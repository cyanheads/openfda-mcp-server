/**
 * @fileoverview Tool for searching openFDA tobacco product problem reports.
 * Records are the smallest openFDA serves, so `limit` reaches openFDA's
 * 1000-record page maximum.
 * @module mcp-server/tools/definitions/search-tobacco-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  emptyResultMessage,
  formatRemainingFields,
  lineContent,
  projectedRecordLines,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  META_LIMIT_DESCRIPTION,
  malformedSearchError,
  pageLimit,
  pageSizeNotice,
  phrasePlusHint,
  resolvePageSize,
  SEARCH_SYNTAX_NOTE,
  SKIP_DESCRIPTION,
  searchExpression,
  sortExpression,
  totalUnverifiedField,
} from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  canvasCapacityExhaustedError,
  canvasDisabledError,
  canvasNotFoundError,
  canvasOutputShape,
  canvasResult,
  STAGING_WORKFLOW,
  spillSearch,
  stageInput,
  stagingNotice,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  inlinePage,
  OVERSIZED_RECORD_BYTES,
  oversizedRecordNotice,
  oversizedRecordOutputShape,
} from '@/services/openfda/page-budget.js';
import {
  projectionNotice,
  projectionOutputShape,
  recordProjection,
} from '@/services/openfda/record-projection.js';

/**
 * Keys that tell one record apart, kept on every `fields`-projected record:
 * `report_id`.
 */
const IDENTITY_KEYS = ['report_id'] as const;

/** The sort a bare browse sends: the most recently submitted report first. */
const NEWEST_FIRST = 'date_submitted:desc';

/**
 * Canvas table projection for tobacco problem reports. Count fields are stored as
 * VARCHAR (CAST in SQL for numeric math); the reported-problem arrays are JSON
 * columns. All nullable.
 */
const TOBACCO_REPORTS_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'report_id', type: 'VARCHAR', nullable: true },
  { name: 'date_submitted', type: 'VARCHAR', nullable: true },
  { name: 'nonuser_affected', type: 'VARCHAR', nullable: true },
  { name: 'number_tobacco_products', type: 'VARCHAR', nullable: true },
  { name: 'number_health_problems', type: 'VARCHAR', nullable: true },
  { name: 'number_product_problems', type: 'VARCHAR', nullable: true },
  { name: 'tobacco_products', type: 'JSON', nullable: true },
  { name: 'reported_health_problems', type: 'JSON', nullable: true },
  { name: 'reported_product_problems', type: 'JSON', nullable: true },
];

export const searchTobaccoReportsTool = tool('openfda_search_tobacco_reports', {
  description: `Search problem reports submitted to the FDA for tobacco products, including e-cigarettes, vaping products, cigarettes, and smokeless tobacco. Reports capture product type, reported health problems (e.g. seizure, chest pain), product problems (e.g. exploding battery), whether a non-user was affected, and submission date. Use to investigate safety signals, find reports by product type, or analyze health effects.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query using field:value syntax. Examples: tobacco_products:"Electronic cigarette", reported_health_problems:"Seizure", nonuser_affected:"Yes". Omit to browse newest first, sorted by ${NEWEST_FIRST}. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        `Sort expression — a field path optionally suffixed with :asc or :desc (any letter case; :ascending and :descending are also accepted, and every direction is sent as asc or desc); comma-separate for multi-field sort. Omitted with no search, defaults to ${NEWEST_FIRST}, newest first; omitted with a search, results come in openFDA's relevance order. Field paths take only letters, digits, underscores, and dots; any other character or direction is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.`,
      ),
    limit: pageLimit('tobacco/problem', 'Records per page.'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['date_submitted', 'reported_health_problems'])),
    stage: stageInput,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID returned by a prior stage=true call to this tool or another openFDA search tool (openfda_search_* or openfda_lookup_ndc). Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
    ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records in the dataset'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe(META_LIMIT_DESCRIPTION),
        lastUpdated: z.string().describe('Dataset last updated date'),
        totalUnverified: totalUnverifiedField,
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Tobacco problem report records. Key fields: report_id, date_submitted, tobacco_products[] (product type description), reported_health_problems[] (health effects), reported_product_problems[] (device/product defects), number_tobacco_products, number_health_problems, number_product_problems, nonuser_affected.',
      ),
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching tobacco problem reports in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        `Canvas staging disclosure when the call staged, the limit clamp when limit exceeded the cap (requested value, cap, next skip), the fields projection and any requested path no record carries, the size and largest fields when a record on the page exceeds ${OVERSIZED_RECORD_BYTES} bytes, and guidance when results are empty or paging overshot — how to broaden filters or adjust the query.`,
      ),
  },

  errors: [
    canvasDisabledError,
    canvasNotFoundError,
    canvasCapacityExhaustedError,
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The openFDA daily or per-minute request limit is exceeded.',
      retryable: true,
      recovery:
        'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The openFDA API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
      thrownBy: 'service',
    },
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    {
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'skip exceeds the 25000 record pagination ceiling.',
      recovery:
        'Narrow the search query with additional filters or date ranges instead of increasing skip.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);
    const size = resolvePageSize(input.limit, 'tobacco/problem', ctx);
    const sort = sortOrNewest(input, NEWEST_FIRST);

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No tobacco problem reports matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''}. Try broader filters — use tobacco_products, reported_health_problems, or nonuser_affected fields. ${formatFieldHint('tobacco/problem')}`,
        totalUnverified,
      );

    const projection = recordProjection(input.fields, IDENTITY_KEYS);
    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'Staging requires DataCanvas. Set CANVAS_PROVIDER_TYPE=duckdb, or drop stage/canvas_id for the inline page.',
      );
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint: 'tobacco/problem',
        search: input.search,
        sort,
        canvasId: input.canvas_id,
        schema: TOBACCO_REPORTS_CANVAS_SCHEMA,
        limit: size.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      ctx.enrich.notice(
        [
          spill.preview.length === 0 ? emptyNotice(spill.skip, spill.total) : undefined,
          phrasePlusHint(input.search, spill.total),
          pageSizeNotice(size, staged),
          projectionNotice(staged),
          oversizedRecordNotice(staged),
          stagingNotice(spill),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return staged;
    }

    const svc = getOpenFdaService();
    const response = await svc.query(
      'tobacco/problem',
      {
        search: input.search,
        sort,
        limit: size.limit,
        skip: input.skip,
      },
      ctx,
    );

    const page = inlinePage(response, size.limit, projection);

    ctx.log.info('Tobacco problem report search completed', {
      total: response.meta.total,
      returned: page.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    const notices = [
      page.results.length === 0
        ? emptyNotice(response.meta.skip, response.meta.total, response.meta.totalUnverified)
        : undefined,
      phrasePlusHint(input.search, response.meta.total),
      pageSizeNotice(size, page),
      projectionNotice(page),
      oversizedRecordNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No tobacco problem reports found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    const rendered = new Set([
      'report_id',
      'date_submitted',
      'tobacco_products',
      'reported_health_problems',
      'reported_product_problems',
      'nonuser_affected',
      'number_tobacco_products',
      'number_health_problems',
      'number_product_problems',
    ]);

    for (const r of result.results) {
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      lines.push(singleLine(`### Report ${r.report_id ?? 'N/A'}`));
      lines.push(
        singleLine(
          `**Submitted:** ${r.date_submitted ?? 'N/A'} | **Non-user affected:** ${r.nonuser_affected ?? 'N/A'}`,
        ),
      );

      // Product types
      const products = (r.tobacco_products as string[] | undefined) ?? [];
      if (products.length > 0) {
        lines.push('**Products:**');
        for (const p of products) {
          lines.push(`- ${lineContent(String(p))}`);
        }
        // A blank line ends the list; without it the next line continues the last item.
        lines.push('');
      }

      // Health problems
      const healthProblems = (r.reported_health_problems as string[] | undefined) ?? [];
      if (healthProblems.length > 0) {
        lines.push(singleLine(`**Health problems:** ${healthProblems.join(', ')}`));
      }

      // Product problems — rendered in full, including openFDA's
      // "No information provided" placeholder, so content[] carries the same
      // list structuredContent does.
      const productProblems = (r.reported_product_problems as string[] | undefined) ?? [];
      if (productProblems.length > 0) {
        lines.push(singleLine(`**Product problems:** ${productProblems.join(', ')}`));
      }

      // Counts — a zero is reported data, not an absent field.
      const counts = [
        r.number_tobacco_products != null ? `${r.number_tobacco_products} product(s)` : null,
        r.number_health_problems != null ? `${r.number_health_problems} health problem(s)` : null,
        r.number_product_problems != null
          ? `${r.number_product_problems} product problem(s)`
          : null,
      ]
        .filter(Boolean)
        .join(', ');
      if (counts) lines.push(singleLine(`**Counts:** ${counts}`));

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

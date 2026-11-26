/**
 * @fileoverview Tool for searching openFDA tobacco product problem reports.
 * Records are the smallest openFDA serves, so `limit` reaches openFDA's
 * 1000-record page maximum.
 * @module mcp-server/tools/definitions/search-tobacco-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  formatRemainingFields,
  lineContent,
  projectedRecordLines,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  type CursorQuery,
  cursorInput,
  cursorOutputShape,
  invalidCursorError,
  nextCursorField,
  resolveCursor,
} from '@/mcp-server/tools/pagination-cursor.js';
import {
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  notSortableError,
  pageLimit,
  pageMetaOutput,
  paginationLimitReachedError,
  rateLimitedError,
  resolvePageSize,
  SKIP_DESCRIPTION,
  searchNoticeField,
  sortDescription,
  sortExpression,
  upstreamError,
} from '@/mcp-server/tools/schema-utils.js';
import { enrichSearchPage } from '@/mcp-server/tools/search-enrichment.js';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
  SEARCH_SYNTAX_NOTE,
  searchExpression,
} from '@/mcp-server/tools/search-expression.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  CANVAS_DISABLED_MESSAGE,
  canvasCapacityExhaustedError,
  canvasDisabledError,
  canvasIdInput,
  canvasNotFoundError,
  canvasOutputShape,
  canvasResult,
  STAGING_WORKFLOW,
  spillSearch,
  stageInput,
  varcharColumns,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { inlinePage, oversizedRecordOutputShape } from '@/services/openfda/page-budget.js';
import { projectionOutputShape, recordProjection } from '@/services/openfda/record-projection.js';

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
  ...varcharColumns([
    'report_id',
    'date_submitted',
    'nonuser_affected',
    'number_tobacco_products',
    'number_health_problems',
    'number_product_problems',
  ]),
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
        `openFDA search query, e.g. tobacco_products:"Electronic cigarette", reported_health_problems:"Seizure", nonuser_affected:"Yes". Omit to browse newest first. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(sortDescription({ newest: NEWEST_FIRST })),
    limit: pageLimit('tobacco/problem', 'Records per page.'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['date_submitted', 'reported_health_problems'])),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Tobacco problem report records. Key fields: report_id, date_submitted, tobacco_products[] (product type description), reported_health_problems[] (health effects), reported_product_problems[] (device/product defects), number_tobacco_products, number_health_problems, number_product_problems, nonuser_affected.',
      ),
    ...cursorOutputShape,
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
    notice: searchNoticeField(),
  },

  errors: [
    canvasDisabledError,
    canvasNotFoundError,
    canvasCapacityExhaustedError,
    rateLimitedError,
    upstreamError,
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    paginationLimitReachedError,
    invalidCursorError,
    notSortableError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);
    const size = resolvePageSize(input.limit, 'tobacco/problem', ctx);
    const query: CursorQuery = {
      endpoint: 'tobacco/problem',
      search: input.search,
      sort: sortOrNewest(input, NEWEST_FIRST),
    };
    const searchAfter = resolveCursor(input, query, ctx);

    const noMatch = () =>
      `No tobacco problem reports matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''}. Try broader filters — use tobacco_products, reported_health_problems, or nonuser_affected fields. ${formatFieldHint('tobacco/problem')}`;

    const projection = recordProjection(input.fields, IDENTITY_KEYS);
    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail('canvas_disabled', CANVAS_DISABLED_MESSAGE);
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint: query.endpoint,
        search: query.search,
        sort: query.sort,
        canvasId: input.canvas_id,
        schema: TOBACCO_REPORTS_CANVAS_SCHEMA,
        limit: size.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      enrichSearchPage(ctx, { query, page: staged, size, noMatch, spill });
      return staged;
    }

    const svc = getOpenFdaService();
    const response = await svc.query(
      query.endpoint,
      {
        search: query.search,
        sort: query.sort,
        limit: size.limit,
        skip: input.skip,
        searchAfter,
      },
      ctx,
    );

    const page = {
      ...inlinePage(response, size.limit, projection),
      ...nextCursorField(response, query),
    };

    ctx.log.info('Tobacco problem report search completed', {
      total: response.meta.total,
      returned: page.results.length,
    });

    enrichSearchPage(ctx, { query, page, size, noMatch, response, searchAfter });
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

      /**
       * Product problems — rendered in full, including openFDA's
       * "No information provided" placeholder, so content[] carries the same
       * list structuredContent does.
       */
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

/**
 * @fileoverview Tool for searching openFDA tobacco product problem reports.
 * Records are the smallest openFDA serves, but `limit` reaches 1000, so the inline
 * page is bounded by a serialized-byte budget and discloses any records it withheld
 * along with the routes to them.
 * @module mcp-server/tools/definitions/search-tobacco-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  canvasStagingLine,
  emptyPageNote,
  emptyResultMessage,
  formatRemainingFields,
  noMatchNote,
} from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  malformedSearchError,
  nonBlankString,
  SEARCH_BALANCE_NOTE,
  SKIP_DESCRIPTION,
  sortExpression,
} from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  canvasDisabledError,
  canvasOutputShape,
  canvasResult,
  spillSearch,
  stageInput,
  stagingNotice,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  boundedPage,
  META_LIMIT_DESCRIPTION,
  PAGE_BUDGET_NOTE,
  pageBudgetLine,
  pageBudgetNotice,
  pageBudgetOutputShape,
} from '@/services/openfda/page-budget.js';

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
  description:
    'Search problem reports submitted to the FDA for tobacco products, including e-cigarettes, vaping products, cigarettes, and smokeless tobacco. Reports capture product type, reported health problems (e.g. seizure, chest pain), product problems (e.g. exploding battery), whether a non-user was affected, and submission date. Use to investigate safety signals, find reports by product type, or analyze health effects.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: nonBlankString()
      .optional()
      .describe(
        `openFDA search query using field:value syntax. Examples: tobacco_products:"Electronic cigarette", reported_health_problems:"Seizure", nonuser_affected:"Yes". Omit to browse recent reports. ${SEARCH_BALANCE_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        'Sort expression — a field path optionally suffixed with :asc or :desc; comma-separate for multi-field sort. Example: date_submitted:desc. Field paths take only letters, digits, underscores, and dots; anything else is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe(`Maximum number of records to return (1-1000, default 10). ${PAGE_BUDGET_NOTE}`),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    stage: stageInput,
    canvas_id: nonBlankString()
      .optional()
      .describe(
        'DataCanvas session id from a prior call. Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
      ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records in the dataset'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe(META_LIMIT_DESCRIPTION),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Tobacco problem report records. Key fields: report_id, date_submitted, tobacco_products[] (product type description), reported_health_problems[] (health effects), reported_product_problems[] (device/product defects), number_tobacco_products, number_health_problems, number_product_problems, nonuser_affected.',
      ),
    ...pageBudgetOutputShape,
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
        'Canvas staging disclosure when the call staged, the byte-budget disclosure and the routes to the withheld records when the inline page was bounded, and guidance when results are empty or paging overshot — how to broaden filters or adjust the query.',
      ),
  },

  errors: [
    canvasDisabledError,
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The openFDA daily or per-minute request limit is exceeded.',
      retryable: true,
      recovery:
        'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The openFDA API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
    },
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
    },
    {
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'skip exceeds the 25000 record pagination ceiling.',
      recovery:
        'Narrow the search query with additional filters or date ranges instead of increasing skip.',
    },
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);

    const emptyNotice = (skip: number, total: number) =>
      emptyResultMessage(
        skip,
        total,
        `No tobacco problem reports matched${input.search ? ` search: ${input.search}` : ''}. Try broader filters — use tobacco_products, reported_health_problems, or nonuser_affected fields. ${formatFieldHint('tobacco/problem')}`,
      );

    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'Staging requires DataCanvas. Set CANVAS_PROVIDER_TYPE=duckdb, or drop stage/canvas_id for the inline page.',
        { ...ctx.recoveryFor('canvas_disabled') },
      );
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint: 'tobacco/problem',
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema: TOBACCO_REPORTS_CANVAS_SCHEMA,
        limit: input.limit,
        skip: input.skip,
        ctx,
      });
      const staged = canvasResult(spill);
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      ctx.enrich.notice(
        [
          spill.preview.length === 0 ? emptyNotice(spill.skip, spill.total) : undefined,
          pageBudgetNotice(staged),
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
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    const page = boundedPage(response);

    ctx.log.info('Tobacco problem report search completed', {
      total: response.meta.total,
      returned: page.results.length,
      pageOmitted: page.page_omitted,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    const notices = [
      page.results.length === 0 ? emptyNotice(response.meta.skip, response.meta.total) : undefined,
      pageBudgetNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    if (result.results.length === 0 && result.meta.total === 0) {
      return [
        {
          type: 'text' as const,
          text: noMatchNote('No tobacco problem reports found.', result.meta.skip),
        },
      ];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    const budget = pageBudgetLine(result);
    if (budget) lines.push(`${budget}\n`);

    const staging = canvasStagingLine(result.meta.total, result);
    if (staging) lines.push(`${staging}\n`);

    if (result.results.length === 0) {
      lines.push(emptyPageNote(result.meta.total, result.meta.skip, result));
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
      lines.push(`### Report ${r.report_id ?? 'N/A'}`);
      lines.push(
        `**Submitted:** ${r.date_submitted ?? 'N/A'} | **Non-user affected:** ${r.nonuser_affected ?? 'N/A'}`,
      );

      // Product types
      const products = (r.tobacco_products as string[] | undefined) ?? [];
      if (products.length > 0) {
        lines.push('**Products:**');
        for (const p of products) {
          lines.push(`- ${p}`);
        }
      }

      // Health problems
      const healthProblems = (r.reported_health_problems as string[] | undefined) ?? [];
      if (healthProblems.length > 0) {
        lines.push(`**Health problems:** ${healthProblems.join(', ')}`);
      }

      // Product problems — rendered in full, including openFDA's
      // "No information provided" placeholder, so content[] carries the same
      // list structuredContent does.
      const productProblems = (r.reported_product_problems as string[] | undefined) ?? [];
      if (productProblems.length > 0) {
        lines.push(`**Product problems:** ${productProblems.join(', ')}`);
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
      if (counts) lines.push(`**Counts:** ${counts}`);

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

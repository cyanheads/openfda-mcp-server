/**
 * @fileoverview Tool for searching openFDA enforcement reports and recall actions.
 * Device enforcement and recall records run several kilobytes each, so the inline
 * page is bounded by a serialized-byte budget and discloses any records it
 * withheld along with the routes to them.
 * @module mcp-server/tools/definitions/search-recalls
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
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
  boundedPage,
  META_LIMIT_DESCRIPTION,
  PAGE_BUDGET_NOTE,
  pageBudgetLine,
  pageBudgetNotice,
  pageBudgetOutputShape,
} from '@/services/openfda/page-budget.js';

/**
 * Canvas table projection for enforcement records (every category). Scalars are
 * VARCHAR (CAST in SQL for math); the openfda block is a JSON column. All
 * nullable — records are sparse. The canvas ignores fields outside the schema,
 * so each endpoint shape stages against its own column set.
 */
const ENFORCEMENT_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'recall_number', type: 'VARCHAR', nullable: true },
  { name: 'event_id', type: 'VARCHAR', nullable: true },
  { name: 'status', type: 'VARCHAR', nullable: true },
  { name: 'classification', type: 'VARCHAR', nullable: true },
  { name: 'product_type', type: 'VARCHAR', nullable: true },
  { name: 'recalling_firm', type: 'VARCHAR', nullable: true },
  { name: 'product_description', type: 'VARCHAR', nullable: true },
  { name: 'reason_for_recall', type: 'VARCHAR', nullable: true },
  { name: 'voluntary_mandated', type: 'VARCHAR', nullable: true },
  { name: 'distribution_pattern', type: 'VARCHAR', nullable: true },
  { name: 'product_quantity', type: 'VARCHAR', nullable: true },
  { name: 'recall_initiation_date', type: 'VARCHAR', nullable: true },
  { name: 'report_date', type: 'VARCHAR', nullable: true },
  { name: 'state', type: 'VARCHAR', nullable: true },
  { name: 'country', type: 'VARCHAR', nullable: true },
  { name: 'city', type: 'VARCHAR', nullable: true },
  { name: 'product_code', type: 'VARCHAR', nullable: true },
  { name: 'res_event_number', type: 'VARCHAR', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

/**
 * Canvas table projection for device/recall records — every top-level field the
 * endpoint returns, verified against live records. Identity and status live in
 * `product_res_number` and `recall_status`; the endpoint carries no recall
 * hazard classification, so the enforcement-only columns would only ever be
 * NULL here. `k_numbers`/`pma_numbers` and the openfda block are JSON columns.
 */
const DEVICE_RECALL_CANVAS_SCHEMA: ColumnSchema[] = [
  ...[
    'cfres_id',
    'product_res_number',
    'res_event_number',
    'recall_status',
    'event_date_initiated',
    'event_date_posted',
    'event_date_created',
    'event_date_terminated',
    'recalling_firm',
    'firm_fei_number',
    'address_1',
    'address_2',
    'city',
    'state',
    'postal_code',
    'country',
    'additional_info_contact',
    'product_code',
    'product_description',
    'product_quantity',
    'code_info',
    'reason_for_recall',
    'root_cause_description',
    'action',
    'distribution_pattern',
  ].map((name): ColumnSchema => ({ name, type: 'VARCHAR', nullable: true })),
  { name: 'k_numbers', type: 'JSON', nullable: true },
  { name: 'pma_numbers', type: 'JSON', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

const Category = z.enum(['drug', 'food', 'device']).describe('Product category');

const Endpoint = z
  .enum(['enforcement', 'recall'])
  .default('enforcement')
  .describe('Report type. Default enforcement. The recall endpoint is only available for devices.');

export const searchRecallsTool = tool('openfda_search_recalls', {
  description: `Search enforcement reports and recall actions across drugs, food, and devices.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    category: Category,
    endpoint: Endpoint,
    search: nonBlankString()
      .optional()
      .describe(
        `openFDA search query. Examples: classification:"Class I" (also "Class II" or "Class III"), recalling_firm:"pfizer", reason_for_recall:"undeclared allergen". Omit to browse recent. ${SEARCH_BALANCE_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        'Sort expression — a field path optionally suffixed with :asc or :desc; comma-separate for multi-field sort (e.g. report_date:desc,status.exact:asc). Field paths take only letters, digits, underscores, and dots; anything else is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe(
        `Maximum number of records to return (1-1000, default 10). ${PAGE_BUDGET_NOTE} Device records are the largest here — a device enforcement or recall record runs several kilobytes where a drug or food enforcement record is around one.`,
      ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    stage: stageInput,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID returned by a prior stage=true call to this tool or another openFDA search tool (openfda_search_* or openfda_lookup_ndc). Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
    ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe(META_LIMIT_DESCRIPTION),
        lastUpdated: z.string().describe('Dataset last updated date'),
        totalUnverified: totalUnverifiedField,
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Enforcement or recall records. Enforcement records (every category) carry recall_number, classification, status, voluntary_mandated, recalling_firm, product_description, reason_for_recall, distribution_pattern, report_date. Device recall records name identity product_res_number and status recall_status, add res_event_number and root_cause_description, share the firm, product, reason, and distribution fields, and carry no recall hazard classification.',
      ),
    ...pageBudgetOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching recall/enforcement records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the recall query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        'Canvas staging disclosure when the call staged, the byte-budget disclosure and the routes to the withheld records when the inline page was bounded, and guidance when results are empty — how to broaden filters or correct field names.',
      ),
  },

  errors: [
    {
      reason: 'recall_endpoint_non_device',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The recall endpoint was requested for a non-device category.',
      recovery: 'Set endpoint=enforcement for drug and food categories; recall is device-only.',
    },
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

    const endpointValue = input.endpoint ?? 'enforcement';

    if (endpointValue === 'recall' && input.category !== 'device') {
      throw ctx.fail(
        'recall_endpoint_non_device',
        'The recall endpoint is only available for devices. Use enforcement for drug and food recalls.',
        { ...ctx.recoveryFor('recall_endpoint_non_device') },
      );
    }

    const resolvedEndpoint = `${input.category}/${endpointValue}`;
    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No recall/enforcement records matched${input.search ? ` search: ${input.search}` : ''} in ${resolvedEndpoint}. Try broadening filters or check field names (e.g. classification, recalling_firm, reason_for_recall). ${formatFieldHint(resolvedEndpoint)}`,
        totalUnverified,
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
        endpoint: resolvedEndpoint,
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema:
          endpointValue === 'recall' ? DEVICE_RECALL_CANVAS_SCHEMA : ENFORCEMENT_CANVAS_SCHEMA,
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

    const service = getOpenFdaService();
    const response = await service.query(
      resolvedEndpoint,
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    const page = boundedPage(response);

    ctx.log.info('Recall search completed', {
      category: input.category,
      endpoint: endpointValue,
      total: response.meta.total,
      returned: page.results.length,
      pageOmitted: page.page_omitted,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    const notices = [
      page.results.length === 0
        ? emptyNotice(response.meta.skip, response.meta.total, response.meta.totalUnverified)
        : undefined,
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
          text: noMatchNote('No results found.', result.meta.skip, result.meta.totalUnverified),
        },
      ];
    }

    const header = `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Last updated: ${result.meta.lastUpdated}\n`;
    const budget = pageBudgetLine(result);
    const budgetHint = budget ? `${budget}\n\n` : '';
    const staging = canvasStagingLine(result.meta.total, result);
    const canvasHint = staging ? `${staging}\n\n` : '';

    if (result.results.length === 0) {
      return [
        {
          type: 'text' as const,
          text: `${header}\n${budgetHint}${canvasHint}${emptyPageNote(result.meta.total, result.meta.skip, result)}`,
        },
      ];
    }

    /**
     * Keys each branch's curated lines emit verbatim whenever present. The two
     * endpoint shapes share firm, product, reason, and distribution, but name
     * identity and status differently — and device/recall carries no recall
     * hazard classification (`openfda.device_class` is the product's regulatory
     * class), so its branch prints none.
     */
    const sharedRendered = [
      'recalling_firm',
      'product_description',
      'reason_for_recall',
      'distribution_pattern',
    ];
    const renderedEnforcement = new Set([
      ...sharedRendered,
      'recall_number',
      'classification',
      'status',
      'voluntary_mandated',
    ]);
    const renderedDeviceRecall = new Set([
      ...sharedRendered,
      'product_res_number',
      'recall_status',
    ]);

    const records = result.results.map((r) => {
      // device/recall — detected structurally, since format() never sees the endpoint input.
      const deviceRecall = r.product_res_number != null;
      const lines = deviceRecall
        ? [`**Recall #${r.product_res_number}**`]
        : [`**Recall #${r.recall_number ?? 'N/A'}** — ${r.classification ?? 'Unclassified'}`];
      lines.push(
        `Firm: ${r.recalling_firm ?? 'N/A'}`,
        `Product: ${(r.product_description as string | undefined) || 'N/A'}`,
        `Reason: ${(r.reason_for_recall as string | undefined) || 'N/A'}`,
        deviceRecall
          ? `Status: ${r.recall_status ?? 'N/A'}`
          : `Status: ${r.status ?? 'N/A'} | ${r.voluntary_mandated ?? 'N/A'}`,
      );
      if (r.distribution_pattern) {
        lines.push(`Distribution: ${r.distribution_pattern}`);
      }
      lines.push(
        ...formatRemainingFields(r, deviceRecall ? renderedDeviceRecall : renderedEnforcement),
      );
      return lines.join('\n');
    });

    const body = records.join('\n\n---\n\n');

    return [{ type: 'text' as const, text: `${header}\n${budgetHint}${canvasHint}${body}` }];
  },
});

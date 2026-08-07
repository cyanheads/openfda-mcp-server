/**
 * @fileoverview Tool for searching openFDA enforcement reports and recall actions.
 * @module mcp-server/tools/definitions/search-recalls
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

/**
 * Canvas table projection for enforcement/recall records. Scalars are VARCHAR
 * (CAST in SQL for math); the openfda block is a JSON column. All nullable — the
 * field set differs between the enforcement and device recall endpoints, and
 * records are sparse.
 */
const RECALLS_CANVAS_SCHEMA: ColumnSchema[] = [
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

const Category = z.enum(['drug', 'food', 'device']).describe('Product category');

const Endpoint = z
  .enum(['enforcement', 'recall'])
  .default('enforcement')
  .describe('Report type. Default enforcement. The recall endpoint is only available for devices.');

export const searchRecallsTool = tool('openfda_search_recalls', {
  description: 'Search enforcement reports and recall actions across drugs, food, and devices.',
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
      .describe('Maximum number of records to return (1-1000).'),
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
        total: z.number().describe('Total matching records'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Enforcement or recall records — recall_number, classification, recalling_firm, product_description, reason_for_recall, status, voluntary_mandated, distribution_pattern, report_date. Field set varies between enforcement and recall endpoints.',
      ),
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
        'Canvas staging disclosure when the call staged, and guidance when results are empty — how to broaden filters or correct field names.',
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

    const endpointValue = input.endpoint ?? 'enforcement';

    if (endpointValue === 'recall' && input.category !== 'device') {
      throw ctx.fail(
        'recall_endpoint_non_device',
        'The recall endpoint is only available for devices. Use enforcement for drug and food recalls.',
        { ...ctx.recoveryFor('recall_endpoint_non_device') },
      );
    }

    const resolvedEndpoint = `${input.category}/${endpointValue}`;
    const emptyNotice = (skip: number, total: number) =>
      emptyResultMessage(
        skip,
        total,
        `No recall/enforcement records matched${input.search ? ` search: ${input.search}` : ''} in ${resolvedEndpoint}. Try broadening filters or check field names (e.g. classification, recalling_firm, reason_for_recall). ${formatFieldHint(resolvedEndpoint)}`,
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
        schema: RECALLS_CANVAS_SCHEMA,
        limit: input.limit,
        skip: input.skip,
        ctx,
      });
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      ctx.enrich.notice(
        spill.preview.length === 0
          ? `${emptyNotice(spill.skip, spill.total)} ${stagingNotice(spill)}`
          : stagingNotice(spill),
      );
      return canvasResult(spill);
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

    ctx.log.info('Recall search completed', {
      category: input.category,
      endpoint: endpointValue,
      total: response.meta.total,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    if (response.results.length === 0) {
      ctx.enrich.notice(emptyNotice(response.meta.skip, response.meta.total));
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0 && result.meta.total === 0) {
      return [{ type: 'text' as const, text: noMatchNote('No results found.', result.meta.skip) }];
    }

    const header = `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Last updated: ${result.meta.lastUpdated}\n`;
    const staging = canvasStagingLine(result.meta.total, result);
    const canvasHint = staging ? `${staging}\n\n` : '';

    if (result.results.length === 0) {
      return [
        {
          type: 'text' as const,
          text: `${header}\n${canvasHint}${emptyPageNote(result.meta.total, result.meta.skip, result)}`,
        },
      ];
    }

    const rendered = new Set([
      'recall_number',
      'classification',
      'recalling_firm',
      'product_description',
      'reason_for_recall',
      'status',
      'voluntary_mandated',
      'distribution_pattern',
    ]);

    const records = result.results.map((r) => {
      const lines = [
        `**Recall #${r.recall_number ?? 'N/A'}** — ${r.classification ?? 'Unclassified'}`,
        `Firm: ${r.recalling_firm ?? 'N/A'}`,
        `Product: ${(r.product_description as string | undefined) || 'N/A'}`,
        `Reason: ${(r.reason_for_recall as string | undefined) || 'N/A'}`,
        `Status: ${r.status ?? 'N/A'} | ${r.voluntary_mandated ?? 'N/A'}`,
      ];
      if (r.distribution_pattern) {
        lines.push(`Distribution: ${r.distribution_pattern}`);
      }
      lines.push(...formatRemainingFields(r, rendered));
      return lines.join('\n');
    });

    const body = records.join('\n\n---\n\n');

    return [{ type: 'text' as const, text: `${header}\n${canvasHint}${body}` }];
  },
});

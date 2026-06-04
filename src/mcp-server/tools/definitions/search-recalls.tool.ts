/**
 * @fileoverview Tool for searching openFDA enforcement reports and recall actions.
 * @module mcp-server/tools/definitions/search-recalls
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  emptyResultMessage,
  formatRemainingFields,
  truncate,
} from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

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
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query. Examples: classification:"Class I" (also "Class II" or "Class III"), recalling_firm:"pfizer", reason_for_recall:"undeclared allergen".',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: report_date:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe('Maximum number of records to return (1-1000).'),
    skip: z.number().min(0).max(25000).default(0).describe('Pagination offset (0-25000).'),
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
        'Guidance when results are empty — how to broaden filters or correct field names. Absent when results are returned.',
      ),
  },

  errors: [
    {
      reason: 'recall_endpoint_non_device',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The recall endpoint was requested for a non-device category.',
      recovery: 'Set endpoint=enforcement for drug and food categories; recall is device-only.',
    },
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
    const endpointValue = input.endpoint ?? 'enforcement';

    if (endpointValue === 'recall' && input.category !== 'device') {
      throw ctx.fail(
        'recall_endpoint_non_device',
        'The recall endpoint is only available for devices. Use enforcement for drug and food recalls.',
        { ...ctx.recoveryFor('recall_endpoint_non_device') },
      );
    }

    const resolvedEndpoint = `${input.category}/${endpointValue}`;
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
      const fieldHint = formatFieldHint(resolvedEndpoint);
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No recall/enforcement records matched${input.search ? ` search: ${input.search}` : ''} in ${resolvedEndpoint}. Try broadening filters or check field names (e.g. classification, recalling_firm, reason_for_recall). ${fieldHint}`,
        ),
      );
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No results found.' }];
    }

    const header = `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Last updated: ${result.meta.lastUpdated}\n`;

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
        `Product: ${truncate(r.product_description as string | undefined, 300)}`,
        `Reason: ${truncate(r.reason_for_recall as string | undefined, 300)}`,
        `Status: ${r.status ?? 'N/A'} | ${r.voluntary_mandated ?? 'N/A'}`,
      ];
      if (r.distribution_pattern) {
        lines.push(`Distribution: ${r.distribution_pattern}`);
      }
      lines.push(...formatRemainingFields(r, rendered));
      return lines.join('\n');
    });

    const body = records.join('\n\n---\n\n');

    return [{ type: 'text' as const, text: `${header}\n${body}` }];
  },
});

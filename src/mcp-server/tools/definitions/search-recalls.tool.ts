/**
 * @fileoverview Tool for searching openFDA enforcement reports and recall actions.
 * @module mcp-server/tools/definitions/search-recalls
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const Category = z.enum(['drug', 'food', 'device']).describe('Product category');

const Endpoint = z
  .enum(['enforcement', 'recall'])
  .default('enforcement')
  .optional()
  .describe('Report type. Default enforcement. The recall endpoint is only available for devices.');

/** Truncate a string to `max` characters, appending ellipsis when trimmed. */
function truncate(value: string | undefined, max: number): string {
  if (!value) return 'N/A';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

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
        'openFDA search query. Examples: classification:"Class I", recalling_firm:"pfizer", reason_for_recall:"undeclared allergen".',
      ),
    sort: z.string().optional().describe('Sort expression. Example: report_date:desc.'),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .optional()
      .describe('Maximum number of records to return (1-1000).'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
      .optional()
      .describe('Pagination offset (0-25000).'),
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
    results: z.array(z.record(z.string(), z.any())).describe('Enforcement/recall records'),
    message: z
      .string()
      .optional()
      .describe('Guidance when results are empty or search can be refined'),
  }),

  async handler(input, ctx) {
    const endpointValue = input.endpoint ?? 'enforcement';

    if (endpointValue === 'recall' && input.category !== 'device') {
      throw validationError(
        'The recall endpoint is only available for devices. Use enforcement for drug and food recalls.',
      );
    }

    const service = getOpenFdaService();
    const response = await service.query(
      `${input.category}/${endpointValue}`,
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

    return {
      meta: response.meta,
      results: response.results,
      message:
        response.results.length === 0
          ? `No recall/enforcement records matched${input.search ? ` search: ${input.search}` : ''} in ${input.category}/${endpointValue}. Try broadening filters or check field names (e.g. classification, recalling_firm, reason_for_recall).`
          : undefined,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [
        {
          type: 'text' as const,
          text: result.message ?? 'No results found.',
        },
      ];
    }

    const header = `**${result.meta.total.toLocaleString()} total records** (showing ${result.results.length}, offset ${result.meta.skip}) | Last updated: ${result.meta.lastUpdated}\n`;

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
      return lines.join('\n');
    });

    const body = records.join('\n\n---\n\n');

    return [{ type: 'text' as const, text: `${header}\n${body}` }];
  },
});

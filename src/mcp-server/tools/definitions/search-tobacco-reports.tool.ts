/**
 * @fileoverview Tool for searching openFDA tobacco product problem reports.
 * @module mcp-server/tools/definitions/search-tobacco-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import { emptyResultMessage, formatRemainingFields } from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const searchTobaccoReportsTool = tool('openfda_search_tobacco_reports', {
  description:
    'Search problem reports submitted to the FDA for tobacco products, including e-cigarettes, vaping products, cigarettes, and smokeless tobacco. Reports capture product type, reported health problems (e.g. seizure, chest pain), product problems (e.g. exploding battery), whether a non-user was affected, and submission date. Use to investigate safety signals, find reports by product type, or analyze health effects.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query using field:value syntax. Examples: tobacco_products:"Electronic cigarette", reported_health_problems:"Seizure", nonuser_affected:"Yes". Omit to browse recent reports.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: date_submitted:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe('Maximum number of records to return (1-1000, default 10)'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
      .describe('Number of records to skip for pagination (0-25000, default 0)'),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records in the dataset'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned in this response'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Tobacco problem report records. Key fields: report_id, date_submitted, tobacco_products[] (product type description), reported_health_problems[] (health effects), reported_product_problems[] (device/product defects), number_tobacco_products, number_health_problems, number_product_problems, nonuser_affected.',
      ),
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
        'Guidance when results are empty or paging overshot — how to broaden filters or adjust the query. Absent when results are returned.',
      ),
  },

  errors: [
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

    ctx.log.info('Tobacco problem report search completed', {
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    if (response.results.length === 0) {
      const fieldHint = formatFieldHint('tobacco/problem');
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No tobacco problem reports matched${input.search ? ` search: ${input.search}` : ''}. Try broader filters — use tobacco_products, reported_health_problems, or nonuser_affected fields. ${fieldHint}`,
        ),
      );
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No tobacco problem reports found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

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

      // Product problems
      const productProblems = (r.reported_product_problems as string[] | undefined) ?? [];
      const meaningfulProductProblems = productProblems.filter(
        (p) => p !== 'No information provided',
      );
      if (meaningfulProductProblems.length > 0) {
        lines.push(`**Product problems:** ${meaningfulProductProblems.join(', ')}`);
      }

      // Counts
      const counts = [
        r.number_tobacco_products != null ? `${r.number_tobacco_products} product(s)` : null,
        r.number_health_problems != null && r.number_health_problems > 0
          ? `${r.number_health_problems} health problem(s)`
          : null,
        r.number_product_problems != null && r.number_product_problems > 0
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

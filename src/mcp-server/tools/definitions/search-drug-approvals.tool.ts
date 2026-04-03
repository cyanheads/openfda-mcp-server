/**
 * @fileoverview Tool for searching FDA drug application approvals (NDAs and ANDAs)
 * via the Drugs@FDA endpoint.
 * @module mcp-server/tools/definitions/search-drug-approvals
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/** Exported tool definition for searching drug approvals. */
export const searchDrugApprovalsTool = tool('openfda_search_drug_approvals', {
  description:
    'Search the Drugs@FDA database for drug application approvals (NDAs and ANDAs). Returns application details, sponsor info, and full submission history.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: z
      .string()
      .describe(
        'openFDA search query. Examples: openfda.brand_name:"humira", sponsor_name:"pfizer", submissions.submission_type:"ORIG" AND submissions.review_priority:"PRIORITY"',
      ),
    sort: z
      .string()
      .optional()
      .describe('Sort field and order. Example: submissions.submission_status_date:desc'),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .optional()
      .describe('Maximum number of records to return (1-1000, default 10)'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
      .optional()
      .describe('Number of records to skip for pagination (0-25000, default 0)'),
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
      .describe('Drug application records with submission history'),
    message: z
      .string()
      .optional()
      .describe('Guidance when results are empty or search can be refined'),
  }),

  async handler(input, ctx) {
    const service = getOpenFdaService();

    const response = await service.query(
      'drug/drugsfda',
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Drug approval search completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    const message =
      response.results.length === 0
        ? 'No drug approvals matched the query. Try broader terms, check field names (e.g. openfda.brand_name, sponsor_name), or remove filters.'
        : undefined;

    return {
      meta: response.meta,
      results: response.results,
      message,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [
        {
          type: 'text' as const,
          text: result.message ?? 'No drug approvals found.',
        },
      ];
    }

    const lines: string[] = [
      `**${result.meta.total.toLocaleString()} total results** (showing ${result.results.length}, skip: ${result.meta.skip}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    for (const r of result.results) {
      const openfda = r.openfda ?? {};
      const brandName = (openfda.brand_name ?? [])[0] ?? '';
      const genericName = (openfda.generic_name ?? [])[0] ?? '';
      const title = brandName || genericName || r.application_number || 'Unknown';

      lines.push(`### ${title}`);
      lines.push(
        `**Application:** ${r.application_number ?? 'N/A'} | **Sponsor:** ${r.sponsor_name ?? 'N/A'}`,
      );
      if (brandName && genericName)
        lines.push(`**Brand:** ${brandName} | **Generic:** ${genericName}`);
      if (openfda.route) lines.push(`**Route:** ${(openfda.route as string[]).join(', ')}`);
      if (openfda.product_type)
        lines.push(`**Type:** ${(openfda.product_type as string[]).join(', ')}`);

      const submissions = r.submissions ?? [];
      if (submissions.length > 0) {
        lines.push('**Submissions:**');
        for (const s of submissions.slice(0, 10)) {
          const parts = [
            s.submission_type,
            s.submission_number ? `#${s.submission_number}` : null,
            s.submission_status,
            s.submission_status_date,
            s.review_priority ? `(${s.review_priority})` : null,
          ].filter(Boolean);
          lines.push(`- ${parts.join(' | ')}`);
        }
        if (submissions.length > 10) lines.push(`- ... and ${submissions.length - 10} more`);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

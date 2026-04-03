/**
 * @fileoverview Tool definition for looking up FDA drug labeling (package inserts / SPL documents).
 * @module mcp-server/tools/definitions/get-drug-label
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const ENDPOINT = 'drug/label';

export const getDrugLabelTool = tool('openfda_get_drug_label', {
  description:
    'Look up FDA drug labeling (package inserts / SPL documents). Check indications, warnings, dosage, contraindications, active ingredients, or any structured label section.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: z
      .string()
      .describe(
        'Query targeting label fields. Examples: openfda.brand_name:"aspirin", openfda.generic_name:"metformin", openfda.manufacturer_name:"pfizer", set_id:"uuid".',
      ),
    sort: z.string().optional().describe('Sort order for results. Example: effective_time:desc.'),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(5)
      .optional()
      .describe('Maximum number of results to return (1-1000). Default 5. Labels are large.'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
      .optional()
      .describe('Number of results to skip for pagination (0-25000). Default 0.'),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching results in the dataset.'),
        skip: z.number().describe('Number of results skipped.'),
        limit: z.number().describe('Maximum results returned per request.'),
        lastUpdated: z.string().describe('Date the dataset was last updated.'),
      })
      .describe('Pagination and freshness metadata.'),
    results: z.array(z.record(z.string(), z.any())).describe('Array of drug label records.'),
    message: z.string().optional().describe('Human-readable note when the result set is empty.'),
  }),

  async handler(input, ctx) {
    const service = getOpenFdaService();
    const response = await service.query(
      ENDPOINT,
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Drug label lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    return {
      meta: response.meta,
      results: response.results,
      ...(response.results.length === 0 && {
        message: 'No labels matched the query. Try broader terms or check field names.',
      }),
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: result.message ?? 'No labels found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total.toLocaleString()} total labels** (showing ${result.results.length}, skip: ${result.meta.skip}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    const sections = [
      ['Indications & Usage', 'indications_and_usage'],
      ['Dosage & Administration', 'dosage_and_administration'],
      ['Warnings', 'warnings'],
      ['Contraindications', 'contraindications'],
      ['Adverse Reactions', 'adverse_reactions'],
      ['Drug Interactions', 'drug_interactions'],
      ['Active Ingredient', 'active_ingredient'],
    ] as const;

    for (const r of result.results) {
      const openfda = r.openfda ?? {};
      const brandName = (openfda.brand_name ?? [])[0] ?? 'Unknown';
      const genericName = (openfda.generic_name ?? [])[0];
      const manufacturer = (openfda.manufacturer_name ?? [])[0];

      lines.push(`### ${brandName}${genericName ? ` (${genericName})` : ''}`);
      if (manufacturer) lines.push(`**Manufacturer:** ${manufacturer}`);
      if (openfda.route) lines.push(`**Route:** ${(openfda.route as string[]).join(', ')}`);

      for (const [label, key] of sections) {
        const val = r[key];
        if (!val) continue;
        const text = Array.isArray(val) ? val.join('\n') : String(val);
        const truncated = text.length > 1000 ? `${text.slice(0, 1000)}... (truncated)` : text;
        lines.push(`\n**${label}:**\n${truncated}`);
      }
      lines.push('\n---\n');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

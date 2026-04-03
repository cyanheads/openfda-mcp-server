/**
 * @fileoverview MCP tool for looking up drugs in the openFDA NDC (National Drug Code) Directory.
 * @module mcp-server/tools/definitions/lookup-ndc
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const lookupNdcTool = tool('openfda_lookup_ndc', {
  description:
    'Look up drugs in the NDC (National Drug Code) Directory. Identify drug products by NDC code, find active ingredients, packaging details, or manufacturer info.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: z
      .string()
      .describe(
        'openFDA search query. Examples: product_ndc:"0363-0218", brand_name:"aspirin", generic_name:"metformin", openfda.manufacturer_name:"walgreen", active_ingredients.name:"ASPIRIN"',
      ),
    sort: z
      .string()
      .optional()
      .describe('Sort field and direction. Example: listing_expiration_date:desc'),
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
        total: z.number().describe('Total matching records'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe('NDC directory records with product and packaging details'),
    message: z
      .string()
      .optional()
      .describe('Guidance when results are empty or search can be refined'),
  }),

  async handler(input, ctx) {
    const service = getOpenFdaService();
    const response = await service.query('drug/ndc', input, ctx);

    ctx.log.info('NDC lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    return {
      meta: response.meta,
      results: response.results,
      message:
        response.results.length === 0
          ? 'No NDC records matched the query. Try broadening the search — use brand_name, generic_name, or active_ingredients.name fields.'
          : undefined,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: result.message ?? 'No NDC records found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total.toLocaleString()} total results** (showing ${result.results.length}, skip: ${result.meta.skip}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    for (const r of result.results) {
      const title = r.brand_name ?? r.generic_name ?? r.product_ndc ?? 'Unknown';
      lines.push(`### ${title}`);
      lines.push(`**NDC:** ${r.product_ndc ?? 'N/A'} | **Labeler:** ${r.labeler_name ?? 'N/A'}`);
      if (r.generic_name && r.brand_name) lines.push(`**Generic:** ${r.generic_name}`);
      if (r.dosage_form)
        lines.push(
          `**Form:** ${r.dosage_form}${r.route ? ` | **Route:** ${(Array.isArray(r.route) ? r.route : [r.route]).join(', ')}` : ''}`,
        );
      if (r.marketing_category) lines.push(`**Category:** ${r.marketing_category}`);

      const ingredients = r.active_ingredients ?? [];
      if (ingredients.length > 0) {
        lines.push(
          `**Active ingredients:** ${ingredients.map((i: Record<string, unknown>) => `${i.name}${i.strength ? ` (${i.strength})` : ''}`).join(', ')}`,
        );
      }

      const packaging = r.packaging ?? [];
      if (packaging.length > 0) {
        lines.push(`**Packaging:**`);
        for (const p of packaging.slice(0, 5)) {
          lines.push(`- ${p.package_ndc ?? ''}: ${p.description ?? 'N/A'}`);
        }
        if (packaging.length > 5) lines.push(`- ... and ${packaging.length - 5} more`);
      }

      if (r.listing_expiration_date)
        lines.push(`**Listing expires:** ${r.listing_expiration_date}`);
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

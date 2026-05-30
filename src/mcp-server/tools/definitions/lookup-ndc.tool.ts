/**
 * @fileoverview MCP tool for looking up drugs in the openFDA NDC (National Drug Code) Directory.
 * @module mcp-server/tools/definitions/lookup-ndc
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { emptyResultMessage, formatRemainingFields } from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const lookupNdcTool = tool('openfda_lookup_ndc', {
  description:
    'Look up drugs in the NDC (National Drug Code) Directory. Identify drug products by NDC code, find active ingredients, packaging details, or manufacturer info. Pair with openfda_get_drug_label using the returned brand_name or set_id to read the package insert.',
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
      .describe(
        'Sort expression (field:asc or field:desc). Example: listing_expiration_date:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
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
        total: z.number().describe('Total matching records'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'NDC directory records — product_ndc, brand_name, generic_name, labeler_name, dosage_form, route, marketing_category, active_ingredients[], packaging[], listing_expiration_date.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching NDC records in the dataset'),
    effectiveQuery: z
      .string()
      .describe('Search filter applied to the NDC lookup, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty — how to broaden filters or correct field names. Absent when results are returned.',
      ),
  },

  async handler(input, ctx) {
    const service = getOpenFdaService();
    const response = await service.query('drug/ndc', input, ctx);

    ctx.log.info('NDC lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });
    if (response.results.length === 0) {
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          'No NDC records matched the query. Try broadening the search — use brand_name, generic_name, or active_ingredients.name fields.',
        ),
      );
    }

    return {
      meta: response.meta,
      results: response.results,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No NDC records found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    const rendered = new Set([
      'brand_name',
      'generic_name',
      'product_ndc',
      'labeler_name',
      'dosage_form',
      'route',
      'marketing_category',
      'active_ingredients',
      'packaging',
      'listing_expiration_date',
    ]);

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
      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

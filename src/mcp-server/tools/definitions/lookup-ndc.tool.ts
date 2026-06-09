/**
 * @fileoverview MCP tool for looking up drugs in the openFDA NDC (National Drug Code) Directory.
 * @module mcp-server/tools/definitions/lookup-ndc
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import { emptyResultMessage, formatRemainingFields } from '@/mcp-server/tools/format-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { canvasOutputShape, canvasResult, spillSearch } from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/**
 * Canvas table projection for NDC directory records. Scalars are VARCHAR; route
 * (an array) and the ingredient/packaging/openfda structures are JSON columns.
 * All nullable.
 */
const NDC_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'product_ndc', type: 'VARCHAR', nullable: true },
  { name: 'product_id', type: 'VARCHAR', nullable: true },
  { name: 'brand_name', type: 'VARCHAR', nullable: true },
  { name: 'generic_name', type: 'VARCHAR', nullable: true },
  { name: 'labeler_name', type: 'VARCHAR', nullable: true },
  { name: 'dosage_form', type: 'VARCHAR', nullable: true },
  { name: 'product_type', type: 'VARCHAR', nullable: true },
  { name: 'marketing_category', type: 'VARCHAR', nullable: true },
  { name: 'marketing_start_date', type: 'VARCHAR', nullable: true },
  { name: 'listing_expiration_date', type: 'VARCHAR', nullable: true },
  { name: 'dea_schedule', type: 'VARCHAR', nullable: true },
  { name: 'finished', type: 'VARCHAR', nullable: true },
  { name: 'route', type: 'JSON', nullable: true },
  { name: 'active_ingredients', type: 'JSON', nullable: true },
  { name: 'packaging', type: 'JSON', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

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
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas session id from a prior call. Omit to start a fresh canvas; the response returns a new one when canvas is enabled. When canvas (CANVAS_PROVIDER_TYPE=duckdb) is enabled the full matched set is staged for SQL and limit/skip apply only to the inline path.',
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
        'NDC directory records — product_ndc, brand_name, generic_name, labeler_name, dosage_form, route, marketing_category, active_ingredients[], packaging[], listing_expiration_date.',
      ),
    ...canvasOutputShape,
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
    const canvas = getCanvas();
    if (canvas) {
      const spill = await spillSearch({
        endpoint: 'drug/ndc',
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema: NDC_CANVAS_SCHEMA,
        ctx,
      });
      ctx.enrich({ totalResults: spill.total, effectiveQuery: input.search });
      if (spill.spilled) {
        ctx.enrich.notice(
          `Full result set (${spill.total} matched) staged on canvas table "${spill.tableName}". Query it with openfda_dataframe_query using canvas_id "${spill.canvasId}".`,
        );
      }
      return canvasResult(spill);
    }

    const service = getOpenFdaService();
    const response = await service.query('drug/ndc', input, ctx);

    ctx.log.info('NDC lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });
    if (response.results.length === 0) {
      const fieldHint = formatFieldHint('drug/ndc');
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No NDC records matched the query. Try broadening the search — use brand_name, generic_name, or active_ingredients.name fields. ${fieldHint}`,
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

    if (result.spilled !== undefined) {
      lines.push(
        result.canvas_table
          ? `> Staged ${result.meta.total} matched rows on canvas table \`${result.canvas_table}\` (canvas_id \`${result.canvas_id}\`, spilled=${result.spilled})${result.truncated ? ', truncated at the 25000-row ceiling' : ''} — query with openfda_dataframe_query.\n`
          : `> Canvas enabled (canvas_id \`${result.canvas_id}\`, spilled=${result.spilled}); ${result.meta.total} rows fit inline.\n`,
      );
    }

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

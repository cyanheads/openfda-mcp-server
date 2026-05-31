/**
 * @fileoverview Tool definition for looking up FDA drug labeling (package inserts / SPL documents).
 * @module mcp-server/tools/definitions/get-drug-label
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { emptyResultMessage, humanizeField } from '@/mcp-server/tools/format-utils.js';
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
        'Query targeting label fields. Examples: openfda.brand_name:"aspirin", openfda.generic_name:"metformin", openfda.manufacturer_name:"pfizer". For a specific revision, pass set_id with the SPL UUID returned in earlier results.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: effective_time:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(5)
      .describe('Maximum number of results to return (1-1000). Default 5. Labels are large.'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
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
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Drug label records. Each carries an openfda block (brand_name, generic_name, manufacturer_name, route) plus optional SPL sections like indications_and_usage, warnings, dosage_and_administration, contraindications, adverse_reactions; section presence varies per label.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching label records in the dataset'),
    effectiveQuery: z
      .string()
      .describe('Search filter applied to the drug label query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty or paging overshot — how to broaden filters or correct field names. Absent when results are returned.',
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

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });
    if (response.results.length === 0) {
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No labels matched${input.search ? ` search: ${input.search}` : ''}. Try broader terms or check field names (e.g. openfda.brand_name, openfda.generic_name, openfda.manufacturer_name).`,
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
      return [{ type: 'text' as const, text: 'No labels found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total label results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    /** Keys rendered in the header block — skipped during section iteration. */
    const metaKeys = new Set(['openfda', 'set_id', 'id', 'version', 'effective_time']);

    for (const r of result.results) {
      const openfda = (r.openfda ?? {}) as Record<string, unknown>;
      const brandName = ((openfda.brand_name as string[]) ?? [])[0] ?? 'Unknown';
      const genericName = ((openfda.generic_name as string[]) ?? [])[0];
      const manufacturer = ((openfda.manufacturer_name as string[]) ?? [])[0];

      lines.push(`### ${brandName}${genericName ? ` (${genericName})` : ''}`);
      if (manufacturer) lines.push(`**Manufacturer:** ${manufacturer}`);
      if (r.effective_time) lines.push(`**Effective date:** ${r.effective_time}`);
      if (r.set_id) lines.push(`**Set ID:** ${r.set_id}${r.version ? ` (v${r.version})` : ''}`);

      // All openfda fields beyond the header ones
      const renderedOpenfda = new Set(['brand_name', 'generic_name', 'manufacturer_name']);
      for (const [key, val] of Object.entries(openfda)) {
        if (renderedOpenfda.has(key) || val == null) continue;
        const display = Array.isArray(val) ? (val as string[]).join(', ') : String(val);
        if (display) lines.push(`**${humanizeField(key)}:** ${display}`);
      }

      // All label sections present in the record (not just a hardcoded subset)
      for (const [key, value] of Object.entries(r)) {
        if (metaKeys.has(key) || value == null) continue;
        const text = Array.isArray(value)
          ? value.join('\n')
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
        if (!text) continue;
        const truncated = text.length > 1000 ? `${text.slice(0, 1000)}... (truncated)` : text;
        lines.push(`\n**${humanizeField(key)}:**\n${truncated}`);
      }
      lines.push('\n---\n');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

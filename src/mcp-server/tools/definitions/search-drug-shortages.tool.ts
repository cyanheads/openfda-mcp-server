/**
 * @fileoverview Tool for searching FDA drug shortage records via the drug/shortages endpoint.
 * @module mcp-server/tools/definitions/search-drug-shortages
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

export const searchDrugShortagesTool = tool('openfda_search_drug_shortages', {
  description:
    'Search FDA drug shortage records. Returns per-product shortage status, availability, therapeutic category, dosage form, manufacturer, and dates. Use to check whether a drug is currently in shortage, find all oncology drugs with supply issues, or retrieve the openfda block (brand_name, product_ndc, rxcui) to chain into openfda_get_drug_label or openfda_lookup_ndc.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query using field:value syntax. Examples: status:"Current", therapeutic_category:"Oncology", generic_name:"carboplatin", company_name:"pfizer". Omit to browse all records. Call openfda_describe_fields({ endpoint: "drug/shortages" }) for the complete field list.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: update_date:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
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
        total: z.number().describe('Total matching shortage records in the database'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned in this response'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Drug shortage records. Key fields: generic_name, status ("Current"/"Resolved"), availability, therapeutic_category, dosage_form, presentation, package_ndc, company_name, contact_info, initial_posting_date, update_date, update_type. openfda block contains brand_name, product_ndc, rxcui, spl_set_id for cross-linking.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching drug shortage records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the drug/shortages query, as submitted to openFDA'),
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
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases). Call openfda_describe_fields({ endpoint: "drug/shortages" }) for valid field paths.',
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
      'drug/shortages',
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Drug shortage search completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    if (response.results.length === 0) {
      const fieldHint = formatFieldHint('drug/shortages');
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No drug shortage records matched${input.search ? ` search: ${input.search}` : ''}. Try broader filters or check field names. ${fieldHint}`,
        ),
      );
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No drug shortage records found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    const rendered = new Set([
      'generic_name',
      'status',
      'availability',
      'therapeutic_category',
      'dosage_form',
      'presentation',
      'company_name',
      'contact_info',
      'initial_posting_date',
      'update_date',
      'update_type',
      'openfda',
    ]);

    for (const r of result.results) {
      const name = (r.generic_name as string | undefined) ?? 'Unknown';
      const status = (r.status as string | undefined) ?? 'N/A';
      lines.push(`### ${name}`);
      lines.push(`**Status:** ${status}`);

      if (r.availability)
        lines.push(`**Availability:** ${truncate(r.availability as string, 400)}`);
      if (r.therapeutic_category) lines.push(`**Therapeutic category:** ${r.therapeutic_category}`);
      if (r.dosage_form) lines.push(`**Dosage form:** ${r.dosage_form}`);
      if (r.presentation) lines.push(`**Presentation:** ${r.presentation}`);
      if (r.company_name) lines.push(`**Manufacturer:** ${r.company_name}`);
      if (r.contact_info) lines.push(`**Contact:** ${truncate(r.contact_info as string, 200)}`);

      const dates = [
        r.initial_posting_date ? `first posted ${r.initial_posting_date}` : null,
        r.update_date ? `updated ${r.update_date}` : null,
        r.update_type ? `(${r.update_type})` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      if (dates) lines.push(`**Timeline:** ${dates}`);

      // OpenFDA cross-links (brand name, NDC, RxCUI for chaining)
      const openfda = r.openfda as Record<string, unknown> | undefined;
      if (openfda) {
        const brandNames = (openfda.brand_name as string[] | undefined) ?? [];
        const rxcui = (openfda.rxcui as string[] | undefined) ?? [];
        const ndc = (openfda.product_ndc as string[] | undefined) ?? [];
        const crossLinks = [
          brandNames.length > 0 ? `brand: ${brandNames.join(', ')}` : null,
          ndc.length > 0 ? `NDC: ${ndc[0]}` : null,
          rxcui.length > 0 ? `RxCUI: ${rxcui[0]}` : null,
        ]
          .filter(Boolean)
          .join(' | ');
        if (crossLinks) lines.push(`**OpenFDA:** ${crossLinks}`);
      }

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

/**
 * @fileoverview Tool definition for searching openFDA adverse event reports across drugs, food, and devices.
 * @module mcp-server/tools/definitions/search-adverse-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  emptyResultMessage,
  formatRemainingFields,
  truncate,
} from '@/mcp-server/tools/format-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { canvasOutputShape, canvasResult, spillSearch } from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/**
 * Canvas table projections per category — each call stages one category, so the
 * schema is selected by `input.category`. Scalars are VARCHAR (openFDA returns
 * most values as strings; CAST in SQL for math); nested objects/arrays are JSON
 * columns. All nullable — openFDA records are sparse.
 */
const ADVERSE_EVENT_SCHEMAS: Record<'drug' | 'food' | 'device', ColumnSchema[]> = {
  drug: [
    { name: 'safetyreportid', type: 'VARCHAR', nullable: true },
    { name: 'receivedate', type: 'VARCHAR', nullable: true },
    { name: 'receiptdate', type: 'VARCHAR', nullable: true },
    { name: 'serious', type: 'VARCHAR', nullable: true },
    { name: 'seriousnessdeath', type: 'VARCHAR', nullable: true },
    { name: 'seriousnesshospitalization', type: 'VARCHAR', nullable: true },
    { name: 'occurcountry', type: 'VARCHAR', nullable: true },
    { name: 'primarysourcecountry', type: 'VARCHAR', nullable: true },
    { name: 'companynumb', type: 'VARCHAR', nullable: true },
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'openfda', type: 'JSON', nullable: true },
  ],
  food: [
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'date_created', type: 'VARCHAR', nullable: true },
    { name: 'date_started', type: 'VARCHAR', nullable: true },
    { name: 'outcomes', type: 'JSON', nullable: true },
    { name: 'reactions', type: 'JSON', nullable: true },
    { name: 'products', type: 'JSON', nullable: true },
    { name: 'consumer', type: 'JSON', nullable: true },
  ],
  device: [
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'mdr_report_key', type: 'VARCHAR', nullable: true },
    { name: 'event_type', type: 'VARCHAR', nullable: true },
    { name: 'date_received', type: 'VARCHAR', nullable: true },
    { name: 'date_of_event', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_name', type: 'VARCHAR', nullable: true },
    { name: 'device', type: 'JSON', nullable: true },
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'mdr_text', type: 'JSON', nullable: true },
    { name: 'openfda', type: 'JSON', nullable: true },
  ],
};

export const searchAdverseEventsTool = tool('openfda_search_adverse_events', {
  description:
    'Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics.',
  annotations: { readOnlyHint: true },

  input: z.object({
    category: z
      .enum(['drug', 'food', 'device'])
      .describe('Product category — each has different field schemas in the response'),
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query. Examples: patient.drug.medicinalproduct:"aspirin", patient.reaction.reactionmeddrapt:"nausea" AND serious:"1". Omit to browse recent.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: receivedate:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
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
        total: z.number().describe('Total matching records in the database'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned in this response'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Adverse event records — fields vary by category (drug: patient/reactions/drugs, device: device details/event type, food: products/outcomes)',
      ),
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching adverse event records in the dataset'),
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
    const endpoint = `${input.category}/event`;

    const canvas = getCanvas();
    if (canvas) {
      const spill = await spillSearch({
        endpoint,
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema: ADVERSE_EVENT_SCHEMAS[input.category],
        ctx,
      });
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      if (spill.spilled) {
        ctx.enrich.notice(
          `Full result set (${spill.total} matched) staged on canvas table "${spill.tableName}". Query it with openfda_dataframe_query using canvas_id "${spill.canvasId}".`,
        );
      }
      return canvasResult(spill);
    }

    const svc = getOpenFdaService();
    const response = await svc.query(
      endpoint,
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Adverse event search completed', {
      category: input.category,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    if (response.results.length === 0) {
      const fieldHint = formatFieldHint(endpoint);
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No adverse event reports matched${input.search ? ` search: ${input.search}` : ''} in ${endpoint}. Try broadening filters or checking field names (use openfda.brand_name for product searches). ${fieldHint}`,
        ),
      );
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No results found.' }];
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

    for (const r of result.results) {
      // Drug adverse events
      if (r.patient) {
        const patient = r.patient;
        const reactions = (patient.reaction ?? [])
          .map((rx: Record<string, unknown>) => rx.reactionmeddrapt)
          .filter(Boolean)
          .join(', ');

        lines.push(`### Report ${r.safetyreportid ?? 'N/A'}`);
        lines.push(
          `**Date:** ${r.receivedate ?? 'N/A'} | **Serious:** ${r.serious === '1' ? 'Yes' : r.serious === '2' ? 'No' : (r.serious ?? 'N/A')}`,
        );
        if (patient.patientsex)
          lines.push(
            `**Patient:** Sex ${patient.patientsex === '1' ? 'Male' : patient.patientsex === '2' ? 'Female' : patient.patientsex}`,
          );
        if (reactions) lines.push(`**Reactions:** ${reactions}`);

        // Drugs — expanded with indication and route
        const drugList = (patient.drug ?? []) as Record<string, unknown>[];
        if (drugList.length > 0) {
          lines.push('**Drugs:**');
          for (const d of drugList) {
            const char =
              d.drugcharacterization === '1'
                ? 'Suspect'
                : d.drugcharacterization === '2'
                  ? 'Concomitant'
                  : d.drugcharacterization === '3'
                    ? 'Interacting'
                    : '';
            const detail = [
              char,
              d.drugindication ? `for ${d.drugindication}` : null,
              d.drugadministrationroute ? `via ${d.drugadministrationroute}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            lines.push(`- ${d.medicinalproduct ?? 'Unknown'}${detail ? ` (${detail})` : ''}`);
          }
        }

        // Remaining patient fields (age, weight, death, etc.)
        const renderedPatient = new Set(['reaction', 'drug', 'patientsex']);
        lines.push(...formatRemainingFields(patient, renderedPatient));

        // Remaining top-level fields (companynumb, sender, primarysource, etc.)
        // Skip FDA workflow timestamps and format codes that aren't useful for clinical reading.
        const renderedTop = new Set([
          'patient',
          'safetyreportid',
          'receivedate',
          'serious',
          'safetyreportversion',
          'transmissiondate',
          'transmissiondateformat',
          'receivedateformat',
          'receiptdate',
          'receiptdateformat',
          'reporttype',
          'fulfillexpeditecriteria',
          'duplicate',
        ]);
        lines.push(...formatRemainingFields(r, renderedTop));
      }
      // Device adverse events
      else if (r.device) {
        lines.push(`### Report ${r.report_number ?? r.mdr_report_key ?? 'N/A'}`);
        if (r.event_type) lines.push(`**Event type:** ${r.event_type}`);
        for (const d of Array.isArray(r.device) ? r.device : []) {
          const renderedDevice = new Set(['brand_name', 'generic_name', 'manufacturer_d_name']);
          lines.push(
            `**Device:** ${d.brand_name ?? d.generic_name ?? 'Unknown'}${d.manufacturer_d_name ? ` by ${d.manufacturer_d_name}` : ''}`,
          );
          lines.push(...formatRemainingFields(d, renderedDevice));
        }
        for (const t of (r.mdr_text ?? []) as Record<string, unknown>[]) {
          if (!t.text) continue;
          const label = t.text_type_code ? `Narrative (${t.text_type_code})` : 'Narrative';
          lines.push(`**${label}:** ${truncate(t.text as string, 500)}`);
        }

        // Remaining top-level fields (date_of_event, source_type, patient, etc.)
        const renderedTop = new Set([
          'device',
          'report_number',
          'mdr_report_key',
          'event_type',
          'mdr_text',
        ]);
        lines.push(...formatRemainingFields(r, renderedTop));
      }
      // Food adverse events
      else if (r.products || r.reactions) {
        lines.push(`### Report ${r.report_number ?? 'N/A'}`);
        if (r.reactions)
          lines.push(
            `**Reactions:** ${(Array.isArray(r.reactions) ? r.reactions : [r.reactions]).join(', ')}`,
          );
        if (r.outcomes)
          lines.push(
            `**Outcomes:** ${(Array.isArray(r.outcomes) ? r.outcomes : [r.outcomes]).join(', ')}`,
          );
        const productsList = (r.products ?? []) as Record<string, unknown>[];
        if (productsList.length > 0) {
          lines.push('**Products:**');
          for (const p of productsList) {
            const name = (p.name_brand as string) ?? (p.industry_name as string) ?? 'Unknown';
            const detail = [
              p.role ? `role: ${p.role}` : null,
              p.industry_code ? `code: ${p.industry_code}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            lines.push(`- ${name}${detail ? ` (${detail})` : ''}`);
          }
        }

        // Remaining top-level fields (date_created, date_started, consumer, etc.)
        const renderedTop = new Set(['report_number', 'reactions', 'outcomes', 'products']);
        lines.push(...formatRemainingFields(r, renderedTop));
      }
      // Fallback — dump full record
      else {
        lines.push(`### Record`);
        lines.push(`\`\`\`json\n${JSON.stringify(r, null, 2).slice(0, 1000)}\n\`\`\``);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

/**
 * @fileoverview Tool definition for searching openFDA adverse event reports across drugs, food, and devices.
 * @module mcp-server/tools/definitions/search-adverse-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  canvasStagingLine,
  emptyPageNote,
  emptyResultMessage,
  formatRemainingFields,
  noMatchNote,
} from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  malformedSearchError,
  nonBlankString,
  SEARCH_BALANCE_NOTE,
  SKIP_DESCRIPTION,
  sortExpression,
} from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  canvasDisabledError,
  canvasOutputShape,
  canvasResult,
  spillSearch,
  stageInput,
  stagingNotice,
} from '@/services/openfda/canvas-spill.js';
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
    search: nonBlankString()
      .optional()
      .describe(
        `openFDA search query. Examples: patient.drug.medicinalproduct:"aspirin", patient.reaction.reactionmeddrapt:"nausea" AND serious:"1". Omit to browse recent. ${SEARCH_BALANCE_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        'Sort expression — a field path optionally suffixed with :asc or :desc; comma-separate for multi-field sort. Field paths take only letters, digits, underscores, and dots; anything else is rejected before the request. Sortable date fields are category-specific: drug → receivedate:desc (or receiptdate), food → date_created:desc (or date_started), device → date_received:desc (or date_of_event). A field from another category (e.g. receivedate on food or device) causes a query error — use the field for this category.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe('Maximum number of records to return (1-1000, default 10)'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    stage: stageInput,
    canvas_id: nonBlankString()
      .optional()
      .describe(
        'DataCanvas session id from a prior call. Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
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
        'Canvas staging disclosure when the call staged, and guidance when results are empty or paging overshot — how to broaden filters or adjust the query.',
      ),
  },

  errors: [
    canvasDisabledError,
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
    malformedSearchError,
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
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);

    const endpoint = `${input.category}/event`;
    const emptyNotice = (skip: number, total: number) =>
      emptyResultMessage(
        skip,
        total,
        `No adverse event reports matched${input.search ? ` search: ${input.search}` : ''} in ${endpoint}. Try broadening filters or checking field names (use openfda.brand_name for product searches). ${formatFieldHint(endpoint)}`,
      );

    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'Staging requires DataCanvas. Set CANVAS_PROVIDER_TYPE=duckdb, or drop stage/canvas_id for the inline page.',
        { ...ctx.recoveryFor('canvas_disabled') },
      );
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint,
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema: ADVERSE_EVENT_SCHEMAS[input.category],
        limit: input.limit,
        skip: input.skip,
        ctx,
      });
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      ctx.enrich.notice(
        spill.preview.length === 0
          ? `${emptyNotice(spill.skip, spill.total)} ${stagingNotice(spill)}`
          : stagingNotice(spill),
      );
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
      ctx.enrich.notice(emptyNotice(response.meta.skip, response.meta.total));
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0 && result.meta.total === 0) {
      return [{ type: 'text' as const, text: noMatchNote('No results found.', result.meta.skip) }];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    const staging = canvasStagingLine(result.meta.total, result);
    if (staging) lines.push(`${staging}\n`);

    if (result.results.length === 0) {
      lines.push(emptyPageNote(result.meta.total, result.meta.skip, result));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    for (const r of result.results) {
      // Device adverse events. Checked before `patient`: a device/event record
      // also carries a `patient` array, so a patient-first branch would route
      // every device report into the drug renderer.
      if (r.device) {
        lines.push(`### Report ${r.report_number ?? r.mdr_report_key ?? 'N/A'}`);
        if (r.event_type) lines.push(`**Event type:** ${r.event_type}`);
        for (const d of Array.isArray(r.device) ? r.device : []) {
          lines.push(
            `**Device:** ${d.brand_name ?? d.generic_name ?? 'Unknown'}${d.manufacturer_d_name ? ` by ${d.manufacturer_d_name}` : ''}`,
          );
          lines.push(...formatRemainingFields(d, new Set(['brand_name', 'manufacturer_d_name'])));
        }
        for (const t of (r.mdr_text ?? []) as Record<string, unknown>[]) {
          const label = t.text_type_code ? `Narrative (${t.text_type_code})` : 'Narrative';
          if (t.text) lines.push(`**${label}:** ${t.text as string}`);
          lines.push(...formatRemainingFields(t, new Set(['text', 'text_type_code'])));
        }

        // Remaining top-level fields (date_of_event, source_type, patient, etc.)
        const renderedTop = new Set(['device', 'report_number', 'event_type', 'mdr_text']);
        lines.push(...formatRemainingFields(r, renderedTop));
      }
      // Drug adverse events
      else if (r.patient) {
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
        for (const rx of (patient.reaction ?? []) as Record<string, unknown>[]) {
          lines.push(...formatRemainingFields(rx, new Set(['reactionmeddrapt'])));
        }

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
            lines.push(
              ...formatRemainingFields(
                d,
                new Set(['medicinalproduct', 'drugindication', 'drugadministrationroute']),
              ),
            );
          }
        }

        // Remaining patient fields (age, weight, death, sex code, etc.)
        lines.push(...formatRemainingFields(patient, new Set(['reaction', 'drug'])));

        // Remaining top-level fields (companynumb, sender, primarysource, the
        // serious code, FDA workflow timestamps, ...).
        const renderedTop = new Set(['patient', 'safetyreportid', 'receivedate']);
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
            lines.push(
              ...formatRemainingFields(p, new Set(['name_brand', 'role', 'industry_code'])),
            );
          }
        }

        // Remaining top-level fields (date_created, date_started, consumer, etc.)
        const renderedTop = new Set(['report_number', 'reactions', 'outcomes', 'products']);
        lines.push(...formatRemainingFields(r, renderedTop));
      }
      // Fallback — dump full record
      else {
        lines.push(`### Record`);
        lines.push(`\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

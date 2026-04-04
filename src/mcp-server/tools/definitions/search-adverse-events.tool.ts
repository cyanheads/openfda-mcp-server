/**
 * @fileoverview Tool definition for searching openFDA adverse event reports across drugs, food, and devices.
 * @module mcp-server/tools/definitions/search-adverse-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { formatRemainingFields, truncate } from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

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
        'Elasticsearch query string. Examples: patient.drug.medicinalproduct:"aspirin", patient.reaction.reactionmeddrapt:"nausea" AND serious:"1". Omit to browse recent.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: receivedate:desc. Unrecognized fields are silently ignored by the API — results return in default order.',
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
    message: z
      .string()
      .optional()
      .describe('Guidance when results are empty or search can be refined'),
  }),

  async handler(input, ctx) {
    const svc = getOpenFdaService();
    const endpoint = `${input.category}/event`;
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

    if (response.results.length === 0) {
      return {
        ...response,
        message: `No adverse event reports matched${input.search ? ` search: ${input.search}` : ''} in ${input.category}/event. Try broadening filters, checking field names (use openfda.brand_name for product searches), or removing date constraints.`,
      };
    }

    return response;
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: result.message ?? 'No results found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total.toLocaleString()} total results** (showing ${result.results.length}, skip: ${result.meta.skip}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

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
        const renderedTop = new Set(['patient', 'safetyreportid', 'receivedate', 'serious']);
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

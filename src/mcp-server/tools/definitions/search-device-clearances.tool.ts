/**
 * @fileoverview Tool for searching FDA device premarket notifications (510(k) clearances and PMA approvals).
 * @module mcp-server/tools/definitions/search-device-clearances
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { emptyResultMessage, formatRemainingFields } from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const searchDeviceClearancesTool = tool('openfda_search_device_clearances', {
  description: 'Search FDA device premarket notifications — 510(k) clearances and PMA approvals.',
  annotations: { readOnlyHint: true },

  input: z.object({
    pathway: z
      .enum(['510k', 'pma'])
      .describe('Premarket pathway. 510(k) is the most common; PMA is for higher-risk devices.'),
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query. Examples: applicant:"medtronic", advisory_committee_description:"cardiovascular", product_code:"DXN", openfda.device_name:"catheter". Omit to browse recent.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: decision_date:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe('Maximum number of records to return (1-1000).'),
    skip: z.number().min(0).max(25000).default(0).describe('Pagination offset (0-25000).'),
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
        '510(k) or PMA records — 510(k) carries k_number, device_name, applicant, product_code, decision_date, decision_description, advisory_committee_description; PMA carries pma_number, trade_name, generic_name, supplement_number plus shared applicant/product_code/decision_date/decision_description.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching device clearance records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the device clearance query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty — how to broaden filters or correct field names. Absent when results are returned.',
      ),
  },

  async handler(input, ctx) {
    const service = getOpenFdaService();
    const response = await service.query(
      `device/${input.pathway}`,
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Device clearance search completed', {
      pathway: input.pathway,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    if (response.results.length === 0) {
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          'No matching device clearances found. Try broadening the search — use applicant, product_code, advisory_committee_description, or openfda.device_name fields.',
        ),
      );
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No device clearances found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    const rendered510k = new Set([
      'k_number',
      'device_name',
      'applicant',
      'product_code',
      'decision_description',
      'decision_date',
      'advisory_committee',
      'advisory_committee_description',
      'clearance_type',
      'statement_or_summary',
    ]);
    const renderedPma = new Set([
      'pma_number',
      'trade_name',
      'generic_name',
      'applicant',
      'product_code',
      'decision_description',
      'decision_code',
      'decision_date',
      'advisory_committee',
      'advisory_committee_description',
      'supplement_number',
    ]);

    for (const r of result.results) {
      // 510(k)
      if (r.k_number) {
        lines.push(`### ${r.k_number}: ${r.device_name ?? 'Unknown device'}`);
        lines.push(
          `**Applicant:** ${r.applicant ?? 'N/A'} | **Product code:** ${r.product_code ?? 'N/A'}`,
        );
        lines.push(
          `**Decision:** ${r.decision_description ?? 'N/A'} (${r.decision_date ?? 'N/A'})`,
        );
        if (r.advisory_committee_description)
          lines.push(`**Advisory committee:** ${r.advisory_committee_description}`);
        if (r.clearance_type) lines.push(`**Clearance type:** ${r.clearance_type}`);
        if (r.statement_or_summary) {
          const text = String(r.statement_or_summary);
          lines.push(`**Summary:** ${text.length > 500 ? `${text.slice(0, 500)}...` : text}`);
        }
        lines.push(...formatRemainingFields(r, rendered510k));
      }
      // PMA
      else if (r.pma_number) {
        const deviceLabel = r.trade_name ?? r.generic_name ?? '';
        lines.push(`### ${r.pma_number}${deviceLabel ? `: ${deviceLabel}` : ''}`);
        lines.push(
          `**Applicant:** ${r.applicant ?? 'N/A'} | **Product code:** ${r.product_code ?? 'N/A'}`,
        );
        lines.push(
          `**Decision:** ${r.decision_description ?? r.decision_code ?? 'N/A'} (${r.decision_date ?? 'N/A'})`,
        );
        if (r.advisory_committee_description)
          lines.push(`**Advisory committee:** ${r.advisory_committee_description}`);
        if (r.supplement_number) lines.push(`**Supplement:** ${r.supplement_number}`);
        lines.push(...formatRemainingFields(r, renderedPma));
      }
      // Fallback
      else {
        lines.push(`### Record`);
        lines.push(`\`\`\`json\n${JSON.stringify(r, null, 2).slice(0, 500)}\n\`\`\``);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

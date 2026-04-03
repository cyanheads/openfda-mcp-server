/**
 * @fileoverview Tool for searching FDA device premarket notifications (510(k) clearances and PMA approvals).
 * @module mcp-server/tools/definitions/search-device-clearances
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const searchDeviceClearancesTool = tool('openfda_search_device_clearances', {
  description: 'Search FDA device premarket notifications — 510(k) clearances and PMA approvals.',
  annotations: { readOnlyHint: true },

  input: z.object({
    pathway: z
      .enum(['510k', 'pma'])
      .describe(
        'Premarket pathway. 510(k) is most common (174K+ records). PMA is for higher-risk devices.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query. Examples: applicant:"medtronic", advisory_committee_description:"cardiovascular", product_code:"DXN", openfda.device_name:"catheter". Omit to browse recent.',
      ),
    sort: z.string().optional().describe('Sort expression. Example: decision_date:desc.'),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .optional()
      .describe('Maximum number of records to return (1-1000).'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
      .optional()
      .describe('Pagination offset (0-25000).'),
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
      .describe('510(k) clearance or PMA approval records'),
    message: z
      .string()
      .optional()
      .describe('Guidance when results are empty or search can be refined'),
  }),

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

    return {
      meta: response.meta,
      results: response.results,
      message:
        response.results.length === 0
          ? 'No matching device clearances found. Try broadening the search — use applicant, product_code, advisory_committee_description, or openfda.device_name fields.'
          : undefined,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: result.message ?? 'No device clearances found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total.toLocaleString()} total results** (showing ${result.results.length}, skip: ${result.meta.skip}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

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

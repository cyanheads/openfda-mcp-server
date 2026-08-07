/**
 * @fileoverview Tool for searching FDA device premarket notifications (510(k) clearances and PMA approvals).
 * @module mcp-server/tools/definitions/search-device-clearances
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
 * Canvas table projection covering both 510(k) and PMA records (one pathway per
 * call). Scalars are VARCHAR (CAST in SQL for math); the openfda block is a JSON
 * column. All nullable — pathway-specific fields are absent on the other pathway.
 */
const DEVICE_CLEARANCES_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'k_number', type: 'VARCHAR', nullable: true },
  { name: 'pma_number', type: 'VARCHAR', nullable: true },
  { name: 'supplement_number', type: 'VARCHAR', nullable: true },
  { name: 'device_name', type: 'VARCHAR', nullable: true },
  { name: 'trade_name', type: 'VARCHAR', nullable: true },
  { name: 'generic_name', type: 'VARCHAR', nullable: true },
  { name: 'applicant', type: 'VARCHAR', nullable: true },
  { name: 'product_code', type: 'VARCHAR', nullable: true },
  { name: 'decision_date', type: 'VARCHAR', nullable: true },
  { name: 'decision_code', type: 'VARCHAR', nullable: true },
  { name: 'decision_description', type: 'VARCHAR', nullable: true },
  { name: 'advisory_committee', type: 'VARCHAR', nullable: true },
  { name: 'advisory_committee_description', type: 'VARCHAR', nullable: true },
  { name: 'clearance_type', type: 'VARCHAR', nullable: true },
  { name: 'date_received', type: 'VARCHAR', nullable: true },
  { name: 'state', type: 'VARCHAR', nullable: true },
  { name: 'country_code', type: 'VARCHAR', nullable: true },
  { name: 'expedited_review_flag', type: 'VARCHAR', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

export const searchDeviceClearancesTool = tool('openfda_search_device_clearances', {
  description: 'Search FDA device premarket notifications — 510(k) clearances and PMA approvals.',
  annotations: { readOnlyHint: true },

  input: z.object({
    pathway: z
      .enum(['510k', 'pma'])
      .describe('Premarket pathway. 510(k) is the most common; PMA is for higher-risk devices.'),
    search: nonBlankString()
      .optional()
      .describe(
        `openFDA search query. Examples: applicant:"medtronic", advisory_committee_description:"cardiovascular", product_code:"DXN", openfda.device_name:"catheter". Omit to browse recent. ${SEARCH_BALANCE_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        'Sort expression — a field path optionally suffixed with :asc or :desc; comma-separate for multi-field sort. Example: decision_date:desc. Field paths take only letters, digits, underscores, and dots; anything else is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe('Maximum number of records to return (1-1000).'),
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
    ...canvasOutputShape,
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
        'Canvas staging disclosure when the call staged, and guidance when results are empty — how to broaden filters or correct field names.',
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

    const endpoint = `device/${input.pathway}`;
    const emptyNotice = (skip: number, total: number) =>
      emptyResultMessage(
        skip,
        total,
        `No matching device clearances found. Try broadening the search — use applicant, product_code, advisory_committee_description, or openfda.device_name fields. ${formatFieldHint(endpoint)}`,
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
        schema: DEVICE_CLEARANCES_CANVAS_SCHEMA,
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

    const service = getOpenFdaService();
    const response = await service.query(
      endpoint,
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
      ctx.enrich.notice(emptyNotice(response.meta.skip, response.meta.total));
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0 && result.meta.total === 0) {
      return [
        {
          type: 'text' as const,
          text: noMatchNote('No device clearances found.', result.meta.skip),
        },
      ];
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

    /**
     * Keys the curated lines below emit verbatim and unconditionally. Anything
     * rendered only as a fallback (`generic_name` behind `trade_name`) or never
     * rendered (`advisory_committee`, the raw committee code) stays out, so
     * `formatRemainingFields` carries it into `content[]`.
     */
    const rendered510k = new Set([
      'k_number',
      'device_name',
      'applicant',
      'product_code',
      'decision_description',
      'decision_date',
      'advisory_committee_description',
      'clearance_type',
      'statement_or_summary',
    ]);
    const renderedPma = new Set([
      'pma_number',
      'trade_name',
      'applicant',
      'product_code',
      'decision_description',
      'decision_date',
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
          lines.push(`**Summary:** ${String(r.statement_or_summary)}`);
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
        lines.push(`\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

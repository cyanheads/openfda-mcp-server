/**
 * @fileoverview Tool for searching FDA device premarket notifications (510(k)
 * clearances and PMA approvals). 510(k) records carry a summary narrative and run
 * several kilobytes each, so the inline page is bounded by a serialized-byte budget
 * and discloses any records it withheld along with the routes to them.
 * @module mcp-server/tools/definitions/search-device-clearances
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  emptyPageBody,
  emptyResultMessage,
  formatRemainingFields,
  projectedRecordLines,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  malformedSearchError,
  nonBlankString,
  SEARCH_BALANCE_NOTE,
  SKIP_DESCRIPTION,
  sortExpression,
  totalUnverifiedField,
} from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  canvasCapacityExhaustedError,
  canvasDisabledError,
  canvasNotFoundError,
  canvasOutputShape,
  canvasResult,
  STAGING_WORKFLOW,
  spillSearch,
  stageInput,
  stagingNotice,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  boundedPage,
  META_LIMIT_DESCRIPTION,
  PAGE_BUDGET_NOTE,
  pageBudgetNotice,
  pageBudgetOutputShape,
} from '@/services/openfda/page-budget.js';
import {
  projectionNotice,
  projectionOutputShape,
  recordProjection,
} from '@/services/openfda/record-projection.js';

/**
 * Keys that tell one record apart, kept on every `fields`-projected record:
 * `k_number` on 510(k) records; `pma_number` plus
 * `supplement_number` on PMA records, since every supplement shares its PMA's
 * number.
 */
const IDENTITY_KEYS = ['k_number', 'pma_number', 'supplement_number'] as const;

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
  description: `Search FDA device premarket notifications — 510(k) clearances and PMA approvals.${STAGING_WORKFLOW}`,
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
        'Sort expression — a field path optionally suffixed with :asc or :desc (any letter case; :ascending and :descending are also accepted, and every direction is sent as asc or desc); comma-separate for multi-field sort. Example: decision_date:desc. Field paths take only letters, digits, underscores, and dots; any other character or direction is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe(
        `Maximum number of records to return (1-1000, default 10). ${PAGE_BUDGET_NOTE} A 510(k) record carries a summary narrative and is several times the size of a PMA record.`,
      ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['decision_date', 'applicant'])),
    stage: stageInput,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID returned by a prior stage=true call to this tool or another openFDA search tool (openfda_search_* or openfda_lookup_ndc). Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
    ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe(META_LIMIT_DESCRIPTION),
        lastUpdated: z.string().describe('Dataset last updated date'),
        totalUnverified: totalUnverifiedField,
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        '510(k) or PMA records — 510(k) carries k_number, device_name, applicant, product_code, decision_date, decision_description, advisory_committee_description; PMA carries pma_number, trade_name, generic_name, supplement_number plus shared applicant/product_code/decision_date/decision_description.',
      ),
    ...pageBudgetOutputShape,
    ...projectionOutputShape,
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
        'Canvas staging disclosure when the call staged, the fields projection and any requested path no record carries, the byte-budget disclosure when the inline page was bounded or one record exceeds it (with the routes to the withheld records and the largest fields of the oversized record), and guidance when results are empty — how to broaden filters or correct field names.',
      ),
  },

  errors: [
    canvasDisabledError,
    canvasNotFoundError,
    canvasCapacityExhaustedError,
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The openFDA daily or per-minute request limit is exceeded.',
      retryable: true,
      recovery:
        'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The openFDA API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
      thrownBy: 'service',
    },
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    {
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'skip exceeds the 25000 record pagination ceiling.',
      recovery:
        'Narrow the search query with additional filters or date ranges instead of increasing skip.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);

    const endpoint = `device/${input.pathway}`;
    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No matching device clearances found. Try broadening the search — use applicant, product_code, advisory_committee_description, or openfda.device_name fields. ${formatFieldHint(endpoint)}`,
        totalUnverified,
      );

    const projection = recordProjection(input.fields, IDENTITY_KEYS);
    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'Staging requires DataCanvas. Set CANVAS_PROVIDER_TYPE=duckdb, or drop stage/canvas_id for the inline page.',
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
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      ctx.enrich.notice(
        [
          spill.preview.length === 0 ? emptyNotice(spill.skip, spill.total) : undefined,
          projectionNotice(staged),
          pageBudgetNotice(staged),
          stagingNotice(spill),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return staged;
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

    const page = boundedPage(response, projection);

    ctx.log.info('Device clearance search completed', {
      pathway: input.pathway,
      total: response.meta.total,
      returned: page.results.length,
      pageOmitted: page.page_omitted,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    const notices = [
      page.results.length === 0
        ? emptyNotice(response.meta.skip, response.meta.total, response.meta.totalUnverified)
        : undefined,
      projectionNotice(page),
      pageBudgetNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No device clearances found.'));
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
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      // 510(k)
      if (r.k_number) {
        lines.push(singleLine(`### ${r.k_number}: ${r.device_name ?? 'Unknown device'}`));
        lines.push(
          singleLine(
            `**Applicant:** ${r.applicant ?? 'N/A'} | **Product code:** ${r.product_code ?? 'N/A'}`,
          ),
        );
        lines.push(
          singleLine(
            `**Decision:** ${r.decision_description ?? 'N/A'} (${r.decision_date ?? 'N/A'})`,
          ),
        );
        if (r.advisory_committee_description)
          lines.push(singleLine(`**Advisory committee:** ${r.advisory_committee_description}`));
        if (r.clearance_type) lines.push(singleLine(`**Clearance type:** ${r.clearance_type}`));
        if (r.statement_or_summary) {
          lines.push(singleLine(`**Summary:** ${String(r.statement_or_summary)}`));
        }
        lines.push(...formatRemainingFields(r, rendered510k));
      }
      // PMA
      else if (r.pma_number) {
        const deviceLabel = r.trade_name ?? r.generic_name ?? '';
        lines.push(singleLine(`### ${r.pma_number}${deviceLabel ? `: ${deviceLabel}` : ''}`));
        lines.push(
          singleLine(
            `**Applicant:** ${r.applicant ?? 'N/A'} | **Product code:** ${r.product_code ?? 'N/A'}`,
          ),
        );
        lines.push(
          singleLine(
            `**Decision:** ${r.decision_description ?? r.decision_code ?? 'N/A'} (${r.decision_date ?? 'N/A'})`,
          ),
        );
        if (r.advisory_committee_description)
          lines.push(singleLine(`**Advisory committee:** ${r.advisory_committee_description}`));
        if (r.supplement_number) lines.push(singleLine(`**Supplement:** ${r.supplement_number}`));
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

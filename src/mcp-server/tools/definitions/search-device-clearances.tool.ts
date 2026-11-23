/**
 * @fileoverview Tool for searching FDA device premarket records: 510(k)
 * clearances, PMA approvals, and the product classification registry. The
 * `pathway` picks the endpoint, and with it the identity key, the bare-browse
 * sort, the page size, and the staged column list. 510(k) records carry a
 * summary narrative and run several kilobytes each, so `limit`'s default and cap
 * follow the pathway, and a page holding a record over 24,000 bytes names its
 * largest fields.
 * @module mcp-server/tools/definitions/search-device-clearances
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import { DEVICE_CLASSES, SUBMISSION_TYPES } from '@/mcp-server/tools/device-codes.js';
import { codeLabel } from '@/mcp-server/tools/drug-event-codes.js';
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
  type CursorQuery,
  cursorEndNotice,
  cursorInput,
  cursorOutputShape,
  invalidCursorError,
  nextCursorField,
  resolveCursor,
} from '@/mcp-server/tools/pagination-cursor.js';
import {
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  limitAboveCapError,
  type PageKind,
  pageLimitBy,
  pageMetaOutput,
  pageSizeNotice,
  paginationLimitReachedError,
  rateLimitedError,
  resolvePageSize,
  SKIP_DESCRIPTION,
  searchNoticeField,
  sortDescription,
  sortExpression,
  upstreamError,
} from '@/mcp-server/tools/schema-utils.js';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
  phrasePlusHint,
  SEARCH_SYNTAX_NOTE,
  searchExpression,
} from '@/mcp-server/tools/search-expression.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  CANVAS_DISABLED_MESSAGE,
  canvasCapacityExhaustedError,
  canvasDisabledError,
  canvasIdInput,
  canvasNotFoundError,
  canvasOutputShape,
  canvasResult,
  STAGING_WORKFLOW,
  spillSearch,
  stageInput,
  stagingNotice,
  varcharColumns,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  inlinePage,
  oversizedRecordNotice,
  oversizedRecordOutputShape,
} from '@/services/openfda/page-budget.js';
import {
  projectionNotice,
  projectionOutputShape,
  recordProjection,
} from '@/services/openfda/record-projection.js';

/** The sort a bare 510(k) or PMA browse sends: newest FDA decision first. */
const NEWEST_FIRST = 'decision_date:desc';

/**
 * A pathway's staged columns, one per top-level field its endpoint returns
 * (verified live 2026-11-22), fixed per endpoint rather than read off the matched
 * rows, so two stagings of one pathway always `UNION ALL`. All nullable: a record
 * lacking a field stages NULL. `fields` are the VARCHAR scalars (CAST in SQL for
 * math); `openfda`, the one object a device record carries, follows them as a JSON
 * column.
 */
function stagedColumns(fields: readonly string[]): ColumnSchema[] {
  return [...varcharColumns(fields), { name: 'openfda', type: 'JSON', nullable: true }];
}

/** Every top-level field `device/510k` returns. */
const K510_CANVAS_SCHEMA = stagedColumns([
  'k_number',
  'device_name',
  'applicant',
  'contact',
  'product_code',
  'decision_date',
  'decision_code',
  'decision_description',
  'advisory_committee',
  'advisory_committee_description',
  'review_advisory_committee',
  'clearance_type',
  'date_received',
  'third_party_flag',
  'expedited_review_flag',
  'statement_or_summary',
  'address_1',
  'address_2',
  'city',
  'state',
  'zip_code',
  'postal_code',
  'country_code',
]);

/** Every top-level field `device/pma` returns. */
const PMA_CANVAS_SCHEMA = stagedColumns([
  'pma_number',
  'supplement_number',
  'supplement_type',
  'supplement_reason',
  'trade_name',
  'generic_name',
  'applicant',
  'product_code',
  'decision_date',
  'decision_code',
  'advisory_committee',
  'advisory_committee_description',
  'date_received',
  'expedited_review_flag',
  'docket_number',
  'fed_reg_notice_date',
  'ao_statement',
  'street_1',
  'street_2',
  'city',
  'state',
  'zip',
  'zip_ext',
]);

/** Every top-level field `device/classification` returns — all 17 are on every one of its records. */
const CLASSIFICATION_CANVAS_SCHEMA = stagedColumns([
  'product_code',
  'device_name',
  'device_class',
  'regulation_number',
  'submission_type_id',
  'definition',
  'medical_specialty',
  'medical_specialty_description',
  'review_panel',
  'review_code',
  'implant_flag',
  'life_sustain_support_flag',
  'gmp_exempt_flag',
  'third_party_flag',
  'summary_malfunction_reporting',
  'unclassified_reason',
]);

const CLEARANCES_EMPTY_HINT =
  'No matching device clearances found. Try broadening the search — use applicant, product_code, advisory_committee_description, or openfda.device_name fields.';

/**
 * What each `pathway` reads: the endpoint; the keys that tell its records apart,
 * kept on every `fields`-projected record (a PMA supplement shares its PMA's
 * number, so PMA keeps both); the sort a bare browse sends — none on
 * classification, whose records carry no date (`decision_date:desc` answers HTTP
 * 500 there); the staged column list; and the empty-result hint.
 */
const PATHWAYS = {
  '510k': {
    endpoint: 'device/510k',
    identityKeys: ['k_number'],
    newestFirst: NEWEST_FIRST,
    schema: K510_CANVAS_SCHEMA,
    emptyHint: CLEARANCES_EMPTY_HINT,
  },
  pma: {
    endpoint: 'device/pma',
    identityKeys: ['pma_number', 'supplement_number'],
    newestFirst: NEWEST_FIRST,
    schema: PMA_CANVAS_SCHEMA,
    emptyHint: CLEARANCES_EMPTY_HINT,
  },
  classification: {
    endpoint: 'device/classification',
    identityKeys: ['product_code'],
    newestFirst: undefined,
    schema: CLASSIFICATION_CANVAS_SCHEMA,
    emptyHint:
      'No matching device classifications found. Try broadening the search — use product_code, device_name, regulation_number, device_class, or submission_type_id fields.',
  },
} as const satisfies Record<
  string,
  {
    emptyHint: string;
    endpoint: PageKind;
    identityKeys: readonly string[];
    newestFirst: string | undefined;
    schema: ColumnSchema[];
  }
>;

/**
 * Every pathway's identity keys, in the order `format()` looks for a projected
 * record's heading: 510(k) and PMA records carry `product_code` too, so their
 * own keys come first.
 */
const HEADING_KEYS = ['k_number', 'pma_number', 'supplement_number', 'product_code'] as const;

export const searchDeviceClearancesTool = tool('openfda_search_device_clearances', {
  description: `Search FDA device premarket records: 510(k) clearances, PMA approvals, and the product classification registry (class and required submission type per product code).${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    pathway: z
      .enum(['510k', 'pma', 'classification'])
      .describe(
        "Premarket pathway. 510(k) is the most common; PMA is for higher-risk devices; classification is the product-code registry: each device type's class and the submission it requires.",
      ),
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query, e.g. applicant:"medtronic", advisory_committee_description:"cardiovascular", product_code:"DXN", openfda.device_name:"catheter"; on classification, device_class:"3" or submission_type_id:"4" (510(k) exempt). Omit to browse newest first (unsorted on classification). ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        sortDescription({
          newest: `${NEWEST_FIRST} (classification records carry no date, so a classification browse is unsorted)`,
        }),
      ),
    limit: pageLimitBy(
      'pathway',
      [
        ['510k', 'device/510k'],
        ['pma', 'device/pma'],
        ['classification', 'device/classification'],
      ],
      'Records per page.',
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(
        fieldsDescription(
          [
            'k_number on 510(k); pma_number and supplement_number on PMA; product_code on classification',
          ],
          ['decision_date', 'applicant'],
        ),
      ),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        '510(k), PMA, or classification records — 510(k) carries k_number, device_name, applicant, product_code, decision_date, decision_description, advisory_committee_description; PMA carries pma_number, trade_name, generic_name, supplement_number plus shared applicant/product_code/decision_date and decision_code; classification carries product_code, device_name, device_class, regulation_number, submission_type_id, definition, and the *_flag fields.',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching device records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the device query, as submitted to openFDA'),
    notice: searchNoticeField(),
  },

  errors: [
    limitAboveCapError,
    canvasDisabledError,
    canvasNotFoundError,
    canvasCapacityExhaustedError,
    rateLimitedError,
    upstreamError,
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    paginationLimitReachedError,
    invalidCursorError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);

    const pathway = PATHWAYS[input.pathway];
    const size = resolvePageSize(input.limit, pathway.endpoint, ctx);
    const query: CursorQuery = {
      endpoint: pathway.endpoint,
      search: input.search,
      sort:
        pathway.newestFirst === undefined ? input.sort : sortOrNewest(input, pathway.newestFirst),
    };
    const searchAfter = resolveCursor(input, query, ctx);

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `${pathway.emptyHint} ${formatFieldHint(pathway.endpoint)}`,
        totalUnverified,
        searchAfter !== undefined,
      );

    const projection = recordProjection(input.fields, pathway.identityKeys);
    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail('canvas_disabled', CANVAS_DISABLED_MESSAGE);
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint: query.endpoint,
        search: query.search,
        sort: query.sort,
        canvasId: input.canvas_id,
        schema: pathway.schema,
        limit: size.limit,
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
          phrasePlusHint(input.search, spill.total),
          pageSizeNotice(size, staged),
          projectionNotice(staged),
          oversizedRecordNotice(staged),
          stagingNotice(spill),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return staged;
    }

    const service = getOpenFdaService();
    const response = await service.query(
      query.endpoint,
      {
        search: query.search,
        sort: query.sort,
        limit: size.limit,
        skip: input.skip,
        searchAfter,
      },
      ctx,
    );

    const page = {
      ...inlinePage(response, size.limit, projection),
      ...nextCursorField(response, query),
    };

    ctx.log.info('Device clearance search completed', {
      pathway: input.pathway,
      total: response.meta.total,
      returned: page.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    const notices = [
      page.results.length === 0
        ? emptyNotice(response.meta.skip, response.meta.total, response.meta.totalUnverified)
        : undefined,
      phrasePlusHint(input.search, response.meta.total),
      pageSizeNotice(size, page) ?? cursorEndNotice(page, searchAfter),
      projectionNotice(page),
      oversizedRecordNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No device records found.'));
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
        lines.push(...projectedRecordLines(r, HEADING_KEYS), '');
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
      // Classification — the only shape with a top-level device_class. The labels
      // keep the code beside them (`Class II (2)`), so the raw value still reaches content[].
      else if (r.device_class) {
        lines.push(
          singleLine(
            `### ${r.product_code || 'Record'}${r.device_name ? `: ${r.device_name}` : ''}`,
          ),
        );
        const rendered = new Set(['product_code', 'device_name', 'device_class']);
        const coded = [`**Class:** ${codeLabel(DEVICE_CLASSES, r.device_class)}`];
        if (r.submission_type_id) {
          coded.push(`**Submission type:** ${codeLabel(SUBMISSION_TYPES, r.submission_type_id)}`);
          rendered.add('submission_type_id');
        }
        lines.push(singleLine(coded.join(' | ')));
        lines.push(...formatRemainingFields(r, rendered));
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

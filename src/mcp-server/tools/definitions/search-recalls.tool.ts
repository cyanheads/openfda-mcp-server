/**
 * @fileoverview Tool for searching openFDA enforcement reports and recall actions.
 * Device enforcement and recall records run several kilobytes each, so `limit`'s
 * default and cap follow the category and endpoint, a default device page leaves
 * its lot and registrant lists out of each record (`include` returns them), and a
 * page holding a record over 24,000 bytes names its largest fields.
 * @module mcp-server/tools/definitions/search-recalls
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
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
import { fieldPathsNamed } from '@/mcp-server/tools/search-clauses.js';
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
  includeDescription,
  LEFT_OUT_NOTICE_TOPIC,
  omissionNotice,
  omissionOutputShape,
  pageProjection,
  projectionNotice,
  projectionOutputShape,
} from '@/services/openfda/record-projection.js';

/**
 * Keys that tell one record apart, kept on every `fields`-projected record:
 * `recall_number` on enforcement reports, `product_res_number` on device/recall
 * records.
 */
const IDENTITY_KEYS = ['recall_number', 'product_res_number'] as const;

/**
 * The sort a bare browse sends, per endpoint shape: enforcement reports (every
 * category) by the date FDA posted the report, device/recall records by the date
 * the firm initiated the recall.
 */
const NEWEST_ENFORCEMENT = 'report_date:desc';
const NEWEST_DEVICE_RECALL = 'event_date_initiated:desc';
const NEWEST_FIRST_NOTE = `${NEWEST_ENFORCEMENT} (${NEWEST_DEVICE_RECALL} on the device recall endpoint)`;

/**
 * Canvas table projection for enforcement records (every category) — every
 * top-level field the drug, device, and food enforcement endpoints return,
 * verified against live records. openFDA cuts `code_info` at 32,600 characters
 * and continues the lot list in `more_code_info`, so both stage verbatim and
 * `code_info || coalesce(more_code_info, '')` recovers the whole list. Scalars
 * are VARCHAR (CAST in SQL for math); the openfda block is a JSON column. All
 * nullable — records are sparse. The canvas ignores fields outside the schema,
 * so each endpoint shape stages against its own column set.
 */
const ENFORCEMENT_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns([
    'recall_number',
    'event_id',
    'status',
    'classification',
    'product_type',
    'recalling_firm',
    'product_description',
    'reason_for_recall',
    'voluntary_mandated',
    'initial_firm_notification',
    'distribution_pattern',
    'product_quantity',
    'code_info',
    'more_code_info',
    'recall_initiation_date',
    'report_date',
    'center_classification_date',
    'termination_date',
    'state',
    'country',
    'city',
    'address_1',
    'address_2',
    'postal_code',
  ]),
  { name: 'openfda', type: 'JSON', nullable: true },
];

/**
 * Canvas table projection for device/recall records — every top-level field the
 * endpoint returns, verified against live records. Identity and status live in
 * `product_res_number` and `recall_status`; the endpoint carries no recall
 * hazard classification, so the enforcement-only columns would only ever be
 * NULL here. `k_numbers`/`pma_numbers` and the openfda block are JSON columns.
 */
const DEVICE_RECALL_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns([
    'cfres_id',
    'product_res_number',
    'res_event_number',
    'recall_status',
    'event_date_initiated',
    'event_date_posted',
    'event_date_created',
    'event_date_terminated',
    'recalling_firm',
    'firm_fei_number',
    'address_1',
    'address_2',
    'city',
    'state',
    'postal_code',
    'country',
    'additional_info_contact',
    'product_code',
    'product_description',
    'product_quantity',
    'code_info',
    'reason_for_recall',
    'root_cause_description',
    'action',
    'distribution_pattern',
  ]),
  { name: 'k_numbers', type: 'JSON', nullable: true },
  { name: 'pma_numbers', type: 'JSON', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

const Category = z.enum(['drug', 'food', 'device']).describe('Product category');

const Endpoint = z
  .enum(['enforcement', 'recall'])
  .default('enforcement')
  .describe('Report type: enforcement reports, or recall (devices only).');

export const searchRecallsTool = tool('openfda_search_recalls', {
  description: `Search enforcement reports and recall actions across drugs, food, and devices.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    category: Category,
    endpoint: Endpoint,
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query, e.g. classification:"Class I" (or "Class II", "Class III"), recalling_firm:"pfizer", reason_for_recall:"undeclared allergen". Omit to browse newest first. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        sortDescription({
          example: 'report_date:desc,status.exact:asc',
          newest: NEWEST_FIRST_NOTE,
        }),
      ),
    limit: pageLimitBy(
      'category and endpoint',
      [
        ['drug or food enforcement', 'drug/enforcement'],
        ['device enforcement', 'device/enforcement'],
        ['device recall', 'device/recall'],
      ],
      'Records per page.',
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['recalling_firm', 'reason_for_recall'])),
    include: fieldSelection()
      .optional()
      .describe(
        includeDescription([
          ['device enforcement', 'device/enforcement'],
          ['device recall', 'device/recall'],
        ]),
      ),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Enforcement records (every category) carry recall_number, classification, status, voluntary_mandated, recalling_firm, product_description, reason_for_recall, distribution_pattern, report_date. Device recall records carry product_res_number, recall_status, res_event_number, root_cause_description, and the firm, product, reason, and distribution fields, but no hazard classification.',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...omissionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching recall/enforcement records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the recall query, as submitted to openFDA'),
    notice: searchNoticeField([LEFT_OUT_NOTICE_TOPIC]),
  },

  errors: [
    {
      reason: 'recall_endpoint_non_device',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The recall endpoint was requested for a non-device category.',
      recovery: 'Set endpoint=enforcement for drug and food categories; recall is device-only.',
    },
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

    const endpointValue = input.endpoint ?? 'enforcement';

    if (endpointValue === 'recall' && input.category !== 'device') {
      throw ctx.fail(
        'recall_endpoint_non_device',
        'The recall endpoint is only available for devices. Use enforcement for drug and food recalls.',
      );
    }

    // The recall endpoint is device-only, checked above.
    const resolvedEndpoint =
      endpointValue === 'recall' ? 'device/recall' : (`${input.category}/enforcement` as const);
    const size = resolvePageSize(input.limit, resolvedEndpoint, ctx);
    const query: CursorQuery = {
      endpoint: resolvedEndpoint,
      search: input.search,
      sort: sortOrNewest(
        input,
        endpointValue === 'recall' ? NEWEST_DEVICE_RECALL : NEWEST_ENFORCEMENT,
      ),
    };
    const searchAfter = resolveCursor(input, query, ctx);
    // A device/recall record carries no `classification`; its class is `openfda.device_class`.
    const classField = endpointValue === 'recall' ? 'openfda.device_class' : 'classification';
    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No recall/enforcement records matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''} in ${resolvedEndpoint}. Try broadening filters or check field names (e.g. ${classField}, recalling_firm, reason_for_recall). ${formatFieldHint(resolvedEndpoint)}`,
        totalUnverified,
        searchAfter !== undefined,
      );

    const projection = pageProjection(resolvedEndpoint, IDENTITY_KEYS, {
      fields: input.fields,
      include: input.include,
      searched: input.search ? fieldPathsNamed(input.search) : undefined,
    });
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
        schema:
          endpointValue === 'recall' ? DEVICE_RECALL_CANVAS_SCHEMA : ENFORCEMENT_CANVAS_SCHEMA,
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
          omissionNotice(staged),
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

    ctx.log.info('Recall search completed', {
      category: input.category,
      endpoint: endpointValue,
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
      omissionNotice(page),
      oversizedRecordNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lead = searchLead(result);
    if (result.results.length === 0) {
      lead.push(emptyPageBody(result, 'No results found.'));
      return [{ type: 'text' as const, text: lead.join('\n') }];
    }

    /**
     * Keys each branch's curated lines emit verbatim whenever present. The two
     * endpoint shapes share firm, product, reason, and distribution, but name
     * identity and status differently — and device/recall carries no recall
     * hazard classification (`openfda.device_class` is the product's regulatory
     * class), so its branch prints none.
     */
    const sharedRendered = [
      'recalling_firm',
      'product_description',
      'reason_for_recall',
      'distribution_pattern',
    ];
    const renderedEnforcement = new Set([
      ...sharedRendered,
      'recall_number',
      'classification',
      'status',
      'voluntary_mandated',
    ]);
    const renderedDeviceRecall = new Set([
      ...sharedRendered,
      'product_res_number',
      'recall_status',
    ]);

    const records = result.results.map((r) => {
      if (result.projected_fields) return projectedRecordLines(r, IDENTITY_KEYS).join('\n');
      // device/recall — detected structurally, since format() never sees the endpoint input.
      const deviceRecall = r.product_res_number != null;
      const lines = [
        deviceRecall
          ? `**Recall #${r.product_res_number}**`
          : `**Recall #${r.recall_number ?? 'N/A'}** — ${r.classification ?? 'Unclassified'}`,
        `Firm: ${r.recalling_firm ?? 'N/A'}`,
        `Product: ${(r.product_description as string | undefined) || 'N/A'}`,
        `Reason: ${(r.reason_for_recall as string | undefined) || 'N/A'}`,
        deviceRecall
          ? `Status: ${r.recall_status ?? 'N/A'}`
          : `Status: ${r.status ?? 'N/A'} | ${r.voluntary_mandated ?? 'N/A'}`,
      ].map(singleLine);
      if (r.distribution_pattern) {
        lines.push(singleLine(`Distribution: ${r.distribution_pattern}`));
      }
      lines.push(
        ...formatRemainingFields(r, deviceRecall ? renderedDeviceRecall : renderedEnforcement),
      );
      return lines.join('\n');
    });

    return [{ type: 'text' as const, text: [...lead, records.join('\n\n---\n\n')].join('\n') }];
  },
});

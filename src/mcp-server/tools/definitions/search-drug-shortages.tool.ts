/**
 * @fileoverview Tool for searching FDA drug shortage records via the drug/shortages
 * endpoint. Records are small, so `limit` reaches openFDA's 1000-record page maximum.
 * @module mcp-server/tools/definitions/search-drug-shortages
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
  pageLimit,
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
import { rewriteShortageDates, shortageDateGroupHint } from '@/mcp-server/tools/shortage-dates.js';
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

/**
 * Keys that tell one record apart, kept on every `fields`-projected record:
 * `package_ndc`.
 */
const IDENTITY_KEYS = ['package_ndc'] as const;

/**
 * The sort a bare browse sends: the most recently updated record first. Every
 * record's `update_date` is on or after its `initial_posting_date`, so a new
 * posting leads too.
 */
const NEWEST_FIRST = 'update_date:desc';

/**
 * Canvas table projection for drug shortage records — every top-level field the
 * endpoint returns, verified against live records. Scalars are VARCHAR (CAST in
 * SQL for math); the openfda cross-link block is a JSON column. openFDA sends
 * `therapeutic_category` as an array, staged as one comma-joined VARCHAR
 * (`Rheumatology,Oncology`) because SQL written against earlier releases reads
 * that text form; no category name contains a comma. All nullable — a record
 * lacking a field stages NULL, and the column set never follows the matched
 * rows, so two stagings of this endpoint always union.
 */
const DRUG_SHORTAGES_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns([
    'generic_name',
    'status',
    'availability',
    'therapeutic_category',
    'dosage_form',
    'presentation',
    'package_ndc',
    'company_name',
    'initial_posting_date',
    'update_date',
    'update_type',
    'discontinued_date',
    'change_date',
    'shortage_reason',
    'contact_info',
    'related_info',
    'related_info_link',
    'resolved_note',
  ]),
  { name: 'openfda', type: 'JSON', nullable: true },
];

export const searchDrugShortagesTool = tool('openfda_search_drug_shortages', {
  description: `Search FDA drug shortage records. Returns per-product shortage status, availability, therapeutic category, dosage form, manufacturer, and dates. Use to check whether a drug is currently in shortage, find all oncology drugs with supply issues, or retrieve the openfda block (brand_name, product_ndc, rxcui) to chain into openfda_get_drug_label or openfda_lookup_ndc.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression()
      .overwrite(rewriteShortageDates)
      .optional()
      .describe(
        `openFDA search query, e.g. status:"Current", therapeutic_category:"Oncology", generic_name:"carboplatin", company_name:"pfizer", update_date:[2026-01-01 TO 2026-12-31]. Dates on initial_posting_date, update_date, discontinued_date, and change_date are stored MM/DD/YYYY and written YYYY-MM-DD; one written YYYYMMDD, M/D/YYYY, or YYYY-M-D is rewritten to YYYY-MM-DD. Omit to browse newest first. ${SEARCH_SYNTAX_NOTE} Call openfda_describe_fields({ endpoint: "drug/shortages" }) for the complete field list.`,
      ),
    sort: sortExpression()
      .optional()
      .describe(sortDescription({ newest: NEWEST_FIRST })),
    limit: pageLimit('drug/shortages', 'Records per page.'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['generic_name', 'status'])),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Drug shortage records. Key fields: generic_name, status ("Current", "To Be Discontinued", or "Resolved"), availability, therapeutic_category, dosage_form, presentation, package_ndc, company_name, contact_info, initial_posting_date, update_date, update_type. openfda block contains brand_name, product_ndc, rxcui, spl_set_id for cross-linking.',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching drug shortage records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the drug/shortages query, as submitted to openFDA'),
    notice: searchNoticeField(),
  },

  errors: [
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
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases). Call openfda_describe_fields({ endpoint: "drug/shortages" }) for valid field paths.',
      thrownBy: 'service',
    },
    paginationLimitReachedError,
    invalidCursorError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);
    const size = resolvePageSize(input.limit, 'drug/shortages', ctx);
    const query: CursorQuery = {
      endpoint: 'drug/shortages',
      search: input.search,
      sort: sortOrNewest(input, NEWEST_FIRST),
    };
    const searchAfter = resolveCursor(input, query, ctx);

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) => {
      const groupHint = shortageDateGroupHint(input.search);
      return emptyResultMessage(
        skip,
        total,
        `No drug shortage records matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''}.${groupHint ? ` ${groupHint}` : ''} Try broader filters or check field names. ${formatFieldHint('drug/shortages')}`,
        totalUnverified,
        searchAfter !== undefined,
      );
    };

    const projection = recordProjection(input.fields, IDENTITY_KEYS);
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
        schema: DRUG_SHORTAGES_CANVAS_SCHEMA,
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

    const svc = getOpenFdaService();
    const response = await svc.query(
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

    ctx.log.info('Drug shortage search completed', {
      search: input.search,
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
      lines.push(emptyPageBody(result, 'No drug shortage records found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

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
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      const name = (r.generic_name as string | undefined) ?? 'Unknown';
      const status = (r.status as string | undefined) ?? 'N/A';
      lines.push(singleLine(`### ${name}`));
      lines.push(singleLine(`**Status:** ${status}`));

      if (r.availability) lines.push(singleLine(`**Availability:** ${r.availability as string}`));
      // openFDA sends therapeutic_category as an array; a bare string is rendered as is.
      const category = r.therapeutic_category as string[] | string | undefined;
      if (category) {
        const categories = Array.isArray(category) ? category.join(', ') : category;
        lines.push(singleLine(`**Therapeutic category:** ${categories}`));
      }
      if (r.dosage_form) lines.push(singleLine(`**Dosage form:** ${r.dosage_form}`));
      if (r.presentation) lines.push(singleLine(`**Presentation:** ${r.presentation}`));
      if (r.company_name) lines.push(singleLine(`**Manufacturer:** ${r.company_name}`));
      if (r.contact_info) lines.push(singleLine(`**Contact:** ${r.contact_info as string}`));

      const dates = [
        r.initial_posting_date ? `first posted ${r.initial_posting_date}` : null,
        r.update_date ? `updated ${r.update_date}` : null,
        r.update_type ? `(${r.update_type})` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      if (dates) lines.push(singleLine(`**Timeline:** ${dates}`));

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
        if (crossLinks) lines.push(singleLine(`**OpenFDA:** ${crossLinks}`));
        /**
         * Remaining openfda leaves — the full NDC/RxCUI lists, spl ids, substance,
         * product type, route, UNII, application number.
         */
        lines.push(...formatRemainingFields(openfda, new Set(['brand_name'])));
      }

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

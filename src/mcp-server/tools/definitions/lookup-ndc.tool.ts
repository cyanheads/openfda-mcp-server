/**
 * @fileoverview MCP tool for looking up drugs in the openFDA NDC (National Drug
 * Code) Directory, or, with `dataset: "nsde"`, in the NDC SPL Data Elements file
 * (`other/nsde`), which holds one flat row per package, keyed by its 11-digit
 * NDC, ended packages included. A Directory record grows with its packaging
 * list, and a page holding a record over 24,000 bytes names its largest fields.
 * @module mcp-server/tools/definitions/lookup-ndc
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFieldHint, OBJECT_ARRAY_PATHS } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  emptyResultMessage,
  formatRemainingFields,
  lineContent,
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
  CONJOINED_ARRAY_NOTICE_TOPIC,
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
import { arrayTieNotice } from '@/mcp-server/tools/search-clauses.js';
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

/**
 * Keys that tell one record apart, kept on every `fields`-projected record:
 * `product_ndc` on an NDC Directory record, `package_ndc11` on an NSDE row.
 */
const IDENTITY_KEYS = ['product_ndc', 'package_ndc11'] as const;

/**
 * Canvas table projection for NDC directory records: every top-level field
 * `drug/ndc` returns (live, 2026-11-22), fixed so two stagings of the endpoint
 * always share one column set. Scalars are VARCHAR (`finished`, a boolean,
 * reads `'true'`/`'false'`); `route`, `pharm_class`, and the
 * ingredient/packaging/openfda structures are JSON columns. All nullable.
 */
const NDC_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns([
    'product_ndc',
    'product_id',
    'spl_id',
    'brand_name',
    'brand_name_base',
    'brand_name_suffix',
    'generic_name',
    'labeler_name',
    'dosage_form',
    'product_type',
    'marketing_category',
    'application_number',
    'marketing_start_date',
    'marketing_end_date',
    'listing_expiration_date',
    'dea_schedule',
    'finished',
  ]),
  { name: 'route', type: 'JSON', nullable: true },
  { name: 'active_ingredients', type: 'JSON', nullable: true },
  { name: 'packaging', type: 'JSON', nullable: true },
  { name: 'pharm_class', type: 'JSON', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

/**
 * Canvas table projection for NSDE rows: every top-level field `other/nsde`
 * returns, each a scalar, so all VARCHAR. All nullable.
 */
const NSDE_CANVAS_SCHEMA = varcharColumns([
  'package_ndc11',
  'package_ndc',
  'proprietary_name',
  'dosage_form',
  'product_type',
  'billing_unit',
  'marketing_category',
  'application_number_or_citation',
  'marketing_start_date',
  'marketing_end_date',
  'inactivation_date',
  'reactivation_date',
]);

/** The endpoint each `dataset` value searches, and the table its rows stage into. */
const DATASETS = {
  ndc: { endpoint: 'drug/ndc', schema: NDC_CANVAS_SCHEMA },
  nsde: { endpoint: 'other/nsde', schema: NSDE_CANVAS_SCHEMA },
} as const;

/**
 * An NDC as a search can spell it: a 10- or 11-digit run, a hyphenated product
 * (4-4, 5-3, 5-4), or a hyphenated package (4-4-2, 5-3-2, 5-4-1, and 5-4-2, the
 * 11-digit form). A letter, digit, underscore, or hyphen on either side rules a
 * match out, which keeps it off dates, application numbers, UPCs, 9-digit runs,
 * and the digit runs inside a UUID. Every quantifier is bounded, so the scan is
 * linear in the length of the search.
 */
const NDC_TOKEN =
  /(?<![\w-])(?:\d{10,11}|\d{4}-\d{4}(?:-\d{2})?|\d{5}-\d{3}(?:-\d{2})?|\d{5}-\d{4}(?:-\d{1,2})?)(?![\w-])/;

/**
 * The NSDE search that resolves the first NDC-shaped value in `search`, worded
 * for an empty drug/ndc page, or `undefined` when `search` holds none. drug/ndc
 * holds only currently listed products, in hyphenated 10-digit form, so an
 * 11-digit NDC, an unhyphenated one, and an ended package all miss there; NSDE
 * keys each package by its 11 digits and keeps ended ones. An unhyphenated
 * 10-digit NDC is ambiguous — the padding zero of its 11-digit form can belong
 * to any segment — so its three hyphenations are named instead.
 */
export function nsdeRoute(search: string): string | undefined {
  const token = NDC_TOKEN.exec(search)?.[0];
  if (token === undefined) return;
  const digits = token.replaceAll('-', '');
  if (digits.length === 11) {
    return `${codeLiteral(token)} is an 11-digit NDC, a form drug/ndc does not hold: search ${codeLiteral(`package_ndc11:"${digits}"`)} with dataset "nsde", which returns its hyphenated package_ndc.`;
  }
  if (!token.includes('-')) {
    const [a, b, c] = [
      `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`,
      `${digits.slice(0, 5)}-${digits.slice(5, 8)}-${digits.slice(8)}`,
      `${digits.slice(0, 5)}-${digits.slice(5, 9)}-${digits.slice(9)}`,
    ].map((ndc) => codeLiteral(ndc));
    return `${codeLiteral(token)} is an NDC without hyphens, which no field matches as written. It reads as ${a}, ${b}, or ${c}: search each as packaging.package_ndc here, or as package_ndc with dataset "nsde", which keeps packages whose marketing ended.`;
  }
  return `drug/ndc holds only currently listed products: search ${codeLiteral(`package_ndc:"${token}"`)} with dataset "nsde", which keeps packages whose marketing ended.`;
}

/** The base of the empty-result notice on `other/nsde`: the one spelling each NDC field takes. */
const NSDE_MISS = `No NSDE package rows matched the query. Each field matches one spelling: package_ndc11 11 digits without hyphens ("00093171201"), package_ndc the hyphenated 10-digit form ("0093-1712-01", or a product NDC such as "0093-1712" for all its packages), and proprietary_name the whole name in stored case ("Warfarin Sodium"; "warfarin sodium" and "Warfarin" match nothing). ${formatFieldHint('other/nsde')}`;

/** NSDE keys {@link nsdeRecordLines} renders verbatim before the rest of the row. */
const NSDE_RENDERED = new Set([
  'proprietary_name',
  'package_ndc',
  'package_ndc11',
  'marketing_end_date',
]);

/**
 * One NSDE row: headed by its proprietary name (its 11-digit NDC when it has
 * none), then both NDC forms, the marketing end date when the row has one, and
 * every other field it carries.
 */
function nsdeRecordLines(r: Record<string, unknown>): string[] {
  const ndcs = [
    r.package_ndc ? `**Package NDC:** ${r.package_ndc}` : undefined,
    `**NDC11:** ${r.package_ndc11}`,
  ].filter(Boolean);
  return [
    singleLine(`### ${r.proprietary_name || r.package_ndc11}`),
    singleLine(ndcs.join(' | ')),
    ...(r.marketing_end_date
      ? [singleLine(`**Marketing end date:** ${r.marketing_end_date}`)]
      : []),
    ...formatRemainingFields(r, NSDE_RENDERED),
  ];
}

export const lookupNdcTool = tool('openfda_lookup_ndc', {
  description: `Look up drugs in the NDC (National Drug Code) Directory. Identify drug products by NDC code, find active ingredients, packaging details, or manufacturer info. Set dataset to nsde to resolve an 11-digit NDC or a package whose marketing ended. Pair with openfda_get_drug_label using the returned brand_name or set_id to read the package insert.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression().describe(
      `openFDA search query, e.g. product_ndc:"0363-0218", brand_name:"aspirin", generic_name:"metformin", labeler_name:"walgreen", active_ingredients.name:"ASPIRIN". With dataset nsde each field takes one spelling: package_ndc11:"00093171201" (11 digits), package_ndc:"0093-1712-01" (hyphenated; "0093-1712" reaches every package of the product), proprietary_name:"Warfarin Sodium" (the whole name, case-sensitive). ${SEARCH_SYNTAX_NOTE}`,
    ),
    dataset: z
      .enum(['ndc', 'nsde'])
      .default('ndc')
      .describe(
        'ndc: the NDC Directory, currently listed products with their packaging. nsde: the NDC SPL Data Elements file, one flat row per package keyed by its 11-digit package_ndc11, ended packages included.',
      ),
    sort: sortExpression()
      .optional()
      .describe(sortDescription({ example: 'listing_expiration_date:desc' })),
    limit: pageLimit('drug/ndc', 'Records per page; a record grows with its packaging list.'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['brand_name', 'active_ingredients.name'])),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'NDC directory records — product_ndc, brand_name, generic_name, labeler_name, dosage_form, route, marketing_category, active_ingredients[], packaging[], listing_expiration_date. With dataset nsde, flat package rows — package_ndc11, package_ndc, proprietary_name, marketing_start_date, marketing_end_date, billing_unit, application_number_or_citation.',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching NDC records in the dataset'),
    effectiveQuery: z
      .string()
      .describe('Search filter applied to the NDC lookup, as submitted to openFDA'),
    notice: searchNoticeField([
      CONJOINED_ARRAY_NOTICE_TOPIC,
      'the NSDE search for an NDC drug/ndc does not hold',
    ]),
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
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    paginationLimitReachedError,
    invalidCursorError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);
    const { endpoint, schema } = DATASETS[input.dataset];
    const size = resolvePageSize(input.limit, endpoint, ctx);
    const query: CursorQuery = { endpoint, search: input.search, sort: input.sort };
    const searchAfter = resolveCursor(input, query, ctx);
    // other/nsde rows are flat, so the catalog lists no arrays of objects for it.
    const arrayPaths = OBJECT_ARRAY_PATHS[endpoint] ?? [];

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        input.dataset === 'nsde'
          ? NSDE_MISS
          : `No NDC records matched the query. ${nsdeRoute(input.search) ?? 'Try broadening the search — use brand_name, generic_name, or active_ingredients.name fields.'} ${formatFieldHint('drug/ndc')}`,
        totalUnverified,
        searchAfter !== undefined,
      );

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
        schema,
        limit: size.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      ctx.enrich({ totalResults: spill.total, effectiveQuery: input.search });
      ctx.enrich.notice(
        [
          spill.preview.length === 0 ? emptyNotice(spill.skip, spill.total) : undefined,
          phrasePlusHint(input.search, spill.total),
          pageSizeNotice(size, staged),
          projectionNotice(staged),
          oversizedRecordNotice(staged),
          stagingNotice(spill),
          arrayTieNotice(
            input.search,
            spill.total,
            arrayPaths,
            spill.tableName ? { kind: 'staged', table: spill.tableName } : { kind: 'restage' },
          ),
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

    ctx.log.info('NDC lookup completed', {
      endpoint,
      search: input.search,
      total: response.meta.total,
      returned: page.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });
    const notices = [
      page.results.length === 0
        ? emptyNotice(response.meta.skip, response.meta.total, response.meta.totalUnverified)
        : undefined,
      phrasePlusHint(input.search, response.meta.total),
      pageSizeNotice(size, page) ?? cursorEndNotice(page, searchAfter),
      projectionNotice(page),
      oversizedRecordNotice(page),
      arrayTieNotice(input.search, response.meta.total, arrayPaths, {
        kind: 'restage',
        byCursor: searchAfter !== undefined,
      }),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No NDC records found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    const rendered = new Set([
      'brand_name',
      'generic_name',
      'product_ndc',
      'labeler_name',
      'dosage_form',
      'route',
      'marketing_category',
      'active_ingredients',
      'packaging',
      'listing_expiration_date',
    ]);

    for (const r of result.results) {
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      if (r.package_ndc11 != null) {
        lines.push(...nsdeRecordLines(r), '');
        continue;
      }
      const title = r.brand_name ?? r.generic_name ?? r.product_ndc ?? 'Unknown';
      lines.push(singleLine(`### ${title}`));
      lines.push(
        singleLine(`**NDC:** ${r.product_ndc ?? 'N/A'} | **Labeler:** ${r.labeler_name ?? 'N/A'}`),
      );
      if (r.generic_name && r.brand_name) lines.push(singleLine(`**Generic:** ${r.generic_name}`));
      if (r.dosage_form) lines.push(singleLine(`**Form:** ${r.dosage_form}`));
      if (r.route)
        lines.push(
          singleLine(`**Route:** ${(Array.isArray(r.route) ? r.route : [r.route]).join(', ')}`),
        );
      if (r.marketing_category) lines.push(singleLine(`**Category:** ${r.marketing_category}`));

      const ingredients = r.active_ingredients ?? [];
      if (ingredients.length > 0) {
        lines.push(
          singleLine(
            `**Active ingredients:** ${ingredients.map((i: Record<string, unknown>) => `${i.name}${i.strength ? ` (${i.strength})` : ''}`).join(', ')}`,
          ),
        );
      }

      const packaging = r.packaging ?? [];
      if (packaging.length > 0) {
        lines.push(`**Packaging:**`);
        for (const p of packaging) {
          lines.push(`- ${lineContent(`${p.package_ndc ?? ''}: ${p.description ?? 'N/A'}`)}`);
          // Marketing dates and the sample flag.
          lines.push(...formatRemainingFields(p, new Set(['package_ndc', 'description'])));
        }
        // A blank line ends the list; without it the next line continues the last item.
        lines.push('');
      }

      if (r.listing_expiration_date)
        lines.push(singleLine(`**Listing expires:** ${r.listing_expiration_date}`));
      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

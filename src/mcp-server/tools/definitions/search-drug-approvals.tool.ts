/**
 * @fileoverview Tool for searching FDA drug application records in one of three
 * openFDA datasets, picked by `dataset`: Drugs@FDA applications (NDAs, ANDAs,
 * BLAs), Orange Book product records with their patents and exclusivities, and
 * Complete Response Letters. `format()` never sees the input, so it routes on
 * record shape. A submission history or a letter's text makes record size vary
 * widely, so a page holding a record over 24,000 bytes names its largest fields.
 * @module mcp-server/tools/definitions/search-drug-approvals
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import {
  formatFieldHint,
  OBJECT_ARRAY_PATHS,
  SINGLE_ENTRY_ARRAYS,
} from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  emptyResultMessage,
  formatRemainingFields,
  humanizeField,
  lineContent,
  projectedRecordLines,
  renderValue,
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
 * Keys that tell one record apart, kept on every `fields`-projected record. A
 * dataset's record carries only its own, so one list serves all three:
 * `application_number` on Drugs@FDA applications (the NDA, ANDA, or BLA
 * number); `products.application_number`, `products.application_type`, and
 * `product_number` on Orange Book products, one record per strength; and
 * `application_number`, `file_name`, and `letter_date` on letters, since one PDF
 * can hold several letters. Order decides the projected heading — the first key
 * a record carries — so an Orange Book product heads with its application number.
 */
const IDENTITY_KEYS = [
  'application_number',
  'products.application_number',
  'products.application_type',
  'product_number',
  'file_name',
  'letter_date',
] as const;

/**
 * The sort a Drugs@FDA bare browse sends. A descending sort on the `submissions`
 * array orders each application by its latest submission status date,
 * supplements included — not by its original approval.
 */
const NEWEST_APPLICATION = 'submissions.submission_status_date:desc';

/**
 * Canvas table projection for Drugs@FDA application records. The analytical
 * dimensions (brand/generic/route, marketing status, submission history) live in
 * the nested openfda/products/submissions blocks, carried as JSON columns and
 * read with DuckDB json functions. All nullable.
 */
const DRUG_APPROVALS_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns(['application_number', 'sponsor_name']),
  { name: 'openfda', type: 'JSON', nullable: true },
  { name: 'products', type: 'JSON', nullable: true },
  { name: 'submissions', type: 'JSON', nullable: true },
];

/**
 * Canvas table projection for Orange Book product records — every top-level
 * field the endpoint returns, read from live records (2026-11-22). A product
 * approved before 1982 carries `approved_prior_to_1982` (true) in place of
 * `approval_date`. The application, ingredients, and TE codes sit in the
 * one-element `products` block; patents and exclusivities are lists. All
 * nullable: most records carry no patents or exclusivity.
 */
const ORANGE_BOOK_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns(['product_number', 'approval_date', 'approved_prior_to_1982']),
  { name: 'products', type: 'JSON', nullable: true },
  { name: 'patents', type: 'JSON', nullable: true },
  { name: 'exclusivity', type: 'JSON', nullable: true },
];

/**
 * Canvas table projection for Complete Response Letters — every top-level field
 * the endpoint returns, read from all 466 live letters (2026-11-22). The two
 * lists (application numbers, issuing offices) are JSON; `letter_date` stays
 * as stored, MM/DD/YYYY. All nullable: one letter carries only four fields.
 */
const LETTER_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns(['file_name', 'letter_date']),
  { name: 'application_number', type: 'JSON', nullable: true },
  ...varcharColumns([
    'letter_type',
    'letter_year',
    'approval_status',
    'company_name',
    'company_rep',
    'company_address',
    'approver_name',
    'approver_title',
  ]),
  { name: 'approver_center', type: 'JSON', nullable: true },
  { name: 'text', type: 'VARCHAR', nullable: true },
];

/** A `dataset` value: the endpoint it searches, its bare-browse sort, staged columns, and no-match line. */
interface DatasetSpec {
  endpoint: PageKind;
  miss: string;
  newest: string;
  schema: ColumnSchema[];
}

const DATASETS = {
  drugsfda: {
    endpoint: 'drug/drugsfda',
    newest: NEWEST_APPLICATION,
    schema: DRUG_APPROVALS_CANVAS_SCHEMA,
    miss: 'No drug approvals matched the query. Try broader terms, check field names — products.brand_name for a product name (openfda.* covers harmonized applications only), sponsor_name for the applicant, stored uppercase (sponsor_name:"PFIZER") — or remove filters.',
  },
  orangebook: {
    endpoint: 'drug/orangebook',
    newest: 'approval_date:desc',
    schema: ORANGE_BOOK_CANVAS_SCHEMA,
    miss: 'No Orange Book products matched the query. Try broader terms, check field names — products.brand_name for a brand, products.application_number for the six-digit application number with no NDA or ANDA prefix, patents.patent_number, exclusivity.exclusivity_code — or remove filters.',
  },
  crl: {
    endpoint: 'transparency/crl',
    newest: 'letter_date:desc',
    schema: LETTER_CANVAS_SCHEMA,
    miss: 'No Complete Response Letters matched the query. Try broader terms, check field names — application_number exactly as stored, with a space ("NDA 210274"), company_name, text for a phrase in the letter body — or remove filters.',
  },
} as const satisfies Record<string, DatasetSpec>;

/**
 * One upstream record, or one entry of a list in it, as `results` carries it:
 * whatever keys and values openFDA sent, which the renderers below read field by
 * field and print verbatim.
 */
const UpstreamRecord = z.record(z.string(), z.any());
type UpstreamRecord = z.infer<typeof UpstreamRecord>;

/**
 * One labeled list in a record — a Drugs@FDA application's products and
 * submissions, an Orange Book product's products, patents, and exclusivities:
 * the label, then one item per entry carrying `lead`'s parts joined by ` | `,
 * then the entry's other fields as `**Label:** value` lines inside the item, and
 * a blank line ending the list — without it, the next line would continue the
 * last item. `rendered` names the keys `lead` renders verbatim whenever present.
 */
function listBlock(
  label: string,
  entries: readonly UpstreamRecord[],
  lead: (entry: UpstreamRecord) => unknown[],
  rendered: readonly string[],
): string[] {
  if (entries.length === 0) return [];
  const own = new Set(rendered);
  return [
    `**${label}:**`,
    ...entries.flatMap((entry) => [
      `- ${lineContent(lead(entry).filter(Boolean).join(' | '))}`,
      ...formatRemainingFields(entry, own),
    ]),
    '',
  ];
}

/**
 * The products list: brand, ingredients, dosage form, route, and marketing status
 * lead each item, and its other fields — product number, reference-drug and
 * reference-standard flags, TE codes, and on the Orange Book the application —
 * follow. Drugs@FDA and the Orange Book name these fields alike.
 */
function productsBlock(products: readonly UpstreamRecord[]): string[] {
  return listBlock(
    'Products',
    products,
    (p) => {
      const ingredients = (p.active_ingredients ?? [])
        .map((i: Record<string, unknown>) => `${i.name} ${i.strength ?? ''}`.trim())
        .join(', ');
      return [
        p.brand_name,
        ingredients ? `(${ingredients})` : null,
        p.dosage_form,
        p.route,
        p.marketing_status,
      ];
    },
    ['brand_name', 'active_ingredients', 'dosage_form', 'route', 'marketing_status'],
  );
}

/** A Drugs@FDA application: identity, the openfda block, products, submissions, and the rest. */
function applicationLines(r: UpstreamRecord): string[] {
  const lines: string[] = [];
  const openfda = r.openfda ?? {};
  const brandName = (openfda.brand_name ?? [])[0] ?? '';
  const genericName = (openfda.generic_name ?? [])[0] ?? '';
  // openfda.* is filled on harmonized applications only; products[] names the rest.
  const productBrand = r.products?.[0]?.brand_name ?? '';
  const title = brandName || productBrand || genericName || r.application_number || 'Unknown';

  lines.push(singleLine(`### ${title}`));
  lines.push(
    singleLine(
      `**Application:** ${r.application_number ?? 'N/A'} | **Sponsor:** ${r.sponsor_name ?? 'N/A'}`,
    ),
  );
  if (brandName && genericName)
    lines.push(singleLine(`**Brand:** ${brandName} | **Generic:** ${genericName}`));
  if (openfda.route) lines.push(singleLine(`**Route:** ${(openfda.route as string[]).join(', ')}`));
  if (openfda.product_type)
    lines.push(singleLine(`**Type:** ${(openfda.product_type as string[]).join(', ')}`));

  /**
   * Remaining openfda fields — brand_name/generic_name included, since the
   * lines above only ever show entry 0 of each — plus manufacturer_name,
   * substance_name, rxcui, nui, pharm_class, ...
   */
  lines.push(...formatRemainingFields(openfda, new Set(['route', 'product_type'])));
  lines.push(...productsBlock(r.products ?? []));
  // Each submission's application_docs[] (names + URLs), class code, and public notes follow it.
  lines.push(
    ...listBlock(
      'Submissions',
      r.submissions ?? [],
      (s) => [
        s.submission_type,
        s.submission_number ? `#${s.submission_number}` : null,
        s.submission_status,
        s.submission_status_date,
        s.review_priority ? `(${s.review_priority})` : null,
      ],
      [
        'submission_type',
        'submission_number',
        'submission_status',
        'submission_status_date',
        'review_priority',
      ],
    ),
  );
  lines.push(
    ...formatRemainingFields(
      r,
      new Set(['openfda', 'application_number', 'sponsor_name', 'products', 'submissions']),
    ),
  );
  return lines;
}

/**
 * An Orange Book product: brand, application, and product number in the
 * heading, its top-level fields (approval date, product number), then its
 * products, patents, and exclusivities. Nothing is filled in for a missing
 * field: the heading names only the parts the record carries.
 */
function orangeBookLines(r: UpstreamRecord): string[] {
  const product = r.products?.[0] ?? {};
  const application = [product.application_type, product.application_number]
    .filter(Boolean)
    .join(' ');
  const id = [application, r.product_number ? `product ${r.product_number}` : null]
    .filter(Boolean)
    .join(', ');
  const title = [product.brand_name, id].filter(Boolean).join(' — ') || 'Orange Book product';
  return [
    singleLine(`### ${title}`),
    ...formatRemainingFields(r, new Set(['products', 'patents', 'exclusivity'])),
    ...productsBlock(r.products ?? []),
    ...listBlock(
      'Patents',
      r.patents ?? [],
      (p) => [
        p.patent_number,
        p.expiration_date ? `expires ${p.expiration_date}` : null,
        p.patent_use_code,
      ],
      ['patent_number', 'expiration_date', 'patent_use_code'],
    ),
    ...listBlock(
      'Exclusivity',
      r.exclusivity ?? [],
      (e) => [
        e.exclusivity_code,
        e.exclusivity_expiration_date ? `expires ${e.exclusivity_expiration_date}` : null,
      ],
      ['exclusivity_code', 'exclusivity_expiration_date'],
    ),
  ];
}

/** Letter fields that hold line breaks, rendered as code literals so the breaks survive. */
const LETTER_BLOCKS = ['company_address', 'text'] as const;

/**
 * A Complete Response Letter: application numbers, letter type, and date in the
 * heading, its other fields, then the company address and the letter text as
 * code literals — a fenced block when the value holds a line break — which a
 * CommonMark parse reads back exactly, line breaks included.
 */
function letterLines(r: UpstreamRecord): string[] {
  const heading = [renderValue(r.application_number), r.letter_type, r.letter_date];
  const title = heading.filter(Boolean).join(' — ') || 'Letter';
  const blocks = LETTER_BLOCKS.filter((key) => typeof r[key] === 'string' && r[key] !== '');
  return [
    singleLine(`### ${title}`),
    ...formatRemainingFields(
      r,
      new Set(['application_number', 'letter_type', 'letter_date', ...blocks]),
    ),
    ...blocks.map((key) => `**${humanizeField(key)}:** ${codeLiteral(r[key])}`),
  ];
}

/** Exported tool definition for searching drug approvals. */
export const searchDrugApprovalsTool = tool('openfda_search_drug_approvals', {
  description: `Search FDA drug application records: Drugs@FDA approvals (NDAs, ANDAs, BLAs) with sponsor and full submission history by default, or with dataset the Orange Book's patents and exclusivities, or FDA's Complete Response Letters with their full text. Pair with openfda_get_drug_label to read the approved label, or openfda_count_values to aggregate by sponsor_name, product_type, or route.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    dataset: z
      .enum(['drugsfda', 'orangebook', 'crl'])
      .default('drugsfda')
      .describe(
        'drugsfda: Drugs@FDA applications, each with its sponsor, products, and submission history. orangebook: Orange Book product records, one per strength, with patents[], exclusivity[], and therapeutic equivalence codes. crl: Complete Response Letters FDA issued on drug and biologic applications, each with its full text.',
      ),
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query, e.g. products.brand_name:"eliquis" (any letter case; openfda.* fields are filled only on harmonized applications, so openfda.brand_name misses the rest), sponsor_name:"PFIZER" (stored uppercase; a lowercase quoted value returns no matches); on orangebook products.brand_name:"ELIQUIS", patents.expiration_date:[20270101 TO 20271231]; on crl application_number:"NDA 210274", text:"bioequivalence". openFDA tests each clause against the whole record, so AND-ed clauses on one array's fields can be met by different entries (an ORIG submission and a PRIORITY one); to require one entry, stage the search and filter per entry in openfda_dataframe_query. Each dataset spells an application number its own way: a letter's "NDA 210274" is Drugs@FDA's NDA210274 and the Orange Book's products.application_number:"210274" with products.application_type:"N" ("A" for an ANDA); a letter matches only its whole stored spelling (no wildcard reaches the number past the space). Omit to browse newest first. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        sortDescription({
          newest: `${NEWEST_APPLICATION} (an application's latest submission status date, supplements included, not its approval date; ${DATASETS.orangebook.newest} on orangebook, ${DATASETS.crl.newest} on crl)`,
        }),
      ),
    limit: pageLimitBy(
      'dataset',
      [
        ['drugsfda', DATASETS.drugsfda.endpoint],
        ['orangebook', DATASETS.orangebook.endpoint],
        ['crl', DATASETS.crl.endpoint],
      ],
      "Records per page. A Drugs@FDA record carries its application's whole submission history, so a long-running application is an order of magnitude larger than a recent one, and a letter carries its full text.",
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(
        fieldsDescription(IDENTITY_KEYS, ['sponsor_name', 'submissions.submission_status_date']),
      ),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(UpstreamRecord)
      .describe(
        'Records of the selected dataset. Drug application records — application_number, sponsor_name, openfda block on harmonized applications only (brand_name, generic_name, route, product_type, substance_name), products[] (brand_name, active_ingredients, dosage_form, marketing_status), submissions[] (submission_type, submission_status, submission_status_date, review_priority). Orange Book products — product_number, approval_date (approved_prior_to_1982 on older products), products[] (application_type, application_number, brand_name, active_ingredients, therapeutic_equivalence_codes, reference_listed_drug), patents[] (patent_number, expiration_date, patent_use_code), exclusivity[] (exclusivity_code, exclusivity_expiration_date). Letters — application_number[], letter_date (MM/DD/YYYY), letter_type, approval_status, company_name, company_address, approver_name, file_name, text.',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching records in the selected dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the selected dataset, as submitted to openFDA'),
    notice: searchNoticeField([CONJOINED_ARRAY_NOTICE_TOPIC]),
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
    const { endpoint, miss, newest, schema } = DATASETS[input.dataset];
    const size = resolvePageSize(input.limit, endpoint, ctx);
    const query: CursorQuery = {
      endpoint,
      search: input.search,
      sort: sortOrNewest(input, newest),
    };
    const searchAfter = resolveCursor(input, query, ctx);
    /**
     * openFDA tests each clause against the whole record, so AND-ed clauses on
     * one array's fields can be met by different entries. Each top array the
     * catalog lists is a staged column; letters list none. An Orange Book
     * record's one product splits nothing, though its ingredients can.
     */
    const arrayPaths = OBJECT_ARRAY_PATHS[endpoint] ?? [];
    const singleEntry = SINGLE_ENTRY_ARRAYS[endpoint];

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `${miss} ${formatFieldHint(endpoint)}`,
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
          arrayTieNotice(
            input.search,
            spill.total,
            arrayPaths,
            spill.tableName ? { kind: 'staged', table: spill.tableName } : { kind: 'restage' },
            singleEntry,
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

    ctx.log.info('Drug approval search completed', {
      dataset: input.dataset,
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
      arrayTieNotice(
        input.search,
        response.meta.total,
        arrayPaths,
        { kind: 'restage', byCursor: searchAfter !== undefined },
        singleEntry,
      ),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No drug application records found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    for (const r of result.results) {
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      /**
       * format() never sees `dataset`: a letter carries letter_date, an Orange Book
       * product a top-level product_number, and a Drugs@FDA application neither.
       */
      if (Object.hasOwn(r, 'letter_date')) lines.push(...letterLines(r));
      else if (Object.hasOwn(r, 'product_number')) lines.push(...orangeBookLines(r));
      else lines.push(...applicationLines(r));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

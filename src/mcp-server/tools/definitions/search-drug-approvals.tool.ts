/**
 * @fileoverview Tool for searching FDA drug application approvals (NDAs and ANDAs)
 * via the Drugs@FDA endpoint. An application's full submission history makes record
 * size vary widely, so a page holding a record over 24,000 bytes names its largest
 * fields.
 * @module mcp-server/tools/definitions/search-drug-approvals
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  emptyPageBody,
  emptyResultMessage,
  formatRemainingFields,
  lineContent,
  projectedRecordLines,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  META_LIMIT_DESCRIPTION,
  malformedSearchError,
  pageLimit,
  pageSizeNotice,
  phrasePlusHint,
  resolvePageSize,
  SEARCH_SYNTAX_NOTE,
  SKIP_DESCRIPTION,
  searchExpression,
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
  inlinePage,
  OVERSIZED_RECORD_BYTES,
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
 * `application_number` — the NDA, ANDA, or BLA number.
 */
const IDENTITY_KEYS = ['application_number'] as const;

/**
 * The sort a bare browse sends. A descending sort on the `submissions` array
 * orders each application by its latest submission status date, supplements
 * included — not by its original approval.
 */
const NEWEST_FIRST = 'submissions.submission_status_date:desc';

/**
 * Canvas table projection for Drugs@FDA application records. The analytical
 * dimensions (brand/generic/route, marketing status, submission history) live in
 * the nested openfda/products/submissions blocks, carried as JSON columns and
 * read with DuckDB json functions. All nullable.
 */
const DRUG_APPROVALS_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'application_number', type: 'VARCHAR', nullable: true },
  { name: 'sponsor_name', type: 'VARCHAR', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
  { name: 'products', type: 'JSON', nullable: true },
  { name: 'submissions', type: 'JSON', nullable: true },
];

/** Exported tool definition for searching drug approvals. */
export const searchDrugApprovalsTool = tool('openfda_search_drug_approvals', {
  description: `Search the Drugs@FDA database for drug application approvals (NDAs and ANDAs). Returns application details, sponsor info, and full submission history. Pair with openfda_get_drug_label to read the approved label, or openfda_count_values to aggregate by sponsor_name, product_type, or route.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query. Examples: products.brand_name:"eliquis" (any letter case; openfda.* fields are filled only on harmonized applications, so openfda.brand_name misses the rest), sponsor_name:"PFIZER", submissions.submission_type:"ORIG" AND submissions.review_priority:"PRIORITY". Exact quoted values can be case-sensitive on some fields — sponsor_name is stored uppercase, so use sponsor_name:"PFIZER" (a lowercase quoted value returns no matches). Omit to browse by latest submission, newest first, sorted by ${NEWEST_FIRST}. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        `Sort expression — a field path optionally suffixed with :asc or :desc (any letter case; :ascending and :descending are also accepted, and every direction is sent as asc or desc); comma-separate for multi-field sort. Omitted with no search, defaults to ${NEWEST_FIRST}: applications by their latest submission status date, supplements included, newest first — not by approval date. Omitted with a search, results come in openFDA's relevance order. Field paths take only letters, digits, underscores, and dots; any other character or direction is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.`,
      ),
    limit: pageLimit(
      'drug/drugsfda',
      "Records per page. A record carries its application's whole submission history, so a long-running application is an order of magnitude larger than a recent one.",
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    fields: fieldSelection()
      .optional()
      .describe(
        fieldsDescription(IDENTITY_KEYS, ['sponsor_name', 'submissions.submission_status_date']),
      ),
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
        'Drug application records — application_number, sponsor_name, openfda block on harmonized applications only (brand_name, generic_name, route, product_type, substance_name), products[] (brand_name, active_ingredients, dosage_form, marketing_status), submissions[] (submission_type, submission_status, submission_status_date, review_priority).',
      ),
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching drug approval records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the Drugs@FDA query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        `Canvas staging disclosure when the call staged, the limit clamp when limit exceeded the cap (requested value, cap, next skip), the fields projection and any requested path no record carries, the size and largest fields when a record on the page exceeds ${OVERSIZED_RECORD_BYTES} bytes, and guidance when results are empty — how to broaden filters or correct field names.`,
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
    const size = resolvePageSize(input.limit, 'drug/drugsfda', ctx);
    const sort = sortOrNewest(input, NEWEST_FIRST);

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No drug approvals matched the query. Try broader terms, check field names — products.brand_name for a product name (openfda.* covers harmonized applications only), sponsor_name for the applicant, stored uppercase (sponsor_name:"PFIZER") — or remove filters. ${formatFieldHint('drug/drugsfda')}`,
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
        endpoint: 'drug/drugsfda',
        search: input.search,
        sort,
        canvasId: input.canvas_id,
        schema: DRUG_APPROVALS_CANVAS_SCHEMA,
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
      'drug/drugsfda',
      {
        search: input.search,
        sort,
        limit: size.limit,
        skip: input.skip,
      },
      ctx,
    );

    const page = inlinePage(response, size.limit, projection);

    ctx.log.info('Drug approval search completed', {
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
      pageSizeNotice(size, page),
      projectionNotice(page),
      oversizedRecordNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No drug approvals found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    const rendered = new Set([
      'openfda',
      'application_number',
      'sponsor_name',
      'products',
      'submissions',
    ]);

    for (const r of result.results) {
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
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
      if (openfda.route)
        lines.push(singleLine(`**Route:** ${(openfda.route as string[]).join(', ')}`));
      if (openfda.product_type)
        lines.push(singleLine(`**Type:** ${(openfda.product_type as string[]).join(', ')}`));

      // Remaining openfda fields — brand_name/generic_name included, since the
      // lines above only ever show entry 0 of each — plus manufacturer_name,
      // substance_name, rxcui, nui, pharm_class, ...
      const renderedOpenfda = new Set(['route', 'product_type']);
      lines.push(...formatRemainingFields(openfda, renderedOpenfda));

      const products = r.products ?? [];
      if (products.length > 0) {
        lines.push('**Products:**');
        for (const p of products) {
          const ingredients = (p.active_ingredients ?? [])
            .map((i: Record<string, unknown>) => `${i.name} ${i.strength ?? ''}`.trim())
            .join(', ');
          const parts = [
            p.brand_name,
            ingredients ? `(${ingredients})` : null,
            p.dosage_form,
            p.route,
            p.marketing_status,
          ].filter(Boolean);
          lines.push(`- ${lineContent(parts.join(' | '))}`);
          // Product number, reference-drug/standard flags, TE code.
          lines.push(
            ...formatRemainingFields(
              p,
              new Set([
                'brand_name',
                'active_ingredients',
                'dosage_form',
                'route',
                'marketing_status',
              ]),
            ),
          );
        }
        // A blank line ends the list; without it the next line continues the last item.
        lines.push('');
      }

      const submissions = r.submissions ?? [];
      if (submissions.length > 0) {
        lines.push('**Submissions:**');
        for (const s of submissions) {
          const parts = [
            s.submission_type,
            s.submission_number ? `#${s.submission_number}` : null,
            s.submission_status,
            s.submission_status_date,
            s.review_priority ? `(${s.review_priority})` : null,
          ].filter(Boolean);
          lines.push(`- ${lineContent(parts.join(' | '))}`);
          // application_docs[] (names + URLs), submission class code, public notes.
          lines.push(
            ...formatRemainingFields(
              s,
              new Set([
                'submission_type',
                'submission_number',
                'submission_status',
                'submission_status_date',
                'review_priority',
              ]),
            ),
          );
        }
        lines.push('');
      }

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

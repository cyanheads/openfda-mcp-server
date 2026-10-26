/**
 * @fileoverview Tool for searching FDA drug shortage records via the drug/shortages
 * endpoint. Records are small, but `limit` reaches 1000, so the inline page is bounded
 * by a serialized-byte budget and discloses any records it withheld along with the
 * routes to them.
 * @module mcp-server/tools/definitions/search-drug-shortages
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  malformedSearchError,
  phrasePlusHint,
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
 * `package_ndc`.
 */
const IDENTITY_KEYS = ['package_ndc'] as const;

/**
 * Canvas table projection for drug shortage records. Scalars are VARCHAR (CAST
 * in SQL for math); the openfda cross-link block is a JSON column. All nullable.
 */
const DRUG_SHORTAGES_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'generic_name', type: 'VARCHAR', nullable: true },
  { name: 'status', type: 'VARCHAR', nullable: true },
  { name: 'availability', type: 'VARCHAR', nullable: true },
  { name: 'therapeutic_category', type: 'VARCHAR', nullable: true },
  { name: 'dosage_form', type: 'VARCHAR', nullable: true },
  { name: 'presentation', type: 'VARCHAR', nullable: true },
  { name: 'package_ndc', type: 'VARCHAR', nullable: true },
  { name: 'company_name', type: 'VARCHAR', nullable: true },
  { name: 'initial_posting_date', type: 'VARCHAR', nullable: true },
  { name: 'update_date', type: 'VARCHAR', nullable: true },
  { name: 'update_type', type: 'VARCHAR', nullable: true },
  { name: 'shortage_reason', type: 'VARCHAR', nullable: true },
  { name: 'contact_info', type: 'VARCHAR', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

export const searchDrugShortagesTool = tool('openfda_search_drug_shortages', {
  description: `Search FDA drug shortage records. Returns per-product shortage status, availability, therapeutic category, dosage form, manufacturer, and dates. Use to check whether a drug is currently in shortage, find all oncology drugs with supply issues, or retrieve the openfda block (brand_name, product_ndc, rxcui) to chain into openfda_get_drug_label or openfda_lookup_ndc.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query using field:value syntax. Examples: status:"Current", therapeutic_category:"Oncology", generic_name:"carboplatin", company_name:"pfizer". Omit to browse all records. ${SEARCH_SYNTAX_NOTE} Call openfda_describe_fields({ endpoint: "drug/shortages" }) for the complete field list.`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        'Sort expression — a field path optionally suffixed with :asc or :desc (any letter case; :ascending and :descending are also accepted, and every direction is sent as asc or desc); comma-separate for multi-field sort. Example: update_date:desc. Field paths take only letters, digits, underscores, and dots; any other character or direction is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe(`Maximum number of records to return (1-1000, default 10). ${PAGE_BUDGET_NOTE}`),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['generic_name', 'status'])),
    stage: stageInput,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID returned by a prior stage=true call to this tool or another openFDA search tool (openfda_search_* or openfda_lookup_ndc). Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
    ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching shortage records in the database'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe(META_LIMIT_DESCRIPTION),
        lastUpdated: z.string().describe('Dataset last updated date'),
        totalUnverified: totalUnverifiedField,
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Drug shortage records. Key fields: generic_name, status ("Current", "To Be Discontinued", or "Resolved"), availability, therapeutic_category, dosage_form, presentation, package_ndc, company_name, contact_info, initial_posting_date, update_date, update_type. openfda block contains brand_name, product_ndc, rxcui, spl_set_id for cross-linking.',
      ),
    ...pageBudgetOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching drug shortage records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the drug/shortages query, as submitted to openFDA'),
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
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases). Call openfda_describe_fields({ endpoint: "drug/shortages" }) for valid field paths.',
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

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No drug shortage records matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''}. Try broader filters or check field names. ${formatFieldHint('drug/shortages')}`,
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
        endpoint: 'drug/shortages',
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema: DRUG_SHORTAGES_CANVAS_SCHEMA,
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
          phrasePlusHint(input.search, spill.total),
          projectionNotice(staged),
          pageBudgetNotice(staged),
          stagingNotice(spill),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return staged;
    }

    const svc = getOpenFdaService();
    const response = await svc.query(
      'drug/shortages',
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    const page = boundedPage(response, projection);

    ctx.log.info('Drug shortage search completed', {
      search: input.search,
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
      phrasePlusHint(input.search, response.meta.total),
      projectionNotice(page),
      pageBudgetNotice(page),
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
      if (r.therapeutic_category)
        lines.push(singleLine(`**Therapeutic category:** ${r.therapeutic_category}`));
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
        // Remaining openfda leaves — the full NDC/RxCUI lists, spl ids, substance,
        // product type, route, UNII, application number.
        lines.push(...formatRemainingFields(openfda, new Set(['brand_name'])));
      }

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

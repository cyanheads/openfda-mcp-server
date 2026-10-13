/**
 * @fileoverview MCP tool for looking up drugs in the openFDA NDC (National Drug
 * Code) Directory. A record grows with its packaging list and `limit` reaches 1000,
 * so the inline page is bounded by a serialized-byte budget and discloses any records
 * it withheld along with the routes to them.
 * @module mcp-server/tools/definitions/lookup-ndc
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
 * `product_ndc`.
 */
const IDENTITY_KEYS = ['product_ndc'] as const;

/**
 * Canvas table projection for NDC directory records. Scalars are VARCHAR; route
 * (an array) and the ingredient/packaging/openfda structures are JSON columns.
 * All nullable.
 */
const NDC_CANVAS_SCHEMA: ColumnSchema[] = [
  { name: 'product_ndc', type: 'VARCHAR', nullable: true },
  { name: 'product_id', type: 'VARCHAR', nullable: true },
  { name: 'brand_name', type: 'VARCHAR', nullable: true },
  { name: 'generic_name', type: 'VARCHAR', nullable: true },
  { name: 'labeler_name', type: 'VARCHAR', nullable: true },
  { name: 'dosage_form', type: 'VARCHAR', nullable: true },
  { name: 'product_type', type: 'VARCHAR', nullable: true },
  { name: 'marketing_category', type: 'VARCHAR', nullable: true },
  { name: 'marketing_start_date', type: 'VARCHAR', nullable: true },
  { name: 'listing_expiration_date', type: 'VARCHAR', nullable: true },
  { name: 'dea_schedule', type: 'VARCHAR', nullable: true },
  { name: 'finished', type: 'VARCHAR', nullable: true },
  { name: 'route', type: 'JSON', nullable: true },
  { name: 'active_ingredients', type: 'JSON', nullable: true },
  { name: 'packaging', type: 'JSON', nullable: true },
  { name: 'openfda', type: 'JSON', nullable: true },
];

export const lookupNdcTool = tool('openfda_lookup_ndc', {
  description: `Look up drugs in the NDC (National Drug Code) Directory. Identify drug products by NDC code, find active ingredients, packaging details, or manufacturer info. Pair with openfda_get_drug_label using the returned brand_name or set_id to read the package insert.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: nonBlankString().describe(
      `openFDA search query. Examples: product_ndc:"0363-0218", brand_name:"aspirin", generic_name:"metformin", openfda.manufacturer_name:"walgreen", active_ingredients.name:"ASPIRIN". ${SEARCH_BALANCE_NOTE}`,
    ),
    sort: sortExpression()
      .optional()
      .describe(
        'Sort expression — a field path optionally suffixed with :asc or :desc (any letter case; :ascending and :descending are also accepted, and every direction is sent as asc or desc); comma-separate for multi-field sort. Example: listing_expiration_date:desc. Field paths take only letters, digits, underscores, and dots; any other character or direction is rejected before the request. A well-formed but non-sortable field still causes a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe(
        `Maximum number of records to return (1-1000, default 10). ${PAGE_BUDGET_NOTE} A record grows with its packaging list, so a product with many package configurations is several times the size of one with a single package.`,
      ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['brand_name', 'active_ingredients.name'])),
    stage: stageInput,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID returned by a prior stage=true call to this tool or an openFDA search tool (openfda_search_*). Passing one stages this lookup onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
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
        'NDC directory records — product_ndc, brand_name, generic_name, labeler_name, dosage_form, route, marketing_category, active_ingredients[], packaging[], listing_expiration_date.',
      ),
    ...pageBudgetOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching NDC records in the dataset'),
    effectiveQuery: z
      .string()
      .describe('Search filter applied to the NDC lookup, as submitted to openFDA'),
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

    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No NDC records matched the query. Try broadening the search — use brand_name, generic_name, or active_ingredients.name fields. ${formatFieldHint('drug/ndc')}`,
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
        endpoint: 'drug/ndc',
        search: input.search,
        sort: input.sort,
        canvasId: input.canvas_id,
        schema: NDC_CANVAS_SCHEMA,
        limit: input.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      ctx.enrich({ totalResults: spill.total, effectiveQuery: input.search });
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
    const response = await service.query('drug/ndc', input, ctx);

    const page = boundedPage(response, projection);

    ctx.log.info('NDC lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: page.results.length,
      pageOmitted: page.page_omitted,
    });

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });
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
      }

      if (r.listing_expiration_date)
        lines.push(singleLine(`**Listing expires:** ${r.listing_expiration_date}`));
      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

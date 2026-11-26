/**
 * @fileoverview Tool for searching openFDA animal and veterinary adverse event
 * reports. A page holding a record over 24,000 bytes names its largest fields.
 * @module mcp-server/tools/definitions/search-animal-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  formatRemainingFields,
  lineContent,
  projectedRecordLines,
  renderValue,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  type CursorQuery,
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
  notSortableError,
  pageLimit,
  pageMetaOutput,
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
import { enrichSearchPage } from '@/mcp-server/tools/search-enrichment.js';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
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
  varcharColumns,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { inlinePage, oversizedRecordOutputShape } from '@/services/openfda/page-budget.js';
import { projectionOutputShape, recordProjection } from '@/services/openfda/record-projection.js';

/**
 * Keys that tell one record apart, kept on every `fields`-projected record:
 * `unique_aer_id_number`.
 */
const IDENTITY_KEYS = ['unique_aer_id_number'] as const;

/** The sort a bare browse sends: the report FDA received most recently first. */
const NEWEST_FIRST = 'original_receive_date:desc';

/**
 * The value openFDA stores in place of every veterinary brand and manufacturer
 * name — FDA's `MSK` ("masked") null flavor.
 */
const MASKED = 'MSK';

/** Search fields that hold only {@link MASKED}, so a filter on a real name matches nothing. */
const MASKED_FIELDS = ['drug.brand_name', 'drug.manufacturer.name'] as const;

const MASKED_FIELD_GUIDANCE = `drug.brand_name and drug.manufacturer.name hold only "${MASKED}" (masked on every record), so a brand or manufacturer filter matches nothing. Search the ingredient on drug.active_ingredients.name, unsuffixed, or narrow to one approval with drug.manufacturer.registration_number (the full value, e.g. "USA-USFDACVM-N141426").`;

/**
 * Canvas table projection for veterinary adverse event records: one column per
 * top-level field the endpoint returns (verified live), fixed so every staging
 * of this endpoint unions with another. Scalars are VARCHAR (CAST in SQL for
 * math); objects and arrays are JSON columns. All nullable. The 0.10.0 columns
 * keep their positions and the later ones follow them.
 */
const ANIMAL_EVENTS_CANVAS_SCHEMA: ColumnSchema[] = [
  ...varcharColumns([
    'unique_aer_id_number',
    'original_receive_date',
    'serious_ae',
    'primary_reporter',
    'type_of_information',
    'number_of_animals_affected',
    'number_of_animals_treated',
    'foreign_or_domestic',
  ]),
  { name: 'animal', type: 'JSON', nullable: true },
  { name: 'drug', type: 'JSON', nullable: true },
  { name: 'reaction', type: 'JSON', nullable: true },
  { name: 'outcome', type: 'JSON', nullable: true },
  ...varcharColumns([
    'report_id',
    'onset_date',
    'secondary_reporter',
    'treated_for_ae',
    'time_between_exposure_and_onset',
  ]),
  { name: 'receiver', type: 'JSON', nullable: true },
  { name: 'health_assessment_prior_to_exposure', type: 'JSON', nullable: true },
  { name: 'duration', type: 'JSON', nullable: true },
];

export const searchAnimalEventsTool = tool('openfda_search_animal_events', {
  description: `Search adverse event reports for veterinary drugs and devices submitted to the FDA Center for Veterinary Medicine. Records include animal species, breed, age, weight, drug name and route, adverse reactions (using VeDDRA terminology), and outcome. Use to investigate safety signals for veterinary products, find reports by animal species or drug, or explore reaction patterns. Brand and manufacturer names are masked as "MSK" on every record (the FDA null flavor for withheld data), so find a product by active ingredient on drug.active_ingredients.name, unsuffixed. An ingredient search spans every product containing it and cannot attribute reports to one brand; drug.manufacturer.registration_number (the full value, e.g. "USA-USFDACVM-N141426") narrows it to one approval.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query, e.g. animal.species:"Dog", drug.active_ingredients.name:"Fluralaner", reaction.veddra_term_name:"Vomiting", serious_ae:"true". Omit to browse newest first. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(sortDescription({ newest: NEWEST_FIRST })),
    limit: pageLimit('animalandveterinary/event', 'Records per page.'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['original_receive_date', 'animal.species'])),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Animal adverse event records. Key fields: unique_aer_id_number, original_receive_date, serious_ae, animal (species, gender, breed, age, weight), drug[] (brand_name, active_ingredients, route, dose, administered_by), reaction[] (veddra_term_name, number_of_animals_affected), outcome[] (medical_status), primary_reporter, type_of_information.',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching animal adverse event records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the query, as submitted to openFDA'),
    notice: searchNoticeField([CONJOINED_ARRAY_NOTICE_TOPIC]),
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
    notSortableError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);
    const size = resolvePageSize(input.limit, 'animalandveterinary/event', ctx);
    const query: CursorQuery = {
      endpoint: 'animalandveterinary/event',
      search: input.search,
      sort: sortOrNewest(input, NEWEST_FIRST),
    };
    const searchAfter = resolveCursor(input, query, ctx);

    const named = input.search ? fieldPathsNamed(input.search) : [];
    const maskedFieldNote = MASKED_FIELDS.some((field) => named.includes(field))
      ? ` ${MASKED_FIELD_GUIDANCE}`
      : '';
    const noMatch = () =>
      `No animal adverse event reports matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''}. Try broader filters — use animal.species, drug.active_ingredients.name, or reaction.veddra_term_name fields.${maskedFieldNote} ${formatFieldHint('animalandveterinary/event')}`;

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
        schema: ANIMAL_EVENTS_CANVAS_SCHEMA,
        limit: size.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      enrichSearchPage(ctx, { query, page: staged, size, noMatch, spill });
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

    ctx.log.info('Animal adverse event search completed', {
      total: response.meta.total,
      returned: page.results.length,
    });

    enrichSearchPage(ctx, { query, page, size, noMatch, response, searchAfter });
    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No animal adverse event reports found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    for (const r of result.results) {
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      lines.push(singleLine(`### Report ${r.unique_aer_id_number ?? 'N/A'}`));
      lines.push(
        singleLine(
          `**Received:** ${r.original_receive_date ?? 'N/A'} | **Serious:** ${r.serious_ae === 'true' ? 'Yes' : r.serious_ae === 'false' ? 'No' : (r.serious_ae ?? 'N/A')}`,
        ),
      );

      // Animal details
      const animal = r.animal as Record<string, unknown> | undefined;
      if (animal) {
        const speciesBreed = [
          animal.species,
          animal.breed
            ? typeof animal.breed === 'object'
              ? ((animal.breed as Record<string, unknown>).breed_component as string)
              : String(animal.breed)
            : null,
        ]
          .filter(Boolean)
          .join(', ');
        if (speciesBreed) lines.push(singleLine(`**Animal:** ${speciesBreed}`));

        const age = animal.age as Record<string, unknown> | undefined;
        const weight = animal.weight as Record<string, unknown> | undefined;
        const animalDetails = [
          animal.gender,
          animal.reproductive_status && animal.reproductive_status !== 'NOT APPLICABLE'
            ? animal.reproductive_status
            : null,
          age?.min ? `age ${age.min} ${age.unit ?? ''}`.trim() : null,
          weight?.min ? `weight ${weight.min} ${weight.unit ?? ''}`.trim() : null,
        ]
          .filter(Boolean)
          .join(' | ');
        if (animalDetails) lines.push(`  ${lineContent(animalDetails)}`);
        // Breed detail, age/weight qualifiers, physiological status, sex code.
        lines.push(...formatRemainingFields(animal, new Set(['species', 'gender'])));
      }

      // Reactions
      const reactions = (r.reaction as Record<string, unknown>[] | undefined) ?? [];
      if (reactions.length > 0) {
        const reactionNames = reactions
          .map((rx) => rx.veddra_term_name)
          .filter(Boolean)
          .join(', ');
        if (reactionNames) lines.push(singleLine(`**Reactions:** ${reactionNames}`));
        for (const rx of reactions) {
          lines.push(...formatRemainingFields(rx, new Set(['veddra_term_name'])));
        }
      }

      // Drugs
      const drugs = (r.drug as Record<string, unknown>[] | undefined) ?? [];
      if (drugs.length > 0) {
        lines.push('**Drugs:**');
        for (const d of drugs) {
          const ingredients = (d.active_ingredients as Record<string, unknown>[] | undefined) ?? [];
          const ingredientNames = ingredients
            .map((i) => i.name)
            .filter(Boolean)
            .join(', ');
          const masked = d.brand_name === MASKED;
          const name =
            (masked ? undefined : (d.brand_name as string)) || ingredientNames || 'Unknown';
          const qualifiers = [
            masked ? `brand masked: ${MASKED}` : null,
            [
              d.route ? `via ${d.route}` : null,
              d.administered_by ? `by ${d.administered_by}` : null,
            ]
              .filter(Boolean)
              .join(', '),
          ]
            .filter(Boolean)
            .join('; ');
          lines.push(`- ${lineContent(`${name}${qualifiers ? ` (${qualifiers})` : ''}`)}`);
          /**
           * Ingredient doses, lot number, dosage form, manufacturer, ATC code — a
           * masked manufacturer name labelled the way the brand is, never shown as a firm.
           */
          const maker = d.manufacturer as Record<string, unknown> | undefined;
          const remaining =
            maker?.name === MASKED
              ? {
                  ...d,
                  manufacturer: [`name masked: ${MASKED}`, renderValue({ ...maker, name: null })]
                    .filter(Boolean)
                    .join('; '),
                }
              : d;
          lines.push(
            ...formatRemainingFields(
              remaining,
              new Set(['brand_name', 'route', 'administered_by']),
            ),
          );
        }
        // A blank line ends the list; without it the next line continues the last item.
        lines.push('');
      }

      // Outcomes
      const outcomes = (r.outcome as Record<string, unknown>[] | undefined) ?? [];
      if (outcomes.length > 0) {
        const outcomeStatuses = outcomes
          .map((o) => o.medical_status)
          .filter(Boolean)
          .join(', ');
        if (outcomeStatuses) lines.push(singleLine(`**Outcome:** ${outcomeStatuses}`));
        for (const o of outcomes) {
          lines.push(...formatRemainingFields(o, new Set(['medical_status'])));
        }
      }

      // Reporter and type
      if (r.primary_reporter) lines.push(singleLine(`**Reporter:** ${r.primary_reporter}`));
      if (r.type_of_information) lines.push(singleLine(`**Type:** ${r.type_of_information}`));
      if (r.foreign_or_domestic) lines.push(singleLine(`**Origin:** ${r.foreign_or_domestic}`));

      /**
       * Render remaining top-level fields — the serious_ae code, receiver,
       * secondary reporter, treatment context, health assessment, counts.
       */
      const rendered = new Set([
        'unique_aer_id_number',
        'original_receive_date',
        'animal',
        'reaction',
        'drug',
        'outcome',
        'primary_reporter',
        'type_of_information',
        'foreign_or_domestic',
      ]);
      const numberInfo = [
        r.number_of_animals_treated ? `treated: ${r.number_of_animals_treated}` : null,
        r.number_of_animals_affected ? `affected: ${r.number_of_animals_affected}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      if (numberInfo) lines.push(singleLine(`**Animals:** ${numberInfo}`));
      rendered.add('number_of_animals_treated');
      rendered.add('number_of_animals_affected');

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

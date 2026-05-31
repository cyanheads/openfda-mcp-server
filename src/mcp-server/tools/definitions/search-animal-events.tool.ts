/**
 * @fileoverview Tool for searching openFDA animal and veterinary adverse event reports.
 * @module mcp-server/tools/definitions/search-animal-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { emptyResultMessage, formatRemainingFields } from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const searchAnimalEventsTool = tool('openfda_search_animal_events', {
  description:
    'Search adverse event reports for veterinary drugs and devices submitted to the FDA Center for Veterinary Medicine. Records include animal species, breed, age, weight, drug name and route, adverse reactions (using VeDDRA terminology), and outcome. Use to investigate safety signals for veterinary products, find reports by animal species or drug, or explore reaction patterns.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: z
      .string()
      .optional()
      .describe(
        'openFDA search query using field:value syntax. Examples: animal.species:"Dog", drug.brand_name:"Bravecto", reaction.veddra_term_name:"Vomiting", serious_ae:"true". Omit to browse recent reports.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: original_receive_date:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(10)
      .describe('Maximum number of records to return (1-1000, default 10)'),
    skip: z
      .number()
      .min(0)
      .max(25000)
      .default(0)
      .describe('Number of records to skip for pagination (0-25000, default 0)'),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records in the dataset'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe('Records returned in this response'),
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Animal adverse event records. Key fields: unique_aer_id_number, original_receive_date, serious_ae, animal (species, gender, breed, age, weight), drug[] (brand_name, active_ingredients, route, dose, administered_by), reaction[] (veddra_term_name, number_of_animals_affected), outcome[] (medical_status), primary_reporter, type_of_information.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching animal adverse event records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty or paging overshot — how to broaden filters or adjust the query. Absent when results are returned.',
      ),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The openFDA daily or per-minute request limit is exceeded.',
      retryable: true,
      recovery:
        'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The openFDA API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
    },
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
    },
    {
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'skip exceeds the 25000 record pagination ceiling.',
      recovery:
        'Narrow the search query with additional filters or date ranges instead of increasing skip.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFdaService();
    const response = await svc.query(
      'animalandveterinary/event',
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Animal adverse event search completed', {
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    if (response.results.length === 0) {
      ctx.enrich.notice(
        emptyResultMessage(
          response.meta.skip,
          `No animal adverse event reports matched${input.search ? ` search: ${input.search}` : ''}. Try broader filters — use animal.species, drug.brand_name, or reaction.veddra_term_name fields.`,
        ),
      );
    }

    return { meta: response.meta, results: response.results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No animal adverse event reports found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total results** (returned: ${result.results.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    for (const r of result.results) {
      lines.push(`### Report ${r.unique_aer_id_number ?? 'N/A'}`);
      lines.push(
        `**Received:** ${r.original_receive_date ?? 'N/A'} | **Serious:** ${r.serious_ae === 'true' ? 'Yes' : r.serious_ae === 'false' ? 'No' : (r.serious_ae ?? 'N/A')}`,
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
        if (speciesBreed) lines.push(`**Animal:** ${speciesBreed}`);

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
        if (animalDetails) lines.push(`  ${animalDetails}`);
      }

      // Reactions
      const reactions = (r.reaction as Record<string, unknown>[] | undefined) ?? [];
      if (reactions.length > 0) {
        const reactionNames = reactions
          .map((rx) => rx.veddra_term_name)
          .filter(Boolean)
          .join(', ');
        if (reactionNames) lines.push(`**Reactions:** ${reactionNames}`);
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
          const brandName = (d.brand_name as string) ?? ingredientNames ?? 'Unknown';
          const routeDose = [
            d.route ? `via ${d.route}` : null,
            d.administered_by ? `by ${d.administered_by}` : null,
          ]
            .filter(Boolean)
            .join(', ');
          lines.push(`- ${brandName}${routeDose ? ` (${routeDose})` : ''}`);
        }
      }

      // Outcomes
      const outcomes = (r.outcome as Record<string, unknown>[] | undefined) ?? [];
      if (outcomes.length > 0) {
        const outcomeStatuses = outcomes
          .map((o) => o.medical_status)
          .filter(Boolean)
          .join(', ');
        if (outcomeStatuses) lines.push(`**Outcome:** ${outcomeStatuses}`);
      }

      // Reporter and type
      if (r.primary_reporter) lines.push(`**Reporter:** ${r.primary_reporter}`);
      if (r.type_of_information) lines.push(`**Type:** ${r.type_of_information}`);
      if (r.foreign_or_domestic) lines.push(`**Origin:** ${r.foreign_or_domestic}`);

      // Render remaining top-level fields (treatment context, number counts, etc.)
      const rendered = new Set([
        'unique_aer_id_number',
        'original_receive_date',
        'serious_ae',
        'animal',
        'reaction',
        'drug',
        'outcome',
        'primary_reporter',
        'secondary_reporter',
        'type_of_information',
        'foreign_or_domestic',
        'receiver',
        'treated_for_ae',
        'health_assessment_prior_to_exposure',
      ]);
      const numberInfo = [
        r.number_of_animals_treated ? `treated: ${r.number_of_animals_treated}` : null,
        r.number_of_animals_affected ? `affected: ${r.number_of_animals_affected}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      if (numberInfo) lines.push(`**Animals:** ${numberInfo}`);
      rendered.add('number_of_animals_treated');
      rendered.add('number_of_animals_affected');

      lines.push(...formatRemainingFields(r, rendered));
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

/**
 * @fileoverview MCP tool for openFDA count/aggregation queries. Tallies unique
 * values for any field across any endpoint, returning ranked term-count pairs.
 * @module mcp-server/tools/definitions/count-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
  nonBlankString,
  SEARCH_BALANCE_NOTE,
} from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/** All valid openFDA endpoint paths. */
const ENDPOINTS = [
  'drug/event',
  'drug/label',
  'drug/enforcement',
  'drug/ndc',
  'drug/drugsfda',
  'drug/shortages',
  'food/event',
  'food/enforcement',
  'device/event',
  'device/510k',
  'device/pma',
  'device/recall',
  'device/enforcement',
  'device/classification',
  'device/registrationlisting',
  'device/udi',
  'device/covid19serology',
  'animalandveterinary/event',
  'tobacco/problem',
  'other/substance',
] as const;

/** openFDA rejects a count `limit` above this with HTTP 400. */
const OPENFDA_MAX_COUNT_TERMS = 1000;

export const countValuesTool = tool('openfda_count_values', {
  description:
    'Aggregate and tally unique values for any field across any openFDA endpoint. Returns ranked term-count pairs sorted by count descending. Pair with openfda_search_adverse_events, openfda_search_drug_approvals, openfda_search_device_clearances, openfda_search_recalls, openfda_get_drug_label, or openfda_lookup_ndc when sample records help interpret the aggregates.',
  annotations: { readOnlyHint: true },

  input: z.object({
    endpoint: z
      .enum(ENDPOINTS)
      .describe('Full openFDA endpoint path (e.g. "drug/event", "device/classification")'),
    count: nonBlankString().describe(
      'Field to count. openfda_describe_fields gives the verified expression per field as countAs (null = not countable in any form). Otherwise: append .exact for whole-phrase counting of free-text fields (e.g. "patient.reaction.reactionmeddrapt.exact"); count identifier fields openFDA already indexes as keywords (product_ndc, application_number, pma_number) bare — .exact on those is rejected as not countable.',
    ),
    search: nonBlankString()
      .optional()
      .describe(
        `Filter query to scope the count (e.g. patient.drug.medicinalproduct:"metformin"). Omit to count across every record in the endpoint. ${SEARCH_BALANCE_NOTE}`,
      ),
    limit: z
      .number()
      .min(1)
      .max(OPENFDA_MAX_COUNT_TERMS)
      .default(100)
      .describe(
        `Number of top terms to return (default 100, max ${OPENFDA_MAX_COUNT_TERMS} — openFDA's own count maximum). truncated reports whether more distinct terms exist beyond it, except at the maximum itself, where openFDA offers no way to tell.`,
      ),
  }),

  output: z.object({
    meta: z
      .object({
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(
        z
          .object({
            term: z.string().describe('Field value'),
            count: z.number().describe('Number of occurrences'),
          })
          .describe('A single term-count pair'),
      )
      .describe('Term-count pairs sorted by count descending'),
  }),

  enrichment: {
    termCount: z.number().describe('Number of distinct terms returned'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when at least one more distinct term exists beyond the limit. Absent when the list is complete, and at the 1000-term maximum, where openFDA cannot show whether more exist (notice says so).',
      ),
    shown: z.number().optional().describe('Number of terms returned in this response.'),
    cap: z.number().optional().describe('The limit applied to the term list.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe('Count of the lowest-ranked term returned — omitted terms fall at or below it.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Why the tally is empty — the search matched no records, or the matched records carry no value for the field — and how to widen it; when truncated, how to reach the omitted terms; at the 1000-term maximum, that openFDA cannot show whether more distinct values exist. Absent when a complete list is returned.',
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
      when: 'The search or count query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    {
      reason: 'not_aggregatable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'openFDA cannot aggregate the count expression as written — an analyzed text field, .exact on a field already indexed as a keyword, or a field with no countable form.',
      recovery:
        'Use the countAs expression openfda_describe_fields lists for the field, or a different field when it is null. For a field outside that list, add .exact to tally whole values of an analyzed text field, or drop .exact from an identifier field openFDA already indexes as a keyword.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    assertSearchDelimitersBalanced(input.search, ctx);

    /*
     * openFDA count responses carry no distinct-term total, so one term past the
     * limit is the only completeness signal: it arrives only when more exist. At
     * the count maximum there is no room for it, and completeness is unknowable.
     */
    const svc = getOpenFdaService();
    const response = await svc.query(
      input.endpoint,
      {
        search: input.search,
        count: input.count,
        limit: Math.min(input.limit + 1, OPENFDA_MAX_COUNT_TERMS),
      },
      ctx,
    );

    ctx.log.info('Count query completed', {
      endpoint: input.endpoint,
      count: input.count,
      terms: response.results.length,
    });

    const moreExist = response.results.length > input.limit;
    const results = response.results.slice(0, input.limit).map((r) => ({
      term: String(r.term),
      count: r.count as number,
    }));

    ctx.enrich({ termCount: results.length });
    if (response.meta.nothingToCount) {
      ctx.enrich.notice(
        `${input.count} is countable on ${input.endpoint}, but the records matching search: ${input.search} carry no value for it, so the tally is empty. Count across a broader search, or count a different field (openfda_describe_fields lists the endpoint's countable fields).`,
      );
    } else if (results.length === 0) {
      ctx.enrich.notice(
        `${input.count} is countable on ${input.endpoint}, but nothing matched${input.search ? ` search: ${input.search}` : ''}. Broaden or drop the search filter; call openfda_describe_fields for the endpoint field list.`,
      );
    } else if (moreExist) {
      const lowestCount = results.at(-1)?.count;
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        ...(lowestCount !== undefined ? { ceiling: lowestCount } : {}),
        guidance: `Showing the top ${input.limit} terms by count; more distinct values exist. Raise limit (max ${OPENFDA_MAX_COUNT_TERMS}) or narrow with search.`,
      });
    } else if (results.length === OPENFDA_MAX_COUNT_TERMS) {
      ctx.enrich.notice(
        `The term list reached openFDA's ${OPENFDA_MAX_COUNT_TERMS}-term maximum for a count, so openFDA cannot show whether more distinct values exist. Narrow with search to rank a smaller population.`,
      );
    }

    return { meta: { lastUpdated: response.meta.lastUpdated }, results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: 'No count results.' }];
    }

    const totalCount = result.results.reduce((sum, r) => sum + r.count, 0);
    const lines: string[] = [
      `**${result.results.length} terms** (total occurrences: ${totalCount}) | Data updated: ${result.meta.lastUpdated}\n`,
      '| # | Term | Count |',
      '|---|------|-------|',
    ];

    for (const [i, r] of result.results.entries()) {
      lines.push(`| ${i + 1} | ${r.term} | ${r.count} |`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

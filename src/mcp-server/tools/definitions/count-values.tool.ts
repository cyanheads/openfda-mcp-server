/**
 * @fileoverview MCP tool for openFDA count/aggregation queries. Tallies unique
 * values for any field across any endpoint, returning ranked term-count pairs.
 * @module mcp-server/tools/definitions/count-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { codeLiteral, escapeTableCell, singleLine } from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
  nonBlankString,
  PAGE_SIZES,
  pageLimit,
  pageSizeNotice,
  phrasePlusHint,
  resolvePageSize,
  SEARCH_SYNTAX_NOTE,
  searchExpression,
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

/**
 * The count term list's cap, which is openFDA's own count maximum: openFDA
 * rejects a count `limit` above it with HTTP 400, so the one-term look-ahead has
 * no room at it.
 */
const OPENFDA_MAX_COUNT_TERMS = PAGE_SIZES.count.cap;

/**
 * One openFDA count row. A field value arrives as `{ term, count }` (a number on
 * numeric fields); a date field arrives as `{ time, count }`, one bucket per
 * distinct `YYYYMMDD` date. Keyed on the row rather than the field catalog,
 * which does not type every date field openFDA buckets.
 */
const CountRowSchema = z.union([
  z.object({ term: z.union([z.string(), z.number(), z.boolean()]), count: z.number() }),
  z.object({ time: z.string(), count: z.number() }),
]);

type CountTerm = { term: string; count: number };

/** Count descending, then term ascending — chronological for `YYYYMMDD` dates. */
const byCountThenTerm = (a: CountTerm, b: CountTerm) =>
  b.count - a.count || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0);

export const countValuesTool = tool('openfda_count_values', {
  description:
    'Aggregate and tally unique values for any field across any openFDA endpoint. Returns ranked term-count pairs sorted by count descending; a date field tallies one term per distinct YYYYMMDD date, ranked the same way. Pair with openfda_search_adverse_events, openfda_search_drug_approvals, openfda_search_device_clearances, openfda_search_recalls, openfda_get_drug_label, or openfda_lookup_ndc when sample records help interpret the aggregates.',
  annotations: { readOnlyHint: true },

  input: z.object({
    endpoint: z
      .enum(ENDPOINTS)
      .describe('Full openFDA endpoint path (e.g. "drug/event", "device/classification")'),
    count: nonBlankString().describe(
      'Field to count. openfda_describe_fields gives the verified expression per field as countAs (null = not countable in any form). Otherwise: append .exact for whole-phrase counting of free-text fields (e.g. "patient.reaction.reactionmeddrapt.exact"); count identifier fields openFDA already indexes as keywords (product_ndc, application_number, pma_number) bare — .exact on those is rejected as not countable. A date field (receivedate, report_date, decision_date) is counted bare and yields one term per distinct YYYYMMDD date.',
    ),
    search: searchExpression()
      .optional()
      .describe(
        `Filter query to scope the count (e.g. patient.drug.medicinalproduct:"metformin"). Omit to count across every record in the endpoint. ${SEARCH_SYNTAX_NOTE}`,
      ),
    limit: pageLimit(
      'count',
      `Number of top terms to return. truncated reports whether more distinct terms exist beyond it, except at ${OPENFDA_MAX_COUNT_TERMS} — openFDA's own count maximum — where openFDA offers no way to tell. A date field is the exception: openFDA sends every date, so the tool ranks them all and truncated is exact at any limit; scope search to at most limit dates to list each one.`,
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
            term: z.string().describe('Field value; on a date field, the date as YYYYMMDD'),
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
        'True when at least one more distinct term exists beyond the limit. Absent when the list is complete, and at the 1000-term maximum, where openFDA cannot show whether more exist (notice says so). Exact at any limit on a date field, where every date arrives.',
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
        'Why the tally is empty — the search matched no records, or the matched records carry no value for the field — and how to widen it; when truncated, how to reach the omitted terms (on a date field, how many distinct dates were counted); at the 1000-term maximum, that openFDA cannot show whether more distinct values exist; how many count rows openFDA sent without a value or numeric count, which are left out; when limit exceeded the 1000-term cap, the requested value and the cap applied. Absent when a complete list is returned at the requested limit.',
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
    const size = resolvePageSize(input.limit, 'count', ctx);
    const limit = size.limit;

    /*
     * openFDA count responses carry no distinct-term total, so one term past the
     * limit is the only completeness signal: it arrives only when more exist. At
     * the count maximum there is no room for it, and completeness is unknowable.
     * Date buckets are the exception: openFDA ignores `limit` on them and sends
     * every bucket in ascending date order, so they are ranked here and the cut
     * is exact.
     */
    const svc = getOpenFdaService();
    const response = await svc.query(
      input.endpoint,
      {
        search: input.search,
        count: input.count,
        limit: Math.min(limit + 1, OPENFDA_MAX_COUNT_TERMS),
      },
      ctx,
    );

    ctx.log.info('Count query completed', {
      endpoint: input.endpoint,
      count: input.count,
      terms: response.results.length,
    });

    const rows = response.results.map((row) => CountRowSchema.safeParse(row).data);
    const dated = rows.some((row) => row !== undefined && 'time' in row);
    const considered = dated ? rows : rows.slice(0, limit);
    const tally = considered.flatMap((row) =>
      row === undefined
        ? []
        : [{ term: 'time' in row ? row.time : String(row.term), count: row.count }],
    );
    if (dated) tally.sort(byCountThenTerm);
    const results = tally.slice(0, limit);
    const moreExist = dated ? tally.length > limit : response.results.length > limit;

    const unreadable = considered.length - tally.length;
    const unreadableNote =
      unreadable > 0
        ? `openFDA returned ${unreadable} count ${unreadable === 1 ? 'row' : 'rows'} with no value or no numeric count; ${unreadable === 1 ? 'it is' : 'they are'} left out of the tally.`
        : undefined;
    /*
     * `notice` is last-wins, and the clamp disclosure holds on every branch, so
     * each branch sends its own text joined with the notes that also apply.
     */
    const clampNote = pageSizeNotice(size);
    const withNotes = (...texts: (string | undefined)[]) =>
      [...texts, clampNote].filter(Boolean).join(' ');

    // Caller text in a notice rides as a code literal, so it reads back as sent.
    const field = codeLiteral(input.count);
    const search = input.search && codeLiteral(input.search);

    ctx.enrich({ termCount: results.length });
    if (response.meta.nothingToCount) {
      ctx.enrich.notice(
        withNotes(
          `${field} is countable on ${input.endpoint}, but the records matching search: ${search} carry no value for it, so the tally is empty. Count across a broader search, or count a different field (openfda_describe_fields lists the endpoint's countable fields).`,
        ),
      );
    } else if (results.length === 0) {
      const hint = phrasePlusHint(input.search, response.results.length);
      ctx.enrich.notice(
        withNotes(
          unreadableNote ??
            `${field} is countable on ${input.endpoint}, but nothing matched${search ? ` search: ${search}` : ''}. Broaden or drop the search filter; call openfda_describe_fields for the endpoint field list.${hint ? ` ${hint}` : ''}`,
        ),
      );
    } else if (moreExist) {
      const lowestCount = results.at(-1)?.count;
      const raise = limit < OPENFDA_MAX_COUNT_TERMS;
      ctx.enrich.truncated({
        shown: results.length,
        cap: limit,
        ...(lowestCount !== undefined ? { ceiling: lowestCount } : {}),
        guidance: withNotes(
          dated
            ? `Showing the ${limit} dates with the most records of the ${tally.length} distinct dates counted. ${raise ? `Raise limit (max ${OPENFDA_MAX_COUNT_TERMS}) or narrow` : 'Narrow'} search to at most ${limit} dates to list every one.`
            : `Showing the top ${limit} terms by count; more distinct values exist. Raise limit (max ${OPENFDA_MAX_COUNT_TERMS}) or narrow with search.`,
          unreadableNote,
        ),
      });
    } else if (!dated && results.length === OPENFDA_MAX_COUNT_TERMS) {
      ctx.enrich.notice(
        withNotes(
          `The term list reached openFDA's ${OPENFDA_MAX_COUNT_TERMS}-term maximum for a count, so openFDA cannot show whether more distinct values exist. Narrow with search to rank a smaller population.`,
          unreadableNote,
        ),
      );
    } else if (unreadableNote || clampNote) {
      ctx.enrich.notice(withNotes(unreadableNote));
    }

    return { meta: { lastUpdated: response.meta.lastUpdated }, results };
  },

  format: (result) => {
    const totalCount = result.results.reduce((sum, r) => sum + r.count, 0);
    const header = `${singleLine(`**${result.results.length} terms** (total occurrences: ${totalCount}) | Data updated: ${result.meta.lastUpdated}`)}\n`;
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: `${header}\nNo count results.` }];
    }

    const lines: string[] = [header, '| # | Term | Count |', '|---|------|-------|'];

    for (const [i, r] of result.results.entries()) {
      lines.push(`| ${i + 1} | ${escapeTableCell(r.term)} | ${r.count} |`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

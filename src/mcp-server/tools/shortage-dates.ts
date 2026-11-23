/**
 * @fileoverview Calendar dates on the `drug/shortages` date fields, rewritten to
 * the one form openFDA reads as written. The endpoint stores
 * `initial_posting_date`, `update_date`, `discontinued_date`, and `change_date`
 * as MM/DD/YYYY strings but indexes them as dates that also accept epoch
 * milliseconds, so an eight-digit `20261120` is read as a time on 1970-01-01, a
 * date that is not zero-padded matches nothing, and an unquoted `11/20/2026`
 * parses as something other than a date. Every endpoint reads `YYYY-MM-DD`.
 * {@link canonicalShortageDate} rewrites one value; {@link rewriteShortageDates}
 * rewrites every such value in a `search` query; {@link shortageDateGroupHint}
 * is the no-match hint for a `field:(…)` group the rewrite leaves as written.
 * @module mcp-server/tools/shortage-dates
 */

import { type SourceSpan, scanFieldClauses } from '@/mcp-server/tools/search-clauses.js';
import { SEARCH_REFUSED_CHARACTER } from '@/mcp-server/tools/search-expression.js';

/** The `drug/shortages` fields stored MM/DD/YYYY and indexed as dates. */
const SHORTAGE_DATE_FIELDS: ReadonlySet<string> = new Set([
  'initial_posting_date',
  'update_date',
  'discontinued_date',
  'change_date',
]);

/** Longest value {@link canonicalShortageDate} can rewrite: `MM/DD/YYYY` or `YYYY-MM-DD`. */
const LONGEST_DATE = 10;

/** A character of an unquoted slash-form date. */
const SLASH_DATE_CHAR = /[0-9/]/;
/** What may follow an unquoted slash-form date for it to be the whole value: whitespace or `)`. */
const SLASH_DATE_END = /[\s)]/;

/** `YYYYMMDD`, the form `openfda_count_values` returns these fields' buckets in. */
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
/** `M/D/YYYY`, one- or two-digit month and day, the stored form when zero-padded. */
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** `YYYY-M-D`, one- or two-digit month and day. */
const DASHED_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Gregorian leap year: every fourth year, except centuries not divisible by 400. */
const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * The year, month, and day a value spells in one of the three date forms. Every
 * group takes part in a match; the defaults only satisfy `noUncheckedIndexedAccess`.
 */
function dateParts(value: string): { year: string; month: string; day: string } | undefined {
  const yearFirst = COMPACT_DATE.exec(value) ?? DASHED_DATE.exec(value);
  if (yearFirst) {
    const [, year = '', month = '', day = ''] = yearFirst;
    return { year, month, day };
  }
  const slashed = SLASHED_DATE.exec(value);
  if (slashed) {
    const [, month = '', day = '', year = ''] = slashed;
    return { year, month, day };
  }
  return;
}

/**
 * One date value as written on a `drug/shortages` date field, as zero-padded
 * `YYYY-MM-DD` when it spells a real calendar date as `YYYYMMDD`, `M/D/YYYY`, or
 * `YYYY-M-D` (one- or two-digit month and day). Any other value comes back
 * unchanged: `*`, epoch milliseconds, a date-time, date math such as `now-30d`,
 * and a date that does not exist (month 13, 30 February, 29 February outside a
 * leap year), which openFDA answers with no match whatever its form. The value is
 * the term or range bound without its quotes; checked for length before any
 * pattern runs, so the cost does not grow with the value.
 */
export function canonicalShortageDate(value: string): string {
  if (value.length > LONGEST_DATE) return value;
  const parts = dateParts(value);
  if (!parts) return value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // A month outside 1–12 has no entry in the table.
  const monthDays = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (monthDays === undefined || day < 1 || day > monthDays) return value;
  return `${parts.year}-${parts.month.padStart(2, '0')}-${parts.day.padStart(2, '0')}`;
}

/**
 * The source span of an unquoted term's value. Lucene ends a term at `/`, so
 * `update_date:11/20/2026` scans as the term `11` followed by a regexp: when the
 * run of digits and slashes from the term's start, read for at most
 * {@link LONGEST_DATE} characters, reaches past the term and ends the clause (at
 * the end of the query, whitespace, or `)`), that run is the value.
 */
function bareValueSpan(search: string, term: SourceSpan): SourceSpan {
  let end = term.start;
  while (
    end < search.length &&
    end - term.start < LONGEST_DATE &&
    SLASH_DATE_CHAR.test(search[end] ?? '')
  ) {
    end += 1;
  }
  if (end <= term.end) return term;
  if (end < search.length && !SLASH_DATE_END.test(search[end] ?? '')) return term;
  return { start: term.start, end };
}

/**
 * `search` with every calendar date on a `drug/shortages` date field rewritten by
 * {@link canonicalShortageDate}: a `field:` term, bare or quoted, and either bound
 * of a `[…]` or `{…}` range, on `initial_posting_date`, `update_date`,
 * `discontinued_date`, or `change_date`. A rewritten unquoted term is sent quoted
 * (`update_date:"2026-11-20"`, the form every unquoted hyphenated term takes); a
 * quoted term and a range bound keep the caller's quoting. Left as written: a
 * `field:(…)` group, a `/regexp/`, every other field, and every value that is not
 * a calendar date in one of the three forms. A query with nothing to rewrite
 * comes back as the same string.
 *
 * A query holding a {@link SEARCH_REFUSED_CHARACTER} is also left as written: the
 * delimiter guard rejects it before any request, and a rewritten date is longer
 * than the one it replaces, so the position the rejection names would no longer
 * count the caller's characters.
 *
 * Pass the search after `searchExpression()` has normalized it. Edits come from
 * {@link scanFieldClauses} spans in source order and are spliced in one
 * left-to-right pass over the original string, so every span stays valid and
 * the cost is linear in the length of the query.
 */
export function rewriteShortageDates(search: string): string {
  if (SEARCH_REFUSED_CHARACTER.test(search)) return search;
  const pieces: string[] = [];
  let copiedTo = 0;
  const edit = (span: SourceSpan, text: string) => {
    pieces.push(search.slice(copiedTo, span.start), text);
    copiedTo = span.end;
  };

  for (const { field, value } of scanFieldClauses(search)) {
    if (!SHORTAGE_DATE_FIELDS.has(field)) continue;
    if (value.kind === 'term') {
      const span = value.quoted ? value.span : bareValueSpan(search, value.span);
      const written = search.slice(span.start, span.end);
      const date = canonicalShortageDate(written);
      if (date !== written) edit(span, value.quoted ? date : `"${date}"`);
    } else if (value.kind === 'range') {
      for (const { span } of value.bounds) {
        const written = search.slice(span.start, span.end);
        const date = canonicalShortageDate(written);
        if (date !== written) edit(span, date);
      }
    }
  }

  if (pieces.length === 0) return search;
  pieces.push(search.slice(copiedTo));
  return pieces.join('');
}

/**
 * The empty-result hint for a search holding a `field:(…)` group on one of the
 * four date fields, or `undefined` when it holds none. {@link rewriteShortageDates}
 * leaves a group's dates as written, so `update_date:(20261120 OR 20261119)`
 * matches nothing; the hint names the first such group's field and the form to
 * write. One {@link scanFieldClauses} pass, so linear in the length of the query.
 *
 * Wiring: pass the parsed `input.search` and add the returned text to the tool's
 * no-match notice, which only a zero-total page carries.
 */
export function shortageDateGroupHint(search: string | undefined): string | undefined {
  if (search === undefined) return;
  const group = scanFieldClauses(search).find(
    ({ field, value }) => value.kind === 'group' && SHORTAGE_DATE_FIELDS.has(field),
  );
  if (!group) return;
  return `Dates inside the ${group.field}:(...) group are sent as written, so write each one YYYY-MM-DD.`;
}

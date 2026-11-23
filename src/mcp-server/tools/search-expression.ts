/**
 * @fileoverview The shared caller-supplied `search` input and its guards:
 * `searchExpression()`, which reads whitespace and openFDA's URL-form `+`
 * separators as spaces and quotes an unquoted hyphenated term openFDA would
 * otherwise split into its parts; the guard that rejects a character openFDA
 * refuses, an unclosed quote, group, or range, or a trailing backslash, before
 * an upstream request is spent, with its `malformed_search` contract entry; the
 * exported definition of the characters openFDA refuses; the `search`
 * description clause every tool shares; and the empty-result hint for a `+`
 * inside a quoted phrase.
 * @module mcp-server/tools/search-expression
 */

import type { TypedFail } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { codeLiteral } from '@/mcp-server/tools/format-utils.js';
import { nonBlankString } from '@/mcp-server/tools/schema-utils.js';

/* --- characters openFDA refuses --- */

/**
 * Whitespace: every character `\s` matches, the set `nonBlankString()` treats as
 * blank. openFDA answers HTTP 400 `Search not supported` to a query holding any
 * of them but the space itself — a tab, a line break, a no-break space — where
 * Lucene reads each as a separator, so {@link searchExpression} turns each into a
 * space. Matches one character and carries no `g` flag, so `test()` keeps no
 * state between calls; a caller replacing every match builds its global form
 * from `.source`.
 */
export const SEARCH_WHITESPACE = /\s/u;

/**
 * Every other character openFDA refuses anywhere in a `search`, inside a quoted
 * phrase and after a backslash alike (HTTP 400 `Search not supported`): the
 * ASCII marks `` ! # $ ; ? ^ ` | ~ ``, and every character outside printable ASCII
 * (U+0020–U+007E) that is not {@link SEARCH_WHITESPACE}, so the two never
 * overlap. Matches one code point, with no `g` flag, as above.
 *
 * {@link assertSearchDelimitersBalanced} rejects a caller's `search` holding one
 * rather than rewriting it: outside a phrase `!`, `|`, `?`, `^`, and `~` are
 * Lucene operators, and `;` sits inside a term, so a space in its place would
 * change the query's structure.
 */
export const SEARCH_REFUSED_CHARACTER = /[!#$;?^`|~]|[^\s\x20-\x7e]/u;

/** {@link SEARCH_WHITESPACE} in the global form `replace()` needs. */
const EVERY_WHITESPACE = new RegExp(SEARCH_WHITESPACE.source, 'gu');

/** What to write instead of a refused ASCII mark that has a working spelling. */
const REFUSED_CHARACTER_ADVICE = new Map([
  ['!', 'Remove it; to exclude a clause, write NOT before it.'],
  ['|', 'Remove it; to join alternatives, write OR between them.'],
  ['?', 'Remove it; for a wildcard, write * (it matches any run of characters).'],
  ['^', 'Remove it; openFDA has no ^ boost operator.'],
  ['~', 'Remove it; openFDA has no ~ fuzzy or proximity operator.'],
]);

/** A combining mark, as canonical decomposition splits it from its letter. */
const COMBINING_MARK = /\p{Mn}/gu;

/** One or more ASCII letters and nothing else. */
const ASCII_LETTERS = /^[A-Za-z]+$/;

/**
 * `text` with each canonical diacritic dropped: it is decomposed (NFD) and its
 * combining marks removed, so `é` → `e`, `Å` → `A`, and a lone combining mark
 * → nothing. Canonical decomposition only, so a character with none (`™`, `®`,
 * `ø`, a CJK character) is unchanged.
 */
export function foldDiacritics(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARK, '');
}

/**
 * The `malformed_search` message for a refused `character` at `index`. A
 * printable ASCII mark is quoted as itself; any other character is named only by
 * its code point, so an invisible or direction-changing one never lands in the
 * message. The position counts from 1, and is exact in the caller's text:
 * everything before the first refused character is printable ASCII or
 * whitespace, one UTF-16 unit each, and {@link searchExpression} keeps a query
 * holding one at its own length.
 *
 * A character whose canonical decomposition, combining marks dropped, is ASCII
 * letters (`é` → `e`, `Å` → `A`) is advised as that spelling: openFDA stores such
 * names unaccented, so a space or nothing in its place matches no record. The
 * spelling is ASCII letters only, so nothing invisible reaches the message
 * there either. Every other character keeps the remove-or-space advice.
 */
function refusedCharacterMessage(character: string, index: number): string {
  const printable = character >= ' ' && character <= '~';
  const name = printable
    ? `"${character}"`
    : `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`;
  const plain = foldDiacritics(character);
  const advice = printable
    ? (REFUSED_CHARACTER_ADVICE.get(character) ?? 'Remove it or put a space in its place.')
    : ASCII_LETTERS.test(plain)
      ? `openFDA accepts only printable ASCII in a query: write "${plain}" in its place.`
      : 'openFDA accepts only printable ASCII in a query: remove it or put a space in its place.';
  return `Search query holds ${name} at position ${index + 1}, a character openFDA refuses anywhere in a query, quoted or escaped. ${advice}`;
}

/* --- search delimiter balance --- */

/**
 * Shared `search` description clause, appended to every tool's own `search`
 * prose. It states the one `+` rule a caller has to know: {@link searchExpression}
 * reads a separator `+` as a space, but never touches one inside a quoted
 * phrase, where it is data and a URL-style phrase silently matches nothing. The
 * separator positions themselves need no statement, since the rewrite applies
 * them, and the delimiter rule none, since {@link assertSearchDelimitersBalanced}
 * rejects a fault before the request and {@link malformedSearchError} states it.
 */
export const SEARCH_SYNTAX_NOTE =
  'A "+" between clauses reads as a space; inside a quoted phrase it is a literal plus.';

/** The delimiter faults {@link findSearchDelimiterFault} can detect. */
export type SearchDelimiterFault =
  | 'unterminated_quote'
  | 'unopened_paren'
  | 'unclosed_paren'
  | 'unopened_range'
  | 'unclosed_range'
  | 'dangling_escape';

/**
 * Report the first delimiter fault in an openFDA `search` query, or `undefined`
 * when every delimiter it opens is closed.
 *
 * Three Lucene contexts, because a delimiter's meaning depends on the one it sits
 * in — every boundary below is the upstream's own answer, not an assumption:
 *
 * - **Normal.** `"` opens a phrase, `[` or `{` opens a range, `(`/`)` group. A
 *   `]`/`}` with no opener and a `)` with no `(` are both refused upstream, as is
 *   a bare `[` or `]` inside a term (`reason_for_recall:foo[bar` answers
 *   `parse_exception`, since openFDA reads `[` as a range opener wherever it
 *   appears unquoted).
 * - **Inside a phrase** every other delimiter is literal data.
 *   `product_description:"Packaged as a) 4 FL OZ"` carries one `)` and no `(` and
 *   matches a real `drug/enforcement` record.
 * - **Inside a range** the same holds, which a paren or quote count alone gets
 *   wrong: `report_date:[(20200101 TO 20201231]` and
 *   `report_date:["20200101 TO 20201231]` are both answered rather than refused.
 *
 * A backslash escapes the next character in every context, ranges included —
 * openFDA answers `Term can not end with escape character` when one consumes a
 * range's closing bracket. With no next character there is nothing to escape,
 * which is `dangling_escape`.
 *
 * Field names, boolean structure, wildcards, and `+`/`-` prefixes are left to
 * openFDA to arbitrate. The characters openFDA refuses outright are
 * {@link assertSearchDelimitersBalanced}'s own check, made before this one.
 */
export function findSearchDelimiterFault(search: string): SearchDelimiterFault | undefined {
  let inPhrase = false;
  let inRange = false;
  let depth = 0;

  for (let i = 0; i < search.length; i += 1) {
    const char = search[i];
    if (char === '\\') {
      if (i + 1 >= search.length) return 'dangling_escape';
      i += 1; // The escaped character is literal — never a delimiter.
      continue;
    }
    if (inPhrase) {
      if (char === '"') inPhrase = false;
      continue;
    }
    if (inRange) {
      // A range accepts either closer, so `[X TO Y}` and `{X TO Y]` both close.
      if (char === ']' || char === '}') inRange = false;
      continue;
    }
    if (char === '"') inPhrase = true;
    else if (char === '[' || char === '{') inRange = true;
    else if (char === ']' || char === '}') return 'unopened_range';
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return 'unopened_paren';
    }
  }

  if (inPhrase) return 'unterminated_quote';
  if (inRange) return 'unclosed_range';
  if (depth > 0) return 'unclosed_paren';
  return;
}

const SEARCH_FAULT_MESSAGE: Record<SearchDelimiterFault, string> = {
  unterminated_quote:
    'Search query has an unterminated double quote — a phrase is opened and never closed. Close it, or write a literal quote inside a phrase as \\".',
  unopened_paren:
    'Search query closes a group that was never opened — a ")" appears with no preceding "(". Remove it, or write a literal paren as \\).',
  unclosed_paren:
    'Search query leaves a group open — a "(" is never closed. Close it, or write a literal paren as \\(.',
  unopened_range:
    'Search query closes a range that was never opened — a "]" or "}" appears with no preceding "[" or "{". Remove it, or write a literal bracket as \\].',
  unclosed_range:
    'Search query leaves a range open — a "[" or "{" is never closed by "]" or "}". Close it, or write a literal bracket as \\[ (openFDA reads an unquoted bracket as a range, even mid-term).',
  dangling_escape:
    'Search query ends on a backslash, which escapes the character after it and has nothing left to escape. Remove it, or write a literal backslash as \\\\.',
};

/**
 * The `errors[]` entry every tool taking a caller-supplied `search` declares, so
 * the locally-rejected shape is advertised and distinguishable from the
 * `query_error` openFDA raises on field semantics. Spread into the contract.
 * Raised by {@link assertSearchDelimitersBalanced}, below the handler body, hence
 * `thrownBy: 'service'`.
 */
export const malformedSearchError = {
  reason: 'malformed_search',
  code: JsonRpcErrorCode.ValidationError,
  when: 'search leaves a double quote, parenthesis, or range bracket unclosed, ends on a backslash, or holds a character openFDA refuses.',
  recovery:
    'Close the unterminated quote, group, or range, write a literal " ( ) [ ] or backslash escaped with a backslash, or replace the character the message names as the message says.',
  thrownBy: 'service',
} as const;

/** The slice of a handler's `ctx` {@link assertSearchDelimitersBalanced} needs. */
type MalformedSearchContext = {
  fail: TypedFail<'malformed_search'>;
};

/**
 * Reject a `search` query openFDA cannot answer, before the request is spent.
 *
 * First, a {@link SEARCH_REFUSED_CHARACTER}, checked ahead of the delimiters as
 * openFDA's own gate answers before its parser does. openFDA's reply is a 400
 * echoing the whole query HTML-escaped, never the character, and its recovery
 * would send the caller to field names and boolean operators; the message here
 * names the character, its position, and the syntax that works instead.
 *
 * Then the delimiters, through {@link findSearchDelimiterFault}. openFDA answers
 * most of those faults with a `token_mgr_error` or `parse_exception` whose column
 * index runs past the submitted string and whose echoed tail repeats clauses the
 * caller never sent, so the actual defect is never named.
 *
 * A trailing backslash is worse than an unnamed error and is why this guard
 * covers more than balance. The endpoints that scope a shared index append their
 * own clause, so the escape lands on that clause's leading space instead of the
 * end of input: on `drug/enforcement`, `recalling_firm:pfizer\` answers HTTP 200
 * with 18856 records against 155 for `recalling_firm:pfizer` — the appended
 * `product_type:drugs` scope is swallowed and the caller is silently served
 * another product type's recalls.
 *
 * A handler guard rather than a schema `.refine()` for the reason
 * `OPENFDA_MAX_SKIP` in `schema-utils.ts` documents: a schema rejection carries no
 * `structuredContent.error.data.reason` and none of the declared recovery text,
 * leaving the advertised {@link malformedSearchError} contract unreachable. The
 * check stays out of `OpenFdaService` too — the service forwards whatever string
 * it is given, and internally composed queries are not caller input.
 */
export function assertSearchDelimitersBalanced(
  search: string | undefined,
  ctx: MalformedSearchContext,
): void {
  if (search === undefined) return;
  const refused = SEARCH_REFUSED_CHARACTER.exec(search);
  if (refused) {
    throw ctx.fail('malformed_search', refusedCharacterMessage(refused[0], refused.index));
  }
  const fault = findSearchDelimiterFault(search);
  if (!fault) return;
  throw ctx.fail('malformed_search', SEARCH_FAULT_MESSAGE[fault]);
}

/* --- search `+` separators --- */

/** Lucene's word operators — uppercase only; `and` or `to` is an ordinary term. */
const OPERATOR_WORDS = new Set(['AND', 'OR', 'NOT', 'TO']);

/** The longest word operator plus one, so `AND` is told apart from `BAND` or `ANDROID`. */
const OPERATOR_SCAN = 4;

/** Characters that end a word operator: whitespace, `+`, a quote, or a group or range delimiter. */
const OPERATOR_BOUNDARY = /[\s+"()[\]{}]/;

/** Characters that cannot end a term: whitespace and Lucene's syntax characters. `*` is a wildcard, part of the term, and so is `?` in Lucene, though openFDA refuses it. */
const NON_TERM_CHAR = /[\s+\-!(){}[\]^"~:\\/&|]/;

const UPPERCASE = /[A-Z]/;
const FIELD_START = /[A-Za-z_]/;
const FIELD_CHAR = /[A-Za-z0-9_.]/;

/** What can open a clause after a required-operator `+`: a field or term, a phrase, a group, or a range. */
const CLAUSE_START = /[A-Za-z0-9_"([{]/;

/**
 * Whether the query marks a clause required in Lucene's own syntax: an
 * unescaped, unquoted `+` at the start or after whitespace or `(`, directly
 * before a clause. URL form has no use for a `+` there — it would be a leading
 * space — so such a query is written with `+` as the required operator, and a
 * `+` between two of its clauses (`+a:"x"+b:"y"`) is that operator too.
 */
function marksRequiredClause(search: string): boolean {
  let inPhrase = false;
  let escapedAt = -1;
  for (let i = 0; i < search.length; i += 1) {
    const char = search[i];
    if (char === '\\') {
      i += 1;
      escapedAt = i;
      continue;
    }
    if (inPhrase) {
      if (char === '"') inPhrase = false;
      continue;
    }
    if (char === '"') inPhrase = true;
    else if (
      char === '+' &&
      (i === 0 || (escapedAt !== i - 1 && /[\s(]/.test(search[i - 1] ?? ''))) &&
      CLAUSE_START.test(search[i + 1] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the unescaped, unquoted `+` at `index` sits in a separator position —
 * one of the places openFDA's URL-form examples write a space. `escapedAt` is
 * the index of the most recent backslash-escaped character, so a `\)` or `\"`
 * before the `+` reads as a term character rather than a closer. In a query that
 * `requiredStyle` marks as using `+` as the required operator, only the
 * word-operator position counts: a `+` beside `AND`, `OR`, `NOT`, or `TO` has no
 * clause of its own to mark.
 */
function isSeparatorPlus(
  search: string,
  index: number,
  escapedAt: number,
  requiredStyle: boolean,
): boolean {
  const prev = search[index - 1];
  const prevEscaped = escapedAt === index - 1;

  // Touching a standalone word operator, on either side. An escaped letter has a
  // backslash before it, which is no boundary, so the only escape to rule out is
  // on the boundary character itself (`\(AND+`).
  let start = index;
  while (start > 0 && index - start < OPERATOR_SCAN && UPPERCASE.test(search[start - 1] ?? '')) {
    start -= 1;
  }
  if (
    OPERATOR_WORDS.has(search.slice(start, index)) &&
    (start === 0 || (escapedAt !== start - 1 && OPERATOR_BOUNDARY.test(search[start - 1] ?? '')))
  ) {
    return true;
  }
  let end = index + 1;
  while (end < search.length && end - index <= OPERATOR_SCAN && UPPERCASE.test(search[end] ?? '')) {
    end += 1;
  }
  if (
    OPERATOR_WORDS.has(search.slice(index + 1, end)) &&
    (end === search.length || OPERATOR_BOUNDARY.test(search[end] ?? ''))
  ) {
    return true;
  }

  if (requiredStyle) return false;

  // After a closing quote, paren, or bracket. Outside a phrase, an unescaped `"`
  // just before this `+` can only have closed one.
  if (prev !== undefined && !prevEscaped && '")]}'.includes(prev)) return true;

  // Between a term and the next clause's `field:` prefix (`ca+serious:1`). The
  // scan stops at the first non-path character, and a `+` is one, so no stretch
  // of the query is scanned for two different `+`.
  if (prev === undefined || (!prevEscaped && NON_TERM_CHAR.test(prev))) return false;
  if (!FIELD_START.test(search[index + 1] ?? '')) return false;
  let fieldEnd = index + 2;
  while (fieldEnd < search.length && FIELD_CHAR.test(search[fieldEnd] ?? '')) fieldEnd += 1;
  return search[fieldEnd] === ':';
}

/**
 * Turn each `+` that openFDA's URL-form syntax uses as a space into a space,
 * leaving every other `+` as sent.
 *
 * openFDA documents `search` in URL form, where `+` is an encoded space
 * (`a:x+AND+b:y`, `[20040101+TO+20081231]`, `a:x+b:y`). The service sends the
 * value form-encoded, so a `+` reaches openFDA as a literal plus: `+AND+` matches
 * nothing, `+TO+` fails to parse, and `"a"+b:"c"` becomes Lucene's required
 * operator and drops the first clause. A literal plus is also real data and real
 * syntax — `brand_name.exact:"Bausch + Lomb"`, `device_name.exact:Knee+`, and a
 * leading `+field:` required clause all answer correctly as sent — so only an
 * unescaped `+` outside a quoted phrase, in a separator position, is rewritten:
 *
 * - touching a standalone `AND`, `OR`, `NOT`, or `TO` (uppercase, as Lucene reads
 *   them; inside a range too);
 * - right after a closing `"`, `)`, `]`, or `}`;
 * - right before a `field:` prefix when the character before the `+` ends a term.
 *
 * The last two positions are also where Lucene's required operator goes, so they
 * are read as separators only in a query that does not otherwise use that
 * operator ({@link marksRequiredClause}): `+a:"x"+b:"y"` keeps its AND, answered
 * as sent, where reading the middle `+` as a space would make `b` optional.
 *
 * A `+` before `(` after a bare term stays literal, and a keyword-shaped literal
 * value ending in an operator word (`brand_name.exact:x+AND`) reads as a separator:
 * neither occurs in the data, and a caller can always write a space or `\+`.
 *
 * Two passes, with a constant-size look-around per `+` and a field-prefix scan no
 * two `+` share, so the cost is linear in the length of the query.
 */
function normalizeSearchSeparators(search: string): string {
  if (!search.includes('+')) return search;
  const requiredStyle = marksRequiredClause(search);
  let out = '';
  let copiedTo = 0;
  let inPhrase = false;
  let escapedAt = -1;

  for (let i = 0; i < search.length; i += 1) {
    const char = search[i];
    if (char === '\\') {
      i += 1; // The escaped character is literal, in a phrase or out of one.
      escapedAt = i;
      continue;
    }
    if (inPhrase) {
      if (char === '"') inPhrase = false;
      continue;
    }
    if (char === '"') inPhrase = true;
    else if (char === '+' && isSeparatorPlus(search, i, escapedAt, requiredStyle)) {
      out += `${search.slice(copiedTo, i)} `;
      copiedTo = i + 1;
    }
  }
  return out + search.slice(copiedTo);
}

/* --- unquoted hyphenated terms --- */

/** A whole term of letters and digits joined by hyphens: `0003-0894`, `D-0123-2024`, `COVID-19`. */
const HYPHENATED_TERM = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/y;

/** What ends a term on either side, besides the start or end of the query: whitespace or a group paren. */
const TERM_BOUNDARY = /[\s()]/;

/** The Lucene context a character sits in, as {@link findSearchDelimiterFault} reads them, plus a `/…/` regexp. */
type TermContext = 'normal' | 'phrase' | 'range' | 'regexp';

/**
 * Send each unquoted whole term of letters and digits joined by hyphens as a
 * quoted phrase: `0003-0894` → `"0003-0894"`, `recall_number:D-0123-2024` →
 * `recall_number:"D-0123-2024"`, `-0003-0894` → `-"0003-0894"`.
 *
 * Lucene reads a hyphen inside a term as part of it, so `D-0123-2024` is one
 * term; openFDA's analyzer then splits it into `d`, `0123`, and `2024` and ORs
 * them, so the term matches any record holding any part. On `drug/enforcement`
 * `recall_number:D-0123-2024` answers the 18,148 records of
 * `recall_number:(D OR 0123 OR 2024)` and the quoted form answers 1; on
 * `drug/ndc` `0003-0894` answers 259, led by other labelers' products, and the
 * quoted form answers 1. Keyword and date fields are not split, and answer the
 * same either way (`product_ndc:0003-0894`, `update_date:2026-11-20`). A notice
 * would leave the unrelated records ranked first, so the term is quoted.
 *
 * Only a whole term is quoted: one bounded by the start or end of the query,
 * whitespace, or a group paren, or opening a `field:` value; a leading `-` or `+`
 * operator before a bounded term stays outside the quotes. A term holding any
 * other character (`D-0123*`, `1.5-mg`, `a\-b`) is left as written, and so is
 * everything inside a quoted phrase, a `[…]`/`{…}` range, or a `/…/` regexp,
 * which Lucene reads to the next unescaped slash. The quotes added always
 * balance, so the delimiter guard's verdict is the caller's text's.
 *
 * A query holding a {@link SEARCH_REFUSED_CHARACTER} is left as written: the
 * guard rejects it before any request, and the position its message names is
 * then exact in the caller's own text.
 *
 * One pass. The term match runs only where a term can start, never inside a
 * run it already read, so the cost is linear in the length of the query.
 */
function quoteHyphenatedTerms(search: string): string {
  if (!search.includes('-') || SEARCH_REFUSED_CHARACTER.test(search)) return search;
  let out = '';
  let copiedTo = 0;
  let context: TermContext = 'normal';
  let escapedAt = -1;

  for (let i = 0; i < search.length; i += 1) {
    const char = search[i];
    if (char === '\\') {
      i += 1; // The escaped character is literal — never a boundary or a delimiter.
      escapedAt = i;
      continue;
    }
    if (context !== 'normal') {
      if (
        (context === 'phrase' && char === '"') ||
        (context === 'range' && (char === ']' || char === '}')) ||
        (context === 'regexp' && char === '/')
      ) {
        context = 'normal';
      }
      continue;
    }
    if (char === '"') context = 'phrase';
    else if (char === '[' || char === '{') context = 'range';
    else if (char === '/') context = 'regexp';
    else {
      const prevLiteral = escapedAt === i - 1;
      const afterField = !prevLiteral && search[i - 1] === ':';
      const bounded = i === 0 || (!prevLiteral && TERM_BOUNDARY.test(search[i - 1] ?? ''));
      if (!afterField && !bounded) continue;

      const start = bounded && (char === '-' || char === '+') ? i + 1 : i;
      HYPHENATED_TERM.lastIndex = start;
      const term = HYPHENATED_TERM.exec(search)?.[0];
      if (term === undefined) continue;
      const end = start + term.length;
      // A matched run holds no delimiter or boundary, so the scan resumes after it either way.
      if (end === search.length || TERM_BOUNDARY.test(search[end] ?? '')) {
        out += `${search.slice(copiedTo, start)}"${term}"`;
        copiedTo = end;
      }
      i = end - 1;
    }
  }
  return out + search.slice(copiedTo);
}

/**
 * The shared caller-supplied `search` input: {@link nonBlankString}, then, in
 * order, each {@link SEARCH_WHITESPACE} character read as one space (inside a
 * phrase and after a backslash too, so no position shifts), the URL-form `+`
 * normalization of {@link normalizeSearchSeparators}, and the quoting of
 * {@link quoteHyphenatedTerms}, which needs the separators already spaced.
 * Applied with `.overwrite()` inside the schema — as `sortExpression` in
 * `schema-utils.ts` normalizes sort directions — so the handler, the delimiter
 * guard, the staged path, the mirror gate, and the echoed query all receive the
 * string openFDA is sent.
 *
 * Wiring: replace a tool's `search: nonBlankString()` with
 * `search: searchExpression()`, keeping its `.optional()` and `.describe(...)`
 * chain. The advertised JSON Schema is unchanged (`minLength: 1` and the
 * non-blank `pattern`), and no value that parsed before is rejected: the rewrite
 * runs after both checks, turns only whitespace and `+` into spaces, and only
 * adds quotes, so a non-whitespace character survives and the result is never
 * blank. For the caller's own `search` only — a server-composed query
 * (`openfda_drug_profile`) puts a drug name inside a phrase, where a `+` is data.
 */
export function searchExpression() {
  return nonBlankString().overwrite((search) =>
    quoteHyphenatedTerms(normalizeSearchSeparators(search.replace(EVERY_WHITESPACE, ' '))),
  );
}

/**
 * The empty-result hint for a search whose quoted phrase holds a `+`, or
 * `undefined` when there is nothing to say.
 *
 * {@link searchExpression} never rewrites inside a phrase, because a phrase `+`
 * can be real data (`brand_name.exact:"Bausch + Lomb"`). So a URL-style
 * `reactionmeddrapt.exact:"INJECTION+SITE+PAIN"` is sent as a literal-plus value
 * and matches nothing where the spaced phrase matches. The hint names the first
 * such phrase and its spaced form, so the caller can tell which one it meant,
 * each quoted as a {@link codeLiteral} since the hint lands on a notice.
 *
 * Wiring: pass the parsed `input.search` (already normalized) and the result's
 * `total`, and append the returned text to the tool's empty-result notice. It
 * returns text only when `total` is 0 — a page past the end of a matched set is
 * not a miss — and only for an unescaped `+` inside a quoted phrase; a `\+` was
 * written as a literal on purpose.
 */
export function phrasePlusHint(search: string | undefined, total: number): string | undefined {
  if (search === undefined || total > 0) return;
  const phrase = firstPhraseWithPlus(search);
  if (phrase === undefined) return;
  return `A "+" inside a quoted phrase is a literal plus sign, not a space, so ${codeLiteral(`"${phrase.text}"`)} can match only values spelled with one. If its words are meant to be separate, write them with spaces: ${codeLiteral(`"${phrase.spaced}"`)}.`;
}

/**
 * The body of the first quoted phrase holding an unescaped `+`, as written and
 * with each such `+` turned to a space. Same context rules as
 * {@link findSearchDelimiterFault}: a backslash escapes the next character, and
 * an unterminated phrase still counts — the delimiter guard rejects that query
 * before any result exists, so it never reaches a notice.
 */
function firstPhraseWithPlus(search: string): { spaced: string; text: string } | undefined {
  let phraseStart = -1;
  let spaced = '';
  let hasPlus = false;

  for (let i = 0; i < search.length; i += 1) {
    const char = search[i] ?? '';
    if (phraseStart === -1) {
      if (char === '\\') i += 1;
      else if (char === '"') {
        phraseStart = i + 1;
        spaced = '';
        hasPlus = false;
      }
      continue;
    }
    if (char === '\\') {
      spaced += search.slice(i, i + 2);
      i += 1;
    } else if (char === '"') {
      if (hasPlus) return { text: search.slice(phraseStart, i), spaced };
      phraseStart = -1;
    } else if (char === '+') {
      spaced += ' ';
      hasPlus = true;
    } else spaced += char;
  }
  return phraseStart !== -1 && hasPlus ? { text: search.slice(phraseStart), spaced } : undefined;
}

/**
 * @fileoverview Shared Zod building blocks for tool input schemas, plus the
 * handler guards that reject locally-detectable bad input before an upstream
 * request is spent: the openFDA pagination ceiling, and the `search` delimiter
 * balance check. Also holds the `sort` grammar and the `fields` path grammar,
 * which are regex-expressible and therefore ride the advertised JSON Schema
 * `pattern`, and the paginated tools'
 * shared `meta.totalUnverified` output field.
 * @module mcp-server/tools/schema-utils
 */

import { type TypedFail, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * A free-text input that must carry at least one non-whitespace character.
 * `minLength` alone lets `"   "` through: the URL builder drops a falsy
 * parameter and openFDA reads a whitespace-only one as match-all, so either way
 * a targeted lookup silently becomes an unfiltered browse over the whole corpus.
 * Both constraints are advertised in the tool's JSON Schema (`minLength` +
 * `pattern`), so a client sees the rule before it calls rather than only in the
 * rejection.
 *
 * Chain `.optional()` for an input where omission is a legitimate mode (an
 * unfiltered browse, an unsorted result, a fresh canvas). The wrapper leaves the
 * property out of `required` while keeping `minLength`/`pattern` on it, so an
 * absent value stays valid and a supplied blank one does not.
 */
export function nonBlankString() {
  return z.string().min(1).regex(/\S/, 'Must not be empty or whitespace-only.');
}

/**
 * openFDA's hard pagination ceiling — `skip` may not exceed this.
 *
 * Deliberately **not** a schema `.max()`. A schema maximum makes an over-ceiling
 * request fail as a generic input-validation error, which carries no
 * `structuredContent.error.data.reason` and none of the declared
 * `pagination_limit_reached` recovery text — the contract every paginated tool
 * advertises would then be unreachable. Handlers compare against this constant
 * and raise the typed reason instead, so both response paths carry it.
 */
export const OPENFDA_MAX_SKIP = 25_000;

/** Shared `skip` description — states the ceiling the handlers enforce. */
export const SKIP_DESCRIPTION = `Number of records to skip for pagination (default 0). openFDA caps pagination at ${OPENFDA_MAX_SKIP} records; a higher value returns a pagination_limit_reached error.`;

/**
 * The slice of a handler's `ctx` this guard needs. Structural, so any tool whose
 * contract declares `pagination_limit_reached` satisfies it — a `fail` accepting
 * the tool's wider reason union is assignable to one accepting just this reason.
 */
type PaginationCeilingContext = {
  fail: TypedFail<'pagination_limit_reached'>;
};

/**
 * Reject an over-ceiling `skip` with the declared typed reason, before any
 * upstream request is spent on a page openFDA would refuse. Called first in
 * every paginated handler; see `OPENFDA_MAX_SKIP` for why the bound is not a
 * schema `.max()`.
 */
export function assertSkipWithinCeiling(skip: number, ctx: PaginationCeilingContext): void {
  if (skip > OPENFDA_MAX_SKIP) {
    throw ctx.fail(
      'pagination_limit_reached',
      `skip=${skip} exceeds openFDA's ${OPENFDA_MAX_SKIP}-record pagination ceiling.`,
    );
  }
}

/* --- field paths: sort grammar and field selection --- */

/**
 * A sort direction the schema accepts: `asc`, `desc`, `ascending`, or
 * `descending`, in any letter case — spelled with character classes because the
 * advertised JSON Schema `pattern` carries no flags.
 *
 * openFDA honours only a lowercase `asc` or `desc`. Every other direction token
 * — `DESC`, `Desc`, `ascending`, `"desc"`, an empty one — answers HTTP 200 with
 * that sort key silently dropped, on every sortable endpoint: a single-key sort
 * returns the unsorted order, and a multi-field sort loses the key. So the four
 * spellings whose meaning is certain are accepted and rewritten by
 * {@link normalizeSortDirections}, and anything else is rejected.
 */
const SORT_DIRECTION =
  '(?:[Aa][Ss][Cc](?:[Ee][Nn][Dd][Ii][Nn][Gg])?|[Dd][Ee][Ss][Cc](?:[Ee][Nn][Dd][Ii][Nn][Gg])?)';

/**
 * The `sort` grammar, as a single JSON Schema `pattern` so a client sees the
 * shape before it calls: one or more comma-separated segments, each a dotted
 * field path (letters, digits, underscores, and dots, with no leading, trailing,
 * or doubled dot) optionally followed by `:` and a {@link SORT_DIRECTION}, with
 * spaces allowed around a segment and any whitespace around the whole value.
 * Equivalent to `^\s*SEG(?: *, *SEG)*\s*$`, `SEG` being `path(?::direction)?`.
 *
 * It is written as one character-class run plus lookaheads, never as a repeated
 * segment group: on a long run of segments with no valid end, JavaScriptCore's
 * backtracking cost on the repeated-group form grows several-hundredfold between
 * 5,000 and 320,000 characters, and this pattern runs over caller-supplied text.
 * After the leading whitespace, the lookaheads rule out, in order: a
 * first segment opening on `,`, `:`, or `.`; a comma followed by an empty
 * segment, a colon, or a dot; a space anywhere but beside a comma or in the
 * trailing whitespace; a dot not followed by a path character; and a colon not
 * followed by exactly one direction and the end of its segment — which is what
 * rejects `report_date:desc:asc`, whose field path openFDA reads as
 * `report_date:desc`.
 *
 * Multi-field sort is real (`report_date:desc,status.exact:asc` returns 200), and
 * an empty segment from a leading, trailing, or doubled comma is not (openFDA
 * answers a `query_shard_exception` for the empty field path). openFDA trims the
 * whole value of any whitespace — tabs, line breaks, and no-break spaces
 * included, exactly the set `\s` matches — and then the spaces around each
 * segment, and honours the sort: `classification.exact:desc, report_date:asc`
 * returns the same ordering as the space-free form, and so do
 * `  report_date:asc  ` and `report_date:asc\t`. Inside the value only spaces
 * beside a comma are trimmed: any other whitespace there answers 400, and a space
 * *inside* a segment is not trimmed, so `report_date :asc` stays rejected here as
 * openFDA rejects it (`query_shard_exception` for `report_date `).
 *
 * The field path is shape-only. A well-formed path naming a field that does not
 * exist or is analyzed still needs the upstream request to arbitrate — openFDA
 * answers those with a 400 that names the field, which the `query_error` contract
 * surfaces as-is.
 */
export const SORT_EXPRESSION_PATTERN = new RegExp(
  [
    String.raw`^\s*(?=\S)`,
    '(?![,:.])',
    String.raw`(?!.*,(?: *[,:.]|\s*$))`,
    String.raw`(?!.*[^\s,] +[^\s,])`,
    String.raw`(?!.*\.(?:[.:,\s]|$))`,
    String.raw`(?!.*:(?!${SORT_DIRECTION}(?: *,|\s*$)))`,
    String.raw`[A-Za-z0-9_.:, ]*[A-Za-z0-9_]\s*$`,
  ].join(''),
);

/**
 * Rewrite every direction in an accepted `sort` to the lowercase `asc` or `desc`
 * openFDA honours — `ASC` and `ascending` to `asc`, `Desc` and `DESCENDING` to
 * `desc` — leaving field paths and whitespace as sent. A value already in that
 * form passes through unchanged.
 */
function normalizeSortDirections(sort: string): string {
  return sort.replace(
    /:(asc|desc)(?:ending)?(?= *,|\s*$)/gi,
    (_match, direction: string) => `:${direction.toLowerCase()}`,
  );
}

/**
 * A `sort` input constrained to the grammar openFDA honours, with each direction
 * normalized after the pattern accepts it — inside the schema, so every handler
 * and the staged path receive the lowercase form. Chain `.optional()` where an
 * unsorted result set is a legitimate mode. Supersedes {@link nonBlankString} on
 * this input: the anchored pattern already excludes blank and whitespace-only
 * values, and `minLength` stays advertised alongside it.
 */
export function sortExpression() {
  return z
    .string()
    .min(1)
    .regex(
      SORT_EXPRESSION_PATTERN,
      'Must be one or more comma-separated field paths, each optionally suffixed with :asc or :desc (any letter case; ascending and descending are also accepted) — e.g. "report_date:desc" or "report_date:desc,status.exact:asc". A field path may contain only letters, digits, underscores, and dots, and any other direction is rejected.',
    )
    .overwrite(normalizeSortDirections);
}

/**
 * A `fields` input: dotted record paths the search tools project each inline
 * record to. Chain `.optional()` — whole records are the default — and describe
 * with {@link fieldsDescription}.
 *
 * Each path carries the advertised `pattern`, so a malformed entry is rejected at
 * argument validation, before any upstream request. openFDA has no field
 * selection of its own (an unknown query parameter answers HTTP 400), so the
 * projection runs server-side on the fetched page.
 *
 * No `.max()`, on the list or on a path: the list shapes output only, and a
 * longer one costs nothing a shorter one does not — a path matching no record
 * key is named on the response notice rather than rejected. An empty list is the
 * same as omitting the input, since form-based clients send `[]` for an unset
 * array.
 */
export function fieldSelection() {
  return z.array(
    z
      .string()
      .regex(
        FIELD_PATH_PATTERN,
        'Each field must be a dotted record path of letters, digits, underscores, and dots — e.g. "patient.drug.medicinalproduct".',
      ),
  );
}

/**
 * One dotted field path — runs of `[A-Za-z0-9_]` joined by `.`, the shape of
 * every path in `field-catalog.ts` (`.exact` subfields included) and of every key
 * path on an openFDA record — anchored, in a form whose cost stays linear on
 * Bun's engine: one character-class run plus three lookaheads ruling out a
 * leading, doubled, or trailing dot. The nested-quantifier form matches the same strings,
 * but on a long run of `a.a.a.` with no valid end JavaScriptCore's backtracking
 * cost jumps roughly sixtyfold between 80,000 and 320,000 characters, and this
 * pattern runs over caller-supplied text. No flags, since the advertised JSON
 * Schema `pattern` carries none: `.` stopping at a line break changes nothing,
 * because the class already rejects one.
 */
const FIELD_PATH_PATTERN = /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.]+$/;

/**
 * `fields` description, naming the identity keys every projected record keeps so
 * a caller can tell its records apart without asking for them, and an example of
 * paths the tool's own records carry — a caller copies the example.
 */
export function fieldsDescription(
  identityKeys: readonly string[],
  example: readonly string[],
): string {
  return `Dotted record paths to keep on each returned record, e.g. [${example.map((path) => `"${path}"`).join(', ')}] — any key path on a returned record works, and openfda_describe_fields lists the searchable ones. Each record is projected to these paths plus its identity key (${identityKeys.join(', ')}) before the inline byte budget is measured, identically on both response surfaces, and a path through an array applies to every element. Use it when records are large: a page_bytes over the budget comes with the largest fields of the oversized record. A path no returned record carries is named on the notice. Omit for whole records. Paths take only letters, digits, underscores, and dots; anything else is rejected before the request. With stage=true, only the inline page is projected — the staged table keeps its columns.`;
}

/* --- search delimiter balance --- */

/**
 * Shared `search` description clause — states the delimiter rule
 * {@link assertSearchDelimitersBalanced} enforces, so every tool advertises it in
 * the same words. Append it to the tool's own `search` prose.
 */
export const SEARCH_BALANCE_NOTE =
  'Double quotes, parentheses, and range brackets must balance, and the query must not end on a backslash — each is rejected before the request.';

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
 * Field names, boolean structure, wildcards, `+`/`-` prefixes, and the `^`/`~`
 * operators openFDA refuses by name are all left to openFDA to arbitrate.
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
  when: 'The search query leaves a double quote, parenthesis, or range bracket unclosed, or ends on a backslash.',
  recovery:
    'Close the unterminated quote, group, or range, and write a literal " ( ) [ ] or backslash escaped with a backslash.',
  thrownBy: 'service',
} as const;

/** The slice of a handler's `ctx` {@link assertSearchDelimitersBalanced} needs. */
type MalformedSearchContext = {
  fail: TypedFail<'malformed_search'>;
};

/**
 * Reject a `search` query whose delimiters cannot parse, before the request is
 * spent. openFDA answers most of these with a `token_mgr_error` or
 * `parse_exception` whose column index runs past the submitted string and whose
 * echoed tail repeats clauses the caller never sent, so the actual defect is
 * never named.
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
 * {@link OPENFDA_MAX_SKIP} documents: a schema rejection carries no
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
  const fault = findSearchDelimiterFault(search);
  if (!fault) return;
  throw ctx.fail('malformed_search', SEARCH_FAULT_MESSAGE[fault]);
}

/**
 * Shared `meta.totalUnverified` output field for the paginated search tools.
 * The service sets it when an empty page at `skip > 0` could not have its total
 * recovered (see `OpenFdaMeta.totalUnverified`); `format()` reads it to keep the
 * no-match-or-past-the-end wording on `content[]`.
 */
export const totalUnverifiedField = z
  .boolean()
  .optional()
  .describe(
    'Present (true) only on an empty page at skip > 0 whose total could not be confirmed: openFDA answers a page past the end and a search that matched nothing alike, and the follow-up request for the total failed. total then reads 0 without ruling out records at a lower skip — re-call with skip=0 to tell.',
  );

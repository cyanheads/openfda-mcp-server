/**
 * @fileoverview Shared Zod building blocks for tool input schemas, plus the
 * handler guard that rejects a `skip` past openFDA's pagination ceiling before an
 * upstream request is spent, and its shared contract entry. Holds the non-blank
 * free-text input, the per-endpoint page size every paged tool's `limit`
 * resolves through (default, cap, and the clamp or strict rejection above it),
 * the `sort` grammar and the `fields` path grammar, which are regex-expressible
 * and therefore ride the advertised JSON Schema `pattern`, with the shared
 * descriptions of `skip`, `sort`, and `fields`, and the paginated tools' shared
 * `meta` output and search-tool `notice` field. The shared `search` input and
 * its delimiter guard live in `search-expression.ts`, and the `cursor` that
 * reads past the `skip` ceiling in `pagination-cursor.ts`.
 *
 * Every shared description here is the one source of its rule: a client
 * loads each tool's descriptions before its first call, so a rule the server
 * enforces with a local rejection, a schema `pattern`, or automatic
 * normalization is left to that mechanism, and what stays is the guidance that
 * prevents a silent wrong answer.
 * @module mcp-server/tools/schema-utils
 */

import { type Context, type TypedFail, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { OpenFdaResponse } from '@/services/openfda/types.js';

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

/**
 * Shared `skip` description — states the ceiling the handlers enforce and the
 * route past it, which starts at `skip: 0`: openFDA links a `search_after` page
 * only from there, so no cursor continues a page read at a later `skip`. The
 * default rides the schema, and the typed rejection names itself.
 */
export const SKIP_DESCRIPTION = `Records to skip, at most ${OPENFDA_MAX_SKIP}; to read past that, follow next_cursor from skip 0.`;

/**
 * How to read past the `skip` ceiling, worded once for the contract entry, the
 * clamp notice, and `openfda_get_drug_label`'s page lead.
 */
export const PAST_CEILING_ROUTE =
  're-run the call from skip 0 and follow next_cursor, or narrow the search';

/**
 * The `errors[]` entry every paginated tool declares for a `skip` past the
 * ceiling. Raised by {@link assertSkipWithinCeiling} through the handler's typed
 * `ctx.fail`, below the handler body, hence `thrownBy: 'service'`.
 */
export const paginationLimitReachedError = {
  reason: 'pagination_limit_reached',
  code: JsonRpcErrorCode.ValidationError,
  when: `skip exceeds the ${OPENFDA_MAX_SKIP} record pagination ceiling.`,
  recovery: `To read past skip ${OPENFDA_MAX_SKIP}, ${PAST_CEILING_ROUTE}.`,
  thrownBy: 'service',
} as const;

/** The `errors[]` entry for openFDA answering 429, raised by the service below the handler. */
export const rateLimitedError = {
  reason: 'rate_limited',
  code: JsonRpcErrorCode.RateLimited,
  when: 'The openFDA daily or per-minute request limit is exceeded.',
  retryable: true,
  recovery:
    'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
  thrownBy: 'service',
} as const;

/**
 * The `errors[]` entry for openFDA answering 5xx, or 200 with a body that is not
 * its JSON (a proxy's page, a body cut short), raised by the service below the
 * handler.
 */
export const upstreamError = {
  reason: 'upstream_error',
  code: JsonRpcErrorCode.ServiceUnavailable,
  when: 'The openFDA API returned a 5xx error, or a 200 that is not openFDA JSON.',
  retryable: true,
  recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
  thrownBy: 'service',
} as const;

/**
 * The `errors[]` entry every tool taking `sort` declares for a sort key openFDA
 * cannot sort on, raised by the service below the handler from openFDA's own
 * refusal.
 */
export const notSortableError = {
  reason: 'not_sortable',
  code: JsonRpcErrorCode.ValidationError,
  when: 'openFDA refused a key in sort: analyzed text, an .exact form the field lacks, a field with no sortable form, or one the endpoint lacks.',
  recovery:
    'Sort on the field’s other form (add or drop .exact) or on another field; a field that fails both ways cannot be sorted.',
  thrownBy: 'service',
} as const;

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

/* --- page size: per-endpoint default and cap --- */

/**
 * `limit`'s default and cap per openFDA endpoint a tool pages, plus `count`, the
 * term list `openfda_count_values` returns on every endpoint. `limit` is the page
 * size — a page holds `limit` records, fewer only at the end of the match — so
 * the cap is what bounds a response, and it is set per endpoint because record
 * size spans three orders of magnitude across them.
 *
 * Measured 2026-11-10 through each tool's `format()`, as `structuredContent`
 * UTF-8 bytes on 2–10 windows per endpoint: a cap is the median record count
 * that serializes to about 1 MB, rounded down to a multiple of 25, or openFDA's
 * own 1000-record page maximum where a full page is at most 1.27 MB.
 * `drug/event`'s 25 sits between its product-search (~18) and all-window (~50)
 * medians. A default stays well under its cap: 25 for short records, 10 or fewer
 * for heavy ones, 5 for drug reports and labels.
 *
 * A byte budget on each page was rejected: it overrides an explicit `limit` with
 * a record count the caller cannot predict, and continuation stops being
 * `skip + limit`.
 */
export const PAGE_SIZES = {
  'drug/event': { default: 5, cap: 25 },
  'food/event': { default: 25, cap: 1000 },
  'device/event': { default: 10, cap: 175 },
  'cosmetic/event': { default: 25, cap: 1000 },
  'drug/enforcement': { default: 25, cap: 1000 },
  'food/enforcement': { default: 25, cap: 1000 },
  'device/enforcement': { default: 10, cap: 125 },
  'device/recall': { default: 10, cap: 50 },
  'drug/drugsfda': { default: 25, cap: 375 },
  'drug/orangebook': { default: 25, cap: 1000 },
  'transparency/crl': { default: 5, cap: 75 },
  'device/510k': { default: 10, cap: 175 },
  'device/pma': { default: 25, cap: 575 },
  'device/classification': { default: 25, cap: 600 },
  'animalandveterinary/event': { default: 25, cap: 450 },
  'drug/shortages': { default: 25, cap: 1000 },
  'tobacco/problem': { default: 25, cap: 1000 },
  'drug/ndc': { default: 25, cap: 1000 },
  'other/nsde': { default: 25, cap: 1000 },
  'drug/label': { default: 5, cap: 1000 },
  count: { default: 100, cap: 1000 },
} as const satisfies Record<string, { cap: number; default: number }>;

/** An endpoint a tool pages, or `count` for the count term list. */
export type PageKind = keyof typeof PAGE_SIZES;

/** One increment per call whose `limit` exceeded its endpoint cap and was clamped to it. */
const limitClamps = createCounter(
  'openfda.limit.clamped',
  'Calls whose limit exceeded the endpoint cap and was clamped to it',
  '{calls}',
);

/**
 * The integer `limit` schema both page-limit inputs build on. With
 * `OPENFDA_CLAMP_LIMITS` on (the default) it advertises no `maximum`, since the
 * handler clamps any larger value; off, it advertises `maximum` and rejects a
 * larger value at argument validation. Both read the config when they run, so
 * the advertised schema and the parse always agree. `.int()` alone would
 * advertise `Number.MAX_SAFE_INTEGER`, which the `maximum` getter replaces.
 */
function limitSchema(maximum: number, describe: (strict: boolean) => string) {
  const strict = () => !getServerConfig().clampLimits;
  return z
    .number()
    .int()
    .min(1)
    .check((payload) => {
      if (payload.value > maximum && strict()) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .meta({
      get maximum() {
        return strict() ? maximum : undefined;
      },
      get description() {
        return describe(strict());
      },
    });
}

/**
 * `limit` for a tool that pages one endpoint, or the count term list: an integer
 * from 1, defaulting to that endpoint's default. `lead` opens the description;
 * the default and the cap close it, worded for the configured mode.
 */
export function pageLimit(kind: PageKind, lead: string) {
  const { default: fallback, cap } = PAGE_SIZES[kind];
  return limitSchema(
    cap,
    (strict) =>
      `${lead} Default ${fallback}${strict ? `, at most ${cap}.` : `; a larger value returns at most ${cap} and says so.`}`,
  ).default(fallback);
}

/**
 * `limit` for a tool whose endpoint follows another input (`category`,
 * `endpoint`, `pathway`): optional with no schema default, since the default is
 * the selected endpoint's, which {@link resolvePageSize} applies. Advertises its
 * largest cap as the strict-mode `maximum`; a value under that but over the
 * selected endpoint's cap is rejected by {@link resolvePageSize} with the typed
 * {@link limitAboveCapError}. `choices` pairs each label the description lists
 * with its endpoint.
 */
export function pageLimitBy(
  selector: string,
  choices: readonly (readonly [label: string, kind: PageKind])[],
  lead: string,
) {
  const sizes = choices
    .map(([label, kind]) => `${label} ${PAGE_SIZES[kind].default} (cap ${PAGE_SIZES[kind].cap})`)
    .join(', ');
  const maximum = Math.max(...choices.map(([, kind]) => PAGE_SIZES[kind].cap));
  return limitSchema(
    maximum,
    (strict) =>
      `${lead} Default and cap by ${selector}: ${sizes}; ${strict ? 'a value above that cap is rejected.' : 'a larger value returns at most that cap and says so.'}`,
  ).optional();
}

/** The page size one call applies, resolved by {@link resolvePageSize}. */
export interface PageSize {
  /** Cap for this call's endpoint. */
  cap: number;
  /** The caller's limit — present only when it exceeded the cap and was clamped. */
  clampedFrom?: number | undefined;
  /** The endpoint, or `count`, the size was resolved for. */
  kind: PageKind;
  /** Page size applied: the caller's limit, the endpoint default, or the cap. */
  limit: number;
}

/**
 * Resolve the page size a call applies: the caller's `limit`, or the endpoint's
 * default when it was omitted. A value above the endpoint's cap is clamped to
 * the cap — one log line and one `openfda.limit.clamped` increment — or, with
 * `OPENFDA_CLAMP_LIMITS=false`, rejected as `limit_above_cap` before any
 * upstream request. Call it after the handler's other local guards and before
 * the first request; {@link pageSizeNotice} renders the clamp disclosure.
 */
export function resolvePageSize(
  requested: number | undefined,
  kind: PageKind,
  ctx: Pick<Context, 'log'>,
): PageSize {
  const { default: fallback, cap } = PAGE_SIZES[kind];
  const limit = requested ?? fallback;
  if (limit <= cap) return { cap, kind, limit };
  if (!getServerConfig().clampLimits) {
    throw validationError(`limit=${limit} exceeds the ${cap} cap for ${kind}.`, {
      reason: 'limit_above_cap',
      cap,
    });
  }
  ctx.log.info('Clamped limit to the endpoint cap', { endpoint: kind, requested: limit, cap });
  limitClamps.add(1, { 'openfda.endpoint': kind });
  return { cap, clampedFrom: limit, kind, limit: cap };
}

/**
 * The `errors[]` entry for a strict-mode `limit` above the selected endpoint's
 * cap. Declared only by the tools that pick their endpoint from another input:
 * a single-endpoint tool's strict schema `maximum` is its cap, so its handler
 * never sees a larger value. Raised by {@link resolvePageSize}, below the
 * handler body, hence `thrownBy: 'service'`.
 */
export const limitAboveCapError = {
  reason: 'limit_above_cap',
  code: JsonRpcErrorCode.ValidationError,
  when: 'limit exceeds the cap of the endpoint this call selects, on a deployment that rejects rather than clamps it.',
  recovery: 'Lower limit to the cap the message names, and page on with skip for the rest.',
  thrownBy: 'service',
} as const;

/**
 * The disclosure for a clamped `limit`, or `undefined` when none was clamped:
 * the requested value, the cap applied, and where the next page starts — or that
 * this page ends the match, or that the next page would pass openFDA's `skip`
 * ceiling, and how to read past it: the page's `next_cursor` when it carries
 * one, else a walk from `skip: 0` — except on a page whose next link openFDA
 * cannot follow (`searchAfterBlocked`), where that walk reaches the same link
 * and the blocked notice names the way on. `page` is the response the call
 * returns, its `meta.skip` the walk position on a page read by cursor; the count
 * term list has no `skip`, so it omits it.
 */
export function pageSizeNotice(
  size: PageSize,
  page?: {
    meta: { skip: number; total: number };
    next_cursor?: string | undefined;
    results: readonly unknown[];
    searchAfterBlocked?: OpenFdaResponse['searchAfterBlocked'];
  },
): string | undefined {
  if (size.clampedFrom === undefined) return;
  const unit = size.kind === 'count' ? 'term' : 'record';
  const scope = size.kind === 'count' ? 'a count' : size.kind;
  const head = `limit=${size.clampedFrom} is above the ${size.cap}-${unit} cap for ${scope}, so ${size.cap} was applied`;
  const returned = page?.results.length ?? 0;
  if (!page || returned === 0) return `${head}.`;
  const next = page.meta.skip + returned;
  if (next >= page.meta.total) {
    return `${head}; this page holds the last ${returned} of the ${page.meta.total} matched records.`;
  }
  if (next > OPENFDA_MAX_SKIP) {
    const past = `${head}. The next page would start at skip=${next}, past openFDA's ${OPENFDA_MAX_SKIP}-record pagination ceiling`;
    if (page.searchAfterBlocked) return `${past}.`;
    const route = page.next_cursor
      ? 'follow next_cursor to read it'
      : `to read past it, ${PAST_CEILING_ROUTE}`;
    return `${past} — ${route}.`;
  }
  return `${head}. The next page starts at skip=${next}.`;
}

/**
 * Shared `meta.limit` description for the paged search tools. The clamp is
 * disclosed on the notice; the short last page is not, so that sentence stays.
 */
const META_LIMIT_DESCRIPTION =
  'Page size applied: limit, the endpoint default, or the cap when limit exceeded it. The last page of a match holds fewer records.';

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
 * exist, is analyzed, or lacks the form given still needs the upstream request to
 * arbitrate — openFDA refuses those with a 400 or 5xx naming the field, which the
 * service raises as `not_sortable` with the form to try.
 */
const SORT_EXPRESSION_PATTERN = new RegExp(
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
 * `sort` description for a {@link sortExpression} input: the grammar, with
 * `example` when the tool gives one; the tool's newest-first default for a call
 * with neither `search` nor `sort` (`newest`, the sort `sortOrNewest` in
 * `default-sort.ts` sends), when it has one; and the order a search sent
 * without a sort comes back in. That last is openFDA's index order, not
 * relevance: the `search_after` value an unsorted page links to is a single
 * document-id key, and `brand_name:aspirin` on `drug/ndc` lists "Low Dose
 * Aspirin" before "Aspirin". The rejected-character and non-sortable-field
 * rules are left to the `pattern` and the `not_sortable` error that names the
 * field.
 * Append any further text the tool needs after it.
 */
export function sortDescription(options: { example?: string; newest?: string } = {}): string {
  const example = options.example ? `, e.g. ${options.example}` : '';
  const newest = options.newest
    ? ` With neither search nor sort, records come newest first by ${options.newest}.`
    : '';
  return `A field path with :asc or :desc (any letter case; :ascending and :descending also work), several comma-separated${example}.${newest} A search without sort returns openFDA's index order, not relevance.`;
}

/**
 * A `fields` input: dotted record paths the search tools project each inline
 * record to. Chain `.optional()` — omitted, a record comes back whole, less any
 * path its endpoint leaves out by default (`record-projection.ts`) — and describe
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
 * paths the tool's own records carry — a caller copies the example. It says
 * nothing of what omitting `fields` returns: on a tool with left-out paths
 * (`include` in `record-projection.ts`) that is not the whole record. A path no
 * record carries is named on the notice, and the path grammar rides the
 * `pattern`.
 */
export function fieldsDescription(
  identityKeys: readonly string[],
  example: readonly string[],
): string {
  return `Dotted record paths to keep on each record, e.g. [${example.map((path) => `"${path}"`).join(', ')}], plus its identity key (${identityKeys.join(', ')}). Any record path works (openfda_describe_fields lists searchable ones); a path through an array covers every element. Use it when page_bytes flags an oversized record; with stage=true only the inline page is projected.`;
}

/**
 * Shared `meta.totalUnverified` output field for the paginated search tools.
 * The service sets it when an empty page at `skip > 0` could not have its total
 * recovered (see `OpenFdaMeta.totalUnverified`); `format()` reads it to keep the
 * no-match-or-past-the-end wording on `content[]`.
 */
const totalUnverifiedField = z
  .boolean()
  .optional()
  .describe(
    'True on an empty page at skip > 0 whose total could not be confirmed: total 0 then does not rule out records — re-call with skip=0.',
  );

/**
 * The `meta` output every paged search tool returns — `total`, `skip`, `limit`
 * (the size {@link resolvePageSize} applied), `lastUpdated`, and
 * {@link totalUnverifiedField}. One schema for every such tool, so the field
 * texts have one source.
 */
export const pageMetaOutput = z
  .object({
    total: z.number().describe('Total matching records'),
    skip: z.number().describe('Pagination offset'),
    limit: z.number().describe(META_LIMIT_DESCRIPTION),
    lastUpdated: z.string().describe('Dataset last updated date'),
    totalUnverified: totalUnverifiedField,
  })
  .describe('Response metadata');

/** Notice topic for a page that ends a cursor walk, worded once for every paged tool's `notice`. */
export const CURSOR_END_NOTICE_TOPIC = 'end of a cursor walk';

/**
 * Notice topic for the staged SQL a search tool offers when AND-ed clauses on
 * one array of objects can be met by different entries (`search-clauses.ts`
 * writes the notice itself).
 */
export const CONJOINED_ARRAY_NOTICE_TOPIC = 'SQL for AND-ed clauses on one array entry';

/**
 * The `notice` enrichment field of a search tool that stages: one sentence
 * naming what the notice can carry — the topics every such tool shares, then
 * the tool's own `extra` topics ({@link CONJOINED_ARRAY_NOTICE_TOPIC},
 * `LEFT_OUT_NOTICE_TOPIC` in `record-projection.ts`, or its own words). The
 * notice states each at run time, so the description only names them.
 */
export function searchNoticeField(extra: readonly string[] = []) {
  return z
    .string()
    .optional()
    .describe(
      `Guidance for this page: empty result, limit clamp, ${CURSOR_END_NOTICE_TOPIC}, fields projection, oversized record, staging${extra.map((topic) => `, ${topic}`).join('')}. Absent when nothing needs saying.`,
    );
}

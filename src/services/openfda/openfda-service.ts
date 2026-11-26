/**
 * @fileoverview Generic openFDA API client with retry, rate-limit awareness, and error normalization.
 * @module services/openfda/openfda-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RetryOptions, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { type CountVerdict, countVerdict } from '@/mcp-server/tools/field-catalog.js';
import { OPENFDA_MAX_SKIP } from '@/mcp-server/tools/schema-utils.js';
import { decodeEntities } from './html-entities.js';
import { getMirror, planMirrorLookup, runMirrorLookup } from './mirror/index.js';
import type { OpenFdaMeta, OpenFdaQueryParams, OpenFdaResponse } from './types.js';

/** Timeout for one attempt, capped at whatever the call's deadline leaves. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Wall-clock budget for one `query()` call that names no deadline of its own —
 * every attempt, every backoff, and the side requests it makes. Four 15 s
 * attempts plus backoff run ~65–69 s, past the 60 s request timeout MCP SDK
 * clients default to, so the caller would see a transport timeout instead of
 * the classified error; 50 s leaves room for the tool's own work and the
 * transport around it. A tool that chains requests passes one `deadlineAtMs`
 * to all of them instead.
 */
export const OPENFDA_CALL_DEADLINE_MS = 50_000;

/** Per-call options for {@link OpenFdaService.query}. */
export interface OpenFdaQueryOptions {
  /**
   * Instant, in epoch milliseconds (the `Date.now()` scale), by which the call
   * settles. Expiry fails it as `Timeout` with `data.reason:
   * 'retry_deadline_exceeded'`; a cancel on the caller's signal stays a
   * cancellation. Defaults to {@link OPENFDA_CALL_DEADLINE_MS} after the call starts.
   */
  deadlineAtMs?: number;
}

/**
 * Retry budget for a side request issued from inside the primary request's retry
 * callback — the past-end total recovery and the `Nothing to count` confirm. One
 * attempt: the recovery is best-effort, so a retry only parks a backoff sleep
 * (≥750 ms at the 1 s base) on a call that would otherwise return at once; a
 * failed confirm propagates into the primary loop, which already retries the
 * whole exchange, so retrying it in place would multiply that budget. The side
 * request shares the primary call's deadline.
 */
const SIDE_REQUEST_RETRY = { maxRetries: 0 } as const satisfies RetryOptions;

/**
 * openFDA surfaces deterministic, user-fixable query failures as HTTP 5xx whose body
 * names the underlying Lucene/ES exception in `error.details`. Covered markers:
 *
 * - `token_mgr_error` / `lexical error` — the tokenizer rejected the search string
 *   (e.g. an unbalanced quote).
 * - `parse_exception` — the tokens are legal but the grammar is not: an unbalanced
 *   bracket or paren, a dangling `AND`/`OR`, a half-open range (`[20200101 TO]`),
 *   or a bare `_exists_:`.
 * - `illegal_argument_exception` — a `count` on a non-keyword text field, or a
 *   sort on one past the first key. A count query is answered by
 *   {@link OPENFDA_NOT_AGGREGATABLE_5XX} first and a refused sort key by
 *   `not_sortable` ({@link OPENFDA_FIELDDATA_FIELD}); the marker stays here to
 *   cover the same exception raised otherwise, such as a `search_after` that does
 *   not fit the sort.
 * - `query_shard_exception` — a field absent from that index's mapping. A sort
 *   key with no mapping (`receivedate:desc` on food/device, which lack the field)
 *   is answered by `not_sortable` first ({@link OPENFDA_SORT_NO_MAPPING}); the
 *   marker stays here for the rest.
 *
 * These never succeed on retry, so a 5xx carrying one is reclassified to a
 * non-retryable `query_error` — `ValidationError` sits outside `withRetry`'s
 * transient-code set, so the reclassification alone stops the retry loop.
 *
 * Keyed on the specific exception names only — NOT openFDA's generic "Check your request
 * and try again" message, which rides on every application-level SERVER_ERROR including
 * transient ES failures (circuit breaker, thread-pool rejection, recovering shards).
 * A 5xx with no specific marker — generic message, transient ES exception, or a
 * gateway/HTML outage page — stays a retryable `upstream_error`. The markers sit at the
 * head of `error.details`, inside the ~500-byte body `fetchWithTimeout` captures, so
 * truncation never hides them.
 */
const OPENFDA_QUERY_ERROR_5XX =
  /token_mgr_error|lexical error|parse_exception|illegal_argument_exception|query_shard_exception/i;

/**
 * openFDA answers a count query with two distinguishable 404s: `No matches found!`
 * (the field aggregates fine, the filter matched nothing) and `Nothing to count`
 * (the field expression is not aggregatable as written — commonly `.exact` on a
 * field openFDA already indexes as keyword-only). Only the first is an empty tally
 * by default; the second is a fixable query error and must not be collapsed into
 * one — except that openFDA also answers `Nothing to count` for a countable field
 * when the search matched only records carrying no value for it, which
 * `resolveNothingToCount` separates out.
 */
const OPENFDA_NOTHING_TO_COUNT = /nothing to count/i;

/** The title of an HTML page, matched within {@link HTML_TITLE_SCAN_CHARS} of its start. */
const HTML_TITLE = /<title[^>]*>([^<]*)<\/title>/i;

/**
 * Leading characters of an HTML page searched for its title. A proxy's error
 * page names itself in its head; an error body is captured at a few hundred
 * bytes anyway, while a page served as 200 arrives whole.
 */
const HTML_TITLE_SCAN_CHARS = 2_048;

/** Whether a body is an HTML page — a proxy's, never openFDA's own answer. */
function isHtml(body: string): boolean {
  return /^\s*</.test(body.slice(0, HTML_TITLE_SCAN_CHARS));
}

/** An HTML page's title, or `undefined` when its head names none. */
function htmlTitle(page: string): string | undefined {
  return HTML_TITLE.exec(page.slice(0, HTML_TITLE_SCAN_CHARS))?.[1]?.trim() || undefined;
}

/** Whether a parsed JSON value is an object — not an array, not null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The body of every 200 openFDA answers: a search page, whose `meta.results`
 * holds its skip, limit, and total (its `results` empty at `limit=0`), or a
 * count tally, which has no `meta.results`. Records are checked to be objects
 * and passed on as parsed: a page holds up to 1,000, and copying each one
 * would add a pass over every key.
 */
const OPENFDA_ENVELOPE = z.object({
  meta: z.object({
    last_updated: z.string().optional(),
    results: z.object({ skip: z.number(), limit: z.number(), total: z.number() }).optional(),
  }),
  results: z.array(z.custom<Record<string, unknown>>(isRecord)),
});

type OpenFdaEnvelope = z.infer<typeof OPENFDA_ENVELOPE>;

/**
 * The envelope of a 200 body. A body that is not JSON, or JSON off the
 * envelope, fails as `upstream_error`, retried as a marker-free 5xx is: a
 * proxy's page served as 200 is the outage its 5xx page is, and a body cut
 * short is a transport fault. The message names the endpoint, the status, and
 * an HTML page's title — never the body.
 */
function parseEnvelope(text: string, endpoint: string): OpenFdaEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw unusableSuccess(endpoint, unparsedBody(text));
  }
  const envelope = OPENFDA_ENVELOPE.safeParse(json);
  if (!envelope.success) throw unusableSuccess(endpoint, 'JSON that is not an openFDA response');
  return envelope.data;
}

/** What a 200 body that is not JSON holds, in words that quote none of it but a page title. */
function unparsedBody(text: string): string {
  if (isHtml(text)) {
    const title = htmlTitle(text);
    return title
      ? `an HTML page titled "${title}" instead of JSON`
      : 'an HTML page instead of JSON';
  }
  return /\S/.test(text) ? 'a body that is not valid JSON' : 'an empty body instead of JSON';
}

function unusableSuccess(endpoint: string, body: string): McpError {
  return serviceUnavailable(`openFDA upstream error: ${endpoint} answered HTTP 200 with ${body}.`, {
    reason: 'upstream_error',
    endpoint,
    status: 200,
  });
}

/**
 * openFDA's 400 for a first sort key it will not sort by as written: analyzed
 * text, a number or boolean, an object path, a reserved name, or a field the
 * index lacks. Anchored at the start of the decoded message, which names the
 * key as sent.
 */
const OPENFDA_SORT_NON_ANALYZED = /^Sorting allowed by non-analyzed fields only: ([\w.]+)/;

/**
 * openFDA's 5xx `query_shard_exception` for a sort key with no mapping on the
 * index: an `.exact` form the field lacks, another endpoint's field, or a later
 * key that is absent or an object path.
 */
const OPENFDA_SORT_NO_MAPPING = /No mapping found for \[([\w.]+)\] in order to sort on/;

/**
 * The field Elasticsearch names in its `illegal_argument_exception` for sorting
 * or aggregating analyzed text. openFDA raises it, as a 5xx, for a sort on
 * analyzed text past the first key; a first key draws
 * {@link OPENFDA_SORT_NON_ANALYZED} instead.
 */
const OPENFDA_FIELDDATA_FIELD = /fielddata=true on \[([\w.]+)\]/;

/** How openFDA refused a sort key, which decides the correction `not_sortable` offers. */
type SortRefusal = 'non_analyzed' | 'analyzed_text' | 'no_mapping';

/**
 * The field an openFDA sort refusal names, when it is one of the request's own
 * sort keys — the only field the refusal can be about, so the error echoes the
 * caller's key and no other upstream text.
 */
function refusedSortKey(
  sort: string | undefined,
  refusal: RegExpExecArray | null,
): string | undefined {
  const field = refusal?.[1];
  if (sort === undefined || field === undefined) return undefined;
  return sortKeys(sort).includes(field) ? field : undefined;
}

/** The keys of a `sort` expression in order, as sent: `.exact` kept, the direction dropped. */
function sortKeys(sort: string): string[] {
  return sort.split(',').map((key) => {
    const colon = key.indexOf(':');
    return (colon === -1 ? key : key.slice(0, colon)).trim();
  });
}

/**
 * The fields of an openFDA error body the classifier reads. A body off this
 * shape — a field of another type, a bare `error` string, JSON that is no
 * object — contributes its raw text instead. A null field reads as absent.
 */
const OPENFDA_ERROR_BODY = z.object({
  error: z.object({ message: z.string().nullish(), details: z.string().nullish() }),
});

/**
 * openFDA's marker for aggregating an analyzed text field: Elasticsearch refuses
 * to build fielddata for it and answers HTTP 5xx with
 * `illegal_argument_exception`. On a `count` query that is the `.exact`-missing
 * case, not a syntax error — the field name is already correct — so it routes to
 * `not_aggregatable` naming `<field>.exact` instead of the generic `query_error`.
 * The advice that survives in the upstream text (`fielddata=true`) is a
 * server-side index setting no MCP caller can reach, so it is dropped.
 */
const OPENFDA_NOT_AGGREGATABLE_5XX = /illegal_argument_exception/i;

/** Countable expressions a no-countable-form `not_aggregatable` lists before truncating. */
const MAX_ALTERNATIVES = 8;

/**
 * openFDA's 400 message for a `skip` above its ceiling (`Skip value must 25000
 * or less.`). Anchored at the start of the message: a refused search echoes the
 * caller's query in its message, and a `25000` inside it is not this failure.
 */
const OPENFDA_SKIP_CEILING = /^skip value must 25000\b/i;

/** One link-value of a `Link` header (RFC 8288): its `<target>`, then its parameters. */
const LINK_VALUE = /<([^<>]*)>([^<,]*)/g;

/**
 * The `search_after` parameter of the `rel="next"` target in an openFDA `Link`
 * header, or `undefined` when there is no header, no next link, or a next link
 * without one — from a page read at `skip > 0` openFDA links by `skip` instead.
 * An empty value is no continuation (openFDA reads it as the first page). The
 * target URL echoes the request and goes no further than this function.
 */
export function searchAfterOfNextLink(header: string | null): string | undefined {
  for (const [, target = '', params = ''] of header?.matchAll(LINK_VALUE) ?? []) {
    if (namesNextRel(params)) {
      return URL.parse(target)?.searchParams.get('search_after') || undefined;
    }
  }
  return undefined;
}

/**
 * A sort key's value in openFDA's `search_after` for a record that lacks the
 * field: Long.MIN or Long.MAX printed through a double (`±9223372036854776000`)
 * on a date sort, the exact longs matched too. A keyword sort writes the empty
 * value, which a record holding "" writes as well (see {@link continuationOf}).
 */
const MISSING_SORT_VALUE = /^-?92233720368547(?:75807|75808|76000)$/;

/**
 * Whether `value` holds something to sort by at `segments[i..]`, through any
 * array: null and an empty array hold nothing, as the sort reads them, while ""
 * is a value.
 */
function holdsSortValue(value: unknown, segments: readonly string[], i: number): boolean {
  if (Array.isArray(value)) return value.some((item) => holdsSortValue(item, segments, i));
  if (i === segments.length) return value !== undefined && value !== null;
  if (value === null || typeof value !== 'object') return false;
  const key = segments[i] as string;
  return (
    Object.hasOwn(value, key) &&
    holdsSortValue((value as Record<string, unknown>)[key], segments, i + 1)
  );
}

/**
 * The continuation a page's next link offers. A sorted walk that reaches the
 * records lacking a sort field (openFDA sorts them last) is linked with that
 * key's missing-value marker, and following it fails (a date sort answers HTTP
 * 500) or loops (a keyword sort: ascending restarts the walk at its first
 * record, descending settles on one page it repeats under the same link). Such
 * a link, or one repeating the value the page was read with, comes back as
 * `searchAfterBlocked`, naming which, rather than `nextSearchAfter`.
 *
 * A keyword sort's empty value is that marker only when the page's last record,
 * whose values the link carries, lacks the key's field: a record holding "" is
 * linked the same way, and openFDA continues that walk. When the link's values
 * do not line up one-to-one with the sort's keys, an empty value is the marker
 * if the last record lacks any sort field.
 */
function continuationOf(
  link: string | undefined,
  sent: string | undefined,
  sort: string | undefined,
  last: unknown,
): Pick<OpenFdaResponse, 'nextSearchAfter' | 'searchAfterBlocked'> {
  if (link === undefined) return {};
  if (link === sent) return { searchAfterBlocked: 'repeated_link' };
  // One `<n>=<value>` per sort key, then openFDA's tiebreaker id. Values arrive
  // percent-encoded, so `;` only ever separates components.
  const sortValues = link
    .split(';')
    .slice(0, -1)
    .map((component) => component.slice(component.indexOf('=') + 1));
  const paths = (sort === undefined ? [] : sortKeys(sort)).map((key) =>
    key.endsWith('.exact') ? key.slice(0, -'.exact'.length) : key,
  );
  const lacks = (path: string) => !holdsSortValue(last, path.split('.'), 0);
  const emptyIsMissing = (i: number) =>
    paths.length === sortValues.length
      ? lacks(paths[i] as string)
      : paths.length === 0 || paths.some(lacks);
  return sortValues.some(
    (value, i) => MISSING_SORT_VALUE.test(value) || (value === '' && emptyIsMissing(i)),
  )
    ? { searchAfterBlocked: 'missing_sort_value' }
    : { nextSearchAfter: link };
}

/** Whether a link-value's parameters hold a `rel` whose relation types include `next`. */
function namesNextRel(params: string): boolean {
  return params.split(';').some((param) => {
    const eq = param.indexOf('=');
    if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== 'rel') return false;
    const types = param
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '');
    return types.toLowerCase().split(/\s+/).includes('next');
  });
}

/**
 * The slice of {@link ServerConfig} the client reads. Mirror settings are
 * optional so a caller that only wants the live client — the default posture —
 * can construct one from a base URL alone.
 */
export type OpenFdaServiceConfig = Pick<ServerConfig, 'apiKey' | 'baseUrl'> &
  Partial<Pick<ServerConfig, 'mirrorEnabled' | 'mirrorFallbackLive'>>;

export class OpenFdaService {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly mirrorEnabled: boolean;
  private readonly mirrorFallbackLive: boolean;
  /** Last-seen `meta.last_updated` per endpoint, used as fallback on 404 responses. */
  private readonly lastUpdatedByEndpoint: Map<string, string> = new Map();

  constructor(config: OpenFdaServiceConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.mirrorEnabled = config.mirrorEnabled ?? false;
    this.mirrorFallbackLive = config.mirrorFallbackLive ?? true;
  }

  /**
   * Execute a query against any openFDA endpoint, local mirror first when one is
   * enabled and can reproduce the query exactly (see `mirror/query.ts`), live
   * otherwise. With the mirror off — the default — this is the live path and
   * nothing else. The live path settles by `options.deadlineAtMs`.
   */
  async query<T = Record<string, unknown>>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
    options?: OpenFdaQueryOptions,
  ): Promise<OpenFdaResponse<T>> {
    const deadlineAtMs = options?.deadlineAtMs ?? Date.now() + OPENFDA_CALL_DEADLINE_MS;
    const mirrored = await this.queryMirror<T>(endpoint, params, ctx);
    return mirrored ?? (await this.queryLive<T>(endpoint, params, ctx, deadlineAtMs));
  }

  /**
   * Answer from the local mirror, or return `undefined` to route live.
   *
   * Routes live when the mirror is off, the query is one the mirror cannot
   * reproduce, the mirror has never completed a sync, or the lookup matched
   * nothing — a zero-match on a mirror that is a refresh cycle behind is
   * indistinguishable from a genuine miss, so the live API arbitrates. With
   * `OPENFDA_MIRROR_FALLBACK_LIVE=false` a cold or failing mirror raises instead
   * of silently spending the live API budget.
   */
  private async queryMirror<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
  ): Promise<OpenFdaResponse<T> | undefined> {
    if (!this.mirrorEnabled) return;
    const lookup = planMirrorLookup(endpoint, params);
    if (!lookup) return;

    const mirror = getMirror(lookup.dataset.endpoint);
    let answer: OpenFdaResponse | undefined;
    try {
      if (!(await mirror.ready())) {
        if (this.mirrorFallbackLive) {
          ctx.log.debug('openFDA mirror not synced; using live API', { endpoint });
          return;
        }
        throw serviceUnavailable(
          `The local openFDA mirror for ${endpoint} has never completed a sync, and OPENFDA_MIRROR_FALLBACK_LIVE is off. Run the mirror init for this dataset or re-enable live fallback.`,
          { reason: 'mirror_unavailable', endpoint },
        );
      }
      answer = await runMirrorLookup(mirror, lookup);
    } catch (error) {
      if (!this.mirrorFallbackLive) throw error;
      ctx.log.warning('openFDA mirror lookup failed; falling back to live API', {
        endpoint,
        field: lookup.field,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!answer || (answer.meta.total === 0 && this.mirrorFallbackLive)) return;
    ctx.log.debug('Served openFDA query from local mirror', {
      endpoint,
      field: lookup.field,
      total: answer.meta.total,
    });
    return answer as OpenFdaResponse<T>;
  }

  /**
   * Execute a query against the live openFDA API.
   *
   * Uses the framework's `fetchWithTimeout` (which throws a status-mapped
   * `McpError` on any non-2xx, redacts the api_key-bearing URL from logs/errors,
   * and emits the fleet-standard `http.client.request.duration` metric). The
   * classification happens inside the `withRetry` callback so a reclassified
   * non-retryable error (`query_error`) stops the retry loop while a genuine
   * `upstream_error` / `rate_limited` is retried. Returns an empty result set for
   * 404 (valid query, zero matches) — except on a count expression that does not
   * count, which is a fixable count expression, not an empty tally. A 200 body is
   * read whole, then parsed against openFDA's envelope: a read the deadline or
   * the caller's cancel cuts keeps its own class, and only a body that arrived
   * and is not openFDA JSON becomes `upstream_error` ({@link parseEnvelope}).
   *
   * `deadlineAtMs` bounds the whole ladder: `withRetry`'s `deadlineMs` fails a
   * backoff that would outlast it and gives every expiry one shape, and each
   * attempt's own timeout is capped at the time left, so the in-flight request
   * is cut at the deadline too. Side requests inherit the same instant. A call
   * that starts with no time left sends nothing: a request given a 0 ms timeout
   * still reaches openFDA before the timeout cuts it. `retry` overrides the retry
   * budget; only side requests pass it.
   */
  private async queryLive<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
    deadlineAtMs: number,
    retry?: Pick<RetryOptions, 'maxRetries'>,
  ): Promise<OpenFdaResponse<T>> {
    // A cancelled caller keeps its cancellation; the request path below reports it.
    if (!ctx.signal?.aborted && Date.now() >= deadlineAtMs) {
      throw timeout(`openFDA:${endpoint} reached its deadline before the request was sent.`, {
        reason: 'retry_deadline_exceeded',
        endpoint,
      });
    }
    return await withRetry(
      async () => {
        const remainingMs = Math.max(0, deadlineAtMs - Date.now());
        const url = this.buildUrl(endpoint, params);
        ctx.log.debug('Querying openFDA', { endpoint, params });

        // `Context extends RequestContext`, so the handler context goes through
        // whole — trace, span, session, and tenant ids join the request trace
        // alongside the correlation id. Only `operation` is overridden, to name
        // the upstream call rather than the tool execution that wraps it.
        const requestContext = { ...ctx, operation: `openFDA:${endpoint}` };
        let response: Response;
        let text: string;
        try {
          // openFDA answers a valid zero-match query with 404; `expectedStatuses`
          // drops that to a debug log so a handled empty result stops reading as
          // an operational failure. The thrown status-mapped McpError is unchanged,
          // so classification below is unaffected.
          response = await fetchWithTimeout(
            url,
            Math.min(REQUEST_TIMEOUT_MS, remainingMs),
            requestContext,
            { signal: ctx.signal, expectedStatuses: [404] },
          );
          text = await response.text();
        } catch (error) {
          return await this.classifyError<T>(error, endpoint, params, ctx, deadlineAtMs);
        }
        const envelope = parseEnvelope(text, endpoint);
        // Read with the body it came with, so a retried attempt keeps only its own link.
        const nextSearchAfter = searchAfterOfNextLink(response.headers.get('link'));
        return this.normalizeResponse<T>(envelope, endpoint, params, nextSearchAfter);
      },
      {
        operation: `openFDA:${endpoint}`,
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        deadlineMs: Math.max(0, deadlineAtMs - Date.now()),
        ...retry,
      },
    );
  }

  /**
   * The request URL. `search` goes out wrapped in one pair of parentheses: on
   * `drug/enforcement`, `food/enforcement`, and `device/enforcement` — one shared
   * index — openFDA appends its own product-type clause, and a top-level `A OR B`
   * then matches only `B`'s records (food: `cheese OR milk` answered 1,675, the
   * union 3,141). Grouped, OR is a union there as everywhere else; on every
   * endpoint a query with no top-level OR answers the same total either way. The
   * wrap lives here, at the one place every request is built — side requests and
   * server-composed queries included — so callers, the mirror gate, and echoed
   * queries all keep the unwrapped string.
   *
   * A `search_after` continuation goes out as openFDA's own next link does:
   * `skip=0` beside the value, whatever `skip` the params carry — openFDA
   * answers a skip above 0 with `search_after` with a 400.
   */
  private buildUrl(endpoint: string, params: OpenFdaQueryParams): URL {
    const url = new URL(`/${endpoint}.json`, this.baseUrl);
    if (params.search) url.searchParams.set('search', `(${params.search})`);
    if (params.count) url.searchParams.set('count', params.count);
    if (params.sort) url.searchParams.set('sort', params.sort);
    if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
    if (params.searchAfter) {
      url.searchParams.set('skip', '0');
      url.searchParams.set('search_after', params.searchAfter.value);
    } else if (params.skip !== undefined) {
      url.searchParams.set('skip', String(params.skip));
    }
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    return url;
  }

  /**
   * The normalized page. openFDA reports `skip: 0` on every `search_after`
   * page, so a continuation reports its walk position instead — except a page
   * linked with the value it was read with (`repeated_link`): the link names the
   * page's last record, so that page ends where the walk stood, and it reports
   * where its records start. A count tally carries no pagination, so its total,
   * skip, and limit read 0.
   */
  private normalizeResponse<T>(
    envelope: OpenFdaEnvelope,
    endpoint: string,
    params: OpenFdaQueryParams,
    nextSearchAfter: string | undefined,
  ): OpenFdaResponse<T> {
    const { last_updated: lastUpdated = 'unknown', results: pagination } = envelope.meta;
    if (lastUpdated !== 'unknown') {
      this.lastUpdatedByEndpoint.set(endpoint, lastUpdated);
    }
    const continuation = continuationOf(
      nextSearchAfter,
      params.searchAfter?.value,
      params.sort,
      envelope.results.at(-1),
    );
    const position = params.searchAfter?.position;
    const skip =
      position === undefined
        ? (pagination?.skip ?? 0)
        : continuation.searchAfterBlocked === 'repeated_link'
          ? position - envelope.results.length
          : position;
    return {
      meta: {
        total: pagination?.total ?? 0,
        skip,
        limit: pagination?.limit ?? 0,
        lastUpdated,
      },
      results: envelope.results as T[],
      ...continuation,
    };
  }

  /**
   * Classify an error thrown from the fetch and body read into openFDA's typed
   * failure surface. Keyed on the HTTP status and body `fetchWithTimeout` attaches
   * to `error.data`. Non-`McpError` throws and status-less `McpError`s (network
   * failure, timeout, abort — before the headers or during the body read)
   * propagate unchanged — they are already correctly classified. The
   * reclassified reasons match the calling tools' `errors[]` contracts, so the
   * framework fills each declared recovery hint.
   */
  private async classifyError<T>(
    error: unknown,
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
    deadlineAtMs: number,
  ): Promise<OpenFdaResponse<T>> {
    if (!(error instanceof McpError)) throw error;

    const data = error.data as { status?: number; body?: string; retryAfter?: string } | undefined;
    // No HTTP status → timeout / abort / network error from fetchWithTimeout; it is
    // already classified (ServiceUnavailable / Timeout — retryable). Let it bubble.
    if (data?.status === undefined) throw error;

    const status = data.status;
    const body = data.body ?? '';
    const message = this.upstreamMessage(body, status);

    // 404 → valid query, zero matches. Return an empty result set (not an error).
    if (status === 404) {
      if (params.count) {
        // openFDA answers a search that matched nothing before it reads the count
        // expression, so an expression the catalog records as failing can reach
        // either 404 — and it fails as written whatever the search matches.
        const verdict = countVerdict(endpoint, params.count);
        if (verdict.kind === 'none' || verdict.kind === 'wrong_form') {
          throw this.notAggregatableError(endpoint, params.count);
        }
        // Only a count query can produce this marker; keyed on `params.count` so
        // the error can always name the expression it is telling the caller to fix.
        if (OPENFDA_NOTHING_TO_COUNT.test(body)) {
          return await this.resolveNothingToCount<T>(
            endpoint,
            params,
            params.count,
            verdict,
            ctx,
            deadlineAtMs,
          );
        }
      } else if (params.searchAfter || (params.skip ?? 0) > 0) {
        return await this.resolvePastEnd<T>(endpoint, params, ctx, deadlineAtMs);
      }
      return this.emptyResult<T>(endpoint, params);
    }

    if (status === 429) {
      throw rateLimited(
        this.apiKey
          ? 'openFDA rate limit exceeded (240 req/min or 120K/day with key). Retry after a brief wait.'
          : 'openFDA rate limit exceeded (240 req/min or 1K/day without key). Configure OPENFDA_API_KEY to increase to 120K/day.',
        // `withRetry` waits out a `retryAfter` it can afford and fails fast on one it cannot.
        {
          reason: 'rate_limited',
          endpoint,
          ...(data.retryAfter !== undefined && { retryAfter: data.retryAfter }),
        },
      );
    }

    if (status === 401) {
      throw unauthorized(
        'openFDA API key is missing or invalid. Provide a valid key via OPENFDA_API_KEY.',
        { reason: 'unauthorized', endpoint },
      );
    }

    if (status === 403) {
      throw forbidden(
        'Access to this openFDA endpoint is forbidden. Check that the API key has the required permissions.',
        { reason: 'forbidden', endpoint },
      );
    }

    if (status === 400) {
      // The fact only: each tool's declared recovery names the ways past it.
      if (OPENFDA_SKIP_CEILING.test(message)) {
        throw validationError(`Pagination limit reached: skip cannot exceed ${OPENFDA_MAX_SKIP}.`, {
          reason: 'pagination_limit_reached',
          endpoint,
        });
      }
      const refused = refusedSortKey(params.sort, OPENFDA_SORT_NON_ANALYZED.exec(message));
      if (refused) throw this.sortRefusalError(endpoint, refused, 'non_analyzed');
      throw validationError(
        `openFDA query error: ${message}. Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.`,
        { reason: 'query_error', endpoint },
      );
    }

    if (status >= 500) {
      // A count on an analyzed text field. Keyed on `params.count` so the error
      // can name the expression it is correcting; checked before the generic
      // marker set, which also matches this exception.
      if (params.count && OPENFDA_NOT_AGGREGATABLE_5XX.test(body)) {
        throw this.notAggregatableError(endpoint, params.count, 'analyzed_text');
      }
      // A sort key openFDA refused, ahead of the generic marker set, which matches
      // both exceptions too. Read off the raw capture rather than the parsed
      // message: an over-budget body is kept as head and tail around an elision,
      // and the field sits in the tail.
      const unmapped = refusedSortKey(params.sort, OPENFDA_SORT_NO_MAPPING.exec(body));
      if (unmapped) throw this.sortRefusalError(endpoint, unmapped, 'no_mapping');
      const analyzed = refusedSortKey(params.sort, OPENFDA_FIELDDATA_FIELD.exec(body));
      if (analyzed) throw this.sortRefusalError(endpoint, analyzed, 'analyzed_text');
      // openFDA reports deterministic, user-fixable query failures (malformed
      // syntax, aggregation on a non-keyword field) as HTTP 5xx. Reclassify those
      // as non-retryable query errors; genuine outages stay retryable.
      if (OPENFDA_QUERY_ERROR_5XX.test(body)) {
        throw validationError(
          `openFDA query error: ${message}. Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.`,
          { reason: 'query_error', endpoint },
        );
      }
      throw serviceUnavailable(`openFDA upstream error: ${message}`, {
        reason: 'upstream_error',
        endpoint,
        status,
      });
    }

    // Unexpected HTTP status (e.g. 418) — fetchWithTimeout already produced a typed
    // McpError; keep its code and data rather than inventing a classification. The
    // captured body stays off the client envelope, so openFDA's own error text rides
    // in the message, as it does on every classified branch above.
    throw new McpError(
      error.code,
      `openFDA returned HTTP ${status}${body ? `: ${message}` : ''}`,
      error.data,
      { cause: error },
    );
  }

  /**
   * The empty result for a count or search that tallied nothing. `meta` overlays
   * what a resolver learned about it — a recovered total or a disclosure flag.
   * Its `skip` is where the page started: the walk position on a `search_after`
   * continuation.
   */
  private emptyResult<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    meta?: Pick<Partial<OpenFdaMeta>, 'nothingToCount' | 'total' | 'totalUnverified'>,
  ): OpenFdaResponse<T> {
    return {
      meta: {
        total: 0,
        skip: params.searchAfter?.position ?? params.skip ?? 0,
        limit: params.limit ?? 0,
        lastUpdated: this.lastUpdatedByEndpoint.get(endpoint) ?? 'unknown',
        ...meta,
      },
      results: [],
    };
  }

  /**
   * Resolve a `Nothing to count` 404. openFDA answers it for an expression it
   * cannot aggregate, and also — data-level, not mapping-level — for a countable
   * expression whose search matched only records that carry no value for the
   * field. The second case is an empty tally, not an error.
   *
   * The caller has already failed every expression the catalog records as
   * failing. Only a search can make a countable expression come up empty, so an
   * unscoped `Nothing to count` is always `not_aggregatable`. Under a search, a
   * recorded countable expression is settled; one outside the catalog is
   * re-asked unscoped with `limit=1` — a tally proves it countable, and a second
   * `Nothing to count` raises `not_aggregatable` from that request's own
   * classification. The extra request runs only on this failure path, on a
   * single attempt — a transient failure of it is retried by the primary loop.
   */
  private async resolveNothingToCount<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    count: string,
    verdict: Extract<CountVerdict, { kind: 'countable' | 'uncataloged' }>,
    ctx: Context,
    deadlineAtMs: number,
  ): Promise<OpenFdaResponse<T>> {
    if (!params.search) throw this.notAggregatableError(endpoint, count);
    if (verdict.kind === 'uncataloged') {
      await this.queryLive(endpoint, { count, limit: 1 }, ctx, deadlineAtMs, SIDE_REQUEST_RETRY);
    }
    return this.emptyResult<T>(endpoint, params, { nothingToCount: true });
  }

  /**
   * Resolve a `No matches found!` 404 on a page at `skip > 0` or on a
   * `search_after` continuation — openFDA links an exactly full last page, and
   * that link 404s. openFDA answers a page past the end of a matched set exactly
   * as it answers a search that matched nothing, so one `skip=0&limit=0` request
   * for the same search — no sort, which cannot change a total, and no
   * `search_after` — settles it: a match returns its total with no records, a
   * genuine miss 404s again. The extra request runs only on this path.
   *
   * Best-effort, on a single attempt: the empty page is a valid answer without
   * the total, so a failed recovery returns it at once, marked `totalUnverified`,
   * rather than retrying or failing the call.
   */
  private async resolvePastEnd<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
    deadlineAtMs: number,
  ): Promise<OpenFdaResponse<T>> {
    try {
      const { total } = (
        await this.queryLive(
          endpoint,
          { search: params.search, limit: 0, skip: 0 },
          ctx,
          deadlineAtMs,
          SIDE_REQUEST_RETRY,
        )
      ).meta;
      return this.emptyResult<T>(endpoint, params, { total });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      ctx.log.warning('openFDA total recovery for an empty page failed; total left unverified', {
        endpoint,
        skip: params.searchAfter?.position ?? params.skip,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.emptyResult<T>(endpoint, params, { totalUnverified: true });
    }
  }

  /**
   * Build the `not_aggregatable` error for a count expression openFDA will not
   * aggregate, always naming the expression and the correction that applies.
   *
   * A field in the catalog carries its verified count form, so the correction is
   * definitive: the recorded expression when the caller used the other form, or
   * a statement that the field has no countable form, listing the endpoint's
   * countable expressions. Neither suggests a form the catalog records as failing.
   *
   * An expression outside the catalog — or a recorded form that itself failed,
   * meaning openFDA remapped the index — gets the hedged correction, whose
   * direction `cause` selects:
   *
   * - `not_countable` (a `Nothing to count` 404) — the dominant case is `.exact`
   *   on a field openFDA already indexes as keyword-only, so **drop** the suffix.
   * - `analyzed_text` (a 5xx `illegal_argument_exception` on a count) — the field
   *   is analyzed text, so **add** `.exact` to reach its keyword subfield.
   *
   * Neither is guaranteed to land, because some analyzed fields have no keyword
   * subfield at all (`reason_for_recall` on `drug/enforcement` fails both ways),
   * so both name the field catalog as the next step, and an expression that
   * already carries the suffix the correction would apply falls back to naming
   * `openfda_describe_fields`. Non-retryable: the same expression fails
   * identically every time.
   */
  private notAggregatableError(
    endpoint: string,
    expression: string,
    cause: 'not_countable' | 'analyzed_text' = 'not_countable',
  ): McpError {
    const hasExact = expression.endsWith('.exact');
    const verdict = countVerdict(endpoint, expression);
    const data = { reason: 'not_aggregatable', endpoint, count: expression };

    if (verdict.kind === 'wrong_form') {
      const diagnosis = hasExact
        ? '.exact is unsupported on a field openFDA indexes as a keyword'
        : 'it is an analyzed text field';
      return validationError(
        `openFDA cannot aggregate "${expression}" on ${endpoint}: ${diagnosis}. Count "${verdict.use}" instead.`,
        { ...data, recovery: { hint: `Retry with count "${verdict.use}".` } },
      );
    }

    if (verdict.kind === 'none') {
      const field = hasExact ? expression.slice(0, -'.exact'.length) : expression;
      const shown = verdict.alternatives.slice(0, MAX_ALTERNATIVES);
      const more = verdict.alternatives.length - shown.length;
      return validationError(
        `openFDA cannot aggregate "${expression}" on ${endpoint}: "${field}" has no countable form — openFDA indexes it as analyzed text with no keyword subfield, so neither the bare field nor .exact aggregates. Countable on ${endpoint}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
        {
          ...data,
          recovery: {
            hint: `Count a different field; openfda_describe_fields for ${endpoint} lists each field's countAs expression.`,
          },
        },
      );
    }

    const describeFields = `Count a keyword field instead; call openfda_describe_fields for ${endpoint} to see the available field paths.`;
    const { diagnosis, correction } =
      cause === 'analyzed_text'
        ? {
            diagnosis: 'it is an analyzed text field',
            correction: hasExact
              ? describeFields
              : `Retry with "${expression}.exact" to tally whole values; if that reports nothing to count, the field has no keyword subfield — call openfda_describe_fields for ${endpoint} to pick one that does.`,
          }
        : {
            diagnosis: 'the field is not countable as written',
            correction: hasExact
              ? `Retry with the bare field "${expression.slice(0, -'.exact'.length)}" — .exact is unsupported on a field openFDA indexes as a keyword. If the bare field fails too, the field is analyzed text with no keyword subfield; call openfda_describe_fields for ${endpoint} to pick a countable one.`
              : describeFields,
          };
    return validationError(
      `openFDA cannot aggregate "${expression}" on ${endpoint}: ${diagnosis}. ${correction}`,
      data,
    );
  }

  /**
   * Build the `not_sortable` error for a sort key openFDA refused, naming the
   * key, the endpoint, and the correction. The correction closes the message and
   * is the recovery hint, so the wire states it once.
   *
   * The other form is hedged: `.exact` cures analyzed text only where the field
   * has a keyword subfield, and dropping it cures an `.exact` the index lacks
   * only where the bare field sorts, so the correction says a field that fails
   * both ways cannot be sorted. A bare key with no mapping is one the endpoint
   * lacks, which no form cures. `openfda_describe_fields` lists field paths, not
   * sortable forms, so it is offered only as the endpoint's field list.
   * Non-retryable: the same key fails identically every time.
   */
  private sortRefusalError(endpoint: string, field: string, refusal: SortRefusal): McpError {
    const diagnosis = (
      {
        non_analyzed: `cannot sort ${endpoint} by "${field}" as written: it sorts by non-analyzed fields only`,
        analyzed_text: `cannot sort ${endpoint} by "${field}": it is an analyzed text field`,
        no_mapping: `cannot sort ${endpoint} by "${field}": the field has no sortable mapping on ${endpoint}`,
      } satisfies Record<SortRefusal, string>
    )[refusal];
    const hasExact = field.endsWith('.exact');
    const correction =
      refusal === 'no_mapping' && !hasExact
        ? `Sort on another field; openfda_describe_fields for ${endpoint} lists the endpoint's field paths.`
        : `Sort on "${hasExact ? field.slice(0, -'.exact'.length) : `${field}.exact`}" instead; a field that fails both ways cannot be sorted, so sort on another field.`;
    return validationError(`openFDA ${diagnosis}. ${correction}`, {
      reason: 'not_sortable',
      endpoint,
      field,
      recovery: { hint: correction },
    });
  }

  /**
   * Best-effort human-readable message from an openFDA error body. Prefers the
   * specific `error.details` (e.g. the parser location or the "use a keyword
   * field" hint) then `error.message`, falling back to the raw (possibly
   * truncated) body or the bare HTTP status. An HTML page — a proxy's error page,
   * not openFDA's — contributes only its title: its markup states no reason.
   *
   * openFDA HTML-escapes `error.message` — the query a 400 echoes comes back
   * with `&quot;` for `"` and `&amp;amp;` for the caller's own `&amp;` — so it is
   * decoded once, restoring the text as sent. `error.details` arrives unescaped
   * and stays as it is.
   */
  private upstreamMessage(body: string, status: number): string {
    if (!body) return `HTTP ${status}`;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // Truncated or non-JSON body — falls through to the raw text.
    }
    const error = OPENFDA_ERROR_BODY.safeParse(json).data?.error;
    const detail = error?.details ?? (error?.message && decodeEntities(error.message));
    if (detail) return detail;
    if (isHtml(body)) return htmlTitle(body) ?? `HTTP ${status}`;
    return body;
  }
}

/* --- Init / accessor pattern --- */

let _service: OpenFdaService | undefined;

export function initOpenFdaService(): void {
  _service = new OpenFdaService(getServerConfig());
}

export function getOpenFdaService(): OpenFdaService {
  if (!_service)
    throw new Error('OpenFdaService not initialized — call initOpenFdaService() in setup()');
  return _service;
}

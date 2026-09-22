/**
 * @fileoverview Generic openFDA API client with retry, rate-limit awareness, and error normalization.
 * @module services/openfda/openfda-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  McpError,
  rateLimited,
  serviceUnavailable,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RetryOptions, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { type CountVerdict, countVerdict } from '@/mcp-server/tools/field-catalog.js';
import { getMirror, planMirrorLookup, runMirrorLookup } from './mirror/index.js';
import type { OpenFdaMeta, OpenFdaQueryParams, OpenFdaResponse } from './types.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Retry budget for a side request issued from inside the primary request's retry
 * callback — the past-end total recovery and the `Nothing to count` confirm. One
 * attempt: the recovery is best-effort, so a retry only parks a backoff sleep
 * (≥750 ms at the 1 s base) on a call that would otherwise return at once; a
 * failed confirm propagates into the primary loop, which already retries the
 * whole exchange, so retrying it in place would multiply that budget.
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
 * - `illegal_argument_exception` — a `count` on a non-keyword text field. On a
 *   count query this is answered by {@link OPENFDA_NOT_AGGREGATABLE_5XX} first;
 *   the marker stays here to cover the same exception raised without a `count`.
 * - `query_shard_exception` — a sort or filter on a field absent from that index's
 *   mapping (e.g. `receivedate:desc` on food/device, which lack the field).
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
   * nothing else.
   */
  async query<T = Record<string, unknown>>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
  ): Promise<OpenFdaResponse<T>> {
    const mirrored = await this.queryMirror<T>(endpoint, params, ctx);
    return mirrored ?? (await this.queryLive<T>(endpoint, params, ctx));
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
   * count, which is a fixable count expression, not an empty tally. `retry` overrides the retry budget; only side requests pass it.
   */
  private async queryLive<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
    retry?: Pick<RetryOptions, 'maxRetries'>,
  ): Promise<OpenFdaResponse<T>> {
    return await withRetry(
      async () => {
        const url = this.buildUrl(endpoint, params);
        ctx.log.debug('Querying openFDA', { endpoint, params });

        // `Context extends RequestContext`, so the handler context goes through
        // whole — trace, span, session, and tenant ids join the request trace
        // alongside the correlation id. Only `operation` is overridden, to name
        // the upstream call rather than the tool execution that wraps it.
        const requestContext = { ...ctx, operation: `openFDA:${endpoint}` };
        try {
          // openFDA answers a valid zero-match query with 404; `expectedStatuses`
          // drops that to a debug log so a handled empty result stops reading as
          // an operational failure. The thrown status-mapped McpError is unchanged,
          // so classification below is unaffected.
          const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, requestContext, {
            signal: ctx.signal,
            expectedStatuses: [404],
          });
          const data = (await response.json()) as Record<string, unknown>;
          return this.normalizeResponse<T>(data, endpoint);
        } catch (error) {
          return await this.classifyError<T>(error, endpoint, params, ctx);
        }
      },
      {
        operation: `openFDA:${endpoint}`,
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        ...retry,
      },
    );
  }

  private buildUrl(endpoint: string, params: OpenFdaQueryParams): URL {
    const url = new URL(`/${endpoint}.json`, this.baseUrl);
    if (params.search) url.searchParams.set('search', params.search);
    if (params.count) url.searchParams.set('count', params.count);
    if (params.sort) url.searchParams.set('sort', params.sort);
    if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
    if (params.skip !== undefined) url.searchParams.set('skip', String(params.skip));
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    return url;
  }

  private normalizeResponse<T>(
    data: Record<string, unknown>,
    endpoint: string,
  ): OpenFdaResponse<T> {
    const meta = data.meta as Record<string, unknown> | undefined;
    const pagination = meta?.results as Record<string, unknown> | undefined;
    const lastUpdated = (meta?.last_updated as string) ?? 'unknown';
    if (lastUpdated !== 'unknown') {
      this.lastUpdatedByEndpoint.set(endpoint, lastUpdated);
    }
    return {
      meta: {
        total: (pagination?.total as number) ?? 0,
        skip: (pagination?.skip as number) ?? 0,
        limit: (pagination?.limit as number) ?? 0,
        lastUpdated,
      },
      results: (data.results as T[]) ?? [],
    };
  }

  /**
   * Classify an error thrown from the fetch/parse pipeline into openFDA's typed
   * failure surface. Keyed on the HTTP status and body `fetchWithTimeout` attaches
   * to `error.data`. Non-`McpError` throws (network errors, JSON parse failures)
   * and status-less `McpError`s (timeout, abort) propagate unchanged — they are
   * already correctly classified. The reclassified reasons match the calling
   * tools' `errors[]` contracts so `ctx.recoveryFor` carries the recovery hint.
   */
  private async classifyError<T>(
    error: unknown,
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
  ): Promise<OpenFdaResponse<T>> {
    if (!(error instanceof McpError)) throw error;

    const data = error.data as { status?: number; body?: string } | undefined;
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
          throw this.notAggregatableError(endpoint, params.count, ctx);
        }
        // Only a count query can produce this marker; keyed on `params.count` so
        // the error can always name the expression it is telling the caller to fix.
        if (OPENFDA_NOTHING_TO_COUNT.test(body)) {
          return await this.resolveNothingToCount<T>(endpoint, params, params.count, verdict, ctx);
        }
      } else if ((params.skip ?? 0) > 0) {
        return await this.resolvePastEnd<T>(endpoint, params, ctx);
      }
      return this.emptyResult<T>(endpoint, params);
    }

    if (status === 429) {
      throw rateLimited(
        this.apiKey
          ? 'openFDA rate limit exceeded (240 req/min or 120K/day with key). Retry after a brief wait.'
          : 'openFDA rate limit exceeded (240 req/min or 1K/day without key). Configure OPENFDA_API_KEY to increase to 120K/day.',
        { reason: 'rate_limited', endpoint, ...ctx.recoveryFor('rate_limited') },
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
      if (/25000/i.test(body)) {
        throw validationError(
          'Pagination limit reached: skip cannot exceed 25000. Narrow the search query with additional filters or date ranges instead of increasing skip.',
          {
            reason: 'pagination_limit_reached',
            endpoint,
            ...ctx.recoveryFor('pagination_limit_reached'),
          },
        );
      }
      throw validationError(
        `openFDA query error: ${message}. Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.`,
        { reason: 'query_error', endpoint, ...ctx.recoveryFor('query_error') },
      );
    }

    if (status >= 500) {
      // A count on an analyzed text field. Keyed on `params.count` so the error
      // can name the expression it is correcting; checked before the generic
      // marker set, which also matches this exception.
      if (params.count && OPENFDA_NOT_AGGREGATABLE_5XX.test(body)) {
        throw this.notAggregatableError(endpoint, params.count, ctx, 'analyzed_text');
      }
      // openFDA reports deterministic, user-fixable query failures (malformed
      // syntax, aggregation on a non-keyword field) as HTTP 5xx. Reclassify those
      // as non-retryable query errors; genuine outages stay retryable.
      if (OPENFDA_QUERY_ERROR_5XX.test(body)) {
        throw validationError(
          `openFDA query error: ${message}. Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.`,
          { reason: 'query_error', endpoint, ...ctx.recoveryFor('query_error') },
        );
      }
      throw serviceUnavailable(`openFDA upstream error: ${message}`, {
        reason: 'upstream_error',
        endpoint,
        status,
        ...ctx.recoveryFor('upstream_error'),
      });
    }

    // Unexpected HTTP status (e.g. 418) — fetchWithTimeout already produced a typed
    // McpError; propagate it unchanged rather than inventing a classification.
    throw error;
  }

  /**
   * The empty result for a count or search that tallied nothing. `meta` overlays
   * what a resolver learned about it — a recovered total or a disclosure flag.
   */
  private emptyResult<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    meta?: Pick<Partial<OpenFdaMeta>, 'nothingToCount' | 'total' | 'totalUnverified'>,
  ): OpenFdaResponse<T> {
    return {
      meta: {
        total: 0,
        skip: params.skip ?? 0,
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
  ): Promise<OpenFdaResponse<T>> {
    if (!params.search) throw this.notAggregatableError(endpoint, count, ctx);
    if (verdict.kind === 'uncataloged') {
      await this.queryLive(endpoint, { count, limit: 1 }, ctx, SIDE_REQUEST_RETRY);
    }
    return this.emptyResult<T>(endpoint, params, { nothingToCount: true });
  }

  /**
   * Resolve a `No matches found!` 404 on a page at `skip > 0`. openFDA answers a
   * page past the end of a matched set exactly as it answers a search that
   * matched nothing, so one `skip=0&limit=0` request for the same search — no
   * sort, which cannot change a total — settles it: a match returns its total
   * with no records, a genuine miss 404s again. The extra request runs only on
   * this path.
   *
   * Best-effort, on a single attempt: the empty page is a valid answer without
   * the total, so a failed recovery returns it at once, marked `totalUnverified`,
   * rather than retrying or failing the call.
   */
  private async resolvePastEnd<T>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
  ): Promise<OpenFdaResponse<T>> {
    try {
      const { total } = (
        await this.queryLive(
          endpoint,
          { search: params.search, limit: 0, skip: 0 },
          ctx,
          SIDE_REQUEST_RETRY,
        )
      ).meta;
      return this.emptyResult<T>(endpoint, params, { total });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      ctx.log.warning('openFDA total recovery for an empty page failed; total left unverified', {
        endpoint,
        skip: params.skip,
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
    ctx: Context,
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
      { ...data, ...ctx.recoveryFor('not_aggregatable') },
    );
  }

  /**
   * Best-effort human-readable message from an openFDA error body. Prefers the
   * specific `error.details` (e.g. the parser location or the "use a keyword
   * field" hint) then `error.message`, falling back to the raw (possibly
   * truncated) body or the bare HTTP status.
   */
  private upstreamMessage(body: string, status: number): string {
    if (!body) return `HTTP ${status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string; details?: string } };
      const detail = parsed.error?.details ?? parsed.error?.message;
      if (detail) return detail;
    } catch {
      // Truncated or non-JSON body — fall through to the raw text.
    }
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

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
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type { OpenFdaQueryParams, OpenFdaResponse } from './types.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * openFDA surfaces deterministic, user-fixable query failures as HTTP 5xx whose body
 * names the underlying Lucene/ES exception in `error.details`. Covered markers:
 *
 * - `token_mgr_error` / `lexical error` — the tokenizer rejected the search string
 *   (e.g. an unbalanced quote).
 * - `parse_exception` — the tokens are legal but the grammar is not: an unbalanced
 *   bracket or paren, a dangling `AND`/`OR`, a half-open range (`[20200101 TO]`),
 *   or a bare `_exists_:`.
 * - `illegal_argument_exception` — a `count` on a non-keyword text field.
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
 * field openFDA already indexes as keyword-only). Only the first is an empty tally;
 * the second is a fixable query error and must not be collapsed into one.
 */
const OPENFDA_NOTHING_TO_COUNT = /nothing to count/i;

export class OpenFdaService {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  /** Last-seen `meta.last_updated` per endpoint, used as fallback on 404 responses. */
  private readonly lastUpdatedByEndpoint: Map<string, string> = new Map();

  constructor(config: ServerConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * Execute a query against any openFDA endpoint.
   *
   * Uses the framework's `fetchWithTimeout` (which throws a status-mapped
   * `McpError` on any non-2xx, redacts the api_key-bearing URL from logs/errors,
   * and emits the fleet-standard `http.client.request.duration` metric). The
   * classification happens inside the `withRetry` callback so a reclassified
   * non-retryable error (`query_error`) stops the retry loop while a genuine
   * `upstream_error` / `rate_limited` is retried. Returns an empty result set for
   * 404 (valid query, zero matches) — except a `Nothing to count` 404, which is a
   * fixable count expression, not an empty tally.
   */
  async query<T = Record<string, unknown>>(
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
  ): Promise<OpenFdaResponse<T>> {
    return await withRetry(
      async () => {
        const url = this.buildUrl(endpoint, params);
        ctx.log.debug('Querying openFDA', { endpoint, params });

        // fetchWithTimeout wants a RequestContext (log bindings); carry the
        // correlation id + operation so its logs/metrics join the request trace.
        const requestContext = {
          requestId: ctx.requestId,
          timestamp: ctx.timestamp,
          operation: `openFDA:${endpoint}`,
        };
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
          return this.classifyError<T>(error, endpoint, params, ctx);
        }
      },
      {
        operation: `openFDA:${endpoint}`,
        context: { requestId: ctx.requestId, timestamp: ctx.timestamp },
        baseDelayMs: 1_000,
        signal: ctx.signal,
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
  private classifyError<T>(
    error: unknown,
    endpoint: string,
    params: OpenFdaQueryParams,
    ctx: Context,
  ): OpenFdaResponse<T> {
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
      // Only a count query can produce this marker; keyed on `params.count` so the
      // error can always name the expression it is telling the caller to fix.
      if (params.count && OPENFDA_NOTHING_TO_COUNT.test(body)) {
        throw this.notAggregatableError(endpoint, params.count, ctx);
      }
      return {
        meta: {
          total: 0,
          skip: params.skip ?? 0,
          limit: params.limit ?? 0,
          lastUpdated: this.lastUpdatedByEndpoint.get(endpoint) ?? 'unknown',
        },
        results: [],
      };
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
   * Build the `not_aggregatable` error for a `Nothing to count` 404 — openFDA
   * accepted the query but cannot aggregate the count expression as written.
   * Names the offending expression and, for the dominant `.exact`-on-a-keyword-field
   * case, the exact correction (the bare field, which openFDA already indexes as
   * a keyword). Non-retryable: the same expression fails identically every time.
   */
  private notAggregatableError(endpoint: string, expression: string, ctx: Context): McpError {
    const bare = expression.replace(/\.exact$/, '');
    const correction =
      bare !== expression
        ? `Retry with the bare field "${bare}" — openFDA already indexes it as a keyword, so .exact is redundant and unsupported here.`
        : `Count a keyword field instead; call openfda_describe_fields for ${endpoint} to see the available field paths.`;
    return validationError(
      `openFDA cannot aggregate "${expression}" on ${endpoint}: the field is not countable as written. ${correction}`,
      {
        reason: 'not_aggregatable',
        endpoint,
        count: expression,
        ...ctx.recoveryFor('not_aggregatable'),
      },
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

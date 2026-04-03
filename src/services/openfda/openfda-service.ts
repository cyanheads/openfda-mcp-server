/**
 * @fileoverview Generic openFDA API client with retry, rate-limit awareness, and error normalization.
 * @module services/openfda/openfda-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { rateLimited, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type { OpenFdaQueryParams, OpenFdaResponse } from './types.js';

const REQUEST_TIMEOUT_MS = 15_000;

export class OpenFdaService {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config: ServerConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * Execute a query against any openFDA endpoint.
   *
   * Handles retry with exponential backoff for transient errors (429, 5xx).
   * Returns an empty result set for 404 (valid query, zero matches).
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

        const response = await fetch(url.toString(), {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          headers: { Accept: 'application/json' },
        });

        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;
          return this.normalizeResponse<T>(data);
        }

        return this.handleErrorResponse<T>(response, endpoint);
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

  private normalizeResponse<T>(data: Record<string, unknown>): OpenFdaResponse<T> {
    const meta = data.meta as Record<string, unknown> | undefined;
    const pagination = meta?.results as Record<string, unknown> | undefined;
    return {
      meta: {
        total: (pagination?.total as number) ?? 0,
        skip: (pagination?.skip as number) ?? 0,
        limit: (pagination?.limit as number) ?? 0,
        lastUpdated: (meta?.last_updated as string) ?? 'unknown',
      },
      results: (data.results as T[]) ?? [],
    };
  }

  private async handleErrorResponse<T>(
    response: Response,
    endpoint: string,
  ): Promise<OpenFdaResponse<T>> {
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const errorObj = body?.error as Record<string, unknown> | undefined;
    const errorMessage = (errorObj?.message as string) ?? `HTTP ${response.status}`;

    if (response.status === 404) {
      return {
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: 'unknown' },
        results: [],
      };
    }

    if (response.status === 429) {
      throw rateLimited(
        this.apiKey
          ? 'openFDA rate limit exceeded (240 req/min or 120K/day with key). Retry after a brief wait.'
          : 'openFDA rate limit exceeded (240 req/min or 1K/day without key). Configure OPENFDA_API_KEY to increase to 120K/day.',
      );
    }

    if (response.status >= 500) {
      throw serviceUnavailable(`openFDA upstream error: ${errorMessage}`, {
        endpoint,
        status: response.status,
      });
    }

    if (response.status === 400) {
      if (/25000/i.test(errorMessage)) {
        throw validationError(
          'Pagination limit reached: skip cannot exceed 25000. Narrow the search query with additional filters or date ranges instead of increasing skip.',
          { endpoint },
        );
      }
      throw validationError(
        `openFDA query error: ${errorMessage}. Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.`,
        { endpoint },
      );
    }

    throw new Error(`openFDA returned HTTP ${response.status}: ${errorMessage}`);
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

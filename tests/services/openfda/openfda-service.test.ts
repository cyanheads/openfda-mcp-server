import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records the options the service hands `fetchWithTimeout` so the log-severity
// opt-out (`expectedStatuses`) is assertable — the severity itself is decided
// inside the framework helper, against its module-level logger.
const { fetchOptionsSpy } = vi.hoisted(() => ({ fetchOptionsSpy: vi.fn() }));

// Keep the real `fetchWithTimeout` so classification runs against the actual
// helper (it throws the status-mapped McpError the service reclassifies); only
// collapse `withRetry` to a single attempt so a reclassified error surfaces
// directly instead of retrying against the stubbed fetch.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
    fetchWithTimeout: (...args: Parameters<typeof actual.fetchWithTimeout>) => {
      fetchOptionsSpy(args[3]);
      return actual.fetchWithTimeout(...args);
    },
  };
});

import { OpenFdaService } from '@/services/openfda/openfda-service.js';

describe('OpenFdaService', () => {
  let service: OpenFdaService;
  let ctx: Context;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    fetchOptionsSpy.mockReset();
    service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // `fetchWithTimeout` reads `.text()` + `.headers` on the error path while the
  // service's success path reads `.json()`. Return a re-readable fake (not a real
  // single-use Response) so one stub value can back tests that call query twice.
  function mockResponse(status: number, body: unknown): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(),
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    } as unknown as Response;
  }

  describe('query', () => {
    it('builds URL with all params', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 1, skip: 0, limit: 10 }, last_updated: '2026-01-01' },
          results: [{ id: '1' }],
        }),
      );

      await service.query(
        'drug/event',
        { search: 'aspirin', sort: 'receivedate:desc', limit: 5, skip: 10 },
        ctx,
      );

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/drug/event.json');
      expect(url.searchParams.get('search')).toBe('aspirin');
      expect(url.searchParams.get('sort')).toBe('receivedate:desc');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('skip')).toBe('10');
    });

    it('includes api_key when configured', async () => {
      const serviceWithKey = new OpenFdaService({
        baseUrl: 'https://api.fda.gov',
        apiKey: 'my-key',
      });
      mockFetch.mockResolvedValue(
        mockResponse(200, { meta: { results: {}, last_updated: '' }, results: [] }),
      );

      await serviceWithKey.query('drug/event', {}, ctx);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('api_key')).toBe('my-key');
    });

    it('omits api_key when not configured', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, { meta: { results: {}, last_updated: '' }, results: [] }),
      );

      await service.query('drug/event', {}, ctx);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.has('api_key')).toBe(false);
    });

    it('normalizes successful response', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 42, skip: 5, limit: 10 }, last_updated: '2026-03-01' },
          results: [{ name: 'aspirin' }],
        }),
      );

      const result = await service.query('drug/event', {}, ctx);

      expect(result.meta).toEqual({
        total: 42,
        skip: 5,
        limit: 10,
        lastUpdated: '2026-03-01',
      });
      expect(result.results).toEqual([{ name: 'aspirin' }]);
    });

    it('returns empty results for 404', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      const result = await service.query('drug/event', { search: 'nonexistent' }, ctx);

      expect(result.results).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it('preserves skip/limit from request when 404 returns no matches', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      const result = await service.query('drug/event', { skip: 25000, limit: 10 }, ctx);

      expect(result.meta).toEqual({
        total: 0,
        skip: 25000,
        limit: 10,
        lastUpdated: 'unknown',
      });
    });

    it('falls back to cached lastUpdated on 404 after a prior success on same endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          meta: { results: { total: 100, skip: 0, limit: 1 }, last_updated: '2026-04-28' },
          results: [{ id: '1' }],
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      await service.query('drug/event', { limit: 1 }, ctx);
      const second = await service.query('drug/event', { skip: 25000, limit: 1 }, ctx);

      expect(second.meta.lastUpdated).toBe('2026-04-28');
      expect(second.meta.skip).toBe(25000);
    });

    // #22 — openFDA answers a valid zero-match query with 404. Without the opt-out
    // the framework helper logs every non-2xx at error level, so an expected empty
    // search read as an operational failure in the logs while the tool response was
    // a normal success.
    it('marks 404 as an expected status so a handled no-match is not logged as a fetch error', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      const result = await service.query('drug/drugsfda', { search: 'sponsor_name:"pfizer"' }, ctx);

      expect(result.results).toEqual([]);
      expect(fetchOptionsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ expectedStatuses: [404] }),
      );
    });

    it('classifies off the canonical status/body fields on error.data', async () => {
      // 0.10.15 added Response-aligned `status`/`body` alongside the legacy
      // `statusCode`/`responseBody` aliases. Classification keys on the canonical
      // pair; reading a field the helper does not emit would fall through to the
      // "no HTTP status" branch and rethrow the raw helper error untouched.
      mockFetch.mockResolvedValue(
        mockResponse(400, { error: { message: 'Skip value must 25000 or less.' } }),
      );

      const err = (await service
        .query('drug/event', { skip: 26000 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'pagination_limit_reached' });
      expect(err.message).toMatch(/pagination limit reached/i);
    });

    it('throws McpError on 429', async () => {
      mockFetch.mockResolvedValue(mockResponse(429, { error: { message: 'Too many requests' } }));

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(McpError);
      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/rate limit/i);
    });

    it('throws McpError on 5xx', async () => {
      mockFetch.mockResolvedValue(mockResponse(503, { error: { message: 'Service unavailable' } }));

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(McpError);
      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/upstream/i);
    });

    it('throws McpError on 400', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(400, { error: { message: 'Invalid search syntax' } }),
      );

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(McpError);
      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/query error/i);
    });

    it('throws skip-ceiling error on 400 with 25000 message', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(400, {
          error: { message: 'Skip value must 25000 or less.' },
        }),
      );

      await expect(service.query('drug/event', { skip: 26000 }, ctx)).rejects.toThrow(
        /pagination limit/i,
      );
    });

    it('throws Unauthorized McpError on 401', async () => {
      mockFetch.mockResolvedValue(mockResponse(401, { error: { message: 'Unauthorized' } }));

      const err = await service.query('drug/event', {}, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      // Code -32006 = Unauthorized
      expect(mcpErr.code).toBe(-32006);
      expect(mcpErr.data).toMatchObject({ reason: 'unauthorized' });
    });

    it('throws Forbidden McpError on 403', async () => {
      mockFetch.mockResolvedValue(mockResponse(403, { error: { message: 'Forbidden' } }));

      const err = await service.query('drug/event', {}, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      // Code -32005 = Forbidden
      expect(mcpErr.code).toBe(-32005);
      expect(mcpErr.data).toMatchObject({ reason: 'forbidden' });
    });

    it('401/403 errors are non-transient — withRetry would not retry them', async () => {
      // withRetry only retries McpError with codes RateLimited(-32003), ServiceUnavailable(-32000),
      // or Timeout(-32004). Unauthorized(-32006) and Forbidden(-32005) are outside that set.
      // Verify the thrown error codes are correct so the caller (withRetry) won't retry.
      const TRANSIENT_CODES = new Set([-32000, -32003, -32004]);

      mockFetch.mockResolvedValue(mockResponse(401, { error: { message: 'Unauthorized' } }));
      const err401 = (await service
        .query('drug/event', {}, ctx)
        .catch((e: unknown) => e)) as McpError;
      expect(TRANSIENT_CODES.has(err401.code)).toBe(false);

      mockFetch.mockReset();
      mockFetch.mockResolvedValue(mockResponse(403, { error: { message: 'Forbidden' } }));
      const err403 = (await service
        .query('drug/event', {}, ctx)
        .catch((e: unknown) => e)) as McpError;
      expect(TRANSIENT_CODES.has(err403.code)).toBe(false);
    });

    it('throws a typed McpError on an unexpected status', async () => {
      mockFetch.mockResolvedValue(mockResponse(418, { error: { message: "I'm a teapot" } }));

      const err = await service.query('drug/event', {}, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toMatch(/418/);
    });
  });

  describe('5xx query-error reclassification (#14, #23)', () => {
    // withRetry retries only ServiceUnavailable(-32000), RateLimited(-32003), and
    // Timeout(-32004). A reclassified query_error (ValidationError -32007) is
    // outside that set, so it fails fast instead of retrying a deterministic
    // upstream parse failure.
    const TRANSIENT_CODES = new Set([-32000, -32003, -32004]);

    // Verbatim openFDA 500 body for a malformed search (unbalanced quote).
    const PARSER_500 = JSON.stringify({
      error: {
        code: 'SERVER_ERROR',
        message: 'Check your request and try again',
        details:
          '[token_mgr_error] token_mgr_error: Lexical error at line 1, column 39.  Encountered: <EOF> after : "\\"aspirin"',
      },
    });
    // Verbatim openFDA 500 body for a count on a non-keyword text field.
    const AGGREGATION_500 = JSON.stringify({
      error: {
        code: 'SERVER_ERROR',
        message: 'Check your request and try again',
        details:
          '[illegal_argument_exception] Text fields are not optimised for operations that require per-document field data like aggregations and sorting, so these operations are disabled by default. Please use a keyword field instead.',
      },
    });
    // Verbatim openFDA 500 body for a sort/filter on a field absent from the
    // index mapping — e.g. receivedate:desc on the food/device event indices,
    // which lack the field. Deterministic and user-fixable, never a real outage.
    const SHARD_500 = JSON.stringify({
      error: {
        code: 'SERVER_ERROR',
        message: 'Check your request and try again',
        details:
          '[query_shard_exception] No mapping found for [receivedate] in order to sort on, index="foodevent"',
      },
    });

    it('reclassifies a malformed-search 500 as a non-retryable query_error', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, PARSER_500));

      const err = (await service
        .query('drug/event', { search: 'patient.drug.medicinalproduct:"aspirin' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({ reason: 'query_error' });
      expect(err.code).toBe(-32007); // ValidationError
      expect(TRANSIENT_CODES.has(err.code)).toBe(false);
      expect(err.message).toMatch(/lexical error/i); // parser detail preserved
    });

    it('reclassifies a count-on-non-keyword 500 as a non-retryable query_error (count_values case)', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, AGGREGATION_500));

      const err = (await service
        .query('device/classification', { count: 'device_class' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'query_error' });
      expect(err.code).toBe(-32007);
      expect(TRANSIENT_CODES.has(err.code)).toBe(false);
      expect(err.message).toMatch(/keyword field/i); // openFDA's fix hint preserved
    });

    it('reclassifies an unmapped-sort 500 (query_shard_exception) as a non-retryable query_error', async () => {
      // A food/device query sorted by receivedate (a drug-only field) returns
      // HTTP 500 query_shard_exception. Without this marker it fell through to the
      // generic 5xx branch and advised a retry that can never succeed (#23).
      mockFetch.mockResolvedValue(mockResponse(500, SHARD_500));

      const err = (await service
        .query('food/event', { sort: 'receivedate:desc' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({ reason: 'query_error' });
      expect(err.code).toBe(-32007); // ValidationError
      expect(TRANSIENT_CODES.has(err.code)).toBe(false);
      expect(err.message).toMatch(/no mapping found for \[receivedate\]/i); // shard detail preserved
    });

    // #33 — openFDA returns parse_exception for grammar failures the tokenizer
    // accepts: unbalanced brackets/parens, a dangling AND/OR, a half-open range,
    // and a bare _exists_:. Without the marker these classified as retryable
    // upstream_error — four requests and ~9s of backoff on a query that can never
    // succeed, plus a recovery hint telling the agent to check api.fda.gov status.
    const parseException = (detail: string) =>
      JSON.stringify({
        error: {
          code: 'SERVER_ERROR',
          message: 'Check your request and try again',
          details: detail,
        },
      });

    const PARSE_EXCEPTION_QUERIES: Array<[string, string]> = [
      [
        '(patient.drug.medicinalproduct:"aspirin"',
        '[parse_exception] parse_exception: Encountered "<EOF>" at line 1, column 29. Was expecting one of: <AND> ... <OR> ...',
      ],
      [
        'openfda.brand_name:[[[',
        '[parse_exception] parse_exception: Encountered "[" at line 1, column 21.',
      ],
      [
        'recalling_firm:"pfizer" AND',
        '[parse_exception] parse_exception: Encountered "<EOF>" at line 1, column 27.',
      ],
      [
        'effective_time:[20200101 TO]',
        '[parse_exception] parse_exception: Encountered "]" at line 1, column 28.',
      ],
      ['_exists_:', '[parse_exception] parse_exception: Encountered "<EOF>" at line 1, column 9.'],
    ];

    it.each(PARSE_EXCEPTION_QUERIES)(
      'reclassifies the parse_exception 500 for %s as a non-retryable query_error',
      async (search, detail) => {
        mockFetch.mockResolvedValue(mockResponse(500, parseException(detail)));

        const err = (await service
          .query('drug/event', { search }, ctx)
          .catch((e: unknown) => e)) as McpError;

        expect(err).toBeInstanceOf(McpError);
        expect(err.data).toMatchObject({ reason: 'query_error' });
        expect(err.code).toBe(-32007); // ValidationError
        expect(TRANSIENT_CODES.has(err.code)).toBe(false);
        expect(err.message).toMatch(/parse_exception/i);
        expect(err.message).toMatch(/line 1, column/i); // parser location preserved
        expect(err.message).toMatch(/query syntax/i); // query-syntax recovery guidance attached
      },
    );

    it('leaves a marker-free 500 as a retryable upstream_error', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(500, { error: { message: 'Internal server error' } }),
      );

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'upstream_error' });
      expect(err.code).toBe(-32000); // ServiceUnavailable
      expect(TRANSIENT_CODES.has(err.code)).toBe(true);
    });

    it('leaves a generic-message 500 with no specific marker as a retryable upstream_error', async () => {
      // openFDA's generic SERVER_ERROR wrapper carries "Check your request and try again"
      // on every application-level failure, including transient ES conditions. Without a
      // specific Lucene/ES exception marker it is indistinguishable from a recoverable
      // outage, so it must stay retryable rather than pinning as a query_error.
      mockFetch.mockResolvedValue(
        mockResponse(500, {
          error: { code: 'SERVER_ERROR', message: 'Check your request and try again' },
        }),
      );

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'upstream_error' });
      expect(err.code).toBe(-32000); // ServiceUnavailable
      expect(TRANSIENT_CODES.has(err.code)).toBe(true);
    });

    it('leaves a gateway 502 with no openFDA error body as a retryable upstream_error', async () => {
      mockFetch.mockResolvedValue(mockResponse(502, '<html>502 Bad Gateway</html>'));

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'upstream_error' });
      expect(err.code).toBe(-32000);
      expect(TRANSIENT_CODES.has(err.code)).toBe(true);
    });
  });

  // #34 — openFDA answers a count query with two distinguishable 404s. Collapsing
  // both into an empty tally left the agent no signal to fix the expression.
  describe('404 disambiguation for count queries (#34)', () => {
    const notFound404 = (message: string) =>
      JSON.stringify({ error: { code: 'NOT_FOUND', message } });

    it('raises a non-retryable not_aggregatable error for a "Nothing to count" 404', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, notFound404('Nothing to count.')));

      const err = (await service
        .query('drug/ndc', { count: 'product_ndc.exact', limit: 2 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(-32007); // ValidationError — outside withRetry's transient set
      expect(err.data).toMatchObject({
        reason: 'not_aggregatable',
        endpoint: 'drug/ndc',
        count: 'product_ndc.exact',
      });
      expect(err.message).toContain('product_ndc.exact');
      expect(err.message).toContain('"product_ndc"'); // the bare-field correction
    });

    it('points at a keyword field when the unaggregatable expression carries no .exact suffix', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, notFound404('Nothing to count.')));

      const err = (await service
        .query('drug/event', { count: 'patient.patientonsetage' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(err.message).toMatch(/openfda_describe_fields/);
    });

    it('keeps a "No matches found!" 404 an empty result, not an error', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, notFound404('No matches found!')));

      const result = await service.query(
        'drug/ndc',
        { count: 'dosage_form.exact', search: 'brand_name:"zzzzznotarealdrug"', limit: 2 },
        ctx,
      );

      expect(result.results).toEqual([]);
      expect(result.meta.total).toBe(0);
    });
  });
});

describe('getOpenFdaService', () => {
  it('throws when not initialized', async () => {
    vi.resetModules();
    const { getOpenFdaService: fresh } = await import('@/services/openfda/openfda-service.js');
    expect(() => fresh()).toThrow(/not initialized/);
  });
});

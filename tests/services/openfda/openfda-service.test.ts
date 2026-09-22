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

      const url = new URL(mockFetch.mock.calls[0]![0]);
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

      const url = new URL(mockFetch.mock.calls[0]![0]);
      expect(url.searchParams.get('api_key')).toBe('my-key');
    });

    it('omits api_key when not configured', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, { meta: { results: {}, last_updated: '' }, results: [] }),
      );

      await service.query('drug/event', {}, ctx);

      const url = new URL(mockFetch.mock.calls[0]![0]);
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
      // The total-recovery request for the past-end page (#47) — also a miss.
      mockFetch.mockResolvedValueOnce(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      await service.query('drug/event', { limit: 1 }, ctx);
      const second = await service.query('drug/event', { skip: 25000, limit: 1 }, ctx);

      expect(second.meta.lastUpdated).toBe('2026-04-28');
      expect(second.meta.skip).toBe(25000);
    });

    /*
     * #47 — openFDA answers a page past the end of a matched set with the same
     * `No matches found!` 404 as a query that matched nothing. At skip > 0 the
     * service asks for the total once (`skip=0&limit=0`, no sort), best-effort.
     */
    describe('past-end total recovery', () => {
      const NO_MATCHES = () =>
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } });
      const SEARCH = 'openfda.generic_name:"metformin"';
      const calledUrl = (index: number) => new URL(mockFetch.mock.calls[index]![0]);

      it('recovers the real total for a page past the end of the matched set', async () => {
        mockFetch.mockResolvedValueOnce(NO_MATCHES());
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            meta: { results: { skip: 0, limit: 0, total: 39 }, last_updated: '2026-09-17' },
            results: [],
          }),
        );

        const result = await service.query(
          'drug/enforcement',
          { search: SEARCH, sort: 'report_date:desc', limit: 1, skip: 39 },
          ctx,
        );

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const recovery = calledUrl(1);
        expect(recovery.pathname).toBe('/drug/enforcement.json');
        expect(recovery.searchParams.get('search')).toBe(SEARCH);
        expect(recovery.searchParams.get('skip')).toBe('0');
        expect(recovery.searchParams.get('limit')).toBe('0');
        expect(recovery.searchParams.has('sort')).toBe(false);
        expect(result).toEqual({
          meta: { total: 39, skip: 39, limit: 1, lastUpdated: '2026-09-17' },
          results: [],
        });
      });

      it('settles a genuine zero-match at skip > 0 with exactly one extra request', async () => {
        mockFetch.mockResolvedValue(NO_MATCHES());

        const result = await service.query(
          'drug/enforcement',
          { search: 'openfda.generic_name:"zzznotadrugzzz"', limit: 1, skip: 5 },
          ctx,
        );

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result.meta).toEqual({ total: 0, skip: 5, limit: 1, lastUpdated: 'unknown' });
      });

      it('returns the empty page marked unverified when the recovery request fails', async () => {
        mockFetch.mockResolvedValueOnce(NO_MATCHES());
        mockFetch.mockResolvedValueOnce(
          mockResponse(503, '<html><body>503 Service Temporarily Unavailable</body></html>'),
        );

        const result = await service.query(
          'drug/enforcement',
          { search: SEARCH, limit: 1, skip: 39 },
          ctx,
        );

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
          meta: { total: 0, skip: 39, limit: 1, lastUpdated: 'unknown', totalUnverified: true },
          results: [],
        });
      });

      it('makes no extra request for a 404 at skip=0', async () => {
        mockFetch.mockResolvedValue(NO_MATCHES());

        await service.query('drug/enforcement', { search: SEARCH, limit: 1, skip: 0 }, ctx);

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('makes no extra request for a count query that matched nothing', async () => {
        mockFetch.mockResolvedValue(NO_MATCHES());

        const result = await service.query(
          'drug/event',
          { search: SEARCH, count: 'serious', limit: 3 },
          ctx,
        );

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.meta.total).toBe(0);
      });
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

    // #40 — a count on an analyzed text field is the `.exact`-missing case, not a
    // syntax error: the field name is already right. It reaches the caller as
    // not_aggregatable naming <field>.exact, and the surviving upstream advice
    // (fielddata=true, a server-side index setting) is dropped.
    // An expression outside the field catalog has no verified form, so the
    // correction stays hedged (#49 makes cataloged fields definitive).
    it('routes a count-on-analyzed-text 500 to not_aggregatable naming the .exact subfield', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, AGGREGATION_500));

      const err = (await service
        .query('device/classification', { count: 'review_panel' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({
        reason: 'not_aggregatable',
        endpoint: 'device/classification',
        count: 'review_panel',
      });
      expect(err.code).toBe(-32007); // ValidationError — outside withRetry's transient set
      expect(TRANSIENT_CODES.has(err.code)).toBe(false);
      expect(err.message).toContain('"review_panel.exact"'); // the add-suffix correction
      expect(err.message).toMatch(/analyzed text field/i);
      expect(err.message).not.toMatch(/fielddata/i); // unreachable server-side advice dropped
      // Not every analyzed field has a keyword subfield: `reason_for_recall.exact`
      // on drug/enforcement answers `Nothing to count`, whose own correction is to
      // drop the suffix. Naming the catalog is what stops the two hints bouncing a
      // caller between them.
      expect(err.message).toMatch(/nothing to count/i);
      expect(err.message).toMatch(/openfda_describe_fields for device\/classification/);
    });

    // Without a count, the same exception is not the .exact case — it stays a
    // generic query_error carrying the upstream detail.
    it('keeps an illegal_argument_exception 500 a query_error when the query has no count', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, AGGREGATION_500));

      const err = (await service
        .query('device/classification', { search: 'device_class:"2"' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'query_error' });
      expect(err.code).toBe(-32007);
      expect(err.message).toMatch(/keyword field/i); // openFDA's own text preserved
    });

    it('points at a keyword field rather than doubling .exact when the count already carries it', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, AGGREGATION_500));

      const err = (await service
        .query('drug/enforcement', { count: 'openfda.brand_name.exact' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(err.message).toMatch(/openfda_describe_fields/);
      expect(err.message).not.toContain('.exact.exact');
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

    // Uncataloged expression, unscoped: the hedged drop-suffix correction (#34/#40).
    it('raises a non-retryable not_aggregatable error for a "Nothing to count" 404', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, notFound404('Nothing to count.')));

      const err = (await service
        .query('drug/ndc', { count: 'packaging.package_ndc.exact', limit: 2 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(-32007); // ValidationError — outside withRetry's transient set
      expect(err.data).toMatchObject({
        reason: 'not_aggregatable',
        endpoint: 'drug/ndc',
        count: 'packaging.package_ndc.exact',
      });
      expect(err.message).toContain('packaging.package_ndc.exact');
      expect(err.message).toContain('"packaging.package_ndc"'); // the bare-field correction
      // The drop-suffix correction is the dominant case, not a certainty: on
      // drug/enforcement, `reason_for_recall` answers the 5xx and
      // `reason_for_recall.exact` answers this 404, so each direction's fix is the
      // other's failure. Naming the catalog is what stops the two hints looping.
      expect(err.message).toMatch(/openfda_describe_fields for drug\/ndc/);
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
      expect(result.meta.nothingToCount).toBeUndefined();
    });
  });

  // #49 — for a cataloged field the correction is the live-verified expression, so
  // the two hedged hints can no longer bounce a caller between two failing forms.
  describe('not_aggregatable from the field catalog (#49)', () => {
    const NOTHING_TO_COUNT_404 = JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'Nothing to count' },
    });
    const AGGREGATION_500 = JSON.stringify({
      error: {
        code: 'SERVER_ERROR',
        message: 'Check your request and try again',
        details:
          '[illegal_argument_exception] Text fields are not optimised for operations that require per-document field data like aggregations and sorting, so these operations are disabled by default. Please use a keyword field instead. Alternatively, set fielddata=true on [device_class] in order to load field data by uninverting the inverted index. Note that this can use significant memory.',
      },
    });
    const failure = (endpoint: string, count: string, search?: string) =>
      service
        .query(endpoint, { count, limit: 10, ...(search ? { search } : {}) }, ctx)
        .catch((e: unknown) => e) as Promise<McpError>;

    it.each([
      ['bare (5xx)', 'device_class', AGGREGATION_500, 500],
      ['.exact (404)', 'device_class.exact', NOTHING_TO_COUNT_404, 404],
    ])('says a field with no countable form has none — %s', async (_label, count, body, status) => {
      mockFetch.mockResolvedValue(mockResponse(status, body));

      const err = await failure('device/classification', count, 'product_code:"DXN"');

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(-32007);
      expect(err.data).toMatchObject({
        reason: 'not_aggregatable',
        endpoint: 'device/classification',
        count,
      });
      expect(err.message).toMatch(/"device_class" has no countable form/);
      // Neither suffix direction is offered — both are recorded as failing. (The
      // message echoes the caller's own expression once; nothing else names a form.)
      expect(err.message.replace(`"${count}"`, '')).not.toContain('"device_class.exact"');
      expect(err.message).not.toMatch(/retry with/i);
      expect(err.message).not.toMatch(/fielddata/i);
      expect(err.message).toContain('medical_specialty_description.exact');
      const hint = (err.data as { recovery?: { hint?: string } }).recovery?.hint ?? '';
      expect(hint).not.toMatch(/add \.exact|drop \.exact/i);
      expect(hint).toMatch(/openfda_describe_fields/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('names the recorded .exact form for a bare analyzed field', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, AGGREGATION_500));

      const err = await failure('drug/enforcement', 'classification');

      expect(err.data).toMatchObject({ reason: 'not_aggregatable', count: 'classification' });
      expect(err.message).toContain('Count "classification.exact" instead');
      expect(err.message).not.toMatch(/if that reports nothing to count/i);
      expect(err.message).not.toMatch(/fielddata/i);
      const hint = (err.data as { recovery?: { hint?: string } }).recovery?.hint ?? '';
      expect(hint).toContain('classification.exact');
    });

    it('names the recorded bare form for .exact on a keyword field', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const err = await failure('drug/ndc', 'product_ndc.exact');

      expect(err.data).toMatchObject({ reason: 'not_aggregatable', count: 'product_ndc.exact' });
      expect(err.message).toContain('Count "product_ndc" instead');
      expect(err.message).not.toMatch(/if the bare field fails too/i);
    });

    // The catalog records `classification.exact` as countable, so a 5xx on it means
    // openFDA's mapping moved — the hedged message is the honest fallback.
    it('falls back to the hedged message when a recorded form itself fails', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, AGGREGATION_500));

      const err = await failure('drug/enforcement', 'classification.exact');

      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(err.message).toMatch(/openfda_describe_fields/);
      expect(err.message).not.toContain('.exact.exact');
    });
  });

  // #57 — `Nothing to count` is data-level: a countable expression answers it when
  // the search matched only records that carry no value for the field.
  describe('"Nothing to count" on a countable expression (#57)', () => {
    const NOTHING_TO_COUNT_404 = JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'Nothing to count' },
    });
    const TALLY_200 = {
      meta: { results: {}, last_updated: '2026-09-18' },
      results: [{ term: 'LEVOTHYROXINE SODIUM', count: 431 }],
    };

    it('returns an empty tally for a cataloged countable expression, without a second request', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const result = await service.query(
        'drug/enforcement',
        { count: 'classification.exact', search: '_missing_:classification', limit: 5 },
        ctx,
      );

      expect(result.results).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.nothingToCount).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns an empty tally for either form of a field that counts both ways', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const result = await service.query(
        'device/udi',
        { count: 'product_codes.code', search: '_missing_:product_codes.code', limit: 5 },
        ctx,
      );

      expect(result.meta.nothingToCount).toBe(true);
    });

    it('confirms an uncataloged expression unscoped, then returns an empty tally', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(404, NOTHING_TO_COUNT_404))
        .mockResolvedValueOnce(mockResponse(200, TALLY_200));

      const result = await service.query(
        'drug/enforcement',
        {
          count: 'openfda.generic_name.exact',
          search: '_missing_:openfda.generic_name',
          limit: 5,
        },
        ctx,
      );

      expect(result.results).toEqual([]);
      expect(result.meta.nothingToCount).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const confirm = new URL(mockFetch.mock.calls[1]![0]);
      expect(confirm.searchParams.get('count')).toBe('openfda.generic_name.exact');
      expect(confirm.searchParams.has('search')).toBe(false);
      expect(confirm.searchParams.get('limit')).toBe('1');
    });

    it('keeps the hedged not_aggregatable when the unscoped confirm has nothing to count too', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const err = (await service
        .query('drug/enforcement', { count: 'city.exact', search: 'state:"IL"', limit: 5 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(-32007);
      expect(err.data).toMatchObject({
        reason: 'not_aggregatable',
        endpoint: 'drug/enforcement',
        count: 'city.exact',
      });
      expect(err.message).toContain('"city"'); // #40's drop-suffix correction
      expect(err.message).not.toContain('.exact.exact');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not confirm an uncataloged expression when the count was already unscoped', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const err = (await service
        .query('drug/enforcement', { count: 'city.exact' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Unscoped there is no search to blame: a recorded-countable expression that
    // has nothing to count means openFDA remapped the index, which must surface.
    it('fails a cataloged countable expression that has nothing to count unscoped', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const err = (await service
        .query('drug/enforcement', { count: 'classification.exact', limit: 5 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(err.message).toMatch(/openfda_describe_fields/);
      expect(err.message).not.toContain('.exact.exact');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('still fails a cataloged field with no countable form under a search', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NOTHING_TO_COUNT_404));

      const err = (await service
        .query(
          'drug/enforcement',
          { count: 'reason_for_recall.exact', search: 'state:"IL"', limit: 5 },
          ctx,
        )
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(err.message).toMatch(/has no countable form/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // openFDA answers a search that matched nothing with `No matches found!` before
  // it looks at the count expression, so an expression the catalog records as
  // failing reaches that 404 too. An empty tally there would read as "countable,
  // nothing matched" and send the caller to broaden a search that can never count.
  describe('"No matches found!" on an expression the catalog records as failing', () => {
    const NO_MATCHES_404 = JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'No matches found!' },
    });

    it('raises not_aggregatable for a field with no countable form', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NO_MATCHES_404));

      const err = (await service
        .query(
          'device/classification',
          { count: 'device_class.exact', search: 'product_code:"ZZZQQ"', limit: 3 },
          ctx,
        )
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({ reason: 'not_aggregatable', count: 'device_class.exact' });
      expect(err.message).toMatch(/"device_class" has no countable form/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('raises not_aggregatable naming the recorded form for the other suffix', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NO_MATCHES_404));

      const err = (await service
        .query(
          'drug/ndc',
          { count: 'product_ndc.exact', search: 'brand_name:"zzznotadrugzzz"', limit: 3 },
          ctx,
        )
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'not_aggregatable', count: 'product_ndc.exact' });
      expect(err.message).toContain('Count "product_ndc" instead');
    });

    it('keeps the empty tally for a recorded countable expression', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, NO_MATCHES_404));

      const result = await service.query(
        'drug/ndc',
        { count: 'product_ndc', search: 'brand_name:"zzznotadrugzzz"', limit: 3 },
        ctx,
      );

      expect(result.results).toEqual([]);
      expect(result.meta.nothingToCount).toBeUndefined();
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

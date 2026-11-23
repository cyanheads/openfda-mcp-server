import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records the options the service hands `fetchWithTimeout` so the log-severity
// opt-out (`expectedStatuses`) is assertable — the severity itself is decided
// inside the framework helper, against its module-level logger.
const { fetchOptionsSpy, singleAttempt } = vi.hoisted(() => ({
  fetchOptionsSpy: vi.fn(),
  singleAttempt: (
    fn: (attempt: { signal: AbortSignal; remainingMs: number }) => Promise<unknown>,
  ) => fn({ signal: new AbortController().signal, remainingMs: Number.POSITIVE_INFINITY }),
}));

// Keep the real `fetchWithTimeout` so classification runs against the actual
// helper (it throws the status-mapped McpError the service reclassifies); only
// collapse `withRetry` to a single attempt so a reclassified error surfaces
// directly instead of retrying against the stubbed fetch. The deadline suite
// below restores the real `withRetry`, whose clock is what it tests.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    withRetry: vi.fn(singleAttempt),
    fetchWithTimeout: (...args: Parameters<typeof actual.fetchWithTimeout>) => {
      fetchOptionsSpy(args[3]);
      return actual.fetchWithTimeout(...args);
    },
  };
});

import { countVerdict } from '@/mcp-server/tools/field-catalog.js';
import {
  OPENFDA_CALL_DEADLINE_MS,
  OpenFdaService,
  searchAfterOfNextLink,
} from '@/services/openfda/openfda-service.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

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
  // service's success path reads `.json()` and the `Link` header. Return a
  // re-readable fake (not a real single-use Response) so one stub value can back
  // tests that call query twice.
  function mockResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(headers),
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
      expect(url.searchParams.get('search')).toBe('(aspirin)');
      expect(url.searchParams.get('sort')).toBe('receivedate:desc');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('skip')).toBe('10');
    });

    /*
     * #84 — on the enforcement endpoints openFDA appends its own product-type
     * clause to `search`, and a top-level `A OR B` then matches only `B`
     * (food/enforcement `cheese OR milk`: 1,675 against a 3,141 union). The
     * service sends every search grouped, so OR is a union on every endpoint.
     */
    describe('search grouping (#84)', () => {
      const OK = () =>
        mockResponse(200, {
          meta: { results: { total: 1, skip: 0, limit: 1 }, last_updated: '2026-01-01' },
          results: [{ id: '1' }],
        });
      const sent = () => new URL(mockFetch.mock.calls[0]![0]);

      it('sends a top-level OR inside one pair of parentheses', async () => {
        mockFetch.mockResolvedValue(OK());
        const search = 'product_description:"cheese" OR product_description:"milk"';

        await service.query('food/enforcement', { search, limit: 1 }, ctx);

        expect(sent().searchParams.get('search')).toBe(`(${search})`);
      });

      it.each([
        ['(a:x) OR (b:y)', '((a:x) OR (b:y))'],
        ['(a:x OR b:y)', '((a:x OR b:y))'],
        ['field:(a OR b)', '(field:(a OR b))'],
      ])(
        'wraps %j once, even when it already starts and ends with a paren',
        async (search, wire) => {
          mockFetch.mockResolvedValue(OK());

          await service.query('drug/enforcement', { search }, ctx);

          expect(sent().searchParams.get('search')).toBe(wire);
        },
      );

      it('wraps the search of a count request and leaves the count expression alone', async () => {
        mockFetch.mockResolvedValue(
          mockResponse(200, {
            meta: { last_updated: '2026-01-01' },
            results: [{ term: 'Class II', count: 1 }],
          }),
        );

        await service.query(
          'food/enforcement',
          { search: 'a:x OR b:y', count: 'classification.exact' },
          ctx,
        );

        expect(sent().searchParams.get('search')).toBe('(a:x OR b:y)');
        expect(sent().searchParams.get('count')).toBe('classification.exact');
      });

      it('sends no search parameter when the query has none', async () => {
        mockFetch.mockResolvedValue(OK());

        await service.query('drug/event', { count: 'serious' }, ctx);

        expect(sent().searchParams.has('search')).toBe(false);
      });

      // A space goes out as `+` (openFDA reads a space) and a literal plus as
      // `%2B` (openFDA reads a plus), with the parentheses percent-encoded.
      it('form-encodes the grouped search: a space as +, a plus as %2B', async () => {
        mockFetch.mockResolvedValue(OK());

        await service.query('device/udi', { search: 'brand_name.exact:"Bausch + Lomb"' }, ctx);

        expect(sent().search).toContain('search=%28brand_name.exact%3A%22Bausch+%2B+Lomb%22%29');
      });
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
        expect(recovery.searchParams.get('search')).toBe(`(${SEARCH})`);
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

    // The retry ladder honors `data.retryAfter`, so the rate-limit error keeps it.
    it('carries openFDA’s Retry-After on the rate-limit error', async () => {
      mockFetch.mockResolvedValue({
        ...mockResponse(429, { error: { message: 'Too many requests' } }),
        headers: new Headers({ 'retry-after': '30' }),
      });

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;
      expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '30' });
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

    // A search_after cursor reads past the ceiling too (#97), so the way past it
    // is each tool's declared recovery, not this shared message.
    it('states the skip ceiling as a fact, with no inline route past it', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(400, {
          error: { code: 'BAD_REQUEST', message: 'Skip value must 25000 or less.' },
        }),
      );

      const err = (await service
        .query('drug/event', { skip: 26000 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.message).toBe('Pagination limit reached: skip cannot exceed 25000.');
      expect(err.data).toMatchObject({
        reason: 'pagination_limit_reached',
        endpoint: 'drug/event',
      });
      expect(err.data).not.toHaveProperty('recovery');
    });

    it('keeps a 400 that only echoes 25000 inside the query a query error', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(400, {
          error: {
            code: 'BAD_REQUEST',
            message: 'Search not supported: (patient.patientweight:25000;)',
          },
        }),
      );

      const err = (await service
        .query('drug/event', { search: 'patient.patientweight:25000;' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'query_error' });
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

    // The framework keeps the captured upstream body off the client envelope, so
    // the pass-through error carries openFDA's own reason in its message instead.
    it('carries the openFDA error text in the message of an unexpected-status error', async () => {
      mockFetch.mockResolvedValue(mockResponse(418, { error: { message: "I'm a teapot" } }));

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;
      expect(err.message).toBe("openFDA returned HTTP 418: I'm a teapot");
      expect(err.data).toMatchObject({ status: 418 });
    });

    // A proxy in front of openFDA answers some failures with an HTML page: its
    // markup is no reason, so the message keeps the page's title or the status.
    it('names an HTML error page by its title, never its markup', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(
          414,
          '<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>',
        ),
      );

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;
      expect(err.message).toBe('openFDA returned HTTP 414: 414 Request-URI Too Large');
    });

    it('falls back to the status for an HTML error page with no title', async () => {
      mockFetch.mockResolvedValue(mockResponse(502, '<html>502 Bad Gateway</html>'));

      const err = (await service.query('drug/event', {}, ctx).catch((e: unknown) => e)) as McpError;
      expect(err.message).toBe('openFDA upstream error: HTTP 502');
    });
  });

  /*
   * #103 — openFDA HTML-escapes the `error.message` it sends (`"` `&` `<` `>`
   * `'` as `&quot;` `&amp;` `&lt;` `&gt;` `&#39;`), so the query it echoes there
   * comes back mangled. `error.details` on a 5xx is sent unescaped.
   */
  describe('upstream message entities (#103)', () => {
    const failure = async (status: number, body: unknown) => {
      mockFetch.mockResolvedValue(mockResponse(status, body));
      return (await service
        .query('drug/ndc', { search: 'brand_name:x' }, ctx)
        .catch((e: unknown) => e)) as McpError;
    };
    const QUERY_ERROR_TAIL =
      'Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.';

    it('decodes the five escapes in a 400 message, giving back the query as sent', async () => {
      const err = await failure(400, {
        error: {
          code: 'BAD_REQUEST',
          message:
            'Search not supported: (brand_name:&quot;a &amp; b &lt; c &gt; d &#39; e&quot; ;)',
        },
      });

      expect(err.data).toMatchObject({ reason: 'query_error' });
      expect(err.message).toBe(
        `openFDA query error: Search not supported: (brand_name:"a & b < c > d ' e" ;). ${QUERY_ERROR_TAIL}`,
      );
    });

    // The caller's own `&amp;` comes back `&amp;amp;`: one pass restores it, a second would not.
    it('decodes in one pass, so entity text in the query survives as written', async () => {
      const err = await failure(400, {
        error: {
          code: 'BAD_REQUEST',
          message: 'Search not supported: (brand_name:&quot;x &amp;amp; y &amp;#39; z&quot;)',
        },
      });

      expect(err.message).toBe(
        `openFDA query error: Search not supported: (brand_name:"x &amp; y &#39; z"). ${QUERY_ERROR_TAIL}`,
      );
    });

    it('leaves a 5xx details string exactly as openFDA sent it', async () => {
      const details =
        '[parse_exception] parse_exception: Encountered " "-" "- "" at line 1, column 23. Was expecting &lt;x&gt; &amp; "y"';
      const err = await failure(500, {
        error: { code: 'SERVER_ERROR', message: 'Check your request and try again', details },
      });

      expect(err.data).toMatchObject({ reason: 'query_error' });
      expect(err.message).toBe(`openFDA query error: ${details}. ${QUERY_ERROR_TAIL}`);
    });

    it('decodes the message of a 5xx that carries no details', async () => {
      const err = await failure(503, {
        error: { message: 'Index &quot;drugndc&quot; unavailable' },
      });

      expect(err.data).toMatchObject({ reason: 'upstream_error' });
      expect(err.message).toBe('openFDA upstream error: Index "drugndc" unavailable');
    });

    it('decodes the message of an unexpected status', async () => {
      const err = await failure(418, { error: { message: 'I&#39;m a teapot &amp; a kettle' } });

      expect(err.message).toBe("openFDA returned HTTP 418: I'm a teapot & a kettle");
    });

    it('keeps a raw, non-JSON body as sent', async () => {
      const err = await failure(503, 'upstream said &quot;no&quot;');

      expect(err.message).toBe('openFDA upstream error: upstream said &quot;no&quot;');
    });
  });

  /*
   * An error body off openFDA's `{ error: { message, details } }` shape — a
   * field of another type, a bare `error` string, JSON that is no object — is
   * classified by its status as any other, and its message is the raw body.
   */
  describe('error bodies off the expected shape', () => {
    const failure = async (status: number, body: string) => {
      mockFetch.mockResolvedValue(mockResponse(status, body));
      return (await service
        .query('drug/ndc', { search: 'brand_name:x' }, ctx)
        .catch((e: unknown) => e)) as McpError;
    };
    const TAIL =
      'Check field names and query syntax — use AND/OR for boolean operators, quotes for exact match.';

    const OFF_SHAPE: Array<[string, string]> = [
      ['error.message an object', '{"error":{"code":"BAD_REQUEST","message":{"text":"x"}}}'],
      ['error.message an array', '{"error":{"code":"BAD_REQUEST","message":["a","b"]}}'],
      ['error.message a number', '{"error":{"code":"BAD_REQUEST","message":42}}'],
      ['error.message null', '{"error":{"code":"BAD_REQUEST","message":null}}'],
      [
        'error.details an object beside a string message',
        '{"error":{"message":"m","details":{"x":1}}}',
      ],
      ['error a string', '{"error":"Search not supported"}'],
      ['a JSON string', '"Search not supported"'],
      ['a JSON number', '42'],
      ['JSON null', 'null'],
      ['a JSON array', '[{"error":{"message":"x"}}]'],
    ];

    it.each(OFF_SHAPE)(
      'a 400 with %s is a query_error carrying the raw body',
      async (_label, body) => {
        const err = await failure(400, body);

        expect(err).toBeInstanceOf(McpError);
        expect(err.data).toMatchObject({ reason: 'query_error' });
        expect(err.message).toBe(`openFDA query error: ${body}. ${TAIL}`);
      },
    );

    it.each(OFF_SHAPE)(
      'a 500 with %s is an upstream_error carrying the raw body',
      async (_label, body) => {
        const err = await failure(500, body);

        expect(err).toBeInstanceOf(McpError);
        expect(err.data).toMatchObject({ reason: 'upstream_error' });
        expect(err.message).toBe(`openFDA upstream error: ${body}`);
      },
    );

    // A null field reads as absent, as it always has: the message still answers.
    it('reads a null details as absent and keeps the message', async () => {
      const err = await failure(
        500,
        '{"error":{"message":"Index &quot;x&quot; down","details":null}}',
      );

      expect(err.data).toMatchObject({ reason: 'upstream_error' });
      expect(err.message).toBe('openFDA upstream error: Index "x" down');
    });
  });

  /*
   * #97 — a page read at skip 0 or by `search_after` carries a `rel="next"`
   * link whose `search_after` value continues the walk, past skip 25,000 too.
   * The service keeps only that parameter, sends it back beside `skip=0` as
   * openFDA's own link does, and reports the walk position as `meta.skip`.
   * The `Link` values below are openFDA's own (captured 2026-11-22, no key).
   */
  describe('search_after continuation (#97)', () => {
    const SORTED_LINK =
      '<https://api.fda.gov/food/event.json?search=%28date_created%3A%5B20201101%20TO%2020221231%5D%29&sort=date_created%3Adesc&limit=3&skip=0&search_after=0%3D1672358400000%3B1%3D21Av9aEBE00QUgYiPfaI>; rel="next"';
    const UNSORTED_LINK =
      '<https://api.fda.gov/drug/enforcement.json?search=%28openfda.generic_name%3A%22metformin%22%29&limit=20&skip=0&search_after=0%3D7bbc2fc0e663af3c01d8cf7358a0a12d561b01aefac1826d19a4d398c8d6ee05>; rel="next"';
    const KEYWORD_LINK =
      '<https://api.fda.gov/drug/enforcement.json?search=%28recalling_firm%3A%22johnson%22%29&sort=recalling_firm.exact%3Aasc&limit=2&skip=0&search_after=0%3DJohnson%2520%2526%2520Johnson%3B1%3D60348ca75bbe126c993c1ab5fa489343ac584b4578ad6b5b92ffe240a06b2131>; rel="next"';
    /** openFDA's link from a page read at skip > 0: it pages by `skip`, with no `search_after`. */
    const SKIP_LINK =
      '<https://api.fda.gov/food/event.json?search=%28date_created%3A%5B20201101%20TO%2020221231%5D%29&sort=date_created%3Adesc&limit=3&skip=6>; rel="next"';
    const KEYWORD_VALUE =
      '0=Johnson%20%26%20Johnson;1=60348ca75bbe126c993c1ab5fa489343ac584b4578ad6b5b92ffe240a06b2131';
    const NO_MATCHES = { error: { code: 'NOT_FOUND', message: 'No matches found!' } };
    const page = (
      results: unknown[],
      meta: { skip: number; limit: number; total: number },
      link?: string,
    ) =>
      mockResponse(
        200,
        { meta: { results: meta, last_updated: '2026-11-21' }, results },
        link === undefined ? undefined : { link },
      );
    const sentQuery = (call: number) => new URL(mockFetch.mock.calls[call]![0]).searchParams;

    describe('searchAfterOfNextLink', () => {
      it.each<[string, string | null, string | undefined]>([
        ['a sorted page', SORTED_LINK, '0=1672358400000;1=21Av9aEBE00QUgYiPfaI'],
        [
          'an unsorted page',
          UNSORTED_LINK,
          '0=7bbc2fc0e663af3c01d8cf7358a0a12d561b01aefac1826d19a4d398c8d6ee05',
        ],
        ['a keyword sort, its value percent-encoded inside', KEYWORD_LINK, KEYWORD_VALUE],
        ['a skip-style link', SKIP_LINK, undefined],
        ['no header', null, undefined],
        ['an empty header', '', undefined],
        ['an unquoted rel', '<https://h.example/x.json?search_after=0%3D1>; rel=next', '0=1'],
        [
          'a rel in another case',
          '<https://h.example/x.json?search_after=0%3D1>;REL="Next"',
          '0=1',
        ],
        [
          'a rel list naming next',
          '<https://h.example/x.json?search_after=0%3D1>; rel="prev next"',
          '0=1',
        ],
        [
          'rel after another parameter',
          '<https://h.example/x.json?search_after=0%3D1>; title="a; b"; rel="next"',
          '0=1',
        ],
        [
          'a next link after a prev link',
          '<https://h.example/x.json?search_after=0%3D0>; rel="prev", <https://h.example/x.json?search_after=0%3D2>; rel="next"',
          '0=2',
        ],
        [
          'only a prev link',
          '<https://h.example/x.json?search_after=0%3D0>; rel="prev"',
          undefined,
        ],
        ['a link with no rel', '<https://h.example/x.json?search_after=0%3D1>', undefined],
        [
          'a target with no angle brackets',
          'https://h.example/x.json?search_after=0%3D1; rel="next"',
          undefined,
        ],
        ['an unparseable target', '<http://[::1>; rel="next"', undefined],
        ['a relative target', '</x.json?search_after=0%3D1>; rel="next"', undefined],
        [
          'an empty search_after',
          '<https://h.example/x.json?skip=0&search_after=>; rel="next"',
          undefined,
        ],
      ])('reads %s', (_label, header, expected) => {
        expect(searchAfterOfNextLink(header)).toBe(expected);
      });

      it.each<[string, (n: number) => string]>([
        ['repeated openers with no closer', (n) => `${'<'.repeat(n - 1)}\n`],
        ['one unclosed opener before a long run', (n) => `<${'a'.repeat(n - 2)}\n`],
        ['repeated empty link-values', (n) => `${'<>'.repeat(n / 2 - 1)}\n`],
        ['one target before a long parameter run', (n) => `<x>; rel=${' '.repeat(n - 10)}\n`],
        ['one target before many empty parameters', (n) => `<x>${';'.repeat(n - 4)}\n`],
        ['one target before a long rel list', (n) => `<x>; rel="${'a '.repeat(n / 2 - 6)}\n`],
        [
          'one next link with a long target',
          (n) => `<https://h.example/x.json?search_after=0%3D${'a'.repeat(n - 60)}>; rel="next"\n`,
        ],
        [
          'prev links between line breaks throughout',
          (n) => '<x>; rel="prev"  \r\n'.repeat(n / 20),
        ],
        ['openers between line breaks throughout', (n) => '<a  \r\n'.repeat(n / 6)],
      ])('stays linear on %s', (_name, build) => {
        const { t5k, t320k } = linearTiming(searchAfterOfNextLink, build(5_040), build(322_560));
        expect(t320k / t5k).toBeLessThan(256);
        expect(t320k).toBeLessThan(500_000);
      });
    });

    it('sends search_after beside skip=0 and the request’s own search, sort, and limit', async () => {
      mockFetch.mockResolvedValue(page([], { skip: 0, limit: 3, total: 30231 }));

      await service.query(
        'food/event',
        {
          search: 'date_created:[20201101 TO 20221231]',
          sort: 'date_created:desc',
          limit: 3,
          skip: 7,
          searchAfter: { value: '0=1672358400000;1=21Av9aEBE00QUgYiPfaI', position: 3 },
        },
        ctx,
      );

      const sent = new URL(mockFetch.mock.calls[0]![0]);
      expect([...sent.searchParams.keys()]).toEqual([
        'search',
        'sort',
        'limit',
        'skip',
        'search_after',
      ]);
      // openFDA refuses a skip above 0 beside search_after (400), and its own link sends 0.
      expect(sent.searchParams.get('skip')).toBe('0');
      // Byte for byte what openFDA's own link (SORTED_LINK) sends.
      expect(sent.search).toContain(
        '&skip=0&search_after=0%3D1672358400000%3B1%3D21Av9aEBE00QUgYiPfaI',
      );
    });

    it('sends a keyword sort value back exactly as openFDA linked it', async () => {
      mockFetch.mockResolvedValueOnce(
        page(
          [{ recall_number: 'D-1' }, { recall_number: 'D-2' }],
          { skip: 0, limit: 2, total: 34 },
          KEYWORD_LINK,
        ),
      );
      mockFetch.mockResolvedValueOnce(
        page([{ recall_number: 'D-3' }], { skip: 0, limit: 2, total: 34 }),
      );
      const params = {
        search: 'recalling_firm:"johnson"',
        sort: 'recalling_firm.exact:asc',
        limit: 2,
      };

      const first = await service.query('drug/enforcement', params, ctx);
      await service.query(
        'drug/enforcement',
        { ...params, searchAfter: { value: first.nextSearchAfter!, position: 2 } },
        ctx,
      );

      expect(first.nextSearchAfter).toBe(KEYWORD_VALUE);
      expect(new URL(mockFetch.mock.calls[1]![0]).search).toContain(
        '&search_after=0%3DJohnson%2520%2526%2520Johnson%3B1%3D60348ca75bbe126c993c1ab5fa489343ac584b4578ad6b5b92ffe240a06b2131',
      );
    });

    it('returns the next link’s search_after as the only trace of the link', async () => {
      mockFetch.mockResolvedValue(
        page([{ id: '1' }], { skip: 0, limit: 1, total: 9 }, UNSORTED_LINK),
      );

      const result = await service.query('drug/enforcement', { search: 'x', limit: 1 }, ctx);

      expect(result.nextSearchAfter).toBe(
        '0=7bbc2fc0e663af3c01d8cf7358a0a12d561b01aefac1826d19a4d398c8d6ee05',
      );
      expect(Object.keys(result).sort()).toEqual(['meta', 'nextSearchAfter', 'results']);
      expect(JSON.stringify(result)).not.toContain('api.fda.gov');
    });

    it.each([
      ['a skip-style link', SKIP_LINK],
      ['no Link header', undefined],
    ])('leaves nextSearchAfter absent for %s', async (_label, link) => {
      mockFetch.mockResolvedValue(page([{ id: '1' }], { skip: 3, limit: 3, total: 9 }, link));

      const result = await service.query('food/event', { search: 'x', limit: 3, skip: 3 }, ctx);

      expect(result).not.toHaveProperty('nextSearchAfter');
      expect(result.meta.skip).toBe(3);
    });

    it('reports the walk position as meta.skip, where openFDA reports 0', async () => {
      mockFetch.mockResolvedValue(
        page([{ id: '4' }], { skip: 0, limit: 1, total: 9 }, UNSORTED_LINK),
      );

      const result = await service.query(
        'drug/enforcement',
        { search: 'x', limit: 1, searchAfter: { value: '0=abc', position: 3 } },
        ctx,
      );

      expect(result.meta).toEqual({ total: 9, skip: 3, limit: 1, lastUpdated: '2026-11-21' });
    });

    /**
     * openFDA's `search_after` paging over `ids` in the order given: up to
     * `limit` records after the one `search_after` names (`0=<id>`), a
     * `rel="next"` link carrying the last record's key whenever the page is full
     * (openFDA links an exactly full last page too), `No matches found!` for a
     * page with nothing in it, and the bare total for `limit=0`. A cursor page
     * reports `skip: 0`, as openFDA does.
     */
    const fakeOpenFda = (ids: readonly string[]) => async (input: string) => {
      const query = new URL(input).searchParams;
      const limit = Number(query.get('limit'));
      if (limit === 0) return page([], { skip: 0, limit: 0, total: ids.length });
      const after = query.get('search_after');
      const start = after === null ? Number(query.get('skip')) : ids.indexOf(after.slice(2)) + 1;
      const records = ids.slice(start, start + limit);
      if (records.length === 0) return mockResponse(404, NO_MATCHES);
      const last = records[records.length - 1];
      const link =
        records.length === limit
          ? `<https://api.fda.gov/drug/event.json?search=%28x%29&limit=${limit}&skip=0&search_after=0%3D${last}>; rel="next"`
          : undefined;
      return page(
        records.map((id) => ({ id })),
        { skip: after === null ? start : 0, limit, total: ids.length },
        link,
      );
    };

    it('walks every record once, in order, across changing page sizes to a short last page', async () => {
      mockFetch.mockImplementation(
        fakeOpenFda(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']),
      );
      const seen: string[] = [];
      const starts: number[] = [];
      let next: string | undefined;

      for (const limit of [3, 2, 4, 4]) {
        const result = await service.query<{ id: string }>(
          'drug/event',
          {
            search: 'x',
            limit,
            ...(next === undefined
              ? { skip: 0 }
              : { searchAfter: { value: next, position: seen.length } }),
          },
          ctx,
        );
        starts.push(result.meta.skip);
        seen.push(...result.results.map((record) => record.id));
        next = result.nextSearchAfter;
        if (next === undefined) break;
      }

      expect(seen).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
      expect(starts).toEqual([0, 3, 5, 9]);
      expect(next).toBeUndefined();
      expect([1, 2, 3].map((call) => sentQuery(call).get('search_after'))).toEqual([
        '0=r2',
        '0=r4',
        '0=r8',
      ]);
      expect([1, 2, 3].map((call) => sentQuery(call).get('skip'))).toEqual(['0', '0', '0']);
    });

    it('takes the past-end recovery when the link from an exactly full last page 404s', async () => {
      mockFetch.mockImplementation(fakeOpenFda(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']));
      const base = { search: 'x', sort: 'receivedate:desc', limit: 3 };

      const first = await service.query('drug/event', { ...base, skip: 0 }, ctx);
      const last = await service.query(
        'drug/event',
        { ...base, searchAfter: { value: first.nextSearchAfter!, position: 3 } },
        ctx,
      );
      const past = await service.query(
        'drug/event',
        { ...base, searchAfter: { value: last.nextSearchAfter!, position: 6 } },
        ctx,
      );

      expect(last.results).toHaveLength(3);
      expect(last.nextSearchAfter).toBe('0=r5');
      expect(past).toStrictEqual({
        meta: { total: 6, skip: 6, limit: 3, lastUpdated: '2026-11-21' },
        results: [],
      });
      expect(mockFetch).toHaveBeenCalledTimes(4);
      const recovery = sentQuery(3);
      expect(recovery.get('limit')).toBe('0');
      expect(recovery.get('skip')).toBe('0');
      expect(recovery.has('search_after')).toBe(false);
      expect(recovery.has('sort')).toBe(false);
    });

    it('returns the walk position with the total unverified when that recovery fails', async () => {
      mockFetch.mockImplementation(async (input: string) =>
        new URL(input).searchParams.get('limit') === '0'
          ? mockResponse(503, '<html><body>503 Service Temporarily Unavailable</body></html>')
          : mockResponse(404, NO_MATCHES),
      );

      const past = await service.query(
        'drug/event',
        { search: 'x', limit: 3, searchAfter: { value: '0=r5', position: 6 } },
        ctx,
      );

      expect(past).toStrictEqual({
        meta: { total: 0, skip: 6, limit: 3, lastUpdated: 'unknown', totalUnverified: true },
        results: [],
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    describe('under the retry ladder', () => {
      let random: { mockRestore: () => void };

      beforeEach(async () => {
        const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
          '@cyanheads/mcp-ts-core/utils',
        );
        vi.mocked(withRetry).mockImplementation(actual.withRetry);
        vi.useFakeTimers();
        random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      });

      afterEach(() => {
        vi.mocked(withRetry).mockImplementation(singleAttempt);
        vi.useRealTimers();
        random.mockRestore();
      });

      it('resends the same search_after and keeps the link of the attempt whose body it read', async () => {
        const staleLink =
          '<https://api.fda.gov/drug/event.json?search=%28x%29&limit=2&skip=0&search_after=0%3Dstale>; rel="next"';
        mockFetch
          .mockResolvedValueOnce(mockResponse(503, '<html><body>503</body></html>'))
          // Headers arrive, then the body read fails: that attempt's link must not survive it.
          .mockResolvedValueOnce({
            ...page([], { skip: 0, limit: 2, total: 9 }, staleLink),
            json: () => Promise.reject(serviceUnavailable('body read failed')),
          })
          .mockResolvedValueOnce(
            page(
              [{ id: 'r3' }, { id: 'r4' }],
              { skip: 0, limit: 2, total: 9 },
              '<https://api.fda.gov/drug/event.json?search=%28x%29&limit=2&skip=0&search_after=0%3Dr4>; rel="next"',
            ),
          );

        const pending = service.query<{ id: string }>(
          'drug/event',
          { search: 'x', limit: 2, searchAfter: { value: '0=r2', position: 3 } },
          ctx,
        );
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect([0, 1, 2].map((call) => sentQuery(call).get('search_after'))).toEqual([
          '0=r2',
          '0=r2',
          '0=r2',
        ]);
        expect(result.results.map((record) => record.id)).toEqual(['r3', 'r4']);
        expect(result.meta.skip).toBe(3);
        expect(result.nextSearchAfter).toBe('0=r4');
      });
    });
  });

  /*
   * Four 15 s attempts plus backoff run ~65–69 s, past the 60 s request timeout
   * MCP SDK clients default to. One deadline bounds every attempt, every backoff,
   * and the side requests a call makes, under the real `withRetry` on fake timers.
   */
  describe('call deadline', () => {
    /** A fetch that never answers — it rejects only when its signal aborts. */
    const hangUntilAborted = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    /** Whether `promise` has settled, sampled without awaiting it. */
    const track = (promise: Promise<unknown>) => {
      const state = { settled: false };
      promise.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      return state;
    };

    let random: { mockRestore: () => void };

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
        '@cyanheads/mcp-ts-core/utils',
      );
      vi.mocked(withRetry).mockImplementation(actual.withRetry);
      vi.useFakeTimers();
      // Jitter at its midpoint, so backoff is exactly 1 s, 2 s, 4 s.
      random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.mocked(withRetry).mockImplementation(singleAttempt);
      vi.useRealTimers();
      random.mockRestore();
    });

    it('defaults to 50 s for one call', () => {
      expect(OPENFDA_CALL_DEADLINE_MS).toBe(50_000);
    });

    it('settles a call whose every attempt times out inside the default deadline', async () => {
      mockFetch.mockImplementation(hangUntilAborted);

      const pending = service
        .query('drug/event', { search: 'patient.drug.medicinalproduct:"x"' }, ctx)
        .catch((e: unknown) => e);
      const state = track(pending);
      await vi.advanceTimersByTimeAsync(50_000);

      expect(state.settled).toBe(true);
      const err = (await pending) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 50_000 });
      // 15 s, 1 s, 15 s, 2 s, 15 s — the 4 s backoff would outlast the 2 s left.
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('cuts the first attempt at a caller deadline shorter than the attempt timeout', async () => {
      mockFetch.mockImplementation(hangUntilAborted);

      const pending = service
        .query('drug/event', {}, ctx, { deadlineAtMs: Date.now() + 5_000 })
        .catch((e: unknown) => e);
      const state = track(pending);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.settled).toBe(true);
      const err = (await pending) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 5_000 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('sends no request once its deadline has passed', async () => {
      mockFetch.mockImplementation(hangUntilAborted);

      const pending = service
        .query('drug/event', {}, ctx, { deadlineAtMs: Date.now() })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1);
      const err = (await pending) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps a caller cancel a cancellation, never a deadline expiry', async () => {
      mockFetch.mockImplementation(hangUntilAborted);
      const controller = new AbortController();

      const pending = service
        .query('drug/event', {}, createMockContext({ signal: controller.signal }), {
          deadlineAtMs: Date.now() + 5_000,
        })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      const err = (await pending) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('bounds the past-end total recovery by the same deadline', async () => {
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
        new URL(url).searchParams.get('limit') === '0'
          ? hangUntilAborted(url, init)
          : mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      const pending = service.query(
        'drug/enforcement',
        { search: 'openfda.generic_name:"metformin"', limit: 1, skip: 39 },
        ctx,
        { deadlineAtMs: Date.now() + 5_000 },
      );
      const state = track(pending);
      await vi.advanceTimersByTimeAsync(5_000);

      // Its own 15 s attempt timeout would have held the call open three times longer.
      expect(state.settled).toBe(true);
      expect((await pending).meta).toMatchObject({ total: 0, skip: 39, totalUnverified: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('bounds the "Nothing to count" confirm by the same deadline', async () => {
      // The scoped count answers `Nothing to count`; the unscoped confirm never answers.
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
        new URL(url).searchParams.has('search')
          ? mockResponse(404, { error: { code: 'NOT_FOUND', message: 'Nothing to count' } })
          : hangUntilAborted(url, init),
      );

      const pending = service
        .query(
          'drug/enforcement',
          {
            count: 'openfda.generic_name.exact',
            search: '_missing_:openfda.generic_name',
            limit: 5,
          },
          ctx,
          { deadlineAtMs: Date.now() + 5_000 },
        )
        .catch((e: unknown) => e);
      const state = track(pending);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(state.settled).toBe(true);
      const err = (await pending) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 5_000 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
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
      // The premise: an openFDA field the catalog does not record.
      expect(countVerdict('device/classification', 'review_code')).toEqual({ kind: 'uncataloged' });

      const err = (await service
        .query('device/classification', { count: 'review_code' }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err.data).toMatchObject({
        reason: 'not_aggregatable',
        endpoint: 'device/classification',
        count: 'review_code',
      });
      expect(err.code).toBe(-32007); // ValidationError — outside withRetry's transient set
      expect(TRANSIENT_CODES.has(err.code)).toBe(false);
      expect(err.message).toContain('"review_code.exact"'); // the add-suffix correction
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

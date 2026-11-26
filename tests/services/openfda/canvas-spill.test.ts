/**
 * @fileoverview Tests for the spillSearch DataCanvas helper. The mock
 * CanvasInstance drains the async source registerTable receives, so the paging
 * cadence, the drain's byte budget, the 25k ceiling, the truncation signal, and
 * the inline page's oversized-record disclosure all run for real with only the
 * openFDA service and the canvas accessor stubbed. The `search_after` drain
 * past the ceiling runs the real service against a fake openFDA `fetch`.
 * @module tests/services/openfda/canvas-spill.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    setCanvas: (c: unknown) => {
      _canvas = c;
    },
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

vi.mock('@/services/openfda/openfda-service.js', () => {
  let _svc: unknown;
  return {
    getOpenFdaService: () => _svc,
    initOpenFdaService: () => {},
    __setMock: (s: unknown) => {
      _svc = s;
    },
  };
});

import {
  AGGREGATE_ROUTE,
  canvasIdInput,
  canvasOutputShape,
  canvasResult,
  OPENFDA_MAX_ROWS,
  spillSearch,
  stagingNotice,
} from '@/services/openfda/canvas-spill.js';
import { inlinePage } from '@/services/openfda/page-budget.js';
import { pageProjection } from '@/services/openfda/record-projection.js';
import { setCanvasMock, setSvcMock } from '../../helpers/mock-setters.js';

/**
 * Paged openFDA service stub over a synthetic dataset of `total` rows.
 * `rowBytes` pads each record so the byte-budget path can be exercised.
 */
function makeSvc(total: number, rowBytes = 0) {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const end = Math.min(skip + limit, total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) {
        results.push(
          rowBytes > 0
            ? { id: `r${i}`, val: i, blob: 'x'.repeat(rowBytes) }
            : { id: `r${i}`, val: i },
        );
      }
      return { meta: { total, skip, limit, lastUpdated: '2026-06-01' }, results };
    }),
  };
}

/** Mock canvas whose registerTable drains the async source and counts the rows. */
function makeCanvas(canvasId = 'cv_test') {
  const instance = {
    canvasId,
    isNew: true,
    registerTable: vi.fn(
      async (
        name: string,
        source: AsyncIterable<Record<string, unknown>> | Record<string, unknown>[],
        _options?: { signal?: AbortSignal },
      ) => {
        let rowCount = 0;
        for await (const _row of source as AsyncIterable<Record<string, unknown>>) rowCount++;
        return { tableName: name, rowCount, columns: [] };
      },
    ),
    drop: vi.fn(),
  };
  return { canvas: { acquire: vi.fn().mockResolvedValue(instance) }, instance };
}

const SCHEMA = [
  { name: 'id', type: 'VARCHAR' as const, nullable: true },
  { name: 'val', type: 'VARCHAR' as const, nullable: true },
];

describe('spillSearch', () => {
  beforeEach(async () => {
    await setCanvasMock(undefined);
  });

  it('throws when canvas is disabled', async () => {
    await setSvcMock(makeSvc(10));
    const ctx = createMockContext();
    await expect(
      spillSearch({ endpoint: 'drug/event', schema: SCHEMA, ctx, limit: 10, skip: 0 }),
    ).rejects.toThrow('DataCanvas is not enabled');
  });

  it('stages the matched set and reports staged rows with no truncation when it all fits', async () => {
    const svc = makeSvc(2500);
    await setSvcMock(svc);
    const { canvas, instance } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.spilled).toBe(true);
    expect(result.canvasId).toBe('cv_test');
    expect(result.tableName).toMatch(/^spilled_[0-9a-f]{8}$/);
    expect(result.total).toBe(2500);
    expect(result.stagedRows).toBe(2500);
    expect(result.truncatedBy).toBeUndefined();
    expect(instance.registerTable).toHaveBeenCalledOnce();
  });

  /**
   * The canvas stops reading the drain when this signal aborts. Without it a
   * cancelled staged search keeps requesting pages up to the row ceiling.
   */
  it('hands the call signal to the canvas with the drain, so a cancelled call stops staging', async () => {
    await setSvcMock(makeSvc(2500));
    const { canvas, instance } = makeCanvas();
    await setCanvasMock(canvas);

    const { signal } = new AbortController();
    const ctx = createMockContext({ signal });
    await spillSearch({ endpoint: 'drug/event', schema: SCHEMA, ctx, limit: 10, skip: 0 });

    expect(instance.registerTable.mock.calls[0]?.[2]?.signal).toBe(signal);
  });

  it('bounds the drain by a byte budget so large records cannot run away (#30)', async () => {
    // ~70 KB per record — the drug/event shape that made a limit:10 call take minutes.
    const svc = makeSvc(30_000, 70_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.total).toBe(30_000);
    expect(result.stagedRows).toBeGreaterThan(0);
    expect(result.stagedRows).toBeLessThan(1_000);
    expect(result.truncatedBy).toBe('size_budget');
    // The old drain issued 25 upstream requests for 25,000 rows regardless of limit.
    expect(svc.query.mock.calls.length).toBeLessThan(10);
  });

  it('pages small records by skip to the 25000-row ceiling when openFDA links no continuation', async () => {
    // This stub sends no `search_after` link, so the walk past the ceiling has nothing to follow.
    const svc = makeSvc(40_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/shortages',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.stagedRows).toBe(OPENFDA_MAX_ROWS);
    expect(result.truncatedBy).toBe('row_ceiling');
    const maxSkip = Math.max(...svc.query.mock.calls.map((c) => c[1].skip ?? 0));
    expect(maxSkip).toBeLessThan(OPENFDA_MAX_ROWS);
  });

  it('serves the inline page from the matched set at the caller offset (#32)', async () => {
    const svc = makeSvc(2500);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 3,
      skip: 5,
    });

    expect(result.skip).toBe(5);
    expect(result.preview.map((r) => r.id)).toEqual(['r5', 'r6', 'r7']);
  });

  it('fetches the inline page directly when the offset is past the probe window (#32)', async () => {
    const svc = makeSvc(1175);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/shortages',
      schema: SCHEMA,
      ctx,
      limit: 2,
      skip: 300,
    });

    expect(result.preview.map((r) => r.id)).toEqual(['r300', 'r301']);
    expect(svc.query.mock.calls.some((c) => c[1].skip === 300 && c[1].limit === 2)).toBe(true);
  });

  it('returns an empty page with a note-worthy total when the offset runs past the end (#32)', async () => {
    const svc = makeSvc(50);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/shortages',
      schema: SCHEMA,
      ctx,
      limit: 5,
      skip: 100,
    });

    expect(result.preview).toHaveLength(0);
    expect(result.total).toBe(50);
    expect(result.stagedRows).toBe(50);
  });

  it('holds the whole window, whatever its records measure (#31, #92)', async () => {
    /*
     * Record size can neither empty the page (#31) nor shorten it (#92): `limit`
     * is the page size. Two 70 KB `drug/event`-shaped records come back whole,
     * and the page states its weight instead of dropping one.
     */
    const svc = makeSvc(600, 70_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 2,
      skip: 0,
    });

    expect(result.preview.map((r) => r.id)).toEqual(['r0', 'r1']);
    expect(result.preview[1]?.blob).toHaveLength(70_000);
    expect(result.previewOversized.page_bytes).toBe(
      Buffer.byteLength(JSON.stringify(result.preview), 'utf8'),
    );
    expect(result.previewOversized.page_largest_fields).toEqual([{ path: 'blob', bytes: 70_002 }]);
    expect(result.previewOversized).not.toHaveProperty('page_omitted');
    expect(result.total).toBe(600);
  });

  it('discloses nothing on a window whose records each fit, however large the page', async () => {
    // Ten ~10 KB records: a ~100 KB page with no record over 24,000 bytes.
    await setSvcMock(makeSvc(40, 10_000));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx: createMockContext(),
      limit: 10,
      skip: 0,
    });

    expect(result.preview).toHaveLength(10);
    expect(result.previewOversized).toEqual({});
  });

  it('stages nothing when the query matched no records', async () => {
    const svc = makeSvc(0);
    await setSvcMock(svc);
    const { canvas, instance } = makeCanvas('cv_empty');
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.spilled).toBe(false);
    expect(result.stagedRows).toBe(0);
    expect(result.tableName).toBe('');
    expect(result.truncatedBy).toBeUndefined();
    expect(result.canvasId).toBe('cv_empty');
    expect(instance.registerTable).not.toHaveBeenCalled();
  });

  it('stages the same rows regardless of the caller limit', async () => {
    await setSvcMock(makeSvc(2500));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const small = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 3,
      skip: 0,
    });
    const large = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 50,
      skip: 0,
    });

    expect(small.preview).toHaveLength(3);
    expect(large.preview).toHaveLength(50);
    expect(small.stagedRows).toBe(large.stagedRows);
  });
});

/*
 * #110 — staging past openFDA's 25,000-row `skip` ceiling. These cases run the
 * real OpenFdaService (request building, the `Link` header read, the
 * missing-sort-value check, error classification, the retry deadline) against
 * a fake openFDA behind a stubbed `fetch`, so the drain meets exactly what the
 * service returns and throws. Record `r<i>` sits at position i of the match.
 */
describe('spillSearch — staging past the 25,000-row skip ceiling (#110)', () => {
  type Service = import('@/services/openfda/openfda-service.js').OpenFdaService;
  let makeService: () => Service;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/services/openfda/openfda-service.js')>(
      '@/services/openfda/openfda-service.js',
    );
    makeService = () => new actual.OpenFdaService({ baseUrl: 'https://api.fda.gov' });
  });

  let random: { mockRestore: () => void } | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    random?.mockRestore();
    random = undefined;
  });

  /**
   * The matched set in openFDA's order. Records before `sortedUntil` carry the
   * sort field `d`; openFDA sorts the ones lacking it last. A 380-character
   * blob puts a record at 421 characters as the drain measures it (a 38,012-row
   * size budget), under the 640 at which 16 MB holds 25,000 rows.
   */
  function match(total: number, blobChars: number, sortedUntil = total) {
    const blob = 'x'.repeat(blobChars);
    return Array.from(
      { length: total },
      (_, i): Record<string, unknown> =>
        i < sortedUntil ? { id: `r${i}`, d: 1_790_000_000_000 - i, blob } : { id: `r${i}`, blob },
    );
  }

  function respond(status: number, body: unknown, headers?: Record<string, string>): Response {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(headers),
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  /** A response whose body is `text` as sent: a proxy's page, not openFDA's JSON. */
  function respondText(status: number, text: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(),
      text: () => Promise.resolve(text),
    } as unknown as Response;
  }

  /**
   * Resolves after `ms` fake milliseconds — never, for an infinite `ms` — or
   * rejects as soon as the request is aborted.
   */
  function landing(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (ms === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : undefined;
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  interface FakeOptions {
    /**
     * A response that replaces the fake's own, by request and its attempt (1 on
     * first send): what openFDA, or a proxy in front of it, answers in a failure.
     */
    answer?: (url: URL, attempt: number) => Response | undefined;
    /** Requests answered with openFDA's HTTP 500 `parse_exception`. */
    fails?: (url: URL) => boolean;
    /** Fake milliseconds a response takes to land, by request and its attempt (1 on first send). */
    latencyMs?: (url: URL, attempt: number) => number;
    /** The link value openFDA prints for a record lacking the sort field, and how it answers that link. */
    missing?: { onFollow: 'parse_exception' | 'same_page'; value: string };
    /** Requests whose full page is answered with no `Link` header. */
    unlinked?: (url: URL) => boolean;
  }

  /**
   * Stubs `fetch` with a fake openFDA over `records` and returns every request
   * URL in order. As openFDA does, a full page read at `skip: 0` or by
   * `search_after` links its successor by `search_after` (`0=<sort value>;1=<id>`
   * sorted, `0=<id>` unsorted), one read at `skip > 0` links by `skip`, and a
   * short page links nothing. A link carrying `missing.value` answers HTTP 500
   * (`parse_exception`, a date sort) or the page it came from under the same
   * link (`same_page`, a descending keyword sort).
   */
  function fakeOpenFda(records: Record<string, unknown>[], options: FakeOptions = {}): URL[] {
    const urls: URL[] = [];
    const attempts = new Map<string, number>();
    const position = new Map(records.map((record, i) => [record.id, i]));
    const parseException = (value: string) =>
      respond(500, {
        error: {
          code: 'SERVER_ERROR',
          message: 'Check your request and try again',
          details: `[parse_exception] failed to parse date field [${value}] with format [basic_date||date||epoch_millis]`,
        },
      });
    const linkOf = (record: Record<string, unknown>, sorted: boolean) =>
      sorted
        ? `0=${record.d === undefined ? options.missing?.value : String(record.d)};1=${String(record.id)}`
        : `0=${String(record.id)}`;

    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url);
      const attempt = (attempts.get(url.search) ?? 0) + 1;
      attempts.set(url.search, attempt);
      await landing(options.latencyMs?.(url, attempt) ?? 0, init?.signal);
      const answered = options.answer?.(url, attempt);
      if (answered) return answered;
      if (options.fails?.(url)) return parseException('x');

      const sorted = url.searchParams.has('sort');
      const limit = Number(url.searchParams.get('limit'));
      const after = url.searchParams.get('search_after');
      let start = Number(url.searchParams.get('skip') ?? 0);
      if (after !== null) {
        const components = after.split(';').map((component) => component.slice(2));
        const last = position.get(components.at(-1)) ?? -1;
        if (sorted && options.missing && components[0] === options.missing.value) {
          if (options.missing.onFollow === 'parse_exception') return parseException(after);
          start = last + 1 - limit;
        } else {
          start = last + 1;
        }
      }
      const results = records.slice(start, start + limit);
      if (results.length === 0) {
        return respond(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } });
      }
      const next =
        after !== null || start === 0
          ? `search_after=${encodeURIComponent(linkOf(results.at(-1) ?? {}, sorted))}&skip=0`
          : `skip=${start + limit}`;
      return respond(
        200,
        {
          meta: {
            last_updated: '2026-11-20',
            results: { skip: after === null ? start : 0, limit, total: records.length },
          },
          results,
        },
        results.length === limit && !options.unlinked?.(url)
          ? { link: `<https://api.fda.gov/other/nsde.json?limit=${limit}&${next}>; rel="next"` }
          : undefined,
      );
    });
    return urls;
  }

  /** A request as `skip <n>` or `after <search_after value>`. */
  const requestOf = (url: URL) =>
    url.searchParams.has('search_after')
      ? `after ${url.searchParams.get('search_after')}`
      : `skip ${url.searchParams.get('skip')}`;

  /** The skip pages today's drain sends: the 100-row probe, then 1,000-row pages to `rows`. */
  function skipLadder(rows: number) {
    const pages = [{ skip: 0, limit: 100 }];
    for (let skip = 100; skip < rows; skip += 1_000) {
      pages.push({ skip, limit: Math.min(1_000, rows - skip) });
    }
    return pages;
  }

  /**
   * Starts a staged `other/nsde` call on a fresh real service over the fake,
   * collecting the staged ids in the order the canvas reads them.
   */
  function stage(
    call: { limit?: number; signal?: AbortSignal; skip?: number; sort?: string } = {},
  ) {
    const service = makeService();
    const query = vi.spyOn(service, 'query');
    const ids: unknown[] = [];
    const instance = {
      canvasId: 'cv_walk',
      isNew: true,
      registerTable: vi.fn(async (name: string, source: AsyncIterable<Record<string, unknown>>) => {
        for await (const row of source) ids.push(row.id);
        return { tableName: name, rowCount: ids.length, columns: [] };
      }),
      drop: vi.fn(),
    };
    const pending = (async () => {
      await setSvcMock(service);
      await setCanvasMock({ acquire: vi.fn().mockResolvedValue(instance) });
      return spillSearch({
        endpoint: 'other/nsde',
        schema: SCHEMA,
        ctx: createMockContext(call.signal ? { signal: call.signal } : {}),
        limit: call.limit ?? 10,
        skip: call.skip ?? 0,
        sort: call.sort,
      });
    })();
    return { ids, pending, query };
  }

  function track(promise: Promise<unknown>) {
    const state = { settled: false };
    promise.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      },
    );
    return state;
  }

  it('stages a match past 25,000 rows by search_after, up to the size budget', async () => {
    const records = match(40_000, 380);
    const urls = fakeOpenFda(records);
    const { ids, pending } = stage();
    const spill = await pending;

    expect(spill.stagedRows).toBe(38_012);
    expect(spill.truncatedBy).toBe('size_budget');
    // Every record once, in match order.
    expect(ids).toEqual(records.slice(0, 38_012).map((r) => r.id));
    const [probe, ...drain] = urls.map(requestOf);
    expect(probe).toBe('skip 0');
    // Every drain request continues by search_after from the last record staged.
    expect(drain).toEqual(drain.map((_, k) => `after 0=r${99 + 1_000 * k}`));
    expect(drain).toHaveLength(38);
    expect(canvasResult(spill)).toMatchObject({
      staged_rows: 38_012,
      truncated: true,
      truncated_by: 'size_budget',
    });
  });

  it('stages a 25,001-record match whole', async () => {
    const records = match(25_001, 380);
    const urls = fakeOpenFda(records);
    const { ids, pending } = stage();
    const spill = await pending;

    expect(spill.stagedRows).toBe(25_001);
    expect(spill.truncatedBy).toBeUndefined();
    expect(ids).toEqual(records.map((r) => r.id));
    expect(urls.slice(1).every((url) => url.searchParams.has('search_after'))).toBe(true);
    expect(canvasResult(spill)).not.toHaveProperty('truncated');
    expect(canvasResult(spill)).not.toHaveProperty('truncated_by');
  });

  /**
   * label, total, blob characters, leading records given one character more,
   * the size budget in rows, rows staged. A record's length moves the probe's
   * average in steps of 1/100 character, so nine records one longer land the
   * last row's 100-record probe on 64,000 characters: 640 apiece, the length at
   * which 16 MB holds exactly 25,000 rows.
   */
  it.each([
    ['meta.total is 25,000', 25_000, 380, 0, 38_012, 25_000],
    ['the size budget holds under 25,000 rows', 40_000, 660, 0, 22_827, 22_827],
    ['the size budget holds exactly 25,000 rows', 40_000, 599, 9, 25_000, 25_000],
  ])(
    'pages by skip exactly as before when %s',
    async (_case, total, blobChars, longer, sizeRows, staged) => {
      const records = match(total, blobChars);
      for (const record of records.slice(0, longer)) record.blob = `${String(record.blob)}x`;
      // The premise: the size budget the drain derives from its probe, STAGE_MAX_BYTES over the average record.
      const probeChars = JSON.stringify(records.slice(0, 100)).length;
      expect(Math.floor(16_000_000 / (probeChars / 100))).toBe(sizeRows);
      const urls = fakeOpenFda(records);
      const { ids, pending } = stage();
      const spill = await pending;

      expect(
        urls.map((url) => ({
          skip: Number(url.searchParams.get('skip')),
          limit: Number(url.searchParams.get('limit')),
        })),
      ).toEqual(skipLadder(staged));
      expect(urls.some((url) => url.searchParams.has('search_after'))).toBe(false);
      expect(spill.stagedRows).toBe(staged);
      expect(ids).toEqual(records.slice(0, staged).map((r) => r.id));
    },
  );

  it.each([
    ['date', '-9223372036854776000', 'parse_exception'],
    ['keyword', '', 'same_page'],
  ] as const)(
    'never sends a %s sort’s missing-value marker: it stages that page, then pages on by skip to 25,000',
    async (_sort, value, onFollow) => {
      // r12000 onward lack the sort field; the page holding r12000 ends at r12099.
      const records = match(40_000, 380, 12_000);
      const urls = fakeOpenFda(records, { missing: { value, onFollow } });
      const { ids, pending } = stage({ sort: 'd:desc' });
      const spill = await pending;
      const requests = urls.map(requestOf);

      expect(requests.some((r) => r.startsWith(`after 0=${value};`))).toBe(false);
      const resumed = requests.indexOf('skip 12100');
      expect(requests[resumed - 1]).toMatch(/^after 0=\d+;1=r11099$/);
      expect(requests.slice(resumed)).toEqual(
        skipLadder(25_000)
          .filter((page) => page.skip >= 12_100)
          .map((page) => `skip ${page.skip}`),
      );
      expect(ids).toEqual(records.slice(0, 25_000).map((r) => r.id));
      expect(spill.truncatedBy).toBe('row_ceiling');
    },
  );

  it('keeps every walked row and stops at the row ceiling when the marker falls past 25,000', async () => {
    const records = match(40_000, 380, 30_000);
    const urls = fakeOpenFda(records, {
      missing: { value: '-9223372036854776000', onFollow: 'parse_exception' },
    });
    const { ids, pending } = stage({ sort: 'd:desc' });
    const spill = await pending;
    const requests = urls.map(requestOf);

    expect(requests.slice(1).every((r) => r.startsWith('after 0=17'))).toBe(true);
    expect(requests.at(-1)).toMatch(/;1=r29099$/);
    expect(spill.stagedRows).toBe(30_100);
    expect(ids).toEqual(records.slice(0, 30_100).map((r) => r.id));
    expect(spill.truncatedBy).toBe('row_ceiling');
  });

  it.each([
    ['answered with query_error', '-9.223372036854776E18', 'parse_exception'],
    ['answered with the page it came from', '_last', 'same_page'],
  ] as const)(
    'pages on by skip when a continuation is %s, staging none of its rows',
    async (_case, value, onFollow) => {
      // A marker shape the service does not recognize, so the walk sends it once.
      const records = match(40_000, 380, 12_000);
      const urls = fakeOpenFda(records, { missing: { value, onFollow } });
      const { ids, pending } = stage({ sort: 'd:desc' });
      const spill = await pending;
      const requests = urls.map(requestOf);
      const sent = `after 0=${value};1=r12099`;

      expect(requests.filter((r) => r === sent)).toHaveLength(1);
      expect(requests[requests.indexOf(sent) + 1]).toBe('skip 12100');
      expect(ids).toEqual(records.slice(0, 25_000).map((r) => r.id));
      expect(spill.truncatedBy).toBe('row_ceiling');
    },
  );

  it('pages on by skip to 25,000 when a full continuation page carries no next link', async () => {
    const records = match(40_000, 380);
    const unlinked = '0=r12099';
    const urls = fakeOpenFda(records, {
      unlinked: (url) => url.searchParams.get('search_after') === unlinked,
    });
    const { ids, pending } = stage();
    const spill = await pending;
    const requests = urls.map(requestOf);

    // That page holds r12100 to r13099, every one staged once: the walk resumes by skip right after it.
    const resumed = requests.indexOf('skip 13100');
    expect(requests[resumed - 1]).toBe(`after ${unlinked}`);
    expect(requests.slice(resumed)).toEqual(
      skipLadder(25_000)
        .filter((page) => page.skip >= 13_100)
        .map((page) => `skip ${page.skip}`),
    );
    expect(Math.max(...urls.map((url) => Number(url.searchParams.get('skip'))))).toBeLessThan(
      OPENFDA_MAX_ROWS,
    );
    expect(ids).toEqual(records.slice(0, 25_000).map((r) => r.id));
    expect(spill.truncatedBy).toBe('row_ceiling');
  });

  it('ends the drain with what it staged when the call deadline cuts a page', async () => {
    vi.useFakeTimers();
    const records = match(40_000, 380);
    // Every response lands 3 s after it is sent: the drain page sent at 48 s is still out at 50 s.
    const urls = fakeOpenFda(records, { latencyMs: () => 3_000 });
    const start = Date.now();
    const { pending, query } = stage();
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);

    const spill = await pending;
    expect(spill.stagedRows).toBe(15_100);
    expect(spill.truncatedBy).toBe('time_budget');
    expect(canvasResult(spill)).toMatchObject({ truncated: true, truncated_by: 'time_budget' });
    // The probe, the 15 pages that landed, and the one the deadline cut.
    expect(urls).toHaveLength(17);
    const [probe, ...drain] = query.mock.calls;
    expect(probe?.[3]).toBeUndefined();
    expect(drain).toHaveLength(16);
    for (const call of drain) expect(call[3]).toEqual({ deadlineAtMs: start + 50_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(urls).toHaveLength(17);
  });

  it('holds only the drain to the call deadline: a slow probe and inline page still answer', async () => {
    vi.useFakeTimers();
    // Backoff at its midpoint: exactly 1 s, then 2 s.
    random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const records = match(40_000, 380);
    // The probe and the inline page each time out twice (15 s apiece) and land on the third attempt.
    const urls = fakeOpenFda(records, {
      latencyMs: (url, attempt) =>
        url.searchParams.has('search_after') || attempt > 2 ? 0 : Number.POSITIVE_INFINITY,
    });
    const start = Date.now();
    const { pending, query } = stage({ limit: 3, skip: 300 });
    const state = track(pending);

    // The probe lands at 33 s; the inline page, sent then, at 66 s: past the drain's 50 s deadline, inside its own.
    await vi.advanceTimersByTimeAsync(65_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);

    const spill = await pending;
    expect(spill.preview.map((r) => r.id)).toEqual(['r300', 'r301', 'r302']);
    expect(spill.stagedRows).toBe(100);
    expect(spill.truncatedBy).toBe('time_budget');
    expect(query.mock.calls.map((call) => call[3])).toEqual([
      undefined,
      undefined,
      { deadlineAtMs: start + 50_000 },
    ]);
    // The drain started past its deadline and sent nothing.
    expect(urls.map(requestOf)).toEqual([
      'skip 0',
      'skip 0',
      'skip 0',
      'skip 300',
      'skip 300',
      'skip 300',
    ]);
  });

  it('cancels mid-drain when the caller cancels', async () => {
    vi.useFakeTimers();
    const records = match(40_000, 380);
    const urls = fakeOpenFda(records, { latencyMs: () => 1_000 });
    const controller = new AbortController();
    const { pending } = stage({ signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);

    // The probe and two drain pages land; the third is out.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(urls).toHaveLength(4);
    controller.abort();
    const error = await outcome;

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(urls).toHaveLength(4);
  });

  it.each([
    ['probe', 0],
    ['inline page', 300],
  ])('fails the call when the %s fails', async (_request, skip) => {
    const records = match(40_000, 380);
    fakeOpenFda(records, {
      fails: (url) =>
        Number(url.searchParams.get('skip')) === skip && !url.searchParams.has('search_after'),
    });
    const { pending } = stage({ skip });
    const error = await pending.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).data).toMatchObject({ reason: 'query_error' });
  });

  /**
   * Upstream failures that outlast the service's retries: a rate limit, a 5xx
   * with no query marker, and a 200 that is not openFDA JSON (#112).
   */
  const UPSTREAM_FAILURES = [
    [
      'a 429',
      'rate_limited',
      () => respond(429, { error: { code: 'OVER_RATE_LIMIT', message: 'Rate limit exceeded' } }),
    ],
    [
      'a 5xx',
      'upstream_error',
      () =>
        respond(503, {
          error: { code: 'SERVER_ERROR', message: 'Check your request and try again' },
        }),
    ],
    [
      'an HTML 200',
      'upstream_error',
      () => respondText(200, '<html><head><title>Gateway maintenance</title></head></html>'),
    ],
  ] as const;

  /** Settles a staged call whose retries wait on fake timers, a second at a time. */
  async function settle(pending: Promise<unknown>) {
    const state = track(pending);
    for (let s = 0; s < 45 && !state.settled; s++) await vi.advanceTimersByTimeAsync(1_000);
    expect(state.settled).toBe(true);
  }

  it.each(UPSTREAM_FAILURES)(
    'keeps the rows it walked past 25,000 when a later continuation answers %s (%s) through its retries',
    async (_answer, _reason, failure) => {
      vi.useFakeTimers();
      const records = match(40_000, 380);
      const failing = '0=r30099';
      const urls = fakeOpenFda(records, {
        answer: (url) => (url.searchParams.get('search_after') === failing ? failure() : undefined),
      });
      const { ids, pending } = stage();
      await settle(pending);
      const spill = await pending;
      const requests = urls.map(requestOf);

      // Every attempt the service makes, then nothing: past 25,000 there is no skip page to fall back to.
      expect(requests.filter((r) => r === `after ${failing}`)).toHaveLength(4);
      expect(requests.at(-1)).toBe(`after ${failing}`);
      // More than v0.11.0 staged for the same call (25,000), and every one once, in match order.
      expect(spill.stagedRows).toBe(30_100);
      expect(ids).toEqual(records.slice(0, 30_100).map((r) => r.id));
      expect(spill.truncatedBy).toBe('row_ceiling');
    },
  );

  it.each(UPSTREAM_FAILURES)(
    'sends the skip page v0.11.0 sent when a continuation under 25,000 answers %s (%s) through its retries',
    async (_answer, _reason, failure) => {
      vi.useFakeTimers();
      const records = match(40_000, 380);
      const failing = '0=r12099';
      const urls = fakeOpenFda(records, {
        answer: (url) => (url.searchParams.get('search_after') === failing ? failure() : undefined),
      });
      const { ids, pending } = stage();
      await settle(pending);
      const spill = await pending;
      const requests = urls.map(requestOf);

      const resumed = requests.indexOf('skip 12100');
      expect(requests[resumed - 1]).toBe(`after ${failing}`);
      expect(requests.slice(resumed)).toEqual(
        skipLadder(25_000)
          .filter((page) => page.skip >= 12_100)
          .map((page) => `skip ${page.skip}`),
      );
      expect(ids).toEqual(records.slice(0, 25_000).map((r) => r.id));
      expect(spill.truncatedBy).toBe('row_ceiling');
    },
  );

  it.each(UPSTREAM_FAILURES)(
    'fails the call when the skip page at the failed continuation’s position answers %s too (%s), as v0.11.0 did',
    async (_answer, reason, failure) => {
      vi.useFakeTimers();
      const records = match(40_000, 380);
      fakeOpenFda(records, {
        answer: (url) =>
          url.searchParams.get('search_after') === '0=r12099' ||
          url.searchParams.get('skip') === '12100'
            ? failure()
            : undefined,
      });
      const { pending } = stage();
      const outcome = pending.catch((e: unknown) => e);
      await settle(outcome);
      const error = await outcome;

      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).data).toMatchObject({ reason });
    },
  );

  it.each(UPSTREAM_FAILURES)(
    'fails the call when a skip drain page answers %s (%s) through its retries, as v0.11.0 did',
    async (_answer, reason, failure) => {
      vi.useFakeTimers();
      // meta.total at the ceiling: the drain pages by skip, request for request as v0.11.0.
      const records = match(25_000, 380);
      const urls = fakeOpenFda(records, {
        answer: (url) => (url.searchParams.get('skip') === '12100' ? failure() : undefined),
      });
      const { pending } = stage();
      const outcome = pending.catch((e: unknown) => e);
      await settle(outcome);
      const error = await outcome;

      expect(urls.some((url) => url.searchParams.has('search_after'))).toBe(false);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).data).toMatchObject({ reason });
    },
  );

  it.each([
    ['empty (a 404)', 0],
    ['short', 10],
  ])(
    'ends the drain as upstream_end, keeping every row, when a continuation past 25,000 comes back %s',
    async (_page, served) => {
      const records = match(40_000, 380);
      const failing = '0=r30099';
      fakeOpenFda(records, {
        answer: (url) => {
          if (url.searchParams.get('search_after') !== failing) return;
          return served === 0
            ? respond(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } })
            : respond(200, {
                meta: {
                  last_updated: '2026-11-20',
                  results: { skip: 0, limit: 1_000, total: records.length },
                },
                results: records.slice(30_100, 30_100 + served),
              });
        },
      });
      const { ids, pending } = stage();
      const spill = await pending;

      expect(ids).toEqual(records.slice(0, 30_100 + served).map((r) => r.id));
      expect(spill.truncatedBy).toBe('upstream_end');
    },
  );

  it('rethrows the caller’s cancel while a failing continuation retries, sending no skip page', async () => {
    vi.useFakeTimers();
    const records = match(40_000, 380);
    const failing = '0=r30099';
    const urls = fakeOpenFda(records, {
      answer: (url) =>
        url.searchParams.get('search_after') === failing
          ? respond(503, { error: { code: 'SERVER_ERROR', message: 'Check your request' } })
          : undefined,
    });
    const controller = new AbortController();
    const { pending } = stage({ signal: controller.signal });
    const outcome = pending.catch((e: unknown) => e);

    // Let the walk reach the failing continuation; its first attempt fails and a retry backoff begins.
    const reached = () => urls.some((url) => url.searchParams.get('search_after') === failing);
    for (let i = 0; i < 1_000 && !reached(); i++) await vi.advanceTimersByTimeAsync(0);
    expect(urls.map(requestOf).at(-1)).toBe(`after ${failing}`);
    controller.abort();
    await settle(outcome);

    // The caller's own abort reason, as the service rethrows it from a retry backoff — no staged result.
    expect(await outcome).toBe(controller.signal.reason);
    // Only the probe went out by skip: no fallback after the cancel.
    expect(urls.map(requestOf).filter((r) => r.startsWith('skip'))).toEqual(['skip 0']);
  });

  it('crashes on a continuation that throws anything but a typed upstream error, sending no skip page', async () => {
    const records = match(40_000, 380);
    const urls = fakeOpenFda(records);
    const { pending, query } = stage();
    const bug = new TypeError('a bug, not an upstream failure');
    const throughService: Service['query'] = Object.getPrototypeOf(makeService()).query;
    query.mockImplementation(function (this: Service, endpoint, params, ...rest) {
      if (params.searchAfter?.value === '0=r12099') return Promise.reject(bug);
      return throughService.call(this, endpoint, params, ...rest);
    });
    const error = await pending.catch((e: unknown) => e);

    expect(error).toBe(bug);
    expect(urls.map(requestOf).filter((r) => r.startsWith('skip'))).toEqual(['skip 0']);
  });
});

/*
 * #104 — the inline page of a staged call is cut exactly as the plain path cuts
 * the same window (`inlinePage`), `omitted_fields` and `projected_fields`
 * included, while the drain stages every record whole. Tabled across the whole
 * matrix: `canvas_id` supplied or omitted × `skip` inside the probe window or
 * past it (a separate page request) × `fields` set or not × `include` set or not.
 */
describe('spillSearch — the inline cut against the plain path (#104)', () => {
  const ID = ['recall_number'];
  const record = (i: number): Record<string, unknown> => ({
    recall_number: `Z-${i}`,
    recalling_firm: `Firm ${i}`,
    code_info: `Lot ${i}`,
    more_code_info: i % 2 === 0 ? '' : `More ${i}`,
  });
  function makeDeviceSvc(total: number) {
    return {
      query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
        const skip = params.skip ?? 0;
        const limit = params.limit ?? 1000;
        const results: Record<string, unknown>[] = [];
        for (let i = skip; i < Math.min(skip + limit, total); i++) results.push(record(i));
        return { meta: { total, skip, limit, lastUpdated: '2026-11-22' }, results };
      }),
    };
  }
  function makeCapturingCanvas(canvasId: string) {
    const rows: Record<string, unknown>[] = [];
    const instance = {
      canvasId,
      isNew: true,
      registerTable: vi.fn(async (name: string, source: AsyncIterable<Record<string, unknown>>) => {
        for await (const row of source) rows.push(row);
        return { tableName: name, rowCount: rows.length, columns: [] };
      }),
      drop: vi.fn(),
    };
    return { canvas: { acquire: vi.fn().mockResolvedValue(instance) }, rows };
  }

  const cells = [undefined, 'cv_prior00'].flatMap((canvasId) =>
    [0, 150].flatMap((skip) =>
      [undefined, ['recalling_firm']].flatMap((fields) =>
        [undefined, ['code_info']].map((include) => ({ canvasId, skip, fields, include })),
      ),
    ),
  );

  it.each(cells)(
    'agrees with inlinePage for $canvasId, skip $skip, fields $fields, include $include',
    async ({ canvasId, skip, fields, include }) => {
      const total = 300;
      const svc = makeDeviceSvc(total);
      await setSvcMock(svc);
      const { canvas, rows } = makeCapturingCanvas(canvasId ?? 'cv_fresh');
      await setCanvasMock(canvas);
      const projection = pageProjection('device/enforcement', ID, { fields, include });

      const spill = await spillSearch({
        endpoint: 'device/enforcement',
        schema: SCHEMA,
        ctx: createMockContext(),
        limit: 4,
        skip,
        canvasId,
        projection,
      });
      const staged = canvasResult(spill);
      const plain = inlinePage(
        await makeDeviceSvc(total).query('device/enforcement', { limit: 4, skip }),
        4,
        projection,
      );

      expect(canvas.acquire).toHaveBeenCalledWith(canvasId, expect.anything());
      expect(staged.results).toEqual(plain.results);
      expect(staged.results.map((r) => r.recall_number)).toEqual(
        [0, 1, 2, 3].map((i) => `Z-${skip + i}`),
      );
      expect(staged.omitted_fields).toEqual(plain.omitted_fields);
      expect(staged.projected_fields).toEqual(plain.projected_fields);
      if (fields) {
        expect(staged).not.toHaveProperty('omitted_fields');
        expect(staged.projected_fields).toEqual(include ? [...fields, ...include] : fields);
      } else {
        expect(staged.omitted_fields?.map((f) => f.path)).toEqual(
          include ? ['more_code_info'] : ['code_info', 'more_code_info'],
        );
      }
      // Every matched record reached the table whole, left-out paths included.
      expect(rows).toEqual(Array.from({ length: total }, (_, i) => record(i)));
    },
  );
});

/*
 * #73, #92 — `meta.limit` is the page size applied to the request, as the call
 * resolved it. The staged response must report what the plain path reports for
 * the same request, so a short or empty window never reads as a smaller limit.
 */
describe('canvasResult meta.limit (#73)', () => {
  beforeEach(async () => {
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);
  });

  const stagedMeta = async (
    svc: ReturnType<typeof makeSvc>,
    window: { limit: number; skip: number },
  ) => {
    await setSvcMock(svc);
    const spill = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx: createMockContext(),
      ...window,
    });
    return { spill, result: canvasResult(spill) };
  };

  it('reports the requested limit on a staged miss', async () => {
    const { result } = await stagedMeta(makeSvc(0), { limit: 2, skip: 0 });
    expect(result.results).toHaveLength(0);
    expect(result.meta.limit).toBe(2);
  });

  it('reports the requested limit when the window runs past the end of the match', async () => {
    const { result } = await stagedMeta(makeSvc(50), { limit: 5, skip: 100 });
    expect(result.results).toHaveLength(0);
    expect(result.meta).toEqual({ total: 50, skip: 100, limit: 5, lastUpdated: '2026-06-01' });
  });

  it('reports the requested limit when fewer records matched than it asked for', async () => {
    const { result } = await stagedMeta(makeSvc(3), { limit: 10, skip: 0 });
    expect(result.results).toHaveLength(3);
    expect(result.meta.limit).toBe(10);
  });

  it('reports the requested limit on a full page', async () => {
    const { result } = await stagedMeta(makeSvc(2500), { limit: 10, skip: 0 });
    expect(result.results).toHaveLength(10);
    expect(result.meta.limit).toBe(10);
  });

  it('keeps every record and the requested limit on a page past 24,000 bytes', async () => {
    // ~10 KB records: the earlier byte budget kept two of these ten and reported limit 2.
    const { result } = await stagedMeta(makeSvc(40, 10_000), { limit: 10, skip: 0 });
    expect(result.results).toHaveLength(10);
    expect(result.meta.limit).toBe(10);
    expect(result).not.toHaveProperty('page_omitted');
    expect(result).not.toHaveProperty('page_bytes');
  });

  it('keeps the requested limit for a lone record over 24,000 bytes, and states its size', async () => {
    const { result } = await stagedMeta(makeSvc(1, 70_000), { limit: 10, skip: 0 });
    expect(result.results).toHaveLength(1);
    expect(result).not.toHaveProperty('page_omitted');
    expect(result.page_bytes).toBeGreaterThan(24_000);
    expect(result.meta.limit).toBe(10);
  });
});

describe('stagingNotice', () => {
  const base = {
    canvasId: 'cv_1',
    lastUpdated: '2026-06-01',
    limit: 10,
    preview: [],
    previewOversized: {},
    skip: 0,
    spilled: true,
    stagedRows: 235,
    tableName: 'spilled_ab12cd34',
    total: 609_468,
  };

  it('routes a truncated stage to openfda_count_values for whole-match aggregates (#36)', () => {
    const notice = stagingNotice({ ...base, truncatedBy: 'size_budget' });
    expect(notice).toContain('narrow the query');
    expect(notice).toContain('openfda_count_values');
  });

  /*
   * #110 — the cause comes from what stopped the drain, never from the row
   * count: a size budget can stop past 25,000 rows, and a time budget anywhere.
   */
  it.each([
    ['size_budget', 25_000, 'Staging stopped at its size budget,'],
    ['row_ceiling', 30_100, "Staging stopped at openFDA's 25000-row pagination ceiling,"],
    ['time_budget', 15_100, 'Staging stopped at its time budget,'],
    ['upstream_end', 3, 'Staging stopped at the last record openFDA served,'],
  ] as const)(
    'names %s as the cause, whatever the staged row count',
    (truncatedBy, rows, cause) => {
      const notice = stagingNotice({ ...base, stagedRows: rows, truncatedBy });
      expect(notice).toContain(cause);
      expect(notice).toContain(`the table holds the first ${rows} records`);
      expect(notice.match(/Staging stopped at/g)).toHaveLength(1);
    },
  );

  it('omits the aggregate route when the whole match was staged (#36)', () => {
    const notice = stagingNotice({ ...base, stagedRows: 609_468 });
    expect(notice).not.toContain('openfda_count_values');
    expect(notice).not.toContain('Staging stopped');
  });

  it('names openfda_dataframe_describe before openfda_dataframe_query, truncated or not (#50)', () => {
    for (const truncatedBy of ['size_budget', undefined] as const) {
      const notice = stagingNotice({ ...base, truncatedBy });
      const describeAt = notice.indexOf('openfda_dataframe_describe');
      expect(describeAt).toBeGreaterThan(-1);
      expect(describeAt).toBeLessThan(notice.indexOf('openfda_dataframe_query'));
      expect(notice).toContain('canvas_id "cv_1"');
      expect(notice).toContain('"spilled_ab12cd34"');
      /** #36's aggregate route still closes a truncated notice, unchanged. */
      expect(notice.endsWith(AGGREGATE_ROUTE)).toBe(truncatedBy !== undefined);
    }
  });

  it('keeps the nothing-staged notice free of SQL pointers', () => {
    const notice = stagingNotice({
      ...base,
      spilled: false,
      stagedRows: 0,
      tableName: '',
    });
    expect(notice).toBe('Nothing was staged on canvas "cv_1" — 609468 records matched.');
  });
});

describe('canvasResult truncation fields (#110)', () => {
  const base = {
    canvasId: 'cv_1',
    lastUpdated: '2026-06-01',
    limit: 10,
    preview: [],
    previewOversized: {},
    skip: 0,
    spilled: true,
    stagedRows: 235,
    tableName: 'spilled_ab12cd34',
    total: 609_468,
  };

  it.each(['size_budget', 'row_ceiling', 'time_budget', 'upstream_end'] as const)(
    'carries truncated_by %s beside truncated, leaving the other staged fields as they were',
    (truncatedBy) => {
      expect(canvasResult({ ...base, truncatedBy })).toEqual({
        meta: { total: 609_468, skip: 0, limit: 10, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
        truncated_by: truncatedBy,
      });
    },
  );

  it('carries neither field when the whole match was staged', () => {
    const result = canvasResult({ ...base, stagedRows: 609_468 });
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('truncated_by');
  });
});

describe('canvasOutputShape', () => {
  it('declares truncated_by as an optional stop cause, and truncated lists no causes of its own (#110)', () => {
    expect(canvasOutputShape.truncated_by.safeParse(undefined).success).toBe(true);
    expect(canvasOutputShape.truncated_by.unwrap().options).toEqual([
      'size_budget',
      'row_ceiling',
      'time_budget',
      'upstream_end',
    ]);
    expect(canvasOutputShape.truncated_by.description).toBe(
      'Why staging stopped short of meta.total (upstream_end: openFDA served no more records). Only when truncated is.',
    );
    // The time budget is a third cause; a list of two in truncated's description would be wrong.
    expect(canvasOutputShape.truncated.description).not.toMatch(/size budget|ceiling/);
  });

  it('names both dataframe tools on canvas_table (#50)', () => {
    const text = canvasOutputShape.canvas_table.description ?? '';
    expect(text).toContain('openfda_dataframe_describe');
    expect(text).toContain('openfda_dataframe_query');
  });

  it('points canvas_id at both dataframe tools and a later staged search', () => {
    expect(canvasOutputShape.canvas_id.description).toBe(
      'Canvas id of the staged set: pass to openfda_dataframe_describe, openfda_dataframe_query, or a later staged search.',
    );
  });
});

describe('canvasIdInput', () => {
  it('names the tools whose staged calls issue a canvas_id, and stages onto it', () => {
    expect(canvasIdInput.description).toBe(
      'canvas_id from an earlier staged call to openfda_search_* or openfda_lookup_ndc: stages this call onto that canvas too (as stage=true does), so its tables can be joined.',
    );
  });

  it('is optional', () => {
    expect(canvasIdInput.safeParse(undefined).success).toBe(true);
  });
});

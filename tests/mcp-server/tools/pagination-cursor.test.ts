/**
 * @fileoverview The `search_after` cursor at its own seam (#97): the token a
 * page issues and the next call resolves, its strict decode, its binding to the
 * endpoint, `search`, and `sort` a call sends, the call inputs it cannot be
 * combined with, when a page issues one, and a walk across a fake service that
 * answers by `search_after` value the way openFDA does. Per-tool wiring is
 * asserted in the pagination contract suites.
 * @module tests/mcp-server/tools/pagination-cursor.test
 */

import { Buffer } from 'node:buffer';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  type CursorQuery,
  cursorBlockedNotice,
  cursorEndNotice,
  cursorInput,
  cursorOutputShape,
  invalidCursorError,
  nextCursorField,
  resolveCursor,
} from '@/mcp-server/tools/pagination-cursor.js';
import type { OpenFdaQueryParams, OpenFdaResponse } from '@/services/openfda/types.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

const QUERY: CursorQuery = {
  endpoint: 'tobacco/problem',
  search: 'tobacco_products:"Electronic cigarette"',
  sort: 'date_submitted:desc',
};

/** A value shaped like openFDA's, with the characters a keyword sort puts in one. */
const SEARCH_AFTER = '0=www.vitaminbestbuy.com;1=014f49b7c9b7702e8a29d84db374124b';

/** A response page: `returned` records from `skip`, of `total`, linked by `nextSearchAfter`. */
function page(
  skip: number,
  returned: number,
  total: number,
  nextSearchAfter?: string,
): Pick<OpenFdaResponse, 'meta' | 'nextSearchAfter' | 'results'> {
  return {
    meta: { skip, total, limit: 1000, lastUpdated: '2026-11-21' },
    results: Array.from({ length: returned }, (_, i) => ({ report_id: `r-${skip + i}` })),
    ...(nextSearchAfter !== undefined && { nextSearchAfter }),
  };
}

/** The token a page issues; fails the test when none is issued. */
function issued(response = page(0, 25, 100, SEARCH_AFTER), query = QUERY): string {
  const { next_cursor } = nextCursorField(response, query);
  if (next_cursor === undefined) throw new Error('expected a next_cursor');
  return next_cursor;
}

type CallInput = Parameters<typeof resolveCursor>[0];

/** Resolve `cursor` for a call, returning the thrown failure instead of throwing. */
function resolve(
  input: Partial<CallInput> & { cursor?: string | undefined },
  query: CursorQuery = QUERY,
) {
  const ctx = createMockContext({ errors: [invalidCursorError] });
  try {
    return { searchAfter: resolveCursor({ skip: 0, ...input }, query, ctx) };
  } catch (error) {
    return { error: error as McpError };
  }
}

/** Rewrite the JSON inside a token, keeping everything else. */
function reshape(token: string, edit: (json: string) => string): string {
  const json = Buffer.from(token, 'base64url').toString('utf8');
  return Buffer.from(edit(json), 'utf8').toString('base64url');
}

describe('the cursor input', () => {
  it('advertises a base64url pattern, so an empty value is refused before the call', () => {
    const schema = z.toJSONSchema(z.object({ cursor: cursorInput })) as unknown as {
      properties: { cursor: { pattern?: string; description?: string } };
      required?: string[];
    };
    expect(schema.properties.cursor.pattern).toBe('^[A-Za-z0-9_-]+$');
    expect(schema.properties.cursor.description).toContain('next_cursor from the previous page');
    expect(schema.required ?? []).not.toContain('cursor');
  });

  it.each([
    ['an empty value', ''],
    ['a standard-base64 plus', 'ab+c'],
    ['a standard-base64 slash', 'ab/c'],
    ['padding', 'abc='],
    ['a space', 'ab c'],
    ['a trailing line break', 'abc\n'],
  ])('rejects %s', (_name, value) => {
    expect(cursorInput.safeParse(value).success).toBe(false);
  });

  it('accepts a token a page issued, and an omitted value', () => {
    expect(cursorInput.safeParse(issued()).success).toBe(true);
    expect(cursorInput.safeParse(undefined).success).toBe(true);
  });
});

describe('nextCursorField and resolveCursor', () => {
  it('resolves an issued token to the same search_after value and the next position', () => {
    const token = issued(page(0, 25, 100, SEARCH_AFTER));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolve({ cursor: token }).searchAfter).toEqual({ position: 25, value: SEARCH_AFTER });
  });

  it('carries a search_after value with non-ASCII characters through unchanged', () => {
    const value = '0=Café Ünïcode “quoted” 東京;1=abc';
    expect(resolve({ cursor: issued(page(0, 3, 10, value)) }).searchAfter?.value).toBe(value);
  });

  it('advances from the page position by the records the page holds, not by its limit', () => {
    // A cursor page reports its walk position as meta.skip; this one returned 7 of limit 1000.
    const token = issued(page(26_000, 7, 30_231, SEARCH_AFTER));
    expect(resolve({ cursor: token }).searchAfter?.position).toBe(26_007);
  });

  it('returns no searchAfter for a call without a cursor', () => {
    expect(resolve({}).searchAfter).toBeUndefined();
    expect(resolve({ skip: 40, stage: true, canvas_id: 'cv_1' }).searchAfter).toBeUndefined();
  });

  it('accepts the cursor with skip 0 and stage false stated explicitly', () => {
    expect(resolve({ cursor: issued(), skip: 0, stage: false }).searchAfter?.position).toBe(25);
  });

  it('accepts the same query rebuilt by the next call', () => {
    expect(resolve({ cursor: issued() }, { ...QUERY }).searchAfter).toBeDefined();
  });

  describe('issues nothing', () => {
    it.each([
      ['when openFDA linked no search_after page', page(0, 25, 100)],
      [
        'when the link carried an empty search_after, which openFDA reads as page one',
        page(0, 25, 100, ''),
      ],
      ['on an exactly full last page, whose link answers 404', page(75, 25, 100, SEARCH_AFTER)],
      ['when the page runs past a total that shrank', page(90, 25, 100, SEARCH_AFTER)],
      ['on an empty page', page(0, 0, 0, SEARCH_AFTER)],
      [
        'when openFDA linked a next page the walk cannot follow',
        { ...page(0, 25, 100), searchAfterBlocked: 'missing_sort_value' as const },
      ],
    ])('%s', (_name, response) => {
      expect(nextCursorField(response, QUERY)).toEqual({});
    });
  });
});

describe('invalid_cursor', () => {
  it('declares a ValidationError raised below the handler body', () => {
    expect(invalidCursorError).toMatchObject({
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
    });
  });

  describe('a cursor sent with an input it cannot be combined with', () => {
    it.each([
      [{ skip: 25 }, ['skip=25'], ['stage', 'canvas_id']],
      [{ stage: true }, ['stage=true'], ['skip=', 'canvas_id']],
      [{ canvas_id: 'cv_1' }, ['canvas_id'], ['skip=', 'stage']],
      [{ skip: 5, stage: true, canvas_id: 'cv_1' }, ['skip=5', 'stage=true', 'canvas_id'], []],
    ] as const)('%o names %o', (conflicts, named, unnamed) => {
      const { error } = resolve({ cursor: issued(), ...conflicts });
      expect(error?.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
      for (const name of named) expect(error?.message).toContain(name);
      for (const name of unnamed) expect(error?.message).not.toContain(name);
      expect(error?.message).toMatch(/^cursor cannot be combined with/);
    });

    it('is refused for the conflict before the token is read', () => {
      expect(resolve({ cursor: 'garbage', skip: 5 }).error?.message).toContain('skip=5');
    });
  });

  describe('a cursor issued for another query', () => {
    it.each([
      ['another endpoint', { ...QUERY, endpoint: 'drug/enforcement' }],
      ['another search', { ...QUERY, search: 'tobacco_products:"Cigarette"' }],
      ['no search', { ...QUERY, search: undefined }],
      ['the opposite sort direction', { ...QUERY, sort: 'date_submitted:asc' }],
      ['no sort', { ...QUERY, sort: undefined }],
    ])('is refused for %s', (_name, query) => {
      const { error } = resolve({ cursor: issued() }, query);
      expect(error?.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(error?.message).toBe(
        'cursor was issued for a different endpoint, search, or sort than this call sends.',
      );
    });

    it('tells a value that only moved between fields apart', () => {
      const token = issued(page(0, 1, 5, SEARCH_AFTER), {
        endpoint: 'tobacco/problem',
        search: 'a',
      });
      expect(
        resolve({ cursor: token }, { endpoint: 'tobacco/problem', sort: 'a' }).error,
      ).toBeDefined();
    });
  });

  describe('a cursor that does not decode', () => {
    const UNDECODABLE = 'cursor does not decode as a next_cursor this server issued.';

    it.each([
      ['base64url that is not JSON', 'bm90IGpzb24'],
      ['one stray character', 'A'],
      ['a JSON value that is not an object', Buffer.from('[1,"a","b"]').toString('base64url')],
    ])('is refused for %s', (_name, cursor) => {
      const { error } = resolve({ cursor });
      expect(error?.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(error?.message).toBe(UNDECODABLE);
    });

    it.each([
      ['a missing position', (json: string) => json.replace(/"p":\d+,/, '')],
      ['a zero position', (json: string) => json.replace(/"p":\d+/, '"p":0')],
      ['a fractional position', (json: string) => json.replace(/"p":\d+/, '"p":2.5')],
      ['a string position', (json: string) => json.replace(/"p":(\d+)/, '"p":"$1"')],
      ['an empty search_after value', (json: string) => json.replace(/"a":"[^"]*"/, '"a":""')],
      ['a short query hash', (json: string) => json.replace(/"q":"([^"]{3})[^"]*"/, '"q":"$1"')],
      ['an unknown key', (json: string) => json.replace(/^\{/, '{"extra":1,')],
      ['a __proto__ key', (json: string) => json.replace(/^\{/, '{"__proto__":{"p":1},')],
      ['a constructor key', (json: string) => json.replace(/^\{/, '{"constructor":"x",')],
    ])('is refused for %s, keeping the issued hash', (_name, edit) => {
      const forged = reshape(issued(), edit);
      expect(forged).not.toBe(issued());
      const { error } = resolve({ cursor: forged });
      expect(error?.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(error?.message).toBe(UNDECODABLE);
    });

    it('accepts the untouched token the forgeries were cut from', () => {
      expect(resolve({ cursor: reshape(issued(), (json) => json) }).searchAfter).toBeDefined();
    });
  });
});

describe('cursorEndNotice', () => {
  const AFTER = { position: 75, value: SEARCH_AFTER };

  it('says the walk is complete on a cursor page that holds the last record', () => {
    expect(cursorEndNotice(page(75, 25, 100), AFTER)).toBe(
      'This page holds the last 25 of the 100 matched records, so the cursor walk is complete.',
    );
  });

  it.each([
    ['a cursor page with records after it', page(50, 25, 100), AFTER],
    ['an empty cursor page', page(100, 0, 100), AFTER],
    ['a page read without a cursor', page(75, 25, 100), undefined],
  ])('says nothing on %s', (_name, response, searchAfter) => {
    expect(cursorEndNotice(response, searchAfter)).toBeUndefined();
  });
});

describe('cursorBlockedNotice', () => {
  /** A page whose openFDA next link the walk cannot follow: `returned` records from `skip`, of `total`. */
  const blocked = (
    skip: number,
    returned: number,
    total: number,
    why: 'missing_sort_value' | 'repeated_link' = 'missing_sort_value',
  ) => ({
    ...page(skip, returned, total),
    searchAfterBlocked: why,
  });
  const sortedBy = (sort?: string): CursorQuery => ({
    endpoint: 'food/enforcement',
    search: 'recalling_firm:"Acme"',
    sort,
  });

  it.each([
    [
      'a one-key sort, the next page within the skip ceiling',
      blocked(0, 2, 9),
      'termination_date:desc',
      'openFDA cannot continue a walk sorted by `termination_date:desc` past records that lack the sort field, which sort last, so this page carries no next_cursor though 7 of the 9 matched records follow it. To read on, re-run with skip=2 and the same search and sort, add `_exists_:termination_date` to the search to keep only records that carry it, or sort by another field.',
    ],
    [
      'a cursor page whose next page starts exactly at the ceiling',
      blocked(24_000, 1_000, 30_000),
      'termination_date:asc',
      'openFDA cannot continue a walk sorted by `termination_date:asc` past records that lack the sort field, which sort last, so this page carries no next_cursor though 5000 of the 30000 matched records follow it. To read on, re-run with skip=25000 and the same search and sort, add `_exists_:termination_date` to the search to keep only records that carry it, or sort by another field.',
    ],
    [
      'a cursor page whose next page starts past the ceiling',
      blocked(25_000, 1_000, 30_000),
      'termination_date:desc',
      'openFDA cannot continue a walk sorted by `termination_date:desc` past records that lack the sort field, which sort last, so this page carries no next_cursor though 4000 of the 30000 matched records follow it. To read on, add `_exists_:termination_date` to the search to keep only records that carry it, or sort by another field.',
    ],
    [
      'a multi-key sort, .exact read as its field and the spaces openFDA trims dropped',
      blocked(0, 3, 9),
      '  report_date:desc , status.exact:asc,report_date:asc ',
      'openFDA cannot continue a walk sorted by `report_date:desc , status.exact:asc,report_date:asc` past records that lack a sort field, which sort last, so this page carries no next_cursor though 6 of the 9 matched records follow it. To read on, re-run with skip=3 and the same search and sort, add `_exists_:report_date AND _exists_:status` to the search to keep only records that carry every sort field, or sort by another field.',
    ],
    [
      'an unsorted walk whose link repeats the page, within the ceiling',
      blocked(4, 1, 9, 'repeated_link'),
      undefined,
      'openFDA linked a next page that repeats this one, so this page carries no next_cursor though 4 of the 9 matched records follow it. To read on, re-run with skip=5 and the same search.',
    ],
    [
      'an unsorted walk whose link repeats the page, past the ceiling',
      blocked(26_000, 1, 26_009, 'repeated_link'),
      undefined,
      'openFDA linked a next page that repeats this one, so this page carries no next_cursor though 8 of the 26009 matched records follow it. To read on, narrow the search.',
    ],
    [
      'an unsorted walk whose link carries a missing-value marker, which can only repeat the page',
      blocked(4, 1, 9),
      undefined,
      'openFDA linked a next page that repeats this one, so this page carries no next_cursor though 4 of the 9 matched records follow it. To read on, re-run with skip=5 and the same search.',
    ],
    [
      'a sorted walk whose link repeats the page, blaming no sort field',
      blocked(4, 1, 9, 'repeated_link'),
      'termination_date:desc',
      'openFDA linked a next page that repeats this one, so this page carries no next_cursor though 4 of the 9 matched records follow it. To read on, re-run with skip=5 and the same search and sort.',
    ],
  ])('names the routes on %s', (_name, response, sort, notice) => {
    expect(cursorBlockedNotice(response, sortedBy(sort))).toBe(notice);
  });

  it.each([
    ['a page openFDA linked normally', page(0, 2, 9, SEARCH_AFTER)],
    ['a page with no link', page(0, 2, 9)],
    ['a blocked page that ends the match', blocked(0, 9, 9)],
    ['a blocked page past a total that shrank', blocked(5, 9, 9)],
  ])('says nothing on %s', (_name, response) => {
    expect(cursorBlockedNotice(response, sortedBy('termination_date:desc'))).toBeUndefined();
  });

  it('stays linear over a long sort', { timeout: 120_000 }, () => {
    const run = (sort: string) => cursorBlockedNotice(blocked(0, 2, 9), sortedBy(sort));
    const shapes: [string, (n: number) => string][] = [
      ['one long line ending in a break', (n) => `${'a.exact:desc,'.repeat(n / 13)}b\n`],
      ['breaks throughout', (n) => 'a,\n'.repeat(n / 3)],
    ];
    for (const [, build] of shapes) {
      const { t5k, t320k } = linearTiming(run, build(5_000), build(320_000));
      expect(t320k / t5k).toBeLessThan(256);
      expect(t320k).toBeLessThan(500_000);
    }
  });
});

describe('the next_cursor output', () => {
  it('says the cursor is present only while openFDA can continue the walk, in one sentence', () => {
    const description = cursorOutputShape.next_cursor.description ?? '';
    expect(description).toContain('and openFDA can continue the walk');
    expect(description.match(/[.;]\s/g) ?? []).toHaveLength(1);
  });
});

/**
 * A stand-in for openFDA: answers a `search_after` value with the records after
 * the record it names, never by `position`, and links every non-empty page —
 * the exactly full last one included — the way openFDA does. `served` caps
 * each page below the requested `limit`, as a clamp or a short page would.
 */
function fakeOpenFda(total: number, served: readonly number[]) {
  const ids = Array.from({ length: total }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
  const calls: OpenFdaQueryParams[] = [];
  return {
    calls,
    ids,
    query(
      params: OpenFdaQueryParams,
    ): Pick<OpenFdaResponse, 'meta' | 'nextSearchAfter' | 'results'> {
      calls.push(params);
      const from = params.searchAfter
        ? ids.indexOf(params.searchAfter.value.replace(/^0=/, '')) + 1
        : (params.skip ?? 0);
      const size = Math.min(
        params.limit ?? 25,
        served[calls.length - 1] ?? Number.POSITIVE_INFINITY,
      );
      const slice = ids.slice(from, from + size);
      return {
        meta: {
          // The service reports a cursor page's position as meta.skip; openFDA itself says 0.
          skip: params.searchAfter?.position ?? params.skip ?? 0,
          total,
          limit: params.limit ?? 25,
          lastUpdated: '2026-11-21',
        },
        results: slice.map((id) => ({ report_id: id })),
        ...(slice.length > 0 && { nextSearchAfter: `0=${slice.at(-1)}` }),
      };
    },
  };
}

describe('a walk across a fake openFDA', () => {
  it('returns every record once, in order, across short and changing pages', () => {
    // 23 records; limits change every page and the fake serves fewer than asked on two of them.
    const upstream = fakeOpenFda(23, [5, 3, 7, 2, 6]);
    const limits = [5, 9, 7, 4, 6, 10];
    const seen: string[] = [];
    const positions: number[] = [];
    let cursor: string | undefined;

    for (const limit of limits) {
      const searchAfter = resolve({ cursor }).searchAfter;
      const response = upstream.query({ search: QUERY.search, limit, skip: 0, searchAfter });
      positions.push(response.meta.skip);
      expect(response.meta.skip).toBe(seen.length);
      seen.push(...response.results.map((r) => String(r.report_id)));
      cursor = nextCursorField(response, QUERY).next_cursor;
      if (!cursor) break;
    }

    expect(upstream.calls.length).toBeGreaterThanOrEqual(3);
    expect(positions).toEqual([0, 5, 8, 15, 17]);
    expect(seen).toEqual(upstream.ids);
    expect(new Set(seen).size).toBe(23);
    // The exactly full last page (6 of 6 remaining) carried a link; no cursor was issued from it.
    expect(cursor).toBeUndefined();
  });

  it('would have skipped records had it advanced by limit', () => {
    const upstream = fakeOpenFda(12, [3]);
    const first = upstream.query({ limit: 5, skip: 0 });
    const searchAfter = resolve({ cursor: nextCursorField(first, QUERY).next_cursor }).searchAfter;
    expect(searchAfter?.position).toBe(3);
    expect(upstream.query({ limit: 5, searchAfter }).results[0]).toEqual({
      report_id: 'doc-003',
    });
  });
});

describe('cursor decoding stays linear', { timeout: 120_000 }, () => {
  /** Pattern check then resolution, as an argument parse and the handler run them. */
  const parseAndResolve = (cursor: string) => {
    if (!cursorInput.safeParse(cursor).success) return;
    resolve({ cursor });
  };

  /** A token that decodes, carrying an `n`-character search_after value. */
  const longToken = (n: number) => issued(page(0, 1, 5, `0=${'x'.repeat(n)}`));

  /** A long token resolved against a query it was not issued for. */
  const resolveForeign = (cursor: string) => resolve({ cursor }, { ...QUERY, sort: undefined });
  const valueLength = (n: number) => Math.floor((n * 3) / 4) - 60;

  const shapes: [string, (n: number) => string, (cursor: string) => unknown][] = [
    [
      'a run of base64url characters that decodes to garbage',
      (n) => 'A'.repeat(n),
      parseAndResolve,
    ],
    ['a valid run ending on an invalid character', (n) => `${'A'.repeat(n - 1)}=`, parseAndResolve],
    ['one long line ending in a break', (n) => `${'A'.repeat(n - 1)}\n`, parseAndResolve],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4), parseAndResolve],
    ['a decodable token with a long value', (n) => longToken(valueLength(n)), parseAndResolve],
    ['a decodable token for another query', (n) => longToken(valueLength(n)), resolveForeign],
  ];

  it.each(shapes)('stays linear on %s', (_name, build, run) => {
    const { t5k, t320k } = linearTiming(run, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

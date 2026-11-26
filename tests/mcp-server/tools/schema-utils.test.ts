/**
 * @fileoverview The per-endpoint page size every paged tool's `limit` resolves
 * through (#92): the default and cap table, the clamp with its log line,
 * counter, and notice, the strict `OPENFDA_CLAMP_LIMITS=false` rejection, and
 * the JSON Schema each mode advertises. Also the shared descriptions the paged
 * tools build from here (#109): `skip`, `sort`, `fields`, the `meta` output,
 * and the search-tool `notice`. Per-tool wiring is asserted where each tool is
 * tested.
 * @module tests/mcp-server/tools/schema-utils.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockLogger } from '@cyanheads/mcp-ts-core/testing';
import { createNoopMeter, type MeterProvider, metrics } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  CONJOINED_ARRAY_NOTICE_TOPIC,
  fieldsDescription,
  limitAboveCapError,
  OPENFDA_MAX_SKIP,
  PAGE_SIZES,
  type PageSize,
  pageLimit,
  pageLimitBy,
  pageMetaOutput,
  pageSizeNotice,
  paginationLimitReachedError,
  resolvePageSize,
  SKIP_DESCRIPTION,
  searchNoticeField,
  sortDescription,
} from '@/mcp-server/tools/schema-utils.js';
import { LEFT_OUT_NOTICE_TOPIC } from '@/services/openfda/record-projection.js';

/* --- page size (#92) --- */

/** Run `body` with `OPENFDA_CLAMP_LIMITS=false`, restoring the clamping default after. */
function strictly<T>(body: () => T): T {
  vi.stubEnv('OPENFDA_CLAMP_LIMITS', 'false');
  resetServerConfig();
  try {
    return body();
  } finally {
    vi.unstubAllEnvs();
    resetServerConfig();
  }
}

/** Each `add()` the fake global meter's counters receive, by instrument name. */
const recorded: { name: string; value: number; attributes: unknown }[] = [];

describe('PAGE_SIZES', () => {
  it('pins the default and cap of every endpoint and the count term list', () => {
    expect(PAGE_SIZES).toEqual({
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
    });
  });
});

describe('resolvePageSize', () => {
  beforeEach(() => {
    recorded.length = 0;
    const meter = Object.assign(createNoopMeter(), {
      createCounter: (name: string) => ({
        add: (value: number, attributes?: unknown) => {
          recorded.push({ name, value, attributes });
        },
      }),
    });
    metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider);
  });

  afterEach(() => {
    metrics.disable();
  });

  it('applies the endpoint default when limit is omitted', () => {
    const log = createMockLogger();
    expect(resolvePageSize(undefined, 'drug/event', { log })).toEqual({
      cap: 25,
      kind: 'drug/event',
      limit: 5,
    });
    expect(log.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it.each([
    [1, 'drug/event'],
    [25, 'drug/event'],
    [1000, 'count'],
  ] as const)('applies limit=%i on %s as sent', (limit, kind) => {
    const log = createMockLogger();
    const size = resolvePageSize(limit, kind, { log });
    expect(size.limit).toBe(limit);
    expect(size.clampedFrom).toBeUndefined();
    expect(log.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('clamps cap + 1 to the cap with one log line and one counter increment', () => {
    const log = createMockLogger();
    expect(resolvePageSize(26, 'drug/event', { log })).toEqual({
      cap: 25,
      clampedFrom: 26,
      kind: 'drug/event',
      limit: 25,
    });
    expect(log.calls).toEqual([
      {
        level: 'info',
        msg: 'Clamped limit to the endpoint cap',
        data: { endpoint: 'drug/event', requested: 26, cap: 25 },
      },
    ]);
    expect(recorded).toEqual([
      { name: 'openfda.limit.clamped', value: 1, attributes: { 'openfda.endpoint': 'drug/event' } },
    ]);
  });

  it('clamps the count term list at 1000', () => {
    const log = createMockLogger();
    expect(resolvePageSize(5000, 'count', { log })).toEqual({
      cap: 1000,
      clampedFrom: 5000,
      kind: 'count',
      limit: 1000,
    });
    expect(recorded).toEqual([
      { name: 'openfda.limit.clamped', value: 1, attributes: { 'openfda.endpoint': 'count' } },
    ]);
  });

  describe('with OPENFDA_CLAMP_LIMITS=false', () => {
    it('rejects cap + 1 as limit_above_cap, with no log line or counter', () => {
      const log = createMockLogger();
      let thrown: unknown;
      strictly(() => {
        try {
          resolvePageSize(26, 'drug/event', { log });
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'limit=26 exceeds the 25 cap for drug/event.',
        data: { reason: 'limit_above_cap', cap: 25 },
      });
      expect(log.calls).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('applies the cap itself and the default as before', () => {
      const log = createMockLogger();
      strictly(() => {
        expect(resolvePageSize(25, 'drug/event', { log }).limit).toBe(25);
        expect(resolvePageSize(undefined, 'drug/event', { log }).limit).toBe(5);
      });
    });
  });

  it('declares limit_above_cap as a service-thrown ValidationError', () => {
    expect(limitAboveCapError).toMatchObject({
      reason: 'limit_above_cap',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
    });
  });
});

describe('pageSizeNotice', () => {
  const clamped: PageSize = { cap: 25, clampedFrom: 26, kind: 'drug/event', limit: 25 };
  const page = (skip: number, returned: number, total: number) => ({
    meta: { skip, total },
    results: Array.from({ length: returned }, (_, i) => ({ i })),
  });

  it('says nothing when limit was not clamped', () => {
    expect(pageSizeNotice({ cap: 25, kind: 'drug/event', limit: 25 }, page(0, 25, 100))).toBe(
      undefined,
    );
  });

  it('names the requested value, the cap, and the next skip', () => {
    expect(pageSizeNotice(clamped, page(0, 25, 100))).toBe(
      'limit=26 is above the 25-record cap for drug/event, so 25 was applied. The next page starts at skip=25.',
    );
  });

  it('counts the next skip from the page offset', () => {
    expect(pageSizeNotice(clamped, page(50, 25, 100))).toContain('starts at skip=75.');
  });

  it('says when the page ends the match', () => {
    expect(pageSizeNotice(clamped, page(90, 10, 100))).toBe(
      'limit=26 is above the 25-record cap for drug/event, so 25 was applied; this page holds the last 10 of the 100 matched records.',
    );
  });

  it('names skip=25000 itself as reachable', () => {
    expect(pageSizeNotice(clamped, page(24_975, 25, 100_000))).toContain(
      'The next page starts at skip=25000.',
    );
  });

  // #97 — past the ceiling, the route on is a walk from skip 0, never a cursor from this skip page.
  it('says when the next page would pass the 25000-record skip ceiling, and how to read past it', () => {
    expect(pageSizeNotice(clamped, page(24_990, 25, 100_000))).toBe(
      "limit=26 is above the 25-record cap for drug/event, so 25 was applied. The next page would start at skip=25015, past openFDA's 25000-record pagination ceiling — to read past it, re-run the call from skip 0 and follow next_cursor, or narrow the search.",
    );
  });

  it('points a page that carries next_cursor past the ceiling at that cursor', () => {
    // A page read by cursor reports its walk position as meta.skip.
    const cursorPage = { ...page(25_980, 25, 100_000), next_cursor: 'eyJwIjoxfQ' };
    expect(pageSizeNotice(clamped, cursorPage)).toBe(
      "limit=26 is above the 25-record cap for drug/event, so 25 was applied. The next page would start at skip=26005, past openFDA's 25000-record pagination ceiling — follow next_cursor to read it.",
    );
  });

  // A walk openFDA cannot continue: re-running from skip 0 reaches the same link, so the blocked notice names the way on.
  it.each(['missing_sort_value', 'repeated_link'] as const)(
    'names no route past the ceiling on a page whose next link is blocked (%s)',
    (searchAfterBlocked) => {
      const blocked = { ...page(25_980, 25, 100_000), searchAfterBlocked };
      expect(pageSizeNotice(clamped, blocked)).toBe(
        "limit=26 is above the 25-record cap for drug/event, so 25 was applied. The next page would start at skip=26005, past openFDA's 25000-record pagination ceiling.",
      );
    },
  );

  it('counts the end of the match from a cursor page position', () => {
    expect(pageSizeNotice(clamped, page(30_206, 25, 30_231))).toContain(
      'this page holds the last 25 of the 30231 matched records.',
    );
  });

  it('states only the clamp on an empty page', () => {
    expect(pageSizeNotice(clamped, page(0, 0, 0))).toBe(
      'limit=26 is above the 25-record cap for drug/event, so 25 was applied.',
    );
  });

  it('words the count term list in terms, with no skip', () => {
    expect(pageSizeNotice({ cap: 1000, clampedFrom: 5000, kind: 'count', limit: 1000 })).toBe(
      'limit=5000 is above the 1000-term cap for a count, so 1000 was applied.',
    );
  });
});

/* --- the skip ceiling and the route past it (#97) --- */

describe('the skip ceiling wording', () => {
  it('declares one shared pagination_limit_reached entry raised below the handler body', () => {
    expect(paginationLimitReachedError).toMatchObject({
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
    });
    expect(OPENFDA_MAX_SKIP).toBe(25_000);
  });

  it.each([
    ['the recovery', paginationLimitReachedError.recovery],
    ['the skip description', SKIP_DESCRIPTION],
  ])('%s names the cursor route past skip 25000, starting at skip 0', (_name, text) => {
    expect(text).toContain('25000');
    expect(text).toMatch(/follow(ing)? next_cursor/);
    expect(text).toContain('skip 0');
  });

  it('words the skip description route as a walk from skip 0', () => {
    expect(SKIP_DESCRIPTION).toBe(
      'Records to skip, at most 25000; to read past that, follow next_cursor from skip 0.',
    );
  });

  it('keeps narrowing the search as the other route in the recovery', () => {
    expect(paginationLimitReachedError.recovery).toBe(
      'To read past skip 25000, re-run the call from skip 0 and follow next_cursor, or narrow the search.',
    );
  });
});

describe('the advertised limit schema', () => {
  it('advertises minimum 1, the default, and no maximum while clamping', () => {
    const schema = z.toJSONSchema(pageLimit('drug/label', 'Labels per page.'));
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      default: 5,
      type: 'integer',
      minimum: 1,
      description: 'Labels per page. Default 5; a larger value returns at most 1000 and says so.',
    });
    expect('maximum' in schema).toBe(false);
  });

  it('advertises maximum at the cap in strict mode', () => {
    const schema = strictly(() => z.toJSONSchema(pageLimit('drug/label', 'Labels per page.')));
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      default: 5,
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Labels per page. Default 5, at most 1000.',
    });
  });

  it('admits a value above the cap while clamping and rejects it in strict mode', () => {
    expect(pageLimit('count', 'Terms.').parse(1001)).toBe(1001);
    const issues = strictly(() => pageLimit('count', 'Terms.').safeParse(1001).error?.issues);
    expect(issues).toMatchObject([{ code: 'too_big', maximum: 1000, inclusive: true }]);
    expect(strictly(() => pageLimit('count', 'Terms.').parse(1000))).toBe(1000);
  });

  it.each([0, 2.5])('rejects %s in both modes', (value) => {
    expect(pageLimit('count', 'Terms.').safeParse(value).success).toBe(false);
    expect(strictly(() => pageLimit('count', 'Terms.').safeParse(value).success)).toBe(false);
  });

  describe('for a tool whose endpoint follows another input', () => {
    const byCategory = () =>
      pageLimitBy(
        'category',
        [
          ['drug', 'drug/event'],
          ['device', 'device/event'],
        ],
        'Reports per page.',
      );

    it('advertises no default and no maximum while clamping', () => {
      const schema = z.toJSONSchema(byCategory());
      expect(schema).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'integer',
        minimum: 1,
        description:
          'Reports per page. Default and cap by category: drug 5 (cap 25), device 10 (cap 175); a larger value returns at most that cap and says so.',
      });
      expect(byCategory().parse(undefined)).toBeUndefined();
    });

    it('advertises its largest cap as the strict-mode maximum', () => {
      const schema = strictly(() => z.toJSONSchema(byCategory()));
      expect(schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 175 });
      expect(schema).not.toHaveProperty('default');
      expect(schema.description).toBe(
        'Reports per page. Default and cap by category: drug 5 (cap 25), device 10 (cap 175); a value above that cap is rejected.',
      );
      // Under the largest cap, the schema admits it; resolvePageSize rejects it per endpoint.
      expect(strictly(() => byCategory().parse(26))).toBe(26);
      expect(strictly(() => byCategory().safeParse(176).success)).toBe(false);
    });
  });
});

/* --- shared descriptions (#109) --- */

describe('sortDescription', () => {
  it('states the grammar and the index order of an unsorted search', () => {
    expect(sortDescription()).toBe(
      "A field path with :asc or :desc (any letter case; :ascending and :descending also work), several comma-separated. A search without sort returns openFDA's index order, not relevance.",
    );
  });

  it('places the example after the grammar and the newest-first default before the index order', () => {
    expect(
      sortDescription({
        example: 'report_date:desc,status.exact:asc',
        newest: 'report_date:desc (event_date_initiated:desc on the device recall endpoint)',
      }),
    ).toBe(
      "A field path with :asc or :desc (any letter case; :ascending and :descending also work), several comma-separated, e.g. report_date:desc,status.exact:asc. With neither search nor sort, records come newest first by report_date:desc (event_date_initiated:desc on the device recall endpoint). A search without sort returns openFDA's index order, not relevance.",
    );
  });

  it('states a default without an example', () => {
    expect(sortDescription({ newest: 'update_date:desc' })).toContain(
      'several comma-separated. With neither search nor sort, records come newest first by update_date:desc.',
    );
  });
});

describe('fieldsDescription', () => {
  const description = fieldsDescription(
    ['recall_number', 'product_res_number'],
    ['recalling_firm', 'reason_for_recall'],
  );

  it('names the example paths, the identity keys, the catalog, and the staged scope', () => {
    expect(description).toBe(
      'Dotted record paths to keep on each record, e.g. ["recalling_firm", "reason_for_recall"], plus its identity key (recall_number, product_res_number). Any record path works (openfda_describe_fields lists searchable ones); a path through an array covers every element. Use it when page_bytes flags an oversized record; with stage=true only the inline page is projected.',
    );
  });

  // Two tools leave paths out of a default page, so omitting fields is not a whole record there.
  it('claims nothing about what omitting fields returns', () => {
    expect(description).not.toMatch(/omit/i);
    expect(description).not.toMatch(/whole record/i);
  });
});

describe('pageMetaOutput', () => {
  it('advertises the paged meta shape every search tool returns, with one text per field', () => {
    expect(z.toJSONSchema(pageMetaOutput)).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      description: 'Response metadata',
      type: 'object',
      properties: {
        total: { type: 'number', description: 'Total matching records' },
        skip: { type: 'number', description: 'Pagination offset' },
        limit: {
          type: 'number',
          description:
            'Page size applied: limit, the endpoint default, or the cap when limit exceeded it. The last page of a match holds fewer records.',
        },
        lastUpdated: { type: 'string', description: 'Dataset last updated date' },
        totalUnverified: {
          type: 'boolean',
          description:
            'True on an empty page at skip > 0 whose total could not be confirmed: total 0 then does not rule out records — re-call with skip=0.',
        },
      },
      required: ['total', 'skip', 'limit', 'lastUpdated'],
      additionalProperties: false,
    });
  });
});

describe('searchNoticeField', () => {
  it('names the topics every staging search tool shares', () => {
    expect(searchNoticeField().description).toBe(
      'Guidance for this page: empty result, limit clamp, end of a cursor walk, fields projection, oversized record, staging. Absent when nothing needs saying.',
    );
  });

  it("appends the tool's own topics in order", () => {
    expect(
      searchNoticeField([LEFT_OUT_NOTICE_TOPIC, CONJOINED_ARRAY_NOTICE_TOPIC]).description,
    ).toBe(
      'Guidance for this page: empty result, limit clamp, end of a cursor walk, fields projection, oversized record, staging, paths left out by default, SQL for AND-ed clauses on one array entry. Absent when nothing needs saying.',
    );
  });

  it('is an optional string', () => {
    expect(searchNoticeField().safeParse(undefined).success).toBe(true);
    expect(searchNoticeField().safeParse(1).success).toBe(false);
  });
});

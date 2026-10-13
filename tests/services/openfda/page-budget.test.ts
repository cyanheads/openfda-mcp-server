/**
 * @fileoverview Size breakdown and disclosure for an inline page that meets the
 * byte budget (#66): which fields of an oversized record the notice names, the
 * exactness of the sizes it reports (UTF-8 bytes of the serialized JSON, the size
 * the payload occupies on the wire), the presence rule for `page_bytes` and
 * `page_largest_fields`, and the notice's wording per case. The tool-boundary
 * contract lives in `page-budget-contract.test.ts`.
 * @module tests/services/openfda/page-budget.test
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  boundPageToBudget,
  largestFields,
  PAGE_BUDGET_BYTES,
  pageBudgetFields,
  pageBudgetNotice,
} from '@/services/openfda/page-budget.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

/** UTF-8 bytes of the serialized value — what it occupies on the wire. */
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** A recall-shaped record dominated by one top-level string. */
const RECALL = {
  product_res_number: 'Z-0030-2018',
  recalling_firm: 'ACME',
  code_info: 's'.repeat(60_000),
  openfda: { device_name: 'PUMP' },
};

/** A drug-report-shaped record dominated by a block repeated across an array. */
const REPORT = {
  safetyreportid: '17533498',
  patient: {
    reaction: [{ reactionmeddrapt: 'Nausea' }],
    drug: [
      {
        medicinalproduct: 'A',
        openfda: { brand_name: ['x'.repeat(30_000)], unii: ['u'.repeat(30_000)] },
      },
      {
        medicinalproduct: 'B',
        openfda: { brand_name: ['y'.repeat(30_000)], unii: ['v'.repeat(30_000)] },
      },
    ],
  },
};

/** The response shape a handler returns for a bounded page, built the way `boundedPage` builds it. */
const bounded = (records: Record<string, unknown>[], skip = 0) => {
  const page = boundPageToBudget(records);
  return { meta: { skip }, results: page.records, ...pageBudgetFields(page) };
};

describe('boundPageToBudget', () => {
  it('measures UTF-8 bytes of the serialized page, not UTF-16 code units', () => {
    const records = [{ text: 'é漢😀' }, { text: 'naïve' }];
    const page = boundPageToBudget(records);
    expect(page.bytes).toBe(size(records));
    // 'é' is 2 bytes, '漢' 3, '😀' 4: the code-unit count understates the page.
    expect(page.bytes).toBeGreaterThan(JSON.stringify(records).length);
  });

  it('drops a record whose UTF-8 size crosses the budget even when its code units fit', () => {
    // Each record is 18 code units but 28 bytes: two fit in 40 code units, not in 40 bytes.
    const records = [{ a: 'é'.repeat(10) }, { a: 'é'.repeat(10) }];
    expect(JSON.stringify(records).length).toBeLessThanOrEqual(40);
    const page = boundPageToBudget(records, 40);
    expect(page).toEqual({ bytes: size([records[0]]), omitted: 1, records: [records[0]] });
  });
});

describe('largestFields', () => {
  it('names a dominant top-level field with its exact serialized size', () => {
    const excess = size(RECALL) + 2 - PAGE_BUDGET_BYTES;
    expect(largestFields(RECALL, excess)).toEqual({
      covered: true,
      fields: [{ path: 'code_info', bytes: size(RECALL.code_info) }],
    });
  });

  it('drills to the deepest field that holds the excess, totalled across array elements', () => {
    const excess = size(REPORT) + 2 - PAGE_BUDGET_BYTES;
    const openfdaBytes = REPORT.patient.drug.reduce((sum, d) => sum + size(d.openfda), 0);
    // brand_name or unii alone holds ~60 KB of the ~96 KB excess, so the drill stops at openfda.
    expect(largestFields(REPORT, excess)).toEqual({
      covered: true,
      fields: [{ path: 'patient.drug.openfda', bytes: openfdaBytes }],
    });
  });

  it('lists the largest top-level fields until they cover the excess when none does alone', () => {
    const record = { a: 'a'.repeat(30_000), b: 'b'.repeat(20_000), c: 'c'.repeat(10_000), d: 'd' };
    const { covered, fields } = largestFields(record, 45_000);
    expect(covered).toBe(true);
    expect(fields).toEqual([
      { path: 'a', bytes: 30_002 },
      { path: 'b', bytes: 20_002 },
    ]);
  });

  it('caps the list at three fields and says when they do not cover the excess', () => {
    const record = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, k.repeat(10_000)]));
    const { covered, fields } = largestFields(record, 45_000);
    expect(covered).toBe(false);
    expect(fields).toHaveLength(3);
  });

  it.each([
    ['escapes and non-ASCII', 'é"\\\n\t\u0001'],
    ['three- and four-byte characters', '漢字 😀 🇺🇸'],
    ['a lone surrogate, which serializes as an ASCII escape', 'a\ud800b'],
    ['scalars', [1.5, -0, 1e21, true, null]],
    ['empty containers', [{}, [], ['']]],
    ['nested arrays of objects', [{ a: [{ b: [{ c: 'deep' }] }, {}] }, [[{ d: 1 }]]]],
    ['an object with escaped keys', { 'k"ey': { '\\': [null, { x: 'y' }] }, plain: 'v' }],
    ['an object with non-ASCII keys', { clé: { 名前: ['値'] }, ü: 'ö' }],
  ])('reports the exact serialized size of a field holding %s', (_label, value) => {
    // Asking for exactly the field's size stops the drill at the field itself.
    expect(largestFields({ field: value }, size(value)).fields).toEqual([
      { path: 'field', bytes: size(value) },
    ]);
  });
});

describe('pageBudgetFields', () => {
  it('reports page_bytes and the largest fields for a lone record over the budget', () => {
    const page = boundPageToBudget([RECALL]);
    expect(pageBudgetFields(page)).toEqual({
      page_bytes: size([RECALL]),
      page_largest_fields: [{ path: 'code_info', bytes: size(RECALL.code_info) }],
    });
  });

  it('reports nothing for a page that fits', () => {
    expect(pageBudgetFields(boundPageToBudget([{ a: 1 }]))).toEqual({});
  });

  it('reports both counts and no fields when records were dropped from a page within budget', () => {
    const records = [{ a: 'a'.repeat(15_000) }, { b: 'b'.repeat(15_000) }];
    const page = boundPageToBudget(records);
    expect(pageBudgetFields(page)).toEqual({ page_bytes: size([records[0]]), page_omitted: 1 });
  });

  it('reports all three when the one kept record is over budget and the rest were dropped', () => {
    const page = boundPageToBudget([RECALL, { a: 1 }]);
    expect(pageBudgetFields(page)).toEqual({
      page_bytes: size([RECALL]),
      page_omitted: 1,
      page_largest_fields: [{ path: 'code_info', bytes: size(RECALL.code_info) }],
    });
  });
});

describe('pageBudgetNotice', () => {
  const meta = { skip: 0 };

  it('is absent for a page that fits', () => {
    expect(pageBudgetNotice({ meta, results: [{ a: 1 }] })).toBeUndefined();
  });

  it('names the lone record, its overrun, its largest field, and the fields re-call', () => {
    const result = bounded([RECALL]);
    expect(pageBudgetNotice(result)).toBe(
      `Inline page exceeds the ${PAGE_BUDGET_BYTES}-byte budget at ${result.page_bytes} bytes — one record exceeds the budget on its own, so it is returned whole rather than leaving the page empty. Its largest field is code_info (60002 bytes); leaving it out brings the record within the budget. Re-call with fields set to the dotted paths you need (any key path on the record works; openfda_describe_fields lists the searchable ones) to project each record to those paths plus its identity key.`,
    );
  });

  it('reads the largest fields the page carries rather than measuring the record again', () => {
    const notice = pageBudgetNotice({
      ...bounded([RECALL]),
      page_largest_fields: [{ path: 'carried.path', bytes: 1 }],
    });
    expect(notice).toContain('Its largest field is carried.path (1 bytes).');
    expect(notice).not.toContain('code_info');
  });

  it('names the oversized record and the routes to the dropped ones, without repeating the fields route', () => {
    const notice =
      pageBudgetNotice(bounded([RECALL, { a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }])) ?? '';
    expect(notice).toContain('Inline page bounded to 1 of the 5 records requested');
    expect(notice).toContain('code_info (60002 bytes)');
    expect(notice).toContain('The other 4 begin at skip=1');
    expect(notice).toContain('Re-call with fields');
    expect(notice).not.toContain('pass fields');
  });

  /*
   * A page holding one record cannot shrink by lowering limit — limit=1 returns
   * the same page — so that route is named only when the page holds more.
   */
  it.each([
    ['an oversized record', [RECALL, { a: 1 }, { a: 2 }]],
    ['a record within budget', [{ a: 'a'.repeat(15_000) }, { b: 'b'.repeat(15_000) }]],
  ])('offers no lower-limit route when the page kept one record — %s', (_label, records) => {
    const notice = pageBudgetNotice(bounded(records)) ?? '';
    expect(notice).toContain('Inline page bounded to 1 of the');
    expect(notice).toContain('re-call with that skip');
    expect(notice).not.toContain('lower limit');
  });

  it('offers the lower-limit route when the page kept more than one record', () => {
    const records = Array.from({ length: 4 }, (_, i) => ({ [`k${i}`]: 'x'.repeat(10_000) }));
    const result = bounded(records);
    expect(result.results).toHaveLength(2);
    expect(pageBudgetNotice(result)).toContain('lower limit for a smaller page');
  });

  it('adds the fields route to a page bounded under budget', () => {
    const notice = pageBudgetNotice({ meta, results: [{ a: 1 }], page_bytes: 7, page_omitted: 2 });
    expect(notice).toContain('pass fields to keep only the paths you need');
    expect(notice).not.toContain('largest field');
  });

  it('offers narrower fields, not fields, on a projected page bounded under budget', () => {
    const notice = pageBudgetNotice({
      meta,
      results: [{ a: 1 }],
      page_bytes: 7,
      page_omitted: 2,
      projected_fields: ['a'],
    });
    expect(notice).toContain('narrow fields to fewer paths');
    expect(notice).not.toContain('pass fields');
  });

  it('lists several fields when no single one holds the excess', () => {
    // ~36 KB against a 24 KB budget: no 12 KB field holds the ~12 KB excess alone.
    const record = { a: 'a'.repeat(12_000), b: 'b'.repeat(12_000), c: 'c'.repeat(12_000), id: '1' };
    expect(pageBudgetNotice(bounded([record]))).toContain(
      'Its largest fields are a (12002 bytes), b (12002 bytes); leaving them out brings the record within the budget.',
    );
  });

  it('reports the UTF-8 sizes of a non-ASCII record', () => {
    // 30,000 two-byte characters: 30,002 code units, 60,002 bytes.
    const record = { id: '1', note: 'é'.repeat(30_000) };
    const result = bounded([record]);
    expect(result.page_bytes).toBe(size([record]));
    const notice = pageBudgetNotice(result) ?? '';
    expect(notice).toContain(`at ${size([record])} bytes`);
    expect(notice).toContain('note (60002 bytes)');
  });
});

/**
 * The size walk runs over upstream-sized records — megabytes for a device recall —
 * so it is timed on the shapes that stress it across a 64× span, on this thread's
 * CPU time.
 */
describe('largestFields timing', { timeout: 60_000 }, () => {
  /** Each builder returns a record serializing to roughly `n` characters. */
  it.each([
    ['one long string', (n: number) => ({ code_info: 's'.repeat(n) })],
    ['one long non-ASCII string', (n: number) => ({ code_info: 'é'.repeat(n / 2) })],
    [
      'a wide object of distinct keys',
      (n: number) => Object.fromEntries(Array.from({ length: n / 12 }, (_, i) => [`k${i}`, 1])),
    ],
    [
      'an array of objects with distinct keys',
      (n: number) => ({ drug: Array.from({ length: n / 14 }, (_, i) => ({ [`k${i}`]: 1 })) }),
    ],
    [
      'nested arrays of objects',
      (n: number) => ({
        patient: {
          drug: Array.from({ length: n / 40 }, () => ({ openfda: { brand_name: ['ab'] } })),
        },
      }),
    ],
  ])('stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(
      (record) => largestFields(record, 1),
      build(5_000),
      build(320_000),
    );
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });

  it('bounds a page linearly in its UTF-8 size', () => {
    const page = (n: number) =>
      Array.from({ length: n / 100 }, (_, i) => ({ i, t: 'é'.repeat(40) }));
    const { t5k, t320k } = linearTiming(
      (records) => boundPageToBudget(records, Number.POSITIVE_INFINITY),
      page(5_000),
      page(320_000),
    );
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

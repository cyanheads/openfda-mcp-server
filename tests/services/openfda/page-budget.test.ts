/**
 * @fileoverview The oversized-record disclosure for an inline search page (#66,
 * #92): a page holds every record its `limit`/`skip` window addresses, and only a
 * record that serializes above 24,000 bytes on its own earns `page_bytes` and
 * `page_largest_fields`. Covers which fields of an oversized record are named,
 * the exactness of the sizes reported (UTF-8 bytes of the serialized JSON, the
 * size the payload occupies on the wire), the presence rule for both fields, and
 * the notice's wording per case. The tool-boundary contract lives in
 * `page-budget-contract.test.ts`.
 * @module tests/services/openfda/page-budget.test
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  inlinePage,
  largestFields,
  OVERSIZED_RECORD_BYTES,
  oversizedRecordFields,
  oversizedRecordLine,
  oversizedRecordNotice,
} from '@/services/openfda/page-budget.js';
import { recordProjection } from '@/services/openfda/record-projection.js';
import type { OpenFdaResponse } from '@/services/openfda/types.js';
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

/** A record serializing to exactly `bytes` UTF-8 bytes: `{"id":"<n>","t":"…"}`. */
function recordOf(bytes: number, id = '1'): Record<string, unknown> {
  const record = { id, t: '' };
  record.t = 'x'.repeat(bytes - size(record));
  return record;
}

/** A search response holding `records`, as the service returns it. */
const response = (records: Record<string, unknown>[], limit = 99): OpenFdaResponse => ({
  meta: { total: 1000, skip: 0, limit, lastUpdated: '2026-11-10' },
  results: records,
});

/** The response shape a handler returns for a page, built the way `inlinePage` builds it. */
const pageOf = (records: Record<string, unknown>[]) =>
  inlinePage(response(records), records.length);

it('measures an oversized record against the framework outline budget', () => {
  expect(OVERSIZED_RECORD_BYTES).toBe(24_000);
});

describe('oversizedRecordFields', () => {
  it('reports nothing for a page whose records each fit, however large the page', () => {
    // Three 10 KB reports: a 30 KB page the earlier byte budget cut to two.
    const records = [recordOf(10_000, '1'), recordOf(10_000, '2'), recordOf(10_000, '3')];
    expect(size(records)).toBeGreaterThan(OVERSIZED_RECORD_BYTES);
    expect(oversizedRecordFields(records)).toEqual({});
  });

  it('reports nothing for an empty page', () => {
    expect(oversizedRecordFields([])).toEqual({});
  });

  it('treats a record of exactly 24,000 bytes as fitting and one byte more as oversized', () => {
    expect(oversizedRecordFields([recordOf(24_000)])).toEqual({});
    expect(oversizedRecordFields([recordOf(24_001)])).toMatchObject({
      page_bytes: 24_003,
      page_largest_fields: [{ path: 't', bytes: expect.any(Number) }],
    });
  });

  it('reports page_bytes and the largest fields for a lone oversized record', () => {
    expect(oversizedRecordFields([RECALL])).toEqual({
      page_bytes: size([RECALL]),
      page_largest_fields: [{ path: 'code_info', bytes: size(RECALL.code_info) }],
    });
  });

  it('totals the whole page and breaks down the largest record on a page of several', () => {
    const records = [{ id: 'small' }, REPORT, RECALL];
    const openfdaBytes = REPORT.patient.drug.reduce((sum, d) => sum + size(d.openfda), 0);
    expect(oversizedRecordFields(records)).toEqual({
      page_bytes: size(records),
      page_largest_fields: [{ path: 'patient.drug.openfda', bytes: openfdaBytes }],
    });
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // 15,000 two-byte characters: under 24,000 code units, over 24,000 bytes.
    const record = { id: '1', note: 'é'.repeat(15_000) };
    expect(JSON.stringify(record).length).toBeLessThan(OVERSIZED_RECORD_BYTES);
    expect(oversizedRecordFields([record])).toEqual({
      page_bytes: size([record]),
      page_largest_fields: [{ path: 'note', bytes: 30_002 }],
    });
  });
});

describe('inlinePage', () => {
  it('returns every record of the window, whole, with meta.limit set to the applied page size', () => {
    const records = [recordOf(10_000, '1'), recordOf(10_000, '2'), recordOf(10_000, '3')];
    expect(inlinePage(response(records, 0), 3)).toEqual({
      meta: { total: 1000, skip: 0, limit: 3, lastUpdated: '2026-11-10' },
      results: records,
    });
  });

  it('carries the oversized disclosure beside the records it measured', () => {
    const page = inlinePage(response([{ id: 'small' }, RECALL]), 2);
    expect(page.results).toEqual([{ id: 'small' }, RECALL]);
    expect(page.page_bytes).toBe(size([{ id: 'small' }, RECALL]));
    expect(page.page_largest_fields).toEqual([
      { path: 'code_info', bytes: size(RECALL.code_info) },
    ]);
  });

  it('measures the projected records, so a fields projection that drops the bulk clears it', () => {
    const projection = recordProjection(['recalling_firm'], ['product_res_number']);
    const page = inlinePage(response([RECALL]), 1, projection);
    expect(page.results).toEqual([{ product_res_number: 'Z-0030-2018', recalling_firm: 'ACME' }]);
    expect(page.projected_fields).toEqual(['recalling_firm']);
    expect(page).not.toHaveProperty('page_bytes');
    expect(page).not.toHaveProperty('page_largest_fields');
  });
});

describe('largestFields', () => {
  it('names a dominant top-level field with its exact serialized size', () => {
    const excess = size(RECALL) - OVERSIZED_RECORD_BYTES;
    expect(largestFields(RECALL, excess)).toEqual({
      covered: true,
      fields: [{ path: 'code_info', bytes: size(RECALL.code_info) }],
    });
  });

  it('drills to the deepest field that holds the excess, totalled across array elements', () => {
    const excess = size(REPORT) - OVERSIZED_RECORD_BYTES;
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

describe('oversizedRecordNotice', () => {
  const FIELDS_ROUTE =
    'Re-call with fields set to the dotted paths you need (any key path on the record works; openfda_describe_fields lists the searchable ones) to project each record to those paths plus its identity key.';

  it('is absent for a page whose records each fit', () => {
    expect(oversizedRecordNotice(pageOf([recordOf(10_000), recordOf(10_000)]))).toBeUndefined();
  });

  it('names the lone record, its size, its largest field, and the fields re-call', () => {
    const page = pageOf([RECALL]);
    expect(oversizedRecordNotice(page)).toBe(
      `Oversized record: the one record on this page serializes to ${size(RECALL)} bytes, over 24000 (page_bytes ${size([RECALL])}). Its largest field is code_info (60002 bytes); leaving it out brings the record within 24000 bytes. ${FIELDS_ROUTE}`,
    );
  });

  it('names the page and the largest record on a page of several, without the within claim', () => {
    const records = [RECALL, { a: 1 }, { a: 2 }];
    expect(oversizedRecordNotice(pageOf(records))).toBe(
      `Oversized record: this page of 3 records serializes to ${size(records)} bytes, and at least one record on it exceeds 24000 bytes on its own. The largest record's largest field is code_info (60002 bytes). ${FIELDS_ROUTE}`,
    );
  });

  it('reads the largest fields the page carries rather than measuring the record again', () => {
    const notice = oversizedRecordNotice({
      ...pageOf([RECALL]),
      page_largest_fields: [{ path: 'carried.path', bytes: 1 }],
    });
    expect(notice).toContain('Its largest field is carried.path (1 bytes).');
    expect(notice).not.toContain('code_info');
  });

  it('lists several fields when no single one holds the excess', () => {
    // ~36 KB against 24 KB: no 12 KB field holds the ~12 KB excess alone.
    const record = { a: 'a'.repeat(12_000), b: 'b'.repeat(12_000), c: 'c'.repeat(12_000), id: '1' };
    expect(oversizedRecordNotice(pageOf([record]))).toContain(
      'Its largest fields are a (12002 bytes), b (12002 bytes); leaving them out brings the record within 24000 bytes.',
    );
  });

  it('says nothing about bringing it within when the named fields fall short', () => {
    // Ten 10 KB fields: the three named hold 30 KB of a ~76 KB excess.
    const record = Object.fromEntries([...'abcdefghij'].map((k) => [k, k.repeat(10_000)]));
    const notice = oversizedRecordNotice(pageOf([record])) ?? '';
    expect(notice).toContain(
      'Its largest fields are a (10002 bytes), b (10002 bytes), c (10002 bytes).',
    );
    expect(notice).not.toContain('brings the record within');
  });

  it('reports the UTF-8 sizes of a non-ASCII record', () => {
    // 30,000 two-byte characters: 30,002 code units, 60,002 bytes.
    const record = { id: '1', note: 'é'.repeat(30_000) };
    const page = pageOf([record]);
    expect(page.page_bytes).toBe(size([record]));
    const notice = oversizedRecordNotice(page) ?? '';
    expect(notice).toContain(`serializes to ${size(record)} bytes`);
    expect(notice).toContain('note (60002 bytes)');
  });
});

describe('oversizedRecordLine', () => {
  it('quotes the notice for content[]', () => {
    const page = pageOf([RECALL]);
    expect(oversizedRecordLine(page)).toBe(`> ${oversizedRecordNotice(page)}`);
  });

  it('is null for a page whose records each fit', () => {
    expect(oversizedRecordLine(pageOf([{ a: 1 }]))).toBeNull();
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

  it('measures a page linearly in its UTF-8 size', () => {
    const page = (n: number) =>
      Array.from({ length: n / 100 }, (_, i) => ({ i, t: 'é'.repeat(40) }));
    const { t5k, t320k } = linearTiming(
      (records) => oversizedRecordFields(records),
      page(5_000),
      page(320_000),
    );
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

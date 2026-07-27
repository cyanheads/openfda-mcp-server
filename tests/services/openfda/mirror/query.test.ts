/**
 * @fileoverview Eligibility and execution coverage for the mirror query planner
 * — the gate that decides which openFDA queries a local SQLite corpus can answer
 * without diverging from upstream Elasticsearch.
 * @module tests/services/openfda/mirror/query
 */

import { describe, expect, it } from 'vitest';
import { planMirrorLookup, runMirrorLookup } from '@/services/openfda/mirror/index.js';
import { createMirrorFixture, ENFORCEMENT_RECORD, SIBLING_RECORD } from './mirror-fixture.js';

describe('planMirrorLookup — accepted', () => {
  it.each([
    ['drug/enforcement', 'recall_number:"D-321-2016"', 'recall_number', 'D-321-2016'],
    ['drug/enforcement', 'event_id:"72241"', 'event_id', '72241'],
    ['drug/ndc', 'product_ndc:"0363-0218"', 'product_ndc', '0363-0218'],
    [
      'drug/ndc',
      'product_id:"76329-6300_8e30c3dd-67a2-4973-9325-1765b95c047d"',
      'product_id',
      '76329-6300_8e30c3dd-67a2-4973-9325-1765b95c047d',
    ],
    ['drug/drugsfda', 'application_number:"NDA017398"', 'application_number', 'NDA017398'],
    [
      'drug/label',
      'set_id:"0000025c-6dbf-4af7-a741-5cbacaed519a"',
      'set_id',
      '0000025c-6dbf-4af7-a741-5cbacaed519a',
    ],
  ])('%s %s', (endpoint, search, field, value) => {
    const plan = planMirrorLookup(endpoint, { search, limit: 5 });
    expect(plan).toMatchObject({ field, column: field, value, limit: 5 });
  });

  it('defaults to openFDA’s own page size when limit is omitted', () => {
    expect(
      planMirrorLookup('drug/enforcement', { search: 'recall_number:"D-321-2016"' }),
    ).toMatchObject({ limit: 1 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(
      planMirrorLookup('drug/enforcement', { search: '  recall_number : "D-321-2016" ' }),
    ).toBeDefined();
  });
});

describe('planMirrorLookup — routed live', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['unmirrored endpoint', 'drug/event', { search: 'patient.drug.medicinalproduct:"aspirin"' }],
    ['no search', 'drug/enforcement', {}],
    ['undeclared field', 'drug/enforcement', { search: 'reason_for_recall:"sterility"' }],
    [
      'free-text value on a declared field',
      'drug/enforcement',
      { search: 'recall_number:"sterility"' },
    ],
    ['two clauses', 'drug/enforcement', { search: 'recall_number:"D-321-2016" AND state:"IL"' }],
    ['unquoted value', 'drug/enforcement', { search: 'recall_number:D-321-2016' }],
    ['wildcard', 'drug/enforcement', { search: 'recall_number:"D-321-*"' }],
    ['range', 'drug/enforcement', { search: 'report_date:[20200101 TO 20201231]' }],
    ['wrong case', 'drug/drugsfda', { search: 'application_number:"nda017398"' }],
    ['wrong case UUID', 'drug/label', { search: 'set_id:"0000025C-6DBF-4AF7-A741-5CBACAED519A"' }],
    // openFDA indexes event_id numerically, so the zero-padded spelling selects
    // the same documents upstream while never matching the stored literal.
    ['zero-padded numeric id', 'drug/enforcement', { search: 'event_id:"0072241"' }],
    ['count query', 'drug/enforcement', { count: 'classification.exact' }],
    [
      'sorted query',
      'drug/enforcement',
      { search: 'recall_number:"D-321-2016"', sort: 'report_date:desc' },
    ],
    ['paged past the first page', 'drug/enforcement', { search: 'event_id:"72241"', skip: 10 }],
  ];

  it.each(cases)('%s', (_label, endpoint, params) => {
    expect(planMirrorLookup(endpoint, params)).toBeUndefined();
  });
});

describe('runMirrorLookup', () => {
  it('returns the stored record verbatim with upstream-shaped metadata', async () => {
    await using fixture = await createMirrorFixture('drug/enforcement');
    await fixture.seed([ENFORCEMENT_RECORD, SIBLING_RECORD]);

    const plan = planMirrorLookup('drug/enforcement', {
      search: 'recall_number:"D-321-2016"',
      limit: 1,
    });
    const response = await runMirrorLookup(fixture.mirror, plan!);

    expect(response?.meta).toEqual({
      total: 1,
      skip: 0,
      limit: 1,
      lastUpdated: '2026-07-22',
    });
    expect(response?.results).toEqual([ENFORCEMENT_RECORD]);
  });

  it('reports a zero-match lookup with the dataset’s own freshness stamp', async () => {
    await using fixture = await createMirrorFixture('drug/enforcement');
    await fixture.seed([ENFORCEMENT_RECORD]);

    const plan = planMirrorLookup('drug/enforcement', {
      search: 'recall_number:"D-999-2016"',
      limit: 1,
    });
    const response = await runMirrorLookup(fixture.mirror, plan!);

    expect(response).toMatchObject({ meta: { total: 0, lastUpdated: '2026-07-22' }, results: [] });
  });

  it('returns the whole match set when it fits the page', async () => {
    await using fixture = await createMirrorFixture('drug/enforcement');
    await fixture.seed([ENFORCEMENT_RECORD, SIBLING_RECORD]);

    const plan = planMirrorLookup('drug/enforcement', { search: 'event_id:"72241"', limit: 10 });
    const response = await runMirrorLookup(fixture.mirror, plan!);

    expect(response?.meta.total).toBe(2);
    expect(response?.results).toHaveLength(2);
  });

  it('orders a non-unique match by primary key, not by upstream relevance', async () => {
    await using fixture = await createMirrorFixture('drug/enforcement');
    await fixture.seed([SIBLING_RECORD, ENFORCEMENT_RECORD]);

    const plan = planMirrorLookup('drug/enforcement', { search: 'event_id:"72241"', limit: 10 });
    const response = await runMirrorLookup(fixture.mirror, plan!);

    expect(response?.results.map((r) => r.recall_number)).toEqual(['D-321-2016', 'D-322-2016']);
  });

  it('defers to live when the match set is larger than the page', async () => {
    await using fixture = await createMirrorFixture('drug/enforcement');
    await fixture.seed([ENFORCEMENT_RECORD, SIBLING_RECORD]);

    const plan = planMirrorLookup('drug/enforcement', { search: 'event_id:"72241"', limit: 1 });
    expect(await runMirrorLookup(fixture.mirror, plan!)).toBeUndefined();
  });

  it('reports "unknown" freshness for an empty corpus', async () => {
    await using fixture = await createMirrorFixture('drug/enforcement');

    const plan = planMirrorLookup('drug/enforcement', {
      search: 'recall_number:"D-321-2016"',
      limit: 1,
    });
    const response = await runMirrorLookup(fixture.mirror, plan!);

    expect(response).toMatchObject({ meta: { total: 0, lastUpdated: 'unknown' }, results: [] });
  });
});

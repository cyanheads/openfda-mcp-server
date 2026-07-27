/**
 * @fileoverview Registry, projection, and GMDN carve-out coverage for the bulk
 * mirror's dataset specs.
 * @module tests/services/openfda/mirror/datasets
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  assertNoGmdnContent,
  DATASETS,
  datasetFor,
  findGmdnPath,
  MIRRORED_ENDPOINTS,
} from '@/services/openfda/mirror/index.js';
import { DUMP_STAMP, ENFORCEMENT_RECORD, KEYLESS_RECORD } from './mirror-fixture.js';

describe('mirrored dataset registry', () => {
  it('admits only the four drug datasets openFDA publishes as bulk dumps', () => {
    expect([...MIRRORED_ENDPOINTS]).toEqual([
      'drug/label',
      'drug/ndc',
      'drug/enforcement',
      'drug/drugsfda',
    ]);
  });

  it.each(['device/classification', 'device/udi', 'device/510k', 'drug/event', 'food/enforcement'])(
    'refuses to mirror %s',
    (endpoint) => {
      expect(datasetFor(endpoint)).toBeUndefined();
    },
  );

  it.each(MIRRORED_ENDPOINTS)('declares %s consistently', (endpoint) => {
    const spec = DATASETS[endpoint];
    expect(spec.columns[spec.primaryKey]).toBeDefined();
    expect(spec.columns.raw).toBe('TEXT NOT NULL');
    expect(spec.columns.last_updated).toBeDefined();
    expect(spec.columns.synced_at).toBeDefined();
    for (const key of Object.values(spec.keys)) {
      expect(spec.columns[key.column]).toBeDefined();
    }
    for (const index of spec.indexes) {
      for (const column of index.columns) expect(spec.columns[column]).toBeDefined();
    }
  });
});

describe('GMDN carve-out', () => {
  it('passes records with no GMDN content', () => {
    expect(findGmdnPath(ENFORCEMENT_RECORD)).toBeUndefined();
    expect(() => assertNoGmdnContent('drug/enforcement', ENFORCEMENT_RECORD)).not.toThrow();
  });

  it.each([
    [{ gmdn_terms: [{ code: '35132' }] }, 'gmdn_terms'],
    [{ device: { gmdnTerms: [] } }, 'device.gmdnTerms'],
    [{ items: [{ nested: { GMDN_TERM_NAME: 'Catheter' } }] }, 'items[0].nested.GMDN_TERM_NAME'],
  ])('locates GMDN content at %#', (record, path) => {
    expect(findGmdnPath(record)).toBe(path);
  });

  it('fails the sync rather than storing licensed content', () => {
    expect(() =>
      assertNoGmdnContent('drug/label', { ...ENFORCEMENT_RECORD, gmdn_terms: [{ code: '1' }] }),
    ).toThrow(McpError);
    try {
      assertNoGmdnContent('drug/label', { gmdn_terms: [] });
    } catch (error) {
      expect((error as McpError).data).toMatchObject({
        endpoint: 'drug/label',
        path: 'gmdn_terms',
      });
      expect((error as McpError).message).toContain('The GMDN Agency');
    }
  });
});

describe('projection', () => {
  it('stamps the row with the dump freshness and keeps the record verbatim', () => {
    const row = DATASETS['drug/enforcement'].project(ENFORCEMENT_RECORD, DUMP_STAMP);
    expect(row).toMatchObject({
      recall_number: 'D-321-2016',
      event_id: '72241',
      last_updated: '2026-07-22',
      synced_at: '2026-07-22',
    });
    expect(JSON.parse(String(row?.raw))).toEqual(ENFORCEMENT_RECORD);
  });

  it('drops a record with no primary key', () => {
    expect(DATASETS['drug/enforcement'].project(KEYLESS_RECORD, DUMP_STAMP)).toBeUndefined();
  });

  it('nulls an absent lookup column rather than omitting it', () => {
    const row = DATASETS['drug/ndc'].project(
      { product_id: '76329-6300_8e30c3dd-67a2-4973-9325-1765b95c047d' },
      DUMP_STAMP,
    );
    expect(row?.product_ndc).toBeNull();
  });
});

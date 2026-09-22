/**
 * @fileoverview Tests for the openFDA field catalog — the per-field count
 * annotation, the paths it advertises, and the count-expression lookup.
 * @module tests/mcp-server/tools/field-catalog.test
 */

import { describe, expect, it } from 'vitest';

import {
  countVerdict,
  getCatalogedEndpoints,
  getFieldGroups,
} from '@/mcp-server/tools/field-catalog.js';

const allEntries = () =>
  getCatalogedEndpoints().flatMap((endpoint) =>
    (getFieldGroups(endpoint) ?? []).flatMap((g) => g.fields.map((field) => ({ endpoint, field }))),
  );

describe('field catalog', () => {
  // #49 — the annotation is the only source of countability a caller gets; an
  // entry without one would silently fall back to the hedged two-direction hint.
  it('annotates every entry with a verified count form', () => {
    const entries = allEntries();
    expect(entries.length).toBeGreaterThan(200);

    const missing = entries.filter(
      ({ field }) => !['bare', 'exact', 'both', 'none'].includes(field.countable),
    );
    expect(missing.map(({ endpoint, field }) => `${endpoint} ${field.path}`)).toEqual([]);
  });

  it('never repeats a path within an endpoint', () => {
    for (const endpoint of getCatalogedEndpoints()) {
      const paths = (getFieldGroups(endpoint) ?? []).flatMap((g) => g.fields.map((f) => f.path));
      expect(new Set(paths).size, endpoint).toBe(paths.length);
    }
  });

  // #49 — these paths exist in no record (`_exists_:<path>` answers 404), so a
  // search on them silently matches nothing. The catalog carries the real paths.
  it.each([
    ['device/recall', 'recall_number', 'product_res_number'],
    ['device/recall', 'event_id', 'res_event_number'],
    ['device/recall', 'status', 'recall_status'],
    ['device/recall', 'classification', 'openfda.device_class'],
    ['device/event', 'device.device_class', 'device.openfda.device_class'],
    ['device/event', 'device.product_code', 'device.device_report_product_code'],
    ['food/event', 'consumer.age.age', 'consumer.age'],
    ['food/event', 'consumer.age.age_unit', 'consumer.age_unit'],
  ])('%s advertises %s under its real path %s', (endpoint, absent, real) => {
    const paths = (getFieldGroups(endpoint) ?? []).flatMap((g) => g.fields.map((f) => f.path));
    expect(paths).not.toContain(absent);
    expect(paths).toContain(real);
  });

  describe('countVerdict', () => {
    it('accepts the recorded expression', () => {
      expect(countVerdict('drug/enforcement', 'classification.exact')).toEqual({
        kind: 'countable',
      });
      expect(countVerdict('drug/ndc', 'product_ndc')).toEqual({ kind: 'countable' });
    });

    it('accepts either form of a field that counts both ways', () => {
      expect(countVerdict('device/udi', 'product_codes.code')).toEqual({ kind: 'countable' });
      expect(countVerdict('device/udi', 'product_codes.code.exact')).toEqual({
        kind: 'countable',
      });
    });

    it('names the recorded expression for the other form', () => {
      expect(countVerdict('drug/enforcement', 'classification')).toEqual({
        kind: 'wrong_form',
        use: 'classification.exact',
      });
      expect(countVerdict('drug/ndc', 'product_ndc.exact')).toEqual({
        kind: 'wrong_form',
        use: 'product_ndc',
      });
    });

    it('reports a field with no countable form and lists countable alternatives', () => {
      for (const expression of ['device_class', 'device_class.exact']) {
        const verdict = countVerdict('device/classification', expression);
        expect(verdict.kind).toBe('none');
        if (verdict.kind !== 'none') return;
        expect(verdict.alternatives).toContain('medical_specialty_description.exact');
        expect(verdict.alternatives).not.toContain('device_class');
        expect(verdict.alternatives).not.toContain('device_class.exact');
      }
    });

    it('treats an expression outside the catalog as uncataloged', () => {
      expect(countVerdict('drug/enforcement', 'openfda.generic_name.exact')).toEqual({
        kind: 'uncataloged',
      });
      expect(countVerdict('drug/enforcement', 'classification.exact.exact')).toEqual({
        kind: 'uncataloged',
      });
    });
  });
});

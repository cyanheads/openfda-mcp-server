/**
 * @fileoverview `fields` projection for the search tools' inline page (#66):
 * dotted paths through nested objects and arrays, identity keys, the record count
 * invariant, and the not-carried disclosure.
 * @module tests/services/openfda/record-projection.test
 */

import { describe, expect, it } from 'vitest';
import {
  pathsNotCarried,
  projectionLine,
  projectionNotice,
  projectRecords,
  recordProjection,
} from '@/services/openfda/record-projection.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

const ID = ['safetyreportid'] as const;

/** A drug-report-shaped record with arrays nested two levels deep. */
const REPORT = {
  safetyreportid: '17533498',
  receivedate: '20200101',
  serious: '1',
  patient: {
    patientsex: '2',
    reaction: [{ reactionmeddrapt: 'Nausea', reactionoutcome: '6' }, { reactionmeddrapt: 'Rash' }],
    drug: [
      {
        medicinalproduct: 'ASPIRIN',
        activesubstance: { activesubstancename: 'ASPIRIN' },
        openfda: { brand_name: ['BAYER'], generic_name: ['ASPIRIN'] },
      },
      { drugindication: 'PAIN', openfda: { brand_name: ['TYLENOL'] } },
      { medicinalproduct: 'METFORMIN' },
    ],
  },
};

const project = (fields: string[], record: Record<string, unknown> = REPORT) =>
  projectRecords([record], recordProjection(fields, ID))[0];

describe('recordProjection', () => {
  it('is undefined for an absent or empty fields list', () => {
    expect(recordProjection(undefined, ID)).toBeUndefined();
    expect(recordProjection([], ID)).toBeUndefined();
  });

  it('deduplicates paths in the order given', () => {
    expect(recordProjection(['b', 'a', 'b'], ID)?.paths).toEqual(['b', 'a']);
  });
});

describe('projectRecords', () => {
  it('returns the records untouched without a projection', () => {
    const records = [REPORT];
    expect(projectRecords(records, undefined)).toBe(records);
  });

  it('keeps the identity key first, then the requested top-level paths', () => {
    const projected = project(['serious', 'receivedate']);
    expect(projected).toEqual({
      safetyreportid: '17533498',
      serious: '1',
      receivedate: '20200101',
    });
    expect(Object.keys(projected ?? {})).toEqual(['safetyreportid', 'serious', 'receivedate']);
  });

  it('applies a path through an array to every element, keeping the array length', () => {
    expect(project(['patient.drug.medicinalproduct'])).toEqual({
      safetyreportid: '17533498',
      patient: {
        drug: [{ medicinalproduct: 'ASPIRIN' }, {}, { medicinalproduct: 'METFORMIN' }],
      },
    });
  });

  it('walks paths through nested arrays past the first level', () => {
    expect(
      project(['patient.drug.openfda.brand_name', 'patient.reaction.reactionoutcome']),
    ).toEqual({
      safetyreportid: '17533498',
      patient: {
        drug: [
          { openfda: { brand_name: ['BAYER'] } },
          { openfda: { brand_name: ['TYLENOL'] } },
          {},
        ],
        reaction: [{ reactionoutcome: '6' }, {}],
      },
    });
  });

  it('merges sibling paths into one element per array entry', () => {
    const projected = project(['patient.drug.medicinalproduct', 'patient.drug.drugindication']);
    expect(projected).toEqual({
      safetyreportid: '17533498',
      patient: {
        drug: [
          { medicinalproduct: 'ASPIRIN' },
          { drugindication: 'PAIN' },
          { medicinalproduct: 'METFORMIN' },
        ],
      },
    });
  });

  it('keeps a whole subtree when a shorter path covers a longer one, in either order', () => {
    const whole = { safetyreportid: '17533498', patient: REPORT.patient };
    expect(project(['patient', 'patient.drug.medicinalproduct'])).toEqual(whole);
    expect(project(['patient.drug.medicinalproduct', 'patient'])).toEqual(whole);
  });

  it('omits a path no element carries rather than leaving empty containers', () => {
    expect(project(['patient.drug.no_such_leaf', 'serious'])).toEqual({
      safetyreportid: '17533498',
      serious: '1',
    });
  });

  it('walks a path through two array levels, keeping each level as an array', () => {
    const record = {
      safetyreportid: '1',
      submissions: [{ application_docs: [{ url: 'u1', id: 'x' }, { id: 'y' }] }, { other: 1 }],
      matrix: [[{ k: 1 }, { j: 2 }], [{ j: 3 }]],
    };
    expect(project(['submissions.application_docs.url', 'matrix.k'], record)).toEqual({
      safetyreportid: '1',
      submissions: [{ application_docs: [{ url: 'u1' }, {}] }, {}],
      // An inner array carrying none of the paths stays an array, not an object.
      matrix: [[{ k: 1 }, {}], []],
    });
  });

  it('treats a path running past a scalar or null as absent', () => {
    const record = { safetyreportid: '1', serious: '1', patient: null };
    expect(project(['serious.code', 'patient.drug'], record)).toEqual({ safetyreportid: '1' });
  });

  it('keeps a null leaf the path names, since openFDA sent it', () => {
    const record = { safetyreportid: '1', receiptdate: null };
    expect(project(['receiptdate'], record)).toEqual({ safetyreportid: '1', receiptdate: null });
  });

  it('never drops a record — one carrying nothing requested comes back empty', () => {
    const records = [{ other: 1 }, { safetyreportid: '2' }];
    expect(projectRecords(records, recordProjection(['absent'], ID))).toEqual([
      {},
      { safetyreportid: '2' },
    ]);
  });

  it('does not mutate the records it projects', () => {
    const before = JSON.stringify(REPORT);
    project(['patient.drug.medicinalproduct']);
    expect(JSON.stringify(REPORT)).toBe(before);
  });
});

describe('pathsNotCarried', () => {
  it('finds a path carried by any element of any record', () => {
    const records = [{ a: [{ b: [{}] }] }, { a: [{ b: [{ c: 0 }] }] }];
    expect(pathsNotCarried(records, ['a.b.c', 'a.b.d', 'a'])).toEqual(['a.b.d']);
  });

  it('counts a null value as carried', () => {
    expect(pathsNotCarried([{ a: null }], ['a', 'a.b'])).toEqual(['a.b']);
  });
});

describe('projectionNotice / projectionLine', () => {
  it('is absent when the call did not project', () => {
    expect(projectionNotice({ results: [REPORT] })).toBeUndefined();
    expect(projectionLine({ results: [REPORT] })).toBeNull();
  });

  it('names the projection, and each requested path no record carries', () => {
    const notice = projectionNotice({
      projected_fields: ['serious', 'patient.drug.nope', 'zzz'],
      results: [REPORT],
    });
    expect(notice).toContain(
      'Records projected to the requested fields (serious, patient.drug.nope, zzz)',
    );
    expect(notice).toContain('No record in this page carries patient.drug.nope, zzz');
    // describe_fields lists the searchable subset, not every key a record carries.
    expect(notice).toContain('openfda_describe_fields lists the searchable ones');
    expect(notice).not.toContain("lists the endpoint's paths");
  });

  it('names nothing as missing on an empty page', () => {
    expect(projectionNotice({ projected_fields: ['zzz'], results: [] })).not.toContain('carries');
  });

  it('renders the same sentence as a quoted content[] line', () => {
    const result = { projected_fields: ['serious'], results: [REPORT] };
    expect(projectionLine(result)).toBe(`> ${projectionNotice(result)}`);
  });
});

/**
 * Projection and the not-carried scan walk upstream-sized records, so both are
 * timed on long arrays the requested paths run through, across a 64× span, on
 * this thread's CPU time.
 */
describe('projection timing', { timeout: 60_000 }, () => {
  /** A record whose `drug` array serializes to roughly `n` characters, no element carrying the leaf. */
  const build = (n: number) => ({
    safetyreportid: '1',
    patient: { drug: Array.from({ length: n / 30 }, () => ({ openfda: { unii: ['ab'] } })) },
  });
  const projection = recordProjection(
    ['patient.drug.openfda.missing', 'patient.drug.openfda.unii'],
    ID,
  );

  it('projectRecords stays linear through a long array', () => {
    const { t5k, t320k } = linearTiming(
      (records) => projectRecords(records, projection),
      [build(5_000)],
      [build(320_000)],
    );
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });

  it('pathsNotCarried stays linear when no element carries the path', () => {
    const paths = ['patient.drug.openfda.missing'];
    expect(pathsNotCarried([build(320_000)], paths)).toEqual(paths);
    const { t5k, t320k } = linearTiming(
      (records) => pathsNotCarried(records, paths),
      [build(5_000)],
      [build(320_000)],
    );
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

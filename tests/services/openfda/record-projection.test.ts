/**
 * @fileoverview How the search tools cut their inline records: the `fields`
 * projection (#66) — dotted paths through nested objects and arrays, identity
 * keys, the record count invariant, and the not-carried disclosure — and the
 * paths three endpoints leave out by default (#104): the per-endpoint table, the
 * `include` and search-named merge, the copy-on-write walk through nested arrays,
 * the byte tally, and the `omitted_fields` disclosure.
 * @module tests/services/openfda/record-projection.test
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { fieldPathsNamed } from '@/mcp-server/tools/search-clauses.js';
import {
  cutRecords,
  includeDescription,
  omissionLine,
  omissionNotice,
  pageProjection,
  pathsNotCarried,
  projectionLine,
  projectionNotice,
  projectRecords,
  recordProjection,
} from '@/services/openfda/record-projection.js';
import { codeLiteralsIn, renderCommonMark } from '../../helpers/commonmark.js';
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

  it('keeps an upstream __proto__ key a path names as the record’s own property', () => {
    const record = JSON.parse('{"safetyreportid":"1","__proto__":{"x":1},"serious":"1"}');
    const projected = project(['__proto__', 'serious'], record);
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(JSON.stringify(projected)).toBe(
      '{"safetyreportid":"1","__proto__":{"x":1},"serious":"1"}',
    );
  });

  it('keeps a __proto__ key inside an array element, past the first level', () => {
    const record = JSON.parse(
      '{"safetyreportid":"1","patient":{"drug":[{"__proto__":{"y":2},"medicinalproduct":"A"},{"medicinalproduct":"B"}]}}',
    );
    const projected = project(['patient.drug.__proto__'], record);
    expect(JSON.stringify(projected)).toBe(
      '{"safetyreportid":"1","patient":{"drug":[{"__proto__":{"y":2}},{}]}}',
    );
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
      'Records projected to the requested fields (`serious`, `patient.drug.nope`, `zzz`)',
    );
    expect(notice).toContain('No record in this page carries `patient.drug.nope`, `zzz`');
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

  // #81 — a caller path like `_exists_` would otherwise render as emphasis.
  it('reads every caller path back exactly from the rendered line', () => {
    const line = projectionLine({
      projected_fields: ['_exists_', 'patient__drug_'],
      results: [REPORT],
    });
    const html = renderCommonMark(line ?? '');
    expect(html).not.toMatch(/<(?:em|strong)>/);
    expect(codeLiteralsIn(html)).toEqual([
      '_exists_',
      'patient__drug_',
      '_exists_',
      'patient__drug_',
    ]);
  });
});

/** UTF-8 bytes of the serialized value — what it occupies on the wire. */
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('pageProjection', () => {
  const omission = (endpoint: string, call: Parameters<typeof pageProjection>[2] = {}) =>
    pageProjection(endpoint, ID, call);

  it.each([
    ['drug/event', ['patient.drug.openfda']],
    ['device/enforcement', ['code_info', 'more_code_info']],
    [
      'device/recall',
      ['code_info', 'openfda.k_number', 'openfda.fei_number', 'openfda.registration_number'],
    ],
  ])('leaves the %s paths out whole by default', (endpoint, paths) => {
    expect(omission(endpoint)).toEqual({
      kind: 'omission',
      leftOut: paths.map((path) => ({ keep: [], path })),
    });
  });

  it.each([
    'drug/enforcement',
    'food/enforcement',
    'food/event',
    'device/event',
    'device/510k',
    'drug/label',
    'constructor',
    '__proto__',
  ])('cuts nothing on %s', (endpoint) => {
    expect(omission(endpoint)).toBeUndefined();
    expect(omission(endpoint, { include: ['code_info'], searched: ['code_info'] })).toBeUndefined();
  });

  it('treats an empty fields list as no fields, since form clients send [] for unset', () => {
    expect(omission('device/enforcement', { fields: [] })?.kind).toBe('omission');
  });

  it('keeps a left-out path that include or the search names', () => {
    expect(omission('device/enforcement', { include: ['code_info'] })).toEqual({
      kind: 'omission',
      leftOut: [{ keep: [], path: 'more_code_info' }],
    });
    expect(omission('device/enforcement', { searched: ['more_code_info'] })).toEqual({
      kind: 'omission',
      leftOut: [{ keep: [], path: 'code_info' }],
    });
    expect(
      omission('device/enforcement', { include: ['code_info'], searched: ['more_code_info'] }),
    ).toBeUndefined();
  });

  it('keeps the paths beneath a left-out path that include or the search names, relative to it', () => {
    expect(
      omission('drug/event', {
        include: ['patient.drug.openfda.brand_name'],
        searched: ['patient.drug.openfda.generic_name', 'patient.drug.medicinalproduct'],
      }),
    ).toEqual({
      kind: 'omission',
      leftOut: [{ keep: ['brand_name', 'generic_name'], path: 'patient.drug.openfda' }],
    });
    // Two levels beneath: the sub-path keeps its own dots.
    expect(omission('drug/event', { include: ['patient.drug.openfda.a.b'] })).toEqual({
      kind: 'omission',
      leftOut: [{ keep: ['a.b'], path: 'patient.drug.openfda' }],
    });
  });

  it.each([
    ['a parent of a left-out path', ['patient.drug', 'patient']],
    ['a path that only shares its prefix', ['patient.drug.openfdax', 'patient.drug.open']],
    ['a path elsewhere on the record', ['receivedate', 'no_such_path']],
  ])('changes nothing for an entry naming %s', (_label, entries) => {
    const whole = omission('drug/event');
    expect(omission('drug/event', { include: entries })).toEqual(whole);
    expect(omission('drug/event', { searched: entries })).toEqual(whole);
  });

  it('projects a fields call, joined by the include entries that name a left-out path', () => {
    expect(
      omission('drug/event', {
        fields: ['receivedate', 'patient.drug.openfda.brand_name'],
        include: ['patient.drug.openfda.brand_name', 'serious', 'patient.drug.openfda.unii'],
      }),
    ).toEqual({
      identityKeys: ID,
      kind: 'fields',
      paths: ['receivedate', 'patient.drug.openfda.brand_name', 'patient.drug.openfda.unii'],
    });
  });

  // The paths come from the shared clause scanner, as the tools pass them.
  it.each([
    [
      'drug/event',
      'patient.drug.openfda.generic_name:"apixaban"',
      [{ keep: ['generic_name'], path: 'patient.drug.openfda' }],
    ],
    ['device/enforcement', 'code_info:"0624001HF"', [{ keep: [], path: 'more_code_info' }]],
    [
      'device/enforcement',
      'reason_for_recall:"code_info:x" AND _exists_:more_code_info',
      [{ keep: [], path: 'code_info' }],
    ],
  ])('on %s, reads %s as an include of what it names', (endpoint, search, leftOut) => {
    expect(omission(endpoint, { searched: fieldPathsNamed(search) })).toEqual({
      kind: 'omission',
      leftOut,
    });
  });

  it('ignores the paths a search names on a fields call, which leaves nothing out', () => {
    expect(
      omission('device/enforcement', { fields: ['recalling_firm'], searched: ['code_info'] }),
    ).toEqual({ identityKeys: ID, kind: 'fields', paths: ['recalling_firm'] });
  });
});

describe('cutRecords', () => {
  const cutOn = (
    endpoint: string,
    records: Record<string, unknown>[],
    call: Parameters<typeof pageProjection>[2] = {},
  ) => cutRecords(records, pageProjection(endpoint, ID, call));

  /** Drug reports of variable shape: openfda on some drugs only, one report with no drug array. */
  const REPORTS: Record<string, unknown>[] = [
    REPORT,
    { safetyreportid: '2', patient: { patientsex: '1', reaction: [{ reactionmeddrapt: 'Rash' }] } },
    { safetyreportid: '3', patient: null },
    {
      safetyreportid: '4',
      patient: { drug: [{ medicinalproduct: 'X', openfda: { brand_name: ['XB'], unii: ['U'] } }] },
    },
  ];

  it('returns the records untouched, with no disclosure, when the call cuts nothing', () => {
    expect(cutRecords(REPORTS, undefined)).toEqual({ results: REPORTS });
    expect(cutRecords(REPORTS, undefined).results).toBe(REPORTS);
  });

  it('projects a fields call and names its paths', () => {
    expect(cutRecords([REPORT], recordProjection(['serious'], ID))).toEqual({
      results: [{ safetyreportid: '17533498', serious: '1' }],
      projected_fields: ['serious'],
    });
  });

  it('leaves a block out of every element of an array inside an object, keeping each element', () => {
    const { results, omitted_fields } = cutOn('drug/event', REPORTS);

    expect(results[0]).toEqual({
      safetyreportid: '17533498',
      receivedate: '20200101',
      serious: '1',
      patient: {
        patientsex: '2',
        reaction: REPORT.patient.reaction,
        drug: [
          { medicinalproduct: 'ASPIRIN', activesubstance: { activesubstancename: 'ASPIRIN' } },
          { drugindication: 'PAIN' },
          { medicinalproduct: 'METFORMIN' },
        ],
      },
    });
    expect(results[3]).toEqual({
      safetyreportid: '4',
      patient: { drug: [{ medicinalproduct: 'X' }] },
    });
    // The block's bytes on every drug that carried one, across the page.
    const blocks = [
      { brand_name: ['BAYER'], generic_name: ['ASPIRIN'] },
      { brand_name: ['TYLENOL'] },
      { brand_name: ['XB'], unii: ['U'] },
    ];
    expect(omitted_fields).toEqual([
      { path: 'patient.drug.openfda', bytes: blocks.reduce((sum, b) => sum + size(b), 0) },
    ]);
  });

  it('returns a record the walk changes nothing in as the same object, and never modifies its input', () => {
    const before = JSON.stringify(REPORTS);
    const { results } = cutOn('drug/event', REPORTS);
    expect(results[1]).toBe(REPORTS[1]);
    expect(results[2]).toBe(REPORTS[2]);
    expect(results[0]).not.toBe(REPORTS[0]);
    expect(JSON.stringify(REPORTS)).toBe(before);
  });

  it('carries no omitted_fields when no record on the page holds a left-out path', () => {
    const page = cutOn('drug/event', [REPORTS[1], REPORTS[2]] as Record<string, unknown>[]);
    expect(page).toEqual({ results: [REPORTS[1], REPORTS[2]] });
    expect(page).not.toHaveProperty('omitted_fields');
    expect(cutOn('drug/event', [])).toEqual({ results: [] });
  });

  it('keeps a sub-path include names on each element, leaving the rest of the block out', () => {
    const { results, omitted_fields } = cutOn('drug/event', REPORTS, {
      include: ['patient.drug.openfda.brand_name'],
    });
    const drugs = (r: unknown) => (r as { patient: { drug: unknown[] } }).patient.drug;

    expect(drugs(results[0])).toEqual([
      {
        medicinalproduct: 'ASPIRIN',
        activesubstance: { activesubstancename: 'ASPIRIN' },
        openfda: { brand_name: ['BAYER'] },
      },
      { drugindication: 'PAIN', openfda: { brand_name: ['TYLENOL'] } },
      { medicinalproduct: 'METFORMIN' },
    ]);
    expect(drugs(results[3])).toEqual([{ medicinalproduct: 'X', openfda: { brand_name: ['XB'] } }]);
    // Only what the cut took off: generic_name on the first drug, unii on the last.
    const lost =
      size({ brand_name: ['BAYER'], generic_name: ['ASPIRIN'] }) -
      size({ brand_name: ['BAYER'] }) +
      size({ brand_name: ['XB'], unii: ['U'] }) -
      size({ brand_name: ['XB'] });
    expect(omitted_fields).toEqual([{ path: 'patient.drug.openfda', bytes: lost }]);
  });

  it('keeps only the field a search clause names inside each drug block', () => {
    const { results } = cutOn('drug/event', [REPORT], {
      searched: fieldPathsNamed('patient.drug.openfda.generic_name:"ASPIRIN"'),
    });
    expect((results[0] as typeof REPORT).patient.drug).toEqual([
      {
        medicinalproduct: 'ASPIRIN',
        activesubstance: { activesubstancename: 'ASPIRIN' },
        openfda: { generic_name: ['ASPIRIN'] },
      },
      { drugindication: 'PAIN' },
      { medicinalproduct: 'METFORMIN' },
    ]);
  });

  it('removes the block from an element that carries none of the sub-paths include names', () => {
    const record = {
      safetyreportid: '5',
      patient: { drug: [{ medicinalproduct: 'Y', openfda: { unii: ['U1'] } }] },
    };
    const { results, omitted_fields } = cutOn('drug/event', [record], {
      include: ['patient.drug.openfda.brand_name'],
    });
    expect(results).toEqual([
      { safetyreportid: '5', patient: { drug: [{ medicinalproduct: 'Y' }] } },
    ]);
    expect(omitted_fields).toEqual([
      { path: 'patient.drug.openfda', bytes: size({ unii: ['U1'] }) },
    ]);
  });

  it('keeps a path two levels beneath a left-out one', () => {
    const record = {
      safetyreportid: '6',
      patient: { drug: [{ openfda: { nested: { keep: 'k', drop: 'd' }, other: 'o' } }] },
    };
    const { results, omitted_fields } = cutOn('drug/event', [record], {
      include: ['patient.drug.openfda.nested.keep'],
    });
    expect(results).toEqual([
      { safetyreportid: '6', patient: { drug: [{ openfda: { nested: { keep: 'k' } } }] } },
    ]);
    expect(omitted_fields?.[0]?.bytes).toBe(
      size({ nested: { keep: 'k', drop: 'd' }, other: 'o' }) - size({ nested: { keep: 'k' } }),
    );
  });

  it('counts nothing lost when every element already holds only the sub-paths include names', () => {
    const record = { safetyreportid: '7', patient: { drug: [{ openfda: { brand_name: ['B'] } }] } };
    const page = cutOn('drug/event', [record], { include: ['patient.drug.openfda.brand_name'] });
    expect(page).toEqual({ results: [record] });
    expect(page.results[0]).toBe(record);
  });

  it('counts an empty or null left-out value as lost, by its serialized bytes', () => {
    const records = [
      { recall_number: 'Z-1', code_info: null, more_code_info: '' },
      { recall_number: 'Z-2', more_code_info: 'Lot 9' },
    ];
    expect(cutOn('device/enforcement', records)).toEqual({
      results: [{ recall_number: 'Z-1' }, { recall_number: 'Z-2' }],
      omitted_fields: [
        { path: 'code_info', bytes: 4 },
        { path: 'more_code_info', bytes: 2 + 7 },
      ],
    });
  });

  it('cuts sibling paths under one shared parent in one copy, keeping its other keys in order', () => {
    const record = {
      product_res_number: 'Z-0355-2027',
      code_info: 'YY3462',
      openfda: {
        k_number: ['K1', 'K2'],
        device_name: 'Plate',
        device_class: '2',
        fei_number: ['F1'],
        regulation_number: '866.1640',
      },
    };
    const { results, omitted_fields } = cutOn('device/recall', [record]);
    expect(results).toEqual([
      {
        product_res_number: 'Z-0355-2027',
        openfda: { device_name: 'Plate', device_class: '2', regulation_number: '866.1640' },
      },
    ]);
    expect(Object.keys(results[0]?.openfda as object)).toEqual([
      'device_name',
      'device_class',
      'regulation_number',
    ]);
    // Table order, and only the paths a record lost: no registration_number here.
    expect(omitted_fields).toEqual([
      { path: 'code_info', bytes: 8 },
      { path: 'openfda.k_number', bytes: 11 },
      { path: 'openfda.fei_number', bytes: 6 },
    ]);
  });

  it('walks past a scalar, a null, or an array where the path expects an object', () => {
    const records = [
      { safetyreportid: '8', patient: 'not an object' },
      { safetyreportid: '9', patient: [{ drug: { openfda: { a: 1 } } }] },
    ];
    expect(cutOn('drug/event', records).results).toEqual([
      records[0],
      { safetyreportid: '9', patient: [{ drug: {} }] },
    ]);
  });

  it('keeps an upstream __proto__ key as the record’s own property', () => {
    const record = JSON.parse('{"__proto__":{"x":1},"recall_number":"Z-3","code_info":"a"}');
    const [cut] = cutOn('device/enforcement', [record]).results;
    expect(Object.hasOwn(cut as object, '__proto__')).toBe(true);
    expect(JSON.stringify(cut)).toBe('{"__proto__":{"x":1},"recall_number":"Z-3"}');
    expect(Object.getPrototypeOf(cut)).toBe(Object.prototype);
  });
});

describe('omissionNotice / omissionLine', () => {
  it('is absent when no record lost a left-out path', () => {
    expect(omissionNotice({})).toBeUndefined();
    expect(omissionLine({})).toBeNull();
  });

  it('names each path and its bytes on the page, and the include re-call', () => {
    expect(
      omissionNotice({ omitted_fields: [{ path: 'patient.drug.openfda', bytes: 953_639 }] }),
    ).toBe(
      'Left out of each record by default: patient.drug.openfda (953639 bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.',
    );
    expect(
      omissionNotice({
        omitted_fields: [
          { path: 'code_info', bytes: 121_971 },
          { path: 'more_code_info', bytes: 37_868 },
        ],
      }),
    ).toBe(
      'Left out of each record by default: code_info (121971 bytes on this page), more_code_info (37868 bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.',
    );
  });

  it('renders the same sentence as a quoted content[] line whose paths read back as text', () => {
    const result = {
      omitted_fields: [
        { path: 'more_code_info', bytes: 2 },
        { path: 'openfda.registration_number', bytes: 3 },
      ],
    };
    const line = omissionLine(result) ?? '';
    expect(line).toBe(`> ${omissionNotice(result)}`);
    const html = renderCommonMark(line);
    expect(html).not.toMatch(/<(?:em|strong)>/);
    expect(html).toContain('more_code_info (2 bytes');
    expect(html).toContain('openfda.registration_number (3 bytes');
  });
});

describe('includeDescription', () => {
  it('names the left-out paths per labelled endpoint', () => {
    expect(
      includeDescription([
        ['device enforcement', 'device/enforcement'],
        ['device recall', 'device/recall'],
      ]),
    ).toBe(
      'Paths left out of each record by default, to return: code_info, more_code_info on device enforcement; code_info, openfda.k_number, openfda.fei_number, openfda.registration_number on device recall. Name one whole, or a path beneath one for that field alone; with fields, entries join the projection. A search clause on a left-out path also returns it.',
    );
    expect(includeDescription([['drug', 'drug/event']])).toContain(
      'to return: patient.drug.openfda on drug.',
    );
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

  /** Drug reports serializing to roughly `n` characters in all: one huge array, or many small reports. */
  const oneHugeArray = (n: number) => [
    {
      safetyreportid: '1',
      patient: {
        drug: Array.from({ length: n / 60 }, () => ({
          medicinalproduct: 'A',
          openfda: { unii: ['ab'], brand_name: ['x'] },
        })),
      },
    },
  ];
  const manySmall = (n: number) =>
    Array.from({ length: n / 100 }, (_, i) => ({
      safetyreportid: `${i}`,
      patient: { drug: [{ medicinalproduct: 'A', openfda: { unii: ['ab'], brand_name: ['x'] } }] },
    }));

  it.each([
    ['one huge array, the block left out whole', oneHugeArray, undefined],
    ['many small records, the block left out whole', manySmall, undefined],
    ['one huge array, a sub-path kept', oneHugeArray, ['patient.drug.openfda.brand_name']],
    ['many small records, a sub-path kept', manySmall, ['patient.drug.openfda.brand_name']],
  ])('cutRecords stays linear on %s', (_label, build, include) => {
    const omission = pageProjection('drug/event', ID, { include });
    expect(cutRecords(build(5_000), omission).omitted_fields).toHaveLength(1);
    const { t5k, t320k } = linearTiming(
      (records) => cutRecords(records, omission),
      build(5_000),
      build(320_000),
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

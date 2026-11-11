/**
 * @fileoverview Tests for the drug/event code tables — coverage of each coded
 * field's full code range, the labels FDA's field reference assigns, the
 * exact-string lookup that renders `label (code)`, and the record-level
 * labelling `format()` applies.
 * @module tests/mcp-server/tools/drug-event-codes.test
 */

import { describe, expect, it } from 'vitest';

import {
  ADMINISTRATION_ROUTES,
  codeLabel,
  codeList,
  DECHALLENGE_OUTCOMES,
  DOSAGE_INTERVAL_UNITS,
  DOSE_UNITS,
  DRUG_ACTIONS,
  EXPEDITED_REPORT_FLAGS,
  ONSET_AGE_UNITS,
  PATIENT_AGE_GROUPS,
  REACTION_OUTCOMES,
  RECEIVER_TYPES,
  RECHALLENGE_OUTCOMES,
  REPORT_TYPES,
  REPORTER_QUALIFICATIONS,
  SENDER_TYPES,
  TREATMENT_DURATION_UNITS,
  withCodeLabels,
} from '@/mcp-server/tools/drug-event-codes.js';

/** `001`–`067`: the zero-padded route codes openFDA indexes, all 67 present in drug/event. */
const ROUTE_CODES = Array.from({ length: 67 }, (_, i) => String(i + 1).padStart(3, '0'));
const ONE_TO_SIX = ['1', '2', '3', '4', '5', '6'];

describe('drug/event code tables', () => {
  it.each<[string, ReadonlyMap<string, string>, string[]]>([
    ['administration routes', ADMINISTRATION_ROUTES, ROUTE_CODES],
    ['reaction outcomes', REACTION_OUTCOMES, ONE_TO_SIX],
    ['patient age groups', PATIENT_AGE_GROUPS, ONE_TO_SIX],
  ])('%s cover exactly the documented code range', (_name, codes, expected) => {
    expect([...codes.keys()]).toEqual(expected);
  });

  it.each<[string, ReadonlyMap<string, string>, string[]]>([
    ['administration routes', ADMINISTRATION_ROUTES, ROUTE_CODES],
    ['reaction outcomes', REACTION_OUTCOMES, ONE_TO_SIX],
    ['patient age groups', PATIENT_AGE_GROUPS, ONE_TO_SIX],
  ])('%s render a lower-case label beside every code', (_name, codes, expected) => {
    for (const code of expected) {
      const rendered = codeLabel(codes, code);
      expect(rendered).toMatch(new RegExp(`^[a-z][^|\\n]* \\(${code}\\)$`));
    }
  });

  it.each<[ReadonlyMap<string, string>, string, string]>([
    [ADMINISTRATION_ROUTES, '048', 'oral (048)'],
    [ADMINISTRATION_ROUTES, '058', 'subcutaneous (058)'],
    [ADMINISTRATION_ROUTES, '042', 'intravenous (not otherwise specified) (042)'],
    [ADMINISTRATION_ROUTES, '011', 'intra corpus cavernosum (011)'],
    [ADMINISTRATION_ROUTES, '055', 'respiratory (inhalation) (055)'],
    [ADMINISTRATION_ROUTES, '065', 'unknown (065)'],
    // FDA's field reference misspells these two as "Oropharingeal" and "Sunconjunctival".
    [ADMINISTRATION_ROUTES, '049', 'oropharyngeal (049)'],
    [ADMINISTRATION_ROUTES, '057', 'subconjunctival (057)'],
    [REACTION_OUTCOMES, '1', 'recovered/resolved (1)'],
    [REACTION_OUTCOMES, '4', 'recovered/resolved with sequelae (consequent health issues) (4)'],
    [REACTION_OUTCOMES, '5', 'fatal (5)'],
    [REACTION_OUTCOMES, '6', 'unknown (6)'],
    [PATIENT_AGE_GROUPS, '1', 'neonate (1)'],
    [PATIENT_AGE_GROUPS, '6', 'elderly (6)'],
  ])('labels %#: %s → %s', (codes, code, expected) => {
    expect(codeLabel(codes, code)).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['a route name, which openFDA does not index', 'ORAL'],
    ['an unpadded route number', '48'],
    ['a code past the table', '068'],
    ['a padded code with surrounding space', ' 048'],
    ['a number rather than a string', 48],
    ['an absent value', undefined],
    ['null', null],
  ])('leaves %s unchanged', (_name, value) => {
    expect(codeLabel(ADMINISTRATION_ROUTES, value)).toBe(value);
  });

  it('leaves an inherited property name unlabelled', () => {
    expect(codeLabel(REACTION_OUTCOMES, 'constructor')).toBe('constructor');
    expect(codeLabel(REACTION_OUTCOMES, '__proto__')).toBe('__proto__');
  });

  it('lists codes as `code = label` for the field catalog notes', () => {
    expect(codeList(PATIENT_AGE_GROUPS)).toBe(
      '1 = neonate, 2 = infant, 3 = child, 4 = adolescent, 5 = adult, 6 = elderly',
    );
    expect(codeList(ADMINISTRATION_ROUTES, ['048', '065'])).toBe('048 = oral, 065 = unknown');
  });

  /*
   * #90 and its fold-in — the remaining coded fields, each table exactly the
   * `one_of` list FDA's drug/event field reference publishes, lower-cased. Two
   * gaps stay raw: `drugintervaldosagedefinition` 807 (FDA labels both 807 and
   * 811 "Trimester") and dose-unit codes 005 and above (no published label).
   */
  describe('the #90 tables', () => {
    it.each<[string, ReadonlyMap<string, string>, [string, string][]]>([
      [
        'patient.patientonsetageunit',
        ONSET_AGE_UNITS,
        [
          ['800', 'decade'],
          ['801', 'year'],
          ['802', 'month'],
          ['803', 'week'],
          ['804', 'day'],
          ['805', 'hour'],
        ],
      ],
      [
        'patient.drug.actiondrug',
        DRUG_ACTIONS,
        [
          ['1', 'drug withdrawn'],
          ['2', 'dose reduced'],
          ['3', 'dose increased'],
          ['4', 'dose not changed'],
          ['5', 'unknown'],
          ['6', 'not applicable'],
        ],
      ],
      [
        'patient.drug.drugadditional',
        DECHALLENGE_OUTCOMES,
        [
          ['1', 'yes'],
          ['2', 'no'],
          ['3', 'does not apply'],
        ],
      ],
      [
        'patient.drug.drugrecurreadministration',
        RECHALLENGE_OUTCOMES,
        [
          ['1', 'yes'],
          ['2', 'no'],
          ['3', 'unknown'],
        ],
      ],
      [
        'reporttype',
        REPORT_TYPES,
        [
          ['1', 'spontaneous'],
          ['2', 'report from study'],
          ['3', 'other'],
          ['4', 'not available to sender (unknown)'],
        ],
      ],
      [
        'primarysource.qualification',
        REPORTER_QUALIFICATIONS,
        [
          ['1', 'physician'],
          ['2', 'pharmacist'],
          ['3', 'other health professional'],
          ['4', 'lawyer'],
          ['5', 'consumer or non-health professional'],
        ],
      ],
      ['sender.sendertype', SENDER_TYPES, [['2', 'regulatory authority']]],
      ['receiver.receivertype', RECEIVER_TYPES, [['6', 'other']]],
      [
        'fulfillexpeditecriteria',
        EXPEDITED_REPORT_FLAGS,
        [
          ['1', 'yes'],
          ['2', 'no'],
        ],
      ],
      [
        'patient.drug.drugtreatmentdurationunit',
        TREATMENT_DURATION_UNITS,
        [
          ['801', 'year'],
          ['802', 'month'],
          ['803', 'week'],
          ['804', 'day'],
          ['805', 'hour'],
          ['806', 'minute'],
        ],
      ],
      [
        'patient.drug.drugintervaldosagedefinition',
        DOSAGE_INTERVAL_UNITS,
        [
          ['801', 'year'],
          ['802', 'month'],
          ['803', 'week'],
          ['804', 'day'],
          ['805', 'hour'],
          ['806', 'minute'],
          ['810', 'cyclical'],
          ['811', 'trimester'],
          ['812', 'as necessary'],
          ['813', 'total'],
        ],
      ],
      [
        'patient.drug.drugstructuredosageunit and drugcumulativedosageunit',
        DOSE_UNITS,
        [
          ['001', 'kg (kilograms)'],
          ['002', 'g (grams)'],
          ['003', 'mg (milligrams)'],
          ['004', 'µg (micrograms)'],
        ],
      ],
    ])('%s holds exactly the field reference codes', (_field, codes, expected) => {
      expect([...codes]).toEqual(expected);
    });

    it.each<[ReadonlyMap<string, string>, string]>([
      [DOSAGE_INTERVAL_UNITS, '807'],
      [DOSE_UNITS, '005'],
      [DOSE_UNITS, '032'],
      [ONSET_AGE_UNITS, '806'],
      // openFDA stores these, but FDA's reference defines only 1–3, 1–2, and 2.
      [DECHALLENGE_OUTCOMES, '4'],
      [EXPEDITED_REPORT_FLAGS, '3'],
      [SENDER_TYPES, '1'],
    ])('leaves an unlabelled code raw: %#', (codes, code) => {
      expect(codeLabel(codes, code)).toBe(code);
    });
  });

  describe('withCodeLabels', () => {
    const SPEC = {
      actiondrug: DRUG_ACTIONS,
      primarysource: { qualification: REPORTER_QUALIFICATIONS },
    } as const;

    it('labels a listed field and a listed field one object down, keeping key order', () => {
      const record = {
        medicinalproduct: 'ASPIRIN',
        actiondrug: '1',
        primarysource: { reportercountry: 'BR', qualification: '5' },
      };
      const labelled = withCodeLabels(record, SPEC);
      expect(labelled).toEqual({
        medicinalproduct: 'ASPIRIN',
        actiondrug: 'drug withdrawn (1)',
        primarysource: {
          reportercountry: 'BR',
          qualification: 'consumer or non-health professional (5)',
        },
      });
      expect(Object.keys(labelled)).toEqual(['medicinalproduct', 'actiondrug', 'primarysource']);
    });

    it('leaves the input unmutated', () => {
      const record = { actiondrug: '1', primarysource: { qualification: '1' } };
      const before = JSON.stringify(record);
      withCodeLabels(record, SPEC);
      expect(JSON.stringify(record)).toBe(before);
    });

    it('adds no key the record lacks', () => {
      // toEqual ignores a key whose value is undefined, so the keys themselves are compared.
      expect(Object.keys(withCodeLabels({ medicinalproduct: 'X' }, SPEC))).toEqual([
        'medicinalproduct',
      ]);
    });

    it('leaves an unlisted code, and a nested field that is not an object, unchanged', () => {
      expect(withCodeLabels({ actiondrug: '9', primarysource: 'BR' }, SPEC)).toEqual({
        actiondrug: '9',
        primarysource: 'BR',
      });
      expect(withCodeLabels({ primarysource: [{ qualification: '1' }] }, SPEC)).toEqual({
        primarysource: [{ qualification: '1' }],
      });
    });

    it('labels only own fields, never one inherited by name', () => {
      const record = Object.create({ actiondrug: '1' }) as Record<string, unknown>;
      expect(Object.hasOwn(withCodeLabels(record, SPEC), 'actiondrug')).toBe(false);
    });
  });
});

/**
 * @fileoverview Tests for the drug/event code tables — coverage of each coded
 * field's full code range, the labels FDA's field reference assigns, and the
 * exact-string lookup that renders `label (code)`.
 * @module tests/mcp-server/tools/drug-event-codes.test
 */

import { describe, expect, it } from 'vitest';

import {
  ADMINISTRATION_ROUTES,
  codeLabel,
  codeList,
  PATIENT_AGE_GROUPS,
  REACTION_OUTCOMES,
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
});

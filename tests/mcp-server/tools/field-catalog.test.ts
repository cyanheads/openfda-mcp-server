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

  // #62 — a note states what openFDA stores and accepts: coded fields list their
  // code meanings, and example values return results on a live search (probed
  // 2026-10-12). `format()` writes notes into a Markdown table cell.
  describe('field notes (#62)', () => {
    const fieldOf = (endpoint: string, path: string) => {
      const field = (getFieldGroups(endpoint) ?? [])
        .flatMap((g) => g.fields)
        .find((f) => f.path === path);
      if (!field) throw new Error(`${endpoint} ${path} is not cataloged`);
      return field;
    };

    it('never puts a pipe in a note, which would split the describe_fields table cell', () => {
      const piped = allEntries().filter(({ field }) => field.note.includes('|'));
      expect(piped.map(({ endpoint, field }) => `${endpoint} ${field.path}`)).toEqual([]);
    });

    /** The query forms drug/shortages dates accept — every YYYYMMDD query answers 404. */
    const SHORTAGE_DATE_FORMS = [
      'stored MM/DD/YYYY',
      '[2026-01-01 TO 2026-12-31]',
      '[01/01/2026 TO 12/31/2026]',
      'never YYYYMMDD',
    ];
    /** HDE is indexed lowercase on the harmonized openfda.* paths: `"F"` answers 404, `"f"` matches. */
    const HARMONIZED_DEVICE_CLASS = ['"U"', '"N"', '"f"', '"F" matches nothing'];

    it.each<[string, string, string[]]>([
      [
        'drug/event',
        'patient.reaction.reactionoutcome',
        [
          '1 = recovered/resolved',
          '2 = recovering/resolving',
          '3 = not recovered/not resolved',
          '4 = recovered/resolved with sequelae',
          '5 = fatal',
          '6 = unknown',
        ],
      ],
      ['drug/shortages', 'initial_posting_date', SHORTAGE_DATE_FORMS],
      ['drug/shortages', 'update_date', SHORTAGE_DATE_FORMS],
      ['drug/event', 'patient.patientsex', ['0 = unknown', '1 = male', '2 = female']],
      [
        'drug/event',
        'patient.patientagegroup',
        ['1 = neonate', '2 = infant', '3 = child', '4 = adolescent', '5 = adult', '6 = elderly'],
      ],
      [
        'drug/event',
        'patient.drug.drugadministrationroute',
        ['3-digit', '"ORAL" matches nothing', '048 = oral', '058 = subcutaneous', '065 = unknown'],
      ],
      ['drug/label', 'openfda.product_type', ['"HUMAN OTC DRUG"', '"HUMAN PRESCRIPTION DRUG"']],
      ['drug/label', 'openfda.application_number', ['BLA', '"M020"']],
      ['drug/enforcement', 'product_type', ['always "Drugs"']],
      ['drug/ndc', 'product_ndc', ['"0363-0218"', 'not the package NDC']],
      ['drug/ndc', 'marketing_category', ['"OTC MONOGRAPH DRUG"', '"NDA AUTHORIZED GENERIC"']],
      ['drug/drugsfda', 'submissions.review_priority', ['"UNKNOWN"', '"901 REQUIRED"']],
      ['drug/shortages', 'status', ['"Current"', '"To Be Discontinued"', '"Resolved"']],
      ['drug/shortages', 'availability', ['"Available"', '"Limited Availability"']],
      ['food/event', 'reactions', ['array of MedDRA terms']],
      ['device/event', 'source_type', ['"Health Professional"', '"Consumer"']],
      ['device/event', 'device.openfda.device_class', HARMONIZED_DEVICE_CLASS],
      ['device/recall', 'openfda.device_class', HARMONIZED_DEVICE_CLASS],
      ['device/registrationlisting', 'products.openfda.device_class', HARMONIZED_DEVICE_CLASS],
      ['device/udi', 'product_codes.openfda.device_class', HARMONIZED_DEVICE_CLASS],
      ['device/classification', 'device_class', ['"U"', '"N"', '"F" (HDE)']],
      ['device/udi', 'identifiers.issuing_agency', ['NDC/NHRIC']],
      ['device/510k', 'decision_date', ['stored YYYY-MM-DD', 'query as YYYYMMDD']],
      ['device/pma', 'decision_date', ['stored YYYY-MM-DD', 'query as YYYYMMDD']],
      ['tobacco/problem', 'date_submitted', ['stored MM/DD/YYYY', 'query as YYYYMMDD']],
      ['tobacco/problem', 'nonuser_affected', ['"No information provided"', '"Neither"']],
      ['device/covid19serology', 'date_performed', ['stored M/D/YYYY', 'query as YYYYMMDD']],
      ['animalandveterinary/event', 'outcome.medical_status', ['"Died"', '"Outcome Unknown"']],
      ['animalandveterinary/event', 'foreign_or_domestic', ['"Domestic"', 'matches nothing']],
    ])('%s %s names %j', (endpoint, path, fragments) => {
      const { note } = fieldOf(endpoint, path);
      for (const fragment of fragments) expect(note).toContain(fragment);
    });

    it.each<[string, string, string]>([
      ['drug/event', 'patient.reaction.reactionoutcome', '4 = fatal'],
      ['drug/enforcement', 'product_type', 'Biologics'],
      ['drug/ndc', 'product_ndc', '10-digit'],
      ['device/event', 'source_type', '"Manufacturer"'],
      ['animalandveterinary/event', 'outcome.medical_status', '"Death"'],
    ])(
      '%s %s no longer states the wrong meaning or zero-result example %s',
      (endpoint, path, stale) => {
        expect(fieldOf(endpoint, path).note).not.toContain(stale);
      },
    );

    it('types the covid19serology performed date as a date', () => {
      expect(fieldOf('device/covid19serology', 'date_performed').type).toBe('date');
    });
  });

  // #65 — openFDA masks every veterinary brand and manufacturer name as `MSK`;
  // an ingredient search on the analyzed field and the approval number are the
  // routes that work.
  describe('animalandveterinary/event drug notes (#65)', () => {
    const animalField = (path: string) =>
      (getFieldGroups('animalandveterinary/event') ?? [])
        .flatMap((g) => g.fields)
        .find((f) => f.path === path);

    it('says every brand_name carries MSK', () => {
      const note = animalField('drug.brand_name')?.note ?? '';
      expect(note).toContain('"MSK"');
      expect(note).toMatch(/every record/);
      expect(note).toContain('drug.manufacturer.name');
    });

    it('steers ingredient search to the unsuffixed field', () => {
      const field = animalField('drug.active_ingredients.name');
      expect(field?.note).toMatch(/search .*unsuffixed/i);
      expect(field?.countable).toBe('exact');
    });

    it('catalogs the manufacturer registration number, counted bare', () => {
      const field = animalField('drug.manufacturer.registration_number');
      expect(field).toMatchObject({ type: 'string', countable: 'bare' });
      expect(field?.note).toContain('"USA-USFDACVM-N141426"');
      expect(
        countVerdict('animalandveterinary/event', 'drug.manufacturer.registration_number'),
      ).toEqual({
        kind: 'countable',
      });
    });
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

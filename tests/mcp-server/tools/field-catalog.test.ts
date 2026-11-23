/**
 * @fileoverview Tests for the openFDA field catalog — the per-field count
 * annotation, the paths it advertises, and the count-expression lookup.
 * @module tests/mcp-server/tools/field-catalog.test
 */

import { describe, expect, it } from 'vitest';

import {
  type Countable,
  countVerdict,
  type FieldEntry,
  formatFieldHint,
  getCatalogedEndpoints,
  getFieldGroups,
  OBJECT_ARRAY_PATHS,
  SINGLE_ENTRY_ARRAYS,
} from '@/mcp-server/tools/field-catalog.js';

const allEntries = () =>
  getCatalogedEndpoints().flatMap((endpoint) =>
    (getFieldGroups(endpoint) ?? []).flatMap((g) => g.fields.map((field) => ({ endpoint, field }))),
  );

/** Every cataloged field of an endpoint, in catalog order. */
const fieldsOf = (endpoint: string) => (getFieldGroups(endpoint) ?? []).flatMap((g) => g.fields);

/** The cataloged entry for one path, or undefined. */
const entryAt = (endpoint: string, path: string) => fieldsOf(endpoint).find((f) => f.path === path);

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

    /**
     * drug/shortages dates read an 8-digit value as epoch milliseconds, so the
     * shortage search and count tools rewrite a calendar date to YYYY-MM-DD (#102).
     */
    const SHORTAGE_DATE_FORMS = [
      'stored MM/DD/YYYY',
      'queried as YYYY-MM-DD',
      '[2026-01-01 TO 2026-12-31]',
      'a YYYYMMDD, M/D/YYYY, or YYYY-M-D date is rewritten to that form',
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
      ['drug/shortages', 'discontinued_date', SHORTAGE_DATE_FORMS],
      ['drug/shortages', 'change_date', SHORTAGE_DATE_FORMS],
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
      // #96 — records store HDE as a lowercase "f"; a search matches either case.
      ['device/classification', 'device_class', ['"U"', '"N"', '"f" (HDE, stored lowercase']],
      [
        'device/classification',
        'submission_type_id',
        ['"1" = 510(k)', '"2" = PMA', '"3" = contact ODE', '"4" = 510(k) exempt', '6, 7, 8'],
      ],
      [
        'device/classification',
        'unclassified_reason',
        ['"1" = pre-amendment', '"6" = enforcement discretion', '9 and 11'],
      ],
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
      ['drug/shortages', 'initial_posting_date', 'never YYYYMMDD'],
      ['drug/shortages', 'update_date', 'never YYYYMMDD'],
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

    // #72 — the coded drug/event notes read their labels from the shared code
    // tables, so they carry FDA's field-reference wording, glosses included.
    it.each<[string, string]>([
      [
        'patient.reaction.reactionoutcome',
        '4 = recovered/resolved with sequelae (consequent health issues)',
      ],
      ['patient.drug.drugadministrationroute', '042 = intravenous (not otherwise specified)'],
    ])('drug/event %s carries the field-reference label %j', (path, fragment) => {
      expect(fieldOf('drug/event', path).note).toContain(fragment);
    });

    // #90 fold-in — the coded drug/event fields format() labels are cataloged
    // with notes built from the same code tables, each count form probed live
    // (2026-11-10: the unit fields answer 5xx bare and "Nothing to count" .exact).
    describe('drug/event coded fields (#90)', () => {
      it.each<[string, Countable, string[]]>([
        [
          'patient.patientonsetageunit',
          'none',
          ['patient.patientonsetage', '800 = decade', '802 = month', '805 = hour'],
        ],
        ['patient.drug.actiondrug', 'bare', ['1 = drug withdrawn', '6 = not applicable']],
        ['patient.drug.drugadditional', 'bare', ['1 = yes', '3 = does not apply', 'also stores 4']],
        ['patient.drug.drugrecurreadministration', 'bare', ['1 = yes', '3 = unknown']],
        ['patient.drug.drugtreatmentdurationunit', 'none', ['801 = year', '806 = minute']],
        [
          'patient.drug.drugintervaldosagedefinition',
          'bare',
          ['804 = day', '810 = cyclical', '813 = total', '807'],
        ],
        [
          'patient.drug.drugstructuredosageunit',
          'none',
          ['004 = µg (micrograms)', '005 and above'],
        ],
        [
          'patient.drug.drugcumulativedosageunit',
          'none',
          ['003 = mg (milligrams)', '005 and above'],
        ],
        ['reporttype', 'bare', ['1 = spontaneous', '4 = not available to sender (unknown)']],
        [
          'primarysource.qualification',
          'bare',
          ['1 = physician', '5 = consumer or non-health professional'],
        ],
        ['fulfillexpeditecriteria', 'bare', ['1 = yes', '2 = no', 'also stores 3, 4, and 5']],
      ])('catalogs %s, counted %s, with its code meanings', (path, countable, fragments) => {
        const field = fieldOf('drug/event', path);
        expect(field.countable).toBe(countable);
        for (const fragment of fragments) expect(field.note).toContain(fragment);
      });

      it('keeps the six fields the empty-result hint names', () => {
        expect(formatFieldHint('drug/event')).toContain(
          'drug/event: safetyreportid, receivedate, serious, primarysource.reportercountry, patient.patientsex, patient.patientagegroup.',
        );
      });
    });

    // #80 — openFDA serves one current record per SPL set; no set_id reaches an earlier revision.
    it('drug/label set_id says openFDA holds only the current revision', () => {
      const { note } = fieldOf('drug/label', 'set_id');
      expect(note).toContain('current revision only');
      expect(note).not.toContain('stable across revisions');
    });

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

  // #89 — openFDA fills openfda.* on harmonized Drugs@FDA applications only;
  // products.brand_name is on nearly every one. The bare path is analyzed text:
  // `count=products.brand_name` answers illegal_argument_exception, `.exact` counts.
  describe('drug/drugsfda products.brand_name (#89)', () => {
    it('says sponsor_name is stored uppercase, which a quoted value must match', () => {
      const field = (getFieldGroups('drug/drugsfda') ?? [])
        .flatMap((g) => g.fields)
        .find((f) => f.path === 'sponsor_name');
      expect(field?.note).toContain('stored uppercase');
    });

    it('catalogs products.brand_name, counted as .exact', () => {
      const field = (getFieldGroups('drug/drugsfda') ?? [])
        .flatMap((g) => g.fields)
        .find((f) => f.path === 'products.brand_name');
      expect(field).toMatchObject({ type: 'string', countable: 'exact' });
      expect(countVerdict('drug/drugsfda', 'products.brand_name')).toEqual({
        kind: 'wrong_form',
        use: 'products.brand_name.exact',
      });
    });

    it('sits among the six fields the empty-result hint names', () => {
      expect(formatFieldHint('drug/drugsfda')).toMatch(
        /^Key searchable fields for drug\/drugsfda: (?:[\w.]+, ){0,5}products\.brand_name[,.]/,
      );
    });
  });

  /**
   * A field a notice recommends or a tool sorts on by default is one
   * openfda_describe_fields lists: the label no-match notice names
   * `spl_product_data_elements` (#89), and a bare device recall browse sorts on
   * `event_date_initiated` (#88). Count forms probed live 2026-11-10.
   */
  describe('fields a notice or default sort names', () => {
    it('catalogs drug/label spl_product_data_elements, which counts in neither form', () => {
      for (const expression of ['spl_product_data_elements', 'spl_product_data_elements.exact']) {
        expect(countVerdict('drug/label', expression).kind).toBe('none');
      }
    });

    it('catalogs device/recall event_date_initiated as a date counted bare', () => {
      expect(countVerdict('device/recall', 'event_date_initiated')).toEqual({ kind: 'countable' });
      expect(countVerdict('device/recall', 'event_date_initiated.exact')).toEqual({
        kind: 'wrong_form',
        use: 'event_date_initiated',
      });
      const field = (getFieldGroups('device/recall') ?? [])
        .flatMap((g) => g.fields)
        .find((f) => f.path === 'event_date_initiated');
      expect(field?.type).toBe('date');
    });

    it('leaves the label and device recall empty-result hints unchanged', () => {
      expect(formatFieldHint('drug/label')).toContain(
        'drug/label: openfda.brand_name, openfda.generic_name, openfda.manufacturer_name, openfda.product_type, openfda.route, openfda.application_number.',
      );
      expect(formatFieldHint('device/recall')).toContain(
        'device/recall: product_res_number, res_event_number, recall_status, openfda.device_class, recalling_firm, product_description.',
      );
    });
  });

  /**
   * Entries this batch adds to an existing endpoint, each count form probed live
   * 2026-11-22: `bare` answered 200 bare and `Nothing to count` with .exact,
   * `none` a 5xx bare and `Nothing to count` with .exact, `both` 200 either way.
   */
  describe('fields added to existing endpoints', () => {
    it.each<[string, string, FieldEntry['type'], Countable]>([
      // #96
      ['device/classification', 'submission_type_id', 'string', 'none'],
      ['device/classification', 'summary_malfunction_reporting', 'string', 'bare'],
      ['device/classification', 'openfda.pma_number', 'string', 'bare'],
      ['device/classification', 'review_panel', 'string', 'none'],
      ['device/classification', 'medical_specialty', 'string', 'none'],
      ['device/classification', 'definition', 'string', 'none'],
      ['device/classification', 'unclassified_reason', 'string', 'none'],
      // #100
      ['drug/drugsfda', 'submissions.submission_class_code', 'string', 'bare'],
      // #102 — both bucket by YYYYMMDD date when counted bare.
      ['drug/shortages', 'discontinued_date', 'date', 'bare'],
      ['drug/shortages', 'change_date', 'date', 'bare'],
      // #107 — tallies as 1 bare and "true" with .exact; no label stores false.
      ['drug/label', 'openfda.is_original_packager', 'boolean', 'both'],
      // Tallies as 1 bare (5,873 products, probed 2026-11-22); .exact has nothing to count.
      ['drug/orangebook', 'approved_prior_to_1982', 'boolean', 'bare'],
    ])('%s catalogs %s as a %s counted %s', (endpoint, path, type, countable) => {
      expect(entryAt(endpoint, path)).toMatchObject({ type, countable });
    });

    it('drug/orangebook approved_prior_to_1982 counts bare and says it stands in for approval_date', () => {
      expect(countVerdict('drug/orangebook', 'approved_prior_to_1982.exact')).toEqual({
        kind: 'wrong_form',
        use: 'approved_prior_to_1982',
      });
      const note = entryAt('drug/orangebook', 'approved_prior_to_1982')?.note ?? '';
      expect(note).toContain('approved before 1982');
      expect(note).toContain('no approval_date');
      expect(note).toContain('approved_prior_to_1982:true');
    });

    it('drug/label openfda.is_original_packager counts either way and names its filter', () => {
      const path = 'openfda.is_original_packager';
      for (const expression of [path, `${path}.exact`]) {
        expect(countVerdict('drug/label', expression), expression).toEqual({ kind: 'countable' });
      }
      const note = entryAt('drug/label', path)?.note ?? '';
      expect(note).toContain('openfda.is_original_packager:true');
      expect(note).toContain('never stored false');
    });

    // #100 — the new-molecular-entity code, which a prefix reading would conflate with "TYPE 1/4".
    it('drug/drugsfda submissions.submission_class_code counts bare and names the NME code', () => {
      expect(countVerdict('drug/drugsfda', 'submissions.submission_class_code')).toEqual({
        kind: 'countable',
      });
      expect(countVerdict('drug/drugsfda', 'submissions.submission_class_code.exact')).toEqual({
        kind: 'wrong_form',
        use: 'submissions.submission_class_code',
      });
      const note = entryAt('drug/drugsfda', 'submissions.submission_class_code')?.note ?? '';
      expect(note).toContain('"TYPE 1" (new molecular entity');
      expect(note).toContain('"TYPE 1/4" is a separate value');
    });

    it('keeps the empty-result hint on device/classification led by its search keys', () => {
      expect(formatFieldHint('device/classification')).toContain(
        'device/classification: product_code, device_name, device_class, regulation_number, submission_type_id, medical_specialty_description.',
      );
    });
  });

  /**
   * Endpoints this batch catalogs, each field's count form probed live
   * 2026-11-22 (dates bucket by YYYYMMDD bare; booleans tally as 1 and 0).
   */
  describe('endpoints added for openfda_count_values and openfda_describe_fields', () => {
    const countForms = (endpoint: string) =>
      Object.fromEntries(fieldsOf(endpoint).map((f) => [f.path, f.countable]));
    /** The note an endpoint's entry for a path carries, or '' when uncataloged. */
    const noteOn = (endpoint: string) => (path: string) => entryAt(endpoint, path)?.note ?? '';

    // #93
    it('catalogs drug/orangebook with its probed count forms', () => {
      expect(countForms('drug/orangebook')).toEqual({
        'products.application_number': 'bare',
        'products.application_type': 'bare',
        'products.application_name': 'exact',
        product_number: 'bare',
        'products.brand_name': 'exact',
        approval_date: 'bare',
        approved_prior_to_1982: 'bare',
        'products.marketing_status': 'exact',
        'products.dosage_form': 'exact',
        'products.route': 'exact',
        'products.therapeutic_equivalence_codes': 'bare',
        'products.reference_listed_drug': 'bare',
        'products.reference_standard': 'bare',
        'products.active_ingredients.name': 'exact',
        'products.active_ingredients.strength': 'bare',
        'patents.patent_number': 'bare',
        'patents.expiration_date': 'bare',
        'patents.patent_use_code': 'bare',
        'patents.patent_submission_date': 'bare',
        'patents.drug_substance_flag': 'bare',
        'patents.drug_product_flag': 'bare',
        'exclusivity.exclusivity_code': 'bare',
        'exclusivity.exclusivity_expiration_date': 'bare',
      });
    });

    it('notes the Orange Book application-number form and the pediatric patent suffix', () => {
      const note = noteOn('drug/orangebook');
      expect(note('products.application_number')).toContain('six digits with no prefix');
      expect(note('products.application_number')).toContain('products.application_type');
      expect(note('products.application_type')).toContain('"N" (NDA) or "A" (ANDA)');
      expect(note('patents.patent_number')).toContain('"*PED"');
      expect(countVerdict('drug/orangebook', 'products.brand_name')).toEqual({
        kind: 'wrong_form',
        use: 'products.brand_name.exact',
      });
    });

    // #93
    it('catalogs transparency/crl with its probed count forms', () => {
      expect(countForms('transparency/crl')).toEqual({
        application_number: 'bare',
        company_name: 'exact',
        letter_date: 'bare',
        letter_type: 'bare',
        approval_status: 'bare',
        letter_year: 'bare',
        file_name: 'bare',
        approver_name: 'exact',
        approver_center: 'exact',
        text: 'none',
      });
    });

    it('notes the CRL application-number spelling, letter-date form, and status case', () => {
      const note = noteOn('transparency/crl');
      expect(note('application_number')).toContain('"NDA 210274"');
      expect(note('application_number')).toContain('text:"217225"');
      expect(note('letter_date')).toContain('stored MM/DD/YYYY; query as YYYYMMDD');
      expect(note('approval_status')).toContain('"unapproved" matches nothing');
      const verdict = countVerdict('transparency/crl', 'text');
      expect(verdict.kind).toBe('none');
      if (verdict.kind === 'none') expect(verdict.alternatives).toContain('company_name.exact');
    });

    // #94 — every field counts bare except package_ndc.
    it('catalogs other/nsde with its probed count forms', () => {
      expect(countForms('other/nsde')).toEqual({
        package_ndc11: 'bare',
        package_ndc: 'none',
        proprietary_name: 'bare',
        dosage_form: 'bare',
        product_type: 'bare',
        billing_unit: 'bare',
        marketing_category: 'bare',
        application_number_or_citation: 'bare',
        marketing_start_date: 'bare',
        marketing_end_date: 'bare',
        inactivation_date: 'bare',
        reactivation_date: 'bare',
      });
    });

    it('notes the spelling each NSDE identifier field matches', () => {
      const note = noteOn('other/nsde');
      expect(note('package_ndc11')).toContain('11 digits, no hyphens');
      expect(note('package_ndc')).toContain('Hyphenated 10-digit');
      expect(note('package_ndc')).toContain('every package of the product');
      expect(note('proprietary_name')).toContain('stored case');
      expect(formatFieldHint('other/nsde')).toContain(
        'other/nsde: package_ndc11, package_ndc, proprietary_name,',
      );
    });

    // #95 — .exact on the product name, reactions, and outcomes; bare on the rest.
    it('catalogs cosmetic/event with its probed count forms', () => {
      expect(countForms('cosmetic/event')).toEqual({
        report_number: 'bare',
        initial_received_date: 'bare',
        latest_received_date: 'bare',
        event_date: 'bare',
        'products.product_name': 'exact',
        'products.role': 'bare',
        reactions: 'exact',
        outcomes: 'exact',
        report_type: 'bare',
        report_version: 'bare',
        legacy_report_id: 'bare',
        meddra_version: 'bare',
        'patient.gender': 'bare',
        'patient.age': 'bare',
        'patient.age_unit': 'bare',
      });
    });

    it('notes the free-text event_date, the food/event link, and the gender case', () => {
      const note = noteOn('cosmetic/event');
      expect(entryAt('cosmetic/event', 'event_date')?.type).toBe('string');
      expect(note('event_date')).toContain('free text, not a date');
      expect(note('event_date')).toContain('a YYYYMMDD range matches nothing');
      expect(note('legacy_report_id')).toContain('its report_number on food/event');
      expect(note('patient.gender')).toContain('"female" matches nothing');
      expect(formatFieldHint('cosmetic/event')).toContain(
        'cosmetic/event: report_number, initial_received_date, latest_received_date, event_date, products.product_name, products.role.',
      );
    });
  });

  /**
   * #100 — arrays of objects, where AND-ed clauses on two of an array's fields can
   * be met by different elements. Each path was read as an array of objects on a
   * live record (2026-11-22).
   */
  describe('OBJECT_ARRAY_PATHS (#100)', () => {
    /** Arrays no cataloged field sits under, each with the leaf keys live records carry. */
    const UNCATALOGED_PARENTS = new Map([
      [
        'drug/drugsfda submissions.application_docs',
        'live leaves date, id, type, url; the catalog lists no application document field',
      ],
      [
        'drug/drugsfda submissions.submission_property_type',
        'live leaf code; the catalog lists no submission property field',
      ],
      [
        'drug/drugsfda products.active_ingredients',
        'live leaves name, strength; the catalog lists products.brand_name only',
      ],
      [
        'device/event mdr_text',
        'live leaves text, text_type_code, mdr_text_key, patient_sequence_number; uncataloged',
      ],
      [
        'drug/ndc packaging',
        'live leaves package_ndc, description, marketing_start_date, sample; uncataloged',
      ],
    ]);
    const tablePairs = () =>
      Object.entries(OBJECT_ARRAY_PATHS).flatMap(([endpoint, paths]) =>
        paths.map((path) => ({ endpoint, path })),
      );
    /** The cataloged paths of an endpoint that sit under `path`. */
    const fieldsUnder = (endpoint: string, path: string) =>
      fieldsOf(endpoint)
        .map((f) => f.path)
        .filter((field) => field.startsWith(`${path}.`));

    /**
     * Also read on live records: 466 transparency/crl letters, whose only arrays
     * (`application_number`, `approver_center`) hold strings, and 100 other/nsde
     * rows, which are flat. Both stay out of the table.
     */
    it('lists the arrays of the six #100 endpoints, Orange Book, and cosmetic reports', () => {
      expect(OBJECT_ARRAY_PATHS).toEqual({
        'drug/drugsfda': [
          'submissions',
          'submissions.application_docs',
          'submissions.submission_property_type',
          'products',
          'products.active_ingredients',
        ],
        'drug/event': ['patient.drug', 'patient.reaction'],
        'device/event': ['device', 'patient', 'mdr_text'],
        'food/event': ['products'],
        'animalandveterinary/event': ['drug', 'drug.active_ingredients', 'reaction', 'outcome'],
        'drug/ndc': ['active_ingredients', 'packaging'],
        'drug/orangebook': ['products', 'products.active_ingredients', 'patents', 'exclusivity'],
        'cosmetic/event': ['products'],
      });
      expect(OBJECT_ARRAY_PATHS['transparency/crl']).toBeUndefined();
      expect(OBJECT_ARRAY_PATHS['other/nsde']).toBeUndefined();
    });

    it('keys only cataloged endpoints', () => {
      const cataloged = getCatalogedEndpoints();
      for (const endpoint of Object.keys(OBJECT_ARRAY_PATHS)) {
        expect(cataloged).toContain(endpoint);
      }
    });

    it('lists a nested array by its full path, after the array that holds it', () => {
      for (const paths of Object.values(OBJECT_ARRAY_PATHS)) {
        expect(new Set(paths).size).toBe(paths.length);
        for (const [i, path] of paths.entries()) {
          for (const [j, outer] of paths.entries()) {
            if (path.startsWith(`${outer}.`)) expect(j).toBeLessThan(i);
          }
        }
      }
    });

    it.each([
      ['drug/drugsfda', 'submissions.application_docs', 'submissions'],
      ['drug/drugsfda', 'submissions.submission_property_type', 'submissions'],
      ['drug/drugsfda', 'products.active_ingredients', 'products'],
      ['animalandveterinary/event', 'drug.active_ingredients', 'drug'],
      ['drug/orangebook', 'products.active_ingredients', 'products'],
    ])('%s lists %s after %s, the array that holds it', (endpoint, nested, holder) => {
      const paths = OBJECT_ARRAY_PATHS[endpoint] ?? [];
      expect(paths).toContain(holder);
      expect(paths.indexOf(holder)).toBeLessThan(paths.indexOf(nested));
    });

    it('names a prefix of a cataloged field, or records why the catalog lists none under it', () => {
      const unexplained = tablePairs().filter(
        ({ endpoint, path }) =>
          fieldsUnder(endpoint, path).length === 0 &&
          !UNCATALOGED_PARENTS.has(`${endpoint} ${path}`),
      );
      expect(unexplained).toEqual([]);
    });

    it.each([
      ['drug/orangebook', 'products', 'products.application_number'],
      ['drug/orangebook', 'products.active_ingredients', 'products.active_ingredients.name'],
      ['drug/orangebook', 'patents', 'patents.patent_number'],
      ['drug/orangebook', 'exclusivity', 'exclusivity.exclusivity_code'],
      ['cosmetic/event', 'products', 'products.product_name'],
    ])('%s %s holds the cataloged %s, so it needs no recorded reason', (endpoint, path, field) => {
      expect(fieldsUnder(endpoint, path)).toContain(field);
      expect(UNCATALOGED_PARENTS.has(`${endpoint} ${path}`)).toBe(false);
    });

    it('keeps a recorded reason only for a listed path the catalog still lists nothing under', () => {
      const listed = new Set(tablePairs().map(({ endpoint, path }) => `${endpoint} ${path}`));
      for (const key of UNCATALOGED_PARENTS.keys()) {
        expect(listed).toContain(key);
        const [endpoint = '', path = ''] = key.split(' ');
        expect(fieldsUnder(endpoint, path), key).toEqual([]);
      }
    });
  });

  /**
   * Arrays holding one entry on every record, where two clauses on the array's
   * own fields cannot be met by different entries. A walk of all 48,990
   * drug/orangebook records (2026-11-22) found one `products` entry on each;
   * its `patents` and `exclusivity` hold up to 149 and 12.
   */
  describe('SINGLE_ENTRY_ARRAYS', () => {
    it('marks the Orange Book products block alone', () => {
      expect(SINGLE_ENTRY_ARRAYS).toEqual({ 'drug/orangebook': ['products'] });
    });

    it('marks only arrays its endpoint lists', () => {
      for (const [endpoint, paths] of Object.entries(SINGLE_ENTRY_ARRAYS)) {
        for (const path of paths) expect(OBJECT_ARRAY_PATHS[endpoint], endpoint).toContain(path);
      }
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

    /**
     * #96 — `submission_type_id` answers a 5xx bare and `Nothing to count` with
     * .exact (probed 2026-11-22). Uncataloged, each failure's hint offered the
     * other form; cataloged `none`, both forms fail without one.
     */
    it('reports device/classification submission_type_id as counting in no form', () => {
      for (const expression of ['submission_type_id', 'submission_type_id.exact']) {
        const verdict = countVerdict('device/classification', expression);
        expect(verdict.kind, expression).toBe('none');
        if (verdict.kind !== 'none') return;
        expect(verdict.alternatives).not.toContain('submission_type_id');
        expect(verdict.alternatives).not.toContain('submission_type_id.exact');
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

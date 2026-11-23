/**
 * @fileoverview Static catalog of searchable openFDA field paths, grouped by endpoint.
 * Used by openfda_describe_fields (proactive discovery), the empty-result/error
 * notice enrichment in search tools (reactive guidance), and the openFDA service's
 * `count` error classification (via {@link countVerdict}). Also records the paths
 * that hold arrays of objects per endpoint ({@link OBJECT_ARRAY_PATHS}), and
 * which of them hold one entry per record ({@link SINGLE_ENTRY_ARRAYS}).
 * @module mcp-server/tools/field-catalog
 */

import { DEVICE_CLASSES, SUBMISSION_TYPES } from '@/mcp-server/tools/device-codes.js';
import {
  ADMINISTRATION_ROUTES,
  codeList,
  DECHALLENGE_OUTCOMES,
  DOSAGE_INTERVAL_UNITS,
  DOSE_UNITS,
  DRUG_ACTIONS,
  EXPEDITED_REPORT_FLAGS,
  ONSET_AGE_UNITS,
  PATIENT_AGE_GROUPS,
  REACTION_OUTCOMES,
  RECHALLENGE_OUTCOMES,
  REPORT_TYPES,
  REPORTER_QUALIFICATIONS,
  TREATMENT_DURATION_UNITS,
} from '@/mcp-server/tools/drug-event-codes.js';

/** The label a catalog note quotes for one code; throws on a code the table lacks, like {@link codeList}. */
function deviceCode(codes: ReadonlyMap<string, string>, code: string): string {
  const label = codes.get(code);
  if (label === undefined) throw new Error(`No label for code ${code}`);
  return label;
}

/**
 * How openFDA aggregates a field in a `count` query, verified by probing
 * `count=<path>` and `count=<path>.exact` against the live API:
 *
 * - `bare` — the path itself counts; openFDA indexes it as a keyword, and
 *   `.exact` answers `Nothing to count`.
 * - `exact` — only `<path>.exact` counts; the bare path is analyzed text and
 *   answers a 5xx `illegal_argument_exception`.
 * - `both` — either expression counts, with the same terms.
 * - `none` — neither counts: analyzed text with no keyword subfield.
 *
 * openFDA's published `fields.yaml` cannot derive this — its `is_exact: false`
 * string fields split between `bare` and `none` — so an entry's value comes from
 * a probe, and a remapped index needs a re-probe.
 */
export type Countable = 'bare' | 'exact' | 'both' | 'none';

/** A single searchable field entry. */
export interface FieldEntry {
  /** How the field aggregates in openfda_count_values. */
  countable: Countable;
  /** One-line description of what this field contains. */
  note: string;
  /** Dotted field path as used in openFDA search queries. */
  path: string;
  /** Data type reported by openFDA. */
  type: 'string' | 'date' | 'integer' | 'float' | 'boolean';
}

/** A named group of related fields within an endpoint. */
export interface FieldGroup {
  fields: FieldEntry[];
  /** Human-readable group label. */
  label: string;
}

/** Per-endpoint field catalog — keyed by the full endpoint path (e.g. "drug/event"). */
const FIELD_CATALOG: Record<string, FieldGroup[]> = {
  'drug/event': [
    {
      label: 'Report metadata',
      fields: [
        { path: 'safetyreportid', type: 'string', countable: 'exact', note: 'FDA report ID' },
        {
          path: 'receivedate',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA received the report (YYYYMMDD)',
        },
        {
          path: 'serious',
          type: 'string',
          countable: 'bare',
          note: '1 = serious, 2 = non-serious',
        },
        {
          path: 'primarysource.reportercountry',
          type: 'string',
          countable: 'exact',
          note: 'Country of the reporter',
        },
      ],
    },
    {
      label: 'Patient',
      fields: [
        {
          path: 'patient.patientsex',
          type: 'string',
          countable: 'bare',
          note: '0 = unknown, 1 = male, 2 = female',
        },
        {
          path: 'patient.patientagegroup',
          type: 'string',
          countable: 'bare',
          note: `Age group code: ${codeList(PATIENT_AGE_GROUPS)}`,
        },
        { path: 'patient.patientweight', type: 'float', countable: 'bare', note: 'Weight in kg' },
        {
          path: 'patient.patientonsetageunit',
          type: 'string',
          countable: 'none',
          note: `Unit of patient.patientonsetage: ${codeList(ONSET_AGE_UNITS)}`,
        },
      ],
    },
    {
      label: 'Reactions',
      fields: [
        {
          path: 'patient.reaction.reactionmeddrapt',
          type: 'string',
          countable: 'exact',
          note: 'MedDRA preferred term for the adverse reaction',
        },
        {
          path: 'patient.reaction.reactionoutcome',
          type: 'string',
          countable: 'bare',
          note: `Outcome code: ${codeList(REACTION_OUTCOMES)}`,
        },
      ],
    },
    {
      label: 'Drugs',
      fields: [
        {
          path: 'patient.drug.medicinalproduct',
          type: 'string',
          countable: 'exact',
          note: 'Drug name as reported (use .exact for phrase matching)',
        },
        {
          path: 'patient.drug.drugcharacterization',
          type: 'string',
          countable: 'bare',
          note: '1 = suspect, 2 = concomitant, 3 = interacting',
        },
        {
          path: 'patient.drug.drugindication',
          type: 'string',
          countable: 'exact',
          note: 'Indication for use',
        },
        {
          path: 'patient.drug.drugadministrationroute',
          type: 'string',
          countable: 'exact',
          note: `Route of administration as a 3-digit code, not a name ("ORAL" matches nothing) — e.g. ${codeList(ADMINISTRATION_ROUTES, ['048', '058', '042', '061', '030', '065'])}`,
        },
        {
          path: 'patient.drug.openfda.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'OpenFDA brand name',
        },
        {
          path: 'patient.drug.openfda.generic_name',
          type: 'string',
          countable: 'exact',
          note: 'OpenFDA generic name',
        },
        {
          path: 'patient.drug.openfda.manufacturer_name',
          type: 'string',
          countable: 'exact',
          note: 'OpenFDA manufacturer',
        },
        {
          path: 'patient.drug.actiondrug',
          type: 'string',
          countable: 'bare',
          note: `Action taken with the drug: ${codeList(DRUG_ACTIONS)}`,
        },
        {
          path: 'patient.drug.drugadditional',
          type: 'string',
          countable: 'bare',
          note: `Dechallenge — did the reaction abate once the drug was stopped or reduced: ${codeList(DECHALLENGE_OUTCOMES)}; openFDA also stores 4, which FDA's field reference leaves undefined`,
        },
        {
          path: 'patient.drug.drugrecurreadministration',
          type: 'string',
          countable: 'bare',
          note: `Rechallenge — did the reaction recur when the drug was given again: ${codeList(RECHALLENGE_OUTCOMES)}`,
        },
        {
          path: 'patient.drug.drugtreatmentdurationunit',
          type: 'string',
          countable: 'none',
          note: `Unit of patient.drug.drugtreatmentduration: ${codeList(TREATMENT_DURATION_UNITS)}`,
        },
        {
          path: 'patient.drug.drugintervaldosagedefinition',
          type: 'string',
          countable: 'bare',
          note: `Unit of patient.drug.drugintervaldosageunitnumb: ${codeList(DOSAGE_INTERVAL_UNITS)}; openFDA also stores 807, which FDA's field reference labels trimester like 811`,
        },
        {
          path: 'patient.drug.drugstructuredosageunit',
          type: 'string',
          countable: 'none',
          note: `Unit of patient.drug.drugstructuredosagenumb: ${codeList(DOSE_UNITS)}; openFDA also stores codes 005 and above, which FDA's field reference leaves unlabelled`,
        },
        {
          path: 'patient.drug.drugcumulativedosageunit',
          type: 'string',
          countable: 'none',
          note: `Unit of patient.drug.drugcumulativedosagenumb: ${codeList(DOSE_UNITS)}; openFDA also stores codes 005 and above, which FDA's field reference leaves unlabelled`,
        },
      ],
    },
    {
      label: 'Report source',
      fields: [
        {
          path: 'reporttype',
          type: 'string',
          countable: 'bare',
          note: `Circumstances of the report: ${codeList(REPORT_TYPES)}`,
        },
        {
          path: 'primarysource.qualification',
          type: 'string',
          countable: 'bare',
          note: `Who submitted the report: ${codeList(REPORTER_QUALIFICATIONS)}`,
        },
        {
          path: 'fulfillexpeditecriteria',
          type: 'string',
          countable: 'bare',
          note: `Expedited (15-day) report: ${codeList(EXPEDITED_REPORT_FLAGS)}; openFDA also stores 3, 4, and 5, which FDA's field reference leaves undefined`,
        },
      ],
    },
  ],

  'drug/label': [
    {
      label: 'OpenFDA identifiers',
      fields: [
        { path: 'openfda.brand_name', type: 'string', countable: 'exact', note: 'Brand name' },
        { path: 'openfda.generic_name', type: 'string', countable: 'exact', note: 'Generic name' },
        {
          path: 'openfda.manufacturer_name',
          type: 'string',
          countable: 'exact',
          note: 'Manufacturer',
        },
        {
          path: 'openfda.product_type',
          type: 'string',
          countable: 'exact',
          note: 'Product type (e.g. "HUMAN OTC DRUG", "HUMAN PRESCRIPTION DRUG")',
        },
        {
          path: 'openfda.route',
          type: 'string',
          countable: 'exact',
          note: 'Route of administration',
        },
        {
          path: 'openfda.application_number',
          type: 'string',
          countable: 'exact',
          note: 'NDA, ANDA, or BLA number, or an OTC monograph ID (e.g. "M020")',
        },
        {
          path: 'openfda.is_original_packager',
          type: 'boolean',
          countable: 'both',
          note: "Set true on the original packager's label (filter with openfda.is_original_packager:true); absent on repackagers' copies and on labels with an empty openfda block, never stored false",
        },
      ],
    },
    {
      label: 'Label sections',
      fields: [
        {
          path: 'indications_and_usage',
          type: 'string',
          countable: 'none',
          note: 'Full text of indications section',
        },
        { path: 'warnings', type: 'string', countable: 'none', note: 'Warnings section text' },
        {
          path: 'dosage_and_administration',
          type: 'string',
          countable: 'none',
          note: 'Dosage and administration text',
        },
        {
          path: 'contraindications',
          type: 'string',
          countable: 'none',
          note: 'Contraindications text',
        },
        {
          path: 'adverse_reactions',
          type: 'string',
          countable: 'none',
          note: 'Adverse reactions section text',
        },
        {
          path: 'active_ingredient',
          type: 'string',
          countable: 'none',
          note: 'Active ingredient names/strengths',
        },
        {
          path: 'spl_product_data_elements',
          type: 'string',
          countable: 'none',
          note: "The label's own product text (product names and ingredients); search it when an openfda.* field finds nothing, since openFDA fills the openfda block only on labels it linked to a product",
        },
      ],
    },
    {
      label: 'Metadata',
      fields: [
        {
          path: 'set_id',
          type: 'string',
          countable: 'bare',
          note: 'SPL set ID, one per product label; openFDA holds its current revision only',
        },
        {
          path: 'effective_time',
          type: 'date',
          countable: 'bare',
          note: 'Label effective date (YYYYMMDD) — sort by this for most recent',
        },
      ],
    },
  ],

  'drug/enforcement': [
    {
      label: 'Recall identification',
      fields: [
        { path: 'recall_number', type: 'string', countable: 'exact', note: 'FDA recall number' },
        {
          path: 'classification',
          type: 'string',
          countable: 'exact',
          note: 'Hazard class: "Class I", "Class II", "Class III"',
        },
        {
          path: 'status',
          type: 'string',
          countable: 'exact',
          note: 'Recall status (e.g. Ongoing, Completed)',
        },
        {
          path: 'voluntary_mandated',
          type: 'string',
          countable: 'exact',
          note: 'Voluntary or FDA mandated',
        },
      ],
    },
    {
      label: 'Firm and product',
      fields: [
        {
          path: 'recalling_firm',
          type: 'string',
          countable: 'exact',
          note: 'Firm conducting the recall',
        },
        {
          path: 'product_description',
          type: 'string',
          countable: 'none',
          note: 'Description of recalled product',
        },
        {
          path: 'reason_for_recall',
          type: 'string',
          countable: 'none',
          note: 'Reason stated for the recall',
        },
        {
          path: 'product_type',
          type: 'string',
          countable: 'exact',
          note: 'Product type — always "Drugs" on this endpoint',
        },
        {
          path: 'distribution_pattern',
          type: 'string',
          countable: 'none',
          note: 'Geographic scope of distribution',
        },
      ],
    },
    {
      label: 'Dates',
      fields: [
        { path: 'report_date', type: 'date', countable: 'bare', note: 'Report date (YYYYMMDD)' },
        {
          path: 'recall_initiation_date',
          type: 'date',
          countable: 'bare',
          note: 'When recall was initiated',
        },
      ],
    },
  ],

  'drug/ndc': [
    {
      label: 'Product identification',
      fields: [
        {
          path: 'product_ndc',
          type: 'string',
          countable: 'bare',
          note: 'Two-segment labeler-product code (e.g. "0363-0218"), not the package NDC',
        },
        { path: 'brand_name', type: 'string', countable: 'exact', note: 'Brand name' },
        { path: 'generic_name', type: 'string', countable: 'exact', note: 'Generic name' },
        {
          path: 'labeler_name',
          type: 'string',
          countable: 'exact',
          note: 'Labeler/manufacturer name',
        },
        {
          path: 'dosage_form',
          type: 'string',
          countable: 'exact',
          note: 'Dosage form (e.g. TABLET, CAPSULE)',
        },
        { path: 'route', type: 'string', countable: 'exact', note: 'Route of administration' },
        {
          path: 'marketing_category',
          type: 'string',
          countable: 'bare',
          note: 'Marketing category (e.g. "ANDA", "NDA", "BLA", "OTC MONOGRAPH DRUG", "NDA AUTHORIZED GENERIC", "UNAPPROVED HOMEOPATHIC")',
        },
      ],
    },
    {
      label: 'Ingredients',
      fields: [
        {
          path: 'active_ingredients.name',
          type: 'string',
          countable: 'exact',
          note: 'Active ingredient name',
        },
        {
          path: 'active_ingredients.strength',
          type: 'string',
          countable: 'bare',
          note: 'Active ingredient strength',
        },
      ],
    },
    {
      label: 'OpenFDA cross-references',
      fields: [
        {
          path: 'openfda.manufacturer_name',
          type: 'string',
          countable: 'exact',
          note: 'Manufacturer name',
        },
        { path: 'openfda.rxcui', type: 'string', countable: 'exact', note: 'RxCUI identifier' },
        { path: 'openfda.upc', type: 'string', countable: 'exact', note: 'UPC barcode' },
      ],
    },
  ],

  'drug/drugsfda': [
    {
      label: 'Application',
      fields: [
        {
          path: 'application_number',
          type: 'string',
          countable: 'bare',
          note: 'Application number (e.g. NDA012345, ANDA000001)',
        },
        {
          path: 'sponsor_name',
          type: 'string',
          countable: 'bare',
          note: 'Sponsor/applicant name, stored uppercase — a quoted value must match (sponsor_name:"PFIZER"; "pfizer" matches nothing)',
        },
      ],
    },
    {
      label: 'Products',
      fields: [
        {
          path: 'products.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'Brand name of each product in the application (e.g. "ELIQUIS"), matched in any letter case; set on nearly every application, including those without an openfda block',
        },
      ],
    },
    {
      label: 'Submissions',
      fields: [
        {
          path: 'submissions.submission_type',
          type: 'string',
          countable: 'bare',
          note: 'Submission type (ORIG, SUPPL)',
        },
        {
          path: 'submissions.submission_status',
          type: 'string',
          countable: 'bare',
          note: 'Submission status (AP = approved)',
        },
        {
          path: 'submissions.submission_status_date',
          type: 'date',
          countable: 'bare',
          note: 'Status date (YYYYMMDD)',
        },
        {
          path: 'submissions.submission_class_code',
          type: 'string',
          countable: 'bare',
          note: 'Submission class: "TYPE 1" (new molecular entity; "TYPE 1/4" is a separate value) through "TYPE 10", or a supplement class such as "LABELING", "EFFICACY", "MANUF (CMC)"',
        },
        {
          path: 'submissions.review_priority',
          type: 'string',
          countable: 'bare',
          note: 'Review priority: "STANDARD", "PRIORITY", "UNKNOWN", "N/A", "901 REQUIRED", or "901 ORDER"',
        },
      ],
    },
    {
      label: 'OpenFDA identifiers',
      fields: [
        {
          path: 'openfda.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'Brand name, on harmonized applications only — search products.brand_name to reach the rest',
        },
        { path: 'openfda.generic_name', type: 'string', countable: 'exact', note: 'Generic name' },
        { path: 'openfda.product_type', type: 'string', countable: 'exact', note: 'Product type' },
        {
          path: 'openfda.route',
          type: 'string',
          countable: 'exact',
          note: 'Route of administration',
        },
        {
          path: 'openfda.substance_name',
          type: 'string',
          countable: 'exact',
          note: 'Substance name',
        },
      ],
    },
  ],

  'drug/orangebook': [
    {
      label: 'Application',
      fields: [
        {
          path: 'products.application_number',
          type: 'string',
          countable: 'bare',
          note: 'Application number, six digits with no prefix (e.g. "202155", which Drugs@FDA writes NDA202155); pair it with products.application_type',
        },
        {
          path: 'products.application_type',
          type: 'string',
          countable: 'bare',
          note: 'Application type: "N" (NDA) or "A" (ANDA)',
        },
        {
          path: 'products.application_name',
          type: 'string',
          countable: 'exact',
          note: 'Applicant (e.g. "BRISTOL MYERS SQUIBB")',
        },
      ],
    },
    {
      label: 'Product',
      fields: [
        {
          path: 'product_number',
          type: 'string',
          countable: 'bare',
          note: 'Product number within the application (e.g. "001"); each strength is its own product record',
        },
        {
          path: 'products.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'Brand name (e.g. "ELIQUIS")',
        },
        {
          path: 'approval_date',
          type: 'date',
          countable: 'bare',
          note: 'Product approval date (YYYYMMDD)',
        },
        {
          path: 'approved_prior_to_1982',
          type: 'boolean',
          countable: 'bare',
          note: 'Set true on a product approved before 1982, which carries no approval_date (approved_prior_to_1982:true); absent otherwise',
        },
        {
          path: 'products.marketing_status',
          type: 'string',
          countable: 'exact',
          note: 'Marketing status (e.g. "HUMAN PRESCRIPTION DRUG", "HUMAN OTC DRUG", "DISCONTINUED")',
        },
        {
          path: 'products.dosage_form',
          type: 'string',
          countable: 'exact',
          note: 'Dosage form (e.g. "TABLET")',
        },
        {
          path: 'products.route',
          type: 'string',
          countable: 'exact',
          note: 'Route of administration (e.g. "ORAL")',
        },
        {
          path: 'products.therapeutic_equivalence_codes',
          type: 'string',
          countable: 'bare',
          note: 'Therapeutic equivalence codes (e.g. "AB"), on rated products only',
        },
        {
          path: 'products.reference_listed_drug',
          type: 'boolean',
          countable: 'bare',
          note: 'Whether the product is a reference listed drug (true or false)',
        },
        {
          path: 'products.reference_standard',
          type: 'boolean',
          countable: 'bare',
          note: 'Whether FDA selected the product as the reference standard for ANDA bioequivalence studies (true or false)',
        },
      ],
    },
    {
      label: 'Active ingredients',
      fields: [
        {
          path: 'products.active_ingredients.name',
          type: 'string',
          countable: 'exact',
          note: 'Active ingredient name (e.g. "APIXABAN")',
        },
        {
          path: 'products.active_ingredients.strength',
          type: 'string',
          countable: 'bare',
          note: 'Active ingredient strength (e.g. "5MG")',
        },
      ],
    },
    {
      label: 'Patents',
      fields: [
        {
          path: 'patents.patent_number',
          type: 'string',
          countable: 'bare',
          note: 'Patent number (e.g. "6967208"); a "*PED" suffix marks its pediatric exclusivity extension',
        },
        {
          path: 'patents.expiration_date',
          type: 'date',
          countable: 'bare',
          note: 'Patent expiration date with extensions (YYYYMMDD)',
        },
        {
          path: 'patents.patent_use_code',
          type: 'string',
          countable: 'bare',
          note: 'Method-of-use code (e.g. "U-1729")',
        },
        {
          path: 'patents.patent_submission_date',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA received the patent information (YYYYMMDD); not every patent entry carries one',
        },
        {
          path: 'patents.drug_substance_flag',
          type: 'boolean',
          countable: 'bare',
          note: 'Set true when the patent claims the drug substance; absent otherwise',
        },
        {
          path: 'patents.drug_product_flag',
          type: 'boolean',
          countable: 'bare',
          note: 'Set true when the patent claims the drug product; absent otherwise',
        },
      ],
    },
    {
      label: 'Exclusivity',
      fields: [
        {
          path: 'exclusivity.exclusivity_code',
          type: 'string',
          countable: 'bare',
          note: 'Exclusivity code (e.g. "NCE", "PED", "NPP")',
        },
        {
          path: 'exclusivity.exclusivity_expiration_date',
          type: 'date',
          countable: 'bare',
          note: 'Exclusivity expiration date (YYYYMMDD)',
        },
      ],
    },
  ],

  'drug/shortages': [
    {
      label: 'Drug identification',
      fields: [
        {
          path: 'generic_name',
          type: 'string',
          countable: 'exact',
          note: 'Generic name of the drug in shortage',
        },
        {
          path: 'status',
          type: 'string',
          countable: 'bare',
          note: 'Shortage status: "Current", "To Be Discontinued", or "Resolved"',
        },
        {
          path: 'therapeutic_category',
          type: 'string',
          countable: 'bare',
          note: 'Therapeutic category (e.g. "Oncology")',
        },
        {
          path: 'dosage_form',
          type: 'string',
          countable: 'exact',
          note: 'Dosage form (e.g. "Injection")',
        },
        {
          path: 'company_name',
          type: 'string',
          countable: 'exact',
          note: 'Manufacturer or distributor name',
        },
      ],
    },
    {
      label: 'Product details',
      fields: [
        {
          path: 'presentation',
          type: 'string',
          countable: 'exact',
          note: 'Presentation/package description',
        },
        {
          path: 'package_ndc',
          type: 'string',
          countable: 'bare',
          note: 'NDC code for the package',
        },
        {
          path: 'availability',
          type: 'string',
          countable: 'bare',
          note: 'Current availability: "Available", "Limited Availability", or "Unavailable"',
        },
        {
          path: 'update_type',
          type: 'string',
          countable: 'bare',
          note: 'Type of the most recent update',
        },
      ],
    },
    {
      label: 'Dates',
      fields: [
        {
          path: 'initial_posting_date',
          type: 'date',
          countable: 'bare',
          note: 'Date the shortage was first posted — stored MM/DD/YYYY, queried as YYYY-MM-DD (e.g. [2026-01-01 TO 2026-12-31]); a YYYYMMDD, M/D/YYYY, or YYYY-M-D date is rewritten to that form',
        },
        {
          path: 'update_date',
          type: 'date',
          countable: 'bare',
          note: 'Date of the last update — stored MM/DD/YYYY, queried as YYYY-MM-DD (e.g. [2026-01-01 TO 2026-12-31]); a YYYYMMDD, M/D/YYYY, or YYYY-M-D date is rewritten to that form',
        },
        {
          path: 'discontinued_date',
          type: 'date',
          countable: 'bare',
          note: 'Date the presentation was discontinued — stored MM/DD/YYYY, queried as YYYY-MM-DD (e.g. [2026-01-01 TO 2026-12-31]); a YYYYMMDD, M/D/YYYY, or YYYY-M-D date is rewritten to that form',
        },
        {
          path: 'change_date',
          type: 'date',
          countable: 'bare',
          note: 'Date of the last change to the presentation — stored MM/DD/YYYY, queried as YYYY-MM-DD (e.g. [2026-01-01 TO 2026-12-31]); a YYYYMMDD, M/D/YYYY, or YYYY-M-D date is rewritten to that form',
        },
      ],
    },
    {
      label: 'OpenFDA cross-references',
      fields: [
        {
          path: 'openfda.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'OpenFDA brand name',
        },
        {
          path: 'openfda.product_ndc',
          type: 'string',
          countable: 'exact',
          note: 'OpenFDA product NDC',
        },
        { path: 'openfda.rxcui', type: 'string', countable: 'exact', note: 'RxCUI identifier' },
        {
          path: 'openfda.spl_set_id',
          type: 'string',
          countable: 'exact',
          note: 'SPL set ID for label cross-linking',
        },
      ],
    },
  ],

  'food/event': [
    {
      label: 'Report',
      fields: [
        { path: 'report_number', type: 'string', countable: 'none', note: 'Report ID' },
        {
          path: 'date_created',
          type: 'date',
          countable: 'bare',
          note: 'Date report was created (YYYYMMDD)',
        },
        {
          path: 'date_started',
          type: 'date',
          countable: 'bare',
          note: 'Date event started (YYYYMMDD)',
        },
      ],
    },
    {
      label: 'Products and reactions',
      fields: [
        {
          path: 'products.name_brand',
          type: 'string',
          countable: 'exact',
          note: 'Brand name of the product',
        },
        {
          path: 'products.industry_name',
          type: 'string',
          countable: 'exact',
          note: 'Industry category name',
        },
        {
          path: 'products.industry_code',
          type: 'string',
          countable: 'none',
          note: 'Industry code',
        },
        {
          path: 'products.role',
          type: 'string',
          countable: 'exact',
          note: 'Product role in the event',
        },
        {
          path: 'reactions',
          type: 'string',
          countable: 'exact',
          note: 'Reported reactions — an array of MedDRA terms (e.g. "DIARRHOEA"), not comma-separated text',
        },
        { path: 'outcomes', type: 'string', countable: 'exact', note: 'Medical outcomes' },
      ],
    },
    {
      label: 'Consumer',
      fields: [
        { path: 'consumer.gender', type: 'string', countable: 'bare', note: 'Consumer gender' },
        {
          path: 'consumer.age',
          type: 'string',
          countable: 'bare',
          note: 'Consumer age as a numeric string (unit in consumer.age_unit)',
        },
        {
          path: 'consumer.age_unit',
          type: 'string',
          countable: 'bare',
          note: 'Age unit (e.g. "year(s)")',
        },
      ],
    },
  ],

  'food/enforcement': [
    {
      label: 'Recall identification',
      fields: [
        { path: 'recall_number', type: 'string', countable: 'exact', note: 'FDA recall number' },
        {
          path: 'classification',
          type: 'string',
          countable: 'exact',
          note: 'Hazard class: "Class I", "Class II", "Class III"',
        },
        { path: 'status', type: 'string', countable: 'exact', note: 'Recall status' },
        {
          path: 'voluntary_mandated',
          type: 'string',
          countable: 'exact',
          note: 'Voluntary or FDA mandated',
        },
      ],
    },
    {
      label: 'Firm and product',
      fields: [
        {
          path: 'recalling_firm',
          type: 'string',
          countable: 'exact',
          note: 'Firm conducting the recall',
        },
        {
          path: 'product_description',
          type: 'string',
          countable: 'none',
          note: 'Recalled product description',
        },
        { path: 'reason_for_recall', type: 'string', countable: 'none', note: 'Reason for recall' },
        {
          path: 'distribution_pattern',
          type: 'string',
          countable: 'none',
          note: 'Geographic distribution scope',
        },
        { path: 'product_type', type: 'string', countable: 'exact', note: 'Product type' },
      ],
    },
    {
      label: 'Dates',
      fields: [
        { path: 'report_date', type: 'date', countable: 'bare', note: 'Report date (YYYYMMDD)' },
        {
          path: 'recall_initiation_date',
          type: 'date',
          countable: 'bare',
          note: 'Recall initiation date',
        },
      ],
    },
  ],

  'cosmetic/event': [
    {
      label: 'Report',
      fields: [
        {
          path: 'report_number',
          type: 'string',
          countable: 'bare',
          note: 'Report ID, unique per report',
        },
        {
          path: 'initial_received_date',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA first received the report (YYYYMMDD)',
        },
        {
          path: 'latest_received_date',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA received the latest version of the report (YYYYMMDD)',
        },
        {
          path: 'event_date',
          type: 'string',
          countable: 'bare',
          note: 'Event start date as free text, not a date ("08-Jul-14", "01-Apr", "2015"): search a written value (event_date:"2015"); a YYYYMMDD range matches nothing',
        },
      ],
    },
    {
      label: 'Products and reactions',
      fields: [
        {
          path: 'products.product_name',
          type: 'string',
          countable: 'exact',
          note: 'Product name as reported (e.g. "J And J Baby Powder")',
        },
        {
          path: 'products.role',
          type: 'string',
          countable: 'bare',
          note: 'Product role: "Suspect" or "Concomitant"',
        },
        {
          path: 'reactions',
          type: 'string',
          countable: 'exact',
          note: 'Reported reactions — an array of MedDRA terms (e.g. "Ovarian Cancer")',
        },
        {
          path: 'outcomes',
          type: 'string',
          countable: 'exact',
          note: 'Outcomes (e.g. "Death", "Hospitalization", "Other Serious or Important Medical Event")',
        },
      ],
    },
    {
      label: 'Report details',
      fields: [
        {
          path: 'report_type',
          type: 'string',
          countable: 'bare',
          note: 'Report type (e.g. "Pre-MoCRA", "Expedited (15-Day)", "Direct")',
        },
        {
          path: 'report_version',
          type: 'string',
          countable: 'bare',
          note: 'Report version (e.g. "1")',
        },
        {
          path: 'legacy_report_id',
          type: 'string',
          countable: 'bare',
          note: 'CAERS number of the same report, its report_number on food/event (e.g. "2023-CFS-006510"); absent on some reports',
        },
        {
          path: 'meddra_version',
          type: 'string',
          countable: 'bare',
          note: 'MedDRA version of the reaction terms (e.g. "28")',
        },
      ],
    },
    {
      label: 'Patient',
      fields: [
        {
          path: 'patient.gender',
          type: 'string',
          countable: 'bare',
          note: 'Patient gender in stored case: "Female" or "Male" ("female" matches nothing)',
        },
        {
          path: 'patient.age',
          type: 'string',
          countable: 'bare',
          note: 'Patient age as a numeric string (unit in patient.age_unit)',
        },
        {
          path: 'patient.age_unit',
          type: 'string',
          countable: 'bare',
          note: 'Age unit (e.g. "Year(s)", "Month(s)", "Decade(s)")',
        },
      ],
    },
  ],

  'device/event': [
    {
      label: 'Report',
      fields: [
        { path: 'report_number', type: 'string', countable: 'exact', note: 'MDR report number' },
        { path: 'mdr_report_key', type: 'string', countable: 'exact', note: 'MDR database key' },
        {
          path: 'event_type',
          type: 'string',
          countable: 'exact',
          note: 'Event type (e.g. "Malfunction", "Injury", "Death")',
        },
        {
          path: 'date_of_event',
          type: 'date',
          countable: 'bare',
          note: 'Date the event occurred (YYYYMMDD)',
        },
        {
          path: 'date_received',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA received the report (YYYYMMDD)',
        },
        {
          path: 'source_type',
          type: 'string',
          countable: 'exact',
          note: 'Report source (e.g. "Health Professional", "Consumer", "User facility", "Company representation", "Distributor", "Foreign")',
        },
      ],
    },
    {
      label: 'Device',
      fields: [
        {
          path: 'device.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'Device brand name',
        },
        {
          path: 'device.generic_name',
          type: 'string',
          countable: 'exact',
          note: 'Device generic name',
        },
        {
          path: 'device.manufacturer_d_name',
          type: 'string',
          countable: 'exact',
          note: 'Device manufacturer name',
        },
        {
          path: 'device.openfda.device_class',
          type: 'string',
          countable: 'bare',
          note: 'FDA device class: "1", "2", "3", "U" (unclassified), "N" (not classified), or "f" (HDE; indexed lowercase, so "F" matches nothing)',
        },
        {
          path: 'device.device_report_product_code',
          type: 'string',
          countable: 'exact',
          note: 'FDA product code (3-letter) reported for the device',
        },
        {
          path: 'device.model_number',
          type: 'string',
          countable: 'exact',
          note: 'Device model number',
        },
      ],
    },
    {
      label: 'Patient',
      fields: [
        {
          path: 'patient.sequence_number_outcome',
          type: 'string',
          countable: 'both',
          note: 'Patient outcome code',
        },
        {
          path: 'patient.patient_problems',
          type: 'string',
          countable: 'exact',
          note: 'Patient problems reported',
        },
      ],
    },
  ],

  'device/510k': [
    {
      label: 'Clearance',
      fields: [
        {
          path: 'k_number',
          type: 'string',
          countable: 'exact',
          note: '510(k) number (e.g. K123456)',
        },
        {
          path: 'decision_code',
          type: 'string',
          countable: 'exact',
          note: 'Decision code (SESE = substantial equivalence)',
        },
        {
          path: 'decision_date',
          type: 'date',
          countable: 'bare',
          note: 'Decision date — stored YYYY-MM-DD; query as YYYYMMDD (e.g. [20200101 TO 20201231])',
        },
        {
          path: 'clearance_type',
          type: 'string',
          countable: 'exact',
          note: 'Clearance type (Traditional, Special, Abbreviated)',
        },
      ],
    },
    {
      label: 'Device and applicant',
      fields: [
        {
          path: 'applicant',
          type: 'string',
          countable: 'exact',
          note: 'Company name submitting the 510(k)',
        },
        {
          path: 'device_name',
          type: 'string',
          countable: 'exact',
          note: 'Device name as submitted',
        },
        {
          path: 'product_code',
          type: 'string',
          countable: 'bare',
          note: 'FDA 3-letter product code',
        },
        {
          path: 'advisory_committee_description',
          type: 'string',
          countable: 'both',
          note: 'Review panel (e.g. "Cardiovascular")',
        },
        {
          path: 'openfda.device_name',
          type: 'string',
          countable: 'exact',
          note: 'OpenFDA normalized device name',
        },
      ],
    },
  ],

  'device/pma': [
    {
      label: 'Approval',
      fields: [
        { path: 'pma_number', type: 'string', countable: 'bare', note: 'PMA number' },
        {
          path: 'decision_date',
          type: 'date',
          countable: 'bare',
          note: 'Decision date — stored YYYY-MM-DD; query as YYYYMMDD (e.g. [20200101 TO 20201231])',
        },
        { path: 'decision_code', type: 'string', countable: 'bare', note: 'Decision code' },
      ],
    },
    {
      label: 'Device and applicant',
      fields: [
        { path: 'applicant', type: 'string', countable: 'exact', note: 'Applicant company name' },
        {
          path: 'product_code',
          type: 'string',
          countable: 'bare',
          note: 'FDA 3-letter product code',
        },
        {
          path: 'advisory_committee',
          type: 'string',
          countable: 'bare',
          note: 'Review advisory committee code',
        },
      ],
    },
  ],

  'device/recall': [
    {
      label: 'Recall',
      fields: [
        {
          path: 'product_res_number',
          type: 'string',
          countable: 'exact',
          note: 'FDA product recall number (e.g. "Z-0001-04")',
        },
        {
          path: 'res_event_number',
          type: 'string',
          countable: 'bare',
          note: 'FDA recall event number',
        },
        {
          path: 'recall_status',
          type: 'string',
          countable: 'bare',
          note: 'Recall status (e.g. "Terminated", "Open, Classified", "Completed")',
        },
        {
          path: 'openfda.device_class',
          type: 'string',
          countable: 'bare',
          note: 'Device class of the recalled product: "1", "2", "3", "U" (unclassified), "N" (not classified), or "f" (HDE; indexed lowercase, so "F" matches nothing). The recall hazard class is on device/enforcement',
        },
      ],
    },
    {
      label: 'Firm and device',
      fields: [
        {
          path: 'recalling_firm',
          type: 'string',
          countable: 'exact',
          note: 'Firm conducting the recall',
        },
        {
          path: 'product_description',
          type: 'string',
          countable: 'none',
          note: 'Product description',
        },
        { path: 'reason_for_recall', type: 'string', countable: 'none', note: 'Reason for recall' },
        {
          path: 'root_cause_description',
          type: 'string',
          countable: 'exact',
          note: 'Root cause category description',
        },
      ],
    },
    {
      label: 'Dates',
      fields: [
        {
          path: 'event_date_initiated',
          type: 'date',
          countable: 'bare',
          note: 'Date the firm initiated the recall — stored YYYY-MM-DD; query as YYYYMMDD (e.g. [20240101 TO 20241231]); the default newest-first sort',
        },
      ],
    },
  ],

  'device/enforcement': [
    {
      label: 'Recall identification',
      fields: [
        { path: 'recall_number', type: 'string', countable: 'exact', note: 'FDA recall number' },
        {
          path: 'classification',
          type: 'string',
          countable: 'exact',
          note: 'Hazard class I, II, or III',
        },
        { path: 'status', type: 'string', countable: 'exact', note: 'Recall status' },
        {
          path: 'voluntary_mandated',
          type: 'string',
          countable: 'exact',
          note: 'Voluntary or FDA mandated',
        },
      ],
    },
    {
      label: 'Firm and product',
      fields: [
        {
          path: 'recalling_firm',
          type: 'string',
          countable: 'exact',
          note: 'Firm conducting the recall',
        },
        {
          path: 'product_description',
          type: 'string',
          countable: 'none',
          note: 'Product description',
        },
        { path: 'reason_for_recall', type: 'string', countable: 'none', note: 'Reason for recall' },
        {
          path: 'distribution_pattern',
          type: 'string',
          countable: 'none',
          note: 'Geographic distribution',
        },
      ],
    },
    {
      label: 'Dates',
      fields: [
        { path: 'report_date', type: 'date', countable: 'bare', note: 'Report date (YYYYMMDD)' },
        {
          path: 'recall_initiation_date',
          type: 'date',
          countable: 'bare',
          note: 'Recall initiation date',
        },
      ],
    },
  ],

  'device/classification': [
    {
      label: 'Classification',
      fields: [
        {
          path: 'product_code',
          type: 'string',
          countable: 'none',
          note: 'FDA 3-letter product code (e.g. "LWP")',
        },
        {
          path: 'device_name',
          type: 'string',
          countable: 'exact',
          note: 'Classification device name',
        },
        {
          path: 'device_class',
          type: 'string',
          countable: 'none',
          note: `Device class: "1", "2", "3", "U" (${deviceCode(DEVICE_CLASSES, 'U')}), "N" (${deviceCode(DEVICE_CLASSES, 'N')}), or "f" (${deviceCode(DEVICE_CLASSES, 'f')}, stored lowercase; "F" matches too)`,
        },
        {
          path: 'regulation_number',
          type: 'string',
          countable: 'exact',
          note: 'CFR regulation number (e.g. "878.4800")',
        },
        {
          path: 'submission_type_id',
          type: 'string',
          countable: 'none',
          note: `Premarket path the code is limited to: ${[...SUBMISSION_TYPES].map(([code, label]) => `"${code}" = ${label}`).join(', ')}; also stores 6, 7, 8, and empty`,
        },
        {
          path: 'medical_specialty_description',
          type: 'string',
          countable: 'exact',
          note: 'Review panel / medical specialty (e.g. "General, Plastic Surgery")',
        },
        {
          path: 'medical_specialty',
          type: 'string',
          countable: 'none',
          note: 'Two-letter code of the regulation medical specialty (e.g. "OR"), empty where regulation_number is; medical_specialty_description names it',
        },
        {
          path: 'review_panel',
          type: 'string',
          countable: 'none',
          note: 'Two-letter 510(k) review panel code (e.g. "CH"), as advisory_committee on 510(k) records; can differ from medical_specialty',
        },
        {
          path: 'definition',
          type: 'string',
          countable: 'none',
          note: 'Definition of the device type, empty on most codes',
        },
        {
          path: 'unclassified_reason',
          type: 'string',
          countable: 'none',
          note: 'Why a "U" (unclassified) or "N" (not classified) code has no class: "1" = pre-amendment, "3" = for export only, "4" = unknown, "6" = enforcement discretion; also stores 9 and 11; empty on classified codes',
        },
      ],
    },
    {
      label: 'Regulatory flags',
      fields: [
        {
          path: 'implant_flag',
          type: 'string',
          countable: 'none',
          note: '"Y" if the device is an implant',
        },
        {
          path: 'life_sustain_support_flag',
          type: 'string',
          countable: 'none',
          note: '"Y" if life-sustaining or life-supporting',
        },
        {
          path: 'gmp_exempt_flag',
          type: 'string',
          countable: 'none',
          note: '"Y" if exempt from Good Manufacturing Practice',
        },
        {
          path: 'third_party_flag',
          type: 'string',
          countable: 'none',
          note: '"Y" if eligible for third-party 510(k) review',
        },
        {
          path: 'summary_malfunction_reporting',
          type: 'string',
          countable: 'bare',
          note: 'Voluntary Malfunction Summary Reporting eligibility: "Eligible" or "Ineligible"',
        },
      ],
    },
    {
      label: 'OpenFDA cross-references',
      fields: [
        {
          path: 'openfda.k_number',
          type: 'string',
          countable: 'bare',
          note: '510(k) numbers mapped to this product code',
        },
        {
          path: 'openfda.registration_number',
          type: 'string',
          countable: 'bare',
          note: 'Registration numbers for this product code',
        },
        {
          path: 'openfda.fei_number',
          type: 'string',
          countable: 'bare',
          note: 'FDA Establishment Identifier numbers',
        },
        {
          path: 'openfda.pma_number',
          type: 'string',
          countable: 'bare',
          note: 'PMA numbers mapped to this product code (e.g. "P950037")',
        },
      ],
    },
  ],

  'device/registrationlisting': [
    {
      label: 'Establishment',
      fields: [
        {
          path: 'registration.registration_number',
          type: 'string',
          countable: 'bare',
          note: 'FDA establishment registration number',
        },
        {
          path: 'registration.fei_number',
          type: 'string',
          countable: 'bare',
          note: 'FDA Establishment Identifier (FEI)',
        },
        {
          path: 'registration.name',
          type: 'string',
          countable: 'exact',
          note: 'Registered establishment name',
        },
        {
          path: 'registration.iso_country_code',
          type: 'string',
          countable: 'bare',
          note: 'ISO country code of the establishment',
        },
        {
          path: 'establishment_type',
          type: 'string',
          countable: 'exact',
          note: 'Activity performed (e.g. "Manufacture Medical Device")',
        },
      ],
    },
    {
      label: 'Owner / operator',
      fields: [
        {
          path: 'registration.owner_operator.firm_name',
          type: 'string',
          countable: 'exact',
          note: 'Owner/operator firm name',
        },
        {
          path: 'registration.owner_operator.owner_operator_number',
          type: 'string',
          countable: 'bare',
          note: 'Owner/operator number',
        },
        {
          path: 'proprietary_name',
          type: 'string',
          countable: 'exact',
          note: 'Proprietary/brand names listed by the establishment',
        },
      ],
    },
    {
      label: 'Listed products',
      fields: [
        {
          path: 'products.product_code',
          type: 'string',
          countable: 'bare',
          note: 'FDA 3-letter product code of a listed device',
        },
        {
          path: 'products.openfda.device_name',
          type: 'string',
          countable: 'exact',
          note: 'Normalized device name of the listed product',
        },
        {
          path: 'products.openfda.device_class',
          type: 'string',
          countable: 'bare',
          note: 'Device class of the listed product: "1", "2", "3", "U" (unclassified), "N" (not classified), or "f" (HDE; indexed lowercase, so "F" matches nothing)',
        },
        {
          path: 'k_number',
          type: 'string',
          countable: 'none',
          note: '510(k) number, when the listed device was cleared via 510(k)',
        },
        {
          path: 'pma_number',
          type: 'string',
          countable: 'none',
          note: 'PMA number, when the listed device was approved via PMA',
        },
      ],
    },
  ],

  'device/udi': [
    {
      label: 'Device',
      fields: [
        { path: 'brand_name', type: 'string', countable: 'exact', note: 'Device brand/trade name' },
        { path: 'company_name', type: 'string', countable: 'exact', note: 'Labeler company name' },
        {
          path: 'catalog_number',
          type: 'string',
          countable: 'exact',
          note: 'Manufacturer catalog number',
        },
        {
          path: 'version_or_model_number',
          type: 'string',
          countable: 'exact',
          note: 'Version or model number',
        },
      ],
    },
    {
      label: 'Identifiers and classification',
      fields: [
        {
          path: 'identifiers.id',
          type: 'string',
          countable: 'bare',
          note: 'Device Identifier (DI) value',
        },
        {
          path: 'identifiers.issuing_agency',
          type: 'string',
          countable: 'exact',
          note: 'DI issuing agency (GS1, HIBCC, ICCBBA, NDC/NHRIC)',
        },
        {
          path: 'product_codes.code',
          type: 'string',
          countable: 'both',
          note: 'FDA 3-letter product code',
        },
        {
          path: 'product_codes.name',
          type: 'string',
          countable: 'none',
          note: 'Product code device name',
        },
        {
          path: 'product_codes.openfda.device_class',
          type: 'string',
          countable: 'bare',
          note: 'Device class: "1", "2", "3", "U" (unclassified), "N" (not classified), or "f" (HDE; indexed lowercase, so "F" matches nothing)',
        },
        {
          path: 'gmdn_terms.name',
          type: 'string',
          countable: 'exact',
          note: 'GMDN term name for the device type',
        },
      ],
    },
    {
      label: 'Status and flags',
      fields: [
        {
          path: 'commercial_distribution_status',
          type: 'string',
          countable: 'exact',
          note: '"In Commercial Distribution" or "Not in Commercial Distribution"',
        },
        {
          path: 'record_status',
          type: 'string',
          countable: 'bare',
          note: 'GUDID record status (e.g. "Published")',
        },
        { path: 'is_rx', type: 'string', countable: 'bare', note: '"true" if prescription use' },
        { path: 'is_otc', type: 'string', countable: 'bare', note: '"true" if over-the-counter' },
        {
          path: 'is_single_use',
          type: 'string',
          countable: 'bare',
          note: '"true" if labeled single-use',
        },
        {
          path: 'sterilization.is_sterile',
          type: 'string',
          countable: 'bare',
          note: '"true" if the device is sterile',
        },
      ],
    },
  ],

  'device/covid19serology': [
    {
      label: 'Test device',
      fields: [
        { path: 'device', type: 'string', countable: 'exact', note: 'Serology test device name' },
        { path: 'manufacturer', type: 'string', countable: 'exact', note: 'Test manufacturer' },
        {
          path: 'type',
          type: 'string',
          countable: 'bare',
          note: 'Sample type (e.g. "Serum", "Plasma")',
        },
        { path: 'lot_number', type: 'string', countable: 'bare', note: 'Test lot number' },
      ],
    },
    {
      label: 'Evaluation',
      fields: [
        {
          path: 'panel',
          type: 'string',
          countable: 'bare',
          note: 'Evaluation panel (e.g. "Panel 1")',
        },
        {
          path: 'group',
          type: 'string',
          countable: 'bare',
          note: 'Sample truth group (e.g. "Positive", "Negative")',
        },
        {
          path: 'control',
          type: 'string',
          countable: 'bare',
          note: 'Control result ("Pass"/"Fail")',
        },
        {
          path: 'sample_id',
          type: 'string',
          countable: 'bare',
          note: 'Evaluation sample identifier',
        },
        {
          path: 'days_from_symptom',
          type: 'string',
          countable: 'bare',
          note: 'Days from symptom onset to sample collection — numeric string, or "NA" when not reported',
        },
        {
          path: 'date_performed',
          type: 'date',
          countable: 'bare',
          note: 'Date the evaluation was performed — stored M/D/YYYY; query as YYYYMMDD (e.g. [20200101 TO 20201231])',
        },
      ],
    },
    {
      label: 'Results',
      fields: [
        { path: 'igg_result', type: 'string', countable: 'bare', note: 'IgG antibody result' },
        { path: 'igm_result', type: 'string', countable: 'bare', note: 'IgM antibody result' },
        {
          path: 'igg_agree',
          type: 'string',
          countable: 'bare',
          note: 'Whether the IgG result agreed with the truth panel',
        },
        {
          path: 'antibody_truth',
          type: 'string',
          countable: 'bare',
          note: 'Reference antibody truth for the sample',
        },
      ],
    },
  ],

  'animalandveterinary/event': [
    {
      label: 'Report',
      fields: [
        {
          path: 'unique_aer_id_number',
          type: 'string',
          countable: 'bare',
          note: 'Adverse event report ID',
        },
        {
          path: 'original_receive_date',
          type: 'date',
          countable: 'bare',
          note: 'Date report was received (YYYYMMDD)',
        },
        {
          path: 'serious_ae',
          type: 'boolean',
          countable: 'bare',
          note: 'Whether the event was serious',
        },
        {
          path: 'primary_reporter',
          type: 'string',
          countable: 'exact',
          note: 'Primary reporter type',
        },
        {
          path: 'type_of_information',
          type: 'string',
          countable: 'exact',
          note: 'Type of case information',
        },
        {
          path: 'foreign_or_domestic',
          type: 'string',
          countable: 'bare',
          note: 'Foreign or domestic report — "Domestic" on every record, so a "Foreign" filter matches nothing',
        },
      ],
    },
    {
      label: 'Animal',
      fields: [
        {
          path: 'animal.species',
          type: 'string',
          countable: 'bare',
          note: 'Animal species (e.g. "Dog", "Cat", "Horse")',
        },
        { path: 'animal.gender', type: 'string', countable: 'bare', note: 'Animal gender' },
        {
          path: 'animal.breed.breed_component',
          type: 'string',
          countable: 'exact',
          note: 'Breed name',
        },
        {
          path: 'animal.reproductive_status',
          type: 'string',
          countable: 'bare',
          note: 'Reproductive status',
        },
      ],
    },
    {
      label: 'Drug',
      fields: [
        {
          path: 'drug.brand_name',
          type: 'string',
          countable: 'exact',
          note: 'Veterinary drug brand name — masked: every record carries "MSK", the FDA null flavor for withheld data, as does drug.manufacturer.name, so a brand or manufacturer filter matches nothing. Search drug.active_ingredients.name or drug.manufacturer.registration_number instead',
        },
        {
          path: 'drug.active_ingredients.name',
          type: 'string',
          countable: 'exact',
          note: 'Active ingredient name, often with the product form (e.g. "Fluralaner Chew Tablets", "Pyrantel Pamoate;Sarolaner"). Search it unsuffixed (drug.active_ingredients.name:"Fluralaner"), since .exact matches only the whole value; one ingredient spans every product that contains it, so it cannot isolate a brand',
        },
        {
          path: 'drug.manufacturer.registration_number',
          type: 'string',
          countable: 'bare',
          note: 'Approval the product is marketed under: country, regulator, and application number (e.g. "USA-USFDACVM-N141426"). Only the full value matches; narrows an ingredient search to one approval',
        },
        { path: 'drug.route', type: 'string', countable: 'bare', note: 'Route of administration' },
        {
          path: 'drug.administered_by',
          type: 'string',
          countable: 'exact',
          note: 'Who administered the drug',
        },
      ],
    },
    {
      label: 'Reaction and outcome',
      fields: [
        {
          path: 'reaction.veddra_term_name',
          type: 'string',
          countable: 'exact',
          note: 'VeDDRA term for the adverse reaction',
        },
        {
          path: 'outcome.medical_status',
          type: 'string',
          countable: 'exact',
          note: 'Medical outcome: "Died", "Euthanized", "Recovered/Normal", "Recovered with Sequela", "Ongoing", or "Outcome Unknown"',
        },
      ],
    },
  ],

  'tobacco/problem': [
    {
      label: 'Report',
      fields: [
        { path: 'report_id', type: 'integer', countable: 'bare', note: 'Report ID' },
        {
          path: 'date_submitted',
          type: 'date',
          countable: 'bare',
          note: 'Submission date — stored MM/DD/YYYY; query as YYYYMMDD (e.g. [20230101 TO 20231231])',
        },
        {
          path: 'nonuser_affected',
          type: 'string',
          countable: 'bare',
          note: 'Whether a non-tobacco-user was affected: "Yes", "No", "No information provided", "Unknown", or "Neither"',
        },
      ],
    },
    {
      label: 'Products',
      fields: [
        {
          path: 'tobacco_products',
          type: 'string',
          countable: 'exact',
          note: 'Product types (e.g. "Electronic cigarette", "Cigarette")',
        },
        {
          path: 'number_tobacco_products',
          type: 'integer',
          countable: 'bare',
          note: 'Number of tobacco products',
        },
      ],
    },
    {
      label: 'Problems',
      fields: [
        {
          path: 'reported_health_problems',
          type: 'string',
          countable: 'exact',
          note: 'Reported health effects (e.g. "Seizure", "Chest pain")',
        },
        {
          path: 'reported_product_problems',
          type: 'string',
          countable: 'exact',
          note: 'Product defects (e.g. "Exploding battery")',
        },
        {
          path: 'number_health_problems',
          type: 'integer',
          countable: 'bare',
          note: 'Number of health problems',
        },
        {
          path: 'number_product_problems',
          type: 'integer',
          countable: 'bare',
          note: 'Number of product problems',
        },
      ],
    },
  ],

  'other/substance': [
    {
      label: 'Substance identity',
      fields: [
        {
          path: 'unii',
          type: 'string',
          countable: 'bare',
          note: 'FDA Unique Ingredient Identifier (UNII)',
        },
        {
          path: 'substance_class',
          type: 'string',
          countable: 'bare',
          note: 'Substance class (e.g. "chemical", "protein", "mixture")',
        },
        {
          path: 'definition_type',
          type: 'string',
          countable: 'bare',
          note: 'Definition type ("PRIMARY", "ALTERNATIVE")',
        },
        {
          path: 'definition_level',
          type: 'string',
          countable: 'bare',
          note: 'Definition completeness level (e.g. "COMPLETE")',
        },
      ],
    },
    {
      label: 'Names and codes',
      fields: [
        {
          path: 'names.name',
          type: 'string',
          countable: 'bare',
          note: 'Substance name (systematic, brand, or common)',
        },
        {
          path: 'names.type',
          type: 'string',
          countable: 'bare',
          note: 'Name type code (e.g. "cn" common, "sys" systematic)',
        },
        {
          path: 'codes.code',
          type: 'string',
          countable: 'bare',
          note: 'External registry code value',
        },
        {
          path: 'codes.code_system',
          type: 'string',
          countable: 'bare',
          note: 'Code system (e.g. "CAS", "FDA UNII", "EC")',
        },
      ],
    },
    {
      label: 'Structure',
      fields: [
        {
          path: 'structure.formula',
          type: 'string',
          countable: 'bare',
          note: 'Molecular formula (e.g. "C20H13NO4")',
        },
        {
          path: 'structure.molecular_weight',
          type: 'string',
          countable: 'bare',
          note: 'Molecular weight (numeric string)',
        },
      ],
    },
  ],

  'other/nsde': [
    {
      label: 'Package',
      fields: [
        {
          path: 'package_ndc11',
          type: 'string',
          countable: 'bare',
          note: 'NDC11: 11 digits, no hyphens (e.g. "00093171201"); one row per package',
        },
        {
          path: 'package_ndc',
          type: 'string',
          countable: 'none',
          note: 'Hyphenated 10-digit package NDC (e.g. "0093-1712-01"); a two-segment product NDC ("63629-3292") matches every package of the product',
        },
        {
          path: 'proprietary_name',
          type: 'string',
          countable: 'bare',
          note: 'Proprietary name, matched as the whole value in stored case ("Warfarin Sodium"; "warfarin sodium" or "Warfarin" match nothing)',
        },
        {
          path: 'dosage_form',
          type: 'string',
          countable: 'bare',
          note: 'Dosage form (e.g. "TABLET", "TABLET, FILM COATED")',
        },
        {
          path: 'product_type',
          type: 'string',
          countable: 'bare',
          note: 'Product type (e.g. "HUMAN PRESCRIPTION DRUG", "HUMAN OTC DRUG")',
        },
        {
          path: 'billing_unit',
          type: 'string',
          countable: 'bare',
          note: 'NCPDP billing unit (e.g. "EA", "ML", "GM"), set on some packages only',
        },
      ],
    },
    {
      label: 'Marketing',
      fields: [
        {
          path: 'marketing_category',
          type: 'string',
          countable: 'bare',
          note: 'Marketing category in stored case (e.g. "ANDA", "OTC Monograph Drug"; "anda" matches nothing)',
        },
        {
          path: 'application_number_or_citation',
          type: 'string',
          countable: 'bare',
          note: 'Application number or monograph citation (e.g. "ANDA040616", "M020", "part333A")',
        },
        {
          path: 'marketing_start_date',
          type: 'date',
          countable: 'bare',
          note: 'Date marketing of the package began (YYYYMMDD)',
        },
        {
          path: 'marketing_end_date',
          type: 'date',
          countable: 'bare',
          note: 'Expiration date of the last lot distributed (YYYYMMDD), absent while the package is marketed and possibly in the future',
        },
        {
          path: 'inactivation_date',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA inactivated the listing data (YYYYMMDD)',
        },
        {
          path: 'reactivation_date',
          type: 'date',
          countable: 'bare',
          note: 'Date FDA reactivated listing data it had inactivated (YYYYMMDD)',
        },
      ],
    },
  ],

  'transparency/crl': [
    {
      label: 'Letter',
      fields: [
        {
          path: 'application_number',
          type: 'string',
          countable: 'bare',
          note: 'Application number with a space (e.g. "NDA 210274", "BLA 761082"), matched only whole and as stored: a wildcard reaches the prefix (NDA*), never the number past the space; a few letters spell it otherwise ("BL 125745", "NDA 217225/S-001"), which text:"217225" reaches',
        },
        {
          path: 'company_name',
          type: 'string',
          countable: 'exact',
          note: 'Applicant company name',
        },
        {
          path: 'letter_date',
          type: 'date',
          countable: 'bare',
          note: 'Date the letter was signed — stored MM/DD/YYYY; query as YYYYMMDD (e.g. [20240101 TO 20241231])',
        },
        {
          path: 'letter_type',
          type: 'string',
          countable: 'bare',
          note: 'Letter type (e.g. "COMPLETE RESPONSE", "TENTATIVE APPROVAL")',
        },
        {
          path: 'approval_status',
          type: 'string',
          countable: 'bare',
          note: 'Approval status of the application: "Approved" or "Unapproved", in that case ("unapproved" matches nothing)',
        },
        {
          path: 'letter_year',
          type: 'string',
          countable: 'bare',
          note: 'Year of the letter (e.g. "2024")',
        },
        {
          path: 'file_name',
          type: 'string',
          countable: 'bare',
          note: 'Source PDF (e.g. "210274_2023_Orig1s000OtherActionLtrs.pdf"); one PDF can hold several letters',
        },
      ],
    },
    {
      label: 'Signer',
      fields: [
        {
          path: 'approver_name',
          type: 'string',
          countable: 'exact',
          note: 'Signing official as printed; some letters name an FDA center instead, or "(b) (4)" where the name is withheld',
        },
        {
          path: 'approver_center',
          type: 'string',
          countable: 'exact',
          note: 'FDA center and offices that issued the letter (e.g. "Center for Drug Evaluation and Research", "Office of New Drugs")',
        },
      ],
    },
    {
      label: 'Text',
      fields: [
        {
          path: 'text',
          type: 'string',
          countable: 'none',
          note: 'Full letter text, phrase-searchable (e.g. text:"bioequivalence")',
        },
      ],
    },
  ],
};

/**
 * Per-endpoint dotted paths whose value is an array of objects, read from live
 * records (2026-11-22). openFDA tests each search clause against the whole
 * record, so AND-ed clauses on fields under one of these arrays can be met by
 * different elements. A nested array is listed by its full path after its
 * parent (`submissions`, `submissions.application_docs`). `transparency/crl`
 * and `other/nsde` were read too and hold none (their arrays carry strings, or
 * the record is flat); any other endpoint absent here has not been surveyed,
 * which is not a claim that it has no such array.
 */
export const OBJECT_ARRAY_PATHS: Readonly<Record<string, readonly string[]>> = {
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
};

/**
 * Arrays in {@link OBJECT_ARRAY_PATHS} that hold exactly one entry on every
 * record of their endpoint, read from every record: each of the 48,990
 * `drug/orangebook` records (2026-11-22) carries one `products` entry, while
 * its `patents` and `exclusivity` hold up to 149 and 12. Two clauses on an
 * array's own fields here cannot be met by different entries; an array listed
 * under it still can (one product, several ingredients).
 */
export const SINGLE_ENTRY_ARRAYS: Readonly<Record<string, readonly string[]>> = {
  'drug/orangebook': ['products'],
};

/**
 * Return the field groups for an endpoint, or undefined if the endpoint is not cataloged.
 *
 * Supports both exact paths ("drug/event") and partial matches where the key is
 * a suffix of the supplied endpoint (used by handlers that construct endpoints
 * dynamically, e.g. `${category}/enforcement`).
 */
export function getFieldGroups(endpoint: string): FieldGroup[] | undefined {
  if (FIELD_CATALOG[endpoint]) return FIELD_CATALOG[endpoint];
  // Fallback: suffix match for callers that may prepend extra segments
  const entry = Object.entries(FIELD_CATALOG).find(([key]) => endpoint.endsWith(key));
  return entry?.[1];
}

/** Return all cataloged endpoint paths. */
export function getCatalogedEndpoints(): string[] {
  return Object.keys(FIELD_CATALOG);
}

/**
 * The `count` expression to pass for a field, or `null` when it has none. A
 * field that counts both ways is given bare.
 */
export function countExpression(field: FieldEntry): string | null {
  switch (field.countable) {
    case 'bare':
    case 'both':
      return field.path;
    case 'exact':
      return `${field.path}.exact`;
    case 'none':
      return null;
  }
}

/** What the catalog records about a `count` expression on an endpoint. */
export type CountVerdict =
  /** The field is not cataloged for the endpoint — nothing is recorded. */
  | { kind: 'uncataloged' }
  /** The expression is a form the field was verified to count in. */
  | { kind: 'countable' }
  /** The field counts, but only as `use`. */
  | { kind: 'wrong_form'; use: string }
  /** The field counts in no form; `alternatives` are countable expressions on the endpoint. */
  | { kind: 'none'; alternatives: string[] };

/**
 * Look up a `count` expression (`<path>` or `<path>.exact`) against the
 * catalog's verified count forms for `endpoint`.
 */
export function countVerdict(endpoint: string, expression: string): CountVerdict {
  const groups = getFieldGroups(endpoint);
  const exact = expression.endsWith('.exact');
  const path = exact ? expression.slice(0, -'.exact'.length) : expression;
  const field = groups?.flatMap((g) => g.fields).find((f) => f.path === path);
  if (!groups || !field) return { kind: 'uncataloged' };

  switch (field.countable) {
    case 'both':
      return { kind: 'countable' };
    case 'none':
      return {
        kind: 'none',
        alternatives: groups
          .flatMap((g) => g.fields)
          .map(countExpression)
          .filter((e): e is string => e !== null),
      };
    case 'bare':
    case 'exact':
      return exact === (field.countable === 'exact')
        ? { kind: 'countable' }
        : { kind: 'wrong_form', use: field.countable === 'exact' ? `${path}.exact` : path };
  }
}

/**
 * Format a compact inline hint listing the first few searchable field paths for an endpoint.
 * Used in empty-result notice enrichment to point agents at the right field names without
 * bloating the notice with the full catalog.
 */
export function formatFieldHint(endpoint: string, maxFields = 6): string {
  const groups = getFieldGroups(endpoint);
  if (!groups || groups.length === 0) return '';

  const topFields: string[] = [];
  for (const group of groups) {
    for (const field of group.fields) {
      topFields.push(field.path);
      if (topFields.length >= maxFields) break;
    }
    if (topFields.length >= maxFields) break;
  }

  if (topFields.length === 0) return '';
  return `Key searchable fields for ${endpoint}: ${topFields.join(', ')}. Call openfda_describe_fields({ endpoint: "${endpoint}" }) for the full list.`;
}

/**
 * @fileoverview Static catalog of searchable openFDA field paths, grouped by endpoint.
 * Used by openfda_describe_fields (proactive discovery), the empty-result/error
 * notice enrichment in search tools (reactive guidance), and the openFDA service's
 * `count` error classification (via {@link countVerdict}).
 * @module mcp-server/tools/field-catalog
 */

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
          note: '1 = male, 2 = female',
        },
        {
          path: 'patient.patientagegroup',
          type: 'string',
          countable: 'bare',
          note: 'Age group code',
        },
        { path: 'patient.patientweight', type: 'float', countable: 'bare', note: 'Weight in kg' },
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
          note: 'Outcome code (1=recovered, 2=recovering, 3=not recovered, 4=fatal, 5=unknown)',
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
          note: 'Route of administration',
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
          note: 'Product type (e.g. HUMAN OTC)',
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
          note: 'NDA/ANDA number',
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
      ],
    },
    {
      label: 'Metadata',
      fields: [
        {
          path: 'set_id',
          type: 'string',
          countable: 'bare',
          note: 'SPL set ID (stable across revisions)',
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
          note: 'Product type (Drugs, Biologics, etc.)',
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
          note: 'NDC product code (10-digit)',
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
          note: 'Marketing category (NDA, ANDA, OTC)',
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
        { path: 'sponsor_name', type: 'string', countable: 'bare', note: 'Sponsor/applicant name' },
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
          path: 'submissions.review_priority',
          type: 'string',
          countable: 'bare',
          note: 'PRIORITY or STANDARD',
        },
      ],
    },
    {
      label: 'OpenFDA identifiers',
      fields: [
        { path: 'openfda.brand_name', type: 'string', countable: 'exact', note: 'Brand name' },
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
          note: 'Shortage status: "Current" or "Resolved"',
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
          note: 'Free-text note on current availability',
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
          note: 'Date the shortage was first posted (YYYYMMDD)',
        },
        {
          path: 'update_date',
          type: 'date',
          countable: 'bare',
          note: 'Date of the last update (YYYYMMDD)',
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
          note: 'Reported reactions (comma-separated)',
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
          note: 'Report source (e.g. "Manufacturer", "User facility")',
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
          note: 'FDA device class (1, 2, or 3)',
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
          note: 'Decision date (YYYYMMDD)',
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
          note: 'Decision date (YYYYMMDD)',
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
          note: 'Device class of the recalled product ("1", "2", "3"); the recall hazard class is on device/enforcement',
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
          note: 'Device class: "1", "2", "3", or "U" (unclassified)',
        },
        {
          path: 'regulation_number',
          type: 'string',
          countable: 'exact',
          note: 'CFR regulation number (e.g. "878.4800")',
        },
        {
          path: 'medical_specialty_description',
          type: 'string',
          countable: 'exact',
          note: 'Review panel / medical specialty (e.g. "General, Plastic Surgery")',
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
          note: 'Device class of the listed product ("1", "2", "3")',
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
          note: 'DI issuing agency (GS1, HIBCC, ICCBBA)',
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
          note: 'Device class ("1", "2", "3")',
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
          type: 'string',
          countable: 'bare',
          note: 'Date the evaluation was performed (M/D/YYYY)',
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
          note: 'Foreign or domestic report',
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
          note: 'Veterinary drug brand name',
        },
        {
          path: 'drug.active_ingredients.name',
          type: 'string',
          countable: 'exact',
          note: 'Active ingredient name',
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
          note: 'Medical outcome (e.g. "Death", "Recovery")',
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
          note: 'Submission date (YYYYMMDD)',
        },
        {
          path: 'nonuser_affected',
          type: 'string',
          countable: 'bare',
          note: 'Whether a non-tobacco-user was affected ("Yes"/"No")',
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

/**
 * @fileoverview Static catalog of searchable openFDA field paths, grouped by endpoint.
 * Used by openfda_describe_fields (proactive discovery) and the empty-result/error
 * notice enrichment in search tools (reactive guidance).
 * @module mcp-server/tools/field-catalog
 */

/** A single searchable field entry. */
export interface FieldEntry {
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
        { path: 'safetyreportid', type: 'string', note: 'FDA report ID' },
        { path: 'receivedate', type: 'date', note: 'Date FDA received the report (YYYYMMDD)' },
        { path: 'serious', type: 'string', note: '1 = serious, 2 = non-serious' },
        { path: 'primarysource.reportercountry', type: 'string', note: 'Country of the reporter' },
      ],
    },
    {
      label: 'Patient',
      fields: [
        { path: 'patient.patientsex', type: 'string', note: '1 = male, 2 = female' },
        { path: 'patient.patientagegroup', type: 'string', note: 'Age group code' },
        { path: 'patient.patientweight', type: 'float', note: 'Weight in kg' },
      ],
    },
    {
      label: 'Reactions',
      fields: [
        {
          path: 'patient.reaction.reactionmeddrapt',
          type: 'string',
          note: 'MedDRA preferred term for the adverse reaction',
        },
        {
          path: 'patient.reaction.reactionoutcome',
          type: 'string',
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
          note: 'Drug name as reported (use .exact for phrase matching)',
        },
        {
          path: 'patient.drug.drugcharacterization',
          type: 'string',
          note: '1 = suspect, 2 = concomitant, 3 = interacting',
        },
        {
          path: 'patient.drug.drugindication',
          type: 'string',
          note: 'Indication for use',
        },
        {
          path: 'patient.drug.drugadministrationroute',
          type: 'string',
          note: 'Route of administration',
        },
        { path: 'patient.drug.openfda.brand_name', type: 'string', note: 'OpenFDA brand name' },
        {
          path: 'patient.drug.openfda.generic_name',
          type: 'string',
          note: 'OpenFDA generic name',
        },
        {
          path: 'patient.drug.openfda.manufacturer_name',
          type: 'string',
          note: 'OpenFDA manufacturer',
        },
      ],
    },
  ],

  'drug/label': [
    {
      label: 'OpenFDA identifiers',
      fields: [
        { path: 'openfda.brand_name', type: 'string', note: 'Brand name' },
        { path: 'openfda.generic_name', type: 'string', note: 'Generic name' },
        { path: 'openfda.manufacturer_name', type: 'string', note: 'Manufacturer' },
        { path: 'openfda.product_type', type: 'string', note: 'Product type (e.g. HUMAN OTC)' },
        { path: 'openfda.route', type: 'string', note: 'Route of administration' },
        { path: 'openfda.application_number', type: 'string', note: 'NDA/ANDA number' },
      ],
    },
    {
      label: 'Label sections',
      fields: [
        { path: 'indications_and_usage', type: 'string', note: 'Full text of indications section' },
        { path: 'warnings', type: 'string', note: 'Warnings section text' },
        {
          path: 'dosage_and_administration',
          type: 'string',
          note: 'Dosage and administration text',
        },
        { path: 'contraindications', type: 'string', note: 'Contraindications text' },
        { path: 'adverse_reactions', type: 'string', note: 'Adverse reactions section text' },
        { path: 'active_ingredient', type: 'string', note: 'Active ingredient names/strengths' },
      ],
    },
    {
      label: 'Metadata',
      fields: [
        { path: 'set_id', type: 'string', note: 'SPL set ID (stable across revisions)' },
        {
          path: 'effective_time',
          type: 'date',
          note: 'Label effective date (YYYYMMDD) — sort by this for most recent',
        },
      ],
    },
  ],

  'drug/enforcement': [
    {
      label: 'Recall identification',
      fields: [
        { path: 'recall_number', type: 'string', note: 'FDA recall number' },
        {
          path: 'classification',
          type: 'string',
          note: 'Hazard class: "Class I", "Class II", "Class III"',
        },
        { path: 'status', type: 'string', note: 'Recall status (e.g. Ongoing, Completed)' },
        { path: 'voluntary_mandated', type: 'string', note: 'Voluntary or FDA mandated' },
      ],
    },
    {
      label: 'Firm and product',
      fields: [
        { path: 'recalling_firm', type: 'string', note: 'Firm conducting the recall' },
        { path: 'product_description', type: 'string', note: 'Description of recalled product' },
        { path: 'reason_for_recall', type: 'string', note: 'Reason stated for the recall' },
        { path: 'product_type', type: 'string', note: 'Product type (Drugs, Biologics, etc.)' },
        { path: 'distribution_pattern', type: 'string', note: 'Geographic scope of distribution' },
      ],
    },
    {
      label: 'Dates',
      fields: [
        { path: 'report_date', type: 'date', note: 'Report date (YYYYMMDD)' },
        { path: 'recall_initiation_date', type: 'date', note: 'When recall was initiated' },
      ],
    },
  ],

  'drug/ndc': [
    {
      label: 'Product identification',
      fields: [
        { path: 'product_ndc', type: 'string', note: 'NDC product code (10-digit)' },
        { path: 'brand_name', type: 'string', note: 'Brand name' },
        { path: 'generic_name', type: 'string', note: 'Generic name' },
        { path: 'labeler_name', type: 'string', note: 'Labeler/manufacturer name' },
        { path: 'dosage_form', type: 'string', note: 'Dosage form (e.g. TABLET, CAPSULE)' },
        { path: 'route', type: 'string', note: 'Route of administration' },
        { path: 'marketing_category', type: 'string', note: 'Marketing category (NDA, ANDA, OTC)' },
      ],
    },
    {
      label: 'Ingredients',
      fields: [
        { path: 'active_ingredients.name', type: 'string', note: 'Active ingredient name' },
        { path: 'active_ingredients.strength', type: 'string', note: 'Active ingredient strength' },
      ],
    },
    {
      label: 'OpenFDA cross-references',
      fields: [
        { path: 'openfda.manufacturer_name', type: 'string', note: 'Manufacturer name' },
        { path: 'openfda.rxcui', type: 'string', note: 'RxCUI identifier' },
        { path: 'openfda.upc', type: 'string', note: 'UPC barcode' },
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
          note: 'Application number (e.g. NDA012345, ANDA000001)',
        },
        { path: 'sponsor_name', type: 'string', note: 'Sponsor/applicant name' },
      ],
    },
    {
      label: 'Submissions',
      fields: [
        {
          path: 'submissions.submission_type',
          type: 'string',
          note: 'Submission type (ORIG, SUPPL)',
        },
        {
          path: 'submissions.submission_status',
          type: 'string',
          note: 'Submission status (AP = approved)',
        },
        {
          path: 'submissions.submission_status_date',
          type: 'date',
          note: 'Status date (YYYYMMDD)',
        },
        { path: 'submissions.review_priority', type: 'string', note: 'PRIORITY or STANDARD' },
      ],
    },
    {
      label: 'OpenFDA identifiers',
      fields: [
        { path: 'openfda.brand_name', type: 'string', note: 'Brand name' },
        { path: 'openfda.generic_name', type: 'string', note: 'Generic name' },
        { path: 'openfda.product_type', type: 'string', note: 'Product type' },
        { path: 'openfda.route', type: 'string', note: 'Route of administration' },
        { path: 'openfda.substance_name', type: 'string', note: 'Substance name' },
      ],
    },
  ],

  'drug/shortages': [
    {
      label: 'Drug identification',
      fields: [
        { path: 'generic_name', type: 'string', note: 'Generic name of the drug in shortage' },
        { path: 'status', type: 'string', note: 'Shortage status: "Current" or "Resolved"' },
        {
          path: 'therapeutic_category',
          type: 'string',
          note: 'Therapeutic category (e.g. "Oncology")',
        },
        { path: 'dosage_form', type: 'string', note: 'Dosage form (e.g. "Injection")' },
        { path: 'company_name', type: 'string', note: 'Manufacturer or distributor name' },
      ],
    },
    {
      label: 'Product details',
      fields: [
        { path: 'presentation', type: 'string', note: 'Presentation/package description' },
        { path: 'package_ndc', type: 'string', note: 'NDC code for the package' },
        { path: 'availability', type: 'string', note: 'Free-text note on current availability' },
        { path: 'update_type', type: 'string', note: 'Type of the most recent update' },
      ],
    },
    {
      label: 'Dates',
      fields: [
        {
          path: 'initial_posting_date',
          type: 'date',
          note: 'Date the shortage was first posted (YYYYMMDD)',
        },
        { path: 'update_date', type: 'date', note: 'Date of the last update (YYYYMMDD)' },
      ],
    },
    {
      label: 'OpenFDA cross-references',
      fields: [
        { path: 'openfda.brand_name', type: 'string', note: 'OpenFDA brand name' },
        { path: 'openfda.product_ndc', type: 'string', note: 'OpenFDA product NDC' },
        { path: 'openfda.rxcui', type: 'string', note: 'RxCUI identifier' },
        { path: 'openfda.spl_set_id', type: 'string', note: 'SPL set ID for label cross-linking' },
      ],
    },
  ],

  'food/event': [
    {
      label: 'Report',
      fields: [
        { path: 'report_number', type: 'string', note: 'Report ID' },
        { path: 'date_created', type: 'date', note: 'Date report was created (YYYYMMDD)' },
        { path: 'date_started', type: 'date', note: 'Date event started (YYYYMMDD)' },
      ],
    },
    {
      label: 'Products and reactions',
      fields: [
        { path: 'products.name_brand', type: 'string', note: 'Brand name of the product' },
        { path: 'products.industry_name', type: 'string', note: 'Industry category name' },
        { path: 'products.industry_code', type: 'string', note: 'Industry code' },
        { path: 'products.role', type: 'string', note: 'Product role in the event' },
        { path: 'reactions', type: 'string', note: 'Reported reactions (comma-separated)' },
        { path: 'outcomes', type: 'string', note: 'Medical outcomes' },
      ],
    },
    {
      label: 'Consumer',
      fields: [
        { path: 'consumer.gender', type: 'string', note: 'Consumer gender' },
        { path: 'consumer.age.age', type: 'float', note: 'Consumer age' },
        { path: 'consumer.age.age_unit', type: 'string', note: 'Age unit (e.g. years)' },
      ],
    },
  ],

  'food/enforcement': [
    {
      label: 'Recall identification',
      fields: [
        { path: 'recall_number', type: 'string', note: 'FDA recall number' },
        {
          path: 'classification',
          type: 'string',
          note: 'Hazard class: "Class I", "Class II", "Class III"',
        },
        { path: 'status', type: 'string', note: 'Recall status' },
        { path: 'voluntary_mandated', type: 'string', note: 'Voluntary or FDA mandated' },
      ],
    },
    {
      label: 'Firm and product',
      fields: [
        { path: 'recalling_firm', type: 'string', note: 'Firm conducting the recall' },
        { path: 'product_description', type: 'string', note: 'Recalled product description' },
        { path: 'reason_for_recall', type: 'string', note: 'Reason for recall' },
        { path: 'distribution_pattern', type: 'string', note: 'Geographic distribution scope' },
        { path: 'product_type', type: 'string', note: 'Product type' },
      ],
    },
    {
      label: 'Dates',
      fields: [
        { path: 'report_date', type: 'date', note: 'Report date (YYYYMMDD)' },
        { path: 'recall_initiation_date', type: 'date', note: 'Recall initiation date' },
      ],
    },
  ],

  'device/event': [
    {
      label: 'Report',
      fields: [
        { path: 'report_number', type: 'string', note: 'MDR report number' },
        { path: 'mdr_report_key', type: 'string', note: 'MDR database key' },
        {
          path: 'event_type',
          type: 'string',
          note: 'Event type (e.g. "Malfunction", "Injury", "Death")',
        },
        { path: 'date_of_event', type: 'date', note: 'Date the event occurred (YYYYMMDD)' },
        { path: 'date_received', type: 'date', note: 'Date FDA received the report (YYYYMMDD)' },
        {
          path: 'source_type',
          type: 'string',
          note: 'Report source (e.g. "Manufacturer", "User facility")',
        },
      ],
    },
    {
      label: 'Device',
      fields: [
        { path: 'device.brand_name', type: 'string', note: 'Device brand name' },
        { path: 'device.generic_name', type: 'string', note: 'Device generic name' },
        { path: 'device.manufacturer_d_name', type: 'string', note: 'Device manufacturer name' },
        {
          path: 'device.device_class',
          type: 'string',
          note: 'FDA device class (1, 2, or 3)',
        },
        { path: 'device.product_code', type: 'string', note: 'FDA product code (3-letter)' },
        { path: 'device.model_number', type: 'string', note: 'Device model number' },
      ],
    },
    {
      label: 'Patient',
      fields: [
        { path: 'patient.sequence_number_outcome', type: 'string', note: 'Patient outcome code' },
        { path: 'patient.patient_problems', type: 'string', note: 'Patient problems reported' },
      ],
    },
  ],

  'device/510k': [
    {
      label: 'Clearance',
      fields: [
        { path: 'k_number', type: 'string', note: '510(k) number (e.g. K123456)' },
        {
          path: 'decision_code',
          type: 'string',
          note: 'Decision code (SESE = substantial equivalence)',
        },
        { path: 'decision_date', type: 'date', note: 'Decision date (YYYYMMDD)' },
        {
          path: 'clearance_type',
          type: 'string',
          note: 'Clearance type (Traditional, Special, Abbreviated)',
        },
      ],
    },
    {
      label: 'Device and applicant',
      fields: [
        { path: 'applicant', type: 'string', note: 'Company name submitting the 510(k)' },
        { path: 'device_name', type: 'string', note: 'Device name as submitted' },
        { path: 'product_code', type: 'string', note: 'FDA 3-letter product code' },
        {
          path: 'advisory_committee_description',
          type: 'string',
          note: 'Review panel (e.g. "Cardiovascular")',
        },
        { path: 'openfda.device_name', type: 'string', note: 'OpenFDA normalized device name' },
      ],
    },
  ],

  'device/pma': [
    {
      label: 'Approval',
      fields: [
        { path: 'pma_number', type: 'string', note: 'PMA number' },
        { path: 'decision_date', type: 'date', note: 'Decision date (YYYYMMDD)' },
        { path: 'decision_code', type: 'string', note: 'Decision code' },
      ],
    },
    {
      label: 'Device and applicant',
      fields: [
        { path: 'applicant', type: 'string', note: 'Applicant company name' },
        { path: 'product_code', type: 'string', note: 'FDA 3-letter product code' },
        {
          path: 'advisory_committee',
          type: 'string',
          note: 'Review advisory committee code',
        },
      ],
    },
  ],

  'device/recall': [
    {
      label: 'Recall',
      fields: [
        { path: 'recall_number', type: 'string', note: 'FDA recall number' },
        { path: 'event_id', type: 'integer', note: 'FDA recall event ID' },
        { path: 'status', type: 'string', note: 'Recall status (Ongoing, Completed)' },
        { path: 'classification', type: 'string', note: 'Hazard class I, II, or III' },
      ],
    },
    {
      label: 'Firm and device',
      fields: [
        { path: 'recalling_firm', type: 'string', note: 'Firm conducting the recall' },
        { path: 'product_description', type: 'string', note: 'Product description' },
        { path: 'reason_for_recall', type: 'string', note: 'Reason for recall' },
        {
          path: 'root_cause_description',
          type: 'string',
          note: 'Root cause category description',
        },
      ],
    },
  ],

  'device/enforcement': [
    {
      label: 'Recall identification',
      fields: [
        { path: 'recall_number', type: 'string', note: 'FDA recall number' },
        { path: 'classification', type: 'string', note: 'Hazard class I, II, or III' },
        { path: 'status', type: 'string', note: 'Recall status' },
        { path: 'voluntary_mandated', type: 'string', note: 'Voluntary or FDA mandated' },
      ],
    },
    {
      label: 'Firm and product',
      fields: [
        { path: 'recalling_firm', type: 'string', note: 'Firm conducting the recall' },
        { path: 'product_description', type: 'string', note: 'Product description' },
        { path: 'reason_for_recall', type: 'string', note: 'Reason for recall' },
        { path: 'distribution_pattern', type: 'string', note: 'Geographic distribution' },
      ],
    },
    {
      label: 'Dates',
      fields: [
        { path: 'report_date', type: 'date', note: 'Report date (YYYYMMDD)' },
        { path: 'recall_initiation_date', type: 'date', note: 'Recall initiation date' },
      ],
    },
  ],

  'animalandveterinary/event': [
    {
      label: 'Report',
      fields: [
        { path: 'unique_aer_id_number', type: 'string', note: 'Adverse event report ID' },
        {
          path: 'original_receive_date',
          type: 'date',
          note: 'Date report was received (YYYYMMDD)',
        },
        { path: 'serious_ae', type: 'boolean', note: 'Whether the event was serious' },
        { path: 'primary_reporter', type: 'string', note: 'Primary reporter type' },
        { path: 'type_of_information', type: 'string', note: 'Type of case information' },
        { path: 'foreign_or_domestic', type: 'string', note: 'Foreign or domestic report' },
      ],
    },
    {
      label: 'Animal',
      fields: [
        {
          path: 'animal.species',
          type: 'string',
          note: 'Animal species (e.g. "Dog", "Cat", "Horse")',
        },
        { path: 'animal.gender', type: 'string', note: 'Animal gender' },
        { path: 'animal.breed.breed_component', type: 'string', note: 'Breed name' },
        { path: 'animal.reproductive_status', type: 'string', note: 'Reproductive status' },
      ],
    },
    {
      label: 'Drug',
      fields: [
        { path: 'drug.brand_name', type: 'string', note: 'Veterinary drug brand name' },
        {
          path: 'drug.active_ingredients.name',
          type: 'string',
          note: 'Active ingredient name',
        },
        { path: 'drug.route', type: 'string', note: 'Route of administration' },
        { path: 'drug.administered_by', type: 'string', note: 'Who administered the drug' },
      ],
    },
    {
      label: 'Reaction and outcome',
      fields: [
        {
          path: 'reaction.veddra_term_name',
          type: 'string',
          note: 'VeDDRA term for the adverse reaction',
        },
        {
          path: 'outcome.medical_status',
          type: 'string',
          note: 'Medical outcome (e.g. "Death", "Recovery")',
        },
      ],
    },
  ],

  'tobacco/problem': [
    {
      label: 'Report',
      fields: [
        { path: 'report_id', type: 'integer', note: 'Report ID' },
        { path: 'date_submitted', type: 'date', note: 'Submission date (YYYYMMDD)' },
        {
          path: 'nonuser_affected',
          type: 'string',
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
          note: 'Product types (e.g. "Electronic cigarette", "Cigarette")',
        },
        { path: 'number_tobacco_products', type: 'integer', note: 'Number of tobacco products' },
      ],
    },
    {
      label: 'Problems',
      fields: [
        {
          path: 'reported_health_problems',
          type: 'string',
          note: 'Reported health effects (e.g. "Seizure", "Chest pain")',
        },
        {
          path: 'reported_product_problems',
          type: 'string',
          note: 'Product defects (e.g. "Exploding battery")',
        },
        { path: 'number_health_problems', type: 'integer', note: 'Number of health problems' },
        { path: 'number_product_problems', type: 'integer', note: 'Number of product problems' },
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

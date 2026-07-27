/**
 * @fileoverview content[] ↔ structuredContent parity for the dynamic-record
 * tools. Every `results[]` element is a `z.record(z.string(), z.any())`, so the
 * definition linter's `format-parity` sentinel walk stops at the record boundary
 * and cannot see a leaf a formatter skipped. These fixtures carry the nested
 * shapes real openFDA records have — the blocks each formatter only partially
 * summarizes — and assert every scalar leaf reaches the rendered text (#24).
 * @module tests/mcp-server/tools/definitions/record-parity.test
 */

import { describe, expect, it } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';

/** Every scalar leaf under `value`, keyed by its dotted path. */
function leaves(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (value == null || value === '') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      leaves(v, `${path}[${i}]`, out);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
    return;
  }
  out.push({ path, value: String(value) });
}

/**
 * A leaf reached `content[]` either verbatim or inside a JSON-stringified
 * container (where quotes and backslashes are escaped).
 */
function rendered(text: string, value: string): boolean {
  return text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1));
}

const META = { total: 1, skip: 0, limit: 10, lastUpdated: '2026-07-01' };

/** One fixture per dynamic-record renderer, exercising its nested blocks. */
const CASES: Array<{ name: string; format: (r: never) => { text: string }[]; result: unknown }> = [
  {
    name: 'openfda_search_adverse_events (drug)',
    format: searchAdverseEventsTool.format as never,
    result: {
      meta: META,
      results: [
        {
          safetyreportid: 'AE-DRUG-1',
          receivedate: '20260101',
          serious: '1',
          receiptdate: '20260102',
          transmissiondateformat: 'FMT-102',
          companynumb: 'CO-NUMB-9',
          patient: {
            patientsex: '2',
            patientonsetage: '61',
            reaction: [
              {
                reactionmeddrapt: 'Nausea',
                reactionmeddraversionpt: 'VERSION-26-1',
                reactionoutcome: 'OUTCOME-6',
              },
            ],
            drug: [
              {
                medicinalproduct: 'ASPIRIN',
                drugindication: 'HEADACHE',
                drugdosagetext: 'DOSAGE-TEXT-MARKER',
                openfda: {
                  generic_name: ['GENERIC-MARKER'],
                  unii: ['UNII-MARKER'],
                  pharm_class_epc: ['EPC-MARKER'],
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    name: 'openfda_search_adverse_events (device)',
    format: searchAdverseEventsTool.format as never,
    /** device/event records also carry `patient`, so the device arm must win. */
    result: {
      meta: META,
      results: [
        {
          report_number: 'DEV-RPT-1',
          mdr_report_key: 'MDR-KEY-2',
          event_type: 'Injury',
          device: [
            {
              brand_name: 'BRAND-MARKER',
              generic_name: 'GENERIC-DEVICE-MARKER',
              manufacturer_d_name: 'MFR-MARKER',
              device_report_product_code: 'PRODCODE-MARKER',
            },
          ],
          mdr_text: [
            {
              text_type_code: 'Description of Event or Problem',
              text: 'NARRATIVE-MARKER',
              mdr_text_key: 'TEXTKEY-MARKER',
              patient_sequence_number: 'SEQ-MARKER',
            },
          ],
          patient: [{ patient_age: 'AGE-MARKER', sequence_number_outcome: ['OUTCOME-MARKER'] }],
        },
      ],
    },
  },
  {
    name: 'openfda_search_adverse_events (food)',
    format: searchAdverseEventsTool.format as never,
    result: {
      meta: META,
      results: [
        {
          report_number: 'FOOD-RPT-1',
          reactions: ['DIARRHOEA'],
          outcomes: ['Other Outcome'],
          date_created: '20260301',
          products: [
            {
              name_brand: 'BRAND-FOOD-MARKER',
              industry_name: 'INDUSTRY-MARKER',
              role: 'Suspect',
              industry_code: '99',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'openfda_search_animal_events',
    format: searchAnimalEventsTool.format as never,
    result: {
      meta: META,
      results: [
        {
          unique_aer_id_number: 'VET-1',
          original_receive_date: '20260401',
          serious_ae: 'true',
          primary_reporter: 'Veterinarian',
          secondary_reporter: 'SECONDARY-MARKER',
          type_of_information: 'Safety Issue',
          foreign_or_domestic: 'Domestic',
          treated_for_ae: 'TREATED-MARKER',
          health_assessment_prior_to_exposure: {
            condition: 'Good',
            assessed_by: 'ASSESSOR-MARKER',
          },
          receiver: { organization: 'ORG-MARKER', city: 'CITY-MARKER', state: 'STATE-MARKER' },
          animal: {
            species: 'Dog',
            gender: 'Female',
            breed: { breed_component: 'Beagle', is_crossbred: 'CROSSBRED-MARKER' },
            age: { min: '4', unit: 'Year', qualifier: 'AGEQUAL-MARKER' },
            weight: { min: '12', unit: 'Kilogram', qualifier: 'WTQUAL-MARKER' },
            female_animal_physiological_status: 'PHYSIO-MARKER',
          },
          reaction: [{ veddra_term_name: 'Vomiting', veddra_term_code: 'VEDDRA-MARKER' }],
          drug: [
            {
              brand_name: 'DRUGBRAND-MARKER',
              route: 'Oral',
              administered_by: 'Owner',
              lot_number: 'LOT-MARKER',
              dosage_form: 'DOSAGEFORM-MARKER',
              manufacturer: { registration_number: 'REG-MARKER' },
              active_ingredients: [{ name: 'INGREDIENT-MARKER', dose: { numerator_unit: 'MG' } }],
            },
          ],
          outcome: [{ medical_status: 'Recovered', number_of_animals_affected: 'AFFECTED-MARKER' }],
        },
      ],
    },
  },
  {
    name: 'openfda_search_drug_approvals',
    format: searchDrugApprovalsTool.format as never,
    result: {
      meta: META,
      results: [
        {
          application_number: 'BLA125057',
          sponsor_name: 'SPONSOR-MARKER',
          openfda: {
            // Multi-entry: the curated line shows entry 0 only.
            brand_name: ['HUMIRA', 'SECONDBRAND-MARKER'],
            generic_name: ['adalimumab', 'SECONDGENERIC-MARKER'],
            manufacturer_name: ['MANUFACTURER-MARKER'],
            route: ['SUBCUTANEOUS'],
          },
          products: [
            {
              product_number: 'PRODNUM-MARKER',
              brand_name: 'HUMIRA',
              dosage_form: 'INJECTION',
              marketing_status: 'Prescription',
              reference_drug: 'REFDRUG-MARKER',
              active_ingredients: [{ name: 'ADALIMUMAB', strength: '40MG/0.8ML' }],
            },
          ],
          submissions: [
            {
              submission_type: 'ORIG',
              submission_number: '1',
              submission_status: 'AP',
              submission_status_date: '20021231',
              submission_class_code: 'CLASSCODE-MARKER',
              application_docs: [
                { id: 'DOCID-MARKER', url: 'https://example.test/DOCURL-MARKER', type: 'Label' },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'openfda_search_drug_shortages',
    format: searchDrugShortagesTool.format as never,
    result: {
      meta: META,
      results: [
        {
          generic_name: 'Carboplatin Injection',
          status: 'Current',
          company_name: 'COMPANY-MARKER',
          shortage_reason: 'REASON-MARKER',
          openfda: {
            brand_name: ['PARAPLATIN'],
            product_ndc: ['NDC-ONE-MARKER', 'NDC-TWO-MARKER'],
            package_ndc: ['PKG-NDC-MARKER'],
            rxcui: ['RXCUI-MARKER'],
            spl_set_id: ['SPLSET-MARKER'],
            unii: ['UNII-MARKER'],
            application_number: ['APPNUM-MARKER'],
          },
        },
      ],
    },
  },
  {
    name: 'openfda_search_device_clearances (510k)',
    format: searchDeviceClearancesTool.format as never,
    result: {
      meta: META,
      results: [
        {
          k_number: 'K260001',
          device_name: 'DEVICENAME-MARKER',
          applicant: 'APPLICANT-MARKER',
          product_code: 'PRODCODE-MARKER',
          decision_description: 'Substantially Equivalent',
          decision_date: '20260201',
          advisory_committee: 'ADVCOMMITTEE-MARKER',
          advisory_committee_description: 'Cardiovascular',
          clearance_type: 'Traditional',
          openfda: { device_class: 'CLASS-MARKER', regulation_number: 'REGNUM-MARKER' },
        },
      ],
    },
  },
  {
    name: 'openfda_search_device_clearances (pma)',
    format: searchDeviceClearancesTool.format as never,
    result: {
      meta: META,
      results: [
        {
          pma_number: 'P260001',
          trade_name: 'TRADENAME-MARKER',
          generic_name: 'GENERICNAME-MARKER',
          applicant: 'APPLICANT-MARKER',
          product_code: 'PRODCODE-MARKER',
          decision_description: 'Approved',
          decision_code: 'DECISIONCODE-MARKER',
          decision_date: '20260301',
          advisory_committee: 'ADVCOMMITTEE-MARKER',
          supplement_number: 'S001',
        },
      ],
    },
  },
  {
    name: 'openfda_search_recalls',
    format: searchRecallsTool.format as never,
    result: {
      meta: META,
      results: [
        {
          recall_number: 'D-0001-2026',
          classification: 'Class II',
          recalling_firm: 'FIRM-MARKER',
          product_description: 'PRODUCT-MARKER',
          reason_for_recall: 'REASON-MARKER',
          status: 'Ongoing',
          voluntary_mandated: 'Voluntary: Firm initiated',
          distribution_pattern: 'DISTRIBUTION-MARKER',
          openfda: { brand_name: ['BRAND-MARKER'], rxcui: ['RXCUI-MARKER'] },
        },
      ],
    },
  },
  {
    name: 'openfda_search_tobacco_reports',
    format: searchTobaccoReportsTool.format as never,
    result: {
      meta: META,
      results: [
        {
          report_id: 'TOB-1',
          date_submitted: '20260501',
          nonuser_affected: 'No',
          tobacco_products: ['PRODUCT-MARKER'],
          reported_health_problems: ['HEALTH-MARKER'],
          reported_product_problems: ['No information provided'],
          number_tobacco_products: 1,
          number_health_problems: 0,
          number_product_problems: 0,
        },
      ],
    },
  },
  {
    name: 'openfda_lookup_ndc',
    format: lookupNdcTool.format as never,
    result: {
      meta: META,
      results: [
        {
          product_ndc: '0363-0218',
          brand_name: 'BRAND-MARKER',
          generic_name: 'GENERIC-MARKER',
          labeler_name: 'LABELER-MARKER',
          route: ['ORAL'],
          marketing_category: 'CATEGORY-MARKER',
          active_ingredients: [{ name: 'ASPIRIN', strength: '325 mg/1' }],
          packaging: [
            {
              package_ndc: 'PKGNDC-MARKER',
              description: 'DESCRIPTION-MARKER',
              marketing_start_date: 'STARTDATE-MARKER',
              sample: 'SAMPLE-MARKER',
            },
          ],
          openfda: { spl_set_id: ['SPLSET-MARKER'] },
        },
      ],
    },
  },
  {
    name: 'openfda_lookup_ndc (route without dosage_form)',
    format: lookupNdcTool.format as never,
    result: {
      meta: META,
      results: [
        {
          product_ndc: '1111-2222',
          brand_name: 'NOFORM-MARKER',
          labeler_name: 'LABELER-MARKER',
          route: ['ROUTEONLY-MARKER'],
        },
      ],
    },
  },
  {
    name: 'openfda_get_drug_label',
    format: getDrugLabelTool.format as never,
    result: {
      meta: META,
      kind: 'full',
      results: [
        {
          set_id: 'SETID-MARKER',
          // Distinct from set_id: a value that is a substring of another leaf
          // passes the containment check on that other leaf's rendering.
          id: 'DOCUMENTID-MARKER',
          effective_time: '20260601',
          version: '3',
          openfda: {
            // Multi-entry: the header line shows entry 0 only.
            brand_name: ['BRAND-MARKER', 'SECONDBRAND-MARKER'],
            generic_name: ['GENERIC-MARKER', 'SECONDGENERIC-MARKER'],
            manufacturer_name: ['MFR-MARKER', 'SECONDMFR-MARKER'],
            substance_name: ['SUBSTANCE-MARKER'],
          },
          boxed_warning: [`BOXED-MARKER ${'x'.repeat(1500)}`],
          spl_product_data_elements: ['SPLDATA-MARKER'],
        },
      ],
    },
  },
  {
    name: 'openfda_dataframe_query',
    format: dataframeQueryTool.format as never,
    result: {
      rows: [
        { classification: 'Class I', n: 12, openfda: { brand_name: ['NESTED-MARKER'] } },
        { classification: 'Class II', n: 3, extra_column: 'LATEROW-MARKER' },
      ],
      row_count: 2,
      truncated: false,
      canvas_id: 'cv_parity',
    },
  },
];

describe.each(CASES.map((c) => [c.name, c] as const))(
  '%s — every structured leaf reaches content[]',
  (_name, testCase) => {
    it('renders every scalar leaf of the record', () => {
      const text = testCase
        .format(testCase.result as never)
        .map((b) => b.text)
        .join('\n');

      const found: Array<{ path: string; value: string }> = [];
      const payload = testCase.result as { results?: unknown; rows?: unknown };
      leaves(payload.results ?? payload.rows, '', found);

      const missing = found.filter((leaf) => !rendered(text, leaf.value));
      expect(missing.map((m) => `${m.path}=${m.value}`)).toEqual([]);
    });
  },
);

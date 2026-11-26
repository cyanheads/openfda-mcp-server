/**
 * @fileoverview Staged-table columns for openfda_search_adverse_events on its
 * drug and device categories (#105). Runs the real staging path end to end —
 * the tool handler, the real `spillSearch` drain, and a real DataCanvas
 * (framework CanvasRegistry + DuckDB provider) — with only the openFDA service
 * stubbed, then reads the tables back through openfda_dataframe_describe and
 * openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/search-adverse-events-staging-columns.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Records per endpoint the stubbed openFDA service pages over, and an optional reported total. */
const DATASETS: Record<string, { rows: Record<string, unknown>[]; total?: number }> = {};

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(async (endpoint: string, params: { limit?: number; skip?: number }) => {
      const { rows, total } = DATASETS[endpoint] ?? { rows: [] };
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      return {
        meta: { total: total ?? rows.length, skip, limit, lastUpdated: '2026-11-18' },
        results: structuredClone(rows.slice(skip, skip + limit)),
      };
    }),
  }),
  initOpenFdaService: () => {},
}));

import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { textOf } from '../../../helpers/content.js';
import {
  DUCKDB_SUITE,
  describeStagedTable,
  installStagingCanvas,
  queryStagedRows,
  shutdownStagingCanvas,
} from '../../../helpers/staging-canvas.js';

const TENANT = 'adverse-events-staging-columns';

/** The keys a live device report carries as `''`. */
const blank = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, '']));

/* --- drug/event fixtures (live 2026-11-22) --- */

/**
 * Live 17221437 (`receivedate:[2020]`): 26 of the 27 top-level fields, every
 * seriousness flag, `reportduplicate` as an array. Reactions, drugs, duplicates,
 * and each drug's fields and openfda lists trimmed.
 */
const DRUG_DENSE = {
  safetyreportid: '17221437',
  safetyreportversion: '2',
  reporttype: '1',
  fulfillexpeditecriteria: '1',
  receivedate: '20200101',
  receivedateformat: '102',
  receiptdate: '20230413',
  receiptdateformat: '102',
  transmissiondate: '20230722',
  transmissiondateformat: '102',
  serious: '1',
  seriousnessdeath: '2',
  seriousnesshospitalization: '2',
  seriousnesslifethreatening: '2',
  seriousnessdisabling: '2',
  seriousnesscongenitalanomali: '2',
  seriousnessother: '1',
  occurcountry: 'DE',
  primarysourcecountry: 'DE',
  companynumb: 'DE-NOVPHSZ-PHHY2019DE122528',
  duplicate: '1',
  reportduplicate: [
    { duplicatesource: '002147023', duplicatenumb: 'DE-002147023-PHHY2019DE122528' },
    { duplicatesource: 'EMA', duplicatenumb: 'DE-EMA-DD-20230331-7180171-153111' },
  ],
  primarysource: { reportercountry: 'DE', qualification: '1' },
  sender: { sendertype: '2', senderorganization: 'FDA-Public Use' },
  receiver: { receivertype: '6', receiverorganization: 'FDA' },
  patient: {
    patientonsetage: '61',
    patientonsetageunit: '801',
    patientsex: '2',
    reaction: [
      { reactionmeddraversionpt: '26.0', reactionmeddrapt: 'Rhabdomyolysis', reactionoutcome: '6' },
      {
        reactionmeddraversionpt: '26.0',
        reactionmeddrapt: 'Full blood count abnormal',
        reactionoutcome: '6',
      },
    ],
    drug: [
      {
        drugcharacterization: '1',
        medicinalproduct: 'AMLODIPINE',
        drugadministrationroute: '065',
        activesubstance: { activesubstancename: 'AMLODIPINE BESYLATE' },
        openfda: {
          application_number: ['NDA219531', 'NDA214439'],
          brand_name: ['SDAMLO', 'NORLIQVA'],
          generic_name: ['AMLODIPINE'],
        },
      },
      {
        drugcharacterization: '1',
        medicinalproduct: 'XGEVA',
        drugadministrationroute: '065',
        activesubstance: { activesubstancename: 'DENOSUMAB' },
        openfda: {
          application_number: ['BLA125320'],
          brand_name: ['XGEVA'],
          generic_name: ['DENOSUMAB'],
        },
      },
    ],
  },
};

/**
 * Live 10041310 (`_exists_:authoritynumb`): a regulatory-authority case number,
 * `reportduplicate` as one object, no openfda block on its drug. Drug fields
 * trimmed.
 */
const DRUG_AUTHORITY = {
  safetyreportid: '10041310',
  safetyreportversion: '2',
  reporttype: '1',
  fulfillexpeditecriteria: '1',
  receivedate: '20140327',
  receivedateformat: '102',
  receiptdate: '20140714',
  receiptdateformat: '102',
  transmissiondate: '20150326',
  transmissiondateformat: '102',
  serious: '1',
  seriousnesshospitalization: '1',
  occurcountry: 'IT',
  primarysourcecountry: 'IT',
  authoritynumb: 'IT-MINISAL02-242231',
  companynumb: 'IT-BAYER-2014-041263',
  duplicate: '1',
  reportduplicate: { duplicatesource: 'BAYER', duplicatenumb: 'IT-BAYER-2014-041263' },
  primarysource: { reportercountry: 'IT', qualification: '3' },
  sender: { sendertype: '2', senderorganization: 'FDA-Public Use' },
  receiver: { receivertype: '6', receiverorganization: 'FDA' },
  patient: {
    patientonsetage: '37',
    patientonsetageunit: '801',
    patientagegroup: '5',
    patientsex: '2',
    reaction: [
      { reactionmeddraversionpt: '17.1', reactionmeddrapt: 'Vasospasm', reactionoutcome: '2' },
      { reactionmeddraversionpt: '17.1', reactionmeddrapt: 'Hypertension', reactionoutcome: '2' },
    ],
    drug: [
      {
        drugcharacterization: '1',
        medicinalproduct: 'CIPROXIN',
        drugindication: 'RENAL COLIC',
        activesubstance: { activesubstancename: 'CIPROFLOXACIN' },
      },
    ],
    summary: { narrativeincludeclinical: 'CASE EVENT DATE: 20140303' },
  },
};

/**
 * Live 6760203-8 (`receivedate:[2010]`) as returned: 14 top-level fields — no
 * version, report type, country, seriousness flag, or duplicate, and
 * `receiver: null`.
 */
const DRUG_SPARSE = {
  safetyreportid: '6760203-8',
  transmissiondateformat: '102',
  transmissiondate: '20101027',
  serious: '2',
  receivedateformat: '102',
  receivedate: '20100608',
  receiptdateformat: '102',
  receiptdate: '19991018',
  fulfillexpeditecriteria: '2',
  companynumb: '1999SUS1230',
  primarysource: { reportercountry: 'UNITED STATES' },
  sender: { senderorganization: 'FDA-Public Use' },
  receiver: null,
  patient: {
    patientsex: '2',
    reaction: [{ reactionmeddrapt: 'PREGNANCY' }],
    drug: [
      {
        drugcharacterization: '1',
        medicinalproduct: 'SUSTIVA',
        drugauthorizationnumb: '020972',
        drugindication: 'ADVERSE EVENT',
      },
    ],
  },
};

const DRUG_RECORDS = [DRUG_DENSE, DRUG_AUTHORITY, DRUG_SPARSE];

/* --- device/event fixtures (live 2026-11-22) --- */

/**
 * Live 2032227-2020-110181 (`date_received:[2020]`), a manufacturer report: 86
 * of the 90 top-level fields. Its device, patient, and narratives trimmed, and
 * the contact person's name left out.
 */
const DEVICE_MANUFACTURER = {
  report_number: '2032227-2020-110181',
  mdr_report_key: '10000019',
  report_source_code: 'Manufacturer report',
  mfr_report_type: 'Thirty-Day',
  summary_report_flag: 'N',
  noe_summarized: '1',
  event_type: 'Malfunction',
  adverse_event_flag: 'N',
  product_problem_flag: 'Y',
  previous_use_code: 'U',
  single_use_flag: 'N',
  reprocessed_and_reused_flag: 'N',
  removal_correction_number: 'Z-0956-2020',
  date_received: '20200427',
  date_of_event: '20200308',
  date_report: '20220508',
  date_manufacturer_received: '20200423',
  device_date_of_manufacturer: '20181214',
  date_added: '20200427',
  date_changed: '20250807',
  suppl_dates_fda_received: '05/08/2022',
  suppl_dates_mfr_received: '10/14/2019',
  reporter_occupation_code: 'OTHER',
  health_professional: 'N',
  initial_report_to_fda: 'No',
  reporter_country_code: 'US',
  reporter_state_code: 'VA',
  manufacturer_link_flag: 'Y',
  manufacturer_contact_address_1: 'CEIBA NORTE IND. PARK #50 ROAD',
  manufacturer_contact_city: 'JUNCOS',
  manufacturer_contact_zip_code: '00777',
  manufacturer_contact_zip_ext: '-386',
  manufacturer_contact_postal_code: '00777-3869',
  manufacturer_contact_pcity: '81854648',
  manufacturer_contact_area_code: '818',
  manufacturer_contact_exchange: '818',
  manufacturer_contact_phone_number: '8185',
  manufacturer_contact_plocal: '8185464805',
  manufacturer_g1_name: 'MEDTRONIC PUERTO RICO OPERATIONS CO.',
  manufacturer_g1_address_1: 'CEIBA NORTE IND. PARK #50 ROAD',
  manufacturer_g1_city: 'JUNCOS',
  manufacturer_g1_zip_code: '00777',
  manufacturer_g1_zip_code_ext: '-386',
  manufacturer_g1_postal_code: '00777-3869',
  ...blank(
    'event_key',
    'event_location',
    'number_devices_in_event',
    'number_patients_in_event',
    'report_to_fda',
    'report_to_manufacturer',
    'pma_pmn_number',
    'exemption_number',
    'manufacturer_name',
    'manufacturer_address_1',
    'manufacturer_address_2',
    'manufacturer_city',
    'manufacturer_state',
    'manufacturer_zip_code',
    'manufacturer_zip_code_ext',
    'manufacturer_postal_code',
    'manufacturer_country',
    'manufacturer_contact_t_name',
    'manufacturer_contact_address_2',
    'manufacturer_contact_state',
    'manufacturer_contact_country',
    'manufacturer_contact_pcountry',
    'manufacturer_contact_extension',
    'manufacturer_g1_address_2',
    'manufacturer_g1_state',
    'manufacturer_g1_country',
    'distributor_name',
    'distributor_address_1',
    'distributor_address_2',
    'distributor_city',
    'distributor_state',
    'distributor_zip_code',
    'distributor_zip_code_ext',
  ),
  device: [
    {
      brand_name: 'PUMP MMT-1780KPK 670G PATHWAY BLACK MG',
      generic_name: 'ARTIFICIAL PANCREAS DEVICE SYSTEM, SINGLE HORMONAL CONTROL',
      manufacturer_d_name: 'MEDTRONIC PUERTO RICO OPERATIONS CO.',
      model_number: 'MMT-1780KPK',
      lot_number: 'HG31DTM',
      device_report_product_code: 'OZP',
      udi_di: '00763000190460',
      openfda: {
        device_name: 'Automated Insulin Dosing Device System, Single Hormonal Control',
        device_class: '3',
        fei_number: ['3003166194'],
      },
    },
  ],
  patient: [
    {
      patient_sequence_number: '1',
      sequence_number_outcome: [''],
      patient_age: '63 YR',
      patient_sex: 'Female',
      patient_problems: ['No Consequences Or Impact To Patient'],
    },
  ],
  mdr_text: [
    {
      mdr_text_key: '189074097',
      text_type_code: 'Additional Manufacturer Narrative',
      patient_sequence_number: '1',
      text: 'UNABLE TO PERFORM DISPLACEMENT TEST DUE TO MISSING RETAINER. THE',
    },
    {
      mdr_text_key: '189074098',
      text_type_code: 'Description of Event or Problem',
      patient_sequence_number: '1',
      text: 'INFORMATION RECEIVED BY MEDTRONIC INDICATED THAT THE INSULIN PUM',
    },
  ],
  product_problems: ['Patient Device Interaction Problem', 'Patient Device Interaction Problem'],
  remedial_action: ['Recall'],
  source_type: ['Consumer'],
  type_of_report: ['Initial submission', 'Followup'],
};

/**
 * Live 2182863-2000-00001 (`date_received:[2000]`), a report carrying the
 * facility-aware and report-to dates: 88 of the 90 top-level fields. Device,
 * patient, and narrative trimmed.
 */
const DEVICE_FACILITY_DATES = {
  report_number: '2182863-2000-00001',
  mdr_report_key: '257423',
  report_source_code: 'Manufacturer report',
  mfr_report_type: 'Thirty-Day',
  summary_report_flag: 'N',
  noe_summarized: '1',
  event_type: 'Injury',
  adverse_event_flag: 'Y',
  product_problem_flag: 'N',
  event_location: 'HOSPITAL',
  date_received: '20000104',
  date_of_event: '19991221',
  date_report: '20000104',
  report_date: '20000104',
  date_facility_aware: '19991222',
  date_report_to_fda: '20000104',
  date_report_to_manufacturer: '20000104',
  date_added: '20000106',
  date_changed: '20250725',
  suppl_dates_fda_received: '*',
  suppl_dates_mfr_received: '*',
  reporter_occupation_code: 'PHYSICIAN',
  report_to_fda: 'Y',
  reporter_country_code: 'US',
  reporter_state_code: 'SC',
  manufacturer_link_flag: 'Y',
  ...blank(
    'event_key',
    'number_devices_in_event',
    'number_patients_in_event',
    'previous_use_code',
    'single_use_flag',
    'reprocessed_and_reused_flag',
    'removal_correction_number',
    'health_professional',
    'initial_report_to_fda',
    'report_to_manufacturer',
    'pma_pmn_number',
    'exemption_number',
    'manufacturer_name',
    'manufacturer_address_1',
    'manufacturer_address_2',
    'manufacturer_city',
    'manufacturer_state',
    'manufacturer_zip_code',
    'manufacturer_zip_code_ext',
    'manufacturer_postal_code',
    'manufacturer_country',
    'manufacturer_contact_t_name',
    'manufacturer_contact_f_name',
    'manufacturer_contact_l_name',
    'manufacturer_contact_address_1',
    'manufacturer_contact_address_2',
    'manufacturer_contact_city',
    'manufacturer_contact_state',
    'manufacturer_contact_zip_code',
    'manufacturer_contact_zip_ext',
    'manufacturer_contact_postal_code',
    'manufacturer_contact_country',
    'manufacturer_contact_pcity',
    'manufacturer_contact_pcountry',
    'manufacturer_contact_area_code',
    'manufacturer_contact_exchange',
    'manufacturer_contact_phone_number',
    'manufacturer_contact_extension',
    'manufacturer_contact_plocal',
    'manufacturer_g1_name',
    'manufacturer_g1_address_1',
    'manufacturer_g1_address_2',
    'manufacturer_g1_city',
    'manufacturer_g1_state',
    'manufacturer_g1_zip_code',
    'manufacturer_g1_zip_code_ext',
    'manufacturer_g1_postal_code',
    'manufacturer_g1_country',
    'distributor_name',
    'distributor_address_1',
    'distributor_address_2',
    'distributor_city',
    'distributor_state',
    'distributor_zip_code',
    'distributor_zip_code_ext',
  ),
  device: [
    {
      brand_name: 'CHORUS RM',
      generic_name: 'CARDIAC PACEMAKER',
      manufacturer_d_name: 'ELA MEDICAL, S.A.',
      manufacturer_d_country: 'FR',
      model_number: '7034',
      expiration_date_of_device: '19990530',
      device_report_product_code: 'DXY',
      openfda: {
        device_name: 'Implantable Pacemaker Pulse-Generator',
        regulation_number: '870.3610',
        device_class: '3',
      },
    },
  ],
  patient: [
    {
      patient_sequence_number: '1',
      sequence_number_outcome: ['Hospitalization', ' R'],
      patient_age: '80 YR',
      patient_problems: ['Erosion', 'Unspecified Infection'],
    },
  ],
  mdr_text: [
    {
      mdr_text_key: '176499',
      text_type_code: 'Description of Event or Problem',
      patient_sequence_number: '1',
      text: 'AFTER 16 MONTHS OF IMPLANTATION, THIS PACEMAKER WAS REMOVED. ACC',
    },
  ],
  product_problems: [
    'Material Erosion',
    'Explanted',
    'Premature explantation',
    'Device Damaged Prior to Use',
  ],
  remedial_action: [''],
  source_type: ['Health Professional', 'Company representation'],
  type_of_report: ['Initial submission', 'Followup'],
};

/** Live voluntary report MW1004629 (`date_received:[1995]`) trimmed to nine of its fields. */
const DEVICE_SPARSE = {
  report_number: 'MW1004629',
  mdr_report_key: '18676',
  report_source_code: 'Voluntary report',
  event_type: 'Malfunction',
  date_received: '19950103',
  product_problems: ['Break'],
  device: [
    {
      brand_name: 'TRIPLE LUMEN CATHETER',
      generic_name: 'TRIPLE LUMEN CATHETER',
      manufacturer_d_name: 'ARROW INTL., INC.',
      device_report_product_code: 'DQO',
      openfda: { device_name: 'Catheter, Intravascular, Diagnostic', device_class: '2' },
    },
  ],
  patient: [{ patient_sequence_number: '1', sequence_number_outcome: [''], patient_age: '74 YR' }],
  mdr_text: [
    {
      text_type_code: 'Description of Event or Problem',
      text: 'WHILE CHANGING TUBING ON MEDIAL PORT OF TRIPLE LUMEN CATHETER, T',
    },
  ],
};

const DEVICE_RECORDS = [DEVICE_MANUFACTURER, DEVICE_FACILITY_DATES, DEVICE_SPARSE];

/* --- column lists --- */

type Column = { name: string; type: 'VARCHAR' | 'JSON' };
const columnList = (type: Column['type'], ...names: string[]): Column[] =>
  names.map((name) => ({ name, type }));

/** The 0.10.0 drug columns the endpoint returns, in 0.10.0 order — kept with name and type. */
const DRUG_RELEASED: Column[] = [
  ...columnList(
    'VARCHAR',
    'safetyreportid',
    'receivedate',
    'receiptdate',
    'serious',
    'seriousnessdeath',
    'seriousnesshospitalization',
    'occurcountry',
    'primarysourcecountry',
    'companynumb',
  ),
  { name: 'patient', type: 'JSON' },
];

/** The 0.10.0 device columns the endpoint returns, in 0.10.0 order — kept with name and type. */
const DEVICE_RELEASED: Column[] = [
  ...columnList(
    'VARCHAR',
    'report_number',
    'mdr_report_key',
    'event_type',
    'date_received',
    'date_of_event',
    'manufacturer_name',
  ),
  ...columnList('JSON', 'device', 'patient', 'mdr_text'),
];

/** Every top-level field drug/event returns (27, live 2026-11-22), in staged order. */
const DRUG_COLUMNS: Column[] = [
  ...columnList(
    'VARCHAR',
    'safetyreportid',
    'safetyreportversion',
    'reporttype',
    'fulfillexpeditecriteria',
    'receivedate',
    'receivedateformat',
    'receiptdate',
    'receiptdateformat',
    'transmissiondate',
    'transmissiondateformat',
    'serious',
    'seriousnessdeath',
    'seriousnesshospitalization',
    'seriousnesslifethreatening',
    'seriousnessdisabling',
    'seriousnesscongenitalanomali',
    'seriousnessother',
    'occurcountry',
    'primarysourcecountry',
    'companynumb',
    'authoritynumb',
    'duplicate',
  ),
  ...columnList('JSON', 'patient', 'primarysource', 'sender', 'receiver', 'reportduplicate'),
];

/** Every top-level field device/event returns (90, live 2026-11-22), in staged order. */
const DEVICE_COLUMNS: Column[] = [
  ...columnList(
    'VARCHAR',
    'report_number',
    'mdr_report_key',
    'event_key',
    'report_source_code',
    'mfr_report_type',
    'summary_report_flag',
    'noe_summarized',
    'event_type',
    'adverse_event_flag',
    'product_problem_flag',
    'event_location',
    'number_devices_in_event',
    'number_patients_in_event',
    'previous_use_code',
    'single_use_flag',
    'reprocessed_and_reused_flag',
    'removal_correction_number',
    'date_received',
    'date_of_event',
    'date_report',
    'report_date',
    'date_facility_aware',
    'date_manufacturer_received',
    'date_report_to_fda',
    'date_report_to_manufacturer',
    'device_date_of_manufacturer',
    'date_added',
    'date_changed',
    'suppl_dates_fda_received',
    'suppl_dates_mfr_received',
    'reporter_occupation_code',
    'health_professional',
    'initial_report_to_fda',
    'report_to_fda',
    'report_to_manufacturer',
    'reporter_country_code',
    'reporter_state_code',
    'pma_pmn_number',
    'exemption_number',
    'manufacturer_name',
    'manufacturer_address_1',
    'manufacturer_address_2',
    'manufacturer_city',
    'manufacturer_state',
    'manufacturer_zip_code',
    'manufacturer_zip_code_ext',
    'manufacturer_postal_code',
    'manufacturer_country',
    'manufacturer_link_flag',
    'manufacturer_contact_t_name',
    'manufacturer_contact_f_name',
    'manufacturer_contact_l_name',
    'manufacturer_contact_address_1',
    'manufacturer_contact_address_2',
    'manufacturer_contact_city',
    'manufacturer_contact_state',
    'manufacturer_contact_zip_code',
    'manufacturer_contact_zip_ext',
    'manufacturer_contact_postal_code',
    'manufacturer_contact_country',
    'manufacturer_contact_pcity',
    'manufacturer_contact_pcountry',
    'manufacturer_contact_area_code',
    'manufacturer_contact_exchange',
    'manufacturer_contact_phone_number',
    'manufacturer_contact_extension',
    'manufacturer_contact_plocal',
    'manufacturer_g1_name',
    'manufacturer_g1_address_1',
    'manufacturer_g1_address_2',
    'manufacturer_g1_city',
    'manufacturer_g1_state',
    'manufacturer_g1_zip_code',
    'manufacturer_g1_zip_code_ext',
    'manufacturer_g1_postal_code',
    'manufacturer_g1_country',
    'distributor_name',
    'distributor_address_1',
    'distributor_address_2',
    'distributor_city',
    'distributor_state',
    'distributor_zip_code',
    'distributor_zip_code_ext',
  ),
  ...columnList(
    'JSON',
    'device',
    'patient',
    'mdr_text',
    'product_problems',
    'remedial_action',
    'source_type',
    'type_of_report',
  ),
];

/** Each category under test: its records, pinned columns, and the column a row is ordered by. */
const CATEGORIES = {
  drug: { records: DRUG_RECORDS, columns: DRUG_COLUMNS, key: 'safetyreportid', live: 27 },
  device: { records: DEVICE_RECORDS, columns: DEVICE_COLUMNS, key: 'report_number', live: 90 },
} as const;

beforeEach(() => {
  installStagingCanvas(TENANT);
  DATASETS['drug/event'] = { rows: DRUG_RECORDS };
  DATASETS['device/event'] = { rows: DEVICE_RECORDS };
});

afterEach(() => shutdownStagingCanvas(TENANT));

async function stage(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: searchAdverseEventsTool.errors, tenantId: TENANT });
  const result = await searchAdverseEventsTool.handler(
    searchAdverseEventsTool.input.parse({ ...input, stage: true }),
    ctx,
  );
  expect(result.spilled).toBe(true);
  return { ...result, canvas_id: result.canvas_id ?? '', canvas_table: result.canvas_table ?? '' };
}

async function columnsOf(canvasId: string, table: string): Promise<Column[]> {
  return ((await describeStagedTable(TENANT, canvasId, table))?.columns ?? []).map(
    ({ name, type }) => ({ name, type: type as Column['type'] }),
  );
}

const query = (canvasId: string, sql: string) => queryStagedRows(TENANT, canvasId, sql);

/** A JSON cell parsed back to its value; SQL NULL stays null. */
const parsed = (cell: unknown) => (cell === null ? null : JSON.parse(String(cell)));

describe('openfda_search_adverse_events staging — released columns (#105)', DUCKDB_SUITE, () => {
  it.each([
    ['drug', DRUG_RELEASED],
    ['device', DEVICE_RELEASED],
  ] as const)(
    'keeps every 0.10.0 %s column the endpoint returns, with its name and type',
    async (category, released) => {
      const staged = await stage({ category });
      const columns = await columnsOf(staged.canvas_id, staged.canvas_table);
      expect(columns).toEqual(expect.arrayContaining(released));
      // 0.10.0's relative order holds.
      const names = columns.map((c) => c.name);
      const positions = released.map((c) => names.indexOf(c.name));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    },
  );

  it('answers SQL over the 0.10.0 drug columns with the same values', async () => {
    const staged = await stage({ category: 'drug' });
    const rows = await query(
      staged.canvas_id,
      `SELECT safetyreportid, receivedate, receiptdate, serious, seriousnessdeath, seriousnesshospitalization, occurcountry, primarysourcecountry, companynumb, json_extract_string(patient, '$.reaction[1].reactionmeddrapt') AS second_reaction, json_extract_string(patient, '$.drug[0].openfda.brand_name[1]') AS second_brand, json_extract_string(patient, '$.drug[1].activesubstance.activesubstancename') AS second_substance FROM ${staged.canvas_table} ORDER BY safetyreportid`,
    );
    expect(rows).toEqual([
      {
        safetyreportid: '10041310',
        receivedate: '20140327',
        receiptdate: '20140714',
        serious: '1',
        seriousnessdeath: null,
        seriousnesshospitalization: '1',
        occurcountry: 'IT',
        primarysourcecountry: 'IT',
        companynumb: 'IT-BAYER-2014-041263',
        second_reaction: 'Hypertension',
        second_brand: null,
        second_substance: null,
      },
      {
        safetyreportid: '17221437',
        receivedate: '20200101',
        receiptdate: '20230413',
        serious: '1',
        seriousnessdeath: '2',
        seriousnesshospitalization: '2',
        occurcountry: 'DE',
        primarysourcecountry: 'DE',
        companynumb: 'DE-NOVPHSZ-PHHY2019DE122528',
        second_reaction: 'Full blood count abnormal',
        second_brand: 'NORLIQVA',
        second_substance: 'DENOSUMAB',
      },
      {
        safetyreportid: '6760203-8',
        receivedate: '20100608',
        receiptdate: '19991018',
        serious: '2',
        seriousnessdeath: null,
        seriousnesshospitalization: null,
        occurcountry: null,
        primarysourcecountry: null,
        companynumb: '1999SUS1230',
        second_reaction: null,
        second_brand: null,
        second_substance: null,
      },
    ]);
  });

  it('answers SQL over the 0.10.0 device columns with the same values', async () => {
    const staged = await stage({ category: 'device' });
    const rows = await query(
      staged.canvas_id,
      `SELECT report_number, mdr_report_key, event_type, date_received, date_of_event, manufacturer_name, json_extract_string(device, '$[0].openfda.fei_number[0]') AS fei, json_extract_string(patient, '$[0].sequence_number_outcome[1]') AS second_outcome, json_extract_string(mdr_text, '$[1].text_type_code') AS second_text_type FROM ${staged.canvas_table} ORDER BY report_number`,
    );
    expect(rows).toEqual([
      {
        report_number: '2032227-2020-110181',
        mdr_report_key: '10000019',
        event_type: 'Malfunction',
        date_received: '20200427',
        date_of_event: '20200308',
        manufacturer_name: '',
        fei: '3003166194',
        second_outcome: null,
        second_text_type: 'Description of Event or Problem',
      },
      {
        report_number: '2182863-2000-00001',
        mdr_report_key: '257423',
        event_type: 'Injury',
        date_received: '20000104',
        date_of_event: '19991221',
        manufacturer_name: '',
        fei: null,
        second_outcome: ' R',
        second_text_type: null,
      },
      {
        report_number: 'MW1004629',
        mdr_report_key: '18676',
        event_type: 'Malfunction',
        date_received: '19950103',
        date_of_event: null,
        manufacturer_name: null,
        fei: null,
        second_outcome: null,
        second_text_type: null,
      },
    ]);
  });

  it('reads the nested openfda blocks with json_extract from patient and device', async () => {
    const drug = await stage({ category: 'drug' });
    const drugRows = await query(
      drug.canvas_id,
      `SELECT safetyreportid, json_extract(patient, '$.drug[0].openfda') AS first, json_extract(patient, '$.drug[1].openfda') AS second FROM ${drug.canvas_table} ORDER BY safetyreportid`,
    );
    expect(drugRows.map((r) => [r.safetyreportid, parsed(r.first), parsed(r.second)])).toEqual([
      ['10041310', null, null],
      [
        '17221437',
        {
          application_number: ['NDA219531', 'NDA214439'],
          brand_name: ['SDAMLO', 'NORLIQVA'],
          generic_name: ['AMLODIPINE'],
        },
        { application_number: ['BLA125320'], brand_name: ['XGEVA'], generic_name: ['DENOSUMAB'] },
      ],
      ['6760203-8', null, null],
    ]);

    const device = await stage({ category: 'device', canvas_id: drug.canvas_id });
    const deviceRows = await query(
      drug.canvas_id,
      `SELECT report_number, json_extract(device, '$[0].openfda') AS openfda FROM ${device.canvas_table} ORDER BY report_number`,
    );
    expect(deviceRows.map((r) => [r.report_number, parsed(r.openfda)])).toEqual([
      [
        '2032227-2020-110181',
        {
          device_name: 'Automated Insulin Dosing Device System, Single Hormonal Control',
          device_class: '3',
          fei_number: ['3003166194'],
        },
      ],
      [
        '2182863-2000-00001',
        {
          device_name: 'Implantable Pacemaker Pulse-Generator',
          regulation_number: '870.3610',
          device_class: '3',
        },
      ],
      ['MW1004629', { device_name: 'Catheter, Intravascular, Diagnostic', device_class: '2' }],
    ]);
  });
});

describe('openfda_search_adverse_events staging — upstream fields (#105)', DUCKDB_SUITE, () => {
  it.each(['drug', 'device'] as const)(
    'stages one fixed column per top-level field %s/event returns, in schema order',
    async (category) => {
      const { columns: pinned, records, live } = CATEGORIES[category];
      const staged = await stage({ category });
      const columns = await columnsOf(staged.canvas_id, staged.canvas_table);
      expect(columns).toEqual(pinned);
      expect(columns).toHaveLength(live);
      // The fixtures are live records whose keys together cover the endpoint's fields exactly.
      expect(new Set(columns.map((c) => c.name))).toEqual(
        new Set(records.flatMap((r) => Object.keys(r))),
      );
    },
  );

  it.each(['drug', 'device'] as const)(
    'stages no top-level openfda column on %s/event — no record carries one',
    async (category) => {
      const staged = await stage({ category });
      await expect(
        query(staged.canvas_id, `SELECT openfda FROM ${staged.canvas_table}`),
      ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
    },
  );

  it.each(['drug', 'device'] as const)(
    'reads every %s column back as its record value — text verbatim, JSON whole, NULL where the record lacks the field',
    async (category) => {
      const { columns, records, key } = CATEGORIES[category];
      const staged = await stage({ category });
      const rows = await query(
        staged.canvas_id,
        `SELECT ${columns.map((c) => c.name).join(', ')} FROM ${staged.canvas_table} ORDER BY ${key}`,
      );
      const expected = [...records].sort((a, b) =>
        String(a[key as keyof typeof a]) < String(b[key as keyof typeof b]) ? -1 : 1,
      );
      expect(rows).toHaveLength(expected.length);
      for (const [i, record] of expected.entries()) {
        const row = rows[i] as Record<string, unknown>;
        for (const { name, type } of columns) {
          const value = (record as Record<string, unknown>)[name];
          const cell = type === 'JSON' ? parsed(row[name]) : row[name];
          expect(cell, `${String(record[key as keyof typeof record])}.${name}`).toEqual(
            value ?? null,
          );
        }
      }
    },
  );

  it('stages the report-level objects and the duplicate list as JSON that json_extract reads past the first level', async () => {
    const staged = await stage({ category: 'drug' });
    const rows = await query(
      staged.canvas_id,
      `SELECT safetyreportid, json_type(reportduplicate) AS duplicate_kind, json_extract_string(reportduplicate, '$[1].duplicatesource') AS second_source, json_extract_string(reportduplicate, '$.duplicatenumb') AS only_number, json_extract_string(primarysource, '$.qualification') AS qualification, json_extract_string(sender, '$.senderorganization') AS sender, json_extract_string(receiver, '$.receivertype') AS receiver_type, receiver IS NULL AS no_receiver FROM ${staged.canvas_table} ORDER BY safetyreportid`,
    );
    expect(rows).toEqual([
      {
        safetyreportid: '10041310',
        duplicate_kind: 'OBJECT',
        second_source: null,
        only_number: 'IT-BAYER-2014-041263',
        qualification: '3',
        sender: 'FDA-Public Use',
        receiver_type: '6',
        no_receiver: false,
      },
      {
        safetyreportid: '17221437',
        duplicate_kind: 'ARRAY',
        second_source: 'EMA',
        only_number: null,
        qualification: '1',
        sender: 'FDA-Public Use',
        receiver_type: '6',
        no_receiver: false,
      },
      {
        safetyreportid: '6760203-8',
        duplicate_kind: null,
        second_source: null,
        only_number: null,
        qualification: null,
        sender: 'FDA-Public Use',
        receiver_type: null,
        no_receiver: true,
      },
    ]);
  });

  it('stages the device problem, remedy, source, and report-type lists as JSON arrays', async () => {
    const staged = await stage({ category: 'device' });
    const rows = await query(
      staged.canvas_id,
      `SELECT report_number, CAST(json_array_length(product_problems) AS INTEGER) AS problems, json_extract_string(product_problems, '$[3]') AS fourth_problem, json_extract_string(remedial_action, '$[0]') AS remedy, json_extract_string(source_type, '$[1]') AS second_source, json_extract_string(type_of_report, '$[1]') AS second_type, list_contains(json_extract_string(product_problems, '$[*]'), 'Break') AS broke FROM ${staged.canvas_table} ORDER BY report_number`,
    );
    expect(rows).toEqual([
      {
        report_number: '2032227-2020-110181',
        problems: 2,
        fourth_problem: null,
        remedy: 'Recall',
        second_source: null,
        second_type: 'Followup',
        broke: false,
      },
      {
        report_number: '2182863-2000-00001',
        problems: 4,
        fourth_problem: 'Device Damaged Prior to Use',
        remedy: '',
        second_source: 'Company representation',
        second_type: 'Followup',
        broke: false,
      },
      {
        report_number: 'MW1004629',
        problems: 1,
        fourth_problem: null,
        remedy: null,
        second_source: null,
        second_type: null,
        broke: true,
      },
    ]);
  });

  it.each(['drug', 'device'] as const)(
    'stores no object or array as text in a %s VARCHAR column',
    async (category) => {
      const staged = await stage({ category });
      const columns = await columnsOf(staged.canvas_id, staged.canvas_table);
      const text = columns.filter((c) => c.type === 'VARCHAR').map((c) => c.name);
      const rows = await query(
        staged.canvas_id,
        `SELECT count(*) AS n FROM ${staged.canvas_table} WHERE ${text.map((c) => `${c} LIKE '%[object Object]%'`).join(' OR ')}`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    },
  );

  it.each([
    [
      'drug',
      [DRUG_SPARSE],
      [DRUG_DENSE, DRUG_AUTHORITY],
      'authoritynumb',
      [
        ['10041310', 'IT-MINISAL02-242231'],
        ['17221437', null],
        ['6760203-8', null],
      ],
    ],
    [
      'device',
      [DEVICE_SPARSE],
      [DEVICE_MANUFACTURER, DEVICE_FACILITY_DATES],
      'date_facility_aware',
      [
        ['2032227-2020-110181', null],
        ['2182863-2000-00001', '19991222'],
        ['MW1004629', null],
      ],
    ],
  ] as const)(
    'unions two %s stagings onto one canvas positionally, whatever fields their rows carry',
    async (category, firstRows, secondRows, column, values) => {
      const endpoint = `${category}/event`;
      const { key } = CATEGORIES[category];
      DATASETS[endpoint] = { rows: [...firstRows] };
      const first = await stage({ category });
      DATASETS[endpoint] = { rows: [...secondRows] };
      const second = await stage({ category, canvas_id: first.canvas_id });
      expect(second.canvas_id).toBe(first.canvas_id);

      const [firstColumns, secondColumns] = await Promise.all([
        columnsOf(first.canvas_id, first.canvas_table),
        columnsOf(first.canvas_id, second.canvas_table),
      ]);
      expect(secondColumns).toEqual(firstColumns);

      const rows = await query(
        first.canvas_id,
        `SELECT ${key} AS id, ${column} AS value FROM (SELECT * FROM ${first.canvas_table} UNION ALL SELECT * FROM ${second.canvas_table}) ORDER BY ${key}`,
      );
      expect(rows.map((r) => [r.id, r.value])).toEqual(values);
    },
  );

  it.each([
    ['drug', DRUG_DENSE, '17221437'],
    ['device', DEVICE_MANUFACTURER, '2032227-2020-110181'],
  ] as const)(
    'leaves the %s inline page, staged_rows, and truncated as the drain reports them',
    async (category, firstRecord, id) => {
      const staged = await stage({ category, limit: 1 });
      expect(staged.results).toHaveLength(1);
      // Every top-level field of the record stays on the inline record.
      expect(Object.keys(staged.results[0] ?? {}).sort()).toEqual(Object.keys(firstRecord).sort());
      expect(staged.staged_rows).toBe(3);
      expect(staged).not.toHaveProperty('truncated');

      const text = textOf(searchAdverseEventsTool.format!(staged));
      expect(text).toContain(`canvas table \`${staged.canvas_table}\``);
      expect(text).toContain(`### Report ${id}`);
    },
  );

  it.each(['drug', 'device'] as const)(
    'reports a %s staging the drain stopped short of as truncated, with the rows it staged',
    async (category) => {
      const endpoint = `${category}/event`;
      DATASETS[endpoint] = { rows: [...CATEGORIES[category].records], total: 10 };
      const staged = await stage({ category });
      expect(staged.staged_rows).toBe(3);
      expect(staged.truncated).toBe(true);
      // openFDA served fewer records than it counted; none of the drain's own bounds stopped it.
      expect(staged.truncated_by).toBe('upstream_end');
      expect(staged.meta.total).toBe(10);
    },
  );
});

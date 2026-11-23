/**
 * @fileoverview Staged-table columns for openfda_search_device_clearances, one
 * column list per pathway (#96, #105). Runs the real staging path end to end —
 * the tool handler, the real `spillSearch` drain, and a real DataCanvas
 * (framework CanvasRegistry + DuckDB provider) — with only the openFDA service
 * stubbed, then reads the table back through openfda_dataframe_describe and
 * openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/search-device-clearances-staging-columns.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Records per endpoint the stubbed openFDA service pages over. */
const DATASETS: Record<string, Record<string, unknown>[]> = {};

/** Every request the stubbed service received, in order. */
const CALLS: { endpoint: string; sort: string | undefined }[] = [];

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(
      async (endpoint: string, params: { limit?: number; skip?: number; sort?: string }) => {
        CALLS.push({ endpoint, sort: params.sort });
        const rows = DATASETS[endpoint] ?? [];
        const skip = params.skip ?? 0;
        const limit = params.limit ?? 1000;
        return {
          meta: { total: rows.length, skip, limit, lastUpdated: '2026-11-09' },
          results: structuredClone(rows.slice(skip, skip + limit)),
        };
      },
    ),
  }),
  initOpenFdaService: () => {},
}));

import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import {
  LIVE_510K,
  LIVE_CLASSIFICATION,
  LIVE_PMA,
  SPARSE_510K,
  SPARSE_CLASSIFICATION,
  SPARSE_PMA,
} from '../../../fixtures/device-records.js';
import { textOf } from '../../../helpers/content.js';
import {
  DUCKDB_SUITE,
  installStagingCanvas,
  queryStaged,
  shutdownStagingCanvas,
} from '../../../helpers/staging-canvas.js';

const TENANT = 'device-clearances-staging-columns';

/** Every top-level field `device/510k` returns (24, verified live 2026-11-22). */
const K510_COLUMNS = [
  'k_number',
  'device_name',
  'applicant',
  'contact',
  'product_code',
  'decision_date',
  'decision_code',
  'decision_description',
  'advisory_committee',
  'advisory_committee_description',
  'review_advisory_committee',
  'clearance_type',
  'date_received',
  'third_party_flag',
  'expedited_review_flag',
  'statement_or_summary',
  'address_1',
  'address_2',
  'city',
  'state',
  'zip_code',
  'postal_code',
  'country_code',
  'openfda',
];

/** Every top-level field `device/pma` returns (24, verified live 2026-11-22). */
const PMA_COLUMNS = [
  'pma_number',
  'supplement_number',
  'supplement_type',
  'supplement_reason',
  'trade_name',
  'generic_name',
  'applicant',
  'product_code',
  'decision_date',
  'decision_code',
  'advisory_committee',
  'advisory_committee_description',
  'date_received',
  'expedited_review_flag',
  'docket_number',
  'fed_reg_notice_date',
  'ao_statement',
  'street_1',
  'street_2',
  'city',
  'state',
  'zip',
  'zip_ext',
  'openfda',
];

/** Every top-level field `device/classification` returns (17, on all 7,103 records). */
const CLASSIFICATION_COLUMNS = [
  'product_code',
  'device_name',
  'device_class',
  'regulation_number',
  'submission_type_id',
  'definition',
  'medical_specialty',
  'medical_specialty_description',
  'review_panel',
  'review_code',
  'implant_flag',
  'life_sustain_support_flag',
  'gmp_exempt_flag',
  'third_party_flag',
  'summary_malfunction_reporting',
  'unclassified_reason',
  'openfda',
];

beforeEach(() => {
  installStagingCanvas(TENANT);
  DATASETS['device/510k'] = [...LIVE_510K, SPARSE_510K];
  DATASETS['device/pma'] = [...LIVE_PMA, SPARSE_PMA];
  DATASETS['device/classification'] = [...LIVE_CLASSIFICATION, SPARSE_CLASSIFICATION];
  CALLS.length = 0;
});

afterEach(() => shutdownStagingCanvas(TENANT));

async function stage(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: searchDeviceClearancesTool.errors, tenantId: TENANT });
  const result = await searchDeviceClearancesTool.handler(
    searchDeviceClearancesTool.input.parse({ ...input, stage: true }),
    ctx,
  );
  expect(result.spilled).toBe(true);
  return result as typeof result & { canvas_id: string; canvas_table: string };
}

async function columnsOf(canvasId: string, table: string) {
  const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: TENANT });
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ canvas_id: canvasId }),
    ctx,
  );
  const found = result.tables.find((t) => t.name === table);
  return {
    columns: found?.columns ?? [],
    rowCount: found?.row_count,
    text: textOf(dataframeDescribeTool.format!(result)),
  };
}

const query = (canvasId: string, sql: string) => queryStaged(TENANT, canvasId, sql);

/*
 * The columns both pathways staged in 0.10.0 and still return: same names, same
 * values, so SQL written against them reads what it read before.
 */
describe(
  'device clearances staging — the columns 0.10.0 staged (characterization)',
  DUCKDB_SUITE,
  () => {
    it('reads the 510(k) identity, decision, committee, and openfda columns back unchanged', async () => {
      const staged = await stage({ pathway: '510k' });
      const rows = await query(
        staged.canvas_id,
        `SELECT k_number, device_name, applicant, product_code, decision_date, decision_code, decision_description, advisory_committee, advisory_committee_description, clearance_type, date_received, state, country_code, expedited_review_flag, json_extract_string(openfda, '$.device_class') AS device_class FROM ${staged.canvas_table} ORDER BY k_number`,
      );
      expect(rows.rows).toEqual([
        {
          k_number: 'K000017',
          device_name: 'Catheter, Intravascular',
          applicant: 'Example Medical',
          product_code: 'DQO',
          decision_date: '1976-08-02',
          decision_code: 'SESE',
          decision_description: 'Substantially Equivalent',
          advisory_committee: 'CV',
          advisory_committee_description: 'Cardiovascular',
          clearance_type: 'Traditional',
          date_received: '1976-06-01',
          state: null,
          country_code: 'US',
          expedited_review_flag: null,
          device_class: null,
        },
        {
          k_number: 'K260132',
          device_name: 'Jason membrane',
          applicant: 'Botiss Biomaterials GmbH',
          product_code: 'NPL',
          decision_date: '2026-11-08',
          decision_code: 'SESE',
          decision_description: 'Substantially Equivalent',
          advisory_committee: 'DE',
          advisory_committee_description: 'Dental',
          clearance_type: 'Traditional',
          date_received: '2026-01-16',
          state: '',
          country_code: 'DE',
          expedited_review_flag: '',
          device_class: '2',
        },
        {
          k_number: 'K262755',
          device_name: 'Wave Electrode;Remote Wave Electrode',
          applicant: 'Bionit Labs Srl',
          product_code: 'GXY',
          decision_date: '2026-11-06',
          decision_code: 'SESE',
          decision_description: 'Substantially Equivalent',
          advisory_committee: 'NE',
          advisory_committee_description: 'Neurology',
          clearance_type: 'Special',
          date_received: '2026-08-03',
          state: '',
          country_code: 'IT',
          expedited_review_flag: '',
          device_class: '2',
        },
      ]);
    });

    it('reads the PMA identity, supplement, decision, and openfda columns back unchanged', async () => {
      const staged = await stage({ pathway: 'pma' });
      const rows = await query(
        staged.canvas_id,
        `SELECT pma_number, supplement_number, trade_name, generic_name, applicant, product_code, decision_date, decision_code, advisory_committee, advisory_committee_description, date_received, state, expedited_review_flag, json_extract_string(openfda, '$.regulation_number') AS regulation_number FROM ${staged.canvas_table} ORDER BY pma_number`,
      );
      expect(rows.rows).toEqual([
        {
          pma_number: 'P000001',
          supplement_number: null,
          trade_name: 'EXAMPLE VALVE',
          generic_name: 'Heart valve',
          applicant: 'Example Devices',
          product_code: 'DYE',
          decision_date: '2001-03-02',
          decision_code: 'APPR',
          advisory_committee: 'CV',
          advisory_committee_description: 'Cardiovascular',
          date_received: '2000-04-03',
          state: null,
          expedited_review_flag: null,
          regulation_number: null,
        },
        {
          pma_number: 'P970043',
          supplement_number: 'S005',
          trade_name: 'LADARVISION EXCIMER LASER SYSTEM',
          generic_name: 'Excimer laser system',
          applicant: 'Alcon Laboratories',
          product_code: 'LZS',
          decision_date: '2000-05-09',
          decision_code: 'APPR',
          advisory_committee: 'OP',
          advisory_committee_description: 'Ophthalmic',
          date_received: '1999-09-03',
          state: 'TX',
          expedited_review_flag: 'N',
          regulation_number: '',
        },
        {
          pma_number: 'P980040',
          supplement_number: 'S065',
          trade_name: 'TECNIS SYMFONY EXTENDED RANGE OF VISION INTRAOCULAR LENS',
          generic_name: 'Extended depth of focus intraocular lens',
          applicant: 'Johnson & Johnson Surgical Vision, Inc.',
          product_code: 'POE',
          decision_date: '2016-07-15',
          decision_code: 'APPR',
          advisory_committee: 'OP',
          advisory_committee_description: 'Ophthalmic',
          date_received: '2016-01-19',
          state: 'CA',
          expedited_review_flag: 'N',
          regulation_number: '886.3600',
        },
      ]);
    });
  },
);

describe('device clearances staging — one column list per pathway (#105)', DUCKDB_SUITE, () => {
  it.each([
    ['510k', K510_COLUMNS, LIVE_510K],
    ['pma', PMA_COLUMNS, LIVE_PMA],
  ] as const)(
    'the %s table holds exactly the fields its endpoint returns',
    async (pathway, expected, live) => {
      const staged = await stage({ pathway });
      const { columns, rowCount } = await columnsOf(staged.canvas_id, staged.canvas_table);

      expect(columns.map((c) => c.name)).toEqual(expected);
      expect(new Set(expected)).toEqual(new Set(Object.keys(live[0] ?? {})));
      expect(columns.filter((c) => c.type === 'JSON').map((c) => c.name)).toEqual(['openfda']);
      expect(columns.every((c) => c.type === 'JSON' || c.type === 'VARCHAR')).toBe(true);
      expect(rowCount).toBe(3);
    },
  );

  it.each([
    ['510k', ['pma_number', 'supplement_number', 'trade_name', 'generic_name']],
    ['pma', ['k_number', 'device_name', 'decision_description', 'clearance_type', 'country_code']],
  ] as const)(
    'the %s table drops the columns its endpoint never returns',
    async (pathway, dropped) => {
      const staged = await stage({ pathway });
      for (const column of dropped) {
        await expect(
          query(staged.canvas_id, `SELECT ${column} FROM ${staged.canvas_table}`),
          column,
        ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
      }
    },
  );

  it('reads the 510(k) summary, contact, panel, third-party, and address fields', async () => {
    const staged = await stage({ pathway: '510k' });
    const rows = await query(
      staged.canvas_id,
      `SELECT k_number, third_party_flag, statement_or_summary, contact, review_advisory_committee, address_1, address_2, city, zip_code, postal_code FROM ${staged.canvas_table} ORDER BY k_number`,
    );
    expect(rows.rows).toEqual([
      {
        k_number: 'K000017',
        third_party_flag: null,
        statement_or_summary: null,
        contact: null,
        review_advisory_committee: null,
        address_1: null,
        address_2: null,
        city: null,
        zip_code: null,
        postal_code: null,
      },
      {
        k_number: 'K260132',
        third_party_flag: 'N',
        statement_or_summary: 'Summary',
        contact: 'Elena  Pies',
        review_advisory_committee: 'DE',
        address_1: 'Hauptstrasse 28',
        address_2: '',
        city: 'Zossen',
        zip_code: '15806',
        postal_code: '15806',
      },
      {
        k_number: 'K262755',
        third_party_flag: 'N',
        statement_or_summary: 'Summary',
        contact: 'Aventaggiato  Matteo',
        review_advisory_committee: 'NE',
        address_1: 'Via Cracovia 1',
        address_2: '',
        city: 'Soleto',
        zip_code: '73010',
        postal_code: '73010',
      },
    ]);
  });

  it('reads the PMA supplement, approval-order, docket, and address fields', async () => {
    const staged = await stage({ pathway: 'pma' });
    const rows = await query(
      staged.canvas_id,
      `SELECT pma_number, supplement_type, supplement_reason, ao_statement, docket_number, fed_reg_notice_date, street_1, street_2, city, zip, zip_ext FROM ${staged.canvas_table} ORDER BY pma_number`,
    );
    expect(rows.rows).toEqual([
      {
        pma_number: 'P000001',
        supplement_type: null,
        supplement_reason: null,
        ao_statement: null,
        docket_number: null,
        fed_reg_notice_date: null,
        street_1: null,
        street_2: null,
        city: null,
        zip: null,
        zip_ext: null,
      },
      {
        pma_number: 'P970043',
        supplement_type: 'Panel Track',
        supplement_reason: 'Labeling Change - Indications/instructions/shelf life/tradename',
        ao_statement:
          'Approval for the LADARVision Excimer Laser System indicated for laser in-situ keratomileusis (LASIK).',
        docket_number: '00M-1593',
        fed_reg_notice_date: '2000-11-14',
        street_1: '6201 S. Fwy.',
        street_2: '',
        city: 'Fort Worth',
        zip: '76134',
        zip_ext: '',
      },
      {
        pma_number: 'P980040',
        supplement_type: 'Panel Track',
        supplement_reason: 'Labeling Change - Indications/instructions/shelf life/tradename',
        ao_statement: 'Approval for the Tecnis Symfony Extended Range of Vision Intraocular Lens.',
        docket_number: '16M-2184',
        fed_reg_notice_date: '2016-07-25',
        street_1: '31 Technology Dr., Suite 200',
        street_2: '',
        city: 'Irvine',
        zip: '92618',
        zip_ext: '',
      },
    ]);
  });

  it('keeps openfda a JSON column json_extract reads, never [object Object]', async () => {
    const staged = await stage({ pathway: 'pma' });
    const rows = await query(
      staged.canvas_id,
      `SELECT pma_number, json_extract_string(openfda, '$.registration_number[1]') AS reg, CAST(openfda AS VARCHAR) LIKE '%[object Object]%' AS stringified FROM ${staged.canvas_table} WHERE openfda IS NOT NULL ORDER BY pma_number`,
    );
    expect(rows.rows).toEqual([
      { pma_number: 'P970043', reg: '3002807715', stringified: false },
      { pma_number: 'P980040', reg: '1119279', stringified: false },
    ]);
  });

  it('unions two stagings of one pathway positionally, whatever fields their rows carry', async () => {
    const first = await stage({ pathway: '510k' });
    DATASETS['device/510k'] = [SPARSE_510K];
    const second = await stage({ pathway: '510k', canvas_id: first.canvas_id });

    const rows = await query(
      first.canvas_id,
      `SELECT k_number, third_party_flag FROM (SELECT * FROM ${first.canvas_table} UNION ALL SELECT * FROM ${second.canvas_table}) ORDER BY k_number, third_party_flag`,
    );
    expect(rows.rows).toEqual([
      { k_number: 'K000017', third_party_flag: null },
      { k_number: 'K000017', third_party_flag: null },
      { k_number: 'K260132', third_party_flag: 'N' },
      { k_number: 'K262755', third_party_flag: 'N' },
    ]);
  });

  it('stages each pathway onto one canvas as its own table with its own columns', async () => {
    const k510 = await stage({ pathway: '510k' });
    const pma = await stage({ pathway: 'pma', canvas_id: k510.canvas_id });
    const cls = await stage({ pathway: 'classification', canvas_id: k510.canvas_id });

    const names = async (table: string) =>
      (await columnsOf(k510.canvas_id, table)).columns.map((c) => c.name);
    expect(await names(k510.canvas_table)).toEqual(K510_COLUMNS);
    expect(await names(pma.canvas_table)).toEqual(PMA_COLUMNS);
    expect(await names(cls.canvas_table)).toEqual(CLASSIFICATION_COLUMNS);
  });
});

describe('device classification staging (#96)', DUCKDB_SUITE, () => {
  it('stages all 17 classification fields, openfda as JSON, with no sort on any request', async () => {
    const staged = await stage({ pathway: 'classification' });
    const { columns, rowCount, text } = await columnsOf(staged.canvas_id, staged.canvas_table);

    expect(columns.map((c) => c.name)).toEqual(CLASSIFICATION_COLUMNS);
    expect(new Set(CLASSIFICATION_COLUMNS)).toEqual(new Set(Object.keys(LIVE_CLASSIFICATION[0]!)));
    expect(columns.filter((c) => c.type === 'JSON').map((c) => c.name)).toEqual(['openfda']);
    expect(rowCount).toBe(6);
    expect(text).toContain('submission_type_id');

    expect(CALLS.length).toBeGreaterThan(0);
    for (const call of CALLS) {
      expect(call).toEqual({ endpoint: 'device/classification', sort: undefined });
    }
  });

  it('keeps the raw codes in the staged rows — lowercase f for HDE, an undefined 6, an empty type', async () => {
    const staged = await stage({ pathway: 'classification' });
    const rows = await query(
      staged.canvas_id,
      `SELECT product_code, device_class, submission_type_id, regulation_number, implant_flag, unclassified_reason, json_extract_string(openfda, '$.k_number[0]') AS k FROM ${staged.canvas_table} ORDER BY product_code`,
    );
    expect(rows.rows).toEqual([
      {
        product_code: 'JDT',
        device_class: '1',
        submission_type_id: '4',
        regulation_number: '888.3000',
        implant_flag: 'Y',
        unclassified_reason: '',
        k: null,
      },
      {
        product_code: 'LKX',
        device_class: 'U',
        submission_type_id: '1',
        regulation_number: '',
        implant_flag: 'N',
        unclassified_reason: '1',
        k: 'K822217',
      },
      {
        product_code: 'OLM',
        device_class: 'f',
        submission_type_id: '6',
        regulation_number: '',
        implant_flag: 'Y',
        unclassified_reason: '',
        k: null,
      },
      {
        product_code: 'QBJ',
        device_class: '2',
        submission_type_id: '1',
        regulation_number: '862.1355',
        implant_flag: 'N',
        unclassified_reason: '',
        k: 'K222447',
      },
      {
        product_code: 'RDG',
        device_class: 'N',
        submission_type_id: '',
        regulation_number: '',
        implant_flag: '',
        unclassified_reason: '',
        k: null,
      },
      {
        product_code: 'ZZZ',
        device_class: '3',
        submission_type_id: null,
        regulation_number: null,
        implant_flag: null,
        unclassified_reason: null,
        k: null,
      },
    ]);
  });

  it('answers a class distribution in SQL, the question count_values cannot', async () => {
    const staged = await stage({ pathway: 'classification' });
    const rows = await query(
      staged.canvas_id,
      `SELECT device_class, COUNT(*) AS n FROM ${staged.canvas_table} GROUP BY device_class ORDER BY device_class`,
    );
    expect(rows.rows.map((r) => [r.device_class, Number(r.n)])).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 1],
      ['N', 1],
      ['U', 1],
      ['f', 1],
    ]);
  });

  it('serves the inline page with raw codes in structuredContent and labelled ones in content[]', async () => {
    const staged = await stage({ pathway: 'classification', limit: 3, skip: 1 });

    expect(
      staged.results.map((r) => [r.product_code, r.device_class, r.submission_type_id]),
    ).toEqual([
      ['JDT', '1', '4'],
      ['OLM', 'f', '6'],
      ['LKX', 'U', '1'],
    ]);
    expect(staged.staged_rows).toBe(6);

    const text = textOf(searchDeviceClearancesTool.format!(staged));
    expect(text).toContain('### JDT: Cap, Bone\n');
    expect(text).toContain('**Class:** Class I (1) | **Submission type:** 510(k) exempt (4)\n');
    expect(text).toContain('**Class:** HDE (f) | **Submission type:** 6\n');
    expect(text).toContain(`canvas table \`${staged.canvas_table}\``);
  });
});

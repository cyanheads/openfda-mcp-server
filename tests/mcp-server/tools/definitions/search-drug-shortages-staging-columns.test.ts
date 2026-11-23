/**
 * @fileoverview Staged-table columns for openfda_search_drug_shortages (#105).
 * Runs the real staging path end to end — the tool handler, the real
 * `spillSearch` drain, and a real DataCanvas (framework CanvasRegistry + DuckDB
 * provider) — with only the openFDA service stubbed, then reads the table back
 * through openfda_dataframe_describe and openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/search-drug-shortages-staging-columns.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The records the stubbed openFDA service pages over. */
const DATASET: { rows: Record<string, unknown>[] } = { rows: [] };

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      return {
        meta: { total: DATASET.rows.length, skip, limit, lastUpdated: '2026-11-20' },
        results: structuredClone(DATASET.rows.slice(skip, skip + limit)),
      };
    }),
  }),
  initOpenFdaService: () => {},
}));

import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { textOf } from '../../../helpers/content.js';
import {
  DUCKDB_SUITE,
  installStagingCanvas,
  queryStagedRows,
  shutdownStagingCanvas,
  stagedColumns,
} from '../../../helpers/staging-canvas.js';

const TENANT = 'shortages-staging-columns';

/** Live 0009-0902-18 (`_exists_:related_info_link`, 2026-11-22), its openfda block trimmed. */
const CLINDAMYCIN = {
  update_type: 'Revised',
  initial_posting_date: '03/21/2023',
  package_ndc: '0009-0902-18',
  generic_name: 'Clindamycin Phosphate Injection',
  related_info_link:
    'https://www.accessdata.fda.gov/scripts/drugshortages/dsp_ActiveIngredientDetails.cfm?AI=Clindamycin%20Phosphate%20Injection&st=d',
  contact_info: '800-533-4535',
  availability: 'Unavailable',
  related_info:
    'Next Delivery and Estimated Recovery: December 2028; Shortage per Manufacturer: Manufacturing Delay',
  openfda: {
    application_number: ['NDA050441'],
    brand_name: ['CLEOCIN PHOSPHATE'],
    product_ndc: ['0009-0902', '0009-0870'],
    rxcui: ['205964', '309335'],
  },
  update_date: '11/06/2026',
  therapeutic_category: ['Anti-Infective'],
  dosage_form: 'Injection',
  presentation:
    'Cleocin Phosphate, Injection, Cleocin Phosphate 900 mg/6 mL (150 mg/mL) (NDC 0009-0902-18)',
  company_name: 'Pfizer Inc.',
  shortage_reason: 'Other',
  status: 'Current',
};

/** Live 0069-4370-71 (`_exists_:change_date`, 2026-11-22): discontinued, no openfda block. */
const PRAZOSIN = {
  discontinued_date: '04/28/2023',
  update_type: 'New',
  initial_posting_date: '04/28/2023',
  change_date: '04/28/2023',
  package_ndc: '0069-4370-71',
  generic_name: 'Prazosin Hydrochloride Capsule',
  contact_info: '800-533-4535',
  related_info:
    'Discontinuation of the manufacture of the drug. Supply expected to exhaust in September 2023',
  update_date: '04/28/2023',
  therapeutic_category: ['Cardiovascular'],
  dosage_form: 'Capsule',
  presentation: 'Minipress, Capsule, 2 mg (NDC 0069-4370-71)',
  company_name: 'Pfizer Inc.',
  status: 'To Be Discontinued',
};

/** Live 43547-408-10 (`_exists_:resolved_note`, 2026-11-22): resolved, three categories. */
const CLONAZEPAM = {
  update_type: 'Revised',
  initial_posting_date: '03/10/2023',
  change_date: '11/04/2026',
  package_ndc: '43547-408-10',
  generic_name: 'Clonazepam Tablet',
  contact_info: 'For orders, Solco Healthcare 866-931-9829',
  resolved_note: 'Available',
  openfda: { brand_name: ['CLONAZEPAM'], product_ndc: ['43547-408'], rxcui: ['197527'] },
  update_date: '11/04/2026',
  therapeutic_category: ['Neurology', 'Pediatric', 'Psychiatry'],
  dosage_form: 'Tablet',
  presentation: 'Clonazepam, Tablet, 2 mg (NDC 43547-408-10)',
  company_name: 'Prinston Pharmaceutical, Inc.',
  status: 'Resolved',
};

/**
 * Constructed sparse record: two categories, and none of the optional fields —
 * no availability, presentation, contact, reason, dates past the update, or
 * openfda block.
 */
const SPARSE_TWO_CATEGORIES = {
  update_type: 'Revised',
  initial_posting_date: '01/05/2026',
  package_ndc: '0000-0001-01',
  generic_name: 'Methotrexate Injection',
  update_date: '11/18/2026',
  therapeutic_category: ['Rheumatology', 'Oncology'],
  company_name: 'Example Pharma',
  status: 'Current',
};

const RECORDS = [CLINDAMYCIN, PRAZOSIN, CLONAZEPAM, SPARSE_TWO_CATEGORIES];

/** The 0.10.0 staged columns and their types, which every later release keeps. */
const RELEASED_COLUMNS = [
  ...[
    'generic_name',
    'status',
    'availability',
    'therapeutic_category',
    'dosage_form',
    'presentation',
    'package_ndc',
    'company_name',
    'initial_posting_date',
    'update_date',
    'update_type',
    'shortage_reason',
    'contact_info',
  ].map((name) => ({ name, type: 'VARCHAR' })),
  { name: 'openfda', type: 'JSON' },
];
const RELEASED_SCALARS = RELEASED_COLUMNS.filter((c) => c.type === 'VARCHAR').map((c) => c.name);

/** The top-level fields drug/shortages returns that 0.10.0 did not stage, all strings upstream. */
const ADDED_COLUMNS = [
  'discontinued_date',
  'change_date',
  'related_info',
  'related_info_link',
  'resolved_note',
] as const;

beforeEach(() => {
  installStagingCanvas(TENANT);
  DATASET.rows = RECORDS;
});

afterEach(() => shutdownStagingCanvas(TENANT));

async function stage(input: Record<string, unknown> = {}) {
  const ctx = createMockContext({ errors: searchDrugShortagesTool.errors, tenantId: TENANT });
  const result = await searchDrugShortagesTool.handler(
    searchDrugShortagesTool.input.parse({ ...input, stage: true }),
    ctx,
  );
  expect(result.spilled).toBe(true);
  return result;
}

const columnsOf = (canvasId: string, table: string) => stagedColumns(TENANT, canvasId, table);
const query = (canvasId: string, sql: string) => queryStagedRows(TENANT, canvasId, sql);

describe('openfda_search_drug_shortages staging — released columns (#105)', DUCKDB_SUITE, () => {
  it('keeps every 0.10.0 column with its name and type', async () => {
    const staged = await stage();
    const columns = await columnsOf(staged.canvas_id ?? '', staged.canvas_table ?? '');
    expect(columns).toEqual(expect.arrayContaining(RELEASED_COLUMNS));
  });

  it('answers SQL over the 0.10.0 columns with the same values', async () => {
    const staged = await stage();
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT ${RELEASED_SCALARS.join(', ')}, json_extract_string(openfda, '$.brand_name[0]') AS brand, json_extract_string(openfda, '$.rxcui[1]') AS rxcui FROM ${staged.canvas_table} ORDER BY package_ndc`,
    );
    expect(rows).toEqual([
      {
        generic_name: 'Methotrexate Injection',
        status: 'Current',
        availability: null,
        therapeutic_category: 'Rheumatology,Oncology',
        dosage_form: null,
        presentation: null,
        package_ndc: '0000-0001-01',
        company_name: 'Example Pharma',
        initial_posting_date: '01/05/2026',
        update_date: '11/18/2026',
        update_type: 'Revised',
        shortage_reason: null,
        contact_info: null,
        brand: null,
        rxcui: null,
      },
      {
        generic_name: 'Clindamycin Phosphate Injection',
        status: 'Current',
        availability: 'Unavailable',
        therapeutic_category: 'Anti-Infective',
        dosage_form: 'Injection',
        presentation:
          'Cleocin Phosphate, Injection, Cleocin Phosphate 900 mg/6 mL (150 mg/mL) (NDC 0009-0902-18)',
        package_ndc: '0009-0902-18',
        company_name: 'Pfizer Inc.',
        initial_posting_date: '03/21/2023',
        update_date: '11/06/2026',
        update_type: 'Revised',
        shortage_reason: 'Other',
        contact_info: '800-533-4535',
        brand: 'CLEOCIN PHOSPHATE',
        rxcui: '309335',
      },
      {
        generic_name: 'Prazosin Hydrochloride Capsule',
        status: 'To Be Discontinued',
        availability: null,
        therapeutic_category: 'Cardiovascular',
        dosage_form: 'Capsule',
        presentation: 'Minipress, Capsule, 2 mg (NDC 0069-4370-71)',
        package_ndc: '0069-4370-71',
        company_name: 'Pfizer Inc.',
        initial_posting_date: '04/28/2023',
        update_date: '04/28/2023',
        update_type: 'New',
        shortage_reason: null,
        contact_info: '800-533-4535',
        brand: null,
        rxcui: null,
      },
      {
        generic_name: 'Clonazepam Tablet',
        status: 'Resolved',
        availability: null,
        therapeutic_category: 'Neurology,Pediatric,Psychiatry',
        dosage_form: 'Tablet',
        presentation: 'Clonazepam, Tablet, 2 mg (NDC 43547-408-10)',
        package_ndc: '43547-408-10',
        company_name: 'Prinston Pharmaceutical, Inc.',
        initial_posting_date: '03/10/2023',
        update_date: '11/04/2026',
        update_type: 'Revised',
        shortage_reason: null,
        contact_info: 'For orders, Solco Healthcare 866-931-9829',
        brand: 'CLONAZEPAM',
        rxcui: null,
      },
    ]);
  });

  it('keeps therapeutic_category one comma-joined VARCHAR that LIKE and = read as before', async () => {
    const staged = await stage();
    const table = staged.canvas_table;
    const ndcs = async (where: string) =>
      (
        await query(
          staged.canvas_id ?? '',
          `SELECT package_ndc FROM ${table} WHERE ${where} ORDER BY package_ndc`,
        )
      ).map((r) => r.package_ndc);

    expect(await ndcs(`therapeutic_category LIKE '%Oncology%'`)).toEqual(['0000-0001-01']);
    expect(await ndcs(`therapeutic_category = 'Rheumatology,Oncology'`)).toEqual(['0000-0001-01']);
    // A multi-category record never equals one of its categories alone.
    expect(await ndcs(`therapeutic_category = 'Oncology'`)).toEqual([]);
    expect(await ndcs(`therapeutic_category = 'Anti-Infective'`)).toEqual(['0009-0902-18']);
  });

  it('leaves the inline page, staged_rows, and truncated as the drain reports them', async () => {
    const staged = await stage({ limit: 2 });
    expect(staged.results).toEqual([CLINDAMYCIN, PRAZOSIN]);
    expect(staged.staged_rows).toBe(RECORDS.length);
    expect(staged).not.toHaveProperty('truncated');

    const text = textOf(searchDrugShortagesTool.format!(staged));
    expect(text).toContain(`canvas table \`${staged.canvas_table}\``);
    expect(text).toContain('### Clindamycin Phosphate Injection');
  });
});

describe('openfda_search_drug_shortages staging — upstream fields (#105)', DUCKDB_SUITE, () => {
  it('stages one fixed column per top-level field the endpoint returns, in schema order', async () => {
    const staged = await stage();
    const columns = await columnsOf(staged.canvas_id ?? '', staged.canvas_table ?? '');
    expect(columns).toEqual([
      ...RELEASED_COLUMNS.slice(0, 11),
      { name: 'discontinued_date', type: 'VARCHAR' },
      { name: 'change_date', type: 'VARCHAR' },
      ...RELEASED_COLUMNS.slice(11, 13),
      { name: 'related_info', type: 'VARCHAR' },
      { name: 'related_info_link', type: 'VARCHAR' },
      { name: 'resolved_note', type: 'VARCHAR' },
      { name: 'openfda', type: 'JSON' },
    ]);
    // Every key a fixture record carries is a column.
    const names = new Set(columns.map((c) => c.name));
    for (const key of new Set(RECORDS.flatMap((r) => Object.keys(r)))) {
      expect(names.has(key)).toBe(true);
    }
  });

  it.each([
    ['discontinued_date', { '0069-4370-71': '04/28/2023' }],
    ['change_date', { '0069-4370-71': '04/28/2023', '43547-408-10': '11/04/2026' }],
    [
      'related_info',
      {
        '0009-0902-18': CLINDAMYCIN.related_info,
        '0069-4370-71': PRAZOSIN.related_info,
      },
    ],
    ['related_info_link', { '0009-0902-18': CLINDAMYCIN.related_info_link }],
    ['resolved_note', { '43547-408-10': 'Available' }],
  ] satisfies [(typeof ADDED_COLUMNS)[number], Record<string, string>][])(
    'stages %s as its value where a record carries it and NULL where it does not',
    async (column, carried) => {
      const staged = await stage();
      const rows = await query(
        staged.canvas_id ?? '',
        `SELECT package_ndc, ${column} AS value FROM ${staged.canvas_table} ORDER BY package_ndc`,
      );
      expect(rows).toEqual(
        ['0000-0001-01', '0009-0902-18', '0069-4370-71', '43547-408-10'].map((ndc) => ({
          package_ndc: ndc,
          value: carried[ndc as keyof typeof carried] ?? null,
        })),
      );
    },
  );

  it('answers a discontinued-supply question in SQL from the added columns', async () => {
    const staged = await stage();
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT generic_name, discontinued_date, related_info FROM ${staged.canvas_table} WHERE discontinued_date IS NOT NULL`,
    );
    expect(rows).toEqual([
      {
        generic_name: 'Prazosin Hydrochloride Capsule',
        discontinued_date: '04/28/2023',
        related_info: PRAZOSIN.related_info,
      },
    ]);
  });

  it('unions two stagings onto one canvas positionally, whatever fields their rows carry', async () => {
    DATASET.rows = [SPARSE_TWO_CATEGORIES];
    const first = await stage();
    DATASET.rows = [CLINDAMYCIN, PRAZOSIN, CLONAZEPAM];
    const second = await stage({ canvas_id: first.canvas_id });
    expect(second.canvas_id).toBe(first.canvas_id);

    const [firstColumns, secondColumns] = await Promise.all([
      columnsOf(first.canvas_id ?? '', first.canvas_table ?? ''),
      columnsOf(first.canvas_id ?? '', second.canvas_table ?? ''),
    ]);
    expect(secondColumns).toEqual(firstColumns);

    const rows = await query(
      first.canvas_id ?? '',
      `SELECT package_ndc, resolved_note FROM (SELECT * FROM ${first.canvas_table} UNION ALL SELECT * FROM ${second.canvas_table}) ORDER BY package_ndc`,
    );
    expect(rows).toEqual([
      { package_ndc: '0000-0001-01', resolved_note: null },
      { package_ndc: '0009-0902-18', resolved_note: null },
      { package_ndc: '0069-4370-71', resolved_note: null },
      { package_ndc: '43547-408-10', resolved_note: 'Available' },
    ]);
  });

  it('stores no object or array as text in a VARCHAR column', async () => {
    const staged = await stage();
    const columns = await columnsOf(staged.canvas_id ?? '', staged.canvas_table ?? '');
    const text = columns.filter((c) => c.type === 'VARCHAR').map((c) => c.name);
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT count(*) AS n FROM ${staged.canvas_table} WHERE ${text.map((c) => `${c} LIKE '%[object Object]%'`).join(' OR ')}`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

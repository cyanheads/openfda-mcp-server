/**
 * @fileoverview Staged-table columns for openfda_lookup_ndc on both datasets:
 * every top-level field drug/ndc returns (#105) and every field other/nsde
 * returns (#94). Runs the real staging path end to end — the tool handler, the
 * real `spillSearch` drain, and a real DataCanvas (framework CanvasRegistry +
 * DuckDB provider) — with only the openFDA service stubbed, then reads the table
 * back through openfda_dataframe_describe and openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/lookup-ndc-staging-columns.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Rows the stubbed openFDA service pages over, by `<endpoint> <search>`, else by endpoint. */
const DATASETS: Record<string, Record<string, unknown>[]> = {};

/** Every request the stubbed service answered, in order. */
const CALLS: { endpoint: string; params: Record<string, unknown> }[] = [];

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(
      async (endpoint: string, params: { limit?: number; search?: string; skip?: number }) => {
        CALLS.push({ endpoint, params: { ...params } });
        const rows = DATASETS[`${endpoint} ${params.search}`] ?? DATASETS[endpoint] ?? [];
        const skip = params.skip ?? 0;
        const limit = params.limit ?? 1000;
        return {
          meta: { total: rows.length, skip, limit, lastUpdated: '2026-11-20' },
          results: structuredClone(rows.slice(skip, skip + limit)),
        };
      },
    ),
  }),
  initOpenFdaService: () => {},
}));

import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { OBJECT_ARRAY_PATHS } from '@/mcp-server/tools/field-catalog.js';
import { textOf } from '../../../helpers/content.js';
import {
  DUCKDB_SUITE,
  describeStagedTable,
  installStagingCanvas,
  queryStagedRows,
  shutdownStagingCanvas,
} from '../../../helpers/staging-canvas.js';

const TENANT = 'lookup-ndc-staging-columns';

/** Live drug/ndc records (2026-11-22), packaging, ingredients, and openfda trimmed. */
const ELIQUIS: Record<string, unknown> = {
  product_ndc: '50090-1436',
  generic_name: 'apixaban',
  labeler_name: 'A-S Medication Solutions',
  brand_name: 'ELIQUIS',
  active_ingredients: [{ name: 'APIXABAN', strength: '2.5 mg/1' }],
  finished: true,
  packaging: [{ package_ndc: '50090-1436-0', description: '60 TABLET, FILM COATED in 1 BOTTLE' }],
  listing_expiration_date: '20261231',
  openfda: { manufacturer_name: ['A-S Medication Solutions'], rxcui: ['1364435'] },
  marketing_category: 'NDA',
  dosage_form: 'TABLET, FILM COATED',
  spl_id: '76e8efee-ea1e-460e-8027-443facf02ee9',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  route: ['ORAL'],
  marketing_start_date: '20121228',
  product_id: '50090-1436_76e8efee-ea1e-460e-8027-443facf02ee9',
  application_number: 'NDA202155',
  brand_name_base: 'ELIQUIS',
  pharm_class: ['Factor Xa Inhibitor [EPC]', 'Factor Xa Inhibitors [MoA]'],
};

/** A scheduled authorized generic with an end date: no pharm_class, no listing_expiration_date. */
const ARMODAFINIL: Record<string, unknown> = {
  product_ndc: '0781-8045',
  marketing_end_date: '20270930',
  generic_name: 'Armodafinil',
  labeler_name: 'Sandoz Inc',
  dea_schedule: 'CIV',
  brand_name: 'Armodafinil',
  active_ingredients: [{ name: 'ARMODAFINIL', strength: '200 mg/1' }],
  finished: true,
  packaging: [{ package_ndc: '0781-8045-31', description: '30 TABLET in 1 BOTTLE' }],
  openfda: { manufacturer_name: ['Sandoz Inc'] },
  marketing_category: 'NDA AUTHORIZED GENERIC',
  dosage_form: 'TABLET',
  spl_id: 'dea0ad34-a35f-42ba-a6b6-dea58a16868f',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  route: ['ORAL'],
  marketing_start_date: '20161201',
  product_id: '0781-8045_dea0ad34-a35f-42ba-a6b6-dea58a16868f',
  application_number: 'NDA021875',
  brand_name_base: 'Armodafinil',
};

/** Sparse: a homeopathic product with a brand suffix and no application number, empty openfda. */
const LYMPHASTAT: Record<string, unknown> = {
  product_ndc: '44911-0657',
  marketing_end_date: '20270908',
  generic_name: 'Echinacea (Angustifolia), Lomatium Dissectum',
  labeler_name: 'Energique, Inc.',
  brand_name: 'Lymphastat V',
  brand_name_suffix: 'V',
  active_ingredients: [{ name: 'ECHINACEA ANGUSTIFOLIA WHOLE', strength: '3 [hp_X]/mL' }],
  finished: false,
  packaging: [{ package_ndc: '44911-0657-1', description: '30 mL in 1 BOTTLE, DROPPER' }],
  openfda: {},
  marketing_category: 'UNAPPROVED HOMEOPATHIC',
  dosage_form: 'LIQUID',
  spl_id: '92365727-70fe-4c1e-bac2-4d58a6948cd2',
  product_type: 'HUMAN OTC DRUG',
  route: ['ORAL'],
  marketing_start_date: '20220720',
  product_id: '44911-0657_92365727-70fe-4c1e-bac2-4d58a6948cd2',
  brand_name_base: 'Lymphastat',
};

const NDC_RECORDS = [ELIQUIS, ARMODAFINIL, LYMPHASTAT];

/** The drug/ndc table: every field the endpoint returns, pinned whole with its type. */
const NDC_COLUMNS = [
  ['product_ndc', 'VARCHAR'],
  ['product_id', 'VARCHAR'],
  ['spl_id', 'VARCHAR'],
  ['brand_name', 'VARCHAR'],
  ['brand_name_base', 'VARCHAR'],
  ['brand_name_suffix', 'VARCHAR'],
  ['generic_name', 'VARCHAR'],
  ['labeler_name', 'VARCHAR'],
  ['dosage_form', 'VARCHAR'],
  ['product_type', 'VARCHAR'],
  ['marketing_category', 'VARCHAR'],
  ['application_number', 'VARCHAR'],
  ['marketing_start_date', 'VARCHAR'],
  ['marketing_end_date', 'VARCHAR'],
  ['listing_expiration_date', 'VARCHAR'],
  ['dea_schedule', 'VARCHAR'],
  ['finished', 'VARCHAR'],
  ['route', 'JSON'],
  ['active_ingredients', 'JSON'],
  ['packaging', 'JSON'],
  ['pharm_class', 'JSON'],
  ['openfda', 'JSON'],
] as const;

/** The 0.10.0 drug/ndc columns, each of which keeps its name and type. */
const NDC_COLUMNS_0_10 = [
  ['product_ndc', 'VARCHAR'],
  ['product_id', 'VARCHAR'],
  ['brand_name', 'VARCHAR'],
  ['generic_name', 'VARCHAR'],
  ['labeler_name', 'VARCHAR'],
  ['dosage_form', 'VARCHAR'],
  ['product_type', 'VARCHAR'],
  ['marketing_category', 'VARCHAR'],
  ['marketing_start_date', 'VARCHAR'],
  ['listing_expiration_date', 'VARCHAR'],
  ['dea_schedule', 'VARCHAR'],
  ['finished', 'VARCHAR'],
  ['route', 'JSON'],
  ['active_ingredients', 'JSON'],
  ['packaging', 'JSON'],
  ['openfda', 'JSON'],
] as const;

/** Live other/nsde rows (2026-11-22): every field set, an ended package, and a sparse row. */
const ELOCON: Record<string, unknown> = {
  proprietary_name: 'Elocon',
  marketing_end_date: '20211231',
  application_number_or_citation: 'NDA019543',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  marketing_start_date: '19870430',
  package_ndc: '0085-0370-02',
  reactivation_date: '20210908',
  inactivation_date: '20210723',
  marketing_category: 'NDA',
  billing_unit: 'GM',
  package_ndc11: '00085037002',
  dosage_form: 'OINTMENT',
};

const WARFARIN: Record<string, unknown> = {
  proprietary_name: 'Warfarin Sodium',
  application_number_or_citation: 'ANDA040616',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  marketing_start_date: '20151019',
  package_ndc: '0093-1712-01',
  marketing_category: 'ANDA',
  billing_unit: 'EA',
  package_ndc11: '00093171201',
  dosage_form: 'TABLET',
};

const AESCULUS: Record<string, unknown> = {
  proprietary_name: 'Aesculus Hippocastanum',
  product_type: 'HUMAN OTC DRUG',
  marketing_start_date: '19830303',
  package_ndc: '0220-0085-41',
  reactivation_date: '20230712',
  inactivation_date: '20230130',
  marketing_category: 'unapproved homeopathic',
  package_ndc11: '00220008541',
  dosage_form: 'PELLET',
};

const NSDE_ROWS = [ELOCON, WARFARIN, AESCULUS];

/** The NSDE table: its 12 top-level fields, every one a nullable VARCHAR. */
const NSDE_COLUMNS = [
  'package_ndc11',
  'package_ndc',
  'proprietary_name',
  'dosage_form',
  'product_type',
  'billing_unit',
  'marketing_category',
  'application_number_or_citation',
  'marketing_start_date',
  'marketing_end_date',
  'inactivation_date',
  'reactivation_date',
];

/** A live Drugs@FDA application for apixaban, submissions and products trimmed. */
const ELIQUIS_APPLICATION: Record<string, unknown> = {
  application_number: 'NDA202155',
  sponsor_name: 'BRISTOL MYERS SQUIBB',
  products: [{ product_number: '001', brand_name: 'ELIQUIS', dosage_form: 'TABLET' }],
  submissions: [{ submission_type: 'ORIG', submission_number: '1', submission_status: 'AP' }],
  openfda: { brand_name: ['ELIQUIS'] },
};

beforeEach(() => {
  installStagingCanvas(TENANT);
  for (const key of Object.keys(DATASETS)) delete DATASETS[key];
  DATASETS['drug/ndc'] = NDC_RECORDS;
  DATASETS['other/nsde'] = NSDE_ROWS;
  DATASETS['drug/drugsfda'] = [ELIQUIS_APPLICATION];
  CALLS.length = 0;
});

afterEach(() => shutdownStagingCanvas(TENANT));

async function lookup(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: lookupNdcTool.errors, tenantId: TENANT });
  const result = await lookupNdcTool.handler(lookupNdcTool.input.parse(input), ctx);
  return { ctx, result };
}

async function stage(input: Record<string, unknown>) {
  const { ctx, result } = await lookup({ search: 'x', ...input, stage: true });
  expect(result.spilled).toBe(true);
  return { ctx, result };
}

const describeTable = (canvasId: string, table: string) =>
  describeStagedTable(TENANT, canvasId, table);
const query = (canvasId: string, sql: string) => queryStagedRows(TENANT, canvasId, sql);

describe('openfda_lookup_ndc staging — drug/ndc columns (#105)', DUCKDB_SUITE, () => {
  it('stages a column for every top-level field drug/ndc returns, each with its type', async () => {
    const { result } = await stage({});
    const table = await describeTable(result.canvas_id ?? '', result.canvas_table ?? '');

    expect(table?.columns.map((c) => [c.name, c.type])).toEqual(NDC_COLUMNS);
    expect(table?.columns.every((c) => c.nullable === true)).toBe(true);
    expect(table?.row_count).toBe(NDC_RECORDS.length);
    const names = new Set(table?.columns.map((c) => c.name));
    for (const key of new Set(NDC_RECORDS.flatMap((r) => Object.keys(r)))) {
      expect(names.has(key), key).toBe(true);
    }
  });

  it('keeps every 0.10.0 column with its name and type', async () => {
    const { result } = await stage({});
    const table = await describeTable(result.canvas_id ?? '', result.canvas_table ?? '');
    const types = new Map(table?.columns.map((c) => [c.name, c.type]));

    for (const [name, type] of NDC_COLUMNS_0_10) expect(types.get(name), name).toBe(type);
  });

  it('reads the added fields, NULL where a record lacks one', async () => {
    const { result } = await stage({});
    const rows = await query(
      result.canvas_id ?? '',
      `SELECT product_ndc, application_number, brand_name_base, brand_name_suffix, marketing_end_date, spl_id, json_extract_string(pharm_class, '$[0]') AS epc FROM ${result.canvas_table} ORDER BY product_ndc`,
    );

    expect(rows).toEqual([
      {
        product_ndc: '0781-8045',
        application_number: 'NDA021875',
        brand_name_base: 'Armodafinil',
        brand_name_suffix: null,
        marketing_end_date: '20270930',
        spl_id: 'dea0ad34-a35f-42ba-a6b6-dea58a16868f',
        epc: null,
      },
      {
        product_ndc: '44911-0657',
        application_number: null,
        brand_name_base: 'Lymphastat',
        brand_name_suffix: 'V',
        marketing_end_date: '20270908',
        spl_id: '92365727-70fe-4c1e-bac2-4d58a6948cd2',
        epc: null,
      },
      {
        product_ndc: '50090-1436',
        application_number: 'NDA202155',
        brand_name_base: 'ELIQUIS',
        brand_name_suffix: null,
        marketing_end_date: null,
        spl_id: '76e8efee-ea1e-460e-8027-443facf02ee9',
        epc: 'Factor Xa Inhibitor [EPC]',
      },
    ]);
  });

  it('stages the boolean as text and the structures as JSON, never [object Object]', async () => {
    const { result } = await stage({});
    const rows = await query(
      result.canvas_id ?? '',
      `SELECT product_ndc, finished, json_extract_string(route, '$[0]') AS route, json_extract_string(packaging, '$[0].package_ndc') AS package, json_extract_string(openfda, '$.manufacturer_name[0]') AS manufacturer FROM ${result.canvas_table} ORDER BY product_ndc`,
    );
    expect(rows).toEqual([
      {
        product_ndc: '0781-8045',
        finished: 'true',
        route: 'ORAL',
        package: '0781-8045-31',
        manufacturer: 'Sandoz Inc',
      },
      {
        product_ndc: '44911-0657',
        finished: 'false',
        route: 'ORAL',
        package: '44911-0657-1',
        manufacturer: null,
      },
      {
        product_ndc: '50090-1436',
        finished: 'true',
        route: 'ORAL',
        package: '50090-1436-0',
        manufacturer: 'A-S Medication Solutions',
      },
    ]);

    const text = NDC_COLUMNS.filter(([, type]) => type === 'VARCHAR').map(([name]) => name);
    const garbled = await query(
      result.canvas_id ?? '',
      `SELECT count(*) AS n FROM ${result.canvas_table} WHERE ${text.map((c) => `${c} LIKE '%[object Object]%'`).join(' OR ')}`,
    );
    expect(Number(garbled[0]?.n)).toBe(0);
  });

  it('joins a staged NDC table to a staged Drugs@FDA table on application_number', async () => {
    DATASETS['drug/ndc brand_name:"eliquis"'] = [ELIQUIS];
    const { result: ndc } = await stage({ search: 'brand_name:"eliquis"' });
    const approvals = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({
        search: 'products.brand_name:"eliquis"',
        canvas_id: ndc.canvas_id,
      }),
      createMockContext({ errors: searchDrugApprovalsTool.errors, tenantId: TENANT }),
    );

    const rows = await query(
      ndc.canvas_id ?? '',
      `SELECT n.product_ndc, a.application_number, a.sponsor_name FROM ${ndc.canvas_table} n JOIN ${approvals.canvas_table} a ON a.application_number = n.application_number`,
    );
    expect(rows).toEqual([
      {
        product_ndc: '50090-1436',
        application_number: 'NDA202155',
        sponsor_name: 'BRISTOL MYERS SQUIBB',
      },
    ]);
  });

  it('unions two stagings onto one canvas positionally, whatever fields their rows carry', async () => {
    DATASETS['drug/ndc brand_name:"eliquis"'] = [ELIQUIS];
    DATASETS['drug/ndc product_type:"HUMAN OTC DRUG"'] = [LYMPHASTAT];
    const { result: first } = await stage({ search: 'brand_name:"eliquis"' });
    const { result: second } = await stage({
      search: 'product_type:"HUMAN OTC DRUG"',
      canvas_id: first.canvas_id,
    });

    const rows = await query(
      first.canvas_id ?? '',
      `SELECT product_ndc, brand_name_suffix, application_number FROM (SELECT * FROM ${first.canvas_table} UNION ALL SELECT * FROM ${second.canvas_table}) ORDER BY product_ndc`,
    );
    expect(rows).toEqual([
      { product_ndc: '44911-0657', brand_name_suffix: 'V', application_number: null },
      { product_ndc: '50090-1436', brand_name_suffix: null, application_number: 'NDA202155' },
    ]);
  });
});

describe('openfda_lookup_ndc staging — other/nsde columns (#94)', DUCKDB_SUITE, () => {
  it('stages an NSDE search against its 12 fields, every one a nullable VARCHAR', async () => {
    const { result } = await stage({ dataset: 'nsde' });
    const table = await describeTable(result.canvas_id ?? '', result.canvas_table ?? '');

    expect(CALLS.every((call) => call.endpoint === 'other/nsde')).toBe(true);
    expect(table?.columns.map((c) => c.name)).toEqual(NSDE_COLUMNS);
    expect(table?.columns.every((c) => c.type === 'VARCHAR' && c.nullable === true)).toBe(true);
    expect(table?.row_count).toBe(NSDE_ROWS.length);
  });

  it('reads every NSDE field, NULL where a row lacks it', async () => {
    const { result } = await stage({ dataset: 'nsde' });
    const rows = await query(
      result.canvas_id ?? '',
      `SELECT ${NSDE_COLUMNS.join(', ')} FROM ${result.canvas_table} ORDER BY package_ndc11`,
    );

    expect(rows).toEqual(
      [ELOCON, WARFARIN, AESCULUS]
        .sort((a, b) => String(a.package_ndc11).localeCompare(String(b.package_ndc11)))
        .map((row) => Object.fromEntries(NSDE_COLUMNS.map((c) => [c, row[c] ?? null]))),
    );
  });

  it('keeps the staged response consistent on both surfaces', async () => {
    const { result } = await stage({ dataset: 'nsde', limit: 1 });

    expect(result.results).toEqual([ELOCON]);
    expect(result.staged_rows).toBe(3);
    const text = textOf(lookupNdcTool.format!(result));
    expect(text).toContain(`canvas table \`${result.canvas_table}\``);
    expect(text).toContain('### Elocon\n**Package NDC:** 0085-0370-02 | **NDC11:** 00085037002');
  });
});

/*
 * staged or not × canvas_id supplied or omitted × skip 0 or later × fields set
 * or not, on each dataset: the staged call sends only its dataset's endpoint,
 * serves the same inline window the plain call does, and stages the whole match.
 */
describe('openfda_lookup_ndc staging — the inline window on both paths', DUCKDB_SUITE, () => {
  const MATRIX = (['ndc', 'nsde'] as const).flatMap((dataset) =>
    [0, 2].flatMap((skip) =>
      [undefined, ['dosage_form']].flatMap((fields) =>
        [false, true].map((canvasSupplied) => ({ dataset, skip, fields, canvasSupplied })),
      ),
    ),
  );

  it.each(MATRIX)(
    'dataset $dataset, skip $skip, fields $fields, canvas_id supplied: $canvasSupplied',
    async ({ dataset, skip, fields, canvasSupplied }) => {
      const endpoint = dataset === 'nsde' ? 'other/nsde' : 'drug/ndc';
      const rows = dataset === 'nsde' ? NSDE_ROWS : NDC_RECORDS;
      const call = { search: 'x', dataset, skip, limit: 1, ...(fields && { fields }) };
      let canvasId: string | undefined;
      if (canvasSupplied) {
        const { result: seed } = await stage({ dataset });
        canvasId = seed.canvas_id;
      }

      const { result: plain } = await lookup(call);
      CALLS.length = 0;
      const { result: staged } = await stage({
        ...call,
        ...(canvasId && { canvas_id: canvasId }),
      });

      expect(CALLS.length).toBeGreaterThan(0);
      expect(CALLS.every((c) => c.endpoint === endpoint)).toBe(true);
      expect(staged.results).toEqual(plain.results);
      const identity = dataset === 'nsde' ? 'package_ndc11' : 'product_ndc';
      expect(staged.results.map((r) => r[identity])).toEqual([rows[skip]?.[identity]]);
      const keys = fields ? ['dosage_form', identity].sort() : Object.keys(rows[skip] ?? {}).sort();
      expect(Object.keys(staged.results[0] ?? {}).sort()).toEqual(keys);
      expect(staged.staged_rows).toBe(rows.length);
      if (canvasId) expect(staged.canvas_id).toBe(canvasId);
      const table = await describeTable(staged.canvas_id ?? '', staged.canvas_table ?? '');
      expect(table?.row_count).toBe(rows.length);
      // A staged table keeps whole rows, whatever the inline page was cut to.
      expect(table?.columns.length).toBe(dataset === 'nsde' ? 12 : 22);
    },
  );

  it('names the NSDE route on a staged drug/ndc search that matched nothing', async () => {
    DATASETS['drug/ndc'] = [];
    const { ctx, result } = await lookup({ search: '00093171201', stage: true });
    const { notice } = getEnrichment(ctx);

    expect(result.spilled).toBe(false);
    expect(notice).toContain('search `package_ndc11:"00093171201"` with dataset "nsde"');
    expect(notice).toContain('Nothing was staged on canvas');
  });
});

/*
 * #100 — on the staged path the cross-element notice names the table, and its
 * SQL, run against that table, answers per packaging entry.
 */
describe('openfda_lookup_ndc staging — cross-entry clauses (#100)', DUCKDB_SUITE, () => {
  /** Two packages: a sample bottle and a non-sample blister, so the two clauses meet only across entries. */
  const TWO_PACKAGES: Record<string, unknown> = {
    ...ARMODAFINIL,
    product_ndc: '0781-8046',
    packaging: [
      { package_ndc: '0781-8046-01', description: '30 TABLET in 1 BOTTLE', sample: true },
      { package_ndc: '0781-8046-02', description: '10 TABLET in 1 BLISTER PACK', sample: false },
    ],
  };
  /** One package that meets both clauses itself. */
  const ONE_SAMPLE_BLISTER: Record<string, unknown> = {
    ...ELIQUIS,
    packaging: [
      { package_ndc: '50090-1436-9', description: '2 TABLET in 1 BLISTER PACK', sample: true },
    ],
  };
  const TIED = 'packaging.sample:"true" AND packaging.description:"BLISTER"';

  it('stages every array the notice can name as a JSON column', async () => {
    const arrays = OBJECT_ARRAY_PATHS['drug/ndc'] ?? [];
    const { result } = await stage({});
    const table = await describeTable(result.canvas_id ?? '', result.canvas_table ?? '');
    const types = new Map(table?.columns.map((c) => [c.name, c.type]));

    expect(arrays).toEqual(['active_ingredients', 'packaging']);
    for (const path of arrays) expect(types.get(path.split('.')[0] ?? ''), path).toBe('JSON');
    expect(OBJECT_ARRAY_PATHS['other/nsde']).toBeUndefined();
  });

  it('names the staged table after the staging notice, and its SQL answers per entry', async () => {
    DATASETS[`drug/ndc ${TIED}`] = [TWO_PACKAGES, ONE_SAMPLE_BLISTER];
    const { ctx, result } = await stage({ search: TIED });
    const notice = String(getEnrichment(ctx).notice);

    const staging = notice.indexOf(
      `Staged 2 of 2 matched records on canvas table "${result.canvas_table}"`,
    );
    const tie = notice.indexOf('openFDA matches each clause against the whole record');
    expect(staging).toBeGreaterThanOrEqual(0);
    expect(tie).toBeGreaterThan(staging);
    const sql = notice.match(/`(SELECT \* FROM [^`]+)`/)?.[1] ?? '';
    expect(sql.startsWith(`SELECT * FROM ${result.canvas_table} t WHERE EXISTS`)).toBe(true);

    const rows = await query(result.canvas_id ?? '', sql);
    expect(rows.map((r) => r.product_ndc)).toEqual(['50090-1436']);
  });

  it('stays silent on a staged search that matched nothing', async () => {
    DATASETS['drug/ndc'] = [];
    const { ctx } = await lookup({ search: TIED, stage: true });

    expect(getEnrichment(ctx).notice).not.toContain('openFDA matches each clause');
  });
});

describe('openfda_lookup_ndc staging — an empty NSDE search', DUCKDB_SUITE, () => {
  it('does not fire on a staged NSDE search that matched nothing', async () => {
    DATASETS['other/nsde'] = [];
    const { ctx, result } = await lookup({
      search: 'package_ndc:"0093171201"',
      dataset: 'nsde',
      stage: true,
    });
    const { notice } = getEnrichment(ctx);

    expect(result.spilled).toBe(false);
    expect(notice).toMatch(/^No NSDE package rows matched the query\./);
    expect(notice).not.toContain('It reads as');
    expect(notice).toContain('Nothing was staged on canvas');
  });
});

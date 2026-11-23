/**
 * @fileoverview Staged tables for openfda_search_drug_approvals, per dataset
 * (#93). Runs the real staging path end to end — the tool handler, the real
 * `spillSearch` drain, and a real DataCanvas (framework CanvasRegistry + DuckDB
 * provider) — with only the openFDA service stubbed, then reads each table back
 * through openfda_dataframe_describe and openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/search-drug-approvals-staging-columns.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Records per endpoint the stubbed openFDA service pages over. */
const DATASETS: Record<string, Record<string, unknown>[]> = {};

/** Every request the stub served, as `[endpoint, params]`. */
const REQUESTS: [string, Record<string, unknown>][] = [];

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(async (endpoint: string, params: { limit?: number; skip?: number }) => {
      REQUESTS.push([endpoint, { ...params }]);
      const rows = DATASETS[endpoint] ?? [];
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      return {
        meta: { total: rows.length, skip, limit, lastUpdated: '2026-11-20' },
        results: rows.slice(skip, skip + limit).map((row) => structuredClone(row)),
      };
    }),
  }),
  initOpenFdaService: () => {},
}));

import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { OBJECT_ARRAY_PATHS } from '@/mcp-server/tools/field-catalog.js';
import {
  DUCKDB_SUITE,
  installStagingCanvas,
  queryStaged,
  shutdownStagingCanvas,
} from '../../../helpers/staging-canvas.js';

const TENANT = 'drug-approvals-staging-columns';

/** Three Drugs@FDA applications, the last sparse (no openfda block, no products). */
const DRUGSFDA: Record<string, unknown>[] = [
  {
    application_number: 'NDA202155',
    sponsor_name: 'BRISTOL MYERS SQUIBB',
    openfda: { brand_name: ['ELIQUIS'] },
    products: [{ product_number: '001', brand_name: 'ELIQUIS' }],
    submissions: [{ submission_type: 'ORIG', submission_status_date: '20121228' }],
  },
  {
    application_number: 'ANDA210274',
    sponsor_name: 'ZHEJIANG NOVUS',
    products: [{ product_number: '001', brand_name: 'TOLVAPTAN' }],
    submissions: [{ submission_type: 'ORIG', submission_status_date: '20230301' }],
  },
  { application_number: 'BLA125057', sponsor_name: 'ABBVIE' },
];

const DRUGSFDA_COLUMNS = [
  'application_number',
  'sponsor_name',
  'openfda',
  'products',
  'submissions',
];

/**
 * Three Orange Book products shaped like live records (2026-11-22): one with
 * patents and an exclusivity, one approved before 1982 (no approval_date), and
 * an ANDA product with neither list.
 */
const ORANGE_BOOK: Record<string, unknown>[] = [
  {
    approval_date: '20121228',
    product_number: '001',
    products: [
      {
        application_type: 'N',
        application_number: '202155',
        brand_name: 'ELIQUIS',
        therapeutic_equivalence_codes: ['AB'],
      },
    ],
    patents: [
      { patent_number: '6967208', expiration_date: '20261121', drug_product_flag: true },
      { patent_number: '6967208*PED', expiration_date: '20270521' },
    ],
    exclusivity: [{ exclusivity_code: 'NPP', exclusivity_expiration_date: '20280417' }],
  },
  {
    approved_prior_to_1982: true,
    product_number: '007',
    products: [{ application_type: 'N', application_number: '017105', brand_name: 'TRANXENE' }],
  },
  {
    approval_date: '20261110',
    product_number: '002',
    products: [
      { application_type: 'A', application_number: '218668', brand_name: 'TOFACITINIB CITRATE' },
    ],
  },
];

const ORANGE_BOOK_COLUMNS = [
  'product_number',
  'approval_date',
  'approved_prior_to_1982',
  'products',
  'patents',
  'exclusivity',
];

/**
 * Three letters shaped like live ones (2026-11-22), texts cut short: one filed
 * under two application numbers, one whose text holds backtick runs and an
 * indented line, and the letter that carries only four fields.
 */
const LETTERS: Record<string, unknown>[] = [
  {
    letter_date: '12/16/2025',
    approver_title: null,
    file_name: 'CRL_BLA761458_20251216.pdf',
    letter_year: '2025',
    approval_status: 'Unapproved',
    approver_name: 'Center for Drug Evaluation and Research',
    approver_center: [],
    company_rep: 'David Colton',
    company_address: '200 Cambridge Park Drive\nCambridge, Massachusetts 02140',
    company_name: 'GlaxoSmithKline LLC',
    text: 'BLA 761458/Original 2\nCOMPLETE RESPONSE\n\nDear David Colton:',
    application_number: ['BLA 761458/Original 2', 'BLA 761458'],
    letter_type: 'COMPLETE RESPONSE',
  },
  {
    letter_date: '08/25/2021',
    file_name: '210274_2023_Orig1s000OtherActionLtrs.pdf',
    letter_year: '2021',
    approval_status: 'Approved',
    approver_center: ['Office of Infectious Diseases', 'Center for Drug Evaluation and Research'],
    company_name: 'Zhejiang Novus Pharmaceuticals Co. Ltd.',
    text: 'Item 2 cites ``` and `x`.\n    An indented line.',
    application_number: ['NDA 210274'],
    letter_type: 'COMPLETE RESPONSE',
  },
  {
    letter_date: '02/27/2026',
    approval_status: 'Unapproved',
    file_name: 'Under Review for Release',
    company_name: 'Chiesi Farmaceutici S.p.A',
  },
];

const LETTER_COLUMNS = [
  'file_name',
  'letter_date',
  'application_number',
  'letter_type',
  'letter_year',
  'approval_status',
  'company_name',
  'company_rep',
  'company_address',
  'approver_name',
  'approver_title',
  'approver_center',
  'text',
];

beforeEach(() => {
  installStagingCanvas(TENANT);
  REQUESTS.length = 0;
  DATASETS['drug/drugsfda'] = DRUGSFDA;
  DATASETS['drug/orangebook'] = ORANGE_BOOK;
  DATASETS['transparency/crl'] = LETTERS;
});

afterEach(() => shutdownStagingCanvas(TENANT));

async function call(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: searchDrugApprovalsTool.errors, tenantId: TENANT });
  return searchDrugApprovalsTool.handler(searchDrugApprovalsTool.input.parse(input), ctx);
}

async function stage(input: Record<string, unknown>) {
  const result = await call({ ...input, stage: true });
  expect(result.spilled).toBe(true);
  return result;
}

async function columnsOf(canvasId: string, table: string) {
  const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: TENANT });
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ canvas_id: canvasId }),
    ctx,
  );
  const found = result.tables.find((t) => t.name === table);
  return {
    columns: found?.columns.map((c) => c.name),
    rowCount: found?.row_count,
    types: new Map(found?.columns.map((c) => [c.name, c.type])),
  };
}

const query = (canvasId: string, sql: string) => queryStaged(TENANT, canvasId, sql);

describe('drugsfda staging without dataset (#93 characterization)', DUCKDB_SUITE, () => {
  it('stages drug/drugsfda against its five columns, sorted newest first on every request', async () => {
    const staged = await stage({});
    const { columns, rowCount } = await columnsOf(
      staged.canvas_id ?? '',
      staged.canvas_table ?? '',
    );

    expect(columns).toEqual(DRUGSFDA_COLUMNS);
    expect(rowCount).toBe(3);
    expect(REQUESTS.map(([endpoint]) => endpoint)).toEqual(REQUESTS.map(() => 'drug/drugsfda'));
    for (const [, params] of REQUESTS) {
      expect(params).toMatchObject({ sort: 'submissions.submission_status_date:desc' });
    }
    expect(staged.results.map((r) => r.application_number)).toEqual([
      'NDA202155',
      'ANDA210274',
      'BLA125057',
    ]);

    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT application_number, json_extract_string(openfda, '$.brand_name[0]') AS brand, products FROM ${staged.canvas_table} ORDER BY application_number`,
    );
    expect(rows.rows).toEqual([
      { application_number: 'ANDA210274', brand: null, products: expect.any(String) },
      { application_number: 'BLA125057', brand: null, products: null },
      { application_number: 'NDA202155', brand: 'ELIQUIS', products: expect.any(String) },
    ]);
  });
});

/**
 * Per dataset: its endpoint, bare-browse sort, staged columns, records, a
 * `fields` list, and each record as that list projects it — identity keys kept.
 */
const NEW_DATASETS = [
  {
    dataset: 'orangebook',
    endpoint: 'drug/orangebook',
    sort: 'approval_date:desc',
    columns: ORANGE_BOOK_COLUMNS,
    records: ORANGE_BOOK,
    fields: ['patents.patent_number'],
    projected: [
      {
        products: [{ application_number: '202155', application_type: 'N' }],
        product_number: '001',
        patents: [{ patent_number: '6967208' }, { patent_number: '6967208*PED' }],
      },
      {
        products: [{ application_number: '017105', application_type: 'N' }],
        product_number: '007',
      },
      {
        products: [{ application_number: '218668', application_type: 'A' }],
        product_number: '002',
      },
    ],
  },
  {
    dataset: 'crl',
    endpoint: 'transparency/crl',
    sort: 'letter_date:desc',
    columns: LETTER_COLUMNS,
    records: LETTERS,
    fields: ['company_name'],
    projected: [
      {
        application_number: ['BLA 761458/Original 2', 'BLA 761458'],
        file_name: 'CRL_BLA761458_20251216.pdf',
        letter_date: '12/16/2025',
        company_name: 'GlaxoSmithKline LLC',
      },
      {
        application_number: ['NDA 210274'],
        file_name: '210274_2023_Orig1s000OtherActionLtrs.pdf',
        letter_date: '08/25/2021',
        company_name: 'Zhejiang Novus Pharmaceuticals Co. Ltd.',
      },
      {
        file_name: 'Under Review for Release',
        letter_date: '02/27/2026',
        company_name: 'Chiesi Farmaceutici S.p.A',
      },
    ],
  },
] as const;

/**
 * The staged-path matrix (#93): staged or not × canvas_id supplied or omitted ×
 * skip 0 or later × fields set or not — canvas_id implies staging, so the plain
 * call takes only the omitted arm. A one-record window at skip 0 or 2.
 */
const MATRIX = NEW_DATASETS.flatMap((spec) =>
  (['plain', 'fresh canvas', 'canvas_id'] as const).flatMap((mode) =>
    [0, 2].flatMap((skip) =>
      [false, true].map((projected) => ({ spec, mode, skip, projected }) as const),
    ),
  ),
);

describe('new datasets across the staged-path matrix (#93)', DUCKDB_SUITE, () => {
  it.each(
    MATRIX.map(
      (c) =>
        [
          `${c.spec.dataset} ${c.mode} skip=${c.skip} ${c.projected ? 'fields' : 'whole'}`,
          c,
        ] as const,
    ),
  )('%s', async (_name, { spec, mode, skip, projected }) => {
    const prior = mode === 'canvas_id' ? await stage({}) : undefined;
    REQUESTS.length = 0;

    const result = await call({
      dataset: spec.dataset,
      limit: 1,
      skip,
      ...(projected ? { fields: spec.fields } : {}),
      ...(mode === 'fresh canvas' ? { stage: true } : {}),
      ...(prior ? { canvas_id: prior.canvas_id } : {}),
    });

    // Every request — the plain page, or the stage's probe, window, and drain —
    // goes to the dataset's endpoint with its newest-first sort.
    expect(REQUESTS.length).toBeGreaterThan(0);
    for (const [endpoint, params] of REQUESTS) {
      expect(endpoint).toBe(spec.endpoint);
      expect(params).toMatchObject({ sort: spec.sort });
    }

    // The inline window, projected only when fields was passed.
    expect(result.meta).toMatchObject({ total: 3, skip, limit: 1 });
    expect(result.results).toEqual([projected ? spec.projected[skip] : spec.records[skip]]);
    if (projected) expect(result.projected_fields).toEqual(spec.fields);
    else expect(result).not.toHaveProperty('projected_fields');

    if (mode === 'plain') {
      expect(result).not.toHaveProperty('canvas_id');
      return;
    }

    // The staged table holds every record whole, against the dataset's own columns.
    expect(result.staged_rows).toBe(3);
    if (prior) expect(result.canvas_id).toBe(prior.canvas_id);
    const { columns, rowCount } = await columnsOf(
      result.canvas_id ?? '',
      result.canvas_table ?? '',
    );
    expect(columns).toEqual(spec.columns);
    expect(rowCount).toBe(3);
    if (prior) {
      const priorTable = await columnsOf(prior.canvas_id ?? '', prior.canvas_table ?? '');
      expect(priorTable.columns).toEqual(DRUGSFDA_COLUMNS);
    }
  });
});

describe('Orange Book staged columns (#93)', DUCKDB_SUITE, () => {
  it('stages the product, its application, patents, and exclusivity as queryable columns', async () => {
    const staged = await stage({ dataset: 'orangebook' });
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT product_number, approval_date, approved_prior_to_1982 AS prior, json_extract_string(products, '$[0].application_type') AS type, json_extract_string(products, '$[0].application_number') AS app, json_extract_string(patents, '$[1].patent_number') AS ped, json_extract_string(exclusivity, '$[0].exclusivity_code') AS excl FROM ${staged.canvas_table} ORDER BY product_number`,
    );

    expect(rows.rows).toEqual([
      {
        product_number: '001',
        approval_date: '20121228',
        prior: null,
        type: 'N',
        app: '202155',
        ped: '6967208*PED',
        excl: 'NPP',
      },
      {
        product_number: '002',
        approval_date: '20261110',
        prior: null,
        type: 'A',
        app: '218668',
        ped: null,
        excl: null,
      },
      {
        product_number: '007',
        approval_date: null,
        prior: 'true',
        type: 'N',
        app: '017105',
        ped: null,
        excl: null,
      },
    ]);
  });
});

describe('letter staged columns (#93)', DUCKDB_SUITE, () => {
  it('stages each letter whole — its text and address exactly, its lists as JSON — whatever fields projected inline', async () => {
    const staged = await stage({ dataset: 'crl', fields: ['company_name'] });
    expect(staged.results[0]).not.toHaveProperty('text');

    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT file_name, letter_date, json_extract_string(application_number, '$[1]') AS second, json_array_length(approver_center) AS offices, approver_title, company_address, text FROM ${staged.canvas_table} ORDER BY file_name`,
    );

    expect(rows.rows).toEqual([
      {
        file_name: '210274_2023_Orig1s000OtherActionLtrs.pdf',
        letter_date: '08/25/2021',
        second: null,
        offices: expect.anything(),
        approver_title: null,
        company_address: null,
        text: 'Item 2 cites ``` and `x`.\n    An indented line.',
      },
      {
        file_name: 'CRL_BLA761458_20251216.pdf',
        letter_date: '12/16/2025',
        second: 'BLA 761458',
        offices: expect.anything(),
        approver_title: null,
        company_address: '200 Cambridge Park Drive\nCambridge, Massachusetts 02140',
        text: 'BLA 761458/Original 2\nCOMPLETE RESPONSE\n\nDear David Colton:',
      },
      {
        file_name: 'Under Review for Release',
        letter_date: '02/27/2026',
        second: null,
        offices: null,
        approver_title: null,
        company_address: null,
        text: null,
      },
    ]);
    expect(rows.rows.slice(0, 2).map((r) => Number(r.offices))).toEqual([2, 0]);
  });
});

/*
 * #100 — the cross-entry notice names a top array of the tie and reaches a
 * nested one through a nested EXISTS inside that column's JSON, so every top
 * array the catalog lists must be a staged column of its dataset; and the SQL
 * the notice prints, run on the staged table, keeps only the records where one
 * entry meets both clauses.
 */
describe('cross-entry clauses on the staged tables (#100)', DUCKDB_SUITE, () => {
  /** The listed paths with no listed array above them. */
  const topArrays = (endpoint: string) => {
    const paths = OBJECT_ARRAY_PATHS[endpoint] ?? [];
    return paths.filter((path) => !paths.some((outer) => path.startsWith(`${outer}.`)));
  };

  it.each([
    ['drugsfda', 'drug/drugsfda', ['submissions', 'products']],
    ['orangebook', 'drug/orangebook', ['products', 'patents', 'exclusivity']],
  ] as const)('stages every %s top array as a JSON column', async (dataset, endpoint, tops) => {
    const staged = await stage({ dataset });
    const { types } = await columnsOf(staged.canvas_id ?? '', staged.canvas_table ?? '');

    expect(topArrays(endpoint)).toEqual(tops);
    for (const top of tops) expect(types.get(top), top).toBe('JSON');
  });

  it('lists no array of objects for letters', () => {
    expect(OBJECT_ARRAY_PATHS['transparency/crl']).toBeUndefined();
  });

  /** Stage `search` over `records` and return the notice and the staged result. */
  async function stageTied(
    dataset: string,
    endpoint: string,
    records: Record<string, unknown>[],
    search: string,
  ) {
    DATASETS[endpoint] = records;
    const ctx = createMockContext({ errors: searchDrugApprovalsTool.errors, tenantId: TENANT });
    const result = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ dataset, search, stage: true }),
      ctx,
    );
    return { notice: String(getEnrichment(ctx).notice), result };
  }

  /** The staged SQL the notice prints, after the staging notice for the three records. */
  const stagedSql = (notice: string, table: string) => {
    const staging = notice.indexOf(`Staged 3 of 3 matched records on canvas table "${table}"`);
    const tie = notice.indexOf('openFDA matches each clause against the whole record');
    expect(staging).toBeGreaterThanOrEqual(0);
    expect(tie).toBeGreaterThan(staging);
    const sql = notice.match(/`(SELECT \* FROM [^`]+)`/)?.[1] ?? '';
    expect(sql.startsWith(`SELECT * FROM ${table} t WHERE EXISTS`)).toBe(true);
    return sql;
  };

  it('ties a Drugs@FDA letter document dated 2026 inside one submission document', async () => {
    const { notice, result } = await stageTied(
      'drugsfda',
      'drug/drugsfda',
      [
        {
          application_number: 'NDA021920',
          submissions: [
            {
              submission_type: 'SUPPL',
              submission_number: '22',
              application_docs: [
                { id: '56633', type: 'Label', date: '20181204' },
                { id: '90001', type: 'Letter', date: '20260310' },
              ],
            },
          ],
        },
        // A 2026 label and a 2019 letter in one submission's documents.
        {
          application_number: 'NDA212725',
          submissions: [
            {
              submission_type: 'SUPPL',
              application_docs: [
                { id: '90002', type: 'Label', date: '20260115' },
                { id: '60001', type: 'Letter', date: '20190820' },
              ],
            },
          ],
        },
        // The same split across two submissions.
        {
          application_number: 'BLA125409',
          submissions: [
            {
              submission_type: 'ORIG',
              application_docs: [{ id: '30001', type: 'Letter', date: '20120608' }],
            },
            {
              submission_type: 'SUPPL',
              application_docs: [{ id: '90003', type: 'Label', date: '20260201' }],
            },
          ],
        },
      ],
      'submissions.application_docs.type:"Letter" AND submissions.application_docs.date:[20260101 TO 20261231]',
    );

    expect(notice).toContain('can be met by different `submissions` entries');
    const rows = await query(result.canvas_id ?? '', stagedSql(notice, result.canvas_table ?? ''));
    expect(rows.rows.map((r) => r.application_number)).toEqual(['NDA021920']);
  });

  it('ties an Orange Book ingredient name and strength inside one active_ingredients entry', async () => {
    const amlodipine = (strength: string) => ({ name: 'AMLODIPINE BESYLATE', strength });
    const { notice, result } = await stageTied(
      'orangebook',
      'drug/orangebook',
      [
        // A combination product: amlodipine at 5 MG, benazepril at 10 MG.
        {
          approval_date: '19950303',
          product_number: '002',
          products: [
            {
              application_type: 'N',
              application_number: '020364',
              brand_name: 'LOTREL',
              active_ingredients: [
                amlodipine('EQ 5MG BASE'),
                { name: 'BENAZEPRIL HYDROCHLORIDE', strength: '10MG' },
              ],
            },
          ],
        },
        {
          approval_date: '19920731',
          product_number: '003',
          products: [
            {
              application_type: 'N',
              application_number: '019787',
              brand_name: 'NORVASC',
              active_ingredients: [amlodipine('EQ 10MG BASE')],
            },
          ],
        },
        {
          approved_prior_to_1982: true,
          product_number: '007',
          products: [{ brand_name: 'TRANXENE' }],
        },
      ],
      'products.active_ingredients.name:"AMLODIPINE BESYLATE" AND products.active_ingredients.strength:"10MG"',
    );

    const rows = await query(result.canvas_id ?? '', stagedSql(notice, result.canvas_table ?? ''));
    expect(rows.rows.map((r) => r.product_number)).toEqual(['003']);
  });
});

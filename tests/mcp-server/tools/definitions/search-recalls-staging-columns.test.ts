/**
 * @fileoverview Staged-table columns for openfda_search_recalls, per endpoint
 * shape (#59). Runs the real staging path end to end — the tool handler, the
 * real `spillSearch` drain, and a real DataCanvas (framework CanvasRegistry +
 * DuckDB provider) — with only the openFDA service stubbed, then reads the
 * table back through openfda_dataframe_describe and openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/search-recalls-staging-columns.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Records per endpoint the stubbed openFDA service pages over. */
const DATASETS: Record<string, Record<string, unknown>[]> = {};

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(async (endpoint: string, params: { limit?: number; skip?: number }) => {
      const rows = DATASETS[endpoint] ?? [];
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      return {
        meta: { total: rows.length, skip, limit, lastUpdated: '2026-09-20' },
        results: rows.slice(skip, skip + limit),
      };
    }),
  }),
  initOpenFdaService: () => {},
}));

import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { textOf } from '../../../helpers/content.js';

const TENANT = 'recalls-staging-columns';

/** Two live device/recall records (product_code:"DXN"), long free text trimmed. */
const DEVICE_RECALLS: Record<string, unknown>[] = [
  {
    cfres_id: '209973',
    product_res_number: 'Z-0032-2025',
    event_date_initiated: '2024-08-30',
    event_date_posted: '2024-10-08',
    recall_status: 'Open, Classified',
    res_event_number: '95318',
    product_code: 'DXN',
    k_numbers: ['K193627'],
    product_description: 'MEDLINE AUTOMATIC DIGITAL BLOOD PRESSURE UNIT, REF MDS1001',
    code_info: 'GTIN 00888277629656, Lot Numbers: L230380005',
    firm_fei_number: '1417592',
    recalling_firm: 'MEDLINE INDUSTRIES, LP - Northfield',
    address_1: '3 Lakes Dr',
    city: 'Northfield',
    state: 'IL',
    postal_code: '60093-2753',
    additional_info_contact: 'Haley Barclay\n886-359-1704',
    reason_for_recall: 'Blood Pressure Monitors containing a faulty microchip fail to power on.',
    root_cause_description: 'Under Investigation by firm',
    action: 'Medline issued a MEDICAL DEVICE RECALL notice.',
    product_quantity: '52,521 units',
    distribution_pattern: 'Worldwide distribution - US Nationwide, Panama, Jamaica.',
    openfda: {
      device_name: 'System, Measurement, Blood-Pressure, Non-Invasive',
      device_class: '2',
      regulation_number: '870.1130',
    },
  },
  {
    // Sparse: terminated, with fields most records omit and one they usually carry missing.
    cfres_id: '188001',
    product_res_number: 'Z-1200-2020',
    event_date_initiated: '2020-01-15',
    event_date_created: '2020-02-01',
    event_date_terminated: '2021-06-30',
    recall_status: 'Terminated',
    res_event_number: '84001',
    product_code: 'DXN',
    pma_numbers: ['P990001'],
    product_description: 'Blood pressure cuff',
    code_info: 'Lot 7',
    firm_fei_number: '3000000001',
    recalling_firm: 'Example Medical GmbH',
    address_1: 'Hauptstrasse 1',
    address_2: 'Suite 2',
    city: 'Berlin',
    country: 'Germany',
    reason_for_recall: 'Cuff seam may separate.',
    root_cause_description: 'Process control',
    action: 'Letter to consignees.',
    product_quantity: '400',
    distribution_pattern: 'US Nationwide',
    openfda: {},
  },
];

/** Live-shaped drug/enforcement record. */
const DRUG_ENFORCEMENT: Record<string, unknown>[] = [
  {
    status: 'Ongoing',
    city: 'Deerfield',
    state: 'IL',
    country: 'United States',
    classification: 'Class I',
    openfda: { brand_name: ['DEXTROSE'] },
    product_type: 'Drugs',
    event_id: '99679',
    recalling_firm: 'Baxter Healthcare Corporation',
    voluntary_mandated: 'Voluntary: Firm initiated',
    distribution_pattern: 'U.S. Nationwide.',
    recall_number: 'D-0850-2026',
    product_description: 'Dextrose Injection, USP, 70 %',
    product_quantity: '1,000 bags',
    reason_for_recall: 'Presence of Particulate Matter',
    recall_initiation_date: '20260801',
    report_date: '20260916',
    product_code: '',
  },
];

/** The enforcement table's column set as it stood before #59 — pinned so it cannot drift. */
const ENFORCEMENT_COLUMNS = [
  'recall_number',
  'event_id',
  'status',
  'classification',
  'product_type',
  'recalling_firm',
  'product_description',
  'reason_for_recall',
  'voluntary_mandated',
  'distribution_pattern',
  'product_quantity',
  'recall_initiation_date',
  'report_date',
  'state',
  'country',
  'city',
  'product_code',
  'res_event_number',
  'openfda',
];

let canvas: DataCanvas | undefined;

beforeEach(() => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: '/tmp/openfda-recalls-staging-columns-test',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
  setCanvas(canvas);
  DATASETS['device/recall'] = DEVICE_RECALLS;
  DATASETS['device/enforcement'] = DRUG_ENFORCEMENT.map((r) => ({ ...r, product_type: 'Devices' }));
  DATASETS['drug/enforcement'] = DRUG_ENFORCEMENT;
});

afterEach(async () => {
  if (canvas) await canvas.shutdown(createMockContext({ tenantId: TENANT }));
  canvas = undefined;
  setCanvas(undefined);
});

async function stage(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: searchRecallsTool.errors, tenantId: TENANT });
  const result = await searchRecallsTool.handler(
    searchRecallsTool.input.parse({ ...input, stage: true }),
    ctx,
  );
  expect(result.spilled).toBe(true);
  return result;
}

async function describeTable(canvasId: string) {
  const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: TENANT });
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ canvas_id: canvasId }),
    ctx,
  );
  return { result, text: textOf(dataframeDescribeTool.format!(result)) };
}

async function query(canvasId: string, sql: string) {
  const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: TENANT });
  return dataframeQueryTool.handler(
    dataframeQueryTool.input.parse({ canvas_id: canvasId, query: sql }),
    ctx,
  );
}

describe('openfda_search_recalls staging — enforcement columns unchanged (#59)', () => {
  it.each([
    ['drug', 'enforcement'],
    ['device', 'enforcement'],
  ])(
    '%s/%s stages the pinned enforcement column set with its values',
    async (category, endpoint) => {
      const staged = await stage({ category, endpoint });
      const { result } = await describeTable(staged.canvas_id ?? '');
      const table = result.tables.find((t) => t.name === staged.canvas_table);
      expect(table?.columns.map((c) => c.name)).toEqual(ENFORCEMENT_COLUMNS);
      expect(table?.row_count).toBe(1);

      const rows = await query(
        staged.canvas_id ?? '',
        `SELECT recall_number, classification, status, json_extract_string(openfda, '$.brand_name[0]') AS brand FROM ${staged.canvas_table}`,
      );
      expect(rows.rows).toEqual([
        {
          recall_number: 'D-0850-2026',
          classification: 'Class I',
          status: 'Ongoing',
          brand: 'DEXTROSE',
        },
      ]);
    },
  );
});

describe('openfda_search_recalls staging — device/recall columns (#59)', () => {
  const DEVICE_RECALL_SCALARS = [
    'cfres_id',
    'product_res_number',
    'res_event_number',
    'recall_status',
    'event_date_initiated',
    'event_date_posted',
    'event_date_created',
    'event_date_terminated',
    'recalling_firm',
    'firm_fei_number',
    'address_1',
    'address_2',
    'city',
    'state',
    'postal_code',
    'country',
    'additional_info_contact',
    'product_code',
    'product_description',
    'product_quantity',
    'code_info',
    'reason_for_recall',
    'root_cause_description',
    'action',
    'distribution_pattern',
  ];

  it('stages a column for every top-level field the endpoint returns', async () => {
    const staged = await stage({ category: 'device', endpoint: 'recall' });
    const { result } = await describeTable(staged.canvas_id ?? '');
    const columns = result.tables.find((t) => t.name === staged.canvas_table)?.columns ?? [];
    const names = columns.map((c) => c.name);

    for (const field of new Set(DEVICE_RECALLS.flatMap((r) => Object.keys(r)))) {
      expect(names).toContain(field);
    }
    expect(names).toEqual(expect.arrayContaining(DEVICE_RECALL_SCALARS));
    // Enforcement-only fields a device recall never carries are not staged as all-null columns.
    expect(names).not.toContain('recall_number');
    expect(names).not.toContain('classification');
    expect(names).not.toContain('voluntary_mandated');
  });

  it('populates identity, status, root cause, and dates — NULL where a record lacks the field', async () => {
    const staged = await stage({ category: 'device', endpoint: 'recall' });
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT product_res_number, recall_status, root_cause_description, event_date_initiated, event_date_posted, event_date_terminated, country FROM ${staged.canvas_table} ORDER BY product_res_number`,
    );
    expect(rows.rows).toEqual([
      {
        product_res_number: 'Z-0032-2025',
        recall_status: 'Open, Classified',
        root_cause_description: 'Under Investigation by firm',
        event_date_initiated: '2024-08-30',
        event_date_posted: '2024-10-08',
        event_date_terminated: null,
        country: null,
      },
      {
        product_res_number: 'Z-1200-2020',
        recall_status: 'Terminated',
        root_cause_description: 'Process control',
        event_date_initiated: '2020-01-15',
        event_date_posted: null,
        event_date_terminated: '2021-06-30',
        country: 'Germany',
      },
    ]);
  });

  it('stores the nested and array fields as queryable JSON', async () => {
    const staged = await stage({ category: 'device', endpoint: 'recall' });
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT product_res_number, json_extract_string(k_numbers, '$[0]') AS k, json_extract_string(pma_numbers, '$[0]') AS pma, json_extract_string(openfda, '$.device_class') AS device_class FROM ${staged.canvas_table} ORDER BY product_res_number`,
    );
    expect(rows.rows).toEqual([
      { product_res_number: 'Z-0032-2025', k: 'K193627', pma: null, device_class: '2' },
      { product_res_number: 'Z-1200-2020', k: null, pma: 'P990001', device_class: null },
    ]);
  });

  it('filters and groups on recall_status in SQL', async () => {
    const staged = await stage({ category: 'device', endpoint: 'recall' });
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT recall_status, COUNT(*) AS n FROM ${staged.canvas_table} GROUP BY recall_status ORDER BY recall_status`,
    );
    expect(rows.rows.map((r) => [r.recall_status, Number(r.n)])).toEqual([
      ['Open, Classified', 1],
      ['Terminated', 1],
    ]);
  });

  it('keeps the staged response consistent on both paths — structuredContent and content[]', async () => {
    const staged = await stage({ category: 'device', endpoint: 'recall', limit: 1 });
    expect(staged.results).toHaveLength(1);
    expect(staged.results[0]?.product_res_number).toBe('Z-0032-2025');
    expect(staged.staged_rows).toBe(2);

    const text = textOf(searchRecallsTool.format!(staged));
    expect(text).toContain(`canvas table \`${staged.canvas_table}\``);
    expect(text).toContain('**Recall #Z-0032-2025**');
    expect(text).toContain('Status: Open, Classified');

    const { text: describeText } = await describeTable(staged.canvas_id ?? '');
    for (const column of [
      'product_res_number',
      'recall_status',
      'root_cause_description',
      'event_date_posted',
    ]) {
      expect(describeText).toContain(column);
    }
  });

  it('stages both shapes onto one canvas as separate tables with their own columns', async () => {
    const first = await stage({ category: 'device', endpoint: 'recall' });
    const second = await stage({ category: 'drug', canvas_id: first.canvas_id });
    const { result } = await describeTable(first.canvas_id ?? '');
    const byName = new Map(result.tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
    expect(byName.get(first.canvas_table ?? '')).toContain('product_res_number');
    expect(byName.get(second.canvas_table ?? '')).toEqual(ENFORCEMENT_COLUMNS);
  });
});

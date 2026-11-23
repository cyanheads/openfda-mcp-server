import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { resetServerConfig } from '@/config/server-config.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  LIVE_510K,
  LIVE_CLASSIFICATION,
  LIVE_PMA,
  SPARSE_510K,
  SPARSE_CLASSIFICATION,
  SPARSE_PMA,
} from '../../../fixtures/device-records.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

/** Answer `mockQuery` from `rows`, echoing `limit` and `skip` into `meta` as the service does. */
function serve(rows: readonly Record<string, unknown>[]) {
  mockQuery.mockImplementation(
    async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      return {
        meta: { total: rows.length, skip, limit, lastUpdated: '2026-11-09' },
        results: structuredClone(rows.slice(skip, skip + limit)),
      };
    },
  );
}

/**
 * Install a canvas stub: `acquire` answers with the canvas_id it is given (a
 * fresh one otherwise), and `registerTable` drains the rows it is handed into
 * `registered`, with the schema the call passed.
 */
function stubCanvas() {
  const registered: {
    rows: Record<string, unknown>[];
    schema: { name: string; type: string }[];
  }[] = [];
  setCanvas({
    acquire: vi.fn(async (canvasId?: string) => ({
      canvasId: canvasId ?? 'cv_fresh01',
      isNew: canvasId === undefined,
      registerTable: vi.fn(
        async (
          tableName: string,
          source: AsyncIterable<Record<string, unknown>>,
          options: { schema: { name: string; type: string }[] },
        ) => {
          const rows: Record<string, unknown>[] = [];
          for await (const row of source) rows.push(row);
          registered.push({ rows, schema: options.schema });
          return { tableName, rowCount: rows.length, columns: [] };
        },
      ),
      drop: vi.fn(),
    })),
  } as never);
  return registered;
}

const contractText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

describe('openfda_search_device_clearances', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDeviceClearancesTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDeviceClearancesTool.errors });
  });

  it('queries device/510k for 510k pathway', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456', device_name: 'Test Device' }],
    });

    const result = await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'applicant:"medtronic"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('device/510k');
    expect(result.results[0]!.k_number).toBe('K123456');
  });

  it('queries device/pma for pma pathway', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: 'pma', search: 'applicant:"test"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('device/pma');
  });

  // #92 — the pathway picks the page size an omitted limit gets and the cap a larger one is clamped to.
  it.each([
    ['510k', 'device/510k', 10, 175],
    ['pma', 'device/pma', 25, 575],
    ['classification', 'device/classification', 25, 600],
  ] as const)(
    'pages the %s pathway on %s at default %i and cap %i',
    async (pathway, endpoint, fallback, cap) => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
        results: [],
      });

      const omitted = await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway }),
        ctx,
      );
      const above = await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway, limit: 5_000 }),
        ctx,
      );

      expect(mockQuery.mock.calls.map(([path, params]) => [path, params.limit])).toEqual([
        [endpoint, fallback],
        [endpoint, cap],
      ]);
      expect([omitted.meta.limit, above.meta.limit]).toEqual([fallback, cap]);
    },
  );

  // #88 — a bare browse is newest first by decision date, on either pathway.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it.each(['510k', 'pma'] as const)(
      'sends the %s pathway with neither search nor sort as decision_date:desc',
      async (pathway) => {
        mockQuery.mockResolvedValue(EMPTY);

        await searchDeviceClearancesTool.handler(
          searchDeviceClearancesTool.input.parse({ pathway }),
          ctx,
        );

        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'decision_date:desc' });
      },
    );

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'product_code:"DXN"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway: 'pma', sort: 'decision_date:asc' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'decision_date:asc' });
    });

    it('states the newest-first browse on search and the default sort on sort', () => {
      const shape = searchDeviceClearancesTool.input.shape;
      expect(shape.search.description).toContain(
        'Omit to browse newest first (unsorted on classification).',
      );
      expect(shape.sort.description).toContain(
        'With neither search nor sort, records come newest first by decision_date:desc (classification records carry no date, so a classification browse is unsorted).',
      );
    });
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 7, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456' }],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(7);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456' }],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'applicant:"medtronic"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('applicant:"medtronic"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'nonexistent' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no matching device clearances/i);
  });

  // #75 wiring: the shared search schema reads a URL-form `+` separator as a
  // space, so the service and the echo carry the spaced string.
  describe('search wiring (#75)', () => {
    const resultText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      String((result.structuredContent as { notice?: string }).notice);

    it('sends and echoes a URL-form +AND+ search with spaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [{ k_number: 'K123456' }],
      });

      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: '510k',
        search: 'applicant:"medtronic"+AND+product_code:"DXN"',
      });

      const spaced = 'applicant:"medtronic" AND product_code:"DXN"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [],
      });

      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: '510k',
        search: 'device_name.exact:"KNEE+JOINT"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"KNEE JOINT"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats 510k records', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          k_number: 'K123456',
          device_name: 'Cardiac Monitor',
          applicant: 'Medtronic',
          product_code: 'DXN',
          decision_description: 'Substantially Equivalent',
          decision_date: '20260101',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('K123456');
    expect(text).toContain('Cardiac Monitor');
    expect(text).toContain('Medtronic');
    expect(text).toContain('Substantially Equivalent');
  });

  it('formats PMA records', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          pma_number: 'P123456',
          applicant: 'Boston Scientific',
          product_code: 'NIQ',
          decision_code: 'APPR',
          decision_date: '20260101',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('P123456');
    expect(text).toContain('Boston Scientific');
    expect(text).toContain('APPR');
  });
});

/*
 * Every pathway across staged or not × canvas_id given or omitted × skip 0 or
 * later × fields or not: the requests each call sends, the whole records it
 * stages, and the records it returns on both surfaces. The 510(k) and PMA rows
 * were pinned against 0.10.0 before the classification pathway, the per-pathway
 * staging columns, and the cursor landed, and hold unchanged.
 */
describe('openfda_search_device_clearances — pages across staging, skip, and fields', () => {
  const PATHWAYS = [
    {
      pathway: '510k',
      endpoint: 'device/510k',
      sort: 'decision_date:desc',
      field: 'decision_date',
      rows: [...LIVE_510K, SPARSE_510K],
      project: (r: Record<string, unknown>): Record<string, unknown> => ({
        k_number: r.k_number,
        decision_date: r.decision_date,
      }),
      wholeLines: [
        [
          '### K260132: Jason membrane',
          '**Applicant:** Botiss Biomaterials GmbH | **Product code:** NPL',
          '**Decision:** Substantially Equivalent (2026-11-08)',
          '**Advisory committee:** Dental',
          '**Clearance type:** Traditional',
          '**Summary:** Summary',
        ],
        [
          '### K262755: Wave Electrode;Remote Wave Electrode',
          '**Applicant:** Bionit Labs Srl | **Product code:** GXY',
          '**Decision:** Substantially Equivalent (2026-11-06)',
        ],
        [
          '### K000017: Catheter, Intravascular',
          '**Applicant:** Example Medical | **Product code:** DQO',
          '**Decision:** Substantially Equivalent (1976-08-02)',
        ],
      ],
      projectedLines: [
        ['### k_number: K260132', '**Decision date:** 2026-11-08'],
        ['### k_number: K262755', '**Decision date:** 2026-11-06'],
        ['### k_number: K000017', '**Decision date:** 1976-08-02'],
      ],
    },
    {
      pathway: 'pma',
      endpoint: 'device/pma',
      sort: 'decision_date:desc',
      field: 'decision_date',
      rows: [...LIVE_PMA, SPARSE_PMA],
      project: (r: Record<string, unknown>): Record<string, unknown> => ({
        pma_number: r.pma_number,
        ...(r.supplement_number !== undefined && { supplement_number: r.supplement_number }),
        decision_date: r.decision_date,
      }),
      wholeLines: [
        [
          '### P980040: TECNIS SYMFONY EXTENDED RANGE OF VISION INTRAOCULAR LENS',
          '**Applicant:** Johnson & Johnson Surgical Vision, Inc. | **Product code:** POE',
          '**Decision:** APPR (2016-07-15)',
          '**Advisory committee:** Ophthalmic',
          '**Supplement:** S065',
        ],
        [
          '### P970043: LADARVISION EXCIMER LASER SYSTEM',
          '**Applicant:** Alcon Laboratories | **Product code:** LZS',
          '**Decision:** APPR (2000-05-09)',
          '**Supplement:** S005',
        ],
        [
          '### P000001: EXAMPLE VALVE',
          '**Applicant:** Example Devices | **Product code:** DYE',
          '**Decision:** APPR (2001-03-02)',
        ],
      ],
      projectedLines: [
        ['### pma_number: P980040', '**Supplement number:** S065', '**Decision date:** 2016-07-15'],
        ['### pma_number: P970043', '**Supplement number:** S005', '**Decision date:** 2000-05-09'],
        ['### pma_number: P000001', '**Decision date:** 2001-03-02'],
      ],
    },
    {
      pathway: 'classification',
      endpoint: 'device/classification',
      sort: undefined,
      field: 'device_class',
      rows: LIVE_CLASSIFICATION.slice(0, 3),
      project: (r: Record<string, unknown>): Record<string, unknown> => ({
        product_code: r.product_code,
        device_class: r.device_class,
      }),
      wholeLines: [
        [
          '### QBJ: Integrated Continuous Glucose Monitoring System, Factory Calibrated',
          '**Class:** Class II (2) | **Submission type:** 510(k) (1)',
          '**Regulation number:** 862.1355',
        ],
        ['### JDT: Cap, Bone', '**Class:** Class I (1) | **Submission type:** 510(k) exempt (4)'],
        [
          '### OLM: Deep Brain Stimulator For Obsessive Compulsive Disorder (Ocd)',
          '**Class:** HDE (f) | **Submission type:** 6',
        ],
      ],
      projectedLines: [
        ['### product_code: QBJ', '**Device class:** 2'],
        ['### product_code: JDT', '**Device class:** 1'],
        ['### product_code: OLM', '**Device class:** f'],
      ],
    },
  ] as const;

  const CELLS = PATHWAYS.flatMap((p) =>
    (['inline', 'stage', 'canvas_id'] as const).flatMap((mode) =>
      ([0, 1] as const).flatMap((skip) =>
        ([false, true] as const).map((projected) => ({ ...p, mode, skip, projected })),
      ),
    ),
  );

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  afterEach(() => {
    setCanvas(undefined);
  });

  it.each(CELLS.map((cell) => [cell.pathway, cell.mode, cell.skip, cell.projected, cell] as const))(
    '%s, %s, skip %i, fields %s',
    async (_pathway, mode, skip, projected, cell) => {
      serve(cell.rows);
      const registered = mode === 'inline' ? [] : stubCanvas();

      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: cell.pathway,
        limit: 2,
        skip,
        ...(projected && { fields: [cell.field] }),
        ...(mode === 'stage' && { stage: true }),
        ...(mode === 'canvas_id' && { canvas_id: 'cv_0000000' }),
      });

      expect(result.isError).toBeFalsy();
      const { notice, ...structured } = result.structuredContent as Record<string, unknown>;
      const window = cell.rows.slice(skip, skip + 2);
      expect(structured).toEqual({
        meta: { total: 3, skip, limit: 2, lastUpdated: '2026-11-09' },
        results: projected ? window.map(cell.project) : window,
        ...(projected && { projected_fields: [cell.field] }),
        ...(mode !== 'inline' && {
          canvas_id: mode === 'canvas_id' ? 'cv_0000000' : 'cv_fresh01',
          canvas_table: expect.stringMatching(/^spilled_[0-9a-f]{8}$/),
          spilled: true,
          staged_rows: 3,
        }),
        totalResults: 3,
      });
      if (mode === 'inline' && !projected) expect(notice).toBeUndefined();
      else expect(notice).toEqual(expect.any(String));

      // The requests: one inline page, or the stage's probe from skip 0; the pathway's sort either way.
      for (const [endpoint, params] of mockQuery.mock.calls) {
        expect(endpoint).toBe(cell.endpoint);
        expect(params.sort).toBe(cell.sort);
        expect(params.search).toBeUndefined();
      }
      if (mode === 'inline') {
        expect(mockQuery.mock.calls.map(([, params]) => [params.limit, params.skip])).toEqual([
          [2, skip],
        ]);
      } else {
        expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ skip: 0 });
        // The drain stages whole records, whatever the inline page was cut to.
        expect(registered.map(({ rows }) => rows)).toEqual([cell.rows]);
        // Against the pathway's own column list: every field its records carry, nothing else (#105).
        expect(new Set(registered[0]?.schema.map((c) => c.name))).toEqual(
          new Set(Object.keys(cell.rows[0] ?? {})),
        );
      }

      const text = contractText(result);
      expect(text).toContain(
        `**3 total results** (returned: 2, skip: ${skip}, limit: 2) | Data updated: 2026-11-09`,
      );
      const lines = projected ? cell.projectedLines : cell.wholeLines;
      for (const expected of lines.slice(skip, skip + 2)) {
        const at = text.indexOf(`${expected[0]}\n`);
        expect(at, expected[0]).toBeGreaterThanOrEqual(0);
        for (const line of expected) expect(text.slice(at)).toContain(`${line}\n`);
      }
      for (const unexpected of lines.filter((_, i) => i < skip || i >= skip + 2)) {
        expect(text).not.toContain(unexpected[0]);
      }
      if (mode !== 'inline') {
        expect(text).toContain(`canvas table \`${String(structured.canvas_table)}\``);
      }
    },
  );
});

/* --- #96: the classification pathway reads device/classification --- */

describe('openfda_search_device_clearances — classification pathway (#96)', () => {
  const ROWS = [...LIVE_CLASSIFICATION, SPARSE_CLASSIFICATION];

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  afterEach(() => {
    setCanvas(undefined);
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  describe('requests', () => {
    it('sends a bare browse to device/classification with no sort, inline and staged', async () => {
      serve(ROWS);
      await runToolContract(searchDeviceClearancesTool, { pathway: 'classification' });
      stubCanvas();
      const staged = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        stage: true,
      });

      expect(staged.isError).toBeFalsy();
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [endpoint, params] of mockQuery.mock.calls) {
        expect(endpoint).toBe('device/classification');
        expect(params.sort).toBeUndefined();
      }
    });

    it('sends an explicit sort as given, inline and staged', async () => {
      serve(ROWS);
      await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        sort: 'device_name.exact:asc',
      });
      stubCanvas();
      await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        sort: 'regulation_number.exact:desc',
        stage: true,
      });

      expect(mockQuery.mock.calls.map(([, params]) => params.sort)).toEqual([
        'device_name.exact:asc',
        ...mockQuery.mock.calls.slice(1).map(() => 'regulation_number.exact:desc'),
      ]);
    });

    it('sends a search alone with no sort', async () => {
      serve(ROWS);
      await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        search: 'product_code:"qbj"',
      });

      expect(mockQuery.mock.calls[0]).toEqual([
        'device/classification',
        expect.objectContaining({ search: 'product_code:"qbj"', sort: undefined, limit: 25 }),
        expect.anything(),
      ]);
    });

    it('keeps product_code, and only it, as the identity key of a projected record', async () => {
      serve(ROWS);
      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        fields: ['device_class'],
        limit: 2,
      });

      expect((result.structuredContent as { results: unknown[] }).results).toEqual([
        { product_code: 'QBJ', device_class: '2' },
        { product_code: 'JDT', device_class: '1' },
      ]);
      expect(contractText(result)).toContain('### product_code: QBJ\n**Device class:** 2\n');
    });
  });

  describe('format()', () => {
    const render = (results: Record<string, unknown>[]) =>
      textOf(
        searchDeviceClearancesTool.format!({
          meta: { total: results.length, skip: 0, limit: 25, lastUpdated: '2026-11-09' },
          results,
        }),
      );

    it('renders a record under its product code and name, class and submission type labelled, then every other field', () => {
      expect(render([LIVE_CLASSIFICATION[0]!])).toBe(
        [
          '**1 total results** (returned: 1, skip: 0, limit: 25) | Data updated: 2026-11-09',
          '',
          '### QBJ: Integrated Continuous Glucose Monitoring System, Factory Calibrated',
          '**Class:** Class II (2) | **Submission type:** 510(k) (1)',
          '**Third party flag:** N',
          '**Life sustain support flag:** N',
          '**Gmp exempt flag:** N',
          '**Summary malfunction reporting:** Ineligible',
          '**Openfda:** k_number=K222447, K201328; registration_number=3004753838, 3038285067; fei_number=3004753838, 3038285067',
          '**Review panel:** CH',
          '**Medical specialty:** CH',
          '**Medical specialty description:** Clinical Chemistry',
          '**Definition:** An integrated continuous glucose monitoring system (iCGM) is intended to automatically measure glucose in bodily fluids continuously or frequently for a specified period of time.',
          '**Regulation number:** 862.1355',
          '**Implant flag:** N',
          '',
        ].join('\n'),
      );
    });

    it.each([
      ['JDT', '**Class:** Class I (1) | **Submission type:** 510(k) exempt (4)'],
      ['OLM', '**Class:** HDE (f) | **Submission type:** 6'],
      ['LKX', '**Class:** unclassified (U) | **Submission type:** 510(k) (1)'],
      ['RDG', '**Class:** not classified (N)'],
    ])('labels %s as %j, an undefined code as sent', (code, line) => {
      const record = LIVE_CLASSIFICATION.find((r) => r.product_code === code)!;
      const text = render([record]);
      expect(text).toContain(`### ${code}: ${String(record.device_name)}\n${line}\n`);
    });

    it('names the unclassified reason and every flag an unclassified record carries', () => {
      const text = render([LIVE_CLASSIFICATION.find((r) => r.product_code === 'LKX')!]);
      expect(text).toContain('**Unclassified reason:** 1\n');
      expect(text).toContain('**Openfda:** k_number=K822217, K855150\n');
    });

    it('renders a sparse record as its heading and class alone, inventing nothing', () => {
      expect(render([SPARSE_CLASSIFICATION])).toBe(
        [
          '**1 total results** (returned: 1, skip: 0, limit: 25) | Data updated: 2026-11-09',
          '',
          '### ZZZ: Example Device Type',
          '**Class:** Class III (3)',
          '',
        ].join('\n'),
      );
    });

    it('carries every non-empty scalar of every classification record into content[]', () => {
      const scalars = (value: unknown): string[] =>
        value == null || value === ''
          ? []
          : typeof value === 'object'
            ? Object.values(value).flatMap(scalars)
            : [String(value)];
      for (const record of [...LIVE_CLASSIFICATION, SPARSE_CLASSIFICATION]) {
        const text = render([record]);
        const missing = scalars(record).filter((leaf) => !text.includes(leaf));
        expect(missing, String(record.product_code)).toEqual([]);
      }
    });

    it('leaves 510(k) and PMA records on their own branches', () => {
      const text = render([LIVE_510K[0]!, LIVE_PMA[0]!]);
      expect(text).toContain('### K260132: Jason membrane\n');
      expect(text).toContain('### P980040: TECNIS SYMFONY');
      expect(text).not.toContain('**Class:**');
    });
  });

  describe('both surfaces', () => {
    it('keeps raw codes in structuredContent and carries them, labelled, in content[]', async () => {
      serve(ROWS);
      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
      });

      const structured = result.structuredContent as {
        meta: { total: number; limit: number };
        results: Record<string, unknown>[];
      };
      expect(structured.meta).toMatchObject({ total: 6, limit: 25 });
      expect(structured.results).toEqual(ROWS);
      const text = contractText(result);
      for (const record of ROWS) {
        expect(text).toContain(
          `### ${String(record.product_code)}: ${String(record.device_name)}\n`,
        );
        expect(text).toContain(`(${String(record.device_class)})`);
      }
    });

    it('names classification fields when nothing matched', async () => {
      serve([]);
      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        search: 'product_code:"QQQ"',
      });

      const { notice } = result.structuredContent as { notice?: string };
      expect(notice).toContain(
        'No matching device classifications found. Try broadening the search — use product_code, device_name, regulation_number, device_class, or submission_type_id fields.',
      );
      expect(notice).not.toContain('advisory_committee_description');
      expect(contractText(result)).toContain('No device records found.');
    });

    it('says the offset is past the end, never a no-match, when skip overshoots the match', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 6, skip: 40, limit: 25, lastUpdated: '2026-11-09' },
        results: [],
      });
      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        skip: 40,
      });

      const { notice } = result.structuredContent as { notice?: string };
      expect(notice).toContain('No records at skip=40: 6 matched');
      expect(contractText(result)).toContain('6 matched, but skip=40 is past the end');
      expect(contractText(result)).not.toContain('No device records found.');
    });

    it('clamps a limit above 600 to the classification cap and says so', async () => {
      serve(ROWS);
      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        limit: 5_000,
      });

      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ limit: 600 });
      const { notice } = result.structuredContent as { notice?: string };
      expect(notice).toContain('limit=5000 is above the 600-record cap for device/classification');
      expect(notice).toContain('this page holds the last 6 of the 6 matched records');
    });
  });

  describe('strict limits (OPENFDA_CLAMP_LIMITS=false)', () => {
    beforeEach(() => {
      vi.stubEnv('OPENFDA_CLAMP_LIMITS', 'false');
      resetServerConfig();
    });

    it('accepts 600 on classification and refuses 601 at argument validation', async () => {
      serve(ROWS);
      const ok = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        limit: 600,
      });
      const over = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        limit: 601,
      });

      expect(ok.isError).toBeFalsy();
      expect(over.isError).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['510k', 175],
      ['pma', 575],
    ] as const)('refuses 600 on %s as limit_above_cap, its own cap %i', async (pathway, cap) => {
      const result = await runToolContract(searchDeviceClearancesTool, { pathway, limit: 600 });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as {
        error: { data?: { reason?: string; cap?: number } };
      };
      expect(error.data).toMatchObject({ reason: 'limit_above_cap', cap });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  it('rejects a pathway outside the three at argument validation', async () => {
    const result = await runToolContract(searchDeviceClearancesTool, {
      pathway: 'de_novo',
    } as never);
    expect(result.isError).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

/*
 * #97 — the cursor on every pathway. The token itself is tabled in
 * pagination-cursor.test.ts and the shared handler contract in
 * pagination-contract.test.ts; these prove what differs by pathway: the endpoint
 * and sort a token binds, classification's absent sort included.
 */
describe('openfda_search_device_clearances — cursor (#97)', () => {
  /** A page of `rows` from `from`, linked onward the way openFDA links a skip 0 or cursor page. */
  function linkedPage(rows: readonly Record<string, unknown>[], from: number, limit: number) {
    const results = structuredClone(rows.slice(from, from + limit));
    return {
      meta: { total: rows.length, skip: from, limit, lastUpdated: '2026-11-09' },
      results,
      nextSearchAfter: `0=after-${from + results.length}`,
    };
  }

  const PATHWAY_ROWS = [
    ['510k', 'device/510k', 'decision_date:desc', [...LIVE_510K, SPARSE_510K]],
    ['pma', 'device/pma', 'decision_date:desc', [...LIVE_PMA, SPARSE_PMA]],
    ['classification', 'device/classification', undefined, LIVE_CLASSIFICATION],
  ] as const;

  const failureOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (
      result.structuredContent as unknown as {
        error: { message: string; data?: { reason?: string } };
      }
    ).error;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  afterEach(() => {
    setCanvas(undefined);
  });

  it('advertises cursor and next_cursor and declares the shared entries', () => {
    const input = z.toJSONSchema(searchDeviceClearancesTool.input) as unknown as {
      properties: Record<string, { pattern?: string }>;
      required?: string[];
    };
    expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
    expect(input.required ?? []).not.toContain('cursor');
    const output = z.toJSONSchema(searchDeviceClearancesTool.output) as unknown as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(output.properties.next_cursor?.type).toBe('string');
    expect(output.required ?? []).not.toContain('next_cursor');
    expect(searchDeviceClearancesTool.errors).toContain(invalidCursorError);
    expect(searchDeviceClearancesTool.errors).toContain(paginationLimitReachedError);
    expect(
      searchDeviceClearancesTool.errors?.filter((e) => e.reason === 'pagination_limit_reached'),
    ).toHaveLength(1);
  });

  it.each(PATHWAY_ROWS)(
    '%s: issues next_cursor on a skip 0 page and follows it on %s with the sort it bound',
    async (pathway, endpoint, sort, rows) => {
      mockQuery.mockResolvedValueOnce(linkedPage(rows, 0, 2));
      const first = await runToolContract(searchDeviceClearancesTool, { pathway, limit: 2 });
      const { next_cursor } = first.structuredContent as { next_cursor?: string };
      expect(next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(contractText(first)).toContain(`\nnext_cursor: \`${next_cursor}\`\n`);

      mockQuery.mockResolvedValueOnce(linkedPage(rows, 2, 2));
      const second = await runToolContract(searchDeviceClearancesTool, {
        pathway,
        limit: 2,
        cursor: next_cursor,
      });

      expect(second.isError).toBeFalsy();
      expect(mockQuery.mock.calls.map(([path, params]) => [path, params.sort])).toEqual([
        [endpoint, sort],
        [endpoint, sort],
      ]);
      expect(mockQuery.mock.calls[1]?.[1]).toMatchObject({
        searchAfter: { value: '0=after-2', position: 2 },
      });
      expect(mockQuery.mock.calls[1]?.[1].skip ?? 0).toBe(0);
      const structured = second.structuredContent as {
        meta: { skip: number };
        next_cursor?: string;
        results: unknown[];
      };
      expect(structured.meta.skip).toBe(2);
      expect(structured.results).toEqual(rows.slice(2, 4));
    },
  );

  it('ends a classification walk on the page holding the last record, on both surfaces', async () => {
    mockQuery.mockResolvedValueOnce(linkedPage(LIVE_CLASSIFICATION, 0, 3));
    const first = await runToolContract(searchDeviceClearancesTool, {
      pathway: 'classification',
      limit: 3,
    });
    const { next_cursor } = first.structuredContent as { next_cursor?: string };

    mockQuery.mockResolvedValueOnce(linkedPage(LIVE_CLASSIFICATION, 3, 3));
    const last = await runToolContract(searchDeviceClearancesTool, {
      pathway: 'classification',
      limit: 3,
      cursor: next_cursor,
    });

    const structured = last.structuredContent as { next_cursor?: string; notice?: string };
    expect(structured.next_cursor).toBeUndefined();
    expect(structured.notice).toContain(
      'This page holds the last 2 of the 5 matched records, so the cursor walk is complete.',
    );
    expect(contractText(last)).toContain('so the cursor walk is complete.');
    expect(contractText(last)).not.toContain('next_cursor:');
  });

  it.each([
    ['a pathway', { pathway: 'pma' }],
    ['a sort', { sort: 'device_name.exact:asc' }],
    ['a search', { search: 'device_class:"2"' }],
  ])(
    'refuses a classification cursor presented with %s it was not issued for',
    async (_case, change) => {
      mockQuery.mockResolvedValueOnce(linkedPage(LIVE_CLASSIFICATION, 0, 2));
      const first = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        limit: 2,
      });
      const { next_cursor } = first.structuredContent as { next_cursor?: string };

      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: 'classification',
        limit: 2,
        cursor: next_cursor,
        ...change,
      } as never);

      expect(result.isError).toBe(true);
      expect(failureOf(result).data?.reason).toBe('invalid_cursor');
      expect(failureOf(result).message).toContain('different endpoint, search, or sort');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    },
  );

  it('returns no next_cursor on a staged page, even when openFDA linked one', async () => {
    stubCanvas();
    mockQuery.mockResolvedValue(linkedPage(LIVE_CLASSIFICATION, 0, 5));
    const staged = await runToolContract(searchDeviceClearancesTool, {
      pathway: 'classification',
      limit: 2,
      stage: true,
    });
    expect(staged.isError).toBeFalsy();
    expect(Object.keys(staged.structuredContent as object)).not.toContain('next_cursor');
    for (const [, params] of mockQuery.mock.calls) expect(params.searchAfter).toBeUndefined();
  });
});

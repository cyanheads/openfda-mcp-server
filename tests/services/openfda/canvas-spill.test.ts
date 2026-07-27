/**
 * @fileoverview Tests for the spillSearch DataCanvas helper. The mock
 * CanvasInstance drains the async source registerTable receives, so the paging
 * cadence, the byte budget, the 25k ceiling, and the truncation signal all run
 * for real with only the openFDA service and the canvas accessor stubbed.
 * @module tests/services/openfda/canvas-spill.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    setCanvas: (c: unknown) => {
      _canvas = c;
    },
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

vi.mock('@/services/openfda/openfda-service.js', () => {
  let _svc: unknown;
  return {
    getOpenFdaService: () => _svc,
    initOpenFdaService: () => {},
    __setMock: (s: unknown) => {
      _svc = s;
    },
  };
});

import { OPENFDA_MAX_ROWS, spillSearch, stagingNotice } from '@/services/openfda/canvas-spill.js';

async function setCanvasMock(c: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(c);
}

async function setSvcMock(s: unknown) {
  const mod = await import('@/services/openfda/openfda-service.js');
  (mod as unknown as { __setMock: (s: unknown) => void }).__setMock(s);
}

/**
 * Paged openFDA service stub over a synthetic dataset of `total` rows.
 * `rowBytes` pads each record so the byte-budget path can be exercised.
 */
function makeSvc(total: number, rowBytes = 0) {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const end = Math.min(skip + limit, total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) {
        results.push(
          rowBytes > 0
            ? { id: `r${i}`, val: i, blob: 'x'.repeat(rowBytes) }
            : { id: `r${i}`, val: i },
        );
      }
      return { meta: { total, skip, limit, lastUpdated: '2026-06-01' }, results };
    }),
  };
}

/** Mock canvas whose registerTable drains the async source and counts the rows. */
function makeCanvas(canvasId = 'cv_test') {
  const instance = {
    canvasId,
    isNew: true,
    registerTable: vi.fn(
      async (
        name: string,
        source: AsyncIterable<Record<string, unknown>> | Record<string, unknown>[],
      ) => {
        let rowCount = 0;
        for await (const _row of source as AsyncIterable<Record<string, unknown>>) rowCount++;
        return { tableName: name, rowCount, columns: [] };
      },
    ),
    drop: vi.fn(),
  };
  return { canvas: { acquire: vi.fn().mockResolvedValue(instance) }, instance };
}

const SCHEMA = [
  { name: 'id', type: 'VARCHAR' as const, nullable: true },
  { name: 'val', type: 'VARCHAR' as const, nullable: true },
];

describe('spillSearch', () => {
  beforeEach(async () => {
    await setCanvasMock(undefined);
  });

  it('throws when canvas is disabled', async () => {
    await setSvcMock(makeSvc(10));
    const ctx = createMockContext();
    await expect(
      spillSearch({ endpoint: 'drug/event', schema: SCHEMA, ctx, limit: 10, skip: 0 }),
    ).rejects.toThrow('DataCanvas is not enabled');
  });

  it('stages the matched set and reports staged rows with no truncation when it all fits', async () => {
    const svc = makeSvc(2500);
    await setSvcMock(svc);
    const { canvas, instance } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.spilled).toBe(true);
    expect(result.canvasId).toBe('cv_test');
    expect(result.tableName).toMatch(/^spilled_[0-9a-f]{8}$/);
    expect(result.total).toBe(2500);
    expect(result.stagedRows).toBe(2500);
    expect(result.truncated).toBe(false);
    expect(instance.registerTable).toHaveBeenCalledOnce();
  });

  it('bounds the drain by a byte budget so large records cannot run away (#30)', async () => {
    // ~70 KB per record — the drug/event shape that made a limit:10 call take minutes.
    const svc = makeSvc(30_000, 70_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.total).toBe(30_000);
    expect(result.stagedRows).toBeGreaterThan(0);
    expect(result.stagedRows).toBeLessThan(1_000);
    expect(result.truncated).toBe(true);
    // The old drain issued 25 upstream requests for 25,000 rows regardless of limit.
    expect(svc.query.mock.calls.length).toBeLessThan(10);
  });

  it('caps the drain at the 25000-row openFDA ceiling for small records', async () => {
    const svc = makeSvc(40_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/shortages',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.stagedRows).toBe(OPENFDA_MAX_ROWS);
    expect(result.truncated).toBe(true);
    const maxSkip = Math.max(...svc.query.mock.calls.map((c) => c[1].skip ?? 0));
    expect(maxSkip).toBeLessThan(OPENFDA_MAX_ROWS);
  });

  it('serves the inline page from the matched set at the caller offset (#32)', async () => {
    const svc = makeSvc(2500);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 3,
      skip: 5,
    });

    expect(result.skip).toBe(5);
    expect(result.preview.map((r) => r.id)).toEqual(['r5', 'r6', 'r7']);
  });

  it('fetches the inline page directly when the offset is past the probe window (#32)', async () => {
    const svc = makeSvc(1175);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/shortages',
      schema: SCHEMA,
      ctx,
      limit: 2,
      skip: 300,
    });

    expect(result.preview.map((r) => r.id)).toEqual(['r300', 'r301']);
    expect(svc.query.mock.calls.some((c) => c[1].skip === 300 && c[1].limit === 2)).toBe(true);
  });

  it('returns an empty page with a note-worthy total when the offset runs past the end (#32)', async () => {
    const svc = makeSvc(50);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/shortages',
      schema: SCHEMA,
      ctx,
      limit: 5,
      skip: 100,
    });

    expect(result.preview).toHaveLength(0);
    expect(result.total).toBe(50);
    expect(result.stagedRows).toBe(50);
  });

  it('keeps the inline page even when a single record is larger than any preview budget (#31)', async () => {
    // One 70 KB record could never fit a character-budgeted preview.
    const svc = makeSvc(600, 70_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 2,
      skip: 0,
    });

    expect(result.preview).toHaveLength(2);
    expect(result.total).toBe(600);
  });

  it('stages nothing when the query matched no records', async () => {
    const svc = makeSvc(0);
    await setSvcMock(svc);
    const { canvas, instance } = makeCanvas('cv_empty');
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 10,
      skip: 0,
    });

    expect(result.spilled).toBe(false);
    expect(result.stagedRows).toBe(0);
    expect(result.tableName).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.canvasId).toBe('cv_empty');
    expect(instance.registerTable).not.toHaveBeenCalled();
  });

  it('stages the same rows regardless of the caller limit', async () => {
    await setSvcMock(makeSvc(2500));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const small = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 3,
      skip: 0,
    });
    const large = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      limit: 50,
      skip: 0,
    });

    expect(small.preview).toHaveLength(3);
    expect(large.preview).toHaveLength(50);
    expect(small.stagedRows).toBe(large.stagedRows);
  });
});

describe('stagingNotice', () => {
  const base = {
    canvasId: 'cv_1',
    lastUpdated: '2026-06-01',
    preview: [],
    skip: 0,
    spilled: true,
    stagedRows: 235,
    tableName: 'spilled_ab12cd34',
    total: 609_468,
  };

  it('routes a truncated stage to openfda_count_values for whole-match aggregates (#36)', () => {
    const notice = stagingNotice({ ...base, truncated: true });
    expect(notice).toContain('narrow the query');
    expect(notice).toContain('openfda_count_values');
  });

  it('omits the aggregate route when the whole match was staged (#36)', () => {
    const notice = stagingNotice({ ...base, stagedRows: 609_468, truncated: false });
    expect(notice).not.toContain('openfda_count_values');
  });
});

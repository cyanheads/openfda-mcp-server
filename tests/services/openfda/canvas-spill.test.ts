/**
 * @fileoverview Tests for the spillSearch DataCanvas helper. Exercises the real
 * spillover() against a mock CanvasInstance whose registerTable drains the async
 * source — so the lazy drain paging, the 25k ceiling, and the truncated signal
 * run for real, with only the openFDA service and canvas accessor stubbed.
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

import { spillSearch } from '@/services/openfda/canvas-spill.js';

async function setCanvasMock(c: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(c);
}

async function setSvcMock(s: unknown) {
  const mod = await import('@/services/openfda/openfda-service.js');
  (mod as unknown as { __setMock: (s: unknown) => void }).__setMock(s);
}

/** Paged openFDA service stub backed by a synthetic dataset of `total` rows. */
function makeSvc(total: number) {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const end = Math.min(skip + limit, total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) results.push({ id: `r${i}`, val: i });
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
    await expect(spillSearch({ endpoint: 'drug/event', schema: SCHEMA, ctx })).rejects.toThrow(
      'DataCanvas is not enabled',
    );
  });

  it('stages the full set, pages lazily, and reports no truncation when all rows fit the ceiling', async () => {
    const svc = makeSvc(2500);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      previewChars: 100, // tiny budget forces a spill
    });

    expect(result.spilled).toBe(true);
    expect(result.canvasId).toBe('cv_test');
    expect(result.tableName).not.toBe('');
    expect(result.total).toBe(2500);
    expect(result.truncated).toBe(false);
    // First page fetched at skip 0, then paged forward at the 1000-row cap.
    expect(svc.query.mock.calls[0][1]).toMatchObject({ skip: 0, limit: 1000 });
    const skips = svc.query.mock.calls.map((c) => c[1].skip);
    expect(skips).toEqual([0, 1000, 2000]);
  });

  it('caps the drain at 25000 rows and reports truncated when more match upstream', async () => {
    const svc = makeSvc(30_000);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({
      endpoint: 'drug/event',
      schema: SCHEMA,
      ctx,
      previewChars: 100,
    });

    expect(result.spilled).toBe(true);
    expect(result.total).toBe(30_000);
    expect(result.truncated).toBe(true);
    // Never requests a skip past the 25000 ceiling.
    const maxSkip = Math.max(...svc.query.mock.calls.map((c) => c[1].skip ?? 0));
    expect(maxSkip).toBeLessThanOrEqual(24_000);
  });

  it('returns an inline preview with no canvas table when the result fits', async () => {
    const svc = makeSvc(3);
    await setSvcMock(svc);
    const { canvas, instance } = makeCanvas('cv_small');
    await setCanvasMock(canvas);

    const ctx = createMockContext();
    const result = await spillSearch({ endpoint: 'drug/event', schema: SCHEMA, ctx });

    expect(result.spilled).toBe(false);
    expect(result.canvasId).toBe('cv_small');
    expect(result.tableName).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.preview).toHaveLength(3);
    expect(instance.registerTable).not.toHaveBeenCalled();
  });
});

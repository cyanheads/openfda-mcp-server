/**
 * @fileoverview Canvas spillover path for openfda_search_recalls — the same
 * wiring every search tool shares. Drives the tool handler with canvas enabled
 * (mock service + mock canvas instance, real spillover) and confirms the
 * non-canvas path is unchanged when canvas is disabled.
 * @module tests/mcp-server/tools/definitions/search-recalls-canvas.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';

async function setCanvasMock(c: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(c);
}
async function setSvcMock(s: unknown) {
  const mod = await import('@/services/openfda/openfda-service.js');
  (mod as unknown as { __setMock: (s: unknown) => void }).__setMock(s);
}

function makeSvc(total: number) {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const end = Math.min(skip + limit, total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) {
        results.push({ recall_number: `R-${i}`, classification: 'Class I' });
      }
      return { meta: { total, skip, limit, lastUpdated: '2026-06-01' }, results };
    }),
  };
}

function makeCanvas(canvasId = 'cv_recalls') {
  const instance = {
    canvasId,
    isNew: true,
    registerTable: vi.fn(async (name: string, source: AsyncIterable<Record<string, unknown>>) => {
      let rowCount = 0;
      for await (const _row of source) rowCount++;
      return { tableName: name, rowCount, columns: [] };
    }),
    drop: vi.fn(),
  };
  return { acquire: vi.fn().mockResolvedValue(instance) };
}

describe('openfda_search_recalls — canvas disabled', () => {
  beforeEach(async () => {
    await setCanvasMock(undefined);
    await setSvcMock(makeSvc(1));
  });

  it('returns the classic shape with no canvas fields', async () => {
    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    const input = searchRecallsTool.input.parse({ category: 'drug' });
    const result = await searchRecallsTool.handler(input, ctx);
    expect(result.results).toHaveLength(1);
    expect(result.spilled).toBeUndefined();
    expect(result.canvas_id).toBeUndefined();
    expect(result.canvas_table).toBeUndefined();
  });
});

describe('openfda_search_recalls — canvas spillover', () => {
  beforeEach(async () => {
    await setCanvasMock(makeCanvas());
  });

  it('stages the full set and surfaces canvas fields when spilled', async () => {
    await setSvcMock(makeSvc(2500));
    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    const input = searchRecallsTool.input.parse({
      category: 'drug',
      search: 'classification:"Class I"',
    });
    const result = await searchRecallsTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('cv_recalls');
    expect(result.canvas_table).not.toBe('');
    expect(result.meta.total).toBe(2500);
    expect(result.truncated).toBeUndefined(); // 2500 < 25000 ceiling

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(2500);
    expect(enrichment.effectiveQuery).toBe('classification:"Class I"');
    expect(enrichment.notice).toContain('openfda_dataframe_query');
  });

  it('still resolves the endpoint and enforces the recall/device guard', async () => {
    await setSvcMock(makeSvc(5));
    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    // recall endpoint on a non-device category must throw before any canvas work
    await expect(
      searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category: 'food', endpoint: 'recall' }),
        ctx,
      ),
    ).rejects.toThrow(/only available for devices/i);
  });

  it('reflects canvas pointers in the formatted text', () => {
    const blocks = searchRecallsTool.format({
      meta: { total: 2500, skip: 0, limit: 1, lastUpdated: '2026-06-01' },
      results: [{ recall_number: 'R-0', classification: 'Class I' }],
      canvas_id: 'cv_recalls',
      canvas_table: 'spilled_x',
      spilled: true,
    });
    const text = blocks[0].text;
    expect(text).toContain('spilled_x');
    expect(text).toContain('openfda_dataframe_query');
  });
});

/**
 * @fileoverview Canvas staging path for openfda_search_recalls — the same wiring
 * every search tool shares. Drives the tool handler with canvas enabled (mock
 * service + mock canvas instance, real drain), confirms staging is opt-in, and
 * checks that the inline page and the formatted text agree with the
 * canvas-disabled path.
 * @module tests/mcp-server/tools/definitions/search-recalls-canvas.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
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
import { textOf } from '../../../helpers/content.js';

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
  const canvas = { acquire: vi.fn().mockResolvedValue(instance) };
  return { canvas, instance };
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

  it('fails with a typed canvas_disabled error when staging is requested (#30)', async () => {
    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    const input = searchRecallsTool.input.parse({ category: 'drug', stage: true });
    const err = (await Promise.resolve(searchRecallsTool.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'canvas_disabled' });
  });
});

describe('openfda_search_recalls — canvas enabled', () => {
  it('does not touch the canvas or drain pages unless staging is requested (#30)', async () => {
    const svc = makeSvc(609_468);
    await setSvcMock(svc);
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    const input = searchRecallsTool.input.parse({
      category: 'drug',
      search: 'classification:"Class I"',
      limit: 10,
    });
    const result = await searchRecallsTool.handler(input, ctx);

    expect(canvas.acquire).not.toHaveBeenCalled();
    expect(svc.query).toHaveBeenCalledOnce();
    expect(svc.query.mock.calls[0]![1]).toMatchObject({ limit: 10, skip: 0 });
    expect(result.results).toHaveLength(10);
    expect(result.spilled).toBeUndefined();
  });

  it('stages on stage=true and discloses how much of the match reached the canvas', async () => {
    await setSvcMock(makeSvc(2500));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);

    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    const input = searchRecallsTool.input.parse({
      category: 'drug',
      search: 'classification:"Class I"',
      stage: true,
    });
    const result = await searchRecallsTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('cv_recalls');
    expect(result.canvas_table).toMatch(/^spilled_/);
    expect(result.staged_rows).toBe(2500);
    expect(result.meta.total).toBe(2500);
    expect(result.truncated).toBeUndefined(); // everything matched reached the canvas

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(2500);
    expect(enrichment.effectiveQuery).toBe('classification:"Class I"');
    expect(enrichment.notice).toContain('openfda_dataframe_query');
    expect(enrichment.notice).toContain('2500 of 2500');
  });

  it('stages when a canvas_id is passed back, without stage=true', async () => {
    await setSvcMock(makeSvc(40));
    const { canvas } = makeCanvas('cv_prior00');
    await setCanvasMock(canvas);

    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    const input = searchRecallsTool.input.parse({ category: 'drug', canvas_id: 'cv_prior00' });
    const result = await searchRecallsTool.handler(input, ctx);

    expect(canvas.acquire).toHaveBeenCalledWith('cv_prior00', expect.anything());
    expect(result.spilled).toBe(true);
    expect(result.staged_rows).toBe(40);
  });

  it('agrees with the canvas-disabled path about records at a given skip (#32)', async () => {
    await setSvcMock(makeSvc(1175));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);
    const stagedCtx = createMockContext({ errors: searchRecallsTool.errors });
    const staged = await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug', limit: 2, skip: 300, stage: true }),
      stagedCtx,
    );

    await setCanvasMock(undefined);
    await setSvcMock(makeSvc(1175));
    const plainCtx = createMockContext({ errors: searchRecallsTool.errors });
    const plain = await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug', limit: 2, skip: 300 }),
      plainCtx,
    );

    expect(staged.results).toEqual(plain.results);
    expect(staged.results.map((r) => r.recall_number)).toEqual(['R-300', 'R-301']);
    expect(staged.meta.skip).toBe(300);
  });

  // #47 — the probe already carries the total, so a window at or past it is known
  // empty: no page request, and so no past-end total recovery behind it either.
  it.each([150, 400])(
    'spends no request on an inline window at skip=%i, at or past the probed total',
    async (skip) => {
      const svc = makeSvc(150);
      await setSvcMock(svc);
      const { canvas } = makeCanvas();
      await setCanvasMock(canvas);
      const ctx = createMockContext({ errors: searchRecallsTool.errors });

      const result = await searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category: 'drug', limit: 10, skip, stage: true }),
        ctx,
      );

      const skips = svc.query.mock.calls.map(([, params]) => params.skip);
      expect(skips).not.toContain(skip);
      expect(result.results).toEqual([]);
      expect(result.meta.total).toBe(150);
      expect(getEnrichment(ctx).notice).toContain('150 matched');
      const text = textOf(searchRecallsTool.format!(result));
      expect(text).toContain('150 matched');
      expect(text).not.toMatch(/either nothing matched/i);
    },
  );

  it('still resolves the endpoint and enforces the recall/device guard', async () => {
    await setSvcMock(makeSvc(5));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);
    const ctx = createMockContext({ errors: searchRecallsTool.errors });
    // recall endpoint on a non-device category must throw before any canvas work
    await expect(
      searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category: 'food', endpoint: 'recall', stage: true }),
        ctx,
      ),
    ).rejects.toThrow(/only available for devices/i);
  });
});

describe('openfda_search_recalls — format', () => {
  it('renders the staging line with the staged-vs-matched counts', () => {
    const blocks = searchRecallsTool.format!({
      meta: { total: 2500, skip: 0, limit: 1, lastUpdated: '2026-06-01' },
      results: [{ recall_number: 'R-0', classification: 'Class I' }],
      canvas_id: 'cv_recalls',
      canvas_table: 'spilled_x',
      spilled: true,
      staged_rows: 2500,
    });
    const text = textOf(blocks);
    expect(text).toContain('spilled_x');
    expect(text).toContain('Staged 2500 of 2500');
    expect(text).toContain('openfda_dataframe_query');
  });

  it('discloses truncation in the staging line', () => {
    const blocks = searchRecallsTool.format!({
      meta: { total: 609_468, skip: 0, limit: 1, lastUpdated: '2026-06-01' },
      results: [{ recall_number: 'R-0', classification: 'Class I' }],
      canvas_id: 'cv_recalls',
      canvas_table: 'spilled_x',
      spilled: true,
      staged_rows: 235,
      truncated: true,
    });
    const text = textOf(blocks);
    expect(text).toContain('Staged 235 of 609468');
    expect(text).toMatch(/size budget/i);
  });

  it('never renders "No results found." for a query that matched records (#31)', () => {
    const blocks = searchRecallsTool.format!({
      meta: { total: 609_468, skip: 700_000, limit: 0, lastUpdated: '2026-06-01' },
      results: [],
      canvas_id: 'cv_recalls',
      canvas_table: 'spilled_x',
      spilled: true,
      staged_rows: 235,
      truncated: true,
    });
    const text = textOf(blocks);
    expect(text).not.toContain('No results found.');
    expect(text).toContain('609468');
    expect(text).toContain('spilled_x');
    expect(text).toContain('The staged table holds the first 235 of them');
    /** 700000 overshot both the matched set and the 235-row table — never echo it into the SQL. */
    expect(text).not.toContain('OFFSET 700000');
  });

  it('keeps the no-match wording when nothing matched', () => {
    const blocks = searchRecallsTool.format!({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
      results: [],
    });
    expect(textOf(blocks)).toBe('No results found.');
  });

  it('qualifies the no-match wording when the total behind an offset is unverified', () => {
    const blocks = searchRecallsTool.format!({
      meta: { total: 0, skip: 2000, limit: 0, lastUpdated: '2026-06-01', totalUnverified: true },
      results: [],
    });
    expect(textOf(blocks)).toContain('at skip=2000');
    expect(textOf(blocks)).toContain('Retry with skip=0');
  });
});

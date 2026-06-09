/**
 * @fileoverview Tests for openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/dataframe-query.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';

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

async function setCanvasMock(impl: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(impl);
}

describe('openfda_dataframe_query', () => {
  beforeEach(async () => {
    const mockInstance = {
      canvasId: 'cv_abc123',
      query: vi.fn().mockResolvedValue({
        rows: [
          { classification: 'Class I', n: 42 },
          { classification: 'Class II', n: 17 },
        ],
        rowCount: 2,
      }),
    };
    await setCanvasMock({ acquire: vi.fn().mockResolvedValue(mockInstance) });
  });

  it('runs SQL against a staged canvas table', async () => {
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      canvas_id: 'cv_abc123',
      query: 'SELECT classification, COUNT(*) AS n FROM spilled_x GROUP BY classification',
    });
    const result = await dataframeQueryTool.handler(input, ctx);
    expect(result.canvas_id).toBe('cv_abc123');
    expect(result.row_count).toBe(2);
    expect(result.rows[0]).toMatchObject({ classification: 'Class I' });
  });

  it('throws when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ canvas_id: 'cv_abc123', query: 'SELECT 1' });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toThrow(
      'DataCanvas is not enabled',
    );
  });

  it('formats results as a markdown table', () => {
    const blocks = dataframeQueryTool.format!({
      rows: [{ classification: 'Class I', n: 42 }],
      row_count: 1,
      canvas_id: 'cv_abc123',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('cv_abc123');
    expect(text).toContain('classification');
    expect(text).toContain('Class I');
  });

  it('formats an empty result gracefully', () => {
    const blocks = dataframeQueryTool.format!({ rows: [], row_count: 0, canvas_id: 'cv_abc123' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('No rows returned');
  });
});

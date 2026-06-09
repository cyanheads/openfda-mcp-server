/**
 * @fileoverview Tests for openfda_dataframe_describe.
 * @module tests/mcp-server/tools/definitions/dataframe-describe.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';

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

describe('openfda_dataframe_describe', () => {
  beforeEach(async () => {
    const mockInstance = {
      canvasId: 'cv_abc123',
      describe: vi.fn().mockResolvedValue([
        {
          name: 'spilled_x',
          kind: 'table',
          rowCount: 2500,
          columns: [
            { name: 'recall_number', type: 'VARCHAR', nullable: true },
            { name: 'openfda', type: 'JSON', nullable: true },
          ],
        },
      ]),
    };
    await setCanvasMock({ acquire: vi.fn().mockResolvedValue(mockInstance) });
  });

  it('lists staged tables with column schemas', async () => {
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({ canvas_id: 'cv_abc123' });
    const result = await dataframeDescribeTool.handler(input, ctx);
    expect(result.canvas_id).toBe('cv_abc123');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ name: 'spilled_x', kind: 'table', row_count: 2500 });
    expect(result.tables[0]?.columns[1]).toMatchObject({ name: 'openfda', type: 'JSON' });
  });

  it('throws when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({ canvas_id: 'cv_abc123' });
    await expect(dataframeDescribeTool.handler(input, ctx)).rejects.toThrow(
      'DataCanvas is not enabled',
    );
  });

  it('formats table schemas as markdown', () => {
    const blocks = dataframeDescribeTool.format!({
      tables: [
        {
          name: 'spilled_x',
          kind: 'table',
          row_count: 2500,
          columns: [{ name: 'recall_number', type: 'VARCHAR', nullable: true }],
        },
      ],
      canvas_id: 'cv_abc123',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('spilled_x');
    expect(text).toContain('recall_number');
    expect(text).toContain('VARCHAR');
  });
});

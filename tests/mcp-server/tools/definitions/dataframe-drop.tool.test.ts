/**
 * @fileoverview Tests for openfda_dataframe_drop. Runs the tool against a real
 * DataCanvas (framework CanvasRegistry + DuckDB provider) and reads the canvas
 * back through openfda_dataframe_describe and openfda_dataframe_query, so a
 * drop is checked by what the other two tools no longer see.
 * @module tests/mcp-server/tools/definitions/dataframe-drop.tool.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { textOf } from '../../../helpers/content.js';

const TENANT = 'dataframe-drop';

type DropStructured = { canvas_id: string; table: string; remaining_tables: string[] };
type ErrorStructured = { error: { code: number; data?: Record<string, unknown> } };

let canvas: DataCanvas | undefined;
let canvasId: string;

beforeEach(async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: '/tmp/openfda-dataframe-drop-test',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
  setCanvas(canvas);

  const instance = await canvas.acquire(undefined, createMockContext({ tenantId: TENANT }));
  canvasId = instance.canvasId;
  await instance.registerTable('spilled_recalls', [
    { recall_number: 'D-0850-2026', classification: 'Class I' },
    { recall_number: 'D-0851-2026', classification: 'Class II' },
  ]);
  await instance.registerTable('spilled_events', [{ safetyreportid: '10003300' }]);
});

afterEach(async () => {
  if (canvas) await canvas.shutdown(createMockContext({ tenantId: TENANT }));
  canvas = undefined;
  setCanvas(undefined);
});

const contractContext = { context: { tenantId: TENANT } };

async function stagedTableNames(): Promise<string[]> {
  const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: TENANT });
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ canvas_id: canvasId }),
    ctx,
  );
  return result.tables.map((t) => t.name).sort();
}

describe('openfda_dataframe_drop', () => {
  it('drops one table, leaving the canvas and its other tables in place', async () => {
    const result = await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_recalls' },
      contractContext,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as DropStructured;
    expect(structured).toEqual({
      canvas_id: canvasId,
      table: 'spilled_recalls',
      remaining_tables: ['spilled_events'],
    });

    const text = textOf(result.content as never);
    expect(text).toContain('spilled_recalls');
    expect(text).toContain(canvasId);
    expect(text).toContain('Remaining tables (1): spilled_events');

    expect(await stagedTableNames()).toEqual(['spilled_events']);
  });

  it('makes the dropped table unreachable by openfda_dataframe_query', async () => {
    await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_recalls' },
      contractContext,
    );

    const result = await runToolContract(
      dataframeQueryTool,
      { canvas_id: canvasId, query: 'SELECT COUNT(*) AS n FROM spilled_recalls' },
      contractContext,
    );
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as ErrorStructured;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'missing_table' });

    const survivor = await runToolContract(
      dataframeQueryTool,
      { canvas_id: canvasId, query: 'SELECT COUNT(*) AS n FROM spilled_events' },
      contractContext,
    );
    expect(survivor.isError).toBeFalsy();
  });

  it('reports an empty canvas once the last table is dropped', async () => {
    await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_recalls' },
      contractContext,
    );
    const result = await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_events' },
      contractContext,
    );

    const structured = result.structuredContent as unknown as DropStructured;
    expect(structured.remaining_tables).toEqual([]);
    expect(textOf(result.content as never)).toContain('No tables remain on this canvas.');
    expect(await stagedTableNames()).toEqual([]);
  });

  it('fails as missing_table, with the declared recovery, for a table not on the canvas', async () => {
    const result = await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_nope' },
      contractContext,
    );

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as ErrorStructured;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'missing_table',
      tableName: 'spilled_nope',
      recovery: { hint: expect.stringContaining('openfda_dataframe_describe') },
    });
    expect(textOf(result.content as never)).toContain('spilled_nope');
    expect(await stagedTableNames()).toEqual(['spilled_events', 'spilled_recalls']);
  });

  it('fails as missing_table when the same table is dropped twice', async () => {
    const args = { canvas_id: canvasId, table: 'spilled_recalls' };
    expect((await runToolContract(dataframeDropTool, args, contractContext)).isError).toBeFalsy();
    const second = await runToolContract(dataframeDropTool, args, contractContext);
    expect(second.isError).toBe(true);
    expect((second.structuredContent as unknown as ErrorStructured).error.data).toMatchObject({
      reason: 'missing_table',
    });
  });

  it('fails as canvas_not_found for a well-formed canvas_id with no active canvas', async () => {
    const result = await runToolContract(
      dataframeDropTool,
      { canvas_id: 'cvnotreal0', table: 'spilled_recalls' },
      contractContext,
    );

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as ErrorStructured;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'canvas_not_found' });
    // A missing canvas means its tables are already gone: the drop tool's own
    // recovery says so, rather than the framework's re-stage hint.
    const hint = (error.data?.recovery as { hint?: string } | undefined)?.hint;
    expect(hint).toMatch(/no drop is needed/);
    expect(hint).not.toMatch(/Re-run the tool/);
    expect(textOf(result.content as never)).toMatch(/no drop is needed/);
    expect(await stagedTableNames()).toEqual(['spilled_events', 'spilled_recalls']);
  });

  it('fails as canvas_disabled, with the declared recovery, when DataCanvas is off', async () => {
    setCanvas(undefined);
    const result = await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_recalls' },
      contractContext,
    );
    setCanvas(canvas);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as ErrorStructured;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'canvas_disabled',
      recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb') },
    });
  });

  it.each([
    ['a table name that is not a SQL identifier', { table: 'spilled; DROP x' }],
    ['a blank table name', { table: '' }],
    ['a malformed canvas_id', { canvas_id: 'not a canvas id!' }],
  ])('rejects %s before touching the canvas', async (_label, override) => {
    const result = await runToolContract(
      dataframeDropTool,
      { canvas_id: canvasId, table: 'spilled_recalls', ...override },
      contractContext,
    );

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as ErrorStructured;
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(await stagedTableNames()).toEqual(['spilled_events', 'spilled_recalls']);
  });
});

describe('openfda_dataframe_drop deployment gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadGatedTool(flag: string | undefined) {
    vi.resetModules();
    vi.stubEnv('OPENFDA_DATAFRAME_DROP_ENABLED', flag ?? '');
    const mod = await import('@/mcp-server/tools/definitions/dataframe-drop.tool.js');
    const index = await import('@/mcp-server/tools/definitions/index.js');
    return { tool: mod.dataframeDropTool, all: index.allToolDefinitions };
  }

  it('registers the tool as disabled, with the enable hint, when the flag is unset', async () => {
    const { tool, all } = await loadGatedTool(undefined);
    expect((tool as unknown as { __mcpDisabled?: unknown }).__mcpDisabled).toEqual({
      reason: 'Dropping staged DataCanvas tables is turned off in this deployment.',
      hint: 'OPENFDA_DATAFRAME_DROP_ENABLED=true',
    });
    expect(all.map((d) => d.name)).toContain('openfda_dataframe_drop');
  });

  it('registers the tool as callable when OPENFDA_DATAFRAME_DROP_ENABLED=true', async () => {
    const { tool, all } = await loadGatedTool('true');
    expect((tool as unknown as { __mcpDisabled?: unknown }).__mcpDisabled).toBeUndefined();
    expect(all.map((d) => d.name)).toContain('openfda_dataframe_drop');
  });
});

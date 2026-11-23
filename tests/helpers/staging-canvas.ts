/**
 * @fileoverview Shared setup for the staging tests that run the real staging
 * path against a real DataCanvas (framework CanvasRegistry + DuckDB provider):
 * the canvas lifecycle, the suite timeout, and readers over the staged tables
 * through openfda_dataframe_describe and openfda_dataframe_query.
 * @module tests/helpers/staging-canvas
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';

/**
 * Suite options for the real-DuckDB tests. The first staging call starts DuckDB:
 * up to ~750 ms alone, past the 5 s default when the full suite saturates the machine.
 */
export const DUCKDB_SUITE = { timeout: 30_000 };

let canvas: DataCanvas | undefined;

/**
 * Installs a fresh real DataCanvas as the process canvas, exporting under
 * `/tmp/openfda-<tenantId>-test`. Call from `beforeEach`; pair with
 * {@link shutdownStagingCanvas}.
 */
export function installStagingCanvas(tenantId: string): void {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: `/tmp/openfda-${tenantId}-test`,
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
  setCanvas(canvas);
}

/** Shuts the canvas {@link installStagingCanvas} installed and clears the process canvas. */
export async function shutdownStagingCanvas(tenantId: string): Promise<void> {
  if (canvas) await canvas.shutdown(createMockContext({ tenantId }));
  canvas = undefined;
  setCanvas(undefined);
}

/** One staged table as openfda_dataframe_describe reports it, or undefined when absent. */
export async function describeStagedTable(tenantId: string, canvasId: string, table: string) {
  const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId });
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ canvas_id: canvasId }),
    ctx,
  );
  return result.tables.find((t) => t.name === table);
}

/** A staged table's `{ name, type }` column list in staged order. */
export async function stagedColumns(tenantId: string, canvasId: string, table: string) {
  return ((await describeStagedTable(tenantId, canvasId, table))?.columns ?? []).map(
    ({ name, type }) => ({ name, type }),
  );
}

/** Runs `sql` through openfda_dataframe_query and returns the full tool result. */
export async function queryStaged(tenantId: string, canvasId: string, sql: string) {
  const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId });
  return dataframeQueryTool.handler(
    dataframeQueryTool.input.parse({ canvas_id: canvasId, query: sql }),
    ctx,
  );
}

/** Runs `sql` through openfda_dataframe_query and returns its rows. */
export async function queryStagedRows(tenantId: string, canvasId: string, sql: string) {
  return (await queryStaged(tenantId, canvasId, sql)).rows;
}

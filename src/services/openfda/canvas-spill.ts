/**
 * @fileoverview DataCanvas spillover helper for openFDA search tools. Pages an
 * openFDA endpoint lazily (the API caps each request at 1000 rows) up to the
 * 25,000-row skip ceiling, feeding the rows into `spillover()`: a sized inline
 * preview plus, when the result overflows, a staged canvas table the agent
 * queries with openfda_dataframe_query. Shared by every multi-row search tool so
 * the drain + spill branch lives in one place.
 * @module services/openfda/canvas-spill
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { type ColumnSchema, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/** openFDA hard pagination ceiling — `skip` may not exceed this. */
export const OPENFDA_MAX_ROWS = 25_000;
/** openFDA per-request row cap. */
const PAGE_SIZE = 1_000;
/** Inline preview character budget (~10k tokens of JSON). */
export const PREVIEW_CHARS = 40_000;

/**
 * Output fields shared by every search tool for DataCanvas spillover. All
 * optional — absent when canvas (CANVAS_PROVIDER_TYPE=duckdb) is disabled, so
 * the default response shape is unchanged. Spread into each tool's output object.
 */
export const canvasOutputShape = {
  canvas_id: z
    .string()
    .optional()
    .describe(
      'DataCanvas session id for the staged result set. Present when canvas is enabled. Pass to openfda_dataframe_query / openfda_dataframe_describe, or back into this tool to accumulate more tables on the same canvas.',
    ),
  canvas_table: z
    .string()
    .optional()
    .describe(
      'Canvas table holding the full staged result. Present when spilled=true; reference it in SQL FROM clauses.',
    ),
  spilled: z
    .boolean()
    .optional()
    .describe(
      'True when the full result set was staged on the canvas — use canvas_id with openfda_dataframe_query for SQL. False when it fit inline. Absent when canvas is disabled.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when more rows matched upstream than the 25000-row staging ceiling. Narrow the query (filters, date range) for a complete set.',
    ),
};

/** Outcome of a canvas-backed search drain. */
export interface OpenFdaSpillResult {
  /** Canvas session id — surface so the agent can query or accumulate. */
  canvasId: string;
  /** Dataset `last_updated` date from upstream metadata. */
  lastUpdated: string;
  /** Inline preview rows — raw records, identical in shape to the non-canvas path. */
  preview: Record<string, unknown>[];
  /** True when the full result set was staged on the canvas. */
  spilled: boolean;
  /** Canvas table holding the staged rows; empty string when the result fit inline. */
  tableName: string;
  /** Total matching records upstream, before the drain ceiling. */
  total: number;
  /** True when more rows matched upstream than were staged (drain ceiling hit). */
  truncated: boolean;
}

/**
 * Drain an openFDA search endpoint into a DataCanvas via spillover. Peeks the
 * first page for the total and dataset metadata, then pages lazily up to the
 * 25,000-row ceiling. The explicit nullable `schema` keeps DuckDB ingestion
 * robust against openFDA's sparse, heterogeneous records — missing fields land
 * as NULL, fields outside the schema are ignored, and nested objects/arrays are
 * stored as JSON columns (queryable with DuckDB's json functions). Caller must
 * confirm `getCanvas()` is defined before invoking.
 */
export async function spillSearch(opts: {
  endpoint: string;
  search?: string | undefined;
  sort?: string | undefined;
  canvasId?: string | undefined;
  schema: ColumnSchema[];
  ctx: Context;
  previewChars?: number | undefined;
}): Promise<OpenFdaSpillResult> {
  const { endpoint, search, sort, canvasId, schema, ctx } = opts;
  const canvas = getCanvas();
  if (!canvas) {
    throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  }
  const svc = getOpenFdaService();

  // Peek the first page: total drives the truncation signal and the drain bound;
  // lastUpdated carries dataset provenance into the tool's meta block.
  const first = await svc.query<Record<string, unknown>>(
    endpoint,
    { search, sort, limit: PAGE_SIZE, skip: 0 },
    ctx,
  );
  const total = first.meta.total;
  const lastUpdated = first.meta.lastUpdated;

  async function* drain(): AsyncGenerator<Record<string, unknown>> {
    yield* first.results;
    let skip = first.results.length;
    // Page forward, never requesting a skip past the 25,000 ceiling.
    while (skip < OPENFDA_MAX_ROWS && skip < total) {
      const limit = Math.min(PAGE_SIZE, OPENFDA_MAX_ROWS - skip);
      const page = await svc.query<Record<string, unknown>>(
        endpoint,
        { search, sort, limit, skip },
        ctx,
      );
      if (page.results.length === 0) break;
      yield* page.results;
      if (page.results.length < limit) break;
      skip += page.results.length;
    }
  }

  const instance = await canvas.acquire(canvasId, ctx);
  const result = await spillover({
    canvas: instance,
    source: drain(),
    schema,
    previewChars: opts.previewChars ?? PREVIEW_CHARS,
    caps: { maxRows: OPENFDA_MAX_ROWS },
    signal: ctx.signal,
  });

  const stagedCount = result.spilled ? result.handle.rowCount : result.previewRows.length;
  return {
    preview: result.previewRows,
    total,
    lastUpdated,
    canvasId: instance.canvasId,
    tableName: result.spilled ? result.handle.tableName : '',
    spilled: result.spilled,
    truncated: total > stagedCount,
  };
}

/**
 * Map a spill result to the canvas-mode tool response — the `{ meta, results }`
 * shape every search tool returns plus the canvas pointer fields. Shared so the
 * output contract lives in one place.
 */
export function canvasResult(spill: OpenFdaSpillResult) {
  return {
    meta: {
      total: spill.total,
      skip: 0,
      limit: spill.preview.length,
      lastUpdated: spill.lastUpdated,
    },
    results: spill.preview,
    canvas_id: spill.canvasId,
    spilled: spill.spilled,
    ...(spill.tableName ? { canvas_table: spill.tableName } : {}),
    ...(spill.truncated ? { truncated: true } : {}),
  };
}

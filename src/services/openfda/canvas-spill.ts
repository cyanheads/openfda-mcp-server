/**
 * @fileoverview DataCanvas staging helper for openFDA search tools. Staging is
 * opt-in: a search only reaches this module when the caller asked for it
 * (`stage: true`, or a `canvas_id` to accumulate onto). It returns the same
 * inline page the plain search path returns — `limit`/`skip` address the matched
 * set identically in both modes, and the page carries the same inline byte budget
 * (`page-budget.ts`), so a staged call and an unstaged one never disagree about
 * what a window holds — and, alongside it, registers a bounded drain of
 * the matched set as a canvas table the agent queries with
 * openfda_dataframe_query. The drain is capped by a serialized-byte budget as
 * well as openFDA's 25,000-row `skip` ceiling, so a staged call on a
 * large-record endpoint cannot run for minutes; `stagedRows` vs `total`
 * discloses how much of the match actually reached the canvas.
 * @module services/openfda/canvas-spill
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  boundPageToBudget,
  type PageBudgetFields,
  pageBudgetFields,
} from '@/services/openfda/page-budget.js';

/** openFDA hard pagination ceiling — `skip` may not exceed this. */
export const OPENFDA_MAX_ROWS = 25_000;
/** openFDA per-request row cap. */
const MAX_PAGE_SIZE = 1_000;
/** Rows read up front to get the total and measure serialized record size. */
const PROBE_ROWS = 100;
/**
 * Serialized-JSON budget for one staged drain. Record size varies by three
 * orders of magnitude across openFDA endpoints (a shortage row is ~1 KB, a
 * `drug/event` report ~65 KB), so a flat row cap either starves the small
 * endpoints or stalls the large ones — the drain measures the probe page and
 * derives its own row cap from this budget.
 */
export const STAGE_MAX_BYTES = 16_000_000;
/** Serialized-JSON budget for a single upstream page, bounding per-request latency. */
const PAGE_MAX_BYTES = 4_000_000;

/**
 * `stage` input field shared by every search tool that can stage to DataCanvas.
 * Spread into each tool's input object alongside `canvas_id`.
 */
export const stageInput = z
  .boolean()
  .default(false)
  .describe(
    'Stage the matched set on a DataCanvas for SQL analysis with openfda_dataframe_query. Default false — the call returns one page for one upstream request. When true, records are also drained onto a canvas table up to a size budget (staged_rows reports how many reached it). Staging is for record-level SQL over a bounded slice; for a distribution over everything that matched, openfda_count_values aggregates server-side in one request. Requires CANVAS_PROVIDER_TYPE=duckdb.',
  );

/**
 * Recovery clause appended wherever staging discloses a cut. A truncated table
 * still supports record-level SQL, but a GROUP BY over it reads as a population
 * statistic and is not one — openFDA answers that question over the whole match.
 */
export const AGGREGATE_ROUTE =
  ' A GROUP BY over the staged rows describes only those rows — for a distribution over the whole matched set, use openfda_count_values with the same search and a count field.';

/**
 * `canvas_disabled` contract entry shared by every search tool that can stage.
 * Spread into each tool's `errors` array so the reason, code, and recovery stay
 * identical across the surface.
 */
export const canvasDisabledError = {
  reason: 'canvas_disabled',
  code: JsonRpcErrorCode.ValidationError,
  when: 'Staging was requested (stage=true or a canvas_id) but DataCanvas is disabled.',
  recovery:
    'Set CANVAS_PROVIDER_TYPE=duckdb to enable staging, or drop stage/canvas_id to get the inline page.',
} as const;

/**
 * Output fields shared by every search tool that can stage to DataCanvas. All
 * optional — absent unless the call staged (canvas enabled plus an explicit
 * staging signal), so the default response shape is unchanged. Spread into each
 * tool's output object.
 */
export const canvasOutputShape = {
  canvas_id: z
    .string()
    .optional()
    .describe(
      'DataCanvas session id for the staged result set. Present when this call staged. Pass to openfda_dataframe_query / openfda_dataframe_describe, or back into this tool to accumulate more tables on the same canvas.',
    ),
  canvas_table: z
    .string()
    .optional()
    .describe(
      'Canvas table holding the staged rows. Present when rows were staged; reference it in SQL FROM clauses.',
    ),
  spilled: z
    .boolean()
    .optional()
    .describe(
      'True when this call staged its matched set on the canvas — use canvas_id with openfda_dataframe_query for SQL. Absent when staging was not requested.',
    ),
  staged_rows: z
    .number()
    .optional()
    .describe(
      'Rows written to the canvas table. Compare with meta.total: a smaller value means staging stopped at its size budget and the table holds only the first staged_rows records.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      "True when fewer rows reached the canvas than matched upstream — staging stopped at its size budget or openFDA's 25000-row pagination ceiling. Narrow the query (filters, date range) for a complete set.",
    ),
};

/** Outcome of a canvas-backed search. */
export interface OpenFdaSpillResult {
  /** Canvas session id — surface so the agent can query or accumulate. */
  canvasId: string;
  /** Dataset `last_updated` date from upstream metadata. */
  lastUpdated: string;
  /**
   * Inline page — the caller's `limit`/`skip` window over the matched set,
   * bounded by the same inline byte budget the non-staged path applies.
   */
  preview: Record<string, unknown>[];
  /** Byte-budget disclosure for `preview` — empty when the whole window fit. */
  previewBudget: PageBudgetFields;
  /** Pagination offset applied to the inline page. */
  skip: number;
  /** True when rows were registered on the canvas. */
  spilled: boolean;
  /** Rows written to the canvas table. */
  stagedRows: number;
  /** Canvas table holding the staged rows; empty string when nothing was staged. */
  tableName: string;
  /** Total matching records upstream. */
  total: number;
  /** True when fewer rows were staged than matched upstream. */
  truncated: boolean;
}

/** Canvas table handle — `spilled_<8 hex>`, matching the framework's spillover naming. */
function newTableName(): string {
  return `spilled_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

/**
 * Fetch the caller's inline page and stage a bounded drain of the matched set on
 * a DataCanvas. The explicit nullable `schema` keeps DuckDB ingestion robust
 * against openFDA's sparse, heterogeneous records — missing fields land as NULL,
 * fields outside the schema are ignored, and nested objects/arrays are stored as
 * JSON columns (queryable with DuckDB's json functions). Caller must confirm
 * `getCanvas()` is defined before invoking.
 *
 * The inline page is the same `limit`/`skip` window the plain search path
 * returns, under the same inline byte budget; the drain always starts at offset 0
 * and runs until its own (much larger) byte budget, the row ceiling, or the
 * matched set is exhausted.
 */
export async function spillSearch(opts: {
  endpoint: string;
  search?: string | undefined;
  sort?: string | undefined;
  canvasId?: string | undefined;
  schema: ColumnSchema[];
  ctx: Context;
  /** Inline page size — the caller's `limit`. */
  limit: number;
  /** Inline page offset into the matched set — the caller's `skip`. */
  skip: number;
}): Promise<OpenFdaSpillResult> {
  const { endpoint, search, sort, canvasId, schema, ctx, limit, skip } = opts;
  const canvas = getCanvas();
  if (!canvas) {
    throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  }
  const svc = getOpenFdaService();

  // Acquire before any upstream work so an unknown canvas_id fails fast.
  const instance = await canvas.acquire(canvasId, ctx);

  // Probe: the total drives the drain bound, the serialized size drives the page
  // cadence, and the rows themselves cover the common inline window for free.
  const probe = await svc.query<Record<string, unknown>>(
    endpoint,
    { search, sort, limit: PROBE_ROWS, skip: 0 },
    ctx,
  );
  const total = probe.meta.total;
  const lastUpdated = probe.meta.lastUpdated;

  const probeCoversWindow =
    skip + limit <= probe.results.length || probe.results.length < PROBE_ROWS;
  const requested = probeCoversWindow
    ? probe.results.slice(skip, skip + limit)
    : (await svc.query<Record<string, unknown>>(endpoint, { search, sort, limit, skip }, ctx))
        .results;

  /*
   * The staged page carries the same inline byte budget the plain path applies —
   * a staged call and an unstaged one must agree about what a `limit`/`skip`
   * window holds, and staging is not a reason to hand back an unholdable page.
   */
  const page = boundPageToBudget(requested);
  const preview = page.records;
  const previewBudget = pageBudgetFields(page);

  if (probe.results.length === 0) {
    return {
      canvasId: instance.canvasId,
      lastUpdated,
      preview,
      previewBudget,
      skip,
      spilled: false,
      stagedRows: 0,
      tableName: '',
      total,
      truncated: false,
    };
  }

  const avgBytes = Math.max(1, JSON.stringify(probe.results).length / probe.results.length);
  const rowBudget = Math.min(
    OPENFDA_MAX_ROWS,
    Math.max(probe.results.length, Math.floor(STAGE_MAX_BYTES / avgBytes)),
  );
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(PAGE_MAX_BYTES / avgBytes)));

  async function* drain(): AsyncGenerator<Record<string, unknown>> {
    yield* probe.results;
    let fetched = probe.results.length;
    while (fetched < rowBudget && fetched < total) {
      const pageLimit = Math.min(pageSize, rowBudget - fetched);
      const page = await svc.query<Record<string, unknown>>(
        endpoint,
        { search, sort, limit: pageLimit, skip: fetched },
        ctx,
      );
      if (page.results.length === 0) break;
      yield* page.results;
      fetched += page.results.length;
      if (page.results.length < pageLimit) break;
    }
  }

  const handle = await instance.registerTable(newTableName(), drain(), {
    schema,
    signal: ctx.signal,
  });

  ctx.log.info('Staged openFDA search on canvas', {
    endpoint,
    canvasId: instance.canvasId,
    tableName: handle.tableName,
    stagedRows: handle.rowCount,
    total,
  });

  return {
    canvasId: instance.canvasId,
    lastUpdated,
    preview,
    previewBudget,
    skip,
    spilled: true,
    stagedRows: handle.rowCount,
    tableName: handle.tableName,
    total,
    truncated: total > handle.rowCount,
  };
}

/**
 * Enrichment notice for a staged search — the canvas pointer plus how much of
 * the matched set actually reached the table.
 */
export function stagingNotice(spill: OpenFdaSpillResult): string {
  if (!spill.spilled) {
    return `Nothing was staged on canvas "${spill.canvasId}" — ${spill.total} records matched.`;
  }
  const cut = spill.truncated
    ? ` Staging stopped at its size budget, so the table holds the first ${spill.stagedRows} records — narrow the query (filters, date range) for a complete set.${AGGREGATE_ROUTE}`
    : '';
  return `Staged ${spill.stagedRows} of ${spill.total} matched records on canvas table "${spill.tableName}". Query it with openfda_dataframe_query using canvas_id "${spill.canvasId}".${cut}`;
}

/**
 * Map a spill result to the staged tool response — the `{ meta, results }` shape
 * every search tool returns plus the canvas pointer fields. Shared so the output
 * contract lives in one place.
 */
export function canvasResult(spill: OpenFdaSpillResult) {
  return {
    meta: {
      total: spill.total,
      skip: spill.skip,
      limit: spill.preview.length,
      lastUpdated: spill.lastUpdated,
    },
    results: spill.preview,
    ...spill.previewBudget,
    canvas_id: spill.canvasId,
    spilled: spill.spilled,
    staged_rows: spill.stagedRows,
    ...(spill.tableName ? { canvas_table: spill.tableName } : {}),
    ...(spill.truncated ? { truncated: true } : {}),
  };
}

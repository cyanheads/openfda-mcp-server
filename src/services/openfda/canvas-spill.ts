/**
 * @fileoverview DataCanvas staging helper for openFDA search tools. Staging is
 * opt-in: a search only reaches this module when the caller asked for it
 * (`stage: true`, or a `canvas_id` to accumulate onto). It returns the same
 * inline page the plain search path returns — `limit`/`skip` address the matched
 * set identically in both modes, and the page is cut the same way (`fields`, or
 * the endpoint's left-out paths, in `record-projection.ts`) and carries the same
 * oversized-record disclosure (`page-budget.ts`), so a staged call and an
 * unstaged one never disagree about what a window holds — and, alongside it,
 * registers a bounded drain of the matched set as a canvas table the agent
 * inspects with openfda_dataframe_describe and queries with
 * openfda_dataframe_query. The drain stages whole records, left-out paths
 * included, and is capped by a serialized-byte budget as well as openFDA's
 * 25,000-row `skip` ceiling, so a staged call on a large-record endpoint cannot
 * run for minutes; `stagedRows` vs `total` discloses how much of the match
 * actually reached the canvas.
 * @module services/openfda/canvas-spill
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  type OversizedRecordFields,
  oversizedRecordFields,
} from '@/services/openfda/page-budget.js';
import {
  cutRecords,
  type OmissionFields,
  type ProjectionFields,
  type RecordProjection,
} from '@/services/openfda/record-projection.js';

/** openFDA hard pagination ceiling — `skip` may not exceed this. */
export const OPENFDA_MAX_ROWS = 25_000;
/** openFDA per-request row cap. */
const MAX_PAGE_SIZE = 1_000;
/** Rows read up front to get the total and measure serialized record size. */
const PROBE_ROWS = 100;
/**
 * Serialized-JSON budget for one staged drain. Record size varies by three
 * orders of magnitude across openFDA endpoints (a shortage row is ~1 KB, a
 * `drug/event` report ~30 KB on average and 11–62 KB by search, 2026-11-10), so
 * a flat row cap either starves the small endpoints or stalls the large ones —
 * the drain measures the probe page and derives its own row cap from this budget.
 */
const STAGE_MAX_BYTES = 16_000_000;
/** Serialized-JSON budget for a single upstream page, bounding per-request latency. */
const PAGE_MAX_BYTES = 4_000_000;

/**
 * What stopped a truncated drain: the row ceiling once the table holds that
 * many rows, otherwise the byte budget's derived row cap.
 */
export function stagingStopCause(stagedRows: number): string {
  return stagedRows >= OPENFDA_MAX_ROWS
    ? `openFDA's ${OPENFDA_MAX_ROWS}-row pagination ceiling`
    : 'its size budget';
}

/**
 * `stage` input field shared by every search tool that can stage to DataCanvas,
 * set alongside {@link canvasIdInput}. It names describe before query and
 * `openfda_count_values` for a distribution over the whole match; the
 * default rides the schema, and a deployment without DataCanvas answers
 * {@link canvasDisabledError}.
 */
export const stageInput = z
  .boolean()
  .default(false)
  .describe(
    'Also stage the matched set on a DataCanvas for SQL: openfda_dataframe_describe lists its columns, then openfda_dataframe_query runs the SQL. Staging is bounded (staged_rows says how many rows landed); for a distribution over the whole match, use openfda_count_values.',
  );

/**
 * `canvas_id` input shared by every search tool that can stage: the canvas an
 * earlier staged call returned, which this call stages onto as `stage: true`
 * would. A malformed id fails `CanvasIdSchema` at argument validation; an
 * unknown one answers {@link canvasNotFoundError}.
 */
export const canvasIdInput = CanvasIdSchema.optional().describe(
  'canvas_id from an earlier staged call to openfda_search_* or openfda_lookup_ndc: stages this call onto that canvas too (as stage=true does), so its tables can be joined.',
);

/**
 * Recovery clause appended wherever staging discloses a cut. A truncated table
 * still supports record-level SQL, but a GROUP BY over it reads as a population
 * statistic and is not one — openFDA answers that question over the whole match.
 */
export const AGGREGATE_ROUTE =
  ' A GROUP BY over the staged rows describes only those rows — for a distribution over the whole matched set, use openfda_count_values with the same search and a count field.';

/**
 * Clause appended to every staging tool's `description`. Names describe before
 * query: the inline page renders nested blocks that are not canvas columns, so
 * SQL written from it without the column list fails.
 */
export const STAGING_WORKFLOW =
  ' With stage=true, call openfda_dataframe_describe for the staged columns, then openfda_dataframe_query for SQL.';

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

/** Message each handler passes to `ctx.fail('canvas_disabled', …)`, so it reads the same on every staging tool. */
export const CANVAS_DISABLED_MESSAGE =
  'Staging requires DataCanvas. Set CANVAS_PROVIDER_TYPE=duckdb, or drop stage/canvas_id for the inline page.';

/** Nullable VARCHAR staged columns, one per name, in the order given. */
export function varcharColumns(names: readonly string[]): ColumnSchema[] {
  return names.map((name): ColumnSchema => ({ name, type: 'VARCHAR', nullable: true }));
}

/**
 * `canvas_not_found` contract entry shared by every search tool that can stage.
 * Raised by the framework's `canvas.acquire()` inside `spillSearch`, below the
 * handler, hence `thrownBy: 'service'`. A malformed id never gets this far —
 * `CanvasIdSchema` rejects it at argument validation.
 */
export const canvasNotFoundError = {
  reason: 'canvas_not_found',
  code: JsonRpcErrorCode.NotFound,
  when: 'The canvas_id is well-formed but names no active canvas — expired or never minted.',
  recovery:
    'Omit canvas_id to stage onto a fresh canvas, or pass a canvas_id copied from a recent response.',
  thrownBy: 'service',
} as const;

/**
 * `canvas_capacity_exhausted` contract entry shared by every search tool that
 * can stage. Raised by `canvas.acquire()` when a call omits `canvas_id` and the
 * tenant already holds its cap of active canvases.
 */
export const canvasCapacityExhaustedError = {
  reason: 'canvas_capacity_exhausted',
  code: JsonRpcErrorCode.RateLimited,
  when: 'canvas_id was omitted and the active canvas cap is already reached.',
  retryable: true,
  recovery:
    'Pass a canvas_id you already hold to stage onto it, or retry once idle canvases expire.',
  thrownBy: 'service',
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
      'Canvas id of the staged set: pass to openfda_dataframe_describe, openfda_dataframe_query, or a later staged search.',
    ),
  canvas_table: z
    .string()
    .optional()
    .describe(
      'Staged table name: openfda_dataframe_describe lists its columns, then use it in openfda_dataframe_query.',
    ),
  spilled: z
    .boolean()
    .optional()
    .describe('True when this call staged its matched set; see canvas_id.'),
  staged_rows: z
    .number()
    .optional()
    .describe(
      'Rows written to the canvas table; below meta.total, the table holds only the first staged_rows records.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      `True when staging stopped short of meta.total (size budget or the ${OPENFDA_MAX_ROWS}-row ceiling); narrow the search for the whole set.`,
    ),
};

/** Outcome of a canvas-backed search. */
export interface OpenFdaSpillResult {
  /** Canvas session id — surface so the agent can query or accumulate. */
  canvasId: string;
  /** Dataset `last_updated` date from upstream metadata. */
  lastUpdated: string;
  /** Page size applied to the inline page, as the plain search path reports it. */
  limit: number;
  /** Inline page — the `limit`/`skip` window over the matched set, cut as on the plain path. */
  preview: Record<string, unknown>[];
  /** Oversized-record disclosure for `preview` — empty unless a record on it is oversized. */
  previewOversized: OversizedRecordFields;
  /**
   * Cut disclosure for `preview` — `projected_fields` or `omitted_fields`, empty
   * or absent when the call cut nothing.
   */
  previewProjection?: (OmissionFields & ProjectionFields) | undefined;
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
 * returns, under the same cut and oversized-record disclosure; the drain always
 * starts at offset 0, stages whole records into the table's column projection —
 * left-out paths included — and runs until its byte budget, the row ceiling, or
 * the matched set is exhausted.
 */
export async function spillSearch(opts: {
  endpoint: string;
  search?: string | undefined;
  sort?: string | undefined;
  canvasId?: string | undefined;
  schema: ColumnSchema[];
  ctx: Context;
  /** Inline page size — the page size the call resolved (`resolvePageSize`). */
  limit: number;
  /** Inline page offset into the matched set — the caller's `skip`. */
  skip: number;
  /**
   * The call's cut — its `fields`, or the endpoint's left-out paths — applied to
   * the inline page only, never the staged table.
   */
  projection?: RecordProjection | undefined;
}): Promise<OpenFdaSpillResult> {
  const { endpoint, search, sort, canvasId, schema, ctx, limit, skip, projection } = opts;
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

  // A window at or past the probed total is known empty — fetching it would only
  // draw openFDA's past-end 404 and the service's total recovery behind it.
  const probeCoversWindow =
    skip + limit <= probe.results.length || probe.results.length < PROBE_ROWS || skip >= total;
  const requested = probeCoversWindow
    ? probe.results.slice(skip, skip + limit)
    : (await svc.query<Record<string, unknown>>(endpoint, { search, sort, limit, skip }, ctx))
        .results;

  /*
   * The staged page carries the same cut and oversized-record disclosure the
   * plain path applies — a staged call and an unstaged one must agree about what
   * a `limit`/`skip` window holds. `cutRecords` copies what it changes, so the
   * drain below still reads the probe rows whole.
   */
  const { results: preview, ...previewProjection } = cutRecords(requested, projection);
  const previewOversized = oversizedRecordFields(preview);

  if (probe.results.length === 0) {
    return {
      canvasId: instance.canvasId,
      lastUpdated,
      limit,
      preview,
      previewOversized,
      previewProjection,
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
    limit,
    preview,
    previewOversized,
    previewProjection,
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
    ? ` Staging stopped at ${stagingStopCause(spill.stagedRows)}, so the table holds the first ${spill.stagedRows} records — narrow the query (filters, date range) for a complete set.${AGGREGATE_ROUTE}`
    : '';
  return `Staged ${spill.stagedRows} of ${spill.total} matched records on canvas table "${spill.tableName}" (canvas_id "${spill.canvasId}"). Call openfda_dataframe_describe for the column names, then openfda_dataframe_query to run SQL over the staged set.${cut}`;
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
      limit: spill.limit,
      lastUpdated: spill.lastUpdated,
    },
    results: spill.preview,
    ...spill.previewOversized,
    ...spill.previewProjection,
    canvas_id: spill.canvasId,
    spilled: spill.spilled,
    staged_rows: spill.stagedRows,
    ...(spill.tableName ? { canvas_table: spill.tableName } : {}),
    ...(spill.truncated ? { truncated: true } : {}),
  };
}

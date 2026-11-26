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
 * included, and is bounded by a serialized-byte budget, openFDA's 25,000-row
 * `skip` ceiling, and a time budget, so a staged call on a large-record
 * endpoint cannot run for minutes. A match whose small records let the byte
 * budget reach past that ceiling is walked by `search_after` instead of `skip`.
 * `stagedRows` vs `total` discloses how much of the match reached the canvas,
 * and `truncatedBy` names what stopped the drain short of it.
 * @module services/openfda/canvas-spill
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
import type { OpenFdaResponse } from '@/services/openfda/types.js';

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
 * Wall-clock budget for a staged call's drain, counted from the call's start:
 * every drain page, retries and backoff included, settles by one instant this
 * far out, below the 60 s request timeout MCP SDK clients default to. The probe
 * and the inline page keep the service's own per-call deadline, as on an
 * unstaged search, so this budget only ends a drain early, with the rows already
 * staged, and never fails a call that stages. Equal to the service's per-call
 * default (`OPENFDA_CALL_DEADLINE_MS`), but a budget of its own, as
 * openfda_drug_profile's is.
 */
const STAGE_DEADLINE_MS = 50_000;

/**
 * What can stop a staged drain short of the matched set — `truncated_by` on a
 * staged response. `upstream_end` is openFDA serving an empty or short page
 * before the `meta.total` it counted, which none of the drain's own bounds
 * explains.
 */
const STAGING_STOP_CAUSES = ['size_budget', 'row_ceiling', 'time_budget', 'upstream_end'] as const;
export type StagingStopCause = (typeof STAGING_STOP_CAUSES)[number];

const STOP_CAUSE_TEXT = {
  size_budget: 'its size budget',
  row_ceiling: `openFDA's ${OPENFDA_MAX_ROWS}-row pagination ceiling`,
  time_budget: 'its time budget',
  upstream_end: 'the last record openFDA served',
} as const satisfies Record<StagingStopCause, string>;

/** A stop cause as the staging notice and the `content[]` staging line name it, after "stopped at". */
export function stagingStopCause(cause: StagingStopCause): string {
  return STOP_CAUSE_TEXT[cause];
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
      'True when staging stopped short of meta.total; narrow the search for the whole set.',
    ),
  truncated_by: z
    .enum(STAGING_STOP_CAUSES)
    .optional()
    .describe(
      'Why staging stopped short of meta.total (upstream_end: openFDA served no more records). Only when truncated is.',
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
  /** What stopped the drain short of `total`; absent when every matched record was staged. */
  truncatedBy?: StagingStopCause | undefined;
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
 * left-out paths included — and runs until its byte budget, the row ceiling, its
 * time budget, or the end of the matched set.
 *
 * The walk is chosen at the probe, since openFDA links a page read at `skip > 0`
 * only by `skip`: when the byte budget and the match both reach past the row
 * ceiling, the drain follows the probe's `search_after` link; otherwise it pages
 * by `skip`, as it always has. A walk openFDA cannot continue — a link carrying a
 * sort key's missing-value marker (`searchAfterBlocked`), a continuation that
 * fails through the service's retries or answers the page it was linked from, or
 * a page with no link — goes on by `skip` from where it stands, up to the row
 * ceiling. A `skip` page that fails still fails the call, as it always has.
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
  const deadlineAtMs = Date.now() + STAGE_DEADLINE_MS;

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
    };
  }

  const avgBytes = Math.max(1, JSON.stringify(probe.results).length / probe.results.length);
  const sizeRows = Math.max(probe.results.length, Math.floor(STAGE_MAX_BYTES / avgBytes));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(PAGE_MAX_BYTES / avgBytes)));
  // The `search_after` value of the next page while the drain walks by it; undefined pages by `skip`.
  let after =
    sizeRows > OPENFDA_MAX_ROWS && total > OPENFDA_MAX_ROWS ? probe.nextSearchAfter : undefined;
  let rowCap = after === undefined ? Math.min(sizeRows, OPENFDA_MAX_ROWS) : sizeRows;
  let stoppedBy: StagingStopCause | undefined;

  async function* drain(): AsyncGenerator<Record<string, unknown>> {
    yield* probe.results;
    let fetched = probe.results.length;
    const pageBySkip = (why: string) => {
      ctx.log.debug('Staging walk goes on by skip', { endpoint, position: fetched, why });
      after = undefined;
      rowCap = Math.min(rowCap, OPENFDA_MAX_ROWS);
    };

    while (fetched < total) {
      if (fetched >= rowCap) {
        stoppedBy = rowCap < sizeRows ? 'row_ceiling' : 'size_budget';
        return;
      }
      const pageLimit = Math.min(pageSize, rowCap - fetched);
      const value = after;
      let page: OpenFdaResponse<Record<string, unknown>>;
      try {
        page = await svc.query<Record<string, unknown>>(
          endpoint,
          value === undefined
            ? { search, sort, limit: pageLimit, skip: fetched }
            : { search, sort, limit: pageLimit, searchAfter: { position: fetched, value } },
          ctx,
          { deadlineAtMs },
        );
      } catch (error) {
        // The service raises every upstream failure typed; anything else is a bug and crashes.
        if (ctx.signal?.aborted || !(error instanceof McpError)) throw error;
        const reason = error.data?.reason;
        if (reason === 'retry_deadline_exceeded') {
          stoppedBy = 'time_budget';
          return;
        }
        /*
         * A continuation that failed through the service's retries — a marker
         * shape the service does not recognize (`query_error`), a 5xx, a rate
         * limit, a body that is not openFDA JSON — goes on by `skip`: under the
         * ceiling with the very page a skip walk sends, which fails the call only
         * where that page fails too; past it, ending the drain with every row
         * walked, more than a skip walk reaches.
         */
        if (value !== undefined) {
          pageBySkip(`continuation failed (${String(reason)})`);
          continue;
        }
        throw error;
      }
      // openFDA answered the continuation with the page it was linked from: nothing new to stage.
      if (page.searchAfterBlocked === 'repeated_link') {
        pageBySkip('continuation repeated its page');
        continue;
      }
      if (page.results.length === 0) break;
      yield* page.results;
      fetched += page.results.length;
      if (page.results.length < pageLimit) break;
      if (value !== undefined) {
        after = page.nextSearchAfter;
        if (after === undefined) {
          pageBySkip(page.searchAfterBlocked ? 'missing sort value' : 'no next link');
        }
      }
    }
  }

  const handle = await instance.registerTable(newTableName(), drain(), {
    schema,
    signal: ctx.signal,
  });
  // A drain that ended on an empty or short page before `total` was served fewer records than openFDA counted.
  const truncatedBy = total > handle.rowCount ? (stoppedBy ?? 'upstream_end') : undefined;

  ctx.log.info('Staged openFDA search on canvas', {
    endpoint,
    canvasId: instance.canvasId,
    tableName: handle.tableName,
    stagedRows: handle.rowCount,
    total,
    truncatedBy,
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
    truncatedBy,
  };
}

/**
 * Enrichment notice for a staged search — the canvas pointer, how much of the
 * matched set reached the table, and on a cut, what stopped the drain.
 */
export function stagingNotice(spill: OpenFdaSpillResult): string {
  if (!spill.spilled) {
    return `Nothing was staged on canvas "${spill.canvasId}" — ${spill.total} records matched.`;
  }
  const cut = spill.truncatedBy
    ? ` Staging stopped at ${stagingStopCause(spill.truncatedBy)}, so the table holds the first ${spill.stagedRows} records — narrow the query (filters, date range) for a complete set.${AGGREGATE_ROUTE}`
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
    ...(spill.truncatedBy ? { truncated: true, truncated_by: spill.truncatedBy } : {}),
  };
}

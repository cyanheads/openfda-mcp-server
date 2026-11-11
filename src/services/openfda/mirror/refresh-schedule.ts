/**
 * @fileoverview Out-of-band refresh wiring for the bulk mirror.
 *
 * A sync re-downloads and re-parses whole dump partitions, so it never runs
 * inline with a tool call or with server startup. Refresh is a cron job; the
 * initial harvest is a CLI run (`bun run mirror:init`). A dataset that has never
 * completed an init is skipped by the cron rather than initialised by it — that
 * would put a multi-hour first harvest on a scheduled tick.
 *
 * @module services/openfda/mirror/refresh-schedule
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  logger,
  type RequestContext,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { MIRRORED_ENDPOINTS, type MirroredEndpoint } from './datasets.js';
import { getMirror } from './mirror-registry.js';

const JOB_ID = 'openfda-mirror-refresh';

/** Per-dataset outcome of one refresh pass. */
export interface RefreshOutcome {
  endpoint: MirroredEndpoint;
  error?: string;
  recordsApplied?: number;
  skipped?: 'never-initialised' | 'sync-locked';
  total?: number;
}

/** Handle on the scheduled refresh, held by the server's teardown. */
export interface MirrorRefreshJob {
  /**
   * Abort a refresh pass in flight and resolve once it has settled, so the
   * stores can be closed under it. A tick that fires afterwards does nothing.
   */
  stop(): Promise<void>;
}

/**
 * Refresh every initialised dataset in turn. Datasets are independent, so a
 * failure is recorded and the pass continues rather than abandoning the rest.
 * A dataset whose store another process is already syncing (a `mirror:init`
 * run, another instance's refresh) holds the store's sync lease; it is skipped,
 * not failed. `timeoutMs` bounds each dataset's run; `signal` stops the whole
 * pass, which then rejects with the abort error instead of starting another
 * dataset.
 */
export async function refreshMirrors(
  timeoutMs: number,
  ctx: RequestContext,
  signal: AbortSignal,
): Promise<RefreshOutcome[]> {
  const outcomes: RefreshOutcome[] = [];
  for (const endpoint of MIRRORED_ENDPOINTS) {
    signal.throwIfAborted();
    try {
      // Opening the store to read its sync state can fail on its own (a corrupt
      // or unreadable database file), so the readiness probe is inside the guard
      // that keeps one dataset's failure from abandoning the rest.
      const mirror = getMirror(endpoint);
      if (!(await mirror.ready())) {
        outcomes.push({ endpoint, skipped: 'never-initialised' });
        continue;
      }
      const result = await mirror.runSync({
        mode: 'refresh',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      outcomes.push({ endpoint, recordsApplied: result.recordsApplied, total: result.total });
    } catch (error) {
      // Stopped, not failed: the runner recorded the run as resumable and logged
      // it at info, and the rest of the pass must not start.
      if (signal.aborted) throw error;
      if (error instanceof McpError && error.data?.reason === 'sync_locked') {
        outcomes.push({ endpoint, skipped: 'sync-locked' });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ endpoint, error: message });
      logger.error('openFDA mirror refresh failed', withExtra(ctx, { endpoint, error: message }));
    }
  }
  return outcomes;
}

/**
 * Register the refresh cron when the mirror is enabled and a schedule is set,
 * returning the handle teardown stops it with; `undefined` when nothing was
 * scheduled. Gated to the HTTP transport: a stdio server is a short-lived
 * per-client process, so its operator runs `bun run mirror:refresh` from the
 * host instead.
 */
export async function scheduleMirrorRefresh(
  transport: 'http' | 'stdio',
): Promise<MirrorRefreshJob | undefined> {
  const config = getServerConfig();
  if (!config.mirrorEnabled || !config.mirrorRefreshCron) return;
  if (transport !== 'http') {
    logger.info(
      'openFDA mirror refresh cron skipped on stdio transport; run `bun run mirror:refresh` out-of-band',
      { requestId: JOB_ID, timestamp: new Date().toISOString() },
    );
    return;
  }

  const shutdown = new AbortController();
  // The scheduler skips a tick while the previous one runs, so one pass at most.
  let pass: Promise<void> | undefined;
  const runPass = async (ctx: RequestContext) => {
    try {
      const outcomes = await refreshMirrors(config.mirrorRefreshTimeoutMs, ctx, shutdown.signal);
      logger.info('openFDA mirror refresh pass complete', withExtra(ctx, { outcomes }));
    } catch (error) {
      // Stopped for shutdown: returning keeps the scheduler from logging a failed job.
      if (shutdown.signal.aborted) return;
      throw error;
    }
  };

  await schedulerService.schedule(
    JOB_ID,
    config.mirrorRefreshCron,
    (ctx) => {
      pass = runPass(ctx);
      return pass;
    },
    'Re-harvests the openFDA bulk dumps into the local mirror',
  );
  schedulerService.start(JOB_ID);

  return {
    async stop() {
      shutdown.abort();
      // Settled either way: a pass that failed on its own was already logged by the scheduler.
      await Promise.allSettled([pass]);
    },
  };
}

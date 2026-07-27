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

import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { logger, type RequestContext, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { MIRRORED_ENDPOINTS, type MirroredEndpoint } from './datasets.js';
import { getMirror } from './mirror-registry.js';

const JOB_ID = 'openfda-mirror-refresh';

/** Per-dataset outcome of one refresh pass. */
export interface RefreshOutcome {
  endpoint: MirroredEndpoint;
  error?: string;
  recordsApplied?: number;
  skipped?: 'never-initialised';
  total?: number;
}

/**
 * Refresh every initialised dataset in turn. Datasets are independent, so a
 * failure is recorded and the pass continues rather than abandoning the rest.
 */
export async function refreshMirrors(
  timeoutMs: number,
  ctx: RequestContext,
  log?: MirrorLogger,
): Promise<RefreshOutcome[]> {
  const outcomes: RefreshOutcome[] = [];
  for (const endpoint of MIRRORED_ENDPOINTS) {
    try {
      // Opening the store to read its sync state can fail on its own (a corrupt
      // or unreadable database file), so the readiness probe is inside the guard
      // that keeps one dataset's failure from abandoning the rest.
      const mirror = getMirror(endpoint, log);
      if (!(await mirror.ready())) {
        outcomes.push({ endpoint, skipped: 'never-initialised' });
        continue;
      }
      const result = await mirror.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(timeoutMs),
      });
      outcomes.push({ endpoint, recordsApplied: result.recordsApplied, total: result.total });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ endpoint, error: message });
      logger.error('openFDA mirror refresh failed', { ...ctx, endpoint, error: message });
    }
  }
  return outcomes;
}

/**
 * Register the refresh cron when the mirror is enabled and a schedule is set.
 * Gated to the HTTP transport: a stdio server is a short-lived per-client
 * process, so its operator runs `bun run mirror:refresh` from the host instead.
 */
export async function scheduleMirrorRefresh(transport: 'http' | 'stdio'): Promise<void> {
  const config = getServerConfig();
  if (!config.mirrorEnabled || !config.mirrorRefreshCron) return;
  if (transport !== 'http') {
    logger.info(
      'openFDA mirror refresh cron skipped on stdio transport; run `bun run mirror:refresh` out-of-band',
      { requestId: JOB_ID, timestamp: new Date().toISOString() },
    );
    return;
  }

  await schedulerService.schedule(
    JOB_ID,
    config.mirrorRefreshCron,
    async (ctx) => {
      const outcomes = await refreshMirrors(config.mirrorRefreshTimeoutMs, ctx);
      logger.info('openFDA mirror refresh pass complete', { ...ctx, outcomes });
    },
    'Re-harvests the openFDA bulk dumps into the local mirror',
  );
  schedulerService.start(JOB_ID);
}

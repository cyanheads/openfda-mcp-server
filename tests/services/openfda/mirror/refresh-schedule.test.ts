/**
 * @fileoverview Coverage for the out-of-band refresh wiring: when the cron is
 * registered, what a refresh pass does with a dataset that has never been
 * initialised or whose store another process is syncing, and how teardown stops
 * a refresh in flight.
 * @module tests/services/openfda/mirror/refresh-schedule
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  closeMirrors,
  DATASETS,
  getMirror,
  type MirroredEndpoint,
  mirrorPathFor,
  refreshMirrors,
  scheduleMirrorRefresh,
} from '@/services/openfda/mirror/index.js';

const JOB_ID = 'openfda-mirror-refresh';
const CTX = { requestId: 'test', timestamp: new Date().toISOString() };
/** A stop signal for passes nothing stops. */
const NEVER_STOPPED = new AbortController().signal;

/** A store on `endpoint`'s mirror file, as a second process opening it builds one. */
function storeFile(endpoint: MirroredEndpoint) {
  const spec = DATASETS[endpoint];
  return sqliteMirrorStore({
    path: mirrorPathFor(endpoint),
    table: spec.table,
    primaryKey: spec.primaryKey,
    columns: spec.columns,
    indexes: spec.indexes,
  });
}

describe('mirror refresh scheduling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openfda-refresh-'));
    vi.stubEnv('OPENFDA_MIRROR_PATH', dir);
    resetServerConfig();
  });

  afterEach(async () => {
    try {
      schedulerService.remove(JOB_ID);
    } catch {
      // Not registered — the no-op cases never create it.
    }
    await closeMirrors();
    vi.unstubAllEnvs();
    resetServerConfig();
    await rm(dir, { recursive: true, force: true });
  });

  const isRegistered = () => schedulerService.listJobs().some((job) => job.id === JOB_ID);

  it('registers nothing when the mirror is disabled', async () => {
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_CRON', '0 4 * * *');
    resetServerConfig();
    expect(await scheduleMirrorRefresh('http')).toBeUndefined();
    expect(isRegistered()).toBe(false);
  });

  it('registers nothing when no refresh cron is configured', async () => {
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    resetServerConfig();
    expect(await scheduleMirrorRefresh('http')).toBeUndefined();
    expect(isRegistered()).toBe(false);
  });

  it('leaves the refresh to the operator on stdio', async () => {
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_CRON', '0 4 * * *');
    resetServerConfig();
    expect(await scheduleMirrorRefresh('stdio')).toBeUndefined();
    expect(isRegistered()).toBe(false);
  });

  it('registers and starts the cron on the HTTP transport', async () => {
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_CRON', '0 4 * * *');
    resetServerConfig();
    await scheduleMirrorRefresh('http');
    expect(schedulerService.listJobs().find((job) => job.id === JOB_ID)?.schedule).toBe(
      '0 4 * * *',
    );
  });

  it('records an unreadable dataset and keeps refreshing the rest', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // A corrupt file fails when the store opens to read its sync state — before
    // any harvest — so it exercises the readiness probe, not runSync.
    const path = mirrorPathFor('drug/ndc');
    await mkdir(dir, { recursive: true });
    await writeFile(path, 'this is not a SQLite database');

    const outcomes = await refreshMirrors(60_000, CTX, NEVER_STOPPED);

    expect(outcomes).toHaveLength(4);
    expect(outcomes.find((outcome) => outcome.endpoint === 'drug/ndc')?.error).toBeDefined();
    const rest = outcomes.filter((outcome) => outcome.endpoint !== 'drug/ndc');
    expect(rest.every((outcome) => outcome.skipped === 'never-initialised')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('skips datasets that have never completed an init instead of harvesting them', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const outcomes = await refreshMirrors(60_000, CTX, NEVER_STOPPED);

    expect(outcomes.every((outcome) => outcome.skipped === 'never-initialised')).toBe(true);
    expect(outcomes).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('skips a dataset whose sync lease another process holds instead of failing it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // A second mirror on the same store file stands in for a concurrent
    // `mirror:init` process: it completes an init (so the dataset reads as
    // ready), then holds the lease with a refresh parked inside its generator.
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const other = defineMirror({
      name: 'other-process',
      store: storeFile('drug/ndc'),
      async *sync({ mode }) {
        if (mode === 'refresh') {
          markStarted();
          await held;
        }
        yield { records: [] };
      },
    });
    await mkdir(dir, { recursive: true });
    await other.runSync({ mode: 'init' });
    const holding = other.runSync({ mode: 'refresh' });
    await started;

    try {
      const outcomes = await refreshMirrors(60_000, CTX, NEVER_STOPPED);

      expect(outcomes.find((outcome) => outcome.endpoint === 'drug/ndc')).toEqual({
        endpoint: 'drug/ndc',
        skipped: 'sync-locked',
      });
      const rest = outcomes.filter((outcome) => outcome.endpoint !== 'drug/ndc');
      expect(rest.every((outcome) => outcome.skipped === 'never-initialised')).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      release();
      await holding;
      await other.close();
      vi.unstubAllGlobals();
    }
  });

  it('starts no dataset once its stop signal has fired', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const stop = new AbortController();
    stop.abort();

    try {
      await expect(refreshMirrors(60_000, CTX, stop.signal)).rejects.toBe(stop.signal.reason);
      // Not even the readiness probe ran: it opens (and creates) a dataset's store file.
      expect(await readdir(dir)).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops an in-flight scheduled refresh at teardown and lets it settle before the stores close', async () => {
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_CRON', '0 4 * * *');
    resetServerConfig();
    // A completed `mirror:init` makes drug/ndc ready, so the cron refreshes it.
    const cli = defineMirror({
      name: 'mirror-init-cli',
      store: storeFile('drug/ndc'),
      async *sync() {
        yield { records: [] };
      },
    });
    await mkdir(dir, { recursive: true });
    await cli.runSync({ mode: 'init' });
    await cli.close();

    // The harvester's manifest download parks until its signal aborts, as a slow
    // bulk download would.
    const download = Promise.withResolvers<AbortSignal>();
    let failDownload: ((reason: Error) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        download.resolve(signal);
        return new Promise((_resolve, reject) => {
          failDownload = reject;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
    );
    const errors = vi.spyOn(logger, 'error');

    const job = await scheduleMirrorRefresh('http');
    const scheduled = schedulerService.listJobs().find((entry) => entry.id === JOB_ID);
    const tick = scheduled?.task.execute();
    const signal = await download.promise;

    try {
      // src/index.ts teardown: stop the refresh, then close the stores.
      await job?.stop();
      const state = await getMirror('drug/ndc').status();
      await closeMirrors();

      // The run had recorded its stop (resumable, still ready) before the store closed.
      expect(state).toMatchObject({ status: 'error', ready: true });
      expect(signal.aborted).toBe(true);
      // The pass ended on the dataset it was refreshing; no later store was opened.
      expect(existsSync(mirrorPathFor('drug/enforcement'))).toBe(false);
      expect(existsSync(mirrorPathFor('drug/drugsfda'))).toBe(false);
      await tick;
      // A stop for shutdown is neither a refresh failure nor a failed job.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      failDownload?.(new Error('download released by the test'));
      await tick;
      errors.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

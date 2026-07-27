/**
 * @fileoverview Coverage for the out-of-band refresh wiring: when the cron is
 * registered, and what a refresh pass does with a dataset that has never been
 * initialised.
 * @module tests/services/openfda/mirror/refresh-schedule
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  closeMirrors,
  mirrorPathFor,
  refreshMirrors,
  scheduleMirrorRefresh,
} from '@/services/openfda/mirror/index.js';

const JOB_ID = 'openfda-mirror-refresh';
const CTX = { requestId: 'test', timestamp: new Date().toISOString() };

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
    await scheduleMirrorRefresh('http');
    expect(isRegistered()).toBe(false);
  });

  it('registers nothing when no refresh cron is configured', async () => {
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    resetServerConfig();
    await scheduleMirrorRefresh('http');
    expect(isRegistered()).toBe(false);
  });

  it('leaves the refresh to the operator on stdio', async () => {
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_CRON', '0 4 * * *');
    resetServerConfig();
    await scheduleMirrorRefresh('stdio');
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

    const outcomes = await refreshMirrors(60_000, CTX);

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

    const outcomes = await refreshMirrors(60_000, CTX);

    expect(outcomes.every((outcome) => outcome.skipped === 'never-initialised')).toBe(true);
    expect(outcomes).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

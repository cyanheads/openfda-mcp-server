/**
 * @fileoverview Service-level routing between the local mirror and the live
 * openFDA API: which queries the mirror answers, when it defers, and what
 * happens when it is cold, empty, or broken.
 *
 * The live API is stubbed at `fetch`, so every "routed live" assertion is a
 * positive observation that the HTTP client ran — not an absence of evidence.
 * @module tests/services/openfda/mirror/routing
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  closeMirrors,
  DATASETS,
  type MirroredEndpoint,
  mirrorPathFor,
} from '@/services/openfda/mirror/index.js';
import { OpenFdaService } from '@/services/openfda/openfda-service.js';
import { DUMP_STAMP, ENFORCEMENT_RECORD, SIBLING_RECORD } from './mirror-fixture.js';

const LIVE_RECORD = { ...ENFORCEMENT_RECORD, product_description: 'served by the live API' };

describe('mirror routing', () => {
  const mockFetch = vi.fn();
  let ctx: Context;
  let dir: string;

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      liveResponse(200, {
        meta: { results: { total: 1, skip: 0, limit: 1 }, last_updated: '2026-07-15' },
        results: [LIVE_RECORD],
      }),
    );
    ctx = createMockContext();
    dir = await mkdtemp(join(tmpdir(), 'openfda-routing-'));
    vi.stubEnv('OPENFDA_MIRROR_PATH', dir);
    resetServerConfig();
  });

  afterEach(async () => {
    await closeMirrors();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetServerConfig();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * `fetchWithTimeout` reads `.text()`/`.headers` on the error path and the
   * service reads `.json()` on success — a re-readable fake backs both.
   */
  function liveResponse(status: number, body: unknown): Response {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(),
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  /** Seed the on-disk mirror the registry will open for `endpoint`. */
  async function seedMirror(
    endpoint: MirroredEndpoint,
    records: Array<Record<string, unknown>>,
    { complete = true } = {},
  ): Promise<void> {
    const spec = DATASETS[endpoint];
    const store = sqliteMirrorStore({
      path: mirrorPathFor(endpoint),
      table: spec.table,
      primaryKey: spec.primaryKey,
      columns: spec.columns,
      indexes: spec.indexes,
    });
    const rows = records
      .map((record) => spec.project(record, DUMP_STAMP))
      .filter((row) => row !== undefined);
    await store.applyBatch(rows, []);
    if (complete) {
      await store.writeState({
        status: 'complete',
        completedAt: new Date().toISOString(),
        checkpoint: DUMP_STAMP.exportDate,
        total: rows.length,
      });
    }
    await store.close();
  }

  const lookup = { search: 'recall_number:"D-321-2016"', limit: 1 };

  it('never opens the mirror when it is disabled', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD]);
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: false });

    const response = await service.query('drug/enforcement', lookup, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(response.results).toEqual([LIVE_RECORD]);
    expect(response.meta.lastUpdated).toBe('2026-07-15');
  });

  it('answers an exact-key lookup from a synced mirror without calling the API', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD, SIBLING_RECORD]);
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    const response = await service.query('drug/enforcement', lookup, ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(response.results).toEqual([ENFORCEMENT_RECORD]);
    expect(response.meta).toEqual({ total: 1, skip: 0, limit: 1, lastUpdated: '2026-07-22' });
  });

  it('routes live when the mirror has never completed a sync', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD], { complete: false });
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    const response = await service.query('drug/enforcement', lookup, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(response.results).toEqual([LIVE_RECORD]);
  });

  it('routes live when a synced mirror holds no matching record', async () => {
    await seedMirror('drug/enforcement', [SIBLING_RECORD]);
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    const response = await service.query('drug/enforcement', lookup, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(response.results).toEqual([LIVE_RECORD]);
  });

  it('routes live for a query the mirror cannot reproduce', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD]);
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    await service.query(
      'drug/enforcement',
      { search: 'reason_for_recall:"sterility"', limit: 5 },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('keeps count aggregation on the live API', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD]);
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    await service.query('drug/enforcement', { count: 'classification.exact', limit: 10 }, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(new URL(mockFetch.mock.calls[0]?.[0] as string).searchParams.get('count')).toBe(
      'classification.exact',
    );
  });

  it('raises rather than spending the live budget when fallback is off and the mirror is cold', async () => {
    const service = new OpenFdaService({
      baseUrl: 'https://api.fda.gov',
      mirrorEnabled: true,
      mirrorFallbackLive: false,
    });

    await expect(service.query('drug/enforcement', lookup, ctx)).rejects.toThrow(McpError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports a genuine miss as an empty result when fallback is off', async () => {
    await seedMirror('drug/enforcement', [SIBLING_RECORD]);
    const service = new OpenFdaService({
      baseUrl: 'https://api.fda.gov',
      mirrorEnabled: true,
      mirrorFallbackLive: false,
    });

    const response = await service.query('drug/enforcement', lookup, ctx);

    // Fallback off is an explicit offline posture: a synced mirror that does not
    // hold the record answers zero, the shape the live API returns for a miss.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(response.meta).toEqual({ total: 0, skip: 0, limit: 1, lastUpdated: '2026-07-22' });
    expect(response.results).toEqual([]);
  });

  it('keeps serving while a refresh is in flight over a complete mirror', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD]);
    const spec = DATASETS['drug/enforcement'];
    const store = sqliteMirrorStore({
      path: mirrorPathFor('drug/enforcement'),
      table: spec.table,
      primaryKey: spec.primaryKey,
      columns: spec.columns,
      indexes: spec.indexes,
    });
    // The durable `completedAt` survives the in-flight status, so readiness holds.
    await store.writeState({ status: 'in_progress', startedAt: new Date().toISOString() });
    await store.close();
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    const response = await service.query('drug/enforcement', lookup, ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(response.results).toEqual([ENFORCEMENT_RECORD]);
  });

  it('falls back to live when the mirror store itself fails', async () => {
    await seedMirror('drug/enforcement', [ENFORCEMENT_RECORD]);
    const path = mirrorPathFor('drug/enforcement');
    for (const suffix of ['-wal', '-shm']) await rm(`${path}${suffix}`, { force: true });
    await writeFile(path, 'this is not a SQLite database');
    const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov', mirrorEnabled: true });

    const response = await service.query('drug/enforcement', lookup, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(response.results).toEqual([LIVE_RECORD]);
  });
});

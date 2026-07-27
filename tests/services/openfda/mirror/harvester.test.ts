/**
 * @fileoverview End-to-end sync coverage for one dataset's ingester, driven
 * through the framework runner against a temp SQLite store and a stubbed bulk
 * download. Covers the full-refresh model openFDA forces (no incremental API),
 * tombstoning of withdrawn records, and the GMDN abort.
 * @module tests/services/openfda/mirror/harvester
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { defineMirror, type MirrorRow, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarvester, DATASETS } from '@/services/openfda/mirror/index.js';
import { ENFORCEMENT_RECORD, KEYLESS_RECORD, SIBLING_RECORD } from './mirror-fixture.js';

const SPEC = DATASETS['drug/enforcement'];
const BASE_URL = 'https://api.fda.gov';
const PARTITION_URL = 'https://download.test/drug-enforcement-0001-of-0001.json.zip';
const STAMP_0722 = { exportDate: '2026-07-22', lastUpdated: '2026-07-22' };

describe('bulk harvester', () => {
  const mockFetch = vi.fn();
  let dir: string;

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    dir = await mkdtemp(join(tmpdir(), 'openfda-harvest-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  /** Serve `download.json` and the one partition it names. */
  function stubDump(
    exportDate: string,
    records: Array<Record<string, unknown>>,
    lastUpdated = exportDate,
  ): void {
    mockFetch.mockImplementation(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith('/download.json')) {
        return new Response(
          JSON.stringify({
            results: {
              drug: {
                enforcement: {
                  export_date: exportDate,
                  total_records: records.length,
                  partitions: [{ file: PARTITION_URL, records: records.length }],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(await zip(records, lastUpdated), { status: 200 });
    });
  }

  /** Serve `download.json` with one partition per record group. */
  function stubPartitionedDump(
    exportDate: string,
    groups: Array<Array<Record<string, unknown>>>,
  ): void {
    const files = groups.map((_, index) => `${PARTITION_URL}#${index}`);
    mockFetch.mockImplementation(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith('/download.json')) {
        return new Response(
          JSON.stringify({
            results: {
              drug: {
                enforcement: {
                  export_date: exportDate,
                  total_records: groups.flat().length,
                  partitions: files.map((file, index) => ({
                    file,
                    records: (groups[index] ?? []).length,
                  })),
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      const index = files.indexOf(url);
      return new Response(await zip(groups[index] ?? [], exportDate), { status: 200 });
    });
  }

  async function zip(
    records: Array<Record<string, unknown>>,
    lastUpdated: string,
  ): Promise<Uint8Array> {
    const content = JSON.stringify({
      meta: { last_updated: lastUpdated, results: { skip: 0, limit: 0, total: records.length } },
      results: records,
    });
    const raw = new TextEncoder().encode(content);
    const deflated = new Uint8Array(
      await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
      ).arrayBuffer(),
    );
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x0403_4b50, true);
    view.setUint16(8, 8, true);
    view.setUint32(18, deflated.length, true);
    view.setUint32(22, raw.length, true);
    const out = new Uint8Array(header.length + deflated.length);
    out.set(header, 0);
    out.set(deflated, header.length);
    return out;
  }

  function buildMirror() {
    const store = sqliteMirrorStore({
      path: join(dir, 'drug-enforcement.db'),
      table: SPEC.table,
      primaryKey: SPEC.primaryKey,
      columns: SPEC.columns,
      indexes: SPEC.indexes,
    });
    return defineMirror({
      name: 'test-enforcement',
      store,
      logger: {},
      sync: createHarvester(SPEC, { baseUrl: BASE_URL, log: {}, store }),
    });
  }

  it('ingests a full dump and marks the mirror ready', async () => {
    stubDump('2026-07-22', [ENFORCEMENT_RECORD, SIBLING_RECORD, KEYLESS_RECORD], '2026-07-20');
    const mirror = buildMirror();

    const result = await mirror.runSync({ mode: 'init' });

    // The keyless record is unaddressable and is dropped, not stored.
    expect(result.recordsApplied).toBe(2);
    expect(await mirror.ready()).toBe(true);
    expect(await mirror.status()).toMatchObject({ checkpoint: '2026-07-22', total: 2 });

    const stored = await mirror.getByIds(['D-321-2016']);
    expect(JSON.parse(String(stored[0]?.raw))).toEqual(ENFORCEMENT_RECORD);
    expect(stored[0]?.last_updated).toBe('2026-07-20');
    await mirror.close();
  });

  it('skips a refresh when the published dump has not advanced', async () => {
    stubDump('2026-07-22', [ENFORCEMENT_RECORD]);
    const mirror = buildMirror();
    await mirror.runSync({ mode: 'init' });
    mockFetch.mockClear();

    const result = await mirror.runSync({ mode: 'refresh' });

    expect(result.recordsApplied).toBe(0);
    // Only the manifest was read; the partition was never downloaded.
    expect(mockFetch).toHaveBeenCalledOnce();
    await mirror.close();
  });

  it('tombstones records a newer dump no longer carries', async () => {
    stubDump('2026-07-22', [ENFORCEMENT_RECORD, SIBLING_RECORD]);
    const mirror = buildMirror();
    await mirror.runSync({ mode: 'init' });

    stubDump('2026-07-29', [ENFORCEMENT_RECORD]);
    const result = await mirror.runSync({ mode: 'refresh' });

    expect(result.tombstonesApplied).toBe(1);
    expect(await mirror.store.count()).toBe(1);
    expect(await mirror.getByIds(['D-322-2016'])).toEqual([]);
    await mirror.close();
  });

  it('resumes an interrupted init rather than restarting it', async () => {
    stubPartitionedDump('2026-07-22', [[ENFORCEMENT_RECORD], [SIBLING_RECORD]]);
    const mirror = buildMirror();
    // Partition 0 already landed in this same export; the run picks up at 1.
    await mirror.store.applyBatch([SPEC.project(ENFORCEMENT_RECORD, STAMP_0722) as MirrorRow], []);
    await mirror.store.writeState({
      status: 'error',
      cursor: '2026-07-22:1',
      error: 'interrupted',
    });

    const result = await mirror.runSync({ mode: 'init' });

    expect(result.recordsApplied).toBe(1);
    expect(await mirror.status()).toMatchObject({ status: 'complete', total: 2 });
    await mirror.close();
  });

  it('restarts an init whose dump was re-exported mid-run instead of tombstoning it', async () => {
    stubPartitionedDump('2026-07-29', [[ENFORCEMENT_RECORD], [SIBLING_RECORD]]);
    const mirror = buildMirror();
    // Partition 0 landed under the previous export; resuming at 1 would leave it
    // stamped 2026-07-22 for the closing tombstone pass to delete.
    await mirror.store.applyBatch([SPEC.project(ENFORCEMENT_RECORD, STAMP_0722) as MirrorRow], []);
    await mirror.store.writeState({
      status: 'error',
      cursor: '2026-07-22:1',
      error: 'interrupted',
    });

    await mirror.runSync({ mode: 'init' });

    expect(await mirror.store.count()).toBe(2);
    expect(await mirror.getByIds(['D-321-2016'])).toHaveLength(1);
    expect(await mirror.status()).toMatchObject({ status: 'complete', total: 2 });
    await mirror.close();
  });

  it('aborts the sync when the dump carries GMDN-licensed content', async () => {
    stubDump('2026-07-22', [{ ...ENFORCEMENT_RECORD, gmdn_terms: [{ code: '35132' }] }]);
    const mirror = buildMirror();

    await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow(McpError);
    expect(await mirror.store.count()).toBe(0);
    expect(await mirror.ready()).toBe(false);
    await mirror.close();
  });
});

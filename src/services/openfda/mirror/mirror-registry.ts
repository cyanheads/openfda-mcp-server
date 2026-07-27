/**
 * @fileoverview Lazily constructed mirror instances — one SQLite file per
 * mirrored dataset.
 *
 * The framework's sync-state row is per database, so the four datasets cannot
 * share a file: each gets its own store, its own harvester, and its own
 * init/refresh lifecycle, which also lets an operator mirror only the datasets
 * they care about.
 *
 * @module services/openfda/mirror/mirror-registry
 */

import { join } from 'node:path';
import {
  defineMirror,
  type Mirror,
  type MirrorLogger,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { DATASETS, type MirroredEndpoint } from './datasets.js';
import { createHarvester } from './harvester.js';

const instances = new Map<MirroredEndpoint, Mirror>();

/** Sync progress is quiet by default; the CLI passes a logger that reports it. */
const SILENT_LOG: MirrorLogger = {};

/** Absolute-or-relative path of the SQLite file backing one dataset. */
export function mirrorPathFor(endpoint: MirroredEndpoint): string {
  return join(getServerConfig().mirrorPath, `${DATASETS[endpoint].slug}.db`);
}

/**
 * The mirror for one dataset, constructed on first use. Construction opens
 * nothing — the store lazy-opens on its first query or write. `log` is used for
 * harvest progress; omit it to inherit the framework logger for runner events
 * and stay silent about per-partition progress.
 */
export function getMirror(endpoint: MirroredEndpoint, log?: MirrorLogger): Mirror {
  const existing = instances.get(endpoint);
  if (existing) return existing;

  const spec = DATASETS[endpoint];
  const config = getServerConfig();
  const store = sqliteMirrorStore({
    path: mirrorPathFor(endpoint),
    table: spec.table,
    primaryKey: spec.primaryKey,
    columns: spec.columns,
    indexes: spec.indexes,
  });
  const mirror = defineMirror({
    name: `openfda-${spec.slug}`,
    store,
    ...(log ? { logger: log } : {}),
    sync: createHarvester(spec, {
      baseUrl: config.mirrorBaseUrl,
      log: log ?? SILENT_LOG,
      store,
    }),
  });
  instances.set(endpoint, mirror);
  return mirror;
}

/** Close every opened mirror. Used by CLI scripts and tests. */
export async function closeMirrors(): Promise<void> {
  const opened = [...instances.values()];
  instances.clear();
  await Promise.all(opened.map((mirror) => mirror.close()));
}

/**
 * @fileoverview Shared fixture for the mirror tests — builds a real SQLite store
 * for a dataset in a temp directory and seeds it with real openFDA record
 * shapes. Nothing here touches the network; a seeded mirror is written through
 * the same `applyBatch` path the sync runner uses.
 * @module tests/services/openfda/mirror/mirror-fixture
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineMirror,
  type Mirror,
  type MirrorStore,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { DATASETS, type MirroredEndpoint } from '@/services/openfda/mirror/index.js';

export const ENFORCEMENT_RECORD = {
  status: 'Terminated',
  city: 'Peoria',
  state: 'IL',
  classification: 'Class II',
  openfda: {},
  product_type: 'Drugs',
  event_id: '72241',
  recalling_firm: 'Essential Wellness Pharmacy',
  recall_number: 'D-321-2016',
  product_description: 'Progesterone 100 mg/mL in Corn Oil Injection, 2 mL vials',
  reason_for_recall: 'Lack of Assurance of Sterility',
  report_date: '20151125',
} as const;

export const SIBLING_RECORD = {
  ...ENFORCEMENT_RECORD,
  recall_number: 'D-322-2016',
  product_description: 'Testosterone Cypionate 200 mg/mL Injection',
} as const;

/** A record with no primary key — unaddressable, so the projector drops it. */
export const KEYLESS_RECORD = { event_id: '72241', state: 'IL' } as const;

export const DUMP_STAMP = { exportDate: '2026-07-22', lastUpdated: '2026-07-22' };

export interface MirrorFixture extends AsyncDisposable {
  dir: string;
  /** Mark the mirror as having completed a sync, so `ready()` is true. */
  markComplete(total: number): Promise<void>;
  mirror: Mirror;
  /** Write records through the dataset's own projector. */
  seed(records: Array<Record<string, unknown>>): Promise<void>;
  store: MirrorStore;
}

/** Open an empty mirror for `endpoint` backed by a fresh temp database. */
export async function createMirrorFixture(endpoint: MirroredEndpoint): Promise<MirrorFixture> {
  const spec = DATASETS[endpoint];
  const dir = await mkdtemp(join(tmpdir(), 'openfda-mirror-'));
  const store = sqliteMirrorStore({
    path: join(dir, `${spec.slug}.db`),
    table: spec.table,
    primaryKey: spec.primaryKey,
    columns: spec.columns,
    indexes: spec.indexes,
  });
  const mirror = defineMirror({
    name: `test-${spec.slug}`,
    store,
    /** Fixtures are seeded directly; nothing here ever runs a sync. */
    sync: async function* () {},
  });

  return {
    dir,
    store,
    mirror,
    async seed(records) {
      const rows = records
        .map((record) => spec.project(record, DUMP_STAMP))
        .filter((row) => row !== undefined);
      await store.applyBatch(rows, []);
    },
    async markComplete(total) {
      await store.writeState({
        status: 'complete',
        completedAt: new Date().toISOString(),
        checkpoint: DUMP_STAMP.exportDate,
        total,
      });
    },
    async [Symbol.asyncDispose]() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

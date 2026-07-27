/**
 * @fileoverview Ingester for one mirrored openFDA dataset.
 *
 * openFDA publishes no incremental API for these endpoints — only whole bulk
 * dumps stamped with an export date — so both `init` and `refresh` re-read every
 * partition, and a refresh whose export date has not advanced past the stored
 * checkpoint is a no-op. Rows carry the export date they were written from, so a
 * completed pass can tombstone whatever the new dump no longer contains.
 *
 * @module services/openfda/mirror/harvester
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorLogger,
  MirrorRow,
  MirrorStore,
  SyncGenerator,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { type BulkManifest, fetchBulkManifest, streamPartition } from './bulk-stream.js';
import { assertNoGmdnContent, type DatasetSpec, type DumpStamp } from './datasets.js';

/** Records applied per store transaction. */
const BATCH_SIZE = 500;
/** Stale primary keys read per tombstone page. */
const TOMBSTONE_PAGE = 5_000;

export interface HarvestOptions {
  /** Host serving `download.json`. */
  baseUrl: string;
  log: MirrorLogger;
  /** Store backing this dataset — read directly to find rows the new dump dropped. */
  store: MirrorStore;
}

/**
 * Build the `sync` generator for a dataset. Yields one page per batch of
 * records; the export date is published as the checkpoint only after the final
 * partition, so an interrupted run never advertises a complete corpus.
 */
export function createHarvester(spec: DatasetSpec, options: HarvestOptions): SyncGenerator {
  const { baseUrl, log, store } = options;

  return async function* sync({ mode, cursor, checkpoint, signal }): AsyncGenerator<SyncPage> {
    const manifest = await fetchBulkManifest(baseUrl, spec.endpoint, signal);

    if (mode === 'refresh' && checkpoint !== undefined && manifest.exportDate <= checkpoint) {
      log.info?.('openFDA bulk dump unchanged since last sync', {
        endpoint: spec.endpoint,
        exportDate: manifest.exportDate,
        checkpoint,
      });
      return;
    }

    const startPartition = resumeIndex(cursor, manifest);
    log.info?.('Harvesting openFDA bulk dump', {
      endpoint: spec.endpoint,
      mode,
      exportDate: manifest.exportDate,
      partitions: manifest.partitions.length,
      startPartition,
      totalRecords: manifest.totalRecords,
    });

    for (let index = startPartition; index < manifest.partitions.length; index += 1) {
      const partition = manifest.partitions[index] as BulkManifest['partitions'][number];
      log.info?.('Reading bulk partition', {
        endpoint: spec.endpoint,
        partition: index + 1,
        of: manifest.partitions.length,
        file: partition.file,
      });
      for await (const batch of streamPartition(partition.file, BATCH_SIZE, signal)) {
        if (batch.lastUpdated === undefined) {
          throw serviceUnavailable(
            `openFDA bulk partition for ${spec.endpoint} carries no meta.last_updated stamp.`,
            { endpoint: spec.endpoint, file: partition.file },
          );
        }
        const stamp: DumpStamp = {
          exportDate: manifest.exportDate,
          lastUpdated: batch.lastUpdated,
        };
        yield {
          records: project(spec, batch.records, stamp),
          cursor: `${manifest.exportDate}:${index}`,
        };
      }
    }

    yield* tombstoneStalePages(spec, store, manifest.exportDate);
    // The corpus is whole only now: publishing the export date earlier would let
    // a later refresh skip work an interrupted run never finished.
    yield { records: [], checkpoint: manifest.exportDate };
  };
}

/**
 * Resume position for an interrupted init, read from an `<exportDate>:<index>`
 * cursor. Anything that does not name the dump now being harvested restarts from
 * the beginning: a cursor from an older export would leave the partitions the
 * interrupted run already wrote stamped with the previous export date, and the
 * tombstone pass that closes a completed harvest would then delete them — a
 * mirror that reports itself complete while missing everything before the
 * resume point. The same restart covers a cursor pointing past the current
 * manifest (openFDA re-partitioned) and any cursor written before this format.
 */
function resumeIndex(cursor: string | undefined, manifest: BulkManifest): number {
  if (cursor === undefined) return 0;
  const separator = cursor.lastIndexOf(':');
  if (separator === -1 || cursor.slice(0, separator) !== manifest.exportDate) return 0;
  const index = Number.parseInt(cursor.slice(separator + 1), 10);
  if (!Number.isInteger(index) || index < 0 || index >= manifest.partitions.length) return 0;
  return index;
}

/** Map upstream records to rows, dropping any that carry no primary key. */
function project(
  spec: DatasetSpec,
  records: Record<string, unknown>[],
  stamp: DumpStamp,
): MirrorRow[] {
  const rows: MirrorRow[] = [];
  for (const record of records) {
    assertNoGmdnContent(spec.endpoint, record);
    const row = spec.project(record, stamp);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Emit tombstones for rows the new dump no longer carries. Every row written
 * during the pass holds the current export date, so anything older is a record
 * openFDA has withdrawn. Each page is re-read after the runner applies the
 * previous one, so the loop drains as the deletes land.
 */
async function* tombstoneStalePages(
  spec: DatasetSpec,
  store: MirrorStore,
  exportDate: string,
): AsyncGenerator<SyncPage> {
  const handle = await store.raw();
  const statement = handle.prepare<Record<string, string>>(
    `SELECT ${spec.primaryKey} FROM ${spec.table}
     WHERE synced_at IS NULL OR synced_at < ?
     LIMIT ?`,
  );
  for (;;) {
    const rows = statement.all(exportDate, TOMBSTONE_PAGE);
    if (rows.length === 0) return;
    yield {
      records: [],
      tombstones: rows.map((row) => String(row[spec.primaryKey])),
    };
  }
}

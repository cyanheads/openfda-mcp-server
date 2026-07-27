/**
 * @fileoverview Public barrel for the openFDA bulk mirror — an opt-in local
 * SQLite copy of the four drug datasets openFDA publishes as bulk downloads,
 * queried only for lookups it can answer identically to the live API.
 * @module services/openfda/mirror
 */

export type { BulkManifest, BulkPartition, DumpBatch } from './bulk-stream.js';
export { DumpScanner, fetchBulkManifest, streamPartition } from './bulk-stream.js';
export type { DatasetSpec, DumpStamp, ExactKeyField, MirroredEndpoint } from './datasets.js';
export {
  assertNoGmdnContent,
  DATASETS,
  datasetFor,
  findGmdnPath,
  MIRRORED_ENDPOINTS,
} from './datasets.js';
export { createHarvester, type HarvestOptions } from './harvester.js';
export { closeMirrors, getMirror, mirrorPathFor } from './mirror-registry.js';
export { type MirrorLookup, planMirrorLookup, runMirrorLookup } from './query.js';
export {
  type RefreshOutcome,
  refreshMirrors,
  scheduleMirrorRefresh,
} from './refresh-schedule.js';

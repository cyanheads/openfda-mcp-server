/**
 * @fileoverview Decides whether a query can be answered from the local mirror
 * without diverging from the live API, and answers it when it can.
 *
 * openFDA's `search` runs server-side in Elasticsearch: it tokenises, ranks, and
 * orders. A local SQLite corpus reproduces none of that, so the mirror answers
 * only the narrow class of queries where an equality test provably selects the
 * same documents as the upstream query:
 *
 * 1. a single quoted `field:"value"` term — no boolean operators, no wildcards,
 *    no ranges, no second clause;
 * 2. on a field declared in the dataset's `keys`, with a value that is a whole
 *    canonical identifier in its canonical case;
 * 3. no `count`, no `sort`, and `skip === 0` — aggregation and ordering are
 *    upstream's to define;
 * 4. and the value addresses exactly one record, so the response is the whole
 *    answer and there is no order to disagree about.
 *
 * Anything else returns `undefined` and is routed live.
 *
 * Selection is reproduced; ordering is not. Upstream orders an unsorted match by
 * Elasticsearch relevance, which no local index can recompute. Condition 4 is
 * what keeps that from mattering: a lookup on a non-unique key (`event_id`,
 * `product_ndc`, `set_id`) is served only where that key happens to address a
 * single record, and two or more records route live whatever the page size. A
 * one-record response is order-free, so a mirrored answer is the API's answer.
 *
 * @module services/openfda/mirror/query
 */

import type { Mirror } from '@cyanheads/mcp-ts-core/mirror';
import type { OpenFdaQueryParams, OpenFdaResponse } from '../types.js';
import { type DatasetSpec, datasetFor } from './datasets.js';

/**
 * A single quoted term. The value is captured verbatim; an embedded quote,
 * a second clause, or an unquoted value all fail to match and route live.
 */
const SINGLE_QUOTED_TERM = /^([A-Za-z_][A-Za-z0-9_.]*)\s*:\s*"([^"]*)"$/;

/** openFDA's documented default page size when `limit` is omitted. */
const DEFAULT_LIMIT = 1;

/** A query the mirror is permitted to attempt. */
export interface MirrorLookup {
  column: string;
  dataset: DatasetSpec;
  /** openFDA field path the search named. */
  field: string;
  /** Requested page size, echoed into `meta.limit` as the live API echoes it. */
  limit: number;
  value: string;
}

/**
 * Resolve a query to a mirror lookup, or `undefined` when the mirror cannot
 * reproduce it. Purely syntactic — it inspects no data, so it is safe to call
 * before the store is open.
 */
export function planMirrorLookup(
  endpoint: string,
  params: OpenFdaQueryParams,
): MirrorLookup | undefined {
  if (params.count !== undefined || params.sort !== undefined) return;
  if ((params.skip ?? 0) !== 0) return;

  const dataset = datasetFor(endpoint);
  if (!dataset || params.search === undefined) return;

  const term = SINGLE_QUOTED_TERM.exec(params.search.trim());
  if (!term) return;

  // Both groups always participate in a match; the defaults only satisfy
  // `noUncheckedIndexedAccess`, and an empty field name matches no declared key.
  const [, field = '', value = ''] = term;
  const key = dataset.keys[field];
  if (!key?.pattern.test(value)) return;

  return {
    dataset,
    field,
    column: key.column,
    value,
    limit: params.limit ?? DEFAULT_LIMIT,
  };
}

/**
 * Answer a planned lookup from the mirror, or return `undefined` when the value
 * matches more than one record — upstream ranks a multi-record match by
 * relevance and the mirror cannot recompute that, so the caller routes live.
 *
 * A zero-match is answered rather than declined: an empty result is a fact about
 * the corpus, and whether a mirror that may be a refresh cycle behind is allowed
 * to report a miss belongs to the caller (`OPENFDA_MIRROR_FALLBACK_LIVE`).
 *
 * @throws Whatever the store throws (a missing or corrupt database file); the
 *   caller decides whether that falls back to live.
 */
export async function runMirrorLookup(
  mirror: Mirror,
  lookup: MirrorLookup,
): Promise<OpenFdaResponse | undefined> {
  // `total` counts the whole match; one row is all a served answer can hold, so
  // a multi-record match is detected without reading records it will not return.
  const { rows, total } = await mirror.query({
    filters: [{ column: lookup.column, op: 'eq', value: lookup.value }],
    limit: 1,
    offset: 0,
  });
  if (total > 1) return;

  return {
    meta: {
      total,
      skip: 0,
      limit: lookup.limit,
      lastUpdated:
        (rows[0]?.last_updated as string | undefined) ??
        (await datasetStamp(mirror, lookup.dataset)),
    },
    results: rows.map((row) => JSON.parse(String(row.raw)) as Record<string, unknown>),
  };
}

/**
 * The dump's `meta.last_updated` — the same value the live API reports for the
 * endpoint. Every row carries it, so a zero-match lookup reads it from any row.
 */
async function datasetStamp(mirror: Mirror, dataset: DatasetSpec): Promise<string> {
  const handle = await mirror.raw();
  const row = handle
    .prepare<{ last_updated: string | null }>(
      `SELECT last_updated FROM ${dataset.table} WHERE last_updated IS NOT NULL LIMIT 1`,
    )
    .get();
  return row?.last_updated ?? 'unknown';
}

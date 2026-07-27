/**
 * @fileoverview Closed registry of the openFDA bulk datasets this server may
 * mirror, plus the GMDN licensing carve-out that keeps the registry closed.
 *
 * Each entry declares the SQLite projection (a primary key, the exact-key
 * lookup columns, the dump's freshness stamps, and the verbatim upstream record
 * in `raw`) and the search fields the mirror is allowed to answer. Every
 * routable field carries an identifier grammar in its **canonical spelling**:
 * openFDA indexes these as analysed text, so `field:"value"` is a phrase match
 * rather than an equality test, and only a whole canonical identifier is
 * guaranteed to select the same documents a `=` comparison does. A value outside
 * its grammar — including the right identifier in the wrong case — is never
 * served from the mirror.
 *
 * @module services/openfda/mirror/datasets
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { SqlValue } from '@cyanheads/mcp-ts-core/mirror';

/** Endpoints with a published bulk dump this server is permitted to mirror. */
export const MIRRORED_ENDPOINTS = [
  'drug/label',
  'drug/ndc',
  'drug/enforcement',
  'drug/drugsfda',
] as const;

export type MirroredEndpoint = (typeof MIRRORED_ENDPOINTS)[number];

/** Freshness stamps carried by every row written during one harvest pass. */
export interface DumpStamp {
  /** `export_date` from `download.json` — the tombstone generation marker. */
  exportDate: string;
  /** `meta.last_updated` from the dump body — the value the live API reports. */
  lastUpdated: string;
}

/**
 * openFDA data is dedicated to the public domain under CC0 1.0 with one
 * exception: GMDN® Term Code, Name and Definition are licensed from The GMDN
 * Agency, and extracting them for redistribution, alternative categorisation, or
 * AI training requires a separate licence from the Agency. Those terms are
 * carried in the `gmdn_terms[]` block of the device UDI (GUDID) dataset and in
 * `device/classification`.
 *
 * {@link MIRRORED_ENDPOINTS} is the primary defence — it admits four drug
 * datasets and nothing else, so no device dump is reachable.
 * {@link assertNoGmdnContent} is the backstop: every ingested record is walked
 * for a GMDN-bearing key before it reaches the store, so a schema change
 * upstream fails the sync loudly instead of silently copying licensed content
 * into a local database.
 */
const GMDN_KEY_PATTERN = /gmdn/i;

/**
 * Walk a record for any key path carrying GMDN content. Returns the offending
 * path, or `undefined` when the record is clear.
 */
export function findGmdnPath(value: unknown, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findGmdnPath(item, `${path}[${index}]`);
      if (hit) return hit;
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (GMDN_KEY_PATTERN.test(key)) return childPath;
    const hit = findGmdnPath(child, childPath);
    if (hit) return hit;
  }
  return;
}

/**
 * Fail the sync when an upstream record carries GMDN-licensed content. Mirroring
 * it would create a local redistribution of data openFDA licenses rather than
 * dedicates to the public domain.
 */
export function assertNoGmdnContent(endpoint: string, record: unknown): void {
  const path = findGmdnPath(record);
  if (path === undefined) return;
  throw validationError(
    `Refusing to mirror ${endpoint}: record carries GMDN-licensed content at "${path}". GMDN Term Code, Name and Definition are licensed from The GMDN Agency and are excluded from this mirror.`,
    { endpoint, path },
  );
}

/** One search field the mirror may answer, and the column it resolves to. */
export interface ExactKeyField {
  /** Declared SQLite column holding the value. */
  column: string;
  /**
   * Canonical grammar for the identifier, matched case-sensitively. A search
   * value outside the grammar is routed live: outside it a phrase match and an
   * equality test can select different documents, and a differently-cased
   * spelling matches upstream's analysed index but not the stored literal.
   */
  pattern: RegExp;
}

/** Declarative spec for one mirrored dataset. */
export interface DatasetSpec {
  /** Declared columns, in insertion order; `raw` holds the verbatim upstream record. */
  columns: Record<string, string>;
  endpoint: MirroredEndpoint;
  /** Secondary indexes over declared columns. */
  indexes: Array<{ columns: string[] }>;
  /** Search fields the mirror may answer, keyed by their openFDA field path. */
  keys: Record<string, ExactKeyField>;
  /** Primary-key column. */
  primaryKey: string;
  /**
   * Project an upstream record into a row stamped with the dump's freshness.
   * Returns `undefined` when the record lacks a primary key — such a record is
   * unaddressable and is skipped.
   */
  project(record: Record<string, unknown>, stamp: DumpStamp): Record<string, SqlValue> | undefined;
  /** Filesystem-safe dataset slug — one SQLite file per dataset. */
  slug: string;
  /** SQLite table name. */
  table: string;
}

/** Lowercase hex UUID — the spelling openFDA stores for SPL identifiers. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** NDC product code — 4-5 digit labeler segment, 3-4 digit product segment. */
const PRODUCT_NDC = /^\d{4,5}-\d{3,4}$/;
/** NDC directory row key — a product NDC joined to its SPL document id. */
const PRODUCT_ID = new RegExp(`^\\d{4,5}-\\d{3,4}_${UUID.source.slice(1, -1)}$`);
/** Enforcement recall number — centre letter, sequence, year. */
const RECALL_NUMBER = /^[A-Z]-\d{3,4}-\d{4}$/;
/** Drugs@FDA application number — NDA, ANDA, or BLA and its serial. */
const APPLICATION_NUMBER = /^(?:NDA|ANDA|BLA)\d{5,6}$/;
/**
 * A numeric identifier in its canonical spelling — no leading zeros. openFDA
 * indexes `event_id` numerically, so `"0072241"` and `"72241"` are the same
 * query upstream while the stored literal is only ever the latter; admitting the
 * padded spelling would answer a matching query with a zero-match.
 */
const CANONICAL_DIGITS = /^(?:0|[1-9]\d*)$/;

/** Freshness + payload columns every dataset carries, appended after its keys. */
const COMMON_COLUMNS = {
  last_updated: 'TEXT',
  synced_at: 'TEXT',
  raw: 'TEXT NOT NULL',
} as const;

/** Read a top-level string field, normalising empty/absent to `undefined`. */
function str(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build a projector for datasets whose row is a primary key, zero or more
 * lookup columns, the dump's freshness stamps, and the verbatim record.
 */
function projector(primaryKey: string, lookups: string[]) {
  return (
    record: Record<string, unknown>,
    stamp: DumpStamp,
  ): Record<string, SqlValue> | undefined => {
    const id = str(record, primaryKey);
    if (id === undefined) return;
    const row: Record<string, SqlValue> = {
      [primaryKey]: id,
      last_updated: stamp.lastUpdated,
      synced_at: stamp.exportDate,
      raw: JSON.stringify(record),
    };
    for (const field of lookups) row[field] = str(record, field) ?? null;
    return row;
  };
}

/**
 * The four mirrorable datasets. A key need not be unique — `product_ndc`,
 * `set_id` and `event_id` are not — because `query.ts` answers a lookup only
 * when the whole match set fits on the requested page.
 */
export const DATASETS: Record<MirroredEndpoint, DatasetSpec> = {
  'drug/label': {
    endpoint: 'drug/label',
    slug: 'drug-label',
    table: 'drug_label',
    primaryKey: 'id',
    columns: { id: 'TEXT', set_id: 'TEXT', ...COMMON_COLUMNS },
    indexes: [{ columns: ['set_id'] }, { columns: ['synced_at'] }],
    keys: {
      id: { column: 'id', pattern: UUID },
      set_id: { column: 'set_id', pattern: UUID },
    },
    project: projector('id', ['set_id']),
  },
  'drug/ndc': {
    endpoint: 'drug/ndc',
    slug: 'drug-ndc',
    table: 'drug_ndc',
    primaryKey: 'product_id',
    columns: { product_id: 'TEXT', product_ndc: 'TEXT', ...COMMON_COLUMNS },
    indexes: [{ columns: ['product_ndc'] }, { columns: ['synced_at'] }],
    keys: {
      product_id: { column: 'product_id', pattern: PRODUCT_ID },
      product_ndc: { column: 'product_ndc', pattern: PRODUCT_NDC },
    },
    project: projector('product_id', ['product_ndc']),
  },
  'drug/enforcement': {
    endpoint: 'drug/enforcement',
    slug: 'drug-enforcement',
    table: 'drug_enforcement',
    primaryKey: 'recall_number',
    columns: { recall_number: 'TEXT', event_id: 'TEXT', ...COMMON_COLUMNS },
    indexes: [{ columns: ['event_id'] }, { columns: ['synced_at'] }],
    keys: {
      recall_number: { column: 'recall_number', pattern: RECALL_NUMBER },
      event_id: { column: 'event_id', pattern: CANONICAL_DIGITS },
    },
    project: projector('recall_number', ['event_id']),
  },
  'drug/drugsfda': {
    endpoint: 'drug/drugsfda',
    slug: 'drug-drugsfda',
    table: 'drug_drugsfda',
    primaryKey: 'application_number',
    columns: { application_number: 'TEXT', ...COMMON_COLUMNS },
    indexes: [{ columns: ['synced_at'] }],
    keys: {
      application_number: { column: 'application_number', pattern: APPLICATION_NUMBER },
    },
    project: projector('application_number', []),
  },
};

/** The dataset spec for an endpoint, or `undefined` when it is not mirrorable. */
export function datasetFor(endpoint: string): DatasetSpec | undefined {
  return DATASETS[endpoint as MirroredEndpoint];
}

/**
 * @fileoverview Oversized-record disclosure for the inline page a multi-row
 * search tool returns. `limit` is the page size (`resolvePageSize` in
 * `schema-utils.ts`), so a page holds every record its window addresses; this
 * module states the weight of a page whose records include one that serializes
 * above 24,000 bytes on its own — a `drug/event` report carrying 100 KB of
 * `patient.drug.openfda`, a `device/recall` record carrying megabytes of
 * `code_info` — naming the page's size, the largest record's biggest fields, and
 * the `fields` projection (`record-projection.ts`) that would shrink them. A page
 * whose records each serialize under that size carries nothing extra.
 *
 * Every size is UTF-8 bytes of the serialized JSON — what the payload occupies on
 * the wire. JavaScript string length counts UTF-16 code units, which understates
 * any non-ASCII text: one device recall's `code_info` carries over half a million
 * multi-byte characters.
 * @module services/openfda/page-budget
 */

import { Buffer } from 'node:buffer';
import { z } from '@cyanheads/mcp-ts-core';
import { DEFAULT_OUTLINE_BUDGET_BYTES } from '@cyanheads/mcp-ts-core/utils';
import {
  type ProjectionFields,
  projectionFields,
  projectRecords,
  type RecordProjection,
} from '@/services/openfda/record-projection.js';
import type { OpenFdaMeta, OpenFdaResponse } from '@/services/openfda/types.js';

/**
 * Serialized size above which a record is disclosed as oversized.
 *
 * Deliberately the figure `openfda_get_drug_label` overflows to a section outline
 * at: one server should have one meaning of "too large to inline", so a caller
 * can reason about the threshold once. A helper constant rather than an env var,
 * for the reason the framework's own budget is one — a deploy-tunable threshold
 * would drift a tool's response *shape* between environments.
 */
export const OVERSIZED_RECORD_BYTES = DEFAULT_OUTLINE_BUDGET_BYTES;

/** UTF-8 byte length of serialized JSON text — the size it occupies on the wire. */
function utf8Bytes(json: string): number {
  return Buffer.byteLength(json, 'utf8');
}

/**
 * Output fields disclosing a page that holds an oversized record. Both optional
 * and absent unless a record on the page serializes above
 * {@link OVERSIZED_RECORD_BYTES}, so any other page returns exactly the shape it
 * would without them. Spread into each search tool's output object.
 */
export const oversizedRecordOutputShape = {
  page_bytes: z
    .number()
    .optional()
    .describe(
      `Serialized size of results in this response, in UTF-8 bytes. Present only when a record on the page serializes above ${OVERSIZED_RECORD_BYTES} bytes on its own — page_largest_fields then names the largest record's biggest fields, and fields projects each record to the paths you need.`,
    ),
  page_largest_fields: z
    .array(
      z
        .object({
          path: z
            .string()
            .describe(
              'Dotted field path on the record. Fields of array elements share their array path, so patient.drug.openfda covers that block in every drug of the report.',
            ),
          bytes: z
            .number()
            .describe('Serialized UTF-8 bytes the field holds, totalled across array elements.'),
        })
        .describe('One field of the largest record and its serialized size.'),
    )
    .optional()
    .describe(
      `Present with page_bytes: the biggest fields of the largest record on the page, largest first — the deepest single field that holds that record's excess over ${OVERSIZED_RECORD_BYTES} bytes, or else up to three top-level fields. Leave them out with a fields projection to shrink the records.`,
    ),
};

/** The oversized-record disclosure fields a search tool's response carries. */
export interface OversizedRecordFields {
  page_bytes?: number | undefined;
  page_largest_fields?: FieldSize[] | undefined;
}

/**
 * Disclosure fields for a page — empty unless a record on it serializes above
 * {@link OVERSIZED_RECORD_BYTES}.
 *
 * Each record is serialized once, and the page total follows exactly: an array
 * serializes as its elements joined by `,` inside `[]`, one byte each, so
 * `page_bytes` is the figure a caller can verify against the payload. Only the
 * largest record is walked for its field breakdown, and the breakdown rides the
 * response: the handler's notice and the `content[]` line `format()` renders both
 * read it, so a record of megabytes is walked once rather than once per surface.
 */
export function oversizedRecordFields(
  records: readonly Record<string, unknown>[],
): OversizedRecordFields {
  let pageBytes = 2 + Math.max(0, records.length - 1);
  let largest: { bytes: number; record: Record<string, unknown> } | undefined;
  for (const record of records) {
    const bytes = utf8Bytes(JSON.stringify(record));
    pageBytes += bytes;
    if (!largest || bytes > largest.bytes) largest = { bytes, record };
  }
  if (!largest || largest.bytes <= OVERSIZED_RECORD_BYTES) return {};
  return {
    page_bytes: pageBytes,
    page_largest_fields: largestFields(largest.record, largest.bytes - OVERSIZED_RECORD_BYTES)
      .fields,
  };
}

/**
 * Shape an openFDA search response as the tool's return value: records projected
 * to the caller's `fields`, `meta.limit` set to the page size the call applied,
 * and the oversized-record disclosure measured on the projected records — what
 * the caller actually receives. A page without `fields` whose records each fit
 * carries exactly `{ meta, results }`.
 */
export function inlinePage(
  response: OpenFdaResponse,
  limit: number,
  projection?: RecordProjection | undefined,
): { meta: OpenFdaMeta; results: Record<string, unknown>[] } & OversizedRecordFields &
  ProjectionFields {
  const results = projectRecords(response.results, projection);
  return {
    meta: { ...response.meta, limit },
    results,
    ...oversizedRecordFields(results),
    ...projectionFields(projection),
  };
}

/** Largest record fields named on an oversized-record notice, at most. */
const LARGEST_FIELDS_SHOWN = 3;

/** Serialized bytes under one dotted path, array elements collapsed into one path. */
interface SizeNode {
  bytes: number;
  children: Map<string, SizeNode>;
}

/**
 * Serialized UTF-8 size of `value`, accumulating each nested key's bytes into
 * `node`. Array elements share their array's node, so `patient.drug.openfda`
 * totals that block across every drug in the report. Sums to exactly the UTF-8
 * size of `JSON.stringify(value)` for parsed JSON — the punctuation is ASCII, and
 * `JSON.stringify` escapes a lone surrogate, so every leaf's text is well-formed
 * on its own — in one pass, no re-serializing a subtree at each level.
 */
function measureInto(value: unknown, node: SizeNode): number {
  if (Array.isArray(value)) {
    let size = 2 + Math.max(0, value.length - 1);
    for (const item of value) size += measureInto(item, node);
    return size;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    let size = 2 + Math.max(0, entries.length - 1);
    for (const [key, child] of entries) {
      let childNode = node.children.get(key);
      if (!childNode) {
        childNode = { bytes: 0, children: new Map() };
        node.children.set(key, childNode);
      }
      const childSize = measureInto(child, childNode);
      childNode.bytes += childSize;
      size += utf8Bytes(JSON.stringify(key)) + 1 + childSize;
    }
    return size;
  }
  return utf8Bytes(JSON.stringify(value ?? null));
}

/** A record field and the serialized bytes its values hold. */
export interface FieldSize {
  bytes: number;
  path: string;
}

/**
 * The fields that make a record exceed the oversized size, by dotted path and
 * size, and whether leaving them out would bring it within that size — exactly
 * whether their sizes total at least `excess`, the bytes the record is over.
 *
 * When one top-level field holds the excess on its own, the path drills down to
 * the deepest field that still does — `patient.drug.openfda` in a drug report,
 * not `patient`, which a caller cannot leave out without losing the reactions
 * and drug names it came for. Otherwise the largest top-level fields are listed
 * until they cover the excess, at most {@link LARGEST_FIELDS_SHOWN}.
 */
export function largestFields(
  record: unknown,
  excess: number,
): { covered: boolean; fields: FieldSize[] } {
  const root: SizeNode = { bytes: 0, children: new Map() };
  measureInto(record, root);
  const bySize = (node: SizeNode) =>
    [...node.children].sort(([, a], [, b]) => b.bytes - a.bytes) as [string, SizeNode][];

  const [first] = bySize(root);
  if (first && first[1].bytes >= excess) {
    let [path, node] = first;
    for (let next = bySize(node)[0]; next && next[1].bytes >= excess; next = bySize(node)[0]) {
      path = `${path}.${next[0]}`;
      node = next[1];
    }
    return { covered: true, fields: [{ path, bytes: node.bytes }] };
  }

  const fields: FieldSize[] = [];
  let held = 0;
  for (const [path, node] of bySize(root)) {
    if (held >= excess || fields.length === LARGEST_FIELDS_SHOWN) break;
    fields.push({ path, bytes: node.bytes });
    held += node.bytes;
  }
  return { covered: held >= excess, fields };
}

/** The response shape {@link oversizedRecordNotice} and {@link oversizedRecordLine} read. */
type DisclosedResponse = OversizedRecordFields & { results: readonly unknown[] };

/**
 * Disclosure for a page holding an oversized record: the page's size, the
 * largest record's biggest fields, and the `fields` re-call that projects them
 * away. Returns undefined when no record on the page is oversized.
 *
 * A lone record's own size is the page's less its two brackets, so only then can
 * the notice say whether leaving the named fields out brings it within
 * {@link OVERSIZED_RECORD_BYTES}; on a page of several records it names them
 * without that claim.
 *
 * One sentence source for both surfaces — {@link oversizedRecordLine} renders it
 * into `content[]` and the handler puts it on `enrichment.notice`, so a
 * `structuredContent` reader and a `content[]` reader cannot be told different
 * things about the same page. It reads the size breakdown the response carries
 * and measures nothing itself, so rendering it twice costs no second walk.
 */
export function oversizedRecordNotice(result: DisclosedResponse): string | undefined {
  const bytes = result.page_bytes;
  if (bytes === undefined) return;
  const fields = result.page_largest_fields ?? [];
  const lone = result.results.length === 1;
  const plural = fields.length > 1;
  const named = fields.map((field) => `${field.path} (${field.bytes} bytes)`).join(', ');
  const covered =
    lone &&
    fields.reduce((total, field) => total + field.bytes, 0) >= bytes - 2 - OVERSIZED_RECORD_BYTES;

  const lead = lone
    ? `Oversized record: the one record on this page serializes to ${bytes - 2} bytes, over ${OVERSIZED_RECORD_BYTES} (page_bytes ${bytes}).`
    : `Oversized record: this page of ${result.results.length} records serializes to ${bytes} bytes, and at least one record on it exceeds ${OVERSIZED_RECORD_BYTES} bytes on its own.`;
  const subject = lone ? 'Its' : "The largest record's";
  const within = covered
    ? `; leaving ${plural ? 'them' : 'it'} out brings the record within ${OVERSIZED_RECORD_BYTES} bytes`
    : '';
  const largest =
    fields.length > 0
      ? ` ${subject} largest field${plural ? 's are' : ' is'} ${named}${within}.`
      : '';
  return `${lead}${largest} Re-call with fields set to the dotted paths you need (any key path on the record works; openfda_describe_fields lists the searchable ones) to project each record to those paths plus its identity key.`;
}

/**
 * The same disclosure as a `content[]` line, quoted to match the canvas staging
 * line it sits beside. Returns null when no record on the page is oversized.
 */
export function oversizedRecordLine(result: DisclosedResponse): string | null {
  const notice = oversizedRecordNotice(result);
  return notice ? `> ${notice}` : null;
}

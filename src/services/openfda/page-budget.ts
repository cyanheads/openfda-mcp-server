/**
 * @fileoverview Serialized-byte budget for the inline page a multi-row search
 * tool returns. openFDA record size spans three orders of magnitude across
 * endpoints, so `limit` alone does not bound a response: ten `drug/event`
 * reports are a six-figure byte count where ten `food/event` reports are under
 * 4 KB. This module measures the page in hand, drops records from the tail of
 * the caller's window until it fits, and reports the cut on both response
 * surfaces — never below one record, so record size can bound the page but
 * never empty it. A page whose one kept record still overruns the budget is
 * disclosed too, with that record's largest fields and the `fields` projection
 * (`record-projection.ts`) that would shrink it.
 *
 * Every size is UTF-8 bytes of the serialized JSON — what the payload occupies on
 * the wire. JavaScript string length counts UTF-16 code units, which understates
 * any non-ASCII text: one device recall's `code_info` carries over half a million
 * multi-byte characters.
 *
 * The staged drain in `canvas-spill.ts` derives a row cap from an *average*
 * because the rows it bounds have not been fetched yet. The inline page is
 * already in hand and is measured record by record instead: a `drug/event`
 * median record is ~6 KB against a ~34 KB mean, so an average would misprice
 * the page it is meant to bound.
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
 * Serialized-JSON budget for one inline page of records.
 *
 * Deliberately the same figure `openfda_get_drug_label` measures its overflow
 * against: one server should have one meaning of "too large to inline", so a
 * caller can reason about the threshold once. A helper constant rather than an
 * env var, for the reason the framework's own budget is one — a deploy-tunable
 * threshold would drift a tool's response *shape* between environments.
 */
export const PAGE_BUDGET_BYTES = DEFAULT_OUTLINE_BUDGET_BYTES;

/**
 * Shared `limit` description clause — states the budget {@link boundPageToBudget}
 * enforces, so every search tool advertises it in the same words. Append to the
 * tool's own `limit` prose.
 */
export const PAGE_BUDGET_NOTE = `Serialized record size varies by three orders of magnitude across openFDA endpoints, so the page is also bounded by a ${PAGE_BUDGET_BYTES}-byte serialized budget: a page that would overrun it returns fewer records than requested and reports the cut on page_omitted. Whenever any record matched, at least one comes back, however large it measures — page_bytes then reports its size and page_largest_fields names its largest fields, which fields can project away.`;

/**
 * Shared `meta.limit` description. The field is the page size applied to the
 * request, not a count of what came back: it follows the record count when the
 * byte budget bounded the page, and otherwise echoes the requested `limit` —
 * which a window running past the end of the matched set overshoots.
 */
export const META_LIMIT_DESCRIPTION = `Page size applied to this request — the requested limit, lowered to the records returned when the ${PAGE_BUDGET_BYTES}-byte inline budget bounded the page (see page_omitted). Not a count of what arrived: a window running past the end of the matched set returns fewer records than this, so read the length of results for the actual count.`;

/** UTF-8 byte length of serialized JSON text — the size it occupies on the wire. */
function utf8Bytes(json: string): number {
  return Buffer.byteLength(json, 'utf8');
}

/** A page of records measured against {@link PAGE_BUDGET_BYTES}. */
export interface BoundedPage {
  /** UTF-8 bytes of `JSON.stringify(records)` — exceeds the budget only in the one-record case. */
  bytes: number;
  /** Records dropped from the tail of the caller's window to fit the budget. */
  omitted: number;
  /** The records that fit. Empty only when the input page was empty. */
  records: Record<string, unknown>[];
}

/**
 * Bound a page to a serialized-byte budget, dropping records from the tail.
 *
 * **The page is never emptied by record size.** When the first record alone
 * clears the budget it is returned whole and `bytes` reports the overrun — the
 * invariant #31 established (a 68 KB `drug/event` report must not render as "No
 * results found." for a query matching hundreds of thousands of records) is
 * about emptiness, not about the count, and #18 asked for `min(limit,
 * budget-fit)` rows explicitly. Truncating *within* a record is never an option:
 * `structuredContent` and `content[]` derive from the same array, so a partial
 * record would either desync the two surfaces or hand back a record whose
 * absent fields are indistinguishable from openFDA's own sparsity.
 *
 * Sizes are accumulated per record and the total computed exactly, because
 * `JSON.stringify` of an array is its elements joined by `,` inside `[]`, one
 * byte each — one pass, and `bytes` is the figure a caller can verify against the
 * payload.
 */
export function boundPageToBudget(
  records: Record<string, unknown>[],
  budget = PAGE_BUDGET_BYTES,
): BoundedPage {
  if (records.length === 0) return { bytes: 2, omitted: 0, records };

  let bytes = 2; // The enclosing `[]`.
  let kept = 0;
  for (const record of records) {
    // The record's own serialization plus the `,` separating it from the last.
    const cost = utf8Bytes(JSON.stringify(record)) + (kept > 0 ? 1 : 0);
    if (kept > 0 && bytes + cost > budget) break;
    bytes += cost;
    kept += 1;
  }

  return kept === records.length
    ? { bytes, omitted: 0, records }
    : { bytes, omitted: records.length - kept, records: records.slice(0, kept) };
}

/**
 * Output fields disclosing an inline page that met the byte budget. All optional
 * and absent on a page that fits, so such a page returns exactly the shape it
 * returned before the budget existed. `page_bytes` is present whenever the page
 * was bounded or overruns the budget; `page_omitted` only when records were
 * dropped; `page_largest_fields` only when the one record kept overruns the
 * budget on its own. Spread into each search tool's output object.
 */
export const pageBudgetOutputShape = {
  page_bytes: z
    .number()
    .optional()
    .describe(
      `Serialized size of results in this response, in UTF-8 bytes. Present when the ${PAGE_BUDGET_BYTES}-byte inline budget bounded the page or when the page exceeds it; larger than the budget only when a single record exceeds it on its own, which is returned whole — page_largest_fields then names its largest fields, and fields projects the record to the paths you need.`,
    ),
  page_omitted: z
    .number()
    .optional()
    .describe(
      'Records dropped from the requested limit/skip window so the page fit the inline byte budget. Present only when records were dropped. Read them by re-calling with skip advanced by the number of records returned, lower limit for a smaller page (when more than one record came back), pass fields to keep only the paths you need, or pass stage=true to query a bounded drain of the match with openfda_dataframe_query.',
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
        .describe('One field of the oversized record and its serialized size.'),
    )
    .optional()
    .describe(
      `Present only when page_bytes exceeds the ${PAGE_BUDGET_BYTES}-byte budget, which happens only when the one record on the page exceeds it on its own: that record's largest fields, largest first — the deepest single field that holds the overrun, or else up to three top-level fields. Leave them out with a fields projection to shrink the record.`,
    ),
};

/** The page-budget disclosure fields a search tool's response carries. */
export interface PageBudgetFields {
  page_bytes?: number | undefined;
  page_largest_fields?: FieldSize[] | undefined;
  page_omitted?: number | undefined;
}

/**
 * Disclosure fields for a measured page — empty when it fit. A lone record over
 * the budget drops nothing, so it carries `page_bytes` without `page_omitted`.
 *
 * The oversized record's size breakdown is measured here, once per call, and
 * carried on the response: the handler's notice and the `content[]` line
 * `format()` renders both read it, so a record of megabytes is walked one time
 * rather than once per surface.
 */
export function pageBudgetFields(page: BoundedPage): PageBudgetFields {
  if (page.bytes > PAGE_BUDGET_BYTES) {
    return {
      page_bytes: page.bytes,
      ...(page.omitted > 0 && { page_omitted: page.omitted }),
      page_largest_fields: largestFields(page.records[0], page.bytes - PAGE_BUDGET_BYTES).fields,
    };
  }
  return page.omitted > 0 ? { page_bytes: page.bytes, page_omitted: page.omitted } : {};
}

/**
 * `meta.limit` for a measured page: the requested limit, lowered to the records
 * kept when the budget dropped any — a response cannot claim a page size it did
 * not send. A window running short of the limit, or empty, keeps the requested
 * figure. The plain and staged paths both report through this, so the same
 * request reports the same page size in either mode.
 */
export function appliedLimit(page: BoundedPage, requested: number): number {
  return page.omitted > 0 ? page.records.length : requested;
}

/**
 * Project an openFDA search response to the caller's `fields`, bound it to the
 * inline byte budget, and shape it as the tool's return value. Projection runs
 * first, so the budget measures the records the caller actually receives.
 * `meta.limit` is {@link appliedLimit} over openFDA's echo of the requested limit,
 * so a page that fit the budget without `fields` serializes exactly as it did
 * before this budget existed.
 */
export function boundedPage(
  response: OpenFdaResponse,
  projection?: RecordProjection | undefined,
): { meta: OpenFdaMeta; results: Record<string, unknown>[] } & PageBudgetFields & ProjectionFields {
  const page = boundPageToBudget(projectRecords(response.results, projection));
  return {
    meta: { ...response.meta, limit: appliedLimit(page, response.meta.limit) },
    results: page.records,
    ...pageBudgetFields(page),
    ...projectionFields(projection),
  };
}

/** Largest record fields named on an over-budget notice, at most. */
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
 * The fields that make a record overrun the budget, by dotted path and size, and
 * whether leaving them out would bring it within budget — exactly whether their
 * sizes total at least `excess`, the bytes the page is over.
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

/** The response shape {@link pageBudgetNotice} and {@link pageBudgetLine} read. */
type BoundedResponse = PageBudgetFields &
  ProjectionFields & {
    meta: { skip: number };
    results: unknown[];
    /** Present only on the staged arm, which already holds a canvas table. */
    spilled?: boolean | undefined;
  };

/**
 * The sentence naming an oversized record's largest fields — as the response
 * carries them on `page_largest_fields` — and the `fields` re-call that projects
 * them away. `excess` is the bytes the page is over.
 */
function oversizedFieldsSentence(fields: readonly FieldSize[], excess: number): string {
  const covered = fields.reduce((total, field) => total + field.bytes, 0) >= excess;
  const named = fields.map((field) => `${field.path} (${field.bytes} bytes)`).join(', ');
  const plural = fields.length > 1;
  const within = covered
    ? `; leaving ${plural ? 'them' : 'it'} out brings the record within the budget`
    : '';
  const largest =
    fields.length > 0 ? `Its largest field${plural ? 's are' : ' is'} ${named}${within}. ` : '';
  return `${largest}Re-call with fields set to the dotted paths you need (any key path on the record works; openfda_describe_fields lists the searchable ones) to project each record to those paths plus its identity key.`;
}

/**
 * Disclosure for a page that met the byte budget: what it holds, what it cost,
 * and every route to what it withheld or could not shrink. Returns undefined when
 * the page fit.
 *
 * Two cases fire it. Records dropped from the window name the routes to them.
 * A kept record larger than the budget on its own — the only way a page can
 * still overrun it — names that record's largest fields and the `fields`
 * re-call, whether or not anything was dropped beside it. Every route named
 * works from this call: lowering `limit` is offered only when the page holds
 * more than one record, since `limit: 1` returns the same one-record page.
 *
 * One sentence source for both surfaces — {@link pageBudgetLine} renders it into
 * `content[]` and the handler puts it on `enrichment.notice`, so a
 * `structuredContent` reader and a `content[]` reader cannot be told different
 * things about the same page. It reads the size breakdown the response carries
 * and measures nothing itself, so rendering it twice costs no second walk.
 */
export function pageBudgetNotice(result: BoundedResponse): string | undefined {
  const bytes = result.page_bytes;
  if (bytes === undefined) return;
  const omitted = result.page_omitted ?? 0;
  const kept = result.results.length;
  const oversized = bytes > PAGE_BUDGET_BYTES;
  const whole =
    ' — one record exceeds the budget on its own, so it is returned whole rather than leaving the page empty';
  const fieldsSentence = oversized
    ? ` ${oversizedFieldsSentence(result.page_largest_fields ?? [], bytes - PAGE_BUDGET_BYTES)}`
    : '';

  if (omitted === 0) {
    return `Inline page exceeds the ${PAGE_BUDGET_BYTES}-byte budget at ${bytes} bytes${whole}.${fieldsSentence}`;
  }

  const next = result.meta.skip + kept;
  /*
   * The staged arm already has a table, so offering it `stage=true` is advice it
   * cannot act on. Neither arm claims SQL over the whole match: the drain stops
   * at its own byte budget and openFDA's row ceiling, which the staging notice
   * beside this one reports as `truncated`.
   */
  const sql =
    result.spilled === undefined
      ? 'pass stage=true to query a bounded drain of the match with openfda_dataframe_query'
      : 'query the table this call staged with openfda_dataframe_query';
  const limitRoute = kept > 1 ? 'lower limit for a smaller page, ' : '';
  const fieldsRoute = oversized
    ? ''
    : result.projected_fields
      ? 'narrow fields to fewer paths, '
      : 'pass fields to keep only the paths you need, ';
  return `Inline page bounded to ${kept} of the ${kept + omitted} records requested: ${bytes} bytes against a ${PAGE_BUDGET_BYTES}-byte budget${oversized ? whole : ''}.${fieldsSentence} The other ${omitted} begin at skip=${next} — re-call with that skip, ${limitRoute}${fieldsRoute}${sql}, or use openfda_count_values for a distribution over every matched record.`;
}

/**
 * The same disclosure as a `content[]` line, quoted to match the canvas staging
 * line it sits beside. Returns null when the page fit.
 */
export function pageBudgetLine(result: BoundedResponse): string | null {
  const notice = pageBudgetNotice(result);
  return notice ? `> ${notice}` : null;
}

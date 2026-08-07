/**
 * @fileoverview Serialized-byte budget for the inline page a multi-row search
 * tool returns. openFDA record size spans three orders of magnitude across
 * endpoints, so `limit` alone does not bound a response: ten `drug/event`
 * reports are a six-figure byte count where ten `food/event` reports are under
 * 4 KB. This module measures the page in hand, drops records from the tail of
 * the caller's window until it fits, and reports the cut on both response
 * surfaces — never below one record, so record size can bound the page but
 * never empty it.
 *
 * The staged drain in `canvas-spill.ts` derives a row cap from an *average*
 * because the rows it bounds have not been fetched yet. The inline page is
 * already in hand and is measured record by record instead: a `drug/event`
 * median record is ~6 KB against a ~34 KB mean, so an average would misprice
 * the page it is meant to bound.
 * @module services/openfda/page-budget
 */

import { z } from '@cyanheads/mcp-ts-core';
import { DEFAULT_OUTLINE_BUDGET_BYTES } from '@cyanheads/mcp-ts-core/utils';
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
export const PAGE_BUDGET_NOTE = `Serialized record size varies by three orders of magnitude across openFDA endpoints, so the page is also bounded by a ${PAGE_BUDGET_BYTES}-byte serialized budget: a page that would overrun it returns fewer records than requested and reports the cut on page_omitted. Whenever any record matched, at least one comes back, however large it measures.`;

/**
 * Shared `meta.limit` description. The field is the page size applied to the
 * request, not a count of what came back: it follows the record count when the
 * byte budget bounded the page, and otherwise echoes the requested `limit` —
 * which a window running past the end of the matched set overshoots.
 */
export const META_LIMIT_DESCRIPTION = `Page size applied to this request — the requested limit, lowered to the records returned when the ${PAGE_BUDGET_BYTES}-byte inline budget bounded the page (see page_omitted). Not a count of what arrived: a window running past the end of the matched set returns fewer records than this, so read the length of results for the actual count.`;

/** A page of records measured against {@link PAGE_BUDGET_BYTES}. */
export interface BoundedPage {
  /** `JSON.stringify(records).length` — exceeds the budget only in the one-record case. */
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
 * `JSON.stringify` of an array is its elements joined by `,` inside `[]` — one
 * pass, and `bytes` is the figure a caller can verify against the payload.
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
    const cost = JSON.stringify(record).length + (kept > 0 ? 1 : 0);
    if (kept > 0 && bytes + cost > budget) break;
    bytes += cost;
    kept += 1;
  }

  return kept === records.length
    ? { bytes, omitted: 0, records }
    : { bytes, omitted: records.length - kept, records: records.slice(0, kept) };
}

/**
 * Output fields disclosing an inline page bounded by the byte budget. Both
 * optional and both absent unless the bound fired, so a page that fits returns
 * exactly the shape it returned before the budget existed. Spread into each
 * search tool's output object.
 */
export const pageBudgetOutputShape = {
  page_bytes: z
    .number()
    .optional()
    .describe(
      `Serialized size of results in this response, in bytes. Present only when the ${PAGE_BUDGET_BYTES}-byte inline budget bounded the page; larger than the budget only when a single record exceeds it on its own.`,
    ),
  page_omitted: z
    .number()
    .optional()
    .describe(
      'Records dropped from the requested limit/skip window so the page fit the inline byte budget. Present only when the page was bounded. Read them by re-calling with skip advanced by the number of records returned, lower limit for a smaller page, or pass stage=true to query a bounded drain of the match with openfda_dataframe_query.',
    ),
};

/** The page-budget disclosure fields a search tool's response carries. */
export interface PageBudgetFields {
  page_bytes?: number | undefined;
  page_omitted?: number | undefined;
}

/** Disclosure fields for a bounded page — empty when nothing was dropped. */
export function pageBudgetFields(page: BoundedPage): PageBudgetFields {
  return page.omitted > 0 ? { page_bytes: page.bytes, page_omitted: page.omitted } : {};
}

/**
 * Bound an openFDA search response to the inline byte budget and shape it as the
 * tool's return value. `meta.limit` follows the records actually returned when
 * the bound fires — a response cannot claim a page size it did not send. It is
 * otherwise openFDA's echo of the requested limit, untouched, so a page that fit
 * the budget serializes exactly as it did before this budget existed.
 */
export function boundedPage(
  response: OpenFdaResponse,
): { meta: OpenFdaMeta; results: Record<string, unknown>[] } & PageBudgetFields {
  const page = boundPageToBudget(response.results);
  return {
    meta: page.omitted > 0 ? { ...response.meta, limit: page.records.length } : response.meta,
    results: page.records,
    ...pageBudgetFields(page),
  };
}

/** The response shape {@link pageBudgetNotice} and {@link pageBudgetLine} read. */
type BoundedResponse = PageBudgetFields & {
  meta: { skip: number };
  results: unknown[];
  /** Present only on the staged arm, which already holds a canvas table. */
  spilled?: boolean | undefined;
};

/**
 * Disclosure for a bounded page: what it holds, what it cost, and every route to
 * the records it withheld. Returns undefined when the page was not bounded.
 *
 * One sentence source for both surfaces — {@link pageBudgetLine} renders it into
 * `content[]` and the handler puts it on `enrichment.notice`, so a
 * `structuredContent` reader and a `content[]` reader cannot be told different
 * things about the same cut.
 */
export function pageBudgetNotice(result: BoundedResponse): string | undefined {
  const omitted = result.page_omitted;
  if (omitted === undefined || omitted <= 0) return;
  const kept = result.results.length;
  const bytes = result.page_bytes ?? 0;
  const next = result.meta.skip + kept;
  const oversized =
    bytes > PAGE_BUDGET_BYTES
      ? ' — one record exceeds the budget on its own, so it is returned whole rather than leaving the page empty'
      : '';
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
  return `Inline page bounded to ${kept} of the ${kept + omitted} records requested: ${bytes} bytes against a ${PAGE_BUDGET_BYTES}-byte budget${oversized}. The other ${omitted} begin at skip=${next} — re-call with that skip, lower limit for a smaller page, ${sql}, or use openfda_count_values for a distribution over every matched record.`;
}

/**
 * The same disclosure as a `content[]` line, quoted to match the canvas staging
 * line it sits beside. Returns null when the page was not bounded.
 */
export function pageBudgetLine(result: BoundedResponse): string | null {
  const notice = pageBudgetNotice(result);
  return notice ? `> ${notice}` : null;
}

/**
 * @fileoverview The enrichment a multi-row search tool sets on the page it
 * returns, staged or inline: the matched total, the query echo, and one notice
 * joining what applies to the page, in order — the empty result, the phrase-plus
 * hint, the limit clamp or else the end of a cursor walk, a walk openFDA cannot
 * continue, the `fields` projection, the paths left out by default, the
 * oversized record, the staging pointer, and the AND-ed clauses one array entry
 * may not meet together. A notice that does not apply to the page or its
 * endpoint returns nothing, so every tool shares the one list.
 * @module mcp-server/tools/search-enrichment
 */

import type { Enrich } from '@cyanheads/mcp-ts-core';
import { OBJECT_ARRAY_PATHS, SINGLE_ENTRY_ARRAYS } from '@/mcp-server/tools/field-catalog.js';
import { emptyResultMessage } from '@/mcp-server/tools/format-utils.js';
import {
  type CursorQuery,
  cursorBlockedNotice,
  cursorEndNotice,
} from '@/mcp-server/tools/pagination-cursor.js';
import { type PageSize, pageSizeNotice } from '@/mcp-server/tools/schema-utils.js';
import { type ArrayTieRoute, arrayTieNotice } from '@/mcp-server/tools/search-clauses.js';
import { phrasePlusHint } from '@/mcp-server/tools/search-expression.js';
import { type OpenFdaSpillResult, stagingNotice } from '@/services/openfda/canvas-spill.js';
import {
  type OversizedRecordFields,
  oversizedRecordNotice,
} from '@/services/openfda/page-budget.js';
import {
  type OmissionFields,
  omissionNotice,
  type ProjectionFields,
  projectionNotice,
} from '@/services/openfda/record-projection.js';
import type { OpenFdaQueryParams, OpenFdaResponse } from '@/services/openfda/types.js';

/** The page a search tool returns — `inlinePage(...)` with its `next_cursor`, or `canvasResult(spill)`. */
type SearchPage = OversizedRecordFields &
  ProjectionFields &
  OmissionFields & {
    meta: { skip: number; total: number; totalUnverified?: boolean | undefined };
    next_cursor?: string | undefined;
    results: readonly unknown[];
  };

/**
 * Where the page came from: an inline page carries the openFDA response it was
 * cut from (read for a walk that cannot continue) and the call's resolved
 * cursor; a staged page carries its spill, and never a cursor, which a staged
 * call refuses.
 */
type PageSource =
  | {
      response: Pick<OpenFdaResponse, 'meta' | 'results' | 'searchAfterBlocked'>;
      searchAfter: OpenFdaQueryParams['searchAfter'];
      spill?: never;
    }
  | { spill: OpenFdaSpillResult; response?: never; searchAfter?: never };

/** What {@link enrichSearchPage} reads: the call's query and page size, the page, and its source. */
type SearchPageEnrichment = PageSource & {
  /** The tool's no-match hint, wrapped by `emptyResultMessage` when the page is empty. */
  noMatch: () => string;
  page: SearchPage;
  /** The query the call sent: `query.search` is echoed, `query.endpoint` picks the array table. */
  query: CursorQuery;
  size: PageSize;
};

/**
 * Set a search page's enrichment: `totalResults` from the page's total, the
 * `search` echoed when the call sent one, and the notice, when any applies.
 * Call once per path, after the page is built.
 */
export function enrichSearchPage(
  ctx: { enrich: Enrich<{ totalResults: number }> },
  { noMatch, page, query, response, searchAfter, size, spill }: SearchPageEnrichment,
): void {
  const { skip, total, totalUnverified } = page.meta;
  ctx.enrich({ totalResults: total });
  if (query.search) ctx.enrich.echo(query.search);

  // An endpoint the array table has not surveyed raises no tie notice.
  const arrays = OBJECT_ARRAY_PATHS[query.endpoint];
  const tieRoute: ArrayTieRoute = spill
    ? spill.tableName
      ? { kind: 'staged', table: spill.tableName }
      : { kind: 'restage' }
    : { kind: 'restage', byCursor: searchAfter !== undefined };
  const notices = [
    page.results.length === 0
      ? emptyResultMessage(skip, total, noMatch(), totalUnverified, searchAfter !== undefined)
      : undefined,
    phrasePlusHint(query.search, total),
    pageSizeNotice(size, { ...page, searchAfterBlocked: response?.searchAfterBlocked }) ??
      cursorEndNotice(page, searchAfter),
    response && cursorBlockedNotice(response, query),
    projectionNotice(page),
    omissionNotice(page),
    oversizedRecordNotice(page),
    spill && stagingNotice(spill),
    arrays &&
      arrayTieNotice(query.search, total, arrays, tieRoute, SINGLE_ENTRY_ARRAYS[query.endpoint]),
  ].filter(Boolean);
  if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
}

/**
 * @fileoverview Types for the openFDA service layer.
 * @module services/openfda/types
 */

/** Pagination and freshness metadata from an openFDA response. */
export interface OpenFdaMeta {
  lastUpdated: string;
  limit: number;
  /**
   * Set on an empty count tally for a countable expression whose search matched
   * only records that carry no value for the field (openFDA's `Nothing to
   * count`), as opposed to a search that matched nothing.
   */
  nothingToCount?: true;
  skip: number;
  total: number;
  /**
   * Set on an empty page at `skip > 0` whose total could not be recovered:
   * openFDA answers a page past the end and a search that matched nothing with
   * the same 404, so `total: 0` there does not rule out records at a lower skip.
   */
  totalUnverified?: true;
}

/** Normalized openFDA API response. */
export interface OpenFdaResponse<T = Record<string, unknown>> {
  meta: OpenFdaMeta;
  /**
   * The `search_after` parameter of the response's `rel="next"` link, present
   * only when openFDA linked a next page that carries one. Pass it back as
   * {@link OpenFdaQueryParams.searchAfter} to read that page.
   */
  nextSearchAfter?: string;
  results: T[];
  /**
   * Set in place of {@link nextSearchAfter} when openFDA linked a next page the
   * walk cannot follow, naming why: `missing_sort_value` when its `search_after`
   * carries a sort key's missing-value marker (a sorted walk reached the records
   * lacking that field, which sort last, and this page's records are new), or
   * `repeated_link` when it repeats the value this page was read with (this page
   * is the one that value was read from, so its `meta.skip` is where those
   * already-returned records start). The records past this page are reachable
   * by `skip`, within its 25,000-row ceiling.
   */
  searchAfterBlocked?: 'missing_sort_value' | 'repeated_link';
}

/** Query parameters shared by all openFDA endpoints. */
export interface OpenFdaQueryParams {
  count?: string | undefined;
  limit?: number | undefined;
  search?: string | undefined;
  /**
   * Continue a `search_after` walk instead of paging by `skip`: `value` is
   * openFDA's `search_after` parameter from the previous page's link, and
   * `position` is the number of records the walk has already returned, which
   * the page reports as `meta.skip` (a `repeated_link` page excepted, see
   * {@link OpenFdaResponse.searchAfterBlocked}).
   */
  searchAfter?: { position: number; value: string } | undefined;
  skip?: number | undefined;
  sort?: string | undefined;
}

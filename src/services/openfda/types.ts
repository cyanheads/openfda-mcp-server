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
  results: T[];
}

/** Term-count pair returned by openFDA count queries. */
export interface OpenFdaCountResult {
  count: number;
  term: string;
}

/** Query parameters shared by all openFDA endpoints. */
export interface OpenFdaQueryParams {
  count?: string | undefined;
  limit?: number | undefined;
  search?: string | undefined;
  skip?: number | undefined;
  sort?: string | undefined;
}

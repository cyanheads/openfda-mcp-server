/**
 * @fileoverview Types for the openFDA service layer.
 * @module services/openfda/types
 */

/** Pagination and freshness metadata from an openFDA response. */
export interface OpenFdaMeta {
  lastUpdated: string;
  limit: number;
  skip: number;
  total: number;
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

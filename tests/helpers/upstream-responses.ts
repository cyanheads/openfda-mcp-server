/**
 * @fileoverview openFDA error responses the fetch-mocked tests answer with:
 * the 404 for a search with no hits, the 404 for a count with nothing to tally,
 * and the HTML 503 from an unavailable upstream.
 * @module tests/helpers/upstream-responses
 */

/** openFDA's 404 for a search that matches no records. */
export const NO_MATCHES = () =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }, { status: 404 });

/** openFDA's 404 for a count that has no records to tally. */
export const NOTHING_TO_COUNT = () =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'Nothing to count' } }, { status: 404 });

/** The HTML 503 body the openFDA edge returns when the API is down. */
export const UNAVAILABLE = () =>
  new Response('<html><body>503 Service Temporarily Unavailable</body></html>', { status: 503 });

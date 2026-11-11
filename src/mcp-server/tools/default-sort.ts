/**
 * @fileoverview Newest-first default sort for a search tool browsed with neither
 * `search` nor `sort`. openFDA answers an unsorted request in index order, so a
 * bare browse would otherwise lead with records from decades ago.
 * @module mcp-server/tools/default-sort
 */

/**
 * The sort a search tool sends upstream: the caller's `sort` as given, `newest`
 * when the call names neither `search` nor `sort`, and no sort when it names a
 * `search` alone (relevance order, and the mirror's exact-key routing, stay as
 * they are). Pass the result to both the inline query and the staged path.
 */
export function sortOrNewest(
  input: { readonly search?: string | undefined; readonly sort?: string | undefined },
  newest: string,
): string | undefined {
  if (input.sort !== undefined) return input.sort;
  return input.search === undefined ? newest : undefined;
}

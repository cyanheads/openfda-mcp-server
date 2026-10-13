/**
 * @fileoverview Server-side field projection for the inline page a multi-row
 * search tool returns. openFDA has no field selection of its own — an unknown
 * query parameter answers HTTP 400 — and a single record can outweigh the inline
 * byte budget a hundred times over (a `device/recall` record carries megabytes of
 * serial numbers in `code_info`), so lowering `limit` cannot shrink it. A caller
 * that names the dotted paths it needs gets each record cut to those paths plus
 * its identity key, before `page-budget.ts` measures the page.
 *
 * A record is never projected unless the caller asked: without `fields` it comes
 * back whole, exactly as openFDA sent it.
 * @module services/openfda/record-projection
 */

import { z } from '@cyanheads/mcp-ts-core';

/** What one call projects its records to. */
export interface RecordProjection {
  /** Top-level keys that tell records apart, kept on every projected record. */
  identityKeys: readonly string[];
  /** The caller's dotted paths, deduplicated, in the order given. */
  paths: string[];
}

/**
 * The projection a call's `fields` input asks for, or undefined when it asks for
 * none — an empty list included, since form-based clients send `[]` for an
 * unset array.
 */
export function recordProjection(
  fields: readonly string[] | undefined,
  identityKeys: readonly string[],
): RecordProjection | undefined {
  if (!fields?.length) return;
  return { identityKeys, paths: [...new Set(fields)] };
}

/** Path segments compiled into a tree; `true` keeps the whole value at that key. */
type PathTree = Map<string, PathTree | true>;

/**
 * Compile the projection into one tree, identity keys first so a projected record
 * leads with them. A path that ends where another continues keeps the whole
 * value: `patient` with `patient.drug` keeps all of `patient`.
 */
function buildTree(projection: RecordProjection): PathTree {
  const root: PathTree = new Map();
  for (const path of [...projection.identityKeys, ...projection.paths]) {
    const segments = path.split('.');
    let node = root;
    for (const [i, segment] of segments.entries()) {
      const existing = node.get(segment);
      if (existing === true) break;
      if (i === segments.length - 1) {
        node.set(segment, true);
        break;
      }
      const next: PathTree = existing ?? new Map();
      node.set(segment, next);
      node = next;
    }
  }
  return root;
}

/**
 * Cut a value down to the paths in `tree`, or undefined when none of them is
 * present. An array applies the tree to every element and keeps its length, so a
 * report's drug count survives projection: an element carrying none of the paths
 * stays as an empty container of its own kind (`{}`, or `[]` for a nested array)
 * rather than vanishing. An array no element of which carries a path is absent,
 * like any other missing key.
 */
function projectValue(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => projectValue(item, tree));
    if (!items.some((item) => item !== undefined)) return;
    return items.map((item, i) => item ?? (Array.isArray(value[i]) ? [] : {}));
  }
  if (value === null || typeof value !== 'object') return;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, subtree] of tree) {
    if (!Object.hasOwn(source, key)) continue;
    const kept = subtree === true ? source[key] : projectValue(source[key], subtree);
    if (kept !== undefined) projected[key] = kept;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Project each record to the requested paths plus its identity keys, or return
 * the records untouched when there is no projection. One record in always gives
 * one record out — a record carrying none of the paths comes back as `{}` — so
 * projection can never shrink the page a caller's `limit` addressed.
 */
export function projectRecords(
  records: Record<string, unknown>[],
  projection: RecordProjection | undefined,
): Record<string, unknown>[] {
  if (!projection) return records;
  const tree = buildTree(projection);
  return records.map((record) => (projectValue(record, tree) ?? {}) as Record<string, unknown>);
}

/** True when `value` holds something at `segments[i..]`, through any array. */
function carries(value: unknown, segments: string[], i: number): boolean {
  if (i === segments.length) return value !== undefined;
  if (Array.isArray(value)) return value.some((item) => carries(item, segments, i));
  if (value === null || typeof value !== 'object') return false;
  const key = segments[i] as string;
  return (
    Object.hasOwn(value, key) && carries((value as Record<string, unknown>)[key], segments, i + 1)
  );
}

/** The requested paths no record in `records` carries, in the order requested. */
export function pathsNotCarried(records: readonly unknown[], paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const segments = path.split('.');
    return !records.some((record) => carries(record, segments, 0));
  });
}

/**
 * Output field disclosing a projected page. Absent unless the call passed
 * `fields`, so a call without it returns the shape it always has. Spread into
 * each search tool's output object.
 */
export const projectionOutputShape = {
  projected_fields: z
    .array(z.string())
    .optional()
    .describe(
      'The field paths each record in results was projected to, as requested — present only when the call passed fields. Every record also keeps its identity key; any other field is absent because the projection left it out, not because openFDA lacks it. Re-call without fields for whole records.',
    ),
};

/** The projection disclosure field a search tool's response carries. */
export interface ProjectionFields {
  projected_fields?: string[] | undefined;
}

/** Disclosure field for a projected page — empty when the call did not project. */
export function projectionFields(projection: RecordProjection | undefined): ProjectionFields {
  return projection ? { projected_fields: projection.paths } : {};
}

/**
 * Disclosure for a projected page: which paths the records were cut to, and any
 * requested path no record on the page carries. Returns undefined when the call
 * did not project.
 *
 * An absent path is reported rather than rejected: openFDA records are sparse, so
 * a path missing from one page is not proof it is misspelled. One sentence source
 * for both surfaces, like the page-budget notice — {@link projectionLine} renders
 * it into `content[]` and the handler puts it on `enrichment.notice`.
 */
export function projectionNotice(
  result: ProjectionFields & { results: readonly unknown[] },
): string | undefined {
  const paths = result.projected_fields;
  if (!paths) return;
  const projected = `Records projected to the requested fields (${paths.join(', ')}) plus each record's identity key; every other field is left out on request.`;
  const absent = result.results.length > 0 ? pathsNotCarried(result.results, paths) : [];
  if (absent.length === 0) return projected;
  return `${projected} No record in this page carries ${absent.join(', ')} — check it against the keys records carry (openfda_describe_fields lists the searchable ones); records are sparse, so a path can be absent from one page and present on another.`;
}

/**
 * The same disclosure as a `content[]` line, quoted to match the page-budget and
 * canvas staging lines beside it. Returns null when the call did not project.
 */
export function projectionLine(
  result: ProjectionFields & { results: readonly unknown[] },
): string | null {
  const notice = projectionNotice(result);
  return notice ? `> ${notice}` : null;
}

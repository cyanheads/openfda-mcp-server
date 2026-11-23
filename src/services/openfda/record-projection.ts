/**
 * @fileoverview How a multi-row search tool cuts the records of its inline page.
 * openFDA has no field selection of its own — an unknown query parameter answers
 * HTTP 400 — and one block or list can fill a record (a `drug/event` report
 * carrying 280 KB of `patient.drug.openfda`, a device lot list cut at 32,600
 * characters), so lowering `limit` cannot shrink it. A call gets one of two cuts,
 * never both:
 *
 * - **`fields`** — a caller that names the dotted paths it needs gets each record
 *   cut to those paths plus its identity key.
 * - **Left out by default** — without `fields`, the endpoints in
 *   {@link LEFT_OUT_BY_DEFAULT} leave those paths out of each record and name
 *   them in `omitted_fields`; `include`, or a `search` clause on the path, brings
 *   one back. Every other endpoint's records come back whole, exactly as openFDA
 *   sent them.
 *
 * `page-budget.ts` measures the cut records for its oversized-record disclosure.
 * A staged call cuts only its inline page: the canvas drain stages whole records.
 * @module services/openfda/record-projection
 */

import { Buffer } from 'node:buffer';
import { z } from '@cyanheads/mcp-ts-core';
import { markdown } from '@cyanheads/mcp-ts-core/utils';

/** A `fields` projection: the paths one call cuts its records to. */
interface FieldsProjection {
  /** Top-level keys that tell records apart, kept on every projected record. */
  identityKeys: readonly string[];
  kind: 'fields';
  /** The caller's dotted paths, deduplicated, in the order given. */
  paths: string[];
}

/**
 * The endpoint's left-out paths one call keeps out of each record, in table
 * order, each with the paths beneath it the call brings back — relative to it
 * (`brand_name` under `patient.drug.openfda`), none when it is left out whole.
 */
interface DefaultOmission {
  kind: 'omission';
  leftOut: { keep: string[]; path: string }[];
}

/** How one call cuts the records of its inline page; undefined returns them whole. */
export type RecordProjection = DefaultOmission | FieldsProjection;

/**
 * The projection a call's `fields` input asks for, or undefined when it asks for
 * none — an empty list included, since form-based clients send `[]` for an
 * unset array.
 */
export function recordProjection(
  fields: readonly string[] | undefined,
  identityKeys: readonly string[],
): FieldsProjection | undefined {
  if (!fields?.length) return;
  return { identityKeys, kind: 'fields', paths: [...new Set(fields)] };
}

/**
 * Paths each inline record leaves out when the call passes no `fields`, per
 * endpoint: the bulk of a default page where one block or list fills each record
 * (2026-11-22: `patient.drug.openfda` 92% of a drug/event page; `code_info` and
 * `more_code_info` 89% of a device/enforcement page; `code_info` and the three
 * product-code lists 78% of a device/recall page). The drug is already named by
 * `medicinalproduct` and `activesubstance`; device `code_info` is a lot and
 * serial list; the device/recall `openfda` lists cover every registrant and
 * 510(k) of the product code, not the recall, so that block's small scalars stay
 * — `device_class` is the only class a device recall carries. Every other
 * endpoint's default page stays under 85 KB and keeps whole records.
 */
const LEFT_OUT_BY_DEFAULT = {
  'drug/event': ['patient.drug.openfda'],
  'device/enforcement': ['code_info', 'more_code_info'],
  'device/recall': [
    'code_info',
    'openfda.k_number',
    'openfda.fei_number',
    'openfda.registration_number',
  ],
} as const satisfies Record<string, readonly string[]>;

/** An endpoint whose records leave paths out by default. */
type LeftOutEndpoint = keyof typeof LEFT_OUT_BY_DEFAULT;

/** The paths `endpoint` leaves out by default — none for an endpoint not in the table. */
function leftOutAt(endpoint: string): readonly string[] {
  return Object.hasOwn(LEFT_OUT_BY_DEFAULT, endpoint)
    ? LEFT_OUT_BY_DEFAULT[endpoint as LeftOutEndpoint]
    : [];
}

/**
 * The cut one call on a search tool with left-out paths applies to its inline
 * records. With `fields`: the `fields` projection, joined by each `include`
 * entry that names a left-out path or a path beneath one. Without: each of the
 * endpoint's left-out paths comes out of every record, unless `include` or the
 * call's `search` (`searched`, the field paths it names) names it — then it
 * stays whole — or names paths beneath it — then only those stay. An entry
 * naming no left-out path changes nothing. Undefined when the call cuts nothing.
 */
export function pageProjection(
  endpoint: string,
  identityKeys: readonly string[],
  call: {
    fields?: readonly string[] | undefined;
    include?: readonly string[] | undefined;
    searched?: readonly string[] | undefined;
  },
): RecordProjection | undefined {
  const leftOut = leftOutAt(endpoint);
  const naming = (entries: readonly string[] = []) =>
    entries.filter((entry) =>
      leftOut.some((path) => entry === path || entry.startsWith(`${path}.`)),
    );
  if (call.fields?.length) {
    return recordProjection([...call.fields, ...naming(call.include)], identityKeys);
  }
  const back = [...naming(call.include), ...naming(call.searched)];
  const kept = leftOut.flatMap((path) =>
    back.includes(path)
      ? []
      : [
          {
            keep: back
              .filter((entry) => entry.startsWith(`${path}.`))
              .map((entry) => entry.slice(path.length + 1)),
            path,
          },
        ],
  );
  return kept.length > 0 ? { kind: 'omission', leftOut: kept } : undefined;
}

/** Path segments compiled into a tree; `true` keeps the whole value at that key. */
type PathTree = Map<string, PathTree | true>;

/**
 * Compile dotted paths into one tree, in the order given — identity keys first,
 * so a projected record leads with them. A path that ends where another
 * continues keeps the whole value: `patient` with `patient.drug` keeps all of
 * `patient`.
 */
function buildTree(paths: readonly string[]): PathTree {
  const root: PathTree = new Map();
  for (const path of paths) {
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
  const kept: [string, unknown][] = [];
  for (const [key, subtree] of tree) {
    if (!Object.hasOwn(source, key)) continue;
    const child = subtree === true ? source[key] : projectValue(source[key], subtree);
    if (child !== undefined) kept.push([key, child]);
  }
  // `Object.fromEntries` defines each key as its own property, `__proto__` included.
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Project each record to the requested paths plus its identity keys, or return
 * the records untouched when there is no projection. One record in always gives
 * one record out — a record carrying none of the paths comes back as `{}` — so
 * projection can never shrink the page a caller's `limit` addressed.
 */
export function projectRecords(
  records: Record<string, unknown>[],
  projection: FieldsProjection | undefined,
): Record<string, unknown>[] {
  if (!projection) return records;
  const tree = buildTree([...projection.identityKeys, ...projection.paths]);
  return records.map((record) => (projectValue(record, tree) ?? {}) as Record<string, unknown>);
}

/** A left-out path where the walk reaches it, with the sub-paths it keeps, if any. */
interface LeftOutLeaf {
  keep: PathTree | undefined;
  path: string;
}

/** The left-out paths compiled into segments, each ending in its leaf. */
type OmissionTree = Map<string, LeftOutLeaf | OmissionTree>;

function omissionTree(leftOut: DefaultOmission['leftOut']): OmissionTree {
  const root: OmissionTree = new Map();
  for (const { keep, path } of leftOut) {
    const segments = path.split('.');
    const last = segments.pop() as string;
    let node = root;
    for (const segment of segments) {
      const next = node.get(segment);
      const branch: OmissionTree = next instanceof Map ? next : new Map();
      node.set(segment, branch);
      node = branch;
    }
    node.set(last, { keep: keep.length > 0 ? buildTree(keep) : undefined, path });
  }
  return root;
}

/**
 * `value` with each left-out path in `tree` removed, or cut to the sub-paths its
 * leaf keeps, through any array — so `patient.drug.openfda` comes out of every
 * drug of a report. What each removal held is added to `held` under its path.
 * Copies only what it changes: `value` is never modified, and a subtree the walk
 * changes nothing in is returned as is.
 */
function leaveOut(value: unknown, tree: OmissionTree, held: Map<string, number>): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = leaveOut(item, tree, held);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const changes = new Map<string, unknown>();
  for (const [key, node] of tree) {
    if (!Object.hasOwn(source, key)) continue;
    const child = source[key];
    const next = node instanceof Map ? leaveOut(child, node, held) : cutLeaf(child, node, held);
    if (next !== child) changes.set(key, next);
  }
  if (changes.size === 0) return value;
  // `Object.fromEntries` defines each key as its own property, `__proto__` included.
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, child]) => {
      const next = changes.has(key) ? changes.get(key) : child;
      return next === undefined ? [] : [[key, next]];
    }),
  );
}

/**
 * A left-out value cut to the sub-paths its leaf keeps — undefined when it keeps
 * none of them, which removes the key — with the UTF-8 bytes the cut took off
 * added to `held`. A value the cut leaves whole is returned as is, and counts as
 * nothing lost.
 */
function cutLeaf(value: unknown, leaf: LeftOutLeaf, held: Map<string, number>): unknown {
  const kept = leaf.keep ? projectValue(value, leaf.keep) : undefined;
  const whole = JSON.stringify(value);
  const rest = kept === undefined ? '' : JSON.stringify(kept);
  if (rest === whole) return value;
  const bytes = Buffer.byteLength(whole, 'utf8') - Buffer.byteLength(rest, 'utf8');
  held.set(leaf.path, (held.get(leaf.path) ?? 0) + bytes);
  return kept;
}

/**
 * Cut each record to the call's projection, with the disclosure that rides it:
 * `projected_fields` for a `fields` projection; for a default omission,
 * `omitted_fields` naming each left-out path a record on the page lost and the
 * bytes it held across the page, in table order, absent when no record lost
 * anything. One record in always gives one record out, and the records passed in
 * are never modified — a staged call's drain stages the same objects whole.
 */
export function cutRecords(
  records: Record<string, unknown>[],
  projection: RecordProjection | undefined,
): { results: Record<string, unknown>[] } & ProjectionFields & OmissionFields {
  if (!projection) return { results: records };
  if (projection.kind === 'fields') {
    return { results: projectRecords(records, projection), projected_fields: projection.paths };
  }
  const tree = omissionTree(projection.leftOut);
  const held = new Map<string, number>();
  const results = records.map((record) => leaveOut(record, tree, held) as Record<string, unknown>);
  const omitted = projection.leftOut.flatMap(({ path }) => {
    const bytes = held.get(path);
    return bytes === undefined ? [] : [{ path, bytes }];
  });
  return omitted.length > 0 ? { results, omitted_fields: omitted } : { results };
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
      'Paths each record was projected to, present only with fields; a field missing from a record was projected away, not absent upstream.',
    ),
};

/** The projection disclosure field a search tool's response carries. */
export interface ProjectionFields {
  projected_fields?: string[] | undefined;
}

/** A record field and the serialized bytes it holds. */
export interface FieldSize {
  bytes: number;
  path: string;
}

/**
 * Output field disclosing the left-out paths a page's records lost. Absent
 * unless a record lost one, so a page with nothing left out returns the shape it
 * would without it. Spread into the output of each search tool with left-out
 * paths.
 */
export const omissionOutputShape = {
  omitted_fields: z
    .array(
      z
        .object({
          path: z.string().describe('Dotted path; array elements share one path.'),
          bytes: z.number().describe('UTF-8 bytes left out under the path on this page.'),
        })
        .describe('A left-out path and its bytes.'),
    )
    .optional()
    .describe(
      'Paths left out of each record by default and their bytes on this page; name one in include to return it.',
    ),
};

/** Notice topic for the paths a page left out by default, for a search tool's `notice` description. */
export const LEFT_OUT_NOTICE_TOPIC = 'paths left out by default';

/** The left-out disclosure field a search tool's response carries. */
export interface OmissionFields {
  omitted_fields?: FieldSize[] | undefined;
}

/**
 * Disclosure for a page whose records lost a left-out path: each path, the bytes
 * it held on the page, and the `include` re-call that returns it. Returns
 * undefined when no record lost anything. One sentence source for both
 * surfaces, like {@link projectionNotice}: {@link omissionLine} renders it into
 * `content[]` and the handler puts it on `enrichment.notice`. The paths come
 * from {@link LEFT_OUT_BY_DEFAULT}, never from the caller, so they ride as text.
 */
export function omissionNotice(result: OmissionFields): string | undefined {
  const fields = result.omitted_fields;
  if (!fields) return;
  const named = fields.map(({ path, bytes }) => `${path} (${bytes} bytes on this page)`);
  return `Left out of each record by default: ${named.join(', ')}. Re-call with include naming a path to return it, or a path beneath it for that field alone.`;
}

/**
 * The same disclosure as a `content[]` line, quoted to match the projection and
 * oversized-record lines beside it. Returns null when no record lost anything.
 */
export function omissionLine(result: OmissionFields): string | null {
  const notice = omissionNotice(result);
  return notice ? `> ${notice}` : null;
}

/**
 * `include` description for a search tool with left-out paths, naming them per
 * endpoint from `[label, endpoint]` pairs. The input's schema is the `fields`
 * grammar, `fieldSelection()` in `schema-utils.ts`.
 */
export function includeDescription(
  endpoints: readonly (readonly [label: string, endpoint: LeftOutEndpoint])[],
): string {
  const named = endpoints.map(
    ([label, endpoint]) => `${LEFT_OUT_BY_DEFAULT[endpoint].join(', ')} on ${label}`,
  );
  return `Paths left out of each record by default, to return: ${named.join('; ')}. Name one whole, or a path beneath one for that field alone; with fields, entries join the projection. A search clause on a left-out path also returns it.`;
}

/**
 * Disclosure for a projected page: which paths the records were cut to, and any
 * requested path no record on the page carries. Returns undefined when the call
 * did not project.
 *
 * An absent path is reported rather than rejected: openFDA records are sparse, so
 * a path missing from one page is not proof it is misspelled. One sentence source
 * for both surfaces, like the oversized-record notice — {@link projectionLine}
 * renders it into `content[]` and the handler puts it on `enrichment.notice`.
 *
 * Each path is the caller's own text, so it rides as a code span: `_exists_`
 * would otherwise render as emphasis. The span comes from the framework's
 * `MarkdownBuilder` directly rather than through `codeLiteral` in
 * `format-utils.ts`, which imports this module; the `fields` pattern admits no
 * line break, so the span is all of `codeLiteral`'s rule a path can reach.
 */
export function projectionNotice(
  result: ProjectionFields & { results: readonly unknown[] },
): string | undefined {
  const paths = result.projected_fields;
  if (!paths) return;
  const projected = `Records projected to the requested fields (${codeSpans(paths)}) plus each record's identity key; every other field is left out on request.`;
  const absent = result.results.length > 0 ? pathsNotCarried(result.results, paths) : [];
  if (absent.length === 0) return projected;
  return `${projected} No record in this page carries ${codeSpans(absent)} — check it against the keys records carry (openfda_describe_fields lists the searchable ones); records are sparse, so a path can be absent from one page and present on another.`;
}

/** Each path as an inline code span, comma-separated. */
function codeSpans(paths: readonly string[]): string {
  return paths.map((path) => markdown().inlineCode(path).build()).join(', ');
}

/**
 * The same disclosure as a `content[]` line, quoted to match the oversized-record
 * and canvas staging lines beside it. Returns null when the call did not project.
 */
export function projectionLine(
  result: ProjectionFields & { results: readonly unknown[] },
): string | null {
  const notice = projectionNotice(result);
  return notice ? `> ${notice}` : null;
}

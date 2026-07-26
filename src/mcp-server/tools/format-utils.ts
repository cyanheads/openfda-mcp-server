/**
 * @fileoverview Shared formatting helpers for tool format() functions.
 * @module mcp-server/tools/format-utils
 */

/** Truncate a string, appending ellipsis when trimmed. */
export function truncate(value: string | undefined | null, max: number): string {
  if (!value) return 'N/A';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** Convert a snake_case field key to a human-readable label. */
export function humanizeField(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function renderValue(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (isPrimitive(value)) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((v) => v == null || isPrimitive(v))) {
      const joined = value.filter((v) => v != null && v !== '').join(', ');
      return joined ? joined : null;
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;
    const parts: string[] = [];
    for (const [k, v] of entries) {
      if (v == null || v === '') continue;
      if (isPrimitive(v)) parts.push(`${k}=${v}`);
      else if (Array.isArray(v) && v.every((x) => x == null || isPrimitive(x))) {
        const joined = v.filter((x) => x != null && x !== '').join(', ');
        if (joined) parts.push(`${k}=${joined}`);
      } else {
        parts.push(`${k}=${JSON.stringify(v)}`);
      }
    }
    return parts.length > 0 ? parts.join('; ') : null;
  }
  return null;
}

/**
 * Render record fields not in the `rendered` set as `**Label:** value` lines.
 * String arrays render as comma-joined values; objects flatten one level into
 * `key=value` pairs; deeper structures fall back to JSON. Skips null, undefined,
 * empty strings, and empty containers.
 */
export function formatRemainingFields(
  record: Record<string, unknown>,
  rendered: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (rendered.has(key)) continue;
    const formatted = renderValue(value);
    if (formatted == null) continue;
    lines.push(`**${humanizeField(key)}:** ${formatted}`);
  }
  return lines;
}

/**
 * Build an empty-result message that distinguishes "no matches" from
 * "paginated past the end". A non-zero `total` settles it — records matched, so
 * the offset overshot and the field hints are noise. openFDA answers both cases
 * with the same 404 (total 0), so without a total the message names both
 * possibilities and the request's `skip` is the only clue.
 */
export function emptyResultMessage(skip: number, total: number, baseHint: string): string {
  if (total > 0) {
    return `No records at skip=${skip}: ${total} matched, so the offset is past the end of the result set. Lower skip to read them.`;
  }
  return skip > 0
    ? `No results at skip=${skip}. Either no records match or pagination ran past the end of the result set — try skip=0 to confirm. ${baseHint}`
    : baseHint;
}

/** Canvas pointer fields a search tool's `format()` receives when the call staged. */
export interface CanvasResultFields {
  canvas_id?: string | undefined;
  canvas_table?: string | undefined;
  spilled?: boolean | undefined;
  staged_rows?: number | undefined;
  truncated?: boolean | undefined;
}

/**
 * Canvas staging disclosure for `content[]`. Renders whenever the call staged —
 * independent of how many inline rows came back — so the canvas pointer and the
 * staged-vs-matched count never hinge on the size of the inline page. Returns
 * null when the call did not stage.
 */
export function canvasStagingLine(total: number, result: CanvasResultFields): string | null {
  if (result.spilled === undefined) return null;
  if (!result.canvas_table) {
    return `> Canvas \`${result.canvas_id}\` acquired; no rows staged (spilled=${result.spilled}, ${total} matched).`;
  }
  const staged = result.staged_rows ?? 0;
  const cut = result.truncated
    ? ` Truncated: staging stopped at its size budget, so the table holds the first ${staged} records — narrow the query for a complete set.`
    : '';
  return `> Staged ${staged} of ${total} matched rows on canvas table \`${result.canvas_table}\` (canvas_id \`${result.canvas_id}\`, spilled=${result.spilled}) — query with openfda_dataframe_query.${cut}`;
}

/**
 * Explain an empty inline page for a query that did match records. Callers keep
 * their own "nothing matched" wording for `total === 0`, so a search that found
 * records never renders as no results. The staged-table pointer reads from the
 * start of the table: this note only fires once the offset has run past the
 * matched set, and the table never holds more rows than matched, so carrying
 * `skip` into the SQL would hand back a query that returns nothing.
 */
export function emptyPageNote(
  total: number,
  skip: number,
  result?: CanvasResultFields | undefined,
): string {
  const base = `No records in this page: ${total} matched, but skip=${skip} is past the end of the result set. Lower skip to read matched records.`;
  if (!result?.canvas_table) return base;
  const held = result.truncated
    ? `the first ${result.staged_rows ?? 0} of them`
    : `all ${total} of them`;
  return `${base} The staged table holds ${held} — openfda_dataframe_query with \`SELECT * FROM ${result.canvas_table} LIMIT 10\`.`;
}

/**
 * Qualify a tool's no-match line when the request carried an offset. openFDA
 * answers a page past the end of a result set with the same empty payload and
 * `total: 0` it uses for a genuine miss, so at `skip > 0` the flat wording would
 * assert something the response cannot support.
 */
export function noMatchNote(miss: string, skip: number): string {
  return skip > 0
    ? `${miss.replace(/\.$/, '')} at skip=${skip} — either nothing matched or the offset ran past the end of the result set. Retry with skip=0 to tell them apart.`
    : miss;
}

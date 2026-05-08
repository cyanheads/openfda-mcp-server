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

function renderValue(value: unknown, maxLen: number): string | null {
  if (value == null || value === '') return null;
  if (isPrimitive(value)) return truncate(String(value), maxLen);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((v) => v == null || isPrimitive(v))) {
      const joined = value.filter((v) => v != null && v !== '').join(', ');
      return joined ? truncate(joined, maxLen) : null;
    }
    return truncate(JSON.stringify(value), maxLen);
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
    return parts.length > 0 ? truncate(parts.join('; '), maxLen) : null;
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
  maxLen = 300,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (rendered.has(key)) continue;
    const formatted = renderValue(value, maxLen);
    if (formatted == null) continue;
    lines.push(`**${humanizeField(key)}:** ${formatted}`);
  }
  return lines;
}

/**
 * Build an empty-result message that distinguishes "no matches" from
 * "paginated past the end" — openFDA returns the same 404 for both, so the
 * handler needs the request's `skip` to disambiguate for the caller.
 */
export function emptyResultMessage(skip: number, baseHint: string): string {
  return skip > 0
    ? `No results at skip=${skip}. Either no records match or pagination ran past the end of the result set — try skip=0 to confirm. ${baseHint}`
    : baseHint;
}

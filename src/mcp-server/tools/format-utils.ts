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

/**
 * Render record fields not in the `rendered` set as `**Label:** value` lines.
 * Skips null, undefined, and empty-string values. Objects/arrays are JSON-stringified.
 */
export function formatRemainingFields(
  record: Record<string, unknown>,
  rendered: ReadonlySet<string>,
  maxLen = 300,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (rendered.has(key) || value == null || value === '') continue;
    if (typeof value === 'object' && Object.keys(value as object).length === 0) continue;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`**${humanizeField(key)}:** ${truncate(raw, maxLen)}`);
  }
  return lines;
}

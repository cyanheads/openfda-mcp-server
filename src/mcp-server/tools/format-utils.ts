/**
 * @fileoverview Shared formatting helpers for tool format() functions.
 * @module mcp-server/tools/format-utils
 */

import { AGGREGATE_ROUTE } from '@/services/openfda/canvas-spill.js';
import { type PageBudgetFields, pageBudgetLine } from '@/services/openfda/page-budget.js';
import { type ProjectionFields, projectionLine } from '@/services/openfda/record-projection.js';

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

/**
 * One upstream value as inline text — a primitive as-is, a primitive list joined
 * by `, `, an object as `key=value; …` — or null when it holds nothing to show.
 */
export function renderValue(value: unknown): string | null {
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
 * What a Markdown table cell must escape, one character per match:
 * line endings (they end the row), `|` (it splits the cell), the emphasis, code,
 * link, and strikethrough markers, and the characters whose meaning depends on
 * what follows — a `\` before ASCII punctuation or a line break (the break
 * becomes `<br>`, whose `<` it would otherwise escape), a `<` that can open a
 * tag, an `&` that completes a character reference, and a `_` not flanked by
 * alphanumerics on both sides. Every alternative is a single character or a
 * bounded lookaround except the reference check, which stops at the first
 * character outside its run, so the scan stays linear.
 */
const CELL_ESCAPE =
  /\r\n?|\n|[|*`[\]~]|\\(?=[!-/:-@[-`{-~\r\n])|<(?=[A-Za-z/!?])|&(?=#\d+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/
    .source;

/**
 * Where a GFM parser can start an extended autolink — `http://`, `https://`,
 * and `www.` in any case, plus `ftp://`, which marked also links.
 */
const LINK_OPENER = /(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]):\/\/|[Ww][Ww][Ww]\./.source;

/** One left-to-right scan: a link opener, or a character the cell must escape. */
const CELL_SCAN_RE = new RegExp(`${LINK_OPENER}|${CELL_ESCAPE}`, 'g');
/** The cell escapes alone, tested at one position. */
const CELL_ESCAPE_AT_RE = new RegExp(CELL_ESCAPE, 'y');
/** What ends an autolink's span in both parsers: whitespace or `<`. */
const SPAN_END_RE = /[\s<]/g;
/** The ASCII domain an exempt autolink must open with. */
const DOMAIN_RE = /[A-Za-z0-9_.-]*/y;
/** Characters GFM trims off the end of an autolink (`&name;` references aside). */
const LINK_TRAIL = new Set(['!', '"', "'", ')', '*', ',', '.', ':', ';', '?', '_', '~', ']']);

/**
 * The whitespace-delimited stretch of text a link opener's autolink can cover,
 * measured once and shared by every opener inside it so the scan stays linear.
 */
interface LinkSpan {
  /** Index of the whitespace or `<` that ends the span, or the text length. */
  end: number;
  /** Last `|`, or `]` before `(` or `[` — micromark ends the link there and leaves the rest as Markdown. */
  lastBreak: number;
  lastCloseParen: number;
  /** Last index in the span (or an escaped `<` ending it) the escaper would change; -1 when none. */
  lastEscape: number;
  lastOpenParen: number;
  /** The trimmed trail holds an emphasis marker or a character reference — raw, either would render. */
  unsafeTrail: boolean;
}

function measureLinkSpan(text: string, start: number): LinkSpan {
  SPAN_END_RE.lastIndex = start;
  const end = SPAN_END_RE.exec(text)?.index ?? text.length;
  const span: LinkSpan = {
    end,
    lastBreak: -1,
    lastCloseParen: -1,
    lastEscape: -1,
    lastOpenParen: -1,
    unsafeTrail: false,
  };
  for (let i = start; i <= end && i < text.length; i++) {
    const c = text[i];
    const bracketBreak = c === ']' && (text[i + 1] === '(' || text[i + 1] === '[');
    if (c === '|' || bracketBreak) span.lastBreak = i;
    else if (c === '(') span.lastOpenParen = i;
    else if (c === ')') span.lastCloseParen = i;
    CELL_ESCAPE_AT_RE.lastIndex = i;
    if ('|*`[]~\\<&_'.includes(c as string) && CELL_ESCAPE_AT_RE.test(text)) span.lastEscape = i;
  }
  for (let i = end; i > start; i--) {
    const c = text[i - 1] as string;
    if (c === ';') {
      let j = i - 2;
      while (j > start && /[A-Za-z0-9]/.test(text[j] as string)) j--;
      if (text[j] === '&' && /[A-Za-z]/.test(text[j + 1] as string) && j + 1 < i - 1) {
        span.unsafeTrail = true;
        break;
      }
    } else if (!LINK_TRAIL.has(c)) break;
    if (c === '*' || c === '_' || c === '~') {
      span.unsafeTrail = true;
      break;
    }
  }
  return span;
}

/**
 * Whether the autolink opening at `at` can render verbatim: marked and
 * micromark both link it from its first character, end it only by trimming
 * plain punctuation, and leave nothing after it that Markdown would read.
 * Inside such a link a backslash escape is literal text — it would show in the
 * link and its address — so the span is emitted unescaped. `|` and line breaks
 * never reach one: a `|` disqualifies the span and a line break ends it.
 */
function exemptLink(
  text: string,
  at: number,
  opener: string,
  span: LinkSpan,
  continues: boolean,
): boolean {
  if (continues && span.end === text.length) return false;
  if (text[span.end] === '<' || span.unsafeTrail || span.lastBreak >= at) return false;
  if (span.lastOpenParen >= at && span.lastOpenParen > span.lastCloseParen) return false;
  const prev = text[at - 1];
  if (opener.endsWith('.')) {
    if (opener !== 'www.') return false;
    if (prev !== undefined && !' \t(*[]~'.includes(prev)) return false;
  } else {
    if (/^ftp/i.test(opener)) return false;
    if (prev !== undefined && /[A-Za-z0-9._+-]/.test(prev)) return false;
  }
  DOMAIN_RE.lastIndex = at + opener.length;
  const domain = DOMAIN_RE.exec(text)?.[0] ?? '';
  if (!/^[A-Za-z0-9](?:.*[A-Za-z0-9-])?$/.test(domain)) return false;
  if (text.charCodeAt(at + opener.length + domain.length) >= 0x80) return false;
  return !domain
    .split('.')
    .slice(-2)
    .some((segment) => segment.includes('_'));
}

/**
 * Escape text for a Markdown table cell so it renders as one cell holding the
 * original text. Only characters that would change the rendering are escaped,
 * so identifiers and ordinary text stay byte-identical — `recall_number`,
 * `p<0.05`, `AT&T`, and `CARBIDOPA\LEVODOPA` pass through, since agents copy
 * spans out of `content[]`. Line breaks become `<br>`.
 *
 * GFM links a bare `http://`, `https://`, or `www.` address from the raw text,
 * so a backslash inside one would show in the link and corrupt a copied URL.
 * An address both parsers link whole is emitted verbatim; one they would read
 * differently, and that needs an escape, has its opener's `:` or `.` escaped
 * instead, so it renders as plain text.
 */
export function escapeTableCell(text: string): string {
  return escapeCell(text, false);
}

/**
 * `escapeTableCell` for a fragment of a cell that other output follows
 * directly. Its end is escaped as though ASCII punctuation came next — a
 * trailing `<` or `\` is escaped — and an address reaching the end could run
 * into that output, so it is never kept as a link.
 */
export function escapeTableCellFragment(text: string): string {
  return escapeCell(`${text}!`, true).slice(0, -1);
}

function escapeCell(text: string, continues: boolean): string {
  let out = '';
  let from = 0;
  let span: LinkSpan | undefined;
  CELL_SCAN_RE.lastIndex = 0;
  for (let match = CELL_SCAN_RE.exec(text); match; match = CELL_SCAN_RE.exec(text)) {
    const at = match.index;
    const token = match[0];
    if (token.length < 4) {
      out += `${text.slice(from, at)}${token.startsWith('\r') || token === '\n' ? '<br>' : `\\${token}`}`;
      from = at + token.length;
      continue;
    }
    if (!span || at >= span.end) span = measureLinkSpan(text, at);
    if (span.lastEscape < at || exemptLink(text, at, token, span, continues)) {
      out += text.slice(from, span.end);
      from = span.end;
    } else {
      const killAt = token.endsWith('.') ? at + 3 : at + token.length - 3;
      out += `${text.slice(from, killAt)}\\${text[killAt]}`;
      from = killAt + 1;
    }
    CELL_SCAN_RE.lastIndex = from;
  }
  return out + text.slice(from);
}

/**
 * Flatten CR, LF, and CRLF to a space, for upstream or caller text placed on a
 * line whose structure it must not change — a record heading, a `**Label:**`
 * line, a list item — so a value cannot open a new heading or list item.
 */
export function singleLine(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ');
}

/**
 * A block marker opening a line, past up to three columns of indent: an ATX
 * heading, a block quote, a bullet, a `*` or `_` thematic break, a `=` setext
 * underline, a line of only `-`, `:`, `|`, and blanks (a `-` thematic break or
 * setext underline, or a table delimiter row), a code fence, an HTML block, a
 * link reference or footnote definition, or a task-list box. An ordinal (`1.`,
 * `12)`) is captured separately, since its escape goes after the digits.
 * Anchored, and built from character-class runs alone — no quantified group or
 * backreference, which JavaScriptCore backtracks quadratically — so it stays
 * linear in both Bun and Node.
 */
const LINE_START_MARKER_RE =
  /^([ \t]{0,3})(?:(?=#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|\*[ \t]*\*[ \t]*\*[* \t]*$|_[ \t]*_[ \t]*_[_ \t]*$|=+[ \t]*$|(?=[-:| \t]*-)[-:|][-:| \t]*$|`{3}|~{3}|<[A-Za-z/!?]|\[.*?\]:|\[[ xX]\](?:[ \t]|$))|(\d{1,9})(?=[.)](?:[ \t]|$)))/;

/**
 * Upstream or caller text that opens a line's content — a list item's text, or
 * a line of its own — rendered so it stays text inside the line the tool opened:
 * line breaks flattened as by {@link singleLine}, and a block marker it opens
 * with escaped. Text that opens with no marker passes through byte-identical.
 */
export function lineContent(text: string): string {
  return singleLine(text).replace(
    LINE_START_MARKER_RE,
    (_match, indent: string, ordinal: string | undefined) =>
      ordinal ? `${indent}${ordinal}\\` : `${indent}\\`,
  );
}

/**
 * Render one value as a table cell — primitives as written, structures as
 * JSON, escaped either way. `String()` on a nested object yields
 * `[object Object]`, which drops every leaf under it from `content[]` while
 * `structuredContent` keeps the whole structure.
 */
export function formatCell(value: unknown): string {
  if (value == null) return '';
  return escapeTableCell(isPrimitive(value) ? String(value) : JSON.stringify(value));
}

/**
 * Render record fields not in the `rendered` set as `**Label:** value` lines.
 * String arrays render as comma-joined values; objects flatten one level into
 * `key=value` pairs; deeper structures fall back to JSON. Skips null, undefined,
 * empty strings, and empty containers. Each line is flattened by
 * {@link singleLine}, so a multi-line value stays on its label line.
 *
 * `rendered` names only the keys a caller's own lines emit **verbatim and
 * unconditionally** — that is what keeps `content[]` complete against a dynamic
 * record. A key whose value is translated (a code mapped to a label), filtered,
 * partially rendered, or rendered only when a sibling is absent must stay out of
 * the set so its full value still reaches `content[]`.
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
    lines.push(singleLine(`**${humanizeField(key)}:** ${formatted}`));
  }
  return lines;
}

/**
 * Build an empty-result message that distinguishes "no matches" from
 * "paginated past the end". A non-zero `total` settles it — records matched, so
 * the offset overshot and the field hints are noise. openFDA answers both cases
 * with the same 404, and the service recovers the real total for a page at
 * `skip > 0`; only when that recovery failed (`totalUnverified`) does the
 * message name both possibilities.
 */
export function emptyResultMessage(
  skip: number,
  total: number,
  baseHint: string,
  totalUnverified?: boolean,
): string {
  if (total > 0) {
    return `No records at skip=${skip}: ${total} matched, so the offset is past the end of the result set. Lower skip to read them.`;
  }
  return totalUnverified
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
    ? ` Truncated: staging stopped at its size budget, so the table holds the first ${staged} records — narrow the query for a complete set.${AGGREGATE_ROUTE}`
    : '';
  return `> Staged ${staged} of ${total} matched rows on canvas table \`${result.canvas_table}\` (canvas_id \`${result.canvas_id}\`, spilled=${result.spilled}) — openfda_dataframe_describe for its columns, then openfda_dataframe_query for SQL.${cut}`;
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
 * Qualify a tool's no-match line when the total behind it is unverified. openFDA
 * answers a page past the end of a result set with the same empty payload it
 * uses for a genuine miss; the service recovers the real total, and when that
 * recovery failed (`totalUnverified`) the flat wording would assert something
 * the response cannot support.
 */
export function noMatchNote(miss: string, skip: number, totalUnverified?: boolean): string {
  return totalUnverified
    ? `${miss.replace(/\.$/, '')} at skip=${skip} — either nothing matched or the offset ran past the end of the result set. Retry with skip=0 to tell them apart.`
    : miss;
}

/** The `meta` block a search tool's response carries. */
interface ResultMeta {
  lastUpdated: string;
  limit: number;
  skip: number;
  total: number;
  totalUnverified?: boolean | undefined;
}

/**
 * Metadata header that opens a search tool's `content[]` on every branch, a
 * no-match included, so a text-only client sees the dataset date, offset, and
 * page size `structuredContent` carries. `lastUpdated` renders as the service
 * reported it — `unknown` on a cold process, never a substitute date. `kind`
 * names the label tool's response arm.
 */
export function resultHeader(meta: ResultMeta, returned: number, kind?: string): string {
  return `**${meta.total} total results** (returned: ${returned}, skip: ${meta.skip}, limit: ${meta.limit}${kind ? `, kind: ${kind}` : ''}) | Data updated: ${meta.lastUpdated}`;
}

/**
 * The lines that open a search tool's `content[]` on every branch, in order: the
 * metadata header, then the disclosures that hold regardless of row count — the
 * `fields` projection line, the page-budget line, then the canvas staging line
 * whenever the call staged. The branch body (the no-match line, the past-the-end
 * note, or the records) follows. Each entry is one line — the dataset date and
 * the page-budget field paths come from upstream — ending in a newline, so
 * joining on `\n` separates the blocks with a blank line.
 */
export function searchLead(
  result: CanvasResultFields &
    PageBudgetFields &
    ProjectionFields & { meta: ResultMeta; results: unknown[] },
): string[] {
  return [
    resultHeader(result.meta, result.results.length),
    projectionLine(result),
    pageBudgetLine(result),
    canvasStagingLine(result.meta.total, result),
  ]
    .filter((line) => line !== null)
    .map((line) => `${singleLine(line)}\n`);
}

/**
 * Render one record a `fields` projection cut down. A tool's curated renderer
 * keys on record shape and fills absent fields with placeholders, both of which
 * misread a projected record — a drug report without `patient` routes to the
 * wrong branch, and a projected-away date would render as `N/A`, a claim the
 * response cannot make. So a projected record gets its identity heading — the
 * first identity key it carries, by key name, which `structuredContent` uses too
 * — and then every field it holds, verbatim and nothing else.
 */
export function projectedRecordLines(
  record: Record<string, unknown>,
  identityKeys: readonly string[],
): string[] {
  const key = identityKeys.find((k) => record[k] != null && record[k] !== '');
  const heading = key ? `### ${key}: ${String(record[key])}` : '### Record';
  return [singleLine(heading), ...formatRemainingFields(record, new Set(key ? [key] : []))];
}

/**
 * Body for an empty inline page: the tool's own no-match line when nothing
 * matched, qualified when the zero total is unverified, and otherwise the
 * past-the-end note — a search that matched records never renders as no
 * results (#31).
 */
export function emptyPageBody(
  result: CanvasResultFields & { meta: Pick<ResultMeta, 'skip' | 'total' | 'totalUnverified'> },
  miss: string,
): string {
  const { skip, total, totalUnverified } = result.meta;
  return total === 0
    ? noMatchNote(miss, skip, totalUnverified)
    : emptyPageNote(total, skip, result);
}

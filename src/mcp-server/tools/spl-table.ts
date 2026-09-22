/**
 * @fileoverview Renders an SPL `*_table` string from a `drug/label` record as a
 * GFM pipe table for `content[]`. openFDA ships these sections as raw SPL table
 * markup — `<table>`, `<content styleCode>`, `colspan`/`rowspan`, numeric
 * entities — which is roughly three-quarters markup by character count. Only
 * the rendering changes: `structuredContent` keeps the provider string as-is.
 * @module mcp-server/tools/spl-table
 */

/** A parsed SPL node — an element from the table vocabulary, or text between tags. */
type SplNode =
  | { kind: 'text'; text: string }
  | { kind: 'element'; name: string; attrs: Record<string, string>; children: SplNode[] };

type SplElement = Extract<SplNode, { kind: 'element' }>;

/**
 * The SPL table vocabulary, lowercased. A tag-shaped run outside it — such as
 * the literal `<E050800>` some labels carry in ingredient text — is text, not
 * markup, so it is never stripped.
 */
const SPL_TAGS = new Set([
  'br',
  'caption',
  'col',
  'colgroup',
  'content',
  'footnote',
  'footnoteref',
  'item',
  'linkhtml',
  'list',
  'paragraph',
  'rendermultimedia',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);

/** Elements that never carry children, whether or not the source self-closes them. */
const VOID_TAGS = new Set(['br', 'col', 'footnoteref', 'rendermultimedia']);

const TAG_RE =
  /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([\w.:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/** Marks a block boundary (paragraph, list item, nested row) inside one cell. */
const BLOCK = '\u0000';
/** How a block boundary renders inside a table cell. */
const CELL_BREAK = '<br>';
/** Upper bound on a single cell's colspan — guards the grid against a malformed span. */
const MAX_COLSPAN = 1000;

/** Decode numeric character references and the five XML named entities. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, hex: string, dec: string, named: string) => {
    if (named) return NAMED_ENTITIES[named] ?? match;
    const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

/**
 * Escape text for a Markdown table cell: the pipe that would split the cell,
 * the backslash, the characters that open emphasis, code, links, or HTML, and
 * an `&` that would re-form an entity reference once decoded.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/&(?=#?\w+;)/g, '\\&');
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, dq, sq, bare] of source.matchAll(ATTR_RE)) {
    if (name) attrs[name.toLowerCase()] = dq ?? sq ?? bare ?? '';
  }
  return attrs;
}

/**
 * Parse SPL table markup into a node tree. Returns undefined when the markup is
 * not balanced — a close tag that doesn't match its opener, or an element left
 * open at the end — so the caller can fall back to plain text.
 */
function parseSpl(raw: string): SplNode[] | undefined {
  const root: SplElement = { kind: 'element', name: '#root', attrs: {}, children: [] };
  const stack: SplElement[] = [root];
  let cursor = 0;
  let pendingText = '';

  const top = () => stack[stack.length - 1] as SplElement;
  const flushText = () => {
    if (pendingText) top().children.push({ kind: 'text', text: pendingText });
    pendingText = '';
  };

  for (const match of raw.matchAll(TAG_RE)) {
    const [whole, closing, rawName = '', attrSource = '', selfClosing] = match;
    const name = rawName.toLowerCase();
    pendingText += raw.slice(cursor, match.index);
    cursor = match.index + whole.length;
    if (!SPL_TAGS.has(name)) {
      pendingText += whole;
      continue;
    }
    flushText();
    if (closing) {
      if (VOID_TAGS.has(name)) continue;
      if (top().name !== name) return;
      stack.pop();
      continue;
    }
    const element: SplElement = {
      kind: 'element',
      name,
      attrs: parseAttrs(attrSource),
      children: [],
    };
    top().children.push(element);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
  }
  pendingText += raw.slice(cursor);
  flushText();
  return stack.length === 1 ? root.children : undefined;
}

/**
 * The footnote numbers already handed out in one text output. Share one across
 * every `renderSplTable` call that lands in the same document so its `[^n]`
 * labels stay unique — a Markdown renderer keeps only the first definition of a label.
 */
export interface FootnoteSequence {
  last: number;
}

/** A sequence that starts numbering at 1. */
export function createFootnoteSequence(): FootnoteSequence {
  return { last: 0 };
}

/**
 * Footnote numbering for one table — markers follow first appearance, by footnote
 * or reference. Numbers come from the shared sequence; footnote IDs are scoped to
 * the table, since SPL reuses IDs like `f1` across tables.
 */
class FootnoteRegistry {
  readonly #numbers = new Map<string, number>();
  readonly #notes = new Map<number, string>();
  readonly #sequence: FootnoteSequence;

  constructor(sequence: FootnoteSequence) {
    this.#sequence = sequence;
  }

  /** The marker number for an ID, assigning the next one on first sight. Anonymous footnotes always get a fresh number. */
  number(id: string | undefined): number {
    if (id === undefined) return ++this.#sequence.last;
    let n = this.#numbers.get(id);
    if (n === undefined) {
      n = ++this.#sequence.last;
      this.#numbers.set(id, n);
    }
    return n;
  }

  define(n: number, text: string): void {
    if (text) this.#notes.set(n, text);
  }

  /** `[^n]: text` lines in marker order. A reference whose footnote never appears gets no line. */
  definitions(): string[] {
    return [...this.#notes].sort(([a], [b]) => a - b).map(([n, text]) => `[^${n}]: ${text}`);
  }
}

/**
 * Collapse whitespace and resolve block markers: inside a cell every block
 * boundary becomes a visible `<br>` (a raw newline would end the table row).
 */
function finalizeInline(text: string, separator = CELL_BREAK): string {
  return text
    .replace(/\s+/g, ' ')
    .split(BLOCK)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(separator);
}

function elementChildren(node: SplElement): SplElement[] {
  return node.children.filter((c): c is SplElement => c.kind === 'element');
}

/** `^9`, or `^(a b)` when the raised text has a space — so `10^9/L` never reads as `109/L`. */
function scripted(marker: string, inner: string): string {
  if (!inner) return '';
  return /\s/.test(inner) ? `${marker}(${inner})` : `${marker}${inner}`;
}

/** Render a node's text for use inside a cell, escaped, with block markers between blocks. */
function renderInline(node: SplNode, notes: FootnoteRegistry): string {
  if (node.kind === 'text') return escapeMarkdown(decodeEntities(node.text));
  const inner = () => node.children.map((child) => renderInline(child, notes)).join('');
  switch (node.name) {
    case 'br':
      return BLOCK;
    case 'col':
    case 'colgroup':
      return '';
    case 'paragraph':
    case 'table':
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
      // A nested table flattens into its cell: one block per row, cells space-separated.
      return `${BLOCK}${inner()}${BLOCK}`;
    case 'td':
    case 'th':
      return ` ${inner()} `;
    case 'list':
      return `${BLOCK}${renderList(node, notes)}${BLOCK}`;
    case 'item':
      return `${BLOCK}• ${inner()}${BLOCK}`;
    case 'sup':
      return scripted('^', finalizeInline(inner(), ' '));
    case 'sub':
      return scripted('\\_', finalizeInline(inner(), ' '));
    case 'footnote': {
      const n = notes.number(node.attrs.id);
      notes.define(n, finalizeInline(inner(), ' '));
      return `[^${n}]`;
    }
    case 'footnoteref':
      return `[^${notes.number(node.attrs.idref)}]`;
    case 'rendermultimedia':
      return '[image]';
    default:
      // content, linkHtml, caption inside an item, and anything else: its text.
      return inner();
  }
}

/**
 * A list as blocks, in source order. An item's own `<caption>` is its bullet;
 * otherwise `•`, or `n.` for an ordered list. Anything else directly in the
 * list — its heading `<caption>`, stray text — is a block of its own.
 */
function renderList(list: SplElement, notes: FootnoteRegistry): string {
  const ordered = list.attrs.listtype === 'ordered';
  let index = 0;
  return list.children
    .map((child) => {
      if (child.kind !== 'element' || child.name !== 'item') {
        return `${BLOCK}${renderInline(child, notes)}${BLOCK}`;
      }
      index++;
      const caption = child.children.find(
        (c): c is SplElement => c.kind === 'element' && c.name === 'caption',
      );
      const marker = caption
        ? `${finalizeInline(renderInline(caption, notes), ' ')} `
        : ordered
          ? `${index}. `
          : '• ';
      const body = child.children
        .filter((c) => c !== caption)
        .map((c) => renderInline(c, notes))
        .join('');
      return `${BLOCK}${marker}${body}${BLOCK}`;
    })
    .join('');
}

function cellsOf(row: SplElement): SplElement[] {
  return elementChildren(row).filter((cell) => cell.name === 'td' || cell.name === 'th');
}

function cellText(cell: SplElement, notes: FootnoteRegistry, separator = CELL_BREAK): string {
  return finalizeInline(cell.children.map((c) => renderInline(c, notes)).join(''), separator);
}

function spanOf(value: string | undefined, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return n >= 1 ? Math.min(n, max) : 1;
}

/**
 * Lay rows out on a rectangular grid. A spanned value sits in its origin cell;
 * the cells it covers are empty, so every row ends with the same column count
 * and no later cell shifts.
 */
function buildGrid(rows: SplElement[], notes: FootnoteRegistry): string[][] {
  const grid: (string | undefined)[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    const line = grid[r] as (string | undefined)[];
    let col = 0;
    for (const cell of cellsOf(row)) {
      while (line[col] !== undefined) col++;
      const text = cellText(cell, notes);
      const colspan = spanOf(cell.attrs.colspan, MAX_COLSPAN);
      const rowspan = spanOf(cell.attrs.rowspan, rows.length - r);
      for (let dr = 0; dr < rowspan; dr++) {
        const target = grid[r + dr] as (string | undefined)[];
        for (let dc = 0; dc < colspan; dc++) {
          target[col + dc] = dr === 0 && dc === 0 ? text : '';
        }
      }
      col += colspan;
    }
  });
  const width = Math.max(0, ...grid.map((line) => line.length));
  return grid.map((line) => Array.from({ length: width }, (_, c) => line[c] ?? ''));
}

function pipeRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** One `<table>` as caption, pipe table, footer lines, and footnote definitions — blank-line separated. */
function renderTable(table: SplElement, sequence: FootnoteSequence): string {
  const notes = new FootnoteRegistry(sequence);
  const captions: SplElement[] = [];
  const headRows: SplElement[] = [];
  const bodyRows: SplElement[] = [];
  const footRows: SplElement[] = [];
  const rowsOf = (group: SplElement) => elementChildren(group).filter((c) => c.name === 'tr');

  for (const child of elementChildren(table)) {
    if (child.name === 'caption') captions.push(child);
    else if (child.name === 'thead') headRows.push(...rowsOf(child));
    else if (child.name === 'tbody') bodyRows.push(...rowsOf(child));
    else if (child.name === 'tfoot') footRows.push(...rowsOf(child));
    else if (child.name === 'tr') bodyRows.push(child);
  }

  const blocks: string[] = [];
  const caption = captions
    .map((c) => finalizeInline(renderInline(c, notes), ' '))
    .filter(Boolean)
    .join(' ');
  if (caption) blocks.push(caption);

  // The first <thead> row is the header; with no <thead>, the first row is.
  const grid = buildGrid([...headRows, ...bodyRows], notes);
  const [header, ...body] = grid;
  if (header && header.length > 0) {
    blocks.push(
      [pipeRow(header), pipeRow(header.map(() => '---')), ...body.map(pipeRow)].join('\n'),
    );
  }

  // Footer rows sit below the table as text, so a paragraph break is a line break here.
  const footer = footRows
    .map((row) =>
      cellsOf(row)
        .map((cell) => cellText(cell, notes, '\n'))
        .filter(Boolean)
        .join(' | '),
    )
    .filter(Boolean);
  if (footer.length > 0) blocks.push(footer.join('\n'));

  const definitions = notes.definitions();
  if (definitions.length > 0) blocks.push(definitions.join('\n'));
  return blocks.join('\n\n');
}

/**
 * Markup that does not parse as balanced SPL: its decoded text, with only the
 * SPL vocabulary's tags removed. Nothing throws and no text is dropped.
 */
function plainText(raw: string): string {
  const stripped = raw.replace(TAG_RE, (whole, _closing, name: string) =>
    SPL_TAGS.has(name.toLowerCase()) ? ' ' : whole,
  );
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/**
 * Render one SPL `*_table` string as Markdown: each `<table>` becomes its
 * caption, a GFM pipe table, any `<tfoot>` rows, and `[^n]:` definitions for
 * the footnotes its cells mark. Text outside a table renders as its own block.
 * Pass one `sequence` to every call whose output shares a document; without it,
 * footnotes number from 1.
 */
export function renderSplTable(
  raw: string,
  sequence: FootnoteSequence = createFootnoteSequence(),
): string {
  const nodes = parseSpl(raw);
  if (!nodes) return plainText(raw);

  const blocks: string[] = [];
  const looseNotes = new FootnoteRegistry(sequence);
  let loose = '';
  const flushLoose = () => {
    const text = finalizeInline(loose, '\n\n');
    if (text) blocks.push(text);
    loose = '';
  };

  for (const node of nodes) {
    if (node.kind === 'element' && node.name === 'table') {
      flushLoose();
      const table = renderTable(node, sequence);
      if (table) blocks.push(table);
    } else {
      loose += renderInline(node, looseNotes);
    }
  }
  flushLoose();
  const definitions = looseNotes.definitions();
  if (definitions.length > 0) blocks.push(definitions.join('\n'));
  return blocks.join('\n\n');
}

/**
 * @fileoverview Reads a caller's openFDA `search` string in Lucene's classic
 * query grammar — the grammar openFDA's query parser applies — to report which
 * fields it names, where each field clause's value sits in the string, and
 * which AND-ed clauses under one array of objects openFDA can satisfy from
 * different elements — with the notice and per-element SQL filter for them.
 * One linear scan builds the clause tree; every export derives from it, and
 * none throws, whatever the input.
 * @module mcp-server/tools/search-clauses
 */

import { codeLiteral } from '@/mcp-server/tools/format-utils.js';

/* --- public shapes --- */

/** A half-open `[start, end)` character range into the search string as given. */
export interface SourceSpan {
  readonly end: number;
  readonly start: number;
}

/** One bound of a range value. A quoted bound's span covers the characters between its quotes. */
interface RangeBound {
  readonly quoted: boolean;
  readonly span: SourceSpan;
}

/**
 * A field clause's value as written. For a quoted phrase the span covers the
 * characters between the quotes (to the end of the string when the phrase is
 * never closed). A range lists its bounds in order, `TO` left out. A
 * `field:( … )` group spans the text inside its parentheses.
 */
type ClauseValue =
  | { readonly kind: 'term'; readonly quoted: boolean; readonly span: SourceSpan }
  | {
      readonly bounds: readonly RangeBound[];
      readonly kind: 'range';
      readonly lowerInclusive: boolean;
      readonly upperInclusive: boolean;
    }
  | { readonly kind: 'regexp'; readonly span: SourceSpan }
  | { readonly kind: 'group'; readonly span: SourceSpan };

/** One `field:value` clause: the field path exactly as written (`.exact` kept) and its value. */
export interface FieldClause {
  readonly field: string;
  readonly value: ClauseValue;
}

/* --- clause tree --- */

/** The modifier written before an operand: `+` marks it required; `-`, `!`, or `NOT` prohibits it. */
type Modifier = 'required' | 'prohibited' | undefined;

/** The conjunction written before an operand (`AND`/`&&` or `OR`/`||`), if any. */
type Connector = 'and' | 'or' | undefined;

interface Operand {
  readonly connector: Connector;
  readonly modifier: Modifier;
  readonly node: QueryNode;
}

/**
 * A clause on a field: an explicit `field:value`, or a bare value inside a
 * `field:( … )` group, which Lucene reads against that group's field.
 */
interface ClauseNode {
  /** The field path as written, `.exact` kept. */
  readonly field: string;
  readonly kind: 'clause';
  /** The field the clause tests: `.exact` stripped, `_exists_`/`_missing_` resolved to their value. */
  readonly leaf: string;
  readonly value: ClauseValue;
}

/** A parenthesized group. `field` is set on a `field:( … )` group and inherited by groups inside it. */
interface GroupNode {
  readonly depth: number;
  readonly field: string | undefined;
  readonly kind: 'group';
  readonly operands: Operand[];
}

/** A value on the default field (no `field:` prefix): it names no field. */
interface BareNode {
  readonly kind: 'bare';
}

type QueryNode = ClauseNode | GroupNode | BareNode;

interface ParsedSearch {
  /** Every clause node in source order, bare values inside `field:( … )` groups included. */
  readonly clauseNodes: readonly ClauseNode[];
  /** The explicit `field:` clauses in source order — what {@link scanFieldClauses} returns. */
  readonly fieldClauses: readonly FieldClause[];
  readonly root: GroupNode;
}

/* --- scanner --- */

const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/** Lucene's whitespace: space, tab, line feed, carriage return, and the ideographic space. */
function isSpace(char: string | undefined): boolean {
  return (
    char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === IDEOGRAPHIC_SPACE
  );
}

/** Characters that end a term. `+`, `-`, `*`, and `?` continue one once it has started. */
const TERM_STOPS = '!():^[]"{}~/';

function endsTerm(char: string): boolean {
  return isSpace(char) || TERM_STOPS.includes(char);
}

/** Whether a term can start at `char`: not a stop character and not a `+` or `-` modifier. */
function startsTerm(char: string | undefined): boolean {
  return char !== undefined && char !== '+' && char !== '-' && !endsTerm(char);
}

/** End of the term starting at `from`; a backslash takes the next character into the term. */
function termEnd(search: string, from: number): number {
  let i = from;
  while (i < search.length) {
    const char = search[i] as string;
    if (char === '\\') i += 2;
    else if (endsTerm(char)) break;
    else i += 1;
  }
  return Math.min(i, search.length);
}

/** Lucene lexes these as operators wherever they stand alone, even right after a `field:`. */
const OPERATOR_WORDS = new Set(['AND', '&&', 'OR', '||', 'NOT']);

/**
 * Index of the first unescaped character in `stops` at or after `from`, or
 * `limit` when there is none before it.
 */
function delimiterAt(search: string, from: number, limit: number, stops: string): number {
  let i = from;
  while (i < limit && !stops.includes(search[i] as string)) i += search[i] === '\\' ? 2 : 1;
  return Math.min(i, limit);
}

/** A phrase, range, or regular expression opened at `at`, read to its closer. */
interface Delimited {
  readonly next: number;
  readonly value: ClauseValue;
}

function readPhrase(search: string, at: number): Delimited {
  const close = delimiterAt(search, at + 1, search.length, '"');
  return {
    value: { kind: 'term', quoted: true, span: { start: at + 1, end: close } },
    next: Math.min(close + 1, search.length),
  };
}

function readRegexp(search: string, at: number): Delimited {
  const close = delimiterAt(search, at + 1, search.length, '/');
  return {
    value: { kind: 'regexp', span: { start: at + 1, end: close } },
    next: Math.min(close + 1, search.length),
  };
}

/**
 * A range runs to the first unescaped `]` or `}`, the same extent the delimiter
 * guard gives it. Inside, bounds are separated by whitespace; a bound opening
 * with a quote that closes inside the range is quoted, and a standalone `TO` is
 * the separator, not a bound.
 */
function readRange(search: string, at: number): Delimited {
  const close = delimiterAt(search, at + 1, search.length, ']}');
  const bounds: RangeBound[] = [];
  let i = at + 1;
  while (i < close) {
    if (isSpace(search[i])) {
      i += 1;
      continue;
    }
    if (search[i] === '"') {
      const quoteEnd = delimiterAt(search, i + 1, close, '"');
      if (quoteEnd < close) {
        bounds.push({ quoted: true, span: { start: i + 1, end: quoteEnd } });
        i = quoteEnd + 1;
        continue;
      }
    }
    let end = i;
    while (end < close && !isSpace(search[end])) end += search[end] === '\\' ? 2 : 1;
    end = Math.min(end, close);
    if (search.slice(i, end) !== 'TO') bounds.push({ quoted: false, span: { start: i, end } });
    i = end;
  }
  return {
    value: {
      kind: 'range',
      bounds,
      lowerInclusive: search[at] === '[',
      upperInclusive: search[close] !== '}',
    },
    next: Math.min(close + 1, search.length),
  };
}

/** The phrase, range, or regular expression opened at `at`, if one opens there. */
function readDelimited(search: string, at: number): Delimited | undefined {
  const char = search[at];
  if (char === '"') return readPhrase(search, at);
  if (char === '[' || char === '{') return readRange(search, at);
  if (char === '/') return readRegexp(search, at);
  return;
}

const EXISTENCE_FIELDS = new Set(['_exists_', '_missing_']);

/** The field a clause tests: `_exists_`/`_missing_` read their value as the field, and `.exact` is dropped. */
function leafOf(search: string, field: string, value: ClauseValue): string {
  const named =
    EXISTENCE_FIELDS.has(field) && value.kind === 'term'
      ? search.slice(value.span.start, value.span.end)
      : field;
  return named.endsWith('.exact') ? named.slice(0, -'.exact'.length) : named;
}

/** An open group during the scan, with the conjunction and modifier pending for its next operand. */
interface Frame {
  connector: Connector;
  /** The content span of a `field:( … )` group, closed when its `)` is reached. */
  readonly fieldSpan?: { end: number; start: number };
  readonly group: GroupNode;
  modifier: Modifier;
}

/**
 * Scan `search` once, left to right, into its clause tree. Iterative — an
 * explicit stack holds open groups — so neither nesting depth nor a run of
 * unclosed `(` reaches the call stack. Each character is read a bounded number
 * of times: a term, phrase, range, or expression is consumed once, and the
 * whitespace looked past for a `:` after a term is the only text read twice.
 * Unbalanced input still yields a tree: a stray `)`, `]`, `}`, or `:` is
 * skipped, and an unclosed phrase, range, or group runs to the end.
 */
function parseSearch(search: string): ParsedSearch {
  const root: GroupNode = { kind: 'group', depth: 0, field: undefined, operands: [] };
  const stack: Frame[] = [{ group: root, connector: undefined, modifier: undefined }];
  const fieldClauses: FieldClause[] = [];
  const clauseNodes: ClauseNode[] = [];

  const push = (frame: Frame, node: QueryNode) => {
    frame.group.operands.push({ connector: frame.connector, modifier: frame.modifier, node });
    frame.connector = undefined;
    frame.modifier = undefined;
  };
  const pushValue = (frame: Frame, field: string | undefined, value: ClauseValue) => {
    if (field === undefined) {
      push(frame, { kind: 'bare' });
      return;
    }
    const node: ClauseNode = { kind: 'clause', field, leaf: leafOf(search, field, value), value };
    clauseNodes.push(node);
    push(frame, node);
  };
  const openGroup = (frame: Frame, field: string | undefined, fieldSpan?: Frame['fieldSpan']) => {
    const group: GroupNode = { kind: 'group', depth: stack.length, field, operands: [] };
    push(frame, group);
    stack.push({
      group,
      connector: undefined,
      modifier: undefined,
      ...(fieldSpan ? { fieldSpan } : {}),
    });
  };

  let i = 0;
  while (i < search.length) {
    const char = search[i] as string;
    const frame = stack[stack.length - 1] as Frame;
    if (isSpace(char)) {
      i += 1;
      continue;
    }

    const delimited = readDelimited(search, i);
    if (delimited) {
      pushValue(frame, frame.group.field, delimited.value);
      i = delimited.next;
      continue;
    }

    switch (char) {
      case '(':
        openGroup(frame, frame.group.field);
        i += 1;
        continue;
      case ')': {
        if (stack.length > 1) {
          const closed = stack.pop() as Frame;
          if (closed.fieldSpan) closed.fieldSpan.end = i;
        }
        i += 1;
        continue;
      }
      case '+':
        frame.modifier = 'required';
        i += 1;
        continue;
      case '-':
      case '!':
        frame.modifier = 'prohibited';
        i += 1;
        continue;
      case '^':
      case '~': {
        // A boost or fuzzy suffix and its number qualify the previous operand.
        i += 1;
        while (i < search.length && '0123456789.'.includes(search[i] as string)) i += 1;
        continue;
      }
    }
    if (!startsTerm(char)) {
      i += 1; // A stray `]`, `}`, or `:`.
      continue;
    }

    const end = termEnd(search, i);
    const text = search.slice(i, end);
    if (text === 'AND' || text === '&&') frame.connector = 'and';
    else if (text === 'OR' || text === '||') frame.connector = 'or';
    else if (text === 'NOT') frame.modifier = 'prohibited';
    else {
      let colon = end;
      while (isSpace(search[colon])) colon += 1;
      if (search[colon] !== ':') {
        pushValue(frame, frame.group.field, {
          kind: 'term',
          quoted: false,
          span: { start: i, end },
        });
        i = end;
        continue;
      }
      let at = colon + 1;
      while (isSpace(search[at])) at += 1;
      const value = readDelimited(search, at);
      if (value) {
        fieldClauses.push({ field: text, value: value.value });
        pushValue(frame, text, value.value);
        i = value.next;
      } else if (search[at] === '(') {
        const span = { start: at + 1, end: search.length };
        fieldClauses.push({ field: text, value: { kind: 'group', span } });
        openGroup(frame, text, span);
        i = at + 1;
      } else {
        // `field:` with no value after it — or an operator word, which Lucene lexes as one — names nothing.
        const valueEnd = startsTerm(search[at]) ? termEnd(search, at) : at;
        if (valueEnd === at || OPERATOR_WORDS.has(search.slice(at, valueEnd))) {
          i = at;
          continue;
        }
        const term: ClauseValue = {
          kind: 'term',
          quoted: false,
          span: { start: at, end: valueEnd },
        };
        fieldClauses.push({ field: text, value: term });
        pushValue(frame, text, term);
        i = valueEnd;
      }
      continue;
    }
    i = end;
  }
  return { root, fieldClauses, clauseNodes };
}

/* --- exports --- */

/**
 * The dotted field paths a `search` names, distinct, in order of first
 * appearance: each `field:` prefix outside a quoted phrase or a range, with a
 * trailing `.exact` dropped, and the field an `_exists_:` or `_missing_:` clause
 * names in its value. A `field:( … )` group names its field once. A value
 * without a field prefix names nothing.
 */
export function fieldPathsNamed(search: string): string[] {
  return [...new Set(parseSearch(search).clauseNodes.map((node) => node.leaf))];
}

/**
 * Every explicit `field:value` clause in `search`, in source order, with the
 * span of its value in the string as given — offsets a caller can rewrite from
 * in place, right to left. `field` is the path as written (`.exact` kept;
 * `_exists_`/`_missing_` appear as written, their value naming the field). A
 * `field:( … )` group is one clause of kind `group`, spanning the text inside
 * its parentheses; the values inside it are not listed separately, but explicit
 * `field:` clauses inside any group are.
 */
export function scanFieldClauses(search: string): FieldClause[] {
  return [...parseSearch(search).fieldClauses];
}

/* --- clauses tied to one array element --- */

/**
 * Fold the group tree under `root` bottom-up without recursion. `enter` gives a
 * subgroup operand the context its group is read in, from its parent's; `leaf`
 * reads a clause or bare operand in its group's context; `exit` combines a
 * group's operand results, which arrive aligned with `group.operands`.
 */
function foldGroups<C, R>(
  root: GroupNode,
  rootContext: C,
  visit: {
    enter: (operand: Operand, group: GroupNode, parent: C) => C;
    exit: (group: GroupNode, context: C, results: readonly R[]) => R;
    leaf: (operand: Operand, context: C) => R;
  },
): R {
  interface Step {
    readonly context: C;
    readonly group: GroupNode;
    readonly results: R[];
  }
  const stack: Step[] = [{ group: root, context: rootContext, results: [] }];
  for (;;) {
    const step = stack[stack.length - 1] as Step;
    const next = step.group.operands[step.results.length];
    if (next === undefined) {
      const result = visit.exit(step.group, step.context, step.results);
      stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent) return result;
      parent.results.push(result);
    } else if (next.node.kind === 'group') {
      const context = visit.enter(next, next.node, step.context);
      stack.push({ group: next.node, context, results: [] });
    } else {
      step.results.push(visit.leaf(next, step.context));
    }
  }
}

/** How Lucene's boolean query holds an operand: required, prohibited, or optional. */
type Occur = 'must' | 'must_not' | 'should';

/**
 * Each operand's occur, as Lucene's classic parser assigns it with OR as the
 * default operator: `+` requires and `-`/`NOT` prohibits; `AND` requires the
 * operands on both sides of it, unless one is prohibited; anything else is
 * optional.
 */
function occursOf(operands: readonly Operand[]): Occur[] {
  const occurs: Occur[] = [];
  for (const { connector, modifier } of operands) {
    if (connector === 'and' && occurs[occurs.length - 1] === 'should') {
      occurs[occurs.length - 1] = 'must';
    }
    occurs.push(
      modifier === 'prohibited'
        ? 'must_not'
        : modifier === 'required' || connector === 'and'
          ? 'must'
          : 'should',
    );
  }
  return occurs;
}

/**
 * Which operands of a group hold, or are excluded, on every match of it: each
 * required and prohibited one, and a lone optional one in a group with no
 * required operand, which must then match. Beside a required operand an
 * optional one never has to match. Read from {@link occursOf}, so an `OR` in
 * the group frees only the operands it leaves optional: Lucene reads
 * `a AND b OR c` as `+a +b c`, and openFDA answers it with the total of
 * `a AND b`. A prohibited operand is joined by its `-` or `NOT`, so `a -b`
 * ties both sides and `a b` neither.
 */
function heldOnEveryMatch(occurs: readonly Occur[]): boolean[] {
  const loneOptional =
    !occurs.includes('must') && occurs.filter((occur) => occur === 'should').length === 1;
  return occurs.map((occur) => occur !== 'should' || loneOptional);
}

/** Whether `path` is `array` itself or sits under it. */
function within(path: string, array: string): boolean {
  return path === array || path.startsWith(`${array}.`);
}

/** The deepest listed array a field sits strictly under, if any. */
function deepestArray(leaf: string, arrayPaths: readonly string[]): string | undefined {
  let deepest: string | undefined;
  for (const array of arrayPaths) {
    if (leaf.startsWith(`${array}.`) && (!deepest || array.length > deepest.length)) {
      deepest = array;
    }
  }
  return deepest;
}

/**
 * For each array path, up to two distinct fields under it for each negation
 * parity (index 0 even, 1 odd). Two per side is enough to find a pair on
 * different fields whenever one exists, so a group's summary stays bounded by
 * the number of array paths, whatever the size of its subtree.
 */
type Summary = Map<string, [string[], string[]]>;

function addLeaf(summary: Summary, array: string, parity: 0 | 1, leaf: string): void {
  let sides = summary.get(array);
  if (!sides) {
    sides = [[], []];
    summary.set(array, sides);
  }
  const side = sides[parity];
  if (side.length < 2 && !side.includes(leaf)) side.push(leaf);
}

function mergeSummary(target: Summary, source: Summary): void {
  for (const [array, sides] of source) {
    for (const parity of [0, 1] as const) {
      for (const leaf of sides[parity]) addLeaf(target, array, parity, leaf);
    }
  }
}

/**
 * A field from `earlier` and a different one from `later`, at least one of
 * them positive — its parity equal to `parity`, the group's own.
 */
function differentFields(
  earlier: [string[], string[]],
  later: [string[], string[]],
  parity: 0 | 1,
): [string, string] | undefined {
  for (const a of [0, 1] as const) {
    for (const b of [0, 1] as const) {
      if (a !== parity && b !== parity) continue;
      for (const first of earlier[a]) {
        const second = later[b].find((leaf) => leaf !== first);
        if (second !== undefined) return [first, second];
      }
    }
  }
  return;
}

/** A pair of fields under one array conjoined at `group`, their lowest common group. */
interface Tie {
  readonly array: string;
  readonly fields: readonly [string, string];
  readonly group: GroupNode;
}

/**
 * Every conjoined pair of clauses on different fields under one listed array,
 * at most one per array per group. A pair counts at its lowest common group
 * when both sides are operands that group holds on every match
 * ({@link heldOnEveryMatch}); at least one side must be a positive clause
 * relative to that group. The cross-operand check at each group
 * compares bounded summaries ({@link Summary}), so the walk is linear in the
 * number of clauses times the number of array paths.
 */
function findTies(root: GroupNode, arrayPaths: readonly string[]): Tie[] {
  const ties: Tie[] = [];
  const negated = (operand: Operand) => (operand.modifier === 'prohibited' ? 1 : 0);

  // A group's context is its negation parity from the root, its own modifier included.
  foldGroups<0 | 1, Summary>(root, 0, {
    enter: (operand, _group, parent) => (parent ^ negated(operand)) as 0 | 1,
    leaf: (operand, parity) => {
      const summary: Summary = new Map();
      if (operand.node.kind !== 'clause') return summary;
      const own = (parity ^ negated(operand)) as 0 | 1;
      for (const array of arrayPaths) {
        if (operand.node.leaf.startsWith(`${array}.`))
          addLeaf(summary, array, own, operand.node.leaf);
      }
      return summary;
    },
    exit: (group, parity, results) => {
      const held = heldOnEveryMatch(occursOf(group.operands));
      const seen: Summary = new Map();
      const total: Summary = new Map();
      const fired = new Set<string>();
      results.forEach((summary, index) => {
        if (held[index]) {
          for (const [array, sides] of summary) {
            const earlier = seen.get(array);
            if (!earlier || fired.has(array)) continue;
            const fields = differentFields(earlier, sides, parity);
            if (fields) {
              fired.add(array);
              ties.push({ array, fields, group });
            }
          }
          mergeSummary(seen, summary);
        }
        mergeSummary(total, summary);
      });
      return total;
    },
  });
  return ties;
}

/* --- the per-element SQL filter --- */

/** One array level of the filter: the JSON array its EXISTS unnests and the alias of its element. */
interface ArrayLevel {
  readonly alias: string;
  /** The enclosing level's path; absent on the top array. */
  readonly parent?: string;
  readonly path: string;
  readonly source: string;
}

/**
 * SQL text as nested fragments, joined once by {@link renderSql}: each group
 * wraps its operands' text without copying it, so a deeply nested query costs
 * no more to render than a flat one.
 */
type Sql = string | readonly Sql[];

/** A SQL condition. `enclosed` when it can be negated without parentheses (an EXISTS, or a parenthesized list). */
interface Condition {
  readonly enclosed: boolean;
  readonly sql: Sql;
}

/**
 * A node's translation at one array level. `parts` are conditions on that
 * level's element, all of which must hold; none when nothing in the node can be
 * stated per element. `leaf` is set on a clause.
 */
interface Translation {
  readonly leaf?: string;
  readonly level: string;
  readonly parts: readonly Condition[];
}

function renderSql(sql: Sql): string {
  const out: string[] = [];
  const pending: Sql[] = [sql];
  while (pending.length > 0) {
    const next = pending.pop() as Sql;
    if (typeof next === 'string') out.push(next);
    else for (let i = next.length - 1; i >= 0; i -= 1) pending.push(next[i] as Sql);
  }
  return out.join('');
}

const joined = (conditions: readonly Condition[], operator: string): Sql[] =>
  conditions.flatMap((condition, index) =>
    index === 0 ? [condition.sql] : [operator, condition.sql],
  );

const all = (conditions: readonly Condition[]): Condition =>
  conditions.length === 1
    ? (conditions[0] as Condition)
    : { enclosed: true, sql: ['(', joined(conditions, ' AND '), ')'] };
const any = (conditions: readonly Condition[]): Condition =>
  conditions.length === 1
    ? (conditions[0] as Condition)
    : { enclosed: true, sql: ['(', joined(conditions, ' OR '), ')'] };
const not = (condition: Condition): Condition => ({
  enclosed: false,
  sql: condition.enclosed ? ['NOT ', condition.sql] : ['NOT (', condition.sql, ')'],
});
const plain = (sql: string): Condition => ({ enclosed: false, sql });

const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** A query value with each backslash escape resolved to the character it escapes. */
const unescaped = (text: string) => text.replace(/\\(.)/gsu, '$1');

/** An unquoted term as a LIKE pattern: `*` and `?` are Lucene's wildcards, and an escaped one is literal. */
function likePattern(term: string): string {
  let pattern = '';
  for (let i = 0; i < term.length; i += 1) {
    const char = term[i] as string;
    if (char === '\\' && i + 1 < term.length) {
      i += 1;
      pattern += term[i];
    } else pattern += char === '*' ? '%' : char === '?' ? '_' : char;
  }
  return pattern;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * The condition one clause puts on an element at `level`, or undefined when it
 * cannot be stated per element — a regular expression, a range with a bound
 * that is not a number (date math included), or a wildcard field name.
 *
 * Every condition is a relaxation of openFDA's own match, never a tightening,
 * so the filter can only keep a record that openFDA's per-record answer also
 * kept: a term or phrase is a case-insensitive substring match (`ILIKE`), or a
 * case-sensitive one (`LIKE`) on an `.exact` field, since a stored value can
 * hold more words than the query and can be a list of strings; a numeric range
 * compares numerically; `_exists_`/`_missing_` test for a value. A `%` or `_`
 * in a value stays as written, so it matches as a SQL wildcard, wider than the
 * literal character and in keeping with that relaxation.
 */
function clauseCondition(
  search: string,
  node: ClauseNode,
  level: ArrayLevel,
): Condition | undefined {
  const path = node.leaf.slice(level.path.length + 1).split('.');
  if (path.some((key) => key.includes('*') || key.includes('?'))) return;
  const parents = path.slice(0, -1).map((key) => `->${sqlString(key)}`);
  const value = `${level.alias}${parents.join('')}->>${sqlString(path[path.length - 1] as string)}`;

  if (node.field === '_exists_') return plain(`${value} IS NOT NULL`);
  if (node.field === '_missing_') return plain(`${value} IS NULL`);
  const like = node.field.endsWith('.exact') ? 'LIKE' : 'ILIKE';
  const clause = node.value;
  if (clause.kind === 'term') {
    const text = search.slice(clause.span.start, clause.span.end);
    const pattern = clause.quoted ? unescaped(text) : likePattern(text);
    return plain(`${value} ${like} ${sqlString(`%${pattern}%`)}`);
  }
  if (clause.kind !== 'range' || clause.bounds.length !== 2) return;
  const [lower, upper] = clause.bounds.map(({ quoted, span }) => {
    const text = search.slice(span.start, span.end);
    return !quoted && text === '*' ? undefined : unescaped(text);
  });
  if ([lower, upper].some((bound) => bound !== undefined && !NUMBER.test(bound))) return;
  const number = `TRY_CAST(${value} AS DOUBLE)`;
  const sides = [
    lower === undefined ? undefined : `${number} ${clause.lowerInclusive ? '>=' : '>'} ${lower}`,
    upper === undefined ? undefined : `${number} ${clause.upperInclusive ? '<=' : '<'} ${upper}`,
  ].flatMap((side) => (side === undefined ? [] : [plain(side)]));
  return sides.length > 0 ? all(sides) : plain(`${value} IS NOT NULL`);
}

/**
 * The array levels under `top`, keyed by path. The top array is unnested from
 * its column (`t.drug`), or from inside an object column
 * (`json_extract(t.patient, '$.drug')`); a nested array from its parent's
 * element (`d->'active_ingredients'`). Each element alias is the initial of the
 * array's last key, numbered when the table alias `t` or an enclosing level
 * already holds it.
 */
function arrayLevels(top: string, arrayPaths: readonly string[]): Map<string, ArrayLevel> {
  const levels = new Map<string, ArrayLevel>();
  const nested = arrayPaths
    .filter((path) => within(path, top))
    .sort((a, b) => a.split('.').length - b.split('.').length);
  for (const path of nested) {
    const parent = [...levels.values()]
      .filter((level) => path.startsWith(`${level.path}.`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const keys = (parent ? path.slice(parent.path.length + 1) : path).split('.');
    let source: string;
    if (parent) source = `${parent.alias}${keys.map((key) => `->${sqlString(key)}`).join('')}`;
    else {
      const [column, ...rest] = keys as [string, ...string[]];
      const ref = /^[A-Za-z_][A-Za-z0-9_]*$/.test(column)
        ? `t.${column}`
        : `t."${column.replaceAll('"', '""')}"`;
      source =
        rest.length === 0 ? ref : `json_extract(${ref}, ${sqlString(`$.${rest.join('.')}`)})`;
    }
    const taken = new Set(['t']);
    for (const level of levels.values())
      if (path.startsWith(`${level.path}.`)) taken.add(level.alias);
    const last = keys[keys.length - 1] as string;
    const initial = /^[a-z]/i.test(last) ? last.charAt(0).toLowerCase() : 'e';
    let alias = initial;
    for (let n = 2; taken.has(alias); n += 1) alias = `${initial}${n}`;
    levels.set(path, { alias, path, source, ...(parent ? { parent: parent.path } : {}) });
  }
  return levels;
}

function existsOver(level: ArrayLevel, condition: Sql): Condition {
  return {
    enclosed: true,
    sql: [
      `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(${level.source}, '["json"]')) AS ${level.alias}) WHERE `,
      condition,
      ')',
    ],
  };
}

/**
 * Translate the firing group's subtree into conditions on one element of
 * `top`, keeping Lucene's boolean semantics ({@link occursOf}): required and
 * prohibited operands all hold, and optional ones count only in a group with
 * no required operand, where at least one must hold. A clause outside `top`
 * states nothing per element (the staged rows already met it), and an optional
 * operand that states nothing leaves its whole disjunction unstated — each step
 * a relaxation, so the filter never drops a record openFDA's answer would keep
 * and that has one element meeting every tied clause.
 *
 * Required and prohibited operands under a nested array go into one EXISTS
 * over it when that ties anything — two or more of them, one required, not all
 * the same field — one level of EXISTS per array level. A field named twice is
 * two elements (`active_ingredients.name:"A" AND active_ingredients.name:"B"`),
 * so those, like a lone operand, get an EXISTS each.
 *
 * `fields` lists the clauses' fields under `named`, the array the notice
 * names: `top` itself, or an array under it when `top` holds one entry per
 * record.
 */
function tieFilter(
  search: string,
  group: GroupNode,
  top: string,
  named: string,
  arrayPaths: readonly string[],
): { fields: string[]; filter: string } {
  const levels = arrayLevels(top, arrayPaths);
  const inTop = [...levels.keys()];
  const levelOf = (path: string) => levels.get(path) as ArrayLevel;

  /** An operand's translation as its group combines it. */
  interface Item {
    readonly condition: Condition;
    readonly leaf?: string;
    readonly level: string;
    readonly occur: Occur;
  }

  /** The array directly under `level` on the way down to `deeper`. */
  const childToward = (level: string, deeper: string) => {
    let child = levelOf(deeper);
    while (child.parent !== level) child = levelOf(child.parent as string);
    return child.path;
  };

  /** A condition on an element at `item.level`, wrapped in one EXISTS per level up to `level`. */
  const lift = (item: Item, level: string): Condition => {
    let condition = item.condition;
    for (let at = levelOf(item.level); at.path !== level; at = levelOf(at.parent as string)) {
      condition = existsOver(at, condition.sql);
    }
    return condition;
  };

  /** Required and prohibited items on elements at `level` or below, as conditions on its element. */
  const combine = (level: string, items: readonly Item[]): Condition[] => {
    const parts: Condition[] = [];
    const children = new Map<string, Item[]>();
    for (const item of items) {
      if (item.level === level) {
        parts.push(item.occur === 'must' ? item.condition : not(item.condition));
        continue;
      }
      const child = childToward(level, item.level);
      const held = children.get(child);
      if (held) held.push(item);
      else children.set(child, [item]);
    }
    for (const [child, held] of children) {
      const leaves = new Set(held.map((item) => item.leaf));
      const oneField = leaves.size === 1 && !leaves.has(undefined);
      if (held.length > 1 && !oneField && held.some((item) => item.occur === 'must')) {
        parts.push(existsOver(levelOf(child), joined(combine(child, held), ' AND ')));
      } else {
        for (const item of held) {
          const lifted = lift(item, level);
          parts.push(item.occur === 'must' ? lifted : not(lifted));
        }
      }
    }
    return parts;
  };

  // The deepest array holding every clause of each subgroup, read bottom-up first.
  const commonArray = new Map<GroupNode, string | undefined>();
  foldGroups<undefined, string | undefined>(group, undefined, {
    enter: () => undefined,
    leaf: (operand) =>
      operand.node.kind === 'clause' ? deepestArray(operand.node.leaf, inTop) : undefined,
    exit: (node, _context, results) => {
      let common = results.length > 0 ? results[0] : undefined;
      for (const next of results.slice(1)) {
        if (common === undefined || next === undefined) common = undefined;
        else {
          const a: string = common;
          common = inTop
            .filter((array) => within(a, array) && within(next, array))
            .sort((x, y) => y.length - x.length)[0];
        }
      }
      commonArray.set(node, common);
      return common;
    },
  });

  const fields = new Set<string>();
  const result = foldGroups<ArrayLevel, Translation>(group, levelOf(top), {
    // A subgroup whose clauses all sit under one deeper array is read at that array's level.
    enter: (_operand, node, parent) => {
      const common = commonArray.get(node);
      return levelOf(common !== undefined && within(common, parent.path) ? common : parent.path);
    },
    leaf: (operand, level) => {
      const node = operand.node;
      if (node.kind !== 'clause' || !node.leaf.startsWith(`${level.path}.`)) {
        return { level: level.path, parts: [] };
      }
      if (within(node.leaf, named)) fields.add(node.leaf);
      const own = levelOf(deepestArray(node.leaf, inTop) as string);
      const condition = clauseCondition(search, node, own);
      return { level: own.path, leaf: node.leaf, parts: condition ? [condition] : [] };
    },
    exit: (node, level, results) => {
      const occurs = occursOf(node.operands);
      const held: Item[] = [];
      const optional: Condition[] = [];
      let optionalUnstated = false;
      results.forEach((translation, index) => {
        const occur = occurs[index] as Occur;
        if (translation.parts.length === 0) {
          if (occur === 'should') optionalUnstated = true;
          return;
        }
        const item: Item = {
          condition: all(translation.parts),
          level: translation.level,
          occur,
          ...(translation.leaf ? { leaf: translation.leaf } : {}),
        };
        if (occur === 'should') optional.push(lift(item, level.path));
        else held.push(item);
      });
      const parts = combine(level.path, held);
      if (!occurs.includes('must') && optional.length > 0 && !optionalUnstated) {
        parts.push(any(optional));
      }
      return { level: level.path, parts };
    },
  });

  const condition = result.parts.length > 0 ? joined(result.parts, ' AND ') : '…';
  return { fields: [...fields], filter: renderSql(existsOver(levelOf(top), condition).sql) };
}

/** A search's clauses that one array's elements can split, and the filter that ties them. */
interface ConjoinedArrayClauses {
  /**
   * The array whose entries can split the clauses: the top array of the tie (a
   * listed path with no listed array above it), or, where that array holds one
   * entry per record, the shallowest array under it holding a pair.
   */
  readonly array: string;
  /** The fields under that array the tied group names, in source order. */
  readonly fields: readonly string[];
  /**
   * A SQL condition over a staged table aliased `t` — an EXISTS over the top
   * array's elements, one nested EXISTS per nested array level — that holds
   * when one element meets the tied clauses together.
   */
  readonly filter: string;
}

/**
 * The clauses of `search` that openFDA can satisfy from different elements of
 * one array of objects, since it tests each clause against the whole record.
 * `arrayPaths` lists the endpoint's arrays of objects as full dotted paths
 * (`drug`, `drug.active_ingredients`); a path whose parent is not listed sits
 * under a plain object (`patient.drug`). `singleEntryArrays` names those that
 * hold one entry on every record: clauses on such an array's own fields cannot
 * split, while an array listed under it still can.
 *
 * A pair is two clauses on different fields (`.exact` dropped;
 * `_exists_:`/`_missing_:` count on the field they name) under one listed array,
 * conjoined at their lowest common group: both are operands that group holds on
 * every match, as Lucene's OR-default parser reads it — required by `AND`, `&&`,
 * or `+` (so `a AND b OR c`, read `+a +b c`, ties `a` and `b`), prohibited, or the
 * lone optional operand of a group with no required one; a `NOT`/`-` clause
 * beside a positive one counts, two negated ones do not. One entry per top array — or,
 * under a single-entry top array, per shallowest array below it holding a pair —
 * built from its outermost group holding a pair, in `arrayPaths` order. The
 * filter always unnests from the top array's column.
 */
export function findConjoinedArrayClauses(
  search: string,
  arrayPaths: readonly string[],
  singleEntryArrays: readonly string[] = [],
): ConjoinedArrayClauses[] {
  const splittable = arrayPaths.filter((path) => !singleEntryArrays.includes(path));
  const ties = findTies(parseSearch(search).root, splittable);
  const shallowest = (paths: readonly string[], array: string) =>
    paths.filter((path) => within(array, path)).sort((a, b) => a.length - b.length)[0] as string;
  const outermost = new Map<string, GroupNode>();
  for (const tie of ties) {
    const named = shallowest(splittable, tie.array);
    const held = outermost.get(named);
    if (!held || tie.group.depth < held.depth) outermost.set(named, tie.group);
  }
  return splittable
    .filter((path) => outermost.has(path))
    .map((named) => ({
      array: named,
      ...tieFilter(
        search,
        outermost.get(named) as GroupNode,
        shallowest(arrayPaths, named),
        named,
        arrayPaths,
      ),
    }));
}

/**
 * Where the notice sends the caller for the per-element answer: `restage` on a
 * search tool's inline page (call again with `stage: true`; `byCursor` when the
 * page was read by `cursor`, which a staged call refuses, so the notice says to
 * drop it), `staged` when the call staged (name its table), `search_tool` on
 * `openfda_count_values` (stage the search with the endpoint's search tool;
 * `selector` is the input that tool needs to reach the endpoint, written
 * `name: "value"`).
 */
export type ArrayTieRoute =
  | { readonly kind: 'restage'; readonly byCursor?: boolean | undefined }
  | { readonly kind: 'staged'; readonly table: string }
  | {
      readonly kind: 'search_tool';
      readonly tool: string;
      readonly selector?: string | undefined;
    };

/** The call that stages the search, as the notice words it. */
function stagingCall(route: Exclude<ArrayTieRoute, { kind: 'staged' }>): string {
  if (route.kind === 'search_tool') {
    return `stage this search with ${route.tool} (${route.selector ? `${route.selector}, ` : ''}stage: true)`;
  }
  return route.byCursor
    ? 'call again without cursor and with stage: true,'
    : 'call again with stage: true';
}

const listed = (items: readonly string[]) =>
  items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

/**
 * The notice for a matched search whose conjoined clauses fall under one array
 * of objects ({@link findConjoinedArrayClauses}), or `undefined` when there is
 * nothing to say: no search, a total of 0 (every per-element match is also a
 * per-record one, so an empty result cannot be this mistake), or no such pair.
 * Names each array and its fields, and the staged route to a per-element
 * answer with its SQL condition. Caller text rides as code literals.
 *
 * Wiring: pass the parsed `input.search`, the result's total, the endpoint's
 * array paths, the route, and the endpoint's single-entry arrays where the
 * catalog lists any; append the returned text to the tool's notices.
 */
export function arrayTieNotice(
  search: string | undefined,
  total: number,
  arrayPaths: readonly string[],
  route: ArrayTieRoute,
  singleEntryArrays: readonly string[] = [],
): string | undefined {
  if (search === undefined || total === 0) return;
  const tied = findConjoinedArrayClauses(search, arrayPaths, singleEntryArrays);
  if (tied.length === 0) return;
  return tied
    .map(({ array, fields, filter }) => {
      const where = `WHERE ${filter}`;
      const next =
        route.kind === 'staged'
          ? `query the staged table in openfda_dataframe_query: ${codeLiteral(`SELECT * FROM ${route.table} t ${where}`)}`
          : `${stagingCall(route)} and query the staged table, aliased t, in openfda_dataframe_query: ${codeLiteral(where)}`;
      return `openFDA matches each clause against the whole record, so the clauses on ${listed(fields.map((field) => codeLiteral(field)))} can be met by different ${codeLiteral(array)} entries. For one entry meeting them together, ${next}.`;
    })
    .join(' ');
}

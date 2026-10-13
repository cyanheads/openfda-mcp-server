/**
 * @fileoverview Unit tests for shared formatting helpers.
 * @module tests/mcp-server/tools/format-utils
 */

import { describe, expect, it } from 'vitest';
import {
  emptyPageBody,
  emptyResultMessage,
  escapeTableCell,
  escapeTableCellFragment,
  formatCell,
  formatRemainingFields,
  humanizeField,
  lineContent,
  noMatchNote,
  projectedRecordLines,
  resultHeader,
  searchLead,
  singleLine,
  truncate,
} from '@/mcp-server/tools/format-utils.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

describe('truncate', () => {
  it('returns value unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and appends ellipsis when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('returns N/A for undefined', () => {
    expect(truncate(undefined, 100)).toBe('N/A');
  });

  it('returns N/A for null', () => {
    expect(truncate(null, 100)).toBe('N/A');
  });

  it('returns N/A for empty string', () => {
    expect(truncate('', 100)).toBe('N/A');
  });

  it('handles exact-length strings without appending ellipsis', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles single-char strings', () => {
    expect(truncate('x', 1)).toBe('x');
  });

  it('handles unicode characters correctly', () => {
    const value = 'cafébistro';
    expect(truncate(value, 4)).toBe('café...');
  });
});

describe('humanizeField', () => {
  it('replaces underscores with spaces', () => {
    expect(humanizeField('brand_name')).toBe('Brand name');
  });

  it('capitalizes the first character', () => {
    expect(humanizeField('report_date')).toBe('Report date');
  });

  it('handles single-word keys', () => {
    expect(humanizeField('status')).toBe('Status');
  });

  it('handles already-capitalized keys', () => {
    expect(humanizeField('NDC')).toBe('NDC');
  });

  it('handles multiple underscores', () => {
    expect(humanizeField('reason_for_recall')).toBe('Reason for recall');
  });

  it('handles keys with no underscores', () => {
    expect(humanizeField('applicant')).toBe('Applicant');
  });
});

describe('formatRemainingFields', () => {
  it('skips fields in the rendered set', () => {
    const record = { name: 'test', skip_me: 'value' };
    const lines = formatRemainingFields(record, new Set(['skip_me']));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Name');
    expect(lines.join()).not.toContain('Skip me');
  });

  it('renders string fields as label-value pairs', () => {
    const record = { product_code: 'DXN' };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Product code:** DXN');
  });

  it('renders number fields', () => {
    const record = { count: 42 };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Count:** 42');
  });

  it('renders boolean fields', () => {
    const record = { active: true };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Active:** true');
  });

  it('renders primitive arrays as comma-joined', () => {
    const record = { routes: ['ORAL', 'TOPICAL'] };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Routes:** ORAL, TOPICAL');
  });

  it('skips null values', () => {
    const record = { name: null, status: 'active' };
    const lines = formatRemainingFields(record as Record<string, unknown>, new Set());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Status');
  });

  it('skips undefined values', () => {
    const record = { name: undefined, status: 'active' };
    const lines = formatRemainingFields(record as Record<string, unknown>, new Set());
    expect(lines).toHaveLength(1);
  });

  it('skips empty string values', () => {
    const record = { name: '', status: 'active' };
    const lines = formatRemainingFields(record, new Set());
    expect(lines).toHaveLength(1);
  });

  it('skips empty arrays', () => {
    const record = { tags: [], status: 'active' };
    const lines = formatRemainingFields(record, new Set());
    expect(lines).toHaveLength(1);
  });

  it('renders object fields as key=value pairs', () => {
    const record = { address: { city: 'Seattle', state: 'WA' } };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toContain('city=Seattle');
    expect(lines[0]).toContain('state=WA');
  });

  it('renders long values in full without truncation', () => {
    const longValue = 'x'.repeat(500);
    const record = { description: longValue };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe(`**Description:** ${longValue}`);
    expect(lines[0]).not.toContain('...');
  });

  it('returns empty array for empty record', () => {
    expect(formatRemainingFields({}, new Set())).toEqual([]);
  });

  it('skips arrays containing objects by falling back to JSON', () => {
    const record = { complex: [{ a: 1 }, { b: 2 }] };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toContain('Complex');
    expect(lines[0]).toContain('{');
  });

  // #67 — a raw line break in an upstream value would end the label line.
  it('flattens line breaks in every value shape so a value cannot open a list item or heading', () => {
    const lines = formatRemainingFields(
      {
        reproductive_status: 'Intact\n- item',
        note: 'a\r\n### x',
        address: { city: 'Sea\rttle', tags: ['p\nq'] },
        routes: ['ORAL\n> quoted', 'TOPICAL'],
      },
      new Set(),
    );
    expect(lines).toEqual([
      '**Reproductive status:** Intact - item',
      '**Note:** a ### x',
      '**Address:** city=Sea ttle; tags=p q',
      '**Routes:** ORAL > quoted, TOPICAL',
    ]);
  });

  it('keeps single-line values byte-identical, markup included', () => {
    const record = { lot: 'Lot #JKU4639A, Exp 10/2022', p: 'p<0.05', drug: 'CARBIDOPA\\LEVODOPA' };
    expect(formatRemainingFields(record, new Set())).toEqual([
      '**Lot:** Lot #JKU4639A, Exp 10/2022',
      '**P:** p<0.05',
      '**Drug:** CARBIDOPA\\LEVODOPA',
    ]);
  });
});

describe('emptyResultMessage', () => {
  it('returns base hint when skip is 0 and nothing matched', () => {
    const msg = emptyResultMessage(0, 0, 'Try different filters.');
    expect(msg).toBe('Try different filters.');
  });

  it('adds pagination context when skip > 0 and the total is unverified', () => {
    const msg = emptyResultMessage(10, 0, 'Try different filters.', true);
    expect(msg).toContain('skip=10');
    expect(msg).toContain('Try different filters.');
  });

  it('mentions skip=0 in the pagination hint', () => {
    const msg = emptyResultMessage(500, 0, 'Some hint.', true);
    expect(msg).toContain('skip=0');
  });

  // #47 — the service recovers the total at skip > 0, so a confirmed zero is a plain miss.
  it('returns the base hint alone when skip > 0 and the zero total is confirmed', () => {
    const msg = emptyResultMessage(10, 0, 'Try different filters.');
    expect(msg).toBe('Try different filters.');
  });

  it('says the offset overshot — not "no match" — when records did match', () => {
    const msg = emptyResultMessage(2000, 1175, 'Try different filters.');
    expect(msg).toContain('1175 matched');
    expect(msg).toContain('skip=2000');
    expect(msg).not.toContain('Try different filters.');
  });
});

describe('noMatchNote', () => {
  it('keeps the flat line when the zero total is confirmed, even at skip > 0', () => {
    expect(noMatchNote('No results found.', 40)).toBe('No results found.');
  });

  it('names both readings when the total behind an offset is unverified', () => {
    const note = noMatchNote('No results found.', 40, true);
    expect(note).toContain('No results found at skip=40');
    expect(note).toContain('either nothing matched or the offset ran past the end');
    expect(note).toContain('Retry with skip=0');
  });
});

// #68 — one header and lead for every search tool, on every branch.
describe('resultHeader', () => {
  const META = { total: 0, skip: 0, limit: 2, lastUpdated: '2026-07-31' };

  it('renders total, returned, skip, limit, and the dataset date', () => {
    expect(resultHeader(META, 0)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 2) | Data updated: 2026-07-31',
    );
  });

  it('names the response arm when given a kind', () => {
    expect(resultHeader({ ...META, total: 3 }, 1, 'outline')).toBe(
      '**3 total results** (returned: 1, skip: 0, limit: 2, kind: outline) | Data updated: 2026-07-31',
    );
  });

  it('renders the dataset date verbatim, never a substitute', () => {
    expect(resultHeader({ ...META, lastUpdated: 'unknown' }, 0)).toContain('Data updated: unknown');
  });
});

describe('searchLead', () => {
  const META = { total: 0, skip: 0, limit: 0, lastUpdated: '2026-06-01' };

  it('opens with the header alone when nothing staged and the page was not bounded', () => {
    expect(searchLead({ meta: META, results: [] })).toEqual([`${resultHeader(META, 0)}\n`]);
  });

  it('orders header, page-budget line, then staging line', () => {
    const lead = searchLead({
      meta: { ...META, total: 9, limit: 1 },
      results: [{}],
      page_bytes: 70_000,
      page_omitted: 4,
      canvas_id: 'cv_1',
      canvas_table: 'spilled_ab12cd34',
      spilled: true,
      staged_rows: 9,
    });
    expect(lead).toHaveLength(3);
    expect(lead[0]).toMatch(/^\*\*9 total results\*\*/);
    expect(lead[1]).toMatch(/^> Inline page bounded to 1 of the 5 records requested/);
    expect(lead[2]).toMatch(/^> Staged 9 of 9 matched rows/);
    for (const line of lead) expect(line.endsWith('\n')).toBe(true);
  });

  it('renders the staging line on a staged miss', () => {
    const lead = searchLead({
      meta: META,
      results: [],
      canvas_id: 'cv_1',
      spilled: false,
      staged_rows: 0,
    });
    expect(lead[1]).toBe('> Canvas `cv_1` acquired; no rows staged (spilled=false, 0 matched).\n');
  });

  it('places the fields projection line after the header and before the page-budget line (#66)', () => {
    const record = { report_id: 'r-1', code_info: 'c'.repeat(30_000) };
    const lead = searchLead({
      meta: { ...META, total: 1, limit: 10 },
      results: [record],
      projected_fields: ['code_info', 'missing.leaf'],
      page_bytes: JSON.stringify([record]).length,
      page_largest_fields: [{ path: 'code_info', bytes: 30_002 }],
    });
    expect(lead).toHaveLength(3);
    expect(lead[1]).toMatch(
      /^> Records projected to the requested fields \(code_info, missing\.leaf\)/,
    );
    expect(lead[1]).toContain('No record in this page carries missing.leaf');
    expect(lead[2]).toMatch(/^> Inline page exceeds the 24000-byte budget/);
    expect(lead[2]).toContain('code_info (30002 bytes)');
  });

  // #67 — every lead entry is one line; a field path is built from upstream record keys.
  it('keeps each lead entry on one line when an upstream key or date carries a line break', () => {
    const record = { blob: 'b'.repeat(50_000) };
    const lead = searchLead({
      meta: { ...META, total: 1, limit: 1, lastUpdated: '2026-06-01\n# forged' },
      results: [record],
      page_bytes: 50_011,
      page_largest_fields: [{ path: 'blob\n### forged', bytes: 50_002 }],
    });
    for (const entry of lead) expect(entry.indexOf('\n')).toBe(entry.length - 1);
    expect(lead[0]).toContain('Data updated: 2026-06-01 # forged');
    expect(lead[1]).toContain('blob ### forged (50002 bytes)');
  });
});

describe('projectedRecordLines', () => {
  const IDS = ['recall_number', 'product_res_number'] as const;

  it('heads the record with the first identity key it carries, then every other field verbatim', () => {
    const lines = projectedRecordLines(
      {
        product_res_number: 'Z-0030-2018',
        reason_for_recall: 'Leak',
        openfda: { device_name: 'PUMP' },
      },
      IDS,
    );
    expect(lines).toEqual([
      '### product_res_number: Z-0030-2018',
      '**Reason for recall:** Leak',
      '**Openfda:** device_name=PUMP',
    ]);
  });

  it('renders other identity keys the record carries as fields', () => {
    expect(
      projectedRecordLines({ report_number: 'R-1', mdr_report_key: 'K-2' }, [
        'safetyreportid',
        'report_number',
        'mdr_report_key',
      ]),
    ).toEqual(['### report_number: R-1', '**Mdr report key:** K-2']);
  });

  it('falls back to a bare heading, with no placeholder, when no identity key is present', () => {
    expect(projectedRecordLines({ serious: '1' }, IDS)).toEqual(['### Record', '**Serious:** 1']);
    expect(projectedRecordLines({}, IDS)).toEqual(['### Record']);
  });

  it('flattens a line break in the identity value so it cannot open a new heading', () => {
    expect(projectedRecordLines({ recall_number: 'D-1\n### forged' }, IDS)[0]).toBe(
      '### recall_number: D-1 ### forged',
    );
  });
});

describe('emptyPageBody', () => {
  it('renders the tool miss line when nothing matched', () => {
    expect(emptyPageBody({ meta: { total: 0, skip: 0 } }, 'No results found.')).toBe(
      'No results found.',
    );
  });

  it('qualifies the miss line when the zero total is unverified', () => {
    expect(
      emptyPageBody({ meta: { total: 0, skip: 40, totalUnverified: true } }, 'No results found.'),
    ).toContain('No results found at skip=40');
  });

  it('never renders the miss line for a query that matched records (#31)', () => {
    const body = emptyPageBody({ meta: { total: 12, skip: 40 } }, 'No results found.');
    expect(body).not.toContain('No results found');
    expect(body).toContain('skip=40 is past the end');
  });
});

// #67 — one escaper for every Markdown table cell, rendering each value as written.
describe('escapeTableCell', () => {
  it.each([
    ['<E>', '\\<E>'],
    ['a|b', 'a\\|b'],
    ['x\ny', 'x<br>y'],
    ['x\r\ny', 'x<br>y'],
    ['x\ry', 'x<br>y'],
    ['a\\|b', 'a\\\\\\|b'],
    ['*x*', '\\*x\\*'],
    ['[t](u)', '\\[t\\](u)'],
    ['&amp;', '\\&amp;'],
    ['&#169; &#x2020;', '\\&#169; \\&#x2020;'],
    ['<br>', '\\<br>'],
    ['</td> <!-- c --> <?x?>', '\\</td> \\<!-- c --> \\<?x?>'],
    ['`code` ~s~', '\\`code\\` \\~s\\~'],
    ['_lead trail_ a _b_', '\\_lead trail\\_ a \\_b\\_'],
    ['{"k":"x|y"}', '{"k":"x\\|y"}'],
    /** A backslash before a line break would otherwise escape the `<` of its `<br>`. */
    ['a\\\nb', 'a\\\\<br>b'],
  ])('escapes %j as %j', (value, escaped) => {
    expect(escapeTableCell(value)).toBe(escaped);
  });

  it.each([
    'recall_number',
    'p<0.05',
    'AT&T',
    'CARBIDOPA\\LEVODOPA',
    'Lot #JKU4639A, Exp 10/2022',
    'a > b',
  ])('leaves %j byte-identical', (value) => {
    expect(escapeTableCell(value)).toBe(value);
  });

  /**
   * GFM links a bare address from the raw text, so a backslash inside one shows
   * in the link and its href. An address marked and micromark both link whole is
   * emitted verbatim; the escapes resume after it.
   */
  it.each([
    'http://example.com/~user',
    'https://www.fda.gov/media/1/download/Posting%20for%20website%2010.6.23%20(2)[3].pdf',
    'See https://www.fda.gov/media/1/download/Posting%20(2)[3].pdf for details.',
    '(see https://en.wikipedia.org/wiki/Foo_(bar))',
    'Letters at http://www.example.com/~recall/letter_2023.pdf, www.example.com/~a~b.',
    'HTTPS://EXAMPLE.COM/*x*y',
  ])('keeps the autolink in %j verbatim', (value) => {
    expect(escapeTableCell(value)).toBe(value);
  });

  it('keeps a www autolink opened after an escaped marker verbatim', () => {
    expect(escapeTableCell('*www.example.com/~a*b')).toBe('\\*www.example.com/~a*b');
  });

  it('escapes text around a verbatim autolink as usual', () => {
    expect(escapeTableCell('*a* http://a.com/~b\n_c_ www.d.org/[e]')).toBe(
      '\\*a\\* http://a.com/~b<br>\\_c\\_ www.d.org/[e]',
    );
  });

  /**
   * An address the parsers would link differently — mid-word, `WWW.`, `ftp://`,
   * cut short by a `|`, `<`, `](`, or an unbalanced `(`, or trailing an emphasis
   * marker or a character reference — has its opener's `:` or `.` escaped, so
   * neither parser links it and every other character is escaped as plain text.
   */
  it.each([
    ['xhttp://a.com/~b', 'xhttp\\://a.com/\\~b'],
    ['WWW.a.com/~b', 'WWW\\.a.com/\\~b'],
    ['ftp://a.com/~b', 'ftp\\://a.com/\\~b'],
    ['http://a.com/a|b~', 'http\\://a.com/a\\|b\\~'],
    ['http://a.com/x~<b>', 'http\\://a.com/x\\~\\<b>'],
    ['http://a.com/x](y)~', 'http\\://a.com/x\\](y)\\~'],
    ['http://a.com/(x~', 'http\\://a.com/(x\\~'],
    ['http://a.com/x_', 'http\\://a.com/x\\_'],
    ['http://a.com/x*.', 'http\\://a.com/x\\*.'],
    ['http://a.com/x&amp;', 'http\\://a.com/x\\&amp;'],
    ['http://a_b.c_d/~e', 'http\\://a_b.c_d/\\~e'],
    ['x\nwww.a.com/~b', 'x<br>www\\.a.com/\\~b'],
  ])('refuses the autolink in %j', (value, escaped) => {
    expect(escapeTableCell(value)).toBe(escaped);
  });

  it.each(['xhttp://a.com/b', 'ftp://a.com/x', 'WWW.A.COM', 'http://a.com/(x'])(
    'leaves an unexempt address with nothing to escape byte-identical: %j',
    (value) => {
      expect(escapeTableCell(value)).toBe(value);
    },
  );

  it('keeps escaping each value alone when mapped over an array', () => {
    expect(['a<', 'http://a.com/~b'].map(escapeTableCell)).toEqual(['a<', 'http://a.com/~b']);
  });
});

describe('escapeTableCellFragment', () => {
  it('never keeps an address that runs to the fragment end as a link', () => {
    expect(escapeTableCellFragment('http://a.com/~b')).toBe('http\\://a.com/\\~b');
    expect(escapeTableCellFragment('http://a.com/~b more')).toBe('http://a.com/~b more');
  });

  it('escapes a trailing < or \\ as though punctuation came next', () => {
    expect(escapeTableCellFragment('a <')).toBe('a \\<');
    expect(escapeTableCellFragment('a \\')).toBe('a \\\\');
    expect(escapeTableCellFragment('http://a.com/x<')).toBe('http\\://a.com/x\\<');
  });

  it('matches escapeTableCell away from the fragment end', () => {
    expect(escapeTableCellFragment('*x* a|b_ ')).toBe(escapeTableCell('*x* a|b_ '));
  });
});

describe('formatCell', () => {
  it('escapes a primitive and the JSON text of a structure, and renders null as empty', () => {
    expect(formatCell('a|b')).toBe('a\\|b');
    expect(formatCell({ k: 'x|y' })).toBe('{"k":"x\\|y"}');
    expect(formatCell(42)).toBe('42');
    expect(formatCell(null)).toBe('');
  });
});

describe('singleLine', () => {
  it('flattens CR, LF, and CRLF to a space', () => {
    expect(singleLine('a\r\nb\nc\rd')).toBe('a b c d');
    expect(singleLine('### X\n### injected')).toBe('### X ### injected');
  });

  it('leaves a single-line value untouched', () => {
    expect(singleLine('### Report 2145405')).toBe('### Report 2145405');
  });
});

// #67 — upstream text that opens a list item's text or a line of its own.
describe('lineContent', () => {
  it.each([
    ['# forged', '\\# forged'],
    ['###### x', '\\###### x'],
    ['#', '\\#'],
    ['> q', '\\> q'],
    ['>q', '\\>q'],
    ['- item', '\\- item'],
    ['+ item', '\\+ item'],
    ['* item', '\\* item'],
    ['-', '\\-'],
    ['1. x', '1\\. x'],
    ['12) x', '12\\) x'],
    ['2023.', '2023\\.'],
    ['```js', '\\```js'],
    ['~~~', '\\~~~'],
    ['***', '\\***'],
    ['___', '\\___'],
    ['_ _ _', '\\_ _ _'],
    ['- - -', '\\- - -'],
    ['--', '\\--'],
    ['===', '\\==='],
    ['|---|---|', '\\|---|---|'],
    [':--- | ---:', '\\:--- | ---:'],
    ['<div>x', '\\<div>x'],
    ['</p>', '\\</p>'],
    ['<!-- c -->', '\\<!-- c -->'],
    ['[a]: http://x', '\\[a]: http://x'],
    ['[^1]: note', '\\[^1]: note'],
    ['[ ] task', '\\[ ] task'],
    ['[x] done', '\\[x] done'],
    ['   # x', '   \\# x'],
    ['\t> x', '\t\\> x'],
  ])('escapes the block marker %j opens with', (value, escaped) => {
    expect(lineContent(value)).toBe(escaped);
  });

  it('flattens line breaks first, then escapes a marker the flattened text opens with', () => {
    expect(lineContent('a\n# x\r\n- y')).toBe('a # x - y');
    expect(lineContent('\n# x')).toBe(' \\# x');
  });

  it.each([
    'Dog',
    'Lot #JKU4639A',
    '#2 pencil',
    '-5 mg',
    '1.5 mg',
    '2023.10',
    '1234567890. x',
    '<0.05',
    'p<0.05',
    '+/- 2',
    '*x* bold',
    '_lead',
    '--x',
    '=x',
    '|a|b|',
    '[81 MG] ASPIRIN',
    'a > b',
    'CARBIDOPA\\LEVODOPA',
    '    # indented four',
  ])('leaves %j byte-identical', (value) => {
    expect(lineContent(value)).toBe(value);
  });
});

/**
 * Both scanners run over upstream- and caller-sized text, so each is timed on
 * its worst inputs — repeated openers with no closer, and for the cell escaper's
 * autolink handling, link openers it must refuse, re-measure, or trim — across a
 * 64× span, on this thread's CPU time. Bun and Node grow alike on these inputs,
 * so the in-process (Node) measurement stands for both.
 */
describe('cell and line scanner timing', { timeout: 60_000 }, () => {
  const worstCases: [string, (n: number) => string][] = [
    ['an ampersand before a run with no semicolon', (n) => `&${'a'.repeat(n - 1)}`],
    ['repeated ampersand-hash openers', (n) => '&#'.repeat(n / 2)],
    ['repeated ampersand-letter openers', (n) => '&a'.repeat(n / 2)],
    ['repeated tag openers', (n) => '<a'.repeat(n / 2)],
    ['repeated backslashes', (n) => '\\'.repeat(n)],
    ['repeated underscores', (n) => '_'.repeat(n)],
    ['repeated CRs', (n) => '\r'.repeat(n)],
    ['mixed openers', (n) => '&#x<\\_|\r\n'.repeat(Math.ceil(n / 9)).slice(0, n)],
    ['refused mid-word link openers', (n) => 'xhttp://~'.repeat(Math.ceil(n / 9)).slice(0, n)],
    ['link openers in one span with a pipe', (n) => '(http://a|'.repeat(n / 10)],
    ['repeated www openers', (n) => 'www.'.repeat(n / 4)],
    ['repeated protocol openers', (n) => 'http://'.repeat(Math.ceil(n / 7)).slice(0, n)],
    ['many short links', (n) => ' http://a.b/~'.repeat(Math.ceil(n / 13)).slice(0, n)],
    ['a link with a long dotted domain', (n) => `http://${'a.'.repeat(n / 2 - 5)}a/~`],
    ['a link trailing semicolons', (n) => `http://a/${';'.repeat(n - 9)}`],
    ['a link trailing a long reference-like run', (n) => `http://a/&${'a'.repeat(n - 11)};`],
    ['a link trailing repeated references', (n) => `http://a/${'&a;.'.repeat(n / 4 - 3)}`],
  ];

  it.each(worstCases)('escapeTableCell stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(escapeTableCell, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });

  it.each(worstCases)('singleLine stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(singleLine, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });

  /**
   * The line-start check is anchored, but its thematic-break, delimiter-row, and
   * definition alternatives each scan the rest of the text before failing on the
   * last character.
   */
  const lineStartCases: [string, (n: number) => string][] = [
    ['a dash run failing on its last character', (n) => `${'-'.repeat(n - 1)}x`],
    ['an asterisk run failing late', (n) => `${'*'.repeat(n - 1)}x`],
    ['spaced underscores failing late', (n) => `${'_ '.repeat(n / 2 - 1)}_x`],
    ['a delimiter row failing late', (n) => `${'-|'.repeat(n / 2 - 1)}-x`],
    ['a setext run failing late', (n) => `${'='.repeat(n - 1)}x`],
    ['a run of spaces', (n) => ' '.repeat(n)],
    ['an unclosed definition label', (n) => `[${'a'.repeat(n - 1)}`],
    ['a definition label of escapes', (n) => `[${'\\]'.repeat(n / 2 - 1)}`],
    ['repeated line breaks', (n) => '\n'.repeat(n)],
  ];

  it.each([...worstCases, ...lineStartCases])('lineContent stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(lineContent, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

/**
 * @fileoverview Tests for the SPL `*_table` → GFM table renderer, over table
 * strings captured from live `drug/label` records plus synthetic edge cases.
 * @module tests/mcp-server/tools/spl-table.test
 */

import { describe, expect, it } from 'vitest';
import { renderSplTable } from '@/mcp-server/tools/spl-table.js';
import * as fixtures from '../../fixtures/spl-tables.js';

/** Undo the renderer's Markdown escapes, recovering the displayed text. */
function unescapeMarkdown(markdown: string): string {
  return markdown.replace(/\\([\\`*_[\]<>|~&])/g, '$1');
}

/**
 * Every text node of an SPL string — the runs between tags — entity-decoded and
 * whitespace-collapsed. Deliberately independent of the renderer's parser.
 */
function textNodes(raw: string): string[] {
  const decode = (s: string) =>
    s
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  return raw
    .split(/<[^>]+>/)
    .map((s) => decode(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The pipe-table lines of a rendering. */
function tableLines(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('|'));
}

/** Split a pipe row into its cell texts, honoring escaped pipes. */
function cells(row: string): string[] {
  return row
    .slice(2, -2)
    .split(/(?<!\\) \| /)
    .map((c) => c.trim());
}

describe('renderSplTable', () => {
  describe('live SPL table strings', () => {
    it('renders the warfarin dosing table as caption, pipe table, and footer', () => {
      expect(renderSplTable(fixtures.WARFARIN_DOSING)).toBe(
        [
          'Table 1: Three Ranges of Expected Maintenance Warfarin Sodium Tablets Daily Doses Based on CYP2C9 and VKORC1 Genotypes†',
          '',
          '| VKORC1 | CYP2C9 |  |  |  |  |  |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          '|  | \\*1/\\*1 | \\*1/\\*2 | \\*1/\\*3 | \\*2/\\*2 | \\*2/\\*3 | \\*3/\\*3 |',
          '| GG | 5 mg to 7 mg | 5 mg to 7 mg | 3 mg to 4 mg | 3 mg to 4 mg | 3 mg to 4 mg | 0.5 mg to 2 mg |',
          '| AG | 5 mg to 7 mg | 3 mg to 4 mg | 3 mg to 4 mg | 3 mg to 4 mg | 0.5 mg to 2 mg | 0.5 mg to 2 mg |',
          '| AA | 3 mg to 4 mg | 3 mg to 4 mg | 0.5 mg to 2 mg | 0.5 mg to 2 mg | 0.5 mg to 2 mg | 0.5 mg to 2 mg |',
          '',
          '^†Ranges are derived from multiple published clinical studies. VKORC1 -1639G\\>A (rs9923231) variant is used in this table. Other co-inherited VKORC1 variants may also be important determinants of warfarin dose.',
        ].join('\n'),
      );
    });

    it('expands a no-thead rowspan/colspan grid into equal-width rows', () => {
      expect(renderSplTable(fixtures.ROWSPAN_GRID)).toBe(
        [
          '|  |  | Atorvastatin (mg) |  |  |  |',
          '| --- | --- | --- | --- | --- | --- |',
          '|  |  | 10 | 20 | 40 | 80 |',
          '| Amlodipine (mg) | 5 | X | X | X | X |',
          '|  | 10 | X | X | X | X |',
        ].join('\n'),
      );
    });

    it('numbers a footnote once and reuses its marker for every footnoteRef', () => {
      const out = renderSplTable(fixtures.FOOTNOTE_REF);
      const [header, , first, second] = tableLines(out);
      expect(cells(header ?? '')[2]).toBe(
        'In-use (opened)[^1] Room temperature only (Do not refrigerate) up to 86°F (30°C)',
      );
      expect(cells(first ?? '')[2]).toBe('56 days[^1]');
      expect(cells(second ?? '')[2]).toBe('56 days[^1]');
      expect(
        out.endsWith(
          '\n\n[^1]: To prevent degradation, always store the prefilled pens with the cap on during in-use period.',
        ),
      ).toBe(true);
      expect(out).not.toContain('[^2]');
    });

    it('moves an unreferenced footnote below the table, keeping a marker in its cell', () => {
      const out = renderSplTable(fixtures.FOOTNOTE_INLINE);
      expect(out).toContain('| Infection[^1] | 9.4 | 10.3 |');
      expect(out).toContain('\n\n[^1]: Body system not specified');
      expect(out.startsWith('Table 1: Adverse Reactions Occurring ≥5% in Pooled')).toBe(true);
    });

    it('uses the first thead row as the header and demotes later header rows to the body', () => {
      const lines = tableLines(renderSplTable(fixtures.MULTI_HEADER_ROW));
      expect(lines).toEqual([
        '|  | ORIGIN Study Median duration of follow-up: 6.2 years |  |',
        '| --- | --- | --- |',
        '|  | LANTUS N=6231 | Standard Care N=6273 |',
        '| Percent of patients | 5.6 | 1.8 |',
      ]);
    });

    it('keeps list items in their cell, separated by a visible break', () => {
      expect(tableLines(renderSplTable(fixtures.LIST_IN_CELL))[0]).toBe(
        '| • shortness of breath or trouble breathing<br>• chest pain<br>• weakness in one part or side of your body | • slurred speech<br>• swelling of the face or throat |',
      );
    });

    it('renders linkHtml as its text and renderMultiMedia as a placeholder', () => {
      expect(tableLines(renderSplTable(fixtures.MEDIA_AND_LINK))).toEqual([
        '| Repackaged by Aphena Pharma Solutions - TN. See Repackaging Information for available configurations. |',
        '| --- |',
        '| [image] |',
      ]);
    });

    it('keeps subscripts and superscripts distinguishable from the digits around them', () => {
      expect(renderSplTable(fixtures.SUBSCRIPT_FORMULA)).toContain(
        '| C\\_22H\\_29FO\\_5 | MW 392.47 |',
      );
      const sci = renderSplTable(fixtures.SCIENTIFIC_NOTATION);
      expect(sci).toContain('| WBC Count | \\<1 x 10 ^9/L | 2/103 (4%) | 0/95 |');
      expect(sci).toContain('| SGOT | \\>5 x ULN ^b |');
      expect(sci).toContain('Percentage of Patients ^a Exceeding');
      expect(sci).not.toContain('109/L');
    });

    it.each(Object.entries(fixtures))('%s: every text node reaches the output', (_name, raw) => {
      const out = unescapeMarkdown(renderSplTable(raw)).replace(/\s+/g, ' ');
      const missing = textNodes(raw).filter((node) => !out.includes(node));
      expect(missing).toEqual([]);
    });

    it.each(Object.entries(fixtures))(
      '%s: no markup or entity survives, and every row is one line',
      (_name, raw) => {
        const out = renderSplTable(raw);
        expect(out).not.toMatch(/<(?!br>)[a-zA-Z/]/);
        expect(out).not.toMatch(/&#x?[0-9a-f]+;/i);
        const lines = tableLines(out);
        const widths = new Set(lines.map((line) => cells(line).length));
        expect(widths.size).toBe(1);
      },
    );
  });

  describe('grid layout', () => {
    it('places a spanned value in its origin cell and leaves covered cells empty', () => {
      const out = renderSplTable(
        '<table><tbody><tr><td rowspan="2">A</td><td colspan="2">B</td></tr><tr><td>C</td><td>D</td></tr><tr><td>E</td><td>F</td><td>G</td></tr></tbody></table>',
      );
      expect(tableLines(out)).toEqual([
        '| A | B |  |',
        '| --- | --- | --- |',
        '|  | C | D |',
        '| E | F | G |',
      ]);
    });

    it('handles a block spanning rows and columns at once, and spans stacked below it', () => {
      const out = renderSplTable(
        '<table><tr><td colspan="2" rowspan="2">X</td><td>1</td></tr><tr><td rowspan="2">2</td></tr><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></table>',
      );
      expect(tableLines(out)).toEqual([
        '| X |  | 1 |',
        '| --- | --- | --- |',
        '|  |  | 2 |',
        '| a | b |  |',
        '| c | d | e |',
      ]);
    });

    it('lets a colspan cover slots an earlier rowspan occupies without losing either value', () => {
      /**
       * Overlapping spans are an authoring error; like the HTML table model, the later
       * cell still covers its full width and the earlier origin keeps its text.
       */
      const out = renderSplTable(
        '<table><tr><td>a</td><td rowspan="3">B</td><td>c</td></tr><tr><td colspan="3" rowspan="2">D</td></tr><tr><td>e</td></tr></table>',
      );
      expect(tableLines(out)).toEqual([
        '| a | B | c |  |',
        '| --- | --- | --- | --- |',
        '| D |  |  |  |',
        '|  |  |  | e |',
      ]);
    });

    it('clamps a rowspan that runs past the last row and pads ragged rows', () => {
      const out = renderSplTable(
        '<table><tr><td>h1</td><td>h2</td><td>h3</td></tr><tr><td rowspan="9">tall</td></tr></table>',
      );
      expect(tableLines(out)).toEqual([
        '| h1 | h2 | h3 |',
        '| --- | --- | --- |',
        '| tall |  |  |',
      ]);
    });

    it('treats a malformed span as 1 and bounds an oversized colspan', () => {
      const bad = renderSplTable(
        '<table><tr><td colspan="0">a</td><td rowspan="x">b</td><td colspan="-3">c</td></tr></table>',
      );
      expect(tableLines(bad)[0]).toBe('| a | b | c |');
      const wide = tableLines(renderSplTable('<table><tr><td colspan="99999">w</td></tr></table>'));
      expect(cells(wide[0] ?? '')).toHaveLength(1000);
    });

    it('keeps empty and whitespace-only cells without shifting later columns', () => {
      const out = renderSplTable(
        '<table><tr><th>a</th><th>b</th><th>c</th><th>d</th></tr><tr><td/><td>   </td><td></td><td>x</td></tr></table>',
      );
      expect(tableLines(out)[2]).toBe('|  |  |  | x |');
    });

    it('takes the first row as the header when there is no thead', () => {
      const out = renderSplTable(
        '<table><tbody><tr><td>Dose</td><td>Group</td></tr><tr><td>5 mg</td><td>A</td></tr></tbody></table>',
      );
      expect(tableLines(out).slice(0, 2)).toEqual(['| Dose | Group |', '| --- | --- |']);
    });

    it('renders a header-only table as just the header', () => {
      expect(renderSplTable('<table><thead><tr><th>Only</th></tr></thead></table>')).toBe(
        '| Only |\n| --- |',
      );
    });

    it('renders a row-less table as its caption alone, and an empty table as nothing', () => {
      expect(renderSplTable('<table><caption>Just a caption</caption></table>')).toBe(
        'Just a caption',
      );
      expect(renderSplTable('<table></table>')).toBe('');
      expect(renderSplTable('')).toBe('');
    });
  });

  describe('text', () => {
    it('decodes numeric references and the five XML named entities', () => {
      const out = renderSplTable(
        '<table><tr><td>&#x2020;&#8224;</td><td>&lt;&gt;&amp;&quot;&apos;</td></tr></table>',
      );
      expect(cells(tableLines(out)[0] ?? '')).toEqual(['††', '\\<\\>&"\'']);
    });

    it('renders an entity-only cell as that character', () => {
      expect(renderSplTable('<table><tr><td>&#x2022;</td><td>x</td></tr></table>')).toContain(
        '| • | x |',
      );
    });

    it('leaves an unknown named entity and an invalid code point visible rather than dropping them', () => {
      const out = unescapeMarkdown(
        renderSplTable('<table><tr><td>a&nbsp;b &#xD800; c</td></tr></table>'),
      );
      expect(out).toContain('a&nbsp;b &#xD800; c');
    });

    it('escapes pipes, backslashes, and Markdown-significant characters in cells', () => {
      const out = renderSplTable(
        '<table><tr><td>a|b</td><td>C:\\dir</td><td>*1/*1</td><td>_x_ `y` [z](u) ~s~</td><td>&amp;lt;</td></tr></table>',
      );
      expect(cells(tableLines(out)[0] ?? '')).toEqual([
        'a\\|b',
        'C:\\\\dir',
        '\\*1/\\*1',
        '\\_x\\_ \\`y\\` \\[z\\](u) \\~s\\~',
        '\\&lt;',
      ]);
    });

    it('keeps a tag-shaped run outside the SPL vocabulary as literal text', () => {
      const out = renderSplTable('<table><tr><td>Water <E050800></td></tr></table>');
      expect(unescapeMarkdown(out)).toContain('Water <E050800>');
    });

    it('collapses whitespace runs and never puts a raw newline inside a row', () => {
      const out = renderSplTable(
        '<table><tr><td>  line one\n\n\tline two  </td><td><paragraph>p1</paragraph>\n<paragraph>p2</paragraph></td></tr></table>',
      );
      expect(tableLines(out)[0]).toBe('| line one line two | p1<br>p2 |');
      expect(out.split('\n')).toHaveLength(2);
    });

    it('marks superscripts and subscripts, parenthesizing a spaced run', () => {
      const out = renderSplTable(
        '<table><tr><td>10<sup>9</sup>/L</td><td>HbA<sub>1C</sub></td><td>x<sup>a b</sup></td><td>y<sup> </sup></td></tr></table>',
      );
      expect(cells(tableLines(out)[0] ?? '')).toEqual(['10^9/L', 'HbA\\_1C', 'x^(a b)', 'y']);
    });

    it('numbers ordered list items and uses an item caption as its bullet', () => {
      const out = renderSplTable(
        '<table><tr><td><list listType="ordered"><item>first</item><item>second</item></list></td><td><list><item><caption>&#x25CB;</caption>open</item></list></td></tr></table>',
      );
      expect(cells(tableLines(out)[0] ?? '')).toEqual(['1. first<br>2. second', '○ open']);
    });

    it("keeps a list's own caption as the block before its items", () => {
      // Shape from a live medication guide: <list><caption>X is:</caption><item>…
      const out = renderSplTable(
        '<table><tr><td><list listType="unordered"><caption>OXYCONTIN is:</caption><item>A strong pain medicine</item><item>Long-term</item></list></td></tr></table>',
      );
      expect(tableLines(out)[0]).toBe(
        '| OXYCONTIN is:<br>• A strong pain medicine<br>• Long-term |',
      );
    });

    it('flattens a nested table into its cell, one break per nested row', () => {
      const out = renderSplTable(
        '<table><tr><td>Outer<table><tbody><tr><td>n1</td><td>n2</td></tr><tr><td>n3</td></tr></tbody></table></td><td>next</td></tr></table>',
      );
      expect(tableLines(out)[0]).toBe('| Outer<br>n1 n2<br>n3 | next |');
    });
  });

  describe('captions, footers, and footnotes', () => {
    it('renders the caption above the table and tfoot rows below it', () => {
      const out = renderSplTable(
        '<table><caption>Cap</caption><tfoot><tr><td>note one</td></tr><tr><td>Total</td><td>9</td></tr></tfoot><tbody><tr><td>h</td><td>v</td></tr><tr><td>r</td><td>1</td></tr></tbody></table>',
      );
      expect(out).toBe(
        ['Cap', '', '| h | v |', '| --- | --- |', '| r | 1 |', '', 'note one\nTotal | 9'].join(
          '\n',
        ),
      );
    });

    it('puts each paragraph of a footer cell on its own line', () => {
      const out = renderSplTable(
        fixtures.SCIENTIFIC_NOTATION.replace(
          '<tbody>',
          '<tfoot><tr><td><paragraph>a first note</paragraph><paragraph>b second note</paragraph></td></tr></tfoot><tbody>',
        ),
      );
      expect(out.endsWith('\n\na first note\nb second note')).toBe(true);
    });

    it('resolves a footnoteRef that appears before its footnote', () => {
      const out = renderSplTable(
        '<table><tr><td>a<footnoteRef IDREF="n1"/></td><td>b<footnote ID="n1">shared</footnote></td></tr></table>',
      );
      expect(tableLines(out)[0]).toBe('| a[^1] | b[^1] |');
      expect(out.endsWith('[^1]: shared')).toBe(true);
    });

    it('numbers anonymous footnotes separately and in order, including one in the caption', () => {
      const out = renderSplTable(
        '<table><caption>T<footnote>on caption</footnote></caption><tr><td>x<footnote>first cell</footnote></td><td>y<footnote>second cell</footnote></td></tr></table>',
      );
      expect(out.split('\n')[0]).toBe('T[^1]');
      expect(tableLines(out)[0]).toBe('| x[^2] | y[^3] |');
      expect(out).toContain('[^1]: on caption\n[^2]: first cell\n[^3]: second cell');
    });

    it('keeps a marker for a reference whose footnote never appears, without inventing a definition', () => {
      const out = renderSplTable('<table><tr><td>a<footnoteRef IDREF="gone"/></td></tr></table>');
      expect(out).toBe('| a[^1] |\n| --- |');
    });
  });

  describe('multiple tables and fallback', () => {
    it('renders each top-level table and any text between them as separate blocks', () => {
      const out = renderSplTable(
        '<table><tr><td>one</td></tr></table> between &amp; after <table><tr><td>two</td></tr></table>',
      );
      expect(out).toBe(['| one |\n| --- |', 'between & after', '| two |\n| --- |'].join('\n\n'));
    });

    it.each([
      ['an unclosed table', '<table><tr><td>A &amp; B</td></tr>', 'A & B'],
      ['a mismatched close tag', '<table><tr><td>x &#x2265; 5</tr></td></table>', 'x ≥ 5'],
      ['a stray close tag', 'lead</td><table><tr><td>cell</td></tr></table>', 'lead cell'],
    ])('falls back to decoded text for %s', (_name, raw, text) => {
      expect(() => renderSplTable(raw)).not.toThrow();
      expect(renderSplTable(raw)).toBe(text);
    });

    it('keeps non-SPL tag-shaped text in the fallback', () => {
      expect(renderSplTable('<table><tr><td><E050800> water')).toBe('<E050800> water');
    });
  });
});

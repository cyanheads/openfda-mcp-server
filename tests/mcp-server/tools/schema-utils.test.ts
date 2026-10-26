/**
 * @fileoverview The shared `search` input (#75): which `+` it reads as a space,
 * which it leaves as sent, the schema contract it keeps, and the empty-result
 * hint for a `+` inside a quoted phrase. Totals in the comments are
 * api.fda.gov's answers (2026-10-26) for the string as sent before and after.
 * Per-tool wiring is asserted where each tool is tested.
 * @module tests/mcp-server/tools/schema-utils.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  findSearchDelimiterFault,
  nonBlankString,
  phrasePlusHint,
  searchExpression,
} from '@/mcp-server/tools/schema-utils.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

const parse = (search: string) => searchExpression().parse(search);

describe('searchExpression reads a URL-form + as a space in separator positions', () => {
  it.each([
    // The three calls the issue reproduces: 0 → 435,387; parse_exception → 218,980;
    // 696,420 (occurcountry alone) → 1,404,130.
    [
      'patient.drug.medicinalproduct:"aspirin"+AND+serious:"1"',
      'patient.drug.medicinalproduct:"aspirin" AND serious:"1"',
    ],
    [
      'patient.drug.medicinalproduct:"aspirin" AND receivedate:[20180101+TO+20231231]',
      'patient.drug.medicinalproduct:"aspirin" AND receivedate:[20180101 TO 20231231]',
    ],
    [
      'patient.reaction.reactionmeddrapt:"fatigue"+occurcountry:"ca"',
      'patient.reaction.reactionmeddrapt:"fatigue" occurcountry:"ca"',
    ],
    // parse_exception → 11,906,128.
    ['occurcountry:ca+serious:1', 'occurcountry:ca serious:1'],
  ])('%j → %j', (search, normalized) => {
    expect(parse(search)).toBe(normalized);
  });

  describe('touching a standalone word operator', () => {
    it.each([
      ['a:"x"+OR+b:"y"', 'a:"x" OR b:"y"'],
      ['a:"x"+AND+NOT+b:"y"', 'a:"x" AND NOT b:"y"'],
      ['a:x+AND+b:y', 'a:x AND b:y'],
      ['NOT+a:x', 'NOT a:x'],
      ['+NOT+a:x', ' NOT a:x'],
      ['x+OR+(y)', 'x OR (y)'],
      ['a:(x+OR+y)', 'a:(x OR y)'],
      ['a:ORANGE+NOT+b:y', 'a:ORANGE NOT b:y'],
      ['a:x+AND', 'a:x AND'],
      // Inside a range, either closer.
      ['receivedate:{20180101+TO+20231231}', 'receivedate:{20180101 TO 20231231}'],
      ['receivedate:[20180101+TO+20231231}', 'receivedate:[20180101 TO 20231231}'],
      // A literal plus before the operator stays; only the separator goes.
      ['device_name.exact:Knee++AND+x:y', 'device_name.exact:Knee+ AND x:y'],
      ['device_name.exact:Knee\\++AND+x:y', 'device_name.exact:Knee\\+ AND x:y'],
    ])('%j → %j', (search, normalized) => {
      expect(parse(search)).toBe(normalized);
    });
  });

  describe('right after a closing quote, paren, or bracket', () => {
    it.each([
      // 11,882,971 (serious alone) → 12,065,512, the union.
      [
        'patient.drug.medicinalproduct:"aspirin"+serious:"1"',
        'patient.drug.medicinalproduct:"aspirin" serious:"1"',
      ],
      // 696,420 (occurcountry alone) → 2,013,414.
      [
        '(patient.reaction.reactionmeddrapt:"fatigue" OR patient.reaction.reactionmeddrapt:"nausea")+occurcountry:"ca"',
        '(patient.reaction.reactionmeddrapt:"fatigue" OR patient.reaction.reactionmeddrapt:"nausea") occurcountry:"ca"',
      ],
      ['a:"x"+(b OR c)', 'a:"x" (b OR c)'],
      ['a:"x"+[1 TO 2]', 'a:"x" [1 TO 2]'],
      ['a:[1 TO 2]+b:y', 'a:[1 TO 2] b:y'],
      ['a:{1 TO 2}+b:y', 'a:{1 TO 2} b:y'],
      ['(a:x)+(b:y)', '(a:x) (b:y)'],
      ['"a"+"b"', '"a" "b"'],
      ['a:"AND"+x', 'a:"AND" x'],
      ['a:"x"+', 'a:"x" '],
    ])('%j → %j', (search, normalized) => {
      expect(parse(search)).toBe(normalized);
    });
  });

  describe('between a term and the next field: prefix', () => {
    it.each([
      ['a.b:x+c.d.exact:"y"', 'a.b:x c.d.exact:"y"'],
      ['a:x+_exists_:y', 'a:x _exists_:y'],
      ['_exists_:y+_missing_:z', '_exists_:y _missing_:z'],
      ['a:1.5+b:y', 'a:1.5 b:y'],
      ['a:x*+b:y', 'a:x* b:y'],
      ['a:x?+b:y', 'a:x? b:y'],
      // An escaped character ends a term like any other.
      ['a:x\\)+b:y', 'a:x\\) b:y'],
      ['a:x\\"+b:y', 'a:x\\" b:y'],
      ['a:x\\ +b:y', 'a:x\\  b:y'],
      // Lowercase `and` is a term, not an operator, so only the second + separates.
      ['a:x+and+b:y', 'a:x+and b:y'],
    ])('%j → %j', (search, normalized) => {
      expect(parse(search)).toBe(normalized);
    });
  });

  it('rewrites every separator in one query', () => {
    expect(parse('a:"x"+AND+b:[1+TO+2]+c:y+OR+d:z')).toBe('a:"x" AND b:[1 TO 2] c:y OR d:z');
  });
});

describe('searchExpression leaves every other + as sent', () => {
  it.each([
    // Phrase-internal: real data on device/udi (2,326 and 1,703 records as sent).
    'brand_name.exact:"Bausch + Lomb"',
    'brand_name.exact:"EVO/EVO+VISIAN Implantable Collamer Lens"',
    'brand_name:"Bausch + Lomb"',
    'classification:"Class+I"',
    'reason_for_recall:"undeclared+allergen"',
    'patient.reaction.reactionmeddrapt.exact:"INJECTION+SITE+PAIN"',
    'a:"x+AND+y"',
    'a:"x\\"+y"',
    '"+"',
    // In-term and escaped literals: device/510k `Knee+` (6 records as sent).
    'device_name.exact:Knee+',
    'device_name.exact:Knee\\+',
    'device_name.exact:Knee+ AND decision_date:[20200101 TO 20201231]',
    'brand_name.exact:Candulor\\ NFC+',
    'a:"x"\\+b:y',
    // Lucene's required operator: 435,387 (AND) as sent.
    '+patient.drug.medicinalproduct:"aspirin" +serious:"1"',
    '+a:x +b:y',
    'a:x +b:y',
    'a:x\t+b:y',
    // Not a separator position.
    'a:x+(b OR c)',
    'a:x+[1 TO 2]',
    'a:(x+y)',
    'a:x+b',
    'a:x+b c:d',
    'a:x+1b:y',
    'receivedate:[2018+0101 TO 2023]',
    'a:x+\tb:y',
    'a:x+-b:y',
    'a:x+!b:y',
    'a:x~+b:y',
    'a:x&&+b:y',
    'a:x+&&+b:y',
    'a:x+||+b:y',
    'a:/re+gex/',
    'a:x+',
    '+',
    // Operators are uppercase whole words.
    'a:x+or+b',
    'receivedate:[20180101+to+20231231]',
    'a:x+ANDROID',
    'a:BAND+b',
    'a:x+TOTAL',
  ])('%j', (search) => {
    expect(parse(search)).toBe(search);
  });

  /*
   * A query that already marks a clause required with a leading `+` is written in
   * Lucene's syntax, where a `+` before the next clause is that operator too:
   * `+…"aspirin"+serious:"1"` answers 435,387 (AND) as sent, and reading the
   * middle `+` as a space would make `serious` optional — 617,928, aspirin alone.
   */
  describe('in a query that uses + as the required operator', () => {
    it.each([
      '+patient.drug.medicinalproduct:"aspirin"+serious:"1"',
      '+a:x+b:y',
      '(+a:"x")+b:"y"',
      'a:x +b:"y"+c:z',
      '+[1 TO 2]+b:y',
    ])('%j stays as sent', (search) => {
      expect(parse(search)).toBe(search);
    });

    it('still reads a + beside a word operator as a space', () => {
      expect(parse('+a:"x"+AND+b:"y"')).toBe('+a:"x" AND b:"y"');
      expect(parse('+a:x AND c:[1+TO+2]')).toBe('+a:x AND c:[1 TO 2]');
    });

    it('does not read a + after escaped whitespace as the operator', () => {
      expect(parse('a:x\\ +b:y AND c:"z"+d:w')).toBe('a:x\\  b:y AND c:"z" d:w');
    });
  });
});

describe('searchExpression keeps the nonBlankString contract', () => {
  it('advertises the same JSON Schema as nonBlankString', () => {
    expect(z.toJSONSchema(searchExpression())).toEqual(z.toJSONSchema(nonBlankString()));
  });

  it.each(['', '   ', '\t\n'])('rejects blank %j', (search) => {
    expect(searchExpression().safeParse(search).success).toBe(false);
  });

  it('stays optional when chained, and passes undefined through', () => {
    expect(searchExpression().optional().parse(undefined)).toBeUndefined();
    expect(searchExpression().optional().parse('a:x+AND+b:y')).toBe('a:x AND b:y');
  });

  it('never turns a non-blank value blank', () => {
    for (const search of ['+', '++', '+ +', '"a"+', '+AND+']) {
      expect(parse(search)).toMatch(/\S/);
    }
  });

  // The delimiter guard reads the normalized string; a `+` is never a delimiter,
  // so its verdict is the one the caller's text would get.
  it.each([
    'a:"x"+AND+b:"y',
    'a:(x+OR+y',
    'receivedate:[20180101+TO+20231231',
    'a:x+AND+b:y)',
    'a:x+AND+b:y\\',
    'a:"x"+AND+b:[1+TO+2]',
  ])('leaves the delimiter verdict on %j unchanged', (search) => {
    expect(findSearchDelimiterFault(parse(search))).toBe(findSearchDelimiterFault(search));
  });
});

describe('phrasePlusHint', () => {
  it('names the phrase and its spaced form when a phrase + search matched nothing', () => {
    // As sent: no matches. With spaces: 299,526.
    const hint = phrasePlusHint('patient.reaction.reactionmeddrapt.exact:"INJECTION+SITE+PAIN"', 0);
    expect(hint).toBe(
      'A "+" inside a quoted phrase is a literal plus sign, not a space, so `"INJECTION+SITE+PAIN"` can match only values spelled with one. If its words are meant to be separate, write them with spaces: `"INJECTION SITE PAIN"`.',
    );
  });

  it('names the first phrase that holds a +, past phrases that do not', () => {
    const hint = phrasePlusHint('a:"plain" AND b:"x+y" AND c:"p+q"', 0);
    expect(hint).toContain('`"x+y"`');
    expect(hint).toContain('`"x y"`');
    expect(hint).not.toContain('p+q');
  });

  it('keeps escapes in the spaced form and turns only unescaped + to spaces', () => {
    const hint = phrasePlusHint('a:"x\\+y+z\\"w"', 0);
    expect(hint).toContain('`"x\\+y+z\\"w"`');
    expect(hint).toContain('`"x\\+y z\\"w"`');
  });

  it('reads an unterminated phrase to the end', () => {
    expect(phrasePlusHint('a:"x+y', 0)).toContain('`"x y"`');
  });

  // #81 — the phrase is caller text inside a notice, so it rides as a code literal.
  it('wraps each phrase as a code literal sized past the backticks it holds', () => {
    const hint = phrasePlusHint('a:"*x*+`y`"', 0);
    expect(hint).toContain('so ``"*x*+`y`"`` can match');
    expect(hint).toContain('spaces: ``"*x* `y`"``.');
  });

  it.each([
    ['a matched set', 'a:"x+y"', 5],
    ['no search', undefined, 0],
    ['a + outside every phrase', 'a:x+b c:"d"', 0],
    ['an escaped + inside a phrase', 'a:"x\\+y"', 0],
    ['an escaped quote that opens no phrase', 'a:\\"x+y\\"', 0],
    ['no phrase at all', 'a:x', 0],
  ] as const)('says nothing for %s', (_label, search, total) => {
    expect(phrasePlusHint(search, total)).toBeUndefined();
  });
});

/*
 * Both scanners walk caller-sized text: each shape is timed from 5k characters,
 * doubling to 320k, with the absolute bound checked at every size before the
 * next and the full-span ratio checked at the end, on this thread's CPU time.
 */
describe('search scanner timing', { timeout: 300_000 }, () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: [string, (n: number) => string][] = [
    ['closers each followed by +', (n) => '"a"+'.repeat(n / 4)],
    ['term + pairs', (n) => 'a+'.repeat(n / 2)],
    ['one + before a long field path with no colon', (n) => `a+${'b'.repeat(n - 2)}`],
    ['field prefixes after +', (n) => 'a+b:'.repeat(n / 4)],
    ['operator words between +', (n) => '+AND'.repeat(n / 4)],
    ['near-operator words between +', (n) => '+ANDX'.repeat(n / 5)],
    ['repeated backslashes', (n) => '\\'.repeat(n)],
    ['an unterminated phrase of +', (n) => `"${'+'.repeat(n - 1)}`],
    ['phrases without a +', (n) => '"ab"'.repeat(n / 4)],
    ['a long digit run', (n) => '1'.repeat(n)],
    ['digit + pairs', (n) => '1+'.repeat(n / 2)],
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
  ];
  const scanners: [string, (search: string) => unknown][] = [
    ['searchExpression', (search) => searchExpression().safeParse(search)],
    ['phrasePlusHint', (search) => phrasePlusHint(search, 0)],
  ];

  for (const [scanner, run] of scanners) {
    it.each(shapes)(`${scanner} stays linear on %s`, (_name, build) => {
      const small = build(SIZES[0]!);
      let ratio = 0;
      for (const size of SIZES.slice(1)) {
        const { t5k, t320k: tSize } = linearTiming(run, small, build(size));
        expect(tSize, `${size} characters`).toBeLessThan(500_000);
        ratio = tSize / t5k;
      }
      expect(ratio).toBeLessThan(256);
    });
  }
});

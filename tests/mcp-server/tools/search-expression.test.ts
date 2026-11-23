/**
 * @fileoverview The shared `search` input: which `+` it reads as a space (#75),
 * the whitespace it reads as a space and the characters its guard refuses
 * (#103), the hyphenated terms it quotes (#101), every Lucene form it keeps as
 * written, the schema contract it keeps, and the empty-result hint for a `+`
 * inside a quoted phrase. Totals in the comments are api.fda.gov's answers for
 * the string as sent before and after. Also the linear-time bound on every
 * scanner over caller-sized text. Per-tool wiring is asserted where each tool
 * is tested.
 * @module tests/mcp-server/tools/search-expression.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { nonBlankString } from '@/mcp-server/tools/schema-utils.js';
import {
  assertSearchDelimitersBalanced,
  findSearchDelimiterFault,
  malformedSearchError,
  phrasePlusHint,
  SEARCH_REFUSED_CHARACTER,
  SEARCH_WHITESPACE,
  searchExpression,
} from '@/mcp-server/tools/search-expression.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

const parse = (search: string) => searchExpression().parse(search);

/** The character at a code point, so no non-ASCII character is written raw into this file. */
const cp = (codePoint: number) => String.fromCodePoint(codePoint);

/** The guard's verdict on `search`: the thrown error, or `undefined` when it passes. */
function guard(search: string): McpError | undefined {
  const ctx = createMockContext({ errors: [malformedSearchError] });
  try {
    assertSearchDelimitersBalanced(search, ctx);
  } catch (error) {
    return error as McpError;
  }
  return;
}

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
    // Not a separator position.
    'a:x+(b OR c)',
    'a:x+[1 TO 2]',
    'a:(x+y)',
    'a:x+b',
    'a:x+b c:d',
    'a:x+1b:y',
    'receivedate:[2018+0101 TO 2023]',
    'a:x+ b:y',
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

/*
 * Every Lucene form openFDA answers today reaches it meaning what it meant, and
 * none of them trips the guard: quoted phrases, ranges, prefixes, `_exists_`,
 * the required operator, a `-` NOT after whitespace, backslash escapes, and a
 * hyphen anywhere a term is not whole letters and digits.
 */
describe('searchExpression keeps every Lucene form openFDA accepts', () => {
  it.each([
    'brand_name:"tylenol extra"',
    'brand_name:"0003-0894"',
    'product_ndc:"0003-0894" AND brand_name:eliquis',
    'report_date:[20200101 TO 20201231]',
    'report_date:{20200101 TO 20201231}',
    'update_date:[2026-11-20 TO 2026-11-20]',
    'recalling_firm:pfiz*',
    'recall_number:D-0123*',
    '_exists_:recall_number',
    '+brand_name:eliquis +dosage_form:tablet',
    // 2 of brand_name:eliquis's 15 — a `-` after whitespace is NOT.
    'brand_name:eliquis -dosage_form:tablet',
    'NOT dosage_form:tablet',
    'reason_for_recall:foo\\(bar',
    'a\\-b',
    '1.5-mg',
    'brand_name:tylenol && brand_name:extra',
    'brand_name:(eliquis OR xarelto)',
    'K213456',
  ])('%j reaches openFDA as written, past the guard', (search) => {
    expect(parse(search)).toBe(search);
    expect(findSearchDelimiterFault(search)).toBeUndefined();
  });

  // Each answers 29 inside "tylenol X extra", as the phrase without it does.
  it.each([..."%&'()*+,-./:<=>@[]_{}".split(''), '\\"', '\\\\'])(
    'passes %j inside a phrase',
    (char) => {
      expect(findSearchDelimiterFault(`brand_name:"tylenol ${char} extra"`)).toBeUndefined();
    },
  );
});

/*
 * openFDA answers HTTP 400 `Search not supported` to a query holding any
 * character outside printable ASCII or any of `! # $ ; ? ^ ` | ~`, inside a
 * phrase, escaped, or bare (#103). Whitespace among them is read as the space it
 * stands for; the rest fail locally as malformed_search.
 */
describe('the refused-character classes (#103)', () => {
  /** ECMAScript's WhiteSpace and LineTerminator code points — what `\s` matches. */
  const WHITESPACE = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
  ]);
  const REFUSED_ASCII = new Set([...'!#$;?^`|~'].map((char) => char.codePointAt(0)));

  it('split every code point into accepted, whitespace, or refused, with no overlap', () => {
    const misread: string[] = [];
    const codePoints = [
      ...Array.from({ length: 0x10000 }, (_, n) => n),
      0x10000,
      0x1f600,
      0x10ffff,
    ];
    for (const codePoint of codePoints) {
      const char = cp(codePoint);
      const whitespace = WHITESPACE.has(codePoint);
      const refused =
        !whitespace && (codePoint < 0x20 || codePoint > 0x7e || REFUSED_ASCII.has(codePoint));
      if (
        SEARCH_WHITESPACE.test(char) !== whitespace ||
        SEARCH_REFUSED_CHARACTER.test(char) !== refused
      ) {
        misread.push(codePoint.toString(16));
      }
    }
    expect(misread).toEqual([]);
  });

  it('carry no global flag, so test() and exec() keep no state between calls', () => {
    expect(SEARCH_WHITESPACE.flags).not.toContain('g');
    expect(SEARCH_REFUSED_CHARACTER.flags).not.toContain('g');
  });
});

describe('searchExpression reads whitespace openFDA refuses as a space (#103)', () => {
  // Each refused as written; spaced, 49 on drug/ndc.
  it.each([
    ['a tab', '\t'],
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
    ['a no-break space', cp(0xa0)],
    ['an ideographic space', cp(0x3000)],
    ['a line separator', cp(0x2028)],
    ['a zero-width no-break space', cp(0xfeff)],
  ])('%s between clauses', (_label, whitespace) => {
    expect(parse(`brand_name:tylenol${whitespace}AND${whitespace}brand_name:extra`)).toBe(
      'brand_name:tylenol AND brand_name:extra',
    );
  });

  it('turns each such character into one space, so a CRLF is two', () => {
    expect(parse('a:x\r\nb:y')).toBe('a:x  b:y');
  });

  it('reads them inside a phrase and after a backslash too', () => {
    expect(parse('brand_name:"tylenol\textra"')).toBe('brand_name:"tylenol extra"');
    expect(parse('a\\\tb')).toBe('a\\ b');
  });

  it('reads them before the + rule, which then sees a space beside the +', () => {
    expect(parse('a:x\t+b:y')).toBe('a:x +b:y');
    expect(parse('a:x+\tb:y')).toBe('a:x+ b:y');
  });

  it('leaves nothing for the guard to refuse', () => {
    const run = ['\t', '\n', '\r', '\v', '\f', cp(0xa0), cp(0x2029), cp(0x3000)].join('');
    expect(guard(parse(`a:x${run}b:y`))).toBeUndefined();
  });

  it('still rejects a value of only such whitespace as blank', () => {
    expect(searchExpression().safeParse(`${cp(0xa0)}\t${cp(0x3000)}`).success).toBe(false);
  });
});

describe('the guard refuses each character openFDA refuses (#103)', () => {
  // Each answers 400 `Search not supported` from openFDA.
  it.each([
    ['brand_name:"Tylenol; Extra"', '";" at position 20'],
    ['brand_name:"Tylenol\\; Extra"', '";" at position 21'],
    ['brand_name:tyl?nol', '"?" at position 15'],
    ['!brand_name:tylenol', '"!" at position 1'],
    ['brand_name:tylenol || brand_name:extra', '"|" at position 20'],
    [`brand_name:"Ozempic${cp(0xae)}"`, 'U+00AE at position 20'],
  ])('%j fails as malformed_search naming %s', (search, named) => {
    const error = guard(search);
    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.data).toMatchObject({ reason: 'malformed_search' });
    expect(error?.message).toContain(named);
  });

  it.each([...'!#$;?^`|~'])('refuses %j bare, inside a phrase, and escaped', (char) => {
    expect(guard(`a:x${char}y`)?.message).toContain(`"${char}" at position 4,`);
    expect(guard(`a:"x ${char} y"`)?.message).toContain(`"${char}" at position 6,`);
    expect(guard(`a:x\\${char}y`)?.message).toContain(`"${char}" at position 5,`);
  });

  it.each([
    [0xae, 'U+00AE'],
    [0x2122, 'U+2122'],
    [0xe9, 'U+00E9'],
    [0xb5, 'U+00B5'],
    [0x01, 'U+0001'],
    [0x7f, 'U+007F'],
    [0x202e, 'U+202E'],
    [0x1f600, 'U+1F600'],
  ])('names code point %i as %s and never echoes the character itself', (codePoint, name) => {
    const message = guard(`a:"x${cp(codePoint)}"`)?.message;
    expect(message).toContain(`${name} at position 5,`);
    expect(message).not.toContain(cp(codePoint));
  });

  it.each([
    ['!', 'Remove it; to exclude a clause, write NOT before it.'],
    ['|', 'Remove it; to join alternatives, write OR between them.'],
    ['?', 'Remove it; for a wildcard, write * (it matches any run of characters).'],
    ['^', 'Remove it; openFDA has no ^ boost operator.'],
    ['~', 'Remove it; openFDA has no ~ fuzzy or proximity operator.'],
    [';', 'Remove it or put a space in its place.'],
    ['#', 'Remove it or put a space in its place.'],
    ['$', 'Remove it or put a space in its place.'],
    ['`', 'Remove it or put a space in its place.'],
  ])('tells the caller what to write instead of %j', (char, advice) => {
    expect(guard(`a:x${char}y`)?.message).toBe(
      `Search query holds "${char}" at position 4, a character openFDA refuses anywhere in a query, quoted or escaped. ${advice}`,
    );
  });

  it('says a non-ASCII character has no place in a query at all', () => {
    expect(guard(`brand_name:"Ozempic${cp(0xae)}"`)?.message).toBe(
      'Search query holds U+00AE at position 20, a character openFDA refuses anywhere in a query, quoted or escaped. openFDA accepts only printable ASCII in a query: remove it or put a space in its place.',
    );
  });

  /*
   * openFDA stores accented names unaccented: openfda.brand_name:"Neoral" answers
   * 1 on drug/label, while "N oral" and "Noral" answer 0. A character whose
   * canonical decomposition, combining marks dropped, is ASCII letters gets that
   * spelling as its advice; the guard still rejects the query.
   */
  it.each([
    [0xe9, 'U+00E9', 'e'],
    [0xc5, 'U+00C5', 'A'],
    [0xf1, 'U+00F1', 'n'],
    [0x212a, 'U+212A', 'K'],
  ])('names the plain letter for code point %i (%s)', (codePoint, name, letter) => {
    const error = guard(`openfda.brand_name:"N${cp(codePoint)}oral"`);
    expect(error?.data).toMatchObject({ reason: 'malformed_search' });
    expect(error?.message).toBe(
      `Search query holds ${name} at position 22, a character openFDA refuses anywhere in a query, quoted or escaped. openFDA accepts only printable ASCII in a query: write "${letter}" in its place.`,
    );
  });

  it.each([
    [0xae, 'U+00AE'],
    [0xf8, 'U+00F8'],
    [0x200b, 'U+200B'],
    [0x963f, 'U+963F'],
    // Folds to "=", which is no letter.
    [0x2260, 'U+2260'],
    // A combining mark alone folds to nothing.
    [0x301, 'U+0301'],
  ])('keeps the remove-or-space advice for code point %i (%s)', (codePoint, name) => {
    expect(guard(`a:"x${cp(codePoint)}"`)?.message).toBe(
      `Search query holds ${name} at position 5, a character openFDA refuses anywhere in a query, quoted or escaped. openFDA accepts only printable ASCII in a query: remove it or put a space in its place.`,
    );
  });

  it('reports the first refused character', () => {
    expect(guard(`a:x;y${cp(0xae)}!`)?.message).toContain('";" at position 4,');
  });

  // openFDA's character gate answers before its parser does.
  it('reports a refused character ahead of a delimiter fault', () => {
    expect(guard('brand_name:"Tylenol; Extra')?.message).toContain('";" at position 20,');
    expect(guard('(a:x;y')?.message).toContain('";" at position 5,');
  });

  it('still reports a delimiter fault when no character is refused', () => {
    expect(guard('brand_name:"Tylenol Extra')?.message).toMatch(/unterminated double quote/);
  });

  // Each answers 29 inside "tylenol X extra"; && answers 49, as AND does.
  it.each([..."%&'()*+,-./:<=>@[]_{}".split(''), '\\"', '\\\\'])(
    'passes %j inside a phrase',
    (char) => {
      expect(guard(`brand_name:"tylenol ${char} extra"`)).toBeUndefined();
    },
  );

  it.each([
    'brand_name:tylenol && brand_name:extra',
    'brand_name:tyl*nol',
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ])('passes %j', (search) => {
    expect(guard(search)).toBeUndefined();
  });

  it('advertises the refused characters in its when and recovery', () => {
    expect(malformedSearchError.when).toMatch(/character openFDA refuses/);
    expect(malformedSearchError.recovery).toMatch(/character the message names/);
  });
});

/*
 * An unquoted term of letters and digits joined by hyphens is one Lucene term,
 * which openFDA's analyzer splits into its parts and ORs (#101):
 * `recall_number:D-0123-2024` answers the 18,148 of `recall_number:(D OR 0123 OR
 * 2024)`, quoted it answers 1. Outside phrases, ranges, and regexps such a whole
 * term, bare or a `field:` value, is sent quoted, with a leading `-` or `+`
 * operator kept outside the quotes. Totals are api.fda.gov's (2026-11-22), as
 * written → quoted.
 */
describe('searchExpression quotes an unquoted hyphenated term (#101)', () => {
  it.each([
    ['0003-0894', '"0003-0894"'], // drug/ndc 259 → 1
    ['0003-0894-21', '"0003-0894-21"'], // drug/ndc 2,260 → 1
    ['69339-364', '"69339-364"'], // drug/ndc 85 → 1
    ['0003-0894 AND brand_name:eliquis', '"0003-0894" AND brand_name:eliquis'], // 5 → 1
    ['D-0123-2024', '"D-0123-2024"'], // drug/enforcement 18,149 → 1
    ['recall_number:D-0123-2024', 'recall_number:"D-0123-2024"'], // 18,148 → 1
    ['extended-release', '"extended-release"'], // drug/label 54,686 → 13,312
    ['COVID-19', '"COVID-19"'], // drug/label 55,269 → 4,963
    // Keyword and date fields answer the same either way.
    ['product_ndc:0003-0894', 'product_ndc:"0003-0894"'], // 1 → 1
    ['packaging.package_ndc:0003-0894-21', 'packaging.package_ndc:"0003-0894-21"'], // 1 → 1
    ['update_date:2026-11-20', 'update_date:"2026-11-20"'], // drug/shortages 32 → 32
  ])('%j → %j', (search, quoted) => {
    expect(parse(search)).toBe(quoted);
  });

  describe('keeps a leading - or + operator outside the quotes', () => {
    it.each([
      ['-0003-0894', '-"0003-0894"'],
      // 14 of brand_name:eliquis's 15.
      ['-0003-0894 AND brand_name:eliquis', '-"0003-0894" AND brand_name:eliquis'],
      ['+0003-0894 +brand_name:eliquis', '+"0003-0894" +brand_name:eliquis'],
      ['brand_name:eliquis -0003-0894', 'brand_name:eliquis -"0003-0894"'],
      ['-recall_number:D-0123-2024', '-recall_number:"D-0123-2024"'],
      ['(-a-b)', '(-"a-b")'],
      ['(x)-a-b', '(x)-"a-b"'],
    ])('%j → %j', (search, quoted) => {
      expect(parse(search)).toBe(quoted);
    });
  });

  describe('at every term boundary', () => {
    it.each([
      ['(0003-0894)', '("0003-0894")'],
      ['brand_name:(a-b OR c-d)', 'brand_name:("a-b" OR "c-d")'],
      ['a-b c-d', '"a-b" "c-d"'],
      ['(x)a-b', '(x)"a-b"'],
      ['a-b(x)', '"a-b"(x)'],
      ['NOT a-b', 'NOT "a-b"'],
      ['a:"x" b-c', 'a:"x" "b-c"'],
      ['a:[1 TO 2] b-c', 'a:[1 TO 2] "b-c"'],
      ['a:/x/ b-c', 'a:/x/ "b-c"'],
      ['field.exact:A1-b2-C3', 'field.exact:"A1-b2-C3"'],
      // After the + and whitespace rules, which run first.
      ['0003-0894+AND+brand_name:eliquis', '"0003-0894" AND brand_name:eliquis'],
      ['0003-0894\tAND brand_name:eliquis', '"0003-0894" AND brand_name:eliquis'],
      ['recall_number:D-0123-2024+status:ongoing', 'recall_number:"D-0123-2024" status:ongoing'],
    ])('%j → %j', (search, quoted) => {
      expect(parse(search)).toBe(quoted);
    });
  });

  it.each([
    // Quoted phrases, ranges, and regexps, where a hyphen is the caller's data.
    'brand_name:"0003-0894"',
    '"x a-b',
    'update_date:[2026-11-20 TO 2026-12-01]',
    'update_date:{2026-11-20 TO 2026-12-01}',
    // A bound with whitespace after it, which the term boundary alone would quote.
    'update_date:[ 2026-11-20 TO 2026-12-01 ]',
    'update_date:{ 2026-11-20 TO 2026-12-01 }',
    'update_date:[2026-11-20 TO 2026-12-01 ]',
    'a:[1 TO 2\\] b-c]',
    'brand_name:/x a-b y/',
    'brand_name:/a-b/',
    'brand_name:/x\\/ a-b/',
    'x/a-b',
    // A term holding any other character.
    'recall_number:D-0123*',
    '1.5-mg',
    'a\\-b',
    'a-b\\ c',
    'a_b-c',
    'a-b_c',
    'a.b-c',
    'a-b.c',
    'a-b*',
    'a-b"c"',
    'a--b',
    'a-b-',
    '-a',
    'a-',
    '--a-b',
    // Not a whole term: a field name, an escaped boundary, a prefix after a colon.
    'a-b:c',
    'x\\ a-b',
    'x\\(a-b',
    'a\\:b-c',
    'field:-a-b',
    'field:+a-b',
    'x&&a-b',
    // A `-` after whitespace is NOT; 2 of brand_name:eliquis's 15.
    'brand_name:eliquis -dosage_form:tablet',
  ])('leaves %j as written', (search) => {
    expect(parse(search)).toBe(search);
  });

  // The guard rejects the query anyway; its message counts the caller's own text.
  it('leaves a query holding a refused character unquoted, so the guard names its position as written', () => {
    const search = '0003-0894 AND brand_name:tyl;nol';
    expect(parse(search)).toBe(search);
    expect(guard(parse(search))?.message).toContain('";" at position 29,');
  });

  it.each(['a-b "c', 'a-b (c', 'a-b [1 TO 2', 'a-b)', 'a-b]', 'a-b\\', '(a-b', 'a-b) c-d'])(
    'leaves the delimiter verdict on %j unchanged',
    (search) => {
      expect(findSearchDelimiterFault(parse(search))).toBe(findSearchDelimiterFault(search));
    },
  );

  it('balances every quote it adds', () => {
    expect(findSearchDelimiterFault(parse('a-b c:d-e (-f-g OR +h-i)'))).toBeUndefined();
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

  // The boundary: the same search with nothing matched gets the hint, with one record matched none.
  it('names the phrase at total 0, the boundary below a match of one', () => {
    expect(phrasePlusHint('a:"x+y"', 0)).toBe(
      'A "+" inside a quoted phrase is a literal plus sign, not a space, so `"x+y"` can match only values spelled with one. If its words are meant to be separate, write them with spaces: `"x y"`.',
    );
  });

  it.each([
    ['a matched set', 'a:"x+y"', 5],
    ['a matched set of one', 'a:"x+y"', 1],
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
 * Every scanner walks caller-sized text — the schema's three rewrites, the
 * guard's character and delimiter checks, and the phrase-plus hint: each shape
 * is timed from 5k characters, doubling to 320k, with the absolute bound checked
 * at every size before the next and the full-span ratio checked at the end, on
 * this thread's CPU time.
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
    ['tabs and no-break spaces throughout', (n) => `a\t${cp(0xa0)}`.repeat(n / 3)],
    ['bounded hyphenated terms', (n) => 'a-b '.repeat(n / 4)],
    ['one hyphenated chain ending in a wildcard', (n) => `${'a-'.repeat(n / 2 - 1)}a*`],
    ['one long run ending in a hyphen', (n) => `${'a'.repeat(n - 1)}-`],
    ['prefix operators before no term', (n) => ' -(+'.repeat(n / 4)],
    ['field prefixes before unbounded hyphenated values', (n) => 'a:b-c'.repeat(n / 5)],
    ['an unterminated phrase of hyphenated terms', (n) => `"${'a-b '.repeat(n / 4)}`],
    ['an unterminated regexp of hyphenated terms', (n) => `/${'a-b '.repeat(n / 4)}`],
    ['an unclosed range of hyphenated terms', (n) => `[${'a-b '.repeat(n / 4)}`],
    ['escaped boundaries before hyphenated terms', (n) => '\\ a-b'.repeat(n / 5)],
    [
      'nested group openers, then hyphenated terms',
      (n) => `${'('.repeat(n / 2)}${'a-b)'.repeat(n / 8)}`,
    ],
    ['hyphenated terms, then one refused character', (n) => `${'a-b '.repeat(n / 4)};`],
    ['a long accepted run, then a non-ASCII character', (n) => `${'a'.repeat(n - 1)}${cp(0xae)}`],
  ];
  const guardContext = createMockContext({ errors: [malformedSearchError] });
  const scanners: [string, (search: string) => unknown][] = [
    ['searchExpression', (search) => searchExpression().safeParse(search)],
    [
      'assertSearchDelimitersBalanced',
      (search) => {
        try {
          assertSearchDelimitersBalanced(search, guardContext);
        } catch (error) {
          return error;
        }
        return;
      },
    ],
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

/**
 * @fileoverview The shared `search` input (#75): which `+` it reads as a space,
 * which it leaves as sent, the schema contract it keeps, and the empty-result
 * hint for a `+` inside a quoted phrase. Totals in the comments are
 * api.fda.gov's answers (2026-10-26) for the string as sent before and after.
 * Also the per-endpoint page size every paged tool's `limit` resolves through
 * (#92): the default and cap table, the clamp with its log line, counter, and
 * notice, the strict `OPENFDA_CLAMP_LIMITS=false` rejection, and the JSON
 * Schema each mode advertises. Per-tool wiring is asserted where each tool is
 * tested.
 * @module tests/mcp-server/tools/schema-utils.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockLogger } from '@cyanheads/mcp-ts-core/testing';
import { createNoopMeter, type MeterProvider, metrics } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  findSearchDelimiterFault,
  limitAboveCapError,
  nonBlankString,
  PAGE_SIZES,
  type PageSize,
  pageLimit,
  pageLimitBy,
  pageSizeNotice,
  phrasePlusHint,
  resolvePageSize,
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

/* --- page size (#92) --- */

/** Run `body` with `OPENFDA_CLAMP_LIMITS=false`, restoring the clamping default after. */
function strictly<T>(body: () => T): T {
  vi.stubEnv('OPENFDA_CLAMP_LIMITS', 'false');
  resetServerConfig();
  try {
    return body();
  } finally {
    vi.unstubAllEnvs();
    resetServerConfig();
  }
}

/** Each `add()` the fake global meter's counters receive, by instrument name. */
const recorded: { name: string; value: number; attributes: unknown }[] = [];

describe('PAGE_SIZES', () => {
  it('pins the default and cap of every endpoint and the count term list', () => {
    expect(PAGE_SIZES).toEqual({
      'drug/event': { default: 5, cap: 25 },
      'food/event': { default: 25, cap: 1000 },
      'device/event': { default: 10, cap: 175 },
      'drug/enforcement': { default: 25, cap: 1000 },
      'food/enforcement': { default: 25, cap: 1000 },
      'device/enforcement': { default: 10, cap: 125 },
      'device/recall': { default: 10, cap: 50 },
      'drug/drugsfda': { default: 25, cap: 375 },
      'device/510k': { default: 10, cap: 175 },
      'device/pma': { default: 25, cap: 575 },
      'animalandveterinary/event': { default: 25, cap: 450 },
      'drug/shortages': { default: 25, cap: 1000 },
      'tobacco/problem': { default: 25, cap: 1000 },
      'drug/ndc': { default: 25, cap: 1000 },
      'drug/label': { default: 5, cap: 1000 },
      count: { default: 100, cap: 1000 },
    });
  });
});

describe('resolvePageSize', () => {
  beforeEach(() => {
    recorded.length = 0;
    const meter = Object.assign(createNoopMeter(), {
      createCounter: (name: string) => ({
        add: (value: number, attributes?: unknown) => {
          recorded.push({ name, value, attributes });
        },
      }),
    });
    metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider);
  });

  afterEach(() => {
    metrics.disable();
  });

  it('applies the endpoint default when limit is omitted', () => {
    const log = createMockLogger();
    expect(resolvePageSize(undefined, 'drug/event', { log })).toEqual({
      cap: 25,
      kind: 'drug/event',
      limit: 5,
    });
    expect(log.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it.each([
    [1, 'drug/event'],
    [25, 'drug/event'],
    [1000, 'count'],
  ] as const)('applies limit=%i on %s as sent', (limit, kind) => {
    const log = createMockLogger();
    const size = resolvePageSize(limit, kind, { log });
    expect(size.limit).toBe(limit);
    expect(size.clampedFrom).toBeUndefined();
    expect(log.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('clamps cap + 1 to the cap with one log line and one counter increment', () => {
    const log = createMockLogger();
    expect(resolvePageSize(26, 'drug/event', { log })).toEqual({
      cap: 25,
      clampedFrom: 26,
      kind: 'drug/event',
      limit: 25,
    });
    expect(log.calls).toEqual([
      {
        level: 'info',
        msg: 'Clamped limit to the endpoint cap',
        data: { endpoint: 'drug/event', requested: 26, cap: 25 },
      },
    ]);
    expect(recorded).toEqual([
      { name: 'openfda.limit.clamped', value: 1, attributes: { 'openfda.endpoint': 'drug/event' } },
    ]);
  });

  it('clamps the count term list at 1000', () => {
    const log = createMockLogger();
    expect(resolvePageSize(5000, 'count', { log })).toEqual({
      cap: 1000,
      clampedFrom: 5000,
      kind: 'count',
      limit: 1000,
    });
    expect(recorded).toEqual([
      { name: 'openfda.limit.clamped', value: 1, attributes: { 'openfda.endpoint': 'count' } },
    ]);
  });

  describe('with OPENFDA_CLAMP_LIMITS=false', () => {
    it('rejects cap + 1 as limit_above_cap, with no log line or counter', () => {
      const log = createMockLogger();
      let thrown: unknown;
      strictly(() => {
        try {
          resolvePageSize(26, 'drug/event', { log });
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'limit=26 exceeds the 25 cap for drug/event.',
        data: { reason: 'limit_above_cap', cap: 25 },
      });
      expect(log.calls).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('applies the cap itself and the default as before', () => {
      const log = createMockLogger();
      strictly(() => {
        expect(resolvePageSize(25, 'drug/event', { log }).limit).toBe(25);
        expect(resolvePageSize(undefined, 'drug/event', { log }).limit).toBe(5);
      });
    });
  });

  it('declares limit_above_cap as a service-thrown ValidationError', () => {
    expect(limitAboveCapError).toMatchObject({
      reason: 'limit_above_cap',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
    });
  });
});

describe('pageSizeNotice', () => {
  const clamped: PageSize = { cap: 25, clampedFrom: 26, kind: 'drug/event', limit: 25 };
  const page = (skip: number, returned: number, total: number) => ({
    meta: { skip, total },
    results: Array.from({ length: returned }, (_, i) => ({ i })),
  });

  it('says nothing when limit was not clamped', () => {
    expect(pageSizeNotice({ cap: 25, kind: 'drug/event', limit: 25 }, page(0, 25, 100))).toBe(
      undefined,
    );
  });

  it('names the requested value, the cap, and the next skip', () => {
    expect(pageSizeNotice(clamped, page(0, 25, 100))).toBe(
      'limit=26 is above the 25-record cap for drug/event, so 25 was applied. The next page starts at skip=25.',
    );
  });

  it('counts the next skip from the page offset', () => {
    expect(pageSizeNotice(clamped, page(50, 25, 100))).toContain('starts at skip=75.');
  });

  it('says when the page ends the match', () => {
    expect(pageSizeNotice(clamped, page(90, 10, 100))).toBe(
      'limit=26 is above the 25-record cap for drug/event, so 25 was applied; this page holds the last 10 of the 100 matched records.',
    );
  });

  it('names skip=25000 itself as reachable', () => {
    expect(pageSizeNotice(clamped, page(24_975, 25, 100_000))).toContain(
      'The next page starts at skip=25000.',
    );
  });

  it('says when the next page would pass the 25000-record skip ceiling', () => {
    expect(pageSizeNotice(clamped, page(24_990, 25, 100_000))).toBe(
      "limit=26 is above the 25-record cap for drug/event, so 25 was applied. The next page would start at skip=25015, past openFDA's 25000-record pagination ceiling — narrow the search to reach the rest.",
    );
  });

  it('states only the clamp on an empty page', () => {
    expect(pageSizeNotice(clamped, page(0, 0, 0))).toBe(
      'limit=26 is above the 25-record cap for drug/event, so 25 was applied.',
    );
  });

  it('words the count term list in terms, with no skip', () => {
    expect(pageSizeNotice({ cap: 1000, clampedFrom: 5000, kind: 'count', limit: 1000 })).toBe(
      'limit=5000 is above the 1000-term cap for a count, so 1000 was applied.',
    );
  });
});

describe('the advertised limit schema', () => {
  it('advertises minimum 1, the default, and no maximum while clamping', () => {
    const schema = z.toJSONSchema(pageLimit('drug/label', 'Labels per page.'));
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      default: 5,
      type: 'integer',
      minimum: 1,
      description: 'Labels per page. Default 5; a larger value returns at most 1000 and says so.',
    });
    expect('maximum' in schema).toBe(false);
  });

  it('advertises maximum at the cap in strict mode', () => {
    const schema = strictly(() => z.toJSONSchema(pageLimit('drug/label', 'Labels per page.')));
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      default: 5,
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Labels per page. Default 5, at most 1000.',
    });
  });

  it('admits a value above the cap while clamping and rejects it in strict mode', () => {
    expect(pageLimit('count', 'Terms.').parse(1001)).toBe(1001);
    const issues = strictly(() => pageLimit('count', 'Terms.').safeParse(1001).error?.issues);
    expect(issues).toMatchObject([{ code: 'too_big', maximum: 1000, inclusive: true }]);
    expect(strictly(() => pageLimit('count', 'Terms.').parse(1000))).toBe(1000);
  });

  it.each([0, 2.5])('rejects %s in both modes', (value) => {
    expect(pageLimit('count', 'Terms.').safeParse(value).success).toBe(false);
    expect(strictly(() => pageLimit('count', 'Terms.').safeParse(value).success)).toBe(false);
  });

  describe('for a tool whose endpoint follows another input', () => {
    const byCategory = () =>
      pageLimitBy(
        'category',
        [
          ['drug', 'drug/event'],
          ['device', 'device/event'],
        ],
        'Reports per page.',
      );

    it('advertises no default and no maximum while clamping', () => {
      const schema = z.toJSONSchema(byCategory());
      expect(schema).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'integer',
        minimum: 1,
        description:
          'Reports per page. Default and cap by category: drug 5 (cap 25), device 10 (cap 175); a larger value returns at most that cap and says so.',
      });
      expect(byCategory().parse(undefined)).toBeUndefined();
    });

    it('advertises its largest cap as the strict-mode maximum', () => {
      const schema = strictly(() => z.toJSONSchema(byCategory()));
      expect(schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 175 });
      expect(schema).not.toHaveProperty('default');
      expect(schema.description).toBe(
        'Reports per page. Default and cap by category: drug 5 (cap 25), device 10 (cap 175); a value above that cap is rejected.',
      );
      // Under the largest cap, the schema admits it; resolvePageSize rejects it per endpoint.
      expect(strictly(() => byCategory().parse(26))).toBe(26);
      expect(strictly(() => byCategory().safeParse(176).success)).toBe(false);
    });
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

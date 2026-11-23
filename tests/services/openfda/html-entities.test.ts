/**
 * @fileoverview Tests for the character-reference decoder shared by the SPL
 * table renderer and the service's upstream error text.
 * @module tests/services/openfda/html-entities.test
 */

import { describe, expect, it } from 'vitest';
import { decodeEntities } from '@/services/openfda/html-entities.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

describe('decodeEntities', () => {
  it('decodes the five XML named entities and decimal and hex references', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos; &#39;&#x2020;&#X2265;&#8224;')).toBe(
      `<>&"' '†≥†`,
    );
  });

  it.each([
    ['&amp;lt;', '&lt;'],
    ['&amp;amp;', '&amp;'],
    ['&amp;#39;', '&#39;'],
    ['&amp;quot;x&amp;quot;', '&quot;x&quot;'],
  ])('decodes %j in one pass, never re-reading what it produced', (input, output) => {
    expect(decodeEntities(input)).toBe(output);
  });

  it.each(['&constructor;', '&__proto__;', '&toString;', '&hasOwnProperty;', '&nbsp;', '&AMP;'])(
    'leaves the undeclared name %s as written',
    (input) => {
      expect(decodeEntities(`a ${input} b`)).toBe(`a ${input} b`);
    },
  );

  it.each(['&#0;', '&#xD800;', '&#xDFFF;', '&#x110000;', '&#99999999999;'])(
    'leaves the invalid code point %s as written',
    (input) => {
      expect(decodeEntities(input)).toBe(input);
    },
  );

  it('leaves an unterminated reference and a bare ampersand as written', () => {
    expect(decodeEntities('AT&T &amp &#39 & &;')).toBe('AT&T &amp &#39 & &;');
  });

  it.each<[string, (n: number) => string]>([
    ['one unclosed decimal opener before a long digit run', (n) => `&#${'1'.repeat(n - 2)}\n`],
    ['one unclosed hex opener before a long hex run', (n) => `&#x${'a'.repeat(n - 3)}\n`],
    ['repeated decimal openers with no closer', (n) => `${'&#1'.repeat(n / 3)}\n`],
    ['repeated named prefixes with no closer', (n) => `${'&amp'.repeat(n / 4)}\n`],
    ['repeated complete references', (n) => `${'&amp;'.repeat(n / 5)}\n`],
    ['openers between line breaks throughout', (n) => '&#1  \r\n'.repeat(n / 7)],
    ['named prefixes between line breaks throughout', (n) => '&quot  \r\n'.repeat(n / 9)],
  ])('stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(decodeEntities, build(5_040), build(322_560));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

/**
 * @fileoverview Decodes the character references in openFDA text: the SPL
 * markup of `drug/label` `*_table` fields, and the `error.message` openFDA
 * HTML-escapes before sending.
 * @module services/openfda/html-entities
 */

const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;

/** The five XML named entities, keyed by name. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['quot', '"'],
]);

/**
 * Decode numeric character references and the five XML named entities, in one
 * left-to-right pass: decoded text is never re-scanned, so `&amp;lt;` comes out
 * as `&lt;`. Any other `&name;` and an invalid code point stay as written.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, hex: string, dec: string, named: string) => {
    if (named) return NAMED_ENTITIES.get(named) ?? match;
    const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

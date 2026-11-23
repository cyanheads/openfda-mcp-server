/**
 * @fileoverview Tests for the drug/shortages date rewrite: the value table for
 * one date value, the positions a date takes in a query, the empty-result hint
 * for a date-field group the rewrite leaves as written, and the timing bounds.
 * @module tests/mcp-server/tools/shortage-dates.test
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalShortageDate,
  rewriteShortageDates,
  shortageDateGroupHint,
} from '@/mcp-server/tools/shortage-dates.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

describe('canonicalShortageDate', () => {
  it.each([
    ['YYYYMMDD', '20261120', '2026-11-20'],
    ['YYYYMMDD on the first of a month', '20260101', '2026-01-01'],
    ['MM/DD/YYYY, the stored form', '11/20/2026', '2026-11-20'],
    ['M/D/YYYY', '1/5/2026', '2026-01-05'],
    ['M/DD/YYYY', '1/15/2026', '2026-01-15'],
    ['MM/D/YYYY', '12/5/2026', '2026-12-05'],
    ['YYYY-M-D', '2026-1-5', '2026-01-05'],
    ['YYYY-MM-D', '2026-11-5', '2026-11-05'],
    ['YYYY-M-DD', '2026-1-20', '2026-01-20'],
    ['29 February in a leap year', '20240229', '2024-02-29'],
    ['29 February in a century divisible by 400', '2/29/2000', '2000-02-29'],
    ['31 December', '2026-12-31', '2026-12-31'],
  ])('rewrites %s', (_name, value, expected) => {
    expect(canonicalShortageDate(value)).toBe(expected);
  });

  it('leaves an already-correct YYYY-MM-DD value as written', () => {
    expect(canonicalShortageDate('2026-11-20')).toBe('2026-11-20');
  });

  it.each([
    ['month 13', '20261301'],
    ['month 13 written M/D/YYYY (never read day-first)', '13/01/2026'],
    ['month 0', '2026-0-10'],
    ['day 0', '20260100'],
    ['30 February', '20260230'],
    ['29 February outside a leap year', '2/29/2025'],
    ['29 February in a century not divisible by 400', '19000229'],
    ['31 April', '2026-04-31'],
    ['epoch milliseconds', '1795132800000'],
    ['an eight-digit value that is no date', '99999999'],
    ['a date-time', '2026-11-20T00:00:00'],
    ['date math', 'now-30d'],
    ['now', 'now'],
    ['an open range bound', '*'],
    ['a two-digit year', '11/20/26'],
    ['a slashed year-first date', '2026/11/20'],
    ['a three-digit month', '2026-011-20'],
    ['a seven-digit value', '2026112'],
    ['a wildcard', '2026112*'],
    ['a leading space', ' 20261120'],
    ['an escaped slash', '11\\/20\\/2026'],
    ['date math anchored on a date', '2026-11-20||+1d'],
    ['an empty value', ''],
    ['non-ASCII digits', '２０２６１１２０'],
  ])('leaves %s as written', (_name, value) => {
    expect(canonicalShortageDate(value)).toBe(value);
  });

  it.each([
    ['a long digit run ending in a line break', (n: number) => `${'2'.repeat(n - 1)}\n`],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['repeated date-shaped runs', (n: number) => '2026-1-1/'.repeat(Math.ceil(n / 9))],
  ])('stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(canonicalShortageDate, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

describe('rewriteShortageDates', () => {
  it.each([
    ['a bare term, sent quoted', 'update_date:20261120', 'update_date:"2026-11-20"'],
    ['a quoted term, quotes kept', 'update_date:"11/20/2026"', 'update_date:"2026-11-20"'],
    ['a quoted YYYYMMDD term', 'update_date:"20261120"', 'update_date:"2026-11-20"'],
    ['a bare slash-form term', 'update_date:11/20/2026', 'update_date:"2026-11-20"'],
    [
      'a bare slash-form term followed by another clause',
      'update_date:11/20/2026 AND status:"Current"',
      'update_date:"2026-11-20" AND status:"Current"',
    ],
    [
      'a bare slash-form term closing a group',
      '(update_date:1/5/2026) OR status:"Current"',
      '(update_date:"2026-01-05") OR status:"Current"',
    ],
    [
      'a field clause inside a group',
      'status:"Current" AND (update_date:20261120 OR change_date:20261104)',
      'status:"Current" AND (update_date:"2026-11-20" OR change_date:"2026-11-04")',
    ],
    ['a bare YYYY-M-D term', 'update_date:2026-1-5', 'update_date:"2026-01-05"'],
    ['a quoted YYYY-M-D term', 'update_date:"2026-1-5"', 'update_date:"2026-01-05"'],
    [
      'the lower bound of an open range',
      'initial_posting_date:[20260101 TO *]',
      'initial_posting_date:[2026-01-01 TO *]',
    ],
    [
      'the upper bound of an open range',
      'initial_posting_date:[* TO 20251231]',
      'initial_posting_date:[* TO 2025-12-31]',
    ],
    [
      'both bounds of an inclusive range',
      'initial_posting_date:[20260101 TO 20261231]',
      'initial_posting_date:[2026-01-01 TO 2026-12-31]',
    ],
    [
      'both bounds of an exclusive range',
      'initial_posting_date:{12/31/2025 TO 2027-1-1}',
      'initial_posting_date:{2025-12-31 TO 2027-01-01}',
    ],
    [
      'a range with mixed brackets',
      'update_date:[20260101 TO 20261231}',
      'update_date:[2026-01-01 TO 2026-12-31}',
    ],
    [
      'quoted range bounds, quotes kept',
      'initial_posting_date:["01/01/2026" TO "12/31/2026"]',
      'initial_posting_date:["2026-01-01" TO "2026-12-31"]',
    ],
    ['discontinued_date', 'discontinued_date:20260224', 'discontinued_date:"2026-02-24"'],
    ['change_date', 'change_date:[11/1/2026 TO *]', 'change_date:[2026-11-01 TO *]'],
    ['a prohibited clause', '-update_date:20261120', '-update_date:"2026-11-20"'],
    [
      'a required clause',
      '+update_date:20261120 +status:Current',
      '+update_date:"2026-11-20" +status:Current',
    ],
    ['a NOT clause', 'NOT update_date:11/20/2026', 'NOT update_date:"2026-11-20"'],
    ['whitespace around the colon', 'update_date : 20261120', 'update_date : "2026-11-20"'],
    [
      'every clause of a compound query',
      'update_date:[20260101 TO *] AND discontinued_date:2/24/2026 OR change_date:"11/4/2026"',
      'update_date:[2026-01-01 TO *] AND discontinued_date:"2026-02-24" OR change_date:"2026-11-04"',
    ],
  ])('rewrites %s', (_name, search, expected) => {
    expect(rewriteShortageDates(search)).toBe(expected);
  });

  it.each([
    ['an already-correct quoted term', 'update_date:"2026-11-20"'],
    ['an already-correct bare term', 'update_date:2026-11-20'],
    ['an already-correct range', 'initial_posting_date:[2026-01-01 TO 2026-12-31]'],
    ['a field group', 'update_date:(20261120 OR 20261121)'],
    ['a regexp on a date field', 'update_date:/20.*/'],
    ['a slash run that is no date', 'update_date:13/45/2026'],
    ['a slash run followed by a boost', 'update_date:11/20/2026^2'],
    ['a slash run longer than a date', 'update_date:11/20/20261'],
    ['a slash run with a trailing slash', 'update_date:11/20/2026/'],
    ['escaped slashes', 'update_date:11\\/20\\/2026'],
    ['date math', 'update_date:[now-30d TO now]'],
    ['epoch milliseconds', 'update_date:1795132800000'],
    ['a date-time', 'update_date:"2026-11-20T00:00:00"'],
    ['a date-shaped value on another field', 'generic_name:20261120 AND package_ndc:11/20/2026'],
    ["a date token inside another field's phrase", 'generic_name:"update_date:20261120"'],
    ['a .exact path', 'update_date.exact:20261120'],
    ['an _exists_ clause', '_exists_:update_date'],
    ['a field named like an Object member', 'constructor:20261120'],
    ['a bare value with no field', '20261120'],
    ['a query with no date field', 'status:"Current" AND therapeutic_category:"Oncology"'],
  ])('leaves %s as written', (_name, search) => {
    expect(rewriteShortageDates(search)).toBe(search);
  });

  // The guard rejects such a query before any request and names the character's position in it.
  it.each([
    ['after a date', 'update_date:20261120 AND generic_name:a;b'],
    ['before a date', 'generic_name:a;b AND update_date:11/20/2026'],
    ['inside a range on a date field', 'update_date:[20260101 TO 2026~1231]'],
    ['outside ASCII', 'update_date:20261120 AND generic_name:café'],
  ])('leaves a query holding a character openFDA refuses as written: %s', (_name, search) => {
    expect(rewriteShortageDates(search)).toBe(search);
  });

  it('rewrites inside an unclosed phrase without throwing, for the delimiter guard to reject', () => {
    expect(rewriteShortageDates('update_date:"20261120')).toBe('update_date:"2026-11-20');
  });

  const clauses = (clause: string, separator: string) => (n: number) =>
    `${`${clause}${separator}`.repeat(Math.ceil(n / (clause.length + separator.length)))}`;

  it.each([
    [
      'one long line of slash-form terms ending in a break',
      (n: number) => `${clauses('update_date:11/20/2026', ' OR ')(n)}\n`,
    ],
    [
      'range clauses with breaks throughout',
      clauses('update_date:[20260101 TO 20261231]', '  \r\n'),
    ],
    ['quoted terms with breaks throughout', clauses('change_date:"1/5/2026"', '  \r\n')],
    ['clauses on other fields', clauses('generic_name:20261120', ' AND ')],
    ['unterminated slash runs', (n: number) => `update_date:${'1/'.repeat(n / 2)}`],
  ])('stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(rewriteShortageDates, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

/*
 * The rewrite leaves a `field:(…)` group as written, so
 * `update_date:(20261120 OR 20261119)` answers 0 where
 * `update_date:("11/20/2026" OR "11/19/2026")` answers 95 (api.fda.gov,
 * 2026-11-22). The hint names the group's field and the form to write.
 */
describe('shortageDateGroupHint', () => {
  const hint = (field: string) =>
    `Dates inside the ${field}:(...) group are sent as written, so write each one YYYY-MM-DD.`;

  it.each(['initial_posting_date', 'update_date', 'discontinued_date', 'change_date'])(
    'names a group on %s',
    (field) => {
      expect(shortageDateGroupHint(`${field}:(20261120 OR 20261119)`)).toBe(hint(field));
    },
  );

  it.each([
    ['inside an outer group', 'status:"Current" AND (update_date:(20261120 OR 20261119))'],
    ['prohibited', 'generic_name:carboplatin -update_date:(11/20/2026)'],
    ['with whitespace around the colon', 'update_date : ( 20261120 )'],
    ['holding a range', 'update_date:([20261101 TO 20261130] OR 20261120)'],
    ['unclosed', 'update_date:(20261120 OR'],
    ['after a group on another field', 'generic_name:(a OR b) AND update_date:(20261120)'],
  ])('names a date-field group %s', (_name, search) => {
    expect(shortageDateGroupHint(search)).toBe(hint('update_date'));
  });

  it('names the first date-field group when there are several', () => {
    expect(shortageDateGroupHint('change_date:(20261104) OR initial_posting_date:(20260101)')).toBe(
      hint('change_date'),
    );
  });

  it.each([
    ['no search', undefined],
    ['a term', 'update_date:20261120'],
    ['a quoted term', 'update_date:"11/20/2026"'],
    ['a range', 'update_date:[20260101 TO *]'],
    ['a field clause inside a bare group', '(update_date:20261120 OR change_date:20261104)'],
    ['a group on another field', 'generic_name:(20261120 OR carboplatin)'],
    ['a .exact path', 'update_date.exact:(20261120)'],
    ['a date-field group inside a phrase', 'generic_name:"update_date:(20261120)"'],
    ['a field named like an Object member', 'constructor:(20261120)'],
    ['a bare group', '(20261120 OR 20261119)'],
  ])('says nothing for %s', (_name, search) => {
    expect(shortageDateGroupHint(search)).toBeUndefined();
  });

  const repeated = (clause: string, separator: string) => (n: number) =>
    `${clause}${separator}`.repeat(Math.ceil(n / (clause.length + separator.length)));

  it.each([
    [
      'one long line of groups on another field ending in a break',
      (n: number) => `${repeated('generic_name:(a OR b)', ' AND ')(n)}\n`,
    ],
    ['date-field groups with breaks throughout', repeated('update_date:(20261120)', '  \r\n')],
    ['unclosed date-field groups', repeated('update_date:(', ' ')],
    ['nested openers', (n: number) => '('.repeat(n)],
  ])('stays linear on %s', (_name, build) => {
    const { t5k, t320k } = linearTiming(shortageDateGroupHint, build(5_000), build(320_000));
    expect(t320k / t5k).toBeLessThan(256);
    expect(t320k).toBeLessThan(500_000);
  });
});

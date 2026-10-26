/**
 * @fileoverview openfda_count_values truncation disclosure against the real
 * OpenFdaService with a stubbed HTTP boundary. openFDA count responses carry no
 * distinct-term total, so the tool asks for one term past `limit` and treats
 * that look-ahead row as the only completeness signal — asserted here on the
 * outgoing `limit` and on both `structuredContent` and `content[]`.
 * @module tests/mcp-server/tools/definitions/count-values.truncation.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { initOpenFdaService } from '@/services/openfda/openfda-service.js';

const http = createFetchMock();

/** A count response holding `n` terms ranked by descending count. */
const tally = (n: number) => () =>
  Response.json({
    meta: { last_updated: '2026-09-18', terms: {} },
    results: Array.from({ length: n }, (_, i) => ({ term: `TERM${i + 1}`, count: 1000 * (n - i) })),
  });

const NO_MATCHES = () =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }, { status: 404 });

/**
 * A date-field count response: openFDA sends `{ time, count }` rows, one per
 * distinct date, in ascending date order, whatever `limit` asked for.
 */
const dateBuckets = (rows: Record<string, unknown>[]) => () =>
  Response.json({ meta: { last_updated: '2026-10-24' }, results: rows });

/** `drug/enforcement` `report_date` over January 2024, as openFDA answers it. */
const JAN_2024 = [
  { time: '20240103', count: 50 },
  { time: '20240110', count: 6 },
  { time: '20240117', count: 5 },
  { time: '20240124', count: 30 },
  { time: '20240131', count: 19 },
];

/** `n` ascending date buckets whose counts rise with the date. */
const risingBuckets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ time: String(20000101 + i * 100), count: i + 1 }));

/** The table rows `format()` renders, one per term. */
const tableRows = (text: string) => text.split('\n').filter((line) => /^\| \d/.test(line));

/** The `limit` query parameter of the n-th upstream request. */
const sentLimit = (index = 0) => new URL(http.calls[index]!.request.url).searchParams.get('limit');

function textOfResult(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

interface CountStructured {
  cap?: number;
  notice?: string;
  results: { term: string; count: number }[];
  shown?: number;
  termCount: number;
  truncated?: boolean;
  truncationCeiling?: number;
}

describe('openfda_count_values — truncation from the look-ahead row', () => {
  beforeAll(() => {
    initOpenFdaService();
  });

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  // #44 — the repro: a binary field asked for exactly as many terms as exist.
  it('reports an exhaustive list as complete when exactly limit terms exist', async () => {
    http.route({ match: () => true, respond: tally(2) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'serious',
      limit: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(sentLimit()).toBe('3');
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results.map((r) => r.term)).toEqual(['TERM1', 'TERM2']);
    expect(structured.termCount).toBe(2);
    expect(structured.truncated).toBeUndefined();
    expect(structured.shown).toBeUndefined();
    expect(structured.cap).toBeUndefined();
    expect(structured.truncationCeiling).toBeUndefined();
    expect(structured.notice).toBeUndefined();

    const text = textOfResult(result);
    expect(text).toContain('**2 terms**');
    expect(text).not.toMatch(/truncat|more distinct values/i);
  });

  it('discloses truncation, trimmed to limit, when the look-ahead row arrives', async () => {
    http.route({ match: () => true, respond: tally(3) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'patient.reaction.reactionmeddrapt.exact',
      limit: 2,
    });

    expect(sentLimit()).toBe('3');
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([
      { term: 'TERM1', count: 3000 },
      { term: 'TERM2', count: 2000 },
    ]);
    expect(structured.termCount).toBe(2);
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(2);
    expect(structured.cap).toBe(2);
    expect(structured.truncationCeiling).toBe(2000);
    expect(structured.notice).toMatch(/more distinct values exist/i);
    expect(structured.notice).not.toMatch(/may exist/i);

    const text = textOfResult(result);
    expect(text).toContain('**2 terms**');
    expect(text).not.toContain('TERM3');
    expect(text).toMatch(/more distinct values exist/i);
  });

  it('sends openFDA one term past the limit below the 1000-term maximum', async () => {
    http.route({ match: () => true, respond: tally(1) });

    await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'serious',
      limit: 999,
    });

    expect(sentLimit()).toBe('1000');
  });

  it('never sends openFDA more than its 1000-term count maximum', async () => {
    http.route({ match: () => true, respond: tally(1000) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'patient.reaction.reactionmeddrapt.exact',
      limit: 1000,
    });

    expect(sentLimit()).toBe('1000');
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toHaveLength(1000);
    expect(structured.termCount).toBe(1000);
    expect(structured.truncated).toBeUndefined();
    expect(structured.shown).toBeUndefined();
    expect(structured.cap).toBeUndefined();
    expect(structured.notice).toMatch(/1000-term maximum/);
    expect(structured.notice).toMatch(/cannot show whether more distinct values exist/i);
    expect(structured.notice).not.toMatch(/raise limit/i);

    const text = textOfResult(result);
    expect(text).toMatch(/1000-term maximum/);
    expect(text).not.toMatch(/raise limit/i);
  });

  it('reports no truncation at limit 999 when 999 terms come back', async () => {
    http.route({ match: () => true, respond: tally(999) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'serious',
      limit: 999,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toHaveLength(999);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toBeUndefined();
  });

  it('adds no truncation fields when fewer terms than the limit exist', async () => {
    http.route({ match: () => true, respond: tally(1) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'serious',
      limit: 5,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toHaveLength(1);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toBeUndefined();
    expect(textOfResult(result)).not.toMatch(/truncat|more distinct values/i);
  });

  it('keeps the zero-term notice for a search that matched nothing', async () => {
    http.route({ match: () => true, respond: NO_MATCHES });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'serious',
      search: 'patient.drug.medicinalproduct:"zzznotadrugzzz"',
      limit: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([]);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toMatch(/nothing matched/i);
    const text = textOfResult(result);
    expect(text).toContain('No count results.');
    expect(text).toMatch(/nothing matched/i);
  });

  // #67 — a term holding a line break or a pipe stays one row, one cell.
  it('renders each term in its own cell and row', async () => {
    const terms = [
      { term: 'FLORASTOR', count: 40 },
      { term: 'FLORASTOR (SACCHAROMYCES\nBOULARDII LYOPHILISED)', count: 17 },
      { term: 'A|B <E>', count: 3 },
    ];
    http.route({
      match: () => true,
      respond: () => Response.json({ meta: { last_updated: '2026-09-18' }, results: terms }),
    });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'food/event',
      count: 'products.name_brand.exact',
      search: 'products.name_brand:"FLORASTOR"',
      limit: 10,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual(terms);
    const rows = textOfResult(result)
      .split('\n')
      .filter((line) => /^\| \d/.test(line));
    expect(rows).toEqual([
      '| 1 | FLORASTOR | 40 |',
      '| 2 | FLORASTOR (SACCHAROMYCES<br>BOULARDII LYOPHILISED) | 17 |',
      '| 3 | A\\|B \\<E> | 3 |',
    ]);
  });

  // #68 — an empty tally renders the dataset date structuredContent carries.
  it('renders the dataset date ahead of an empty tally', async () => {
    http.route(
      { match: () => true, once: true, respond: tally(1) },
      { match: () => true, respond: NO_MATCHES },
    );
    await runToolContract(countValuesTool, { endpoint: 'drug/event', count: 'serious' });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'serious',
      search: 'patient.drug.medicinalproduct:"zzznotadrugzzz"',
    });

    const structured = result.structuredContent as unknown as { meta: { lastUpdated: string } };
    expect(structured.meta.lastUpdated).toBe('2026-09-18');
    const text = textOfResult(result);
    const date = text.indexOf('Data updated: 2026-09-18');
    expect(date).toBeGreaterThan(-1);
    expect(date).toBeLessThan(text.indexOf('No count results.'));
  });
});

/*
 * #78 — a date field counts into `{ time, count }` buckets. openFDA ignores
 * `limit` on them and sends every bucket in ascending date order, so the tool
 * ranks them itself and the truncation it reports is exact.
 */
describe('openfda_count_values — date-bucket counts', () => {
  beforeAll(() => {
    initOpenFdaService();
  });

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  // The issue repro, call 1.
  it('names each bucket by its date and keeps the top limit by count', async () => {
    http.route({ match: () => true, respond: dateBuckets(JAN_2024) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/enforcement',
      count: 'report_date',
      search: 'report_date:[20240101 TO 20240131]',
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([
      { term: '20240103', count: 50 },
      { term: '20240124', count: 30 },
      { term: '20240131', count: 19 },
    ]);
    expect(structured.termCount).toBe(3);
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(3);
    expect(structured.cap).toBe(3);
    expect(structured.truncationCeiling).toBe(19);
    expect(structured.notice).toMatch(/of the 5 distinct dates/);
    expect(structured.notice).toMatch(/raise limit/i);
    expect(structured.notice).not.toMatch(/cannot show/i);

    const text = textOfResult(result);
    expect(text).not.toContain('undefined');
    expect(tableRows(text)).toEqual([
      '| 1 | 20240103 | 50 |',
      '| 2 | 20240124 | 30 |',
      '| 3 | 20240131 | 19 |',
    ]);
    expect(text).toMatch(/of the 5 distinct dates/);
  });

  it('returns every bucket, ranked, with no truncation when the dates fit the limit', async () => {
    http.route({ match: () => true, respond: dateBuckets(JAN_2024) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/enforcement',
      count: 'report_date',
      search: 'report_date:[20240101 TO 20240131]',
      limit: 5,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results.map((r) => r.term)).toEqual([
      '20240103',
      '20240124',
      '20240131',
      '20240110',
      '20240117',
    ]);
    expect(structured.truncated).toBeUndefined();
    expect(structured.shown).toBeUndefined();
    expect(structured.truncationCeiling).toBeUndefined();
    expect(structured.notice).toBeUndefined();
    expect(textOfResult(result)).not.toMatch(/truncat|distinct/i);
  });

  it('breaks count ties by date ascending, whatever order the buckets arrive in', async () => {
    http.route({
      match: () => true,
      respond: dateBuckets([
        { time: '20240301', count: 7 },
        { time: '20240115', count: 7 },
        { time: '20240220', count: 9 },
        { time: '20240101', count: 7 },
      ]),
    });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'receivedate',
      limit: 3,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([
      { term: '20240220', count: 9 },
      { term: '20240101', count: 7 },
      { term: '20240115', count: 7 },
    ]);
    expect(structured.truncated).toBe(true);
    expect(structured.truncationCeiling).toBe(7);
  });

  // Every bucket is in hand, so even the 1000-term maximum truncates exactly.
  it('reports exact truncation at the 1000-term maximum, without the unknowable notice', async () => {
    http.route({ match: () => true, respond: dateBuckets(risingBuckets(1200)) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'device/510k',
      count: 'decision_date',
      limit: 1000,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toHaveLength(1000);
    expect(structured.results[0]).toEqual({ term: '20120001', count: 1200 });
    expect(structured.results.at(-1)).toEqual({ term: '20020101', count: 201 });
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(1000);
    expect(structured.cap).toBe(1000);
    expect(structured.truncationCeiling).toBe(201);
    expect(structured.notice).toMatch(/of the 1200 distinct dates/);
    expect(structured.notice).not.toMatch(/raise limit/i);
    expect(structured.notice).not.toMatch(/cannot show/i);

    const text = textOfResult(result);
    expect(text).toMatch(/of the 1200 distinct dates/);
    expect(text).not.toMatch(/cannot show|1000-term maximum/i);
  });

  it('calls exactly 1000 buckets at limit 1000 complete', async () => {
    http.route({ match: () => true, respond: dateBuckets(risingBuckets(1000)) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'device/510k',
      count: 'decision_date',
      limit: 1000,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toHaveLength(1000);
    expect(structured.results[0]!.count).toBe(1000);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toBeUndefined();
    expect(textOfResult(result)).not.toMatch(/cannot show|1000-term maximum|truncat/i);
  });

  // A bucket with no date or no numeric count cannot be named or ranked.
  it('leaves out sparse buckets and says so on both surfaces', async () => {
    http.route({
      match: () => true,
      respond: dateBuckets([
        { time: '20240103', count: 50 },
        { time: '20240110' },
        { count: 12 },
        { time: '20240124', count: 30 },
      ]),
    });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/enforcement',
      count: 'report_date',
      limit: 10,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([
      { term: '20240103', count: 50 },
      { term: '20240124', count: 30 },
    ]);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toMatch(/2 count rows/);
    expect(structured.notice).toMatch(/left out/i);

    const text = textOfResult(result);
    expect(text).not.toContain('undefined');
    expect(tableRows(text)).toHaveLength(2);
    expect(text).toMatch(/2 count rows/);
  });

  it('keeps the sparse-row disclosure alongside a truncated ranking', async () => {
    http.route({
      match: () => true,
      respond: dateBuckets([...JAN_2024, { time: '20240201', count: null }]),
    });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/enforcement',
      count: 'report_date',
      limit: 2,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results.map((r) => r.term)).toEqual(['20240103', '20240124']);
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toMatch(/of the 5 distinct dates/);
    expect(structured.notice).toMatch(/1 count row\b/);
  });

  it('does not call a tally of only unreadable rows a search that matched nothing', async () => {
    http.route({ match: () => true, respond: dateBuckets([{ time: '20240103' }, { count: 4 }]) });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/enforcement',
      count: 'report_date',
      search: 'report_date:[20240101 TO 20240131]',
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([]);
    expect(structured.notice).toMatch(/2 count rows/);
    expect(structured.notice).not.toMatch(/nothing matched/i);
    expect(textOfResult(result)).toContain('No count results.');
  });

  it('ranks a mixed response of term and date rows as date buckets', async () => {
    http.route({
      match: () => true,
      respond: dateBuckets([
        { time: '20240103', count: 5 },
        { term: 'ALPHA', count: 9 },
        { time: '20240110', count: 7 },
      ]),
    });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'receivedate',
      limit: 2,
    });

    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([
      { term: 'ALPHA', count: 9 },
      { term: '20240110', count: 7 },
    ]);
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toMatch(/of the 3 distinct/);
  });

  it('keeps the zero-term notice for a date count whose search matched nothing', async () => {
    http.route({ match: () => true, respond: NO_MATCHES });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/event',
      count: 'receivedate',
      search: 'receivedate:[19000101 TO 19000102]',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as CountStructured;
    expect(structured.results).toEqual([]);
    expect(structured.notice).toMatch(/nothing matched/i);
  });
});

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
});

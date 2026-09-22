/**
 * @fileoverview openfda_count_values against the real OpenFdaService with a
 * stubbed HTTP boundary — the `Nothing to count` / `not_aggregatable`
 * classification exercised end to end, on both `structuredContent` and
 * `content[]`, through the tool's public contract.
 * @module tests/mcp-server/tools/definitions/count-values.classification.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { initOpenFdaService } from '@/services/openfda/openfda-service.js';

const http = createFetchMock();

const NOTHING_TO_COUNT = () =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'Nothing to count' } }, { status: 404 });
const ANALYZED_TEXT = () =>
  Response.json(
    {
      error: {
        code: 'SERVER_ERROR',
        message: 'Check your request and try again',
        details:
          '[illegal_argument_exception] Text fields are not optimised for operations that require per-document field data like aggregations and sorting, so these operations are disabled by default. Please use a keyword field instead. Alternatively, set fielddata=true on [device_class] in order to load field data by uninverting the inverted index.',
      },
    },
    { status: 500 },
  );
const TALLY = () =>
  Response.json({
    meta: { results: {}, last_updated: '2026-09-18' },
    results: [{ term: 'LEVOTHYROXINE SODIUM', count: 431 }],
  });

/** Whether the request carries a `search` parameter. */
const scoped = (request: Request) => new URL(request.url).searchParams.has('search');

function textOfResult(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('openfda_count_values — upstream classification', () => {
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

  // #57 — the repro: an uncataloged but countable expression under a search that
  // matches only records lacking the field.
  it('returns an empty tally with a no-values notice when the matched records lack the field', async () => {
    http.route(
      { match: scoped, respond: NOTHING_TO_COUNT },
      { match: (request) => !scoped(request), respond: TALLY },
    );

    const result = await runToolContract(countValuesTool, {
      endpoint: 'drug/enforcement',
      search: '_missing_:openfda.generic_name',
      count: 'openfda.generic_name.exact',
      limit: 5,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: unknown[];
      termCount: number;
      notice?: string;
    };
    expect(structured.results).toEqual([]);
    expect(structured.termCount).toBe(0);
    expect(structured.notice).toContain('openfda.generic_name.exact');
    expect(structured.notice).toMatch(/carry no value/i);
    expect(structured.notice).not.toMatch(/nothing matched/i);

    const text = textOfResult(result);
    expect(text).toContain('No count results.');
    expect(text).toContain('openfda.generic_name.exact');
    expect(text).toMatch(/carry no value/i);
    expect(http.calls).toHaveLength(2);
  });

  // #49 — steps 1 and 2 of the repro: each form fails, and neither message offers
  // the other form, on either surface.
  it.each([
    ['device_class', ANALYZED_TEXT],
    ['device_class.exact', NOTHING_TO_COUNT],
  ])('fails %s as not_aggregatable with no suffix toggle', async (count, respond) => {
    http.route({ match: () => true, respond });

    const result = await runToolContract(countValuesTool, {
      endpoint: 'device/classification',
      search: 'product_code:"DXN"',
      count,
      limit: 10,
    });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      }
    ).error;
    expect(error.code).toBe(-32007);
    expect(error.data).toMatchObject({ reason: 'not_aggregatable', count });
    expect(error.message).toMatch(/"device_class" has no countable form/);

    const text = textOfResult(result);
    expect(text).toMatch(/has no countable form/);
    // The caller's own expression is echoed once; no other form is named.
    expect(text.replaceAll(`"${count}"`, '')).not.toContain('"device_class.exact"');
    expect(text).not.toMatch(/retry with|add \.exact|drop \.exact/i);
    expect(text).not.toMatch(/fielddata/i);
    expect(http.calls).toHaveLength(1);
  });
});

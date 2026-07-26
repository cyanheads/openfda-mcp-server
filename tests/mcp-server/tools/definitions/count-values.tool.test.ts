import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_count_values', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('passes count param to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
      ],
    });

    const result = await countValuesTool.handler(
      { endpoint: 'drug/event', count: 'patient.reaction.reactionmeddrapt.exact' },
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ count: 'patient.reaction.reactionmeddrapt.exact' }),
      ctx,
    );
    expect(result.results).toEqual([
      { term: 'NAUSEA', count: 100 },
      { term: 'FATIGUE', count: 50 },
    ]);
  });

  it('coerces term to string', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [{ term: 2026, count: 5 }],
    });

    const result = await countValuesTool.handler(
      { endpoint: 'drug/event', count: 'receivedate' },
      ctx,
    );

    expect(result.results[0].term).toBe('2026');
  });

  it('populates enrichment.termCount', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
      ],
    });

    await countValuesTool.handler(
      { endpoint: 'drug/event', count: 'patient.reaction.reactionmeddrapt.exact' },
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.termCount).toBe(2);
  });

  it('discloses truncation when the term list is capped at the limit', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
      ],
    });

    await countValuesTool.handler(
      { endpoint: 'drug/event', count: 'patient.reaction.reactionmeddrapt.exact', limit: 2 },
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
    expect(enrichment.truncationCeiling).toBe(50);
  });

  it('omits truncation when fewer terms than the limit are returned', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [{ term: 'NAUSEA', count: 100 }],
    });

    await countValuesTool.handler(
      { endpoint: 'drug/event', count: 'patient.reaction.reactionmeddrapt.exact', limit: 100 },
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
  });

  // An empty tally now carries one meaning only: the expression aggregates and the
  // filter matched nothing. A non-aggregatable expression throws from the service
  // (#34), so the notice points at the filter instead of blaming the field name.
  it('sets enrichment.notice and returns empty results when no terms match', async () => {
    mockQuery.mockResolvedValue({ meta: { lastUpdated: '' }, results: [] });

    const result = await countValuesTool.handler(
      { endpoint: 'drug/ndc', count: 'dosage_form.exact', search: 'brand_name:"zzznotreal"' },
      ctx,
    );

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/nothing matched/i);
    expect(enrichment.notice).toContain('brand_name:"zzznotreal"');
    expect(enrichment.termCount).toBe(0);
  });

  it('formats as markdown table', () => {
    const content = countValuesTool.format({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 1000 },
        { term: 'FATIGUE', count: 500 },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('| # | Term | Count |');
    expect(text).toContain('NAUSEA');
    expect(text).toContain('FATIGUE');
    expect(text).toContain('2 terms');
  });

  it('formats empty results without message', () => {
    const content = countValuesTool.format({
      meta: { lastUpdated: '' },
      results: [],
    });

    expect(content[0].text).toBe('No count results.');
  });

  // Issue #34 — a non-aggregatable count expression is a fixable query error, so it
  // reaches the caller as a distinct declared failure rather than an empty tally.
  describe('not_aggregatable (#34)', () => {
    it('declares the reason in the error contract with a recovery hint', () => {
      const entry = countValuesTool.errors?.find((e) => e.reason === 'not_aggregatable');

      expect(entry).toBeDefined();
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(entry?.recovery).toMatch(/\.exact/);
    });

    it('surfaces the service error instead of an empty result', async () => {
      mockQuery.mockRejectedValue(
        validationError('openFDA cannot aggregate "product_ndc.exact" on drug/ndc.', {
          reason: 'not_aggregatable',
        }),
      );

      const err = (await countValuesTool
        .handler({ endpoint: 'drug/ndc', count: 'product_ndc.exact', limit: 2 }, ctx)
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });
});

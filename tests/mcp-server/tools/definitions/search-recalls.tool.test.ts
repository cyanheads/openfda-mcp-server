import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_recalls', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchRecallsTool.errors });
  });

  it('queries enforcement endpoint by default', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    const result = await searchRecallsTool.handler({ category: 'drug' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('drug/enforcement');
    expect(result.results).toHaveLength(1);
  });

  it('allows recall endpoint for devices', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchRecallsTool.handler({ category: 'device', endpoint: 'recall' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('device/recall');
  });

  it('rejects recall endpoint for non-device categories', async () => {
    await expect(
      searchRecallsTool.handler({ category: 'food', endpoint: 'recall' }, ctx),
    ).rejects.toThrow(McpError);

    await expect(
      searchRecallsTool.handler({ category: 'drug', endpoint: 'recall' }, ctx),
    ).rejects.toThrow(/only available for devices/i);
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 23, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    await searchRecallsTool.handler({ category: 'drug' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(23);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    await searchRecallsTool.handler({ category: 'drug', search: 'classification:"Class I"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('classification:"Class I"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchRecallsTool.handler({ category: 'drug' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  /**
   * Driven through `input.parse` — the boundary the framework validates at —
   * rather than straight into the handler, so the assertion covers what a client
   * actually hits.
   */
  it('rejects a blank search before any upstream request', async () => {
    for (const blank of ['', '   ', '\t']) {
      expect(() => searchRecallsTool.input.parse({ category: 'drug', search: blank })).toThrow(
        /empty or whitespace-only|>=1 characters/i,
      );
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still browses when search is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 17816, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    const input = searchRecallsTool.input.parse({ category: 'drug', limit: 1 });
    const result = await searchRecallsTool.handler(input, ctx);

    expect(mockQuery.mock.calls[0][1]).toMatchObject({ search: undefined });
    expect(result.results).toHaveLength(1);
  });

  it('formats recall records', () => {
    const content = searchRecallsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          recall_number: 'R-123',
          classification: 'Class I',
          recalling_firm: 'Acme Corp',
          product_description: 'Widget',
          reason_for_recall: 'Contamination',
          status: 'Ongoing',
          voluntary_mandated: 'Voluntary',
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('R-123');
    expect(text).toContain('Class I');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Contamination');
  });

  it('renders full product_description and reason_for_recall — parity with structuredContent (no truncation)', () => {
    const reason = `Class I recall. ${'Detailed contamination finding. '.repeat(20)}`;
    const product = `Product monograph. ${'Formulation detail. '.repeat(20)}`;
    const structured = {
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          recall_number: 'R-LONG',
          classification: 'Class I',
          recalling_firm: 'Acme Corp',
          product_description: product,
          reason_for_recall: reason,
          status: 'Ongoing',
        },
      ],
    };

    const text = searchRecallsTool.format(structured)[0].text;
    // content[] carries the identical full field values that structuredContent exposes.
    expect(text).toContain(structured.results[0].reason_for_recall);
    expect(text).toContain(structured.results[0].product_description);
    expect(reason.length).toBeGreaterThan(300);
    expect(product.length).toBeGreaterThan(300);
    expect(text).not.toContain('...');
  });
});

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_adverse_events', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('maps category to endpoint and returns results', async () => {
    const response = {
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '123', patient: { drug: [] } }],
    };
    mockQuery.mockResolvedValue(response);

    const result = await searchAdverseEventsTool.handler({ category: 'drug' }, ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ search: undefined }),
      ctx,
    );
    expect(result.meta.total).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it('maps device category correctly', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAdverseEventsTool.handler({ category: 'device' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('device/event');
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 42, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '1', patient: {} }],
    });

    await searchAdverseEventsTool.handler({ category: 'drug' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(42);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '1', patient: {} }],
    });

    await searchAdverseEventsTool.handler(
      { category: 'drug', search: 'patient.drug.medicinalproduct:"aspirin"' },
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('patient.drug.medicinalproduct:"aspirin"');
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAdverseEventsTool.handler({ category: 'drug', search: 'nonexistent' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no adverse event/i);
  });

  it('formats drug adverse event records', () => {
    const content = searchAdverseEventsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          safetyreportid: 'RPT-1',
          receivedate: '20260101',
          serious: '1',
          patient: {
            patientsex: '2',
            reaction: [{ reactionmeddrapt: 'NAUSEA' }],
            drug: [{ medicinalproduct: 'ASPIRIN', drugcharacterization: '1' }],
          },
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('RPT-1');
    expect(text).toContain('NAUSEA');
    expect(text).toContain('ASPIRIN');
    expect(text).toContain('Suspect');
    expect(text).toContain('Female');
  });

  it('formats empty results', () => {
    const content = searchAdverseEventsTool.format({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    expect(content[0].text).toBe('No results found.');
  });
});

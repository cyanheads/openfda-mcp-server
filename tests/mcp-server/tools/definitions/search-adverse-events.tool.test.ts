import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import type { Context } from '@cyanheads/mcp-ts-core';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';

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
    mockQuery.mockResolvedValue({ meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' }, results: [] });

    await searchAdverseEventsTool.handler({ category: 'device' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('device/event');
  });

  it('returns message when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    const result = await searchAdverseEventsTool.handler(
      { category: 'drug', search: 'nonexistent' },
      ctx,
    );

    expect(result.message).toMatch(/no adverse event/i);
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
      message: 'No results found.',
    });

    expect(content[0].text).toBe('No results found.');
  });
});

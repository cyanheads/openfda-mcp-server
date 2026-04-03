import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import type { Context } from '@cyanheads/mcp-ts-core';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { countTool } from '@/mcp-server/tools/definitions/count.tool.js';

const mockQuery = vi.fn();

describe('openfda_count', () => {
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

    const result = await countTool.handler(
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

    const result = await countTool.handler(
      { endpoint: 'drug/event', count: 'receivedate' },
      ctx,
    );

    expect(result.results[0].term).toBe('2026');
  });

  it('returns message when empty', async () => {
    mockQuery.mockResolvedValue({ meta: { lastUpdated: '' }, results: [] });

    const result = await countTool.handler(
      { endpoint: 'drug/event', count: 'nonexistent.field' },
      ctx,
    );

    expect(result.results).toHaveLength(0);
    expect(result.message).toMatch(/no count results/i);
  });

  it('formats as markdown table', () => {
    const content = countTool.format({
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
});

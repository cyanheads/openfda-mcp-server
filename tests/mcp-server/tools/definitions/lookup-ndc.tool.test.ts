import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_lookup_ndc', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries drug/ndc endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ product_ndc: '0363-0218', brand_name: 'Aspirin' }],
    });

    const result = await lookupNdcTool.handler({ search: 'product_ndc:"0363-0218"' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('drug/ndc');
    expect(result.results[0].brand_name).toBe('Aspirin');
  });

  it('returns message when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    const result = await lookupNdcTool.handler({ search: 'nonexistent' }, ctx);
    expect(result.message).toMatch(/no NDC records/i);
  });

  it('formats NDC records with ingredients and packaging', () => {
    const content = lookupNdcTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          product_ndc: '0363-0218',
          brand_name: 'Aspirin',
          generic_name: 'aspirin',
          labeler_name: 'Walgreen Co',
          dosage_form: 'TABLET',
          route: ['ORAL'],
          active_ingredients: [{ name: 'ASPIRIN', strength: '325 mg' }],
          packaging: [{ package_ndc: '0363-0218-01', description: '100 TABLET in 1 BOTTLE' }],
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('Aspirin');
    expect(text).toContain('0363-0218');
    expect(text).toContain('Walgreen');
    expect(text).toContain('ASPIRIN');
    expect(text).toContain('325 mg');
    expect(text).toContain('100 TABLET');
  });

  it('caps packaging at 5 items in format', () => {
    const packaging = Array.from({ length: 8 }, (_, i) => ({
      package_ndc: `0000-0000-0${i}`,
      description: `Package ${i}`,
    }));

    const content = lookupNdcTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ brand_name: 'Test', product_ndc: '0000', labeler_name: 'Lab', packaging }],
    });

    const text = content[0].text;
    expect(text).toContain('... and 3 more');
  });
});

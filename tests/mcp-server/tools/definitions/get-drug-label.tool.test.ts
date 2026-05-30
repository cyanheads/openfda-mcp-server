import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_get_drug_label', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries drug/label endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ openfda: { brand_name: ['Aspirin'] } }],
    });

    const result = await getDrugLabelTool.handler({ search: 'openfda.brand_name:"aspirin"' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('drug/label');
    expect(result.results).toHaveLength(1);
  });

  it('populates enrichment.totalResults and effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ openfda: { brand_name: ['Aspirin'] } }],
    });

    await getDrugLabelTool.handler({ search: 'openfda.brand_name:"aspirin"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(1);
    expect(enrichment.effectiveQuery).toBe('openfda.brand_name:"aspirin"');
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' },
      results: [],
    });

    await getDrugLabelTool.handler({ search: 'nonexistent' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no labels/i);
  });

  it('formats label sections', () => {
    const content = getDrugLabelTool.format({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [
        {
          openfda: {
            brand_name: ['Aspirin'],
            generic_name: ['aspirin'],
            manufacturer_name: ['Bayer'],
            route: ['ORAL'],
          },
          indications_and_usage: ['For pain relief.'],
          warnings: ['Do not exceed recommended dose.'],
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('Aspirin');
    expect(text).toContain('Bayer');
    expect(text).toContain('For pain relief.');
    expect(text).toContain('Do not exceed');
  });

  it('truncates long sections in format', () => {
    const longText = 'A'.repeat(2000);
    const content = getDrugLabelTool.format({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
      results: [
        {
          openfda: { brand_name: ['Test'] },
          warnings: [longText],
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(longText.length);
  });
});

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_drug_approvals', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries drug/drugsfda endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345', sponsor_name: 'Pfizer' }],
    });

    const result = await searchDrugApprovalsTool.handler({ search: 'sponsor_name:"pfizer"' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('drug/drugsfda');
    expect(result.results[0].application_number).toBe('NDA012345');
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 15, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345' }],
    });

    await searchDrugApprovalsTool.handler({ search: 'sponsor_name:"pfizer"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(15);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345' }],
    });

    await searchDrugApprovalsTool.handler({ search: 'sponsor_name:"pfizer"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('sponsor_name:"pfizer"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugApprovalsTool.handler({ search: 'nonexistent' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no drug approvals/i);
  });

  it('formats submissions list', () => {
    const content = searchDrugApprovalsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          application_number: 'NDA012345',
          sponsor_name: 'Pfizer',
          openfda: { brand_name: ['Lipitor'], generic_name: ['atorvastatin'] },
          submissions: [
            {
              submission_type: 'ORIG',
              submission_number: '1',
              submission_status: 'AP',
              submission_status_date: '19961217',
              review_priority: 'STANDARD',
            },
          ],
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('Lipitor');
    expect(text).toContain('NDA012345');
    expect(text).toContain('Pfizer');
    expect(text).toContain('ORIG');
  });

  it('caps submissions at 10 in format', () => {
    const submissions = Array.from({ length: 15 }, (_, i) => ({
      submission_type: 'SUPPL',
      submission_number: String(i + 1),
      submission_status: 'AP',
    }));

    const content = searchDrugApprovalsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ application_number: 'NDA999', sponsor_name: 'Test', submissions }],
    });

    const text = content[0].text;
    expect(text).toContain('... and 5 more');
  });
});

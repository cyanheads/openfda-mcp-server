/**
 * @fileoverview Tests for openfda_search_drug_shortages tool.
 * @module tests/mcp-server/tools/definitions/search-drug-shortages.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_drug_shortages', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries drug/shortages endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Carboplatin Injection', status: 'Current' }],
    });

    const result = await searchDrugShortagesTool.handler({}, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('drug/shortages');
    expect(result.results[0].generic_name).toBe('Carboplatin Injection');
  });

  it('passes search, sort, limit, skip to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 5, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Test Drug', status: 'Current' }],
    });

    await searchDrugShortagesTool.handler(
      {
        search: 'status:"Current" AND therapeutic_category:"Oncology"',
        sort: 'update_date:desc',
        limit: 5,
        skip: 0,
      },
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/shortages',
      expect.objectContaining({
        search: 'status:"Current" AND therapeutic_category:"Oncology"',
        sort: 'update_date:desc',
        limit: 5,
        skip: 0,
      }),
      ctx,
    );
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 127, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Drug A', status: 'Current' }],
    });

    await searchDrugShortagesTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(127);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Drug B', status: 'Resolved' }],
    });

    await searchDrugShortagesTool.handler({ search: 'generic_name:"amoxicillin"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('generic_name:"amoxicillin"');
  });

  it('does not set effectiveQuery when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Drug C', status: 'Current' }],
    });

    await searchDrugShortagesTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugShortagesTool.handler({ search: 'generic_name:"nonexistent"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('drug/shortages');
  });

  it('notice includes field hint from catalog when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugShortagesTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    // Field hint from catalog should mention searchable fields
    expect(enrichment.notice).toContain('generic_name');
  });

  it('sets pagination-context notice when empty at skip > 0', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 30, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugShortagesTool.handler({ skip: 30 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=30/);
  });

  it('format renders shortage record with all key fields', () => {
    const content = searchDrugShortagesTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-05-01' },
      results: [
        {
          generic_name: 'Carboplatin Injection',
          status: 'Current',
          availability: 'Limited availability from one manufacturer.',
          therapeutic_category: 'Oncology',
          dosage_form: 'Injection',
          presentation: '50 mg/5 mL (10 mg/mL) vial',
          company_name: 'Pfizer Labs',
          contact_info: 'Contact FDA MedWatch',
          initial_posting_date: '20230301',
          update_date: '20260101',
          update_type: 'Status update',
          openfda: {
            brand_name: ['Paraplatin'],
            product_ndc: ['0015-3371'],
            rxcui: ['40048'],
          },
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('Carboplatin Injection');
    expect(text).toContain('Current');
    expect(text).toContain('Limited availability');
    expect(text).toContain('Oncology');
    expect(text).toContain('Injection');
    expect(text).toContain('Pfizer Labs');
    expect(text).toContain('20260101');
    expect(text).toContain('Paraplatin');
    expect(text).toContain('RxCUI: 40048');
  });

  it('format handles sparse payload — all optional fields absent', () => {
    const content = searchDrugShortagesTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Minimal Drug', status: 'Resolved' }],
    });

    const text = content[0].text;
    expect(text).toContain('Minimal Drug');
    expect(text).toContain('Resolved');
    expect(typeof text).toBe('string');
  });

  it('format returns "No drug shortage records found." for empty results', () => {
    const content = searchDrugShortagesTool.format({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    expect(content[0].text).toBe('No drug shortage records found.');
  });

  it('format includes meta header with totals', () => {
    const content = searchDrugShortagesTool.format({
      meta: { total: 305, skip: 0, limit: 10, lastUpdated: '2026-05-31' },
      results: [{ generic_name: 'Drug X', status: 'Current' }],
    });

    const text = content[0].text;
    expect(text).toContain('305 total results');
    expect(text).toContain('2026-05-31');
  });

  it('format renders openfda block with NDC when brand_name absent', () => {
    const content = searchDrugShortagesTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          generic_name: 'Drug Y',
          status: 'Current',
          openfda: { product_ndc: ['1234-5678'] },
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('NDC: 1234-5678');
  });
});

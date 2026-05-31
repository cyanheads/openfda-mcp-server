/**
 * @fileoverview Tests for openfda_search_tobacco_reports tool.
 * @module tests/mcp-server/tools/definitions/search-tobacco-reports.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_tobacco_reports', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries tobacco/problem endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-1' }],
    });

    const result = await searchTobaccoReportsTool.handler({}, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('tobacco/problem');
    expect(result.results).toHaveLength(1);
  });

  it('passes search, sort, limit, skip to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 3, skip: 5, limit: 3, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-2' }],
    });

    await searchTobaccoReportsTool.handler(
      {
        search: 'tobacco_products:"Electronic cigarette"',
        sort: 'date_submitted:desc',
        limit: 3,
        skip: 5,
      },
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'tobacco/problem',
      expect.objectContaining({
        search: 'tobacco_products:"Electronic cigarette"',
        sort: 'date_submitted:desc',
        limit: 3,
        skip: 5,
      }),
      ctx,
    );
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 42, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-3' }],
    });

    await searchTobaccoReportsTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(42);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-4' }],
    });

    await searchTobaccoReportsTool.handler({ search: 'reported_health_problems:"Seizure"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('reported_health_problems:"Seizure"');
  });

  it('does not set effectiveQuery when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-5' }],
    });

    await searchTobaccoReportsTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchTobaccoReportsTool.handler({ search: 'nonexistent_field:"foo"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('sets pagination-context notice when empty at skip > 0', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 50, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchTobaccoReportsTool.handler({ skip: 50 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=50/);
  });

  it('formats records with products and health problems', () => {
    const content = searchTobaccoReportsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-02-01' },
      results: [
        {
          report_id: 'TOB-FMT-1',
          date_submitted: '20260115',
          nonuser_affected: 'No',
          tobacco_products: ['Electronic cigarette (including e-cigarettes and vaping devices)'],
          reported_health_problems: ['Chest pain', 'Difficulty breathing'],
          reported_product_problems: ['Battery exploded', 'Leaking'],
          number_tobacco_products: 1,
          number_health_problems: 2,
          number_product_problems: 2,
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('TOB-FMT-1');
    expect(text).toContain('20260115');
    expect(text).toContain('Electronic cigarette');
    expect(text).toContain('Chest pain');
    expect(text).toContain('Battery exploded');
    expect(text).toContain('No');
  });

  it('format handles sparse payload — all optional fields absent', () => {
    // Upstream record with only report_id — all other fields omitted
    const content = searchTobaccoReportsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'SPARSE-TOB' }],
    });

    const text = content[0].text;
    expect(text).toContain('SPARSE-TOB');
    // Should not crash on missing optional fields
    expect(typeof text).toBe('string');
  });

  it('format returns "No tobacco problem reports found." for empty results', () => {
    const content = searchTobaccoReportsTool.format({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    expect(content[0].text).toBe('No tobacco problem reports found.');
  });

  it('format includes meta header with totals', () => {
    const content = searchTobaccoReportsTool.format({
      meta: { total: 777, skip: 0, limit: 10, lastUpdated: '2026-04-01' },
      results: [{ report_id: 'TOB-HDR' }],
    });

    const text = content[0].text;
    expect(text).toContain('777 total results');
    expect(text).toContain('2026-04-01');
  });

  it('format suppresses product problem "No information provided"', () => {
    const content = searchTobaccoReportsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          report_id: 'TOB-SUPP',
          reported_product_problems: ['No information provided'],
          reported_health_problems: ['Nausea'],
        },
      ],
    });

    const text = content[0].text;
    // "No information provided" should be filtered out from product problems
    expect(text).not.toContain('No information provided');
    // But health problems should still appear
    expect(text).toContain('Nausea');
  });

  it('format renders counts when present', () => {
    const content = searchTobaccoReportsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          report_id: 'TOB-CNT',
          number_tobacco_products: 2,
          number_health_problems: 3,
          number_product_problems: 1,
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('2 product(s)');
    expect(text).toContain('3 health problem(s)');
    expect(text).toContain('1 product problem(s)');
  });
});

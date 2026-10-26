/**
 * @fileoverview Tests for openfda_search_tobacco_reports tool.
 * @module tests/mcp-server/tools/definitions/search-tobacco-reports.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_search_tobacco_reports', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchTobaccoReportsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchTobaccoReportsTool.errors });
  });

  it('queries tobacco/problem endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-1' }],
    });

    const result = await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('tobacco/problem');
    expect(result.results).toHaveLength(1);
  });

  it('passes search, sort, limit, skip to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 3, skip: 5, limit: 3, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-2' }],
    });

    await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({
        search: 'tobacco_products:"Electronic cigarette"',
        sort: 'date_submitted:desc',
        limit: 3,
        skip: 5,
      }),
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

    await searchTobaccoReportsTool.handler(searchTobaccoReportsTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(42);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-4' }],
    });

    await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({ search: 'reported_health_problems:"Seizure"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('reported_health_problems:"Seizure"');
  });

  it('does not set effectiveQuery when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-5' }],
    });

    await searchTobaccoReportsTool.handler(searchTobaccoReportsTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({ search: 'nonexistent_field:"foo"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 50, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchTobaccoReportsTool.handler(searchTobaccoReportsTool.input.parse({ skip: 50 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=50/);
  });

  // #75 wiring: the shared search schema reads a URL-form `+` separator as a
  // space, so the service and the echo carry the spaced string. #81: the caller's
  // search in the empty-result notice is a code span on both surfaces.
  describe('search wiring (#75, #81)', () => {
    const EMPTY = {
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
      results: [],
    };
    const resultText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      String((result.structuredContent as { notice?: string }).notice);

    it('sends and echoes a URL-form +AND+ search with spaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [{ report_id: 'TOB-75' }],
      });

      const result = await runToolContract(searchTobaccoReportsTool, {
        search: 'tobacco_products:"Electronic cigarette"+AND+nonuser_affected:"Yes"',
      });

      const spaced = 'tobacco_products:"Electronic cigarette" AND nonuser_affected:"Yes"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchTobaccoReportsTool, {
        search: 'reported_health_problems.exact:"Chest+Pain"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"Chest Pain"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });

    it('wraps the caller search in the empty-result notice as a code span on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchTobaccoReportsTool, {
        search: 'reported_health_problems:*seiz*zzz*',
      });

      expect(noticeOf(result)).toContain(
        'No tobacco problem reports matched search: `reported_health_problems:*seiz*zzz*`.',
      );
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats records with products and health problems', () => {
    const content = searchTobaccoReportsTool.format!({
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

    const text = textOf(content);
    expect(text).toContain('TOB-FMT-1');
    expect(text).toContain('20260115');
    expect(text).toContain('Electronic cigarette');
    expect(text).toContain('Chest pain');
    expect(text).toContain('Battery exploded');
    expect(text).toContain('No');
  });

  it('format handles sparse payload — all optional fields absent', () => {
    // Upstream record with only report_id — all other fields omitted
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'SPARSE-TOB' }],
    });

    const text = textOf(content);
    expect(text).toContain('SPARSE-TOB');
    // Should not crash on missing optional fields
    expect(typeof text).toBe('string');
  });

  it('format renders the metadata header, then "No tobacco problem reports found.", for empty results (#68)', () => {
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo tobacco problem reports found.',
    );
  });

  it('format includes meta header with totals', () => {
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 777, skip: 0, limit: 10, lastUpdated: '2026-04-01' },
      results: [{ report_id: 'TOB-HDR' }],
    });

    const text = textOf(content);
    expect(text).toContain('777 total results');
    expect(text).toContain('2026-04-01');
  });

  it('format renders every reported product problem, placeholders included (#24)', () => {
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          report_id: 'TOB-SUPP',
          reported_product_problems: ['No information provided'],
          reported_health_problems: ['Nausea'],
        },
      ],
    });

    const text = textOf(content);
    // structuredContent carries the placeholder, so content[] must too.
    expect(text).toContain('No information provided');
    expect(text).toContain('Nausea');
  });

  it('format renders a zero problem count rather than dropping it (#24)', () => {
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          report_id: 'TOB-ZERO',
          number_tobacco_products: 1,
          number_health_problems: 0,
          number_product_problems: 0,
        },
      ],
    });

    expect(textOf(content)).toContain('0 health problem(s)');
    expect(textOf(content)).toContain('0 product problem(s)');
  });

  it('format renders counts when present', () => {
    const content = searchTobaccoReportsTool.format!({
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

    const text = textOf(content);
    expect(text).toContain('2 product(s)');
    expect(text).toContain('3 health problem(s)');
    expect(text).toContain('1 product problem(s)');
  });
});

/**
 * @fileoverview Tests for openfda_search_tobacco_reports tool.
 * @module tests/mcp-server/tools/definitions/search-tobacco-reports.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { renderCommonMark } from '../../../helpers/commonmark.js';
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

  // #92 — the endpoint's default page size reaches the request and meta.limit.
  it('pages tobacco/problem at its default of 25 when limit is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
      results: [],
    });

    const result = await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    expect(result.meta.limit).toBe(25);
  });

  // #88 — a bare browse is newest first by submission date.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it('sends date_submitted:desc with neither search nor sort', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchTobaccoReportsTool.handler(searchTobaccoReportsTool.input.parse({}), ctx);

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'date_submitted:desc' });
    });

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchTobaccoReportsTool.handler(
        searchTobaccoReportsTool.input.parse({ search: 'nonuser_affected:"Yes"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchTobaccoReportsTool.handler(
        searchTobaccoReportsTool.input.parse({ sort: 'date_submitted:asc' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'date_submitted:asc' });
    });

    it('states the newest-first browse on search and the default sort on sort', () => {
      const shape = searchTobaccoReportsTool.input.shape;
      expect(shape.search.description).toContain('Omit to browse newest first.');
      expect(shape.sort.description).toContain(
        'With neither search nor sort, records come newest first by date_submitted:desc.',
      );
    });
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

  /**
   * Under CommonMark a line right after a list item, with no blank line between,
   * continues that item — so the problems and counts rendered inside the last
   * product type's `<li>`.
   */
  it('ends the product list before the record fields that follow it, under CommonMark', () => {
    const text = textOf(
      searchTobaccoReportsTool.format!({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-11-10' },
        results: [
          {
            report_id: 'TOB-LIST',
            date_submitted: '04/17/2026',
            nonuser_affected: 'No',
            tobacco_products: ['Electronic cigarette', 'Cigar'],
            reported_health_problems: ['Chest pain'],
            reported_product_problems: ['Battery exploded'],
            number_tobacco_products: 2,
            number_health_problems: 1,
            number_product_problems: 1,
            report_source: 'Consumer',
          },
        ],
      }),
    );

    const items = [...renderCommonMark(text).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual(['Electronic cigarette', 'Cigar']);
    for (const label of ['Health problems', 'Product problems', 'Counts', 'Report source']) {
      expect(text).toContain(`**${label}:**`);
    }
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

  /**
   * #97 — the tool's own cursor surface. The walk, the binding, and the refusals
   * run through every cursor tool in pagination-contract.test.ts; the token at
   * its seam in pagination-cursor.test.ts.
   */
  describe('cursor (#97)', () => {
    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(searchTobaccoReportsTool.input) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required ?? []).not.toContain('cursor');
      const output = z.toJSONSchema(searchTobaccoReportsTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
      expect(searchTobaccoReportsTool.errors).toContain(invalidCursorError);
      expect(searchTobaccoReportsTool.errors).toContain(paginationLimitReachedError);
    });

    it('sends no searchAfter and returns no next_cursor key without a cursor or a link', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 0, limit: 25, lastUpdated: '2026-01-01' },
        results: [{ report_id: 'TOB-1' }],
      });

      const result = await searchTobaccoReportsTool.handler(
        searchTobaccoReportsTool.input.parse({}),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
    });

    it('renders next_cursor after the header and before the records', () => {
      const text = textOf(
        searchTobaccoReportsTool.format!({
          meta: { total: 30, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
          results: [{ report_id: 'TOB-1' }],
          next_cursor: 'eyJwIjox_-',
        }),
      );
      const lines = text.split('\n');
      expect(lines[0]).toMatch(/^\*\*30 total results\*\*/);
      expect(lines[2]).toBe('next_cursor: `eyJwIjox_-`');
      expect(text.indexOf('### Report TOB-1')).toBeGreaterThan(text.indexOf('next_cursor'));
    });
  });
});

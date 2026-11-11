import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_lookup_ndc', () => {
  let ctx: ReturnType<typeof createMockContext<typeof lookupNdcTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: lookupNdcTool.errors });
  });

  it('queries drug/ndc endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ product_ndc: '0363-0218', brand_name: 'Aspirin' }],
    });

    const result = await lookupNdcTool.handler(
      lookupNdcTool.input.parse({ search: 'product_ndc:"0363-0218"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('drug/ndc');
    expect(result.results[0]!.brand_name).toBe('Aspirin');
  });

  // #92 — the endpoint's default page size reaches the request and meta.limit.
  it('pages drug/ndc at its default of 25 when limit is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
      results: [],
    });

    const result = await lookupNdcTool.handler(
      lookupNdcTool.input.parse({ search: 'product_ndc:"0363-0218"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    expect(result.meta.limit).toBe(25);
  });

  it('populates enrichment.totalResults and effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ product_ndc: '0363-0218', brand_name: 'Aspirin' }],
    });

    await lookupNdcTool.handler(
      lookupNdcTool.input.parse({ search: 'product_ndc:"0363-0218"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(1);
    expect(enrichment.effectiveQuery).toBe('product_ndc:"0363-0218"');
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await lookupNdcTool.handler(lookupNdcTool.input.parse({ search: 'nonexistent' }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no NDC records/i);
  });

  // #75 wiring: the shared search schema reads a URL-form `+` separator as a
  // space, so the service and the echo carry the spaced string.
  describe('search wiring (#75)', () => {
    const resultText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      String((result.structuredContent as { notice?: string }).notice);

    it('sends and echoes a URL-form +AND+ search with spaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [{ product_ndc: '0363-0218', brand_name: 'Aspirin' }],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'brand_name:"aspirin"+AND+dosage_form:"TABLET"',
      });

      const spaced = 'brand_name:"aspirin" AND dosage_form:"TABLET"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(spaced);
      expect(resultText(result)).not.toContain('+AND+');
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'dosage_form.exact:"TABLET,+FILM+COATED"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"TABLET, FILM COATED"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats NDC records with ingredients and packaging', () => {
    const content = lookupNdcTool.format!({
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

    const text = textOf(content);
    expect(text).toContain('Aspirin');
    expect(text).toContain('0363-0218');
    expect(text).toContain('Walgreen');
    expect(text).toContain('ASPIRIN');
    expect(text).toContain('325 mg');
    expect(text).toContain('100 TABLET');
  });

  it('renders every packaging entry in format — parity with structuredContent (no cap)', () => {
    const packaging = Array.from({ length: 8 }, (_, i) => ({
      package_ndc: `0000-0000-0${i}`,
      description: `Package ${i}`,
    }));

    const content = lookupNdcTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ brand_name: 'Test', product_ndc: '0000', labeler_name: 'Lab', packaging }],
    });

    const text = textOf(content);
    // All 8 packaging entries render — entries 6–8 were previously capped at slice(0, 5).
    for (const p of packaging) {
      expect(text).toContain(p.package_ndc);
      expect(text).toContain(p.description);
    }
    expect(text).not.toContain('...');
  });

  /**
   * Under CommonMark a line right after a list item, with no blank line between,
   * continues that item — so the listing date and the product's remaining
   * fields rendered inside the last package's `<li>`. Each package's own fields
   * still belong in its item.
   */
  it('ends the packaging list before the product fields that follow it, under CommonMark', () => {
    const text = textOf(
      lookupNdcTool.format!({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [
          {
            product_ndc: '0363-0218',
            brand_name: 'Aspirin',
            labeler_name: 'Walgreen Co',
            packaging: [
              { package_ndc: '0363-0218-01', description: '100 TABLET in 1 BOTTLE', sample: false },
              { package_ndc: '0363-0218-02', description: '300 TABLET in 1 BOTTLE', sample: true },
            ],
            listing_expiration_date: '20271231',
            marketing_start_date: '19900101',
          },
        ],
      }),
    );

    const items = [...renderCommonMark(text).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
      (m) => m[1] ?? '',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Sample:</strong> false');
    expect(items[1]).toContain('Sample:</strong> true');
    for (const label of ['Listing expires', 'Marketing start date']) {
      expect(items.join('\n')).not.toContain(`${label}:</strong>`);
      expect(text).toContain(`**${label}:**`);
    }
  });

  // The record's own labeler field is on every NDC record; openfda.manufacturer_name
  // only on those openFDA harmonized.
  it('leads its manufacturer example with labeler_name, not an openfda.* path', () => {
    const description = lookupNdcTool.input.shape.search.description ?? '';
    expect(description).toContain('labeler_name:"walgreen"');
    expect(description).not.toContain('openfda.manufacturer_name');
  });
});

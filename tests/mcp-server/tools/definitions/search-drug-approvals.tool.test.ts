import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_search_drug_approvals', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDrugApprovalsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDrugApprovalsTool.errors });
  });

  it('queries drug/drugsfda endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345', sponsor_name: 'Pfizer' }],
    });

    const result = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('drug/drugsfda');
    expect(result.results[0]!.application_number).toBe('NDA012345');
  });

  // #92 — the endpoint's default page size reaches the request and meta.limit.
  it('pages drug/drugsfda at its default of 25 when limit is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
      results: [],
    });

    const result = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    expect(result.meta.limit).toBe(25);
  });

  // #88 — a bare browse is newest first by each application's latest submission.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it('sends submissions.submission_status_date:desc with neither search nor sort', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugApprovalsTool.handler(searchDrugApprovalsTool.input.parse({}), ctx);

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({
        sort: 'submissions.submission_status_date:desc',
      });
    });

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugApprovalsTool.handler(
        searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugApprovalsTool.handler(
        searchDrugApprovalsTool.input.parse({ sort: 'application_number:asc' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'application_number:asc' });
    });

    it('states the default, by latest submission, in the search and sort descriptions', () => {
      const shape = searchDrugApprovalsTool.input.shape;
      expect(shape.search.description).toContain(
        'Omit to browse by latest submission, newest first, sorted by submissions.submission_status_date:desc.',
      );
      expect(shape.sort.description).toContain(
        'defaults to submissions.submission_status_date:desc',
      );
      expect(shape.sort.description).toContain('not by approval date');
    });
  });

  // #89 — openFDA fills openfda.* on harmonized applications only, so a brand
  // search on openfda.brand_name misses applications products.brand_name finds.
  describe('product-name field (#89)', () => {
    it('leads the search examples with products.brand_name', () => {
      const description = searchDrugApprovalsTool.input.shape.search.description ?? '';
      expect(description).toMatch(/^openFDA search query\. Examples: products\.brand_name:"/);
      expect(description).not.toContain('openfda.brand_name:"humira"');
    });

    it('names products.brand_name in the empty-result notice and scopes openfda.* to harmonized applications', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'openfda.brand_name:"eliquis"',
      });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toContain('products.brand_name');
      expect(notice).toContain('openfda.* covers harmonized applications only');
      // The six-field hint reaches the product-name field.
      expect(notice).toMatch(/Key searchable fields for drug\/drugsfda: [^.]*products\.brand_name/);
      // A lowercase quoted sponsor matches nothing: the hint says how it is stored.
      expect(notice).toContain(
        'sponsor_name for the applicant, stored uppercase (sponsor_name:"PFIZER")',
      );
    });

    it('heads an application openFDA never harmonized with its products[] brand name', () => {
      const content = searchDrugApprovalsTool.format!({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [
          {
            application_number: 'NDA202155',
            sponsor_name: 'BRISTOL MYERS SQUIBB',
            products: [
              {
                brand_name: 'ELIQUIS',
                active_ingredients: [{ name: 'APIXABAN', strength: '2.5MG' }],
              },
            ],
          },
        ],
      });

      const text = textOf(content);
      expect(text).toContain('### ELIQUIS\n');
      expect(text).not.toContain('### NDA202155');
    });
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 15, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345' }],
    });

    await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(15);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345' }],
    });

    await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('sponsor_name:"PFIZER"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'nonexistent' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no drug approvals/i);
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
        results: [{ application_number: 'NDA012345' }],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'sponsor_name:"PFIZER"+AND+submissions.submission_type:"ORIG"',
      });

      const spaced = 'sponsor_name:"PFIZER" AND submissions.submission_type:"ORIG"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'openfda.brand_name.exact:"HUMIRA+PEN"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"HUMIRA PEN"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats submissions list', () => {
    const content = searchDrugApprovalsTool.format!({
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

    const text = textOf(content);
    expect(text).toContain('Lipitor');
    expect(text).toContain('NDA012345');
    expect(text).toContain('Pfizer');
    expect(text).toContain('ORIG');
  });

  it('renders every submission in format — parity with structuredContent (no cap)', () => {
    const submissions = Array.from({ length: 15 }, (_, i) => ({
      submission_type: 'SUPPL',
      submission_number: String(i + 1),
      submission_status: 'AP',
    }));

    const content = searchDrugApprovalsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ application_number: 'NDA999', sponsor_name: 'Test', submissions }],
    });

    const text = textOf(content);
    // All 15 submissions render — entries 11–15 were previously capped at slice(0, 10).
    const submissionLines = text.split('\n').filter((l) => l.startsWith('- SUPPL'));
    expect(submissionLines).toHaveLength(15);
    expect(text).toContain('#15');
    expect(text).not.toContain('...');
  });

  /**
   * Under CommonMark a line right after a list item, with no blank line between,
   * continues that item — so the Submissions label rendered inside the last
   * product's `<li>` and the submissions joined the products list. Each
   * product's and submission's own fields still belong in its item.
   */
  it('ends the products and submissions lists before the next block, under CommonMark', () => {
    const text = textOf(
      searchDrugApprovalsTool.format!({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [
          {
            application_number: 'NDA202155',
            sponsor_name: 'BRISTOL MYERS SQUIBB',
            products: [
              { product_number: '001', brand_name: 'ELIQUIS', dosage_form: 'TABLET' },
              { product_number: '002', brand_name: 'ELIQUIS', dosage_form: 'TABLET' },
            ],
            submissions: [
              { submission_type: 'ORIG', submission_number: '1', submission_class_code: 'TYPE 1' },
              {
                submission_type: 'SUPPL',
                submission_number: '37',
                submission_class_code: 'LABELING',
              },
            ],
            record_note: 'top-level field',
          },
        ],
      }),
    );

    const html = renderCommonMark(text);
    expect([...html.matchAll(/<ul>/g)]).toHaveLength(2);
    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '');
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('Product number:</strong> 001');
    expect(items[3]).toContain('Submission class code:</strong> LABELING');
    expect(items.join('\n')).not.toContain('Submissions:');
    expect(items.join('\n')).not.toContain('Record note:');
    expect(html).toContain('<p><strong>Submissions:</strong></p>');
    expect(text).toContain('**Record note:** top-level field');
  });
});

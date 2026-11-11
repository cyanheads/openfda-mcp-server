import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_search_device_clearances', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDeviceClearancesTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDeviceClearancesTool.errors });
  });

  it('queries device/510k for 510k pathway', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456', device_name: 'Test Device' }],
    });

    const result = await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'applicant:"medtronic"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('device/510k');
    expect(result.results[0]!.k_number).toBe('K123456');
  });

  it('queries device/pma for pma pathway', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: 'pma', search: 'applicant:"test"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('device/pma');
  });

  // #92 — the pathway picks the page size an omitted limit gets and the cap a larger one is clamped to.
  it.each([
    ['510k', 'device/510k', 10, 175],
    ['pma', 'device/pma', 25, 575],
  ] as const)(
    'pages the %s pathway on %s at default %i and cap %i',
    async (pathway, endpoint, fallback, cap) => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
        results: [],
      });

      const omitted = await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway }),
        ctx,
      );
      const above = await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway, limit: 5_000 }),
        ctx,
      );

      expect(mockQuery.mock.calls.map(([path, params]) => [path, params.limit])).toEqual([
        [endpoint, fallback],
        [endpoint, cap],
      ]);
      expect([omitted.meta.limit, above.meta.limit]).toEqual([fallback, cap]);
    },
  );

  // #88 — a bare browse is newest first by decision date, on either pathway.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it.each(['510k', 'pma'] as const)(
      'sends the %s pathway with neither search nor sort as decision_date:desc',
      async (pathway) => {
        mockQuery.mockResolvedValue(EMPTY);

        await searchDeviceClearancesTool.handler(
          searchDeviceClearancesTool.input.parse({ pathway }),
          ctx,
        );

        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'decision_date:desc' });
      },
    );

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'product_code:"DXN"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDeviceClearancesTool.handler(
        searchDeviceClearancesTool.input.parse({ pathway: 'pma', sort: 'decision_date:asc' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'decision_date:asc' });
    });

    it('states the default in the search and sort descriptions', () => {
      const shape = searchDeviceClearancesTool.input.shape;
      expect(shape.search.description).toContain(
        'Omit to browse newest first, sorted by decision_date:desc.',
      );
      expect(shape.sort.description).toContain('defaults to decision_date:desc');
    });
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 7, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456' }],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(7);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456' }],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'applicant:"medtronic"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('applicant:"medtronic"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', search: 'nonexistent' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no matching device clearances/i);
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
        results: [{ k_number: 'K123456' }],
      });

      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: '510k',
        search: 'applicant:"medtronic"+AND+product_code:"DXN"',
      });

      const spaced = 'applicant:"medtronic" AND product_code:"DXN"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [],
      });

      const result = await runToolContract(searchDeviceClearancesTool, {
        pathway: '510k',
        search: 'device_name.exact:"KNEE+JOINT"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"KNEE JOINT"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats 510k records', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          k_number: 'K123456',
          device_name: 'Cardiac Monitor',
          applicant: 'Medtronic',
          product_code: 'DXN',
          decision_description: 'Substantially Equivalent',
          decision_date: '20260101',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('K123456');
    expect(text).toContain('Cardiac Monitor');
    expect(text).toContain('Medtronic');
    expect(text).toContain('Substantially Equivalent');
  });

  it('formats PMA records', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          pma_number: 'P123456',
          applicant: 'Boston Scientific',
          product_code: 'NIQ',
          decision_code: 'APPR',
          decision_date: '20260101',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('P123456');
    expect(text).toContain('Boston Scientific');
    expect(text).toContain('APPR');
  });
});

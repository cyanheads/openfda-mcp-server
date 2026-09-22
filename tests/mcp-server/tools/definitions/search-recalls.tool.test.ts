import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_search_recalls', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchRecallsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchRecallsTool.errors });
  });

  it('queries enforcement endpoint by default', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    const result = await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('drug/enforcement');
    expect(result.results).toHaveLength(1);
  });

  it('allows recall endpoint for devices', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'device', endpoint: 'recall' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('device/recall');
  });

  it('rejects recall endpoint for non-device categories', async () => {
    await expect(
      searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category: 'food', endpoint: 'recall' }),
        ctx,
      ),
    ).rejects.toThrow(McpError);

    await expect(
      searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category: 'drug', endpoint: 'recall' }),
        ctx,
      ),
    ).rejects.toThrow(/only available for devices/i);
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 23, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    await searchRecallsTool.handler(searchRecallsTool.input.parse({ category: 'drug' }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(23);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug', search: 'classification:"Class I"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('classification:"Class I"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchRecallsTool.handler(searchRecallsTool.input.parse({ category: 'drug' }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  /**
   * Driven through `input.parse` — the boundary the framework validates at —
   * rather than straight into the handler, so the assertion covers what a client
   * actually hits.
   */
  it('rejects a blank search before any upstream request', async () => {
    for (const blank of ['', '   ', '\t']) {
      expect(() => searchRecallsTool.input.parse({ category: 'drug', search: blank })).toThrow(
        /empty or whitespace-only|>=1 characters/i,
      );
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still browses when search is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 17816, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    const input = searchRecallsTool.input.parse({ category: 'drug', limit: 1 });
    const result = await searchRecallsTool.handler(input, ctx);

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: undefined });
    expect(result.results).toHaveLength(1);
  });

  it('formats recall records', () => {
    const content = searchRecallsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          recall_number: 'R-123',
          classification: 'Class I',
          recalling_firm: 'Acme Corp',
          product_description: 'Widget',
          reason_for_recall: 'Contamination',
          status: 'Ongoing',
          voluntary_mandated: 'Voluntary',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('R-123');
    expect(text).toContain('Class I');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Contamination');
  });

  it('renders full product_description and reason_for_recall — parity with structuredContent (no truncation)', () => {
    const reason = `Class I recall. ${'Detailed contamination finding. '.repeat(20)}`;
    const product = `Product monograph. ${'Formulation detail. '.repeat(20)}`;
    const structured = {
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          recall_number: 'R-LONG',
          classification: 'Class I',
          recalling_firm: 'Acme Corp',
          product_description: product,
          reason_for_recall: reason,
          status: 'Ongoing',
        },
      ],
    };

    const text = textOf(searchRecallsTool.format!(structured));
    // content[] carries the identical full field values that structuredContent exposes.
    expect(text).toContain(structured.results[0]!.reason_for_recall);
    expect(text).toContain(structured.results[0]!.product_description);
    expect(reason.length).toBeGreaterThan(300);
    expect(product.length).toBeGreaterThan(300);
    expect(text).not.toContain('...');
  });

  describe('format() by record shape (#46)', () => {
    const META = { total: 1, skip: 0, limit: 10, lastUpdated: '2026-07-01' };
    const HEADER =
      '**1 total results** (returned: 1, skip: 0, limit: 10) | Last updated: 2026-07-01\n';

    /**
     * Enforcement records share one field set across drug, food, and device —
     * shapes taken from live `*\/enforcement` records. Pinned exactly: the
     * device/recall branch must leave this rendering untouched.
     */
    const enforcementCases = [
      {
        name: 'drug/enforcement',
        record: {
          status: 'Ongoing',
          city: 'Princeton',
          classification: 'Class II',
          openfda: { brand_name: ['METFORMIN'], rxcui: ['861004'] },
          product_type: 'Drugs',
          event_id: '96001',
          recalling_firm: 'Acme Pharma',
          voluntary_mandated: 'Voluntary: Firm initiated',
          distribution_pattern: 'Nationwide',
          recall_number: 'D-0001-2026',
          product_description: 'Metformin ER tablets',
          reason_for_recall: 'CGMP deviations',
          report_date: '20260107',
        },
        expected: [
          '**Recall #D-0001-2026** — Class II',
          'Firm: Acme Pharma',
          'Product: Metformin ER tablets',
          'Reason: CGMP deviations',
          'Status: Ongoing | Voluntary: Firm initiated',
          'Distribution: Nationwide',
          '**City:** Princeton',
          '**Openfda:** brand_name=METFORMIN; rxcui=861004',
          '**Product type:** Drugs',
          '**Event id:** 96001',
          '**Report date:** 20260107',
        ],
      },
      {
        name: 'food/enforcement',
        record: {
          status: 'Terminated',
          classification: 'Class I',
          openfda: {},
          product_type: 'Food',
          recalling_firm: 'Acme Foods',
          voluntary_mandated: 'Voluntary: Firm initiated',
          recall_number: 'F-0002-2026',
          product_description: 'Granola bars',
          reason_for_recall: 'Undeclared peanut',
        },
        expected: [
          '**Recall #F-0002-2026** — Class I',
          'Firm: Acme Foods',
          'Product: Granola bars',
          'Reason: Undeclared peanut',
          'Status: Terminated | Voluntary: Firm initiated',
          '**Product type:** Food',
        ],
      },
      {
        name: 'device/enforcement',
        record: {
          status: 'Ongoing',
          classification: 'Class I',
          openfda: {},
          product_type: 'Devices',
          recalling_firm: 'Covidien LP',
          voluntary_mandated: 'Voluntary: Firm initiated',
          distribution_pattern: 'US Nationwide',
          recall_number: 'Z-2372-2023',
          product_description: 'Dialysis catheter',
          reason_for_recall: 'Lumen occlusion',
          recall_initiation_date: '20230628',
        },
        expected: [
          '**Recall #Z-2372-2023** — Class I',
          'Firm: Covidien LP',
          'Product: Dialysis catheter',
          'Reason: Lumen occlusion',
          'Status: Ongoing | Voluntary: Firm initiated',
          'Distribution: US Nationwide',
          '**Product type:** Devices',
          '**Recall initiation date:** 20230628',
        ],
      },
    ];

    it.each(enforcementCases)(
      'renders a $name record exactly as before',
      ({ record, expected }) => {
        const text = textOf(searchRecallsTool.format!({ meta: META, results: [record] }));
        expect(text).toBe(`${HEADER}\n${expected.join('\n')}`);
      },
    );

    /** A live device/recall record (product_code:"DXN"), trimmed of long free text. */
    const deviceRecall = {
      cfres_id: '209973',
      product_res_number: 'Z-0032-2025',
      event_date_initiated: '2024-08-30',
      event_date_posted: '2024-10-08',
      recall_status: 'Open, Classified',
      res_event_number: '95318',
      product_code: 'DXN',
      k_numbers: ['K193627'],
      product_description: 'MEDLINE AUTOMATIC DIGITAL BLOOD PRESSURE UNIT, REF MDS1001',
      recalling_firm: 'MEDLINE INDUSTRIES, LP - Northfield',
      reason_for_recall: 'Faulty microchip fails to power on.',
      root_cause_description: 'Under Investigation by firm',
      action: 'Medline issued a MEDICAL DEVICE RECALL notice.',
      product_quantity: '52,521 units',
      distribution_pattern: 'Worldwide distribution',
      openfda: {
        device_name: 'System, Measurement, Blood-Pressure, Non-Invasive',
        regulation_number: '870.1130',
        device_class: '2',
      },
    };

    it('renders device/recall identity and status from its own fields', () => {
      const text = textOf(searchRecallsTool.format!({ meta: META, results: [deviceRecall] }));
      const [, , identity, firm, product, reason, status, distribution] = text.split('\n');

      expect(identity).toBe('**Recall #Z-0032-2025**');
      expect(firm).toBe('Firm: MEDLINE INDUSTRIES, LP - Northfield');
      expect(product).toBe('Product: MEDLINE AUTOMATIC DIGITAL BLOOD PRESSURE UNIT, REF MDS1001');
      expect(reason).toBe('Reason: Faulty microchip fails to power on.');
      expect(status).toBe('Status: Open, Classified');
      expect(distribution).toBe('Distribution: Worldwide distribution');
    });

    it('never fabricates a recall classification or placeholder for device/recall', () => {
      const text = textOf(searchRecallsTool.format!({ meta: META, results: [deviceRecall] }));
      expect(text).not.toContain('Unclassified');
      expect(text).not.toContain('N/A');
      expect(text).not.toMatch(/Recall #[^\n]*— /);
      // device_class is the product's regulatory class, carried only as its own field.
      expect(text).toContain('**Openfda:** device_name=');
      expect(text).toContain('device_class=2');
    });

    it('carries every other device/recall field once, through the residual pass', () => {
      const text = textOf(searchRecallsTool.format!({ meta: META, results: [deviceRecall] }));
      for (const line of [
        '**Res event number:** 95318',
        '**Root cause description:** Under Investigation by firm',
        '**Event date initiated:** 2024-08-30',
        '**K numbers:** K193627',
        '**Product quantity:** 52,521 units',
      ]) {
        expect(text).toContain(line);
      }
      // Header fields are not repeated as residual lines.
      expect(text).not.toContain('**Product res number:**');
      expect(text).not.toContain('**Recall status:**');
    });

    it('renders a mixed page with each record on its own branch', () => {
      const text = textOf(
        searchRecallsTool.format!({
          meta: { ...META, total: 2 },
          results: [deviceRecall, enforcementCases[2]!.record],
        }),
      );
      const [recall, enforcement] = text.split('\n\n---\n\n');
      expect(recall).toContain('**Recall #Z-0032-2025**\n');
      expect(recall).toContain('Status: Open, Classified');
      expect(enforcement).toBe(enforcementCases[2]!.expected.join('\n'));
    });

    it('renders a device/recall record missing its status as absent, not as an enforcement field', () => {
      const { recall_status: _omit, ...noStatus } = deviceRecall;
      const text = textOf(searchRecallsTool.format!({ meta: META, results: [noStatus] }));
      expect(text).toContain('**Recall #Z-0032-2025**');
      expect(text).toContain('Status: N/A');
      expect(text).not.toContain('Unclassified');
      expect(text).not.toContain('| N/A');
    });
  });
});

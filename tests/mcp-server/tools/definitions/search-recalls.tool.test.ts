import { z } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
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

  // #92 — category and endpoint pick the page size an omitted limit gets and the cap a larger one is clamped to.
  it.each([
    ['drug', 'enforcement', 'drug/enforcement', 25, 1000],
    ['food', 'enforcement', 'food/enforcement', 25, 1000],
    ['device', 'enforcement', 'device/enforcement', 10, 125],
    ['device', 'recall', 'device/recall', 10, 50],
  ] as const)(
    'pages %s %s records on %s at default %i and cap %i',
    async (category, endpoint, path, fallback, cap) => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
        results: [],
      });

      const omitted = await searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category, endpoint }),
        ctx,
      );
      const above = await searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category, endpoint, limit: 5_000 }),
        ctx,
      );

      expect(mockQuery.mock.calls.map(([called, params]) => [called, params.limit])).toEqual([
        [path, fallback],
        [path, cap],
      ]);
      expect([omitted.meta.limit, above.meta.limit]).toEqual([fallback, cap]);
    },
  );

  // #88 — a bare browse is newest first; the endpoint picks the date it sorts on.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it.each([
      ['drug', 'enforcement', 'report_date:desc'],
      ['food', 'enforcement', 'report_date:desc'],
      ['device', 'enforcement', 'report_date:desc'],
      ['device', 'recall', 'event_date_initiated:desc'],
    ] as const)(
      'sends %s %s with neither search nor sort as %s',
      async (category, endpoint, sort) => {
        mockQuery.mockResolvedValue(EMPTY);

        await searchRecallsTool.handler(searchRecallsTool.input.parse({ category, endpoint }), ctx);

        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort });
      },
    );

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category: 'drug', search: 'recalling_firm:"pfizer"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchRecallsTool.handler(
        searchRecallsTool.input.parse({
          category: 'device',
          endpoint: 'recall',
          sort: 'event_date_posted:asc',
        }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'event_date_posted:asc' });
    });

    it('states the newest-first browse on search and both default sorts on sort', () => {
      const shape = searchRecallsTool.input.shape;
      expect(shape.search.description).toContain('Omit to browse newest first.');
      expect(shape.sort.description).toContain(
        'With neither search nor sort, records come newest first by report_date:desc (event_date_initiated:desc on the device recall endpoint).',
      );
    });
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
        results: [{ recall_number: 'R-75' }],
      });

      const result = await runToolContract(searchRecallsTool, {
        category: 'drug',
        search: 'classification:"Class I"+AND+status:"Ongoing"',
      });

      const spaced = 'classification:"Class I" AND status:"Ongoing"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchRecallsTool, {
        category: 'drug',
        search: 'classification.exact:"Class+I"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"Class I"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });

    it('wraps the caller search in the empty-result notice as a code span on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchRecallsTool, {
        category: 'drug',
        search: 'recalling_firm:*pfi*zzz*',
      });

      expect(noticeOf(result)).toContain(
        'No recall/enforcement records matched search: `recalling_firm:*pfi*zzz*` in drug/enforcement.',
      );
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });

    /**
     * device/recall records carry no `classification`: their class sits at
     * `openfda.device_class`, and `classification:"Class I"` there answers 0
     * (live, 2026-11-22), so its miss hint must not offer that field.
     */
    it.each([
      ['drug', 'enforcement', 'e.g. classification, recalling_firm, reason_for_recall'],
      ['device', 'recall', 'e.g. openfda.device_class, recalling_firm, reason_for_recall'],
    ] as const)(
      'names fields %s/%s records carry in its no-match hint',
      async (category, endpoint, fields) => {
        mockQuery.mockResolvedValue(EMPTY);

        const result = await runToolContract(searchRecallsTool, {
          category,
          endpoint,
          search: 'product_description:"zzqx"',
        });

        expect(noticeOf(result)).toContain(`check field names (${fields}).`);
      },
    );
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
      '**1 total results** (returned: 1, skip: 0, limit: 10) | Data updated: 2026-07-01\n';

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

/*
 * #104 — device enforcement and device recall records leave their lot and
 * registrant lists out of a default page. The mechanism (the walk, the byte
 * tally, the include merge) is tabled in `record-projection.test.ts`; these cases
 * prove the tool's wiring, one per side of each branch, through the production
 * parse (`runToolContract`).
 */
describe('openfda_search_recalls — paths left out by default (#104)', () => {
  /** A live device/enforcement record (Z-0346-2027), product description trimmed. */
  const ENFORCEMENT_LOT = {
    status: 'Ongoing',
    classification: 'Class II',
    openfda: {},
    product_type: 'Devices',
    recalling_firm: 'Henry Schein Inc.',
    voluntary_mandated: 'Voluntary: Firm initiated',
    distribution_pattern: 'Worldwide distribution - U.S. Nationwide and the countries of Canada.',
    recall_number: 'Z-0346-2027',
    product_description: 'Perma Sharp Sutures; Model/Catalog Number: PSN8695P',
    reason_for_recall: 'Products lack 510(k) clearance.',
    report_date: '20261111',
    code_info:
      'Model/Catalog Number: PSN8695P (HSI Item No. 600-9795); UDI-DI: 10889950001926; Lot Numbers: 0624001HF, 0624004HF, 0624010HF;',
    more_code_info: '',
  };
  /** A device/enforcement record whose lot list openFDA cut at 32,600 characters (Z-0316-2027's shape). */
  const ENFORCEMENT_CUT = {
    status: 'Ongoing',
    classification: 'Class II',
    recalling_firm: 'Example Devices',
    recall_number: 'Z-0316-2027',
    product_description: 'Infusion set',
    reason_for_recall: 'Leak.',
    code_info: `UDI-DI: ${'00389152075013 '.repeat(2_200)}`.slice(0, 32_600),
    more_code_info: '1532916 1532917 1532926 1532953',
  };
  /** A live device/recall record (Z-0355-2027), its registrant lists as returned. */
  const DEVICE_RECALL = {
    cfres_id: '223399',
    product_res_number: 'Z-0355-2027',
    event_date_initiated: '2026-10-19',
    recall_status: 'Open, Classified',
    product_code: 'NGZ',
    k_numbers: ['K090968'],
    product_description: 'Yeastone Broth, 11ML, 10/BOX',
    code_info: 'YY3462 lot 440400\nUDI-DI 848838018817',
    recalling_firm: 'Remel, Inc',
    reason_for_recall: 'Affected lot did not meet specifications.',
    root_cause_description: 'Under Investigation by firm',
    openfda: {
      k_number: ['K092454', 'K133817', 'K082534', 'K090968', 'K101566'],
      device_name: 'Susceptibility Test Plate, Antifungal',
      medical_specialty_description: 'Microbiology',
      regulation_number: '866.1640',
      device_class: '2',
      registration_number: ['9615754', '3013718871'],
      fei_number: ['3008237827', '3013718871'],
    },
  };

  /** UTF-8 bytes `path` holds on each record, summed — the figure omitted_fields must report. */
  const heldBytes = (records: Record<string, unknown>[], read: (r: never) => unknown) =>
    records.reduce((sum, r) => {
      const value = read(r as never);
      return value === undefined ? sum : sum + Buffer.byteLength(JSON.stringify(value), 'utf8');
    }, 0);

  const page = (records: Record<string, unknown>[], total = records.length) => ({
    meta: { total, skip: 0, limit: 10, lastUpdated: '2026-11-22' },
    results: structuredClone(records),
  });

  type Structured = {
    meta: { total: number };
    notice?: string;
    omitted_fields?: { bytes: number; path: string }[];
    page_bytes?: number;
    projected_fields?: string[];
    results: Record<string, unknown>[];
  };
  const run = async (input: Record<string, unknown>) => {
    const result = await runToolContract(searchRecallsTool, input as never);
    return {
      result,
      structured: result.structuredContent as Structured,
      text: result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
    };
  };

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  it.each(['drug', 'food'] as const)(
    'returns %s enforcement records whole, carrying exactly meta and results',
    async (category) => {
      const second = { ...ENFORCEMENT_LOT, recall_number: 'D-0001-2026', more_code_info: 'Lot 2' };
      mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT, second]));
      const { structured, text } = await run({ category });

      expect(structured.results).toEqual([ENFORCEMENT_LOT, second]);
      expect(structured).not.toHaveProperty('omitted_fields');
      expect(structured.notice).toBeUndefined();
      expect(text).toContain('**Code info:**');

      const ctx = createMockContext({ errors: searchRecallsTool.errors });
      const returned = await searchRecallsTool.handler(
        searchRecallsTool.input.parse({ category }),
        ctx,
      );
      expect(Object.keys(returned)).toEqual(['meta', 'results']);
    },
  );

  it('leaves code_info and more_code_info out of a default device enforcement page, on both surfaces', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT, ENFORCEMENT_CUT]));
    const { structured, text } = await run({ category: 'device' });

    const codeInfo = heldBytes(
      [ENFORCEMENT_LOT, ENFORCEMENT_CUT],
      (r: { code_info: string }) => r.code_info,
    );
    const moreCodeInfo = heldBytes(
      [ENFORCEMENT_LOT, ENFORCEMENT_CUT],
      (r: { more_code_info: string }) => r.more_code_info,
    );
    const { code_info: _a, more_code_info: _b, ...lotRest } = ENFORCEMENT_LOT;
    const { code_info: _c, more_code_info: _d, ...cutRest } = ENFORCEMENT_CUT;
    expect(structured.results).toEqual([lotRest, cutRest]);
    expect(structured.omitted_fields).toEqual([
      { path: 'code_info', bytes: codeInfo },
      { path: 'more_code_info', bytes: moreCodeInfo },
    ]);
    // The empty `more_code_info` on Z-0346-2027 is two bytes left out, not nothing.
    expect(moreCodeInfo).toBe(2 + 33);

    const sentence = `Left out of each record by default: code_info (${codeInfo} bytes on this page), more_code_info (${moreCodeInfo} bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.`;
    expect(structured.notice).toBe(sentence);
    expect(text).toContain(`\n> ${sentence}\n`);
    expect(text).not.toContain('Code info');
    expect(text).not.toContain('0624001HF');
    expect(text).not.toContain('1532916');
  });

  it('leaves code_info and the registrant lists out of a default device recall page, keeping the rest of openfda', async () => {
    mockQuery.mockResolvedValue(page([DEVICE_RECALL]));
    const { structured, text } = await run({ category: 'device', endpoint: 'recall' });

    const [record] = structured.results;
    expect(record).not.toHaveProperty('code_info');
    expect(record?.openfda).toEqual({
      device_name: 'Susceptibility Test Plate, Antifungal',
      medical_specialty_description: 'Microbiology',
      regulation_number: '866.1640',
      device_class: '2',
    });
    expect(record?.k_numbers).toEqual(['K090968']);
    expect(structured.omitted_fields).toEqual([
      {
        path: 'code_info',
        bytes: heldBytes([DEVICE_RECALL], (r: { code_info: string }) => r.code_info),
      },
      { path: 'openfda.k_number', bytes: 51 },
      { path: 'openfda.fei_number', bytes: 27 },
      { path: 'openfda.registration_number', bytes: 24 },
    ]);
    expect(text).toContain('**Openfda:** device_name=Susceptibility Test Plate, Antifungal');
    for (const listed of ['K092454', '9615754', '3008237827', 'YY3462']) {
      expect(text).not.toContain(listed);
    }
    expect(text).toContain(`> ${structured.notice}`);
  });

  it('returns a left-out path include names, and still leaves the others out', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT, ENFORCEMENT_CUT]));
    const { structured, text } = await run({ category: 'device', include: ['code_info'] });

    expect(structured.results.map((r) => r.code_info)).toEqual([
      ENFORCEMENT_LOT.code_info,
      ENFORCEMENT_CUT.code_info,
    ]);
    expect(structured.results[1]).not.toHaveProperty('more_code_info');
    expect(structured.omitted_fields?.map((f) => f.path)).toEqual(['more_code_info']);
    expect(text).toContain('0624001HF');
  });

  it('returns one registrant list on a device recall when include names it alone', async () => {
    mockQuery.mockResolvedValue(page([DEVICE_RECALL]));
    const { structured } = await run({
      category: 'device',
      endpoint: 'recall',
      include: ['openfda.k_number'],
    });

    expect((structured.results[0]!.openfda as { k_number?: unknown }).k_number).toEqual(
      DEVICE_RECALL.openfda.k_number,
    );
    expect(structured.omitted_fields?.map((f) => f.path)).toEqual([
      'code_info',
      'openfda.fei_number',
      'openfda.registration_number',
    ]);
  });

  it('changes nothing for an include entry that names no left-out path', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const plain = await run({ category: 'device' });
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const named = await run({ category: 'device', include: ['recalling_firm', 'no_such_path'] });

    expect(named.structured.results).toEqual(plain.structured.results);
    expect(named.structured.omitted_fields).toEqual(plain.structured.omitted_fields);
    expect(named.result.isError).toBeFalsy();
  });

  it('projects a fields call exactly as before, with no default omission', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const lots = await run({ category: 'device', fields: ['code_info'] });
    expect(lots.structured.results).toEqual([
      { recall_number: 'Z-0346-2027', code_info: ENFORCEMENT_LOT.code_info },
    ]);
    expect(lots.structured).not.toHaveProperty('omitted_fields');

    // A parent path keeps its whole subtree, registrant lists included.
    mockQuery.mockResolvedValue(page([DEVICE_RECALL]));
    const parent = await run({ category: 'device', endpoint: 'recall', fields: ['openfda'] });
    expect(parent.structured.results).toEqual([
      { product_res_number: 'Z-0355-2027', openfda: DEVICE_RECALL.openfda },
    ]);
    expect(parent.structured).not.toHaveProperty('omitted_fields');
  });

  it('joins include entries naming a left-out path to a fields projection', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const { structured } = await run({
      category: 'device',
      fields: ['recalling_firm'],
      include: ['more_code_info', 'status'],
    });

    expect(structured.results).toEqual([
      { recall_number: 'Z-0346-2027', recalling_firm: 'Henry Schein Inc.', more_code_info: '' },
    ]);
    expect(structured.projected_fields).toEqual(['recalling_firm', 'more_code_info']);
    expect(structured).not.toHaveProperty('omitted_fields');
  });

  it('joins the omission to the oversized-record and clamp notices when all three fire', async () => {
    const heavy = { ...ENFORCEMENT_LOT, product_description: 'p'.repeat(30_000) };
    mockQuery.mockResolvedValue(page([heavy]));
    const { structured, text } = await run({ category: 'device', limit: 5_000 });
    const notice = String(structured.notice);

    expect(notice).toContain('limit=5000 is above the 125-record cap for device/enforcement');
    expect(notice).toContain('Left out of each record by default: code_info (');
    expect(notice).toContain('Oversized record: the one record on this page serializes to');
    // The oversized record is measured as returned: its lot list is already out.
    expect(notice).toContain('Its largest field is product_description (30002 bytes)');
    expect(notice.indexOf('Left out')).toBeLessThan(notice.indexOf('Oversized record'));
    expect(text).toMatch(/^> Left out of each record by default: /m);
    expect(text).toMatch(/^> Oversized record: /m);
  });

  it('parses on a page with nothing left out, a page with something left out, and an empty page', async () => {
    const { code_info: _a, more_code_info: _b, ...bare } = ENFORCEMENT_LOT;
    mockQuery.mockResolvedValue(page([bare]));
    const nothing = await run({ category: 'device' });
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const something = await run({ category: 'device' });
    mockQuery.mockResolvedValue(page([], 0));
    const empty = await run({ category: 'device' });

    for (const { result } of [nothing, something, empty]) expect(result.isError).toBeFalsy();
    expect(nothing.structured.results).toEqual([bare]);
    expect(nothing.structured).not.toHaveProperty('omitted_fields');
    expect(nothing.structured.notice).toBeUndefined();
    expect(something.structured.omitted_fields).toHaveLength(2);
    expect(empty.structured.results).toEqual([]);
    expect(empty.structured).not.toHaveProperty('omitted_fields');
    expect(empty.text).not.toContain('Left out');
  });

  it('returns the left-out path a search clause names, and leaves the others out', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const { structured, text } = await run({ category: 'device', search: 'code_info:"0624001HF"' });

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: 'code_info:"0624001HF"' });
    expect(structured.results[0]?.code_info).toBe(ENFORCEMENT_LOT.code_info);
    expect(structured.results[0]).not.toHaveProperty('more_code_info');
    expect(structured.omitted_fields).toEqual([{ path: 'more_code_info', bytes: 2 }]);
    expect(text).toContain('0624001HF, 0624004HF');
  });

  it.each([
    ['an _exists_ clause', '_exists_:more_code_info', 'device/enforcement', 'more_code_info'],
    ['an .exact clause', 'code_info.exact:"YY3462 lot 440400"', 'device/recall', 'code_info'],
    ['a registrant list clause', 'openfda.k_number:K090968', 'device/recall', 'openfda.k_number'],
  ])('counts %s as an include of its path', async (_label, search, endpoint, path) => {
    const record = endpoint === 'device/recall' ? DEVICE_RECALL : ENFORCEMENT_LOT;
    mockQuery.mockResolvedValue(page([record]));
    const { structured } = await run({
      category: 'device',
      endpoint: endpoint === 'device/recall' ? 'recall' : 'enforcement',
      search,
    });
    const paths = structured.omitted_fields?.map((f) => f.path) ?? [];
    expect(paths).not.toContain(path);
    expect(paths.length).toBeGreaterThan(0);
    expect(JSON.stringify(structured.results[0])).toContain(`"${path.split('.').at(-1)}":`);
  });

  it('adds nothing a search names to a fields projection', async () => {
    mockQuery.mockResolvedValue(page([ENFORCEMENT_LOT]));
    const { structured } = await run({
      category: 'device',
      fields: ['recalling_firm'],
      search: 'code_info:"0624001HF"',
    });
    expect(structured.results).toEqual([
      { recall_number: 'Z-0346-2027', recalling_firm: 'Henry Schein Inc.' },
    ]);
    expect(structured.projected_fields).toEqual(['recalling_firm']);
  });

  /** A default device/recall walk: a first page of DEVICE_RECALL linked onward, then `next` at position 1. */
  describe('read by cursor (#97)', () => {
    const NEXT = {
      ...structuredClone(DEVICE_RECALL),
      cfres_id: '223400',
      product_res_number: 'Z-0356-2027',
      code_info: 'YY3463 lot 440401\nUDI-DI 848838018824',
    };
    const LINK = '0=1792368000000;1=223399';
    const KEPT_OPENFDA = {
      device_name: 'Susceptibility Test Plate, Antifungal',
      medical_specialty_description: 'Microbiology',
      regulation_number: '866.1640',
      device_class: '2',
    };
    const RECALL = { category: 'device', endpoint: 'recall', limit: 1 } as const;
    /** Answer the first page, then each later call with NEXT, and return the first page's next_cursor. */
    const firstPage = async (laterCalls: number) => {
      mockQuery.mockResolvedValueOnce({
        meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-22' },
        results: [structuredClone(DEVICE_RECALL)],
        nextSearchAfter: LINK,
      });
      for (let call = 0; call < laterCalls; call++) {
        mockQuery.mockResolvedValueOnce({
          meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-22' },
          results: [structuredClone(NEXT)],
        });
      }
      const first = await run(RECALL);
      const cursor = (first.structured as { next_cursor?: string }).next_cursor;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      return { first, cursor };
    };
    const END =
      'This page holds the last 1 of the 2 matched records, so the cursor walk is complete.';

    it('leaves the same paths out of a default page read by cursor as the first page, naming them in omitted_fields on both surfaces', async () => {
      const { first, cursor } = await firstPage(1);

      const next = await run({ ...RECALL, cursor });

      expect(mockQuery.mock.calls[1]![1]).toMatchObject({
        searchAfter: { position: 1, value: LINK },
      });
      const leftOutOf = (record: typeof DEVICE_RECALL) => [
        {
          path: 'code_info',
          bytes: heldBytes([record], (r: { code_info: string }) => r.code_info),
        },
        { path: 'openfda.k_number', bytes: 51 },
        { path: 'openfda.fei_number', bytes: 27 },
        { path: 'openfda.registration_number', bytes: 24 },
      ];
      const sentence = (fields: { bytes: number; path: string }[]) =>
        `Left out of each record by default: ${fields.map((f) => `${f.path} (${f.bytes} bytes on this page)`).join(', ')}. Re-call with include naming a path to return it, or a path beneath it for that field alone.`;
      expect(first.structured.omitted_fields).toEqual(leftOutOf(DEVICE_RECALL));
      expect(next.structured.omitted_fields).toEqual(leftOutOf(NEXT));
      for (const { structured } of [first, next]) {
        expect(structured.results[0]).not.toHaveProperty('code_info');
        expect(structured.results[0]?.openfda).toEqual(KEPT_OPENFDA);
      }
      expect(next.structured.results[0]?.product_res_number).toBe('Z-0356-2027');
      const left = sentence(leftOutOf(NEXT));
      expect(next.structured.notice).toBe(`${END} ${left}`);
      expect(next.text).toContain(`\n> ${left}\n`);
      expect(next.text).toContain(`\n> ${END} ${left}`);
      for (const listed of ['YY3463', 'K092454', '9615754', '3008237827']) {
        expect(next.text).not.toContain(listed);
      }
    });

    it('accepts the cursor on a next call that adds include or changes fields, and returns what each asks for', async () => {
      const { cursor } = await firstPage(2);

      const included = await run({ ...RECALL, cursor, include: ['code_info', 'openfda.k_number'] });
      const projected = await run({
        ...RECALL,
        cursor,
        fields: ['recalling_firm', 'openfda.fei_number'],
      });

      expect(mockQuery.mock.calls.slice(1).map(([, params]) => params.searchAfter)).toEqual([
        { position: 1, value: LINK },
        { position: 1, value: LINK },
      ]);
      expect(included.result.isError).toBeFalsy();
      const [withLists] = included.structured.results;
      expect(withLists?.code_info).toBe(NEXT.code_info);
      expect(withLists?.openfda).toEqual({ ...KEPT_OPENFDA, k_number: NEXT.openfda.k_number });
      expect(included.structured.omitted_fields?.map((f) => f.path)).toEqual([
        'openfda.fei_number',
        'openfda.registration_number',
      ]);
      expect(included.text).toContain('YY3463 lot 440401');
      expect(included.text).toContain('K092454');

      expect(projected.result.isError).toBeFalsy();
      expect(projected.structured.results).toEqual([
        {
          product_res_number: 'Z-0356-2027',
          recalling_firm: 'Remel, Inc',
          openfda: { fei_number: NEXT.openfda.fei_number },
        },
      ]);
      expect(projected.structured.projected_fields).toEqual([
        'recalling_firm',
        'openfda.fei_number',
      ]);
      expect(projected.structured).not.toHaveProperty('omitted_fields');
      const notice =
        "Records projected to the requested fields (`recalling_firm`, `openfda.fei_number`) plus each record's identity key; every other field is left out on request.";
      expect(projected.structured.notice).toBe(`${END} ${notice}`);
      expect(projected.text).toContain(`\n> ${END} ${notice}`);
      expect(projected.text).toContain('3008237827');
    });
  });

  it('rejects a malformed include path before any upstream request', async () => {
    const { result, text } = await run({ category: 'device', include: ['code_info..x'] });
    expect(result.isError).toBe(true);
    expect(text).toContain('include');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

/**
 * #97 — the tool's own cursor surface, per endpoint shape. The walk, the
 * binding, and the refusals run through every cursor tool in
 * pagination-contract.test.ts; the token at its seam in pagination-cursor.test.ts.
 */
describe('openfda_search_recalls — cursor (#97)', () => {
  const run = async (input: Record<string, unknown>) => {
    const result = await runToolContract(searchRecallsTool, input as never);
    return {
      result,
      structured: result.structuredContent as {
        meta: { skip: number; total: number };
        next_cursor?: string;
        notice?: string;
        omitted_fields?: { bytes: number; path: string }[];
        results: Record<string, unknown>[];
      },
      text: result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
    };
  };

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  it('returns a page read without a cursor byte-identical on both surfaces', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 40, skip: 0, limit: 125, lastUpdated: '2026-11-22' },
      results: [
        {
          recall_number: 'Z-0346-2027',
          classification: 'Class II',
          status: 'Ongoing',
          recalling_firm: 'Henry Schein Inc.',
          code_info: 'Lot Numbers: 0624001HF',
          more_code_info: '',
        },
      ],
    });

    const { structured, text } = await run({ category: 'device', limit: 5000 });

    const left =
      'Left out of each record by default: code_info (24 bytes on this page), more_code_info (2 bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.';
    const notice = `limit=5000 is above the 125-record cap for device/enforcement, so 125 was applied. The next page starts at skip=1. ${left}`;
    expect(JSON.stringify(structured)).toBe(
      JSON.stringify({
        meta: { total: 40, skip: 0, limit: 125, lastUpdated: '2026-11-22' },
        results: [
          {
            recall_number: 'Z-0346-2027',
            classification: 'Class II',
            status: 'Ongoing',
            recalling_firm: 'Henry Schein Inc.',
          },
        ],
        omitted_fields: [
          { path: 'code_info', bytes: 24 },
          { path: 'more_code_info', bytes: 2 },
        ],
        totalResults: 40,
        notice,
      }),
    );
    expect(text).toBe(
      [
        '**40 total results** (returned: 1, skip: 0, limit: 125) | Data updated: 2026-11-22',
        '',
        `> ${left}`,
        '',
        '**Recall #Z-0346-2027** — Class II',
        'Firm: Henry Schein Inc.',
        'Product: N/A',
        'Reason: N/A',
        'Status: Ongoing | N/A',
        '',
        '',
        '**totalResults:** 40',
        `> ${notice}`,
      ].join('\n'),
    );
  });

  it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
    const input = z.toJSONSchema(searchRecallsTool.input) as unknown as {
      properties: Record<string, { pattern?: string }>;
      required?: string[];
    };
    expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
    expect(input.required ?? []).not.toContain('cursor');
    const output = z.toJSONSchema(searchRecallsTool.output) as unknown as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(output.properties.next_cursor?.type).toBe('string');
    expect(output.required ?? []).not.toContain('next_cursor');
  });

  it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
    expect(searchRecallsTool.errors).toContain(invalidCursorError);
    expect(searchRecallsTool.errors).toContain(paginationLimitReachedError);
    expect(
      searchRecallsTool.errors?.filter((e) => e.reason === 'pagination_limit_reached'),
    ).toHaveLength(1);
  });

  /** Every endpoint shape the tool serves: its input, the path it sends, and its default sort. */
  const SHAPES = [
    [{ category: 'drug', endpoint: 'enforcement' }, 'drug/enforcement', 'report_date:desc'],
    [{ category: 'food', endpoint: 'enforcement' }, 'food/enforcement', 'report_date:desc'],
    [{ category: 'device', endpoint: 'enforcement' }, 'device/enforcement', 'report_date:desc'],
    [{ category: 'device', endpoint: 'recall' }, 'device/recall', 'event_date_initiated:desc'],
  ] as const;

  /** Read a linked first page of `shape` and return the next_cursor it issued. */
  const firstCursor = async (shape: (typeof SHAPES)[number][0]) => {
    mockQuery.mockResolvedValueOnce({
      meta: { total: 3, skip: 0, limit: 1, lastUpdated: '2026-11-22' },
      results: [{ recall_number: 'R-1' }],
      nextSearchAfter: '0=1794355200000;1=06ee2bba',
    });
    const { structured, text } = await run({ ...shape, limit: 1 });
    expect(structured.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text.split('\n')[2]).toBe(`next_cursor: \`${structured.next_cursor}\``);
    return structured.next_cursor as string;
  };

  it.each(SHAPES)(
    'issues and follows a cursor on %o, bound to %s and %s',
    async (shape, path, sort) => {
      const cursor = await firstCursor(shape);
      mockQuery.mockResolvedValueOnce({
        meta: { total: 3, skip: 1, limit: 1, lastUpdated: '2026-11-22' },
        results: [{ recall_number: 'R-2' }],
        nextSearchAfter: '0=1794355200000;1=0872b444',
      });

      const { result, structured } = await run({ ...shape, limit: 1, cursor });

      expect(result.isError).toBeFalsy();
      expect(mockQuery.mock.calls.map(([called, params]) => [called, params.sort])).toEqual([
        [path, sort],
        [path, sort],
      ]);
      expect(mockQuery.mock.calls[1]![1]).toMatchObject({
        skip: 0,
        searchAfter: { position: 1, value: '0=1794355200000;1=06ee2bba' },
      });
      expect(structured.meta.skip).toBe(1);
      expect(structured.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(structured.next_cursor).not.toBe(cursor);
    },
  );

  it.each(
    SHAPES.flatMap(([from, fromPath]) =>
      SHAPES.filter(([, toPath]) => toPath !== fromPath).map(
        ([to, toPath]) => [fromPath, toPath, from, to] as const,
      ),
    ),
  )('refuses a %s cursor on %s before any request', async (_from, _to, from, to) => {
    const cursor = await firstCursor(from);

    const { result } = await run({ ...to, limit: 1, cursor });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as {
      error: { message: string; data?: { reason?: string } };
    };
    expect(error.data?.reason).toBe('invalid_cursor');
    expect(error.message).toContain('different endpoint, search, or sort');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('joins the end of a cursor walk to the left-out notice on a device page, on both surfaces', async () => {
    const cursor = await firstCursor({ category: 'device', endpoint: 'enforcement' });
    mockQuery.mockResolvedValueOnce({
      meta: { total: 3, skip: 1, limit: 2, lastUpdated: '2026-11-22' },
      results: [
        { recall_number: 'Z-0002-2027', code_info: 'Lot 2' },
        { recall_number: 'Z-0003-2027', code_info: 'Lot 3', more_code_info: '' },
      ],
      nextSearchAfter: '0=1794355200000;1=0872b444',
    });

    const { structured, text } = await run({ category: 'device', limit: 2, cursor });

    expect(structured.next_cursor).toBeUndefined();
    expect(structured.results).toEqual([
      { recall_number: 'Z-0002-2027' },
      { recall_number: 'Z-0003-2027' },
    ]);
    const end =
      'This page holds the last 2 of the 3 matched records, so the cursor walk is complete.';
    const left =
      'Left out of each record by default: code_info (14 bytes on this page), more_code_info (2 bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.';
    expect(structured.notice).toBe(`${end} ${left}`);
    expect(text).toContain(`\n> ${end} ${left}`);
    expect(text).not.toContain('next_cursor:');
  });
});

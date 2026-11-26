import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { lookupNdcTool, nsdeRoute } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { planMirrorLookup } from '@/services/openfda/mirror/query.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';
import { linearTiming } from '../../../helpers/cpu-timing.js';

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

  // The handler sends the caller's sort or none: no browse default to state.
  // The example sorts on both datasets: nsde carries no listing_expiration_date.
  it('gives a sort example both datasets accept and claims no newest-first default', () => {
    const description = lookupNdcTool.input.shape.sort.description ?? '';
    expect(description).toContain('several comma-separated, e.g. marketing_start_date:desc.');
    expect(description).not.toContain('newest first');
  });

  /**
   * A call that names no `dataset` (#94), pinned on the request and both
   * surfaces before the NSDE dataset, the cursor, and the cross-element notice
   * reached this tool: it must send and return exactly this.
   */
  describe('a call without dataset (characterization)', () => {
    const textOfCall = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

    it('sends the drug/ndc request and returns a record page unchanged', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 15, skip: 0, limit: 25, lastUpdated: '2026-11-21' },
        results: [structuredClone(ELIQUIS)],
      });

      const result = await runToolContract(lookupNdcTool, { search: 'brand_name:"eliquis"' });

      expect(mockQuery.mock.calls).toHaveLength(1);
      expect(mockQuery.mock.calls[0]![0]).toBe('drug/ndc');
      expect(mockQuery.mock.calls[0]![1]).toEqual({
        search: 'brand_name:"eliquis"',
        limit: 25,
        skip: 0,
      });
      expect(JSON.stringify(result.structuredContent)).toBe(
        JSON.stringify({
          meta: { total: 15, skip: 0, limit: 25, lastUpdated: '2026-11-21' },
          results: [ELIQUIS],
          totalResults: 15,
          effectiveQuery: 'brand_name:"eliquis"',
        }),
      );
      expect(textOfCall(result)).toBe(
        [
          '**15 total results** (returned: 1, skip: 0, limit: 25) | Data updated: 2026-11-21',
          '',
          '### ELIQUIS',
          '**NDC:** 50090-1436 | **Labeler:** A-S Medication Solutions',
          '**Generic:** apixaban',
          '**Form:** TABLET, FILM COATED',
          '**Route:** ORAL',
          '**Category:** NDA',
          '**Active ingredients:** APIXABAN (2.5 mg/1)',
          '**Packaging:**',
          '- 50090-1436-0: 60 TABLET, FILM COATED in 1 BOTTLE, PLASTIC (50090-1436-0)',
          '**Marketing start date:** 20141128',
          '**Sample:** false',
          '',
          '**Listing expires:** 20261231',
          '**Finished:** true',
          '**Openfda:** manufacturer_name=A-S Medication Solutions; rxcui=1364435',
          '**Spl id:** 76e8efee-ea1e-460e-8027-443facf02ee9',
          '**Product type:** HUMAN PRESCRIPTION DRUG',
          '**Marketing start date:** 20121228',
          '**Product id:** 50090-1436_76e8efee-ea1e-460e-8027-443facf02ee9',
          '**Application number:** NDA202155',
          '**Brand name base:** ELIQUIS',
          '**Pharm class:** Factor Xa Inhibitor [EPC], Factor Xa Inhibitors [MoA]',
          '',
          '',
          '',
          '**totalResults:** 15',
          'Query: `brand_name:"eliquis"`',
        ].join('\n'),
      );
    });

    it('returns an empty page with the 0.10.0 notice when the search holds no NDC', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-21' },
        results: [],
      });

      const result = await runToolContract(lookupNdcTool, { search: 'brand_name:"noexist"' });

      expect(JSON.stringify(result.structuredContent)).toBe(
        JSON.stringify({
          meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-21' },
          results: [],
          totalResults: 0,
          effectiveQuery: 'brand_name:"noexist"',
          notice: NDC_MISS_0_10,
        }),
      );
      expect(textOfCall(result)).toBe(
        [
          '**0 total results** (returned: 0, skip: 0, limit: 25) | Data updated: 2026-11-21',
          '',
          'No NDC records found.',
          '',
          '',
          '**totalResults:** 0',
          'Query: `brand_name:"noexist"`',
          `> ${NDC_MISS_0_10}`,
        ].join('\n'),
      );
    });
  });

  /** #94 — the NDC SPL Data Elements dataset, and the pointer an empty drug/ndc page gives to it. */
  describe('NSDE (#94)', () => {
    type Call = Awaited<ReturnType<typeof runToolContract>>;
    const textOfCall = (result: Call) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const noticeOf = (result: Call) => (result.structuredContent as { notice?: string }).notice;
    const emptyPage = () => ({
      meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
      results: [],
    });
    const NDC_HINT =
      'Key searchable fields for drug/ndc: product_ndc, brand_name, generic_name, labeler_name, dosage_form, route. Call openfda_describe_fields({ endpoint: "drug/ndc" }) for the full list.';
    const ELEVEN_ROUTE = (token: string) =>
      `\`${token}\` is an 11-digit NDC, a form drug/ndc does not hold: search \`package_ndc11:"00093171201"\` with dataset "nsde", which returns its hyphenated package_ndc.`;
    const HYPHENATED_ROUTE = (token: string) =>
      `drug/ndc holds only currently listed products: search \`package_ndc:"${token}"\` with dataset "nsde", which keeps packages whose marketing ended.`;

    describe('nsdeRoute', () => {
      it.each([
        ['packaging.package_ndc:"00093171201"', ELEVEN_ROUTE('00093171201')],
        ['00093171201', ELEVEN_ROUTE('00093171201')],
        ['packaging.package_ndc:"00093-1712-01"', ELEVEN_ROUTE('00093-1712-01')],
        [
          'packaging.package_ndc:"0093171201"',
          '`0093171201` is an NDC without hyphens, which no field matches as written. It reads as `0093-1712-01`, `00931-712-01`, or `00931-7120-1`: search each as packaging.package_ndc here, or as package_ndc with dataset "nsde", which keeps packages whose marketing ended.',
        ],
        ['packaging.package_ndc:"63629-3292-1"', HYPHENATED_ROUTE('63629-3292-1')],
        ['product_ndc:"63629-3292"', HYPHENATED_ROUTE('63629-3292')],
        // The schema quotes an unquoted hyphenated value, so the handler sees the quoted form.
        ['"0003-0894"', HYPHENATED_ROUTE('0003-0894')],
        ['0003-0894', HYPHENATED_ROUTE('0003-0894')],
        ['packaging.package_ndc:"0093-1712-01"', HYPHENATED_ROUTE('0093-1712-01')],
        ['packaging.package_ndc:"00931-712-01"', HYPHENATED_ROUTE('00931-712-01')],
        ['packaging.package_ndc:"00931-7120-1"', HYPHENATED_ROUTE('00931-7120-1')],
        ['product_ndc:"12345-678" AND dosage_form:"TABLET"', HYPHENATED_ROUTE('12345-678')],
        ['product_ndc:(12345-6789)', HYPHENATED_ROUTE('12345-6789')],
      ])('routes %s', (search, route) => {
        expect(nsdeRoute(search)).toBe(route);
      });

      it.each([
        'listing_expiration_date:[20250101 TO 20251231]',
        'application_number:"ANDA040616"',
        'openfda.upc:"0300450449108"',
        // A UUID whose last group ends in an 11-digit run.
        'openfda.spl_set_id:"78d12b2c-0521-4b64-a22e-f73886563405"',
        'openfda.spl_set_id:"3c2a1234-5678-42bc-9def-0123456789ab"',
        'openfda.rxcui:"855332"',
        '000931712',
        '000931712011',
        '0093-17120-1',
        'brand_name:"aspirin"',
        'ndc_00093171201',
      ])('finds no NDC in %s', (search) => {
        expect(nsdeRoute(search)).toBeUndefined();
      });

      it('names the first NDC a search holds', () => {
        expect(nsdeRoute('packaging.package_ndc:"0093-1712-01" OR "00093171201"')).toBe(
          HYPHENATED_ROUTE('0093-1712-01'),
        );
      });

      it.each([
        ['a long digit run', (n: number) => '1'.repeat(n)],
        ['a repeated product opener', (n: number) => '0000-'.repeat(n / 5)],
        ['12-digit runs', (n: number) => ' 123456789012'.repeat(n / 13)],
        ['4-4 runs with a short tail', (n: number) => ' 1234-5678-9'.repeat(n / 12)],
        ['5-3 runs with a short tail', (n: number) => ' 12345-678-9'.repeat(n / 12)],
        ['5-4 runs with a dangling hyphen', (n: number) => ' 12345-6789-'.repeat(n / 12)],
        ['one long line ending in a break', (n: number) => `${'0000-'.repeat(n / 5)}\n`],
        ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
      ])('stays linear on %s', (_shape, build) => {
        const small = build(5_000);
        const large = build(320_000);
        expect(nsdeRoute(large)).toBeUndefined();
        const { t5k, t320k } = linearTiming((search) => nsdeRoute(search), small, large);
        expect(t320k / t5k).toBeLessThan(256);
        expect(t320k).toBeLessThan(500_000);
      });
    });

    it('names the NSDE route on an empty drug/ndc page, the quoted form the schema sends included', async () => {
      mockQuery.mockResolvedValue(emptyPage());

      const result = await runToolContract(lookupNdcTool, {
        search: 'packaging.package_ndc:0093-1712-01',
      });

      const notice = `No NDC records matched the query. ${HYPHENATED_ROUTE('0093-1712-01')} ${NDC_HINT}`;
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({
        search: 'packaging.package_ndc:"0093-1712-01"',
      });
      expect(noticeOf(result)).toBe(notice);
      expect(textOfCall(result)).toContain(`> ${notice}`);
    });

    it('stays silent on a page with records, though the search holds an NDC', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [{ product_ndc: '0093-1712', brand_name: 'Warfarin' }],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'packaging.package_ndc:"00093171201"',
      });

      expect(noticeOf(result)).toBeUndefined();
      expect(textOfCall(result)).not.toContain('nsde');
    });

    it('stays silent on a page past the end of a match', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 50, limit: 25, lastUpdated: '2026-11-20' },
        results: [],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'product_ndc:"63629-3292"',
        skip: 50,
      });

      expect(noticeOf(result)).toBe(
        'No records at skip=50: 3 matched, so the offset is past the end of the result set. Lower skip to read them.',
      );
    });

    it('sends the clamp and the NSDE route together when both apply', async () => {
      mockQuery.mockResolvedValue(emptyPage());

      const result = await runToolContract(lookupNdcTool, {
        search: '00093171201',
        limit: 5000,
      });

      expect(noticeOf(result)).toBe(
        `No NDC records matched the query. ${ELEVEN_ROUTE('00093171201')} ${NDC_HINT} limit=5000 is above the 1000-record cap for drug/ndc, so 1000 was applied.`,
      );
    });

    it('advertises dataset as an optional ndc | nsde enum defaulting to ndc', () => {
      const schema = z.toJSONSchema(lookupNdcTool.input, { io: 'input' }) as unknown as {
        properties: Record<string, { default?: unknown; enum?: unknown[] }>;
        required?: string[];
      };
      expect(schema.properties.dataset).toMatchObject({ enum: ['ndc', 'nsde'], default: 'ndc' });
      expect(schema.required).toEqual(['search']);
    });

    it('rejects a dataset it does not know at argument validation', async () => {
      const result = await runToolContract(lookupNdcTool, { search: 'x', dataset: 'spl' } as never);

      expect(result.isError).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('queries other/nsde with the request a drug/ndc call sends', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [{ ...WARFARIN_NSDE }],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'package_ndc11:"00093171201"',
        dataset: 'nsde',
      });

      expect(mockQuery.mock.calls[0]![0]).toBe('other/nsde');
      expect(mockQuery.mock.calls[0]![1]).toEqual({
        search: 'package_ndc11:"00093171201"',
        limit: 25,
        skip: 0,
      });
      expect((result.structuredContent as { results: unknown[] }).results).toEqual([WARFARIN_NSDE]);
    });

    it('renders every field of an NSDE row, the marketing end date after both NDCs', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 2, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [{ ...ENDED_NSDE }, { ...SPARSE_NSDE }],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'marketing_category:"ANDA"',
        dataset: 'nsde',
      });

      const text = textOfCall(result);
      expect(text).toContain(
        [
          '### Pioglitazone Hydrochloride',
          '**Package NDC:** 63629-3292-1 | **NDC11:** 63629329201',
          '**Marketing end date:** 20250930',
        ].join('\n'),
      );
      for (const row of [ENDED_NSDE, SPARSE_NSDE]) {
        for (const value of Object.values(row)) expect(text).toContain(String(value));
      }
      // The sparse row has no application number, billing unit, or end date, and none is invented.
      const sparse = text.slice(text.indexOf('### Aesculus Hippocastanum'));
      expect(sparse).not.toMatch(
        /Application number|Billing unit|Marketing end date|N\/A|undefined/,
      );
      expect(sparse).toContain('**Inactivation date:** 20230130');
    });

    it('heads a row with no proprietary name by its 11-digit NDC', () => {
      const text = textOf(
        lookupNdcTool.format!({
          meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
          results: [{ package_ndc11: '00093171201' }],
        }),
      );
      expect(text).toContain('### 00093171201\n**NDC11:** 00093171201\n');
    });

    it('keeps package_ndc11 on a fields-projected NSDE row and heads it by it', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [{ ...WARFARIN_NSDE }],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'package_ndc11:"00093171201"',
        dataset: 'nsde',
        fields: ['billing_unit'],
      });

      expect((result.structuredContent as { results: unknown[] }).results).toEqual([
        { package_ndc11: '00093171201', billing_unit: 'EA' },
      ]);
      expect(textOfCall(result)).toContain('### package_ndc11: 00093171201\n**Billing unit:** EA');
    });

    it('names the spelling each NSDE field takes on an empty NSDE page, never the drug/ndc route', async () => {
      mockQuery.mockResolvedValue(emptyPage());

      const result = await runToolContract(lookupNdcTool, {
        search: 'package_ndc:"0093171201"',
        dataset: 'nsde',
      });

      const notice = noticeOf(result) ?? '';
      expect(notice).toMatch(/^No NSDE package rows matched the query\./);
      expect(notice).toContain('package_ndc11 11 digits without hyphens ("00093171201")');
      expect(notice).toContain('package_ndc the hyphenated 10-digit form ("0093-1712-01"');
      expect(notice).toContain(
        'proprietary_name the whole name in stored case ("Warfarin Sodium";',
      );
      expect(notice).toContain('openfda_describe_fields({ endpoint: "other/nsde" })');
      expect(notice).not.toContain('It reads as');
      expect(notice).not.toContain('brand_name');
      expect(textOfCall(result)).toContain(`> ${notice}`);
    });

    it('clamps an NSDE limit to its own cap and names its endpoint', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 1000, lastUpdated: '2026-11-20' },
        results: [{ ...WARFARIN_NSDE }],
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'package_ndc11:"00093171201"',
        dataset: 'nsde',
        limit: 1500,
      });

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 1000 });
      expect(noticeOf(result)).toBe(
        'limit=1500 is above the 1000-record cap for other/nsde, so 1000 was applied; this page holds the last 1 of the 1 matched records.',
      );
    });

    // The local mirror holds drug/ndc and answers a one-record product_ndc lookup; NSDE never reaches it.
    it('sends an NSDE lookup nowhere the mirror can answer, and a drug/ndc one where it still can', async () => {
      mockQuery.mockResolvedValue(emptyPage());

      await runToolContract(lookupNdcTool, {
        search: 'package_ndc11:"00093171201"',
        dataset: 'nsde',
      });
      await runToolContract(lookupNdcTool, { search: 'product_ndc:"0093-1712"' });

      const [nsde, ndc] = mockQuery.mock.calls;
      expect(planMirrorLookup(nsde![0], nsde![1])).toBeUndefined();
      expect(planMirrorLookup(ndc![0], ndc![1])).toMatchObject({
        field: 'product_ndc',
        value: '0093-1712',
      });
    });
  });

  /**
   * #97 — the tool's own cursor surface, on both datasets. The walk, the
   * binding, and the refusals run through every cursor tool in
   * pagination-contract.test.ts; the token at its seam in pagination-cursor.test.ts.
   */
  describe('cursor (#97)', () => {
    type Call = Awaited<ReturnType<typeof runToolContract>>;
    const structured = (result: Call) =>
      result.structuredContent as { next_cursor?: string; notice?: string; results: unknown[] };

    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(lookupNdcTool.input, { io: 'input' }) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required).toEqual(['search']);
      const output = z.toJSONSchema(lookupNdcTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
      expect(lookupNdcTool.errors).toContain(invalidCursorError);
      expect(lookupNdcTool.errors).toContain(paginationLimitReachedError);
      expect(lookupNdcTool.errors?.filter((e) => e.reason === 'pagination_limit_reached')).toEqual([
        paginationLimitReachedError,
      ]);
    });

    it('sends no searchAfter and returns no next_cursor key without a cursor or a link', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 0, limit: 25, lastUpdated: '2026-01-01' },
        results: [{ product_ndc: '0363-0218' }],
      });

      const result = await lookupNdcTool.handler(
        lookupNdcTool.input.parse({ search: 'aspirin' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
    });

    it.each([
      ['ndc', 'drug/ndc', { product_ndc: '0093-1712' }],
      ['nsde', 'other/nsde', { package_ndc11: '00093171201' }],
    ] as const)(
      'walks %s by cursor on its own endpoint, the token on both surfaces',
      async (dataset, endpoint, record) => {
        mockQuery
          .mockResolvedValueOnce({
            meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
            results: [{ ...record }],
            nextSearchAfter: '0=first',
          })
          .mockResolvedValueOnce({
            meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-20' },
            results: [{ ...record }],
            nextSearchAfter: '0=second',
          });

        const first = await runToolContract(lookupNdcTool, {
          search: 'marketing_category:"ANDA"',
          dataset,
          limit: 1,
        });
        const cursor = structured(first).next_cursor;
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        const firstText = first.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
        expect(firstText.join('\n')).toContain(`\nnext_cursor: \`${cursor}\`\n`);

        const second = await runToolContract(lookupNdcTool, {
          search: 'marketing_category:"ANDA"',
          dataset,
          limit: 1,
          cursor,
        });

        expect(mockQuery.mock.calls.map((call) => call[0])).toEqual([endpoint, endpoint]);
        expect(mockQuery.mock.calls[1]![1]).toMatchObject({
          searchAfter: { value: '0=first', position: 1 },
          skip: 0,
        });
        expect(structured(second).next_cursor).toBeUndefined();
        expect(structured(second).notice).toBe(
          'This page holds the last 1 of the 2 matched records, so the cursor walk is complete.',
        );
      },
    );

    it('joins the end of a cursor walk with the oversized-record disclosure on one notice', async () => {
      mockQuery
        .mockResolvedValueOnce({
          meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
          results: [{ product_ndc: '0093-1712' }],
          nextSearchAfter: '0=first',
        })
        .mockResolvedValueOnce({
          meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-20' },
          results: [{ product_ndc: '0093-1713', packaging: [{ description: 'x'.repeat(30_000) }] }],
        });
      const first = await runToolContract(lookupNdcTool, { search: 'aspirin', limit: 1 });

      const second = await runToolContract(lookupNdcTool, {
        search: 'aspirin',
        limit: 1,
        cursor: structured(first).next_cursor,
      });

      const notice = structured(second).notice ?? '';
      expect(notice).toMatch(
        /^This page holds the last 1 of the 2 matched records, so the cursor walk is complete\. /,
      );
      expect(notice).toContain('24000 bytes');
    });
  });

  /**
   * #100 — AND-ed clauses on one active_ingredients or packaging array can be
   * met by different entries. The scan and the SQL are tabled at their seam in
   * search-clauses.test.ts; these prove the inline wiring. The staged path, and
   * the SQL run against a real staged table, live in
   * lookup-ndc-staging-columns.test.ts.
   */
  describe('clauses one array entry must meet together (#100)', () => {
    type Call = Awaited<ReturnType<typeof runToolContract>>;
    const noticeOf = (result: Call) => (result.structuredContent as { notice?: string }).notice;
    const textOfCall = (result: Call) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const page = (total: number) => ({
      meta: { total, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
      results: total > 0 ? [{ product_ndc: '0781-8045' }] : [],
    });
    const TIED = 'packaging.sample:"true" AND packaging.description:"BLISTER"';

    it('names the array, its fields, and the staged route on both surfaces', async () => {
      mockQuery.mockResolvedValue(page(4));

      const result = await runToolContract(lookupNdcTool, { search: TIED });

      const notice = noticeOf(result) ?? '';
      expect(notice).toMatch(
        /^openFDA matches each clause against the whole record, so the clauses on `packaging\.sample` and `packaging\.description` can be met by different `packaging` entries\. For one entry meeting them together, call again with stage: true /,
      );
      expect(notice).toContain('from_json(t.packaging, \'["json"]\')');
      expect(textOfCall(result)).toContain(`> ${notice}`);
    });

    it('tells a page read by cursor to restage without it, and keeps the plain wording on the first page, on both surfaces', async () => {
      mockQuery
        .mockResolvedValueOnce({ ...page(2), nextSearchAfter: '0=0781-8045' })
        .mockResolvedValueOnce({
          meta: { total: 2, skip: 1, limit: 25, lastUpdated: '2026-11-20' },
          results: [{ product_ndc: '0781-8046' }],
        });
      const first = await runToolContract(lookupNdcTool, { search: TIED, limit: 1 });
      const cursor = (first.structuredContent as { next_cursor?: string }).next_cursor;

      const next = await runToolContract(lookupNdcTool, { search: TIED, limit: 1, cursor });

      const lead =
        'openFDA matches each clause against the whole record, so the clauses on `packaging.sample` and `packaging.description` can be met by different `packaging` entries. For one entry meeting them together,';
      const where = `\`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.packaging, '["json"]')) AS p) WHERE p->>'sample' ILIKE '%true%' AND p->>'description' ILIKE '%BLISTER%')\`.`;
      const plain = `${lead} call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: ${where}`;
      // A call carrying both cursor and stage is refused, so the cursor page restages without it.
      const byCursor = `${lead} call again without cursor and with stage: true, and query the staged table, aliased t, in openfda_dataframe_query: ${where}`;
      expect(mockQuery.mock.calls[1]![1]).toMatchObject({
        searchAfter: { position: 1, value: '0=0781-8045' },
      });
      expect(noticeOf(first)).toBe(plain);
      expect(textOfCall(first)).toContain(`> ${plain}`);
      const end =
        'This page holds the last 1 of the 2 matched records, so the cursor walk is complete.';
      expect(noticeOf(next)).toBe(`${end} ${byCursor}`);
      expect(textOfCall(next)).toContain(`> ${end} ${byCursor}`);
    });

    it('joins with the clamp notice on one call', async () => {
      mockQuery.mockResolvedValue(page(4));

      const result = await runToolContract(lookupNdcTool, { search: TIED, limit: 5000 });

      const notice = noticeOf(result) ?? '';
      expect(notice).toMatch(
        /^limit=5000 is above the 1000-record cap for drug\/ndc, so 1000 was applied\. The next page starts at skip=1\. openFDA matches each clause/,
      );
    });

    it.each([
      ['a total of 0', TIED, 0],
      [
        'clauses under different arrays',
        'active_ingredients.name:"ASPIRIN" AND packaging.sample:"true"',
        4,
      ],
      ['OR-joined clauses', 'packaging.sample:"true" OR packaging.description:"BLISTER"', 4],
      [
        'an array clause beside a top-level field',
        'packaging.sample:"true" AND brand_name:"Armodafinil"',
        4,
      ],
    ] as const)('stays silent on %s', async (_case, search, total) => {
      mockQuery.mockResolvedValue(page(total));

      const result = await runToolContract(lookupNdcTool, { search });

      expect(noticeOf(result) ?? '').not.toContain('openFDA matches each clause');
    });

    it('stays silent on the NSDE dataset, whose rows hold no arrays', async () => {
      mockQuery.mockResolvedValue(page(4));

      const result = await runToolContract(lookupNdcTool, { search: TIED, dataset: 'nsde' });

      expect(noticeOf(result)).toBeUndefined();
    });
  });
});

/** Live other/nsde rows (2026-11-22): the warfarin package, an ended package, and a sparse row. */
const WARFARIN_NSDE: Record<string, unknown> = {
  proprietary_name: 'Warfarin Sodium',
  application_number_or_citation: 'ANDA040616',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  marketing_start_date: '20151019',
  package_ndc: '0093-1712-01',
  marketing_category: 'ANDA',
  billing_unit: 'EA',
  package_ndc11: '00093171201',
  dosage_form: 'TABLET',
};

const ENDED_NSDE: Record<string, unknown> = {
  proprietary_name: 'Pioglitazone Hydrochloride',
  marketing_end_date: '20250930',
  application_number_or_citation: 'ANDA200044',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  marketing_start_date: '20170123',
  package_ndc: '63629-3292-1',
  reactivation_date: '20211229',
  inactivation_date: '20200131',
  marketing_category: 'ANDA',
  package_ndc11: '63629329201',
  dosage_form: 'TABLET',
};

const SPARSE_NSDE: Record<string, unknown> = {
  proprietary_name: 'Aesculus Hippocastanum',
  product_type: 'HUMAN OTC DRUG',
  marketing_start_date: '19830303',
  package_ndc: '0220-0085-41',
  reactivation_date: '20230712',
  inactivation_date: '20230130',
  marketing_category: 'unapproved homeopathic',
  package_ndc11: '00220008541',
  dosage_form: 'PELLET',
};

/** The 0.10.0 empty-result notice of a drug/ndc search holding no NDC-shaped value. */
const NDC_MISS_0_10 =
  'No NDC records matched the query. Try broadening the search — use brand_name, generic_name, or active_ingredients.name fields. Key searchable fields for drug/ndc: product_ndc, brand_name, generic_name, labeler_name, dosage_form, route. Call openfda_describe_fields({ endpoint: "drug/ndc" }) for the full list.';

/** A live drug/ndc record (`brand_name:"eliquis"`, 2026-11-22), packaging and openfda trimmed. */
const ELIQUIS: Record<string, unknown> = {
  product_ndc: '50090-1436',
  generic_name: 'apixaban',
  labeler_name: 'A-S Medication Solutions',
  brand_name: 'ELIQUIS',
  active_ingredients: [{ name: 'APIXABAN', strength: '2.5 mg/1' }],
  finished: true,
  packaging: [
    {
      package_ndc: '50090-1436-0',
      description: '60 TABLET, FILM COATED in 1 BOTTLE, PLASTIC (50090-1436-0)',
      marketing_start_date: '20141128',
      sample: false,
    },
  ],
  listing_expiration_date: '20261231',
  openfda: { manufacturer_name: ['A-S Medication Solutions'], rxcui: ['1364435'] },
  marketing_category: 'NDA',
  dosage_form: 'TABLET, FILM COATED',
  spl_id: '76e8efee-ea1e-460e-8027-443facf02ee9',
  product_type: 'HUMAN PRESCRIPTION DRUG',
  route: ['ORAL'],
  marketing_start_date: '20121228',
  product_id: '50090-1436_76e8efee-ea1e-460e-8027-443facf02ee9',
  application_number: 'NDA202155',
  brand_name_base: 'ELIQUIS',
  pharm_class: ['Factor Xa Inhibitor [EPC]', 'Factor Xa Inhibitors [MoA]'],
};

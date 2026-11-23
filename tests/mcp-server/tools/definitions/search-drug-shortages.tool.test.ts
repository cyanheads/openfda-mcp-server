/**
 * @fileoverview Tests for openfda_search_drug_shortages tool.
 * @module tests/mcp-server/tools/definitions/search-drug-shortages.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

/*
 * Three drug/shortages records as openFDA returned them on 2026-11-22, trimmed:
 * dates are MM/DD/YYYY strings, therapeutic_category is an array, and a record
 * with no linked product carries no openfda block at all.
 */
const CURRENT_SHORTAGE = {
  update_type: 'Revised',
  initial_posting_date: '12/15/2021',
  package_ndc: '0009-3073-01',
  generic_name: 'Methylprednisolone Acetate Injection',
  contact_info: '844-646-4398',
  availability: 'Limited Availability',
  related_info: 'Limited Supply Available. Next Delivery: February 2027',
  update_date: '11/20/2026',
  therapeutic_category: ['Rheumatology'],
  dosage_form: 'Injection',
  presentation: 'Depo-medrol, Injection, 40 mg/1 mL (NDC 0009-3073-01)',
  company_name: 'Pfizer Inc.',
  shortage_reason: 'Demand increase for the drug',
  status: 'Current',
  openfda: {
    brand_name: ['DEPO-MEDROL'],
    product_ndc: ['0009-3073', '0009-3475'],
    rxcui: ['1743779', '1743781'],
  },
};
const DISCONTINUED_SHORTAGE = {
  discontinued_date: '02/24/2026',
  update_type: 'New',
  initial_posting_date: '02/24/2026',
  package_ndc: '50742-401-02',
  generic_name: 'Irinotecan Hydrochloride Injection',
  update_date: '02/24/2026',
  therapeutic_category: ['Oncology'],
  dosage_form: 'Injection',
  company_name: 'Ingenus Pharmaceuticals LLC',
  status: 'To Be Discontinued',
};
const RESOLVED_SHORTAGE = {
  update_type: 'Revised',
  initial_posting_date: '03/10/2023',
  change_date: '11/04/2026',
  package_ndc: '43547-408-10',
  generic_name: 'Clonazepam Tablet',
  resolved_note: 'Available',
  openfda: { brand_name: ['CLONAZEPAM'], product_ndc: ['43547-408'], rxcui: ['197527'] },
  update_date: '11/04/2026',
  therapeutic_category: ['Neurology', 'Pediatric', 'Psychiatry'],
  dosage_form: 'Tablet',
  company_name: 'Prinston Pharmaceutical, Inc.',
  status: 'Resolved',
};

/**
 * A paged `query` over `total` records, echoing the requested window into `meta`
 * the way the service does, so a staged call issues its probe, window, and drain.
 */
function pagedShortages(total: number) {
  return async (_endpoint: string, params: { limit?: number; skip?: number }) => {
    const skip = params.skip ?? 0;
    const limit = params.limit ?? 1000;
    const results: Record<string, unknown>[] = [];
    for (let i = skip; i < Math.min(skip + limit, total); i++) {
      results.push({ package_ndc: `0000-${i}-01`, generic_name: `Drug ${i}` });
    }
    return { meta: { total, skip, limit, lastUpdated: '2026-11-20' }, results };
  };
}

/** A DataCanvas stub whose `registerTable` drains the staged rows it is handed. */
function stubCanvas() {
  const instance = {
    canvasId: 'cv_shortage',
    isNew: true,
    registerTable: vi.fn(async (name: string, source: AsyncIterable<unknown>) => {
      let rowCount = 0;
      for await (const _row of source) rowCount++;
      return { tableName: name, rowCount, columns: [] };
    }),
    drop: vi.fn(),
  };
  return { acquire: vi.fn().mockResolvedValue(instance) };
}

describe('openfda_search_drug_shortages', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDrugShortagesTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDrugShortagesTool.errors });
  });

  it('queries drug/shortages endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Carboplatin Injection', status: 'Current' }],
    });

    const result = await searchDrugShortagesTool.handler(
      searchDrugShortagesTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('drug/shortages');
    expect(result.results[0]!.generic_name).toBe('Carboplatin Injection');
  });

  // #92 — the endpoint's default page size reaches the request and meta.limit.
  it('pages drug/shortages at its default of 25 when limit is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
      results: [],
    });

    const result = await searchDrugShortagesTool.handler(
      searchDrugShortagesTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    expect(result.meta.limit).toBe(25);
  });

  // #108 — a bare browse is newest first by update date, inline and staged.
  describe('default sort (#108)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    afterEach(() => {
      setCanvas(undefined);
    });

    it('sends update_date:desc with neither search nor sort', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({}), ctx);

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'update_date:desc' });
    });

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugShortagesTool.handler(
        searchDrugShortagesTool.input.parse({ search: 'status:"Current"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given, after direction normalization', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugShortagesTool.handler(
        searchDrugShortagesTool.input.parse({ sort: 'initial_posting_date:ASCENDING' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'initial_posting_date:asc' });
    });

    it('stages a bare browse with update_date:desc on the probe, the window, and the drain', async () => {
      mockQuery.mockImplementation(pagedShortages(250));
      setCanvas(stubCanvas() as never);

      const result = await searchDrugShortagesTool.handler(
        searchDrugShortagesTool.input.parse({ limit: 10, skip: 150, stage: true }),
        ctx,
      );

      expect(result.staged_rows).toBe(250);
      expect(mockQuery.mock.calls.map(([, params]) => params.skip)).toEqual([0, 150, 100]);
      for (const [, params] of mockQuery.mock.calls) {
        expect(params).toMatchObject({ sort: 'update_date:desc' });
      }
    });

    it('states the default in the search and sort descriptions', () => {
      const shape = searchDrugShortagesTool.input.shape;
      expect(shape.search.description).toContain('Omit to browse newest first.');
      expect(shape.sort.description).toContain(
        'With neither search nor sort, records come newest first by update_date:desc.',
      );
      expect(shape.search.description).not.toContain('Omit to browse all records.');
    });
  });

  /*
   * #102 — a calendar date on one of the four date fields reaches openFDA as
   * YYYY-MM-DD. Assertions name the date sent and the form that must be gone, not
   * the bytes around it, so they hold whether or not the shared search schema
   * quotes an unquoted hyphenated value first.
   */
  describe('date rewrite (#102)', () => {
    const MATCHED = {
      meta: { total: 385, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
      results: [DISCONTINUED_SHORTAGE],
    };
    const sentSearches = () =>
      mockQuery.mock.calls.map(([, params]) => (params as { search?: string }).search);

    afterEach(() => {
      setCanvas(undefined);
    });

    it('sends and echoes a YYYYMMDD range as YYYY-MM-DD on both surfaces', async () => {
      mockQuery.mockResolvedValue(MATCHED);

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'initial_posting_date:[20260101 TO 20261231]',
        limit: 1,
      });

      const rewritten = 'initial_posting_date:[2026-01-01 TO 2026-12-31]';
      expect(sentSearches()).toEqual([rewritten]);
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(
        rewritten,
      );
      const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      expect(text).toContain(`Query: \`${rewritten}\``);
      expect(text).not.toContain('20260101');
    });

    it.each([
      ['update_date:20261120', '2026-11-20', '20261120'],
      ['update_date:11/20/2026', '2026-11-20', '11/20/2026'],
      ['update_date:2026-1-5', '2026-01-05', '2026-1-5'],
    ])('sends %s with the date as YYYY-MM-DD', async (search, date, gone) => {
      mockQuery.mockResolvedValue(MATCHED);

      await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({ search }), ctx);

      const [sent] = sentSearches();
      expect(sent).toContain(`update_date:"${date}"`);
      expect(sent).not.toContain(gone);
      expect(getEnrichment(ctx).effectiveQuery).toBe(sent);
    });

    it('stages an open range with the rewritten search on the probe, the window, and the drain', async () => {
      mockQuery.mockImplementation(pagedShortages(250));
      setCanvas(stubCanvas() as never);

      const result = await searchDrugShortagesTool.handler(
        searchDrugShortagesTool.input.parse({
          search: 'initial_posting_date:[20260101 TO *]',
          limit: 10,
          skip: 150,
          stage: true,
        }),
        ctx,
      );

      expect(result.staged_rows).toBe(250);
      expect(mockQuery.mock.calls.map(([, params]) => params.skip)).toEqual([0, 150, 100]);
      expect(sentSearches()).toEqual(Array(3).fill('initial_posting_date:[2026-01-01 TO *]'));
      expect(getEnrichment(ctx).effectiveQuery).toBe('initial_posting_date:[2026-01-01 TO *]');
    });

    it('sends a search on other fields byte-identical, date-shaped values included', async () => {
      mockQuery.mockResolvedValue(MATCHED);
      const search = 'presentation:"20261120" AND generic_name:carboplatin AND status:"Current"';

      await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({ search }), ctx);

      expect(sentSearches()).toEqual([search]);
      expect(getEnrichment(ctx).effectiveQuery).toBe(search);
    });

    it('states the stored form, the written form, and the rewrite in the search description', () => {
      const description = searchDrugShortagesTool.input.shape.search.description;
      expect(description).toContain('update_date:[2026-01-01 TO 2026-12-31]');
      expect(description).toContain(
        'initial_posting_date, update_date, discontinued_date, and change_date are stored MM/DD/YYYY and written YYYY-MM-DD',
      );
      expect(description).toContain('YYYYMMDD, M/D/YYYY, or YYYY-M-D');
    });

    // A rewritten date is four characters longer; the rejection must count the caller's characters.
    it('names a refused character at its position in the search as written, past a date it would rewrite', async () => {
      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'update_date:20261120 AND generic_name:a;b',
      });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { message: string; data?: unknown } })
        .error;
      expect(error.data).toMatchObject({ reason: 'malformed_search' });
      expect(error.message).toContain('Search query holds ";" at position 40,');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  /*
   * The rewrite leaves a field:(…) group as written, so its dates match nothing
   * unless written YYYY-MM-DD; the no-match notice says so for a group on any of
   * the four date fields, and only there.
   */
  describe('a date-field group on a no-match page', () => {
    const EMPTY = {
      meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
      results: [],
    };
    const clause = (field: string) =>
      `Dates inside the ${field}:(...) group are sent as written, so write each one YYYY-MM-DD.`;
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;
    const textOfResult = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

    afterEach(() => {
      setCanvas(undefined);
    });

    it.each(['initial_posting_date', 'update_date', 'discontinued_date', 'change_date'])(
      'names the group on %s after the no-match line, on both surfaces',
      async (field) => {
        mockQuery.mockResolvedValue(EMPTY);
        const search = `${field}:(20261120 OR 20261119)`;

        const result = await runToolContract(searchDrugShortagesTool, { search });

        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search });
        const notice = noticeOf(result);
        expect(notice).toContain(
          `No drug shortage records matched search: \`${search}\`. ${clause(field)} Try broader filters or check field names.`,
        );
        expect(textOfResult(result)).toContain(`> ${notice}`);
      },
    );

    it('names the group on a staged no-match call', async () => {
      mockQuery.mockImplementation(pagedShortages(0));
      setCanvas(stubCanvas() as never);

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'update_date:(20261120 OR 20261119)',
        stage: true,
      });

      const notice = noticeOf(result);
      expect(notice).toContain(clause('update_date'));
      expect(textOfResult(result)).toContain(`> ${notice}`);
    });

    it.each([
      ['a term', 'update_date:20261120'],
      ['a range', 'update_date:[20260101 TO 20260131]'],
      ['a group on another field', 'generic_name:(carboplatin OR cisplatin)'],
    ])('says nothing of groups for %s', async (_name, search) => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchDrugShortagesTool, { search });

      expect(noticeOf(result)).toContain('No drug shortage records matched search:');
      expect(noticeOf(result)).not.toContain('group are sent as written');
    });

    it('says nothing of groups on a page that holds records', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 95, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [CURRENT_SHORTAGE],
      });

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'update_date:("2026-11-20" OR "2026-11-19")',
      });

      expect(String(noticeOf(result) ?? '')).not.toContain('group are sent as written');
      expect(textOfResult(result)).not.toContain('group are sent as written');
    });

    it('says nothing of groups on an empty page past the end of a matched set', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 95, skip: 100, limit: 25, lastUpdated: '2026-11-20' },
        results: [],
      });

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'update_date:(20261120 OR 20261119)',
        skip: 100,
      });

      expect(noticeOf(result)).toContain('No records at skip=100: 95 matched');
      expect(noticeOf(result)).not.toContain('group are sent as written');
    });
  });

  it('passes search, sort, limit, skip to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 5, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Test Drug', status: 'Current' }],
    });

    await searchDrugShortagesTool.handler(
      searchDrugShortagesTool.input.parse({
        search: 'status:"Current" AND therapeutic_category:"Oncology"',
        sort: 'update_date:desc',
        limit: 5,
        skip: 0,
      }),
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

    await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(127);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Drug B', status: 'Resolved' }],
    });

    await searchDrugShortagesTool.handler(
      searchDrugShortagesTool.input.parse({ search: 'generic_name:"amoxicillin"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('generic_name:"amoxicillin"');
  });

  it('does not set effectiveQuery when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Drug C', status: 'Current' }],
    });

    await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugShortagesTool.handler(
      searchDrugShortagesTool.input.parse({ search: 'generic_name:"nonexistent"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('drug/shortages');
  });

  it('notice includes field hint from catalog when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    // Field hint from catalog should mention searchable fields
    expect(enrichment.notice).toContain('generic_name');
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 30, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchDrugShortagesTool.handler(searchDrugShortagesTool.input.parse({ skip: 30 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=30/);
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
        results: [{ generic_name: 'Carboplatin Injection', status: 'Current' }],
      });

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'status:"Current"+AND+therapeutic_category:"Oncology"',
      });

      const spaced = 'status:"Current" AND therapeutic_category:"Oncology"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'dosage_form.exact:"INJECTION+POWDER"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"INJECTION POWDER"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });

    it('wraps the caller search in the empty-result notice as a code span on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'generic_name:*cillin*zzz*',
      });

      expect(noticeOf(result)).toContain(
        'No drug shortage records matched search: `generic_name:*cillin*zzz*`.',
      );
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('format renders shortage record with all key fields', () => {
    const content = searchDrugShortagesTool.format!({
      meta: { total: 1581, skip: 0, limit: 3, lastUpdated: '2026-11-20' },
      results: [CURRENT_SHORTAGE],
    });

    const text = textOf(content);
    expect(text).toContain('### Methylprednisolone Acetate Injection');
    expect(text).toContain('**Status:** Current');
    expect(text).toContain('**Availability:** Limited Availability');
    expect(text).toContain('**Therapeutic category:** Rheumatology');
    expect(text).toContain('**Dosage form:** Injection');
    expect(text).toContain('**Manufacturer:** Pfizer Inc.');
    expect(text).toContain(
      '**Timeline:** first posted 12/15/2021 | updated 11/20/2026 | (Revised)',
    );
    expect(text).toContain('brand: DEPO-MEDROL');
    expect(text).toContain('NDC: 0009-3073');
    expect(text).toContain('RxCUI: 1743779');
  });

  it('renders a multi-value therapeutic_category with ", " in content[], the array unchanged in structuredContent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 2, skip: 0, limit: 2, lastUpdated: '2026-11-20' },
      results: [RESOLVED_SHORTAGE, CURRENT_SHORTAGE],
    });

    const result = await runToolContract(searchDrugShortagesTool, { search: 'status:"Resolved"' });

    const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    expect(text).toContain('**Therapeutic category:** Neurology, Pediatric, Psychiatry\n');
    expect(text).toContain('**Therapeutic category:** Rheumatology\n');
    const records = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(records.map((r) => r.therapeutic_category)).toEqual([
      ['Neurology', 'Pediatric', 'Psychiatry'],
      ['Rheumatology'],
    ]);
  });

  it('format renders the discontinued and change dates as openFDA sends them, MM/DD/YYYY', () => {
    const content = searchDrugShortagesTool.format!({
      meta: { total: 2, skip: 0, limit: 2, lastUpdated: '2026-11-20' },
      results: [DISCONTINUED_SHORTAGE, RESOLVED_SHORTAGE],
    });

    const text = textOf(content);
    expect(text).toContain('### Irinotecan Hydrochloride Injection');
    expect(text).toContain('**Status:** To Be Discontinued');
    expect(text).toMatch(/Discontinued date:\*\* 02\/24\/2026/i);
    expect(text).toContain('**Timeline:** first posted 02/24/2026 | updated 02/24/2026 | (New)');
    expect(text).toContain('### Clonazepam Tablet');
    expect(text).toMatch(/Change date:\*\* 11\/04\/2026/i);
    expect(text).toContain('RxCUI: 197527');
  });

  it('format handles sparse payload — all optional fields absent', () => {
    const content = searchDrugShortagesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ generic_name: 'Minimal Drug', status: 'Resolved' }],
    });

    const text = textOf(content);
    expect(text).toContain('Minimal Drug');
    expect(text).toContain('Resolved');
    expect(typeof text).toBe('string');
  });

  it('format renders the metadata header, then "No drug shortage records found.", for empty results (#68)', () => {
    const content = searchDrugShortagesTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo drug shortage records found.',
    );
  });

  it('format includes meta header with totals', () => {
    const content = searchDrugShortagesTool.format!({
      meta: { total: 305, skip: 0, limit: 10, lastUpdated: '2026-05-31' },
      results: [{ generic_name: 'Drug X', status: 'Current' }],
    });

    const text = textOf(content);
    expect(text).toContain('305 total results');
    expect(text).toContain('2026-05-31');
  });

  it('format renders openfda block with NDC when brand_name absent', () => {
    const content = searchDrugShortagesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          generic_name: 'Drug Y',
          status: 'Current',
          openfda: { product_ndc: ['1234-5678'] },
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('NDC: 1234-5678');
  });

  it('renders full availability and contact_info — parity with structuredContent (no truncation)', () => {
    const availability = `Availability note. ${'Supply detail. '.repeat(40)}`;
    const contact = `Contact info. ${'Reach the manufacturer. '.repeat(15)}`;
    const content = searchDrugShortagesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ generic_name: 'Drug Z', status: 'Current', availability, contact_info: contact }],
    });

    const text = textOf(content);
    // Full values present — availability was capped at 400, contact_info at 200.
    expect(text).toContain(availability);
    expect(text).toContain(contact);
    expect(availability.length).toBeGreaterThan(400);
    expect(contact.length).toBeGreaterThan(200);
    expect(text).not.toContain('...');
  });

  /**
   * #97 — the tool's own cursor surface. The walk, the binding, and the refusals
   * run through every cursor tool in pagination-contract.test.ts; the token at
   * its seam in pagination-cursor.test.ts.
   */
  describe('cursor (#97)', () => {
    const resultText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

    it('returns a page read without a cursor byte-identical on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1581, skip: 0, limit: 1000, lastUpdated: '2026-11-20' },
        results: [
          {
            generic_name: 'Methylprednisolone Acetate Injection',
            status: 'Current',
            package_ndc: '0009-3073-01',
            therapeutic_category: ['Rheumatology'],
            update_date: '11/20/2026',
            openfda: { brand_name: ['DEPO-MEDROL'], rxcui: ['1743779'] },
          },
        ],
      });

      const result = await runToolContract(searchDrugShortagesTool, {
        search: 'status:"Current"',
        limit: 5000,
      });

      const notice =
        'limit=5000 is above the 1000-record cap for drug/shortages, so 1000 was applied. The next page starts at skip=1.';
      expect(JSON.stringify(result.structuredContent)).toBe(
        JSON.stringify({
          meta: { total: 1581, skip: 0, limit: 1000, lastUpdated: '2026-11-20' },
          results: [
            {
              generic_name: 'Methylprednisolone Acetate Injection',
              status: 'Current',
              package_ndc: '0009-3073-01',
              therapeutic_category: ['Rheumatology'],
              update_date: '11/20/2026',
              openfda: { brand_name: ['DEPO-MEDROL'], rxcui: ['1743779'] },
            },
          ],
          totalResults: 1581,
          effectiveQuery: 'status:"Current"',
          notice,
        }),
      );
      expect(resultText(result)).toBe(
        [
          '**1581 total results** (returned: 1, skip: 0, limit: 1000) | Data updated: 2026-11-20',
          '',
          '### Methylprednisolone Acetate Injection',
          '**Status:** Current',
          '**Therapeutic category:** Rheumatology',
          '**Timeline:** updated 11/20/2026',
          '**OpenFDA:** brand: DEPO-MEDROL | RxCUI: 1743779',
          '**Rxcui:** 1743779',
          '**Package ndc:** 0009-3073-01',
          '',
          '',
          '',
          '**totalResults:** 1581',
          'Query: `status:"Current"`',
          `> ${notice}`,
        ].join('\n'),
      );
    });

    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(searchDrugShortagesTool.input) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required ?? []).not.toContain('cursor');
      const output = z.toJSONSchema(searchDrugShortagesTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
      expect(searchDrugShortagesTool.errors).toContain(invalidCursorError);
      expect(searchDrugShortagesTool.errors).toContain(paginationLimitReachedError);
      expect(
        searchDrugShortagesTool.errors?.filter((e) => e.reason === 'pagination_limit_reached'),
      ).toHaveLength(1);
    });

    it('sends no searchAfter and returns no next_cursor key without a cursor or a link', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [CURRENT_SHORTAGE],
      });

      const result = await searchDrugShortagesTool.handler(
        searchDrugShortagesTool.input.parse({}),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
      expect(Object.keys(result)).toEqual(['meta', 'results']);
    });

    it('issues next_cursor on a linked page, the same token after the header in content[]', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1581, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
        results: [CURRENT_SHORTAGE],
        nextSearchAfter: '0=1795132800000;1=23y2-qEBx5cBmaoosLWm',
      });

      const result = await runToolContract(searchDrugShortagesTool, { limit: 1 });

      const { next_cursor } = result.structuredContent as { next_cursor?: string };
      expect(next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const lines = resultText(result).split('\n');
      expect(lines[0]).toMatch(/^\*\*1581 total results\*\*/);
      expect(lines[2]).toBe(`next_cursor: \`${next_cursor}\``);
      expect(resultText(result).indexOf('### Methylprednisolone')).toBeGreaterThan(
        resultText(result).indexOf('next_cursor'),
      );
    });

    it('binds the cursor to the rewritten date search, so the call written as before continues', async () => {
      const search = 'update_date:[20261101 TO 20261130]';
      const rewritten = 'update_date:[2026-11-01 TO 2026-11-30]';
      mockQuery.mockResolvedValueOnce({
        meta: { total: 3, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
        results: [CURRENT_SHORTAGE],
        nextSearchAfter: '0=1795132800000;1=a',
      });
      const first = await runToolContract(searchDrugShortagesTool, { search, limit: 1 });
      const { next_cursor } = first.structuredContent as { next_cursor?: string };
      mockQuery.mockResolvedValueOnce({
        meta: { total: 3, skip: 1, limit: 1, lastUpdated: '2026-11-20' },
        results: [RESOLVED_SHORTAGE],
        nextSearchAfter: '0=1794268800000;1=b',
      });

      const second = await runToolContract(searchDrugShortagesTool, {
        search,
        limit: 1,
        cursor: next_cursor,
      });

      expect(second.isError).toBeFalsy();
      expect(mockQuery.mock.calls.map(([, params]) => params.search)).toEqual([
        rewritten,
        rewritten,
      ]);
      expect(mockQuery.mock.calls[1]![1]).toMatchObject({
        skip: 0,
        searchAfter: { position: 1, value: '0=1795132800000;1=a' },
      });
      expect((second.structuredContent as { meta: { skip: number } }).meta.skip).toBe(1);
    });

    it('joins the end of a cursor walk to the fields projection notice when both fire', async () => {
      mockQuery.mockResolvedValueOnce({
        meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
        results: [CURRENT_SHORTAGE],
        nextSearchAfter: '0=1795132800000;1=a',
      });
      const first = await runToolContract(searchDrugShortagesTool, { limit: 1 });
      const { next_cursor } = first.structuredContent as { next_cursor?: string };
      mockQuery.mockResolvedValueOnce({
        meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-20' },
        results: [RESOLVED_SHORTAGE],
        nextSearchAfter: '0=1794268800000;1=b',
      });

      const last = await runToolContract(searchDrugShortagesTool, {
        limit: 1,
        cursor: next_cursor,
        fields: ['status', 'no_such_field'],
      });

      const structured = last.structuredContent as {
        next_cursor?: string;
        notice?: string;
        results: Record<string, unknown>[];
      };
      expect(structured.next_cursor).toBeUndefined();
      expect(structured.results).toEqual([{ package_ndc: '43547-408-10', status: 'Resolved' }]);
      const notice = String(structured.notice);
      const end =
        'This page holds the last 1 of the 2 matched records, so the cursor walk is complete.';
      expect(notice.startsWith(`${end} `)).toBe(true);
      expect(notice).toContain('no_such_field');
      expect(resultText(last)).toContain(`> ${notice}`);
      expect(resultText(last)).not.toContain('next_cursor:');
    });
  });
});

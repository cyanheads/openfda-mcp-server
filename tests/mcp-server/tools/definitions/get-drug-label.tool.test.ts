/**
 * @fileoverview Tests for openfda_get_drug_label — enrichment, the `sections`
 * selection path, and the outline-on-overflow disclosure path.
 * @module tests/mcp-server/tools/definitions/get-drug-label.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

/** The framework budget the outline and the selection disclosure both measure against. */
const BUDGET = 24_000;

/** A label record whose serialized size clears the 24,000-byte outline budget. */
function oversizedLabel(): Record<string, unknown> {
  return {
    openfda: { brand_name: ['Warfarin'], generic_name: ['warfarin sodium'] },
    set_id: 'set-1',
    id: 'id-1',
    effective_time: '20260101',
    version: '7',
    boxed_warning: ['B'.repeat(9_000)],
    warnings_and_cautions: ['W'.repeat(9_000)],
    clinical_studies_table: ['T'.repeat(9_000)],
  };
}

/**
 * A label whose sections straddle the budget: the two largest cannot be
 * retrieved within it, the rest can. The shape a worked re-call example has to
 * navigate — mirrors a live metformin page, where the largest section costs
 * ~195 KB summed across ten records against a 24 KB budget.
 */
function tieredLabel(): Record<string, unknown> {
  return {
    openfda: { brand_name: ['Metformin'], generic_name: ['metformin hydrochloride'] },
    set_id: 'set-2',
    id: 'id-2',
    effective_time: '20260201',
    version: '3',
    clinical_pharmacology_table: ['P'.repeat(30_000)],
    warnings_and_cautions: ['W'.repeat(20_000)],
    boxed_warning: ['B'.repeat(12_000)],
    indications_and_usage: ['I'.repeat(5_000)],
  };
}

/**
 * A label whose page overflows on the sum of its sections while every one of
 * them is retrievable on its own. `tieredLabel` cannot tell a deliberate skip
 * from a size rejection — its largest section overruns the budget either way —
 * so this is the fixture that isolates the rule that the page's most expensive
 * section is never the worked example.
 */
function evenlyTieredLabel(): Record<string, unknown> {
  return {
    openfda: { brand_name: ['Metformin'] },
    set_id: 'set-4',
    id: 'id-4',
    effective_time: '20260301',
    version: '4',
    clinical_studies: ['A'.repeat(5_000)],
    adverse_reactions: ['B'.repeat(4_800)],
    warnings_and_cautions: ['C'.repeat(4_600)],
    drug_interactions: ['D'.repeat(4_400)],
    dosage_and_administration: ['E'.repeat(4_200)],
    indications_and_usage: ['F'.repeat(4_000)],
    description: ['G'.repeat(3_800)],
  };
}

/** Serialized size of the returned records, measured the way the handler measures it. */
function recordBytes(results: unknown): number {
  return JSON.stringify({ results }).length;
}

describe('openfda_get_drug_label', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: getDrugLabelTool.errors });
  });

  it('queries drug/label endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ openfda: { brand_name: ['Aspirin'] } }],
    });

    const result = await getDrugLabelTool.handler({ search: 'openfda.brand_name:"aspirin"' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('drug/label');
    expect(result.kind).toBe('full');
    expect(result.results).toHaveLength(1);
  });

  it('populates enrichment.totalResults and effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ openfda: { brand_name: ['Aspirin'] } }],
    });

    await getDrugLabelTool.handler({ search: 'openfda.brand_name:"aspirin"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(1);
    expect(enrichment.effectiveQuery).toBe('openfda.brand_name:"aspirin"');
  });

  it('discloses truncation when more labels matched than the page returned', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 42, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: Array.from({ length: 5 }, () => ({ openfda: { brand_name: ['Aspirin'] } })),
    });

    await getDrugLabelTool.handler({ search: 'openfda.generic_name:"aspirin"', limit: 5 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(5);
    expect(enrichment.cap).toBe(5);
  });

  it('omits truncation when the full result set fit on the page', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 3, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: Array.from({ length: 3 }, () => ({ openfda: { brand_name: ['Aspirin'] } })),
    });

    await getDrugLabelTool.handler({ search: 'openfda.generic_name:"aspirin"', limit: 5 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' },
      results: [],
    });

    const result = await getDrugLabelTool.handler({ search: 'nonexistent' }, ctx);

    expect(result.kind).toBe('full');
    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/no labels/i);
  });

  it('raises the declared pagination contract above the openFDA ceiling (#27)', async () => {
    await expect(
      getDrugLabelTool.handler({ search: 'aspirin', skip: 25_001 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'pagination_limit_reached' } });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  describe('sections selection (#11)', () => {
    beforeEach(() => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [oversizedLabel()],
      });
    });

    it('returns only the requested sections plus metadata', async () => {
      const result = await getDrugLabelTool.handler(
        { search: 'openfda.brand_name:"warfarin"', sections: ['boxed_warning'] },
        ctx,
      );

      expect(result.kind).toBe('full');
      const record = result.results?.[0] ?? {};
      expect(Object.keys(record).sort()).toEqual(
        ['boxed_warning', 'effective_time', 'id', 'openfda', 'set_id', 'version'].sort(),
      );
      expect(record.warnings_and_cautions).toBeUndefined();
    });

    it('returns metadata only for an unknown section name', async () => {
      const result = await getDrugLabelTool.handler(
        { search: 'openfda.brand_name:"warfarin"', sections: ['not_a_real_section'] },
        ctx,
      );

      expect(Object.keys(result.results?.[0] ?? {}).sort()).toEqual([
        'effective_time',
        'id',
        'openfda',
        'set_id',
        'version',
      ]);
    });

    it('names the unmatched section and the available ones, so a typo is recoverable', async () => {
      await getDrugLabelTool.handler(
        { search: 'openfda.brand_name:"warfarin"', sections: ['boxed_warnings'] },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('boxed_warnings');
      expect(notice).toContain('Available on this page');
      expect(notice).toContain('warnings_and_cautions');
    });

    it('names only the unmatched section when others resolved', async () => {
      await getDrugLabelTool.handler(
        { search: 'openfda.brand_name:"warfarin"', sections: ['boxed_warning', 'no_such_section'] },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('no_such_section');
      expect(notice).not.toContain('Available on this page');
    });

    it('cuts the payload well below the unfiltered record', async () => {
      const selected = await getDrugLabelTool.handler(
        { search: 'openfda.brand_name:"warfarin"', sections: ['boxed_warning'] },
        ctx,
      );

      expect(JSON.stringify(selected.results).length).toBeLessThan(
        JSON.stringify([oversizedLabel()]).length / 2,
      );
    });
  });

  describe('outline on overflow (#11)', () => {
    beforeEach(() => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [oversizedLabel()],
      });
    });

    it('returns the section outline instead of the label when the page overflows', async () => {
      const result = await getDrugLabelTool.handler(
        { search: 'openfda.brand_name:"warfarin"' },
        ctx,
      );

      expect(result.kind).toBe('outline');
      expect(result.results).toBeUndefined();
      const names = (result.outline ?? []).map((s) => s.name);
      expect(names).toContain('boxed_warning');
      expect(names).toContain('clinical_studies_table');
      // Largest first.
      expect(result.outline?.[0]?.bytes).toBeGreaterThanOrEqual(
        result.outline?.[1]?.bytes ?? Number.POSITIVE_INFINITY,
      );
    });

    it('names the re-call path in enrichment so both response paths carry it', async () => {
      await getDrugLabelTool.handler({ search: 'openfda.brand_name:"warfarin"' }, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('sections');
      expect(notice).toContain('set_id');
    });

    it('returns the page whole when it fits the budget', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [{ openfda: { brand_name: ['Aspirin'] }, warnings: ['Short.'] }],
      });

      const result = await getDrugLabelTool.handler({ search: 'aspirin' }, ctx);

      expect(result.kind).toBe('full');
      expect(result.outline).toBeUndefined();
      expect(result.results?.[0]?.warnings).toEqual(['Short.']);
    });
  });

  describe('the outline offers a retrievable example, and selections state their cost (#41)', () => {
    /** The `sections:["name"]` example and the byte figure the notice quotes for it. */
    function workedExample(notice: string): { bytes: number; name: string } | undefined {
      const name = notice.match(/sections:\["([^"]+)"\]/)?.[1];
      const bytes = Number(notice.match(/returns (\d+) bytes/)?.[1]);
      return name && Number.isFinite(bytes) ? { bytes, name } : undefined;
    }

    beforeEach(() => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [tieredLabel()],
      });
    });

    it('names an example that is not the largest section on the page', async () => {
      const result = await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"' },
        ctx,
      );

      const example = workedExample(String(getEnrichment(ctx).notice));
      expect(example?.name).toBeDefined();
      expect(example?.name).not.toBe(result.outline?.[0]?.name);
      expect(result.outline?.[0]?.name).toBe('clinical_pharmacology_table');
    });

    it('skips the most expensive section even when that section would have fit', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [evenlyTieredLabel()],
      });

      const result = await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"' },
        ctx,
      );
      expect(result.kind).toBe('outline');
      const largest = result.outline?.[0]?.name;
      expect(largest).toBe('clinical_studies');

      const example = workedExample(String(getEnrichment(ctx).notice));
      expect(example?.name).toBe('adverse_reactions');

      /*
       * The skip has to be the rule rather than the measurement: retrieving the
       * largest section here is comfortably inside the budget, so nothing but
       * the rule keeps it out of the example.
       */
      const largestCtx = createMockContext({ errors: getDrugLabelTool.errors });
      const retrieved = await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', sections: [largest ?? ''] },
        largestCtx,
      );
      expect(recordBytes(retrieved.results)).toBeLessThan(BUDGET);
      expect(String(getEnrichment(largestCtx).notice ?? '')).not.toMatch(/inline size budget/);
    });

    it('quotes the example size, and following the example returns that many bytes within budget', async () => {
      await getDrugLabelTool.handler({ search: 'openfda.generic_name:"metformin"' }, ctx);
      const example = workedExample(String(getEnrichment(ctx).notice));
      expect(example).toBeDefined();

      const followed = await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', sections: [example?.name ?? ''] },
        createMockContext({ errors: getDrugLabelTool.errors }),
      );

      expect(recordBytes(followed.results)).toBe(example?.bytes);
      expect(example?.bytes).toBeLessThanOrEqual(BUDGET);
    });

    it('following the example draws no overflow disclosure', async () => {
      await getDrugLabelTool.handler({ search: 'openfda.generic_name:"metformin"' }, ctx);
      const example = workedExample(String(getEnrichment(ctx).notice));

      const followCtx = createMockContext({ errors: getDrugLabelTool.errors });
      await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', sections: [example?.name ?? ''] },
        followCtx,
      );

      expect(String(getEnrichment(followCtx).notice ?? '')).not.toMatch(/inline size budget/);
    });

    it('tells the caller to lower limit when metadata alone clears the budget', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 60, skip: 0, limit: 6, lastUpdated: '2026-01-01' },
        results: Array.from({ length: 6 }, (_, i) => ({
          openfda: { brand_name: [`Product ${i}`], substance_name: ['S'.repeat(5_000)] },
          set_id: `set-${i}`,
          boxed_warning: ['B'.repeat(400)],
          indications_and_usage: ['I'.repeat(400)],
        })),
      });

      const result = await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', limit: 6 },
        ctx,
      );

      expect(result.kind).toBe('outline');
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toMatch(/no single section fits/);
      expect(notice).toMatch(/lower limit/);
      expect(notice).not.toMatch(/sections:\["[^"]+"\] returns/);
    });

    it('discloses an over-budget selection, returning it whole as kind "full"', async () => {
      const result = await getDrugLabelTool.handler(
        {
          search: 'openfda.generic_name:"metformin"',
          sections: ['clinical_pharmacology_table', 'warnings_and_cautions'],
        },
        ctx,
      );

      expect(result.kind).toBe('full');
      const record = result.results?.[0] ?? {};
      // Returned whole — neither section is trimmed, stripped, or replaced.
      expect(record.clinical_pharmacology_table).toEqual(['P'.repeat(30_000)]);
      expect(record.warnings_and_cautions).toEqual(['W'.repeat(20_000)]);

      const bytes = recordBytes(result.results);
      expect(bytes).toBeGreaterThan(BUDGET);
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain(String(bytes));
      expect(notice).toMatch(/not truncated/);
    });

    it('stays quiet when the selection fits the budget', async () => {
      await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', sections: ['indications_and_usage'] },
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('discloses the same selection at a higher limit but not a lower one', async () => {
      const record = () => ({
        openfda: { brand_name: ['Metformin'] },
        set_id: 'set-3',
        clinical_studies: ['C'.repeat(6_000)],
        indications_and_usage: ['I'.repeat(200)],
      });
      const page = (n: number) => ({
        meta: { total: 20, skip: 0, limit: n, lastUpdated: '2026-01-01' },
        results: Array.from({ length: n }, record),
      });

      mockQuery.mockResolvedValue(page(1));
      const oneCtx = createMockContext({ errors: getDrugLabelTool.errors });
      await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', limit: 1, sections: ['clinical_studies'] },
        oneCtx,
      );

      mockQuery.mockResolvedValue(page(5));
      const fiveCtx = createMockContext({ errors: getDrugLabelTool.errors });
      const five = await getDrugLabelTool.handler(
        { search: 'openfda.generic_name:"metformin"', limit: 5, sections: ['clinical_studies'] },
        fiveCtx,
      );

      expect(String(getEnrichment(oneCtx).notice ?? '')).not.toMatch(/inline size budget/);
      expect(String(getEnrichment(fiveCtx).notice)).toMatch(/inline size budget/);
      expect(five.kind).toBe('full');
      expect(recordBytes(five.results)).toBeGreaterThan(BUDGET);
    });
  });

  describe('format()', () => {
    it('renders label sections', () => {
      const content = getDrugLabelTool.format({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        kind: 'full',
        results: [
          {
            openfda: {
              brand_name: ['Aspirin'],
              generic_name: ['aspirin'],
              manufacturer_name: ['Bayer'],
              route: ['ORAL'],
            },
            indications_and_usage: ['For pain relief.'],
            warnings: ['Do not exceed recommended dose.'],
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('Aspirin');
      expect(text).toContain('Bayer');
      expect(text).toContain('For pain relief.');
      expect(text).toContain('Do not exceed');
    });

    it('renders long sections whole — content[] matches structuredContent (#11, #24)', () => {
      const longText = 'A'.repeat(2000);
      const content = getDrugLabelTool.format({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
        kind: 'full',
        results: [{ openfda: { brand_name: ['Test'] }, warnings: [longText] }],
      });

      const text = content[0].text;
      expect(text).toContain(longText);
      expect(text).not.toContain('(truncated)');
    });

    it('renders the outline arm on field presence, not on kind', () => {
      const content = getDrugLabelTool.format({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
        kind: 'outline',
        outline: [{ name: 'boxed_warning', bytes: 9012 }],
      });

      const text = content[0].text;
      expect(text).toContain('boxed_warning');
      expect(text).toContain('9012');
    });

    it('renders both arms when both fields are present (parity sentinel shape)', () => {
      const content = getDrugLabelTool.format({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
        kind: 'full',
        results: [{ openfda: { brand_name: ['Both'] }, warnings: ['Careful.'] }],
        outline: [{ name: 'warnings', bytes: 11 }],
      });

      const text = content[0].text;
      expect(text).toContain('Careful.');
      expect(text).toContain('`warnings` — 11 bytes');
    });
  });
});

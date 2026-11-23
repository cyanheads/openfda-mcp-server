/**
 * @fileoverview Tests for openfda_get_drug_label — enrichment, the `sections`
 * selection path, and the outline-on-overflow disclosure path.
 * @module tests/mcp-server/tools/definitions/get-drug-label.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { z } from '@cyanheads/mcp-ts-core';
import { resetServerConfig } from '@/config/server-config.js';
import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { phrasePlusHint } from '@/mcp-server/tools/search-expression.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import type { OpenFdaQueryParams } from '@/services/openfda/types.js';
import {
  FOOTNOTE_INLINE,
  FOOTNOTE_REF,
  ROWSPAN_GRID,
  SUBSCRIPT_FORMULA,
  WARFARIN_DOSING,
} from '../../../fixtures/spl-tables.js';
import { codeLiteralsIn, renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

type WireResult = Awaited<ReturnType<typeof runToolContract>>;

const noticeOf = (result: WireResult) =>
  String((result.structuredContent as { notice?: string }).notice);

/** The one blockquote of the `content[]` trailer — the notice — as a CommonMark parser renders it. */
function noticeQuote(result: WireResult): string {
  const html = renderCommonMark(textOf(result.content, result.content.length - 1));
  const quotes = html.match(/<blockquote>[\s\S]*?<\/blockquote>/g) ?? [];
  expect(quotes).toHaveLength(1);
  return quotes[0] as string;
}

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

/** Serialized UTF-8 size of the returned records, measured the way the handler measures it. */
function recordBytes(results: unknown): number {
  return Buffer.byteLength(JSON.stringify({ results }), 'utf8');
}

describe('openfda_get_drug_label', () => {
  let ctx: ReturnType<typeof createMockContext<typeof getDrugLabelTool.errors>>;

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

    const result = await getDrugLabelTool.handler(
      getDrugLabelTool.input.parse({ search: 'openfda.brand_name:"aspirin"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('drug/label');
    expect(result.kind).toBe('full');
    expect(result.results).toHaveLength(1);
  });

  // #80 — openFDA serves one current record per SPL set, so set_id reaches no earlier revision.
  it('describes set_id as returning the current label, not a chosen revision', () => {
    const description = getDrugLabelTool.input.shape.search.description ?? '';
    expect(description).not.toMatch(/specific revision/i);
    expect(description).toContain('current revision only');
  });

  it('populates enrichment.totalResults and effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ openfda: { brand_name: ['Aspirin'] } }],
    });

    await getDrugLabelTool.handler(
      getDrugLabelTool.input.parse({ search: 'openfda.brand_name:"aspirin"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(1);
    expect(enrichment.effectiveQuery).toBe('openfda.brand_name:"aspirin"');
  });

  it('discloses truncation when more labels matched than the page returned', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 42, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: Array.from({ length: 5 }, () => ({ openfda: { brand_name: ['Aspirin'] } })),
    });

    await getDrugLabelTool.handler(
      getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"aspirin"', limit: 5 }),
      ctx,
    );

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

    await getDrugLabelTool.handler(
      getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"aspirin"', limit: 5 }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' },
      results: [],
    });

    const result = await getDrugLabelTool.handler(
      getDrugLabelTool.input.parse({ search: 'nonexistent' }),
      ctx,
    );

    expect(result.kind).toBe('full');
    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/no labels/i);
  });

  // #81 — caller text in a notice rides as a code literal on both surfaces.
  it('quotes the search in the empty-result notice', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' },
      results: [],
    });
    const search = 'openfda.brand_name:*cillin*zzz*';

    const result = await runToolContract(getDrugLabelTool, { search });
    expect(noticeOf(result)).toContain(`No labels matched search: \`${search}\`. Try broader`);
    const quote = noticeQuote(result);
    expect(codeLiteralsIn(quote)).toEqual([search]);
    expect(quote).not.toMatch(/<em>/);
  });

  // #75 — the shared search input.
  it('sends URL-form + separators as spaces', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
      results: [{ openfda: { brand_name: ['Aspirin'] } }],
    });
    await runToolContract(getDrugLabelTool, {
      search: 'openfda.brand_name:"aspirin"+AND+openfda.route:"ORAL"',
    });
    expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({
      search: 'openfda.brand_name:"aspirin" AND openfda.route:"ORAL"',
    });
  });

  describe('phrase + hint (#75)', () => {
    const search = 'openfda.generic_name:"SODIUM+CHLORIDE"';

    it('appends the hint to a no-match notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' },
        results: [],
      });
      const result = await runToolContract(getDrugLabelTool, { search });
      const hint = phrasePlusHint(search, 0) as string;
      expect(noticeOf(result).endsWith(` ${hint}`)).toBe(true);
      expect(codeLiteralsIn(noticeQuote(result))).toEqual([
        search,
        '"SODIUM+CHLORIDE"',
        '"SODIUM CHLORIDE"',
      ]);
    });

    it('leaves it off a page past the end of a matched set', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 5, limit: 5, lastUpdated: '' },
        results: [],
      });
      const result = await runToolContract(getDrugLabelTool, { search, skip: 5 });
      expect(noticeOf(result)).not.toContain('literal plus sign');
    });
  });

  it('raises the declared pagination contract above the openFDA ceiling (#27)', async () => {
    await expect(
      getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'aspirin', skip: 25_001 }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'pagination_limit_reached' } });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // #89 — most labels carry no openfda block, so an openfda.* miss proves little.
  it('names spl_product_data_elements as the fallback on an empty search, on both surfaces', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' },
      results: [],
    });
    const result = await runToolContract(getDrugLabelTool, {
      search: 'openfda.brand_name:"lisinopril"',
    });
    const fallback =
      'so when an openfda field finds nothing, search the label\'s own product text with spl_product_data_elements (e.g. spl_product_data_elements:"lisinopril").';
    expect(noticeOf(result)).toContain(fallback);
    expect(noticeQuote(result)).toContain('spl_product_data_elements:&quot;lisinopril&quot;');
  });

  /*
   * #92 — a limit above the 1000-label cap returns the cap's worth with a notice;
   * the clamp itself is tabled in schema-utils.test.ts. Each return path — the
   * outline, the whole page, and a sections selection — carries the disclosure
   * beside whatever else it says.
   */
  describe('limit above the cap', () => {
    const CLAMP = 'limit=5000 is above the 1000-record cap for drug/label, so 1000 was applied.';
    /** `n` small label records, with `total` matched and openFDA's own meta.limit echo. */
    const page = (n: number, total: number, limit = 1000) => ({
      meta: { total, skip: 0, limit, lastUpdated: '2026-11-10' },
      results: Array.from({ length: n }, (_, i) => ({
        openfda: { brand_name: [`Label ${i}`] },
        set_id: `set-${i}`,
        indications_and_usage: ['Use.'],
      })),
    });

    it('sends 1000 and joins the clamp to the outline and paging guidance', async () => {
      mockQuery.mockResolvedValue(page(1000, 3000));
      const result = await runToolContract(getDrugLabelTool, { search: 'aspirin', limit: 5000 });

      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ limit: 1000 });
      const structured = result.structuredContent as { kind: string; meta: { limit: number } };
      expect(structured.kind).toBe('outline');
      expect(structured.meta.limit).toBe(1000);
      const notice = noticeOf(result);
      expect(notice).toMatch(/^3000 labels matched; this page returned 1000\./);
      expect(notice).toContain(`${CLAMP} The next page starts at skip=1000.`);
      expect(notice).toMatch(/lists the sections available instead of the label text/);
      expect(noticeQuote(result)).toContain('The next page starts at skip=1000.');
      expect(result.structuredContent).toMatchObject({ truncated: true, shown: 1000, cap: 1000 });
    });

    it('carries the clamp alone on a whole page that ends the match', async () => {
      mockQuery.mockResolvedValue(page(3, 3));
      const result = await runToolContract(getDrugLabelTool, { search: 'aspirin', limit: 5000 });

      const structured = result.structuredContent as { kind: string; results: unknown[] };
      expect(structured.kind).toBe('full');
      expect(structured.results).toHaveLength(3);
      expect(noticeOf(result)).toBe(
        `${CLAMP.slice(0, -1)}; this page holds the last 3 of the 3 matched records.`,
      );
    });

    it('joins the clamp to a sections selection', async () => {
      mockQuery.mockResolvedValue(page(3, 3));
      const result = await runToolContract(getDrugLabelTool, {
        search: 'aspirin',
        limit: 5000,
        sections: ['indications_and_usage', 'boxed_warning'],
      });

      const notice = noticeOf(result);
      expect(notice).toMatch(/^limit=5000 is above the 1000-record cap/);
      expect(notice).toContain('Not present on this page: `boxed_warning`.');
    });

    it('joins the clamp to the no-match notice', async () => {
      mockQuery.mockResolvedValue(page(0, 0));
      const result = await runToolContract(getDrugLabelTool, { search: 'zzz', limit: 5000 });

      const notice = noticeOf(result);
      expect(notice).toMatch(/^No labels matched search: `zzz`\./);
      expect(notice.endsWith(` ${CLAMP}`)).toBe(true);
    });

    it('sends a limit within the cap as given and reports it as meta.limit', async () => {
      mockQuery.mockResolvedValue(page(3, 3, 0));
      const result = await runToolContract(getDrugLabelTool, { search: 'aspirin', limit: 3 });

      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ limit: 3 });
      expect((result.structuredContent as { meta: { limit: number } }).meta.limit).toBe(3);
      expect(noticeOf(result)).not.toContain('cap');
    });

    it('sends the default of 5 when limit is omitted', async () => {
      mockQuery.mockResolvedValue(page(3, 3, 0));
      const result = await runToolContract(getDrugLabelTool, { search: 'aspirin' });

      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ limit: 5 });
      expect((result.structuredContent as { meta: { limit: number } }).meta.limit).toBe(5);
    });

    describe('with OPENFDA_CLAMP_LIMITS=false', () => {
      beforeEach(() => {
        vi.stubEnv('OPENFDA_CLAMP_LIMITS', 'false');
        resetServerConfig();
      });

      afterEach(() => {
        vi.unstubAllEnvs();
        resetServerConfig();
      });

      it('rejects limit 1001 at the schema maximum before any request', async () => {
        const result = await runToolContract(getDrugLabelTool, { search: 'aspirin', limit: 1001 });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
        expect(mockQuery).not.toHaveBeenCalled();
      });

      it('advertises maximum 1000 on limit', () => {
        const limit = z.toJSONSchema(getDrugLabelTool.input).properties?.limit;
        expect(limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 });
      });
    });

    it('advertises no maximum on limit while clamping', () => {
      const limit = z.toJSONSchema(getDrugLabelTool.input).properties?.limit;
      expect(limit).toMatchObject({ type: 'integer', minimum: 1, default: 5 });
      expect(limit).not.toHaveProperty('maximum');
    });
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
        getDrugLabelTool.input.parse({
          search: 'openfda.brand_name:"warfarin"',
          sections: ['boxed_warning'],
        }),
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
        getDrugLabelTool.input.parse({
          search: 'openfda.brand_name:"warfarin"',
          sections: ['not_a_real_section'],
        }),
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
        getDrugLabelTool.input.parse({
          search: 'openfda.brand_name:"warfarin"',
          sections: ['boxed_warnings'],
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('boxed_warnings');
      expect(notice).toContain('Available on this page');
      expect(notice).toContain('warnings_and_cautions');
    });

    it('names only the unmatched section when others resolved', async () => {
      await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.brand_name:"warfarin"',
          sections: ['boxed_warning', 'no_such_section'],
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('no_such_section');
      expect(notice).not.toContain('Available on this page');
    });

    // #81 — the caller's section names ride in the notice as code literals.
    it('quotes each unmatched section name on both surfaces', async () => {
      const result = await runToolContract(getDrugLabelTool, {
        search: 'openfda.brand_name:"warfarin"',
        sections: ['_boxed_warning_', '*x*'],
      });
      expect(noticeOf(result)).toContain(
        'Not present on this page: `_boxed_warning_`, `*x*`. No requested section is present',
      );
      const quote = noticeQuote(result);
      expect(codeLiteralsIn(quote)).toEqual(['_boxed_warning_', '*x*']);
      expect(quote).not.toMatch(/<(?:em|strong)>/);
    });

    it('fences a section name holding a line break inside the notice quote', async () => {
      const name = 'no_such\nsection';
      const result = await runToolContract(getDrugLabelTool, {
        search: 'openfda.brand_name:"warfarin"',
        sections: ['boxed_warning', name],
      });
      expect(noticeOf(result)).toContain(`Not present on this page: \n\`\`\`\n${name}\n\`\`\`\n.`);
      const quote = noticeQuote(result);
      expect(codeLiteralsIn(quote)).toEqual([name]);
      expect(quote).toMatch(/^<blockquote>[\s\S]*<\/pre>[\s\S]*<\/blockquote>$/);
    });

    it('projects each record onto the requested sections it carries when presence varies', async () => {
      const { boxed_warning: _omitted, ...withoutBoxedWarning } = oversizedLabel();
      mockQuery.mockResolvedValue({
        meta: { total: 2, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [oversizedLabel(), { ...withoutBoxedWarning, set_id: 'set-2', id: 'id-2' }],
      });

      const result = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"warfarin"',
          sections: ['boxed_warning'],
        }),
        ctx,
      );

      expect(result.kind).toBe('full');
      expect(result.results?.[0]?.boxed_warning).toEqual(['B'.repeat(9_000)]);
      expect(Object.keys(result.results?.[1] ?? {}).sort()).toEqual(
        ['effective_time', 'id', 'openfda', 'set_id', 'version'].sort(),
      );
      expect(String(getEnrichment(ctx).notice ?? '')).not.toContain('Not present on this page');
    });

    it('cuts the payload well below the unfiltered record', async () => {
      const selected = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.brand_name:"warfarin"',
          sections: ['boxed_warning'],
        }),
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
        getDrugLabelTool.input.parse({ search: 'openfda.brand_name:"warfarin"' }),
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
      await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'openfda.brand_name:"warfarin"' }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('sections');
      expect(notice).toContain('set_id');
    });

    it('returns the page whole when it fits the budget', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [{ openfda: { brand_name: ['Aspirin'] }, warnings: ['Short.'] }],
      });

      const result = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'aspirin' }),
        ctx,
      );

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
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"metformin"' }),
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
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"metformin"' }),
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
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          sections: [largest ?? ''],
        }),
        largestCtx,
      );
      expect(recordBytes(retrieved.results)).toBeLessThan(BUDGET);
      expect(String(getEnrichment(largestCtx).notice ?? '')).not.toMatch(/inline size budget/);
    });

    it('quotes the example size, and following the example returns that many bytes within budget', async () => {
      await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"metformin"' }),
        ctx,
      );
      const example = workedExample(String(getEnrichment(ctx).notice));
      expect(example).toBeDefined();

      const followed = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          sections: [example?.name ?? ''],
        }),
        createMockContext({ errors: getDrugLabelTool.errors }),
      );

      expect(recordBytes(followed.results)).toBe(example?.bytes);
      expect(example?.bytes).toBeLessThanOrEqual(BUDGET);
    });

    it('following the example draws no overflow disclosure', async () => {
      await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"metformin"' }),
        ctx,
      );
      const example = workedExample(String(getEnrichment(ctx).notice));

      const followCtx = createMockContext({ errors: getDrugLabelTool.errors });
      await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          sections: [example?.name ?? ''],
        }),
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
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"metformin"', limit: 6 }),
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
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          sections: ['clinical_pharmacology_table', 'warnings_and_cautions'],
        }),
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
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          sections: ['indications_and_usage'],
        }),
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
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          limit: 1,
          sections: ['clinical_studies'],
        }),
        oneCtx,
      );

      mockQuery.mockResolvedValue(page(5));
      const fiveCtx = createMockContext({ errors: getDrugLabelTool.errors });
      const five = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"metformin"',
          limit: 5,
          sections: ['clinical_studies'],
        }),
        fiveCtx,
      );

      expect(String(getEnrichment(oneCtx).notice ?? '')).not.toMatch(/inline size budget/);
      expect(String(getEnrichment(fiveCtx).notice)).toMatch(/inline size budget/);
      expect(five.kind).toBe('full');
      expect(recordBytes(five.results)).toBeGreaterThan(BUDGET);
    });
  });

  /**
   * Label text is often non-ASCII (`é`, `µg`, `≥`), where a JavaScript string's
   * length undercounts the bytes it occupies on the wire — `é` is one UTF-16 unit
   * and two UTF-8 bytes.
   */
  describe('sizes are UTF-8 bytes of the serialized JSON', () => {
    const accented = (n: number) => 'é'.repeat(n);
    const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

    it('sizes each outline section in UTF-8 bytes, on both surfaces', async () => {
      const record = {
        openfda: { brand_name: ['Warfarin'] },
        set_id: 'set-u',
        clinical_studies: ['C'.repeat(30_000)],
        warnings_and_cautions: [accented(5_000)],
      };
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
        results: [record],
      });

      const result = await runToolContract(getDrugLabelTool, {
        search: 'openfda.generic_name:"warfarin"',
        limit: 1,
      });

      const bytes = utf8(record.warnings_and_cautions);
      expect(bytes).toBe(10_004);
      const outline = (result.structuredContent as { outline: { bytes: number; name: string }[] })
        .outline;
      expect(outline.find((s) => s.name === 'warnings_and_cautions')?.bytes).toBe(bytes);
      expect(textOf(result.content as never)).toContain(
        `- \`warnings_and_cautions\` — ${bytes} bytes`,
      );
    });

    it('discloses a selection whose UTF-8 size clears the budget though its string length does not', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
        results: [
          {
            openfda: { brand_name: ['Warfarin'] },
            set_id: 'set-u',
            warnings_and_cautions: [accented(15_000)],
          },
        ],
      });

      const result = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"warfarin"',
          limit: 1,
          sections: ['warnings_and_cautions'],
        }),
        ctx,
      );

      const bytes = recordBytes(result.results);
      expect(JSON.stringify({ results: result.results }).length).toBeLessThan(BUDGET);
      expect(bytes).toBeGreaterThan(BUDGET);
      expect(String(getEnrichment(ctx).notice)).toContain(`Selection is ${bytes} bytes`);
    });

    it('never offers a worked example that only fits the budget by string length', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
        results: [
          {
            openfda: { brand_name: ['Warfarin'] },
            set_id: 'set-u',
            clinical_studies: ['C'.repeat(40_000)],
            warnings_and_cautions: [accented(14_000)],
            indications_and_usage: ['I'.repeat(5_000)],
          },
        ],
      });

      await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"warfarin"', limit: 1 }),
        ctx,
      );
      const notice = String(getEnrichment(ctx).notice);
      const name = notice.match(/sections:\["([^"]+)"\]/)?.[1];
      const quoted = Number(notice.match(/returns (\d+) bytes/)?.[1]);
      expect(name).toBe('indications_and_usage');

      const followed = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({
          search: 'openfda.generic_name:"warfarin"',
          limit: 1,
          sections: [name ?? ''],
        }),
        createMockContext({ errors: getDrugLabelTool.errors }),
      );
      expect(recordBytes(followed.results)).toBe(quoted);
      expect(quoted).toBeLessThanOrEqual(BUDGET);
    });

    it('keeps an ASCII page at the same figures string length gave', async () => {
      const record = {
        openfda: { brand_name: ['Warfarin'] },
        set_id: 'set-a',
        clinical_studies: ['C'.repeat(30_000)],
        warnings_and_cautions: ['W'.repeat(5_000)],
      };
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
        results: [record],
      });

      const result = await getDrugLabelTool.handler(
        getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"warfarin"', limit: 1 }),
        ctx,
      );

      expect(result.outline?.find((s) => s.name === 'warnings_and_cautions')?.bytes).toBe(
        JSON.stringify(record.warnings_and_cautions).length,
      );
    });
  });

  describe('format()', () => {
    it('renders label sections', () => {
      const content = getDrugLabelTool.format!({
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

      const text = textOf(content);
      expect(text).toContain('Aspirin');
      expect(text).toContain('Bayer');
      expect(text).toContain('For pain relief.');
      expect(text).toContain('Do not exceed');
    });

    it('renders long sections whole — content[] matches structuredContent (#11, #24)', () => {
      const longText = 'A'.repeat(2000);
      const content = getDrugLabelTool.format!({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
        kind: 'full',
        results: [{ openfda: { brand_name: ['Test'] }, warnings: [longText] }],
      });

      const text = textOf(content);
      expect(text).toContain(longText);
      expect(text).not.toContain('(truncated)');
    });

    it('renders the outline arm on field presence, not on kind', () => {
      const content = getDrugLabelTool.format!({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
        kind: 'outline',
        outline: [{ name: 'boxed_warning', bytes: 9012 }],
      });

      const text = textOf(content);
      expect(text).toContain('boxed_warning');
      expect(text).toContain('9012');
    });

    it('passes prose sections through verbatim, literal angle brackets included (#45)', () => {
      const inactive =
        'Inactive Ingredients <paragraph>Aminomethyl Propanol, Carbomer, [Aqua], Thyme Leaf oil. <E050800>';
      const dosage = 'Take *1 tablet* daily; adjust by INR &#x2265; 2.';
      const text = textOf(
        getDrugLabelTool.format!({
          meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
          kind: 'full',
          results: [
            {
              openfda: { brand_name: ['Prose'] },
              inactive_ingredient: [inactive],
              dosage_and_administration: [dosage, 'Second paragraph.'],
            },
          ],
        }),
      );
      expect(text).toContain(`**Inactive ingredient:**\n${inactive}`);
      expect(text).toContain(`**Dosage and administration:**\n${dosage}\nSecond paragraph.`);
    });

    describe('*_table sections (#45)', () => {
      const label = (sections: Record<string, unknown>) => ({
        openfda: { brand_name: ['Warfarin Sodium'], generic_name: ['warfarin sodium'] },
        set_id: 'set-w',
        id: 'id-w',
        effective_time: '20260101',
        version: '4',
        ...sections,
      });

      it('keeps the raw SPL string in structuredContent and renders a Markdown table in content[]', async () => {
        mockQuery.mockResolvedValue({
          meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
          results: [
            label({
              dosage_and_administration_table: [WARFARIN_DOSING],
              boxed_warning: ['Bleeding risk.'],
            }),
          ],
        });

        const result = await getDrugLabelTool.handler(
          getDrugLabelTool.input.parse({
            search: 'openfda.generic_name:"warfarin"',
            limit: 1,
            sections: ['dosage_and_administration_table'],
          }),
          ctx,
        );

        // structuredContent: the provider string, byte for byte.
        expect(result.results?.[0]?.dosage_and_administration_table).toEqual([WARFARIN_DOSING]);

        const text = textOf(getDrugLabelTool.format!(result));
        expect(text).toContain(
          '**Dosage and administration table:**\n\nTable 1: Three Ranges of Expected Maintenance Warfarin Sodium Tablets Daily Doses Based on CYP2C9 and VKORC1 Genotypes†\n\n| VKORC1 | CYP2C9 |  |  |  |  |  |\n| --- | --- | --- | --- | --- | --- | --- |\n|  | \\*1/\\*1 |',
        );
        expect(text).not.toMatch(/<table|<td|styleCode|&#x2020;/);
      });

      it('measures the outline on the raw strings, unchanged by rendering', async () => {
        const record = label({
          dosage_and_administration_table: [WARFARIN_DOSING],
          clinical_studies: ['C'.repeat(30_000)],
        });
        mockQuery.mockResolvedValue({
          meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
          results: [record],
        });

        const result = await getDrugLabelTool.handler(
          getDrugLabelTool.input.parse({ search: 'openfda.generic_name:"warfarin"', limit: 1 }),
          ctx,
        );

        expect(result.kind).toBe('outline');
        const entry = result.outline?.find((s) => s.name === 'dosage_and_administration_table');
        expect(entry?.bytes).toBe(Buffer.byteLength(JSON.stringify([WARFARIN_DOSING]), 'utf8'));
      });

      it('renders every string of a multi-table section, blank-line separated', () => {
        const text = textOf(
          getDrugLabelTool.format!({
            meta: { total: 1, skip: 0, limit: 1, lastUpdated: '' },
            kind: 'full',
            results: [label({ drug_interactions_table: [FOOTNOTE_INLINE, ROWSPAN_GRID] })],
          }),
        );
        const section = text.slice(text.indexOf('**Drug interactions table:**'));
        expect(section).toContain('[^1]: Body system not specified\n\n|  |  | Atorvastatin (mg) |');
      });

      it('renders a lone string value and leaves a non-string value to the generic rendering', () => {
        const text = textOf(
          getDrugLabelTool.format!({
            meta: { total: 1, skip: 0, limit: 1, lastUpdated: '' },
            kind: 'full',
            results: [
              label({
                description_table: SUBSCRIPT_FORMULA,
                odd_table: { rows: 2 },
                mixed_table: ['<table><tr><td>a</td></tr></table>', 7],
              }),
            ],
          }),
        );
        expect(text).toContain('**Description table:**\n\n| C\\_22H\\_29FO\\_5 | MW 392.47 |');
        expect(text).toContain('**Odd table:**\n{"rows":2}');
        expect(text).toContain('**Mixed table:**\n<table><tr><td>a</td></tr></table>\n7');
      });

      it('falls back to decoded text for a table string that does not parse', () => {
        const text = textOf(
          getDrugLabelTool.format!({
            meta: { total: 1, skip: 0, limit: 1, lastUpdated: '' },
            kind: 'full',
            results: [label({ warnings_table: ['<table><tr><td>Bleeding &#x2265; major'] })],
          }),
        );
        expect(text).toContain('**Warnings table:**\n\nBleeding ≥ major');
      });

      it('omits a table section whose strings render to nothing', () => {
        const text = textOf(
          getDrugLabelTool.format!({
            meta: { total: 1, skip: 0, limit: 1, lastUpdated: '' },
            kind: 'full',
            results: [label({ empty_table: ['<table></table>'], boxed_warning: ['Kept.'] })],
          }),
        );
        expect(text).not.toContain('Empty table');
        expect(text).toContain('Kept.');
      });

      it('numbers footnotes in one sequence across tables, sections, and records (#61)', () => {
        const text = textOf(
          getDrugLabelTool.format!({
            meta: { total: 2, skip: 0, limit: 2, lastUpdated: '' },
            kind: 'full',
            results: [
              label({
                adverse_reactions_table: [FOOTNOTE_INLINE, FOOTNOTE_REF],
                clinical_studies_table: [FOOTNOTE_INLINE],
              }),
              label({ set_id: 'set-2', adverse_reactions_table: [FOOTNOTE_REF] }),
            ],
          }),
        );

        const labels = [...text.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => Number(m[1]));
        expect(labels).toEqual([1, 2, 3, 4]);
        // Each marker still points at its own table's definition.
        expect(text).toContain('| Infection[^1] | 9.4 | 10.3 |');
        expect(text).toContain('[^1]: Body system not specified');
        expect(text).toContain('| Until expiration date | 56 days[^2] |');
        expect(text).toContain('[^2]: To prevent degradation');
        expect(text).toContain('| Infection[^3] | 9.4 | 10.3 |');
        expect(text).toContain('[^3]: Body system not specified');
        expect(text).toContain('| Until expiration date | 56 days[^4] |');
        expect(text).toContain('[^4]: To prevent degradation');
      });

      it('restarts the footnote sequence on each format() call', () => {
        const render = () =>
          textOf(
            getDrugLabelTool.format!({
              meta: { total: 1, skip: 0, limit: 1, lastUpdated: '' },
              kind: 'full',
              results: [label({ adverse_reactions_table: [FOOTNOTE_INLINE] })],
            }),
          );
        expect(render()).toContain('| Infection[^1] |');
        expect(render()).toContain('| Infection[^1] |');
      });
    });

    it('renders both arms when both fields are present (parity sentinel shape)', () => {
      const content = getDrugLabelTool.format!({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
        kind: 'full',
        results: [{ openfda: { brand_name: ['Both'] }, warnings: ['Careful.'] }],
        outline: [{ name: 'warnings', bytes: 11 }],
      });

      const text = textOf(content);
      expect(text).toContain('Careful.');
      expect(text).toContain('`warnings` — 11 bytes');
    });
  });

  /*
   * #107 — an outline page names the records it sums over, so a brand search's
   * repackager copies can be told from the original packager's label.
   */
  describe('page_labels on an outline page (#107)', () => {
    /** A label over the outline budget on its own; `openfda` undefined drops the key. */
    function packagedLabel(
      setId: string,
      openfda: Record<string, unknown> | undefined,
    ): Record<string, unknown> {
      return {
        ...(openfda !== undefined && { openfda }),
        set_id: setId,
        id: `id-${setId}`,
        effective_time: '20260817',
        version: '39',
        boxed_warning: ['B'.repeat(9_000)],
        warnings_and_cautions: ['W'.repeat(9_000)],
        clinical_studies: ['C'.repeat(9_000)],
      };
    }
    const squibb = () =>
      packagedLabel('e9481622-7cc6-418a-acb6-c5450daae9b0', {
        brand_name: ['ELIQUIS', 'ELIQUIS SPRINKLE'],
        generic_name: ['APIXABAN'],
        manufacturer_name: ['E.R. Squibb & Sons, L.L.C.'],
        application_number: ['NDA202155'],
        is_original_packager: [true],
      });
    const aphena = () =>
      packagedLabel('set-aphena', {
        brand_name: ['ELIQUIS'],
        generic_name: ['APIXABAN'],
        manufacturer_name: ['Aphena Pharma Solutions - Tennessee, LLC'],
        application_number: ['NDA202155'],
      });
    /** A linked label missing a name: the name is null, the flag still false. */
    const genericOnly = () =>
      packagedLabel('set-generic', { generic_name: ['APIXABAN'], product_type: ['HUMAN'] });
    const emptyBlock = () => packagedLabel('set-empty', {});
    const noBlock = () => packagedLabel('set-none', undefined);
    const ownBytes = (record: unknown) => Buffer.byteLength(JSON.stringify(record), 'utf8');

    interface OutlineStructured {
      kind: string;
      notice?: string;
      outline: { name: string }[];
      page_labels: Record<string, unknown>[];
    }

    async function outlinePage(records: Record<string, unknown>[], search: string, total = 9) {
      mockQuery.mockResolvedValue({
        meta: { total, skip: 0, limit: records.length, lastUpdated: '2026-11-20' },
        results: records,
      });
      const result = await runToolContract(getDrugLabelTool, { search, limit: records.length });
      expect(result.isError).toBeFalsy();
      return { result, structured: result.structuredContent as unknown as OutlineStructured };
    }

    it('names every record on a page where each carries an openfda block, on both surfaces', async () => {
      const records = [aphena(), squibb()];
      const { result, structured } = await outlinePage(records, 'openfda.brand_name:"eliquis"');

      expect(structured.kind).toBe('outline');
      expect(structured.page_labels).toEqual([
        {
          set_id: 'set-aphena',
          effective_time: '20260817',
          brand_name: 'ELIQUIS',
          generic_name: 'APIXABAN',
          manufacturer_name: 'Aphena Pharma Solutions - Tennessee, LLC',
          is_original_packager: false,
          bytes: ownBytes(records[0]),
        },
        {
          set_id: 'e9481622-7cc6-418a-acb6-c5450daae9b0',
          effective_time: '20260817',
          brand_name: 'ELIQUIS',
          generic_name: 'APIXABAN',
          manufacturer_name: 'E.R. Squibb & Sons, L.L.C.',
          is_original_packager: true,
          bytes: ownBytes(records[1]),
        },
      ]);
      // Each label clears the budget alone, so its own size is what says a set_id re-call outlines too.
      for (const label of structured.page_labels) expect(label.bytes).toBeGreaterThan(BUDGET);

      const text = textOf(result.content);
      expect(text).toContain(
        `| set-aphena | 20260817 | ELIQUIS | APIXABAN | Aphena Pharma Solutions - Tennessee, LLC | false | ${ownBytes(records[0])} |`,
      );
      expect(text).toContain(
        `| e9481622-7cc6-418a-acb6-c5450daae9b0 | 20260817 | ELIQUIS | APIXABAN | E.R. Squibb & Sons, L.L.C. | true | ${ownBytes(records[1])} |`,
      );
      // The table parses with one cell per field, every value included.
      const html = renderCommonMark(text);
      const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
        [...(m[1] ?? '').matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map((c) => c[1]),
      );
      expect(rows[0]).toEqual([
        'set_id',
        'effective_time',
        'brand_name',
        'generic_name',
        'manufacturer_name',
        'is_original_packager',
        'bytes',
      ]);
      expect(rows[2]).toEqual([
        'e9481622-7cc6-418a-acb6-c5450daae9b0',
        '20260817',
        'ELIQUIS',
        'APIXABAN',
        'E.R. Squibb &amp; Sons, L.L.C.',
        'true',
        String(ownBytes(records[1])),
      ]);
    });

    it('keeps set_id, effective_time, and bytes on a page where no record has openfda data, the rest null', async () => {
      const records = [emptyBlock(), noBlock()];
      const { result, structured } = await outlinePage(
        records,
        'spl_product_data_elements:"apixaban"',
      );

      expect(structured.page_labels).toEqual(
        records.map((record) => ({
          set_id: record.set_id,
          effective_time: '20260817',
          brand_name: null,
          generic_name: null,
          manufacturer_name: null,
          is_original_packager: null,
          bytes: ownBytes(record),
        })),
      );
      const text = textOf(result.content);
      for (const record of records) {
        expect(text).toContain(
          `| ${record.set_id} | 20260817 | null | null | null | null | ${ownBytes(record)} |`,
        );
      }
    });

    it('tells true, false, and unknown apart on a mixed page, on both surfaces', async () => {
      const records = [squibb(), aphena(), genericOnly(), emptyBlock()];
      const { result, structured } = await outlinePage(records, 'openfda.generic_name:"apixaban"');

      expect(structured.page_labels.map((l) => [l.set_id, l.is_original_packager])).toEqual([
        ['e9481622-7cc6-418a-acb6-c5450daae9b0', true],
        ['set-aphena', false],
        ['set-generic', false],
        ['set-empty', null],
      ]);
      expect(structured.page_labels[2]).toMatchObject({
        brand_name: null,
        generic_name: 'APIXABAN',
        manufacturer_name: null,
      });
      const flags = [...textOf(result.content).matchAll(/^\| (\S+) \|.*\| (\w+) \| \d+ \|$/gm)].map(
        (m) => [m[1], m[2]],
      );
      expect(flags).toEqual([
        ['e9481622-7cc6-418a-acb6-c5450daae9b0', 'true'],
        ['set-aphena', 'false'],
        ['set-generic', 'false'],
        ['set-empty', 'null'],
      ]);
    });

    it('lists one record for a set_id re-call that still outlines', async () => {
      const { structured } = await outlinePage(
        [squibb()],
        'set_id:"e9481622-7cc6-418a-acb6-c5450daae9b0"',
        1,
      );

      expect(structured.kind).toBe('outline');
      expect(structured.page_labels).toHaveLength(1);
      expect(structured.page_labels[0]).toMatchObject({ is_original_packager: true });
    });

    it('adds page_labels to the outline arm only', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-11-20' },
        results: [squibb()],
      });

      const selection = await runToolContract(getDrugLabelTool, {
        search: 'openfda.brand_name:"eliquis"',
        sections: ['boxed_warning'],
      });

      expect(selection.isError).toBeFalsy();
      expect(selection.structuredContent).toMatchObject({ kind: 'full' });
      expect(selection.structuredContent).not.toHaveProperty('page_labels');
    });

    it('escapes a cell that would split the row, keeping every value', () => {
      const content = getDrugLabelTool.format!({
        meta: { total: 1, skip: 0, limit: 1, lastUpdated: '' },
        kind: 'outline',
        outline: [{ name: 'boxed_warning', bytes: 9004 }],
        page_labels: [
          {
            set_id: 'set-pipe',
            effective_time: '20260101',
            brand_name: 'A | B',
            generic_name: null,
            manufacturer_name: 'Acme *Labs*',
            is_original_packager: false,
            bytes: 27_000,
          },
        ],
      });

      const html = renderCommonMark(textOf(content));
      const cells = [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      expect(cells).toEqual([
        'set-pipe',
        '20260101',
        'A | B',
        'null',
        'Acme *Labs*',
        'false',
        '27000',
      ]);
    });

    describe("the routes to the original packager's label", () => {
      const routes =
        "For the original packager's label, add AND openfda.is_original_packager:true to the search (it keeps only the labels openFDA flags, so several or none can remain), or take identity.spl_set_id from openfda_drug_profile.";

      it('names both when more labels matched than the page returned, on both surfaces', async () => {
        const { result, structured } = await outlinePage(
          [aphena(), aphena()],
          'openfda.brand_name:"eliquis"',
        );

        expect(structured.notice).toContain(
          `9 labels matched; this page returned 2. Page with skip (e.g. skip=2) or narrow the search. ${routes}`,
        );
        expect(noticeQuote(result)).toContain('openfda.is_original_packager:true');
        expect(noticeQuote(result)).toContain('identity.spl_set_id from openfda_drug_profile');
      });

      it('drops the filter when the search already names is_original_packager', async () => {
        const { structured } = await outlinePage(
          [squibb(), squibb()],
          'openfda.brand_name:"medrol" AND openfda.is_original_packager:true',
        );

        expect(structured.notice).toContain(
          "or narrow the search. For the original packager's label, take identity.spl_set_id from openfda_drug_profile.",
        );
        expect(structured.notice).not.toContain('add AND');
      });

      it('rides the whole-record page that leaves labels unreturned too', async () => {
        mockQuery.mockResolvedValue({
          meta: { total: 9, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
          results: [{ openfda: { brand_name: ['ELIQUIS'] }, set_id: 'set-small' }],
        });

        const result = await runToolContract(getDrugLabelTool, {
          search: 'openfda.brand_name:"eliquis"',
          limit: 1,
        });

        expect(result.structuredContent).toMatchObject({ kind: 'full' });
        expect(noticeOf(result)).toBe(
          `9 labels matched; this page returned 1. Page with skip (e.g. skip=1) or narrow the search. ${routes}`,
        );
      });

      it('are named in the search description', () => {
        const description = getDrugLabelTool.input.shape.search.description ?? '';
        expect(description).toContain('add AND openfda.is_original_packager:true');
        expect(description).toContain('identity.spl_set_id from openfda_drug_profile');
      });
    });
  });

  describe('the more-pages lead at the skip ceiling (#97)', () => {
    it('never suggests a skip past the ceiling on a page read at skip 25000', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 46_581, skip: 25_000, limit: 1, lastUpdated: '2026-11-20' },
        results: [{ openfda: { brand_name: ['Oral'] }, set_id: 'set-oral' }],
      });

      const result = await runToolContract(getDrugLabelTool, {
        search: 'openfda.route:"ORAL"',
        limit: 1,
        skip: 25_000,
      });

      const notice = noticeOf(result);
      expect(notice).not.toContain('e.g. skip=25001');
      expect(notice).toContain(
        "46581 labels matched; this page returned 1. The next page would start at skip=25001, past openFDA's 25000-record pagination ceiling — to read past it, re-run the call from skip 0 and follow next_cursor, or narrow the search.",
      );
    });
  });

  /*
   * #97 — the search_after cursor. The token itself is tabled in
   * pagination-cursor.test.ts; these prove this handler's wiring on each arm
   * (whole page, sections selection, outline) and the guidance only this tool
   * gives. They stand in for a pagination-contract CURSOR_TOOLS row, whose
   * limit-and-fields case sends `fields`, an input this tool does not take.
   */
  describe('cursor (#97)', () => {
    const search = 'openfda.brand_name:"aspirin"';

    interface CursorStructured {
      kind: string;
      meta: { skip: number; total: number };
      next_cursor?: string;
      notice?: string;
      outline?: unknown[];
      page_labels?: { set_id: string | null }[];
      results?: { id?: string }[];
    }

    /**
     * Answer `mockQuery` the way openFDA answers through the service: a request
     * by `search_after` value resumes after the record that value names (never at
     * `position`, which returns only as `meta.skip`), and every non-empty page
     * links the next, the exactly full last page included. `served` caps each
     * page below the `limit` sent, as a short page would; `record` shapes each id.
     */
    function answerLikeOpenFda(
      total: number,
      {
        served = [],
        record = (id: string): Record<string, unknown> => ({ id }),
      }: { served?: readonly number[]; record?: (id: string) => Record<string, unknown> } = {},
    ) {
      const ids = Array.from({ length: total }, (_, i) => `doc-${String(i).padStart(5, '0')}`);
      let call = 0;
      mockQuery.mockImplementation((_endpoint: string, params: OpenFdaQueryParams) => {
        const from = params.searchAfter
          ? ids.indexOf(params.searchAfter.value.replace(/^0=/, '')) + 1
          : (params.skip ?? 0);
        const size = Math.min(params.limit ?? 5, served[call] ?? Number.POSITIVE_INFINITY);
        call += 1;
        const slice = ids.slice(from, from + size);
        return Promise.resolve({
          meta: {
            skip: params.searchAfter?.position ?? params.skip ?? 0,
            total,
            limit: params.limit ?? 5,
            lastUpdated: '2026-11-21',
          },
          results: slice.map(record),
          ...(slice.length > 0 && { nextSearchAfter: `0=${slice.at(-1)}` }),
        });
      });
      return ids;
    }

    const structuredOf = (result: WireResult) =>
      result.structuredContent as unknown as CursorStructured;

    /** Read the first page and return its next_cursor; fails when none is issued. */
    async function firstCursor(extra: Record<string, unknown> = {}) {
      const result = await runToolContract(getDrugLabelTool, { search, limit: 5, ...extra });
      const { next_cursor } = structuredOf(result);
      expect(next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      return next_cursor as string;
    }

    const big = (id: string) => ({ ...oversizedLabel(), set_id: id, id });

    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(getDrugLabelTool.input) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required ?? []).not.toContain('cursor');
      const output = z.toJSONSchema(getDrugLabelTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
      expect(getDrugLabelTool.errors).toContain(invalidCursorError);
      expect(getDrugLabelTool.errors).toContain(paginationLimitReachedError);
    });

    it('sends no searchAfter and returns no next_cursor key without a cursor or a link', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
        results: [{ openfda: { brand_name: ['Aspirin'] } }],
      });

      const result = await getDrugLabelTool.handler(getDrugLabelTool.input.parse({ search }), ctx);

      expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(['kind', 'meta', 'results']);
    });

    it('issues next_cursor on a skip 0 page, the same token on both surfaces', async () => {
      answerLikeOpenFda(12);

      const result = await runToolContract(getDrugLabelTool, { search, limit: 5 });

      const { next_cursor, notice } = structuredOf(result);
      expect(next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const lines = textOf(result.content).split('\n');
      expect(lines[0]).toMatch(/^\*\*12 total results\*\*/);
      expect(lines[2]).toBe(`next_cursor: \`${next_cursor}\``);
      expect(notice).toContain(
        '12 labels matched; this page returned 5. Page with next_cursor or skip (e.g. skip=5), or narrow the search.',
      );
    });

    it('follows next_cursor with the query it was issued for, and no skip', async () => {
      answerLikeOpenFda(12);
      const cursor = await firstCursor({ sort: 'effective_time:desc' });

      await runToolContract(getDrugLabelTool, {
        search,
        sort: 'effective_time:desc',
        limit: 5,
        cursor,
      });

      const [first, second] = mockQuery.mock.calls;
      expect(second?.[0]).toBe('drug/label');
      expect(second?.[1]).toMatchObject({
        search,
        sort: 'effective_time:desc',
        searchAfter: { value: '0=doc-00004', position: 5 },
      });
      expect(first?.[1].searchAfter).toBeUndefined();
      expect(second?.[1].skip ?? 0).toBe(0);
    });

    it('walks the match once, in order, across a clamp and short pages', async () => {
      // 12 records: limit 3, then a clamped limit the fake serves only 4 of, then 2, then 5.
      const ids = answerLikeOpenFda(12, { served: [3, 4, 2, 5] });
      const seen: string[] = [];
      const skips: number[] = [];
      const notices: (string | undefined)[] = [];
      let last: WireResult | undefined;
      let cursor: string | undefined;

      for (const limit of [3, 1_000_000, 2, 5]) {
        last = await runToolContract(getDrugLabelTool, {
          search,
          limit,
          ...(cursor && { cursor }),
        });
        const structured = structuredOf(last);
        skips.push(structured.meta.skip);
        notices.push(structured.notice);
        seen.push(...(structured.results ?? []).map((r) => String(r.id)));
        cursor = structured.next_cursor;
        if (!cursor) break;
      }

      expect(skips).toEqual([0, 3, 7, 9]);
      expect(seen).toEqual(ids);
      // The clamp notice counts from the walk position and the 4 records served, not the cap.
      expect(notices[1]).toContain(
        'limit=1000000 is above the 1000-record cap for drug/label, so 1000 was applied. The next page starts at skip=7.',
      );
      expect(notices[2]).toContain(
        'this page returned 2. Page with next_cursor or skip (e.g. skip=9)',
      );
      expect(cursor).toBeUndefined();
      expect(notices[3]).toBe(
        'This page holds the last 3 of the 12 matched records, so the cursor walk is complete.',
      );
      expect(noticeQuote(last!)).toContain('so the cursor walk is complete.');
      expect(textOf(last!.content)).not.toContain('next_cursor:');
    });

    it('walks past skip 25000 and never names a skip past the ceiling', async () => {
      const ids = answerLikeOpenFda(26_500);
      const seen: string[] = [];
      const suggested: number[] = [];
      let atCeiling: string | undefined;
      let cursor: string | undefined;

      for (let page = 0; page < 30; page++) {
        const result = await runToolContract(getDrugLabelTool, {
          search,
          limit: 1000,
          ...(cursor && { cursor }),
        });
        const structured = structuredOf(result);
        seen.push(...(structured.results ?? []).map((r) => String(r.id)));
        for (const m of String(structured.notice).matchAll(/skip \(e\.g\. skip=(\d+)\)/g)) {
          suggested.push(Number(m[1]));
        }
        if (structured.meta.skip === 25_000) atCeiling = structured.notice;
        cursor = structured.next_cursor;
        if (!cursor) break;
      }

      expect(seen).toEqual(ids);
      expect(Math.max(...suggested)).toBe(25_000);
      expect(atCeiling).toContain(
        '26500 labels matched; this page returned 1000. Page with next_cursor, or narrow the search.',
      );
    });

    it('says the walk has ended on an empty cursor page past the end, never a no-match', async () => {
      answerLikeOpenFda(12);
      const cursor = await firstCursor();
      mockQuery.mockResolvedValueOnce({
        meta: { skip: 5, total: 4, limit: 5, lastUpdated: '2026-11-21' },
        results: [],
      });

      const result = await runToolContract(getDrugLabelTool, { search, limit: 5, cursor });

      expect(structuredOf(result).notice).toContain(
        'No records at this cursor: its walk position (5) is past the last of the 4 matched records',
      );
      const text = textOf(result.content);
      expect(text).not.toMatch(/^No labels found\.$/m);
      expect(text).toContain('4 matched, but skip=5 is past the end');
    });

    it('accepts its own continuation for a search the schema rewrites, in either form', async () => {
      const sent = 'openfda.brand_name:"aspirin"+AND+openfda.route:"ORAL"';
      const spaced = 'openfda.brand_name:"aspirin" AND openfda.route:"ORAL"';
      answerLikeOpenFda(12);
      const cursor = await firstCursor({ search: sent });

      for (const each of [sent, spaced]) {
        const result = await runToolContract(getDrugLabelTool, {
          search: each,
          limit: 5,
          cursor,
        });
        expect(result.isError).toBeFalsy();
      }
      expect(mockQuery.mock.calls.map((call) => call[1].search)).toEqual([spaced, spaced, spaced]);
    });

    it('accepts a different limit and sections on the next page', async () => {
      answerLikeOpenFda(12, { record: (id) => ({ id, set_id: id, boxed_warning: ['B.'] }) });
      const cursor = await firstCursor();

      const result = await runToolContract(getDrugLabelTool, {
        search,
        limit: 2,
        sections: ['boxed_warning'],
        cursor,
      });

      expect(result.isError).toBeFalsy();
      const structured = structuredOf(result);
      expect(structured.results?.map((r) => r.id)).toEqual(['doc-00005', 'doc-00006']);
      expect(structured.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it.each([
      ['skip above 0', { skip: 5 }, 'skip=5'],
      [
        'another search',
        { search: 'openfda.brand_name:"other"' },
        'different endpoint, search, or sort',
      ],
      ['another sort', { sort: 'effective_time:asc' }, 'different endpoint, search, or sort'],
      ['a token it did not issue', { cursor: 'bm90IGEgdG9rZW4' }, 'does not decode'],
    ] as [string, Record<string, unknown>, string][])(
      'refuses a cursor with %s before any request',
      async (_case, change, fault) => {
        answerLikeOpenFda(12);
        const cursor = await firstCursor();

        const result = await runToolContract(getDrugLabelTool, {
          search,
          limit: 5,
          cursor,
          ...change,
        });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as unknown as {
          error: { message: string; data?: { reason?: string; recovery?: { hint?: string } } };
        };
        expect(error.data?.reason).toBe('invalid_cursor');
        expect(error.data?.recovery?.hint).toBe(invalidCursorError.recovery);
        expect(error.message).toContain(fault);
        expect(mockQuery).toHaveBeenCalledTimes(1);
      },
    );

    it('refuses an empty cursor at argument validation', async () => {
      const result = await runToolContract(getDrugLabelTool, { search, cursor: '' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    describe('an outline page read by cursor', () => {
      it('says to re-call with the same cursor, joined to the paging lead, and lists its labels', async () => {
        answerLikeOpenFda(12, { record: big });
        const cursor = await firstCursor({ limit: 2 });

        const result = await runToolContract(getDrugLabelTool, { search, limit: 2, cursor });

        const structured = structuredOf(result);
        expect(structured.kind).toBe('outline');
        expect(structured.meta.skip).toBe(2);
        expect(structured.page_labels?.map((l) => l.set_id)).toEqual(['doc-00002', 'doc-00003']);
        expect(structured.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(structured.notice).toMatch(
          /^12 labels matched; this page returned 2\. Page with next_cursor or skip \(e\.g\. skip=4\), or narrow the search\. For the original packager's label, .+ This page of 2 label record\(s\) exceeds the 24000-byte inline size budget/,
        );
        expect(structured.notice).toContain(
          'Re-call with the same search, limit, and cursor plus sections:[...] to retrieve specific ones',
        );
        const lines = textOf(result.content).split('\n');
        expect(lines[2]).toBe(`next_cursor: \`${structured.next_cursor}\``);
        expect(noticeQuote(result)).toContain(
          'Re-call with the same search, limit, and cursor plus',
        );
      });

      it('joins the end of the walk to the outline guidance on the last page', async () => {
        answerLikeOpenFda(3, { record: big });
        const cursor = await firstCursor({ limit: 2 });

        const result = await runToolContract(getDrugLabelTool, { search, limit: 2, cursor });

        const structured = structuredOf(result);
        expect(structured.kind).toBe('outline');
        expect(structured.next_cursor).toBeUndefined();
        expect(structured.notice).toMatch(
          /^This page holds the last 1 of the 3 matched records, so the cursor walk is complete\. This page of 1 label record\(s\) exceeds the 24000-byte inline size budget/,
        );
        expect(structured.notice).toContain('Re-call with the same search, limit, and cursor plus');
      });

      it('keeps the plain re-call wording on an outline page read without one', async () => {
        answerLikeOpenFda(12, { record: big });

        const result = await runToolContract(getDrugLabelTool, { search });

        expect(structuredOf(result).notice).toContain(
          'Re-call with the same search plus sections:[...] to retrieve specific ones',
        );
      });
    });

    /*
     * A limit other than the default, a skip above 0, a sort, and a cursor each
     * change which labels a call reads, so the outline's re-call names each one
     * the call set. The re-call below is built from the names the sentence lists,
     * and nothing else, so a recipe that drops one reads other labels.
     */
    describe('the outline re-call names each paging input the call set', () => {
      type LabelInputs = { search: string } & Record<string, unknown>;

      /** The inputs the outline's re-call sentence names, from `inputs`, plus a sections selection. */
      function recallFrom(notice: string | undefined, inputs: LabelInputs): LabelInputs {
        const kept = notice?.match(/Re-call with the same (.+?) plus sections:\[\.\.\.\]/)?.[1];
        expect(kept).toBeDefined();
        const names = String(kept).split(/, and |, | and /);
        expect(names[0]).toBe('search');
        for (const name of names) expect(Object.hasOwn(inputs, name)).toBe(true);
        return {
          search: inputs.search,
          ...Object.fromEntries(names.map((name) => [name, inputs[name]])),
          sections: ['boxed_warning'],
        };
      }

      /** Read the outline page for `inputs`, then follow its re-call sentence. */
      async function outlineThenFollow(inputs: LabelInputs) {
        const page = await runToolContract(getDrugLabelTool, inputs);
        const outline = structuredOf(page);
        expect(outline.kind).toBe('outline');
        const followed = structuredOf(
          await runToolContract(getDrugLabelTool, recallFrom(outline.notice, inputs)),
        );
        return {
          notice: outline.notice,
          quote: noticeQuote(page),
          named: outline.page_labels?.map((label) => label.set_id),
          followed: followed.results?.map((record) => record.id),
        };
      }

      it.each([
        ['limit', { limit: 3 }, 'search and limit', ['doc-00000', 'doc-00001', 'doc-00002']],
        [
          'skip',
          { skip: 3 },
          'search and skip',
          ['doc-00003', 'doc-00004', 'doc-00005', 'doc-00006', 'doc-00007'],
        ],
        [
          'limit and skip',
          { limit: 3, skip: 4 },
          'search, limit, and skip',
          ['doc-00004', 'doc-00005', 'doc-00006'],
        ],
        [
          'a limit equal to the default, which it leaves unnamed',
          { limit: 5 },
          'search',
          ['doc-00000', 'doc-00001', 'doc-00002', 'doc-00003', 'doc-00004'],
        ],
      ] as [string, Record<string, unknown>, string, string[]][])(
        'names %s, and the re-call reads the same labels',
        async (_case, paging, kept, labels) => {
          answerLikeOpenFda(12, { record: big });

          const { notice, quote, named, followed } = await outlineThenFollow({
            search,
            ...paging,
          });

          expect(named).toEqual(labels);
          expect(followed).toEqual(labels);
          const sentence = `Re-call with the same ${kept} plus sections:[...] to retrieve specific ones`;
          expect(notice).toContain(sentence);
          expect(quote).toContain(`Re-call with the same ${kept} plus`);
        },
      );

      it('names the limit beside the cursor on a page read by cursor, and the re-call reads the same labels', async () => {
        answerLikeOpenFda(12, { record: big });
        const cursor = await firstCursor({ limit: 3 });

        const { notice, quote, named, followed } = await outlineThenFollow({
          search,
          limit: 3,
          cursor,
        });

        const labels = ['doc-00003', 'doc-00004', 'doc-00005'];
        expect(named).toEqual(labels);
        expect(followed).toEqual(labels);
        expect(notice).toContain(
          'Re-call with the same search, limit, and cursor plus sections:[...] to retrieve specific ones',
        );
        expect(quote).toContain('Re-call with the same search, limit, and cursor plus');
      });

      it('names the sort, and the re-call reads the same labels in the same order', async () => {
        const ids = Array.from({ length: 12 }, (_, i) => `doc-${String(i).padStart(5, '0')}`);
        // Answers newest first under a :desc sort, index order otherwise, as openFDA does.
        mockQuery.mockImplementation((_endpoint: string, params: OpenFdaQueryParams) => {
          const order = params.sort?.endsWith(':desc') ? [...ids].reverse() : ids;
          const skip = params.skip ?? 0;
          const limit = params.limit ?? 5;
          return Promise.resolve({
            meta: { skip, total: ids.length, limit, lastUpdated: '2026-11-21' },
            results: order.slice(skip, skip + limit).map(big),
          });
        });

        const { notice, quote, named, followed } = await outlineThenFollow({
          search,
          sort: 'effective_time:desc',
          limit: 3,
          skip: 2,
        });

        const labels = ['doc-00009', 'doc-00008', 'doc-00007'];
        expect(named).toEqual(labels);
        expect(followed).toEqual(labels);
        expect(notice).toContain(
          'Re-call with the same search, sort, limit, and skip plus sections:[...] to retrieve specific ones',
        );
        expect(quote).toContain('Re-call with the same search, sort, limit, and skip plus');
      });
    });
  });

  /*
   * #107 and #97 add to the outline arm and to paged notices only. A page that
   * ends the match, read without a cursor, keeps the bytes it had before them.
   */
  describe('a page that ends the match, read without a cursor', () => {
    const search = 'openfda.brand_name:"aspirin"';
    const record = {
      openfda: { brand_name: ['Aspirin'], generic_name: ['aspirin'], manufacturer_name: ['Bayer'] },
      set_id: 'set-a',
      id: 'id-a',
      effective_time: '20260101',
      version: '2',
      warnings: ['Short.'],
    };

    it('returns a whole-record page byte-identical on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-11-20' },
        results: [record],
      });

      const result = await runToolContract(getDrugLabelTool, { search });

      expect(JSON.stringify(result.structuredContent)).toBe(
        '{"meta":{"total":1,"skip":0,"limit":5,"lastUpdated":"2026-11-20"},"kind":"full","results":[{"openfda":{"brand_name":["Aspirin"],"generic_name":["aspirin"],"manufacturer_name":["Bayer"]},"set_id":"set-a","id":"id-a","effective_time":"20260101","version":"2","warnings":["Short."]}],"totalResults":1,"effectiveQuery":"openfda.brand_name:\\"aspirin\\""}',
      );
      expect(result.content).toEqual([
        {
          type: 'text',
          text: '**1 total results** (returned: 1, skip: 0, limit: 5, kind: full) | Data updated: 2026-11-20\n\n### Aspirin (aspirin)\n**Manufacturer:** Bayer\n**Effective date:** 20260101\n**Set ID:** set-a (v2)\n**Brand name:** Aspirin\n**Generic name:** aspirin\n**Manufacturer name:** Bayer\n\n**Id:**\nid-a\n\n**Version:**\n2\n\n**Warnings:**\nShort.\n\n---\n',
        },
        {
          type: 'text',
          text: '\n\n**totalResults:** 1\n**effectiveQuery:** `openfda.brand_name:"aspirin"`',
        },
      ]);
    });

    it('keeps the outline and its re-call notice byte-identical', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-11-20' },
        results: [oversizedLabel()],
      });

      const result = await runToolContract(getDrugLabelTool, { search });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.kind).toBe('outline');
      expect(structured.results).toBeUndefined();
      expect(JSON.stringify(structured.outline)).toBe(
        '[{"name":"boxed_warning","bytes":9004},{"name":"warnings_and_cautions","bytes":9004},{"name":"clinical_studies_table","bytes":9004},{"name":"openfda","bytes":62},{"name":"effective_time","bytes":10},{"name":"set_id","bytes":7},{"name":"id","bytes":6},{"name":"version","bytes":3}]',
      );
      expect(structured.notice).toBe(
        'This page of 1 label record(s) exceeds the 24000-byte inline size budget, so the response lists the sections available instead of the label text. Re-call with the same search plus sections:[...] to retrieve specific ones — e.g. sections:["warnings_and_cautions"] returns 9188 bytes across the 1 record(s) on this page. Each listed size is summed across the page, so a section\'s cost scales with limit; a selection over the budget is still returned whole and reports its size. Metadata (openfda, set_id, id, effective_time, version) is returned either way and counts toward these figures.',
      );
      expect(textOf(result.content)).toContain(
        '**8 sections available** (page too large to inline)\n\n- `boxed_warning` — 9004 bytes\n- `warnings_and_cautions` — 9004 bytes\n- `clinical_studies_table` — 9004 bytes\n- `openfda` — 62 bytes\n- `effective_time` — 10 bytes\n- `set_id` — 7 bytes\n- `id` — 6 bytes\n- `version` — 3 bytes',
      );
    });

    it('returns a sections selection byte-identical', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-11-20' },
        results: [record],
      });

      const result = await runToolContract(getDrugLabelTool, { search, sections: ['warnings'] });

      expect(JSON.stringify(result.structuredContent)).toBe(
        '{"meta":{"total":1,"skip":0,"limit":5,"lastUpdated":"2026-11-20"},"kind":"full","results":[{"openfda":{"brand_name":["Aspirin"],"generic_name":["aspirin"],"manufacturer_name":["Bayer"]},"set_id":"set-a","id":"id-a","effective_time":"20260101","version":"2","warnings":["Short."]}],"totalResults":1,"effectiveQuery":"openfda.brand_name:\\"aspirin\\""}',
      );
    });
  });
});

/**
 * @fileoverview Cross-tool guarantees for the canvas staging surface. Every
 * search tool that can stage shares one contract: staging is opt-in, staging is
 * disclosed in content[] with a describe-then-query pointer, the canvas.acquire()
 * failures are declared, and an empty inline page for a query that matched
 * records never renders as "no results". A staged call reports the same `meta` as
 * the plain call for the same request (#73), checked at the handler boundary with
 * only the openFDA service and the canvas accessor stubbed. Asserted against every
 * staging tool rather than the two or three a bug report happens to name.
 * @module tests/mcp-server/tools/definitions/canvas-staging-parity.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

vi.mock('@/services/openfda/openfda-service.js', () => {
  let _svc: unknown;
  return {
    getOpenFdaService: () => _svc,
    __setMock: (s: unknown) => {
      _svc = s;
    },
  };
});

import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { AGGREGATE_ROUTE } from '@/services/openfda/canvas-spill.js';

/**
 * Minimal valid input per tool, before the `stage` default is applied, and the
 * tool's own no-match line — asserted exactly, since the past-the-end note also
 * opens with "No" and ends with a period.
 */
const STAGING_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }, 'No results found.'],
  [searchAnimalEventsTool, {}, 'No animal adverse event reports found.'],
  [searchDeviceClearancesTool, { pathway: '510k' }, 'No device clearances found.'],
  [searchDrugApprovalsTool, {}, 'No drug approvals found.'],
  [searchDrugShortagesTool, {}, 'No drug shortage records found.'],
  [searchRecallsTool, { category: 'drug' }, 'No results found.'],
  [searchTobaccoReportsTool, {}, 'No tobacco problem reports found.'],
  [lookupNdcTool, { search: 'aspirin' }, 'No NDC records found.'],
] as const;

const formatText = (
  tool: (typeof STAGING_TOOLS)[number][0],
  result: Record<string, unknown>,
): string => {
  const blocks = (tool.format as (r: unknown) => { text: string }[])(result);
  return blocks.map((b) => b.text).join('\n');
};

describe.each(STAGING_TOOLS.map(([tool, input, miss]) => [tool.name, tool, input, miss] as const))(
  '%s — canvas staging contract',
  (_name, tool, baseInput, miss) => {
    it('defaults staging off so a plain search costs one upstream request (#30)', () => {
      const parsed = tool.input.parse(baseInput) as { stage: boolean };
      expect(parsed.stage).toBe(false);
    });

    it('declares the canvas_disabled failure mode', () => {
      expect(tool.errors?.map((e) => e.reason)).toContain('canvas_disabled');
    });

    it('declares both canvas.acquire() failures as service-raised (#54)', () => {
      const byReason = new Map((tool.errors ?? []).map((e) => [e.reason, e]));
      expect(byReason.get('canvas_not_found')).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        thrownBy: 'service',
      });
      expect(byReason.get('canvas_capacity_exhausted')).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        retryable: true,
        thrownBy: 'service',
      });
    });

    it('leaves canvas_id_malformed undeclared — CanvasIdSchema rejects it before acquire (#54)', () => {
      expect(tool.errors?.map((e) => e.reason)).not.toContain('canvas_id_malformed');
      expect(tool.input.safeParse({ ...baseInput, canvas_id: 'not an id!' }).success).toBe(false);
    });

    it('never reports "no results" for a query that matched records (#31)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).not.toMatch(/^No .*(found|records)\.$/im);
      expect(text).toContain('609468');
    });

    it('discloses staged-vs-matched counts and the query path in content[] (#30, #31)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).toContain('Staged 235 of 609468');
      expect(text).toContain('spilled_ab12cd34');
      expect(text).toContain('openfda_dataframe_query');
    });

    it('points a truncated stage at openfda_count_values for whole-population aggregates (#36)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).toContain('narrow the query');
      expect(text).toContain('openfda_count_values');
    });

    it('omits the aggregate route when the whole match reached the table (#36)', () => {
      const text = formatText(tool, {
        meta: { total: 235, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
      });
      expect(text).not.toContain('openfda_count_values');
    });

    it('names the aggregate alternative in the stage input description (#36)', () => {
      const stage = tool.input.shape.stage as { description?: string };
      expect(stage.description).toContain('openfda_count_values');
    });

    it('points the staging line at openfda_dataframe_describe before openfda_dataframe_query (#50)', () => {
      for (const truncated of [true, false]) {
        const text = formatText(tool, {
          meta: { total: 609_468, skip: 0, limit: 1, lastUpdated: '2026-06-01' },
          results: [{}],
          canvas_id: 'cv_1',
          canvas_table: 'spilled_ab12cd34',
          spilled: true,
          staged_rows: truncated ? 235 : 609_468,
          ...(truncated ? { truncated: true } : {}),
        });
        const line = text.split('\n').find((l) => l.startsWith('> Staged')) ?? '';
        const describeAt = line.indexOf('openfda_dataframe_describe');
        expect(describeAt).toBeGreaterThan(-1);
        expect(describeAt).toBeLessThan(line.indexOf('openfda_dataframe_query'));
        /** #36's aggregate route still closes a truncated line, unchanged. */
        expect(line.endsWith(AGGREGATE_ROUTE)).toBe(truncated);
      }
    });

    it('renders no staging pointer when the call did not stage (#50)', () => {
      const text = formatText(tool, {
        meta: { total: 3, skip: 0, limit: 1, lastUpdated: '2026-06-01' },
        results: [{}],
      });
      expect(text).not.toContain('> Staged');
      expect(text).not.toContain('openfda_dataframe_describe');
    });

    it('names the describe-then-query workflow in the stage input and tool description (#50)', () => {
      const stage = tool.input.shape.stage as { description?: string };
      for (const surface of [stage.description ?? '', tool.description]) {
        expect(surface).toContain('openfda_dataframe_describe');
        expect(surface).toContain('openfda_dataframe_query');
      }
    });

    it('points past-the-end offsets at the staged table with a runnable query (#32)', () => {
      const text = formatText(tool, {
        meta: { total: 1175, skip: 300, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 1175,
      });
      expect(text).toContain('skip=300 is past the end');
      expect(text).toContain('The staged table holds all 1175 of them');
      expect(text).toContain('SELECT * FROM spilled_ab12cd34 LIMIT 10');
      /** The offset already overshot the matched set, so it must not reappear in the SQL. */
      expect(text).not.toContain('OFFSET 300');
    });

    it('says how much the staged table holds when staging was truncated (#30, #32)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 700_000, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).toContain('The staged table holds the first 235 of them');
      expect(text).not.toContain('OFFSET 700000');
    });

    it('qualifies its no-match wording when the total behind an offset is unverified', () => {
      const text = formatText(tool, {
        meta: { total: 0, skip: 500, limit: 0, lastUpdated: '2026-06-01', totalUnverified: true },
        results: [],
      });
      expect(text).toContain('at skip=500');
      expect(text).toContain('Retry with skip=0');
    });

    // #47 — a zero total at an offset is confirmed (recovered, or from the staged
    // probe) unless flagged, so the flat no-match wording stands.
    it('keeps its flat no-match wording at an offset when the zero total is confirmed', () => {
      const text = formatText(tool, {
        meta: { total: 0, skip: 500, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
      });
      expect(text.split('\n').at(-1)).toBe(miss);
      expect(text).not.toContain('Retry with skip=0');
    });

    it('keeps its own no-match wording, after the metadata header, when nothing matched (#68)', () => {
      const text = formatText(tool, {
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
      });
      const lines = text.split('\n');
      expect(lines[0]).toBe(
        '**0 total results** (returned: 0, skip: 0, limit: 0) | Data updated: 2026-06-01',
      );
      expect(lines.at(-1)).toBe(miss);
    });

    it('renders the staging line between the header and the no-match line on a staged miss (#68)', () => {
      const text = formatText(tool, {
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        spilled: false,
        staged_rows: 0,
      });
      const lines = text.split('\n').filter(Boolean);
      expect(lines[0]).toContain('Data updated: 2026-06-01');
      expect(lines[1]).toBe('> Canvas `cv_1` acquired; no rows staged (spilled=false, 0 matched).');
      expect(lines.at(-1)).toBe(miss);
    });
  },
);

/* --- #73: a staged call reports the plain call's meta for the same request --- */

async function setMock(path: string, value: unknown) {
  const mod = await import(path);
  (mod as { __setMock: (v: unknown) => void }).__setMock(value);
}

/**
 * Paged service stub over `total` records padded to `recordBytes`, echoing the
 * requested `limit` and `skip` into `meta` the way openFDA and the service do.
 */
function makeSvc(total: number, recordBytes = 0) {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < Math.min(skip + limit, total); i++) {
        results.push({ report_id: `rec-${i}`, blob: 'x'.repeat(recordBytes) });
      }
      return { meta: { total, skip, limit, lastUpdated: '2026-06-01' }, results };
    }),
  };
}

function makeCanvas() {
  const instance = {
    canvasId: 'cv_meta',
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

/** Each window and the `meta.limit` both modes must report for it. */
const META_CASES = [
  ['a miss', 0, 0, { limit: 2 }, 2],
  ['a window past the end of the match', 5, 0, { limit: 3, skip: 7 }, 3],
  ['a short page the budget did not bound', 3, 0, { limit: 10 }, 10],
  ['a full page the budget did not bound', 50, 0, { limit: 10 }, 10],
  ['a page the budget bounded', 40, 10_000, { limit: 10 }, 2],
  ['a lone record over the budget that dropped nothing', 1, 70_000, { limit: 10 }, 10],
] as const;

/**
 * Every tool hands its own `limit` to the shared staging path, so each runs the
 * two windows the bug misreported (a miss, a short page); the full set of windows
 * runs once, on the tool the bug was reported against. `canvas-spill.test.ts`
 * tables the same windows at the `canvasResult` seam.
 */
const WIRING_CASES = META_CASES.filter(
  ([name]) => name === 'a miss' || name === 'a short page the budget did not bound',
);

describe.each(
  STAGING_TOOLS.map(
    ([tool, input]) =>
      [tool.name, tool, input, tool === searchRecallsTool ? META_CASES : WIRING_CASES] as const,
  ),
)('%s — staged meta matches the plain call (#73)', (_name, tool, baseInput, cases) => {
  beforeEach(async () => {
    await setMock('@/services/canvas/canvas-accessor.js', undefined);
  });

  it.each(cases)('on %s', async (_case, total, recordBytes, window, limit) => {
    await setMock('@/services/openfda/openfda-service.js', makeSvc(total, recordBytes));
    const input = { ...baseInput, ...window } as never;
    const plain = await runToolContract(tool, input);

    await setMock('@/services/canvas/canvas-accessor.js', makeCanvas());
    const staged = await runToolContract(tool, { ...baseInput, ...window, stage: true } as never);

    const meta = (r: typeof plain) => (r.structuredContent as { meta: unknown }).meta;
    const header = (r: typeof plain) =>
      (r.content[0] as { text: string }).text.split('\n')[0] ?? '';

    expect(plain.isError).toBeFalsy();
    expect(staged.isError).toBeFalsy();
    expect((meta(plain) as { limit: number }).limit).toBe(limit);
    expect(meta(staged)).toEqual(meta(plain));
    // The #68 header prints meta.limit into content[] on every page, empty or not.
    expect(header(staged)).toBe(header(plain));
    expect(header(staged)).toContain(`limit: ${limit})`);
  });
});

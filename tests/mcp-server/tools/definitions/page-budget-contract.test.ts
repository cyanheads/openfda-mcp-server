/**
 * @fileoverview The inline byte-budget contract every multi-row search tool shares
 * (#39). Driven at the public tool boundary — `input.parse()` then `handler()`, then
 * `format()` on what the handler returned — because the defect was the size of the
 * payload a caller actually receives, which no helper-level assertion can see.
 *
 * Every case measures the real serialized payload rather than trusting a reported
 * figure, and the fixtures are padded so the overflow branch genuinely runs: a
 * 10 KB record at the default `limit: 10` is a 100 KB window against a 24,000-byte
 * budget.
 *
 * The `fields` projection and the disclosure of a lone over-budget record (#66) are
 * asserted on the assembled `CallToolResult` (`runToolContract`), so the
 * enrichment trailer and input-schema rejection are part of what is checked.
 * @module tests/mcp-server/tools/definitions/page-budget-contract.test
 */

import { Buffer } from 'node:buffer';
import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    setCanvas: (c: unknown) => {
      _canvas = c;
    },
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

vi.mock('@/services/openfda/openfda-service.js', () => {
  let _svc: unknown;
  return {
    getOpenFdaService: () => _svc,
    initOpenFdaService: () => {},
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
import { PAGE_BUDGET_BYTES } from '@/services/openfda/page-budget.js';

async function setCanvasMock(c: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(c);
}
async function setSvcMock(s: unknown) {
  const mod = await import('@/services/openfda/openfda-service.js');
  (mod as unknown as { __setMock: (s: unknown) => void }).__setMock(s);
}

/** Paged service stub whose records are padded with `recordBytes` repeats of `pad`. */
function makeSvc(total: number, recordBytes: number, pad = 'x') {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const end = Math.min(skip + limit, total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) {
        results.push({ report_id: `rec-${i}`, blob: pad.repeat(recordBytes) });
      }
      return { meta: { total, skip, limit, lastUpdated: '2026-06-01' }, results };
    }),
  };
}

function makeCanvas(canvasId = 'cv_budget') {
  const instance = {
    canvasId,
    isNew: true,
    registerTable: vi.fn(async (name: string, source: AsyncIterable<Record<string, unknown>>) => {
      let rowCount = 0;
      for await (const _row of source) rowCount++;
      return { tableName: name, rowCount, columns: [] };
    }),
    drop: vi.fn(),
  };
  return { canvas: { acquire: vi.fn().mockResolvedValue(instance) }, instance };
}

/** Minimal valid input per multi-row search tool, before defaults are applied. */
const SEARCH_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAnimalEventsTool, {}],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDrugApprovalsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [searchTobaccoReportsTool, {}],
  [lookupNdcTool, { search: 'aspirin' }],
] as const;

type SearchTool = (typeof SEARCH_TOOLS)[number][0];

/** Shape the handlers return — `results` is a dynamic record array on every tool. */
interface PageResult {
  meta: { lastUpdated: string; limit: number; skip: number; total: number };
  page_bytes?: number;
  page_omitted?: number;
  results: Record<string, unknown>[];
}

/** Drives one tool call and hands back both the payload and the enrichment context. */
async function call(
  tool: SearchTool,
  baseInput: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ ctx: Context; result: PageResult }> {
  const ctx = createMockContext({ errors: tool.errors });
  const input = tool.input.parse({ ...baseInput, ...extra });
  const result = (await (tool.handler as (i: unknown, c: unknown) => Promise<unknown>)(
    input,
    ctx,
  )) as PageResult;
  return { ctx, result };
}

function formatText(tool: SearchTool, result: unknown): string {
  return (tool.format as (r: unknown) => { text: string }[])(result)
    .map((b) => b.text)
    .join('\n');
}

/**
 * Blob padding that puts a whole page within a few dozen bytes of the budget, so
 * the boundary case below actually straddles the threshold. Every other fixture
 * here sits an order of magnitude clear of it in one direction or the other,
 * which leaves the comparison itself — headroom, an off-by-one, a shrunk
 * constant — free to move without failing anything.
 */
const NEAR_BUDGET_RECORD_BYTES = 2_148;

/**
 * The largest page of `recordBytes`-padded records that still serializes inside
 * the budget, derived by serializing the stub's own records rather than by
 * re-running the accumulator under test — so this pins the payload's real size,
 * not the helper's opinion of it.
 */
async function fittingLimit(recordBytes: number): Promise<number> {
  const { results } = await makeSvc(1_000, recordBytes).query('probe', { limit: 200, skip: 0 });
  let fit = 0;
  while (
    fit < results.length &&
    JSON.stringify(results.slice(0, fit + 1)).length <= PAGE_BUDGET_BYTES
  )
    fit++;
  return fit;
}

describe.each(SEARCH_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — inline byte-budget contract (#39)',
  (_name, tool, baseInput) => {
    beforeEach(async () => {
      await setCanvasMock(undefined);
    });

    it('returns a payload the caller can hold when the requested window cannot fit', async () => {
      await setSvcMock(makeSvc(5_000, 10_000));
      const { result } = await call(tool, baseInput);

      // Measured on the payload, not read off the reported figure.
      const actual = JSON.stringify(result.results).length;
      expect(actual).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
      expect(result.page_bytes).toBe(actual);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThan(10);
      expect(result.page_omitted).toBe(10 - result.results.length);
    });

    it('reports a page size it actually sent', async () => {
      await setSvcMock(makeSvc(5_000, 10_000));
      const { result } = await call(tool, baseInput);
      expect(result.meta.limit).toBe(result.results.length);
    });

    it('keeps a page that lands just inside the budget, and drops one record past it', async () => {
      await setSvcMock(makeSvc(5_000, NEAR_BUDGET_RECORD_BYTES));
      const fit = await fittingLimit(NEAR_BUDGET_RECORD_BYTES);

      const { result: inside } = await call(tool, baseInput, { limit: fit });
      const insideBytes = JSON.stringify(inside.results).length;
      /*
       * Fails loudly if the fixture ever drifts away from the threshold, rather
       * than passing on a page that no longer tests it.
       */
      expect(insideBytes).toBeGreaterThan(PAGE_BUDGET_BYTES - 100);
      expect(insideBytes).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
      expect(inside.results).toHaveLength(fit);
      expect(inside.page_omitted).toBeUndefined();
      expect(inside.page_bytes).toBeUndefined();

      const { result: over } = await call(tool, baseInput, { limit: fit + 1 });
      expect(over.results).toHaveLength(fit);
      expect(over.page_omitted).toBe(1);
      expect(over.page_bytes).toBe(JSON.stringify(over.results).length);
    });

    it('names the real counts and every route to the withheld records, on both surfaces', async () => {
      await setSvcMock(makeSvc(5_000, 10_000));
      const { ctx, result } = await call(tool, baseInput);
      const kept = result.results.length;
      const text = formatText(tool, result);
      /* `notice` is what carries the prose to structuredContent readers. */
      const notice = String(getEnrichment(ctx).notice ?? '');

      for (const surface of [text, notice]) {
        expect(surface).toContain(`${kept} of the ${kept + (result.page_omitted ?? 0)} records`);
        expect(surface).toContain(String(result.page_bytes));
        // The next window starts where this one stopped, so the offset is runnable.
        expect(surface).toContain(`skip=${kept}`);
        expect(surface).toContain('lower limit');
        expect(surface).toContain('openfda_dataframe_query');
        expect(surface).toContain('openfda_count_values');
      }
      expect(result.page_omitted).toBe(10 - kept);
    });

    it('never empties the page, even when one record exceeds the budget alone (#31)', async () => {
      await setSvcMock(makeSvc(900, 200_000));
      const { result } = await call(tool, baseInput, { limit: 5 });
      const text = formatText(tool, result);

      expect(result.results).toHaveLength(1);
      // The oversized record is returned whole — never trimmed to fit.
      expect(result.results[0]?.blob).toHaveLength(200_000);
      expect(result.page_bytes).toBeGreaterThan(PAGE_BUDGET_BYTES);
      expect(text).not.toMatch(/^No .*(found|results)\.$/im);
      expect(text).toContain('one record exceeds the budget on its own');
    });

    it('leaves a page that fits exactly as it was before the budget existed', async () => {
      const svc = makeSvc(5_000, 200);
      await setSvcMock(svc);
      const { result } = await call(tool, baseInput);
      const upstream = (await svc.query.mock.results[0]?.value) as PageResult;

      expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
      expect(result).toEqual({ meta: upstream.meta, results: upstream.results });
      expect(result.results).toHaveLength(10);
      expect(result.meta.limit).toBe(10);
      expect(formatText(tool, result)).not.toContain('Inline page bounded');
    });

    it('bounds the staged page identically, so the two modes agree on a window (#18, #30)', async () => {
      await setSvcMock(makeSvc(40, 10_000));
      const { result: plain } = await call(tool, baseInput);

      const { canvas } = makeCanvas();
      await setCanvasMock(canvas);
      const { result: staged } = await call(tool, baseInput, { stage: true });

      expect(staged.results.length).toBe(plain.results.length);
      expect(staged.page_omitted).toBe(plain.page_omitted);
      expect(staged.page_bytes).toBe(plain.page_bytes);
      // Staging still drains the whole match — the budget bounds the page, not the table.
      expect((staged as { staged_rows?: number }).staged_rows).toBe(40);
    });
  },
);

/* --- #66: fields projection and the lone over-budget record --- */

/** The identity key each tool's projected records keep, for the record shape it serves. */
const IDENTITY_KEY: Record<string, string> = {
  openfda_search_adverse_events: 'safetyreportid',
  openfda_search_animal_events: 'unique_aer_id_number',
  openfda_search_device_clearances: 'k_number',
  openfda_search_drug_approvals: 'application_number',
  openfda_search_drug_shortages: 'package_ndc',
  openfda_search_recalls: 'recall_number',
  openfda_search_tobacco_reports: 'report_id',
  openfda_lookup_ndc: 'product_ndc',
};

/** The projection the issue's drug-report repro asks for. */
const REPRO_FIELDS = [
  'receivedate',
  'serious',
  'patient.reaction',
  'patient.drug.medicinalproduct',
];

/** A drug-report-shaped record whose bulk sits in `patient.drug[].openfda`, like the live one. */
function heavyRecord(idKey: string, i: number): Record<string, unknown> {
  return {
    [idKey]: `id-${i}`,
    receivedate: `2026010${i}`,
    serious: '1',
    companynumb: `CO-${i}`,
    patient: {
      patientsex: '2',
      reaction: [{ reactionmeddrapt: 'Nausea', reactionoutcome: '1' }],
      drug: [
        { medicinalproduct: `DRUG-${i}`, openfda: { brand_name: ['x'.repeat(40_000)] } },
        { drugindication: 'PAIN', openfda: { brand_name: ['y'.repeat(40_000)] } },
      ],
    },
  };
}

/** Paged stub over `total` heavy records. */
function makeHeavySvc(idKey: string, total: number) {
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const end = Math.min(skip + (params.limit ?? 1000), total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) results.push(heavyRecord(idKey, i));
      return {
        meta: { total, skip, limit: params.limit ?? 1000, lastUpdated: '2026-06-01' },
        results,
      };
    }),
  };
}

/** Canvas stub that keeps every row the drain staged, for checking what reached the table. */
function makeCapturingCanvas() {
  const rows: Record<string, unknown>[] = [];
  const instance = {
    canvasId: 'cv_fields',
    isNew: true,
    registerTable: vi.fn(async (name: string, source: AsyncIterable<Record<string, unknown>>) => {
      for await (const row of source) rows.push(row);
      return { tableName: name, rowCount: rows.length, columns: [] };
    }),
    drop: vi.fn(),
  };
  return { canvas: { acquire: vi.fn().mockResolvedValue(instance) }, rows };
}

type WireResult = Awaited<ReturnType<typeof runToolContract>>;

function wireText(result: WireResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function wireStructured(result: WireResult): PageResult & {
  notice?: string;
  page_largest_fields?: { bytes: number; path: string }[];
  projected_fields?: string[];
} {
  return result.structuredContent as never;
}

/** UTF-8 bytes of the serialized value — what it occupies on the wire. */
const wireBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** The page-budget line `format()` rendered into `content[]`, without its quote marker. */
function budgetLine(text: string): string | undefined {
  return text
    .split('\n')
    .find((line) => line.startsWith('> Inline page'))
    ?.slice(2);
}

describe.each(SEARCH_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — fields projection and the lone over-budget record (#66)',
  (name, tool, baseInput) => {
    const idKey = IDENTITY_KEY[name] as string;
    const run = (extra: Record<string, unknown> = {}) =>
      runToolContract(tool, { ...baseInput, ...extra } as never);

    beforeEach(async () => {
      await setCanvasMock(undefined);
    });

    it('discloses a lone record that exceeds the budget on its own, naming its largest field', async () => {
      await setSvcMock(makeSvc(1, 200_000));
      const result = await run();
      const structured = wireStructured(result);
      const text = wireText(result);

      expect(result.isError).toBeFalsy();
      expect(structured.results).toHaveLength(1);
      expect(structured.results[0]?.blob).toHaveLength(200_000);
      // Measured on the payload: the overrun is reported, and nothing was dropped.
      expect(structured.page_bytes).toBe(JSON.stringify(structured.results).length);
      expect(structured.page_bytes).toBeGreaterThan(PAGE_BUDGET_BYTES);
      expect(structured.page_omitted).toBeUndefined();
      expect(structured.meta.limit).toBe(10);

      // `blob` serializes to its 200,000 characters plus two quotes.
      for (const surface of [text, String(structured.notice)]) {
        expect(surface).toContain(`at ${structured.page_bytes} bytes`);
        expect(surface).toContain('blob (200002 bytes)');
        expect(surface).toContain('Re-call with fields');
        expect(surface).toContain('openfda_describe_fields');
      }
      expect(text).toMatch(/^> Inline page exceeds the 24000-byte budget/m);
    });

    it('discloses the lone over-budget record identically when the call staged', async () => {
      await setSvcMock(makeSvc(1, 200_000));
      const { canvas } = makeCapturingCanvas();
      await setCanvasMock(canvas);
      const structured = wireStructured(await run({ stage: true }));

      expect(structured.results).toHaveLength(1);
      expect(structured.page_bytes).toBe(JSON.stringify(structured.results).length);
      expect(structured.page_omitted).toBeUndefined();
      expect(String(structured.notice)).toContain('blob (200002 bytes)');
      expect(structured.page_largest_fields).toEqual([{ path: 'blob', bytes: 200_002 }]);
    });

    it('projects each record to the requested paths plus its identity key, before measuring', async () => {
      const svc = makeHeavySvc(idKey, 3);
      await setSvcMock(svc);
      const result = await run({ fields: REPRO_FIELDS });
      const structured = wireStructured(result);
      const text = wireText(result);

      // Unprojected, one record is ~80 KB; projected, all three fit, so nothing is disclosed.
      expect(structured.results).toHaveLength(3);
      expect(structured.page_bytes).toBeUndefined();
      expect(structured.page_omitted).toBeUndefined();
      expect(JSON.stringify(structured.results).length).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
      expect(structured.projected_fields).toEqual(REPRO_FIELDS);
      expect(structured.results[0]).toEqual({
        [idKey]: 'id-0',
        receivedate: '20260100',
        serious: '1',
        patient: {
          reaction: [{ reactionmeddrapt: 'Nausea', reactionoutcome: '1' }],
          // The array keeps its length: the second drug carries no medicinalproduct.
          drug: [{ medicinalproduct: 'DRUG-0' }, {}],
        },
      });
      expect(Object.keys(structured.results[0] ?? {})[0]).toBe(idKey);

      // content[] carries the same records under their identity heading, and no placeholder.
      for (const i of [0, 1, 2]) expect(text).toContain(`### ${idKey}: id-${i}`);
      expect(text).toContain('DRUG-2');
      expect(text).toContain('Nausea');
      expect(text).not.toContain('CO-0');
      expect(text).not.toMatch(/\bN\/A\b|\bUnknown\b|Unclassified/);
      expect(text).toContain('> Records projected to the requested fields');
    });

    it('names a requested path no record on the page carries, without throwing', async () => {
      await setSvcMock(makeHeavySvc(idKey, 2));
      const result = await run({ fields: ['receivedate', 'patient.drug.no_such_leaf'] });
      const structured = wireStructured(result);

      expect(result.isError).toBeFalsy();
      expect(structured.results).toHaveLength(2);
      for (const surface of [wireText(result), String(structured.notice)]) {
        expect(surface).toContain('No record in this page carries patient.drug.no_such_leaf');
        expect(surface).not.toContain('carries receivedate');
      }
    });

    // The path grammar itself is tabled in input-validation.test.ts.
    it('rejects a malformed path before any upstream request', async () => {
      const svc = makeHeavySvc(idKey, 1);
      await setSvcMock(svc);
      const result = await run({ fields: ['receivedate', 'patient..drug'] });

      expect(result.isError).toBe(true);
      expect(wireText(result)).toContain('fields');
      expect(svc.query).not.toHaveBeenCalled();
    });

    it('shapes only the inline page when staged — the drain stages whole records', async () => {
      await setSvcMock(makeHeavySvc(idKey, 3));
      const { canvas, rows } = makeCapturingCanvas();
      await setCanvasMock(canvas);
      const structured = wireStructured(await run({ fields: REPRO_FIELDS, stage: true }));

      expect(structured.projected_fields).toEqual(REPRO_FIELDS);
      expect(structured.results).toHaveLength(3);
      expect(structured.results[0]).not.toHaveProperty('companynumb');
      // The table received the records as openFDA sent them.
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual(heavyRecord(idKey, 0));
    });
  },
);

/**
 * The mechanisms behind the per-tool wiring above are one shared implementation —
 * UTF-8 sizing, the largest-field drill, the one-record route gate, empty and
 * absent projections — tabled in `page-budget.test.ts` and
 * `record-projection.test.ts`. These cases run them end to end through one tool.
 */
describe('fields projection and the over-budget disclosure, end to end (#66)', () => {
  const run = (extra: Record<string, unknown> = {}) =>
    runToolContract(searchRecallsTool, { category: 'drug', ...extra } as never);

  beforeEach(async () => {
    await setCanvasMock(undefined);
  });

  it('measures the oversized record once and renders the same sentence on both surfaces', async () => {
    await setSvcMock(makeSvc(1, 200_000));
    const blob = 'x'.repeat(200_000);
    // The size walk serializes each leaf on its own; the blob alone is serialized nowhere else.
    const stringify = vi.spyOn(JSON, 'stringify');
    let result: WireResult;
    let walks: number;
    try {
      result = await run();
      walks = stringify.mock.calls.filter(([value]) => value === blob).length;
    } finally {
      stringify.mockRestore();
    }
    const structured = wireStructured(result);

    expect(walks).toBe(1);
    expect(structured.page_largest_fields).toEqual([{ path: 'blob', bytes: 200_002 }]);
    expect(budgetLine(wireText(result))).toBe(structured.notice);
  });

  it('measures the page in UTF-8 bytes, so non-ASCII text is bounded at its wire size', async () => {
    // 6,000 two-byte characters per record: two records fit in 24,000 code units, not in 24,000 bytes.
    await setSvcMock(makeSvc(50, 6_000, 'é'));
    const result = await run();
    const structured = wireStructured(result);

    expect(wireBytes(structured.results)).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
    expect(structured.page_bytes).toBe(wireBytes(structured.results));
    expect(structured.results).toHaveLength(1);
    expect(structured.page_omitted).toBe(9);
    for (const surface of [wireText(result), String(structured.notice)]) {
      expect(surface).toContain(`${structured.page_bytes} bytes against a`);
    }
  });

  it('measures the projected page, so a projection that still overruns is bounded and disclosed', async () => {
    await setSvcMock(makeHeavySvc('recall_number', 3));
    const structured = wireStructured(await run({ fields: ['patient.drug.openfda'] }));

    expect(structured.results).toHaveLength(1);
    expect(structured.page_omitted).toBe(2);
    expect(structured.page_bytes).toBe(JSON.stringify(structured.results).length);
    /*
     * The drill stops at the deepest path that still holds the excess: each
     * `brand_name` list serializes to 40,004 characters, across two drugs.
     */
    expect(String(structured.notice)).toContain('patient.drug.openfda.brand_name (80008 bytes)');
  });
});

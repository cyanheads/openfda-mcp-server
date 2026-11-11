/**
 * @fileoverview The page-size contract every multi-row search tool shares (#92).
 * `limit` is the page size: a page holds `limit` records, fewer only where the
 * match ends, staged or not, whatever the records weigh. Above the selected
 * endpoint's cap the page holds the cap's worth and the notice names the
 * requested value, the cap, and the next `skip` on both surfaces; with
 * `OPENFDA_CLAMP_LIMITS=false` the value is rejected before any upstream request.
 * A page holding a record that serializes above 24,000 bytes on its own reports
 * its size and that record's largest fields (#66); any other page carries neither.
 *
 * Driven at the public tool boundary — the assembled `CallToolResult`
 * (`runToolContract`), so the enrichment trailer and input-schema rejection are
 * part of what is checked, or `input.parse()` then `handler()` where the handler's
 * own return or log is the observable — because each defect (#39's unholdable
 * default pages, the page cut below `limit` that replaced them) was in the payload
 * a caller receives. Every size is measured on the real serialized payload rather
 * than read off a reported figure.
 *
 * Each tool runs at the endpoint its minimal input selects, and only that
 * endpoint's cap appears here: the default and cap of every endpoint are tabled
 * once in `schema-utils.test.ts`, and each tool's own test file wires its
 * selection.
 * @module tests/mcp-server/tools/definitions/page-budget-contract.test
 */

import { Buffer } from 'node:buffer';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { resetServerConfig } from '@/config/server-config.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';

async function setCanvasMock(c: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(c);
}
async function setSvcMock(s: unknown) {
  const mod = await import('@/services/openfda/openfda-service.js');
  (mod as unknown as { __setMock: (s: unknown) => void }).__setMock(s);
}

/**
 * Paged service stub over `total` records, record `i` padded with `recordBytes`
 * (or `recordBytes(i)`) repeats of `pad`, echoing the requested window into
 * `meta` the way openFDA and the service do.
 */
function makeSvc(total: number, recordBytes: number | ((i: number) => number), pad = 'x') {
  const padding = typeof recordBytes === 'number' ? () => recordBytes : recordBytes;
  return {
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      const end = Math.min(skip + limit, total);
      const results: Record<string, unknown>[] = [];
      for (let i = skip; i < end; i++) {
        results.push({ report_id: `rec-${i}`, blob: pad.repeat(padding(i)) });
      }
      return { meta: { total, skip, limit, lastUpdated: '2026-06-01' }, results };
    }),
  };
}

function makeCanvas(canvasId = 'cv_pagesize') {
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

/**
 * Minimal valid input per multi-row search tool, before defaults are applied;
 * the endpoint that input selects and that endpoint's cap; and the tool's
 * largest cap, which strict mode advertises as the schema `maximum`.
 */
const SEARCH_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }, 'drug/event', 25, 1000],
  [searchAnimalEventsTool, {}, 'animalandveterinary/event', 450, 450],
  [searchDeviceClearancesTool, { pathway: '510k' }, 'device/510k', 175, 575],
  [searchDrugApprovalsTool, {}, 'drug/drugsfda', 375, 375],
  [searchDrugShortagesTool, {}, 'drug/shortages', 1000, 1000],
  [searchRecallsTool, { category: 'drug' }, 'drug/enforcement', 1000, 1000],
  [searchTobaccoReportsTool, {}, 'tobacco/problem', 1000, 1000],
  [lookupNdcTool, { search: 'aspirin' }, 'drug/ndc', 1000, 1000],
] as const;

type SearchTool = (typeof SEARCH_TOOLS)[number][0];

/** Serialized size above which a record is disclosed as oversized (`OVERSIZED_RECORD_BYTES`). */
const OVERSIZED_BYTES = 24_000;

/** Shape the handlers return — `results` is a dynamic record array on every tool. */
interface PageResult {
  meta: { lastUpdated: string; limit: number; skip: number; total: number };
  page_bytes?: number;
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

/** The mock logger's record of every line a handler logged. */
function logCalls(ctx: Context): { data?: unknown; level: string; msg: string }[] {
  return (ctx.log as unknown as { calls: { data?: unknown; level: string; msg: string }[] }).calls;
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
  staged_rows?: number;
} {
  return result.structuredContent as never;
}

/** The error envelope a failed call carries on `structuredContent`. */
function errorOf(result: WireResult): {
  code: number;
  data?: { cap?: number; reason?: string; recovery?: { hint?: string } };
  message: string;
} {
  return (result.structuredContent as { error: never }).error;
}

/** UTF-8 bytes of the serialized value — what it occupies on the wire. */
const wireBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** The oversized-record line `format()` rendered into `content[]`, without its quote marker. */
function oversizedLine(text: string): string | undefined {
  return text
    .split('\n')
    .find((line) => line.startsWith('> Oversized record'))
    ?.slice(2);
}

/** The clamp disclosure for a `limit` of 5000 at an endpoint's cap, up to its next-page clause. */
const clampHead = (kind: string, cap: number) =>
  `limit=5000 is above the ${cap}-record cap for ${kind}, so ${cap} was applied.`;

describe.each(
  SEARCH_TOOLS.map(
    ([tool, input, kind, cap, maximum]) => [tool.name, tool, input, kind, cap, maximum] as const,
  ),
)('%s — page-size contract (#92)', (_name, tool, baseInput, kind, cap, maximum) => {
  const run = (extra: Record<string, unknown> = {}) =>
    runToolContract(tool, { ...baseInput, ...extra } as never);

  beforeEach(async () => {
    await setCanvasMock(undefined);
  });

  it('returns limit records however heavy the page is, with meta.limit equal to it', async () => {
    // Ten 10 KB records: a 100 KB page, and no record oversized on its own.
    const svc = makeSvc(5_000, 10_000);
    await setSvcMock(svc);
    const result = await run({ limit: 10 });
    const structured = wireStructured(result);

    expect(svc.query.mock.calls[0]?.[1]).toMatchObject({ limit: 10, skip: 0 });
    expect(structured.results).toHaveLength(10);
    expect(structured.meta.limit).toBe(10);
    expect(wireText(result).split('\n')[0]).toContain('(returned: 10, skip: 0, limit: 10)');
    expect(structured).not.toHaveProperty('page_bytes');
    expect(structured).not.toHaveProperty('page_omitted');
    expect(structured.notice).toBeUndefined();
  });

  it('returns the same window when staged, and stages the whole match (#18, #30)', async () => {
    await setSvcMock(makeSvc(40, 10_000));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);
    const structured = wireStructured(await run({ limit: 10, stage: true }));

    expect(structured.results.map((record) => record.report_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `rec-${i}`),
    );
    expect(structured.meta.limit).toBe(10);
    expect(structured).not.toHaveProperty('page_omitted');
    expect(structured.staged_rows).toBe(40);
  });

  it('applies the cap to a larger limit, naming the requested value, the cap, and the next skip on both surfaces', async () => {
    const svc = makeSvc(7 + cap * 2, 50);
    await setSvcMock(svc);
    const result = await run({ limit: 5_000, skip: 7 });
    const structured = wireStructured(result);
    // The next page starts after this one's `cap` records, from the requested offset.
    const notice = `${clampHead(kind, cap)} The next page starts at skip=${7 + cap}.`;

    expect(result.isError).toBeFalsy();
    expect(svc.query.mock.calls[0]?.[1]).toMatchObject({ limit: cap, skip: 7 });
    expect(structured.results).toHaveLength(cap);
    expect(structured.meta.limit).toBe(cap);
    expect(structured.notice).toBe(notice);
    expect(wireText(result)).toContain(`> ${notice}`);
  });

  it('logs the clamp once, naming the endpoint, the requested value, and the cap', async () => {
    await setSvcMock(makeSvc(cap * 2, 50));
    const { ctx } = await call(tool, baseInput, { limit: 5_000 });

    expect(
      logCalls(ctx).filter((line) => line.msg === 'Clamped limit to the endpoint cap'),
    ).toEqual([
      {
        level: 'info',
        msg: 'Clamped limit to the endpoint cap',
        data: { endpoint: kind, requested: 5_000, cap },
      },
    ]);
  });

  it('joins the clamp to the past-the-end note when the window starts beyond the match', async () => {
    await setSvcMock(makeSvc(40, 50));
    const structured = wireStructured(await run({ limit: 5_000, skip: 40 }));
    const notice = String(structured.notice);

    expect(structured.results).toEqual([]);
    expect(structured.meta.limit).toBe(cap);
    expect(notice).toContain('40 matched, so the offset is past the end of the result set');
    expect(notice).toContain(clampHead(kind, cap));
  });

  it('joins the clamp to the staging disclosure when the call staged', async () => {
    await setSvcMock(makeSvc(cap + 30, 50));
    const { canvas } = makeCanvas();
    await setCanvasMock(canvas);
    const structured = wireStructured(await run({ limit: 5_000, stage: true }));
    const notice = String(structured.notice);

    expect(structured.results).toHaveLength(cap);
    expect(structured.meta.limit).toBe(cap);
    expect(notice).toContain(`${clampHead(kind, cap)} The next page starts at skip=${cap}.`);
    expect(notice).toContain(`Staged ${cap + 30} of ${cap + 30} matched records`);
  });

  it('discloses an oversized record on a page of several, returning every record whole', async () => {
    // The second of three records serializes past 24,000 bytes on its own.
    await setSvcMock(makeSvc(3, (i) => (i === 1 ? 30_000 : 200)));
    const result = await run({ limit: 3 });
    const structured = wireStructured(result);

    expect(structured.results).toHaveLength(3);
    expect(structured.results[1]?.blob).toHaveLength(30_000);
    expect(structured.page_bytes).toBe(wireBytes(structured.results));
    expect(structured.page_largest_fields).toEqual([{ path: 'blob', bytes: 30_002 }]);
    expect(structured.notice).toContain(
      `Oversized record: this page of 3 records serializes to ${structured.page_bytes} bytes, and at least one record on it exceeds 24000 bytes on its own. The largest record's largest field is blob (30002 bytes).`,
    );
    expect(oversizedLine(wireText(result))).toBe(structured.notice);
  });

  it('carries neither disclosure field when every record serializes under 24,000 bytes', async () => {
    // Ten 23 KB records: 230 KB of page, and no record oversized on its own.
    const svc = makeSvc(5_000, 23_000);
    await setSvcMock(svc);
    const { result } = await call(tool, baseInput, { limit: 10 });
    const upstream = (await svc.query.mock.results[0]?.value) as PageResult;

    expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
    expect(result).toEqual({ meta: upstream.meta, results: upstream.results });
    expect(formatText(tool, result)).not.toContain('Oversized record');
  });

  it('never empties or trims a page of oversized records (#31)', async () => {
    await setSvcMock(makeSvc(900, 200_000));
    const { result } = await call(tool, baseInput, { limit: 5 });
    const text = formatText(tool, result);

    expect(result.results).toHaveLength(5);
    for (const record of result.results) expect(record.blob).toHaveLength(200_000);
    expect(result.page_bytes).toBe(wireBytes(result.results));
    expect(text).not.toMatch(/^No .*(found|results)\.$/im);
    expect(text).toContain('> Oversized record: this page of 5 records');
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

    it(`rejects a limit above the tool's largest cap at the schema, before any upstream request`, async () => {
      const svc = makeSvc(5_000, 50);
      await setSvcMock(svc);
      const result = await run({ limit: maximum + 1 });

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorOf(result).message).toContain(
        `limit: Too big: expected number to be <=${maximum}`,
      );
      expect(svc.query).not.toHaveBeenCalled();
    });

    it("returns the selected endpoint's cap without a notice", async () => {
      await setSvcMock(makeSvc(cap + 5, 50));
      const structured = wireStructured(await run({ limit: cap }));

      expect(structured.results).toHaveLength(cap);
      expect(structured.meta.limit).toBe(cap);
      expect(structured.notice).toBeUndefined();
    });
  });
});

/**
 * The three tools whose endpoint follows another input, each at a selection whose
 * cap sits below the tool's largest — the range where strict mode answers with
 * the typed reason rather than the schema `maximum`.
 */
const MULTI_ENDPOINT_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }, 'drug/event', 25],
  [searchRecallsTool, { category: 'device', endpoint: 'recall' }, 'device/recall', 50],
  [searchDeviceClearancesTool, { pathway: '510k' }, 'device/510k', 175],
] as const;

describe.each(
  MULTI_ENDPOINT_TOOLS.map(
    ([tool, input, kind, cap]) => [tool.name, tool, input, kind, cap] as const,
  ),
)(
  '%s — limit_above_cap with OPENFDA_CLAMP_LIMITS=false (#92)',
  (_name, tool, baseInput, kind, cap) => {
    beforeEach(async () => {
      vi.stubEnv('OPENFDA_CLAMP_LIMITS', 'false');
      resetServerConfig();
      await setCanvasMock(undefined);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      resetServerConfig();
    });

    const declared = () => tool.errors?.find((entry) => entry.reason === 'limit_above_cap');

    it('declares the reason as service-raised', () => {
      expect(declared()).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
      });
    });

    it("rejects a limit above the selected endpoint's cap with the typed reason, before any upstream request", async () => {
      const svc = makeSvc(5_000, 50);
      await setSvcMock(svc);
      const result = await runToolContract(tool, { ...baseInput, limit: cap + 1 } as never);
      const error = errorOf(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('limit_above_cap');
      expect(error.data?.cap).toBe(cap);
      expect(error.message).toBe(`limit=${cap + 1} exceeds the ${cap} cap for ${kind}.`);
      expect(error.data?.recovery?.hint).toBe(declared()?.recovery);
      expect(svc.query).not.toHaveBeenCalled();
    });
  },
);

/* --- #66: fields projection and the lone oversized record --- */

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

describe.each(SEARCH_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — fields projection and the lone oversized record (#66)',
  (name, tool, baseInput) => {
    const idKey = IDENTITY_KEY[name] as string;
    const run = (extra: Record<string, unknown> = {}) =>
      runToolContract(tool, { ...baseInput, ...extra } as never);

    beforeEach(async () => {
      await setCanvasMock(undefined);
    });

    it('discloses a lone record that serializes above 24,000 bytes on its own, naming its largest field', async () => {
      const svc = makeSvc(1, 200_000);
      await setSvcMock(svc);
      const result = await run();
      const structured = wireStructured(result);
      const text = wireText(result);
      const pageBytes = structured.page_bytes ?? 0;

      expect(result.isError).toBeFalsy();
      expect(structured.results).toHaveLength(1);
      expect(structured.results[0]?.blob).toHaveLength(200_000);
      // Measured on the payload: the record's size is reported, and it came back whole.
      expect(pageBytes).toBe(JSON.stringify(structured.results).length);
      expect(pageBytes).toBeGreaterThan(OVERSIZED_BYTES);
      expect(structured).not.toHaveProperty('page_omitted');
      // meta.limit is the page size the call applied, not the one record the match held.
      expect(structured.meta.limit).toBe(svc.query.mock.calls[0]?.[1]?.limit);

      // `blob` serializes to its 200,000 characters plus two quotes.
      for (const surface of [text, String(structured.notice)]) {
        expect(surface).toContain(
          `the one record on this page serializes to ${pageBytes - 2} bytes, over 24000 (page_bytes ${pageBytes})`,
        );
        expect(surface).toContain('blob (200002 bytes)');
        expect(surface).toContain('Re-call with fields');
        expect(surface).toContain('openfda_describe_fields');
      }
      expect(text).toMatch(/^> Oversized record: /m);
    });

    it('discloses the lone oversized record identically when the call staged', async () => {
      await setSvcMock(makeSvc(1, 200_000));
      const { canvas } = makeCapturingCanvas();
      await setCanvasMock(canvas);
      const structured = wireStructured(await run({ stage: true }));

      expect(structured.results).toHaveLength(1);
      expect(structured.page_bytes).toBe(JSON.stringify(structured.results).length);
      expect(structured).not.toHaveProperty('page_omitted');
      expect(String(structured.notice)).toContain('blob (200002 bytes)');
      expect(structured.page_largest_fields).toEqual([{ path: 'blob', bytes: 200_002 }]);
    });

    it('projects each record to the requested paths plus its identity key, before measuring', async () => {
      const svc = makeHeavySvc(idKey, 3);
      await setSvcMock(svc);
      const result = await run({ fields: REPRO_FIELDS });
      const structured = wireStructured(result);
      const text = wireText(result);

      // Unprojected, one record is ~80 KB; projected, none is oversized, so nothing is disclosed.
      expect(structured.results).toHaveLength(3);
      expect(structured.page_bytes).toBeUndefined();
      expect(structured).not.toHaveProperty('page_omitted');
      for (const record of structured.results) {
        expect(wireBytes(record)).toBeLessThanOrEqual(OVERSIZED_BYTES);
      }
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
        expect(surface).toContain('No record in this page carries `patient.drug.no_such_leaf`');
        expect(surface).not.toContain('carries `receivedate`');
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
      // Measured after projection, as on the plain path: each ~80 KB record projects under 24,000 bytes.
      expect(structured).not.toHaveProperty('page_bytes');
      expect(structured).not.toHaveProperty('page_largest_fields');
      // The table received the records as openFDA sent them.
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual(heavyRecord(idKey, 0));
    });
  },
);

/**
 * The mechanisms behind the per-tool wiring above are one shared implementation —
 * UTF-8 sizing, the largest-field drill, the lone-record coverage claim, empty and
 * absent projections — tabled in `page-budget.test.ts` and
 * `record-projection.test.ts`. These cases run them end to end through one tool.
 */
describe('fields projection and the oversized-record disclosure, end to end (#66)', () => {
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
    expect(oversizedLine(wireText(result))).toBe(structured.notice);
  });

  it('measures records in UTF-8 bytes, so non-ASCII text is disclosed at its wire size', async () => {
    // 13,000 two-byte characters: under 24,000 UTF-16 code units, over 24,000 bytes.
    await setSvcMock(makeSvc(50, 13_000, 'é'));
    const result = await run({ limit: 3 });
    const structured = wireStructured(result);
    const [first] = structured.results;

    expect(JSON.stringify(first).length).toBeLessThan(OVERSIZED_BYTES);
    expect(wireBytes(first)).toBeGreaterThan(OVERSIZED_BYTES);
    expect(structured.results).toHaveLength(3);
    expect(structured.page_bytes).toBe(wireBytes(structured.results));
    expect(structured.page_largest_fields).toEqual([{ path: 'blob', bytes: 26_002 }]);
    for (const surface of [wireText(result), String(structured.notice)]) {
      expect(surface).toContain(
        `this page of 3 records serializes to ${structured.page_bytes} bytes`,
      );
    }
  });

  it('measures the projected records, so a projection that still carries an oversized field is disclosed whole', async () => {
    await setSvcMock(makeHeavySvc('recall_number', 3));
    const structured = wireStructured(await run({ fields: ['patient.drug.openfda'], limit: 3 }));

    expect(structured.results).toHaveLength(3);
    expect(structured).not.toHaveProperty('page_omitted');
    expect(structured.page_bytes).toBe(JSON.stringify(structured.results).length);
    /*
     * The drill stops at the deepest path that still holds the excess: each
     * `brand_name` list serializes to 40,004 characters, across two drugs.
     */
    expect(String(structured.notice)).toContain('patient.drug.openfda.brand_name (80008 bytes)');
  });
});

/**
 * @fileoverview canvas.acquire() failures on the staging search tools, driven
 * through a real DataCanvas (framework CanvasRegistry + DuckDB provider) rather
 * than a stubbed acquire. Asserts that each failure reason the canvas layer
 * raises reaches the caller as one the tool declares in `errors[]`, and that the
 * recovery the declaration names — reuse a held canvas_id — works.
 * @module tests/mcp-server/tools/definitions/canvas-acquire-failures.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(async (_endpoint: string, params: { skip?: number }) => {
      const skip = params.skip ?? 0;
      const results = skip === 0 ? [{ recall_number: 'R-0', classification: 'Class I' }] : [];
      return { meta: { total: 1, skip, limit: 1, lastUpdated: '2026-06-01' }, results };
    }),
  }),
  initOpenFdaService: () => {},
}));

import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';

const TENANT = 'acquire-failures';

/** Minimal valid input per staging tool. */
const STAGING_TOOLS: readonly (readonly [AnyToolDefinition, Record<string, unknown>])[] = [
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAnimalEventsTool, {}],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDrugApprovalsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [searchTobaccoReportsTool, {}],
  [lookupNdcTool, { search: 'aspirin' }],
];

let canvas: DataCanvas | undefined;

/** A real DataCanvas whose registry admits `maxCanvasesPerTenant` canvases per tenant. */
function installCanvas(maxCanvasesPerTenant: number): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: '/tmp/openfda-canvas-acquire-test',
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
    maxCanvasesPerTenant,
    sweeperIntervalMs: 0,
  });
  canvas = new DataCanvas(provider, registry);
  setCanvas(canvas);
  return canvas;
}

afterEach(async () => {
  if (canvas) await canvas.shutdown(createMockContext({ tenantId: TENANT }));
  canvas = undefined;
  setCanvas(undefined);
});

/** Run a tool handler and return the McpError it threw. */
async function callForError(
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
): Promise<McpError> {
  const ctx = createMockContext({ errors: tool.errors, tenantId: TENANT });
  const outcome = await Promise.resolve()
    .then(() => tool.handler(tool.input.parse(input), ctx))
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(outcome).toBeInstanceOf(McpError);
  return outcome as McpError;
}

function declaredReasons(tool: AnyToolDefinition): string[] {
  return (tool.errors ?? []).map((e) => e.reason);
}

describe.each(STAGING_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — canvas.acquire() failures through a real canvas',
  (_name, tool, baseInput) => {
    it('surfaces an unknown well-formed canvas_id as the declared canvas_not_found (#54)', async () => {
      installCanvas(100);
      const err = await callForError(tool, { ...baseInput, canvas_id: 'zzzzzzzzzz' });

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({ reason: 'canvas_not_found', canvasId: 'zzzzzzzzzz' });
      expect(declaredReasons(tool)).toContain(err.data?.reason);
    });

    it('surfaces a mint at the tenant cap as the declared canvas_capacity_exhausted (#54)', async () => {
      installCanvas(0);
      const err = await callForError(tool, { ...baseInput, stage: true });

      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.data).toMatchObject({ reason: 'canvas_capacity_exhausted', retryable: true });
      expect(declaredReasons(tool)).toContain(err.data?.reason);
    });
  },
);

describe('canvas_capacity_exhausted recovery (#54)', () => {
  it('refuses a second mint at the cap, then stages onto the held canvas_id', async () => {
    const live = installCanvas(1);
    const ctx = createMockContext({ errors: searchRecallsTool.errors, tenantId: TENANT });
    const first = await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug', stage: true }),
      ctx,
    );
    expect(first.spilled).toBe(true);
    expect(first.canvas_id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(live.countForTenant(ctx)).toBe(1);

    const refused = await callForError(searchRecallsTool, { category: 'drug', stage: true });
    expect(refused.data).toMatchObject({ reason: 'canvas_capacity_exhausted' });

    const reused = await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug', canvas_id: first.canvas_id }),
      createMockContext({ errors: searchRecallsTool.errors, tenantId: TENANT }),
    );
    expect(reused.canvas_id).toBe(first.canvas_id);
    expect(reused.staged_rows).toBe(1);
    expect(live.countForTenant(ctx)).toBe(1);
  });
});

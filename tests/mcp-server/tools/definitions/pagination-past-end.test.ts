/**
 * @fileoverview A page requested past the end of its matched set, on every
 * paginated tool, against the real OpenFdaService with a stubbed HTTP boundary.
 * openFDA answers that page with the same `No matches found!` 404 it uses for a
 * query that matched nothing, so the service recovers the total with one
 * `skip=0&limit=0` request — asserted on the outgoing URL and on both
 * `structuredContent` and `content[]` (#47).
 * @module tests/mcp-server/tools/definitions/pagination-past-end.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * One attempt per request: the recovery-failure case answers 503, which the real
 * `withRetry` would back off on for seconds before giving up. The classification
 * inside each attempt stays real.
 */
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { initOpenFdaService } from '@/services/openfda/openfda-service.js';

const http = createFetchMock();

/** Minimal valid input per paginated tool, before defaults are applied. */
const PAGINATED_TOOLS: ReadonlyArray<readonly [AnyToolDefinition, Record<string, unknown>]> = [
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAnimalEventsTool, {}],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDrugApprovalsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [searchTobaccoReportsTool, {}],
  [lookupNdcTool, { search: 'aspirin' }],
  [getDrugLabelTool, { search: 'openfda.brand_name:"aspirin"' }],
];

const NO_MATCHES = () =>
  Response.json({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }, { status: 404 });
const TOTAL = (total: number) => () =>
  Response.json({
    meta: { results: { skip: 0, limit: 0, total }, last_updated: '2026-09-17' },
    results: [],
  });
const UNAVAILABLE = () =>
  new Response('<html><body>503 Service Temporarily Unavailable</body></html>', { status: 503 });

const params = (request: Request) => new URL(request.url).searchParams;
/** The page request — anything but the `limit=0` total recovery. */
const isPage = (request: Request) => params(request).get('limit') !== '0';
const isRecovery = (request: Request) => params(request).get('limit') === '0';

function textOfResult(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

interface SearchStructured {
  meta: { total: number; skip: number; totalUnverified?: boolean };
  notice?: string;
  results?: unknown[];
  totalResults: number;
}

describe.each(PAGINATED_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — a page past the end of the matched set',
  (_name, tool, baseInput) => {
    beforeAll(() => {
      initOpenFdaService();
    });

    beforeEach(() => {
      http.reset();
      http.install();
    });

    afterEach(() => {
      http.restore();
    });

    it('reports the recovered total and says the offset is past the end', async () => {
      http.route({ match: isPage, respond: NO_MATCHES }, { match: isRecovery, respond: TOTAL(39) });

      const result = await runToolContract(tool, { ...baseInput, limit: 1, skip: 39 });

      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(2);
      const recovery = params(http.calls[1]!.request);
      expect(recovery.get('skip')).toBe('0');
      expect(recovery.get('limit')).toBe('0');
      expect(recovery.has('sort')).toBe(false);
      expect(recovery.get('search')).toBe(params(http.calls[0]!.request).get('search'));

      const structured = result.structuredContent as unknown as SearchStructured;
      expect(structured.meta.total).toBe(39);
      expect(structured.meta.skip).toBe(39);
      expect(structured.meta.totalUnverified).toBeUndefined();
      expect(structured.totalResults).toBe(39);
      expect(structured.results ?? []).toEqual([]);
      expect(structured.notice).toMatch(/39 matched/);
      expect(structured.notice).toMatch(/past the end/);
      expect(structured.notice).not.toMatch(/either no records match/i);

      const text = textOfResult(result);
      expect(text).toMatch(/39 matched/);
      expect(text).toMatch(/past the end/);
      expect(text).not.toMatch(/either nothing matched|either no records match/i);
      expect(text).not.toMatch(/^No .* found\.$/m);
    });

    it('treats skip exactly at the total as past the end', async () => {
      http.route({ match: isPage, respond: NO_MATCHES }, { match: isRecovery, respond: TOTAL(40) });

      const result = await runToolContract(tool, { ...baseInput, limit: 10, skip: 40 });

      const structured = result.structuredContent as unknown as SearchStructured;
      expect(structured.meta.total).toBe(40);
      expect(structured.notice).toMatch(/40 matched/);
      expect(textOfResult(result)).toMatch(/40 matched/);
    });

    it('states a genuine zero-match at skip > 0 without the pagination hedge', async () => {
      http.route({ match: () => true, respond: NO_MATCHES });

      const result = await runToolContract(tool, { ...baseInput, limit: 1, skip: 5 });

      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(2);
      const structured = result.structuredContent as unknown as SearchStructured;
      expect(structured.meta.total).toBe(0);
      expect(structured.meta.totalUnverified).toBeUndefined();
      expect(structured.totalResults).toBe(0);
      expect(structured.notice).toBeDefined();
      expect(structured.notice).not.toMatch(/pagination ran past the end|either no records match/i);

      const text = textOfResult(result);
      expect(text).toMatch(/^No .*found\.$/m);
      expect(text).not.toMatch(/ran past the end|either nothing matched|Retry with skip=0/i);
    });

    it('keeps the empty page and the hedge when the total recovery fails', async () => {
      http.route(
        { match: isPage, respond: NO_MATCHES },
        { match: isRecovery, respond: UNAVAILABLE },
      );

      const result = await runToolContract(tool, { ...baseInput, limit: 1, skip: 39 });

      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(2);
      const structured = result.structuredContent as unknown as SearchStructured;
      expect(structured.meta.total).toBe(0);
      expect(structured.meta.totalUnverified).toBe(true);
      expect(structured.results ?? []).toEqual([]);
      expect(structured.notice).toMatch(
        /Either no records match or pagination ran past the end of the result set/,
      );

      const text = textOfResult(result);
      expect(text).toMatch(/either nothing matched or the offset ran past the end/);
      expect(text).toContain('Retry with skip=0');
    });

    it('makes no extra request for an empty page at skip=0', async () => {
      http.route({ match: () => true, respond: NO_MATCHES });

      const result = await runToolContract(tool, { ...baseInput, limit: 1 });

      expect(http.calls).toHaveLength(1);
      expect(textOfResult(result)).toMatch(/^No .*found\.$/m);
    });
  },
);

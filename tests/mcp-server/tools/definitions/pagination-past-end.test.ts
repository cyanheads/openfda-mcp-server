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
import { textOfResult } from '../../../helpers/content.js';
import { NO_MATCHES, UNAVAILABLE } from '../../../helpers/upstream-responses.js';

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

const TOTAL = (total: number) => () =>
  Response.json({
    meta: { results: { skip: 0, limit: 0, total }, last_updated: '2026-09-17' },
    results: [],
  });
/** A 200 page holding nothing — records the dataset date the way a warm process has it. */
const EMPTY_PAGE = (lastUpdated: string) => () =>
  Response.json({
    meta: { results: { skip: 0, limit: 2, total: 0 }, last_updated: lastUpdated },
    results: [],
  });

const params = (request: Request) => new URL(request.url).searchParams;
/** The page request — anything but the `limit=0` total recovery. */
const isPage = (request: Request) => params(request).get('limit') !== '0';
const isRecovery = (request: Request) => params(request).get('limit') === '0';

interface SearchStructured {
  kind?: string;
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

    // #68 — a no-match renders the metadata structuredContent carries, ahead of the miss.
    it('renders the dataset date, skip, and limit ahead of the no-match line', async () => {
      http.route(
        { match: () => true, once: true, respond: EMPTY_PAGE('2026-07-31') },
        { match: () => true, respond: NO_MATCHES },
      );
      await runToolContract(tool, { ...baseInput, limit: 2 });

      const result = await runToolContract(tool, { ...baseInput, limit: 2 });

      const structured = result.structuredContent as unknown as SearchStructured;
      expect(structured.meta).toMatchObject({
        total: 0,
        skip: 0,
        limit: 2,
        lastUpdated: '2026-07-31',
      });
      const text = textOfResult(result);
      const header = text.split('\n')[0]!;
      expect(header).toContain('**0 total results**');
      expect(header).toContain('skip: 0');
      expect(header).toContain('limit: 2');
      expect(header).toContain('Data updated: 2026-07-31');
      if (structured.kind) expect(header).toContain(`kind: ${structured.kind}`);
      const noMatch = text.search(/^No .*found\.$/m);
      expect(noMatch).toBeGreaterThan(text.indexOf('Data updated: 2026-07-31'));
      /** The notice renders unchanged in the trailer after the no-match line. */
      expect(text.indexOf(`> ${structured.notice}`)).toBeGreaterThan(noMatch);
    });

    it('renders an unknown dataset date as structuredContent carries it on a cold process', async () => {
      initOpenFdaService();
      http.route({ match: () => true, respond: NO_MATCHES });

      const result = await runToolContract(tool, { ...baseInput, limit: 2 });

      const structured = result.structuredContent as unknown as SearchStructured;
      expect(structured.meta).toMatchObject({ lastUpdated: 'unknown' });
      const text = textOfResult(result);
      expect(text.split('\n')[0]).toContain('Data updated: unknown');
      expect(text).toMatch(/^No .*found\.$/m);
    });

    it('keeps the qualified no-match wording after the header when the total is unverified', async () => {
      http.route(
        { match: isPage, respond: NO_MATCHES },
        { match: isRecovery, respond: UNAVAILABLE },
      );

      const result = await runToolContract(tool, { ...baseInput, limit: 1, skip: 39 });

      const text = textOfResult(result);
      const header = text.split('\n')[0]!;
      expect(header).toMatch(/^\*\*0 total results\*\* \(returned: 0, skip: 39, limit: 1\b/);
      expect(text.indexOf('either nothing matched')).toBeGreaterThan(header.length);
    });
  },
);

/* --- a search_after cursor walk through the real service (#97) --- */

/**
 * Every paginated tool that takes `cursor`; cosmetic events and device
 * classification walk as rows of their own.
 */
const CURSOR_TOOLS: ReadonlyArray<readonly [AnyToolDefinition, Record<string, unknown>]> = [
  [searchTobaccoReportsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [getDrugLabelTool, { search: 'openfda.brand_name:"aspirin"' }],
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAdverseEventsTool, { category: 'cosmetic' }],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDeviceClearancesTool, { pathway: 'classification' }],
  [lookupNdcTool, { search: 'aspirin' }],
  [searchDrugApprovalsTool, {}],
  [searchAnimalEventsTool, {}],
];

interface CursorPage extends SearchStructured {
  next_cursor?: string;
  results: { id?: string }[];
}

/**
 * openFDA as the service meets it: a page read at `skip=0` or by `search_after`
 * links the next by `search_after` — the exactly full last page included, a
 * link that answers 404 — a page read at a later `skip` links by `skip`, and
 * `meta.results.skip` reads 0 on every `search_after` page. A request by
 * `search_after` resumes after the record its value names.
 */
function openFdaWalk(total: number) {
  const ids = Array.from({ length: total }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
  return {
    ids,
    respond: (request: Request) => {
      const url = new URL(request.url);
      const q = url.searchParams;
      const limit = Number(q.get('limit'));
      const after = q.get('search_after');
      const skip = Number(q.get('skip') ?? 0);
      const from = after ? ids.indexOf(after.replace(/^0=/, '')) + 1 : skip;
      const slice = ids.slice(from, from + limit);
      if (slice.length === 0) return NO_MATCHES();
      const next = new URL(url);
      next.searchParams.delete('api_key');
      if (after || skip === 0) {
        next.searchParams.set('skip', '0');
        next.searchParams.set('search_after', `0=${slice.at(-1)}`);
      } else {
        next.searchParams.set('skip', String(skip + limit));
      }
      return Response.json(
        {
          meta: { results: { skip: after ? 0 : skip, limit, total }, last_updated: '2026-11-21' },
          results: slice.map((id) => ({ id })),
        },
        { headers: { link: `<${next.href}>; rel="next"` } },
      );
    },
  };
}

describe.each(CURSOR_TOOLS.map(([tool, input]) => [tool.name, input, tool] as const))(
  '%s %j — a cursor walk through the real service',
  (_name, baseInput, tool) => {
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

    it('follows next_cursor from skip 0 to the end of the match, every record once', async () => {
      const upstream = openFdaWalk(12);
      http.route({ match: () => true, respond: upstream.respond });
      const seen: string[] = [];
      const skips: number[] = [];
      let page: CursorPage | undefined;
      let last: Awaited<ReturnType<typeof runToolContract>> | undefined;

      for (const limit of [5, 4, 3]) {
        last = await runToolContract(tool, {
          ...baseInput,
          limit,
          ...(page?.next_cursor && { cursor: page.next_cursor }),
        });
        page = last.structuredContent as unknown as CursorPage;
        skips.push(page.meta.skip);
        seen.push(...page.results.map((r) => String(r.id)));
        if (!page.next_cursor) break;
      }

      expect(seen).toEqual(upstream.ids);
      expect(skips).toEqual([0, 5, 9]);
      // The last page was exactly full and openFDA still linked it: no next_cursor from it.
      expect(page?.next_cursor).toBeUndefined();
      expect(page?.notice).toContain('so the cursor walk is complete.');
      expect(textOfResult(last!)).toContain('so the cursor walk is complete.');

      expect(http.calls).toHaveLength(3);
      const sent = http.calls.map((call) => params(call.request));
      expect(sent.map((q) => q.get('search_after'))).toEqual([null, '0=doc-004', '0=doc-008']);
      expect(sent.map((q) => q.get('skip'))).toEqual(['0', '0', '0']);
      for (const q of sent.slice(1)) {
        expect(q.get('search')).toBe(sent[0]!.get('search'));
        expect(q.get('sort')).toBe(sent[0]!.get('sort'));
      }
    });

    it('issues no next_cursor on a page read at skip > 0, whose link pages by skip', async () => {
      http.route({ match: () => true, respond: openFdaWalk(12).respond });

      const result = await runToolContract(tool, { ...baseInput, limit: 3, skip: 3 });

      const page = result.structuredContent as unknown as CursorPage;
      expect(page.results).toHaveLength(3);
      expect(page.next_cursor).toBeUndefined();
      expect(textOfResult(result)).not.toContain('next_cursor:');
    });

    it('takes the past-end recovery when a cursor page answers 404, and says the walk ended', async () => {
      http.route({ match: () => true, once: true, respond: openFdaWalk(12).respond });
      const first = await runToolContract(tool, { ...baseInput, limit: 5 });
      const { next_cursor } = first.structuredContent as unknown as CursorPage;
      // The match shrank to 4 records before the next page was read.
      http.route({ match: isPage, respond: NO_MATCHES }, { match: isRecovery, respond: TOTAL(4) });

      const result = await runToolContract(tool, { ...baseInput, limit: 5, cursor: next_cursor });

      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(3);
      expect(params(http.calls[1]!.request).get('search_after')).toBe('0=doc-004');
      const recovery = params(http.calls[2]!.request);
      expect(recovery.has('search_after')).toBe(false);
      expect(recovery.get('limit')).toBe('0');

      const page = result.structuredContent as unknown as CursorPage;
      expect(page.meta).toMatchObject({ skip: 5, total: 4 });
      expect(page.next_cursor).toBeUndefined();
      expect(page.notice).toContain(
        'No records at this cursor: its walk position (5) is past the last of the 4 matched records',
      );
      const text = textOfResult(result);
      expect(text).toContain('4 matched, but skip=5 is past the end');
      expect(text).not.toMatch(/^No .* found\.$/m);
    });
  },
);

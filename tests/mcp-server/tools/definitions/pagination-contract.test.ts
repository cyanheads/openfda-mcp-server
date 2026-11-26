/**
 * @fileoverview Reachability of the `pagination_limit_reached` contract (#27).
 *
 * Exercised at the public tool boundary — `input.parse()` then `handler()`, the
 * same two steps the framework's handler factory runs — because the defect was
 * that schema validation rejected an over-ceiling `skip` before the handler
 * could produce the declared reason. A service-level test cannot see that: the
 * service classifies openFDA's own 400 correctly and always did.
 * @module tests/mcp-server/tools/definitions/pagination-contract.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { OPENFDA_MAX_SKIP, paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import type { OpenFdaQueryParams } from '@/services/openfda/types.js';
import { toolsWithInput } from '../../../helpers/tool-registry.js';

const mockQuery = vi.fn();

/** Minimal valid input per paginated tool, before defaults are applied. */
const PAGINATED_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAnimalEventsTool, {}],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDrugApprovalsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [searchTobaccoReportsTool, {}],
  [lookupNdcTool, { search: 'aspirin' }],
  [getDrugLabelTool, { search: 'openfda.brand_name:"aspirin"' }],
] as const;

it('PAGINATED_TOOLS has a row for exactly the tools that take skip (#116)', () => {
  expect(PAGINATED_TOOLS.map(([tool]) => tool.name).sort()).toEqual(toolsWithInput('skip'));
});

describe.each(PAGINATED_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — pagination_limit_reached contract',
  (_name, tool, baseInput) => {
    beforeEach(() => {
      mockQuery.mockReset();
      vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    });

    it('declares the reason', () => {
      expect(tool.errors?.map((e) => e.reason)).toContain('pagination_limit_reached');
    });

    it('raises the declared reason and recovery for an over-ceiling skip', async () => {
      // The contract runner applies the framework's declared-recovery fill, as production does.
      const result = await runToolContract(tool as AnyToolDefinition, {
        ...baseInput,
        skip: OPENFDA_MAX_SKIP + 1,
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as {
        error: { message: string; data?: { reason?: string; recovery?: { hint?: string } } };
      };
      expect(error.data?.reason).toBe('pagination_limit_reached');
      expect(error.data?.recovery?.hint).toEqual(
        tool.errors?.find((e) => e.reason === 'pagination_limit_reached')?.recovery,
      );
      expect(error.message).toContain(String(OPENFDA_MAX_SKIP));
      // The ceiling is decided locally — no upstream request is spent on it.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts skip at the ceiling', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: OPENFDA_MAX_SKIP, limit: 10, lastUpdated: '2026-07-01' },
        results: [],
      });

      const parsed = tool.input.parse({ ...baseInput, skip: OPENFDA_MAX_SKIP });
      await expect(
        (tool.handler as (i: unknown, c: unknown) => Promise<unknown>)(parsed, ctx),
      ).resolves.toBeDefined();
      expect(mockQuery).toHaveBeenCalled();
    });
  },
);

/**
 * #92 — a limit above the cap at the ceiling is clamped, not refused, and the
 * clamp notice says the next page lies past the ceiling rather than naming a
 * `skip` that would fail. `openfda_get_drug_label`'s clamp is wired in its own suite.
 */
describe.each(
  PAGINATED_TOOLS.filter(([tool]) => tool !== getDrugLabelTool).map(
    ([tool, input]) => [tool.name, tool, input] as const,
  ),
)('%s — a clamped page at the pagination ceiling', (_name, tool, baseInput) => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  it('pages skip=25000 at the cap and names the ceiling as the next page', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 30_000, skip: OPENFDA_MAX_SKIP, limit: 2, lastUpdated: '2026-07-01' },
      results: [{ report_id: 'r-1' }, { report_id: 'r-2' }],
    });

    const result = await runToolContract(tool as AnyToolDefinition, {
      ...baseInput,
      skip: OPENFDA_MAX_SKIP,
      limit: 5_000,
    });
    const { notice } = result.structuredContent as { notice?: string };

    expect(result.isError).toBeFalsy();
    expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ skip: OPENFDA_MAX_SKIP });
    expect(mockQuery.mock.calls[0]?.[1]?.limit).toBeLessThan(5_000);
    expect(notice).toContain('limit=5000 is above the');
    expect(notice).toContain(
      `The next page would start at skip=${OPENFDA_MAX_SKIP + 2}, past openFDA's ${OPENFDA_MAX_SKIP}-record pagination ceiling`,
    );
  });
});

describe('openfda_count_values — no skip input', () => {
  it('does not advertise a contract it cannot reach (#27)', () => {
    expect(Object.keys(countValuesTool.input.shape)).not.toContain('skip');
    expect(countValuesTool.errors?.map((e) => e.reason)).not.toContain('pagination_limit_reached');
  });

  it('takes no cursor and returns none (#97)', () => {
    expect(Object.keys(countValuesTool.input.shape)).not.toContain('cursor');
    expect(Object.keys(countValuesTool.output.shape)).not.toContain('next_cursor');
  });
});

/* --- the search_after cursor (#97) --- */

/**
 * One row per tool that takes `cursor`. The token itself — decode, binding,
 * issue rules — is tabled once in pagination-cursor.test.ts; these prove each
 * handler's wiring: the query it binds is the one it sends, `searchAfter`
 * reaches the request, `next_cursor` reaches both surfaces, and a cursor it
 * cannot use fails before any request. Adding a tool is one row.
 */
interface CursorRow {
  /** The sort the tool sends for `input` when the call names none, if it applies one. */
  defaultSort?: string;
  /** Minimal valid input, before defaults are applied. */
  input: Record<string, unknown>;
  /** The output-shaping input the next page adds; `{ fields: ['id'] }` when omitted. */
  nextPage?: Record<string, unknown>;
  /** An input change that selects another endpoint, for a tool whose endpoint follows an input. */
  otherEndpoint?: Record<string, unknown>;
  /** A URL-form `+`-separated search the schema rewrites, and the spaced form it sends. */
  plusSearch?: readonly [sent: string, spaced: string];
  /** Whether the tool takes `stage` and `canvas_id`. */
  stages: boolean;
  tool: AnyToolDefinition;
}

const CURSOR_TOOLS: readonly CursorRow[] = [
  {
    tool: searchTobaccoReportsTool as AnyToolDefinition,
    input: {},
    defaultSort: 'date_submitted:desc',
    stages: true,
    plusSearch: [
      'tobacco_products:"Electronic cigarette"+AND+nonuser_affected:"Yes"',
      'tobacco_products:"Electronic cigarette" AND nonuser_affected:"Yes"',
    ],
  },
  {
    tool: searchDrugShortagesTool as AnyToolDefinition,
    input: {},
    defaultSort: 'update_date:desc',
    stages: true,
    plusSearch: [
      'status:"Current"+AND+therapeutic_category:"Oncology"',
      'status:"Current" AND therapeutic_category:"Oncology"',
    ],
  },
  {
    tool: searchRecallsTool as AnyToolDefinition,
    input: { category: 'drug' },
    defaultSort: 'report_date:desc',
    stages: true,
    otherEndpoint: { category: 'food' },
    plusSearch: [
      'classification:"Class I"+AND+status:"Ongoing"',
      'classification:"Class I" AND status:"Ongoing"',
    ],
  },
  {
    tool: searchAdverseEventsTool as AnyToolDefinition,
    input: { category: 'drug' },
    defaultSort: 'receivedate:desc',
    stages: true,
    otherEndpoint: { category: 'cosmetic' },
    plusSearch: [
      'patient.drug.medicinalproduct:"aspirin"+AND+serious:"1"',
      'patient.drug.medicinalproduct:"aspirin" AND serious:"1"',
    ],
  },
  {
    tool: lookupNdcTool as AnyToolDefinition,
    input: { search: 'aspirin' },
    stages: true,
    otherEndpoint: { dataset: 'nsde' },
    plusSearch: [
      'brand_name:"aspirin"+AND+dosage_form:"TABLET"',
      'brand_name:"aspirin" AND dosage_form:"TABLET"',
    ],
  },
  {
    tool: searchDeviceClearancesTool as AnyToolDefinition,
    input: { pathway: '510k' },
    defaultSort: 'decision_date:desc',
    stages: true,
    otherEndpoint: { pathway: 'pma' },
    plusSearch: [
      'applicant:"medtronic"+AND+product_code:"DXN"',
      'applicant:"medtronic" AND product_code:"DXN"',
    ],
  },
  {
    tool: searchDrugApprovalsTool as AnyToolDefinition,
    input: {},
    defaultSort: 'submissions.submission_status_date:desc',
    stages: true,
    otherEndpoint: { dataset: 'crl' },
    plusSearch: [
      'sponsor_name:"PFIZER"+AND+submissions.submission_type:"ORIG"',
      'sponsor_name:"PFIZER" AND submissions.submission_type:"ORIG"',
    ],
  },
  {
    tool: searchAnimalEventsTool as AnyToolDefinition,
    input: {},
    defaultSort: 'original_receive_date:desc',
    stages: true,
    plusSearch: [
      'animal.species:"Dog"+AND+serious_ae:"true"',
      'animal.species:"Dog" AND serious_ae:"true"',
    ],
  },
  {
    tool: getDrugLabelTool as AnyToolDefinition,
    input: { search: 'openfda.brand_name:"aspirin"' },
    stages: false,
    nextPage: { sections: ['id'] },
    plusSearch: [
      'openfda.brand_name:"aspirin"+AND+openfda.route:"ORAL"',
      'openfda.brand_name:"aspirin" AND openfda.route:"ORAL"',
    ],
  },
];

it('CURSOR_TOOLS has a row for exactly the tools that take cursor, staging where the tool takes stage (#116)', () => {
  const staging = toolsWithInput('stage');
  expect(Object.fromEntries(CURSOR_TOOLS.map((row) => [row.tool.name, row.stages]))).toEqual(
    Object.fromEntries(toolsWithInput('cursor').map((name) => [name, staging.includes(name)])),
  );
});

interface CursorStructured {
  meta: { skip: number; total: number };
  next_cursor?: string;
  notice?: string;
  results: { id?: string }[];
}

interface CursorFailure {
  error: { message: string; data?: { reason?: string; recovery?: { hint?: string } } };
}

/**
 * Answer `mockQuery` the way openFDA answers through the service: a request by
 * `search_after` value starts after the record that value names — never at
 * `position`, which comes back only as `meta.skip` — and every non-empty page
 * links the next, the exactly full last page included. `served` caps each
 * page below the `limit` sent, as a short page would.
 */
function answerLikeOpenFda(total: number, served: readonly number[] = []) {
  const ids = Array.from({ length: total }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
  let call = 0;
  mockQuery.mockImplementation((_endpoint: string, params: OpenFdaQueryParams) => {
    const from = params.searchAfter
      ? ids.indexOf(params.searchAfter.value.replace(/^0=/, '')) + 1
      : (params.skip ?? 0);
    const size = Math.min(params.limit ?? 25, served[call] ?? Number.POSITIVE_INFINITY);
    call += 1;
    const slice = ids.slice(from, from + size);
    return Promise.resolve({
      meta: {
        skip: params.searchAfter?.position ?? params.skip ?? 0,
        total,
        limit: params.limit ?? 25,
        lastUpdated: '2026-11-21',
      },
      results: slice.map((id) => ({ id })),
      ...(slice.length > 0 && { nextSearchAfter: `0=${slice.at(-1)}` }),
    });
  });
  return ids;
}

const textOfCall = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe.each(CURSOR_TOOLS.map((row) => [row.tool.name, row] as const))(
  '%s — cursor contract',
  (_name, row) => {
    const { tool, input } = row;

    beforeEach(() => {
      mockQuery.mockReset();
      vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    });

    /** Read the first page and return its next_cursor; fails when none is issued. */
    async function firstCursor(extra: Record<string, unknown> = {}) {
      const result = await runToolContract(tool, { ...input, ...extra, limit: 5 });
      const { next_cursor } = result.structuredContent as unknown as CursorStructured;
      expect(next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      return next_cursor as string;
    }

    it('declares invalid_cursor and the shared pagination_limit_reached entry', () => {
      expect(tool.errors).toContain(invalidCursorError);
      expect(tool.errors).toContain(paginationLimitReachedError);
    });

    it('issues next_cursor on a skip 0 page, the same token on both surfaces', async () => {
      answerLikeOpenFda(12);

      const result = await runToolContract(tool, { ...input, limit: 5 });

      const structured = result.structuredContent as unknown as CursorStructured;
      expect(result.isError).toBeFalsy();
      expect(structured.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(textOfCall(result)).toContain(`\nnext_cursor: \`${structured.next_cursor}\`\n`);
    });

    it('follows next_cursor with the query it was issued for, and no skip', async () => {
      answerLikeOpenFda(12);
      const cursor = await firstCursor();

      await runToolContract(tool, { ...input, limit: 5, cursor });

      const [first, second] = mockQuery.mock.calls;
      expect(second?.[0]).toBe(first?.[0]);
      expect(second?.[1]).toMatchObject({
        search: first?.[1].search,
        sort: first?.[1].sort,
        searchAfter: { value: '0=doc-004', position: 5 },
      });
      expect(second?.[1].skip ?? 0).toBe(0);
    });

    it('walks the match once, in order, across a clamp and short pages', async () => {
      // 12 records: limit 3, then a clamped limit the fake serves only 4 of, then 2, then 5.
      const ids = answerLikeOpenFda(12, [3, 4, 2, 5]);
      const seen: string[] = [];
      const skips: number[] = [];
      const notices: (string | undefined)[] = [];
      let last: Awaited<ReturnType<typeof runToolContract>> | undefined;
      let cursor: string | undefined;

      for (const limit of [3, 1_000_000, 2, 5]) {
        last = await runToolContract(tool, { ...input, limit, ...(cursor && { cursor }) });
        const structured = last.structuredContent as unknown as CursorStructured;
        skips.push(structured.meta.skip);
        notices.push(structured.notice);
        seen.push(...structured.results.map((r) => String(r.id)));
        cursor = structured.next_cursor;
        if (!cursor) break;
      }

      expect(skips).toEqual([0, 3, 7, 9]);
      expect(seen).toEqual(ids);
      // The clamp notice counts from the walk position and the 4 records served, not the cap.
      expect(notices[1]).toMatch(/limit=1000000 is above the \d+-record cap/);
      expect(notices[1]).toContain('The next page starts at skip=7.');
      // The last page holds the last 3 records: no next_cursor, and the walk says so on both surfaces.
      expect(cursor).toBeUndefined();
      expect(notices[3]).toContain(
        'This page holds the last 3 of the 12 matched records, so the cursor walk is complete.',
      );
      expect(textOfCall(last!)).toContain('so the cursor walk is complete.');
      expect(textOfCall(last!)).not.toContain('next_cursor:');
    });

    it('says the walk has ended on an empty cursor page past the end, never a no-match', async () => {
      answerLikeOpenFda(12);
      const cursor = await firstCursor();
      mockQuery.mockResolvedValueOnce({
        meta: { skip: 5, total: 4, limit: 5, lastUpdated: '2026-11-21' },
        results: [],
      });

      const result = await runToolContract(tool, { ...input, limit: 5, cursor });

      const structured = result.structuredContent as unknown as CursorStructured;
      expect(structured.notice).toContain(
        'No records at this cursor: its walk position (5) is past the last of the 4 matched records',
      );
      expect(textOfCall(result)).not.toMatch(/^No .* found\.$/m);
      expect(textOfCall(result)).toContain('4 matched, but skip=5 is past the end');
    });

    if (row.plusSearch) {
      const [sent, spaced] = row.plusSearch;
      it('accepts its own continuation for a search the schema rewrites, in either form', async () => {
        answerLikeOpenFda(12);
        const cursor = await firstCursor({ search: sent });

        for (const search of [sent, spaced]) {
          const result = await runToolContract(tool, { ...input, search, limit: 5, cursor });
          expect(result.isError).toBeFalsy();
        }
        expect(mockQuery.mock.calls.map((call) => call[1].search)).toEqual([
          spaced,
          spaced,
          spaced,
        ]);
      });
    }

    if (row.defaultSort) {
      const { defaultSort } = row;
      it('binds the cursor to the default sort it sent, which the next call may name', async () => {
        answerLikeOpenFda(12);
        const cursor = await firstCursor();

        const result = await runToolContract(tool, {
          ...input,
          limit: 5,
          cursor,
          sort: defaultSort,
        });

        expect(result.isError).toBeFalsy();
        expect(mockQuery.mock.calls.map((call) => call[1].sort)).toEqual([
          defaultSort,
          defaultSort,
        ]);
      });
    }

    it('accepts a different limit and fields on the next page', async () => {
      answerLikeOpenFda(12);
      const cursor = await firstCursor();

      const result = await runToolContract(tool, {
        ...input,
        limit: 2,
        ...(row.nextPage ?? { fields: ['id'] }),
        cursor,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as unknown as CursorStructured;
      expect(structured.results.map((r) => r.id)).toEqual(['doc-005', 'doc-006']);
    });

    const refusals: [string, Record<string, unknown>, string][] = [
      ['skip above 0', { skip: 5 }, 'skip=5'],
      ['another search', { search: 'id:"other"' }, 'different endpoint, search, or sort'],
      ['another sort', { sort: 'id:asc' }, 'different endpoint, search, or sort'],
      ['a token it did not issue', { cursor: 'bm90IGEgdG9rZW4' }, 'does not decode'],
      ...(row.stages
        ? ([
            ['stage=true', { stage: true }, 'stage=true'],
            ['a canvas_id', { canvas_id: 'cv_0000000' }, 'canvas_id'],
          ] as [string, Record<string, unknown>, string][])
        : []),
      ...(row.otherEndpoint
        ? ([['another endpoint', row.otherEndpoint, 'different endpoint, search, or sort']] as [
            string,
            Record<string, unknown>,
            string,
          ][])
        : []),
    ];

    it.each(refusals)(
      'refuses a cursor with %s before any request',
      async (_case, change, fault) => {
        answerLikeOpenFda(12);
        const cursor = await firstCursor();

        const result = await runToolContract(tool, { ...input, limit: 5, cursor, ...change });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as unknown as CursorFailure;
        expect(error.data?.reason).toBe('invalid_cursor');
        expect(error.data?.recovery?.hint).toBe(invalidCursorError.recovery);
        expect(error.message).toContain(fault);
        expect(mockQuery).toHaveBeenCalledTimes(1);
      },
    );

    it('refuses an empty cursor at argument validation', async () => {
      const result = await runToolContract(tool, { ...input, cursor: '' });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as CursorFailure;
      expect(error.data?.reason).not.toBe('invalid_cursor');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  },
);

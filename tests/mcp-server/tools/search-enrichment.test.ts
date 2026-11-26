/**
 * @fileoverview `enrichSearchPage` at its own seam (#115): the matched total,
 * the query echo, and the notice order on an inline and a staged page, each
 * notice's absence where it does not apply, and the branches the helper picks
 * itself (clamp or cursor end, the empty-result variant, the array-tie route).
 * A probe tool runs it, so both surfaces render as they do for a search tool.
 * Per-tool wiring is asserted in each tool's suite and the cross-tool contract
 * suites; each notice's own wording at its own seam.
 * @module tests/mcp-server/tools/search-enrichment.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { PageSize } from '@/mcp-server/tools/schema-utils.js';
import { enrichSearchPage } from '@/mcp-server/tools/search-enrichment.js';
import { canvasResult, type OpenFdaSpillResult } from '@/services/openfda/canvas-spill.js';

type Call = Parameters<typeof enrichSearchPage>[1];

/** The call the probe hands `enrichSearchPage`, set by each test before it runs. */
let call: Call;

const probe = tool('probe_search_enrichment', {
  description: 'Sets the enrichment of the search page under test.',
  input: z.object({}),
  output: z.object({ ok: z.boolean().describe('Always true.') }),
  enrichment: {
    totalResults: z.number().describe('Total matching records.'),
    effectiveQuery: z.string().optional().describe('The search as sent.'),
    notice: z.string().optional().describe('Guidance for this page.'),
  },
  async handler(_input, ctx) {
    enrichSearchPage(ctx, call);
    return { ok: true };
  },
  format: () => [{ type: 'text' as const, text: 'page' }],
});

/** Both surfaces of the probe's result for `next`. */
async function surfaces(next: Call) {
  call = next;
  const result = await runToolContract(probe, {});
  expect(result.isError).toBeFalsy();
  const structured = result.structuredContent as {
    effectiveQuery?: string;
    notice?: string;
    totalResults: number;
  };
  const trailer = result.content[1];
  return { structured, trailer: trailer?.type === 'text' ? trailer.text : undefined };
}

const META = { lastUpdated: '2026-11-25', limit: 1000 };
const RECORD = { safetyreportid: '1', receivedate: '20260101' };
const noMatch = () => 'No probe records matched.';

const CLAMPED: PageSize = { cap: 1000, clampedFrom: 5000, kind: 'drug/event', limit: 1000 };
const UNCLAMPED: PageSize = { cap: 1000, kind: 'drug/event', limit: 25 };

/** Every disclosure field a page can carry, set together so one page raises them all. */
const DISCLOSED = {
  projected_fields: ['safetyreportid', 'receivedate'],
  omitted_fields: [{ path: 'patient.drug.openfda', bytes: 512 }],
  page_bytes: 30_000,
  page_largest_fields: [{ path: 'patient.drug', bytes: 26_000 }],
};

/** Two AND-ed clauses under `patient.drug`, an array of objects on drug/event. */
const TIED = 'patient.drug.medicinalproduct:"ASPIRIN" AND patient.drug.drugindication:"PAIN"';
const PLUS = 'patient.drug.medicinalproduct:"ASPIRIN+PLUS"';

const EMPTY = 'No probe records matched.';
const PLUS_HINT =
  'A "+" inside a quoted phrase is a literal plus sign, not a space, so `"ASPIRIN+PLUS"` can match only values spelled with one. If its words are meant to be separate, write them with spaces: `"ASPIRIN PLUS"`.';
const CLAMP_NEXT =
  'limit=5000 is above the 1000-record cap for drug/event, so 1000 was applied. The next page starts at skip=1.';
const CLAMP_EMPTY = 'limit=5000 is above the 1000-record cap for drug/event, so 1000 was applied.';
const BLOCKED =
  'openFDA cannot continue a walk sorted by `receivedate:desc` past records that lack the sort field, which sort last, so this page carries no next_cursor though 8 of the 9 matched records follow it. To read on, re-run with skip=1 and the same search and sort, add `_exists_:receivedate` to the search to keep only records that carry it, or sort by another field.';
const PROJECTED =
  "Records projected to the requested fields (`safetyreportid`, `receivedate`) plus each record's identity key; every other field is left out on request.";
const LEFT_OUT =
  'Left out of each record by default: patient.drug.openfda (512 bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.';
const OVERSIZED =
  'Oversized record: the one record on this page serializes to 29998 bytes, over 24000 (page_bytes 30000). Its largest field is patient.drug (26000 bytes); leaving it out brings the record within 24000 bytes. Re-call with fields set to the dotted paths you need (any key path on the record works; openfda_describe_fields lists the searchable ones) to project each record to those paths plus its identity key.';
const STAGED =
  'Staged 9 of 9 matched records on canvas table "spilled_0a1b2c3d" (canvas_id "cv-1"). Call openfda_dataframe_describe for the column names, then openfda_dataframe_query to run SQL over the staged set.';

/** The array-tie notice's head; its route and SQL condition follow, matched per route. */
const TIE_HEAD =
  'openFDA matches each clause against the whole record, so the clauses on `patient.drug.medicinalproduct` and `patient.drug.drugindication` can be met by different `patient.drug` entries. For one entry meeting them together, ';

/** `text` as a regular expression that matches it literally. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An inline page and the response it was cut from: `returned` records from
 * `skip`, of `total`. `disclosed` sets every disclosure field the page can
 * carry — the oversized-record fields only with a record to measure.
 */
function inline(
  skip: number,
  returned: number,
  total: number,
  extra: { blocked?: boolean; disclosed?: boolean; totalUnverified?: true } = {},
) {
  const results = Array.from({ length: returned }, () => ({ ...RECORD }));
  const meta = {
    ...META,
    skip,
    total,
    ...(extra.totalUnverified && { totalUnverified: extra.totalUnverified }),
  };
  const { page_bytes, page_largest_fields, ...cut } = DISCLOSED;
  const disclosed = returned > 0 ? { ...cut, page_bytes, page_largest_fields } : cut;
  return {
    page: { meta, results, ...(extra.disclosed && disclosed) },
    response: {
      meta,
      results,
      ...(extra.blocked && { searchAfterBlocked: 'missing_sort_value' as const }),
    },
  };
}

/** A staged spill over `total` matched records with `preview` inline; staged only when `table` is named. */
function spillOf(
  total: number,
  preview: Record<string, unknown>[],
  table = '',
): OpenFdaSpillResult {
  return {
    canvasId: 'cv-1',
    lastUpdated: META.lastUpdated,
    limit: 1000,
    preview,
    previewOversized:
      preview.length > 0
        ? { page_bytes: DISCLOSED.page_bytes, page_largest_fields: DISCLOSED.page_largest_fields }
        : {},
    previewProjection: {
      projected_fields: DISCLOSED.projected_fields,
      omitted_fields: DISCLOSED.omitted_fields,
    },
    skip: 0,
    spilled: table !== '',
    stagedRows: table ? total : 0,
    tableName: table,
    total,
  };
}

const AFTER = { position: 8, value: '0=20260101;1=abc' };

describe('enrichSearchPage — the notice order', () => {
  it('joins every notice an inline page with records carries, after the total and the echo', async () => {
    const { page, response } = inline(0, 1, 9, { blocked: true, disclosed: true });

    const { structured, trailer } = await surfaces({
      query: { endpoint: 'drug/event', search: TIED, sort: 'receivedate:desc' },
      page,
      size: CLAMPED,
      noMatch,
      response,
      searchAfter: undefined,
    });

    const notice = structured.notice ?? '';
    const lead = `${CLAMP_NEXT} ${BLOCKED} ${PROJECTED} ${LEFT_OUT} ${OVERSIZED} ${TIE_HEAD}`;
    expect(notice).toMatch(
      new RegExp(
        `^${literally(lead)}call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE [^\`]+\`\\.$`,
      ),
    );
    expect(structured).toEqual({ ok: true, totalResults: 9, effectiveQuery: TIED, notice });
    expect(trailer).toBe(`\n\n**totalResults:** 9\nQuery: \`${TIED}\`\n> ${notice}`);
  });

  it('joins every notice an empty inline page carries, the empty result first', async () => {
    const { page, response } = inline(0, 0, 0, { blocked: true, disclosed: true });

    const { structured, trailer } = await surfaces({
      query: { endpoint: 'drug/event', search: PLUS, sort: 'receivedate:desc' },
      page,
      size: CLAMPED,
      noMatch,
      response,
      searchAfter: undefined,
    });

    const notice = `${EMPTY} ${PLUS_HINT} ${CLAMP_EMPTY} ${PROJECTED} ${LEFT_OUT}`;
    expect(structured).toEqual({ ok: true, totalResults: 0, effectiveQuery: PLUS, notice });
    expect(trailer).toBe(`\n\n**totalResults:** 0\nQuery: \`${PLUS}\`\n> ${notice}`);
  });

  it('joins every notice a staged page with records carries, staging before the tie', async () => {
    const spill = spillOf(9, [{ ...RECORD }], 'spilled_0a1b2c3d');

    const { structured, trailer } = await surfaces({
      query: { endpoint: 'drug/event', search: TIED, sort: 'receivedate:desc' },
      page: canvasResult(spill),
      size: CLAMPED,
      noMatch,
      spill,
    });

    const notice = structured.notice ?? '';
    const lead = `${CLAMP_NEXT} ${PROJECTED} ${LEFT_OUT} ${OVERSIZED} ${STAGED} ${TIE_HEAD}`;
    expect(notice).toMatch(
      new RegExp(
        `^${literally(lead)}query the staged table in openfda_dataframe_query: \`SELECT \\* FROM spilled_0a1b2c3d t WHERE [^\`]+\`\\.$`,
      ),
    );
    expect(structured).toEqual({ ok: true, totalResults: 9, effectiveQuery: TIED, notice });
    expect(trailer).toBe(`\n\n**totalResults:** 9\nQuery: \`${TIED}\`\n> ${notice}`);
  });

  it('joins every notice an empty staged page carries, the empty result first', async () => {
    const spill = spillOf(0, []);

    const { structured } = await surfaces({
      query: { endpoint: 'drug/event', search: PLUS, sort: 'receivedate:desc' },
      page: canvasResult(spill),
      size: CLAMPED,
      noMatch,
      spill,
    });

    expect(structured.notice).toBe(
      `${EMPTY} ${PLUS_HINT} ${CLAMP_EMPTY} ${PROJECTED} ${LEFT_OUT} Nothing was staged on canvas "cv-1" — 0 records matched.`,
    );
  });
});

describe('enrichSearchPage — the branches it picks', () => {
  it.each([
    [
      'without a clamp',
      UNCLAMPED,
      'This page holds the last 1 of the 9 matched records, so the cursor walk is complete.',
    ],
    [
      'with a clamp, which says it instead',
      CLAMPED,
      'limit=5000 is above the 1000-record cap for drug/event, so 1000 was applied; this page holds the last 1 of the 9 matched records.',
    ],
  ] as const)('ends a cursor walk on its last page %s', async (_name, size, notice) => {
    const { page, response } = inline(8, 1, 9);

    const { structured } = await surfaces({
      query: { endpoint: 'tobacco/problem', search: 'report_id:"1"' },
      page,
      size,
      noMatch,
      response,
      searchAfter: AFTER,
    });

    expect(structured.notice).toBe(notice);
  });

  it.each([
    [
      'a page read by cursor past the end',
      inline(12, 0, 9),
      AFTER,
      'No records at this cursor: its walk position (12) is past the last of the 9 matched records, so the cursor walk has ended. Re-run the call from skip 0 to read them again.',
    ],
    [
      'a skip past the end',
      inline(40, 0, 9),
      undefined,
      'No records at skip=40: 9 matched, so the offset is past the end of the result set. Lower skip to read them.',
    ],
    [
      'a zero total that could not be verified',
      inline(50, 0, 0, { totalUnverified: true }),
      undefined,
      'No results at skip=50. Either no records match or pagination ran past the end of the result set — try skip=0 to confirm. No probe records matched.',
    ],
    ['a search that matched nothing', inline(0, 0, 0), undefined, EMPTY],
  ])('words the empty result for %s', async (_name, { page, response }, searchAfter, notice) => {
    const { structured } = await surfaces({
      query: { endpoint: 'tobacco/problem', search: 'report_id:"1"' },
      page,
      size: UNCLAMPED,
      noMatch,
      response,
      searchAfter,
    });

    expect(structured.notice).toBe(notice);
  });

  it('leaves the way past the ceiling to the blocked notice on a clamped page openFDA cannot continue', async () => {
    const { page, response } = inline(25_998, 1, 26_009, { blocked: true });

    const { structured } = await surfaces({
      query: { endpoint: 'drug/event', sort: 'receivedate:desc' },
      page,
      size: CLAMPED,
      noMatch,
      response,
      searchAfter: { position: 25_998, value: '0=20260101;1=abc' },
    });

    expect(structured.notice).toBe(
      "limit=5000 is above the 1000-record cap for drug/event, so 1000 was applied. The next page would start at skip=25999, past openFDA's 25000-record pagination ceiling. openFDA cannot continue a walk sorted by `receivedate:desc` past records that lack the sort field, which sort last, so this page carries no next_cursor though 10 of the 26009 matched records follow it. To read on, add `_exists_:receivedate` to the search to keep only records that carry it, or sort by another field.",
    );
  });

  it('routes the tie notice on a page read by cursor through a call without it', async () => {
    const { page, response } = inline(8, 1, 12);

    const { structured } = await surfaces({
      query: { endpoint: 'drug/event', search: TIED },
      page,
      size: UNCLAMPED,
      noMatch,
      response,
      searchAfter: AFTER,
    });

    expect(structured.notice).toMatch(
      new RegExp(
        `^${literally(TIE_HEAD)}call again without cursor and with stage: true, and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE [^\`]+\`\\.$`,
      ),
    );
  });

  it('routes the tie notice on a staged call that staged nothing through a new staged call', async () => {
    const spill = spillOf(9, [{ ...RECORD }]);

    const { structured } = await surfaces({
      query: { endpoint: 'drug/event', search: TIED },
      page: { ...canvasResult(spill), page_bytes: undefined, page_largest_fields: undefined },
      size: UNCLAMPED,
      noMatch,
      spill,
    });

    expect(structured.notice).toMatch(
      new RegExp(
        `^${literally(PROJECTED)} ${literally(LEFT_OUT)} Nothing was staged on canvas "cv-1" — 9 records matched\\. ${literally(TIE_HEAD)}call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE [^\`]+\`\\.$`,
      ),
    );
  });
});

describe('enrichSearchPage — what a page does not carry', () => {
  it('sets the total and the echo, and no notice, on a page nothing applies to', async () => {
    const { page, response } = inline(0, 1, 9);

    const { structured, trailer } = await surfaces({
      query: { endpoint: 'tobacco/problem', search: 'report_id:"1"', sort: 'date_submitted:desc' },
      page,
      size: UNCLAMPED,
      noMatch,
      response,
      searchAfter: undefined,
    });

    expect(structured).toEqual({ ok: true, totalResults: 9, effectiveQuery: 'report_id:"1"' });
    expect(trailer).toBe('\n\n**totalResults:** 9\nQuery: `report_id:"1"`');
  });

  it('echoes nothing for a call without a search', async () => {
    const { page, response } = inline(0, 1, 9);

    const { structured, trailer } = await surfaces({
      query: { endpoint: 'tobacco/problem', sort: 'date_submitted:desc' },
      page,
      size: UNCLAMPED,
      noMatch,
      response,
      searchAfter: undefined,
    });

    expect(structured).toEqual({ ok: true, totalResults: 9 });
    expect(trailer).toBe('\n\n**totalResults:** 9');
  });

  it.each([
    [
      'an endpoint the array table has not surveyed',
      'tobacco/problem',
      'tobacco_products.kind:"a" AND tobacco_products.size:"b"',
      false,
    ],
    [
      'an array holding one entry per record',
      'drug/orangebook',
      'products.brand_name:"ELIQUIS" AND products.dosage_form:"TABLET"',
      false,
    ],
    [
      'the same array where it holds several entries',
      'drug/drugsfda',
      'products.brand_name:"ELIQUIS" AND products.dosage_form:"TABLET"',
      true,
    ],
  ] as const)(
    'raises the tie notice for AND-ed array clauses on %s: %s',
    async (_name, endpoint, search, tied) => {
      const { page, response } = inline(0, 1, 9);

      const { structured } = await surfaces({
        query: { endpoint, search },
        page,
        size: UNCLAMPED,
        noMatch,
        response,
        searchAfter: undefined,
      });

      if (tied) expect(structured.notice).toContain('can be met by different `products` entries');
      else expect(structured.notice).toBeUndefined();
    },
  );
});

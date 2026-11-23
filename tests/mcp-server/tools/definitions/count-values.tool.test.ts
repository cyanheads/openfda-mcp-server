import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(() => undefined),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { describeFieldsTool } from '@/mcp-server/tools/definitions/describe-fields.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { getCatalogedEndpoints, OBJECT_ARRAY_PATHS } from '@/mcp-server/tools/field-catalog.js';
import { phrasePlusHint } from '@/mcp-server/tools/search-expression.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { codeLiteralsIn, renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_count_values', () => {
  let ctx: ReturnType<typeof createMockContext<typeof countValuesTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: countValuesTool.errors });
  });

  /**
   * #16 — openfda_count_values and openfda_describe_fields take the same
   * endpoints: the count tool's own list is the cataloged set, so every
   * countable endpoint has the count forms the service classifies against.
   */
  it('accepts exactly the endpoints openfda_describe_fields describes', () => {
    const countEndpoints = [...countValuesTool.input.shape.endpoint.options].sort();
    expect(countEndpoints).toEqual([...getCatalogedEndpoints()].sort());
    expect([...describeFieldsTool.input.shape.endpoint.options].sort()).toEqual(countEndpoints);
  });

  it('passes count param to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
      ],
    });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/event',
        count: 'patient.reaction.reactionmeddrapt.exact',
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ count: 'patient.reaction.reactionmeddrapt.exact' }),
      ctx,
    );
    expect(result.results).toEqual([
      { term: 'NAUSEA', count: 100 },
      { term: 'FATIGUE', count: 50 },
    ]);
  });

  it('coerces term to string', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [{ term: 2026, count: 5 }],
    });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({ endpoint: 'drug/event', count: 'receivedate' }),
      ctx,
    );

    expect(result.results[0]!.term).toBe('2026');
  });

  // Term rows arrive ranked by openFDA; only date buckets are re-ranked (#78).
  it('keeps term rows in the order openFDA ranked them', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'B', count: 5 },
        { term: 'A', count: 5 },
        { term: 'C', count: 9 },
      ],
    });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({ endpoint: 'drug/event', count: 'serious', limit: 3 }),
      ctx,
    );

    expect(result.results.map((r) => r.term)).toEqual(['B', 'A', 'C']);
  });

  // #78 — a date field answers with `{ time, count }` rows.
  it('maps a date bucket to its date and ranks the buckets by count', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { time: '20240103', count: 5 },
        { time: '20240110', count: 8 },
      ],
    });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({ endpoint: 'drug/event', count: 'receivedate' }),
      ctx,
    );

    expect(result.results).toEqual([
      { term: '20240110', count: 8 },
      { term: '20240103', count: 5 },
    ]);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('populates enrichment.termCount', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
      ],
    });

    await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/event',
        count: 'patient.reaction.reactionmeddrapt.exact',
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.termCount).toBe(2);
  });

  // #44 — exactly `limit` terms is an exhaustive list, not a capped one.
  it('omits truncation when exactly limit terms come back', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
      ],
    });

    await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/event',
        count: 'patient.reaction.reactionmeddrapt.exact',
        limit: 2,
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('discloses truncation when the look-ahead term past the limit comes back', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 100 },
        { term: 'FATIGUE', count: 50 },
        { term: 'HEADACHE', count: 20 },
      ],
    });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/event',
        count: 'patient.reaction.reactionmeddrapt.exact',
        limit: 2,
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ limit: 3 }),
      ctx,
    );
    expect(result.results).toHaveLength(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
    expect(enrichment.truncationCeiling).toBe(50);
  });

  it('omits truncation when fewer terms than the limit are returned', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-01-01' },
      results: [{ term: 'NAUSEA', count: 100 }],
    });

    await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/event',
        count: 'patient.reaction.reactionmeddrapt.exact',
        limit: 100,
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
  });

  // An empty tally now carries one meaning only: the expression aggregates and the
  // filter matched nothing. A non-aggregatable expression throws from the service
  // (#34), so the notice points at the filter instead of blaming the field name.
  it('sets enrichment.notice and returns empty results when no terms match', async () => {
    mockQuery.mockResolvedValue({ meta: { lastUpdated: '' }, results: [] });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/ndc',
        count: 'dosage_form.exact',
        search: 'brand_name:"zzznotreal"',
      }),
      ctx,
    );

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/nothing matched/i);
    expect(enrichment.notice).toContain('brand_name:"zzznotreal"');
    expect(enrichment.termCount).toBe(0);
  });

  // #57 — the service marks an empty tally whose matched records carry no value
  // for the field; that is not "nothing matched", and the notice says which.
  it('says the matched records carry no value when the service flags nothingToCount', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '2026-09-18', nothingToCount: true },
      results: [],
    });

    const result = await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/enforcement',
        count: 'openfda.generic_name.exact',
        search: '_missing_:openfda.generic_name',
      }),
      ctx,
    );

    expect(result.results).toEqual([]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.termCount).toBe(0);
    expect(enrichment.notice).toContain('openfda.generic_name.exact');
    expect(enrichment.notice).toMatch(/carry no value/i);
    expect(enrichment.notice).toContain('_missing_:openfda.generic_name');
    expect(enrichment.notice).not.toMatch(/nothing matched/i);
  });

  it('formats as markdown table', () => {
    const content = countValuesTool.format!({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'NAUSEA', count: 1000 },
        { term: 'FATIGUE', count: 500 },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('| # | Term | Count |');
    expect(text).toContain('NAUSEA');
    expect(text).toContain('FATIGUE');
    expect(text).toContain('2 terms');
  });

  it('formats empty results with the dataset date ahead of the empty-tally line (#68)', () => {
    const content = countValuesTool.format!({
      meta: { lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 terms** (total occurrences: 0) | Data updated: 2026-07-31\n\nNo count results.',
    );
  });

  // Issue #34 — a non-aggregatable count expression is a fixable query error, so it
  // reaches the caller as a distinct declared failure rather than an empty tally.
  describe('not_aggregatable (#34)', () => {
    it('declares the reason in the error contract with a recovery hint', () => {
      const entry = countValuesTool.errors?.find((e) => e.reason === 'not_aggregatable');

      expect(entry).toBeDefined();
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(entry?.recovery).toMatch(/\.exact/);
    });

    it('surfaces the service error instead of an empty result', async () => {
      mockQuery.mockRejectedValue(
        validationError('openFDA cannot aggregate "product_ndc.exact" on drug/ndc.', {
          reason: 'not_aggregatable',
        }),
      );

      const err = (await Promise.resolve(
        countValuesTool.handler(
          { endpoint: 'drug/ndc', count: 'product_ndc.exact', limit: 2 },
          ctx,
        ),
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    // #40 — the mirror-image direction. Counting an analyzed text field without
    // .exact used to arrive as a generic query_error advising the caller to check
    // a field name that was already correct.
    it('carries the add-.exact direction to the caller as the same declared reason', async () => {
      mockQuery.mockRejectedValue(
        validationError(
          'openFDA cannot aggregate "classification" on drug/enforcement: it is an analyzed text field. Retry with "classification.exact" to tally whole values.',
          { reason: 'not_aggregatable', endpoint: 'drug/enforcement', count: 'classification' },
        ),
      );

      const err = (await Promise.resolve(
        countValuesTool.handler(
          { endpoint: 'drug/enforcement', count: 'classification', limit: 5 },
          ctx,
        ),
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({ reason: 'not_aggregatable' });
      expect(err.message).toContain('"classification.exact"');
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    // The declared recovery has to cover both directions now that both are
    // reachable — a hint naming only "drop .exact" is wrong half the time.
    it('declares a recovery hint covering both correction directions', () => {
      const recovery = countValuesTool.errors?.find((e) => e.reason === 'not_aggregatable')
        ?.recovery as string;

      expect(recovery).toMatch(/add \.exact/i);
      expect(recovery).toMatch(/drop \.exact/i);
    });

    // #49 — the catalog is the first stop; the suffix toggle is only for fields
    // outside it.
    it('points the declared recovery at the catalog count expression first', () => {
      const recovery = countValuesTool.errors?.find((e) => e.reason === 'not_aggregatable')
        ?.recovery as string;

      expect(recovery).toMatch(/openfda_describe_fields/);
      expect(recovery).toMatch(/countAs/);
    });
  });

  // #81 — caller text in a notice rides as a code literal on both surfaces.
  describe('caller text in the empty-tally notices', () => {
    const COUNT = 'openfda.brand_name.exact';
    const EMPTY = { meta: { lastUpdated: '2026-10-26' }, results: [] };

    /** The notice on both surfaces, and the code literals a CommonMark parse finds in the trailer. */
    async function run(input: { count: string; search?: string }) {
      const result = await runToolContract(countValuesTool, { endpoint: 'drug/label', ...input });
      const notice = String((result.structuredContent as { notice?: string }).notice);
      const html = renderCommonMark(textOf(result.content, result.content.length - 1));
      return { notice, html, literals: codeLiteralsIn(html) };
    }

    it('quotes the field and the search when nothing matched', async () => {
      mockQuery.mockResolvedValue(EMPTY);
      const search = 'openfda.brand_name:*cillin*zzz*';
      const { notice, html, literals } = await run({ count: COUNT, search });

      expect(notice).toContain(
        `\`${COUNT}\` is countable on drug/label, but nothing matched search: \`${search}\`. Broaden`,
      );
      expect(literals).toEqual([COUNT, search]);
      expect(html).not.toMatch(/<em>/);
    });

    it('quotes only the field when an unscoped count is empty', async () => {
      mockQuery.mockResolvedValue(EMPTY);
      const { notice, literals } = await run({ count: COUNT });

      expect(notice).toContain(`\`${COUNT}\` is countable on drug/label, but nothing matched. `);
      expect(literals).toEqual([COUNT]);
    });

    it('quotes the field and the search when the matched records carry no value', async () => {
      mockQuery.mockResolvedValue({ ...EMPTY, meta: { ...EMPTY.meta, nothingToCount: true } });
      const search = '_missing_:openfda.generic_name';
      const { notice, literals } = await run({ count: COUNT, search });

      expect(notice).toContain(`the records matching search: \`${search}\` carry no value`);
      expect(literals).toEqual([COUNT, search]);
    });

    // The search schema sends each line break as a space, so the notice quotes
    // the one-line search openFDA received.
    it('quotes a search holding a line break on one line, the break sent as a space', async () => {
      mockQuery.mockResolvedValue(EMPTY);
      const { notice, html, literals } = await run({
        count: COUNT,
        search: 'openfda.brand_name:"x"\nAND _exists_:openfda',
      });

      const sent = 'openfda.brand_name:"x" AND _exists_:openfda';
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ search: sent });
      expect(notice).toBe(
        '`openfda.brand_name.exact` is countable on drug/label, but nothing matched search: `openfda.brand_name:"x" AND _exists_:openfda`. Broaden or drop the search filter; call openfda_describe_fields for the endpoint field list.',
      );
      expect(literals).toEqual([COUNT, sent]);
      expect(html).not.toContain('<pre>');
    });
  });

  // #75 — the shared search input reads URL-form separators, and an empty tally
  // whose phrase holds a `+` says what that `+` meant.
  describe('shared search input', () => {
    it('sends URL-form + separators as spaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { lastUpdated: '' },
        results: [{ term: 'X', count: 1 }],
      });
      await runToolContract(countValuesTool, {
        endpoint: 'drug/event',
        count: 'serious',
        search: 'occurcountry:"US"+AND+serious:"1"',
      });
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({
        search: 'occurcountry:"US" AND serious:"1"',
      });
    });

    const PLUS_PHRASE = 'patient.reaction.reactionmeddrapt.exact:"INJECTION+SITE+PAIN"';

    it('appends the phrase + hint to a no-match notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({ meta: { lastUpdated: '' }, results: [] });
      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/event',
        count: 'serious',
        search: PLUS_PHRASE,
      });
      const hint = phrasePlusHint(PLUS_PHRASE, 0) as string;
      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toMatch(/nothing matched search: .*\. Broaden/);
      expect(notice.endsWith(` ${hint}`)).toBe(true);
      expect(textOf(result.content, result.content.length - 1)).toContain(hint);
    });

    it('leaves the hint off when the matched records carry no value', async () => {
      mockQuery.mockResolvedValue({ meta: { lastUpdated: '', nothingToCount: true }, results: [] });
      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/event',
        count: 'serious',
        search: PLUS_PHRASE,
      });
      expect(String((result.structuredContent as { notice?: string }).notice)).not.toContain(
        'literal plus sign',
      );
    });
  });

  /**
   * #102 — `drug/shortages` reads an eight-digit date on its four date fields as
   * epoch milliseconds, so a calendar date on one is sent as `YYYY-MM-DD`. The
   * rewrite's forms are tabled at its seam (`shortage-dates.test.ts`); these
   * prove the wiring on this tool.
   */
  describe('shortage dates in search (#102)', () => {
    const TALLY = {
      meta: { lastUpdated: '2026-11-20' },
      results: [{ term: 'Current', count: 385 }],
    };
    const EMPTY = { meta: { lastUpdated: '2026-11-20' }, results: [] };

    it('sends a YYYYMMDD range on drug/shortages as YYYY-MM-DD', async () => {
      mockQuery.mockResolvedValue(TALLY);

      await runToolContract(countValuesTool, {
        endpoint: 'drug/shortages',
        count: 'status',
        search: 'initial_posting_date:[20260101 TO 20261231]',
      });

      expect(mockQuery.mock.calls[0]?.[0]).toBe('drug/shortages');
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({
        search: 'initial_posting_date:[2026-01-01 TO 2026-12-31]',
      });
    });

    it('leaves a YYYYMMDD range on another endpoint as written', async () => {
      mockQuery.mockResolvedValue(TALLY);

      await runToolContract(countValuesTool, {
        endpoint: 'drug/event',
        count: 'serious',
        search: 'receivedate:[20260101 TO 20261231]',
      });

      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({
        search: 'receivedate:[20260101 TO 20261231]',
      });
    });

    it('quotes the search it sent in the no-match notice, on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/shortages',
        count: 'status',
        search: 'update_date:11/20/2026 AND generic_name:"zzz"',
      });

      const sent = 'update_date:"2026-11-20" AND generic_name:"zzz"';
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ search: sent });
      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toBe(
        `\`status\` is countable on drug/shortages, but nothing matched search: \`${sent}\`. Broaden or drop the search filter; call openfda_describe_fields for the endpoint field list.`,
      );
      expect(textOf(result.content, result.content.length - 1)).toContain(`> ${notice}`);
    });

    // A `field:(…)` group's dates are sent as written, so an eight-digit one matches nothing.
    it('says how to write the dates of a date-field group that matched nothing', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/shortages',
        count: 'status',
        search: 'update_date:(20261120 OR 20261119)',
      });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toBe(
        '`status` is countable on drug/shortages, but nothing matched search: `update_date:(20261120 OR 20261119)`. Dates inside the update_date:(...) group are sent as written, so write each one YYYY-MM-DD. Broaden or drop the search filter; call openfda_describe_fields for the endpoint field list.',
      );
      expect(textOf(result.content, result.content.length - 1)).toContain(`> ${notice}`);
    });

    // The guard reads the caller's search, so a position it names counts the caller's characters.
    it('names a refused character at its position in the search as written', async () => {
      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/shortages',
        count: 'status',
        search: 'update_date:20261120 AND generic_name:a;b',
      });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { message: string; data?: unknown } })
        .error;
      expect(error.data).toMatchObject({ reason: 'malformed_search' });
      expect(error.message).toContain('Search query holds ";" at position 40,');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  /**
   * #100 — openFDA tests each clause against the whole record, so a count whose
   * AND-ed clauses fall under one array of objects tallies records where
   * different entries met them. The detector and its SQL are tabled at their
   * seam (`search-clauses.test.ts`); these prove the wiring on this tool.
   */
  describe('clauses one array entry must meet together (#100)', () => {
    const TALLY = { meta: { lastUpdated: '2026-11-20' }, results: [{ term: 'PFIZER', count: 3 }] };
    const EMPTY = { meta: { lastUpdated: '2026-11-20' }, results: [] };
    const TABLE =
      '**1 terms** (total occurrences: 3) | Data updated: 2026-11-20\n\n| # | Term | Count |\n|---|------|-------|\n| 1 | PFIZER | 3 |';
    const NESTED =
      'submissions.submission_type:"ORIG" AND submissions.application_docs.type:"Label"';
    const NESTED_NOTICE = `openFDA matches each clause against the whole record, so the clauses on \`submissions.submission_type\` and \`submissions.application_docs.type\` can be met by different \`submissions\` entries. For one entry meeting them together, stage this search with openfda_search_drug_approvals (stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.submissions, '["json"]')) AS s) WHERE s->>'submission_type' ILIKE '%ORIG%' AND EXISTS (SELECT 1 FROM (SELECT unnest(from_json(s->'application_docs', '["json"]')) AS a) WHERE a->>'type' ILIKE '%Label%'))\`.`;

    const texts = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;

    afterEach(() => {
      vi.mocked(getCanvas).mockReset();
    });

    it('names the drug/drugsfda search tool for a nested submissions.application_docs pair, on both surfaces', async () => {
      mockQuery.mockResolvedValue(TALLY);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/drugsfda',
        count: 'sponsor_name',
        search: NESTED,
      });

      expect(result.structuredContent).toEqual({
        ...TALLY,
        termCount: 1,
        notice: NESTED_NOTICE,
      });
      expect(texts(result)).toEqual([TABLE, `\n\n**termCount:** 1\n> ${NESTED_NOTICE}`]);
    });

    it.each([
      [
        'drug/ndc',
        'active_ingredients.name:"ASPIRIN" AND active_ingredients.strength:"81"',
        `openFDA matches each clause against the whole record, so the clauses on \`active_ingredients.name\` and \`active_ingredients.strength\` can be met by different \`active_ingredients\` entries. For one entry meeting them together, stage this search with openfda_lookup_ndc (stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.active_ingredients, '["json"]')) AS a) WHERE a->>'name' ILIKE '%ASPIRIN%' AND a->>'strength' ILIKE '%81%')\`.`,
      ],
      [
        'drug/event',
        'patient.drug.medicinalproduct:"aspirin" AND patient.drug.drugcharacterization:"1"',
        `openFDA matches each clause against the whole record, so the clauses on \`patient.drug.medicinalproduct\` and \`patient.drug.drugcharacterization\` can be met by different \`patient.drug\` entries. For one entry meeting them together, stage this search with openfda_search_adverse_events (category: "drug", stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(json_extract(t.patient, '$.drug'), '["json"]')) AS d) WHERE d->>'medicinalproduct' ILIKE '%aspirin%' AND d->>'drugcharacterization' ILIKE '%1%')\`.`,
      ],
      [
        'drug/orangebook',
        'patents.patent_number:"1" AND patents.drug_substance_flag:"Y"',
        `openFDA matches each clause against the whole record, so the clauses on \`patents.patent_number\` and \`patents.drug_substance_flag\` can be met by different \`patents\` entries. For one entry meeting them together, stage this search with openfda_search_drug_approvals (dataset: "orangebook", stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.patents, '["json"]')) AS p) WHERE p->>'patent_number' ILIKE '%1%' AND p->>'drug_substance_flag' ILIKE '%Y%')\`.`,
      ],
      [
        'animalandveterinary/event',
        'drug.route:"Oral" AND drug.dosage_form:"Tablet"',
        `openFDA matches each clause against the whole record, so the clauses on \`drug.route\` and \`drug.dosage_form\` can be met by different \`drug\` entries. For one entry meeting them together, stage this search with openfda_search_animal_events (stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '["json"]')) AS d) WHERE d->>'route' ILIKE '%Oral%' AND d->>'dosage_form' ILIKE '%Tablet%')\`.`,
      ],
    ] as const)('names the %s search tool, on both surfaces', async (endpoint, search, notice) => {
      mockQuery.mockResolvedValue(TALLY);

      const result = await runToolContract(countValuesTool, { endpoint, count: 'serious', search });

      expect(result.structuredContent).toEqual({ ...TALLY, termCount: 1, notice });
      expect(texts(result)).toEqual([TABLE, `\n\n**termCount:** 1\n> ${notice}`]);
    });

    // An Orange Book record holds one product, so a pair ties only on the ingredients under it.
    it('names the ingredient array under the one Orange Book product, on both surfaces', async () => {
      mockQuery.mockResolvedValue(TALLY);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/orangebook',
        count: 'serious',
        search:
          'products.active_ingredients.name:"AMLODIPINE BESYLATE" AND products.active_ingredients.strength:"10MG"',
      });

      const notice = `openFDA matches each clause against the whole record, so the clauses on \`products.active_ingredients.name\` and \`products.active_ingredients.strength\` can be met by different \`products.active_ingredients\` entries. For one entry meeting them together, stage this search with openfda_search_drug_approvals (dataset: "orangebook", stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.products, '["json"]')) AS p) WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(p->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%AMLODIPINE BESYLATE%' AND a->>'strength' ILIKE '%10MG%'))\`.`;
      expect(result.structuredContent).toEqual({ ...TALLY, termCount: 1, notice });
      expect(texts(result)).toEqual([TABLE, `\n\n**termCount:** 1\n> ${notice}`]);
    });

    it('joins the notice after the truncation guidance', async () => {
      mockQuery.mockResolvedValue({
        ...TALLY,
        results: [...TALLY.results, { term: 'MERCK', count: 2 }],
      });

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/drugsfda',
        count: 'sponsor_name',
        search: NESTED,
        limit: 1,
      });

      const notice = `Showing the top 1 terms by count; more distinct values exist. Raise limit (max 1000) or narrow with search. ${NESTED_NOTICE}`;
      expect(result.structuredContent).toMatchObject({ truncated: true, shown: 1, notice });
      expect(texts(result).at(-1)).toContain(`> ${notice}`);
    });

    it('joins the notice after the limit clamp on a complete list', async () => {
      mockQuery.mockResolvedValue(TALLY);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/drugsfda',
        count: 'sponsor_name',
        search: NESTED,
        limit: 5_000,
      });

      const notice = String(noticeOf(result));
      expect(notice).toMatch(/^\S.*5000.*1000.*\. openFDA matches each clause/s);
      expect(notice.endsWith(NESTED_NOTICE)).toBe(true);
      expect(notice.match(/openFDA matches each clause/g)).toHaveLength(1);
      expect(texts(result).at(-1)).toContain(`> ${notice}`);
    });

    it.each([
      ['matched nothing', EMPTY],
      [
        'matched records with no value for the field',
        { ...EMPTY, meta: { ...EMPTY.meta, nothingToCount: true } },
      ],
    ])('says nothing about entries when the search %s', async (_case, response) => {
      mockQuery.mockResolvedValue(response);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/drugsfda',
        count: 'sponsor_name',
        search: NESTED,
      });

      expect(result.structuredContent).toMatchObject({ results: [], termCount: 0 });
      expect(String(noticeOf(result))).toContain(
        '`sponsor_name` is countable on drug/drugsfda, but ',
      );
      expect(String(noticeOf(result))).not.toContain('openFDA matches each clause');
    });

    // A count with no conjoined pair under one array returns what it returned before #100.
    it.each([
      [
        'drug/drugsfda',
        'clauses joined by OR',
        'submissions.submission_type:"ORIG" OR submissions.review_priority:"PRIORITY"',
      ],
      [
        'drug/drugsfda',
        'an array clause beside a top-level field',
        'submissions.submission_type:"ORIG" AND sponsor_name:"PFIZER"',
      ],
      [
        'drug/label',
        'an endpoint outside the array table',
        'openfda.brand_name:"X" AND openfda.generic_name:"Y"',
      ],
      [
        'drug/orangebook',
        'two fields of the one product an Orange Book record holds',
        'products.application_number:"210274" AND products.application_type:"N"',
      ],
    ] as const)('returns %s with %s exactly as before', async (endpoint, _case, search) => {
      mockQuery.mockResolvedValue(TALLY);

      const result = await runToolContract(countValuesTool, {
        endpoint,
        count: 'sponsor_name',
        search,
      });

      expect(result.structuredContent).toEqual({ ...TALLY, termCount: 1 });
      expect(texts(result)).toEqual([TABLE, '\n\n**termCount:** 1']);
    });

    // drug/shortages lists no array of objects, so its date rewrite runs with no notice beside it.
    it('rewrites shortage dates and adds no notice, drug/shortages listing no array', async () => {
      expect(OBJECT_ARRAY_PATHS['drug/shortages']).toBeUndefined();
      mockQuery.mockResolvedValue(TALLY);

      const result = await runToolContract(countValuesTool, {
        endpoint: 'drug/shortages',
        count: 'status',
        search: 'initial_posting_date:[20260101 TO 20261231] AND update_date:20261120',
      });

      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({
        search: 'initial_posting_date:[2026-01-01 TO 2026-12-31] AND update_date:"2026-11-20"',
      });
      expect(result.structuredContent).toEqual({ ...TALLY, termCount: 1 });
      expect(texts(result)).toEqual([TABLE, '\n\n**termCount:** 1']);
    });

    /**
     * The route the notice gives works: the tool it names, called with the
     * selector the notice names, stages the counted endpoint into a table
     * holding the column its SQL reads, for every top array of every endpoint
     * the array table lists.
     */
    describe('the search tool it names stages the array as a column', () => {
      /** Endpoint, the tool the notice names, the selector input it names, and that selector as the notice writes it. */
      const STAGERS = [
        ['drug/drugsfda', searchDrugApprovalsTool, {}, ''],
        ['drug/event', searchAdverseEventsTool, { category: 'drug' }, 'category: "drug", '],
        ['device/event', searchAdverseEventsTool, { category: 'device' }, 'category: "device", '],
        ['food/event', searchAdverseEventsTool, { category: 'food' }, 'category: "food", '],
        ['animalandveterinary/event', searchAnimalEventsTool, {}, ''],
        ['drug/ndc', lookupNdcTool, {}, ''],
        [
          'drug/orangebook',
          searchDrugApprovalsTool,
          { dataset: 'orangebook' },
          'dataset: "orangebook", ',
        ],
        [
          'cosmetic/event',
          searchAdverseEventsTool,
          { category: 'cosmetic' },
          'category: "cosmetic", ',
        ],
      ] as const;
      /**
       * Where a top array holds one entry per record, the array under it whose
       * entries a pair can split: an Orange Book record holds one product.
       */
      const PAIRED_UNDER = new Map([['drug/orangebook products', 'products.active_ingredients']]);
      /** Each endpoint's listed arrays with no listed array above them. */
      const cases = STAGERS.flatMap(([endpoint, stager, selector, written]) => {
        const paths = OBJECT_ARRAY_PATHS[endpoint] ?? [];
        return paths
          .filter((path) => !paths.some((outer) => path.startsWith(`${outer}.`)))
          .map((array) => [endpoint, array, stager, selector, written] as const);
      });

      /** A canvas that drains what it is given and records the schema each table was registered with. */
      const stageOnto = () => {
        const schemas: { name: string }[][] = [];
        const instance = {
          canvasId: 'cv_count',
          isNew: true,
          registerTable: vi.fn(
            async (
              name: string,
              rows: AsyncIterable<unknown>,
              options: { schema: { name: string }[] },
            ) => {
              schemas.push(options.schema);
              let rowCount = 0;
              for await (const _row of rows) rowCount++;
              return { tableName: name, rowCount, columns: [] };
            },
          ),
          drop: vi.fn(),
        };
        vi.mocked(getCanvas).mockReturnValue({
          acquire: vi.fn().mockResolvedValue(instance),
        } as never);
        return schemas;
      };

      it('walks every endpoint of the array table, seventeen top arrays', () => {
        expect(STAGERS.map(([endpoint]) => endpoint)).toEqual(Object.keys(OBJECT_ARRAY_PATHS));
        expect(cases.map(([endpoint, array]) => `${endpoint} ${array}`)).toEqual([
          'drug/drugsfda submissions',
          'drug/drugsfda products',
          'drug/event patient.drug',
          'drug/event patient.reaction',
          'device/event device',
          'device/event patient',
          'device/event mdr_text',
          'food/event products',
          'animalandveterinary/event drug',
          'animalandveterinary/event reaction',
          'animalandveterinary/event outcome',
          'drug/ndc active_ingredients',
          'drug/ndc packaging',
          'drug/orangebook products',
          'drug/orangebook patents',
          'drug/orangebook exclusivity',
          'cosmetic/event products',
        ]);
      });

      it.each(cases)('%s %s', async (endpoint, array, stager, selector, written) => {
        const paired = PAIRED_UNDER.get(`${endpoint} ${array}`) ?? array;
        const search = `${paired}.alpha:"x" AND ${paired}.beta:"y"`;
        mockQuery.mockResolvedValue(TALLY);
        const count = await runToolContract(countValuesTool, {
          endpoint,
          count: 'serious',
          search,
        });
        const notice = String(noticeOf(count));
        expect(notice).toContain(`different \`${paired}\` entries`);
        expect(notice).toContain(`stage this search with ${stager.name} (${written}stage: true)`);
        // An array under a plain object (`patient.drug`) is read out of its object column.
        const [column, ...rest] = array.split('.');
        expect(notice).toContain(
          rest.length > 0
            ? `unnest(from_json(json_extract(t.${column}, '$.${rest.join('.')}'), '["json"]'))`
            : `unnest(from_json(t.${array}, '["json"]'))`,
        );

        const schemas = stageOnto();
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({
          meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-11-20' },
          results: [{}],
        });
        const staged = await runToolContract(stager, {
          ...selector,
          search,
          stage: true,
          limit: 1,
        });

        expect(staged.isError).toBeFalsy();
        expect(new Set(mockQuery.mock.calls.map((call) => call[0]))).toEqual(new Set([endpoint]));
        expect(schemas[0]?.map((c) => c.name)).toContain(column);
      });
    });
  });
});

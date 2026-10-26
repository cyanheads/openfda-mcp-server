import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { phrasePlusHint } from '@/mcp-server/tools/schema-utils.js';
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

    it('fences a search holding a line break inside the notice quote', async () => {
      mockQuery.mockResolvedValue(EMPTY);
      const search = 'openfda.brand_name:"x"\nAND _exists_:openfda';
      const { notice, html, literals } = await run({ count: COUNT, search });

      expect(notice).toContain(`nothing matched search: \n\`\`\`\n${search}\n\`\`\`\n. Broaden`);
      expect(literals).toEqual([COUNT, search]);
      expect(html.match(/<blockquote>/g)).toHaveLength(1);
      expect(html).toMatch(/<\/pre>\s*<p>\. Broaden[^<]*<\/p>\s*<\/blockquote>/);
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
});

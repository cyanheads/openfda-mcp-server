import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
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

  it('formats empty results without message', () => {
    const content = countValuesTool.format!({
      meta: { lastUpdated: '' },
      results: [],
    });

    expect(textOf(content)).toBe('No count results.');
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
});

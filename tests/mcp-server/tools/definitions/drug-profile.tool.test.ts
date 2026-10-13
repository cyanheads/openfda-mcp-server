import {
  forbidden,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { drugProfileTool } from '@/mcp-server/tools/definitions/drug-profile.tool.js';
import { findSearchDelimiterFault } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

const meta = (over: Record<string, unknown> = {}) => ({
  total: 0,
  skip: 0,
  limit: 10,
  lastUpdated: '2026-01-01',
  ...over,
});

/**
 * A fully-populated upstream, keyed by endpoint + count expression. The
 * `drug/event` match total (2007) deliberately exceeds the sum of the `serious`
 * buckets (2000): seven reports carry no `serious` value, as real ones do.
 */
function fullUpstream(endpoint: string, params: { count?: string; limit?: number }) {
  if (endpoint === 'drug/label') {
    return {
      meta: meta({ total: 1 }),
      results: [
        {
          set_id: 'spl-abc-123',
          openfda: {
            brand_name: ['Glucophage', 'Glucophage XR'],
            generic_name: ['metformin hydrochloride'],
            product_ndc: ['0087-6060'],
            rxcui: ['860975'],
            spl_set_id: ['spl-abc-123'],
          },
          indications_and_usage: ['Adjunct to diet to improve glycemic control.'],
          warnings: ['Risk of lactic acidosis.'],
          dosage_and_administration: ['Start 500 mg twice daily.'],
        },
      ],
    };
  }
  if (endpoint === 'drug/event' && params.count?.startsWith('patient.reaction')) {
    return {
      meta: meta(),
      results: [
        { term: 'NAUSEA', count: 1200 },
        { term: 'DIARRHOEA', count: 900 },
      ],
    };
  }
  if (endpoint === 'drug/event' && params.count === 'serious') {
    return {
      meta: meta(),
      results: [
        { term: '1', count: 500 },
        { term: '2', count: 1500 },
      ],
    };
  }
  if (endpoint === 'drug/event' && params.count === undefined && params.limit === 0) {
    return { meta: meta({ total: 2007, limit: 0 }), results: [] };
  }
  if (endpoint === 'drug/enforcement') {
    return {
      meta: meta({ total: 1 }),
      results: [
        {
          classification: 'Class II',
          reason_for_recall: 'Failed dissolution specification.',
          recalling_firm: 'Acme Pharma',
          recall_initiation_date: '20240110',
          report_date: '20240115',
        },
      ],
    };
  }
  if (endpoint === 'drug/drugsfda') {
    return {
      meta: meta({ total: 1 }),
      results: [
        {
          application_number: 'NDA020357',
          sponsor_name: 'Bristol Myers Squibb',
          products: [{ marketing_status: 'Prescription' }],
          submissions: [{ submission_status: 'AP' }],
        },
      ],
    };
  }
  if (endpoint === 'drug/shortages') {
    return {
      meta: meta({ total: 1 }),
      results: [{ status: 'Current', availability: 'Limited supply through Q3.' }],
    };
  }
  return { meta: meta(), results: [] };
}

describe('openfda_drug_profile', () => {
  let ctx: ReturnType<typeof createMockContext<typeof drugProfileTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: drugProfileTool.errors });
  });

  it('resolves identity via drug/label and merges all sections', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
      fullUpstream(endpoint, params),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'metformin' }),
      ctx,
    );

    expect(result.meta.resolvedVia).toBe('label');
    expect(result.meta.fanOutKey).toBe('metformin hydrochloride');
    expect(result.identity.generic_name).toBe('metformin hydrochloride');
    expect(result.identity.brand_names).toContain('Glucophage');
    expect(result.identity.rxcui).toBe('860975');
    expect(result.identity.spl_set_id).toBe('spl-abc-123');
    expect(result.label?.indications).toContain('glycemic');
    // The match total, not the serious-bucket sum (2000): reports with no
    // seriousness recorded count toward total only (#63).
    expect(result.adverse_events?.total).toBe(2007);
    expect(result.adverse_events?.seriousCount).toBe(500);
    expect(result.adverse_events?.topReactions[0]).toEqual({ term: 'NAUSEA', count: 1200 });
    const text = textOf(drugProfileTool.format!(result));
    expect(text).toContain('**Total reports:** 2007 | **Serious count:** 500');
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0]!.classification).toBe('Class II');
    expect(result.recalls[0]!.date).toBe('20240110');
    expect(result.approval?.applicationNumber).toBe('NDA020357');
    expect(result.approval?.marketingStatus).toBe('Prescription');
    expect(result.shortage?.status).toBe('Current');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.sectionsFound).toBe(5);
    expect(enrichment.notice).toBeUndefined();
  });

  it('keys structured endpoints off the resolved generic, the free-text AE field off the user term', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
      fullUpstream(endpoint, params),
    );

    await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'Glucophage' }), ctx);

    const calls = mockQuery.mock.calls;
    const structured = calls.filter(([endpoint]) =>
      ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint),
    );
    expect(structured).toHaveLength(3);
    for (const [, params] of structured) {
      expect(params.search).toContain('metformin hydrochloride');
      expect(params.search).not.toContain('Glucophage');
    }

    const events = calls.filter(([endpoint]) => endpoint === 'drug/event');
    expect(events).toHaveLength(3);
    for (const [, params] of events) {
      expect(params.search).toBe('patient.drug.medicinalproduct:"Glucophage"');
    }
    // The total is a records search for the same match, asking for no records.
    expect(events.map(([, params]) => params)).toContainEqual({
      search: 'patient.drug.medicinalproduct:"Glucophage"',
      limit: 0,
    });

    // The profile's own sorts stay in the lowercase form openFDA honours (#64).
    const sortOf = (endpoint: string) => calls.find(([e]) => e === endpoint)?.[1]?.sort;
    expect(sortOf('drug/enforcement')).toBe('report_date:desc');
    expect(sortOf('drug/shortages')).toBe('update_date:desc');
  });

  it('is best-effort: a failing sub-query nulls its section without failing the call', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
      if (endpoint === 'drug/enforcement') throw new Error('boom');
      return fullUpstream(endpoint, params);
    });

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'metformin' }),
      ctx,
    );

    expect(result.recalls).toEqual([]);
    expect(result.label).not.toBeNull();
    expect(result.adverse_events).not.toBeNull();
    expect(getEnrichment(ctx).notice).toMatch(/unavailable|retry/i);
  });

  it('falls back to drug/ndc when no label matches', async () => {
    mockQuery.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'drug/ndc') {
        return {
          meta: meta({ total: 1 }),
          results: [
            {
              brand_name: 'Tylenol',
              generic_name: 'acetaminophen',
              product_ndc: '50580-449',
              openfda: { rxcui: ['198440'] },
            },
          ],
        };
      }
      return { meta: meta(), results: [] };
    });

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'Tylenol' }),
      ctx,
    );

    expect(result.meta.resolvedVia).toBe('ndc');
    expect(result.meta.fanOutKey).toBe('acetaminophen');
    expect(result.identity.generic_name).toBe('acetaminophen');
    expect(result.identity.product_ndc).toBe('50580-449');
    expect(result.identity.rxcui).toBe('198440');
    expect(result.label).toBeNull();
  });

  it('sets a notice when the drug cannot be resolved at all', async () => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'notadrug' }),
      ctx,
    );

    expect(result.meta.resolvedVia).toBe('none');
    expect(result.meta.fanOutKey).toBe('notadrug');
    expect(result.identity.generic_name).toBeNull();
    expect(result.identity.brand_names).toEqual([]);
    expect(getEnrichment(ctx).sectionsFound).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/could not resolve/i);
  });

  it('renders every section header in format(), even when sections are null', () => {
    const content = drugProfileTool.format!({
      meta: { drug: 'mystery', resolvedVia: 'none', fanOutKey: 'mystery' },
      identity: {
        brand_names: [],
        generic_name: null,
        product_ndc: null,
        rxcui: null,
        spl_set_id: null,
      },
      label: null,
      adverse_events: null,
      recalls: [],
      approval: null,
      shortage: null,
      degraded: [],
    });

    const text = textOf(content);
    for (const header of [
      '## Identity',
      '## Label',
      '## Adverse events',
      '## Recalls',
      '## Approval',
      '## Shortage',
    ]) {
      expect(text).toContain(header);
    }
    expect(text).toContain('Drug profile: mystery');
    expect(text).toContain('fan-out key: mystery');
  });

  // Issue #19 — Rx labels carry safety text in boxed_warning / warnings_and_cautions,
  // not the OTC-monograph `warnings` field. The label.warnings mapping falls back
  // through those sections so major Rx drugs stop returning warnings: null.
  const labelOnly = (rec: Record<string, unknown>) => async (endpoint: string) =>
    endpoint === 'drug/label'
      ? { meta: meta({ total: 1 }), results: [rec] }
      : { meta: meta(), results: [] };

  it('populates label.warnings from boxed_warning, which wins over other sections (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        set_id: 'spl-metformin',
        openfda: { generic_name: ['metformin hydrochloride'], brand_name: ['Glucophage'] },
        indications_and_usage: ['Improve glycemic control.'],
        boxed_warning: ['WARNING: LACTIC ACIDOSIS. Postmarketing cases reported.'],
        warnings_and_cautions: ['Monitor renal function.'],
        warnings: ['Generic OTC warning text.'],
        dosage_and_administration: ['Start 500 mg twice daily.'],
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'metformin' }),
      ctx,
    );

    expect(result.label?.warnings).toContain('LACTIC ACIDOSIS');
    expect(result.label?.warnings).not.toContain('OTC warning');
    expect(result.label?.indications).toContain('glycemic');
    expect(result.label?.dosage).toContain('500 mg');
  });

  it('falls back to warnings_and_cautions when the label has no boxed_warning (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        openfda: { generic_name: ['adalimumab'], brand_name: ['Humira'] },
        warnings_and_cautions: ['Serious infections leading to hospitalization.'],
        // no boxed_warning, no `warnings`
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'Humira' }),
      ctx,
    );

    expect(result.label?.warnings).toContain('Serious infections');
  });

  it('still surfaces the OTC-monograph warnings section when it is all the label has (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        openfda: { generic_name: ['ibuprofen'], brand_name: ['Advil'] },
        warnings: ['Stomach bleeding warning.'],
        // no boxed_warning, no warnings_and_cautions (OTC monograph shape)
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'ibuprofen' }),
      ctx,
    );

    expect(result.label?.warnings).toContain('Stomach bleeding');
  });

  it('leaves warnings null when the label carries no warning section at all (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        openfda: { generic_name: ['placebo'], brand_name: ['Placebo'] },
        indications_and_usage: ['No active ingredient.'],
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'placebo' }),
      ctx,
    );

    expect(result.label?.warnings).toBeNull();
    expect(result.label?.indications).toContain('No active');
  });

  // Issue #25 — the schema guards the raw input, but a name made only of delimiter
  // characters survived it and keyed every sub-query off content openFDA cannot
  // match: an unrelated record set returned as a "profile".
  describe('blank fan-out key (#25)', () => {
    it('rejects a drug name with no searchable character, without any upstream request', async () => {
      const failCtx = createMockContext({ errors: drugProfileTool.errors });

      const err = (await Promise.resolve(drugProfileTool.handler({ drug: '"""' }, failCtx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'blank_drug_name' });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('falls back to the input term when the resolved identity yields a blank key', async () => {
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/label'
          ? { meta: meta({ total: 1 }), results: [{ openfda: { generic_name: ['"'] } }] }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.meta.fanOutKey).toBe('metformin');
      const structured = mockQuery.mock.calls.filter(([endpoint]) =>
        ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint),
      );
      expect(structured).toHaveLength(3);
      for (const [, params] of structured) {
        expect(params.search).toContain('metformin');
      }
    });
  });

  /**
   * Issue #42 — the caller's `drug` term is interpolated into seven quoted Lucene
   * phrases. Stripping only `"` left a term ending in `\\` escaping the phrase's own
   * closing quote, so the composed query no longer meant what the tool intended.
   *
   * Both live-verified against api.fda.gov. The two-clause identity resolve was the
   * silent case: `openfda.generic_name:"aspirin\\" OR openfda.brand_name:"aspirin\\"`
   * answers HTTP 200 with total 27101 against 743 for the intended query, because the
   * escaped quote pulls ` OR openfda.brand_name:` inside the phrase and the remainder
   * re-parses as a bare term. The five single-clause sub-queries instead left a phrase
   * open and failed as `token_mgr_error`. Escaping both `\\` and `"` keeps every
   * composed query well-formed with the ` OR ` boundary intact — proven upstream by an
   * escaped no-match first clause leaving the second clause's own total unchanged.
   */
  describe('term escaping in composed queries (#42)', () => {
    /** Every search string the handler sent, across all sub-queries. */
    const sentSearches = () =>
      mockQuery.mock.calls.map(([, params]) => (params as { search: string }).search);

    beforeEach(() => {
      mockQuery.mockResolvedValue({ meta: meta(), results: [] });
    });

    it('escapes a trailing backslash so the OR boundary is not re-parsed', async () => {
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'aspirin\\' }), ctx);

      const resolve = sentSearches().find((s) => s.includes('openfda.generic_name'));
      // The escaped form: the phrase closes on its own quote, so ` OR ` stays an operator.
      expect(resolve).toBe(
        'openfda.generic_name:"aspirin\\\\" OR openfda.brand_name:"aspirin\\\\"',
      );
      // The pre-fix composition, which openFDA answered 200 with unrelated records.
      expect(resolve).not.toBe(
        'openfda.generic_name:"aspirin\\" OR openfda.brand_name:"aspirin\\"',
      );
    });

    it('escapes embedded quotes instead of dropping them from the term', async () => {
      await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'Tylenol "Extra Strength"' }),
        ctx,
      );

      const resolve = sentSearches().find((s) => s.includes('openfda.generic_name'));
      expect(resolve).toBe(
        'openfda.generic_name:"Tylenol \\"Extra Strength\\"" OR openfda.brand_name:"Tylenol \\"Extra Strength\\""',
      );
    });

    it('leaves every composed query with balanced, escape-aware delimiters', async () => {
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'aspirin\\' }), ctx);

      const searches = sentSearches();
      expect(searches.length).toBeGreaterThan(1);
      for (const search of searches) {
        expect(findSearchDelimiterFault(search)).toBeUndefined();
      }
    });

    it('escapes the resolved fan-out key on the structured sub-queries', async () => {
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/label'
          ? {
              meta: meta({ total: 1 }),
              results: [{ openfda: { generic_name: ['odd\\name'], brand_name: ['Odd'] } }],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'odd' }),
        ctx,
      );

      // fanOutKey is reported unescaped — escaping is a query-encoding concern.
      expect(result.meta.fanOutKey).toBe('odd\\name');
      const structured = mockQuery.mock.calls.filter(([endpoint]) =>
        ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint as string),
      );
      expect(structured).toHaveLength(3);
      for (const [, params] of structured) {
        const search = (params as { search: string }).search;
        expect(search).toContain('odd\\\\name');
        expect(findSearchDelimiterFault(search)).toBeUndefined();
      }
    });

    it('keeps a plain term byte-identical to the pre-escape composition', async () => {
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);

      expect(sentSearches()).toContain(
        'openfda.generic_name:"metformin" OR openfda.brand_name:"metformin"',
      );
    });
  });

  // Issue #26 — every section failure used to be swallowed into an empty best-effort
  // result, so an invalid API key was reported as a drug that could not be resolved.
  describe('section failure classification (#26)', () => {
    it('propagates an auth failure instead of reporting an unresolved drug', async () => {
      mockQuery.mockRejectedValue(
        unauthorized('openFDA API key is missing or invalid.', { reason: 'unauthorized' }),
      );

      const err = (await Promise.resolve(drugProfileTool.handler({ drug: 'metformin' }, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('stops before the fan-out when identity resolution fails globally', async () => {
      mockQuery.mockRejectedValue(
        forbidden('Access to this openFDA endpoint is forbidden.', { reason: 'forbidden' }),
      );

      await expect(
        drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx),
      ).rejects.toThrow(McpError);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0]![0]).toBe('drug/label');
    });

    it('propagates cancellation rather than returning a half-built profile', async () => {
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.InternalError, 'Request was aborted.', {
          errorSource: 'FetchAborted',
        }),
      );

      const err = (await Promise.resolve(drugProfileTool.handler({ drug: 'metformin' }, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.message).toMatch(/aborted/i);
    });

    it('reports a per-section failure in structuredContent and content[]', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/enforcement') {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.degraded).toEqual([
        {
          section: 'recalls',
          reason: 'upstream_error',
          message: expect.stringContaining('gateway timeout'),
        },
      ]);
      expect(result.recalls).toEqual([]);
      expect(result.label).not.toBeNull();

      const text = textOf(drugProfileTool.format!(result));
      expect(text).toContain('## Degraded');
      expect(text).toContain('recalls');
      expect(text).toContain('upstream_error');
      expect(text).toContain('gateway timeout');

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('recalls (upstream_error)');
      expect(notice).not.toMatch(/spelling/i);
    });

    it('collapses the three adverse-event sub-queries into one degraded entry', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/event') {
          throw serviceUnavailable('openFDA upstream error: shard failure', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(mockQuery.mock.calls.filter(([endpoint]) => endpoint === 'drug/event')).toHaveLength(
        3,
      );
      expect(result.degraded.map((d) => d.section)).toEqual(['adverse_events']);
      expect(result.adverse_events).toBeNull();
    });

    /**
     * Any one adverse-event sub-query failing leaves the section unknown: no
     * bucket sum or zero stands in for the figure that failed, and the reactions
     * that did arrive are not reported beside a fabricated total (#63).
     */
    it.each([
      ['the match total', (params: { count?: string }) => params.count === undefined],
      ['the serious tally', (params: { count?: string }) => params.count === 'serious'],
      [
        'the reaction tally',
        (params: { count?: string }) => params.count?.startsWith('patient.reaction') === true,
      ],
    ])('nulls adverse_events when %s fails alone', async (_name, failing) => {
      mockQuery.mockImplementation(
        async (endpoint: string, params: { count?: string; limit?: number }) => {
          if (endpoint === 'drug/event' && failing(params)) {
            throw serviceUnavailable('openFDA upstream error: shard failure', {
              reason: 'upstream_error',
            });
          }
          return fullUpstream(endpoint, params);
        },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.adverse_events).toBeNull();
      expect(result.degraded).toEqual([
        {
          section: 'adverse_events',
          reason: 'upstream_error',
          message: expect.stringContaining('shard failure'),
        },
      ]);
      // Every other section still resolves.
      expect(result.label).not.toBeNull();
      expect(result.recalls).toHaveLength(1);
      expect(getEnrichment(ctx).sectionsFound).toBe(4);
      expect(getEnrichment(ctx).notice).toMatch(
        /Partial profile .* adverse_events \(upstream_error\)/,
      );

      const text = textOf(drugProfileTool.format!(result));
      expect(text).toContain('No adverse-event data.');
      expect(text).not.toContain('**Total reports:**');
      expect(text).toContain('## Degraded (1 section)');
    });

    it('propagates cancellation of the match total rather than reporting the section degraded', async () => {
      mockQuery.mockImplementation(
        async (endpoint: string, params: { count?: string; limit?: number }) => {
          if (endpoint === 'drug/event' && params.count === undefined) {
            throw new McpError(JsonRpcErrorCode.InternalError, 'Request was aborted.', {
              errorSource: 'FetchAborted',
            });
          }
          return fullUpstream(endpoint, params);
        },
      );

      const err = (await Promise.resolve(
        drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx),
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.message).toMatch(/aborted/i);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('never blames spelling when every section failed upstream', async () => {
      mockQuery.mockRejectedValue(
        serviceUnavailable('openFDA upstream error: HTTP 503', { reason: 'upstream_error' }),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.meta.resolvedVia).toBe('none');
      expect(getEnrichment(ctx).sectionsFound).toBe(0);
      expect(result.degraded.length).toBeGreaterThan(0);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).not.toMatch(/spelling/i);
      expect(notice).toMatch(/failed upstream/i);
      expect(notice).toMatch(/identity was not resolved/i);
    });

    it('leaves degraded empty on a fully resolved profile', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        fullUpstream(endpoint, params),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.degraded).toEqual([]);
      expect(textOf(drugProfileTool.format!(result))).not.toContain('## Degraded');
    });
  });
});

/**
 * The adverse-event total against the real OpenFdaService, with only the HTTP
 * boundary stubbed: the outgoing `limit=0` request, the total it carries into
 * both response surfaces, and openFDA's no-match 404 (#63).
 */
describe('openfda_drug_profile adverse-event total at the HTTP boundary', () => {
  const http = createFetchMock();
  const NO_MATCHES = () =>
    Response.json({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }, { status: 404 });
  const page = (results: unknown[], total: number) =>
    Response.json({
      meta: { results: { skip: 0, limit: results.length, total }, last_updated: '2026-07-30' },
      results,
    });
  const paramsOf = (req: Request) => new URL(req.url).searchParams;
  const isEvent = (req: Request) => new URL(req.url).pathname === '/drug/event.json';
  const eventRequests = () => http.calls.map((call) => call.request).filter(isEvent);

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/services/openfda/openfda-service.js')>(
      '@/services/openfda/openfda-service.js',
    );
    actual.initOpenFdaService();
    vi.mocked(getOpenFdaService).mockImplementation(actual.getOpenFdaService);
  });

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('reads total from a limit=0 search for the same match, on both surfaces', async () => {
    http.route(
      {
        match: (req) => isEvent(req) && paramsOf(req).get('count') === 'serious',
        respond: () =>
          page(
            [
              { term: 1, count: 293498 },
              { term: 2, count: 139294 },
            ],
            0,
          ),
      },
      {
        match: (req) => isEvent(req) && paramsOf(req).has('count'),
        respond: () => page([{ term: 'NAUSEA', count: 31210 }], 0),
      },
      { match: isEvent, respond: () => page([], 432898) },
      { match: () => true, respond: NO_MATCHES },
    );

    const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

    expect(result.isError).toBeFalsy();
    const totalRequests = eventRequests()
      .map(paramsOf)
      .filter((params) => !params.has('count'));
    expect(totalRequests).toHaveLength(1);
    expect(totalRequests[0]!.get('search')).toBe('patient.drug.medicinalproduct:"metformin"');
    expect(totalRequests[0]!.get('limit')).toBe('0');
    expect(totalRequests[0]!.has('sort')).toBe(false);

    const structured = result.structuredContent as {
      adverse_events: { total: number; seriousCount: number } | null;
      degraded: unknown[];
    };
    expect(structured.adverse_events).toMatchObject({ total: 432898, seriousCount: 293498 });
    expect(structured.degraded).toEqual([]);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('**Total reports:** 432898 | **Serious count:** 293498');
  });

  it('leaves adverse_events null and nothing degraded when drug/event matches nothing', async () => {
    http.route({ match: () => true, respond: NO_MATCHES });

    const result = await runToolContract(drugProfileTool, { drug: 'zzqxnotadrug' });

    expect(result.isError).toBeFalsy();
    expect(eventRequests()).toHaveLength(3);
    const structured = result.structuredContent as {
      adverse_events: unknown;
      degraded: unknown[];
    };
    expect(structured.adverse_events).toBeNull();
    expect(structured.degraded).toEqual([]);
  });

  /**
   * A caller that cancels while a sub-query sleeps between retries. `withRetry`
   * rejects the backoff with the signal's own reason — no `McpError` — so a check
   * keyed on the error's shape files the cancellation as one more degraded
   * section and completes the call. Driven through the real service and the real
   * `withRetry`, on fake timers so the backoff is held open until the abort lands.
   */
  describe('cancellation during a retry backoff', () => {
    const pathOf = (req: Request) => new URL(req.url).pathname;
    const SERVER_ERROR = () =>
      Response.json({ error: { code: 'SERVER_ERROR', message: 'shard failure' } }, { status: 500 });
    const LABEL = () =>
      page(
        [{ set_id: 's-1', openfda: { generic_name: ['metformin'], brand_name: ['Glucophage'] } }],
        1,
      );

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Identity resolution and every sub-query of the fan-out after it. */
    const SUB_QUERIES: Array<[string, (req: Request) => boolean]> = [
      ['the drug/label identity lookup', (req) => pathOf(req) === '/drug/label.json'],
      ['the adverse-event match total', (req) => isEvent(req) && !paramsOf(req).has('count')],
      [
        'the reactions count',
        (req) =>
          isEvent(req) && paramsOf(req).get('count') === 'patient.reaction.reactionmeddrapt.exact',
      ],
      ['the seriousness count', (req) => isEvent(req) && paramsOf(req).get('count') === 'serious'],
      ['the recall search', (req) => pathOf(req) === '/drug/enforcement.json'],
      ['the approval search', (req) => pathOf(req) === '/drug/drugsfda.json'],
      ['the shortage search', (req) => pathOf(req) === '/drug/shortages.json'],
    ];

    it.each(SUB_QUERIES)(
      'reports the call cancelled when the cancel lands while %s backs off',
      async (_label, failing) => {
        vi.useFakeTimers();
        http.route(
          { match: failing, respond: SERVER_ERROR },
          { match: (req) => pathOf(req) === '/drug/label.json', respond: LABEL },
          { match: () => true, respond: NO_MATCHES },
        );
        const controller = new AbortController();
        const pending = runToolContract(
          drugProfileTool,
          { drug: 'metformin' },
          { context: { signal: controller.signal } },
        );

        // Settle every request without moving the clock, so the failed one sits in its backoff.
        const failed = () => http.calls.filter((call) => failing(call.request));
        for (let i = 0; i < 200 && failed().length === 0; i++) await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(0);
        expect(failed()).toHaveLength(1);
        const requestsBeforeCancel = http.calls.length;

        controller.abort();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.RequestCancelled,
        );
        // The retry never fired, and nothing further went upstream once the caller left.
        expect(failed()).toHaveLength(1);
        expect(http.calls).toHaveLength(requestsBeforeCancel);
      },
    );

    it('stops before the fan-out when the cancel lands while the drug/ndc fallback backs off', async () => {
      vi.useFakeTimers();
      http.route(
        { match: (req) => pathOf(req) === '/drug/ndc.json', respond: SERVER_ERROR },
        { match: () => true, respond: NO_MATCHES },
      );
      const controller = new AbortController();
      const pending = runToolContract(
        drugProfileTool,
        { drug: 'metformin' },
        { context: { signal: controller.signal } },
      );

      const ndc = () => http.calls.filter((call) => pathOf(call.request) === '/drug/ndc.json');
      for (let i = 0; i < 200 && ndc().length === 0; i++) await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(0);
      expect(ndc()).toHaveLength(1);

      controller.abort();
      const result = await pending;

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      // Only the label lookup and the one ndc attempt went upstream.
      expect(http.calls.map((call) => pathOf(call.request))).toEqual([
        '/drug/label.json',
        '/drug/ndc.json',
      ]);
    });
  });
});

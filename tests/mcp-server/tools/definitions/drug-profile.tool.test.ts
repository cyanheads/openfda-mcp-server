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

import { drugProfileTool, fanOutKeyFor } from '@/mcp-server/tools/definitions/drug-profile.tool.js';
import { findSearchDelimiterFault } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { codeLiteralsIn, renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';
import { linearTiming } from '../../../helpers/cpu-timing.js';

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
    // The typed ingredient is a word of the resolved generic, so it is the key (#82).
    expect(result.meta.fanOutKey).toBe('metformin');
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

  // #81 — the caller's drug name rides in the notice as a code literal.
  it('quotes the unresolved drug name as a code literal on both surfaces', async () => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });
    const drug = '*not*a_drug_`x`';

    const result = await runToolContract(drugProfileTool, { drug });
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toBe(
      `Could not resolve \`\` ${drug} \`\` to an FDA drug. Check the spelling, try the generic name, or query openfda_get_drug_label / openfda_lookup_ndc directly.`,
    );
    const html = renderCommonMark(textOf(result.content, result.content.length - 1));
    expect(codeLiteralsIn(html)).toEqual([drug]);
    expect(html).not.toMatch(/<em>/);
  });

  /*
   * The heading echoes the caller's drug name and the resolution line its typed
   * term (the fan-out key after #82), so both ride as code literals: a CommonMark
   * read of the profile block gives back the exact string `structuredContent`
   * carries, with no emphasis made of its `*` and `_`. One case per side of
   * codeLiteral's branch: a span inside the heading and the line, and a fence on
   * the lines after them — where a line of the name that reads as a heading
   * stays text inside the fence (#67).
   */
  it.each([
    ['*x*_y_', '<h1>Drug profile: <code>*x*_y_</code></h1>'],
    ['*x*\n# _y_', '<h1>Drug profile:</h1>'],
  ])('renders the caller drug name %j as a code literal in format()', async (drug, heading) => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });

    const result = await runToolContract(drugProfileTool, { drug });
    const structured = result.structuredContent as { meta: { drug: string; fanOutKey: string } };
    expect(structured.meta).toMatchObject({ drug, fanOutKey: drug });

    const html = renderCommonMark(textOf(result.content, 0));
    expect(html).toContain(heading);
    expect(html.match(/<h\d>/g)).toHaveLength(7);
    expect(codeLiteralsIn(html)).toEqual([drug, drug]);
    expect(html.match(/<em>[\s\S]*?<\/em>/g)).toEqual(['<em>Resolved via: none</em>']);
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
      recalls_total: 0,
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
    expect(text).toContain('# Drug profile: `mystery`');
    expect(text).toContain('_Resolved via: none_ · fan-out key: `mystery`');
  });

  /**
   * A null section reads as unknown when its sub-query failed, and as absent only
   * when the search succeeded and matched nothing (#86).
   */
  describe.each([
    ['label', 'Unknown — the label search failed upstream (see Degraded).', 'No label on file.'],
    [
      'adverse_events',
      'Unknown — the adverse-event search failed upstream (see Degraded).',
      'No adverse-event data.',
    ],
    [
      'shortage',
      'Unknown — the shortage search failed upstream (see Degraded).',
      'Not currently listed in the shortage database.',
    ],
  ] as const)('format() for a null %s section', (section, unknownLine, absentLine) => {
    const nullProfile = (degraded: Array<{ section: string; reason: string; message: string }>) =>
      drugProfileTool.format!({
        meta: { drug: 'metformin', resolvedVia: 'none', fanOutKey: 'metformin' },
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
        recalls_total: 0,
        approval: null,
        shortage: null,
        degraded,
      } as Parameters<NonNullable<typeof drugProfileTool.format>>[0]);

    it('reads as unknown when the section is degraded', () => {
      const text = textOf(
        nullProfile([{ section, reason: 'upstream_error', message: 'gateway timeout' }]),
      );
      expect(text).toContain(unknownLine);
      expect(text).not.toContain(absentLine);
    });

    it('reads as absent when the search succeeded and matched nothing', () => {
      const text = textOf(nullProfile([]));
      expect(text).toContain(absentLine);
      expect(text).not.toContain(unknownLine);
    });
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
      // Brand input, so the key is the resolved generic rather than the typed term (#82).
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/label'
          ? {
              meta: meta({ total: 1 }),
              results: [{ openfda: { generic_name: ['odd\\name'], brand_name: ['Oddbrand'] } }],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'Oddbrand' }),
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

  /** The search each structured sub-query (recalls, approval, shortage) sent. */
  const structuredSearches = () =>
    Object.fromEntries(
      mockQuery.mock.calls
        .filter(([endpoint]) =>
          ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint as string),
        )
        .map(([endpoint, params]) => [endpoint, (params as { search: string }).search]),
    ) as Record<'drug/enforcement' | 'drug/drugsfda' | 'drug/shortages', string>;

  /**
   * Issue #82 — the structured sub-queries keyed on one label's `openfda.generic_name`,
   * which can be a single product's string (`ADALIMUMAB-AACF`, `METFORMIN ER 500 MG`).
   * When the typed term is words of that generic, the caller typed the ingredient and
   * it is the key; brand input keeps keying on the resolved generic (#10).
   */
  describe('fan-out key follows a typed ingredient (#82)', () => {
    const labelWith = (generic: string, brand: string) => async (endpoint: string) =>
      endpoint === 'drug/label'
        ? {
            meta: meta({ total: 1 }),
            results: [{ openfda: { generic_name: [generic], brand_name: [brand] } }],
          }
        : { meta: meta(), results: [] };

    it('keys on the typed term when it is a word of a product-specific generic', async () => {
      mockQuery.mockImplementation(labelWith('ADALIMUMAB-AACF', 'IDACIO'));

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'adalimumab' }),
        ctx,
      );

      expect(result.meta.fanOutKey).toBe('adalimumab');
      // Identity still reports the label it resolved; only the key changes.
      expect(result.identity.generic_name).toBe('ADALIMUMAB-AACF');
      const searches = Object.values(structuredSearches());
      expect(searches).toHaveLength(3);
      for (const search of searches) {
        expect(search).toContain('"adalimumab"');
        expect(search).not.toContain('AACF');
      }
    });

    it.each(['METFORMIN HCL', 'METFORMIN ER 500 MG', 'METFORMIN HYDROCHLORIDE'])(
      'keys metformin on the typed term whichever label resolves (%s)',
      async (generic) => {
        mockQuery.mockImplementation(labelWith(generic, 'Metformin'));

        const result = await drugProfileTool.handler(
          drugProfileTool.input.parse({ drug: 'metformin' }),
          ctx,
        );

        expect(result.meta.fanOutKey).toBe('metformin');
        expect(structuredSearches()['drug/shortages']).toBe('generic_name:"metformin"');
      },
    );

    it('keeps the resolved generic when the term is not whole words of it', async () => {
      mockQuery.mockImplementation(labelWith('METFORMIN HCL', 'Metform'));

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'Metform' }),
        ctx,
      );

      expect(result.meta.fanOutKey).toBe('METFORMIN HCL');
    });

    it('applies the same rule to an identity resolved through drug/ndc', async () => {
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/ndc'
          ? {
              meta: meta({ total: 1 }),
              results: [{ brand_name: 'Tylenol', generic_name: 'ACETAMINOPHEN 500 MG' }],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'acetaminophen' }),
        ctx,
      );

      expect(result.meta.resolvedVia).toBe('ndc');
      expect(result.meta.fanOutKey).toBe('acetaminophen');
      expect(structuredSearches()['drug/shortages']).toBe('generic_name:"acetaminophen"');
    });
  });

  /**
   * Issue #79 — `drug/enforcement` and `drug/drugsfda` fill `openfda.generic_name`
   * only for records openFDA could harmonize, so each sub-query also searches the
   * record's own field for the key, and the recall section reports its match total.
   */
  describe('recall and approval searches reach unharmonized records (#79)', () => {
    it('composes each structured search with its own-field clause', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        fullUpstream(endpoint, params),
      );

      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);

      expect(structuredSearches()).toEqual({
        'drug/enforcement': 'openfda.generic_name:"metformin" OR product_description:"metformin"',
        'drug/drugsfda':
          'openfda.generic_name:"metformin" OR products.active_ingredients.name:"metformin"',
        // drug/shortages carries generic_name on the record itself — no harmonization gap.
        'drug/shortages': 'generic_name:"metformin"',
      });
      const enforcement = mockQuery.mock.calls.find(([e]) => e === 'drug/enforcement')?.[1];
      expect(enforcement).toMatchObject({ sort: 'report_date:desc', limit: 5 });
    });

    it('costs 7 upstream requests resolved by label and 8 through the drug/ndc fallback', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        fullUpstream(endpoint, params),
      );
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);
      expect(mockQuery).toHaveBeenCalledTimes(7);

      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ meta: meta(), results: [] });
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);
      expect(mockQuery).toHaveBeenCalledTimes(8);
    });

    /** Upstream with the recall search answering `results` out of `total` matches. */
    const withRecalls =
      (results: unknown[], total: number) => async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/enforcement'
          ? { meta: meta({ total }), results }
          : fullUpstream(endpoint, params);
    const RECALL = {
      classification: 'Class II',
      reason_for_recall: 'Failed dissolution specification.',
      recalling_firm: 'Acme Pharma',
      report_date: '20240115',
    };

    it('reports the recall match total beside the newest five, on both surfaces', async () => {
      mockQuery.mockImplementation(
        withRecalls(
          Array.from({ length: 5 }, () => RECALL),
          91,
        ),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        recalls: unknown[];
        recalls_total: number | null;
      };
      expect(structured.recalls).toHaveLength(5);
      expect(structured.recalls_total).toBe(91);
      expect(textOf(result.content)).toContain('## Recalls (5 of 91)');
    });

    it('names the searched fields when no recall report matches', async () => {
      mockQuery.mockImplementation(withRecalls([], 0));

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as { recalls_total: number | null };
      expect(structured.recalls_total).toBe(0);
      const text = textOf(result.content);
      expect(text).toContain('## Recalls (0 of 0)');
      expect(text).toContain('openfda.generic_name or product_description');
      expect(text).not.toContain('No recalls on record.');
    });

    it('reports the recall total as unknown, never 0, when the recall search fails', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/enforcement') {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as {
        recalls_total: number | null;
        degraded: Array<{ section: string }>;
      };
      expect(structured.recalls_total).toBeNull();
      expect(structured.degraded.map((d) => d.section)).toEqual(['recalls']);
      const text = textOf(result.content);
      expect(text).toContain('## Recalls (unknown)');
      expect(text).not.toContain('openfda.generic_name or product_description');
    });

    it('names the searched fields when no Drugs@FDA application matches', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/drugsfda'
          ? { meta: meta(), results: [] }
          : fullUpstream(endpoint, params),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect((result.structuredContent as { approval: unknown }).approval).toBeNull();
      const text = textOf(result.content);
      expect(text).toContain('openfda.generic_name or products.active_ingredients.name');
      expect(text).not.toContain('No Drugs@FDA approval found.');
    });

    it('says the approval is unknown, not unmatched, when its search fails', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/drugsfda') {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const text = textOf(result.content);
      expect(text).toMatch(/## Approval\nUnknown/);
      expect(text).not.toContain('products.active_ingredients.name');
    });

    /** Drugs@FDA application shapes as api.fda.gov returns them (metformin, 2026-10-26). */
    const app = (
      application_number: string,
      products: Array<{ brand_name: string; ingredients: string[] }>,
      openfda?: { generic_name: string[]; brand_name: string[] },
    ) => ({
      application_number,
      sponsor_name: `Sponsor of ${application_number}`,
      products: products.map((p) => ({
        brand_name: p.brand_name,
        marketing_status: 'Prescription',
        active_ingredients: p.ingredients.map((name) => ({ name, strength: '500MG' })),
      })),
      ...(openfda ? { openfda } : {}),
    });

    it('scores applications without an openfda block on their products, choosing the best match', async () => {
      const apps = [
        // Unharmonized combination ranked first by relevance.
        app('ANDA211466', [
          {
            brand_name: 'DAPAGLIFLOZIN AND METFORMIN HYDROCHLORIDE',
            ingredients: ['DAPAGLIFLOZIN', 'METFORMIN HYDROCHLORIDE'],
          },
        ]),
        app(
          'ANDA205981',
          [
            {
              brand_name: 'SAXAGLIPTIN AND METFORMIN HYDROCHLORIDE',
              ingredients: ['METFORMIN HYDROCHLORIDE', 'SAXAGLIPTIN HYDROCHLORIDE'],
            },
          ],
          {
            generic_name: ['SAXAGLIPTIN AND METFORMIN'],
            brand_name: ['SAXAGLIPTIN AND METFORMIN'],
          },
        ),
        // The single-ingredient application, unharmonized.
        app('ANDA076869', [
          { brand_name: 'METFORMIN HYDROCHLORIDE', ingredients: ['METFORMIN HYDROCHLORIDE'] },
        ]),
      ];
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/drugsfda'
          ? { meta: meta({ total: 214 }), results: apps }
          : fullUpstream(endpoint, params),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.approval).toEqual({
        applicationNumber: 'ANDA076869',
        sponsor: 'Sponsor of ANDA076869',
        marketingStatus: 'Prescription',
      });
    });

    it('prefers a harmonized single-ingredient application over an unharmonized combination', async () => {
      const apps = [
        app('ANDA211466', [
          {
            brand_name: 'DAPAGLIFLOZIN AND METFORMIN HYDROCHLORIDE',
            ingredients: ['DAPAGLIFLOZIN', 'METFORMIN HYDROCHLORIDE'],
          },
        ]),
        app('NDA020357', [{ brand_name: 'GLUCOPHAGE', ingredients: ['METFORMIN HYDROCHLORIDE'] }], {
          generic_name: ['METFORMIN HYDROCHLORIDE'],
          brand_name: ['GLUCOPHAGE'],
        }),
      ];
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/drugsfda'
          ? { meta: meta({ total: 214 }), results: apps }
          : fullUpstream(endpoint, params),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.approval?.applicationNumber).toBe('NDA020357');
    });

    it('finds an approval for a drug no label or NDC resolves (troglitazone)', async () => {
      const discontinued = (n: string, brand: string) => ({
        ...app(n, [{ brand_name: brand, ingredients: ['TROGLITAZONE'] }]),
        products: [
          {
            brand_name: brand,
            marketing_status: 'Discontinued',
            active_ingredients: [{ name: 'TROGLITAZONE', strength: '200MG' }],
          },
        ],
      });
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/drugsfda'
          ? {
              meta: meta({ total: 2 }),
              results: [discontinued('NDA020720', 'REZULIN'), discontinued('NDA020719', 'PRELAY')],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'troglitazone' }),
        ctx,
      );

      expect(result.meta.resolvedVia).toBe('none');
      expect(structuredSearches()['drug/drugsfda']).toBe(
        'openfda.generic_name:"troglitazone" OR products.active_ingredients.name:"troglitazone"',
      );
      expect(result.approval).toMatchObject({
        applicationNumber: 'NDA020720',
        marketingStatus: 'Discontinued',
      });
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
      expect(text).toContain('Unknown — the adverse-event search failed upstream (see Degraded).');
      expect(text).not.toContain('No adverse-event data.');
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
    // The service wraps every search in one pair of parentheses on the wire (#84).
    expect(totalRequests[0]!.get('search')).toBe('(patient.drug.medicinalproduct:"metformin")');
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
    // Label and drug/ndc both miss: the fallback profile's 8 requests.
    expect(http.calls).toHaveLength(8);
    const structured = result.structuredContent as {
      adverse_events: unknown;
      recalls_total: number | null;
      degraded: unknown[];
    };
    expect(structured.adverse_events).toBeNull();
    // openFDA's no-match 404 is a known zero, not the unknown a failed search reports (#79).
    expect(structured.recalls_total).toBe(0);
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

/**
 * The fan-out key rule at its own seam (#82): the typed term when its words occur,
 * in order and case-insensitively, in the resolved generic name; otherwise the
 * resolved generic, then the brand, then the term, with #25's blank guard. The
 * handler tests above prove the wiring; this table is the rule.
 */
describe('fanOutKeyFor', () => {
  it.each([
    // [term, generic, brand, key, why]
    ['adalimumab', 'ADALIMUMAB-AACF', 'IDACIO', 'adalimumab', 'a hyphen ends a word'],
    ['metformin', 'METFORMIN HYDROCHLORIDE', 'Glucophage', 'metformin', 'a salt name'],
    ['metformin', 'METFORMIN ER 500 MG', undefined, 'metformin', 'a strength suffix'],
    ['insulin glargine', 'INSULIN GLARGINE-YFGN', undefined, 'insulin glargine', 'two words'],
    ['Insulin  Glargine', 'INSULIN GLARGINE', undefined, 'Insulin  Glargine', 'spacing, case'],
    ['glargine insulin', 'INSULIN GLARGINE', undefined, 'INSULIN GLARGINE', 'word order'],
    [
      'sitagliptin and metformin',
      'SITAGLIPTIN AND METFORMIN HYDROCHLORIDE',
      'Janumet',
      'sitagliptin and metformin',
      'a combination',
    ],
    ['metform', 'METFORMIN HCL', undefined, 'METFORMIN HCL', 'a prefix, not a word'],
    ['formin', 'METFORMIN', undefined, 'METFORMIN', 'a suffix, not a word'],
    ['metfor.*', 'METFORMIN HCL', undefined, 'METFORMIN HCL', 'regex syntax is literal'],
    ['café', 'CAFÉ EXTRACT', undefined, 'café', 'non-ASCII letters'],
    ['a a b', 'A A A B', undefined, 'a a b', 'a repeated first word'],
    ['a b a b c', 'A B A B A B C', undefined, 'a b a b c', 'an overlapping restart'],
    ['a a b', 'A A A', undefined, 'A A A', 'a near miss on repeated words'],
    [
      'metformin hydrochloride extended',
      'METFORMIN HYDROCHLORIDE',
      undefined,
      'METFORMIN HYDROCHLORIDE',
      'more words than the generic',
    ],
    ['---', 'METFORMIN', undefined, 'METFORMIN', 'a term with no words'],
    ['Glucophage', 'metformin hydrochloride', 'Glucophage', 'metformin hydrochloride', 'a brand'],
    ['Lipitor', 'ATORVASTATIN CALCIUM', 'Lipitor', 'ATORVASTATIN CALCIUM', 'a brand'],
    ['metformin', null, 'Glucophage', 'Glucophage', 'no generic resolved'],
    ['notadrug', null, undefined, 'notadrug', 'nothing resolved'],
    ['metformin', '"', undefined, 'metformin', 'a blank resolved generic (#25)'],
    ['metform', '  METFORMIN HCL  ', undefined, 'METFORMIN HCL', 'a padded resolved generic'],
  ] as const)('%j in %j (brand %j) keys %j — %s', (term, generic, brand, key, _why) => {
    expect(fanOutKeyFor(term, generic, brand)).toBe(key);
  });

  /**
   * The match reads caller text, so it is timed on its worst shapes across a 64×
   * span on this thread's CPU time, growing by doubling and checking the bound at
   * each size. A naive rescan from every start goes quadratic on the first shape.
   */
  describe('timing', { timeout: 120_000 }, () => {
    const shapes: [string, (n: number) => [string, string]][] = [
      ['repeated words with a near miss', (n) => [`${'a '.repeat(n / 4)}b`, 'a '.repeat(n / 2)]],
      [
        'one long line ending in a break',
        (n) => [`${'§1 x'.repeat(n / 4)}\ny`, `${'§1 x'.repeat(n / 4)}\nz`],
      ],
      ['breaks throughout', (n) => ['  \r\n'.repeat(n / 4), '  \r\n'.repeat(n / 4)]],
      ['a long digit run', (n) => ['1'.repeat(n), '1'.repeat(n)]],
    ];

    it.each(shapes)('stays linear on %s', (_name, build) => {
      const run = ([term, generic]: [string, string]) => fanOutKeyFor(term, generic, undefined);
      let ratio = 0;
      for (let n = 10_000; n <= 320_000; n *= 2) {
        const { t5k, t320k: tN } = linearTiming(run, build(5_000), build(n));
        expect(tN).toBeLessThan(500_000);
        ratio = tN / t5k;
      }
      expect(ratio).toBeLessThan(256);
    });
  });
});

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { drugProfileTool } from '@/mcp-server/tools/definitions/drug-profile.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

const meta = (over: Record<string, unknown> = {}) => ({
  total: 0,
  skip: 0,
  limit: 10,
  lastUpdated: '2026-01-01',
  ...over,
});

/** A fully-populated upstream, keyed by endpoint + count expression. */
function fullUpstream(endpoint: string, params: { count?: string }) {
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
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('resolves identity via drug/label and merges all sections', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
      fullUpstream(endpoint, params),
    );

    const result = await drugProfileTool.handler({ drug: 'metformin' }, ctx);

    expect(result.meta.resolvedVia).toBe('label');
    expect(result.meta.fanOutKey).toBe('metformin hydrochloride');
    expect(result.identity.generic_name).toBe('metformin hydrochloride');
    expect(result.identity.brand_names).toContain('Glucophage');
    expect(result.identity.rxcui).toBe('860975');
    expect(result.identity.spl_set_id).toBe('spl-abc-123');
    expect(result.label?.indications).toContain('glycemic');
    expect(result.adverse_events?.total).toBe(2000);
    expect(result.adverse_events?.seriousCount).toBe(500);
    expect(result.adverse_events?.topReactions[0]).toEqual({ term: 'NAUSEA', count: 1200 });
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0].classification).toBe('Class II');
    expect(result.recalls[0].date).toBe('20240110');
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

    await drugProfileTool.handler({ drug: 'Glucophage' }, ctx);

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
    expect(events).toHaveLength(2);
    for (const [, params] of events) {
      expect(params.search).toContain('Glucophage');
    }
  });

  it('is best-effort: a failing sub-query nulls its section without failing the call', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
      if (endpoint === 'drug/enforcement') throw new Error('boom');
      return fullUpstream(endpoint, params);
    });

    const result = await drugProfileTool.handler({ drug: 'metformin' }, ctx);

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

    const result = await drugProfileTool.handler({ drug: 'Tylenol' }, ctx);

    expect(result.meta.resolvedVia).toBe('ndc');
    expect(result.meta.fanOutKey).toBe('acetaminophen');
    expect(result.identity.generic_name).toBe('acetaminophen');
    expect(result.identity.product_ndc).toBe('50580-449');
    expect(result.identity.rxcui).toBe('198440');
    expect(result.label).toBeNull();
  });

  it('sets a notice when the drug cannot be resolved at all', async () => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });

    const result = await drugProfileTool.handler({ drug: 'notadrug' }, ctx);

    expect(result.meta.resolvedVia).toBe('none');
    expect(result.meta.fanOutKey).toBe('notadrug');
    expect(result.identity.generic_name).toBeNull();
    expect(result.identity.brand_names).toEqual([]);
    expect(getEnrichment(ctx).sectionsFound).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/could not resolve/i);
  });

  it('renders every section header in format(), even when sections are null', () => {
    const content = drugProfileTool.format({
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
    });

    const text = content[0].text;
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
});

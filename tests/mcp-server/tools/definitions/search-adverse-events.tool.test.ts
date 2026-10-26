import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_search_adverse_events', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchAdverseEventsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchAdverseEventsTool.errors });
  });

  it('maps category to endpoint and returns results', async () => {
    const response = {
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '123', patient: { drug: [] } }],
    };
    mockQuery.mockResolvedValue(response);

    const result = await searchAdverseEventsTool.handler(
      searchAdverseEventsTool.input.parse({ category: 'drug' }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ search: undefined }),
      ctx,
    );
    expect(result.meta.total).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it('maps device category correctly', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAdverseEventsTool.handler(
      searchAdverseEventsTool.input.parse({ category: 'device' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('device/event');
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 42, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '1', patient: {} }],
    });

    await searchAdverseEventsTool.handler(
      searchAdverseEventsTool.input.parse({ category: 'drug' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(42);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '1', patient: {} }],
    });

    await searchAdverseEventsTool.handler(
      searchAdverseEventsTool.input.parse({
        category: 'drug',
        search: 'patient.drug.medicinalproduct:"aspirin"',
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('patient.drug.medicinalproduct:"aspirin"');
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAdverseEventsTool.handler(
      searchAdverseEventsTool.input.parse({ category: 'drug', search: 'nonexistent' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no adverse event/i);
  });

  // #75 wiring: the shared search schema reads a URL-form `+` separator as a
  // space, so the service and the echo carry the spaced string. #81: the caller's
  // search in the empty-result notice is a code span on both surfaces.
  describe('search wiring (#75, #81)', () => {
    const EMPTY = {
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
      results: [],
    };
    const resultText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      String((result.structuredContent as { notice?: string }).notice);

    it('sends and echoes a URL-form +AND+ search with spaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [{ safetyreportid: '1', patient: {} }],
      });

      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        search: 'patient.drug.medicinalproduct:"aspirin"+AND+serious:"1"',
      });

      const spaced = 'patient.drug.medicinalproduct:"aspirin" AND serious:"1"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        search: 'patient.reaction.reactionmeddrapt.exact:"INJECTION+SITE+PAIN"',
      });

      expect(noticeOf(result)).toContain(
        'A "+" inside a quoted phrase is a literal plus sign, not a space, so `"INJECTION+SITE+PAIN"` can match only values spelled with one. If its words are meant to be separate, write them with spaces: `"INJECTION SITE PAIN"`.',
      );
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });

    it('wraps the caller search in the empty-result notice as a code span on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        search: 'patient.drug.medicinalproduct:*cillin*zzz*',
      });

      expect(noticeOf(result)).toContain(
        'No adverse event reports matched search: `patient.drug.medicinalproduct:*cillin*zzz*` in drug/event.',
      );
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats drug adverse event records', () => {
    const content = searchAdverseEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          safetyreportid: 'RPT-1',
          receivedate: '20260101',
          serious: '1',
          patient: {
            patientsex: '2',
            reaction: [{ reactionmeddrapt: 'NAUSEA' }],
            drug: [{ medicinalproduct: 'ASPIRIN', drugcharacterization: '1' }],
          },
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('RPT-1');
    expect(text).toContain('NAUSEA');
    expect(text).toContain('ASPIRIN');
    expect(text).toContain('Suspect');
    expect(text).toContain('Female');
  });

  // #72 — coded route, reaction outcome, and age group render their meaning in
  // content[] beside the raw code; structuredContent keeps the code alone.
  describe('code meanings (#72)', () => {
    const codedRecord = () => ({
      safetyreportid: 'RPT-72',
      patient: {
        patientagegroup: '6',
        reaction: [
          { reactionmeddrapt: 'DEATH', reactionoutcome: '5' },
          { reactionmeddrapt: 'RASH', reactionoutcome: '9' },
        ],
        drug: [
          {
            medicinalproduct: 'METFORMIN',
            drugcharacterization: '1',
            drugadministrationroute: '048',
          },
          { medicinalproduct: 'INSULIN', drugadministrationroute: '099' },
        ],
      },
    });

    const render = (record: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      textOf(
        searchAdverseEventsTool.format!({
          meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
          results: [record],
          ...extra,
        } as never),
      );

    it('renders a listed route as `via <label> (<code>)` and an unlisted one unchanged', () => {
      const text = render(codedRecord());
      expect(text).toContain('- METFORMIN (Suspect, via oral (048))');
      expect(text).toContain('- INSULIN (via 099)');
    });

    it('renders a listed reaction outcome beside its code and an unlisted one unchanged', () => {
      const text = render(codedRecord());
      expect(text).toContain('**Reactionoutcome:** fatal (5)');
      expect(text).toContain('**Reactionoutcome:** 9');
    });

    it('renders the patient age group beside its code', () => {
      expect(render(codedRecord())).toContain('**Patientagegroup:** elderly (6)');
    });

    it('renders an unlisted age group unchanged', () => {
      const record = codedRecord();
      record.patient.patientagegroup = '7';
      expect(render(record)).toContain('**Patientagegroup:** 7');
    });

    it('keeps raw codes in structuredContent and leaves the record unmutated by format()', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [codedRecord()],
      });

      const result = await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'drug' }),
        ctx,
      );
      const before = JSON.stringify(result);
      searchAdverseEventsTool.format!(result);

      expect(JSON.stringify(result)).toBe(before);
      expect(result.results[0]).toEqual(codedRecord());
    });

    it('keeps raw codes on a fields-projected record', () => {
      const text = render(
        { safetyreportid: 'RPT-72', patient: { drug: [{ drugadministrationroute: '048' }] } },
        { projected_fields: ['patient.drug.drugadministrationroute'] },
      );
      expect(text).toContain('048');
      expect(text).not.toContain('oral');
    });
  });

  it('formats empty results with the metadata header ahead of the no-match line (#68)', () => {
    const content = searchAdverseEventsTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo results found.',
    );
  });

  it('renders a device report through the device arm, not the drug arm (#24)', () => {
    /** device/event records carry their own `patient` array alongside `device`. */
    const content = searchAdverseEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          report_number: 'DEV-9',
          event_type: 'Malfunction',
          device: [{ brand_name: 'INFUSION PUMP', manufacturer_d_name: 'ACME' }],
          mdr_text: [{ text_type_code: 'Description of Event or Problem', text: 'Pump stalled.' }],
          patient: [{ patient_age: '92 YR' }],
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('### Report DEV-9');
    expect(text).toContain('**Event type:** Malfunction');
    expect(text).toContain('**Device:** INFUSION PUMP by ACME');
    expect(text).toContain('Narrative (Description of Event or Problem)');
    expect(text).toContain('92 YR');
  });
});

import { Buffer } from 'node:buffer';
import { z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import type { OpenFdaQueryParams } from '@/services/openfda/types.js';
import { renderCommonMark } from '../../../helpers/commonmark.js';
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

  // #92 — the category picks the page size an omitted limit gets and the cap a larger one is clamped to.
  it.each([
    ['drug', 'drug/event', 5, 25],
    ['food', 'food/event', 25, 1000],
    ['device', 'device/event', 10, 175],
    ['cosmetic', 'cosmetic/event', 25, 1000],
  ] as const)(
    'pages %s reports on %s at default %i and cap %i',
    async (category, endpoint, fallback, cap) => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
        results: [],
      });

      const omitted = await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category }),
        ctx,
      );
      const above = await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category, limit: 5_000 }),
        ctx,
      );

      expect(mockQuery.mock.calls.map(([path, params]) => [path, params.limit])).toEqual([
        [endpoint, fallback],
        [endpoint, cap],
      ]);
      expect([omitted.meta.limit, above.meta.limit]).toEqual([fallback, cap]);
    },
  );

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
      expect(text).toContain('- DEATH — fatal (5)');
      expect(text).toContain('- RASH — 9');
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

  // #88 — openFDA answers an unsorted request in index order, so a bare browse
  // sends the category's newest-first sort. The rule itself is tabled in
  // default-sort.test.ts; these cases prove the category wiring.
  describe('newest-first default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' }, results: [] };

    it.each([
      ['drug', 'receivedate:desc'],
      ['food', 'date_created:desc'],
      ['device', 'date_received:desc'],
      ['cosmetic', 'initial_received_date:desc'],
    ] as const)('a bare %s browse sends %s', async (category, sort) => {
      mockQuery.mockResolvedValue(EMPTY);
      await searchAdverseEventsTool.handler(searchAdverseEventsTool.input.parse({ category }), ctx);
      expect(mockQuery.mock.calls[0]![1].sort).toBe(sort);
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);
      await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'drug', sort: 'receiptdate:asc' }),
        ctx,
      );
      expect(mockQuery.mock.calls[0]![1].sort).toBe('receiptdate:asc');
    });

    it('sends no sort with a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);
      await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'drug', search: 'serious:"1"' }),
        ctx,
      );
      expect(mockQuery.mock.calls[0]![1].sort).toBeUndefined();
    });

    it('states the default in the search and sort descriptions', () => {
      const { search, sort } = searchAdverseEventsTool.input.shape;
      expect(search.description).not.toContain('Omit to browse recent.');
      expect(search.description).toContain('Omit both search and sort to browse the newest');
      expect(sort.description).toContain(
        "With neither search nor sort, records come newest first by the category's received date (drug receivedate:desc, food date_created:desc, device date_received:desc, cosmetic initial_received_date:desc).",
      );
    });
  });

  // #89 — no adverse-event record has a top-level openfda block, so the hint
  // names the category's own product field.
  describe('product-field hint on an empty result (#89)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 5, lastUpdated: '' }, results: [] };

    it.each([
      [
        'drug',
        'for product searches use patient.drug.medicinalproduct (the name as reported) or patient.drug.openfda.brand_name',
      ],
      ['device', 'for product searches use device.brand_name'],
      ['food', 'for product searches use products.name_brand'],
      ['cosmetic', 'for product searches use products.product_name'],
    ] as const)('names the %s product field', async (category, hint) => {
      mockQuery.mockResolvedValue(EMPTY);
      await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category, search: 'aspirin' }),
        ctx,
      );
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain(hint);
      expect(notice).not.toMatch(/(?<![\w.])openfda\.brand_name/);
    });
  });

  // #90 — content[] keeps each reaction's outcome on its term, renders onset age
  // with its unit, and ends every list before the next block.
  describe('reaction, onset age, and list rendering (#90)', () => {
    const page = (results: Record<string, unknown>[]) => ({
      meta: { total: results.length, skip: 0, limit: 5, lastUpdated: '2026-10-28' },
      results,
    });
    const render = (...results: Record<string, unknown>[]) =>
      textOf(searchAdverseEventsTool.format!(page(results) as never));
    const listItems = (html: string) =>
      [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1] ?? '');

    /** Report 27326684's reactions as openFDA served them (2026-11-10), all on MedDRA 29.0. */
    const report27326684 = () => ({
      safetyreportid: '27326684',
      patient: {
        reaction: (
          [
            ['Death', '5'],
            ['Fall', '3'],
            ['Gastrointestinal haemorrhage', '2'],
            ['Colitis', '3'],
            ['Prostatomegaly', '6'],
            ['Influenza', '1'],
            ['Limb discomfort', '3'],
            ['Hypersomnia', '6'],
            ['Gait disturbance', '3'],
            ['Micturition urgency', '6'],
            ['Inappropriate schedule of product administration', '6'],
          ] as const
        ).map(([term, outcome]) => ({
          reactionmeddraversionpt: '29.0',
          reactionmeddrapt: term,
          reactionoutcome: outcome,
        })),
      },
    });

    /** Report 10007369, trimmed: one drug, onset age in months, report-level fields after. */
    const report10007369 = () => ({
      safetyreportid: '10007369',
      receivedate: '20140313',
      serious: '1',
      patient: {
        reaction: [
          { reactionmeddraversionpt: '17.0', reactionmeddrapt: 'Pertussis', reactionoutcome: '1' },
          { reactionmeddraversionpt: '17.0', reactionmeddrapt: 'Cough', reactionoutcome: '1' },
        ],
        drug: [
          {
            drugcharacterization: '1',
            medicinalproduct: 'AEROLIN',
            drugstructuredosagenumb: '100',
            drugstructuredosageunit: '004',
            drugintervaldosagedefinition: '804',
            drugindication: 'BRONCHOSPASM',
            drugadministrationroute: '048',
            actiondrug: '1',
          },
        ],
        patientonsetage: '3',
        patientonsetageunit: '802',
        patientweight: '7.5',
        patientsex: '2',
      },
      reporttype: '1',
      fulfillexpeditecriteria: '1',
      companynumb: 'BR-GLAXOSMITHKLINE-A1064747A',
      primarysource: { reportercountry: 'BR', qualification: '1' },
      sender: { sendertype: '2', senderorganization: 'FDA-Public Use' },
      receiver: { receivertype: '6', receiverorganization: 'FDA' },
    });

    it('renders one item per reaction, term with outcome, and a shared MedDRA version once', () => {
      const text = render(report27326684());
      const items = listItems(renderCommonMark(text));

      expect(items).toHaveLength(11);
      expect(items[0]).toBe('Death — fatal (5)');
      expect(items[1]).toBe('Fall — not recovered/not resolved (3)');
      expect(items[10]).toBe('Inappropriate schedule of product administration — unknown (6)');
      expect(text).toContain('**Reactions (MedDRA 29.0):**');
      expect(text.split('29.0')).toHaveLength(2);
      expect(text).not.toContain('Reactionoutcome');
      expect(text).not.toContain('Reactionmeddraversionpt');
    });

    it('renders each reaction’s own MedDRA version when the versions differ (10004535)', () => {
      const items = listItems(
        renderCommonMark(
          render({
            safetyreportid: '10004535',
            patient: {
              reaction: [
                ['Coeliac disease', '17.0'],
                ['Malaise', '17.0'],
                ['Intentional product misuse', '17.1'],
              ].map(([term, version]) => ({
                reactionmeddraversionpt: version,
                reactionmeddrapt: term,
                reactionoutcome: '6',
              })),
            },
          }),
        ),
      );
      expect(items).toEqual([
        'Coeliac disease (MedDRA 17.0) — unknown (6)',
        'Malaise (MedDRA 17.0) — unknown (6)',
        'Intentional product misuse (MedDRA 17.1) — unknown (6)',
      ]);
    });

    it('renders a version per reaction when only some reactions carry one, and a bare term without an outcome', () => {
      const text = render({
        safetyreportid: 'RPT-PART',
        patient: {
          reaction: [
            { reactionmeddraversionpt: '29.0', reactionmeddrapt: 'Death', reactionoutcome: '5' },
            { reactionmeddrapt: 'Fall' },
          ],
        },
      });
      expect(text).toContain('**Reactions:**\n- Death (MedDRA 29.0) — fatal (5)\n- Fall\n');
    });

    it('keeps a reaction’s other fields on its own item', () => {
      const items = listItems(
        renderCommonMark(
          render({
            safetyreportid: 'RPT-EXTRA',
            patient: {
              reaction: [
                { reactionmeddrapt: 'Rash', reactionstartdate: '20200101' },
                { reactionmeddrapt: 'Fever' },
              ],
              patientweight: '70',
            },
          }),
        ),
      );
      expect(items).toEqual(['Rash\n<strong>Reactionstartdate:</strong> 20200101', 'Fever']);
    });

    it.each<[string, string | undefined, string | undefined, string]>([
      ['a listed unit', '3', '802', '**Patientonsetage:** 3 month (802)'],
      ['an unlisted unit', '3', '999', '**Patientonsetage:** 3 999'],
      ['no unit', '3', undefined, '**Patientonsetage:** 3'],
      ['a unit with no age', undefined, '800', '**Patientonsetageunit:** decade (800)'],
    ])('renders onset age with %s', (_case, age, unit, line) => {
      const text = render({
        safetyreportid: 'RPT-AGE',
        patient: { patientonsetage: age, patientonsetageunit: unit, patientweight: '7.5' },
      });
      expect(text.split('\n')).toContain(line);
      if (age !== undefined) expect(text).not.toContain('Patientonsetageunit');
    });

    it('ends the reaction and drug lists before the patient and report fields', () => {
      const html = renderCommonMark(render(report10007369()));
      const items = listItems(html);
      const recordLabels = [
        'Drugs',
        'Patientonsetage',
        'Patientweight',
        'Patientsex',
        'Reporttype',
        'Fulfillexpeditecriteria',
        'Companynumb',
        'Primarysource',
        'Sender',
        'Receiver',
        'Serious',
      ].map((label) => `<strong>${label}:</strong>`);

      expect(items).toHaveLength(3);
      for (const label of recordLabels) {
        expect(html).toContain(label);
        for (const item of items) expect(item).not.toContain(label);
      }
      // The drug's own fields stay on its item.
      expect(items[2]).toContain('<strong>Actiondrug:</strong> drug withdrawn (1)');
    });

    it('ends the food product list before the report fields', () => {
      const html = renderCommonMark(
        render({
          report_number: 'FOOD-1',
          reactions: ['NAUSEA'],
          products: [
            { name_brand: 'SNACK A', role: 'SUSPECT', industry_name: 'Snack Food Item' },
            { name_brand: 'SNACK B', role: 'CONCOMITANT' },
          ],
          date_created: '20260331',
          consumer: { age: '40', age_unit: 'year(s)' },
        }),
      );
      const items = listItems(html);
      expect(items).toHaveLength(2);
      expect(items[0]).toContain('<strong>Industry name:</strong> Snack Food Item');
      for (const label of ['<strong>Date created:</strong>', '<strong>Consumer:</strong>']) {
        expect(html).toContain(label);
        for (const item of items) expect(item).not.toContain(label);
      }
    });

    it('keeps raw codes in structuredContent and leaves the record unmutated by format()', async () => {
      mockQuery.mockResolvedValue(page([report10007369(), report27326684()]));
      const result = await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'drug' }),
        ctx,
      );
      const before = JSON.stringify(result);
      searchAdverseEventsTool.format!(result);

      expect(JSON.stringify(result)).toBe(before);
      expect(result.results).toEqual([report10007369(), report27326684()]);
    });

    it('keeps raw codes on a fields-projected record', () => {
      const text = textOf(
        searchAdverseEventsTool.format!({
          ...page([
            {
              safetyreportid: 'RPT-P',
              patient: { patientonsetageunit: '802', drug: [{ actiondrug: '1' }] },
            },
          ]),
          projected_fields: ['patient.patientonsetageunit', 'patient.drug.actiondrug'],
        } as never),
      );
      expect(text).toContain('802');
      expect(text).not.toContain('month');
      expect(text).not.toContain('withdrawn');
    });
  });

  // #90 fold-in — the remaining coded drug/event fields render their meaning in
  // content[] beside the code; a code FDA's reference leaves undefined stays raw.
  // The tables themselves are pinned in drug-event-codes.test.ts.
  describe('remaining coded fields (#90 fold-in)', () => {
    const record = () => ({
      safetyreportid: 'RPT-CODES',
      patient: {
        drug: [
          {
            medicinalproduct: 'ASPIRIN',
            actiondrug: '4',
            drugadditional: '3',
            drugrecurreadministration: '3',
            drugtreatmentduration: '1238',
            drugtreatmentdurationunit: '804',
            drugintervaldosageunitnumb: '1',
            drugintervaldosagedefinition: '803',
            drugstructuredosagenumb: '100',
            drugstructuredosageunit: '004',
            drugcumulativedosagenumb: '30',
            drugcumulativedosageunit: '003',
          },
          {
            medicinalproduct: 'BELIMUMAB',
            drugadditional: '4',
            drugintervaldosagedefinition: '807',
            drugstructuredosageunit: '007',
          },
        ],
      },
      reporttype: '2',
      fulfillexpeditecriteria: '2',
      primarysource: { reportercountry: 'US', qualification: '5' },
      sender: { sendertype: '2', senderorganization: 'FDA-Public Use' },
      receiver: { receivertype: '6', receiverorganization: 'FDA' },
    });
    const text = () =>
      textOf(
        searchAdverseEventsTool.format!({
          meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
          results: [record()],
        }),
      ).split('\n');

    it.each([
      '**Actiondrug:** dose not changed (4)',
      '**Drugadditional:** does not apply (3)',
      '**Drugrecurreadministration:** unknown (3)',
      '**Drugtreatmentdurationunit:** day (804)',
      '**Drugintervaldosagedefinition:** week (803)',
      '**Drugstructuredosageunit:** µg (micrograms) (004)',
      '**Drugcumulativedosageunit:** mg (milligrams) (003)',
      '**Reporttype:** report from study (2)',
      '**Fulfillexpeditecriteria:** no (2)',
      '**Primarysource:** reportercountry=US; qualification=consumer or non-health professional (5)',
      '**Sender:** sendertype=regulatory authority (2); senderorganization=FDA-Public Use',
      '**Receiver:** receivertype=other (6); receiverorganization=FDA',
    ])('renders %s', (line) => {
      expect(text()).toContain(line);
    });

    it.each([
      '**Drugadditional:** 4',
      '**Drugintervaldosagedefinition:** 807',
      '**Drugstructuredosageunit:** 007',
    ])('leaves an undefined code raw: %s', (line) => {
      expect(text()).toContain(line);
    });
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

  /**
   * Characterization: what the three categories the tool already served send and
   * return on a call that carries no cursor. Pinned before the cosmetic category
   * and the cursor joined the handler, and expected unchanged after.
   */
  describe('drug, food, and device on a call without a cursor (characterization)', () => {
    const CASES = [
      {
        category: 'drug',
        endpoint: 'drug/event',
        sort: 'receivedate:desc',
        limit: 5,
        record: {
          safetyreportid: '100',
          receivedate: '20260101',
          serious: '1',
          patient: {
            patientsex: '2',
            reaction: [{ reactionmeddrapt: 'Nausea' }],
            drug: [{ medicinalproduct: 'ASPIRIN', drugcharacterization: '1' }],
          },
        },
        lines: [
          '### Report 100',
          '**Date:** 20260101 | **Serious:** Yes',
          '**Patient:** Sex Female',
          '**Reactions:**',
          '- Nausea',
          '',
          '**Drugs:**',
          '- ASPIRIN (Suspect)',
          '**Drugcharacterization:** 1',
          '',
          '**Patientsex:** 2',
          '**Serious:** 1',
          '',
        ],
      },
      {
        category: 'food',
        endpoint: 'food/event',
        sort: 'date_created:desc',
        limit: 25,
        record: {
          report_number: 'F-1',
          reactions: ['NAUSEA'],
          outcomes: ['Hospitalization'],
          products: [{ name_brand: 'SNACK', role: 'SUSPECT', industry_code: '23' }],
          date_created: '20260301',
        },
        lines: [
          '### Report F-1',
          '**Reactions:** NAUSEA',
          '**Outcomes:** Hospitalization',
          '**Products:**',
          '- SNACK (role: SUSPECT, code: 23)',
          '',
          '**Date created:** 20260301',
          '',
        ],
      },
      {
        category: 'device',
        endpoint: 'device/event',
        sort: 'date_received:desc',
        limit: 10,
        record: {
          report_number: 'D-1',
          event_type: 'Malfunction',
          date_received: '20260401',
          device: [{ brand_name: 'PUMP', manufacturer_d_name: 'ACME', generic_name: 'INFUSER' }],
          mdr_text: [{ text_type_code: 'Description of Event or Problem', text: 'Stalled.' }],
          patient: [{ patient_sequence_number: '1' }],
        },
        lines: [
          '### Report D-1',
          '**Event type:** Malfunction',
          '**Device:** PUMP by ACME',
          '**Generic name:** INFUSER',
          '**Narrative (Description of Event or Problem):** Stalled.',
          '**Date received:** 20260401',
          '**Patient:** [{"patient_sequence_number":"1"}]',
          '',
        ],
      },
    ] as const;

    it.each(CASES)(
      'sends $endpoint with $sort, returns meta and results only, and renders as before',
      async ({ category, endpoint, sort, limit, record, lines }) => {
        mockQuery.mockResolvedValue({
          meta: { total: 1, skip: 0, limit, lastUpdated: '2026-01-01' },
          results: [record],
        });

        const result = await searchAdverseEventsTool.handler(
          searchAdverseEventsTool.input.parse({ category }),
          ctx,
        );

        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0]![0]).toBe(endpoint);
        expect(mockQuery.mock.calls[0]![1]).toEqual({ search: undefined, sort, limit, skip: 0 });
        expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
        expect(result.meta).toEqual({ total: 1, skip: 0, limit, lastUpdated: '2026-01-01' });
        expect(textOf(searchAdverseEventsTool.format!(result)).split('\n')).toEqual([
          `**1 total results** (returned: 1, skip: 0, limit: ${limit}) | Data updated: 2026-01-01`,
          '',
          ...lines,
        ]);
      },
    );
  });

  /** #95 — `category: "cosmetic"` reads `cosmetic/event`. */
  describe('cosmetic adverse events (#95)', () => {
    /** Report 24479493 as openFDA served it (2026-11-22): all 12 top-level fields, five products, five reactions. */
    const rich = () => ({
      meddra_version: '28',
      report_number: '24479493',
      outcomes: ['Other Serious or Important Medical Event'],
      patient: { age: '41', age_unit: 'Year(s)', gender: 'Female' },
      event_date: '01-Apr-21',
      legacy_report_id: '2021-CFS-004204',
      latest_received_date: '20210510',
      reactions: [
        'Burning Sensation',
        'Chapped Lips',
        'Skin Discolouration',
        'Skin Exfoliation',
        'Swelling',
      ],
      report_type: 'Direct',
      initial_received_date: '20210510',
      report_version: '1',
      products: [
        { role: 'Suspect', product_name: 'Eos Sweet Mint Lip Balm' },
        { role: 'Concomitant', product_name: 'Advil' },
        { role: 'Concomitant', product_name: 'Trazadone' },
        { role: 'Concomitant', product_name: 'Effexorer' },
        { role: 'Concomitant', product_name: 'One A Day Womens' },
      ],
    });
    /** Report 24468792 as served: no `patient`, `outcomes`, or `event_date`. */
    const sparse = () => ({
      meddra_version: '28',
      report_number: '24468792',
      legacy_report_id: '69912',
      latest_received_date: '20040624',
      reactions: ['Hypersensitivity'],
      report_type: 'Direct',
      initial_received_date: '20040624',
      report_version: '1',
      products: [{ role: 'Suspect', product_name: 'Premier Pigments Tattoo' }],
    });
    const HEADER =
      '**1 total results** (returned: 1, skip: 0, limit: 25) | Data updated: 2025-08-31';
    const page = (...results: Record<string, unknown>[]) => ({
      meta: { total: results.length, skip: 0, limit: 25, lastUpdated: '2025-08-31' },
      results,
    });
    const linesOf = (result: Parameters<NonNullable<typeof searchAdverseEventsTool.format>>[0]) =>
      textOf(searchAdverseEventsTool.format!(result)).split('\n');
    /** Every text block a call's `content[]` carries. */
    const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

    /** Every scalar leaf under `value`, as text. */
    const leafValues = (value: unknown): string[] => {
      if (value == null || value === '') return [];
      if (Array.isArray(value)) return value.flatMap(leafValues);
      if (typeof value === 'object') return Object.values(value).flatMap(leafValues);
      return [String(value)];
    };

    it('accepts cosmetic and reads cosmetic/event', async () => {
      mockQuery.mockResolvedValue(page(rich()));

      const result = await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'cosmetic' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![0]).toBe('cosmetic/event');
      expect(result.results).toEqual([rich()]);
    });

    it('sends an explicit sort as given and no sort with a search alone', async () => {
      mockQuery.mockResolvedValue(page());
      await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({
          category: 'cosmetic',
          sort: 'latest_received_date:asc',
        }),
        ctx,
      );
      await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'cosmetic', search: 'outcomes:"Death"' }),
        ctx,
      );

      expect(mockQuery.mock.calls.map(([, params]) => params.sort)).toEqual([
        'latest_received_date:asc',
        undefined,
      ]);
    });

    it('renders a report with several products and reactions under its report_number', () => {
      expect(linesOf(page(rich()))).toEqual([
        HEADER,
        '',
        '### Report 24479493',
        '**Initial received:** 20210510 | **Latest received:** 20210510',
        '**Patient:** age=41; age_unit=Year(s); gender=Female',
        '**Reactions:** Burning Sensation, Chapped Lips, Skin Discolouration, Skin Exfoliation, Swelling',
        '**Outcomes:** Other Serious or Important Medical Event',
        '**Products:**',
        '- Eos Sweet Mint Lip Balm (role: Suspect)',
        '- Advil (role: Concomitant)',
        '- Trazadone (role: Concomitant)',
        '- Effexorer (role: Concomitant)',
        '- One A Day Womens (role: Concomitant)',
        '',
        '**Meddra version:** 28',
        '**Event date:** 01-Apr-21',
        '**Legacy report id:** 2021-CFS-004204',
        '**Report type:** Direct',
        '**Report version:** 1',
        '',
      ]);
    });

    it('renders a report without patient, outcomes, or event_date with no placeholder for them', () => {
      expect(linesOf(page(sparse()))).toEqual([
        HEADER,
        '',
        '### Report 24468792',
        '**Initial received:** 20040624 | **Latest received:** 20040624',
        '**Reactions:** Hypersensitivity',
        '**Products:**',
        '- Premier Pigments Tattoo (role: Suspect)',
        '',
        '**Meddra version:** 28',
        '**Legacy report id:** 69912',
        '**Report type:** Direct',
        '**Report version:** 1',
        '',
      ]);
    });

    it('renders only the fields a minimal report carries', () => {
      expect(linesOf(page({ report_number: 'C-MIN', initial_received_date: '20250101' }))).toEqual([
        HEADER,
        '',
        '### Report C-MIN',
        '**Initial received:** 20250101',
        '',
      ]);
    });

    it('renders a products value that is not a list whole, on its own line', () => {
      expect(
        linesOf(
          page({
            report_number: 'C-OBJ',
            initial_received_date: '20250101',
            products: { product_name: 'Lotion', role: 'Suspect' },
          }),
        ),
      ).toEqual([
        HEADER,
        '',
        '### Report C-OBJ',
        '**Initial received:** 20250101',
        '**Products:** product_name=Lotion; role=Suspect',
        '',
      ]);
    });

    it('keeps a product’s other fields on its own list item', () => {
      const html = renderCommonMark(
        textOf(
          searchAdverseEventsTool.format!(
            page({
              report_number: 'C-EXTRA',
              initial_received_date: '20250101',
              products: [
                { product_name: 'Lotion', role: 'Suspect', lot: 'L-7' },
                { product_name: 'Soap', role: 'Concomitant' },
              ],
              report_type: 'Direct',
            }),
          ),
        ),
      );
      const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '');
      expect(items).toHaveLength(2);
      expect(items[0]).toContain('<strong>Lot:</strong> L-7');
      expect(html).toContain('<strong>Report type:</strong> Direct');
      for (const item of items) expect(item).not.toContain('Report type');
    });

    it.each([
      ['with a patient block', rich],
      ['without one', sparse],
    ])('carries every field on both surfaces, %s', async (_case, record) => {
      mockQuery.mockResolvedValue(page(record()));

      const result = await runToolContract(searchAdverseEventsTool, { category: 'cosmetic' });

      const { results } = result.structuredContent as { results: Record<string, unknown>[] };
      expect(results).toEqual([record()]);
      const text = contentText(result);
      const missing = leafValues(record()).filter((leaf) => !text.includes(leaf));
      expect(missing).toEqual([]);
      expect(text).not.toContain('N/A');
      expect(text).not.toContain('Unknown');
    });

    it('routes each shape to its own branch: a cosmetic report never renders as drug or food, nor the reverse', () => {
      const text = textOf(
        searchAdverseEventsTool.format!({
          meta: { total: 4, skip: 0, limit: 25, lastUpdated: '' },
          results: [
            rich(),
            sparse(),
            { safetyreportid: 'DRUG-1', receivedate: '20260101', patient: { patientsex: '1' } },
            { report_number: 'FOOD-1', products: [{ name_brand: 'SNACK', role: 'Suspect' }] },
            { report_number: 'DEV-1', device: [{ brand_name: 'PUMP' }], patient: [{}] },
          ],
        }),
      );
      const blocks = text.split('### ').slice(1);
      expect(blocks.map((block) => block.split('\n')[0])).toEqual([
        'Report 24479493',
        'Report 24468792',
        'Report DRUG-1',
        'Report FOOD-1',
        'Report DEV-1',
      ]);
      // A cosmetic report with a patient block is not the drug arm; without one, not the food arm.
      expect(blocks[0]).not.toContain('**Date:**');
      expect(blocks[1]).not.toContain('Unknown (role:');
      // The drug, food, and device arms keep their own lines and gain no cosmetic one.
      expect(blocks[2]).toContain('**Date:** 20260101 | **Serious:** N/A');
      expect(blocks[3]).toContain('- SNACK (role: Suspect)');
      expect(blocks[4]).toContain('**Device:** PUMP');
      for (const block of blocks.slice(2)) expect(block).not.toContain('**Initial received:**');
    });

    it('names cosmetic in the tool, category, sort, results, and limit descriptions', () => {
      const { category, sort, limit } = z.toJSONSchema(searchAdverseEventsTool.input)
        .properties as Record<string, { description?: string; enum?: string[] }>;
      expect(searchAdverseEventsTool.description).toContain(
        'Search adverse event reports across drugs, food, devices, and cosmetics.',
      );
      expect(category?.enum).toEqual(['drug', 'food', 'device', 'cosmetic']);
      expect(sort?.description).toContain(
        'cosmetic → initial_received_date (or latest_received_date)',
      );
      expect(limit?.description).toContain('cosmetic 25 (cap 1000)');
      const results = searchAdverseEventsTool.output.shape.results.description;
      expect(results).toContain('cosmetic: products/reactions/outcomes');
    });

    /**
     * The cosmetic projection, staged or not × `canvas_id` supplied or omitted ×
     * `skip` 0 or past the 100-row probe × `fields` set or not. 150 records, so a
     * staged call drains past the probe, and at skip 90 fetches its window too.
     */
    describe('staged and inline pages', () => {
      const COSMETIC_COLUMNS: ColumnSchema[] = [
        ['report_number', 'VARCHAR'],
        ['report_version', 'VARCHAR'],
        ['report_type', 'VARCHAR'],
        ['initial_received_date', 'VARCHAR'],
        ['latest_received_date', 'VARCHAR'],
        ['event_date', 'VARCHAR'],
        ['legacy_report_id', 'VARCHAR'],
        ['meddra_version', 'VARCHAR'],
        ['patient', 'JSON'],
        ['products', 'JSON'],
        ['reactions', 'JSON'],
        ['outcomes', 'JSON'],
      ].map(([name, type]) => ({ name, type, nullable: true }) as ColumnSchema);
      const TOTAL = 150;
      const recordAt = (i: number) => ({
        report_number: `C-${i}`,
        initial_received_date: '20250101',
        reactions: [`Reaction ${i}`],
        products: [{ product_name: `Product ${i}`, role: 'Suspect' }],
      });

      const registered: { rows: number; schema: ColumnSchema[] }[] = [];
      const acquire = vi.fn(async (canvasId?: string) => ({
        canvasId: canvasId ?? 'cv_fresh01',
        isNew: canvasId === undefined,
        registerTable: async (
          tableName: string,
          source: AsyncIterable<unknown>,
          options: { schema: ColumnSchema[] },
        ) => {
          let rowCount = 0;
          for await (const _row of source) rowCount++;
          registered.push({ rows: rowCount, schema: options.schema });
          return { tableName, rowCount, columns: [] };
        },
        drop: vi.fn(),
      }));

      beforeEach(() => {
        registered.length = 0;
        acquire.mockClear();
        setCanvas({ acquire } as never);
        // openFDA links a search_after page only from a page read at skip 0.
        mockQuery.mockImplementation(async (_endpoint: string, params: OpenFdaQueryParams) => {
          const skip = params.skip ?? 0;
          const limit = params.limit ?? 25;
          const results = [];
          for (let i = skip; i < Math.min(skip + limit, TOTAL); i++) results.push(recordAt(i));
          return {
            meta: { total: TOTAL, skip, limit, lastUpdated: '2025-08-31' },
            results,
            ...(skip === 0 && { nextSearchAfter: `0=1735689600000;1=C-${limit - 1}` }),
          };
        });
      });

      afterEach(() => {
        setCanvas(undefined);
      });

      it('stages all 12 top-level fields of a cosmetic report', () => {
        expect(COSMETIC_COLUMNS.map((c) => c.name).sort()).toEqual(Object.keys(rich()).sort());
      });

      const MATRIX = (['inline', 'stage', 'canvas_id'] as const).flatMap((staging) =>
        [0, 90].flatMap((skip) =>
          [undefined, ['reactions']].map((fields) => ({ staging, skip, fields })),
        ),
      );

      it.each(MATRIX)('$staging, skip $skip, fields $fields', async ({ staging, skip, fields }) => {
        const result = await runToolContract(searchAdverseEventsTool, {
          category: 'cosmetic',
          skip,
          ...(fields && { fields }),
          ...(staging === 'stage' && { stage: true }),
          ...(staging === 'canvas_id' && { canvas_id: 'cv_given01' }),
        });

        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as {
          canvas_id?: string;
          next_cursor?: string;
          projected_fields?: string[];
          results: Record<string, unknown>[];
          staged_rows?: number;
        };
        const text = contentText(result);

        // #97: only an inline page read at skip 0 continues by cursor; a staged call never does.
        if (staging === 'inline' && skip === 0) {
          expect(structured.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
          expect(text).toContain(`\nnext_cursor: \`${structured.next_cursor}\`\n`);
        } else {
          expect(structured).not.toHaveProperty('next_cursor');
          expect(text).not.toContain('next_cursor:');
        }

        // Every request — inline, or the staged probe, window, and drain — reads cosmetic/event newest first.
        for (const [endpoint, params] of mockQuery.mock.calls) {
          expect(endpoint).toBe('cosmetic/event');
          expect(params).toMatchObject({ sort: 'initial_received_date:desc', search: undefined });
        }
        const skips = mockQuery.mock.calls.map(([, params]) => params.skip);
        if (staging === 'inline') {
          expect(skips).toEqual([skip]);
          expect(acquire).not.toHaveBeenCalled();
          expect(structured.canvas_id).toBeUndefined();
        } else {
          expect(skips).toEqual(skip === 0 ? [0, 100] : [0, 90, 100]);
          expect(acquire).toHaveBeenCalledWith(
            staging === 'canvas_id' ? 'cv_given01' : undefined,
            expect.anything(),
          );
          expect(registered).toEqual([{ rows: TOTAL, schema: COSMETIC_COLUMNS }]);
          expect(structured.staged_rows).toBe(TOTAL);
          expect(text).toContain(`Staged ${TOTAL} of ${TOTAL} matched rows`);
        }

        const window = Array.from({ length: 25 }, (_, i) => `C-${skip + i}`);
        expect(structured.results.map((r) => r.report_number)).toEqual(window);
        if (fields) {
          expect(structured.projected_fields).toEqual(['reactions']);
          expect(structured.results[0]).toEqual({
            report_number: `C-${skip}`,
            reactions: [`Reaction ${skip}`],
          });
          expect(text).toContain(`### report_number: C-${skip}\n**Reactions:** Reaction ${skip}`);
        } else {
          expect(structured.projected_fields).toBeUndefined();
          expect(structured.results[0]).toEqual(recordAt(skip));
          expect(text).toContain(
            `### Report C-${skip}\n**Initial received:** 20250101\n**Reactions:** Reaction ${skip}\n**Products:**\n- Product ${skip} (role: Suspect)`,
          );
        }
      });
    });
  });

  /**
   * #97 — the tool's own cursor surface. The walk, the binding, and the refusals
   * run through the cursor contract in pagination-contract.test.ts on the drug
   * category; the token at its seam in pagination-cursor.test.ts. These prove the
   * category picks the endpoint and default sort a cursor is bound to and sent with.
   */
  describe('cursor (#97)', () => {
    const CATEGORIES = [
      ['drug', 'drug/event', 'receivedate:desc', 'food'],
      ['food', 'food/event', 'date_created:desc', 'device'],
      ['device', 'device/event', 'date_received:desc', 'cosmetic'],
      ['cosmetic', 'cosmetic/event', 'initial_received_date:desc', 'drug'],
    ] as const;
    /** A first page of 3 of 9 records, linked onward as openFDA links a skip 0 page. */
    const FIRST_PAGE = {
      meta: { total: 9, skip: 0, limit: 3, lastUpdated: '2026-11-21' },
      results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      nextSearchAfter: '0=1735689600000;1=c',
    };

    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(searchAdverseEventsTool.input) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required ?? []).not.toContain('cursor');
      const output = z.toJSONSchema(searchAdverseEventsTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries, once each', () => {
      expect(searchAdverseEventsTool.errors).toContain(invalidCursorError);
      expect(searchAdverseEventsTool.errors).toContain(paginationLimitReachedError);
      const reasons = (searchAdverseEventsTool.errors ?? []).map((e) => e.reason);
      expect(reasons.filter((r) => r === 'pagination_limit_reached')).toHaveLength(1);
    });

    it('sends no searchAfter and returns no next_cursor key on a cosmetic page without a link', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 0, limit: 25, lastUpdated: '2025-08-31' },
        results: [{ report_number: 'C-1', initial_received_date: '20250101' }],
      });

      const result = await searchAdverseEventsTool.handler(
        searchAdverseEventsTool.input.parse({ category: 'cosmetic' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
    });

    it.each(CATEGORIES)(
      '%s: follows next_cursor on %s with %s, and refuses it on %s',
      async (category, endpoint, sort, other) => {
        mockQuery.mockResolvedValueOnce(structuredClone(FIRST_PAGE));
        const first = await runToolContract(searchAdverseEventsTool, { category, limit: 3 });
        const { next_cursor: cursor } = first.structuredContent as { next_cursor?: string };
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);

        mockQuery.mockResolvedValueOnce({
          meta: { total: 9, skip: 3, limit: 3, lastUpdated: '2026-11-21' },
          results: [{ id: 'd' }],
        });
        const next = await runToolContract(searchAdverseEventsTool, { category, limit: 3, cursor });
        const refused = await runToolContract(searchAdverseEventsTool, {
          category: other,
          limit: 3,
          cursor,
        });

        expect(next.isError).toBeFalsy();
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery.mock.calls[1]![0]).toBe(endpoint);
        expect(mockQuery.mock.calls[1]![1]).toMatchObject({
          sort,
          skip: 0,
          searchAfter: { position: 3, value: '0=1735689600000;1=c' },
        });
        expect(refused.isError).toBe(true);
        const { error } = refused.structuredContent as unknown as {
          error: { message: string; data?: { reason?: string } };
        };
        expect(error.data?.reason).toBe('invalid_cursor');
        expect(error.message).toContain('different endpoint, search, or sort');
      },
    );

    it('renders next_cursor after the header and before the records', () => {
      const lines = textOf(
        searchAdverseEventsTool.format!({
          meta: { total: 30, skip: 0, limit: 1, lastUpdated: '2025-08-31' },
          results: [{ report_number: 'C-1', initial_received_date: '20250101' }],
          next_cursor: 'eyJwIjox_-',
        }),
      ).split('\n');
      expect(lines[0]).toMatch(/^\*\*30 total results\*\*/);
      expect(lines[2]).toBe('next_cursor: `eyJwIjox_-`');
      expect(lines.indexOf('### Report C-1')).toBeGreaterThan(2);
    });
  });

  /**
   * #104 — a drug page without `fields` leaves `patient.drug.openfda` out of
   * each report. #100 — a matched search whose AND-ed clauses fall under one
   * array of objects says different entries can meet them, with the staged SQL
   * for one entry. Each mechanism is tabled at its seam (record-projection.test.ts,
   * search-clauses.test.ts); these prove the wiring, how the notices join, and
   * pin the pages neither changes.
   */
  describe('the default drug cut (#104) and the conjoined-array notice (#100)', () => {
    /** A drug report whose first drug carries an `openfda` block and whose second carries none. */
    const drugReport = () => ({
      safetyreportid: '20000001',
      receivedate: '20261101',
      serious: '1',
      patient: {
        patientsex: '1',
        reaction: [{ reactionmeddrapt: 'Hepatic failure', reactionoutcome: '5' }],
        drug: [
          {
            medicinalproduct: 'ELIQUIS',
            drugcharacterization: '1',
            openfda: { brand_name: ['ELIQUIS'], generic_name: ['APIXABAN'] },
          },
          { medicinalproduct: 'ASPIRIN', drugcharacterization: '2' },
        ],
      },
    });
    const pageOf = (limit: number, ...results: Record<string, unknown>[]) => ({
      meta: { total: results.length, skip: 0, limit, lastUpdated: '2026-11-21' },
      results,
    });
    /** Both surfaces of one call: `structuredContent`, and every text block of `content[]`. */
    const surfaces = (result: Awaited<ReturnType<typeof runToolContract>>) => ({
      structured: result.structuredContent,
      text: result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    });
    const header = (limit: number) =>
      `**1 total results** (returned: 1, skip: 0, limit: ${limit}) | Data updated: 2026-11-21\n\n`;
    const TRAILER = '\n\n**totalResults:** 1';
    /** One default page per category with nothing left out: category, limit, the record, its `content[]` body. */
    const OTHER_CATEGORIES = [
      [
        'food',
        25,
        {
          report_number: 'F-1',
          reactions: ['NAUSEA'],
          outcomes: ['Hospitalization'],
          products: [{ name_brand: 'SNACK', role: 'SUSPECT', industry_code: '23' }],
          date_created: '20260301',
        },
        '### Report F-1\n**Reactions:** NAUSEA\n**Outcomes:** Hospitalization\n**Products:**\n- SNACK (role: SUSPECT, code: 23)\n\n**Date created:** 20260301\n',
      ],
      [
        'device',
        10,
        {
          report_number: 'D-1',
          event_type: 'Malfunction',
          date_received: '20260401',
          device: [
            {
              brand_name: 'PUMP',
              manufacturer_d_name: 'ACME',
              openfda: { device_name: 'Infusion pump' },
            },
          ],
          mdr_text: [{ text_type_code: 'Description of Event or Problem', text: 'Stalled.' }],
          patient: [{ patient_sequence_number: '1' }],
        },
        '### Report D-1\n**Event type:** Malfunction\n**Device:** PUMP by ACME\n**Openfda:** device_name=Infusion pump\n**Narrative (Description of Event or Problem):** Stalled.\n**Date received:** 20260401\n**Patient:** [{"patient_sequence_number":"1"}]\n',
      ],
      [
        'cosmetic',
        25,
        {
          meddra_version: '28',
          report_number: '24468792',
          legacy_report_id: '69912',
          latest_received_date: '20040624',
          reactions: ['Hypersensitivity'],
          report_type: 'Direct',
          initial_received_date: '20040624',
          report_version: '1',
          products: [{ role: 'Suspect', product_name: 'Premier Pigments Tattoo' }],
        },
        '### Report 24468792\n**Initial received:** 20040624 | **Latest received:** 20040624\n**Reactions:** Hypersensitivity\n**Products:**\n- Premier Pigments Tattoo (role: Suspect)\n\n**Meddra version:** 28\n**Legacy report id:** 69912\n**Report type:** Direct\n**Report version:** 1\n',
      ],
    ] as const;

    /** Pinned on the pre-#104 tree; expected unchanged after it. */
    describe('pages the cut leaves as they were (characterization)', () => {
      it('a fields page keeps patient whole, openfda included', async () => {
        mockQuery.mockResolvedValue(pageOf(5, drugReport()));

        const result = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          fields: ['patient'],
        });

        const notice =
          "Records projected to the requested fields (`patient`) plus each record's identity key; every other field is left out on request.";
        const { safetyreportid, patient } = drugReport();
        expect(surfaces(result)).toEqual({
          structured: {
            meta: pageOf(5, drugReport()).meta,
            results: [{ safetyreportid, patient }],
            projected_fields: ['patient'],
            totalResults: 1,
            notice,
          },
          text: [
            `${header(5)}> ${notice}\n\n### safetyreportid: 20000001\n**Patient:** patientsex=1; reaction=[{"reactionmeddrapt":"Hepatic failure","reactionoutcome":"5"}]; drug=[{"medicinalproduct":"ELIQUIS","drugcharacterization":"1","openfda":{"brand_name":["ELIQUIS"],"generic_name":["APIXABAN"]}},{"medicinalproduct":"ASPIRIN","drugcharacterization":"2"}]\n`,
            `${TRAILER}\n> ${notice}`,
          ],
        });
      });

      it.each(OTHER_CATEGORIES)(
        'a default %s page returns its records whole',
        async (category, limit, record, body) => {
          mockQuery.mockResolvedValue(pageOf(limit, structuredClone(record)));

          const result = await runToolContract(searchAdverseEventsTool, { category });

          expect(surfaces(result)).toEqual({
            structured: { ...pageOf(limit, record), totalResults: 1 },
            text: [`${header(limit)}${body}`, TRAILER],
          });
        },
      );
    });

    const OPENFDA = { brand_name: ['ELIQUIS'], generic_name: ['APIXABAN'] };
    /** UTF-8 bytes of the serialized value, as the tally counts them. */
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const leftOut = (bytes: number) =>
      `Left out of each record by default: patient.drug.openfda (${bytes} bytes on this page). Re-call with include naming a path to return it, or a path beneath it for that field alone.`;
    /** drugReport() as a page returns it: the first drug's `openfda` cut to `openfda`, gone when omitted. */
    const reportAs = (openfda?: Record<string, unknown>) => ({
      safetyreportid: '20000001',
      receivedate: '20261101',
      serious: '1',
      patient: {
        patientsex: '1',
        reaction: [{ reactionmeddrapt: 'Hepatic failure', reactionoutcome: '5' }],
        drug: [
          {
            medicinalproduct: 'ELIQUIS',
            drugcharacterization: '1',
            ...(openfda && { openfda }),
          },
          { medicinalproduct: 'ASPIRIN', drugcharacterization: '2' },
        ],
      },
    });
    /** `content[]` for reportAs(openfda), `openfda` rendered as its `**Openfda:**` line. */
    const reportText = (openfdaLine?: string) =>
      `### Report 20000001\n**Date:** 20261101 | **Serious:** Yes\n**Patient:** Sex Male\n**Reactions:**\n- Hepatic failure — fatal (5)\n\n**Drugs:**\n- ELIQUIS (Suspect)\n**Drugcharacterization:** 1\n${openfdaLine ? `${openfdaLine}\n` : ''}- ASPIRIN (Concomitant)\n**Drugcharacterization:** 2\n\n**Patientsex:** 1\n**Serious:** 1\n`;
    type Structured = {
      notice?: string;
      omitted_fields?: { bytes: number; path: string }[];
      page_bytes?: number;
      page_largest_fields?: { bytes: number; path: string }[];
      projected_fields?: string[];
      results: Record<string, unknown>[];
    };
    const structuredOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.structuredContent as unknown as Structured;

    it('a default drug page leaves the block out of every drug and names it with its bytes on both surfaces', async () => {
      mockQuery.mockResolvedValue(pageOf(5, drugReport()));

      const result = await runToolContract(searchAdverseEventsTool, { category: 'drug' });

      const notice = leftOut(size(OPENFDA));
      expect(surfaces(result)).toEqual({
        structured: {
          ...pageOf(5, reportAs()),
          omitted_fields: [{ path: 'patient.drug.openfda', bytes: size(OPENFDA) }],
          totalResults: 1,
          notice,
        },
        text: [`${header(5)}> ${notice}\n\n${reportText()}`, `${TRAILER}\n> ${notice}`],
      });
    });

    it('a cursor page of a default drug search leaves the block out the same way, joined with the cursor end', async () => {
      mockQuery.mockResolvedValueOnce({
        meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-21' },
        results: [drugReport()],
        nextSearchAfter: '0=1762041600000;1=20000001',
      });
      const first = await runToolContract(searchAdverseEventsTool, { category: 'drug', limit: 1 });
      const { next_cursor: cursor } = first.structuredContent as { next_cursor?: string };
      mockQuery.mockResolvedValueOnce({
        meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-21' },
        results: [drugReport()],
      });

      const next = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        limit: 1,
        cursor,
      });

      expect(mockQuery.mock.calls[1]![1]).toMatchObject({
        searchAfter: { position: 1, value: '0=1762041600000;1=20000001' },
      });
      for (const page of [first, next]) {
        expect(structuredOf(page).results).toEqual([reportAs()]);
        expect(structuredOf(page).omitted_fields).toEqual([
          { path: 'patient.drug.openfda', bytes: size(OPENFDA) },
        ]);
      }
      const notice = `This page holds the last 1 of the 2 matched records, so the cursor walk is complete. ${leftOut(size(OPENFDA))}`;
      expect(structuredOf(next).notice).toBe(notice);
      expect(surfaces(next).text).toEqual([
        `**2 total results** (returned: 1, skip: 1, limit: 1) | Data updated: 2026-11-21\n\n> ${leftOut(size(OPENFDA))}\n\n${reportText()}`,
        `\n\n**totalResults:** 2\n> ${notice}`,
      ]);
    });

    it('accepts a default page’s cursor on a next call that adds include or changes fields, and returns what each asks for', async () => {
      const link = '0=1762041600000;1=20000001';
      const cursorPage = () => ({
        meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-21' },
        results: [{ ...drugReport(), safetyreportid: '20000002' }],
      });
      mockQuery
        .mockResolvedValueOnce({
          meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-21' },
          results: [drugReport()],
          nextSearchAfter: link,
        })
        .mockResolvedValueOnce(cursorPage())
        .mockResolvedValueOnce(cursorPage());
      const first = await runToolContract(searchAdverseEventsTool, { category: 'drug', limit: 1 });
      const { next_cursor: cursor } = first.structuredContent as { next_cursor?: string };

      const included = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        limit: 1,
        cursor,
        include: ['patient.drug.openfda'],
      });
      const projected = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        limit: 1,
        cursor,
        fields: ['receivedate', 'patient.drug.openfda.generic_name'],
      });

      expect(mockQuery.mock.calls.slice(1).map(([, params]) => params.searchAfter)).toEqual([
        { position: 1, value: link },
        { position: 1, value: link },
      ]);
      const end =
        'This page holds the last 1 of the 2 matched records, so the cursor walk is complete.';
      expect(surfaces(included)).toEqual({
        structured: {
          ...cursorPage(),
          results: [{ ...reportAs(OPENFDA), safetyreportid: '20000002' }],
          totalResults: 2,
          notice: end,
        },
        text: [
          `**2 total results** (returned: 1, skip: 1, limit: 1) | Data updated: 2026-11-21\n\n${reportText('**Openfda:** brand_name=ELIQUIS; generic_name=APIXABAN').replace('20000001', '20000002')}`,
          `\n\n**totalResults:** 2\n> ${end}`,
        ],
      });

      expect(projected.isError).toBeFalsy();
      const structured = structuredOf(projected);
      expect(structured.results).toEqual([
        {
          safetyreportid: '20000002',
          receivedate: '20261101',
          patient: { drug: [{ openfda: { generic_name: ['APIXABAN'] } }, {}] },
        },
      ]);
      expect(structured.projected_fields).toEqual([
        'receivedate',
        'patient.drug.openfda.generic_name',
      ]);
      expect(structured).not.toHaveProperty('omitted_fields');
      const notice =
        "Records projected to the requested fields (`receivedate`, `patient.drug.openfda.generic_name`) plus each record's identity key; every other field is left out on request.";
      expect(structured.notice).toBe(`${end} ${notice}`);
      expect(surfaces(projected).text[1]).toBe(`\n\n**totalResults:** 2\n> ${end} ${notice}`);
      expect(surfaces(projected).text[0]).toContain('APIXABAN');
    });

    it('include naming the block returns it whole, with nothing disclosed', async () => {
      mockQuery.mockResolvedValue(pageOf(5, drugReport()));

      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        include: ['patient.drug.openfda'],
      });

      expect(surfaces(result)).toEqual({
        structured: { ...pageOf(5, reportAs(OPENFDA)), totalResults: 1 },
        text: [
          `${header(5)}${reportText('**Openfda:** brand_name=ELIQUIS; generic_name=APIXABAN')}`,
          TRAILER,
        ],
      });
    });

    it.each([
      [
        'include',
        { include: ['patient.drug.openfda.brand_name'] as string[] },
        { brand_name: ['ELIQUIS'] },
        '**Openfda:** brand_name=ELIQUIS',
      ],
      [
        'a search clause',
        { search: 'patient.drug.openfda.generic_name:"APIXABAN"' },
        { generic_name: ['APIXABAN'] },
        '**Openfda:** generic_name=APIXABAN',
      ],
    ] as const)(
      '%s naming a path beneath the block keeps that field alone and discloses the rest',
      async (_how, extra, kept, line) => {
        mockQuery.mockResolvedValue(pageOf(5, drugReport()));

        const result = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          ...extra,
        });

        const bytes = size(OPENFDA) - size(kept);
        const structured = structuredOf(result);
        expect(structured.results).toEqual([reportAs(kept)]);
        expect(structured.omitted_fields).toEqual([{ path: 'patient.drug.openfda', bytes }]);
        expect(structured.notice).toBe(leftOut(bytes));
        expect(surfaces(result).text[0]).toBe(
          `${header(5)}> ${leftOut(bytes)}\n\n${reportText(line)}`,
        );
      },
    );

    it('fields with include beneath the block returns both paths plus the identity key', async () => {
      mockQuery.mockResolvedValue(pageOf(5, drugReport()));

      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        fields: ['receivedate'],
        include: ['patient.drug.openfda.brand_name'],
      });

      const structured = structuredOf(result);
      expect(structured.results).toEqual([
        {
          safetyreportid: '20000001',
          receivedate: '20261101',
          patient: { drug: [{ openfda: { brand_name: ['ELIQUIS'] } }, {}] },
        },
      ]);
      expect(structured.projected_fields).toEqual([
        'receivedate',
        'patient.drug.openfda.brand_name',
      ]);
      expect(structured).not.toHaveProperty('omitted_fields');
      expect(structured.notice).not.toContain('Left out of each record');
    });

    it.each(OTHER_CATEGORIES)(
      'include changes nothing on a %s page',
      async (category, limit, record, body) => {
        mockQuery.mockResolvedValue(pageOf(limit, structuredClone(record)));

        const result = await runToolContract(searchAdverseEventsTool, {
          category,
          include: ['patient.drug.openfda', 'device.openfda'],
        });

        expect(surfaces(result)).toEqual({
          structured: { ...pageOf(limit, record), totalResults: 1 },
          text: [`${header(limit)}${body}`, TRAILER],
        });
      },
    );

    it.each([
      ['nothing to leave out', {}, pageOf(5, reportAs())],
      [
        'no match',
        {},
        { meta: { total: 0, skip: 0, limit: 5, lastUpdated: '2026-11-21' }, results: [] },
      ],
      [
        'skip past the end',
        { skip: 25 },
        { meta: { total: 3, skip: 25, limit: 5, lastUpdated: '2026-11-21' }, results: [] },
      ],
    ] as const)('%s: the page carries no omitted_fields', async (_case, extra, response) => {
      mockQuery.mockResolvedValue(structuredClone(response));

      const result = await runToolContract(searchAdverseEventsTool, { category: 'drug', ...extra });

      expect(result.isError).toBeFalsy();
      const structured = structuredOf(result);
      expect(structured.results).toEqual(response.results);
      expect(structured).not.toHaveProperty('omitted_fields');
      expect(String(structured.notice)).not.toContain('Left out of each record');
      expect(surfaces(result).text.join('\n')).not.toContain('Left out of each record');
    });

    it('joins the omission and oversized-record notices when a report stays over 24,000 bytes after the cut', async () => {
      const dosage = 'x'.repeat(30_000);
      const heavy = drugReport();
      Object.assign(heavy.patient.drug[0]!, { drugdosagetext: dosage });
      mockQuery.mockResolvedValue(pageOf(5, heavy));

      const result = await runToolContract(searchAdverseEventsTool, { category: 'drug' });

      const structured = structuredOf(result);
      expect(structured.results[0]).toEqual({
        ...reportAs(),
        patient: {
          ...reportAs().patient,
          drug: [
            { medicinalproduct: 'ELIQUIS', drugcharacterization: '1', drugdosagetext: dosage },
            { medicinalproduct: 'ASPIRIN', drugcharacterization: '2' },
          ],
        },
      });
      // Measured on the cut page, which no longer holds the block.
      expect(structured.page_bytes).toBe(size(structured.results));
      expect(structured.page_largest_fields).toEqual([
        { path: 'patient.drug.drugdosagetext', bytes: size(dosage) },
      ]);
      const omission = leftOut(size(OPENFDA));
      expect(structured.notice?.startsWith(`${omission} Oversized record: `)).toBe(true);
      const text = surfaces(result).text;
      expect(text[0]).toContain(`> ${omission}\n\n> Oversized record: `);
      expect(text[1]).toBe(`${TRAILER}\n> ${structured.notice}`);
    });

    it('joins the limit clamp ahead of the omission notice', async () => {
      mockQuery.mockResolvedValue({ ...pageOf(25, drugReport()) });

      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        limit: 5_000,
      });

      expect(structuredOf(result).notice).toBe(
        `limit=5000 is above the 25-record cap for drug/event, so 25 was applied; this page holds the last 1 of the 1 matched records. ${leftOut(size(OPENFDA))}`,
      );
    });

    it('rejects a malformed include path before any upstream request', async () => {
      const result = await runToolContract(searchAdverseEventsTool, {
        category: 'drug',
        include: ['patient..drug'],
      });

      expect(result.isError).toBe(true);
      expect(surfaces(result).text.join('\n')).toContain('include');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('names the drug left-out path in the include description', () => {
      expect(searchAdverseEventsTool.input.shape.include.description).toContain(
        'patient.drug.openfda on drug',
      );
    });

    describe('staged', () => {
      const SECOND = { ...drugReport(), safetyreportid: '20000002' };
      const staged: Record<string, unknown>[] = [];

      beforeEach(() => {
        staged.length = 0;
        setCanvas({
          acquire: vi.fn(async () => ({
            canvasId: 'cv_drug01',
            isNew: true,
            registerTable: async (
              tableName: string,
              source: AsyncIterable<Record<string, unknown>>,
            ) => {
              for await (const row of source) staged.push(row);
              return { tableName, rowCount: staged.length, columns: [] };
            },
            drop: vi.fn(),
          })),
        } as never);
        mockQuery.mockImplementation(async (_endpoint: string, params: OpenFdaQueryParams) => {
          const skip = params.skip ?? 0;
          const all = [drugReport(), structuredClone(SECOND)];
          return {
            meta: { total: 2, skip, limit: params.limit ?? 5, lastUpdated: '2026-11-21' },
            results: all.slice(skip, skip + (params.limit ?? 5)),
          };
        });
      });

      afterEach(() => {
        setCanvas(undefined);
      });

      it('stage: true cuts the inline page as the plain call does and stages whole reports', async () => {
        const plain = structuredOf(
          await runToolContract(searchAdverseEventsTool, { category: 'drug' }),
        );
        const result = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          stage: true,
        });

        const structured = structuredOf(result);
        expect(structured.results).toEqual(plain.results);
        expect(structured.results).toEqual([
          reportAs(),
          { ...reportAs(), safetyreportid: '20000002' },
        ]);
        expect(structured.omitted_fields).toEqual(plain.omitted_fields);
        expect(structured.omitted_fields).toEqual([
          { path: 'patient.drug.openfda', bytes: 2 * size(OPENFDA) },
        ]);
        expect(staged).toEqual([drugReport(), SECOND]);
        const omission = leftOut(2 * size(OPENFDA));
        expect(structured.notice).toMatch(
          /^Left out of each record by default: .* Staged 2 of 2 matched records/,
        );
        expect(structured.notice?.startsWith(`${omission} Staged 2 of 2`)).toBe(true);
        expect(surfaces(result).text[0]).toContain(`> ${omission}\n`);
      });
    });

    describe('clauses one array entry must meet together (#100)', () => {
      /** Searches with no conjoined pair under one array, pinned on the tree before the notice joined the handler. */
      const NO_PAIR = {
        // An array clause beside a top-level field.
        drug: 'patient.drug.medicinalproduct:"ELIQUIS" AND serious:"1"',
        // OR-joined clauses on one array.
        food: 'products.role:"SUSPECT" OR products.name_brand:"SNACK"',
        // Clauses under different arrays.
        device: 'device.brand_name:"PUMP" AND patient.patient_sequence_number:"1"',
        // The same field twice.
        cosmetic: 'products.product_name:"shampoo" AND products.product_name:"tattoo"',
      } as const;

      it('returns a drug search with no conjoined pair exactly as before', async () => {
        mockQuery.mockResolvedValue(pageOf(5, drugReport()));

        const result = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          search: NO_PAIR.drug,
        });

        const notice = leftOut(size(OPENFDA));
        expect(surfaces(result)).toEqual({
          structured: {
            ...pageOf(5, reportAs()),
            omitted_fields: [{ path: 'patient.drug.openfda', bytes: size(OPENFDA) }],
            totalResults: 1,
            effectiveQuery: NO_PAIR.drug,
            notice,
          },
          text: [
            `${header(5)}> ${notice}\n\n${reportText()}`,
            `${TRAILER}\nQuery: \`${NO_PAIR.drug}\`\n> ${notice}`,
          ],
        });
      });

      it.each(OTHER_CATEGORIES)(
        'returns a %s search with no conjoined pair exactly as before',
        async (category, limit, record, body) => {
          mockQuery.mockResolvedValue(pageOf(limit, structuredClone(record)));

          const result = await runToolContract(searchAdverseEventsTool, {
            category,
            search: NO_PAIR[category],
          });

          expect(surfaces(result)).toEqual({
            structured: {
              ...pageOf(limit, record),
              totalResults: 1,
              effectiveQuery: NO_PAIR[category],
            },
            text: [`${header(limit)}${body}`, `${TRAILER}\nQuery: \`${NO_PAIR[category]}\``],
          });
        },
      );

      const TIED =
        'patient.drug.medicinalproduct:"ELIQUIS" AND patient.drug.drugcharacterization:"1"';
      const FILTER = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(json_extract(t.patient, '$.drug'), '["json"]')) AS d) WHERE d->>'medicinalproduct' ILIKE '%ELIQUIS%' AND d->>'drugcharacterization' ILIKE '%1%')`;
      const TIE_LEAD =
        'openFDA matches each clause against the whole record, so the clauses on `patient.drug.medicinalproduct` and `patient.drug.drugcharacterization` can be met by different `patient.drug` entries.';
      const RESTAGE = `${TIE_LEAD} For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`;

      it('joins the tie notice after the omission notice on an inline page, on both surfaces', async () => {
        mockQuery.mockResolvedValue(pageOf(5, drugReport()));

        const result = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          search: TIED,
        });

        const omission = leftOut(size(OPENFDA));
        const notice = `${omission} ${RESTAGE}`;
        expect(surfaces(result)).toEqual({
          structured: {
            ...pageOf(5, reportAs()),
            omitted_fields: [{ path: 'patient.drug.openfda', bytes: size(OPENFDA) }],
            totalResults: 1,
            effectiveQuery: TIED,
            notice,
          },
          text: [
            `${header(5)}> ${omission}\n\n${reportText()}`,
            `${TRAILER}\nQuery: \`${TIED}\`\n> ${notice}`,
          ],
        });
      });

      it('joins the cursor end, the omission, and the tie notices on a cursor page, which restages without the cursor', async () => {
        mockQuery.mockResolvedValueOnce({
          meta: { total: 2, skip: 0, limit: 1, lastUpdated: '2026-11-21' },
          results: [drugReport()],
          nextSearchAfter: '0=1762041600000;1=20000001',
        });
        const first = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          search: TIED,
          sort: 'receivedate:desc',
          limit: 1,
        });
        const { next_cursor: cursor } = first.structuredContent as { next_cursor?: string };
        mockQuery.mockResolvedValueOnce({
          meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-21' },
          results: [drugReport()],
        });

        const next = await runToolContract(searchAdverseEventsTool, {
          category: 'drug',
          search: TIED,
          sort: 'receivedate:desc',
          limit: 1,
          cursor,
        });

        // A call carrying both cursor and stage is refused, so a cursor page restages without it.
        const restage = `${TIE_LEAD} For one entry meeting them together, call again without cursor and with stage: true, and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`;
        const notice = `This page holds the last 1 of the 2 matched records, so the cursor walk is complete. ${leftOut(size(OPENFDA))} ${restage}`;
        expect(structuredOf(next).notice).toBe(notice);
        expect(surfaces(next).text[1]).toBe(
          `\n\n**totalResults:** 2\nQuery: \`${TIED}\`\n> ${notice}`,
        );
        // The first page was read without a cursor and keeps the plain wording.
        expect(structuredOf(first).notice).toBe(`${leftOut(size(OPENFDA))} ${RESTAGE}`);
      });

      describe('staged', () => {
        /** The schema each table was registered with, per staged call. */
        const schemas: { name: string; type: string }[][] = [];

        beforeEach(() => {
          schemas.length = 0;
          setCanvas({
            acquire: vi.fn(async () => ({
              canvasId: 'cv_tie01',
              isNew: true,
              registerTable: async (
                tableName: string,
                source: AsyncIterable<unknown>,
                options: { schema: { name: string; type: string }[] },
              ) => {
                schemas.push(options.schema);
                let rowCount = 0;
                for await (const _row of source) rowCount++;
                return { tableName, rowCount, columns: [] };
              },
              drop: vi.fn(),
            })),
          } as never);
        });

        afterEach(() => {
          setCanvas(undefined);
        });

        it('names the staged table, joined after the staging notice', async () => {
          mockQuery.mockResolvedValue(pageOf(5, drugReport()));

          const result = await runToolContract(searchAdverseEventsTool, {
            category: 'drug',
            search: TIED,
            stage: true,
          });

          const structured = result.structuredContent as { canvas_table: string; notice: string };
          const omission = leftOut(size(OPENFDA));
          const staging = `Staged 1 of 1 matched records on canvas table "${structured.canvas_table}" (canvas_id "cv_tie01"). Call openfda_dataframe_describe for the column names, then openfda_dataframe_query to run SQL over the staged set.`;
          const tie = `${TIE_LEAD} For one entry meeting them together, query the staged table in openfda_dataframe_query: \`SELECT * FROM ${structured.canvas_table} t WHERE ${FILTER}\`.`;
          expect(structured.canvas_table).toMatch(/^spilled_[0-9a-f]{8}$/);
          expect(structured.notice).toBe(`${omission} ${staging} ${tie}`);
          expect(surfaces(result).text[1]).toBe(
            `${TRAILER}\nQuery: \`${TIED}\`\n> ${structured.notice}`,
          );
        });

        it.each([
          ['inline', false],
          ['staged', true],
        ] as const)('says nothing about entries on a %s total of 0', async (_mode, stage) => {
          mockQuery.mockResolvedValue({
            meta: { total: 0, skip: 0, limit: 5, lastUpdated: '2026-11-21' },
            results: [],
          });

          const result = await runToolContract(searchAdverseEventsTool, {
            category: 'drug',
            search: TIED,
            stage,
          });

          const notice = String(structuredOf(result).notice);
          expect(notice).toContain('No adverse event reports matched');
          expect(notice).not.toContain('openFDA matches each clause');
        });

        // Every array the notice can name is a column of the category's staged table.
        it.each([
          [
            'drug',
            'patient.drug.medicinalproduct:"ELIQUIS" AND patient.drug.drugindication:"PAIN"',
            'patient.drug',
            "json_extract(t.patient, '$.drug')",
            'patient',
          ],
          [
            'drug',
            'patient.reaction.reactionmeddrapt:"Nausea" AND patient.reaction.reactionoutcome:"1"',
            'patient.reaction',
            "json_extract(t.patient, '$.reaction')",
            'patient',
          ],
          [
            'device',
            'device.brand_name:"PUMP" AND device.manufacturer_d_name:"ACME"',
            'device',
            't.device',
            'device',
          ],
          [
            'device',
            'patient.patient_sequence_number:"1" AND patient.patient_age:"60"',
            'patient',
            't.patient',
            'patient',
          ],
          [
            'device',
            'mdr_text.text_type_code:"Description of Event or Problem" AND mdr_text.text:"stalled"',
            'mdr_text',
            't.mdr_text',
            'mdr_text',
          ],
          [
            'food',
            'products.role:"SUSPECT" AND products.name_brand:"SNACK"',
            'products',
            't.products',
            'products',
          ],
          [
            'cosmetic',
            'products.role:"Suspect" AND products.product_name:"shampoo"',
            'products',
            't.products',
            'products',
          ],
        ] as const)(
          '%s: names %s, staged as a JSON column, for %s',
          async (category, search, array, unnested, column) => {
            mockQuery.mockResolvedValue(pageOf(5, { report_number: 'R-1' }));

            const result = await runToolContract(searchAdverseEventsTool, {
              category,
              search,
              stage: true,
            });

            const notice = String(structuredOf(result).notice);
            expect(notice).toContain(`can be met by different \`${array}\` entries`);
            expect(notice).toContain(`unnest(from_json(${unnested}, '["json"]'))`);
            expect(schemas).toHaveLength(1);
            expect(schemas[0]).toContainEqual(
              expect.objectContaining({ name: column, type: 'JSON' }),
            );
          },
        );
      });
    });
  });
});

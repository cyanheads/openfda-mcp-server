import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
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
        'With search also omitted, the default is newest first: drug receivedate:desc, food date_created:desc, device date_received:desc.',
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
});

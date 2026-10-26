/**
 * @fileoverview Tests for openfda_search_animal_events tool.
 * @module tests/mcp-server/tools/definitions/search-animal-events.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

describe('openfda_search_animal_events', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchAnimalEventsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchAnimalEventsTool.errors });
  });

  it('queries animalandveterinary/event endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-1' }],
    });

    const result = await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('animalandveterinary/event');
    expect(result.results).toHaveLength(1);
  });

  it('passes search, sort, limit, skip to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 5, skip: 10, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-2' }],
    });

    await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({
        search: 'animal.species:"Dog"',
        sort: 'original_receive_date:desc',
        limit: 5,
        skip: 10,
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'animalandveterinary/event',
      expect.objectContaining({
        search: 'animal.species:"Dog"',
        sort: 'original_receive_date:desc',
        limit: 5,
        skip: 10,
      }),
      ctx,
    );
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 99, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-3' }],
    });

    await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(99);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-4' }],
    });

    await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({ search: 'drug.active_ingredients.name:"Fluralaner"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('drug.active_ingredients.name:"Fluralaner"');
  });

  it('does not set effectiveQuery when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-5' }],
    });

    await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({ search: 'animal.species:"Unicorn"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 100, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({ skip: 100 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=100/);
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
        results: [{ unique_aer_id_number: 'AER-75' }],
      });

      const result = await runToolContract(searchAnimalEventsTool, {
        search: 'animal.species:"Dog"+AND+serious_ae:"true"',
      });

      const spaced = 'animal.species:"Dog" AND serious_ae:"true"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchAnimalEventsTool, {
        search: 'reaction.veddra_term_name:"INJECTION+SITE+PAIN"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"INJECTION SITE PAIN"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });

    it('wraps the caller search in the empty-result notice as a code span on both surfaces', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchAnimalEventsTool, {
        search: 'animal.species:*og*zzz*',
      });

      expect(noticeOf(result)).toContain(
        'No animal adverse event reports matched search: `animal.species:*og*zzz*`.',
      );
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  it('formats records with animal and reaction fields', () => {
    const content = searchAnimalEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          unique_aer_id_number: 'AER-FMT-1',
          original_receive_date: '20260115',
          serious_ae: 'true',
          animal: {
            species: 'Dog',
            breed: { breed_component: 'Labrador' },
            gender: 'Male',
          },
          reaction: [{ veddra_term_name: 'Vomiting' }],
          drug: [
            {
              brand_name: 'MSK',
              active_ingredients: [{ name: 'Fluralaner 13.64% 12-Week Chew' }],
              route: 'Oral',
              administered_by: 'Animal Owner',
            },
          ],
          outcome: [{ medical_status: 'Recovered/Normal' }],
          primary_reporter: 'Veterinarian',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('AER-FMT-1');
    expect(text).toContain('20260115');
    expect(text).toContain('Dog');
    expect(text).toContain('Labrador');
    expect(text).toContain('Vomiting');
    expect(text).toContain('Fluralaner 13.64% 12-Week Chew');
    expect(text).toContain('Recovered/Normal');
    expect(text).toContain('Veterinarian');
  });

  // #67 — the animal, animal-details, received, and reactions lines carry upstream text.
  it('keeps the animal, animal-details, received, and reactions lines on one line each', async () => {
    const record = {
      unique_aer_id_number: 'AER-LINES',
      original_receive_date: '20260115\n### forged',
      serious_ae: 'true\n- forged',
      animal: {
        species: 'Dog\n- forged',
        breed: { breed_component: 'Beagle\r\n> forged' },
        gender: '# forged',
        reproductive_status: 'Intact\n- item',
      },
      reaction: [{ veddra_term_name: 'Vomiting\n### forged' }, { veddra_term_name: 'Lethargy' }],
    };
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-10-05' },
      results: [record],
    });

    const result = await runToolContract(searchAnimalEventsTool, { limit: 1 });

    expect((result.structuredContent as { results: unknown[] }).results).toEqual([record]);
    const lines = textOf(result.content as never).split('\n');
    expect(lines).toContain('**Received:** 20260115 ### forged | **Serious:** true - forged');
    expect(lines).toContain('**Animal:** Dog - forged, Beagle > forged');
    expect(lines).toContain('  \\# forged | Intact - item');
    expect(lines).toContain('**Reproductive status:** Intact - item');
    expect(lines).toContain('**Reactions:** Vomiting ### forged, Lethargy');
    expect(lines.filter((line) => /^(?:#|>|- )/.test(line.trimStart()))).toEqual([
      '### Report AER-LINES',
    ]);
  });

  it('renders the animal, received, and reactions lines byte-identical when single-line', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 1, lastUpdated: '2026-10-05' },
      results: [
        {
          unique_aer_id_number: 'AER-PLAIN',
          original_receive_date: '20260115',
          serious_ae: 'false',
          animal: {
            species: 'Cat',
            breed: { breed_component: 'Domestic Shorthair' },
            gender: 'Female',
            reproductive_status: 'Neutered',
            age: { min: '4', unit: 'Year' },
          },
          reaction: [{ veddra_term_name: 'Emesis' }, { veddra_term_name: 'Anorexia' }],
        },
      ],
    });

    const result = await runToolContract(searchAnimalEventsTool, { limit: 1 });

    const lines = textOf(result.content as never).split('\n');
    expect(lines).toContain('**Received:** 20260115 | **Serious:** No');
    expect(lines).toContain('**Animal:** Cat, Domestic Shorthair');
    expect(lines).toContain('  Female | Neutered | age 4 Year');
    expect(lines).toContain('**Reproductive status:** Neutered');
    expect(lines).toContain('**Reactions:** Emesis, Anorexia');
  });

  // #65 — openFDA masks every veterinary brand and manufacturer name as `MSK`
  // (FDA's "masked" null flavor), so the brand is no product name to lead with.
  describe('masked brand names (#65)', () => {
    const drugLines = (drug: Record<string, unknown>[]) =>
      textOf(
        searchAnimalEventsTool.format!({
          meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-05' },
          results: [{ unique_aer_id_number: 'AER-MSK', drug }],
        }),
      )
        .split('\n')
        .filter((line) => line.startsWith('- '));

    it.each<[string, Record<string, unknown>, string]>([
      [
        'a masked drug with its ingredient names, labelling MSK as masked',
        {
          brand_name: 'MSK',
          active_ingredients: [{ name: 'Pyrantel Pamoate' }, { name: 'Sarolaner' }],
          route: 'Oral',
          administered_by: 'Animal Owner',
        },
        '- Pyrantel Pamoate, Sarolaner (brand masked: MSK; via Oral, by Animal Owner)',
      ],
      [
        'a masked drug with no ingredient names as Unknown',
        { brand_name: 'MSK', active_ingredients: [{ dose: '1 tab' }] },
        '- Unknown (brand masked: MSK)',
      ],
      [
        'a drug with neither a brand nor ingredients as Unknown',
        { active_ingredients: [], route: 'Topical' },
        '- Unknown (via Topical)',
      ],
      ['an empty drug as Unknown', {}, '- Unknown'],
      [
        'an unmasked drug with its brand name',
        { brand_name: 'Example Chew', active_ingredients: [{ name: 'Fluralaner' }] },
        '- Example Chew',
      ],
      [
        'a drug with no brand with its ingredient names',
        { active_ingredients: [{ name: 'Carprofen' }], route: 'Oral' },
        '- Carprofen (via Oral)',
      ],
    ])('leads %s', (_case, drug, line) => {
      expect(drugLines([drug])).toEqual([line]);
    });

    it('keeps brand_name and manufacturer.name "MSK" raw in structuredContent while content[] labels them masked', async () => {
      const manufacturer = { name: 'MSK', registration_number: 'USA-USFDACVM-N141426' };
      mockQuery.mockResolvedValue({
        meta: { total: 68773, skip: 0, limit: 1, lastUpdated: '2026-10-05' },
        results: [
          {
            unique_aer_id_number: 'USA-USFDACVM-2026-US-012345',
            drug: [
              {
                brand_name: 'MSK',
                active_ingredients: [{ name: 'Fluralaner Chew Tablets' }],
                manufacturer,
              },
            ],
          },
        ],
      });

      const result = await runToolContract(searchAnimalEventsTool, {
        search: 'animal.species:"Dog" AND drug.active_ingredients.name:"Fluralaner"',
        limit: 1,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        results: { drug: { brand_name: string; manufacturer: unknown }[] }[];
      };
      expect(structured.results[0]!.drug[0]!.brand_name).toBe('MSK');
      expect(structured.results[0]!.drug[0]!.manufacturer).toEqual(manufacturer);
      const lines = textOf(result.content as never).split('\n');
      expect(lines).toContain('- Fluralaner Chew Tablets (brand masked: MSK)');
      expect(lines).toContain(
        '**Manufacturer:** name masked: MSK; registration_number=USA-USFDACVM-N141426',
      );
    });

    describe('masked manufacturer names', () => {
      const manufacturerLines = (drug: Record<string, unknown>[]) =>
        textOf(
          searchAnimalEventsTool.format!({
            meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-05' },
            results: [{ unique_aer_id_number: 'AER-MSK', drug }],
          }),
        )
          .split('\n')
          .filter((line) => line.startsWith('**Manufacturer:**'));

      it.each([
        [
          'labels a masked name the way the drug line labels the brand',
          { name: 'MSK', registration_number: 'USA-USFDACVM-N141426' },
          '**Manufacturer:** name masked: MSK; registration_number=USA-USFDACVM-N141426',
        ],
        [
          'labels a masked name that carries no registration number',
          { name: 'MSK' },
          '**Manufacturer:** name masked: MSK',
        ],
        [
          'renders an unmasked name unchanged',
          { name: 'Example Animal Health', registration_number: 'R1' },
          '**Manufacturer:** name=Example Animal Health; registration_number=R1',
        ],
      ])('%s', (_case, manufacturer, line) => {
        expect(manufacturerLines([{ manufacturer }])).toEqual([line]);
      });

      it('labels the manufacturer of every drug on the report, in field order', () => {
        const text = textOf(
          searchAnimalEventsTool.format!({
            meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-05' },
            results: [
              {
                unique_aer_id_number: 'AER-MSK',
                drug: [
                  {
                    lot_number: 'L1',
                    manufacturer: { name: 'MSK', registration_number: 'USA-USFDACVM-N141459' },
                    atc_vet_code: 'QP53BE02',
                  },
                  { manufacturer: { name: 'MSK' } },
                ],
              },
            ],
          }),
        );
        const lines = text.split('\n');
        const at = (line: string) => lines.indexOf(line);

        expect(lines.filter((l) => l.startsWith('**Manufacturer:**'))).toEqual([
          '**Manufacturer:** name masked: MSK; registration_number=USA-USFDACVM-N141459',
          '**Manufacturer:** name masked: MSK',
        ]);
        expect(at('**Lot number:** L1')).toBeLessThan(
          at('**Manufacturer:** name masked: MSK; registration_number=USA-USFDACVM-N141459'),
        );
        expect(
          at('**Manufacturer:** name masked: MSK; registration_number=USA-USFDACVM-N141459'),
        ).toBeLessThan(at('**Atc vet code:** QP53BE02'));
        expect(text).not.toContain('name=MSK');
      });
    });

    describe('empty-result notice', () => {
      const emptyNoticeFor = async (search: string) => {
        mockQuery.mockResolvedValue({
          meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
          results: [],
        });
        await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({ search }), ctx);
        return getEnrichment(ctx).notice as string;
      };

      it('recommends species, ingredient, and VeDDRA fields, never a brand field', async () => {
        const notice = await emptyNoticeFor('animal.species:"Unicorn"');

        expect(notice).toContain(
          'use animal.species, drug.active_ingredients.name, or reaction.veddra_term_name fields',
        );
        expect(notice).not.toContain('drug.brand_name');
        expect(notice).not.toContain('MSK');
      });

      it.each([
        'animal.species:"Dog" AND drug.brand_name:"Bravecto"',
        'drug.manufacturer.name:"Merck Animal Health"',
      ])('explains the MSK mask when the search names a masked field: %s', async (search) => {
        const notice = await emptyNoticeFor(search);

        expect(notice).toContain('drug.brand_name and drug.manufacturer.name hold only "MSK"');
        expect(notice).toContain('drug.active_ingredients.name');
        expect(notice).toContain('drug.manufacturer.registration_number');
        expect(notice).toContain('"USA-USFDACVM-N141426"');
      });

      it('leaves the MSK line off a registration-number search', async () => {
        const notice = await emptyNoticeFor(
          'drug.manufacturer.registration_number:"USA-USFDACVM-N999999"',
        );

        expect(notice).not.toContain('MSK');
      });
    });

    it('advertises ingredient search and the MSK mask instead of a brand search', () => {
      const searchDescription = searchAnimalEventsTool.input.shape.search.description ?? '';

      expect(searchDescription).toContain('drug.active_ingredients.name:"Fluralaner"');
      expect(searchDescription).not.toContain('drug.brand_name');
      expect(searchDescription).not.toContain('Bravecto');
      expect(searchAnimalEventsTool.description).toMatch(/masked as "MSK"/);
    });
  });

  it('format handles sparse payload — all optional fields absent', () => {
    // Upstream record with only the unique ID — all other fields omitted
    const content = searchAnimalEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'SPARSE-AER' }],
    });

    const text = textOf(content);
    expect(text).toContain('SPARSE-AER');
    // Should not crash on missing optional fields
    expect(typeof text).toBe('string');
  });

  it('format renders the metadata header, then "No animal adverse event reports found.", for empty results (#68)', () => {
    const content = searchAnimalEventsTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo animal adverse event reports found.',
    );
  });

  it('format includes meta header with totals', () => {
    const content = searchAnimalEventsTool.format!({
      meta: { total: 150, skip: 0, limit: 10, lastUpdated: '2026-03-01' },
      results: [{ unique_aer_id_number: 'AER-HDR' }],
    });

    const text = textOf(content);
    expect(text).toContain('150 total results');
    expect(text).toContain('2026-03-01');
  });

  it('format renders number_of_animals counts when present', () => {
    const content = searchAnimalEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          unique_aer_id_number: 'AER-CNT',
          number_of_animals_treated: 5,
          number_of_animals_affected: 2,
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('treated: 5');
    expect(text).toContain('affected: 2');
  });
});

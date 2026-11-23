/**
 * @fileoverview Tests for openfda_search_animal_events tool.
 * @module tests/mcp-server/tools/definitions/search-animal-events.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

// No canvas unless a test stages one.
vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(() => undefined),
}));

import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { renderCommonMark } from '../../../helpers/commonmark.js';
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

  // #92 — the endpoint's default page size reaches the request and meta.limit.
  it('pages animalandveterinary/event at its default of 25 when limit is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
      results: [],
    });

    const result = await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    expect(result.meta.limit).toBe(25);
  });

  // #88 — a bare browse is newest first by receive date.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it('sends original_receive_date:desc with neither search nor sort', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({}), ctx);

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'original_receive_date:desc' });
    });

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchAnimalEventsTool.handler(
        searchAnimalEventsTool.input.parse({ search: 'animal.species:"Dog"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchAnimalEventsTool.handler(
        searchAnimalEventsTool.input.parse({ sort: 'original_receive_date:asc' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'original_receive_date:asc' });
    });

    it('states the default in the search and sort descriptions', () => {
      const shape = searchAnimalEventsTool.input.shape;
      expect(shape.search.description).toContain('Omit to browse newest first.');
      expect(shape.sort.description).toContain(
        'With neither search nor sort, records come newest first by original_receive_date:desc.',
      );
    });
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

  /**
   * Under CommonMark a line right after a list item, with no blank line between,
   * continues that item — so the record fields after the drug list rendered
   * inside the last drug's `<li>`. Each drug's own fields still belong in it.
   */
  it('ends the drug list before the record fields that follow it, under CommonMark', () => {
    const text = textOf(
      searchAnimalEventsTool.format!({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-11-10' },
        results: [
          {
            unique_aer_id_number: 'USA-USFDACVM-2026-US-000001',
            original_receive_date: '20261020',
            serious_ae: 'true',
            drug: [
              { active_ingredients: [{ name: 'Fluralaner' }], route: 'Oral', lot_number: 'L1' },
              { active_ingredients: [{ name: 'Moxidectin' }], route: 'Topical', lot_number: 'L2' },
            ],
            outcome: [{ medical_status: 'Recovered/Normal', number_of_animals_affected: '1' }],
            primary_reporter: 'Veterinarian',
            type_of_information: 'Safety Issue',
            foreign_or_domestic: 'Domestic',
            number_of_animals_affected: '1',
            receiver: { organization: 'FDA-CVM' },
          },
        ],
      }),
    );

    const items = [...renderCommonMark(text).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Lot number:</strong> L1');
    expect(items[1]).toContain('Lot number:</strong> L2');
    for (const label of ['Outcome', 'Reporter', 'Type', 'Origin', 'Animals', 'Receiver']) {
      expect(items.join('\n')).not.toContain(`${label}:</strong>`);
      expect(text).toContain(`**${label}:**`);
    }
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

      it('explains the MSK mask for an .exact filter on a masked field', async () => {
        const notice = await emptyNoticeFor('drug.brand_name.exact:"Bravecto"');

        expect(notice).toContain('drug.brand_name and drug.manufacturer.name hold only "MSK"');
      });

      // The guidance follows the fields the search filters on, never their text elsewhere.
      it.each([
        ['inside a quoted phrase', 'reaction.veddra_term_name:"drug.brand_name"'],
        ['as the tail of a longer path', 'other.drug.brand_name:"Bravecto"'],
        ['as the tail of a longer manufacturer path', 'other.drug.manufacturer.name:"Merck"'],
      ])(
        'leaves the MSK line off a search naming a masked field only %s',
        async (_case, search) => {
          const notice = await emptyNoticeFor(search);

          expect(notice).toContain('No animal adverse event reports matched');
          expect(notice).not.toContain('MSK');
        },
      );

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

  // #100 — openFDA tests each clause against the whole record, so AND-ed clauses
  // on different fields of one drug, reaction, or outcome array can be met by
  // different entries; a matched page says so and gives the per-entry SQL.
  describe('clauses one array entry must meet together (#100)', () => {
    const RECORD = {
      unique_aer_id_number: 'AER-100',
      original_receive_date: '20260115',
      serious_ae: 'true',
      drug: [
        { route: 'Oral', dosage_form: 'Tablet', active_ingredients: [{ name: 'Fluralaner' }] },
      ],
      reaction: [{ veddra_term_name: 'Vomiting' }],
    };
    const PAGE = {
      meta: { total: 2, skip: 0, limit: 5, lastUpdated: '2026-11-20' },
      results: [RECORD],
    };
    const EMPTY = { meta: { total: 0, skip: 0, limit: 5, lastUpdated: '2026-11-20' }, results: [] };

    /** A canvas that drains what it is given and records the schema each table was registered with. */
    const stageOnto = () => {
      const schemas: { name: string }[][] = [];
      const instance = {
        canvasId: 'cv_tie',
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
    /** Both surfaces, every text block, with the random staged table name fixed so they compare as literals. */
    const surfaces = (result: Awaited<ReturnType<typeof runToolContract>>) => {
      const fixed = (text: string) => text.replaceAll(/spilled_[0-9a-f]{8}/g, 'spilled_TABLE');
      const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
      return {
        structured: JSON.parse(fixed(JSON.stringify(result.structuredContent))),
        text: text.map(fixed),
      };
    };
    const RECORD_LINES =
      '### Report AER-100\n**Received:** 20260115 | **Serious:** Yes\n**Reactions:** Vomiting\n**Drugs:**\n- Fluralaner (via Oral)\n**Dosage form:** Tablet\n**Active ingredients:** [{"name":"Fluralaner"}]\n\n**Serious ae:** true\n';
    const HEADER =
      '**2 total results** (returned: 1, skip: 0, limit: 5) | Data updated: 2026-11-20\n\n';
    const STAGED_NOTICE =
      'Staged 2 of 2 matched records on canvas table "spilled_TABLE" (canvas_id "cv_tie"). Call openfda_dataframe_describe for the column names, then openfda_dataframe_query to run SQL over the staged set.';
    const STAGED_LINE =
      '> Staged 2 of 2 matched rows on canvas table `spilled_TABLE` (canvas_id `cv_tie`, spilled=true) — openfda_dataframe_describe for its columns, then openfda_dataframe_query for SQL.\n\n';
    const STAGED_FIELDS = {
      canvas_id: 'cv_tie',
      canvas_table: 'spilled_TABLE',
      spilled: true,
      staged_rows: 2,
    };

    afterEach(() => {
      vi.mocked(getCanvas).mockReset();
    });

    it('returns a search with no conjoined pair exactly as before, inline', async () => {
      mockQuery.mockResolvedValue(PAGE);

      const result = await runToolContract(searchAnimalEventsTool, {
        search: 'drug.route:"Oral" OR drug.dosage_form:"Tablet"',
        limit: 5,
      });

      expect(surfaces(result)).toEqual({
        structured: {
          ...PAGE,
          totalResults: 2,
          effectiveQuery: 'drug.route:"Oral" OR drug.dosage_form:"Tablet"',
        },
        text: [
          `${HEADER}${RECORD_LINES}`,
          '\n\n**totalResults:** 2\nQuery: `drug.route:"Oral" OR drug.dosage_form:"Tablet"`',
        ],
      });
    });

    it('returns a search with no conjoined pair exactly as before, staged', async () => {
      stageOnto();
      mockQuery.mockResolvedValue(PAGE);

      const result = await runToolContract(searchAnimalEventsTool, {
        search: 'drug.route:"Oral" AND serious_ae:"true"',
        limit: 5,
        stage: true,
      });

      expect(surfaces(result)).toEqual({
        structured: {
          ...PAGE,
          ...STAGED_FIELDS,
          totalResults: 2,
          effectiveQuery: 'drug.route:"Oral" AND serious_ae:"true"',
          notice: STAGED_NOTICE,
        },
        text: [
          `${HEADER}${STAGED_LINE}${RECORD_LINES}`,
          `\n\n**totalResults:** 2\nQuery: \`drug.route:"Oral" AND serious_ae:"true"\`\n> ${STAGED_NOTICE}`,
        ],
      });
    });

    const TIED = 'drug.active_ingredients.name:"Fluralaner" AND drug.route:"Oral"';
    const FILTER = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '["json"]')) AS d) WHERE d->>'route' ILIKE '%Oral%' AND EXISTS (SELECT 1 FROM (SELECT unnest(from_json(d->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%Fluralaner%'))`;
    const TIE_LEAD =
      'openFDA matches each clause against the whole record, so the clauses on `drug.active_ingredients.name` and `drug.route` can be met by different `drug` entries.';

    it('sends an inline page to stage the search, on both surfaces', async () => {
      mockQuery.mockResolvedValue(PAGE);

      const result = await runToolContract(searchAnimalEventsTool, { search: TIED, limit: 5 });

      const notice = `${TIE_LEAD} For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`;
      expect(surfaces(result)).toEqual({
        structured: { ...PAGE, totalResults: 2, effectiveQuery: TIED, notice },
        text: [
          `${HEADER}${RECORD_LINES}`,
          `\n\n**totalResults:** 2\nQuery: \`${TIED}\`\n> ${notice}`,
        ],
      });
    });

    it('ties a hyphenated value the schema quoted, comparing the value with no stray quote, on both surfaces', async () => {
      mockQuery.mockResolvedValue(PAGE);

      const result = await runToolContract(searchAnimalEventsTool, {
        search:
          'drug.manufacturer.registration_number:USA-USFDACVM-N141426 AND drug.active_ingredients.name:Fluralaner',
        limit: 5,
      });

      const sent =
        'drug.manufacturer.registration_number:"USA-USFDACVM-N141426" AND drug.active_ingredients.name:Fluralaner';
      expect(mockQuery.mock.calls[0]![1].search).toBe(sent);
      const notice = `openFDA matches each clause against the whole record, so the clauses on \`drug.manufacturer.registration_number\` and \`drug.active_ingredients.name\` can be met by different \`drug\` entries. For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '["json"]')) AS d) WHERE d->'manufacturer'->>'registration_number' ILIKE '%USA-USFDACVM-N141426%' AND EXISTS (SELECT 1 FROM (SELECT unnest(from_json(d->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%Fluralaner%'))\`.`;
      expect(surfaces(result)).toEqual({
        structured: { ...PAGE, totalResults: 2, effectiveQuery: sent, notice },
        text: [
          `${HEADER}${RECORD_LINES}`,
          `\n\n**totalResults:** 2\nQuery: \`${sent}\`\n> ${notice}`,
        ],
      });
    });

    /*
     * search-clauses.test.ts tables the SQL text for a quote and an apostrophe;
     * this runs the staged SQL in DuckDB beside a value holding %, _, and '.
     */
    it('runs the staged SQL for that value beside one holding %, _, and an apostrophe, keeping the record one entry meets', {
      timeout: 30_000,
    }, async () => {
      const tenantId = 'animal-events-tie-sql';
      const provider = new DuckdbProvider({
        defaultRowLimit: 1000,
        exportRootPath: '/tmp/openfda-animal-events-tool-test',
        memoryLimitMb: 64,
        schemaSniffRows: 100,
      });
      const canvas = new DataCanvas(
        provider,
        new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
      );
      vi.mocked(getCanvas).mockReturnValue(canvas as never);
      const registration = 'USA-USFDACVM-N141426';
      const lot = "L_5%'A";
      const records = [
        {
          unique_aer_id_number: 'ONE-ENTRY',
          drug: [{ manufacturer: { registration_number: registration }, lot_number: lot }],
        },
        {
          unique_aer_id_number: 'SPLIT',
          drug: [
            { manufacturer: { registration_number: registration }, lot_number: 'L5A' },
            { manufacturer: { registration_number: 'USA-USFDACVM-N000001' }, lot_number: lot },
          ],
        },
      ];
      mockQuery.mockImplementation(
        async (_endpoint: string, params: { limit: number; skip: number }) => ({
          meta: {
            total: records.length,
            skip: params.skip,
            limit: params.limit,
            lastUpdated: '2026-11-20',
          },
          results: structuredClone(records.slice(params.skip, params.skip + params.limit)),
        }),
      );

      try {
        const staged = await runToolContract(
          searchAnimalEventsTool,
          {
            search: `drug.manufacturer.registration_number:${registration} AND drug.lot_number:"${lot}"`,
            stage: true,
          },
          { context: { tenantId } },
        );

        const sent = `drug.manufacturer.registration_number:"${registration}" AND drug.lot_number:"${lot}"`;
        expect(mockQuery.mock.calls.every((call) => call[1].search === sent)).toBe(true);
        const structured = staged.structuredContent as {
          canvas_id: string;
          canvas_table: string;
          effectiveQuery: string;
          notice: string;
          staged_rows: number;
        };
        expect(structured.effectiveQuery).toBe(sent);
        expect(structured.staged_rows).toBe(2);
        const sql = /`(SELECT \* FROM \S+ t WHERE .+)`\.$/.exec(structured.notice)?.[1];
        expect(sql).toBe(
          `SELECT * FROM ${structured.canvas_table} t WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '["json"]')) AS d) WHERE d->'manufacturer'->>'registration_number' ILIKE '%${registration}%' AND d->>'lot_number' ILIKE '%L_5%''A%')`,
        );
        expect(surfaces(staged).text[1]).toContain(`> ${surfaces(staged).structured.notice}`);

        const queried = await runToolContract(
          dataframeQueryTool,
          { canvas_id: structured.canvas_id, query: sql ?? '' },
          { context: { tenantId } },
        );
        expect(queried.isError).toBeFalsy();
        const rows = (queried.structuredContent as { rows: { unique_aer_id_number: string }[] })
          .rows;
        expect(rows.map((row) => row.unique_aer_id_number)).toEqual(['ONE-ENTRY']);
      } finally {
        await canvas.shutdown(createMockContext({ tenantId }));
      }
    });

    it('names the staged table on a staged call, joined after the staging notice', async () => {
      stageOnto();
      mockQuery.mockResolvedValue(PAGE);

      const result = await runToolContract(searchAnimalEventsTool, {
        search: TIED,
        limit: 5,
        stage: true,
      });

      const notice = `${STAGED_NOTICE} ${TIE_LEAD} For one entry meeting them together, query the staged table in openfda_dataframe_query: \`SELECT * FROM spilled_TABLE t WHERE ${FILTER}\`.`;
      expect(surfaces(result).structured).toMatchObject({ ...STAGED_FIELDS, notice });
      expect(surfaces(result).text[1]).toBe(
        `\n\n**totalResults:** 2\nQuery: \`${TIED}\`\n> ${notice}`,
      );
    });

    it('joins the tie notice with the limit clamp when both fire', async () => {
      mockQuery.mockResolvedValue({ ...PAGE, meta: { ...PAGE.meta, limit: 450 } });

      const result = await runToolContract(searchAnimalEventsTool, { search: TIED, limit: 5_000 });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toMatch(/^.*5000.*450.*openFDA matches each clause against the whole record/s);
      expect(notice.match(/openFDA matches each clause/g)).toHaveLength(1);
      expect(surfaces(result).text[1]).toContain(`> ${notice}`);
    });

    it('keeps the tie notice on every page of a cursor walk, a cursor page restaging without the cursor, joined after the walk end', async () => {
      mockQuery.mockImplementation(
        async (_endpoint: string, params: { searchAfter?: { position: number } }) => {
          const position = params.searchAfter?.position ?? 0;
          return {
            meta: { total: 3, skip: position, limit: 1, lastUpdated: '2026-11-20' },
            results: [{ ...RECORD, unique_aer_id_number: `AER-${position}` }],
            nextSearchAfter: `0=AER-${position}`,
          };
        },
      );
      const tieNotice = `${TIE_LEAD} For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`;
      // A call carrying both cursor and stage is refused, so a page read by cursor restages without it.
      const cursorTieNotice = `${TIE_LEAD} For one entry meeting them together, call again without cursor and with stage: true, and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`;
      const walk: { cursor?: string; notice?: string; text: string }[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 3; page++) {
        const result = await runToolContract(searchAnimalEventsTool, {
          search: TIED,
          limit: 1,
          ...(cursor && { cursor }),
        });
        const structured = result.structuredContent as { next_cursor?: string; notice?: string };
        walk.push({
          ...(structured.next_cursor && { cursor: structured.next_cursor }),
          ...(structured.notice && { notice: structured.notice }),
          text: surfaces(result).text.join(''),
        });
        cursor = structured.next_cursor;
      }

      expect(mockQuery.mock.calls.map((call) => call[1].searchAfter)).toEqual([
        undefined,
        { position: 1, value: '0=AER-0' },
        { position: 2, value: '0=AER-1' },
      ]);
      expect(walk.map((p) => p.notice)).toEqual([
        tieNotice,
        cursorTieNotice,
        `This page holds the last 1 of the 3 matched records, so the cursor walk is complete. ${cursorTieNotice}`,
      ]);
      for (const page of walk) expect(page.text).toContain(`> ${page.notice}`);
      expect(walk[0]?.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(walk[1]?.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(walk[0]?.text).toContain(`\nnext_cursor: \`${walk[0]?.cursor}\`\n`);
      expect(walk[1]?.text).toContain(`\nnext_cursor: \`${walk[1]?.cursor}\`\n`);
      expect(walk[2]).not.toHaveProperty('cursor');
      expect(walk[2]?.text).not.toContain('next_cursor:');
    });

    it.each([
      ['inline', {}],
      ['staged', { stage: true }],
    ] as const)('says nothing about entries on a %s total of 0', async (_mode, extra) => {
      if ('stage' in extra) stageOnto();
      mockQuery.mockResolvedValue(EMPTY);

      const result = await runToolContract(searchAnimalEventsTool, {
        search: TIED,
        limit: 5,
        ...extra,
      });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toContain('No animal adverse event reports matched');
      expect(notice).not.toContain('openFDA matches each clause');
    });

    // Every array the notice can name is a column of the staged table.
    it.each([
      ['drug', 'drug.route:"Oral" AND drug.dosage_form:"Tablet"'],
      [
        'drug',
        'drug.active_ingredients.name:"Fluralaner" AND drug.active_ingredients.dose.numerator:"1"',
      ],
      ['reaction', 'reaction.veddra_term_name:"Vomiting" AND reaction.accuracy:"Probable"'],
      ['outcome', 'outcome.medical_status:"Died" AND outcome.number_of_animals_affected:"1"'],
    ] as const)('names %s, a staged column, for %s', async (column, search) => {
      const schemas = stageOnto();
      mockQuery.mockResolvedValue(PAGE);

      const result = await runToolContract(searchAnimalEventsTool, {
        search,
        limit: 5,
        stage: true,
      });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toContain(`different \`${column}\` entries`);
      expect(notice).toContain(`unnest(from_json(t.${column}, '["json"]'))`);
      expect(schemas[0]?.map((c) => c.name)).toContain(column);
    });
  });

  /**
   * #97 — the tool's own cursor surface. The walk, the binding, and the refusals
   * run through every cursor tool in pagination-contract.test.ts; the token at
   * its seam in pagination-cursor.test.ts.
   */
  describe('cursor (#97)', () => {
    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(searchAnimalEventsTool.input) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required ?? []).not.toContain('cursor');
      const output = z.toJSONSchema(searchAnimalEventsTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
      expect(searchAnimalEventsTool.errors).toContain(invalidCursorError);
      expect(searchAnimalEventsTool.errors).toContain(paginationLimitReachedError);
      expect(
        searchAnimalEventsTool.errors?.filter((e) => e.reason === 'pagination_limit_reached'),
      ).toHaveLength(1);
    });

    it('sends no searchAfter and returns no next_cursor key without a cursor or a link', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 3, skip: 0, limit: 25, lastUpdated: '2026-01-01' },
        results: [{ unique_aer_id_number: 'AER-1' }],
      });

      const result = await searchAnimalEventsTool.handler(
        searchAnimalEventsTool.input.parse({}),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
    });

    it('renders next_cursor after the header and before the records', () => {
      const text = textOf(
        searchAnimalEventsTool.format!({
          meta: { total: 30, skip: 0, limit: 1, lastUpdated: '2026-01-01' },
          results: [{ unique_aer_id_number: 'AER-1' }],
          next_cursor: 'eyJwIjox_-',
        }),
      );
      const lines = text.split('\n');
      expect(lines[0]).toMatch(/^\*\*30 total results\*\*/);
      expect(lines[2]).toBe('next_cursor: `eyJwIjox_-`');
      expect(text.indexOf('### Report AER-1')).toBeGreaterThan(text.indexOf('next_cursor'));
    });
  });
});

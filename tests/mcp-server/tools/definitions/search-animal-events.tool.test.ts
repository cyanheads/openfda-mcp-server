/**
 * @fileoverview Tests for openfda_search_animal_events tool.
 * @module tests/mcp-server/tools/definitions/search-animal-events.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_animal_events', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries animalandveterinary/event endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-1' }],
    });

    const result = await searchAnimalEventsTool.handler({}, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('animalandveterinary/event');
    expect(result.results).toHaveLength(1);
  });

  it('passes search, sort, limit, skip to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 5, skip: 10, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-2' }],
    });

    await searchAnimalEventsTool.handler(
      { search: 'animal.species:"Dog"', sort: 'original_receive_date:desc', limit: 5, skip: 10 },
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

    await searchAnimalEventsTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(99);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-4' }],
    });

    await searchAnimalEventsTool.handler({ search: 'drug.brand_name:"Bravecto"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('drug.brand_name:"Bravecto"');
  });

  it('does not set effectiveQuery when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-5' }],
    });

    await searchAnimalEventsTool.handler({}, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAnimalEventsTool.handler({ search: 'animal.species:"Unicorn"' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('sets pagination-context notice when empty at skip > 0', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 100, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAnimalEventsTool.handler({ skip: 100 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=100/);
  });

  it('formats records with animal and reaction fields', () => {
    const content = searchAnimalEventsTool.format({
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
          drug: [{ brand_name: 'Bravecto', route: 'oral', administered_by: 'Owner' }],
          outcome: [{ medical_status: 'Recovered' }],
          primary_reporter: 'Veterinarian',
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('AER-FMT-1');
    expect(text).toContain('20260115');
    expect(text).toContain('Dog');
    expect(text).toContain('Labrador');
    expect(text).toContain('Vomiting');
    expect(text).toContain('Bravecto');
    expect(text).toContain('Recovered');
    expect(text).toContain('Veterinarian');
  });

  it('format handles sparse payload — all optional fields absent', () => {
    // Upstream record with only the unique ID — all other fields omitted
    const content = searchAnimalEventsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'SPARSE-AER' }],
    });

    const text = content[0].text;
    expect(text).toContain('SPARSE-AER');
    // Should not crash on missing optional fields
    expect(typeof text).toBe('string');
  });

  it('format returns "No animal adverse event reports found." for empty results', () => {
    const content = searchAnimalEventsTool.format({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    expect(content[0].text).toBe('No animal adverse event reports found.');
  });

  it('format includes meta header with totals', () => {
    const content = searchAnimalEventsTool.format({
      meta: { total: 150, skip: 0, limit: 10, lastUpdated: '2026-03-01' },
      results: [{ unique_aer_id_number: 'AER-HDR' }],
    });

    const text = content[0].text;
    expect(text).toContain('150 total results');
    expect(text).toContain('2026-03-01');
  });

  it('format renders number_of_animals counts when present', () => {
    const content = searchAnimalEventsTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          unique_aer_id_number: 'AER-CNT',
          number_of_animals_treated: 5,
          number_of_animals_affected: 2,
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('treated: 5');
    expect(text).toContain('affected: 2');
  });
});

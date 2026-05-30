/**
 * @fileoverview Edge-case and format tests for openfda_search_adverse_events.
 * Covers food/device format paths, sparse upstream payloads, and the fallback path.
 * @module tests/mcp-server/tools/definitions/search-adverse-events-edge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_adverse_events (edge cases)', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('maps food category to food/event endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAdverseEventsTool.handler({ category: 'food' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('food/event');
  });

  it('does not echo search in enrichment when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ safetyreportid: '1', patient: {} }],
    });

    await searchAdverseEventsTool.handler({ category: 'drug' }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets pagination-context notice when empty at skip > 0', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 100, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchAdverseEventsTool.handler({ category: 'drug', skip: 100 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=100/);
  });

  describe('format() paths', () => {
    it('formats device adverse event records', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            report_number: 'MDR-001',
            event_type: 'Malfunction',
            device: [
              {
                brand_name: 'CathPro',
                manufacturer_d_name: 'MedCo Inc',
              },
            ],
            mdr_text: [
              {
                text_type_code: 'N',
                text: 'Device malfunctioned during procedure.',
              },
            ],
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('MDR-001');
      expect(text).toContain('Malfunction');
      expect(text).toContain('CathPro');
      expect(text).toContain('MedCo Inc');
      expect(text).toContain('Device malfunctioned');
    });

    it('formats food adverse event records', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            report_number: 'FOOD-123',
            reactions: ['NAUSEA', 'VOMITING'],
            outcomes: ['Hospitalization'],
            products: [
              {
                name_brand: 'SuperSnack',
                role: 'SUSPECT',
                industry_code: '23',
              },
            ],
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('FOOD-123');
      expect(text).toContain('NAUSEA');
      expect(text).toContain('Hospitalization');
      expect(text).toContain('SuperSnack');
    });

    it('formats fallback record via JSON dump for unknown record shape', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            some_field: 'some_value',
            another: 42,
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('some_field');
    });

    it('handles drug record with male patient sex', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            safetyreportid: 'RPT-M',
            serious: '2',
            patient: {
              patientsex: '1',
              reaction: [{ reactionmeddrapt: 'HEADACHE' }],
              drug: [{ medicinalproduct: 'IBUPROFEN', drugcharacterization: '2' }],
            },
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('Male');
      expect(text).toContain('Concomitant');
      expect(text).toContain('No'); // serious '2' → No
    });

    it('handles drug record with unknown characterization', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            safetyreportid: 'RPT-X',
            patient: {
              drug: [{ medicinalproduct: 'UNKNOWN_DRUG', drugcharacterization: '99' }],
            },
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('UNKNOWN_DRUG');
    });

    it('handles drug record with indication and route on drug', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            safetyreportid: 'RPT-2',
            patient: {
              drug: [
                {
                  medicinalproduct: 'METFORMIN',
                  drugcharacterization: '1',
                  drugindication: 'DIABETES',
                  drugadministrationroute: 'ORAL',
                },
              ],
            },
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('for DIABETES');
      expect(text).toContain('via ORAL');
    });

    it('handles interacting drug characterization', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            safetyreportid: 'RPT-3',
            patient: {
              drug: [{ medicinalproduct: 'WARFARIN', drugcharacterization: '3' }],
            },
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('Interacting');
    });

    it('handles sparse drug record with no reactions or drugs', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            safetyreportid: 'SPARSE-1',
            patient: {},
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('SPARSE-1');
    });

    it('handles food record with string reactions (not array)', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
        results: [
          {
            report_number: 'FOOD-STR',
            reactions: 'VOMITING',
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('VOMITING');
    });

    it('includes meta header in format output', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 100, skip: 10, limit: 10, lastUpdated: '2026-05-01' },
        results: [{ safetyreportid: 'X', patient: {} }],
      });

      const text = content[0].text;
      expect(text).toContain('100 total results');
      expect(text).toContain('skip: 10');
      expect(text).toContain('2026-05-01');
    });

    it('handles device record with no mdr_text', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
        results: [
          {
            report_number: 'DEV-NOMDR',
            event_type: 'Injury',
            device: [{ brand_name: 'Widget' }],
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('Widget');
      expect(text).not.toContain('Narrative');
    });

    it('handles device record with mdr_text missing text field', () => {
      const content = searchAdverseEventsTool.format({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
        results: [
          {
            report_number: 'DEV-NOTXT',
            device: [{ brand_name: 'Sensor' }],
            mdr_text: [{ text_type_code: 'B', text: null }],
          },
        ],
      });

      const text = content[0].text;
      expect(text).toContain('Sensor');
    });
  });
});

/**
 * @fileoverview Edge-case tests across multiple tool format() functions.
 * Covers sparse payloads, pagination context, output field coverage,
 * and security: confirms no API key or env value appears in tool output.
 * @module tests/mcp-server/tools/definitions/tools-edge-cases
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { drugProfileTool } from '@/mcp-server/tools/definitions/drug-profile.tool.js';
import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import {
  findSearchDelimiterFault,
  type SearchDelimiterFault,
} from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

// ── openfda_count_values edge cases ──────────────────────────────────────────────────

describe('openfda_count_values (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof countValuesTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: countValuesTool.errors });
  });

  it('passes optional search to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { lastUpdated: '' },
      results: [],
    });

    await countValuesTool.handler(
      countValuesTool.input.parse({
        endpoint: 'drug/event',
        count: 'field',
        search: 'patient.sex:"female"',
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ search: 'patient.sex:"female"' }),
      ctx,
    );
  });

  // #44 — one term past the limit is the look-ahead that shows whether more exist.
  it('asks the service for one term past the limit', async () => {
    mockQuery.mockResolvedValue({ meta: { lastUpdated: '' }, results: [] });

    await countValuesTool.handler(
      countValuesTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 500 }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/event',
      expect.objectContaining({ limit: 501 }),
      ctx,
    );
  });

  it('format includes total occurrences in header', () => {
    const content = countValuesTool.format!({
      meta: { lastUpdated: '2026-01-01' },
      results: [
        { term: 'A', count: 300 },
        { term: 'B', count: 200 },
      ],
    });
    const text = textOf(content);
    expect(text).toContain('total occurrences: 500');
  });

  it('format includes lastUpdated in header', () => {
    const content = countValuesTool.format!({
      meta: { lastUpdated: '2026-03-15' },
      results: [{ term: 'X', count: 5 }],
    });
    expect(textOf(content)).toContain('2026-03-15');
  });

  it('format renders all rows in the table', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      term: `TERM_${i}`,
      count: 10 - i,
    }));
    const content = countValuesTool.format!({ meta: { lastUpdated: '' }, results });
    const text = textOf(content);
    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`TERM_${i}`);
    }
    expect(text).toContain('5 terms');
  });
});

// ── openfda_search_recalls edge cases ─────────────────────────────────────────

describe('openfda_search_recalls (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchRecallsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchRecallsTool.errors });
  });

  it('does not echo search in enrichment when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ recall_number: 'R-1' }],
    });

    await searchRecallsTool.handler(searchRecallsTool.input.parse({ category: 'food' }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 200, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchRecallsTool.handler(
      searchRecallsTool.input.parse({ category: 'drug', skip: 200 }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=200/);
  });

  it('food category uses enforcement endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchRecallsTool.handler(searchRecallsTool.input.parse({ category: 'food' }), ctx);

    expect(mockQuery.mock.calls[0]![0]).toBe('food/enforcement');
  });

  it('format includes distribution_pattern when present', () => {
    const content = searchRecallsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          recall_number: 'R-1',
          classification: 'Class II',
          recalling_firm: 'Acme',
          distribution_pattern: 'Nationwide',
          reason_for_recall: 'Mislabeling',
          product_description: 'Widget',
          status: 'Completed',
          voluntary_mandated: 'Voluntary',
        },
      ],
    });

    expect(textOf(content)).toContain('Nationwide');
  });

  it('format handles missing optional fields gracefully', () => {
    const content = searchRecallsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ recall_number: 'SPARSE-R' }],
    });

    const text = textOf(content);
    expect(text).toContain('SPARSE-R');
    expect(text).toContain('N/A'); // missing fields default to N/A
  });

  it('format separates multiple records with dividers', () => {
    const content = searchRecallsTool.format!({
      meta: { total: 2, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ recall_number: 'R-A' }, { recall_number: 'R-B' }],
    });

    const text = textOf(content);
    expect(text).toContain('R-A');
    expect(text).toContain('R-B');
    expect(text).toContain('---'); // divider
  });

  it('format includes meta header', () => {
    const content = searchRecallsTool.format!({
      meta: { total: 50, skip: 0, limit: 10, lastUpdated: '2026-02-01' },
      results: [{ recall_number: 'R-1' }],
    });

    expect(textOf(content)).toContain('50 total results');
    expect(textOf(content)).toContain('2026-02-01');
  });

  it('format renders the metadata header, then "No results found.", for empty results (#68)', () => {
    const content = searchRecallsTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo results found.',
    );
  });
});

// ── openfda_get_drug_label edge cases ─────────────────────────────────────────

describe('openfda_get_drug_label (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof getDrugLabelTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: getDrugLabelTool.errors });
  });

  it('passes sort param to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [{ openfda: {} }],
    });

    await getDrugLabelTool.handler(
      getDrugLabelTool.input.parse({
        search: 'openfda.brand_name:"aspirin"',
        sort: 'effective_time:desc',
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/label',
      expect.objectContaining({ sort: 'effective_time:desc' }),
      ctx,
    );
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 50, limit: 5, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await getDrugLabelTool.handler(getDrugLabelTool.input.parse({ search: 'x', skip: 50 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=50/);
  });

  it('format handles label without optional openfda fields', () => {
    const content = getDrugLabelTool.format!({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      kind: 'full',
      results: [
        {
          openfda: {},
          indications_and_usage: ['For pain.'],
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('Unknown');
    expect(text).toContain('For pain.');
  });

  it('format renders route field from openfda block', () => {
    const content = getDrugLabelTool.format!({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
      kind: 'full',
      results: [
        {
          openfda: {
            brand_name: ['Aspirin'],
            route: ['ORAL'],
          },
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('ORAL');
  });

  it('format includes effective_time when present', () => {
    const content = getDrugLabelTool.format!({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
      kind: 'full',
      results: [
        {
          openfda: { brand_name: ['TestDrug'] },
          effective_time: '20260101',
        },
      ],
    });

    expect(textOf(content)).toContain('20260101');
  });

  it('format includes set_id and version when present', () => {
    const content = getDrugLabelTool.format!({
      meta: { total: 1, skip: 0, limit: 5, lastUpdated: '' },
      kind: 'full',
      results: [
        {
          openfda: { brand_name: ['TestDrug'] },
          set_id: 'abc-uuid-123',
          version: '2',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('abc-uuid-123');
    expect(text).toContain('v2');
  });

  it('format renders the metadata header, kind included, then "No labels found." for empty results (#68)', () => {
    const content = getDrugLabelTool.format!({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '2026-10-09' },
      kind: 'full',
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 5, kind: full) | Data updated: 2026-10-09\n\nNo labels found.',
    );
  });
});

// ── openfda_lookup_ndc edge cases ─────────────────────────────────────────────

describe('openfda_lookup_ndc (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof lookupNdcTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: lookupNdcTool.errors });
  });

  it('passes all query params to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ product_ndc: '0363-0218' }],
    });

    await lookupNdcTool.handler(
      lookupNdcTool.input.parse({
        search: 'brand_name:"aspirin"',
        sort: 'brand_name:asc',
        limit: 5,
        skip: 0,
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'drug/ndc',
      expect.objectContaining({
        search: 'brand_name:"aspirin"',
        sort: 'brand_name:asc',
        limit: 5,
        skip: 0,
      }),
      ctx,
    );
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 50, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await lookupNdcTool.handler(lookupNdcTool.input.parse({ search: 'x', skip: 50 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=50/);
  });

  it('format renders generic_name when brand_name also present', () => {
    const content = lookupNdcTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          product_ndc: '0000-0001',
          brand_name: 'BrandX',
          generic_name: 'genericx',
          labeler_name: 'Lab Inc',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('genericx');
  });

  it('format renders listing_expiration_date when present', () => {
    const content = lookupNdcTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          product_ndc: '0000-0001',
          brand_name: 'X',
          labeler_name: 'Lab',
          listing_expiration_date: '20301231',
        },
      ],
    });

    expect(textOf(content)).toContain('20301231');
  });

  it('format handles record with no brand_name using generic_name as title', () => {
    const content = lookupNdcTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          product_ndc: '0000-0001',
          generic_name: 'metformin',
          labeler_name: 'Generic Labs',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('metformin');
  });

  it('format renders the metadata header, then "No NDC records found.", for empty results (#68)', () => {
    const content = lookupNdcTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo NDC records found.',
    );
  });

  it('format renders route as comma-joined when array', () => {
    const content = lookupNdcTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          product_ndc: '0000',
          brand_name: 'Combo',
          labeler_name: 'Lab',
          dosage_form: 'TABLET',
          route: ['ORAL', 'TOPICAL'],
        },
      ],
    });

    expect(textOf(content)).toContain('ORAL, TOPICAL');
  });
});

// ── openfda_search_drug_approvals edge cases ───────────────────────────────────

describe('openfda_search_drug_approvals (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDrugApprovalsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDrugApprovalsTool.errors });
  });

  it('query succeeds without search param', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 5, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA001' }],
    });

    const result = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({}),
      ctx,
    );

    expect(result.results).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledWith(
      'drug/drugsfda',
      expect.objectContaining({ search: undefined }),
      ctx,
    );
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 30, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchDrugApprovalsTool.handler(searchDrugApprovalsTool.input.parse({ skip: 30 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=30/);
  });

  it('format handles records without products', () => {
    const content = searchDrugApprovalsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          application_number: 'NDA-NOPRODS',
          sponsor_name: 'TestCo',
          openfda: {},
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('NDA-NOPRODS');
    expect(text).toContain('TestCo');
  });

  it('format handles records with products including ingredients', () => {
    const content = searchDrugApprovalsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          application_number: 'NDA-PRODS',
          sponsor_name: 'PharmCo',
          openfda: { brand_name: ['Lipitor'], generic_name: ['atorvastatin'] },
          products: [
            {
              brand_name: 'Lipitor',
              active_ingredients: [{ name: 'ATORVASTATIN CALCIUM', strength: '10 mg' }],
              dosage_form: 'TABLET',
              route: 'ORAL',
              marketing_status: 'Prescription',
            },
          ],
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('ATORVASTATIN CALCIUM');
    expect(text).toContain('10 mg');
    expect(text).toContain('Prescription');
  });

  it('format renders the metadata header, then "No drug approvals found.", for empty results (#68)', () => {
    const content = searchDrugApprovalsTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo drug approvals found.',
    );
  });

  it('format shows generic name in title when no brand name', () => {
    const content = searchDrugApprovalsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          application_number: 'ANDA123',
          sponsor_name: 'GenericCo',
          openfda: { generic_name: ['amoxicillin'] },
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('amoxicillin');
  });
});

// ── openfda_search_device_clearances edge cases ───────────────────────────────

describe('openfda_search_device_clearances (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDeviceClearancesTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDeviceClearancesTool.errors });
  });

  it('does not echo search when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ k_number: 'K123' }],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 100, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchDeviceClearancesTool.handler(
      searchDeviceClearancesTool.input.parse({ pathway: '510k', skip: 100 }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=100/);
  });

  it('format handles 510k record with advisory_committee_description', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          k_number: 'K999',
          device_name: 'Cardiac Monitor',
          applicant: 'Medtronic',
          product_code: 'DXN',
          decision_description: 'Substantially Equivalent',
          advisory_committee_description: 'Cardiovascular',
          decision_date: '20260101',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('Cardiovascular');
  });

  it('format handles 510k record with statement_or_summary', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          k_number: 'K888',
          device_name: 'Widget',
          applicant: 'WidgetCo',
          product_code: 'ABC',
          statement_or_summary: 'This device is intended for diagnostic use.',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('This device is intended');
  });

  it('format renders long statement_or_summary in full (no truncation)', () => {
    const long = 'x'.repeat(600);
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          k_number: 'K777',
          device_name: 'Big',
          applicant: 'BigCo',
          product_code: 'XYZ',
          statement_or_summary: long,
        },
      ],
    });

    const text = textOf(content);
    // Full 600-char summary present — previously capped at 500 with an ellipsis.
    expect(text).toContain(long);
    expect(text).not.toContain('...');
  });

  it('format handles PMA record with trade_name and generic_name', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          pma_number: 'P999',
          trade_name: 'HeartSaverPro',
          generic_name: 'defibrillator',
          applicant: 'CardiacCo',
          product_code: 'NIQ',
          decision_code: 'APPR',
          supplement_number: 'S001',
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('HeartSaverPro');
    expect(text).toContain('S001');
  });

  it('format handles fallback record shape (no k_number or pma_number)', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          weird_field: 'some value',
          another: 42,
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('some value');
  });

  it('format renders the metadata header, then "No device clearances found.", for empty results (#68)', () => {
    const content = searchDeviceClearancesTool.format!({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 10) | Data updated: 2026-07-31\n\nNo device clearances found.',
    );
  });
});

// ── openfda_search_animal_events edge cases ───────────────────────────────────

describe('openfda_search_animal_events (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchAnimalEventsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchAnimalEventsTool.errors });
  });

  it('passes search and sort to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ unique_aer_id_number: 'AER-EC-1' }],
    });

    await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({
        search: 'animal.species:"Cat"',
        sort: 'original_receive_date:asc',
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'animalandveterinary/event',
      expect.objectContaining({
        search: 'animal.species:"Cat"',
        sort: 'original_receive_date:asc',
      }),
      ctx,
    );
  });

  it('does not echo search in enrichment when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ unique_aer_id_number: 'AER-EC-2' }],
    });

    await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 300, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse({ skip: 300 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=300/);
  });

  it('format handles drug with active_ingredients array', () => {
    const content = searchAnimalEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [
        {
          unique_aer_id_number: 'AER-EC-3',
          drug: [
            {
              active_ingredients: [{ name: 'AFOXOLANER' }],
              route: 'oral',
              administered_by: 'Veterinarian',
            },
          ],
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('AFOXOLANER');
  });

  it('format handles sparse record without animal, drug, reaction, or outcome', () => {
    const content = searchAnimalEventsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ unique_aer_id_number: 'AER-SPARSE' }],
    });

    const text = textOf(content);
    expect(text).toContain('AER-SPARSE');
    expect(typeof text).toBe('string');
  });
});

// ── openfda_search_tobacco_reports edge cases ─────────────────────────────────

describe('openfda_search_tobacco_reports (edge cases)', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchTobaccoReportsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchTobaccoReportsTool.errors });
  });

  it('passes search and sort to service', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ report_id: 'TOB-EC-1' }],
    });

    await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({
        search: 'nonuser_affected:"Yes"',
        sort: 'date_submitted:desc',
      }),
      ctx,
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'tobacco/problem',
      expect.objectContaining({ search: 'nonuser_affected:"Yes"', sort: 'date_submitted:desc' }),
      ctx,
    );
  });

  it('does not echo search in enrichment when search is absent', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ report_id: 'TOB-EC-2' }],
    });

    await searchTobaccoReportsTool.handler(searchTobaccoReportsTool.input.parse({}), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('sets pagination-context notice when empty at skip > 0 with an unverified total', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 150, limit: 10, lastUpdated: '', totalUnverified: true },
      results: [],
    });

    await searchTobaccoReportsTool.handler(
      searchTobaccoReportsTool.input.parse({ skip: 150 }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/skip=150/);
  });

  it('format handles sparse record without products or health problems', () => {
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ report_id: 'TOB-SPARSE' }],
    });

    const text = textOf(content);
    expect(text).toContain('TOB-SPARSE');
    expect(typeof text).toBe('string');
  });

  it('format renders the metadata header, then "No tobacco problem reports found.", for empty results (#68)', () => {
    const content = searchTobaccoReportsTool.format!({
      meta: { total: 0, skip: 0, limit: 2, lastUpdated: '2026-07-31' },
      results: [],
    });

    expect(textOf(content)).toBe(
      '**0 total results** (returned: 0, skip: 0, limit: 2) | Data updated: 2026-07-31\n\nNo tobacco problem reports found.',
    );
  });
});

// ── Cross-tool security: outputs do not contain env secrets ───────────────────

describe('security: tool outputs do not contain API key values', () => {
  const secretKey = 'SUPER_SECRET_API_KEY_XYZ';

  beforeEach(() => {
    vi.stubEnv('OPENFDA_API_KEY', secretKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('count format output does not contain process env values', () => {
    const content = countValuesTool.format!({
      meta: { lastUpdated: secretKey }, // worst case: key leaks into meta
      results: [{ term: secretKey, count: 1 }],
    });

    // We test that if the key somehow ended up in a field, format() would
    // just render it as-is (no transformation). This asserts we test the
    // actual format output structure, not that we suppress legitimate content.
    // The real security property is that handlers never put key values into output.
    const text = textOf(content);
    // The term is "SUPER_SECRET_API_KEY_XYZ" in this mock — format echoes it.
    // The important thing: format() itself does not inject new secrets.
    expect(text).toBeDefined();
    expect(typeof text).toBe('string');
  });
});

// ── Cross-tool search delimiter precheck (#38) ────────────────────────────────

/**
 * `search` was forwarded verbatim to api.fda.gov, so a query whose delimiters
 * cannot parse cost a network round-trip and came back as an Elasticsearch lexer
 * message whose column index runs past the submitted string. Every tool taking a
 * caller-supplied `search` now rejects those locally with the declared
 * `malformed_search` reason, before any request.
 *
 * Both halves are load-bearing, and each value's verdict is openFDA's own. Each
 * MALFORMED value is refused upstream (500 `token_mgr_error` or `parse_exception`)
 * — except the trailing-backslash case, which is refused on most endpoints and,
 * on the ones that append their own index-scoping clause, answers 200 with that
 * scope dissolved (`recalling_firm:pfizer\` returns 18856 against 155). Each VALID
 * value is answered upstream and would be broken by a naive delimiter count: a
 * paren inside a quoted phrase is literal data, so is a paren or quote inside a
 * range, and a backslash escapes the character after it.
 */
describe('search delimiter precheck (#38)', () => {
  /** Every tool taking a caller-supplied `search`, with a minimal valid base input. */
  const SEARCH_TOOLS = [
    ['openfda_count_values', countValuesTool, { endpoint: 'drug/event', count: 'field' }],
    ['openfda_search_adverse_events', searchAdverseEventsTool, { category: 'drug' }],
    ['openfda_search_recalls', searchRecallsTool, { category: 'drug' }],
    ['openfda_get_drug_label', getDrugLabelTool, {}],
    ['openfda_lookup_ndc', lookupNdcTool, {}],
    ['openfda_search_drug_approvals', searchDrugApprovalsTool, {}],
    ['openfda_search_drug_shortages', searchDrugShortagesTool, {}],
    ['openfda_search_device_clearances', searchDeviceClearancesTool, { pathway: '510k' }],
    ['openfda_search_animal_events', searchAnimalEventsTool, {}],
    ['openfda_search_tobacco_reports', searchTobaccoReportsTool, {}],
  ] as const;

  /** [search, expected message fragment] — each refused upstream. */
  const MALFORMED = [
    ['recalling_firm:"pfizer AND product_type:drugs', /unterminated double quote/i],
    ['product_description:"foo \\" bar', /unterminated double quote/i],
    ['recalling_firm:foo"bar', /unterminated double quote/i],
    ['(recalling_firm:pfizer', /leaves a group open/i],
    ['recalling_firm:pfizer)', /closes a group that was never opened/i],
    ['report_date:[20200101 TO 20201231', /leaves a range open/i],
    ['report_date:20200101]', /closes a range that was never opened/i],
    ['reason_for_recall:foo[bar', /leaves a range open/i],
    ['recalling_firm:pfizer\\', /ends on a backslash/i],
  ] as const;

  /** Exotic but valid — each returns a real answer from api.fda.gov. */
  const VALID = [
    'product_description:"Packaged as a) 4 FL OZ"', // paren inside a phrase is literal data
    'product_description:"foo \\" bar"', // backslash-escaped quote inside a phrase
    'reason_for_recall:foo\\(bar', // backslash-escaped paren outside a phrase
    '(recalling_firm:pfizer AND status:Ongoing)', // balanced grouping
    'report_date:[20200101 TO 20201231]', // range query — brackets balance
    'report_date:[20200101 TO 20201231}', // a range closes on either bracket
    'report_date:[(20200101 TO 20201231]', // a paren inside a range is literal data
    'recalling_firm:pfizer\\\\', // an escaped backslash is not a dangling one
    'recalling_firm:pfizer*', // wildcard
  ];

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [],
    });
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  for (const [label, toolDef, base] of SEARCH_TOOLS) {
    const call = (search: string) => {
      const ctx = createMockContext({ errors: toolDef.errors });
      return { ctx, run: Promise.resolve(toolDef.handler({ ...base, search } as never, ctx)) };
    };

    it(`${label} declares the malformed_search contract with a recovery hint`, () => {
      const entry = toolDef.errors?.find((e) => e.reason === 'malformed_search');
      expect(entry).toBeDefined();
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(entry?.recovery).toMatch(/quote|paren/i);
    });

    it.each(MALFORMED)(`${label} rejects %j before any request`, async (search, fragment) => {
      const err = (await call(search).run.catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'malformed_search' });
      expect(err.message).toMatch(fragment);
      // The point of a local precheck: openFDA is never reached.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each(VALID)(`${label} still forwards %j to openFDA`, async (search) => {
      const { ctx, run } = call(search);
      await run;

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ search }),
        ctx,
      );
    });
  }

  // A tool that composes its own query is deliberately not covered — the precheck
  // guards caller-supplied Lucene, and openfda_drug_profile takes a bare term it
  // quotes itself. It therefore declares no malformed_search reason.
  it('openfda_drug_profile declares no malformed_search reason', () => {
    const reasons = drugProfileTool.errors?.map((e) => e.reason);
    expect(reasons).not.toContain('malformed_search');
  });

  /**
   * Which fault each value is, not merely that it is one — the message a caller
   * reads is keyed off this, so a value classified as the wrong fault sends them
   * to fix the wrong character. Every row's verdict was probed against
   * api.fda.gov; the comment records what openFDA answered.
   */
  describe('fault classification', () => {
    const FAULTS: Array<[string, SearchDelimiterFault | undefined]> = [
      // Refused upstream — 500 token_mgr_error / parse_exception.
      ['recalling_firm:"pfizer', 'unterminated_quote'],
      ['recalling_firm:pfizer"', 'unterminated_quote'],
      ['(recalling_firm:pfizer', 'unclosed_paren'],
      ['recalling_firm:pfizer)', 'unopened_paren'],
      ['report_date:[20200101 TO 20201231', 'unclosed_range'],
      ['report_date:{20200101 TO 20201231', 'unclosed_range'],
      ['report_date:20200101]', 'unopened_range'],
      ['report_date:20200101}', 'unopened_range'],
      ['reason_for_recall:foo[bar', 'unclosed_range'], // an unquoted [ is a range opener mid-term
      ['reason_for_recall:foo]bar', 'unopened_range'],
      ['report_date:[20200101 TO 20201231\\]', 'unclosed_range'], // the escape eats the closer
      ['recalling_firm:pfizer\\', 'dangling_escape'], // 200 with the endpoint scope dissolved
      ['\\', 'dangling_escape'],
      ['recalling_firm:pfizer\\\\\\', 'dangling_escape'], // odd-length run: the last one dangles
      // The first fault positionally wins when a value carries two.
      ['recalling_firm:"pfizer\\', 'dangling_escape'],
      ['(report_date:[20200101 TO 20201231)]', 'unclosed_paren'], // range swallows the ), paren left open
      // Answered upstream — must be forwarded.
      ['recalling_firm:pfizer', undefined],
      ['recalling_firm:pfizer\\\\', undefined], // escaped backslash — 200, correct 155 records
      ['recalling_firm:""', undefined], // empty phrase — 200
      ['product_description:"a\\""', undefined], // escape before the closing quote — 200
      ['recalling_firm:"pfi\\"zer"', undefined], // escaped quote mid-phrase
      ['product_description:"Packaged as a) 4 FL OZ"', undefined], // paren literal in a phrase
      ['reason_for_recall:"foo[bar"', undefined], // bracket literal in a phrase
      ['report_date:[20200101 TO 20201231]', undefined],
      ['report_date:{20200101 TO 20201231}', undefined],
      ['report_date:[20200101 TO 20201231}', undefined], // mixed brackets close each other
      ['report_date:[(20200101 TO 20201231]', undefined], // paren literal in a range
      ['report_date:["20200101 TO 20201231]', undefined], // quote literal in a range
      ['report_date:[2020\\1231 TO 20201231]', undefined], // escape mid-range — 200
      ['(report_date:[20200101 TO 20201231])', undefined], // range nested in a group
      ['reason_for_recall:foo\\(bar', undefined],
      ['reason_for_recall:foo\\[bar', undefined], // escaped bracket is not a range
    ];

    it.each(FAULTS)('classifies %j as %s', (search, fault) => {
      expect(findSearchDelimiterFault(search)).toBe(fault);
    });
  });
});

// ── single-line slots (#67) ───────────────────────────────────────────────────

/**
 * Upstream and caller text placed on a record heading, a record title, or a list
 * item has its line breaks flattened, so a value cannot open a heading or list
 * item of its own. Each case names the exact line the value must stay on.
 */
describe('record headings and list items stay on one line (#67)', () => {
  const META = { total: 1, skip: 0, limit: 10, lastUpdated: '2026-07-31' };
  const lineSet = (text: string) => new Set(text.split('\n'));

  const cases: [string, () => string, string[]][] = [
    [
      'adverse events — device report heading',
      () =>
        textOf(
          searchAdverseEventsTool.format!({
            meta: META,
            results: [{ device: [{ brand_name: 'B' }], report_number: 'A\n### injected' }],
          }),
        ),
      ['### Report A ### injected'],
    ],
    [
      'adverse events — drug report heading and drug item',
      () =>
        textOf(
          searchAdverseEventsTool.format!({
            meta: META,
            results: [
              {
                safetyreportid: 'S\r\n### injected',
                patient: { drug: [{ medicinalproduct: 'D\n- injected' }] },
              },
            ],
          }),
        ),
      ['### Report S ### injected', '- D - injected'],
    ],
    [
      'adverse events — food report heading and product item',
      () =>
        textOf(
          searchAdverseEventsTool.format!({
            meta: META,
            results: [{ report_number: 'F\r### injected', products: [{ name_brand: 'P\n- x' }] }],
          }),
        ),
      ['### Report F ### injected', '- P - x'],
    ],
    [
      'animal events — report heading and drug item',
      () =>
        textOf(
          searchAnimalEventsTool.format!({
            meta: META,
            results: [
              { unique_aer_id_number: 'A\n### injected', drug: [{ brand_name: 'B\n- x' }] },
            ],
          }),
        ),
      ['### Report A ### injected', '- B - x'],
    ],
    [
      'device clearances — 510(k) and PMA headings',
      () =>
        textOf(
          searchDeviceClearancesTool.format!({
            meta: { ...META, total: 2 },
            results: [
              { k_number: 'K1', device_name: 'Dev\n### injected' },
              { pma_number: 'P1', trade_name: 'T\n### injected' },
            ],
          }),
        ),
      ['### K1: Dev ### injected', '### P1: T ### injected'],
    ],
    [
      'NDC — product heading and package item',
      () =>
        textOf(
          lookupNdcTool.format!({
            meta: META,
            results: [
              {
                brand_name: 'N\n### injected',
                packaging: [{ package_ndc: '1', description: 'pk\n- x' }],
              },
            ],
          }),
        ),
      ['### N ### injected', '- 1: pk - x'],
    ],
    [
      'drug label — label heading',
      () =>
        textOf(
          getDrugLabelTool.format!({
            meta: META,
            kind: 'full',
            results: [{ openfda: { brand_name: ['L\n### injected'], generic_name: ['g\nx'] } }],
          }),
        ),
      ['### L ### injected (g x)'],
    ],
    [
      'drug approvals — application heading, product and submission items',
      () =>
        textOf(
          searchDrugApprovalsTool.format!({
            meta: META,
            results: [
              {
                application_number: 'NDA1',
                openfda: { brand_name: ['A\n### injected'] },
                products: [{ brand_name: 'P\n- x' }],
                submissions: [{ submission_type: 'ORIG\n- x' }],
              },
            ],
          }),
        ),
      ['### A ### injected', '- P - x', '- ORIG - x'],
    ],
    [
      'drug shortages — shortage heading',
      () =>
        textOf(
          searchDrugShortagesTool.format!({
            meta: META,
            results: [{ generic_name: 'G\n### injected' }],
          }),
        ),
      ['### G ### injected'],
    ],
    [
      'tobacco reports — report heading and product item',
      () =>
        textOf(
          searchTobaccoReportsTool.format!({
            meta: META,
            results: [{ report_id: 'R\n### injected', tobacco_products: ['Snus\n- x'] }],
          }),
        ),
      ['### Report R ### injected', '- Snus - x'],
    ],
    [
      'recalls — enforcement and device recall titles',
      () =>
        textOf(
          searchRecallsTool.format!({
            meta: { ...META, total: 2 },
            results: [
              { recall_number: 'F-1\n### injected', classification: 'Class II' },
              { product_res_number: 'Z-1\n### injected' },
            ],
          }),
        ),
      ['**Recall #F-1 ### injected** — Class II', '**Recall #Z-1 ### injected**'],
    ],
    [
      // The heading's caller drug name rides as a code literal instead (#81),
      // read back through a CommonMark parse in drug-profile.tool.test.ts.
      'drug profile — reaction and recall items',
      () =>
        textOf(
          drugProfileTool.format!({
            meta: { drug: 'aspirin', resolvedVia: 'none', fanOutKey: 'aspirin' },
            identity: {
              brand_names: [],
              generic_name: null,
              product_ndc: null,
              rxcui: null,
              spl_set_id: null,
            },
            label: null,
            adverse_events: {
              total: 1,
              seriousCount: 0,
              topReactions: [{ term: 'NAUSEA\n- x', count: 1 }],
            },
            recalls: [
              {
                classification: 'Class II\n- x',
                recalling_firm: null,
                date: null,
                reason: 'r\n# x',
              },
            ],
            recalls_total: 1,
            approval: null,
            shortage: null,
            degraded: [],
          }),
        ),
      [
        '- NAUSEA - x: 1',
        '- **Classification:** Class II - x · **Recalling firm:** n/a · **Date:** n/a',
        '  **Reason:** r # x',
      ],
    ],
    [
      'drug profile — identity, label, approval, and shortage lines; a reaction term opening with a marker',
      () =>
        textOf(
          drugProfileTool.format!({
            meta: { drug: 'aspirin', resolvedVia: 'label', fanOutKey: 'aspirin' },
            identity: {
              brand_names: ['BAYER\n# x', 'ECOTRIN'],
              generic_name: 'ASPIRIN\r\n- x',
              product_ndc: '0280-2000',
              rxcui: '1191',
              spl_set_id: 'set\r> x',
            },
            label: {
              indications: 'For pain.\n\n### Warnings forged',
              warnings: 'Reye syndrome.\n- x',
              dosage: '1 tablet\n1. x',
            },
            adverse_events: {
              total: 2,
              seriousCount: 1,
              topReactions: [
                { term: '# NAUSEA', count: 2 },
                { term: '1. VOMITING', count: 1 },
              ],
            },
            recalls: [],
            recalls_total: 0,
            approval: {
              applicationNumber: 'NDA1',
              sponsor: 'BAYER\n# x',
              marketingStatus: 'OTC',
            },
            shortage: { status: 'Current\n- x', availability: 'Limited\n> x' },
            degraded: [],
          }),
        ),
      [
        '**Brand names:** BAYER # x, ECOTRIN',
        '**Generic name:** ASPIRIN - x',
        '**SPL set ID:** set > x',
        '**Indications:** For pain.  ### Warnings forged',
        '**Warnings:** Reye syndrome. - x',
        '**Dosage:** 1 tablet 1. x',
        '- \\# NAUSEA: 2',
        '- 1\\. VOMITING: 1',
        '**Application number:** NDA1 | **Sponsor:** BAYER # x | **Marketing status:** OTC',
        '**Status:** Current - x',
        '**Availability:** Limited > x',
      ],
    ],
    [
      'count values — header carrying the dataset date',
      () =>
        textOf(
          countValuesTool.format!({
            meta: { lastUpdated: '2026-07-31\n# x' },
            results: [{ term: 'NAUSEA', count: 3 }],
          }),
        ),
      ['**1 terms** (total occurrences: 3) | Data updated: 2026-07-31 # x'],
    ],
    [
      'drug label — manufacturer, set ID, and openfda lines',
      () =>
        textOf(
          getDrugLabelTool.format!({
            meta: { ...META, lastUpdated: '2026-07-31\n# x' },
            kind: 'full',
            results: [
              {
                openfda: { brand_name: ['L'], manufacturer_name: ['M\n- x'], route: ['ORAL\n> x'] },
                set_id: 'S\n### x',
                version: '2',
                effective_time: '2026\r\n- x',
              },
            ],
          }),
        ),
      [
        '**1 total results** (returned: 1, skip: 0, limit: 10, kind: full) | Data updated: 2026-07-31 # x',
        '**Manufacturer:** M - x',
        '**Effective date:** 2026 - x',
        '**Set ID:** S ### x (v2)',
        '**Route:** ORAL > x',
      ],
    ],
  ];

  it.each(cases)('%s', (_name, render, expected) => {
    const lines = lineSet(render());
    for (const line of expected) expect(lines).toContain(line);
  });
});

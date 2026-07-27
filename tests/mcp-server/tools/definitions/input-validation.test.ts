/**
 * @fileoverview Input validation tests for all openFDA tool Zod schemas.
 * Verifies that invalid, missing, out-of-range, and malformed inputs are
 * rejected by the schema layer with clear errors, and that valid boundary
 * values are accepted.
 * @module tests/mcp-server/tools/definitions/input-validation
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
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

// ── openfda_count_values ────────────────────────────────────────────────────────────

describe('openfda_count_values input schema', () => {
  it('accepts valid minimal input', () => {
    const input = countValuesTool.input.parse({
      endpoint: 'drug/event',
      count: 'patient.reaction.reactionmeddrapt.exact',
    });
    expect(input.endpoint).toBe('drug/event');
    expect(input.limit).toBe(100); // default
  });

  it('rejects missing endpoint', () => {
    expect(() => countValuesTool.input.parse({ count: 'some.field' })).toThrow();
  });

  it('rejects unknown endpoint value', () => {
    expect(() =>
      countValuesTool.input.parse({ endpoint: 'unknown/endpoint', count: 'field' }),
    ).toThrow();
  });

  it('rejects missing count', () => {
    expect(() => countValuesTool.input.parse({ endpoint: 'drug/event' })).toThrow();
  });

  it('accepts limit=1 (minimum)', () => {
    const input = countValuesTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit=1000 (maximum)', () => {
    const input = countValuesTool.input.parse({
      endpoint: 'drug/event',
      count: 'field',
      limit: 1000,
    });
    expect(input.limit).toBe(1000);
  });

  it('rejects limit=0 (below minimum)', () => {
    expect(() =>
      countValuesTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 0 }),
    ).toThrow();
  });

  it('rejects limit=1001 (above maximum)', () => {
    expect(() =>
      countValuesTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 1001 }),
    ).toThrow();
  });

  it('accepts all valid endpoints', () => {
    const validEndpoints = [
      'drug/event',
      'drug/label',
      'drug/enforcement',
      'drug/ndc',
      'drug/drugsfda',
      'food/event',
      'food/enforcement',
      'device/event',
      'device/510k',
      'device/pma',
      'device/recall',
      'device/enforcement',
      'animalandveterinary/event',
      'tobacco/problem',
    ] as const;

    for (const endpoint of validEndpoints) {
      expect(() => countValuesTool.input.parse({ endpoint, count: 'field.exact' })).not.toThrow();
    }
  });

  it('accepts optional search param', () => {
    const input = countValuesTool.input.parse({
      endpoint: 'drug/event',
      count: 'field',
      search: 'patient.drug.medicinalproduct:"aspirin"',
    });
    expect(input.search).toBe('patient.drug.medicinalproduct:"aspirin"');
  });

  it('accepts undefined optional search param', () => {
    const input = countValuesTool.input.parse({ endpoint: 'drug/event', count: 'field' });
    expect(input.search).toBeUndefined();
  });
});

// ── openfda_search_adverse_events ─────────────────────────────────────────────

describe('openfda_search_adverse_events input schema', () => {
  it('accepts valid minimal input', () => {
    const input = searchAdverseEventsTool.input.parse({ category: 'drug' });
    expect(input.category).toBe('drug');
    expect(input.limit).toBe(10); // default
    expect(input.skip).toBe(0); // default
  });

  it('rejects missing category', () => {
    expect(() => searchAdverseEventsTool.input.parse({})).toThrow();
  });

  it('rejects invalid category', () => {
    expect(() => searchAdverseEventsTool.input.parse({ category: 'veterinary' })).toThrow();
  });

  it('accepts all valid categories', () => {
    for (const category of ['drug', 'food', 'device'] as const) {
      expect(() => searchAdverseEventsTool.input.parse({ category })).not.toThrow();
    }
  });

  it('rejects limit below 1', () => {
    expect(() => searchAdverseEventsTool.input.parse({ category: 'drug', limit: 0 })).toThrow();
  });

  it('rejects limit above 1000', () => {
    expect(() => searchAdverseEventsTool.input.parse({ category: 'drug', limit: 1001 })).toThrow();
  });

  it('rejects skip below 0', () => {
    expect(() => searchAdverseEventsTool.input.parse({ category: 'drug', skip: -1 })).toThrow();
  });

  it('admits skip above 25000 so the handler can raise the typed contract (#27)', () => {
    const input = searchAdverseEventsTool.input.parse({ category: 'drug', skip: 25001 });
    expect(input.skip).toBe(25001);
  });

  it('accepts limit=1 (boundary)', () => {
    const input = searchAdverseEventsTool.input.parse({ category: 'drug', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts skip=25000 (boundary)', () => {
    const input = searchAdverseEventsTool.input.parse({ category: 'drug', skip: 25000 });
    expect(input.skip).toBe(25000);
  });
});

// ── openfda_search_recalls ────────────────────────────────────────────────────

describe('openfda_search_recalls input schema', () => {
  it('accepts valid minimal input', () => {
    const input = searchRecallsTool.input.parse({ category: 'drug' });
    expect(input.category).toBe('drug');
    expect(input.endpoint).toBe('enforcement'); // default
  });

  it('rejects missing category', () => {
    expect(() => searchRecallsTool.input.parse({})).toThrow();
  });

  it('rejects invalid category', () => {
    expect(() => searchRecallsTool.input.parse({ category: 'invalid' })).toThrow();
  });

  it('accepts endpoint=recall', () => {
    const input = searchRecallsTool.input.parse({ category: 'device', endpoint: 'recall' });
    expect(input.endpoint).toBe('recall');
  });

  it('rejects invalid endpoint value', () => {
    expect(() =>
      searchRecallsTool.input.parse({ category: 'drug', endpoint: 'withdrawal' }),
    ).toThrow();
  });

  it('admits skip above 25000 so the handler can raise the typed contract (#27)', () => {
    const input = searchRecallsTool.input.parse({ category: 'drug', skip: 25001 });
    expect(input.skip).toBe(25001);
  });

  it('accepts skip=0 (minimum)', () => {
    const input = searchRecallsTool.input.parse({ category: 'drug', skip: 0 });
    expect(input.skip).toBe(0);
  });
});

// ── openfda_get_drug_label ────────────────────────────────────────────────────

describe('openfda_get_drug_label input schema', () => {
  it('accepts valid input', () => {
    const input = getDrugLabelTool.input.parse({
      search: 'openfda.brand_name:"aspirin"',
    });
    expect(input.search).toBe('openfda.brand_name:"aspirin"');
    expect(input.limit).toBe(5); // default
    expect(input.skip).toBe(0);
  });

  it('rejects missing search', () => {
    expect(() => getDrugLabelTool.input.parse({})).toThrow();
  });

  it('accepts limit=1 (boundary)', () => {
    const input = getDrugLabelTool.input.parse({
      search: 'openfda.brand_name:"aspirin"',
      limit: 1,
    });
    expect(input.limit).toBe(1);
  });

  it('rejects limit=0', () => {
    expect(() => getDrugLabelTool.input.parse({ search: 'aspirin', limit: 0 })).toThrow();
  });

  it('accepts limit=1000 (max)', () => {
    const input = getDrugLabelTool.input.parse({ search: 'aspirin', limit: 1000 });
    expect(input.limit).toBe(1000);
  });

  it('rejects limit=1001', () => {
    expect(() => getDrugLabelTool.input.parse({ search: 'aspirin', limit: 1001 })).toThrow();
  });

  it('rejects skip=-1', () => {
    expect(() => getDrugLabelTool.input.parse({ search: 'aspirin', skip: -1 })).toThrow();
  });

  it('accepts skip=25000 (boundary)', () => {
    const input = getDrugLabelTool.input.parse({ search: 'aspirin', skip: 25000 });
    expect(input.skip).toBe(25000);
  });

  it('admits skip=25001 so the handler can raise the typed contract (#27)', () => {
    const input = getDrugLabelTool.input.parse({ search: 'aspirin', skip: 25001 });
    expect(input.skip).toBe(25001);
  });
});

// ── openfda_lookup_ndc ────────────────────────────────────────────────────────

describe('openfda_lookup_ndc input schema', () => {
  it('accepts valid input', () => {
    const input = lookupNdcTool.input.parse({ search: 'product_ndc:"0363-0218"' });
    expect(input.search).toBe('product_ndc:"0363-0218"');
    expect(input.limit).toBe(10);
    expect(input.skip).toBe(0);
  });

  it('rejects missing search', () => {
    expect(() => lookupNdcTool.input.parse({})).toThrow();
  });

  it('accepts limit boundaries', () => {
    expect(() => lookupNdcTool.input.parse({ search: 'x', limit: 1 })).not.toThrow();
    expect(() => lookupNdcTool.input.parse({ search: 'x', limit: 1000 })).not.toThrow();
  });

  it('rejects out-of-range limit', () => {
    expect(() => lookupNdcTool.input.parse({ search: 'x', limit: 0 })).toThrow();
    expect(() => lookupNdcTool.input.parse({ search: 'x', limit: 1001 })).toThrow();
  });

  it('rejects negative skip but admits over-ceiling skip for the handler (#27)', () => {
    expect(() => lookupNdcTool.input.parse({ search: 'x', skip: -1 })).toThrow();
    expect(lookupNdcTool.input.parse({ search: 'x', skip: 25001 }).skip).toBe(25001);
  });
});

// ── openfda_search_drug_approvals ─────────────────────────────────────────────

describe('openfda_search_drug_approvals input schema', () => {
  it('accepts empty input (all optional)', () => {
    const input = searchDrugApprovalsTool.input.parse({});
    expect(input.limit).toBe(10);
    expect(input.skip).toBe(0);
    expect(input.search).toBeUndefined();
  });

  it('accepts valid search query', () => {
    const input = searchDrugApprovalsTool.input.parse({
      search: 'sponsor_name:"PFIZER"',
    });
    expect(input.search).toBe('sponsor_name:"PFIZER"');
  });

  it('rejects out-of-range limit', () => {
    expect(() => searchDrugApprovalsTool.input.parse({ limit: 0 })).toThrow();
    expect(() => searchDrugApprovalsTool.input.parse({ limit: 1001 })).toThrow();
  });

  it('rejects negative skip but admits over-ceiling skip for the handler (#27)', () => {
    expect(() => searchDrugApprovalsTool.input.parse({ skip: -1 })).toThrow();
    expect(searchDrugApprovalsTool.input.parse({ skip: 25001 }).skip).toBe(25001);
  });
});

// ── openfda_search_device_clearances ─────────────────────────────────────────

describe('openfda_search_device_clearances input schema', () => {
  it('accepts valid minimal input with pathway', () => {
    const input = searchDeviceClearancesTool.input.parse({ pathway: '510k' });
    expect(input.pathway).toBe('510k');
    expect(input.limit).toBe(10);
  });

  it('rejects missing pathway', () => {
    expect(() => searchDeviceClearancesTool.input.parse({})).toThrow();
  });

  it('rejects invalid pathway', () => {
    expect(() => searchDeviceClearancesTool.input.parse({ pathway: 'de_novo' })).toThrow();
  });

  it('accepts both valid pathways', () => {
    expect(() => searchDeviceClearancesTool.input.parse({ pathway: '510k' })).not.toThrow();
    expect(() => searchDeviceClearancesTool.input.parse({ pathway: 'pma' })).not.toThrow();
  });

  it('rejects out-of-range limit', () => {
    expect(() => searchDeviceClearancesTool.input.parse({ pathway: '510k', limit: 0 })).toThrow();
  });

  it('admits skip above 25000 so the handler can raise the typed contract (#27)', () => {
    const input = searchDeviceClearancesTool.input.parse({ pathway: '510k', skip: 25001 });
    expect(input.skip).toBe(25001);
  });
});

// ── openfda_search_animal_events ──────────────────────────────────────────────

describe('openfda_search_animal_events input schema', () => {
  it('accepts empty input (all optional)', () => {
    const input = searchAnimalEventsTool.input.parse({});
    expect(input.limit).toBe(10);
    expect(input.skip).toBe(0);
    expect(input.search).toBeUndefined();
    expect(input.sort).toBeUndefined();
  });

  it('accepts valid search and sort', () => {
    const input = searchAnimalEventsTool.input.parse({
      search: 'animal.species:"Dog"',
      sort: 'original_receive_date:desc',
    });
    expect(input.search).toBe('animal.species:"Dog"');
    expect(input.sort).toBe('original_receive_date:desc');
  });

  it('rejects limit below 1', () => {
    expect(() => searchAnimalEventsTool.input.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above 1000', () => {
    expect(() => searchAnimalEventsTool.input.parse({ limit: 1001 })).toThrow();
  });

  it('accepts limit=1 and limit=1000 boundaries', () => {
    expect(() => searchAnimalEventsTool.input.parse({ limit: 1 })).not.toThrow();
    expect(() => searchAnimalEventsTool.input.parse({ limit: 1000 })).not.toThrow();
  });

  it('rejects skip below 0', () => {
    expect(() => searchAnimalEventsTool.input.parse({ skip: -1 })).toThrow();
  });

  it('admits skip above 25000 so the handler can raise the typed contract (#27)', () => {
    expect(searchAnimalEventsTool.input.parse({ skip: 25001 }).skip).toBe(25001);
  });

  it('accepts skip=25000 (boundary)', () => {
    const input = searchAnimalEventsTool.input.parse({ skip: 25000 });
    expect(input.skip).toBe(25000);
  });
});

// ── openfda_search_tobacco_reports ────────────────────────────────────────────

describe('openfda_search_tobacco_reports input schema', () => {
  it('accepts empty input (all optional)', () => {
    const input = searchTobaccoReportsTool.input.parse({});
    expect(input.limit).toBe(10);
    expect(input.skip).toBe(0);
    expect(input.search).toBeUndefined();
    expect(input.sort).toBeUndefined();
  });

  it('accepts valid search and sort', () => {
    const input = searchTobaccoReportsTool.input.parse({
      search: 'tobacco_products:"Electronic cigarette"',
      sort: 'date_submitted:desc',
    });
    expect(input.search).toBe('tobacco_products:"Electronic cigarette"');
    expect(input.sort).toBe('date_submitted:desc');
  });

  it('rejects limit below 1', () => {
    expect(() => searchTobaccoReportsTool.input.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above 1000', () => {
    expect(() => searchTobaccoReportsTool.input.parse({ limit: 1001 })).toThrow();
  });

  it('accepts limit=1 and limit=1000 boundaries', () => {
    expect(() => searchTobaccoReportsTool.input.parse({ limit: 1 })).not.toThrow();
    expect(() => searchTobaccoReportsTool.input.parse({ limit: 1000 })).not.toThrow();
  });

  it('rejects skip below 0', () => {
    expect(() => searchTobaccoReportsTool.input.parse({ skip: -1 })).toThrow();
  });

  it('admits skip above 25000 so the handler can raise the typed contract (#27)', () => {
    expect(searchTobaccoReportsTool.input.parse({ skip: 25001 }).skip).toBe(25001);
  });

  it('accepts skip=25000 (boundary)', () => {
    const input = searchTobaccoReportsTool.input.parse({ skip: 25000 });
    expect(input.skip).toBe(25000);
  });
});

// ── Blank required free-text inputs (#25) ─────────────────────────────────────

/**
 * openFDA's URL builder omits a falsy or blank parameter, so a blank required
 * query silently became an unfiltered browse over the whole corpus (or, for
 * count, a record query that then failed parsing a missing `count` field). Every
 * required free-text input rejects blanks at the schema layer, before any
 * upstream request is issued.
 */
describe('required free-text inputs reject blank values', () => {
  const BLANKS = ['', '   ', '\t', '\n  \t'];

  const cases: Array<[string, (value: string) => unknown]> = [
    ['openfda_get_drug_label.search', (v) => getDrugLabelTool.input.parse({ search: v })],
    ['openfda_lookup_ndc.search', (v) => lookupNdcTool.input.parse({ search: v })],
    [
      'openfda_count_values.count',
      (v) => countValuesTool.input.parse({ endpoint: 'drug/event', count: v }),
    ],
    ['openfda_drug_profile.drug', (v) => drugProfileTool.input.parse({ drug: v })],
    [
      'openfda_dataframe_query.canvas_id',
      (v) => dataframeQueryTool.input.parse({ canvas_id: v, query: 'SELECT 1' }),
    ],
    [
      'openfda_dataframe_query.query',
      (v) => dataframeQueryTool.input.parse({ canvas_id: 'cv-1', query: v }),
    ],
    [
      'openfda_dataframe_describe.canvas_id',
      (v) => dataframeDescribeTool.input.parse({ canvas_id: v }),
    ],
  ];

  for (const [label, parse] of cases) {
    it.each(BLANKS)(`${label} rejects %j`, (blank) => {
      expect(() => parse(blank)).toThrow();
    });

    it(`${label} accepts a non-blank value`, () => {
      expect(() => parse('aspirin')).not.toThrow();
    });
  }

  // The constraint is advertised, not only enforced: a client reading the tool's
  // JSON Schema sees minLength + pattern rather than discovering the rule on rejection.
  it('advertises the non-blank constraint in the JSON Schema', () => {
    const schema = z.toJSONSchema(getDrugLabelTool.input) as {
      properties: { search: { minLength?: number; pattern?: string } };
    };
    expect(schema.properties.search.minLength).toBe(1);
    expect(schema.properties.search.pattern).toBeDefined();
  });
});

// ── Blank optional free-text inputs (#35) ─────────────────────────────────────

/**
 * Omitting an optional free-text input is a legitimate mode — an unfiltered
 * browse, an unsorted result set, a fresh canvas. Supplying a blank one is not:
 * the URL builder drops a falsy parameter and openFDA reads a whitespace-only
 * one as match-all, so a caller who believes it filtered gets the endpoint's
 * whole corpus back with no error and no notice. `.optional()` on
 * `nonBlankString()` keeps omission valid while rejecting a supplied blank at
 * the schema layer, before any upstream request is issued.
 */
describe('optional free-text inputs reject blank values', () => {
  const BLANKS = ['', '   ', '\t', '\n  \t'];

  /** Tool label, its input schema, a minimal valid base input, and the optional free-text fields on it. */
  const cases: Array<
    [string, { parse: (value: unknown) => unknown }, Record<string, unknown>, string[]]
  > = [
    [
      'openfda_count_values',
      countValuesTool.input,
      { endpoint: 'drug/event', count: 'x' },
      ['search'],
    ],
    ['openfda_get_drug_label', getDrugLabelTool.input, { search: 'aspirin' }, ['sort']],
    ['openfda_lookup_ndc', lookupNdcTool.input, { search: 'aspirin' }, ['sort', 'canvas_id']],
    [
      'openfda_search_adverse_events',
      searchAdverseEventsTool.input,
      { category: 'drug' },
      ['search', 'sort', 'canvas_id'],
    ],
    [
      'openfda_search_animal_events',
      searchAnimalEventsTool.input,
      {},
      ['search', 'sort', 'canvas_id'],
    ],
    [
      'openfda_search_device_clearances',
      searchDeviceClearancesTool.input,
      { pathway: '510k' },
      ['search', 'sort', 'canvas_id'],
    ],
    [
      'openfda_search_drug_approvals',
      searchDrugApprovalsTool.input,
      {},
      ['search', 'sort', 'canvas_id'],
    ],
    [
      'openfda_search_drug_shortages',
      searchDrugShortagesTool.input,
      {},
      ['search', 'sort', 'canvas_id'],
    ],
    [
      'openfda_search_recalls',
      searchRecallsTool.input,
      { category: 'drug' },
      ['search', 'sort', 'canvas_id'],
    ],
    [
      'openfda_search_tobacco_reports',
      searchTobaccoReportsTool.input,
      {},
      ['search', 'sort', 'canvas_id'],
    ],
  ];

  for (const [label, schema, base, fields] of cases) {
    for (const field of fields) {
      it.each(BLANKS)(`${label}.${field} rejects %j`, (blank) => {
        expect(() => schema.parse({ ...base, [field]: blank })).toThrow();
      });

      it(`${label}.${field} accepts a non-blank value`, () => {
        expect(() => schema.parse({ ...base, [field]: 'value' })).not.toThrow();
      });
    }

    it(`${label} still accepts every optional free-text input omitted`, () => {
      const parsed = schema.parse(base) as Record<string, unknown>;
      for (const field of fields) {
        expect(parsed[field]).toBeUndefined();
      }
    });
  }

  // Omission stays valid and the constraint stays visible: the optional fields
  // carry minLength + pattern without joining `required`.
  it('advertises the constraint on optional inputs without making them required', () => {
    const schema = z.toJSONSchema(searchRecallsTool.input) as {
      properties: Record<string, { minLength?: number; pattern?: string }>;
      required?: string[];
    };
    for (const field of ['search', 'sort', 'canvas_id']) {
      expect(schema.properties[field]?.minLength).toBe(1);
      expect(schema.properties[field]?.pattern).toBeDefined();
      expect(schema.required ?? []).not.toContain(field);
    }
  });
});

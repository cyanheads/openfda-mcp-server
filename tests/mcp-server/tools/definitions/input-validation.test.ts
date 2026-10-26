/**
 * @fileoverview Input validation tests for all openFDA tool Zod schemas.
 * Verifies that invalid, missing, out-of-range, and malformed inputs are
 * rejected by the schema layer with clear errors, and that valid boundary
 * values are accepted.
 * @module tests/mcp-server/tools/definitions/input-validation
 */

import { spawnSync } from 'node:child_process';
import { z } from '@cyanheads/mcp-ts-core';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { getFieldGroups } from '@/mcp-server/tools/field-catalog.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { initOpenFdaService } from '@/services/openfda/openfda-service.js';

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
      'openfda_dataframe_query.query',
      (v) => dataframeQueryTool.input.parse({ canvas_id: 'cv_abc1234', query: v }),
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
    const search = z.toJSONSchema(getDrugLabelTool.input).properties?.search;
    if (typeof search !== 'object') throw new Error('search is not advertised as a schema');
    expect(search.minLength).toBe(1);
    expect(search.pattern).toBeDefined();
  });
});

// ── Blank optional free-text inputs (#35) ─────────────────────────────────────

/**
 * Omitting an optional free-text input is a legitimate mode — an unfiltered
 * browse, an unsorted result set. Supplying a blank one is not:
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
    ['openfda_lookup_ndc', lookupNdcTool.input, { search: 'aspirin' }, ['sort']],
    [
      'openfda_search_adverse_events',
      searchAdverseEventsTool.input,
      { category: 'drug' },
      ['search', 'sort'],
    ],
    ['openfda_search_animal_events', searchAnimalEventsTool.input, {}, ['search', 'sort']],
    [
      'openfda_search_device_clearances',
      searchDeviceClearancesTool.input,
      { pathway: '510k' },
      ['search', 'sort'],
    ],
    ['openfda_search_drug_approvals', searchDrugApprovalsTool.input, {}, ['search', 'sort']],
    ['openfda_search_drug_shortages', searchDrugShortagesTool.input, {}, ['search', 'sort']],
    ['openfda_search_recalls', searchRecallsTool.input, { category: 'drug' }, ['search', 'sort']],
    ['openfda_search_tobacco_reports', searchTobaccoReportsTool.input, {}, ['search', 'sort']],
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
    for (const field of ['search', 'sort']) {
      expect(schema.properties[field]?.minLength).toBe(1);
      expect(schema.properties[field]?.pattern).toBeDefined();
      expect(schema.required ?? []).not.toContain(field);
    }
  });
});

// ── canvas_id shape ───────────────────────────────────────────────────────────

/**
 * Every `canvas_id` input is declared with the framework's `CanvasIdSchema`, the
 * shape the canvas registry mints (10 URL-safe characters). A value that could
 * never be an id — blank, the wrong length, a stray character — is rejected at
 * argument validation with the pattern advertised in `inputSchema`, instead of
 * reaching the registry and failing there as an expired canvas.
 */
describe('canvas_id inputs take the minted canvas-id shape', () => {
  const VALID_ID = 'cv_abc1234';
  const NOT_AN_ID = ['', '   ', 'cv_abc123', 'cv_abc12345', 'cv abc123', 'cv_abc123!'];

  /** Tool label, its input schema, a minimal valid base input, and whether canvas_id is required. */
  const cases: Array<[string, { parse: (value: unknown) => unknown }, object, boolean]> = [
    ['openfda_dataframe_query', dataframeQueryTool.input, { query: 'SELECT 1' }, true],
    ['openfda_dataframe_describe', dataframeDescribeTool.input, {}, true],
    ['openfda_lookup_ndc', lookupNdcTool.input, { search: 'aspirin' }, false],
    ['openfda_search_adverse_events', searchAdverseEventsTool.input, { category: 'drug' }, false],
    ['openfda_search_animal_events', searchAnimalEventsTool.input, {}, false],
    [
      'openfda_search_device_clearances',
      searchDeviceClearancesTool.input,
      { pathway: '510k' },
      false,
    ],
    ['openfda_search_drug_approvals', searchDrugApprovalsTool.input, {}, false],
    ['openfda_search_drug_shortages', searchDrugShortagesTool.input, {}, false],
    ['openfda_search_recalls', searchRecallsTool.input, { category: 'drug' }, false],
    ['openfda_search_tobacco_reports', searchTobaccoReportsTool.input, {}, false],
  ];

  for (const [label, schema, base, required] of cases) {
    it.each(NOT_AN_ID)(`${label}.canvas_id rejects %j`, (value) => {
      expect(() => schema.parse({ ...base, canvas_id: value })).toThrow();
    });

    it(`${label}.canvas_id accepts a minted-shape id`, () => {
      expect(schema.parse({ ...base, canvas_id: VALID_ID })).toMatchObject({
        canvas_id: VALID_ID,
      });
    });

    it(`${label}.canvas_id is ${required ? 'required' : 'optional'}`, () => {
      if (required) expect(() => schema.parse(base)).toThrow();
      else expect((schema.parse(base) as { canvas_id?: string }).canvas_id).toBeUndefined();
    });
  }

  it('advertises the id pattern without making an optional canvas_id required', () => {
    const schema = z.toJSONSchema(searchRecallsTool.input) as {
      properties: Record<string, { pattern?: string }>;
      required?: string[];
    };
    expect(schema.properties.canvas_id?.pattern).toBe('^[A-Za-z0-9_-]{10}$');
    expect(schema.required ?? []).not.toContain('canvas_id');
  });
});

// ── pattern timing ────────────────────────────────────────────────────────────

/**
 * The runtimes a caller-text pattern is timed on. The engine is the variable:
 * vitest runs this file on Node, while the server runs on Bun, whose
 * JavaScriptCore backtracks differently — a pattern that repeats a parenthesized
 * group stays linear on V8 and grows several-hundredfold on JavaScriptCore.
 */
const TIMING_RUNTIMES = [
  ['Bun', 'bun'],
  ['Node', 'node'],
] as const;

/**
 * Per-call thread CPU time, in microseconds, of `new RegExp(pattern).test(input)`
 * for each input, measured in a child `runtime` process: each input runs until
 * 20 ms of CPU accrue, and the fastest of five such samples is kept, so a busy
 * machine can neither fake a pass nor a fail.
 */
function regexCpuMicros(runtime: string, pattern: string, inputs: string[]): number[] {
  const script = `
    const { pattern, inputs } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    const rx = new RegExp(pattern);
    const perCall = (input) => {
      let best = Infinity;
      for (let sample = 0; sample < 5; sample++) {
        const start = process.threadCpuUsage();
        let calls = 0;
        let used;
        do {
          rx.test(input);
          calls += 1;
          used = process.threadCpuUsage(start);
        } while (used.user + used.system < 20000);
        best = Math.min(best, (used.user + used.system) / calls);
      }
      return best;
    };
    process.stdout.write(JSON.stringify(inputs.map(perCall)));`;
  const run = spawnSync(runtime, ['-e', script], {
    input: JSON.stringify({ pattern, inputs }),
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    throw new Error(`${runtime} timing run failed: ${run.error?.message ?? run.stderr}`);
  }
  return JSON.parse(run.stdout) as number[];
}

// ── sort grammar (#38, #64) ───────────────────────────────────────────────────

/**
 * `sort` was `nonBlankString()` — any non-blank value reached api.fda.gov and a
 * malformed one came back as an Elasticsearch mapping error. The schema now
 * carries the accepted shape as a `pattern`.
 *
 * openFDA honours only a lowercase `asc` or `desc`, or no direction (ascending).
 * Any other direction token — `DESC`, `Desc`, `ascending`, `"desc"`, an empty
 * `field:` — answers HTTP 200 with that sort key dropped, on every sortable
 * endpoint, so it is never forwarded as sent. A direction whose meaning is
 * certain (`asc`/`desc`/`ascending`/`descending` in any letter case) is
 * normalized to `asc` or `desc` by the schema; anything else is rejected.
 *
 * Every ACCEPTED value returns HTTP 200 from api.fda.gov with the requested
 * ordering, and every REJECTED one is either refused upstream (400 "Sorting
 * allowed by non-analyzed fields only" / "Sort not supported", or 500
 * `query_shard_exception`) or silently drops its sort key. openFDA trims spaces
 * around a segment, so a space after a comma sorts identically to the
 * space-free form; a space *inside* a segment is not trimmed and stays rejected.
 * The whole value is also trimmed of any whitespace — tab, line break, no-break
 * space — so that may surround it, but nowhere else.
 */
describe('sort accepts the directions openFDA honours and rejects the rest', () => {
  /** Every tool carrying a caller-supplied `sort`, with a minimal valid base input. */
  const SORT_DEFINITIONS: Array<[AnyToolDefinition, Record<string, unknown>]> = [
    [searchAdverseEventsTool, { category: 'drug' }],
    [searchRecallsTool, { category: 'drug' }],
    [getDrugLabelTool, { search: 'aspirin' }],
    [lookupNdcTool, { search: 'aspirin' }],
    [searchDrugApprovalsTool, {}],
    [searchDrugShortagesTool, {}],
    [searchDeviceClearancesTool, { pathway: '510k' }],
    [searchAnimalEventsTool, {}],
    [searchTobaccoReportsTool, {}],
  ];
  const SORT_TOOLS = SORT_DEFINITIONS.map(
    ([definition, base]) =>
      [definition.name, definition.input as { parse: (value: unknown) => unknown }, base] as const,
  );

  /** Accepted and forwarded byte-identical on every tool — each already in the form openFDA honours. */
  const ACCEPTED = [
    'report_date:desc', // the documented form
    'report_date', // bare field path — ascending upstream
    'report_date:desc,status.exact:asc', // multi-field sort — 200 upstream
    'submissions.submission_status_date:desc', // deep dotted path
    'openfda.brand_name.exact:asc', // .exact subfield
    'classification.exact:desc, report_date:asc', // space after the comma — ordering honoured
    '  report_date:desc  ', // openFDA trims spaces around the whole value
  ];

  /** Refused upstream, and rejected on every tool. */
  const REJECTED = [
    'report_date :asc', // 500: a space inside a field path is not trimmed — "report_date "
    'report_date-desc', // 400: field path "report_date-desc"
    '(report_date):desc', // 400: field path "(report_date)"
    '"report_date":desc', // 400: field path "\"report_date\""
    'report_date desc', // 400: field path "report_date desc"
    'report_date;drop', // 400 Sort not supported
    'report_date:desc:asc', // 500: field path becomes "report_date:desc"
    'report_date:desc,', // 500: empty second segment
    ',report_date', // 500: empty first segment
    'report_date:desc,foo-bar:asc', // 500: second field path "foo-bar"
    ':desc', // 400: empty field path
  ];

  /*
   * The direction rules and the whitespace trim, tabled once on one tool: every
   * tool builds `sort` from the same schema factory, and the lists above already
   * check each tool's wiring of it. Each tool's forwarding of a normalized
   * direction is checked at the HTTP boundary below.
   */

  /** Also accepted and forwarded byte-identical. */
  const ACCEPTED_SHARED = [
    'report_date:asc',
    'classification.exact:desc,report_date:asc',
    'report_date:desc ,status.exact:asc', // space before the comma — trimmed like one after it
    'report_date:desc\t', // openFDA trims any whitespace off the whole value, not only spaces
    'report_date:desc\r\n',
    '\treport_date ',
    '　classification.exact:desc, report_date:asc\n',
  ];

  /** Accepted, with each direction rewritten to the lowercase `asc`/`desc` openFDA honours. */
  const NORMALIZED: Array<[string, string]> = [
    ['report_date:ASC', 'report_date:asc'],
    ['report_date:DESC', 'report_date:desc'],
    ['report_date:Desc', 'report_date:desc'],
    ['report_date:ascending', 'report_date:asc'],
    ['report_date:DESCENDING', 'report_date:desc'],
    ['report_date:Ascending', 'report_date:asc'],
    [
      'classification.exact:desc,report_date:ascending',
      'classification.exact:desc,report_date:asc',
    ],
    // Only the directions change: field paths keep their case, spaces stay where sent.
    ['Report_Date:DESC , Status.Exact:Asc ', 'Report_Date:desc , Status.Exact:asc '],
    ['report_date:DESC\t', 'report_date:desc\t'],
    ['\nreport_date:Ascending ', '\nreport_date:asc '],
  ];

  /** Also rejected: refused upstream, or answered with the sort key silently dropped. */
  const REJECTED_SHARED = [
    'report_date:"desc"', // 200, sort key dropped — a quoted direction is not a direction
    'report_date:foo', // 200, sort key dropped
    'report_date:', // 200, sort key dropped — an empty direction
    'report_date:asce', // 200, sort key dropped — a prefix of ascending is not a direction
    'report_date:descend',
    'report_date: desc', // a space between the colon and the direction
    'classification.exact:desc,report_date:foo', // 200 with the second key silently dropped
    'report_date..x:desc', // empty path component
    '.report_date', // leading dot
    'report_date.:desc', // trailing dot
    '   ', // whitespace only
    '\t\n', // whitespace only
    'report_date:desc\t,status.exact:asc', // 400: only spaces are trimmed beside a comma
    'report_date:\tdesc', // 400: whitespace inside a segment
    'report_date :desc', // 400
    'report_date:desc,\n', // an empty last segment behind a line break
    'report_date:desc\u0085', // 400: NEL is not whitespace to openFDA's trim
    'report_date:desc​', // 400: nor is a zero-width space
  ];

  for (const [label, schema, base] of SORT_TOOLS) {
    it.each(ACCEPTED)(`${label}.sort accepts %j unchanged`, (value) => {
      expect((schema.parse({ ...base, sort: value }) as { sort: string }).sort).toBe(value);
    });

    it.each(REJECTED)(`${label}.sort rejects %j`, (value) => {
      expect(() => schema.parse({ ...base, sort: value })).toThrow();
    });
  }

  describe('on the shared sort schema', () => {
    const parseSort = (value: string) =>
      searchRecallsTool.input.parse({ category: 'drug', sort: value }).sort;

    it.each(ACCEPTED_SHARED)('accepts %j unchanged', (value) => {
      expect(parseSort(value)).toBe(value);
    });

    it.each(NORMALIZED)('accepts %j as %j', (value, normalized) => {
      expect(parseSort(value)).toBe(normalized);
    });

    it.each(REJECTED_SHARED)('rejects %j', (value) => {
      expect(() => parseSort(value)).toThrow();
    });
  });

  it('describes the accepted directions on every tool', () => {
    for (const [label, schema] of SORT_TOOLS) {
      const description = z.toJSONSchema(schema as never).properties?.sort;
      if (typeof description !== 'object') throw new Error(`${label}: sort is not advertised`);
      expect(description.description, label).toMatch(/:asc or :desc \(any letter case/);
      expect(description.description, label).toMatch(/ascending and :descending/);
    }
  });

  it('names the accepted directions in the rejection', () => {
    const result = searchRecallsTool.input.safeParse({ category: 'drug', sort: 'report_date:foo' });
    expect(result.success).toBe(false);
    const message = result.error?.issues.map((issue) => issue.message).join('\n') ?? '';
    expect(message).toMatch(/:asc or :desc/);
    expect(message).toMatch(/any letter case/);
    expect(message).toMatch(/ascending and descending/);
  });

  // The shape reaches the advertised inputSchema, not only the rejection: a client
  // reading tools/list can self-correct before spending a call.
  it('advertises the sort shape as a JSON Schema pattern', () => {
    const sort = z.toJSONSchema(searchRecallsTool.input).properties?.sort;
    if (typeof sort !== 'object') throw new Error('sort is not advertised as a schema');
    const pattern = sort.pattern;
    expect(pattern).toBeDefined();
    expect(sort.minLength).toBe(1);

    // The advertised pattern is the enforced one — a client applying it locally
    // reaches the same verdict the server does, the normalized spellings included.
    const advertised = new RegExp(pattern as string);
    for (const value of [...ACCEPTED, ...ACCEPTED_SHARED]) {
      expect(advertised.test(value)).toBe(true);
    }
    for (const [value, normalized] of NORMALIZED) {
      expect(advertised.test(value)).toBe(true);
      expect(advertised.test(normalized)).toBe(true);
    }
    for (const value of [...REJECTED, ...REJECTED_SHARED]) {
      expect(advertised.test(value)).toBe(false);
    }
  });

  /**
   * The advertised pattern is written as lookaheads over one character class so
   * it stays linear on Bun (see the timing test below). This pins it to the plain
   * grammar it replaces — `^\s*SEG( *, *SEG)*\s*$`, a segment being a dotted path
   * plus an optional direction — over every string of up to five tokens drawn
   * from paths, separators, spaces, directions, near-misses, and foreign
   * characters, and again from tokens that place whitespace other than a space.
   */
  it('admits exactly the strings the plain sort grammar admits', () => {
    const path = '[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*';
    const segment = `${path}(?::(?:asc|desc|ascending|descending))?`;
    const grammar = new RegExp(`^\\s*${segment}(?: *, *${segment})*\\s*$`, 'i');
    const sort = z.toJSONSchema(searchRecallsTool.input).properties?.sort;
    if (typeof sort !== 'object') throw new Error('sort is not advertised as a schema');
    const advertised = new RegExp(sort.pattern as string);

    const tokens = [
      'a',
      'B_1',
      '.',
      ':',
      ',',
      ' ',
      'desc',
      'ASC',
      'Descending',
      'ascend',
      '"',
      '-',
    ];
    const whitespaceTokens = ['a', ':desc', ',', ' ', '.', '\t', '\n', ' '];
    const mismatches: string[] = [];
    let checked = 0;
    const walk = (value: string, depth: number, from: string[]): void => {
      checked += 1;
      if (grammar.test(value) !== advertised.test(value)) mismatches.push(value);
      if (depth === 0) return;
      for (const token of from) walk(value + token, depth - 1, from);
    };
    walk('', 5, tokens);
    walk('', 5, whitespaceTokens);

    expect(checked).toBeGreaterThan(200_000);
    expect(mismatches).toEqual([]);
  });

  /**
   * The sort pattern runs over caller-sized text, so it is timed on its worst
   * inputs — repeated segments, separators, and whitespace with an invalid tail —
   * across a 64× span, on each runtime the server supports.
   */
  const SORT_WORST_CASES: Array<[string, (n: number) => string]> = [
    ['a long field path with an invalid tail', (n) => `${'a'.repeat(n - 1)}!`],
    ['repeated path components with an invalid tail', (n) => `${'a.'.repeat(n / 2 - 1)}a!`],
    ['repeated segments with an invalid tail', (n) => `${'a,'.repeat(n / 2 - 1)}a!`],
    [
      'repeated directed segments with an invalid tail',
      (n) => `${'a:desc,'.repeat(Math.floor(n / 7) - 1)}a!`,
    ],
    ['spaced separators with an invalid tail', (n) => `${'a , '.repeat(n / 4 - 1)}a!`],
    ['a run of spaces inside a segment', (n) => `a${' '.repeat(n - 2)}!`],
    ['a run of spaces before a line break and an invalid tail', (n) => `a${' '.repeat(n - 3)}\n!`],
    ['a run of leading tabs with an invalid tail', (n) => `${'\t'.repeat(n - 2)}a!`],
    ['a direction followed by mixed whitespace', (n) => `a:desc${' \t'.repeat(n / 2 - 4)}!`],
  ];

  describe.each(TIMING_RUNTIMES)('on %s', (_engine, runtime) => {
    let micros: number[] = [];

    beforeAll(() => {
      const sort = z.toJSONSchema(searchRecallsTool.input).properties?.sort;
      if (typeof sort !== 'object') throw new Error('sort is not advertised as a schema');
      const inputs = SORT_WORST_CASES.flatMap(([, build]) => [build(5_000), build(320_000)]);
      micros = regexCpuMicros(runtime, sort.pattern as string, inputs);
    }, 120_000);

    it.each(SORT_WORST_CASES.map(([name, build], i) => [name, build, i] as const))(
      'the sort pattern stays linear on %s',
      (_name, build, i) => {
        expect(
          searchRecallsTool.input.safeParse({ category: 'drug', sort: build(5_000) }).success,
        ).toBe(false);
        const [t5k = Number.NaN, t320k = Number.NaN] = micros.slice(2 * i, 2 * i + 2);
        expect(t320k / t5k).toBeLessThan(256);
        expect(t320k).toBeLessThan(500_000);
      },
    );
  });

  /**
   * The normalized value is what reaches openFDA: each tool's request carries the
   * lowercase direction, through the production argument path and the real
   * service, with only the HTTP boundary stubbed.
   */
  describe('forwards the normalized direction upstream', () => {
    const http = createFetchMock();

    beforeAll(() => {
      initOpenFdaService();
    });

    beforeEach(() => {
      http.reset();
      http.route({
        match: (request) => new URL(request.url).origin === 'https://api.fda.gov',
        respond: () =>
          Response.json({
            meta: { results: { skip: 0, limit: 1, total: 0 }, last_updated: '2026-07-30' },
            results: [],
          }),
      });
      http.install();
    });

    afterEach(() => {
      http.restore();
    });

    it.each(
      SORT_DEFINITIONS.map(([definition, base]) => [definition.name, definition, base] as const),
    )('%s sends the lowercase directions', async (_name, definition, base) => {
      const result = await runToolContract(definition, {
        ...base,
        sort: 'classification.exact:Ascending, report_date:DESC',
      });

      expect(result.isError).toBeFalsy();
      const sorts = http.calls.map((call) => new URL(call.request.url).searchParams.get('sort'));
      expect(sorts[0]).toBe('classification.exact:asc, report_date:desc');
      for (const sort of sorts) {
        if (sort !== null) expect(sort).toBe('classification.exact:asc, report_date:desc');
      }
    });

    it('rejects an unhonoured direction before any request', async () => {
      const result = await runToolContract(searchRecallsTool, {
        category: 'drug',
        sort: 'report_date:foo',
      });

      expect(result.isError).toBe(true);
      expect(http.calls).toHaveLength(0);
    });

    /**
     * A staged call reads a probe page and then drains the match in further pages;
     * every one of those requests must carry the normalized direction, or the
     * staged table is ordered differently from the inline page beside it.
     */
    describe('on the staged path', () => {
      const MATCHED = 150;

      beforeEach(() => {
        http.reset();
        http.route({
          match: (request) => new URL(request.url).origin === 'https://api.fda.gov',
          respond: (request) => {
            const params = new URL(request.url).searchParams;
            const skip = Number(params.get('skip') ?? 0);
            const limit = Number(params.get('limit') ?? 1);
            const count = Math.max(0, Math.min(limit, MATCHED - skip));
            return Response.json({
              meta: { results: { skip, limit, total: MATCHED }, last_updated: '2026-07-30' },
              results: Array.from({ length: count }, (_, i) => ({
                recall_number: `R-${skip + i}`,
              })),
            });
          },
        });
        // A canvas whose table drains the real staging source, so every drain page is requested.
        setCanvas({
          acquire: async () => ({
            canvasId: 'cv_sortnorm',
            isNew: true,
            registerTable: async (name: string, source: AsyncIterable<unknown>) => {
              let rowCount = 0;
              for await (const _row of source) rowCount++;
              return { tableName: name, rowCount, columns: [] };
            },
          }),
        } as never);
      });

      afterEach(() => {
        setCanvas(undefined);
      });

      it.each([
        [searchRecallsTool.name, searchRecallsTool, { category: 'drug', sort: 'report_date:DESC' }],
        [
          searchAdverseEventsTool.name,
          searchAdverseEventsTool,
          { category: 'drug', sort: 'receivedate:DESC' },
        ],
      ] as const)(
        '%s sends the lowercase direction on every drain request',
        async (_name, definition, input) => {
          const result = await runToolContract(definition as AnyToolDefinition, {
            ...input,
            stage: true,
          });

          expect(result.isError).toBeFalsy();
          expect((result.structuredContent as { staged_rows?: number }).staged_rows).toBe(MATCHED);
          const requests = http.calls.map((call) => new URL(call.request.url).searchParams);
          // The probe page, then the drain past it.
          expect(requests.map((params) => params.get('skip'))).toEqual(['0', '100']);
          const expected = input.sort.replace(':DESC', ':desc');
          for (const params of requests) expect(params.get('sort')).toBe(expected);
        },
      );
    });
  });
});

// ── search `+` separators on the staged path (#75) ──────────────────────────────

/**
 * The schema's normalized `search` is what a staged call sends: the probe page
 * and every drain page past it carry the spaced string, through the production
 * argument path and the real service, with only the HTTP boundary stubbed. A
 * staged search that matches nothing gets the same phrase-plus hint as the
 * inline page. `stage: true` and `canvas_id` take the same path.
 */
describe('search reaches the staged path normalized (#75)', () => {
  const http = createFetchMock();
  let matched = 0;

  beforeAll(() => {
    initOpenFdaService();
  });

  beforeEach(() => {
    http.reset();
    http.route({
      match: (request) => new URL(request.url).origin === 'https://api.fda.gov',
      respond: (request) => {
        const params = new URL(request.url).searchParams;
        const skip = Number(params.get('skip') ?? 0);
        const limit = Number(params.get('limit') ?? 1);
        const count = Math.max(0, Math.min(limit, matched - skip));
        return Response.json({
          meta: { results: { skip, limit, total: matched }, last_updated: '2026-10-26' },
          results: Array.from({ length: count }, (_, i) => ({ recall_number: `R-${skip + i}` })),
        });
      },
    });
    http.install();
    // A canvas whose table drains the real staging source, so every drain page is requested.
    setCanvas({
      acquire: async () => ({
        canvasId: 'cv_plus075',
        isNew: true,
        registerTable: async (name: string, source: AsyncIterable<unknown>) => {
          let rowCount = 0;
          for await (const _row of source) rowCount++;
          return { tableName: name, rowCount, columns: [] };
        },
      }),
    } as never);
  });

  afterEach(() => {
    http.restore();
    setCanvas(undefined);
  });

  it.each([
    ['stage: true', { stage: true }],
    ['canvas_id', { canvas_id: 'cv_plus075' }],
  ] as const)(
    'with %s, sends the spaced search on every request and echoes it',
    async (_mode, staging) => {
      matched = 150;
      const result = await runToolContract(searchRecallsTool, {
        category: 'drug',
        search: 'classification:"Class I"+AND+status:"Ongoing"',
        ...staging,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        effectiveQuery?: string;
        staged_rows?: number;
      };
      expect(structured.staged_rows).toBe(matched);
      const requests = http.calls.map((call) => new URL(call.request.url).searchParams);
      // The probe page, then the drain past it.
      expect(requests.map((params) => params.get('skip'))).toEqual(['0', '100']);
      for (const params of requests) {
        expect(params.get('search')).toBe('(classification:"Class I" AND status:"Ongoing")');
      }
      expect(structured.effectiveQuery).toBe('classification:"Class I" AND status:"Ongoing"');
    },
  );

  it('adds the phrase-plus hint when a staged search matches nothing', async () => {
    matched = 0;
    const result = await runToolContract(searchRecallsTool, {
      category: 'drug',
      search: 'classification.exact:"Class+I"',
      stage: true,
    });

    expect(result.isError).toBeFalsy();
    expect(String((result.structuredContent as { notice?: string }).notice)).toContain(
      'write them with spaces: `"Class I"`.',
    );
  });
});

describe('fields takes dotted record paths and rejects anything else (#66)', () => {
  /** Every multi-row search tool, with a minimal valid base input. */
  const FIELDS_TOOLS: Array<
    [string, { parse: (value: unknown) => unknown }, Record<string, unknown>]
  > = [
    ['openfda_search_adverse_events', searchAdverseEventsTool.input, { category: 'drug' }],
    ['openfda_search_recalls', searchRecallsTool.input, { category: 'drug' }],
    ['openfda_lookup_ndc', lookupNdcTool.input, { search: 'aspirin' }],
    ['openfda_search_drug_approvals', searchDrugApprovalsTool.input, {}],
    ['openfda_search_drug_shortages', searchDrugShortagesTool.input, {}],
    ['openfda_search_device_clearances', searchDeviceClearancesTool.input, { pathway: '510k' }],
    ['openfda_search_animal_events', searchAnimalEventsTool.input, {}],
    ['openfda_search_tobacco_reports', searchTobaccoReportsTool.input, {}],
  ];

  const ACCEPTED = [
    ['receivedate'],
    ['patient.drug.medicinalproduct', 'patient.reaction'],
    ['openfda.brand_name.exact'], // well-formed; named on the notice if no record carries it
    ['code_info', 'code_info'], // duplicates are harmless
    ['A_1.b2.C_3'],
    [], // form clients send an empty list for an unset array
  ];

  const REJECTED = [
    'patient drug',
    'patient..drug',
    '.patient',
    'patient.',
    'patient-drug',
    'patient.drug[0]',
    'patient.drug.*',
    '',
    ' receivedate',
  ];

  // Every tool builds `fields` from one schema factory: the grammar is tabled once.
  describe('on the shared fields schema', () => {
    const parseFields = (fields: unknown) =>
      searchRecallsTool.input.parse({ category: 'drug', fields }).fields;

    it.each(ACCEPTED.map((value) => [value] as const))('accepts %j', (value) => {
      expect(parseFields(value)).toEqual(value);
    });

    it.each(REJECTED)('rejects the entry %j', (value) => {
      expect(() => parseFields(['receivedate', value])).toThrow();
    });
  });

  it.each(FIELDS_TOOLS)(
    '%s.fields is optional, takes a dotted path, and rejects a malformed one',
    (_label, schema, base) => {
      expect((schema.parse(base) as { fields?: unknown }).fields).toBeUndefined();
      const fields = ['patient.drug.medicinalproduct', 'patient.reaction'];
      expect((schema.parse({ ...base, fields }) as { fields: string[] }).fields).toEqual(fields);
      expect(() => schema.parse({ ...base, fields: ['receivedate', 'patient..drug'] })).toThrow();
    },
  );

  it('advertises the path shape on every entry, uncapped, and points at openfda_describe_fields', () => {
    for (const [label, schema] of FIELDS_TOOLS) {
      const fields = z.toJSONSchema(schema as never).properties?.fields;
      if (
        typeof fields !== 'object' ||
        typeof fields.items !== 'object' ||
        Array.isArray(fields.items)
      )
        throw new Error(`${label}: fields is not advertised as an array schema`);
      const advertised = new RegExp(fields.items.pattern as string);
      for (const value of ACCEPTED.flat()) expect(advertised.test(value)).toBe(true);
      for (const value of REJECTED) expect(advertised.test(value)).toBe(false);
      expect(fields.maxItems).toBeUndefined();
      expect(fields.description).toContain('openfda_describe_fields');
    }
  });

  it("names example paths every one of the tool's endpoints catalogs", () => {
    const endpoints: Record<string, string[]> = {
      openfda_search_adverse_events: ['drug/event'],
      openfda_search_recalls: [
        'drug/enforcement',
        'food/enforcement',
        'device/enforcement',
        'device/recall',
      ],
      openfda_lookup_ndc: ['drug/ndc'],
      openfda_search_drug_approvals: ['drug/drugsfda'],
      openfda_search_drug_shortages: ['drug/shortages'],
      openfda_search_device_clearances: ['device/510k', 'device/pma'],
      openfda_search_animal_events: ['animalandveterinary/event'],
      openfda_search_tobacco_reports: ['tobacco/problem'],
    };
    for (const [label, schema] of FIELDS_TOOLS) {
      const fields = z.toJSONSchema(schema as never).properties?.fields;
      const description = String(typeof fields === 'object' ? fields.description : '');
      const example = JSON.parse(description.match(/e\.g\. (\[[^\]]*\])/)?.[1] ?? '[]') as string[];
      expect(example.length, label).toBeGreaterThan(0);
      // describe_fields lists the searchable subset, not every key a record carries.
      expect(description).not.toContain("lists an endpoint's paths");
      for (const endpoint of endpoints[label] ?? []) {
        const cataloged = (getFieldGroups(endpoint) ?? []).flatMap((g) =>
          g.fields.map((f) => f.path),
        );
        for (const path of example) expect(cataloged, `${label} ${endpoint}`).toContain(path);
      }
    }
  });

  /**
   * The path pattern runs over caller-sized text, so it is timed on its worst
   * inputs — a long run with no valid end, and repeated separators — across a 64×
   * span, on each runtime the server supports.
   */
  const PATH_WORST_CASES: Array<[string, (n: number) => string]> = [
    ['a long segment with an invalid tail', (n) => `${'a'.repeat(n - 1)}!`],
    ['repeated segments with an invalid tail', (n) => `${'a.'.repeat(n / 2 - 1)}a!`],
    ['repeated separators ending on a dot', (n) => 'a.'.repeat(n / 2)],
    ['doubled dots', (n) => `a${'..'.repeat(n / 2 - 1)}a`],
  ];

  describe.each(TIMING_RUNTIMES)('on %s', (_engine, runtime) => {
    let micros: number[] = [];

    beforeAll(() => {
      const fields = z.toJSONSchema(searchRecallsTool.input).properties?.fields;
      if (
        typeof fields !== 'object' ||
        typeof fields.items !== 'object' ||
        Array.isArray(fields.items)
      )
        throw new Error('fields is not advertised as an array schema');
      const inputs = PATH_WORST_CASES.flatMap(([, build]) => [build(5_000), build(320_000)]);
      micros = regexCpuMicros(runtime, fields.items.pattern as string, inputs);
    }, 120_000);

    it.each(PATH_WORST_CASES.map(([name, build], i) => [name, build, i] as const))(
      'the path pattern stays linear on %s',
      (_name, build, i) => {
        expect(
          searchRecallsTool.input.safeParse({ category: 'drug', fields: [build(5_000)] }).success,
        ).toBe(false);
        const [t5k = Number.NaN, t320k = Number.NaN] = micros.slice(2 * i, 2 * i + 2);
        expect(t320k / t5k).toBeLessThan(256);
        expect(t320k).toBeLessThan(500_000);
      },
    );
  });
});

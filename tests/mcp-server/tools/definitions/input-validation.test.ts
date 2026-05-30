/**
 * @fileoverview Input validation tests for all openFDA tool Zod schemas.
 * Verifies that invalid, missing, out-of-range, and malformed inputs are
 * rejected by the schema layer with clear errors, and that valid boundary
 * values are accepted.
 * @module tests/mcp-server/tools/definitions/input-validation
 */

import { describe, expect, it } from 'vitest';
import { countTool } from '@/mcp-server/tools/definitions/count.tool.js';
import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';

// ── openfda_count ────────────────────────────────────────────────────────────

describe('openfda_count input schema', () => {
  it('accepts valid minimal input', () => {
    const input = countTool.input.parse({
      endpoint: 'drug/event',
      count: 'patient.reaction.reactionmeddrapt.exact',
    });
    expect(input.endpoint).toBe('drug/event');
    expect(input.limit).toBe(100); // default
  });

  it('rejects missing endpoint', () => {
    expect(() => countTool.input.parse({ count: 'some.field' })).toThrow();
  });

  it('rejects unknown endpoint value', () => {
    expect(() => countTool.input.parse({ endpoint: 'unknown/endpoint', count: 'field' })).toThrow();
  });

  it('rejects missing count', () => {
    expect(() => countTool.input.parse({ endpoint: 'drug/event' })).toThrow();
  });

  it('accepts limit=1 (minimum)', () => {
    const input = countTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit=1000 (maximum)', () => {
    const input = countTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 1000 });
    expect(input.limit).toBe(1000);
  });

  it('rejects limit=0 (below minimum)', () => {
    expect(() =>
      countTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 0 }),
    ).toThrow();
  });

  it('rejects limit=1001 (above maximum)', () => {
    expect(() =>
      countTool.input.parse({ endpoint: 'drug/event', count: 'field', limit: 1001 }),
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
    ] as const;

    for (const endpoint of validEndpoints) {
      expect(() => countTool.input.parse({ endpoint, count: 'field.exact' })).not.toThrow();
    }
  });

  it('accepts optional search param', () => {
    const input = countTool.input.parse({
      endpoint: 'drug/event',
      count: 'field',
      search: 'patient.drug.medicinalproduct:"aspirin"',
    });
    expect(input.search).toBe('patient.drug.medicinalproduct:"aspirin"');
  });

  it('accepts undefined optional search param', () => {
    const input = countTool.input.parse({ endpoint: 'drug/event', count: 'field' });
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

  it('rejects skip above 25000', () => {
    expect(() => searchAdverseEventsTool.input.parse({ category: 'drug', skip: 25001 })).toThrow();
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

  it('rejects skip above 25000', () => {
    expect(() => searchRecallsTool.input.parse({ category: 'drug', skip: 25001 })).toThrow();
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

  it('rejects skip=25001', () => {
    expect(() => getDrugLabelTool.input.parse({ search: 'aspirin', skip: 25001 })).toThrow();
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

  it('rejects out-of-range skip', () => {
    expect(() => lookupNdcTool.input.parse({ search: 'x', skip: -1 })).toThrow();
    expect(() => lookupNdcTool.input.parse({ search: 'x', skip: 25001 })).toThrow();
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
      search: 'sponsor_name:"pfizer"',
    });
    expect(input.search).toBe('sponsor_name:"pfizer"');
  });

  it('rejects out-of-range limit', () => {
    expect(() => searchDrugApprovalsTool.input.parse({ limit: 0 })).toThrow();
    expect(() => searchDrugApprovalsTool.input.parse({ limit: 1001 })).toThrow();
  });

  it('rejects out-of-range skip', () => {
    expect(() => searchDrugApprovalsTool.input.parse({ skip: -1 })).toThrow();
    expect(() => searchDrugApprovalsTool.input.parse({ skip: 25001 })).toThrow();
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

  it('rejects out-of-range skip', () => {
    expect(() =>
      searchDeviceClearancesTool.input.parse({ pathway: '510k', skip: 25001 }),
    ).toThrow();
  });
});

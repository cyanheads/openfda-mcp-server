/**
 * @fileoverview Tests for openfda_describe_fields tool.
 * @module tests/mcp-server/tools/definitions/describe-fields.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { describeFieldsTool } from '@/mcp-server/tools/definitions/describe-fields.tool.js';

describe('openfda_describe_fields', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('returns groups for drug/event', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'drug/event' }, ctx);

    expect(result.endpoint).toBe('drug/event');
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.queryTips).toBeTruthy();
  });

  it('returns groups for drug/shortages', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'drug/shortages' }, ctx);

    expect(result.endpoint).toBe('drug/shortages');
    // Should include status and generic_name fields
    const allPaths = result.groups.flatMap((g) => g.fields.map((f) => f.path));
    expect(allPaths).toContain('status');
    expect(allPaths).toContain('generic_name');
    expect(allPaths).toContain('therapeutic_category');
  });

  it('returns groups for device/510k', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'device/510k' }, ctx);

    expect(result.endpoint).toBe('device/510k');
    const allPaths = result.groups.flatMap((g) => g.fields.map((f) => f.path));
    expect(allPaths).toContain('k_number');
    expect(allPaths).toContain('applicant');
  });

  it('every field entry has path, type, and note', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'drug/event' }, ctx);

    for (const group of result.groups) {
      for (const field of group.fields) {
        expect(field.path).toBeTruthy();
        expect(field.type).toBeTruthy();
        expect(field.note).toBeTruthy();
      }
    }
  });

  it('format renders a markdown table with field paths', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'drug/shortages' }, ctx);
    const content = describeFieldsTool.format(result);

    const text = content[0].text;
    expect(text).toContain('drug/shortages');
    expect(text).toContain('| `generic_name`');
    expect(text).toContain('| `status`');
    expect(text).toContain('Query tips:');
  });

  it('format includes all groups as headings', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'animalandveterinary/event' }, ctx);
    const content = describeFieldsTool.format(result);

    const text = content[0].text;
    expect(text).toContain('### Report');
    expect(text).toContain('### Animal');
    expect(text).toContain('### Drug');
  });

  it('queryTips mentions syntax reminders', async () => {
    const result = await describeFieldsTool.handler({ endpoint: 'drug/label' }, ctx);

    expect(result.queryTips).toContain('.exact');
    expect(result.queryTips).toContain('AND');
  });

  // Issue #34 — the tips used to present .exact as the default for every string
  // field, steering callers straight into "Nothing to count" on the identifier
  // fields openFDA already indexes as keywords.
  it('queryTips does not present .exact as the default for string fields', async () => {
    const { queryTips } = await describeFieldsTool.handler({ endpoint: 'drug/ndc' }, ctx);

    expect(queryTips).not.toContain('Append .exact to string fields');
    expect(queryTips).toMatch(/count identifier fields bare/i);
    expect(queryTips).toContain('product_ndc');
    expect(queryTips).toMatch(/free-text fields/i);
  });

  // The tips are where a caller learns query syntax before writing a `search`, so
  // they state the delimiter rule the handlers enforce locally. They also must not
  // promise that counting an analyzed field bare tallies its words — openFDA
  // refuses that with illegal_argument_exception (drug/label openfda.brand_name).
  it('queryTips states the delimiter rule and the .exact direction for free-text fields', async () => {
    const { queryTips } = await describeFieldsTool.handler({ endpoint: 'drug/label' }, ctx);

    expect(queryTips).toMatch(/must close/i);
    expect(queryTips).toMatch(/cannot end on a backslash/i);
    expect(queryTips).toContain('openfda.brand_name.exact');
    expect(queryTips).not.toMatch(/tallies individual words/i);
  });

  // Issue #16 — the count-only endpoints exposed by openfda_count_values now have
  // field catalogs, so openfda_describe_fields accepts them too.
  const countOnlyEndpoints: Array<[string, string]> = [
    ['device/classification', 'product_code'],
    ['device/registrationlisting', 'registration.registration_number'],
    ['device/udi', 'identifiers.id'],
    ['device/covid19serology', 'igg_result'],
    ['other/substance', 'unii'],
  ];

  it('accepts the five count-only endpoints in its input enum (issue #16)', () => {
    for (const [endpoint] of countOnlyEndpoints) {
      expect(() => describeFieldsTool.input.parse({ endpoint })).not.toThrow();
    }
  });

  it.each(countOnlyEndpoints)(
    'returns a representative field group for %s (issue #16)',
    async (endpoint, expectedPath) => {
      const input = describeFieldsTool.input.parse({ endpoint });
      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.endpoint).toBe(endpoint);
      expect(result.groups.length).toBeGreaterThan(0);
      const allPaths = result.groups.flatMap((g) => g.fields.map((f) => f.path));
      expect(allPaths).toContain(expectedPath);
    },
  );
});

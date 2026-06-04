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
});

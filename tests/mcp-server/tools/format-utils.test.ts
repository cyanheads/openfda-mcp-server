/**
 * @fileoverview Unit tests for shared formatting helpers.
 * @module tests/mcp-server/tools/format-utils
 */

import { describe, expect, it } from 'vitest';
import {
  emptyResultMessage,
  formatRemainingFields,
  humanizeField,
  truncate,
} from '@/mcp-server/tools/format-utils.js';

describe('truncate', () => {
  it('returns value unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and appends ellipsis when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('returns N/A for undefined', () => {
    expect(truncate(undefined, 100)).toBe('N/A');
  });

  it('returns N/A for null', () => {
    expect(truncate(null, 100)).toBe('N/A');
  });

  it('returns N/A for empty string', () => {
    expect(truncate('', 100)).toBe('N/A');
  });

  it('handles exact-length strings without appending ellipsis', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles single-char strings', () => {
    expect(truncate('x', 1)).toBe('x');
  });

  it('handles unicode characters correctly', () => {
    const value = 'cafébistro';
    expect(truncate(value, 4)).toBe('café...');
  });
});

describe('humanizeField', () => {
  it('replaces underscores with spaces', () => {
    expect(humanizeField('brand_name')).toBe('Brand name');
  });

  it('capitalizes the first character', () => {
    expect(humanizeField('report_date')).toBe('Report date');
  });

  it('handles single-word keys', () => {
    expect(humanizeField('status')).toBe('Status');
  });

  it('handles already-capitalized keys', () => {
    expect(humanizeField('NDC')).toBe('NDC');
  });

  it('handles multiple underscores', () => {
    expect(humanizeField('reason_for_recall')).toBe('Reason for recall');
  });

  it('handles keys with no underscores', () => {
    expect(humanizeField('applicant')).toBe('Applicant');
  });
});

describe('formatRemainingFields', () => {
  it('skips fields in the rendered set', () => {
    const record = { name: 'test', skip_me: 'value' };
    const lines = formatRemainingFields(record, new Set(['skip_me']));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Name');
    expect(lines.join()).not.toContain('Skip me');
  });

  it('renders string fields as label-value pairs', () => {
    const record = { product_code: 'DXN' };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Product code:** DXN');
  });

  it('renders number fields', () => {
    const record = { count: 42 };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Count:** 42');
  });

  it('renders boolean fields', () => {
    const record = { active: true };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Active:** true');
  });

  it('renders primitive arrays as comma-joined', () => {
    const record = { routes: ['ORAL', 'TOPICAL'] };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toBe('**Routes:** ORAL, TOPICAL');
  });

  it('skips null values', () => {
    const record = { name: null, status: 'active' };
    const lines = formatRemainingFields(record as Record<string, unknown>, new Set());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Status');
  });

  it('skips undefined values', () => {
    const record = { name: undefined, status: 'active' };
    const lines = formatRemainingFields(record as Record<string, unknown>, new Set());
    expect(lines).toHaveLength(1);
  });

  it('skips empty string values', () => {
    const record = { name: '', status: 'active' };
    const lines = formatRemainingFields(record, new Set());
    expect(lines).toHaveLength(1);
  });

  it('skips empty arrays', () => {
    const record = { tags: [], status: 'active' };
    const lines = formatRemainingFields(record, new Set());
    expect(lines).toHaveLength(1);
  });

  it('renders object fields as key=value pairs', () => {
    const record = { address: { city: 'Seattle', state: 'WA' } };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toContain('city=Seattle');
    expect(lines[0]).toContain('state=WA');
  });

  it('truncates long values to maxLen', () => {
    const longValue = 'x'.repeat(500);
    const record = { description: longValue };
    const lines = formatRemainingFields(record, new Set(), 100);
    expect(lines[0]).toContain('...');
    // "**Description:** " (17 chars) + 100 chars + "..." (3 chars) = 120 chars max
    expect(lines[0].length).toBeLessThanOrEqual(120);
  });

  it('returns empty array for empty record', () => {
    expect(formatRemainingFields({}, new Set())).toEqual([]);
  });

  it('skips arrays containing objects by falling back to JSON', () => {
    const record = { complex: [{ a: 1 }, { b: 2 }] };
    const lines = formatRemainingFields(record, new Set());
    expect(lines[0]).toContain('Complex');
    expect(lines[0]).toContain('{');
  });
});

describe('emptyResultMessage', () => {
  it('returns base hint when skip is 0', () => {
    const msg = emptyResultMessage(0, 'Try different filters.');
    expect(msg).toBe('Try different filters.');
  });

  it('adds pagination context when skip > 0', () => {
    const msg = emptyResultMessage(10, 'Try different filters.');
    expect(msg).toContain('skip=10');
    expect(msg).toContain('Try different filters.');
  });

  it('mentions skip=0 in the pagination hint', () => {
    const msg = emptyResultMessage(500, 'Some hint.');
    expect(msg).toContain('skip=0');
  });
});

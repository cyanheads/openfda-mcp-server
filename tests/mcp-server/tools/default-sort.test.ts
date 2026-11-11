/**
 * @fileoverview Tests for the newest-first default sort shared by the search tools.
 * @module tests/mcp-server/tools/default-sort
 */

import { describe, expect, it } from 'vitest';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';

describe('sortOrNewest', () => {
  it('sends the newest-first sort when neither search nor sort is given', () => {
    expect(sortOrNewest({}, 'receivedate:desc')).toBe('receivedate:desc');
  });

  it('sends no sort when only a search is given', () => {
    expect(
      sortOrNewest({ search: 'patient.drug.medicinalproduct:"aspirin"' }, 'receivedate:desc'),
    ).toBeUndefined();
  });

  it('sends an explicit sort unchanged, with or without a search', () => {
    expect(sortOrNewest({ sort: 'receiptdate:asc' }, 'receivedate:desc')).toBe('receiptdate:asc');
    expect(sortOrNewest({ search: 'serious:1', sort: 'receiptdate:asc' }, 'receivedate:desc')).toBe(
      'receiptdate:asc',
    );
  });
});

/**
 * @fileoverview openfda_describe_fields when the field catalog has no entry for
 * an endpoint the input enum accepts — a server-side catalog gap, not a caller
 * error. Pins the wire code and message the caller receives.
 * @module tests/mcp-server/tools/definitions/describe-fields.catalog-gap.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/mcp-server/tools/field-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/mcp-server/tools/field-catalog.js')>();
  return { ...actual, getFieldGroups: () => undefined };
});

import { describeFieldsTool } from '@/mcp-server/tools/definitions/describe-fields.tool.js';

describe('openfda_describe_fields catalog gap', () => {
  it('fails as an internal error naming the endpoint', async () => {
    const result = await runToolContract(describeFieldsTool, { endpoint: 'drug/event' });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as unknown as {
      error: { code: number; message: string };
    };
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toContain('No field catalog found for endpoint: drug/event');
  });
});

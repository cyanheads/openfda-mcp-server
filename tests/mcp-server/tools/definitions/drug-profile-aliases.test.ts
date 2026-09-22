/**
 * @fileoverview `openfda_drug_profile` accepts `drug_name` and `name` as
 * spellings of its one `drug` argument (#53). The aliases are resolved by the
 * framework's argument pre-validation, ahead of the strict input schema, so
 * every case runs through `runToolContract` — the production
 * `parseToolArguments` path — rather than calling the handler directly, which
 * would bypass the rewrite entirely.
 * @module tests/mcp-server/tools/definitions/drug-profile-aliases.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { drugProfileTool } from '@/mcp-server/tools/definitions/drug-profile.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

/** Calls the tool with raw wire arguments, as a client would send them. */
function call(args: Record<string, unknown>) {
  return runToolContract(drugProfileTool, args as never);
}

/** The error envelope a rejected call carries on `structuredContent`. */
function errorOf(result: Awaited<ReturnType<typeof call>>) {
  return (
    result.structuredContent as {
      error: { code: number; message: string; data?: { reason?: string } };
    }
  ).error;
}

/** Every label-resolution search the handler sent upstream. */
function labelSearches(): string[] {
  return mockQuery.mock.calls
    .filter(([endpoint]) => endpoint === 'drug/label')
    .map(([, params]) => (params as { search: string }).search);
}

describe('openfda_drug_profile argument aliases', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 5, lastUpdated: '2026-01-01' },
      results: [],
    });
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
  });

  it.each(['drug_name', 'name'])('accepts %s as the drug argument', async (alias) => {
    const result = await call({ [alias]: 'metformin' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ meta: { drug: 'metformin' } });
    expect(labelSearches()).toEqual([
      'openfda.generic_name:"metformin" OR openfda.brand_name:"metformin"',
    ]);
  });

  it('rejects an alias sent alongside drug itself, naming the alias', async () => {
    const result = await call({ drug: 'metformin', drug_name: 'aspirin' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('drug_name');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still rejects an undeclared key that is not an alias', async () => {
    const result = await call({ drug: 'metformin', dose: '500 mg' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('dose');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('advertises drug as the only argument', () => {
    const schema = z.toJSONSchema(drugProfileTool.input) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(Object.keys(schema.properties)).toEqual(['drug']);
    expect(schema.required).toEqual(['drug']);
  });
});

/**
 * @fileoverview Reachability of the `pagination_limit_reached` contract (#27).
 *
 * Exercised at the public tool boundary — `input.parse()` then `handler()`, the
 * same two steps the framework's handler factory runs — because the defect was
 * that schema validation rejected an over-ceiling `skip` before the handler
 * could produce the declared reason. A service-level test cannot see that: the
 * service classifies openFDA's own 400 correctly and always did.
 * @module tests/mcp-server/tools/definitions/pagination-contract.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { countValuesTool } from '@/mcp-server/tools/definitions/count-values.tool.js';
import { getDrugLabelTool } from '@/mcp-server/tools/definitions/get-drug-label.tool.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';
import { OPENFDA_MAX_SKIP } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

/** Minimal valid input per paginated tool, before defaults are applied. */
const PAGINATED_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAnimalEventsTool, {}],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDrugApprovalsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [searchTobaccoReportsTool, {}],
  [lookupNdcTool, { search: 'aspirin' }],
  [getDrugLabelTool, { search: 'openfda.brand_name:"aspirin"' }],
] as const;

describe.each(PAGINATED_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — pagination_limit_reached contract',
  (_name, tool, baseInput) => {
    beforeEach(() => {
      mockQuery.mockReset();
      vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    });

    it('declares the reason', () => {
      expect(tool.errors?.map((e) => e.reason)).toContain('pagination_limit_reached');
    });

    it('raises the declared reason and recovery for an over-ceiling skip', async () => {
      // The contract runner applies the framework's declared-recovery fill, as production does.
      const result = await runToolContract(tool as AnyToolDefinition, {
        ...baseInput,
        skip: OPENFDA_MAX_SKIP + 1,
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as {
        error: { message: string; data?: { reason?: string; recovery?: { hint?: string } } };
      };
      expect(error.data?.reason).toBe('pagination_limit_reached');
      expect(error.data?.recovery?.hint).toEqual(
        tool.errors?.find((e) => e.reason === 'pagination_limit_reached')?.recovery,
      );
      expect(error.message).toContain(String(OPENFDA_MAX_SKIP));
      // The ceiling is decided locally — no upstream request is spent on it.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts skip at the ceiling', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: OPENFDA_MAX_SKIP, limit: 10, lastUpdated: '2026-07-01' },
        results: [],
      });

      const parsed = tool.input.parse({ ...baseInput, skip: OPENFDA_MAX_SKIP });
      await expect(
        (tool.handler as (i: unknown, c: unknown) => Promise<unknown>)(parsed, ctx),
      ).resolves.toBeDefined();
      expect(mockQuery).toHaveBeenCalled();
    });
  },
);

describe('openfda_count_values — no skip input', () => {
  it('does not advertise a contract it cannot reach (#27)', () => {
    expect(Object.keys(countValuesTool.input.shape)).not.toContain('skip');
    expect(countValuesTool.errors?.map((e) => e.reason)).not.toContain('pagination_limit_reached');
  });
});

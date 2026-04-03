import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const mockQuery = vi.fn();

describe('openfda_search_device_clearances', () => {
  let ctx: Context;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext();
  });

  it('queries device/510k for 510k pathway', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ k_number: 'K123456', device_name: 'Test Device' }],
    });

    const result = await searchDeviceClearancesTool.handler(
      { pathway: '510k', search: 'applicant:"medtronic"' },
      ctx,
    );

    expect(mockQuery.mock.calls[0][0]).toBe('device/510k');
    expect(result.results[0].k_number).toBe('K123456');
  });

  it('queries device/pma for pma pathway', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDeviceClearancesTool.handler({ pathway: 'pma', search: 'applicant:"test"' }, ctx);

    expect(mockQuery.mock.calls[0][0]).toBe('device/pma');
  });

  it('formats 510k records', () => {
    const content = searchDeviceClearancesTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          k_number: 'K123456',
          device_name: 'Cardiac Monitor',
          applicant: 'Medtronic',
          product_code: 'DXN',
          decision_description: 'Substantially Equivalent',
          decision_date: '20260101',
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('K123456');
    expect(text).toContain('Cardiac Monitor');
    expect(text).toContain('Medtronic');
    expect(text).toContain('Substantially Equivalent');
  });

  it('formats PMA records', () => {
    const content = searchDeviceClearancesTool.format({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          pma_number: 'P123456',
          applicant: 'Boston Scientific',
          product_code: 'NIQ',
          decision_code: 'APPR',
          decision_date: '20260101',
        },
      ],
    });

    const text = content[0].text;
    expect(text).toContain('P123456');
    expect(text).toContain('Boston Scientific');
    expect(text).toContain('APPR');
  });
});

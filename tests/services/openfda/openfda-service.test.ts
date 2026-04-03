import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { OpenFdaService } from '@/services/openfda/openfda-service.js';

describe('OpenFdaService', () => {
  let service: OpenFdaService;
  let ctx: Context;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response;
  }

  describe('query', () => {
    it('builds URL with all params', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 1, skip: 0, limit: 10 }, last_updated: '2026-01-01' },
          results: [{ id: '1' }],
        }),
      );

      await service.query(
        'drug/event',
        { search: 'aspirin', sort: 'receivedate:desc', limit: 5, skip: 10 },
        ctx,
      );

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/drug/event.json');
      expect(url.searchParams.get('search')).toBe('aspirin');
      expect(url.searchParams.get('sort')).toBe('receivedate:desc');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('skip')).toBe('10');
    });

    it('includes api_key when configured', async () => {
      const serviceWithKey = new OpenFdaService({
        baseUrl: 'https://api.fda.gov',
        apiKey: 'my-key',
      });
      mockFetch.mockResolvedValue(
        mockResponse(200, { meta: { results: {}, last_updated: '' }, results: [] }),
      );

      await serviceWithKey.query('drug/event', {}, ctx);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('api_key')).toBe('my-key');
    });

    it('omits api_key when not configured', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, { meta: { results: {}, last_updated: '' }, results: [] }),
      );

      await service.query('drug/event', {}, ctx);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.has('api_key')).toBe(false);
    });

    it('normalizes successful response', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 42, skip: 5, limit: 10 }, last_updated: '2026-03-01' },
          results: [{ name: 'aspirin' }],
        }),
      );

      const result = await service.query('drug/event', {}, ctx);

      expect(result.meta).toEqual({
        total: 42,
        skip: 5,
        limit: 10,
        lastUpdated: '2026-03-01',
      });
      expect(result.results).toEqual([{ name: 'aspirin' }]);
    });

    it('returns empty results for 404', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      const result = await service.query('drug/event', { search: 'nonexistent' }, ctx);

      expect(result.results).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it('throws McpError on 429', async () => {
      mockFetch.mockResolvedValue(mockResponse(429, { error: { message: 'Too many requests' } }));

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(McpError);
      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/rate limit/i);
    });

    it('throws McpError on 5xx', async () => {
      mockFetch.mockResolvedValue(mockResponse(503, { error: { message: 'Service unavailable' } }));

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(McpError);
      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/upstream/i);
    });

    it('throws McpError on 400', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(400, { error: { message: 'Invalid search syntax' } }),
      );

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(McpError);
      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/query error/i);
    });

    it('throws skip-ceiling error on 400 with 25000 message', async () => {
      mockFetch.mockResolvedValue(
        mockResponse(400, {
          error: { message: 'Skip value must 25000 or less.' },
        }),
      );

      await expect(service.query('drug/event', { skip: 26000 }, ctx)).rejects.toThrow(
        /pagination limit/i,
      );
    });

    it('throws generic Error on unexpected status', async () => {
      mockFetch.mockResolvedValue(mockResponse(418, { error: { message: "I'm a teapot" } }));

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow(/HTTP 418/);
    });
  });
});

describe('getOpenFdaService', () => {
  it('throws when not initialized', async () => {
    vi.resetModules();
    const { getOpenFdaService: fresh } = await import('@/services/openfda/openfda-service.js');
    expect(() => fresh()).toThrow(/not initialized/);
  });
});

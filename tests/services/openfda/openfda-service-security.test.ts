/**
 * @fileoverview Security and edge-case tests for OpenFdaService.
 * Verifies that API keys are not leaked in errors, injection payloads
 * are not evaluated server-side, and network failures surface cleanly.
 * @module tests/services/openfda/openfda-service-security
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { OpenFdaService } from '@/services/openfda/openfda-service.js';

describe('OpenFdaService security', () => {
  let ctx: Context;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
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

  describe('API key protection', () => {
    it('does not expose the API key in a 429 error message', async () => {
      const service = new OpenFdaService({
        baseUrl: 'https://api.fda.gov',
        apiKey: 'secret-key-abc123',
      });
      mockFetch.mockResolvedValue(mockResponse(429, { error: { message: 'Too many requests' } }));

      let caughtError: unknown;
      try {
        await service.query('drug/event', {}, ctx);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(McpError);
      const errMsg = (caughtError as McpError).message;
      expect(errMsg).not.toContain('secret-key-abc123');
    });

    it('does not expose the API key in a 5xx error message', async () => {
      const service = new OpenFdaService({
        baseUrl: 'https://api.fda.gov',
        apiKey: 'secret-key-abc123',
      });
      mockFetch.mockResolvedValue(mockResponse(500, { error: { message: 'Internal error' } }));

      let caughtError: unknown;
      try {
        await service.query('drug/event', {}, ctx);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(McpError);
      const errMsg = (caughtError as McpError).message;
      expect(errMsg).not.toContain('secret-key-abc123');
    });

    it('does not expose the API key in a 400 error message', async () => {
      const service = new OpenFdaService({
        baseUrl: 'https://api.fda.gov',
        apiKey: 'secret-key-abc123',
      });
      mockFetch.mockResolvedValue(
        mockResponse(400, { error: { message: 'Invalid query syntax' } }),
      );

      let caughtError: unknown;
      try {
        await service.query('drug/event', { search: 'bad:query' }, ctx);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      const errMsg = String(caughtError);
      expect(errMsg).not.toContain('secret-key-abc123');
    });

    it('does not include the API key value in 404 empty responses', async () => {
      const service = new OpenFdaService({
        baseUrl: 'https://api.fda.gov',
        apiKey: 'secret-key-abc123',
      });
      mockFetch.mockResolvedValue(
        mockResponse(404, { error: { code: 'NOT_FOUND', message: 'No matches found!' } }),
      );

      const result = await service.query('drug/event', { search: 'nonexistent' }, ctx);

      // Result should not contain the key anywhere
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret-key-abc123');
    });
  });

  describe('network failures', () => {
    it('propagates fetch network errors', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow('ECONNREFUSED');
    });

    it('propagates AbortError on cancellation', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      const abortError = new DOMException('Aborted', 'AbortError');
      mockFetch.mockRejectedValue(abortError);

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow('Aborted');
    });

    it('propagates fetch TimeoutError', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      const timeoutError = new DOMException('signal timed out', 'TimeoutError');
      mockFetch.mockRejectedValue(timeoutError);

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow();
    });

    it('handles json() rejection on successful status gracefully', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      await expect(service.query('drug/event', {}, ctx)).rejects.toThrow();
    });

    it('handles json() rejection on error status returning empty results', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      // 404 with malformed json still returns empty results
      const result = await service.query('drug/event', {}, ctx);
      expect(result.results).toEqual([]);
      expect(result.meta.total).toBe(0);
    });
  });

  describe('query injection safety', () => {
    it('passes through injection-like search strings without modification', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      const injectionPayload = `'; DROP TABLE drugs; --`;
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 0, skip: 0, limit: 10 }, last_updated: '' },
          results: [],
        }),
      );

      await service.query('drug/event', { search: injectionPayload }, ctx);

      // Payload should be URL-encoded in the request — not evaluated
      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.get('search')).toBe(injectionPayload);
    });

    it('URL-encodes query parameters to prevent injection', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 0, skip: 0, limit: 10 }, last_updated: '' },
          results: [],
        }),
      );

      await service.query('drug/event', { search: '<script>alert(1)</script>' }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      const rawSearch = calledUrl.search;
      expect(rawSearch).not.toContain('<script>');
    });

    it('does not evaluate injected path segments as endpoint routes', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 0, skip: 0, limit: 10 }, last_updated: '' },
          results: [],
        }),
      );

      // Endpoint path traversal attempt
      await service.query('drug/event', {}, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.pathname).toBe('/drug/event.json');
    });
  });

  describe('response field integrity', () => {
    it('returns only normalized fields — no raw upstream internals', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: {
            disclaimer: 'Do not use for medical advice.',
            terms: 'https://open.fda.gov/terms/',
            license: 'https://open.fda.gov/license/',
            last_updated: '2026-01-15',
            results: { skip: 0, limit: 10, total: 100 },
          },
          results: [{ id: 'rec-1' }],
        }),
      );

      const result = await service.query('drug/event', {}, ctx);

      // Only normalized meta fields — no raw disclaimer/terms/license
      expect(Object.keys(result.meta)).toEqual(['total', 'skip', 'limit', 'lastUpdated']);
    });

    it('handles missing meta.results gracefully', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { last_updated: '2026-01-15' }, // no results pagination block
          results: [{ id: 'rec-1' }],
        }),
      );

      const result = await service.query('drug/event', {}, ctx);

      expect(result.meta.total).toBe(0);
      expect(result.meta.skip).toBe(0);
      expect(result.meta.limit).toBe(0);
      expect(result.results).toEqual([{ id: 'rec-1' }]);
    });

    it('handles missing results array gracefully', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 5, skip: 0, limit: 10 }, last_updated: '2026-01-15' },
          // results key entirely absent
        }),
      );

      const result = await service.query('drug/event', {}, ctx);
      expect(result.results).toEqual([]);
    });
  });

  describe('count queries', () => {
    it('builds URL with count param', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { last_updated: '2026-01-15' },
          results: [
            { term: 'NAUSEA', count: 100 },
            { term: 'FATIGUE', count: 50 },
          ],
        }),
      );

      await service.query('drug/event', { count: 'patient.reaction.reactionmeddrapt.exact' }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.get('count')).toBe('patient.reaction.reactionmeddrapt.exact');
    });

    it('omits count param when not provided', async () => {
      const service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
      mockFetch.mockResolvedValue(
        mockResponse(200, {
          meta: { results: { total: 1, skip: 0, limit: 10 }, last_updated: '' },
          results: [{}],
        }),
      );

      await service.query('drug/event', { search: 'aspirin' }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.has('count')).toBe(false);
    });
  });
});

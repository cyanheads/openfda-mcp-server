import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('applies defaults when no env vars are set', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();
    expect(config.baseUrl).toBe('https://api.fda.gov');
    expect(config.apiKey).toBeUndefined();
  });

  it('reads env vars', async () => {
    vi.stubEnv('OPENFDA_API_KEY', 'test-key-123');
    vi.stubEnv('OPENFDA_BASE_URL', 'https://custom.fda.test');
    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();
    expect(config.apiKey).toBe('test-key-123');
    expect(config.baseUrl).toBe('https://custom.fda.test');
  });

  it('caches after first call', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    const first = getServerConfig();
    vi.stubEnv('OPENFDA_API_KEY', 'changed');
    const second = getServerConfig();
    expect(second).toBe(first);
    expect(second.apiKey).toBeUndefined();
  });
});

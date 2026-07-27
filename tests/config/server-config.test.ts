import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('applies defaults when no env vars are set', async () => {
    vi.stubEnv('OPENFDA_API_KEY', '');
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
    vi.stubEnv('OPENFDA_API_KEY', '');
    const { getServerConfig } = await import('@/config/server-config.js');
    const first = getServerConfig();
    vi.stubEnv('OPENFDA_API_KEY', 'changed');
    const second = getServerConfig();
    expect(second).toBe(first);
    expect(second.apiKey).toBeUndefined();
  });

  it('leaves the bulk mirror off with live fallback on by default', async () => {
    vi.stubEnv('OPENFDA_API_KEY', '');
    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();
    expect(config.mirrorEnabled).toBe(false);
    expect(config.mirrorFallbackLive).toBe(true);
    expect(config.mirrorPath).toBe('./data/openfda-mirror');
    expect(config.mirrorRefreshCron).toBeUndefined();
  });

  it('reads the mirror env vars', async () => {
    vi.stubEnv('OPENFDA_API_KEY', '');
    vi.stubEnv('OPENFDA_MIRROR_ENABLED', 'true');
    vi.stubEnv('OPENFDA_MIRROR_PATH', '/srv/openfda');
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_CRON', '0 4 * * *');
    vi.stubEnv('OPENFDA_MIRROR_FALLBACK_LIVE', 'false');
    vi.stubEnv('OPENFDA_MIRROR_REFRESH_TIMEOUT_MS', '600000');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toMatchObject({
      mirrorEnabled: true,
      mirrorPath: '/srv/openfda',
      mirrorRefreshCron: '0 4 * * *',
      mirrorFallbackLive: false,
      mirrorRefreshTimeoutMs: 600_000,
    });
  });
});

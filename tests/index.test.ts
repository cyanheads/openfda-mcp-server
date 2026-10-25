/**
 * @fileoverview Startup defaults preserve deployment overrides.
 * @module tests/index
 */

import { afterEach, expect, it, vi } from 'vitest';

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core', () => ({ createApp }));
vi.mock('../src/mcp-server/tools/definitions/index.js', () => ({ allToolDefinitions: [] }));
vi.mock('../src/services/openfda/openfda-service.js', () => ({ initOpenFdaService: vi.fn() }));
vi.mock('../src/services/openfda/mirror/index.js', () => ({
  closeMirrors: vi.fn(),
  scheduleMirrorRefresh: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  [undefined, 'duckdb'],
  ['', 'duckdb'],
  [`\${${'CANVAS_PROVIDER_TYPE'}}`, 'duckdb'],
  ['none', 'none'],
  ['duckdb', 'duckdb'],
])('starts with canvas setting %j as %s', async (setting, expected) => {
  vi.resetModules();
  vi.stubEnv('CANVAS_PROVIDER_TYPE', setting);
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  await import('../src/index.js');
  expect(process.env.CANVAS_PROVIDER_TYPE).toBe(expected);
  expect(createApp).toHaveBeenLastCalledWith(expect.objectContaining({ sessionMode: 'stateless' }));
});

it('loads a .env-only canvas override before applying its default', async () => {
  vi.resetModules();
  vi.stubEnv('CANVAS_PROVIDER_TYPE', undefined);
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
    process.env.CANVAS_PROVIDER_TYPE = 'none';
  });
  await import('../src/index.js');
  expect(process.env.CANVAS_PROVIDER_TYPE).toBe('none');
});

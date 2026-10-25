/**
 * @fileoverview Entry-point environment loading precedes tool configuration.
 * @module tests/index-env
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('loads .env before tool imports cache server configuration', async () => {
  vi.resetModules();
  vi.stubEnv('OPENFDA_BASE_URL', undefined);
  vi.stubEnv('OPENFDA_DATAFRAME_DROP_ENABLED', undefined);
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
    process.env.OPENFDA_BASE_URL = 'https://example.test';
    process.env.OPENFDA_DATAFRAME_DROP_ENABLED = 'true';
  });

  await import('../src/index.js');
  const { getServerConfig } = await import('../src/config/server-config.js');
  const { dataframeDropTool } = await import(
    '../src/mcp-server/tools/definitions/dataframe-drop.tool.js'
  );

  expect(getServerConfig().baseUrl).toBe('https://example.test');
  expect(getServerConfig().dataframeDropEnabled).toBe(true);
  expect(dataframeDropTool).toHaveProperty('handler', expect.any(Function));
  expect(createApp).toHaveBeenCalled();
});

/**
 * @fileoverview Startup defaults preserve deployment overrides, the server
 * instructions point at each endpoint's own product field, and teardown stops
 * the scheduled mirror refresh before it closes the mirrors.
 * @module tests/index
 */

import { afterEach, expect, it, vi } from 'vitest';

const { closeMirrors, createApp, scheduleMirrorRefresh } = vi.hoisted(() => ({
  closeMirrors: vi.fn(),
  createApp: vi.fn(),
  scheduleMirrorRefresh: vi.fn(),
}));
vi.mock('@cyanheads/mcp-ts-core', () => ({ createApp }));
vi.mock('../src/mcp-server/tools/definitions/index.js', () => ({ allToolDefinitions: [] }));
vi.mock('../src/services/openfda/openfda-service.js', () => ({ initOpenFdaService: vi.fn() }));
vi.mock('../src/services/openfda/mirror/index.js', () => ({ closeMirrors, scheduleMirrorRefresh }));

/** The `setup` and `teardown` hooks src/index.ts handed to createApp(). */
async function lifecycleHooks() {
  vi.resetModules();
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  await import('../src/index.js');
  const options = createApp.mock.lastCall?.[0] as {
    setup: (core: unknown) => Promise<void>;
    teardown: () => Promise<void>;
  };
  await options.setup({ canvas: undefined, config: { mcpTransportType: 'http' } });
  return options;
}

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

it('instructs searching each endpoint’s own product field, not a top-level openfda block', async () => {
  vi.resetModules();
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  await import('../src/index.js');
  const options = createApp.mock.lastCall?.[0] as { instructions: string };
  const { instructions } = options;
  expect(instructions).toContain('`patient.drug.medicinalproduct:"aspirin"`');
  expect(instructions).toContain('`patient.drug.openfda.brand_name`');
  expect(instructions).toContain('absent from food, animal, and tobacco records');
  expect(instructions).not.toContain('`openfda.brand_name:"aspirin"`');
  expect(instructions).not.toContain('cross-product fields use the `openfda.*` prefix');
});

it('stops the scheduled mirror refresh and lets it settle before closing the mirrors', async () => {
  const order: string[] = [];
  const settled = Promise.withResolvers<void>();
  scheduleMirrorRefresh.mockResolvedValueOnce({
    stop: () => {
      order.push('stop');
      return settled.promise;
    },
  });
  closeMirrors.mockImplementationOnce(async () => {
    order.push('close');
  });
  const { teardown } = await lifecycleHooks();
  expect(scheduleMirrorRefresh).toHaveBeenLastCalledWith('http');

  const tearingDown = teardown();
  // The stores stay open while the refresh is still settling.
  expect(order).toEqual(['stop']);
  settled.resolve();
  await tearingDown;
  expect(order).toEqual(['stop', 'close']);
});

it('closes the mirrors at teardown when no refresh was scheduled', async () => {
  scheduleMirrorRefresh.mockResolvedValueOnce(undefined);
  closeMirrors.mockClear();
  const { teardown } = await lifecycleHooks();

  await teardown();
  expect(closeMirrors).toHaveBeenCalledOnce();
});

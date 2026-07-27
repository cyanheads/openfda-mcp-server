/**
 * @fileoverview Server-specific configuration for the openFDA MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .preprocess(
      (v) => (typeof v === 'string' && /^\$\{/.test(v) ? undefined : v || undefined),
      z.string().optional(),
    )
    .describe('openFDA API key — increases daily request limit from 1K to 120K'),
  baseUrl: z.string().default('https://api.fda.gov').describe('openFDA API base URL'),

  /* --- Local bulk mirror (opt-in; off by default) --- */
  mirrorEnabled: z
    .stringbool()
    .default(false)
    .describe('Serve reproducible exact-key lookups from the local bulk mirror instead of the API'),
  mirrorPath: z
    .string()
    .default('./data/openfda-mirror')
    .describe('Directory holding one SQLite file per mirrored dataset'),
  mirrorRefreshCron: z
    .string()
    .optional()
    .describe('Cron expression for the in-process refresh (HTTP transport only)'),
  mirrorFallbackLive: z
    .stringbool()
    .default(true)
    .describe('Fall back to the live API when the mirror is cold, missing a record, or failing'),
  mirrorRefreshTimeoutMs: z.coerce
    .number()
    .min(0)
    .default(21_600_000)
    .describe('Wall-clock budget for one scheduled refresh subprocess before it is aborted'),
  mirrorBaseUrl: z
    .string()
    .default('https://api.fda.gov')
    .describe('Host serving the openFDA bulk download manifest (download.json)'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from environment variables. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'OPENFDA_API_KEY',
    baseUrl: 'OPENFDA_BASE_URL',
    mirrorEnabled: 'OPENFDA_MIRROR_ENABLED',
    mirrorPath: 'OPENFDA_MIRROR_PATH',
    mirrorRefreshCron: 'OPENFDA_MIRROR_REFRESH_CRON',
    mirrorFallbackLive: 'OPENFDA_MIRROR_FALLBACK_LIVE',
    mirrorRefreshTimeoutMs: 'OPENFDA_MIRROR_REFRESH_TIMEOUT_MS',
    mirrorBaseUrl: 'OPENFDA_MIRROR_BASE_URL',
  });
  return _config;
}

/** Drop the cached config so the next call re-reads the environment. Test-only. */
export function resetServerConfig(): void {
  _config = undefined;
}

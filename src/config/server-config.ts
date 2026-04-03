/**
 * @fileoverview Server-specific configuration for the openFDA MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .optional()
    .describe('openFDA API key — increases daily request limit from 1K to 120K'),
  baseUrl: z.string().default('https://api.fda.gov').describe('openFDA API base URL'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from environment variables. */
export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    apiKey: process.env.OPENFDA_API_KEY,
    baseUrl: process.env.OPENFDA_BASE_URL,
  });
  return _config;
}

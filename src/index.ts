#!/usr/bin/env node
/**
 * @fileoverview openfda-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';
import { setCanvas } from './services/canvas/canvas-accessor.js';
import { closeMirrors, scheduleMirrorRefresh } from './services/openfda/mirror/index.js';
import type { MirrorRefreshJob } from './services/openfda/mirror/refresh-schedule.js';
import { initOpenFdaService } from './services/openfda/openfda-service.js';

// Load .env before choosing defaults; exported deployment settings still win.
try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
// DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it.
process.env.CANVAS_PROVIDER_TYPE = normalizeEnv(process.env).CANVAS_PROVIDER_TYPE ?? 'duckdb';

// Tool registration reads server configuration, so import it after loading .env.
const { allToolDefinitions } = await import('./mcp-server/tools/definitions/index.js');

/** The scheduled mirror refresh, when `setup()` registered one; teardown stops it. */
let mirrorRefresh: MirrorRefreshJob | undefined;

await createApp({
  name: 'openfda-mcp-server',
  title: 'openfda-mcp-server',
  tools: allToolDefinitions,
  // No tool calls ctx.requestInput, so no HTTP session state is needed.
  // MCP_SESSION_MODE still overrides this when it carries a meaningful value.
  sessionMode: 'stateless',
  instructions:
    'Use the openfda_* tools to query the openFDA public API for drugs, food, devices, and animal/veterinary products: search adverse events, drug approvals, device clearances, and recalls; look up NDC codes; fetch drug labels; aggregate field counts. Queries use dotted field paths joined by AND/OR with double-quoted phrases (e.g. `patient.drug.medicinalproduct:"aspirin"`). The harmonized `openfda` block sits under `patient.drug` on drug adverse events (`patient.drug.openfda.brand_name`) and under `device` on device adverse events, is absent from food, animal, and tobacco records, and elsewhere exists only where openFDA linked the record to a product, so an `openfda.*` miss does not show the product is absent: also search the endpoint\'s own product field.',
  // Public catalog — serve full landing inventory without requiring auth
  landing: { requireAuth: false },
  skills: 'skills',
  async setup(core) {
    initOpenFdaService();
    // Optional DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) — undefined when disabled.
    setCanvas(core.canvas);
    // No-op unless OPENFDA_MIRROR_ENABLED and a refresh cron are both set; the
    // initial harvest always runs out-of-band via `bun run mirror:init`.
    mirrorRefresh = await scheduleMirrorRefresh(core.config.mcpTransportType);
  },
  async teardown() {
    // A scheduled refresh writes to the stores, so it is stopped and settled
    // before they close. Mirrors otherwise open lazily on first lookup, and
    // nothing else holds the SQLite files.
    await mirrorRefresh?.stop();
    await closeMirrors();
  },
});

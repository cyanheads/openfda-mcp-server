#!/usr/bin/env node
/**
 * @fileoverview openfda-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';
import { closeMirrors, scheduleMirrorRefresh } from './services/openfda/mirror/index.js';
import { initOpenFdaService } from './services/openfda/openfda-service.js';

await createApp({
  name: 'openfda-mcp-server',
  title: 'openfda-mcp-server',
  tools: allToolDefinitions,
  // No tool calls ctx.requestInput, so no HTTP session state is needed.
  // MCP_SESSION_MODE still overrides this when it carries a meaningful value.
  sessionMode: 'stateless',
  instructions:
    'Use the openfda_* tools to query the openFDA public API for drugs, food, devices, and animal/veterinary products: search adverse events, drug approvals, device clearances, and recalls; look up NDC codes; fetch drug labels; aggregate field counts. Queries use dotted field paths joined by AND/OR with double-quoted phrases (e.g. `openfda.brand_name:"aspirin"`); cross-product fields use the `openfda.*` prefix.',
  // Public catalog — serve full landing inventory without requiring auth
  landing: { requireAuth: false },
  async setup(core) {
    initOpenFdaService();
    // Optional DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) — undefined when disabled.
    setCanvas(core.canvas);
    // No-op unless OPENFDA_MIRROR_ENABLED and a refresh cron are both set; the
    // initial harvest always runs out-of-band via `bun run mirror:init`.
    await scheduleMirrorRefresh(core.config.mcpTransportType);
  },
  async teardown() {
    // Mirrors open lazily on first lookup; nothing else holds the SQLite files.
    await closeMirrors();
  },
});

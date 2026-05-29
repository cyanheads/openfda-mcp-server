#!/usr/bin/env node
/**
 * @fileoverview openfda-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initOpenFdaService } from './services/openfda/openfda-service.js';

await createApp({
  tools: allToolDefinitions,
  instructions:
    'Use the openfda_* tools to query the openFDA public API for drugs, food, devices, and animal/veterinary products: search adverse events, drug approvals, device clearances, and recalls; look up NDC codes; fetch drug labels; aggregate field counts. Queries use dotted field paths joined by AND/OR with double-quoted phrases (e.g. `openfda.brand_name:"aspirin"`); cross-product fields use the `openfda.*` prefix.',
  // Public catalog — serve full landing inventory without requiring auth
  landing: { requireAuth: false },
  setup() {
    initOpenFdaService();
  },
});

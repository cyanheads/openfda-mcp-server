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
  setup() {
    initOpenFdaService();
  },
});

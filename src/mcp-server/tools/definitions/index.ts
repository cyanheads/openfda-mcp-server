/**
 * @fileoverview Barrel export for all openFDA tool definitions.
 * @module mcp-server/tools/definitions
 */

import { countTool } from './count.tool.js';
import { getDrugLabelTool } from './get-drug-label.tool.js';
import { lookupNdcTool } from './lookup-ndc.tool.js';
import { searchAdverseEventsTool } from './search-adverse-events.tool.js';
import { searchDeviceClearancesTool } from './search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from './search-drug-approvals.tool.js';
import { searchRecallsTool } from './search-recalls.tool.js';

export const allToolDefinitions = [
  searchAdverseEventsTool,
  searchRecallsTool,
  countTool,
  getDrugLabelTool,
  searchDrugApprovalsTool,
  searchDeviceClearancesTool,
  lookupNdcTool,
];

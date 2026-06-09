/**
 * @fileoverview Barrel export for all openFDA tool definitions.
 * @module mcp-server/tools/definitions
 */

import { countValuesTool } from './count-values.tool.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { describeFieldsTool } from './describe-fields.tool.js';
import { drugProfileTool } from './drug-profile.tool.js';
import { getDrugLabelTool } from './get-drug-label.tool.js';
import { lookupNdcTool } from './lookup-ndc.tool.js';
import { searchAdverseEventsTool } from './search-adverse-events.tool.js';
import { searchAnimalEventsTool } from './search-animal-events.tool.js';
import { searchDeviceClearancesTool } from './search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from './search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from './search-drug-shortages.tool.js';
import { searchRecallsTool } from './search-recalls.tool.js';
import { searchTobaccoReportsTool } from './search-tobacco-reports.tool.js';

export const allToolDefinitions = [
  searchAdverseEventsTool,
  searchAnimalEventsTool,
  searchDrugShortagesTool,
  searchRecallsTool,
  searchTobaccoReportsTool,
  countValuesTool,
  describeFieldsTool,
  getDrugLabelTool,
  searchDrugApprovalsTool,
  searchDeviceClearancesTool,
  lookupNdcTool,
  drugProfileTool,
  dataframeDescribeTool,
  dataframeQueryTool,
];

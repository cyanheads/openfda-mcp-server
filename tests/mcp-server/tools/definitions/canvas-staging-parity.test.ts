/**
 * @fileoverview Cross-tool guarantees for the canvas staging surface. Every
 * search tool that can stage shares one contract: staging is opt-in, staging is
 * disclosed in content[], and an empty inline page for a query that matched
 * records never renders as "no results". Asserted against every staging tool
 * rather than the two or three a bug report happens to name.
 * @module tests/mcp-server/tools/definitions/canvas-staging-parity.test
 */

import { describe, expect, it } from 'vitest';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchAdverseEventsTool } from '@/mcp-server/tools/definitions/search-adverse-events.tool.js';
import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import { searchDeviceClearancesTool } from '@/mcp-server/tools/definitions/search-device-clearances.tool.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { searchDrugShortagesTool } from '@/mcp-server/tools/definitions/search-drug-shortages.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { searchTobaccoReportsTool } from '@/mcp-server/tools/definitions/search-tobacco-reports.tool.js';

/** Minimal valid input per tool, before the `stage` default is applied. */
const STAGING_TOOLS = [
  [searchAdverseEventsTool, { category: 'drug' }],
  [searchAnimalEventsTool, {}],
  [searchDeviceClearancesTool, { pathway: '510k' }],
  [searchDrugApprovalsTool, {}],
  [searchDrugShortagesTool, {}],
  [searchRecallsTool, { category: 'drug' }],
  [searchTobaccoReportsTool, {}],
  [lookupNdcTool, { search: 'aspirin' }],
] as const;

const formatText = (
  tool: (typeof STAGING_TOOLS)[number][0],
  result: Record<string, unknown>,
): string => {
  const blocks = (tool.format as (r: unknown) => { text: string }[])(result);
  return blocks.map((b) => b.text).join('\n');
};

describe.each(STAGING_TOOLS.map(([tool, input]) => [tool.name, tool, input] as const))(
  '%s — canvas staging contract',
  (_name, tool, baseInput) => {
    it('defaults staging off so a plain search costs one upstream request (#30)', () => {
      const parsed = tool.input.parse(baseInput) as { stage: boolean };
      expect(parsed.stage).toBe(false);
    });

    it('declares the canvas_disabled failure mode', () => {
      expect(tool.errors?.map((e) => e.reason)).toContain('canvas_disabled');
    });

    it('never reports "no results" for a query that matched records (#31)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).not.toMatch(/^No .*(found|records)\.$/im);
      expect(text).toContain('609468');
    });

    it('discloses staged-vs-matched counts and the query path in content[] (#30, #31)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).toContain('Staged 235 of 609468');
      expect(text).toContain('spilled_ab12cd34');
      expect(text).toContain('openfda_dataframe_query');
    });

    it('points a truncated stage at openfda_count_values for whole-population aggregates (#36)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).toContain('narrow the query');
      expect(text).toContain('openfda_count_values');
    });

    it('omits the aggregate route when the whole match reached the table (#36)', () => {
      const text = formatText(tool, {
        meta: { total: 235, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
      });
      expect(text).not.toContain('openfda_count_values');
    });

    it('names the aggregate alternative in the stage input description (#36)', () => {
      const stage = tool.input.shape.stage as { description?: string };
      expect(stage.description).toContain('openfda_count_values');
    });

    it('points past-the-end offsets at the staged table with a runnable query (#32)', () => {
      const text = formatText(tool, {
        meta: { total: 1175, skip: 300, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 1175,
      });
      expect(text).toContain('skip=300 is past the end');
      expect(text).toContain('The staged table holds all 1175 of them');
      expect(text).toContain('SELECT * FROM spilled_ab12cd34 LIMIT 10');
      /** The offset already overshot the matched set, so it must not reappear in the SQL. */
      expect(text).not.toContain('OFFSET 300');
    });

    it('says how much the staged table holds when staging was truncated (#30, #32)', () => {
      const text = formatText(tool, {
        meta: { total: 609_468, skip: 700_000, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
        canvas_id: 'cv_1',
        canvas_table: 'spilled_ab12cd34',
        spilled: true,
        staged_rows: 235,
        truncated: true,
      });
      expect(text).toContain('The staged table holds the first 235 of them');
      expect(text).not.toContain('OFFSET 700000');
    });

    it('qualifies its no-match wording when the request carried an offset', () => {
      const text = formatText(tool, {
        meta: { total: 0, skip: 500, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
      });
      expect(text).toContain('at skip=500');
      expect(text).toContain('Retry with skip=0');
    });

    it('keeps its own no-match wording when nothing matched', () => {
      const text = formatText(tool, {
        meta: { total: 0, skip: 0, limit: 0, lastUpdated: '2026-06-01' },
        results: [],
      });
      expect(text).toMatch(/^No .*\.$/);
    });
  },
);

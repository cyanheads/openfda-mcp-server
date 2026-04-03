/**
 * @fileoverview MCP tool for openFDA count/aggregation queries. Tallies unique
 * values for any field across any endpoint, returning ranked term-count pairs.
 * @module mcp-server/tools/definitions/count.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/** All valid openFDA endpoint paths. */
const ENDPOINTS = [
  'drug/event',
  'drug/label',
  'drug/enforcement',
  'drug/ndc',
  'drug/drugsfda',
  'drug/shortages',
  'food/event',
  'food/enforcement',
  'device/event',
  'device/510k',
  'device/pma',
  'device/recall',
  'device/enforcement',
  'device/classification',
  'device/registrationlisting',
  'device/udi',
  'device/covid19serology',
  'animalandveterinary/event',
  'other/substance',
] as const;

export const countTool = tool('openfda_count', {
  description:
    'Aggregate and tally unique values for any field across any openFDA endpoint. Returns ranked term-count pairs sorted by count descending.',
  annotations: { readOnlyHint: true },

  input: z.object({
    endpoint: z
      .enum(ENDPOINTS)
      .describe('Full openFDA endpoint path (e.g. "drug/event", "device/classification")'),
    count: z
      .string()
      .describe(
        'Field to count. Append .exact for whole-phrase counting (e.g. "patient.reaction.reactionmeddrapt.exact", "openfda.brand_name.exact")',
      ),
    search: z
      .string()
      .optional()
      .describe('Filter query to scope the count (e.g. patient.drug.medicinalproduct:"metformin")'),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(100)
      .optional()
      .describe('Number of top terms to return (default 100, max 1000)'),
  }),

  output: z.object({
    meta: z
      .object({
        lastUpdated: z.string().describe('Dataset last updated date'),
      })
      .describe('Response metadata'),
    results: z
      .array(
        z.object({
          term: z.string().describe('Field value'),
          count: z.number().describe('Number of occurrences'),
        }),
      )
      .describe('Term-count pairs sorted by count descending'),
    message: z.string().optional().describe('Guidance when results are empty'),
  }),

  async handler(input, ctx) {
    const svc = getOpenFdaService();
    const response = await svc.query(
      input.endpoint,
      {
        search: input.search,
        count: input.count,
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('Count query completed', {
      endpoint: input.endpoint,
      count: input.count,
      terms: response.results.length,
    });

    const results = response.results.map((r) => ({
      term: String(r.term),
      count: r.count as number,
    }));

    if (results.length === 0) {
      return {
        meta: { lastUpdated: response.meta.lastUpdated },
        results,
        message: `No count results for ${input.count} on ${input.endpoint}${input.search ? ` with search: ${input.search}` : ''}. Verify the field name exists for this endpoint and check .exact suffix usage.`,
      };
    }

    return { meta: { lastUpdated: response.meta.lastUpdated }, results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text' as const, text: result.message ?? 'No count results.' }];
    }

    const totalCount = result.results.reduce((sum, r) => sum + r.count, 0);
    const lines: string[] = [
      `**${result.results.length} terms** (total occurrences: ${totalCount.toLocaleString()}) | Data updated: ${result.meta.lastUpdated}\n`,
      '| # | Term | Count |',
      '|---|------|-------|',
    ];

    for (const [i, r] of result.results.entries()) {
      lines.push(`| ${i + 1} | ${r.term} | ${r.count.toLocaleString()} |`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

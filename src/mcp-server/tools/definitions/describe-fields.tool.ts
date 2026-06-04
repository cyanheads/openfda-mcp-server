/**
 * @fileoverview Tool definition for surfacing openFDA searchable field paths per endpoint.
 * @module mcp-server/tools/definitions/describe-fields
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  type FieldEntry,
  type FieldGroup,
  getCatalogedEndpoints,
  getFieldGroups,
} from '@/mcp-server/tools/field-catalog.js';

/** All endpoints with cataloged field data. */
const CATALOGED_ENDPOINTS = getCatalogedEndpoints() as [string, ...string[]];

export const describeFieldsTool = tool('openfda_describe_fields', {
  description:
    'Return the searchable field paths for an openFDA endpoint, grouped by category with type and description. Use before constructing a search query to find the correct dotted field path — field names differ per endpoint and are not discoverable from the tool schema alone.',
  annotations: { readOnlyHint: true },

  input: z.object({
    endpoint: z
      .enum(CATALOGED_ENDPOINTS)
      .describe(
        'openFDA endpoint to describe (e.g. "drug/event", "drug/shortages", "device/510k"). Must be one of the cataloged endpoints.',
      ),
  }),

  output: z.object({
    endpoint: z.string().describe('The endpoint these fields apply to'),
    groups: z
      .array(
        z
          .object({
            label: z.string().describe('Field group label'),
            fields: z
              .array(
                z
                  .object({
                    path: z.string().describe('Dotted field path for use in search queries'),
                    type: z.string().describe('Data type (string, date, integer, float, boolean)'),
                    note: z.string().describe('What this field contains'),
                  })
                  .describe('A single searchable field entry'),
              )
              .describe('Searchable fields in this group'),
          })
          .describe('A named group of related fields'),
      )
      .describe('Field groups for this endpoint'),
    queryTips: z.string().describe('openFDA query syntax reminders relevant to this endpoint'),
  }),

  handler(input, ctx) {
    const groups = getFieldGroups(input.endpoint);

    // This should not happen since input is constrained to cataloged endpoints,
    // but guard defensively so a future catalog gap doesn't silently return wrong data.
    if (!groups) {
      throw new Error(`No field catalog found for endpoint: ${input.endpoint}`);
    }

    ctx.log.info('Describe fields requested', { endpoint: input.endpoint });

    const queryTips =
      'Use field:value syntax (e.g. generic_name:"carboplatin"). ' +
      'Phrase matching requires double quotes. ' +
      'Combine filters with AND or OR. ' +
      'Append .exact to string fields for whole-phrase aggregation in openfda_count. ' +
      'Date fields accept YYYYMMDD format and support range syntax [20200101 TO 20221231].';

    return { endpoint: input.endpoint, groups, queryTips };
  },

  format: (result) => {
    const lines: string[] = [`## Searchable fields — \`${result.endpoint}\`\n`];

    for (const group of result.groups as FieldGroup[]) {
      lines.push(`### ${group.label}`);
      lines.push('| Field path | Type | Description |');
      lines.push('|:---|:---|:---|');
      for (const field of group.fields as FieldEntry[]) {
        lines.push(`| \`${field.path}\` | ${field.type} | ${field.note} |`);
      }
      lines.push('');
    }

    lines.push(`**Query tips:** ${result.queryTips}`);

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

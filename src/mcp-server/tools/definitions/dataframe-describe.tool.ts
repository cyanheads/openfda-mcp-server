/**
 * @fileoverview Tool: openfda_dataframe_describe — list tables and column
 * schemas on a DataCanvas staged by an openFDA search tool's spillover.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const dataframeDescribeTool = tool('openfda_dataframe_describe', {
  description:
    'List the tables and column schemas on a DataCanvas staged by an openFDA search tool. ' +
    'Call before openfda_dataframe_query to discover the exact table name, column names, and DuckDB types needed for valid SQL. ' +
    'row_count is the full staged result set, not the inline preview count. ' +
    'Columns typed JSON hold nested openFDA objects/arrays — query them with DuckDB json functions.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z.string().describe('Canvas ID from an openFDA search tool response.'),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table or view name — use verbatim in SQL FROM clauses.'),
            kind: z
              .string()
              .describe('Object type: "table" for staged data, "view" for a derived view.'),
            row_count: z
              .number()
              .describe('Total rows in this table — the full staged set, not the inline preview.'),
            columns: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .describe('Column name — use in SELECT, WHERE, GROUP BY, ORDER BY.'),
                    type: z
                      .string()
                      .describe('DuckDB type (VARCHAR, JSON, BIGINT, DOUBLE, BOOLEAN, ...).'),
                    nullable: z
                      .boolean()
                      .optional()
                      .describe('True when the column may contain NULL. Absent when unknown.'),
                  })
                  .describe('A single column in the table.'),
              )
              .describe('All columns in this table, in schema order.'),
          })
          .describe('A registered table or view on the canvas.'),
      )
      .describe('All tables and views available on this canvas.'),
    canvas_id: z
      .string()
      .describe('Canvas ID that was described — pass to openfda_dataframe_query.'),
  }),
  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery:
        'Re-run the openFDA search tool to stage a fresh canvas, then use the new canvas_id.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw new Error(
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use openfda_dataframe_describe.',
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const tableInfos = await instance.describe();

    ctx.log.info('DataCanvas describe complete', {
      canvasId: input.canvas_id,
      tableCount: tableInfos.length,
    });

    return {
      tables: tableInfos.map((t) => ({
        name: t.name,
        kind: t.kind,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          ...(c.nullable != null ? { nullable: c.nullable } : {}),
        })),
      })),
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Canvas:** ${result.canvas_id} | **${result.tables.length} table(s)**\n`,
    ];
    for (const t of result.tables) {
      lines.push(`## ${t.name} (${t.kind}, ${t.row_count} rows)`);
      lines.push(`| Column | Type | Nullable |`);
      lines.push(`| --- | --- | --- |`);
      for (const c of t.columns) {
        lines.push(`| ${c.name} | ${c.type} | ${c.nullable ?? 'unknown'} |`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

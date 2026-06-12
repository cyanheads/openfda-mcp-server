/**
 * @fileoverview Tool: openfda_dataframe_query — read-only SQL SELECT against a
 * DataCanvas table staged by an openFDA search tool's spillover.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const dataframeQueryTool = tool('openfda_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against a DataCanvas table staged by an openFDA search tool (canvas_id + canvas_table in its response when spilled=true). ' +
    'Enables GROUP BY, COUNT/SUM/AVG, time-series, and joins across the full result set without re-paging the API. ' +
    'Call openfda_dataframe_describe first to get the exact table and column names. ' +
    "Scalar fields are stored as text (CAST for numeric math); nested objects/arrays are JSON columns — read them with DuckDB json functions, e.g. json_extract_string(openfda, '$.brand_name[0]'). " +
    'Only SELECT is allowed — DDL, DML, COPY, and file-reading functions are blocked.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID from an openFDA search tool response (the canvas_id field).'),
    query: z
      .string()
      .describe(
        'SQL SELECT against the staged table. Use the table name from openfda_dataframe_describe. ' +
          'Example: "SELECT classification, COUNT(*) AS n FROM spilled_ab12cd34 GROUP BY classification ORDER BY n DESC".',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .record(z.string(), z.unknown())
          .describe('A result row — keys are the SELECT column names, values the computed data.'),
      )
      .describe('Rows returned by the query (capped at the canvas row limit).'),
    row_count: z.number().describe('Number of rows in this response.'),
    canvas_id: z.string().describe('Canvas ID that was queried — reuse for follow-up queries.'),
  }),
  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery:
        'Re-run the openFDA search tool to stage a fresh canvas, then use the new canvas_id.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not a valid SELECT, references an unknown table or column, or uses a blocked operation.',
      recovery:
        'Call openfda_dataframe_describe to verify table and column names, then correct the SQL. Only SELECT is permitted.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw new Error(
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use openfda_dataframe_query.',
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.query, {
      signal: ctx.signal,
      denySystemCatalogs: true,
    });

    ctx.log.info('DataCanvas query complete', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
    });

    return {
      rows: result.rows,
      row_count: result.rowCount,
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const lines: string[] = [`**${result.row_count} rows** | Canvas: ${result.canvas_id}\n`];
    if (result.rows.length === 0) {
      lines.push('_No rows returned._');
    } else {
      const headers = Object.keys(result.rows[0] ?? {});
      if (headers.length > 0) {
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const row of result.rows) {
          lines.push(`| ${headers.map((h) => String(row[h] ?? '')).join(' | ')} |`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

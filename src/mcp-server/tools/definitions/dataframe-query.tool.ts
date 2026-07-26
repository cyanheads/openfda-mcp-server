/**
 * @fileoverview Tool: openfda_dataframe_query — read-only SQL SELECT against a
 * DataCanvas table staged by an openFDA search tool's spillover.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { nonBlankString } from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

/**
 * How the canvas layer's own failure reasons map onto this tool's public
 * contract. The canvas messages recommend internal `registerTable()` / `drop()` /
 * `clear()` APIs that are not tools an agent can call, so the reason is
 * translated here and the message rewritten in terms of the MCP surface.
 * `invalid_sql` carries the DuckDB binder detail (the unknown column or
 * function), which is the one part of the upstream text worth keeping.
 */
const SQL_REJECTION_DETAIL: Record<string, string> = {
  non_select_statement: 'only a single read-only SELECT statement is accepted',
  multi_statement: 'only a single read-only SELECT statement is accepted',
  plan_operator_not_allowed:
    'the query plan uses an operation the read-only gate blocks (writes, file reads, or utility statements)',
  denied_function: 'the query calls a table function that reads outside the canvas',
  denied_function_in_plan: 'the query plan calls a table function that reads outside the canvas',
  system_catalog_access: 'system catalog tables are not queryable through this tool',
  sql_parse_error: 'the statement could not be parsed as SQL',
  sql_read_only: 'the statement is not read-only',
};

/** Structured payload the canvas layer attaches to its `McpError`s. */
function canvasErrorData(err: unknown): {
  reason?: string;
  binderMessage?: string;
  tableName?: string;
} {
  return err instanceof McpError
    ? ((err.data ?? {}) as { reason?: string; binderMessage?: string; tableName?: string })
    : {};
}

export const dataframeQueryTool = tool('openfda_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against a DataCanvas table staged by an openFDA search tool (call one with stage=true; its response carries canvas_id + canvas_table). ' +
    'Enables GROUP BY, COUNT/SUM/AVG, time-series, and joins across the staged result set without re-paging the API. ' +
    'Call openfda_dataframe_describe first to get the exact table and column names. ' +
    'Results are capped at the canvas row limit — when truncated is true, page the rest with ORDER BY plus LIMIT/OFFSET. ' +
    "Scalar fields are stored as text (CAST for numeric math); nested objects/arrays are JSON columns — read them with DuckDB json functions, e.g. json_extract_string(openfda, '$.brand_name[0]'). " +
    'Only SELECT is allowed — DDL, DML, COPY, and file-reading functions are blocked.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: nonBlankString().describe(
      'Canvas ID from an openFDA search tool response (the canvas_id field, present when the search ran with stage=true).',
    ),
    query: nonBlankString().describe(
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
    row_count: z
      .number()
      .describe(
        'Number of rows in this response. Equals the canvas row limit when truncated is true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the result hit the canvas row limit and rows beyond it were dropped. Page the rest with ORDER BY plus LIMIT/OFFSET.',
      ),
    canvas_id: z.string().describe('Canvas ID that was queried — reuse for follow-up queries.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'DataCanvas is disabled — CANVAS_PROVIDER_TYPE is unset.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb to enable DataCanvas SQL, or use an openFDA search tool directly (its inline results need no canvas).',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery:
        'Re-run the openFDA search tool to stage a fresh canvas, then use the new canvas_id.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL references a table that is not on the canvas — dropped, expired, or mistyped.',
      recovery:
        'Call openfda_dataframe_describe for the tables currently on this canvas, or re-run the search tool with stage=true to stage a fresh one.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not a valid SELECT, references an unknown column, or uses a blocked operation.',
      recovery:
        'Call openfda_dataframe_describe to verify table and column names, then correct the SQL. Only a single read-only SELECT is permitted.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use openfda_dataframe_query.',
        { ...ctx.recoveryFor('canvas_disabled') },
      );
    }

    // The canvas layer raises its own reasons (non_select_statement, missing_table,
    // plan_operator_not_allowed, ...) with recovery text pointing at internal APIs.
    // Translate them onto this tool's declared contract at the boundary.
    let result: QueryResult;
    try {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      result = await instance.query(input.query, {
        signal: ctx.signal,
        denySystemCatalogs: true,
      });
    } catch (err) {
      const { reason, binderMessage, tableName } = canvasErrorData(err);
      if (reason === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas "${input.canvas_id}" is not an active session — it expired or never existed.`,
          { ...ctx.recoveryFor('canvas_not_found') },
        );
      }
      if (reason === 'missing_table') {
        throw ctx.fail(
          'missing_table',
          `Table ${tableName ? `"${tableName}" ` : ''}is not on canvas "${input.canvas_id}".`,
          { ...ctx.recoveryFor('missing_table'), ...(tableName ? { tableName } : {}) },
        );
      }
      if (reason === 'invalid_sql') {
        throw ctx.fail(
          'invalid_query',
          `SQL rejected: ${binderMessage ?? 'the query failed to prepare'}.`,
          {
            ...ctx.recoveryFor('invalid_query'),
            canvas_reason: reason,
          },
        );
      }
      if (reason && reason in SQL_REJECTION_DETAIL) {
        throw ctx.fail('invalid_query', `SQL rejected: ${SQL_REJECTION_DETAIL[reason]}.`, {
          ...ctx.recoveryFor('invalid_query'),
          canvas_reason: reason,
        });
      }
      throw err;
    }

    ctx.log.info('DataCanvas query complete', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
      truncated: result.truncated === true,
    });

    return {
      rows: result.rows,
      row_count: result.rowCount,
      truncated: result.truncated === true,
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const lines: string[] = [`**${result.row_count} rows** | Canvas: ${result.canvas_id}\n`];
    if (result.truncated) {
      lines.push(
        `> Truncated: capped at the canvas row limit — ${result.rows.length} rows returned and more matched. ` +
          `Read the rest a page at a time with a deterministic sort, e.g. \`... ORDER BY 1 LIMIT ${result.rows.length} OFFSET ${result.rows.length}\`.\n`,
      );
    }
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

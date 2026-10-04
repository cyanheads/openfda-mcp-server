/**
 * @fileoverview Tool: openfda_dataframe_drop — delete one table (or view) from
 * a DataCanvas staged by an openFDA search tool's spillover. Opt-in: registered
 * only when OPENFDA_DATAFRAME_DROP_ENABLED=true, otherwise listed as disabled.
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX, CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

/** The tool definition itself, before the deployment flag decides whether it is callable. */
const dataframeDropDefinition = tool('openfda_dataframe_drop', {
  description:
    'Delete one table or view from a DataCanvas staged by an openFDA search tool, freeing the space it holds before the canvas expires on its own. Other tables on the canvas, and the canvas itself, stay. The drop is permanent: re-run the search tool with stage=true to stage the data again. Call openfda_dataframe_describe for the exact table name.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID from the canvas_id field of an openFDA search tool response (openfda_search_* or openfda_lookup_ndc), present when the search ran with stage=true.',
    ),
    table: z
      .string()
      .regex(CANVAS_IDENTIFIER_REGEX)
      .describe(
        'Name of the table or view to delete, exactly as openfda_dataframe_describe lists it (e.g. spilled_ab12cd34).',
      ),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas ID the table was removed from.'),
    table: z.string().describe('Name of the table or view that was deleted.'),
    remaining_tables: z
      .array(z.string().describe('Table or view name still on the canvas.'))
      .describe('Tables and views left on the canvas after the drop. Empty when none remain.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'DataCanvas is disabled — CANVAS_PROVIDER_TYPE is unset.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb to enable DataCanvas, or skip the drop, since nothing is staged without it.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not correspond to an active canvas session.',
      recovery:
        'The canvas expired or never existed, so its tables are already gone; no drop is needed.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The named table is not on the canvas — already dropped, expired, or mistyped.',
      recovery:
        'Call openfda_dataframe_describe for the tables currently on this canvas and retry with a listed name.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use openfda_dataframe_drop.',
      );
    }

    /**
     * The registry's canvas_not_found carries a re-stage hint, which is the
     * wrong advice for a drop: a missing canvas has nothing left to remove.
     */
    const instance = await canvas.acquire(input.canvas_id, ctx).catch((err: unknown) => {
      if (err instanceof McpError && err.data?.reason === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas "${input.canvas_id}" is not active.`,
          { canvasId: input.canvas_id },
          { cause: err },
        );
      }
      throw err;
    });
    const dropped = await instance.drop(input.table);
    if (!dropped) {
      throw ctx.fail(
        'missing_table',
        `Table "${input.table}" is not on canvas "${input.canvas_id}".`,
        { tableName: input.table },
      );
    }
    const remaining = await instance.describe();

    ctx.log.info('DataCanvas table dropped', {
      canvasId: input.canvas_id,
      table: input.table,
      remainingTables: remaining.length,
    });

    return {
      canvas_id: input.canvas_id,
      table: input.table,
      remaining_tables: remaining.map((t) => t.name),
    };
  },

  format: (result) => {
    const remaining =
      result.remaining_tables.length === 0
        ? 'No tables remain on this canvas.'
        : `Remaining tables (${result.remaining_tables.length}): ${result.remaining_tables.join(', ')}`;
    return [
      {
        type: 'text',
        text: `Dropped table **${result.table}** from canvas ${result.canvas_id}.\n${remaining}`,
      },
    ];
  },
});

/**
 * Registered in every deployment. With OPENFDA_DATAFRAME_DROP_ENABLED unset it
 * is wrapped in `disabledTool()`: listed on the landing page with the enable
 * hint, skipped at MCP registration so clients cannot call it.
 */
export const dataframeDropTool = getServerConfig().dataframeDropEnabled
  ? dataframeDropDefinition
  : disabledTool(dataframeDropDefinition, {
      reason: 'Dropping staged DataCanvas tables is turned off in this deployment.',
      hint: 'OPENFDA_DATAFRAME_DROP_ENABLED=true',
    });

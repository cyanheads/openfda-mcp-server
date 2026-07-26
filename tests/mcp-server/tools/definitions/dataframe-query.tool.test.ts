/**
 * @fileoverview Tests for openfda_dataframe_query — happy path, the row-cap
 * disclosure, and the mapping of DataCanvas failure reasons onto the tool's
 * declared error contract.
 * @module tests/mcp-server/tools/definitions/dataframe-query.tool.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';

vi.mock('@/services/canvas/canvas-accessor.js', () => {
  let _canvas: unknown;
  return {
    getCanvas: () => _canvas,
    setCanvas: (c: unknown) => {
      _canvas = c;
    },
    __setMock: (c: unknown) => {
      _canvas = c;
    },
  };
});

async function setCanvasMock(impl: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(impl);
}

/** Canvas whose query() rejects with the given framework error. */
async function setFailingCanvas(err: unknown, failOn: 'query' | 'acquire' = 'query') {
  const instance = { canvasId: 'cv_abc123', query: vi.fn().mockRejectedValue(err) };
  await setCanvasMock({
    acquire:
      failOn === 'acquire' ? vi.fn().mockRejectedValue(err) : vi.fn().mockResolvedValue(instance),
  });
}

const recoveryHint = (err: McpError) =>
  (err.data as { recovery?: { hint?: string } }).recovery?.hint ?? '';

describe('openfda_dataframe_query', () => {
  beforeEach(async () => {
    const mockInstance = {
      canvasId: 'cv_abc123',
      query: vi.fn().mockResolvedValue({
        rows: [
          { classification: 'Class I', n: 42 },
          { classification: 'Class II', n: 17 },
        ],
        rowCount: 2,
      }),
    };
    await setCanvasMock({ acquire: vi.fn().mockResolvedValue(mockInstance) });
  });

  it('runs SQL against a staged canvas table', async () => {
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      canvas_id: 'cv_abc123',
      query: 'SELECT classification, COUNT(*) AS n FROM spilled_x GROUP BY classification',
    });
    const result = await dataframeQueryTool.handler(input, ctx);
    expect(result.canvas_id).toBe('cv_abc123');
    expect(result.row_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows[0]).toMatchObject({ classification: 'Class I' });
  });

  it('throws a typed canvas_disabled error (not -32603) when canvas is not enabled', async () => {
    await setCanvasMock(undefined);
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ canvas_id: 'cv_abc123', query: 'SELECT 1' });
    const err = (await dataframeQueryTool.handler(input, ctx).catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError); // typed, not InternalError (-32603)
    expect(err.data).toMatchObject({ reason: 'canvas_disabled' });
    expect(recoveryHint(err)).toContain('CANVAS_PROVIDER_TYPE');
  });

  it('formats results as a markdown table', () => {
    const blocks = dataframeQueryTool.format!({
      rows: [{ classification: 'Class I', n: 42 }],
      row_count: 1,
      truncated: false,
      canvas_id: 'cv_abc123',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('cv_abc123');
    expect(text).toContain('classification');
    expect(text).toContain('Class I');
  });

  it('formats an empty result gracefully', () => {
    const blocks = dataframeQueryTool.format!({
      rows: [],
      row_count: 0,
      truncated: false,
      canvas_id: 'cv_abc123',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('No rows returned');
  });
});

describe('openfda_dataframe_query — row cap disclosure (#29)', () => {
  /** Canvas holding 10,050 rows behind a 10,000-row query cap, honoring LIMIT/OFFSET. */
  function makeCappedCanvas(rowLimit = 10_000, total = 10_050) {
    const instance = {
      canvasId: 'cv_capped',
      query: vi.fn(async (sql: string) => {
        const offset = Number(/OFFSET (\d+)/i.exec(sql)?.[1] ?? 0);
        const explicit = Number(/LIMIT (\d+)/i.exec(sql)?.[1] ?? rowLimit);
        const size = Math.min(explicit, rowLimit, Math.max(0, total - offset));
        const rows = Array.from({ length: size }, (_v, i) => ({ id: offset + i }));
        const truncated = offset + size < total && size === rowLimit;
        return { rows, rowCount: size, columns: ['id'], ...(truncated ? { truncated } : {}) };
      }),
    };
    return { acquire: vi.fn().mockResolvedValue(instance) };
  }

  it('surfaces truncated in structuredContent and content when the cap is hit', async () => {
    await setCanvasMock(makeCappedCanvas());
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const result = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        canvas_id: 'cv_capped',
        query: 'SELECT id FROM spilled_x',
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(10_000);

    const text = (dataframeQueryTool.format!(result)[0] as { text: string }).text;
    expect(text).toMatch(/row limit/i);
    expect(text).toContain('OFFSET 10000');
  });

  it('retrieves a follow-up page past the cap with LIMIT/OFFSET', async () => {
    await setCanvasMock(makeCappedCanvas());
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const page = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        canvas_id: 'cv_capped',
        query: 'SELECT id FROM spilled_x ORDER BY 1 LIMIT 5 OFFSET 10000',
      }),
      ctx,
    );

    expect(page.truncated).toBe(false);
    expect(page.rows).toHaveLength(5);
    expect(page.rows[0]).toMatchObject({ id: 10_000 });
  });
});

describe('openfda_dataframe_query — canvas error mapping (#28)', () => {
  it('maps a non-SELECT rejection to invalid_query without naming internal canvas APIs', async () => {
    await setFailingCanvas(
      validationError(
        'Canvas query must be SELECT; got INSERT. Mutations must use registerTable, drop, or clear.',
        {
          reason: 'non_select_statement',
          statementType: 'INSERT',
        },
      ),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const err = (await dataframeQueryTool
      .handler(
        dataframeQueryTool.input.parse({
          canvas_id: 'cv_abc123',
          query: "INSERT INTO spilled_x VALUES ('x')",
        }),
        ctx,
      )
      .catch((e) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({
      reason: 'invalid_query',
      canvas_reason: 'non_select_statement',
    });
    expect(recoveryHint(err)).toContain('openfda_dataframe_describe');
    for (const internal of ['registerTable', 'drop()', 'clear()']) {
      expect(`${err.message} ${recoveryHint(err)}`).not.toContain(internal);
    }
  });

  it('maps a blocked plan operator to invalid_query with actionable recovery', async () => {
    await setFailingCanvas(
      validationError('Canvas query plan contains disallowed operators: READ_CSV.', {
        reason: 'plan_operator_not_allowed',
      }),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const err = (await dataframeQueryTool
      .handler(
        dataframeQueryTool.input.parse({
          canvas_id: 'cv_abc123',
          query: "SELECT * FROM read_csv('/etc/passwd')",
        }),
        ctx,
      )
      .catch((e) => e)) as McpError;

    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(recoveryHint(err)).toContain('openfda_dataframe_describe');
  });

  it('keeps the DuckDB binder detail when a SELECT names an unknown column', async () => {
    await setFailingCanvas(
      validationError('Canvas query failed to prepare: Referenced column "nope" not found.', {
        reason: 'invalid_sql',
        binderMessage: 'Referenced column "nope" not found.',
      }),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const err = (await dataframeQueryTool
      .handler(
        dataframeQueryTool.input.parse({
          canvas_id: 'cv_abc123',
          query: 'SELECT nope FROM spilled_x',
        }),
        ctx,
      )
      .catch((e) => e)) as McpError;

    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Referenced column "nope" not found');
  });

  it('maps a missing table to the declared missing_table reason', async () => {
    await setFailingCanvas(
      notFound('Canvas table "spilled_gone" does not exist. Re-stage it or call describe().', {
        reason: 'missing_table',
        tableName: 'spilled_gone',
        recovery: { hint: 'Re-stage the table via registerTable() or call describe().' },
      }),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const err = (await dataframeQueryTool
      .handler(
        dataframeQueryTool.input.parse({
          canvas_id: 'cv_abc123',
          query: 'SELECT * FROM spilled_gone',
        }),
        ctx,
      )
      .catch((e) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'missing_table', tableName: 'spilled_gone' });
    expect(recoveryHint(err)).toContain('openfda_dataframe_describe');
    expect(recoveryHint(err)).not.toContain('registerTable');
  });

  it('maps an unknown canvas to the declared canvas_not_found reason', async () => {
    await setFailingCanvas(
      notFound('Canvas not found.', {
        reason: 'canvas_not_found',
        recovery: { hint: 'Call acquire() again.' },
      }),
      'acquire',
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const err = (await dataframeQueryTool
      .handler(dataframeQueryTool.input.parse({ canvas_id: 'cv_gone', query: 'SELECT 1' }), ctx)
      .catch((e) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'canvas_not_found' });
    expect(recoveryHint(err)).toContain('openFDA search tool');
  });

  it('lets an unrelated failure bubble unchanged', async () => {
    await setFailingCanvas(new Error('socket hang up'));
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    await expect(
      dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ canvas_id: 'cv_abc123', query: 'SELECT 1' }),
        ctx,
      ),
    ).rejects.toThrow('socket hang up');
  });
});

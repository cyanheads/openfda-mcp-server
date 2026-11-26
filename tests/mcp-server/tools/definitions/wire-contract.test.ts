/**
 * @fileoverview Wire-shape guarantees every tool definition must hold.
 *
 * Two contracts the framework enforces at definition time, pinned here so a new
 * or edited tool cannot regress them silently:
 *
 * - **Strict inputs.** An unrecognized argument key is rejected by name rather
 *   than stripped, and the advertised `inputSchema` carries
 *   `additionalProperties: false` to match. A stripped key turns a caller's
 *   typo into a wrong answer they cannot detect.
 * - **Reserved `error` key.** `structuredContent.error` is the failure envelope,
 *   so a success payload declaring the same field is indistinguishable from a
 *   failure on the wire.
 * - **Service-raised reasons are marked.** A reason produced below the handler
 *   carries `thrownBy: 'service'` on every tool that declares it. The lint that
 *   reads the marker scans only handlers holding a literal `ctx.fail(`, so it
 *   cannot catch a tool left unmarked.
 * - **Sort refusals.** Every tool taking `sort` declares `not_sortable` from its
 *   shared entry, and the reason, field, and correction reach both surfaces.
 * - **Description size.** A client loads every description before its first
 *   call, so a rule shared across tools is written once, in its shared builder:
 *   a description string repeated verbatim on two or more tools stays within
 *   300 bytes, and the server-written description bytes stay under a ceiling.
 *
 * Asserted against the definitions as `tool()` returns them — the same objects
 * the server registers — not against the schema literals in their source.
 * @module tests/mcp-server/tools/definitions/wire-contract.test
 */

import { Buffer } from 'node:buffer';
import { tool, z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { lookupNdcTool } from '@/mcp-server/tools/definitions/lookup-ndc.tool.js';
import { searchRecallsTool } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import {
  CONJOINED_ARRAY_NOTICE_TOPIC,
  CURSOR_END_NOTICE_TOPIC,
  fieldsDescription,
  notSortableError,
  searchNoticeField,
  sortDescription,
} from '@/mcp-server/tools/schema-utils.js';
import { SEARCH_SYNTAX_NOTE } from '@/mcp-server/tools/search-expression.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { STAGING_WORKFLOW } from '@/services/openfda/canvas-spill.js';
import { initOpenFdaService } from '@/services/openfda/openfda-service.js';
import { includeDescription, LEFT_OUT_NOTICE_TOPIC } from '@/services/openfda/record-projection.js';
import { textOfResult } from '../../../helpers/content.js';

const UNKNOWN_KEY = '__not_a_declared_argument__';

describe('tool input strictness', () => {
  it.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
    '%s rejects an unrecognized argument key by name',
    (_name, definition) => {
      const result = definition.input.safeParse({ [UNKNOWN_KEY]: 'x' });

      expect(result.success).toBe(false);
      if (result.success) return;
      const unrecognized = result.error.issues.filter(
        (issue) => issue.code === 'unrecognized_keys',
      );
      expect(unrecognized).toHaveLength(1);
      expect(unrecognized[0]).toMatchObject({ keys: [UNKNOWN_KEY] });
    },
  );

  it.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
    '%s advertises additionalProperties: false',
    (_name, definition) => {
      const schema = z.toJSONSchema(definition.input, {
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>;

      expect(schema.additionalProperties).toBe(false);
    },
  );
});

describe('service-raised error reasons', () => {
  /**
   * Raised by `openfda-service.ts`, by the shared guards in `schema-utils.ts`
   * (`resolvePageSize` included), `search-expression.ts`, and
   * `pagination-cursor.ts` (`resolveCursor`), or by the framework canvas layer
   * (`canvas.acquire()`), never by a handler's own `ctx.fail`.
   */
  const SERVICE_REASONS = new Set([
    'rate_limited',
    'upstream_error',
    'query_error',
    'not_aggregatable',
    'not_sortable',
    'pagination_limit_reached',
    'malformed_search',
    'limit_above_cap',
    'invalid_cursor',
    'canvas_not_found',
    'canvas_capacity_exhausted',
  ]);

  /**
   * `tool:reason` pairs whose handler catches the service throw and re-raises it
   * through its own `ctx.fail`, so the entry is correctly left unmarked.
   */
  const RERAISED_BY_HANDLER = new Set([
    'openfda_dataframe_query:canvas_not_found',
    'openfda_dataframe_drop:canvas_not_found',
  ]);

  const declared = allToolDefinitions.flatMap((definition: AnyToolDefinition) =>
    (definition.errors ?? [])
      .filter(
        (entry) =>
          SERVICE_REASONS.has(entry.reason) &&
          !RERAISED_BY_HANDLER.has(`${definition.name}:${entry.reason}`),
      )
      .map((entry) => [definition.name, entry.reason, entry] as const),
  );

  it.each(declared)('%s marks %s as thrownBy: service', (_name, _reason, entry) => {
    expect(entry.thrownBy).toBe('service');
  });

  it.each([...RERAISED_BY_HANDLER])('%s is declared and left unmarked', (pair) => {
    const [name, reason] = pair.split(':');
    const definitions: readonly AnyToolDefinition[] = allToolDefinitions;
    const entry = definitions
      .find((definition) => definition.name === name)
      ?.errors?.find((e) => e.reason === reason);

    expect(entry).toBeDefined();
    expect(entry?.thrownBy).toBeUndefined();
  });
});

/**
 * #113 — a sort key openFDA refuses is `not_sortable`, raised by the service
 * from openFDA's own refusal: declared from the one shared entry by every tool
 * taking `sort`, and carried to the wire with the field and the form to try.
 * The refusal shapes themselves are tabled at the service seam.
 */
describe('sort refusals (#113)', () => {
  const sortTools = allToolDefinitions.filter((definition) => 'sort' in definition.input.shape);

  it('finds the nine tools that take sort', () => {
    expect(sortTools.map((definition) => definition.name).sort()).toEqual([
      'openfda_get_drug_label',
      'openfda_lookup_ndc',
      'openfda_search_adverse_events',
      'openfda_search_animal_events',
      'openfda_search_device_clearances',
      'openfda_search_drug_approvals',
      'openfda_search_drug_shortages',
      'openfda_search_recalls',
      'openfda_search_tobacco_reports',
    ]);
  });

  it.each(sortTools.map((definition) => [definition.name, definition] as const))(
    '%s declares not_sortable from the shared entry',
    (_name, definition: AnyToolDefinition) => {
      expect(definition.errors?.find((entry) => entry.reason === 'not_sortable')).toEqual(
        notSortableError,
      );
    },
  );

  describe('at the tool boundary', () => {
    const http = createFetchMock();
    const CORRECTION =
      'Sort on "classification.exact" instead; a field that fails both ways cannot be sorted, so sort on another field.';
    /** openFDA's 5xx for analyzed text past the first sort key. */
    const ANALYZED_TEXT = () =>
      Response.json(
        {
          error: {
            code: 'SERVER_ERROR',
            message: 'Check your request and try again',
            details:
              '[illegal_argument_exception] Text fields are not optimised for operations that require per-document field data like aggregations and sorting, so these operations are disabled by default. Please use a keyword field instead. Alternatively, set fielddata=true on [classification] in order to load field data by uninverting the inverted index. Note that this can use significant memory.',
          },
        },
        { status: 500 },
      );
    type ErrorEnvelope = {
      error: { code: number; message: string; data?: Record<string, unknown> };
    };

    beforeAll(() => {
      initOpenFdaService();
    });

    beforeEach(() => {
      http.reset();
      http.install();
    });

    afterEach(() => {
      http.restore();
    });

    it('carries the reason, the field, and the correction on both surfaces', async () => {
      http.route({ match: () => true, respond: ANALYZED_TEXT });

      const result = await runToolContract(searchRecallsTool, {
        category: 'drug',
        sort: 'report_date:desc,classification:asc',
        limit: 1,
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'not_sortable',
        endpoint: 'drug/enforcement',
        field: 'classification',
        recovery: { hint: CORRECTION },
      });
      const text = textOfResult(result);
      expect(text).toContain('it is an analyzed text field');
      expect(text).toContain(CORRECTION);
      expect(text.split(CORRECTION)).toHaveLength(2); // stated once
      expect(text).toContain('reason not_sortable');
      expect(text).not.toMatch(/AND\/OR|quoted phrases|fielddata/);
      expect(http.calls).toHaveLength(1);
    });

    it('raises it from a 400 before any record is fetched', async () => {
      http.route({
        match: () => true,
        respond: () =>
          Response.json(
            {
              error: {
                code: 'BAD_REQUEST',
                message: 'Sorting allowed by non-analyzed fields only: brand_name',
              },
            },
            { status: 400 },
          ),
      });

      const result = await runToolContract(lookupNdcTool, {
        search: 'brand_name:"aspirin"',
        sort: 'brand_name:asc',
        limit: 1,
      });

      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.data).toMatchObject({
        reason: 'not_sortable',
        endpoint: 'drug/ndc',
        field: 'brand_name',
      });
      expect(textOfResult(result)).toContain('Sort on "brand_name.exact" instead');
    });

    it('raises the same reason on a staged call', async () => {
      const canvas = {
        acquire: async () => ({
          canvasId: 'cv_sort_probe',
          isNew: true,
          registerTable: () => {
            throw new Error('The probe page fails first; nothing is staged.');
          },
        }),
      };
      setCanvas(canvas as unknown as DataCanvas);
      try {
        http.route({ match: () => true, respond: ANALYZED_TEXT });

        const result = await runToolContract(searchRecallsTool, {
          category: 'drug',
          sort: 'report_date:desc,classification:asc',
          limit: 1,
          stage: true,
        });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as ErrorEnvelope;
        expect(error.data).toMatchObject({
          reason: 'not_sortable',
          field: 'classification',
          recovery: { hint: CORRECTION },
        });
        expect(http.calls).toHaveLength(1);
      } finally {
        setCanvas(undefined);
      }
    });
  });
});

describe('reserved error key', () => {
  it.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
    '%s declares no output field named "error"',
    (_name, definition) => {
      expect(Object.keys(definition.output.shape)).not.toContain('error');
    },
  );

  it('rejects a definition whose output declares an "error" field', () => {
    expect(() =>
      tool('openfda_reserved_key_probe', {
        description: 'Probe definition asserting the reserved-key guard fires.',
        annotations: { readOnlyHint: true },
        input: z.object({ q: z.string().describe('Probe query') }),
        output: z.object({ error: z.string().describe('Reserved failure-envelope key') }),
        handler: () => Promise.resolve({ error: 'unreachable' }),
      }),
    ).toThrow(/reserved/i);
  });
});

describe('description size', () => {
  /** A description string repeated verbatim on two or more tools may run to this many bytes. */
  const SHARED_DESCRIPTION_MAX_BYTES = 300;

  /** A shared clause written around per-tool text may run to this many bytes. */
  const SHARED_CLAUSE_MAX_BYTES = 120;

  /**
   * Ceiling on the server-written description bytes across `allToolDefinitions`:
   * the measured total, rounded up to the next 1,000 bytes. A client loads every
   * one of these bytes before its first call, so raising it is a decision, made
   * here, not a side effect of a longer description.
   */
  const SERVER_DESCRIPTION_CEILING_BYTES = 68_000;

  const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

  /** Every string-valued `description` in a JSON Schema, at any depth. */
  function schemaDescriptions(node: unknown): string[] {
    if (Array.isArray(node)) return node.flatMap(schemaDescriptions);
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) =>
      key === 'description' && typeof value === 'string' ? [value] : schemaDescriptions(value),
    );
  }

  /**
   * The input and output JSON Schema descriptions `tools/list` advertises for a
   * definition, its `enrichment` block included. The framework's `error`
   * envelope is not part of either schema, so it is excepted by construction.
   */
  function advertisedDescriptions(definition: AnyToolDefinition): string[] {
    const success = definition.enrichment
      ? definition.output.extend(definition.enrichment)
      : definition.output;
    return [
      ...schemaDescriptions(
        z.toJSONSchema(definition.input, { io: 'input', unrepresentable: 'any' }),
      ),
      ...schemaDescriptions(z.toJSONSchema(success, { io: 'output', unrepresentable: 'any' })),
    ];
  }

  it(`repeats no description over ${SHARED_DESCRIPTION_MAX_BYTES} bytes verbatim on two or more tools`, () => {
    const toolsByText = new Map<string, Set<string>>();
    for (const definition of allToolDefinitions) {
      for (const text of advertisedDescriptions(definition)) {
        const tools = toolsByText.get(text) ?? new Set<string>();
        tools.add(definition.name);
        toolsByText.set(text, tools);
      }
    }
    const oversized = [...toolsByText]
      .filter(([text, tools]) => tools.size > 1 && utf8Bytes(text) > SHARED_DESCRIPTION_MAX_BYTES)
      .map(([text, tools]) => `${utf8Bytes(text)} B on ${tools.size} tools: ${text.slice(0, 100)}`);

    expect(oversized).toEqual([]);
  });

  it(`keeps each shared clause around per-tool text within ${SHARED_CLAUSE_MAX_BYTES} bytes`, () => {
    /** A per-tool slot: every builder below is called with it, and the text is cut at it. */
    const SLOT = '\u0000';
    /** The fixed text of a builder's output, one entry per sentence between its slots. */
    const clauses = (text: string) =>
      text
        .split(SLOT)
        .flatMap((piece) => piece.split(/(?<=\.) (?=[A-Z])/))
        .map((piece) => piece.trim())
        .filter((piece) => /[A-Za-z]/.test(piece));
    const shared = [
      SEARCH_SYNTAX_NOTE,
      STAGING_WORKFLOW,
      CURSOR_END_NOTICE_TOPIC,
      CONJOINED_ARRAY_NOTICE_TOPIC,
      LEFT_OUT_NOTICE_TOPIC,
      ...clauses(sortDescription({ example: SLOT, newest: SLOT })),
      ...clauses(fieldsDescription([SLOT], [SLOT])),
      ...clauses(searchNoticeField([SLOT]).description ?? ''),
      ...clauses(includeDescription([[SLOT, 'drug/event']])),
    ];
    const oversized = shared.filter((clause) => utf8Bytes(clause) > SHARED_CLAUSE_MAX_BYTES);

    expect(shared.length).toBeGreaterThan(5);
    expect(oversized).toEqual([]);
  });

  it(`keeps server-written description bytes within ${SERVER_DESCRIPTION_CEILING_BYTES}`, () => {
    const total = allToolDefinitions.reduce(
      (sum, definition: AnyToolDefinition) =>
        sum +
        utf8Bytes(definition.description) +
        advertisedDescriptions(definition).reduce((n, text) => n + utf8Bytes(text), 0) +
        (definition.errors ?? []).reduce((n, entry) => n + utf8Bytes(entry.when), 0),
      0,
    );

    expect(total).toBeLessThanOrEqual(SERVER_DESCRIPTION_CEILING_BYTES);
  });
});

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
 *
 * Asserted against the definitions as `tool()` returns them — the same objects
 * the server registers — not against the schema literals in their source.
 * @module tests/mcp-server/tools/definitions/wire-contract.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

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

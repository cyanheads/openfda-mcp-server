/**
 * @fileoverview The tool registry (`allToolDefinitions`) as the cross-tool suites'
 * guard tests read it: which tools take an input, and the values each selector
 * input accepts. A guard asserts its suite's hand-written table against these, so
 * a tool that gains an input, or a selector that gains a value, fails the suite
 * until the table has its row.
 * @module tests/helpers/tool-registry
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** The inputs that pick the endpoint a search tool reads. */
const SELECTORS = ['category', 'endpoint', 'dataset', 'pathway'] as const;

/** A tool's input as `tools/list` advertises it, so `.default()` keys read as optional. */
function advertisedInput(definition: AnyToolDefinition) {
  return z.toJSONSchema(definition.input, { io: 'input' }) as {
    properties: Record<string, { enum?: unknown[] }>;
    required?: string[];
  };
}

/** Sorted names of the registered tools whose input takes `key`; with `optional`, only those where it may be omitted. */
export function toolsWithInput(key: string, { optional = false } = {}): string[] {
  return allToolDefinitions
    .filter(
      (definition) =>
        key in definition.input.shape &&
        !(optional && advertisedInput(definition).required?.includes(key)),
    )
    .map((definition) => definition.name)
    .sort();
}

/** Every `[selector, value]` pair the named tool's input accepts. Throws for a name the registry lacks. */
function selectorValues(toolName: string): (readonly [string, string])[] {
  const definition = allToolDefinitions.find((d) => d.name === toolName);
  if (!definition) throw new Error(`No registered tool is named ${toolName}`);
  const { properties } = advertisedInput(definition);
  return SELECTORS.flatMap((key) =>
    (properties[key]?.enum ?? []).map((value) => [key, String(value)] as const),
  );
}

/**
 * The `<tool> <key>=<value>` selector values that no row of a suite's table
 * selects, over the tools taking `inputKey`. Empty when every value has a row.
 * Rows are the table's `[tool, input, ...]` tuples; the input is parsed so a
 * selector left to its default counts as selected.
 */
export function missingSelectorRows(
  inputKey: string,
  tableRows: ReadonlyArray<readonly [AnyToolDefinition, unknown, ...unknown[]]>,
): string[] {
  const rows = tableRows.map(
    ([tool, input]) => [tool.name, tool.input.parse(input) as Record<string, unknown>] as const,
  );
  return toolsWithInput(inputKey).flatMap((name) =>
    selectorValues(name)
      .filter(
        ([key, value]) => !rows.some(([row, parsed]) => row === name && parsed[key] === value),
      )
      .map(([key, value]) => `${name} ${key}=${value}`),
  );
}

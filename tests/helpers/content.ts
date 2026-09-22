/**
 * @fileoverview Shared assertion helper for reading `format()` output in tests.
 * @module tests/helpers/content
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';

/** A single `content[]` block as a tool's `format()` returns it. */
type ContentBlock = ReturnType<NonNullable<AnyToolDefinition['format']>>[number];

/**
 * Returns the text of the content block at `index`, failing the test when the
 * block is missing or is not a text block.
 */
export function textOf(blocks: readonly ContentBlock[], index = 0): string {
  const block = blocks[index];
  if (block?.type !== 'text') {
    throw new Error(`Expected a text block at content[${index}], got ${block?.type ?? 'nothing'}`);
  }
  return block.text;
}

/**
 * @fileoverview Shared Zod building blocks for tool input schemas.
 * @module mcp-server/tools/schema-utils
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * A free-text input that must carry at least one non-whitespace character.
 * `minLength` alone lets `"   "` through: the URL builder drops a falsy
 * parameter and openFDA reads a whitespace-only one as match-all, so either way
 * a targeted lookup silently becomes an unfiltered browse over the whole corpus.
 * Both constraints are advertised in the tool's JSON Schema (`minLength` +
 * `pattern`), so a client sees the rule before it calls rather than only in the
 * rejection.
 *
 * Chain `.optional()` for an input where omission is a legitimate mode (an
 * unfiltered browse, an unsorted result, a fresh canvas). The wrapper leaves the
 * property out of `required` while keeping `minLength`/`pattern` on it, so an
 * absent value stays valid and a supplied blank one does not.
 */
export function nonBlankString() {
  return z.string().min(1).regex(/\S/, 'Must not be empty or whitespace-only.');
}

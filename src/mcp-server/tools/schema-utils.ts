/**
 * @fileoverview Shared Zod building blocks for tool input schemas, plus the
 * openFDA pagination ceiling and the handler guard that enforces it.
 * @module mcp-server/tools/schema-utils
 */

import { type TypedFail, type TypedRecoveryFor, z } from '@cyanheads/mcp-ts-core';

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

/**
 * openFDA's hard pagination ceiling — `skip` may not exceed this.
 *
 * Deliberately **not** a schema `.max()`. A schema maximum makes an over-ceiling
 * request fail as a generic input-validation error, which carries no
 * `structuredContent.error.data.reason` and none of the declared
 * `pagination_limit_reached` recovery text — the contract every paginated tool
 * advertises would then be unreachable. Handlers compare against this constant
 * and raise the typed reason instead, so both response paths carry it.
 */
export const OPENFDA_MAX_SKIP = 25_000;

/** Shared `skip` description — states the ceiling the handlers enforce. */
export const SKIP_DESCRIPTION = `Number of records to skip for pagination (default 0). openFDA caps pagination at ${OPENFDA_MAX_SKIP} records; a higher value returns a pagination_limit_reached error.`;

/**
 * The slice of a handler's `ctx` this guard needs. Structural, so any tool whose
 * contract declares `pagination_limit_reached` satisfies it — a `fail` accepting
 * the tool's wider reason union is assignable to one accepting just this reason.
 */
type PaginationCeilingContext = {
  fail: TypedFail<'pagination_limit_reached'>;
  recoveryFor: TypedRecoveryFor<'pagination_limit_reached'>;
};

/**
 * Reject an over-ceiling `skip` with the declared typed reason, before any
 * upstream request is spent on a page openFDA would refuse. Called first in
 * every paginated handler; see `OPENFDA_MAX_SKIP` for why the bound is not a
 * schema `.max()`.
 */
export function assertSkipWithinCeiling(skip: number, ctx: PaginationCeilingContext): void {
  if (skip > OPENFDA_MAX_SKIP) {
    throw ctx.fail(
      'pagination_limit_reached',
      `skip=${skip} exceeds openFDA's ${OPENFDA_MAX_SKIP}-record pagination ceiling.`,
      { ...ctx.recoveryFor('pagination_limit_reached') },
    );
  }
}

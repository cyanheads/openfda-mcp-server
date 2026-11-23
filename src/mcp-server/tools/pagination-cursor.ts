/**
 * @fileoverview The caller-facing continuation of a paged search past openFDA's
 * `skip` ceiling: the `cursor` input and `next_cursor` output field, the opaque
 * token between them, its `invalid_cursor` contract entry, and the steps a
 * handler calls around its request — {@link resolveCursor} before it,
 * {@link nextCursorField} and {@link cursorEndNotice} after it.
 *
 * The token wraps openFDA's own `search_after` value. The server never returns
 * or fetches the `Link` URL it came from: the service rebuilds every request
 * from the caller's validated inputs, so a token can position a walk and
 * nothing else.
 * @module mcp-server/tools/pagination-cursor
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { type TypedFail, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { OpenFdaQueryParams, OpenFdaResponse } from '@/services/openfda/types.js';

/**
 * What a cursor is bound to: the endpoint, `search`, and `sort` exactly as the
 * call sends them to the service — after the schema's normalization and any
 * default sort the tool applies. Build it once per call and pass the same
 * object to {@link resolveCursor}, {@link nextCursorField}, and the request.
 */
export interface CursorQuery {
  endpoint: string;
  search?: string | undefined;
  sort?: string | undefined;
}

/** Where a cursor walk resumes: openFDA's `search_after` value and the records already returned. */
type SearchAfter = NonNullable<OpenFdaQueryParams['searchAfter']>;

/**
 * The `cursor` input. The base64url `pattern` rides the advertised JSON Schema,
 * so an empty value fails argument validation: openFDA reads an empty
 * `search_after` as a request for the first page and would silently restart
 * the walk. `SKIP_DESCRIPTION` in `schema-utils.ts` names the cursor as the
 * route past the `skip` ceiling; a cursor sent with `skip`, `stage`, or
 * `canvas_id` is rejected as {@link invalidCursorError}.
 */
export const cursorInput = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be a next_cursor value exactly as a previous page returned it.')
  .optional()
  .describe(
    'next_cursor from the previous page, with no skip and the same search, sort, and endpoint as that call; other inputs may change.',
  );

/** The `next_cursor` output field, spread into a paged tool's `output` object. */
export const cursorOutputShape = {
  next_cursor: z
    .string()
    .optional()
    .describe(
      'Pass as cursor for the next page; present on a page read at skip 0 or by cursor when more records follow.',
    ),
};

/**
 * The `errors[]` entry for a `cursor` the call cannot use. Raised by
 * {@link resolveCursor} through the handler's typed `ctx.fail`, below the
 * handler body, hence `thrownBy: 'service'` (lint-only: the conformance scan
 * reads the handler body alone).
 */
export const invalidCursorError = {
  reason: 'invalid_cursor',
  code: JsonRpcErrorCode.ValidationError,
  when: 'cursor does not decode, belongs to another endpoint, search, or sort, or comes with skip above 0, stage, or canvas_id.',
  recovery:
    'Pass next_cursor exactly as returned, with the search, sort, and endpoint of the call that returned it and without skip, stage, or canvas_id, or start over from skip 0.',
  thrownBy: 'service',
} as const;

/** The slice of a handler's `ctx` {@link resolveCursor} needs. */
type InvalidCursorContext = {
  fail: TypedFail<'invalid_cursor'>;
};

/** The inputs a paged tool's call carries that decide whether its `cursor` can be used. */
interface CursorCallInput {
  canvas_id?: string | undefined;
  cursor?: string | undefined;
  skip: number;
  stage?: boolean | undefined;
}

/** Base64url characters of the query hash a token carries. */
const QUERY_HASH_LENGTH = 11;

/**
 * The decoded token: `p`, the walk position (records the walk returned before
 * the page it resumes at); `a`, openFDA's `search_after` value, verbatim; `q`,
 * the {@link queryHash} of the query that issued it. Strict, and parsed with
 * this schema itself: a derived or `.omit()`-ed copy loses the strictness, and
 * a forged token's unknown keys (`__proto__`, `constructor`) would be stripped
 * and accepted.
 */
const CursorTokenSchema = z.strictObject({
  p: z.int().min(1),
  a: z.string().min(1),
  q: z.string().length(QUERY_HASH_LENGTH),
});

type CursorToken = z.infer<typeof CursorTokenSchema>;

/**
 * Binds a token to its query. openFDA answers a `search_after` value taken from
 * another endpoint, another search, or the opposite sort direction with 200 and
 * silently repositioned records, so a token presented with a different query
 * must fail before the request. A guard against honest misuse, not a secret, so
 * it carries no key: a caller who edits a token changes only its own walk. An
 * edited `a` repositions it within the same query, which `skip` already allows;
 * an edited `p` moves no record and misstates the position the page reports
 * (`meta.skip`, the end-of-walk notice).
 */
function queryHash(query: CursorQuery): string {
  return createHash('sha256')
    .update(JSON.stringify([query.endpoint, query.search ?? null, query.sort ?? null]))
    .digest('base64url')
    .slice(0, QUERY_HASH_LENGTH);
}

function encodeToken(token: CursorToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

const UNDECODABLE = 'cursor does not decode as a next_cursor this server issued.';
const FOREIGN_QUERY =
  'cursor was issued for a different endpoint, search, or sort than this call sends.';

/**
 * Resolve the call's `cursor` to the `searchAfter` request parameter, or
 * `undefined` when the call carries none. Throws `invalid_cursor` before any
 * upstream request when the cursor comes with `skip > 0`, `stage`, or
 * `canvas_id`, does not decode, or was issued for another endpoint, `search`,
 * or `sort` — the message names which.
 */
export function resolveCursor(
  input: CursorCallInput,
  query: CursorQuery,
  ctx: InvalidCursorContext,
): SearchAfter | undefined {
  const { cursor } = input;
  if (cursor === undefined) return;

  const conflicts = [
    input.skip > 0 ? `skip=${input.skip}` : undefined,
    input.stage ? 'stage=true' : undefined,
    input.canvas_id !== undefined ? 'canvas_id' : undefined,
  ].filter((conflict) => conflict !== undefined);
  if (conflicts.length > 0) {
    throw ctx.fail(
      'invalid_cursor',
      `cursor cannot be combined with ${conflicts.join(' or ')}: a cursor page is read inline, from the position the cursor carries.`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (cause) {
    throw ctx.fail('invalid_cursor', UNDECODABLE, undefined, { cause });
  }
  const token = CursorTokenSchema.safeParse(decoded);
  if (!token.success) throw ctx.fail('invalid_cursor', UNDECODABLE);
  if (token.data.q !== queryHash(query)) throw ctx.fail('invalid_cursor', FOREIGN_QUERY);
  return { position: token.data.p, value: token.data.a };
}

/**
 * The `next_cursor` field for an unstaged page, to spread into the tool's
 * result: present when openFDA linked a `search_after` page and records remain
 * past this one, empty otherwise. openFDA links only a page read at `skip: 0`
 * or by `search_after`, and links an exactly full last page to a 404, which the
 * remaining-records check suppresses. The position advances by the records
 * this page holds, never by the requested `limit`, so a clamped or short page
 * skips nothing. Never call it on a staged result.
 */
export function nextCursorField(
  response: Pick<OpenFdaResponse, 'meta' | 'nextSearchAfter' | 'results'>,
  query: CursorQuery,
): { next_cursor?: string } {
  const position = response.meta.skip + response.results.length;
  if (!response.nextSearchAfter || position >= response.meta.total) return {};
  return {
    next_cursor: encodeToken({ p: position, a: response.nextSearchAfter, q: queryHash(query) }),
  };
}

/**
 * The notice for a page read by cursor that holds the last matched record, or
 * `undefined` for any other page. A clamped page already says so through
 * `pageSizeNotice`, so send this one only when that returns nothing.
 */
export function cursorEndNotice(
  page: { meta: { skip: number; total: number }; results: readonly unknown[] },
  searchAfter: SearchAfter | undefined,
): string | undefined {
  const returned = page.results.length;
  if (!searchAfter || returned === 0 || page.meta.skip + returned < page.meta.total) return;
  return `This page holds the last ${returned} of the ${page.meta.total} matched records, so the cursor walk is complete.`;
}

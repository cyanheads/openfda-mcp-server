# Agent Protocol

**Server:** openfda-mcp-server
**Version:** 0.1.20
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.21`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

> **Design doc:** `docs/design.md` is the source of truth for the tool surface, error handling, config, and implementation notes. Read it before adding or modifying tools.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const countTool = tool('openfda_count', {
  description: 'Aggregate and tally unique values for any field across any openFDA endpoint.',
  annotations: { readOnlyHint: true },
  input: z.object({
    endpoint: z.enum(['drug/event', 'drug/label', /* ... */]).describe('openFDA endpoint path'),
    count: z.string().describe('Field to count. Append .exact for whole-phrase counting'),
    search: z.string().optional().describe('Filter query to scope the count'),
    limit: z.number().min(1).max(1000).default(100).optional().describe('Top terms to return'),
  }),
  output: z.object({
    meta: z.object({ lastUpdated: z.string().describe('Dataset last updated date') }),
    results: z.array(z.object({
      term: z.string().describe('Field value'),
      count: z.number().describe('Number of occurrences'),
    })).describe('Term-count pairs sorted by count descending'),
  }),

  async handler(input, ctx) {
    const svc = getOpenFdaService();
    const response = await svc.query(input.endpoint, { search: input.search, count: input.count, limit: input.limit }, ctx);
    ctx.log.info('Count query completed', { endpoint: input.endpoint, terms: response.results.length });
    return { meta: { lastUpdated: response.meta.lastUpdated }, results: response.results.map(r => ({ term: String(r.term), count: r.count as number })) };
  },

  // format() populates content[] — the only field most LLM clients forward to
  // the model. Render all data the LLM needs, not just a count or title.
  format: (result) => [{
    type: 'text',
    text: result.results.map((r, i) => `${i + 1}. ${r.term}: ${r.count}`).join('\n'),
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
const ServerConfigSchema = z.object({
  apiKey: z.string().optional().describe('openFDA API key — increases daily limit from 1K to 120K requests'),
  baseUrl: z.string().default('https://api.fda.gov').describe('openFDA base URL'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    apiKey: process.env.OPENFDA_API_KEY,
    baseUrl: process.env.OPENFDA_BASE_URL,
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. Used by the openFDA service for request timeouts and retry abort. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. Passed to the service layer for retry context. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |
| `ctx.fail` | Typed error builder when an `errors[]` contract is declared. `ctx.fail('reason', msg?, data?)` builds an `McpError` keyed against the contract's reasons. |
| `ctx.recoveryFor` | Typed resolver returning `{ recovery: { hint } }` for a declared reason; spread into `data` to carry the contract recovery onto the wire. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` to receive a typed `ctx.fail(reason, ...)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the `recovery` field (≥ 5 words, lint-validated) is the single source of truth for the recovery hint. Spread `ctx.recoveryFor('reason')` into `data` to carry the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text). Override with explicit `{ recovery: { hint: '...' } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring. Used in `search-recalls.tool.ts` for the recall+non-device validation.

```ts
errors: [
  { reason: 'recall_endpoint_non_device', code: JsonRpcErrorCode.ValidationError,
    when: 'The recall endpoint was requested for a non-device category.',
    recovery: 'Set endpoint=enforcement for drug and food categories; recall is device-only.' },
],
async handler(input, ctx) {
  if (input.endpoint === 'recall' && input.category !== 'device') {
    throw ctx.fail('recall_endpoint_non_device', undefined, { ...ctx.recoveryFor('recall_endpoint_non_device') });
  }
}
```

**Service-layer throws carry `data: { reason }`.** The conformance lint scans handler source only — failures thrown from `openfda-service.ts` aren't visible to it. To make service throws carry the same wire-shape `error.data.reason` clients see from `ctx.fail`, the service passes `data: { reason: 'X' }` to the factory (used in `openfda-service.ts` for `rate_limited`, `upstream_error`, `pagination_limit_reached`, `query_error`).

**Fallback (no contract entry fits, ad-hoc throws):**

```ts
// Error factories — explicit code, concise
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    openfda/
      openfda-service.ts                # openFDA API client (retry, rate-limit, error normalization)
      types.ts                          # Query params and response types
  mcp-server/
    tools/definitions/
      count.tool.ts                     # openfda_count
      get-drug-label.tool.ts            # openfda_get_drug_label
      lookup-ndc.tool.ts                # openfda_lookup_ndc
      search-adverse-events.tool.ts     # openfda_search_adverse_events
      search-device-clearances.tool.ts  # openfda_search_device_clearances
      search-drug-approvals.tool.ts     # openfda_search_drug_approvals
      search-recalls.tool.ts            # openfda_search_recalls
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-recalls.tool.ts` |
| Tool/resource/prompt names | snake_case | `openfda_search_recalls` |
| Directories | kebab-case | `src/services/openfda/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search enforcement reports and recall actions.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `release-and-publish` | Post-wrapup ship workflow: verification gate, push, publish to npm/MCP Registry/GHCR |
| `security-pass` | 8-axis MCP server audit (injection surfaces, scope blast radius, input sinks, tenant isolation, telemetry leakage, resource bounds) |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns, typed contracts |
| `api-linter` | Definition lint rule reference (`format-parity`, `describe-on-fields`, `schema-*`, etc.) — consult when devcheck reports a lint diagnostic |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |
| `api-mirror` | MirrorService: persistent, self-refreshing local mirror of a bulk upstream dataset (embedded SQLite + FTS5) |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests (Vitest) |
| `bun run list-skills` | List available skills |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create a GitHub Release from the latest annotated tag |
| `bun run start:stdio` | Production mode (stdio, after build) |
| `bun run start:http` | Production mode (HTTP, after build) |

Smoke-test path is `bun run rebuild && bun run start:stdio` (or `start:http`) — run against the built tree to match production.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.signal` for cancellation
- [ ] Handlers throw on failure — typed `errors[]` + `ctx.fail` when domain failures fit, factories or plain `Error` otherwise. No try/catch.
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (`structuredContent` vs `content[]`); both must carry the same data
- [ ] Raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] Normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] Tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
- [ ] Smoke-test: `bun run rebuild && bun run start:stdio` (or `start:http`)

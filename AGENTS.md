# Agent Protocol

**Server:** openfda-mcp-server
**Version:** 0.7.6
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0 (via the framework)
**Zod:** ^4.6.5

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
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

export const countValuesTool = tool('openfda_count_values', {
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
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. Replaced `ctx.elicit` in 0.12.0. |
| `ctx.inputs` | Reader over a re-entered request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped`. Empty on the first round. |
| `ctx.enrich` | Success-path agent context — `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only where the definition declares an `enrichment` block. |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. Used by the openFDA service for request timeouts and retry abort. |
| `ctx.requestId` | Unique request ID. Passed to the service layer for retry context. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |
| `ctx.fail` | Typed error builder when an `errors[]` contract is declared. `ctx.fail('reason', msg?, data?)` builds an `McpError` keyed against the contract's reasons. |
| `ctx.recoveryFor` | Typed resolver returning `{ recovery: { hint } }` for a declared reason; spread into `data` to carry the contract recovery onto the wire. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` to receive a typed `ctx.fail(reason, ...)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the `recovery` field (≥ 5 words, lint-validated) is the single source of truth for the recovery hint. Spread `ctx.recoveryFor('reason')` into `data` to carry the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text unless the message already contains it verbatim). Override with explicit `{ recovery: { hint: '...' } }` when runtime context matters. Forwarding is lint-enforced per throw site (`error-contract-recovery-unforwarded`). Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring. Used in `search-recalls.tool.ts` for the recall+non-device validation.

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

**Service-layer throws carry `data: { reason }`, and their contract entries carry `thrownBy: 'service'`.** The conformance lint scans handler source only — failures thrown from `openfda-service.ts` aren't visible to it. To make service throws carry the same wire-shape `error.data.reason` clients see from `ctx.fail`, the service passes `data: { reason: 'X' }` to the factory (used in `openfda-service.ts` for `rate_limited`, `upstream_error`, `pagination_limit_reached`, `query_error`, `not_aggregatable`). Every reason produced below the handler — by the service, by the shared guards in `schema-utils.ts` (`malformed_search`, `pagination_limit_reached`), or by the canvas layer (`canvas_not_found` on `openfda_dataframe_describe`) — is marked `thrownBy: 'service'` on every tool that declares it, so `error-contract-unthrown` keeps checking only the handler's own reasons. The marker is lint-only metadata; nothing at runtime reads it.

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
    canvas/
      canvas-accessor.ts                # Optional DataCanvas handle (CANVAS_PROVIDER_TYPE=duckdb)
    openfda/
      openfda-service.ts                # openFDA API client (retry, rate-limit, error normalization) + mirror routing
      canvas-spill.ts                   # stage=true / canvas_id staging onto DataCanvas
      page-budget.ts                    # Serialized-byte budget for inline search pages
      types.ts                          # Query params and response types
      mirror/                           # Opt-in local bulk mirror (OPENFDA_MIRROR_ENABLED, off by default)
        datasets.ts                     # Closed dataset registry + GMDN carve-out
        bulk-stream.ts                  # Streaming ZIP + JSON reader for a dump partition
        harvester.ts                    # sync generator (full-refresh model, tombstones)
        mirror-registry.ts              # One defineMirror instance per dataset
        query.ts                        # Mirror-vs-live gate; exact-key lookups only
        refresh-schedule.ts             # schedulerService wiring (HTTP transport)
        index.ts                        # Barrel
  mcp-server/
    tools/
      field-catalog.ts                  # Searchable field paths per endpoint
      format-utils.ts                   # Shared format() helpers
      schema-utils.ts                   # Shared input schemas + handler guards (skip ceiling, search delimiters)
    tools/definitions/
      count-values.tool.ts              # openfda_count_values
      dataframe-describe.tool.ts        # openfda_dataframe_describe
      dataframe-query.tool.ts           # openfda_dataframe_query
      describe-fields.tool.ts           # openfda_describe_fields
      drug-profile.tool.ts              # openfda_drug_profile
      get-drug-label.tool.ts            # openfda_get_drug_label
      lookup-ndc.tool.ts                # openfda_lookup_ndc
      search-adverse-events.tool.ts     # openfda_search_adverse_events
      search-animal-events.tool.ts      # openfda_search_animal_events
      search-device-clearances.tool.ts  # openfda_search_device_clearances
      search-drug-approvals.tool.ts     # openfda_search_drug_approvals
      search-drug-shortages.tool.ts     # openfda_search_drug_shortages
      search-recalls.tool.ts            # openfda_search_recalls
      search-tobacco-reports.tool.ts    # openfda_search_tobacco_reports
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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run list-skills` | List available skills |
| `bun run mirror:init \| refresh \| verify \| status [dataset...]` | Bulk-mirror lifecycle (`scripts/openfda-mirror.ts`). Init runs out-of-band, never at startup. |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create a GitHub Release from the latest annotated tag |
| `bun run start:stdio` | Production mode (stdio, after build) |
| `bun run start:http` | Production mode (HTTP, after build) |

Smoke-test path is `bun run rebuild && bun run start:stdio` (or `start:http`) — run against the built tree to match production.

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

`scripts/` carries no local overrides — every framework-shipped script is a verbatim copy, resynced by the `maintenance` skill's Phase C. `openfda-mirror.ts` and `split-changelog.ts` are the project's own and are never touched by that sync.

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

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, pushed plainly — nothing already pushed is ever rewritten, so `main` keeps the record of what the review corrected — PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

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

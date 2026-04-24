# Changelog

## [0.1.10] - 2026-04-24

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.5.3` to `^0.7.0` — picks up the HTML landing page + SEP-1649 Server Card at `/`, directory-based changelog scaffolding, `HtmlExtractor` Tier 3 utility, `MCP_PUBLIC_URL` for TLS-terminating proxies, per-request `McpServer` factory hardening, flat ZodError messages with structured `issues` on `McpError.data`, and the locale-aware `format-parity` linter pass
- `openfda_count` — added `.describe()` on `output.results[]` array element to satisfy the recursive `describe-on-fields` lint rule introduced in `mcp-ts-core` 0.6.16
- `.github/ISSUE_TEMPLATE/` — bug_report and feature_request descriptions now reference the scoped package name `@cyanheads/openfda-mcp-server`
- `@biomejs/biome` `^2.4.12` → `^2.4.13`; `vitest` + `@vitest/coverage-istanbul` `^4.1.4` → `^4.1.5`

### Synced

- 13 framework skills updated and 3 new skills added (`api-linter`, `release-and-publish`, `security-pass`); copies in `skills/` and `.claude/skills/` refreshed
- 3 new framework scripts copied into `scripts/` (`build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts`) and `scripts/devcheck.ts` / `scripts/tree.ts` resynced from package — `bun run devcheck` now runs Docs Sync + Skills Sync steps
- `CLAUDE.md` skills table — added entries for `api-linter`, `release-and-publish`, and `security-pass`

## [0.1.9] - 2026-04-20

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.12` to `^0.5.3` — picks up MCP Apps builders, prompt OTel instrumentation, new testing helpers, `parseEnvConfig`, framework-level ZodError conversion, and the new `format-parity` lint rule
- All 7 tool `format()` functions reworked to satisfy the new `format-parity` lint rule — every field declared in `output` schema now appears in rendered `content[]` text so `structuredContent`-only and `content[]`-only clients see the same data
  - Headers now include all four meta fields (`total`, `returned`, `skip`, `limit`) and the word "results" for consistent naming
  - `message` field is rendered after results when present (previously only on empty)
  - Removed `toLocaleString()` from numeric fields so values match raw schema sentinels
- `src/config/server-config.ts` — adopted `parseEnvConfig` from `@cyanheads/mcp-ts-core/config` for env-var-aware error messages instead of raw `ServerConfigSchema.parse(process.env)`

### Removed

- All entries from `package.json` `overrides` block (`@hono/node-server`, `brace-expansion`, `express-rate-limit`, `hono`, `path-to-regexp`, `picomatch`, `vite`, `yaml`) — every previously vulnerable transitive dep has been patched upstream; `bun audit` now reports zero vulnerabilities without any manual pins

### Synced

- 14 framework skills updated to latest versions and 1 new skill added (`add-app-tool`); copies in `skills/` and `.claude/skills/` refreshed

## [0.1.8] - 2026-04-04

### Added

- Shared `format-utils.ts` module — `truncate`, `humanizeField`, and `formatRemainingFields` helpers used by all tool format functions

### Changed

- All tool `format()` functions now render every field present in API responses instead of hardcoded subsets — LLMs see complete data without hidden fields
- `openfda_get_drug_label` format dynamically iterates all label sections and openfda metadata instead of a fixed list of 8 sections
- `openfda_search_adverse_events` format expanded: drug entries now include indication and route; remaining patient and top-level fields rendered automatically
- `openfda_search_device_clearances` format renders remaining fields for both 510(k) and PMA records
- `openfda_search_drug_approvals` format renders remaining openfda metadata and top-level fields
- `openfda_search_recalls` and `openfda_lookup_ndc` format render remaining fields per record
- Standardized `sort` parameter descriptions across all 6 searchable tools — consistent phrasing with note that unrecognized fields are silently ignored
- Moved `truncate()` from `search-recalls.tool.ts` to shared `format-utils.ts`

## [0.1.7] - 2026-04-04

### Added

- Public hosted server notice and config example in README (`https://openfda.caseyjhand.com/mcp`)

### Changed

- Upgraded TypeScript dev dependency from `^5.9.3` to `^6.0.2`

## [0.1.6] - 2026-04-03

### Changed

- Refined package and server description — removed "MCP server for" prefix, added "STDIO or Streamable HTTP" transport context across `package.json`, `server.json`, and `README.md`

## [0.1.5] - 2026-04-03

### Fixed

- Removed redundant `.optional()` from all fields with `.default()` values across all 7 tool definitions — fields with defaults are never undefined, so the combination was semantically incorrect and could produce unexpected schema behavior

### Changed

- Added `@vitest/coverage-istanbul` to `devcheck.config.json` allowed dependencies

## [0.1.4] - 2026-04-03

### Changed

- README — added bunx, npx, and Docker configuration examples; expanded configuration table with all framework env vars; added Bun badge; reformatted tool table; general polish
- `package.json` — normalized scripts to use `bun run` prefix; added author, funding, and security overrides; added `@vitest/coverage-istanbul` dev dependency; fixed homepage URL
- `server.json` — removed `packageArguments` from both transports (simplifies bunx/npx invocation); added `MCP_TRANSPORT_TYPE` env var to HTTP transport config

## [0.1.3] - 2026-04-03

### Added

- Apache-2.0 LICENSE file
- `bunfig.toml` for Bun runtime configuration
- `docs/tree.md` directory structure documentation
- OCI image description and source labels to Dockerfile
- `OPENFDA_API_KEY` environment variable to both transport configs in `server.json`
- `mcpName`, `homepage`, `bugs`, `author`, `packageManager` fields to `package.json`
- Expanded keywords in `package.json` (openfda, fda, drug-safety, adverse-events, typescript)
- Bun engine requirement (`>=1.2.0`) to `package.json`

### Changed

- README.md — complete rewrite with detailed per-tool descriptions, getting started guide, configuration table, Docker instructions, and project structure overview
- CLAUDE.md — updated agent protocol with server-specific code examples, structure, naming conventions, and commands; removed unused generic ctx properties (`ctx.state`, `ctx.elicit`, `ctx.sample`)
- `server.json` name updated to `io.github.cyanheads/openfda-mcp-server` format
- `server.json` runtimeHint changed from `node` to `bun`
- `package.json` repository URL updated to `git+` format

## [0.1.2] - 2026-04-03

### Added

- Boxed warning section in `openfda_get_drug_label` format output
- Product details (ingredients, dosage form, route, marketing status) in `openfda_search_drug_approvals` format output
- `decision_description` display in `openfda_search_device_clearances` format output

### Changed

- Made `search` parameter optional in `openfda_search_device_clearances` and `openfda_search_drug_approvals` — omit to browse recent entries
- Improved `limit` and `skip` field descriptions with explicit ranges and defaults in `openfda_search_adverse_events`
- Total record counts now use locale-formatted numbers in `openfda_search_recalls`
- Concise server description in `server.json` and `package.json`
- Sorted imports alphabetically across all test files

### Fixed

- Removed unused `getOpenFdaService` import from service test

## [0.1.1] - 2026-04-03

### Changed

- Removed URL-encoded syntax (`+AND+`, `+OR+`, `+`) from tool descriptions and error messages — the service layer handles encoding, so user-facing text now shows plain `AND`/`OR`/spaces
- Improved empty-result messages for `openfda_get_drug_label` and `openfda_search_recalls` — now echo the search query and suggest common field names
- PMA result headings in `openfda_search_device_clearances` now include trade/generic name when available

## [0.1.0] - 2026-04-03

Initial release.

### Added

- **openFDA service layer** — generic API client with retry (exponential backoff), rate-limit awareness, and error normalization for all openFDA endpoints
- **Server config** — lazy-parsed Zod schema for `OPENFDA_API_KEY` (optional, increases daily limit from 1K to 120K) and `OPENFDA_BASE_URL`
- **7 MCP tools:**
  - `openfda_search_adverse_events` — search adverse event reports across drugs, food, and devices
  - `openfda_search_recalls` — search enforcement reports and recall actions
  - `openfda_count` — aggregate and tally unique values for any field across any endpoint
  - `openfda_get_drug_label` — look up FDA drug labeling (package inserts / SPL documents)
  - `openfda_search_drug_approvals` — search Drugs@FDA for NDA/ANDA approvals
  - `openfda_search_device_clearances` — search 510(k) clearances and PMA approvals
  - `openfda_lookup_ndc` — look up drugs in the NDC Directory
- `.env.example` with server-specific environment variables
- Design doc at `docs/design.md` with full tool surface, error design, and implementation notes

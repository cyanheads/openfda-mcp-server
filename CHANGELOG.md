# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-08 · ⚠️ Breaking

Breaking: openfda_count renamed to openfda_count_values; openfda_drug_profile surfaces meta.fanOutKey for identifier reconciliation

## [0.1.20](changelog/0.1.x/0.1.20.md) — 2026-06-05

New composite tool openfda_drug_profile: single-call consolidated FDA drug profile resolving identity once and fanning out across label, adverse events, recalls, approvals, and shortage

## [0.1.19](changelog/0.1.x/0.1.19.md) — 2026-06-04

Two new tools: openfda_search_drug_shortages (drug/shortages endpoint) and openfda_describe_fields (field path discovery); reactive field hints on empty results across all 9 search tools

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21; per-request log context, secret-stripping, retryable flag; skills sync; release:github script

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-05-30

Animal/veterinary adverse events and tobacco product reports; typed errors[] contracts with recovery hints on all tools; 401/403 mapped to Unauthorized/Forbidden in service layer

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-05-30

Enrichment adoption across all 7 tools — query echoes, result totals, and empty-result guidance now surface in a typed enrichment block reaching both structuredContent and content[]

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.6 → ^0.9.13: HTTP body cap, session-init gate, quieter client-error logging, landing page keywords; placeholder preprocess for API key; manifest default

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-05-23

Upgrade @cyanheads/mcp-ts-core ^0.9.1 → ^0.9.6; add zod ^4.4.3 runtime dep; add publish-mcp script; scaffold manifest.json + .mcpbignore for MCPB bundle support; add install badges to README.

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-05-16

Upgrade @cyanheads/mcp-ts-core ^0.8.19 → ^0.9.1; adopt the new createApp({ instructions }) field to forward server-level orientation to the model on initialize; raise changelog summary cap 250 → 350 chars; fix bun outdated parser in devcheck.

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-05-08

Disambiguate empty-result responses (no-match vs paginated-past-end); cache last_updated per endpoint for 404 fallback; richer field rendering and tool-description polish across the surface.

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-05-08

Upgrade mcp-ts-core ^0.7.0 → ^0.8.19 — adopt typed error contract in search-recalls; bump engines to Node ≥24 / Bun ≥1.3.

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-04-24

Upgrade mcp-ts-core 0.5.3 → 0.7.0 — HTML landing page, Server Card, directory-based changelog, locale-aware format-parity linter.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-04-20

Upgrade mcp-ts-core ^0.2.12 → ^0.5.3; rework all 7 format() functions for the new format-parity lint rule; adopt parseEnvConfig.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-04-04

Shared format-utils module (truncate, humanizeField, formatRemainingFields); all tool format() functions now render every API response field instead of hardcoded subsets.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-04-04

Add public hosted server notice in README (https://openfda.caseyjhand.com/mcp); bump TypeScript dev dep ^5.9.3 → ^6.0.2.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-04-03

Refined package and server descriptions — name plus transport context (STDIO or Streamable HTTP) across package.json, server.json, README.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-04-03

Drop redundant .optional() on fields with .default() across all 7 tool definitions.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-04-03

README expansion (bunx/npx/Docker examples, full env-var table); package.json metadata polish; simplified server.json.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-04-03

Repo polish — Apache-2.0 LICENSE, bunfig.toml, docs/tree.md, OCI Dockerfile labels, bun engine pin, README rewrite.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-04-03

Boxed warning rendering in drug labels; richer product detail in drug approvals; decision_description in device clearances.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-04-03

Drop URL-encoded operators from descriptions; better empty-result messages; trade/generic names in PMA headings.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-04-03

Initial release: 7-tool surface for openFDA — adverse events, drug labels, drug approvals, NDC lookup, device clearances, recalls, count aggregation.

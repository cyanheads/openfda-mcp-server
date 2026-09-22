<div align="center">
  <h1>@cyanheads/openfda-mcp-server</h1>
  <p><b>Query FDA data on drugs, food, devices, and recalls via openFDA. STDIO or Streamable HTTP.</b>
  <div>14 Tools</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server) [![Version](https://img.shields.io/badge/Version-0.7.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfda-mcp-server/releases/latest/download/openfda-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfda-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZkYS1tY3Atc2VydmVyIl0sImVudiI6eyJPUEVORkRBX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfda-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/openfda-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENFDA_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openfda.caseyjhand.com/mcp](https://openfda.caseyjhand.com/mcp)

</div>

---

## Overview

FDA data on drugs, food, devices, and recalls from the openFDA public API. Search adverse events, recalls, drug approvals, and device clearances; look up NDC codes and drug labels; aggregate field counts across any endpoint. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openfda_drug_profile` | One drug name → consolidated FDA profile: identity, label, adverse events, recalls, approval, shortage |
| `openfda_search_adverse_events` | Search adverse event reports across drugs, food, and devices |
| `openfda_search_animal_events` | Search adverse event reports for veterinary drugs and devices |
| `openfda_search_drug_shortages` | Search FDA drug shortage records — status, availability, therapeutic category, manufacturer |
| `openfda_search_tobacco_reports` | Search problem reports for tobacco products, e-cigarettes, and vaping devices |
| `openfda_search_recalls` | Search enforcement reports and recall actions across drugs, food, and devices |
| `openfda_count_values` | Aggregate and tally unique values for any field across any openFDA endpoint |
| `openfda_describe_fields` | Return searchable field paths for an openFDA endpoint, grouped by category |
| `openfda_get_drug_label` | Look up FDA drug labeling (package inserts / SPL documents) |
| `openfda_search_drug_approvals` | Search the Drugs@FDA database for NDA/ANDA application approvals |
| `openfda_search_device_clearances` | Search FDA device premarket notifications — 510(k) clearances and PMA approvals |
| `openfda_lookup_ndc` | Look up drugs in the NDC (National Drug Code) Directory |
| `openfda_dataframe_query` | Run read-only SQL over a result set staged on a DataCanvas (opt-in) |
| `openfda_dataframe_describe` | List tables and column schemas staged on a DataCanvas (opt-in) |

## Capability reference

### `openfda_drug_profile` <sub>tool</sub>

- Resolves a brand or generic drug name to canonical FDA identifiers (generic name, NDC, RxCUI, SPL set ID) once, then keys every sub-query off that identity — avoids the identifier drift that breaks naive tool chaining
- Fans out in parallel across `drug/label`, `drug/event`, `drug/enforcement`, `drug/drugsfda`, and `drug/shortages`; each section (`label`, `adverse_events`, `recalls`, `approval`, `shortage`) is best-effort and returns `null` on a miss rather than failing the call
- A single-drug query resolves only to a single-ingredient product, never a combination
- `degraded[]` names any section whose sub-query failed upstream (rate limit, 5xx, query error) — a section listed there is unknown, not confirmed absent
- Auth, configuration, and cancellation failures abort the whole call rather than degrading silently
- Accepts `drug_name` or `name` in place of `drug`

---

### `openfda_search_adverse_events` <sub>tool</sub>

- `category` selects `drug`, `food`, or `device` — each returns a different field schema
- `limit` up to 1000 and `skip` up to openFDA's 25000-record ceiling (past it: typed `pagination_limit_reached`); the page is also bounded by a shared ~24 KB serialized-byte budget — `drug/event` reports run tens of KB each against a few hundred bytes for `food/event`, so an oversized page returns fewer records than requested and reports the cut via `page_omitted`
- Sortable date field is category-specific (`receivedate` for drug, `date_created` for food, `date_received` for device) — a field from another category causes a query error
- Optional `stage: true` (or `canvas_id`) drains the matched set onto a DataCanvas table for SQL via `openfda_dataframe_query`

---

### `openfda_search_animal_events` <sub>tool</sub>

- Covers FDA Center for Veterinary Medicine reports — animal species/breed/age/weight, drug, VeDDRA reaction terms, outcome
- `limit` up to 1000, bounded by the shared ~24 KB page-byte budget (`page_omitted` reports any cut); `skip` capped at 25000
- Optional `stage: true` (or `canvas_id`) stages the matched set for SQL via `openfda_dataframe_query`
- Filter examples: `animal.species`, `drug.brand_name`, `reaction.veddra_term_name`, `serious_ae`

---

### `openfda_search_drug_shortages` <sub>tool</sub>

- Filter by `status` (`Current`/`Resolved`), `therapeutic_category`, `generic_name`, or `company_name`
- Each record's `openfda` block carries `brand_name`, `product_ndc`, and `rxcui` for chaining into `openfda_get_drug_label` or `openfda_lookup_ndc`
- `limit` up to 1000, bounded by the shared ~24 KB page-byte budget; `skip` capped at 25000
- Optional `stage: true` (or `canvas_id`) for DataCanvas SQL via `openfda_dataframe_query`

---

### `openfda_search_tobacco_reports` <sub>tool</sub>

- Filter by `tobacco_products`, `reported_health_problems`, `reported_product_problems`, or `nonuser_affected`
- Each report carries `number_tobacco_products` / `number_health_problems` / `number_product_problems` counts alongside the arrays
- `limit` up to 1000, bounded by the shared ~24 KB page-byte budget; `skip` capped at 25000
- Optional `stage: true` (or `canvas_id`) for DataCanvas SQL via `openfda_dataframe_query`

---

### `openfda_search_recalls` <sub>tool</sub>

- `category` (`drug`/`food`/`device`) plus `endpoint` — `enforcement` covers all categories, `recall` is device-only and rejects a non-device category as a typed `recall_endpoint_non_device` error
- Filter by `classification` (Class I/II/III), `recalling_firm`, `reason_for_recall`, `status`
- `limit` up to 1000, bounded by the shared ~24 KB page-byte budget — a device record runs several KB against roughly one for drug/food
- Optional `stage: true` (or `canvas_id`) for DataCanvas SQL via `openfda_dataframe_query`

---

### `openfda_count_values` <sub>tool</sub>

- Works across all 20 openFDA endpoints (drug, food, device, animal/veterinary, tobacco, other) — the same set `openfda_describe_fields` covers
- `count` takes a dotted field path; append `.exact` for whole-phrase counting on analyzed text fields — identifier fields already indexed as keywords (`product_ndc`, `application_number`, `pma_number`) reject `.exact` as `not_aggregatable`
- Optional `search` scopes the aggregation; returns up to 1000 top terms ranked by count descending
- Pairs with the search/label/recall tools when sample records help interpret an aggregate
- Runs against the live API even when the local bulk mirror is enabled — a partial mirror can't produce complete aggregates

---

### `openfda_describe_fields` <sub>tool</sub>

- Covers all 20 cataloged openFDA endpoints — the same set `openfda_count_values` accepts
- Returns field paths grouped by category, each with type and a one-line description, plus `queryTips` covering quoting, AND/OR, `.exact`, and date-range syntax
- Call before constructing a `search` query — field paths differ per endpoint and aren't derivable from a tool's own schema

---

### `openfda_get_drug_label` <sub>tool</sub>

- `search` targets label fields (`openfda.brand_name`, `openfda.generic_name`, `openfda.manufacturer_name`, or `set_id` for a specific SPL revision); default `limit` 5, up to 1000
- A page over the ~24 KB inline budget returns `kind: "outline"` — section names and their serialized size, largest first — instead of label text; re-call with `sections: [...]` for the ones needed
- Outline sizes are summed across the whole page, so cost scales with `limit`; a `sections` selection is always returned whole even when it overflows the budget, with its size disclosed
- `sections` narrows each record to the requested keys plus identity metadata (`openfda`, `set_id`, `id`, `effective_time`, `version`)
- `skip` capped at openFDA's 25000-record pagination ceiling

---

### `openfda_search_drug_approvals` <sub>tool</sub>

- Filter by brand/generic name (`openfda.brand_name`), `sponsor_name` (stored uppercase — a lowercase quoted value matches nothing), or `submissions.submission_type` / `submissions.review_priority`
- Each record carries the application's full submission history, so `limit` up to 1000 is bounded by the shared ~24 KB page-byte budget — a long-running application is an order of magnitude larger than a recent one
- `page_omitted` reports any cut with the routes to the rest; `skip` capped at 25000
- Optional `stage: true` (or `canvas_id`) for DataCanvas SQL via `openfda_dataframe_query`

---

### `openfda_search_device_clearances` <sub>tool</sub>

- `pathway` selects `510k` (174K+ records, most common) or `pma` (higher-risk devices) — one pathway per call
- Filter by `applicant`, `product_code`, `advisory_committee_description`, or `openfda.device_name`
- `limit` up to 1000, bounded by the shared ~24 KB page-byte budget — a 510(k) record carries a summary narrative and runs several times the size of a PMA record
- Optional `stage: true` (or `canvas_id`) for DataCanvas SQL via `openfda_dataframe_query`

---

### `openfda_lookup_ndc` <sub>tool</sub>

- Search by `product_ndc`, `brand_name`, `generic_name`, `openfda.manufacturer_name`, or `active_ingredients.name`
- Pair with `openfda_get_drug_label` via the returned `brand_name` or `set_id` to read the package insert
- `limit` up to 1000, bounded by the shared ~24 KB page-byte budget — a product with many packaging configurations is several times the size of one with a single package
- Optional `stage: true` (or `canvas_id`) for DataCanvas SQL via `openfda_dataframe_query`; `skip` capped at 25000

---

### `openfda_dataframe_query` <sub>tool</sub>

- Runs a single read-only `SELECT` against a table staged by a search tool's `stage: true` — DDL, DML, COPY, and file-reading functions are rejected
- Scalar fields are stored as text (`CAST` for numeric math); nested openFDA objects/arrays are JSON columns, queryable with DuckDB JSON functions
- Results are capped at the canvas row limit; `truncated: true` means page the rest with `ORDER BY` plus `LIMIT`/`OFFSET`
- Requires `CANVAS_PROVIDER_TYPE=duckdb` and the optional `@duckdb/node-api` dependency — errors `canvas_disabled` otherwise

---

### `openfda_dataframe_describe` <sub>tool</sub>

- Lists every table on a canvas by `canvas_id` — name, kind (table/view), full staged row count (not the inline preview count), and column name/DuckDB-type/nullable for each
- Nested openFDA objects/arrays are stored as JSON columns — query them with DuckDB JSON functions
- Call before `openfda_dataframe_query` to get exact table and column names
- Errors `canvas_disabled` when `CANVAS_PROVIDER_TYPE` is unset, `canvas_not_found` when the `canvas_id` has expired or never existed

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

openFDA-specific:

- Generic API client for all 20 openFDA endpoints with retry (exponential backoff) and rate-limit awareness
- Automatic error normalization — 404 returns empty results, 429/5xx retries, 400 surfaces an actionable message
- Optional API key — works without one (1K requests/day), increases to 120K/day with a free key
- Optional DataCanvas staging (`CANVAS_PROVIDER_TYPE=duckdb`, per call with `stage: true`) — stage large result sets as DuckDB tables, list their columns with `openfda_dataframe_describe`, and run SQL via `openfda_dataframe_query`
- Optional local bulk mirror (`OPENFDA_MIRROR_ENABLED=true`) — a self-refreshing SQLite copy of four drug datasets that answers exact-key lookups without spending API budget, with live fallback

Agent-friendly output:

- Byte-budget disclosure — oversized pages are bounded by a shared ~24 KB serialized budget and disclosed via `page_omitted`/`page_bytes` on both `content[]` and `structuredContent`, never silently truncated and never emptied to zero records
- Typed failure contracts — `errors[]` declarations key `ctx.fail` by reason (`rate_limited`, `query_error`, `pagination_limit_reached`, `canvas_disabled`, ...) so callers can branch on `error.data.reason` instead of parsing messages
- Best-effort degradation — `openfda_drug_profile` returns `null` per section on a miss rather than failing the whole call, and names which sections failed upstream (vs. genuinely absent) in `degraded[]`
- Empty-result guidance — a no-match search returns a notice pointing at `openfda_describe_fields` and broader query terms rather than a bare empty array

## Getting started

### Public Hosted Instance

A public instance is available at `https://openfda.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openfda-mcp-server": {
      "type": "streamable-http",
      "url": "https://openfda.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "openfda-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openfda-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OPENFDA_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openfda-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openfda-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OPENFDA_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openfda-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/openfda-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher.
- Optional: [openFDA API key](https://open.fda.gov/apis/authentication/) for higher rate limits (120K requests/day vs 1K/day).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openfda-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openfda-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto`. No tool asks the caller for input mid-call, so no session store is needed. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OPENFDA_API_KEY` | Free API key from [open.fda.gov](https://open.fda.gov/apis/authentication/). Increases daily limit from 1K to 120K requests. | none |
| `OPENFDA_BASE_URL` | Base URL override for testing against a proxy or mock. | `https://api.fda.gov` |
| `OPENFDA_MIRROR_ENABLED` | Answer exact-key lookups from a local copy of the openFDA bulk downloads instead of the API. See [Local bulk mirror](#local-bulk-mirror). | `false` |
| `OPENFDA_MIRROR_PATH` | Directory holding one SQLite file per mirrored dataset. | `./data/openfda-mirror` |
| `OPENFDA_MIRROR_REFRESH_CRON` | Cron expression for the in-process mirror refresh (HTTP transport only). Unset means no scheduled refresh. | none |
| `OPENFDA_MIRROR_FALLBACK_LIVE` | Fall back to the live API when the mirror is cold, missing the record, or failing. | `true` |
| `OPENFDA_MIRROR_REFRESH_TIMEOUT_MS` | Wall-clock budget for one refresh before it is aborted. | `21600000` (6h) |
| `OPENFDA_MIRROR_BASE_URL` | Host serving the bulk download manifest (`download.json`). | `https://api.fda.gov` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas staging — analytical SQL over result sets staged with `stage: true` and queried via `openfda_dataframe_query`. Requires the optional `@duckdb/node-api` dependency. | `none` (disabled) |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Local bulk mirror

openFDA publishes whole-dataset JSON dumps alongside the API. With `OPENFDA_MIRROR_ENABLED=true` the server keeps a local SQLite copy of four of them — `drug/label`, `drug/ndc`, `drug/enforcement`, `drug/drugsfda` — and answers eligible lookups from it, leaving the API budget for everything else.

The mirror is deliberately narrow. openFDA's `search` runs server-side in Elasticsearch, which tokenises and ranks; a local corpus cannot reproduce that. A query is answered locally only when all of the following hold, and is sent to the API otherwise:

- the search is a single quoted `field:"value"` term — no boolean operators, wildcards, or ranges;
- the field is one of `id`, `set_id`, `product_id`, `product_ndc`, `recall_number`, `event_id`, `application_number`, and the value is a whole identifier in its canonical spelling and case;
- there is no `count` and no `sort`, and `skip` is 0;
- the value matches exactly one record.

The last condition is what keeps a mirrored answer identical to the API's rather than merely equivalent. Four of the seven lookup fields are primary keys and always match one record. The other three — `set_id`, `product_ndc`, `event_id` — can address several, and openFDA returns those in relevance order, which a local corpus cannot recompute; such a lookup routes to the API whatever the requested page size.

`openfda_count_values` therefore always runs against the API — a partial mirror would return plausible but incomplete aggregates.

The initial harvest runs out-of-band, never at startup:

```sh
bun run mirror:init                  # all four datasets
bun run mirror:init drug/enforcement # one dataset (~3.8 MB compressed)
bun run mirror:status                # sync state per dataset
bun run mirror:verify                # integrity check + row counts
bun run mirror:refresh               # re-harvest datasets whose dump has advanced
```

openFDA publishes no incremental API for these endpoints, so a refresh re-reads the whole dump and tombstones records the new export no longer carries. It is idempotent and resumable — re-running after an interrupt continues from the persisted cursor. Set `OPENFDA_MIRROR_REFRESH_CRON` to run it in-process on the HTTP transport; on stdio, run `bun run mirror:refresh` from the host.

`meta.lastUpdated` on a mirrored response reports the `last_updated` stamp of the dump being served, which can differ from the live API's — the API index and the published dumps advance on separate schedules.

On Node, install the optional `better-sqlite3` peer dependency; Bun uses its built-in `bun:sqlite`. `OPENFDA_MIRROR_REFRESH_CRON` additionally needs the optional `node-cron` peer dependency — without it the server refuses to start rather than run with a schedule it cannot honour.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t openfda-mcp-server .
docker run --rm -p 3010:3010 openfda-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openfda-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Mount a volume over `/usr/src/app/data/openfda-mirror` to persist an `OPENFDA_MIRROR_ENABLED=true` harvest across container replacement.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | Entry point — `createApp()` with tool registration and service setup. |
| `src/config/` | Server-specific env var parsing and validation with Zod. |
| `src/services/openfda/` | openFDA API client with retry, rate-limit handling, and error normalization. |
| `src/services/openfda/mirror/` | Opt-in local bulk mirror — dataset registry, dump reader, sync ingester, and the query gate that decides mirror vs live. |
| `src/services/canvas/` | DataCanvas accessor — resolves the active canvas provider for staging and SQL. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Fourteen openFDA tools. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Validate raw upstream data → normalize to the output schema → never fabricate a field openFDA didn't return

## Data attribution

Data is served from [openFDA](https://open.fda.gov), a U.S. Food and Drug Administration service. Under the [openFDA license](https://open.fda.gov/license/) the data is dedicated to the public domain under CC0 1.0, with one exception: GMDN® device-classification content — Term Code, Term Name, and Term Definition — is licensed from The GMDN Agency, and redistributing it or using it to train AI requires a separate licence from the Agency.

The local mirror therefore covers drug datasets only. `device/classification` and every other device endpoint are excluded from it, and the ingester rejects any record carrying a GMDN-bearing field rather than writing it to disk. Extending the mirror to device data requires clearing that licence first.

FDA does not endorse this project. Do not rely on openFDA to make decisions regarding medical care.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

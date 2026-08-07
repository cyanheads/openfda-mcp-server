<div align="center">
  <h1>@cyanheads/openfda-mcp-server</h1>
  <p><b>Query FDA data on drugs, food, devices, and recalls via openFDA. STDIO or Streamable HTTP.</b>
  <div>14 Tools</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server) [![Version](https://img.shields.io/badge/Version-0.7.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfda-mcp-server/releases/latest/download/openfda-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfda-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZkYS1tY3Atc2VydmVyIl0sImVudiI6eyJPUEVORkRBX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfda-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/openfda-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENFDA_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openfda.caseyjhand.com/mcp](https://openfda.caseyjhand.com/mcp)

</div>

---

## Tools

Fourteen tools for querying FDA data across drugs, food, devices, animal/veterinary products, and recalls — plus an optional DataCanvas SQL surface for large result sets:

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

**The nine record-returning tools bound their page at ~24 KB.** openFDA record size is not something a caller can see in advance — a `drug/event` report averages ~34 KB against ~440 bytes for a `food/event` report, so `limit: 10` means very different things per endpoint. The eight multi-row search tools return as many records of the requested window as fit, then report the withheld count on `page_omitted` alongside the byte figure and the routes to the rest (the exact `skip` to continue from, a lower `limit`, `stage: true` for SQL, or `openfda_count_values` for a distribution). Whenever anything matched, at least one record comes back, whatever it measures. `openfda_get_drug_label` returns a section outline instead, since its payload is one document rather than many rows.

### `openfda_drug_profile`

Resolve one drug name to its FDA identity, then return a consolidated profile in a single call — replacing four or five chained lookups.

- Resolves a brand or generic name to canonical FDA identifiers once (generic name, NDC, RxCUI, SPL set ID), then keys every sub-query off that identity to avoid the identifier drift that breaks naive tool chaining
- Single-ingredient resolution: a single-drug query won't resolve to a combination product
- Sections: label highlights, adverse-event summary (top reactions, serious count), recall history, Drugs@FDA approval, and current shortage status
- Best-effort — a miss on any section returns `null` rather than failing the whole call; use the dedicated tool for a deep dive into any area

---

### `openfda_search_adverse_events`

Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics.

- Category selection: `drug`, `food`, or `device` — each returns different field schemas
- Elasticsearch query syntax for filtering by product, reaction, seriousness, date range
- Pagination via `limit` (up to 1000) and `skip` (openFDA's ceiling is 25000 — past it the call returns a typed `pagination_limit_reached` error with recovery guidance)
- `drug/event` is the largest-record endpoint openFDA serves, so this is where the ~24 KB page budget bites hardest: a default `limit: 10` on drug reports typically returns one to three of them with the rest disclosed on `page_omitted`, where the same call on food reports returns all ten
- Formatted output includes report ID, seriousness, patient demographics, reactions, drugs with characterization/indication/route, and all remaining fields

---

### `openfda_count_values`

Aggregate and tally unique values for any field across any openFDA endpoint. Returns ranked term-count pairs sorted by count descending.

- Works across all 20 openFDA endpoints (drugs, food, devices, animal/veterinary, tobacco, other)
- Use `.exact` suffix on field names for whole-phrase counting
- Optional `search` filter to scope the aggregation
- Returns up to 1000 terms per query

---

### `openfda_search_recalls`

Search enforcement reports and recall actions across drugs, food, and devices.

- Supports `enforcement` (all categories) and `recall` (devices only) endpoints
- Filter by classification (Class I/II/III), recalling firm, reason, status
- Formatted output includes recall number, classification, product description, reason, distribution pattern

---

### `openfda_search_device_clearances`

Search FDA device premarket notifications — 510(k) clearances and PMA approvals.

- Two pathways: `510k` (174K+ records, most common) and `pma` (higher-risk devices)
- Filter by applicant, product code, advisory committee, device name
- Formatted output adapts to pathway: 510(k) shows K-number/clearance type, PMA shows supplement info

---

### `openfda_get_drug_label`

Look up FDA drug labeling (package inserts / SPL documents). Check indications, warnings, dosage, contraindications, active ingredients, or any structured label section.

- Search by brand name, generic name, manufacturer, or set ID
- Formatted output dynamically renders all label sections and openfda metadata present in the record, in full — `content[]` and `structuredContent` carry the same text
- A page over the ~24 KB inline budget returns `kind: "outline"` — the section names and their sizes — instead of the label text; re-call with `sections: [...]` for the ones you need
- Outline sizes are summed across the page, so a section's cost scales with `limit` — the re-call guidance names a section measured to fit the budget at the requested limit and quotes its byte size
- `sections` narrows each record to the requested keys plus metadata (`openfda`, `set_id`, `id`, `effective_time`, `version`); a selection over the budget is returned whole, never trimmed, with its serialized size reported
- Default limit of 5 — labels are large documents (a warfarin label is ~130 KB on its own)

---

### `openfda_search_drug_approvals`

Search the Drugs@FDA database for drug application approvals (NDAs and ANDAs). Returns application details, sponsor info, and full submission history.

- Filter by brand name, sponsor, submission type, review priority
- Formatted output includes products with active ingredients, dosage forms, routes, and marketing status
- Full submission history with type, status, date, and review priority
- Pagination via `limit` (up to 1000) and `skip` (openFDA's ceiling is 25000 — past it the call returns a typed `pagination_limit_reached` error with recovery guidance)

---

### `openfda_lookup_ndc`

Look up drugs in the NDC (National Drug Code) Directory. Identify drug products by NDC code, find active ingredients, packaging details, or manufacturer info.

- Search by product NDC, brand name, generic name, manufacturer, or active ingredient
- Returns product details, active ingredients with strengths, and packaging information
- Sortable by listing expiration date or other fields

---

### `openfda_search_animal_events`

Search adverse event reports for veterinary drugs and devices submitted to the FDA Center for Veterinary Medicine (1.3M+ records).

- Filter by animal species, breed, drug name, VeDDRA reaction term, or seriousness
- Records include animal details (species, gender, age, weight), administered drugs, reactions, and outcomes
- Formatted output surfaces key clinical fields; remaining fields rendered via catch-all

---

### `openfda_search_tobacco_reports`

Search problem reports submitted to the FDA for tobacco products, including e-cigarettes, vaping products, cigarettes, and smokeless tobacco.

- Filter by product type, reported health problems (e.g. seizure, chest pain), product problems (e.g. battery explosion), or non-user involvement
- Formatted output surfaces products, health effects, product defects, and report counts

---

### `openfda_search_drug_shortages`

Search FDA drug shortage records (1,700+ entries, refreshed daily). Returns shortage status, availability notes, therapeutic category, dosage form, manufacturer, and timeline.

- Filter by status (`Current`, `Resolved`), therapeutic category, generic name, or manufacturer
- The `openfda` block carries `brand_name`, `product_ndc`, and `rxcui` for chaining into `openfda_get_drug_label` or `openfda_lookup_ndc`
- Pagination via `limit` (up to 1000) and `skip` (openFDA's ceiling is 25000 — past it the call returns a typed `pagination_limit_reached` error with recovery guidance)

---

### `openfda_describe_fields`

Return the searchable field paths for an openFDA endpoint, grouped by category with type and description. Use before constructing a search query to discover the correct dotted field paths.

- Covers all major endpoints: `drug/event`, `drug/label`, `drug/shortages`, `drug/drugsfda`, `drug/ndc`, `drug/enforcement`, `food/event`, `food/enforcement`, `device/event`, `device/510k`, `device/pma`, `device/recall`, `device/enforcement`, `animalandveterinary/event`, `tobacco/problem`
- Returns fields grouped by category (identifiers, dates, clinical fields, etc.) with data type and one-line description
- Complements the reactive field hints that appear in `notice` enrichment when a search returns empty

---

### `openfda_dataframe_query` · `openfda_dataframe_describe`

A DataCanvas SQL surface over staged result sets — **opt-in**, enabled with `CANVAS_PROVIDER_TYPE=duckdb` and requested per call with `stage: true`.

- Call a multi-row search tool with `stage: true` to drain its matched set into a DuckDB table alongside the normal page of results; the response adds `canvas_id`, `canvas_table`, and `staged_rows`. `openfda_dataframe_query` runs read-only `SELECT` (GROUP BY, SUM/COUNT, joins) across the staged rows; `openfda_dataframe_describe` lists the table and column schemas needed to write valid SQL.
- Staging is bounded by a byte budget and openFDA's 25,000-row ceiling, so a staged call stays quick even on large-record endpoints like `drug/event`. `staged_rows` against the match total says how much reached the table; `truncated` flags the cut and points at `openfda_count_values`, which aggregates over the whole matched set server-side rather than over the staged slice.
- Scalar fields are stored as text (`CAST` for numeric math); nested openFDA blocks (`openfda`, `patient`, `products`, …) are JSON columns. Pass a `canvas_id` back into a search tool to accumulate result sets on one canvas for cross-table joins.
- Off by default at both levels — without `CANVAS_PROVIDER_TYPE=duckdb` and an explicit staging request, a search costs one upstream request and the two dataframe tools report that canvas is disabled. Requires the optional `@duckdb/node-api` dependency; unsupported on Cloudflare Workers.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

openFDA-specific:

- Generic API client for all openFDA endpoints with retry (exponential backoff) and rate-limit awareness
- Automatic error normalization — 404 returns empty results, 429/5xx retries, 400 provides actionable messages
- A ~24 KB serialized budget on every page of upstream records, measured rather than assumed — oversized pages are bounded and disclosed on both `content[]` and `structuredContent`, never silently truncated and never emptied
- Optional API key support — works without a key (1K requests/day), increases to 120K/day with a free key
- Optional DataCanvas staging (`CANVAS_PROVIDER_TYPE=duckdb`, per call with `stage: true`) — stage large result sets as DuckDB tables and run SQL via `openfda_dataframe_query`
- Optional local bulk mirror (`OPENFDA_MIRROR_ENABLED=true`) — a self-refreshing SQLite copy of the four drug bulk downloads that answers exact-key lookups without spending API budget, with live fallback

## Getting Started

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

### Via bunx (no install)

Add to your MCP client config:

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
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas staging — analytical SQL over result sets staged with `stage: true` and queried via `openfda_dataframe_query`. Requires the optional `@duckdb/node-api` dependency; unsupported on Cloudflare Workers. | `none` (disabled) |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

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

On Node, install the optional `better-sqlite3` peer dependency; Bun uses its built-in `bun:sqlite`. `OPENFDA_MIRROR_REFRESH_CRON` additionally needs the optional `node-cron` peer dependency — without it the server refuses to start rather than run with a schedule it cannot honour. The mirror is unavailable on Cloudflare Workers (no SQLite, no persistent filesystem) and stays off there.

## Running the Server

### Local Development

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

## Project Structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | Entry point — `createApp()` with tool registration and service setup. |
| `src/config/` | Server-specific env var parsing and validation with Zod. |
| `src/services/openfda/` | openFDA API client with retry, rate-limit handling, and error normalization. |
| `src/services/openfda/mirror/` | Opt-in local bulk mirror — dataset registry, dump reader, sync ingester, and the query gate that decides mirror vs live. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Fourteen openFDA tools. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools in `src/mcp-server/tools/definitions/index.ts`

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## Data attribution

Data is served from [openFDA](https://open.fda.gov), a U.S. Food and Drug Administration service. Under the [openFDA license](https://open.fda.gov/license/) the data is dedicated to the public domain under CC0 1.0, with one exception: GMDN® device-classification content — Term Code, Term Name, and Term Definition — is licensed from The GMDN Agency, and redistributing it or using it to train AI requires a separate licence from the Agency.

The local mirror therefore covers drug datasets only. `device/classification` and every other device endpoint are excluded from it, and the ingester rejects any record carrying a GMDN-bearing field rather than writing it to disk. Extending the mirror to device data requires clearing that licence first.

FDA does not endorse this project. Do not rely on openFDA to make decisions regarding medical care.

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

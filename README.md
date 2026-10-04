<div align="center">
  <h1>@cyanheads/openfda-mcp-server</h1>
  <p><b>Query FDA data on drugs, food, devices, and recalls via openFDA. STDIO or Streamable HTTP.</b>
  <div>14 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.9-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfda-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfda-mcp-server/releases/latest/download/openfda-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfda-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZkYS1tY3Atc2VydmVyIl0sImVudiI6eyJPUEVORkRBX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfda-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenfda-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENFDA_API_KEY%22%3A%22your-api-key%22%7D%7D)

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
| `openfda_search_drug_shortages` | Search FDA drug shortage records by status, availability, therapeutic category, manufacturer |
| `openfda_search_tobacco_reports` | Search problem reports for tobacco products, e-cigarettes, and vaping devices |
| `openfda_search_recalls` | Search enforcement reports and recall actions across drugs, food, and devices |
| `openfda_count_values` | Aggregate and tally unique values for any field across any openFDA endpoint |
| `openfda_describe_fields` | Return searchable field paths for an openFDA endpoint, grouped by category |
| `openfda_get_drug_label` | Look up FDA drug labeling (package inserts / SPL documents) |
| `openfda_search_drug_approvals` | Search the Drugs@FDA database for NDA/ANDA application approvals |
| `openfda_search_device_clearances` | Search FDA device premarket notifications: 510(k) clearances and PMA approvals |
| `openfda_lookup_ndc` | Look up drugs in the NDC (National Drug Code) Directory |
| `openfda_dataframe_describe` | List tables and column schemas staged on a DataCanvas (opt-in) |
| `openfda_dataframe_query` | Run read-only SQL over a result set staged on a DataCanvas (opt-in) |
| `openfda_dataframe_drop` | Delete one table staged on a DataCanvas (opt-in, off by default) |

## Capability reference

### `openfda_drug_profile` <sub>tool</sub>

- One `drug` name, brand or generic, resolved once to canonical identity (generic name, NDC, RxCUI, SPL set ID) that keys every sub-query; `meta.resolvedVia` (`label`, `ndc`, `none`) names the source, and a single-ingredient product is preferred over combinations
- Sections `label`, `adverse_events`, `recalls`, `approval`, and `shortage` are best-effort and come back `null` (or an empty `recalls`) on a miss; `degraded[]` names each section whose sub-query failed upstream, so a listed section is unknown rather than absent
- Auth, configuration, and cancellation failures fail the whole call instead of degrading a section

---

### `openfda_search_adverse_events` <sub>tool</sub>

- `category` (`drug`, `food`, `device`) selects the endpoint and its record schema; up to 1000 records per page
- Sortable date fields differ by category: `receivedate` (drug), `date_created` (food), `date_received` (device); another category's field fails as `query_error`

---

### `openfda_search_animal_events` <sub>tool</sub>

- Optional `search` over veterinary reports, e.g. `animal.species`, `drug.brand_name`, `reaction.veddra_term_name`, `serious_ae`; up to 1000 records per page
- Records carry animal species, breed, age, and weight, the drug and route, VeDDRA reaction terms, and outcome

---

### `openfda_search_drug_shortages` <sub>tool</sub>

- Optional `search` over `status` (`Current` / `Resolved`), `therapeutic_category`, `generic_name`, or `company_name`; up to 1000 records per page
- Each record's `openfda` block carries `brand_name`, `product_ndc`, and `rxcui` for chaining into `openfda_get_drug_label` or `openfda_lookup_ndc`

---

### `openfda_search_tobacco_reports` <sub>tool</sub>

- Optional `search` over `tobacco_products`, `reported_health_problems`, `reported_product_problems`, or `nonuser_affected`; up to 1000 records per page
- Reports carry the problem arrays plus `number_tobacco_products`, `number_health_problems`, and `number_product_problems` counts

---

### `openfda_search_recalls` <sub>tool</sub>

- `category` (`drug`, `food`, `device`) plus `endpoint`: `enforcement` (default, every category) or `recall` (devices only; other categories fail as `recall_endpoint_non_device`); up to 1000 records per page
- Enforcement records carry `recall_number`, `classification` (Class I/II/III), and `status`; device recall records carry `product_res_number` and `recall_status` instead, with no hazard classification

---

### `openfda_count_values` <sub>tool</sub>

- `endpoint` (any of the 20 openFDA endpoints), a `count` field expression, and an optional `search`; returns up to 1000 top terms (default 100), ranked by count
- `truncated` flags more distinct terms past `limit`, except at the 1000-term maximum, where a notice says completeness can't be known; an expression openFDA can't aggregate fails as `not_aggregatable` (take the `countAs` form from `openfda_describe_fields`)
- Always runs against the live API, even with the bulk mirror enabled

---

### `openfda_describe_fields` <sub>tool</sub>

- `endpoint`: the same 20 endpoints `openfda_count_values` accepts
- Field paths grouped by category, each with `type`, a description, and `countAs` (the verified count expression, or `null` when the field can't be aggregated), plus `queryTips` on quoting, AND/OR, `.exact`, and date ranges

---

### `openfda_get_drug_label` <sub>tool</sub>

- Required `search` on label fields (`openfda.brand_name`, `openfda.generic_name`, `openfda.manufacturer_name`, `set_id`); `limit` defaults to 5, max 1000
- A page over the 24,000-byte inline budget returns `kind: "outline"` (section names and sizes, largest first) instead of label text; re-call with `sections: [...]` to get those sections plus identity metadata (`openfda`, `set_id`, `id`, `effective_time`, `version`), returned whole even when over budget
- `*_table` sections render as Markdown tables in the text output; structured results keep the raw SPL markup

---

### `openfda_search_drug_approvals` <sub>tool</sub>

- Optional `search` over `openfda.brand_name`, `sponsor_name` (stored uppercase, so a lowercase quoted value matches nothing), `submissions.submission_type`, or `submissions.review_priority`; up to 1000 records per page
- Records carry `application_number`, `sponsor_name`, `products[]`, and the application's full `submissions[]` history

---

### `openfda_search_device_clearances` <sub>tool</sub>

- `pathway` (`510k` or `pma`, one per call) plus an optional `search` over `applicant`, `product_code`, `advisory_committee_description`, or `openfda.device_name`; up to 1000 records per page
- 510(k) records carry `k_number`, `device_name`, and `decision_date`; PMA records carry `pma_number`, `trade_name`, and `supplement_number`

---

### `openfda_lookup_ndc` <sub>tool</sub>

- Required `search` over `product_ndc`, `brand_name`, `generic_name`, `openfda.manufacturer_name`, or `active_ingredients.name`; up to 1000 records per page
- Records carry `product_ndc`, `labeler_name`, `dosage_form`, `route`, `marketing_category`, `active_ingredients[]`, and `packaging[]`

---

### `openfda_dataframe_describe` <sub>tool</sub>

- `canvas_id` from a staged search; lists each table's `name`, `kind`, full staged `row_count`, and columns with DuckDB type and nullability
- Fails as `canvas_disabled` when `CANVAS_PROVIDER_TYPE` is unset, or `canvas_not_found` when the `canvas_id` has expired or never existed

---

### `openfda_dataframe_query` <sub>tool</sub>

- `canvas_id` plus one read-only `SELECT`; DDL, DML, COPY, and file-reading functions are rejected. Scalars are stored as text (`CAST` for math) and nested openFDA blocks as JSON columns
- Rows are capped at the canvas row limit, and `truncated: true` means page on with `ORDER BY` plus `LIMIT`/`OFFSET`; failures are `canvas_disabled`, `canvas_not_found`, `missing_table`, or `invalid_query`

---

### `openfda_dataframe_drop` <sub>tool</sub>

- Off by default: set `OPENFDA_DATAFRAME_DROP_ENABLED=true` to make it callable; otherwise it is listed as disabled on the landing page and absent from `tools/list`
- `canvas_id` plus the `table` name from `openfda_dataframe_describe`; deletes that one table or view and returns `remaining_tables`, leaving the canvas and its other tables in place
- Failures are `canvas_disabled`, `canvas_not_found`, or `missing_table` (already dropped, expired, or mistyped)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

openFDA-specific:

- One client for all 20 openFDA endpoints: 429 and 5xx responses retry with exponential backoff, a 404 is an empty result, and a 400 becomes an actionable `query_error`. No API key is needed (1K requests/day); a free `OPENFDA_API_KEY` raises that to 120K/day
- Queries are `field:value` over dotted paths that differ per endpoint, joined by AND/OR, with phrases in double quotes; `openfda_describe_fields` lists the paths. A query with an unbalanced quote, parenthesis, or range bracket, or a trailing backslash, fails as `malformed_search` before any request
- Paging: `limit` up to 1000 and `skip` up to openFDA's 25,000-record ceiling (`pagination_limit_reached` past it). Search pages are also held to a 24,000-byte serialized budget, so an oversized page returns fewer records than requested, but never zero
- Optional DataCanvas staging (`CANVAS_PROVIDER_TYPE=duckdb`): `stage: true` or a `canvas_id` on any `openfda_search_*` tool or `openfda_lookup_ndc` drains the matched set into a DuckDB table, up to a size budget reported by `staged_rows` and `truncated`
- Optional local bulk mirror (`OPENFDA_MIRROR_ENABLED=true`): a self-refreshing SQLite copy of four drug datasets that answers exact-key lookups without spending API budget, with live fallback

Agent-friendly output:

- Disclosed bounds: `page_omitted` / `page_bytes`, the label `outline`, and `staged_rows` report every cut on both `content[]` and `structuredContent`, with the routes to the rest
- Typed failure contracts: callers branch on `error.data.reason` (`rate_limited`, `query_error`, `not_aggregatable`, `pagination_limit_reached`, `canvas_disabled`, ...) instead of parsing messages
- Unknown vs. absent: `openfda_drug_profile` returns `null` for a section with no FDA record and lists a section whose sub-query failed in `degraded[]`
- Empty-result guidance: a no-match search returns a notice pointing at `openfda_describe_fields` and broader terms; a page past the end reports the real match count

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

Add the following to your MCP client configuration file.

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: an [openFDA API key](https://open.fda.gov/apis/authentication/) raises the limit from 1K to 120K requests per day.

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

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set OPENFDA_API_KEY and the mirror or canvas options as needed
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `OPENFDA_API_KEY` | Free API key from [open.fda.gov](https://open.fda.gov/apis/authentication/); raises the daily limit from 1K to 120K requests. | none |
| `OPENFDA_BASE_URL` | API base URL override, for a proxy or mock. | `https://api.fda.gov` |
| `OPENFDA_MIRROR_ENABLED` | Answer exact-key lookups from the [local bulk mirror](#local-bulk-mirror). | `false` |
| `OPENFDA_MIRROR_PATH` | Directory holding one SQLite file per mirrored dataset. | `./data/openfda-mirror` |
| `OPENFDA_MIRROR_REFRESH_CRON` | Cron expression for the in-process mirror refresh (HTTP transport only). | none |
| `OPENFDA_MIRROR_FALLBACK_LIVE` | Fall back to the live API when the mirror is cold, missing the record, or failing. | `true` |
| `OPENFDA_MIRROR_REFRESH_TIMEOUT_MS` | Wall-clock budget for one refresh before it is aborted, in ms. | `21600000` (6h) |
| `OPENFDA_MIRROR_BASE_URL` | Host serving the bulk download manifest (`download.json`). | `https://api.fda.gov` |
| `CANVAS_PROVIDER_TYPE` | Set `duckdb` to enable DataCanvas staging and the `openfda_dataframe_*` tools. | `none` |
| `OPENFDA_DATAFRAME_DROP_ENABLED` | Enable `openfda_dataframe_drop`, which deletes a staged table. Needs `CANVAS_PROVIDER_TYPE=duckdb`. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Local bulk mirror

With `OPENFDA_MIRROR_ENABLED=true` the server keeps a local SQLite copy of four openFDA bulk dumps (`drug/label`, `drug/ndc`, `drug/enforcement`, `drug/drugsfda`) and answers eligible lookups from it. openFDA ranks results in Elasticsearch, which a local corpus can't reproduce, so a query is answered locally only when all of these hold, and goes to the API otherwise:

- the search is a single quoted `field:"value"` term on `id`, `set_id`, `product_id`, `product_ndc`, `recall_number`, `event_id`, or `application_number`, with a whole identifier in its canonical spelling and case
- there is no `count` and no `sort`, and `skip` is 0
- the value matches exactly one record, so the mirrored answer is the API's answer

The initial harvest runs out-of-band, never at startup:

```sh
bun run mirror:init                  # all four datasets
bun run mirror:init drug/enforcement # one dataset
bun run mirror:status                # sync state per dataset
bun run mirror:verify                # integrity check + row counts
bun run mirror:refresh               # re-harvest datasets whose dump has advanced
```

openFDA has no incremental feed for these datasets, so a refresh re-reads the whole dump, tombstones records the new export drops, and resumes where it stopped after an interruption. Set `OPENFDA_MIRROR_REFRESH_CRON` to run it in-process on the HTTP transport; on stdio, run `bun run mirror:refresh` from the host. A mirrored response's `meta.lastUpdated` is the served dump's stamp, which can differ from the live API's.

On Node, install the optional `better-sqlite3` peer dependency (Bun uses its built-in `bun:sqlite`). `OPENFDA_MIRROR_REFRESH_CRON` also needs the optional `node-cron` peer dependency; without it the server fails at startup.

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openfda-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them. To keep a mirror harvest across container replacement, mount a volume over `/usr/src/app/data/openfda-mirror`.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: tool registration, service setup, mirror refresh wiring. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), fourteen in all. |
| `src/mcp-server/tools` | Shared tool helpers: per-endpoint field catalog, input schemas and guards, formatters, SPL table rendering. |
| `src/services/openfda` | openFDA API client (retry, rate limits, error normalization), inline page budget, canvas staging. |
| `src/services/openfda/mirror` | Opt-in local bulk mirror: dataset registry, dump reader, harvester, mirror-vs-live query gate, refresh schedule. |
| `src/services/canvas` | DataCanvas accessor for staging and SQL. |
| `scripts/openfda-mirror.ts` | Mirror lifecycle CLI behind the `mirror:*` scripts. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools in the barrel at `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate a field openFDA didn't return

## Data attribution

Data comes from [openFDA](https://open.fda.gov), a U.S. Food and Drug Administration service. Under the [openFDA license](https://open.fda.gov/license/) the data is dedicated to the public domain under CC0 1.0, with one exception: GMDN® device-classification content (Term Code, Term Name, and Term Definition) is licensed from The GMDN Agency, and redistributing it or using it to train AI requires a separate licence from the Agency.

That is why the local mirror covers drug datasets only. `device/classification` and every other device endpoint are excluded from it, and the ingester rejects any record carrying a GMDN-bearing field rather than writing it to disk.

FDA does not endorse this project. Do not rely on openFDA to make decisions regarding medical care.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

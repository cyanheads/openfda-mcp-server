<div align="center">
  <h1>@cyanheads/openfda-mcp-server</h1>
  <p><b>Query FDA data on drugs, food, devices, and recalls via openFDA. STDIO or Streamable HTTP.</b>
  <div>12 Tools</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server) [![Version](https://img.shields.io/badge/Version-0.1.20-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Twelve tools for querying FDA data across drugs, food, devices, animal/veterinary products, and recalls:

| Tool | Description |
|:---|:---|
| `openfda_drug_profile` | One drug name → consolidated FDA profile: identity, label, adverse events, recalls, approval, shortage |
| `openfda_search_adverse_events` | Search adverse event reports across drugs, food, and devices |
| `openfda_search_animal_events` | Search adverse event reports for veterinary drugs and devices |
| `openfda_search_drug_shortages` | Search FDA drug shortage records — status, availability, therapeutic category, manufacturer |
| `openfda_search_tobacco_reports` | Search problem reports for tobacco products, e-cigarettes, and vaping devices |
| `openfda_search_recalls` | Search enforcement reports and recall actions across drugs, food, and devices |
| `openfda_count` | Aggregate and tally unique values for any field across any openFDA endpoint |
| `openfda_describe_fields` | Return searchable field paths for an openFDA endpoint, grouped by category |
| `openfda_get_drug_label` | Look up FDA drug labeling (package inserts / SPL documents) |
| `openfda_search_drug_approvals` | Search the Drugs@FDA database for NDA/ANDA application approvals |
| `openfda_search_device_clearances` | Search FDA device premarket notifications — 510(k) clearances and PMA approvals |
| `openfda_lookup_ndc` | Look up drugs in the NDC (National Drug Code) Directory |

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
- Pagination via `limit` (up to 1000) and `skip` (up to 25000)
- Formatted output includes report ID, seriousness, patient demographics, reactions, drugs with characterization/indication/route, and all remaining fields

---

### `openfda_count`

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
- Formatted output dynamically renders all label sections and openfda metadata present in the record
- Large sections are automatically truncated to keep output readable
- Default limit of 5 — labels are large documents

---

### `openfda_search_drug_approvals`

Search the Drugs@FDA database for drug application approvals (NDAs and ANDAs). Returns application details, sponsor info, and full submission history.

- Filter by brand name, sponsor, submission type, review priority
- Formatted output includes products with active ingredients, dosage forms, routes, and marketing status
- Full submission history with type, status, date, and review priority
- Pagination via `limit` (up to 1000) and `skip` (up to 25000)

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
- Pagination via `limit` (up to 1000) and `skip` (up to 25000)

---

### `openfda_describe_fields`

Return the searchable field paths for an openFDA endpoint, grouped by category with type and description. Use before constructing a search query to discover the correct dotted field paths.

- Covers all major endpoints: `drug/event`, `drug/label`, `drug/shortages`, `drug/drugsfda`, `drug/ndc`, `drug/enforcement`, `food/event`, `food/enforcement`, `device/event`, `device/510k`, `device/pma`, `device/recall`, `device/enforcement`, `animalandveterinary/event`, `tobacco/problem`
- Returns fields grouped by category (identifiers, dates, clinical fields, etc.) with data type and one-line description
- Complements the reactive field hints that appear in `notice` enrichment when a search returns empty

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
- Optional API key support — works without a key (1K requests/day), increases to 120K/day with a free key

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
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

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
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Twelve openFDA tools. |

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

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

<div align="center">
  <h1>@cyanheads/openfda-mcp-server</h1>
  <p><b>MCP server for querying FDA data on drugs, food, devices, and recalls via openFDA. STDIO & Streamable HTTP</b></p>
  <p><b>7 Tools</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server) [![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

## Tools

Seven tools for querying FDA data across drugs, food, devices, and recalls:

| Tool Name | Description |
|:----------|:------------|
| `openfda_search_adverse_events` | Search adverse event reports across drugs, food, and devices. |
| `openfda_search_recalls` | Search enforcement reports and recall actions across drugs, food, and devices. |
| `openfda_count` | Aggregate and tally unique values for any field across any openFDA endpoint. |
| `openfda_get_drug_label` | Look up FDA drug labeling (package inserts / SPL documents). |
| `openfda_search_drug_approvals` | Search the Drugs@FDA database for NDA/ANDA application approvals. |
| `openfda_search_device_clearances` | Search FDA device premarket notifications — 510(k) clearances and PMA approvals. |
| `openfda_lookup_ndc` | Look up drugs in the NDC (National Drug Code) Directory. |

### `openfda_search_adverse_events`

Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics.

- Category selection: `drug`, `food`, or `device` — each returns different field schemas
- Elasticsearch query syntax for filtering by product, reaction, seriousness, date range
- Pagination via `limit` (up to 1000) and `skip` (up to 25000)
- Formatted output includes report ID, seriousness, patient demographics, reactions, and drugs with characterization

---

### `openfda_count`

Aggregate and tally unique values for any field across any openFDA endpoint. Returns ranked term-count pairs sorted by count descending.

- Works across all 19 openFDA endpoints (drugs, food, devices, animal/veterinary, other)
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
- Formatted output includes key label sections: boxed warning, indications, dosage, warnings, contraindications, adverse reactions, drug interactions, active ingredients
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

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) from the same codebase

openFDA-specific:

- Generic API client for all openFDA endpoints with retry (exponential backoff) and rate-limit awareness
- Automatic error normalization — 404 returns empty results, 429/5xx retries, 400 provides actionable messages
- Optional API key support — works without a key (1K requests/day), increases to 120K/day with a free key

## Getting Started

### Via npx (no install)

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openfda": {
      "command": "npx",
      "args": ["-y", "@cyanheads/openfda-mcp-server", "run", "start:stdio"],
      "env": {
        "OPENFDA_API_KEY": "<optional>"
      }
    }
  }
}
```

### Prerequisites

- [Bun v1.2.0+](https://bun.sh/) or [Node.js v22+](https://nodejs.org/)

### Installation

```sh
git clone https://github.com/cyanheads/openfda-mcp-server.git
cd openfda-mcp-server
bun install
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OPENFDA_API_KEY` | Free API key from [open.fda.gov](https://open.fda.gov/apis/authentication/). Increases daily limit from 1K to 120K requests. | — |
| `OPENFDA_BASE_URL` | Base URL override for testing against a proxy or mock. | `https://api.fda.gov` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](.env.example) for the full list of framework and server-specific variables.

## Running the Server

### Local Development

- **Build and run the production version:**
  ```sh
  bun run build
  bun run start:stdio   # or start:http
  ```

- **Dev mode with watch:**
  ```sh
  bun run dev:stdio     # or dev:http
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck      # Lints, formats, type-checks
  bun test              # Runs test suite
  ```

### Docker

```sh
docker build -t openfda-mcp-server .
docker run -p 3010:3010 -e OPENFDA_API_KEY=your-key openfda-mcp-server
```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | Entry point — `createApp()` with tool registration and service setup. |
| `src/config/` | Server-specific env var parsing with Zod. |
| `src/services/openfda/` | openFDA API client with retry, rate-limit handling, and error normalization. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools in `src/mcp-server/tools/definitions/index.ts`

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

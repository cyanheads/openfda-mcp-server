# openfda-mcp-server

[![npm version](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server.svg)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server)
[![License](https://img.shields.io/npm/l/@cyanheads/openfda-mcp-server.svg)](LICENSE)

MCP server for querying FDA data on drugs, food, devices, and recalls via the [openFDA API](https://open.fda.gov/apis/). Query adverse events, recalls, drug labels, approvals, device clearances, NDC codes, and aggregate statistics — all through a unified MCP interface.

Built on [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core). Supports stdio and HTTP transports.

## Tools

| Tool | Description |
|:-----|:------------|
| `openfda_search_adverse_events` | Search adverse event reports across drugs, food, and devices |
| `openfda_search_recalls` | Search enforcement reports and recall actions |
| `openfda_count` | Aggregate and tally unique values for any field across any endpoint |
| `openfda_get_drug_label` | Look up FDA drug labeling (package inserts / SPL documents) |
| `openfda_search_drug_approvals` | Search Drugs@FDA for NDA/ANDA application approvals |
| `openfda_search_device_clearances` | Search 510(k) clearances and PMA approvals |
| `openfda_lookup_ndc` | Look up drugs in the NDC (National Drug Code) Directory |

## Quick Start

### Via npx (no install)

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

### From source

```bash
git clone https://github.com/cyanheads/openfda-mcp-server.git
cd openfda-mcp-server
bun install
bun run build
bun run start:stdio
```

## Configuration

| Variable | Required | Default | Description |
|:---------|:---------|:--------|:------------|
| `OPENFDA_API_KEY` | No | — | Free API key from [open.fda.gov](https://open.fda.gov/apis/authentication/). Increases daily limit from 1K to 120K requests. |
| `OPENFDA_BASE_URL` | No | `https://api.fda.gov` | Base URL override for testing against a proxy or mock. |
| `MCP_TRANSPORT_TYPE` | No | `stdio` | Transport type: `stdio` or `http`. |
| `MCP_LOG_LEVEL` | No | `info` | Minimum log level. |

See `.env.example` for the full list of framework and server-specific variables.

## Development

```bash
bun run dev:stdio       # Dev mode with watch (stdio)
bun run dev:http        # Dev mode with watch (HTTP)
bun run devcheck        # Lint + format + typecheck + security audit
bun test                # Run tests
```

## License

[Apache-2.0](LICENSE)

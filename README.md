<div align="center">
  <h1>@cyanheads/openfda-mcp-server</h1>
  <p><b>Query FDA data on drugs, food, devices, and recalls via openFDA. STDIO or Streamable HTTP.</b>
  <div>15 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.11.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfda-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openfda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfda-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

FDA data on drugs, food, cosmetics, devices, tobacco, veterinary products, and recalls from the openFDA public API. Search adverse events, recalls, drug approvals (Drugs@FDA, the Orange Book, Complete Response Letters), drug shortages, device clearances and classifications, and tobacco problem reports; look up NDC codes and drug labels; aggregate field counts across any endpoint.

### Tools

| Tool | Description |
|:---|:---|
| `openfda_drug_profile` | One drug name → consolidated FDA profile: identity, label, adverse events, recalls, approval, shortage |
| `openfda_search_adverse_events` | Search adverse event reports across drugs, food, devices, and cosmetics |
| `openfda_search_animal_events` | Search adverse event reports for veterinary drugs and devices |
| `openfda_search_drug_shortages` | Search FDA drug shortage records by status, availability, therapeutic category, manufacturer |
| `openfda_search_tobacco_reports` | Search problem reports for tobacco products, e-cigarettes, and vaping devices |
| `openfda_search_recalls` | Search enforcement reports and recall actions across drugs, food, and devices |
| `openfda_count_values` | Aggregate and tally unique values for any field across any openFDA endpoint |
| `openfda_describe_fields` | Return searchable field paths for an openFDA endpoint, grouped by category |
| `openfda_get_drug_label` | Look up FDA drug labeling (package inserts / SPL documents) |
| `openfda_search_drug_approvals` | Search Drugs@FDA NDA/ANDA applications, Orange Book products with patents and exclusivities, and Complete Response Letters |
| `openfda_search_device_clearances` | Search FDA device premarket records: 510(k) clearances, PMA approvals, and the product classification registry |
| `openfda_lookup_ndc` | Look up drugs in the NDC (National Drug Code) Directory or the NSDE package file |
| `openfda_dataframe_describe` | List tables and column schemas staged on a DataCanvas |
| `openfda_dataframe_query` | Run read-only SQL over a result set staged on a DataCanvas |
| `openfda_dataframe_drop` | Delete one table staged on a DataCanvas (opt-in, off by default) |

## Capability reference

### `openfda_drug_profile` <sub>tool</sub>

- One `drug` name, brand or generic, with each run of whitespace and characters openFDA refuses (`;`, `®`) read as one space; a name with no ASCII letter or digit fails as `blank_drug_name`. The name is resolved once to an identity (generic name, NDC, manufacturer, application number, original-packager flag, RxCUI, SPL set ID) from an original packager's label when one matches, else any matching label or the NDC directory, and from the approval application's own label when it has one; `meta.resolvedVia` (`label`, `ndc`, `none`) names the source, and a single-ingredient product is preferred over combinations
- `approval` is the drug's own Drugs@FDA application, ranked over the name's NDA, BLA, and brand matches, with its sponsor, marketing status, original approval date, review priority, and submission class (the earliest ORIG submission with status AP; null when there is none, never a supplement's date); recalls and shortage key on `meta.fanOutKey` — the typed name when it is an ingredient of the resolved generic, else that generic
- Each section names its product: `shortage` gives the product, company, and presentation of the record shown, with the match total and per-status counts, and differing `identity.application_number` / `approval.applicationNumber` mean two products
- Recalls also search records openFDA never harmonized (`product_description`); `recalls_total` gives the match count beside the newest 5 recalls, each with its `recall_number`, status, classification, reason, recalling firm, and date; a recall's lots come from `openfda_search_recalls` with `category: drug` and `recall_number:"<recall_number>"`
- Sections `label`, `adverse_events`, `recalls`, `approval`, and `shortage` are best-effort and come back `null` (or an empty `recalls`) on a miss; `degraded[]` names each section whose sub-query failed upstream, so a listed section is unknown rather than absent; a sub-query cut by the 50 s profile deadline is listed with reason `timeout`
- Auth, configuration, and cancellation failures fail the whole call instead of degrading a section

---

### `openfda_search_adverse_events` <sub>tool</sub>

- `category` (`drug`, `food`, `device`, `cosmetic`) selects the endpoint and its record schema; `limit` defaults to 5 (cap 25) for drug, 25 (cap 1000) for food and cosmetic, 10 (cap 175) for device
- Sortable date fields differ by category: `receivedate` (drug), `date_created` (food), `date_received` (device), `initial_received_date` (cosmetic, the date FDA first received the report); another category's field fails as `query_error`; with neither `search` nor `sort`, results come newest first on that field
- A drug page read without `fields` leaves `patient.drug.openfda` out of each report, the bulk of the page, and lists it in `omitted_fields` with its bytes; `include` returns it, or a path beneath it, and so does a `search` clause on `patient.drug.openfda.*`
- A matched search that AND-s clauses under one array (`patient.drug`, `patient.reaction`, a device's `device`, `patient`, or `mdr_text`, a food or cosmetic report's `products`) carries a notice: openFDA tests each clause against the whole report, so different entries can meet them. It names the array, the fields, and the staged SQL that requires one entry
- Text output lists each reaction with its outcome (`Death — fatal (5)`), shows onset age with its unit (`3 month (802)`), and decodes the coded drug and report fields from FDA's field reference beside the raw value (`via oral (048)`, `elderly (6)`, `drug withdrawn (1)`); structured output keeps the codes

---

### `openfda_search_animal_events` <sub>tool</sub>

- Optional `search` over veterinary reports, e.g. `animal.species`, `drug.active_ingredients.name`, `reaction.veddra_term_name`, `serious_ae`; `limit` defaults to 25, cap 450; a bare browse (no `search`, no `sort`) is newest first by `original_receive_date`
- Brand and manufacturer names are masked as `MSK` on every record, so search by active ingredient; `drug.manufacturer.registration_number` narrows to one approval
- Records carry animal species, breed, age, and weight, the drug and route, VeDDRA reaction terms, and outcome
- AND-ed clauses under one array (`drug`, `drug.active_ingredients`, `reaction`, `outcome`) can be met by different entries of a report; a matched search that does this carries a notice naming the array, the fields, and the staged SQL that requires one entry

---

### `openfda_search_drug_shortages` <sub>tool</sub>

- Optional `search` over `status` (`Current` / `To Be Discontinued` / `Resolved`), `therapeutic_category`, `generic_name`, or `company_name`; `limit` defaults to 25, cap 1000; a bare browse (no `search`, no `sort`) is newest first by `update_date`
- The four date fields (`initial_posting_date`, `update_date`, `discontinued_date`, `change_date`) are searched as `YYYY-MM-DD`; a date written `YYYYMMDD`, `M/D/YYYY`, or `YYYY-M-D` is rewritten to that form, in a term or either bound of a range
- Each record's `openfda` block carries `brand_name`, `product_ndc`, and `rxcui` for chaining into `openfda_get_drug_label` or `openfda_lookup_ndc`

---

### `openfda_search_tobacco_reports` <sub>tool</sub>

- Optional `search` over `tobacco_products`, `reported_health_problems`, `reported_product_problems`, or `nonuser_affected`; `limit` defaults to 25, cap 1000; a bare browse (no `search`, no `sort`) is newest first by `date_submitted`
- Reports carry the problem arrays plus `number_tobacco_products`, `number_health_problems`, and `number_product_problems` counts

---

### `openfda_search_recalls` <sub>tool</sub>

- `category` (`drug`, `food`, `device`) plus `endpoint`: `enforcement` (default, every category) or `recall` (devices only; other categories fail as `recall_endpoint_non_device`); `limit` defaults to 25 (cap 1000) for drug and food enforcement, 10 (cap 125) for device enforcement, 10 (cap 50) for device recall; a bare browse (no `search`, no `sort`) is newest first by `report_date` (`event_date_initiated` for device recall)
- Enforcement records carry `recall_number`, `classification` (Class I/II/III), and `status`; device recall records carry `product_res_number` and `recall_status` instead, with no hazard classification
- Device records are the heaviest, so a page read without `fields` leaves the lot lists out and names them in `omitted_fields` with their bytes: `code_info` and `more_code_info` on device enforcement; `code_info`, `openfda.k_number`, `openfda.fei_number`, and `openfda.registration_number` on device recall. `include` returns a path (or one beneath it), and so does a `search` clause naming it; drug and food records come back whole

---

### `openfda_count_values` <sub>tool</sub>

- `endpoint` (any of the 24 openFDA endpoints), a `count` field expression, and an optional `search`; returns the top `limit` terms (default 100, cap 1000; a larger `limit` returns 1000 with a notice), ranked by count; a date field returns one term per distinct `YYYYMMDD` date, ranked the same way
- `truncated` flags more distinct terms past `limit`, except at the 1000-term maximum, where a notice says completeness can't be known (a date count is exact at any limit, since openFDA sends every date); an expression openFDA can't aggregate fails as `not_aggregatable` (take the `countAs` form from `openfda_describe_fields`)
- On `drug/shortages`, dates written `YYYYMMDD`, `M/D/YYYY`, or `YYYY-M-D` in `search` are rewritten to `YYYY-MM-DD`, as on the shortage search tool
- A count whose `search` AND-s clauses under one array of objects on `drug/event`, `device/event`, `food/event`, `cosmetic/event`, `animalandveterinary/event`, `drug/drugsfda`, `drug/orangebook`, or `drug/ndc` carries a notice that the clauses can be met by different entries; it names the search tool and the `category` or `dataset` value (where the tool takes one) that stages the endpoint, with the `WHERE` condition for one entry
- Always runs against the live API, even with the bulk mirror enabled

---

### `openfda_describe_fields` <sub>tool</sub>

- `endpoint`: the same 24 endpoints `openfda_count_values` accepts
- Field paths grouped by category, each with `type`, a description, and `countAs` (the verified count expression, or `null` when the field can't be aggregated), plus `queryTips` on quoting, AND/OR, `.exact`, and date ranges

---

### `openfda_get_drug_label` <sub>tool</sub>

- Required `search` on label fields (`openfda.brand_name`, `openfda.generic_name`, `openfda.manufacturer_name`, `set_id`); `limit` defaults to 5, cap 1000 (a larger value returns 1000 records with a notice naming the next `skip`); an empty search names `spl_product_data_elements` for labels openFDA never linked to a product
- A brand search also matches repackagers' copies of a label: add `AND openfda.is_original_packager:true` to keep the original packager's, or take `identity.spl_set_id` from `openfda_drug_profile`
- A page over 24,000 bytes returns `kind: "outline"` (section names and sizes, largest first) instead of label text, with `page_labels` listing each record on the page (`set_id`, `effective_time`, names, `is_original_packager`, `bytes`); re-call with `sections: [...]` to get those sections plus identity metadata (`openfda`, `set_id`, `id`, `effective_time`, `version`), returned whole even when over budget. A single label over 24,000 bytes outlines even when re-called alone by `set_id`
- `*_table` sections render as Markdown tables in the text output; structured results keep the raw SPL markup

---

### `openfda_search_drug_approvals` <sub>tool</sub>

- `dataset` selects what is searched: `drugsfda` (default, Drugs@FDA applications), `orangebook` (Orange Book products with their patents and exclusivities), or `crl` (Complete Response Letters FDA has published)
- On `drugsfda`, optional `search` over `products.brand_name` (any letter case; `openfda.*` covers harmonized applications only), `sponsor_name` (stored uppercase, so a lowercase quoted value matches nothing), `submissions.submission_type`, or `submissions.review_priority`; omitted, the page is newest first by latest submission (`submissions.submission_status_date:desc`), not approval date; `limit` defaults to 25, cap 375
- On `orangebook`, search `products.brand_name`, `products.application_number`, `patents.patent_number`, or `exclusivity.exclusivity_code`; a bare browse is newest first by `approval_date`; `limit` defaults to 25, cap 1000. On `crl`, search `application_number`, `company_name`, or `text`; a bare browse is newest first by `letter_date`; `limit` defaults to 5, cap 75
- The datasets spell an application number differently: a letter's `NDA 210274` is Drugs@FDA's `NDA210274` and the Orange Book's `products.application_number:"210274"` with `products.application_type:"N"` (`"A"` for an ANDA)
- Records carry `application_number`, `sponsor_name`, `products[]`, and the application's full `submissions[]` history; Orange Book products carry `product_number`, `approval_date`, `products[]`, `patents[]`, and `exclusivity[]`; letters carry `application_number[]`, `letter_date`, `letter_type`, `company_name`, `approver_name`, and the letter `text`
- AND-ed clauses under one array (`drugsfda`: `submissions`, `submissions.application_docs`, `submissions.submission_property_type`, `products`, `products.active_ingredients`; `orangebook`: `products.active_ingredients`, `patents`, `exclusivity`) can be met by different entries; a matched search that does this carries a notice with the staged SQL that requires one entry

---

### `openfda_search_device_clearances` <sub>tool</sub>

- `pathway` (`510k`, `pma`, or `classification`, one per call) plus an optional `search` over `applicant`, `product_code`, `advisory_committee_description`, or `openfda.device_name`; on `classification`, `device_class`, `regulation_number`, or `submission_type_id`; `limit` defaults to 10 (cap 175) for 510(k), 25 (cap 575) for PMA, 25 (cap 600) for classification; a bare browse (no `search`, no `sort`) is newest first by `decision_date` on 510(k) and PMA, and unsorted on classification, whose records carry no date
- 510(k) records carry `k_number`, `device_name`, and `decision_date`; PMA records carry `pma_number`, `trade_name`, and `supplement_number`; classification records, one per product code, carry `product_code`, `device_name`, `device_class`, `regulation_number`, and `submission_type_id` (the submission the device type requires; `4` is 510(k) exempt)
- `content[]` labels a classification record's class and submission type beside the raw code; `structuredContent` and staged rows keep the raw codes

---

### `openfda_lookup_ndc` <sub>tool</sub>

- Required `search` over `product_ndc`, `brand_name`, `generic_name`, `labeler_name`, or `active_ingredients.name`; `limit` defaults to 25, cap 1000
- `dataset` is `ndc` (default, the NDC Directory: currently listed products with their packaging) or `nsde` (the NDC SPL Data Elements file: one flat row per package, ended packages included, keyed by its 11-digit `package_ndc11`); on `nsde`, search `package_ndc11:"00093171201"`, `package_ndc:"0093-1712-01"` (`"0093-1712"` reaches every package of the product), or `proprietary_name` (the whole name, case-sensitive)
- Records carry `product_ndc`, `labeler_name`, `dosage_form`, `route`, `marketing_category`, `active_ingredients[]`, and `packaging[]`; `nsde` rows carry `package_ndc11`, `package_ndc`, `proprietary_name`, `dosage_form`, `billing_unit`, `marketing_category`, and the marketing, inactivation, and reactivation dates
- AND-ed clauses on `active_ingredients` or `packaging` fields can be met by different entries of a record; a matched search that does this carries a notice with the staged SQL that requires one entry

---

### `openfda_dataframe_describe` <sub>tool</sub>

- `canvas_id` from a staged search; lists each table's `name`, `kind`, full staged `row_count`, and columns with DuckDB type and nullability
- Fails as `canvas_disabled` when `CANVAS_PROVIDER_TYPE=none`, or `canvas_not_found` when the `canvas_id` has expired or never existed

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

- One client for all 24 openFDA endpoints, with retry on 429 and 5xx. No API key is needed (1K requests/day); a free `OPENFDA_API_KEY` raises that to 120K/day
- Queries are `field:value` over dotted paths joined by AND/OR (a URL-style `+` between clauses reads as a space, and an unquoted hyphenated value such as `D-0123-2024` is sent quoted); `openfda_describe_fields` lists the paths, and a malformed query fails as `malformed_search` before any request: an unclosed quote, group, or range, a trailing backslash, or a character openFDA refuses (one of ``! # $ ; ? ^ ` | ~`` or anything outside printable ASCII), named with its position
- Paging: `limit` is the page size, with a default and cap per endpoint (default 5 and cap 25 for drug adverse events, default 25 and cap 1000 for the shortest records); a larger value is clamped to the cap with a notice, and `skip` runs up to openFDA's 25,000-record ceiling (`pagination_limit_reached` past it); no page is cut to a byte budget
- Past the ceiling: every search tool, `openfda_lookup_ndc`, and `openfda_get_drug_label` return `next_cursor` on a page read at `skip` 0 or by cursor while records remain; pass it as `cursor` to continue, from skip 0, past 25,000. `limit`, `fields`, `include`, and `sections` may change between pages; the endpoint, `search`, and `sort` may not (`invalid_cursor`), and a `cursor` cannot come with `skip` above 0, `stage`, or `canvas_id`
- `fields` on any `openfda_search_*` tool or `openfda_lookup_ndc` trims each record to the dotted paths you name, so large records fit inline; without `fields`, drug adverse events and device recalls and enforcement reports leave their heaviest paths out and list them in `omitted_fields`, and `include` returns them
- DataCanvas staging (on by default; `CANVAS_PROVIDER_TYPE=none` turns it off) with `stage: true` or a `canvas_id`, and an optional local bulk mirror (`OPENFDA_MIRROR_ENABLED=true`) that answers exact-key lookups without spending API budget

Agent-friendly output:

- Disclosed bounds: the clamp notice, `projected_fields`, `omitted_fields`, the label `outline`, and `staged_rows` report every clamp, projection, left-out path, outline, and staging cut; `page_bytes` and `page_largest_fields` flag a record over 24,000 bytes
- Typed failures: callers branch on `error.data.reason` (`rate_limited`, `query_error`, `not_aggregatable`, ...) instead of parsing messages
- Unknown vs. absent: `openfda_drug_profile` returns `null` for a section with no FDA record and lists failed sections in `degraded[]`
- Empty-result guidance: a no-match search points at `openfda_describe_fields`, broader terms, and the endpoint's own product-name field

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http openfda-mcp-server https://openfda.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add openfda-mcp-server -- npx -y @cyanheads/openfda-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "openfda-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/openfda-mcp-server"]
    }
  }
}
```

No API key is needed. A free [openFDA API key](https://open.fda.gov/apis/authentication/) set as `OPENFDA_API_KEY` raises the limit from 1K to 120K requests per day. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `OPENFDA_API_KEY` | Free API key from [open.fda.gov](https://open.fda.gov/apis/authentication/); raises the daily limit from 1K to 120K requests. | none |
| `OPENFDA_BASE_URL` | API base URL override, for a proxy or mock. | `https://api.fda.gov` |
| `OPENFDA_CLAMP_LIMITS` | Clamp a `limit` above its endpoint's cap to the cap, with a notice; `false` rejects it and advertises the cap as the schema `maximum`. | `true` |
| `OPENFDA_MIRROR_ENABLED` | Answer exact-key lookups from the [local bulk mirror](#local-bulk-mirror). | `false` |
| `OPENFDA_MIRROR_PATH` | Directory holding one SQLite file per mirrored dataset. | `./data/openfda-mirror` |
| `OPENFDA_MIRROR_REFRESH_CRON` | Cron expression for the in-process mirror refresh (HTTP transport only). | none |
| `OPENFDA_MIRROR_FALLBACK_LIVE` | Fall back to the live API when the mirror is cold, missing the record, or failing. | `true` |
| `OPENFDA_MIRROR_REFRESH_TIMEOUT_MS` | Wall-clock budget for one refresh before it is aborted, in ms. | `21600000` (6h) |
| `OPENFDA_MIRROR_BASE_URL` | Host serving the bulk download manifest (`download.json`). | `https://api.fda.gov` |
| `CANVAS_PROVIDER_TYPE` | DataCanvas staging and SQL. `none` disables them; dataframe tools remain listed and return `canvas_disabled`. | `duckdb` |
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

The Claude Desktop MCPB bundle disables DataCanvas because it excludes platform-specific DuckDB bindings. Use npm or Docker for staging and SQL.

### Local bulk mirror

With `OPENFDA_MIRROR_ENABLED=true` the server keeps a local SQLite copy of four openFDA bulk dumps (`drug/label`, `drug/ndc`, `drug/enforcement`, `drug/drugsfda`). Only exact lookups are answered locally: a single quoted `field:"value"` term on `id`, `set_id`, `product_id`, `product_ndc`, `recall_number`, `event_id`, or `application_number`, with no `count`, `sort`, or `cursor`, `skip` 0, and one matching record. Everything else goes to the API.

The initial harvest runs separately, never at startup:

```sh
bun run mirror:init                  # all four datasets
bun run mirror:init drug/enforcement # one dataset
bun run mirror:status                # sync state per dataset
bun run mirror:verify                # integrity check + row counts
bun run mirror:refresh               # re-harvest datasets whose dump has advanced
```

A refresh re-reads the whole dump, and server shutdown stops a refresh in progress; the next refresh resumes it. Set `OPENFDA_MIRROR_REFRESH_CRON` to run it in-process on the HTTP transport; on stdio, run `bun run mirror:refresh` from the host. A mirrored response's `meta.lastUpdated` is the served dump's stamp, which can differ from the live API's.

On Node, install the optional `better-sqlite3` peer dependency (Bun uses its built-in `bun:sqlite`). `OPENFDA_MIRROR_REFRESH_CRON` also needs the optional `node-cron` peer dependency; without it the server fails at startup.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/openfda-mcp-server.git
  cd openfda-mcp-server && bun install
  cp .env.example .env   # optionally set OPENFDA_API_KEY and the mirror or canvas options
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/openfda-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/openfda-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/openfda-mcp-server:latest"]`. To build locally, `docker build -t openfda-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. To keep a mirror harvest across container replacement, mount a volume over `/usr/src/app/data/openfda-mirror`.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: tool registration, service setup, mirror refresh wiring. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), fifteen in all. |
| `src/mcp-server/tools` | Shared tool helpers: per-endpoint field catalog, input schemas and guards, `search` normalization and clause reading, shortage date rewriting, cursor tokens, formatters, SPL table rendering. |
| `src/services/openfda` | openFDA API client (retry, rate limits, 50 s call deadline, error normalization), oversized-record disclosure, `fields` record projection and default left-out paths, canvas staging. |
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

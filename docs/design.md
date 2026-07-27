---
name: openfda-mcp-server
status: designed
priority: high
difficulty: medium
category: government
api_docs: https://open.fda.gov/apis/
---

# openFDA MCP Server

## Overview

Wraps the [openFDA API](https://open.fda.gov/apis/) -- an Elasticsearch-backed public API serving FDA data across drugs, food, devices, and other regulated products. Covers adverse event reports (20M+ drug, 24M+ device), enforcement/recall actions (140K+ across all categories), drug labels, NDC directory, drug approvals (Drugs@FDA), drug shortages, device 510(k) clearances (174K+), PMA approvals, device classifications, and more.

All endpoints share a uniform query interface (`search`, `count`, `sort`, `limit`, `skip`) with Elasticsearch syntax. Optional free API key increases daily limit from 1,000 to 120,000 requests.

**Dependencies**: None beyond HTTP. No official SDK -- the API is straightforward REST/JSON.

---

## Tools

### `openfda_drug_profile`

Resolve one drug name to its FDA identity, then fan out in parallel to the bounded per-drug endpoints and merge into a single consolidated profile. Replaces chaining `openfda_get_drug_label`, `openfda_search_adverse_events`, `openfda_search_recalls`, `openfda_search_drug_approvals`, and `openfda_search_drug_shortages`, and reconciles the identifier drift between endpoints that makes that chaining error-prone.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `drug` | string | Yes | Drug name — brand or generic (e.g. `metformin`, `Humira`). Resolved once to canonical FDA identifiers, which then key every sub-query. |

**Behavior.** Resolves the name against `drug/label` (falling back to `drug/ndc`), picking the best single-ingredient match — combination products are de-prioritized so a single-drug query doesn't resolve to a combo. Structured endpoints (`drug/enforcement`, `drug/drugsfda`, `drug/shortages`) then query by the canonical `openfda.generic_name`; the free-text adverse-event field (`drug/event` `patient.drug.medicinalproduct`) queries by the supplied term for better recall. Each section is best-effort: a failed or empty sub-query yields `null` (or `[]` for recalls) rather than failing the whole call.

**Returns:** `meta` (echoed `drug`, `resolvedVia`) + `identity` (`brand_names`, `generic_name`, `product_ndc`, `rxcui`, `spl_set_id`) + `label` (`indications`, `warnings`, `dosage`) + `adverse_events` (`total`, `seriousCount`, `topReactions[]`) + `recalls[]` (`classification`, `reason`, `recalling_firm`, `date`) + `approval` (`applicationNumber`, `sponsor`, `marketingStatus`) + `shortage` (`status`, `availability`). Sections are `null` when unavailable.

### `openfda_search_adverse_events`

Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics. The primary research tool for safety data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | `"drug"` \| `"food"` \| `"device"` | Yes | Product category. Each has different field schemas -- drug reports include patient demographics and suspect drugs, device reports include device details and event type, food reports include industry and outcomes. |
| `search` | string | No | Elasticsearch query string. Field-value pairs joined by `+AND+` or `+OR+`. Examples: `patient.drug.medicinalproduct:"aspirin"`, `patient.reaction.reactionmeddrapt:"nausea"+AND+serious:"1"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Sortable date fields are category-specific: drug → `receivedate:desc` (or `receiptdate`), food → `date_created:desc` (or `date_started`), device → `date_received:desc` (or `date_of_event`). A field from another category (e.g. `receivedate` on food or device) causes a query error. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`; for deeper access, narrow the search query instead. |

**Returns:** `meta` (total count, skip, limit) + array of adverse event records. Drug records include `safetyreportid`, `patient` (age, sex, reactions[], drugs[]), `serious` flag, `receivedate`. Device records include `report_number`, `device[]` (brand, generic name, manufacturer), `event_type`. Food records include `reactions`, `outcomes`, `products`.

### `openfda_search_recalls`

Search enforcement reports and recall actions across drugs, food, and devices. Use to investigate product recalls, check a company's compliance history, or find safety actions by classification severity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | `"drug"` \| `"food"` \| `"device"` | Yes | Product category. Drug and food use `/enforcement` endpoints. Device has both `/recall` (detailed recall data) and `/enforcement` (enforcement actions). |
| `endpoint` | `"enforcement"` \| `"recall"` | No | Default `enforcement`. `recall` is only valid for devices and includes additional fields like `res_event_number` and root cause analysis. |
| `search` | string | No | Query string. Examples: `classification:"Class+I"`, `recalling_firm:"pfizer"`, `reason_for_recall:"undeclared+allergen"`. |
| `sort` | string | No | Sort field and direction. Example: `report_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** `meta` (total count) + array of enforcement/recall records: `recall_number`, `classification` (Class I/II/III), `recalling_firm`, `product_description`, `reason_for_recall`, `distribution_pattern`, `status`, `voluntary_mandated`, dates.

### `openfda_count_values`

Aggregate and tally unique values for any field across any openFDA endpoint. Use for trend analysis, frequency distributions, and "top N" questions. Returns `[{term, count}]` pairs instead of individual records.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `endpoint` | string | Yes | Full endpoint path. Exhaustive list as of 2026-04: `drug/event`, `drug/label`, `drug/enforcement`, `drug/ndc`, `drug/drugsfda`, `drug/shortages`, `food/event`, `food/enforcement`, `device/event`, `device/510k`, `device/pma`, `device/recall`, `device/enforcement`, `device/classification`, `device/registrationlisting`, `device/udi`, `device/covid19serology`, `animalandveterinary/event`, `other/substance`. New endpoints are rare -- check [open.fda.gov/apis](https://open.fda.gov/apis/) if a category seems missing. |
| `count` | string | Yes | Field to count. Append `.exact` for whole-phrase counting (without it, multi-word values are tokenized). Examples: `patient.reaction.reactionmeddrapt.exact`, `classification`, `openfda.brand_name.exact`. |
| `search` | string | No | Filter query to scope the count. Example: `patient.drug.medicinalproduct:"metformin"` to count reactions only for metformin. |
| `limit` | number | No | Number of top terms to return (default 100, max 1000). |

**Returns:** Array of `{term, count}` objects sorted by count descending. Example: `[{"term": "NAUSEA", "count": 752664}, {"term": "FATIGUE", "count": 742326}]`.

**Count-only endpoints.** Several endpoints are reachable via `openfda_count_values` but have no dedicated search tool. `animalandveterinary/event`, `tobacco/problem`, and `drug/shortages` all now have dedicated search tools and are no longer count-only:

| Endpoint | Reason no search tool |
|---|---|
| `device/registrationlisting` | Registration/listing data (320K records). Primarily useful for facility lookups -- low priority vs. the higher-signal 510(k)/PMA/recall tools. |
| `device/udi` | Large dataset (4.9M records) but very granular device identifier data. UDI lookups are niche -- most device research uses 510(k) or classification. |
| `device/covid19serology` | Narrow domain. Count-only unless serology test data becomes a priority. |
| `other/substance` | Substance/ingredient reference data. Count covers "what substances exist" queries. |

These endpoints all support the standard `search`/`count`/`limit`/`skip` parameters. If a use case emerges requiring individual record access, promote to a full search tool.

### `openfda_get_drug_label`

Look up FDA drug labeling (package inserts / SPL documents). Use to check indications, warnings, dosage, contraindications, active ingredients, or any structured label section for a drug.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query targeting label fields. Common patterns: `openfda.brand_name:"aspirin"`, `openfda.generic_name:"metformin"`, `openfda.manufacturer_name:"pfizer"`, `set_id:"uuid"`. Combine with `+AND+` for specificity. |
| `sort` | string | No | Sort field. Example: `effective_time:desc` for most recent labels. |
| `limit` | number | No | Results to return (1-1000, default 5). Labels are large -- keep limit low unless browsing. |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `sections` | string[] | No | Top-level label sections to return, e.g. `["boxed_warning","indications_and_usage"]`. Omit for the whole label. |

**Returns:** `meta`, a `kind` discriminator, and one of two arms.

`kind: "full"` carries `results[]` — label records with structured sections: `indications_and_usage`, `warnings`, `dosage_and_administration`, `contraindications`, `adverse_reactions`, `drug_interactions`, `active_ingredient`, `inactive_ingredient`, `purpose`, `do_not_use`, `pregnancy_or_breast_feeding`, plus `openfda` enrichment (brand name, generic name, manufacturer, route, substance, pharm class, application number).

**Outline on overflow.** A single SPL record runs to tens of thousands of tokens — a warfarin label is ~130 KB across 36 top-level keys, of which ~39 KB is `*_table` raw HTML duplicating adjacent prose. Trimming only `format()` would desync `content[]` from `structuredContent`, so the size lever is caller-driven instead, via the framework's `outlineOnOverflow` helper (`@cyanheads/mcp-ts-core/utils`):

- With `sections`, each record is projected to the requested keys plus the always-kept metadata (`openfda`, `set_id`, `id`, `effective_time`, `version`) and returned as `kind: "full"`. A name no record on the page carries is reported on `enrichment.notice` — with the names the page does carry when nothing matched at all, since a typo and a genuinely absent section otherwise produce the same metadata-only record.
- Without `sections`, the page is measured against the helper's 24,000-byte budget. Under it, the records come back whole. Over it, the response is `kind: "outline"` with `outline[]` — every section name present on the page and its serialized size, largest first — and the re-call guidance on `enrichment.notice`. The re-call is stateless: the same `search` plus `sections` reproduces the record and slices it.

**Decision — the outline arm is a deliberate default-path change.** Before this, a `structuredContent` reader always got the complete label for any query that matched. Complex prescription drugs overflow the budget by 5-10x, so those queries now return an outline until the caller names sections. Bounding the default payload is the point: the alternative (one-sided `format()` truncation) hid the same data from `content[]` clients while claiming completeness.

### `openfda_search_drug_approvals`

Search the Drugs@FDA database for drug application approvals, including NDAs and ANDAs. Use to check if a drug is FDA-approved, find approval dates, review priority status, or explore a sponsor's portfolio.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query string. Examples: `openfda.brand_name:"humira"`, `sponsor_name:"PFIZER"`, `submissions.submission_type:"ORIG"+AND+submissions.review_priority:"PRIORITY"`. Exact quoted values can be case-sensitive on some fields — `sponsor_name` is stored uppercase, so a lowercase quoted value returns no matches. |
| `sort` | string | No | Sort field and direction. Example: `submissions.submission_status_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** Application records: `application_number` (NDA/ANDA), `sponsor_name`, `submissions[]` (type, status, status date, review priority, class code), plus `openfda` enrichment (brand name, generic name, manufacturer, route, substance, product type).

### `openfda_search_device_clearances`

Search FDA device premarket notifications -- 510(k) clearances and PMA (premarket approval) records. Use to verify if a device has been cleared/approved, find predicate devices, or research a company's device portfolio.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pathway` | `"510k"` \| `"pma"` | Yes | Premarket pathway. 510(k) is the most common clearance route (174K+ records). PMA is for higher-risk devices requiring clinical evidence. |
| `search` | string | Yes | Query string. Examples: `applicant:"medtronic"`, `advisory_committee_description:"cardiovascular"`, `product_code:"DXN"`, `openfda.device_name:"catheter"`. |
| `sort` | string | No | Sort field. Example: `decision_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** 510(k): `k_number`, `applicant`, `device_name`, `product_code`, `decision_date`, `decision_description`, `advisory_committee`, `statement_or_summary`. PMA: `pma_number`, `applicant`, `advisory_committee`, `product_code`, `decision_date`, `decision_code`.

### `openfda_lookup_ndc`

Look up drugs in the NDC (National Drug Code) Directory. Use to identify drug products by NDC code, find active ingredients and strengths, packaging details, or manufacturer information.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query string. Examples: `product_ndc:"0363-0218"`, `brand_name:"aspirin"`, `generic_name:"metformin"`, `openfda.manufacturer_name:"walgreen"`, `active_ingredients.name:"ASPIRIN"`. |
| `sort` | string | No | Sort field and direction. Example: `listing_expiration_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** NDC records: `product_ndc`, `brand_name`, `generic_name`, `labeler_name`, `active_ingredients[]` (name, strength), `dosage_form`, `route`, `marketing_category`, `packaging[]` (package NDC, description), `finished` flag, `listing_expiration_date`, plus `openfda` enrichment (manufacturer, rxcui, pharm class, UPC).

### `openfda_search_animal_events`

Search adverse event reports for veterinary drugs and devices. Use to investigate safety signals for veterinary products, find reports by animal species or drug, or explore reaction patterns.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | openFDA query syntax. Examples: `animal.species:"Dog"`, `drug.brand_name:"Bravecto"`, `reaction.veddra_term_name:"Vomiting"`, `serious_ae:"true"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Example: `original_receive_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** Animal adverse event records: `unique_aer_id_number`, `original_receive_date`, `serious_ae`, `animal` (species, gender, breed, age, weight), `drug[]` (brand_name, active_ingredients, route, dose, administered_by), `reaction[]` (veddra_term_name, number_of_animals_affected), `outcome[]` (medical_status), `primary_reporter`, `type_of_information`.

### `openfda_search_drug_shortages`

Search FDA drug shortage records. Returns per-product shortage status, availability notes, therapeutic category, dosage form, manufacturer, and timeline. The `openfda` block carries cross-reference IDs for chaining into `openfda_get_drug_label` or `openfda_lookup_ndc`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | Elasticsearch query. Examples: `status:"Current"`, `therapeutic_category:"Oncology"`, `generic_name:"carboplatin"`, `company_name:"pfizer"`. Omit to browse all. |
| `sort` | string | No | Sort field and direction. Example: `update_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** Shortage records with `generic_name`, `status` (Current/Resolved), `availability`, `therapeutic_category`, `dosage_form`, `presentation`, `package_ndc`, `company_name`, `contact_info`, `initial_posting_date`, `update_date`, `update_type`, plus `openfda` block (`brand_name`, `product_ndc`, `rxcui`, `spl_set_id`).

### `openfda_describe_fields`

Return the searchable field paths for an openFDA endpoint, grouped by category with type and description. Use before constructing a search query to discover correct dotted field names. Covers 15 endpoints.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `endpoint` | enum | Yes | One of the cataloged endpoint paths (e.g. `drug/event`, `drug/shortages`, `device/510k`). |

**Returns:** `groups[]` with `label`, `fields[]` (path, type, note); plus `queryTips` covering syntax reminders.

**Reactive enrichment.** All search tools populate the `notice` enrichment field with a compact field hint when results are empty or a query is rejected — same catalog, reactive path. This catches agents that don't call `openfda_describe_fields` proactively.

### `openfda_search_tobacco_reports`

Search problem reports submitted to the FDA for tobacco products, including e-cigarettes, vaping products, cigarettes, and smokeless tobacco. Use to investigate safety signals, find reports by product type, or analyze health effects.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | openFDA query syntax. Examples: `tobacco_products:"Electronic cigarette"`, `reported_health_problems:"Seizure"`, `nonuser_affected:"Yes"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Example: `date_submitted:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |

**Returns:** Tobacco problem reports: `report_id`, `date_submitted`, `tobacco_products[]` (product type description), `reported_health_problems[]` (health effects), `reported_product_problems[]` (device/product defects), `number_tobacco_products`, `number_health_problems`, `number_product_problems`, `nonuser_affected`.

### `openfda_dataframe_query`

Run a read-only SQL `SELECT` against a DataCanvas table staged by a search tool (see [DataCanvas staging](#datacanvas-staging-analytical-sql)). Enables `GROUP BY`, `COUNT/SUM/AVG`, time-series, and joins across the staged result set without re-paging the API.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `canvas_id` | string | Yes | Canvas ID from a search tool response (present when the search ran with `stage: true`). |
| `query` | string | Yes | SQL `SELECT`. Use the table name from `openfda_dataframe_describe`. Scalar columns are text (`CAST` for numeric math); nested objects/arrays are JSON columns (e.g. `json_extract_string(openfda, '$.brand_name[0]')`). |

**Returns:** `rows[]`, `row_count`, `truncated`, `canvas_id`. Results are capped at the canvas row limit (10,000 by default); `truncated: true` says rows beyond the cap exist and both response paths point at `ORDER BY` + `LIMIT`/`OFFSET` pagination. Only `SELECT` is allowed — DDL/DML/COPY/file-reading functions are rejected by the framework's four-layer SQL gate, and those rejections are mapped onto the tool's own `invalid_query` / `missing_table` contract so recovery text names MCP tools rather than internal canvas APIs.

### `openfda_dataframe_describe`

List the tables and column schemas on a DataCanvas. Call before `openfda_dataframe_query` to discover the exact table and column names. `row_count` is the full staged set, not the inline page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `canvas_id` | string | Yes | Canvas ID from a search tool response. |

**Returns:** `tables[]` (`name`, `kind`, `row_count`, `columns[]` of `name`/`type`/`nullable`), `canvas_id`.

---

## DataCanvas staging (analytical SQL)

**Opt-in twice over.** The deployment enables the surface with `CANVAS_PROVIDER_TYPE=duckdb` (requires the optional `@duckdb/node-api` dependency; unavailable on the Workers runtime, where it fails closed at init), and the caller asks for staging per call. Without both, a search issues exactly one upstream request and returns one page — identical to a deployment with no canvas at all.

Every multi-row search tool — `openfda_search_adverse_events`, `_recalls`, `_drug_approvals`, `_device_clearances`, `_animal_events`, `_drug_shortages`, `_tobacco_reports`, and `openfda_lookup_ndc` — carries:

- `stage` (boolean, default `false`) — stage the matched set for SQL. Passing a `canvas_id` implies it, so successive searches accumulate onto one canvas for cross-table joins.
- Output fields `canvas_id`, `canvas_table`, `spilled`, `staged_rows`, `truncated` (all absent unless the call staged).

`limit`/`skip` mean the same thing in both modes: a window over the matched set, served from the drain's first page when it covers the window and fetched directly otherwise. A staged call therefore never disagrees with an unstaged one about whether records exist at a given offset, and record size never empties the page.

**Bounded drain.** Staging drains from offset 0 until whichever comes first: openFDA's 25,000-row `skip` ceiling, or a ~16 MB serialized-JSON budget (`STAGE_MAX_BYTES`). The budget is converted to a row cap and a page size from a 100-row probe, because record size spans three orders of magnitude across endpoints — a `drug/shortages` row is ~1 KB, a `drug/event` report ~65 KB — so a flat row cap either starves the small endpoints or stalls the large ones. `staged_rows` versus `meta.total` discloses exactly how much of the match reached the table, in `structuredContent` and in `content[]`; `truncated: true` when they differ. A truncated stage also names `openfda_count_values` in its disclosure: a `GROUP BY` over the staged rows describes only those rows, while a count query answers the same distribution over the whole matched set server-side in one request.

**Canvas table shape.** Each endpoint registers an explicit, all-nullable column projection (`src/services/openfda/canvas-spill.ts` plus a per-tool `*_CANVAS_SCHEMA` constant): high-value scalar fields as `VARCHAR` (openFDA returns most values as strings — `CAST` in SQL for numeric math) and nested objects/arrays (`openfda`, `patient`, `products`, `submissions`, …) as `JSON` columns read with DuckDB json functions. Fields outside the projection are dropped from the table but remain in the inline page; absent fields register as `NULL`. The drain feeds the raw records straight to the appender, which projects them onto the schema — so sparse, heterogeneous records ingest without NOT-NULL failures.

---

## Implementation Notes

**Uniform query layer.** All 15+ openFDA endpoints share identical query mechanics: `search=field:value`, `count=field`, `sort=field:asc|desc`, `limit=N`, `skip=N`. The service layer should implement one generic query function parameterized by endpoint path, with tool handlers providing domain-specific defaults and output formatting.

**Elasticsearch syntax quirks:**
- Boolean: `+AND+`, `+OR+` (URL-encoded spaces). OR is implicit when terms are space-separated.
- Exact matching: field values in quotes (`"aspirin"`). Without quotes, tokenized matching.
- `.exact` suffix on count fields for whole-phrase aggregation vs. tokenized.
- Date ranges: `[20200101+TO+20201231]`.
- Wildcard: `field:aspir*`.

**Rendering a dynamic record.** Every search tool returns `results[]` as `z.record(z.string(), z.any())` — openFDA records are sparse and heterogeneous, so the shape cannot be pinned. That defeats the definition linter's `format-parity` sentinel walk, which stops at the record boundary and cannot tell whether a formatter rendered every leaf inside it. The convention that replaces it:

- A curated summary reads the fields worth leading with; `formatRemainingFields(record, rendered)` then renders everything else, JSON-stringifying nested structures so no leaf is dropped.
- `rendered` names only keys the summary emits **verbatim and unconditionally**. A key that is translated (`serious: '1'` → "Yes"), filtered, partially rendered, or rendered only when a sibling is absent (`brand_name ?? generic_name`) stays out of the set, so its full value still reaches `content[]`. Duplicating a scalar costs a line; omitting one is a client-visible data loss.
- `tests/mcp-server/tools/definitions/record-parity.test.ts` holds the coverage the sentinel cannot: per-tool fixtures carrying the real nested blocks, asserting every scalar leaf appears in the rendered text.

**Pagination ceiling.** openFDA refuses a `skip` above 25000. For datasets larger than `skip + limit`, the agent must narrow the search query (e.g., date ranges, additional filters) rather than paginating further.

**Decision — the ceiling is a handler check, not a schema `.max()`.** Every paginated tool advertises a `pagination_limit_reached` reason with recovery text. A schema maximum rejected the request as a generic input-validation failure first, so that contract carried no `structuredContent.error.data.reason` and no recovery hint — advertised but unreachable. The bound lives in `OPENFDA_MAX_SKIP` (`src/mcp-server/tools/schema-utils.ts`); handlers compare against it and `ctx.fail` the declared reason before spending an upstream request. `openfda_count_values` has no `skip` input, so it does not declare the reason at all.

**Rate limits:**
- Without key: 240 req/min, 1,000 req/day per IP
- With key: 240 req/min, 120,000 req/day per key
- Key is free, passed as `api_key` query parameter or Basic auth header

**`openfda` enrichment.** Most endpoints include an `openfda` object with cross-referenced data (brand names, generic names, manufacturer, RxCUI, pharm class, NDC, UPC). This is added by openFDA on top of the original source data and is the most reliable way to search by product name across endpoints.

**Data freshness.** Updated quarterly with potential 3+ month lag. Drug adverse events cover 2004-present. `meta.last_updated` in every response indicates the dataset date.

---

## Error Design

openFDA returns JSON error objects with `code`, `message`, and sometimes `details`. Map these to actionable tool errors:

| Error | API response | Recovery guidance |
|---|---|---|
| **Malformed query** | `400` — `{"error": {"code": "BAD_REQUEST", ...}}` with Elasticsearch parse details | Surface the parse error. Common causes: unbalanced quotes, invalid field names, wrong boolean syntax (`AND` instead of `+AND+`). Guide agent to fix query syntax. |
| **No results** | `404` — `{"error": {"code": "NOT_FOUND", "message": "No matches found!"}}` | Not an error -- the query was valid but matched nothing. Return empty results with a suggestion to broaden the search (remove filters, check spelling, try `openfda.brand_name` vs `brand_name`). |
| **Skip ceiling** | `400` — `"Skip value must 25000 or less."` | Backstop only — handlers reject an over-ceiling `skip` locally with the typed `pagination_limit_reached` reason before the request goes out. Either path tells the agent to narrow the `search` query (date range, additional filters) instead of increasing skip. |
| **Rate limit** | `429` — Too Many Requests | Without key: 240 req/min, 1K/day per IP. With key: 240 req/min, 120K/day. Retry after backoff. If hitting daily limit, suggest configuring an API key. |
| **Upstream 5xx** | `500`/`503` — `{"error": {"code": "SERVER_ERROR", ...}}` | Transient openFDA/Elasticsearch issue. Retry with exponential backoff (max 3 attempts). If persistent, surface as upstream outage -- not a client issue. |
| **Invalid endpoint** | `404` — no JSON body (plain 404) | The endpoint path doesn't exist. Check for typos in the endpoint enum. |

**Implementation notes:**
- All tools should normalize these into structured error responses with `code`, `message`, and `recovery` fields.
- The `NOT_FOUND` case (valid query, zero results) should not be thrown as an error -- return it as an empty result set with `meta.total: 0`.
- Rate limit handling should be centralized in the service layer with automatic retry + backoff.

---

## Config

| Env var | Required | Description |
|---|---|---|
| `OPENFDA_API_KEY` | No | Free API key from [open.fda.gov](https://open.fda.gov/apis/authentication/). Increases daily limit from 1K to 120K requests. Passed as `api_key` query parameter. |
| `OPENFDA_BASE_URL` | No | Base URL override. Default: `https://api.fda.gov`. Useful for testing against a proxy or mock server. |
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable [DataCanvas staging](#datacanvas-staging-analytical-sql) — analytical SQL over result sets staged with `stage: true` and queried via `openfda_dataframe_query`. Default `none` (disabled). Requires the optional `@duckdb/node-api` dependency; unsupported on Cloudflare Workers. |

---

## References

- [openFDA API Documentation](https://open.fda.gov/apis/)
- [openFDA Query Syntax](https://open.fda.gov/apis/query-syntax/)
- [Authentication & Rate Limits](https://open.fda.gov/apis/authentication/)
- [Drug Adverse Event Fields](https://open.fda.gov/apis/drug/event/searchable-fields/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

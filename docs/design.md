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

**Shared `search` / `sort` contract.** Wherever a tool below takes a caller-supplied `search`, every double quote, parenthesis, and range bracket it opens must close, and it must not end on a backslash — each raises `malformed_search` locally, before the request. Wherever it takes a `sort`, the value is one or more comma-separated field paths (multi-field sort is supported, and spaces around a segment are fine), each optionally suffixed with a direction; a field path holds only letters, digits, underscores, and dots. Where a tool composes a query from a caller-supplied *term* instead — `openfda_drug_profile` — the term is escaped for its phrase context rather than rejected. Grammar, rationale, and boundaries: [Query hygiene](#implementation-notes).

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

## Local bulk mirror

**Opt-in, off by default.** `OPENFDA_MIRROR_ENABLED=false` is the shipped posture and short-circuits before anything opens: `OpenFdaService.query` is the live client and nothing else. Enabling it adds a local-first read path for four datasets; every other endpoint and every ineligible query is untouched.

### Why a mirror, and why this narrow

openFDA allows 240 req/min and 120K/day with a key (1K without). Bulk and repeated-lookup workflows exhaust that, and any 429 blocks every tool. openFDA also publishes whole-dataset JSON dumps at [open.fda.gov/data/downloads](https://open.fda.gov/data/downloads/) with the same record schema the API returns, so a local copy is exact for the records it holds.

**Decision — the mirror answers exact-key lookups only; everything else routes live.** A sibling server in this fleet shipped an equivalent local index and then removed it: openFDA's `search` runs server-side in Elasticsearch, which tokenises and ranks, and a local corpus diverged from live on match counts and result ordering. The gate in `src/services/openfda/mirror/query.ts` keeps the mirror to the class of queries where a SQL equality test provably selects the same documents as the upstream phrase query. All four conditions must hold:

1. the search is a single quoted `field:"value"` term — no boolean operators, wildcards, ranges, or second clause. (Quoting matters: `recall_number:D-321-2016` matches 17,798 documents upstream where `recall_number:"D-321-2016"` matches one, because the bare hyphens parse as operators.)
2. the field is declared in the dataset's `keys` and the value matches its canonical grammar, **case-sensitively**. openFDA's analysed index is case-insensitive; the stored literal is not, so `application_number:"nda017398"` routes live rather than returning a false miss.
3. no `count`, no `sort`, and `skip === 0`. Aggregation and ordering are upstream's to define.
4. the value matches exactly one record. A single record has no order, so a mirrored answer is byte-identical to the API's rather than merely set-equivalent.

**Decision — a multi-record match routes live, narrowing the original page-fits rule.** The first cut of the gate served any match set that fit the requested page, reasoning that a complete set loses nothing but position. It does lose something: openFDA orders an unranked match by Elasticsearch relevance, so `results[0]` and the whole `content[]` rendering differed between mirror and API for the three non-unique keys — a divergence a caller cannot detect. Relevance is server-side and not derivable from the dumps, so the options were to reproduce it (impossible), document it (leaves the hazard in place), or narrow the gate. Narrowing makes the divergence structurally impossible and costs only multi-record lookups. Of the distinct key values in the mirrored corpora, 98.6% of `product_ndc` (133,095 of 134,993) and 69.2% of `event_id` (3,195 of 4,618) address exactly one record and still serve locally. `set_id` is declared non-unique as a conservative posture but is not one in practice — openFDA indexes one current record per SPL set, so across all 260,986 `drug/label` records the most-frequent `set_id` occurs once, and no `set_id` lookup is affected. The keys that lose coverage are the two whose multi-record case is the point of the query: an `event_id` names a recall *event*, and a `product_ndc` with several package configurations lists them all.

**Decision — `openfda_count_values` is never mirrored.** A partial or one-cycle-stale mirror returns a plausible but incomplete tally with no detectable miss, which is worse than a slower correct answer.

### Scope

| Dataset | Primary key | Additional lookup key | Bulk dump |
|---|---|---|---|
| `drug/label` | `id` | `set_id` | 14 partitions |
| `drug/ndc` | `product_id` | `product_ndc` | ~27 MB compressed |
| `drug/enforcement` | `recall_number` | `event_id` | ~3.8 MB compressed |
| `drug/drugsfda` | `application_number` | — | ~9 MB compressed |

Out of scope: `drug/event` and `device/event` (FAERS size warrants its own effort), all device endpoints, food and cosmetic endpoints, and `drug/shortages` (no bulk dump published).

### GMDN licensing carve-out

openFDA data is dedicated to the public domain under CC0 1.0 with one exception: GMDN® Term Code, Term Name, and Term Definition are licensed from The GMDN Agency, and redistribution or AI-training use requires a separate licence. Those terms ride in the device UDI (GUDID) dataset and `device/classification`.

Two layers enforce the exclusion. `MIRRORED_ENDPOINTS` is a closed list of four drug datasets, so no device dump is reachable in the first place. `assertNoGmdnContent` is the backstop: every ingested record is walked for a GMDN-bearing key before it reaches the store, and a hit aborts the sync with the offending path named. An upstream schema change that starts emitting GMDN fields into a drug dataset therefore fails loudly instead of silently writing licensed content to disk. Any future extension to device data needs that licence cleared first.

### Sync model

openFDA publishes no incremental API for these endpoints, so **both `init` and `refresh` re-read every partition**; a refresh whose `export_date` has not advanced past the stored checkpoint returns without downloading anything. Each row carries the export date it was written from, so once every partition has been read the pass tombstones rows an older export left behind. The export date is published as the checkpoint only after the last partition — publishing it earlier would let a later refresh skip work an interrupted run never finished.

A partition is a single-entry ZIP whose JSON unpacks to hundreds of megabytes, so `bulk-stream.ts` holds neither whole: it parses the ZIP local header off the front of the response, inflates the rest through `DecompressionStream`, and runs a depth-aware scanner that emits `results[]` elements as they complete. The reader is strict about the layout openFDA publishes (single entry, deflate, sizes in the header, `results` array closed) — a best-effort parse of an unexpected archive would produce a silently partial mirror.

One SQLite file per dataset (`<slug>.db` under `OPENFDA_MIRROR_PATH`), because the framework's `mirror_sync_state` row is per database and the four datasets have independent lifecycles. A row is the primary key, the lookup columns, the dump's two freshness stamps, and the verbatim upstream record in `raw` — so a mirrored response returns the same JSON the API would. Records with no primary key are unaddressable and are skipped (`drug/enforcement` carries one).

### Lifecycle

**Init runs out-of-band, never at startup** — `bun run mirror:init [dataset...]`, backed by `scripts/openfda-mirror.ts` (`init` / `refresh` / `verify` / `status`). It is idempotent and resumable from the persisted cursor. Refresh is wired to `schedulerService` in `setup()` when `OPENFDA_MIRROR_REFRESH_CRON` is set and the transport is HTTP; a stdio server is a short-lived per-client process, so its operator runs `bun run mirror:refresh` from the host. The cron **skips** any dataset that has never completed an init rather than performing a multi-hour first harvest on a scheduled tick.

### Fallback

The read path gates on the framework's durable completion marker (`mirror.ready()`), which stays true through a refresh, so a mid-refresh or last-refresh-failed mirror keeps serving. `OPENFDA_MIRROR_FALLBACK_LIVE` (default `true`) routes to the API when the mirror is cold, when the store itself fails, and — deliberately — when a lookup matches nothing: a zero-match on a mirror one refresh cycle behind is indistinguishable from a genuine miss, so the API arbitrates. Set it to `false` to raise instead, for a deployment that must not spend API budget.

**`meta.lastUpdated` reports the mirrored dump's own stamp**, which can differ from the live API's for the same endpoint — the API index and the published dumps advance on separate schedules. Reporting the live value would misrepresent the vintage of the data actually being served.

---

## Implementation Notes

**Uniform query layer.** All 15+ openFDA endpoints share identical query mechanics: `search=field:value`, `count=field`, `sort=field:asc|desc`, `limit=N`, `skip=N`. The service layer should implement one generic query function parameterized by endpoint path, with tool handlers providing domain-specific defaults and output formatting.

**Elasticsearch syntax quirks:**
- Boolean: `+AND+`, `+OR+` (URL-encoded spaces). OR is implicit when terms are space-separated.
- Exact matching: field values in quotes (`"aspirin"`). Without quotes, tokenized matching.
- `.exact` suffix on count fields for whole-phrase aggregation vs. tokenized.
- Date ranges: `[20200101+TO+20201231]`.
- Wildcard: `field:aspir*`.
- `sort` takes a comma-separated list, not a single field: `report_date:desc,status.exact:asc` is a working multi-field sort. A bare field path with no direction (`sort=report_date`) is also accepted, and spaces around a segment are trimmed (`a:desc, b:asc` sorts identically to `a:desc,b:asc`).

**Query hygiene — two paths, two mechanisms.** A Lucene query reaching openFDA has one of two origins, and they need opposite treatment. Both are handled in `src/mcp-server/tools/schema-utils.ts` (the caller-written half) and `src/mcp-server/tools/definitions/drug-profile.tool.ts` (the tool-composed half).

| Origin | Tools | Mechanism | Failure |
|---|---|---|---|
| **Caller-written Lucene** — the caller authored the query and owns its syntax | the ten tools taking a `search` and/or `sort` input | **Reject** what is provably malformed, before the request | `malformed_search` for `search`; a schema `ValidationError` for `sort` |
| **Tool-composed Lucene** — the tool built the query from a caller-supplied *term* | `openfda_drug_profile` (seven clauses off one `drug` name) | **Escape** the term for the phrase context it lands in | none — every term produces a well-formed query |

Philosophy: **reject what is provably malformed locally; let openFDA arbitrate what is merely unknown; and never make the caller answer for a query they did not write.** Where the reject line falls is decided by the upstream's own answer, probed against `api.fda.gov` value by value: every value either mechanism refuses is one openFDA refuses outright, with the single recorded exception under [Out of scope](#out-of-scope-deliberately).

### Caller-written: reject

`search` and `sort` were declared as any non-blank string, so a value that cannot be valid still cost a network round-trip and came back as a raw Lucene/Elasticsearch message — a lexer column index past the end of the submitted string, or a mapping error naming a token the caller never meant as a field.

| Input | Check | Where | Failure |
|---|---|---|---|
| `search` | Quotes, parens, and range brackets each close; no trailing escape | `assertSearchDelimitersBalanced`, first lines of each handler | `malformed_search`, naming the specific fault |
| `sort` | Comma-separated `field-path[:direction]` groups | `SORT_EXPRESSION_PATTERN` on the schema, so it reaches the advertised `inputSchema` as `pattern` | Schema `ValidationError` showing the expected form |

**Decision — the `search` check is a three-context scanner, not a character count.** A delimiter means different things in different contexts, and a count is wrong in both directions:

| Context | Opened by | What the delimiters mean | Upstream evidence |
|---|---|---|---|
| Normal | — | `"` opens a phrase, `[`/`{` a range, `(`/`)` group | a `)` or `]`/`}` with no opener is refused; so is a bracket mid-term (`reason_for_recall:foo[bar` → `parse_exception`, since an unquoted `[` is always a range opener) |
| Phrase | `"` | every other delimiter is literal data | `product_description:"Packaged as a) 4 FL OZ"` (one `)`, no `(`) matches a real `drug/enforcement` record |
| Range | `[` or `{`, closed by `]` or `}` | same — literal data | `report_date:[(20200101 TO 20201231]` and `report_date:["20200101 TO 20201231]` are both answered, not refused |

A backslash escapes the next character in every one of the three, ranges included — openFDA answers `Term can not end with escape character` when one eats a range's closing bracket. `product_description:"foo \" bar"` is therefore a valid three-quote query, and `[X TO Y}` closes even though the brackets differ.

**Decision — a trailing backslash is rejected, because the alternative is silently wrong data, not an error.** A `\` at the end of the query has nothing to escape. On endpoints that scope a shared index openFDA appends its own clause, so the escape lands on that clause's leading space rather than on end-of-input: `recalling_firm:pfizer\` on `drug/enforcement` answers **HTTP 200 with 18856 records against 155** for `recalling_firm:pfizer`, because the swallowed space dissolves the appended `product_type:drugs` scope and the caller is served another product type's recalls. On an endpoint with nothing appended the same value is a `token_mgr_error` whose echoed tail is empty — the least actionable shape on the surface. Both are locally detectable from one character. `recalling_firm:pfizer\\` (an escaped backslash) is valid and returns the correct 155.

**Decision — the `sort` check constrains only the field path, never the direction.** openFDA splits a sort segment on its **last** colon and validates the left side against the index mapping; the right side is not validated, so `report_date:ascending` and `report_date:"desc"` both answer 200 (unsorted, but accepted). Narrowing the direction to `asc|desc` would reject working calls, so the pattern accepts any direction token free of `,` and `:`. Excluding `:` is what makes `report_date:desc:asc` reject — its field path becomes `report_date:desc`, which openFDA refuses.

**Decision — spaces around a segment are accepted, spaces inside a field path are not.** openFDA trims a segment before looking it up, so `classification.exact:desc, report_date:asc` returns the same ordering as the space-free form and `  report_date:asc  ` sorts normally; a pattern without the whitespace allowance rejects a working multi-field sort written the way a caller naturally writes a list. The trim does not reach inside the path — `report_date :asc` fails upstream with `No mapping found for [report_date ]` — so the field path itself stays space-free, and a tab (400 upstream) is not accepted either.

**Decision — the `search` check is a handler guard, the `sort` check is a schema `pattern`.** `sort`'s grammar is regex-expressible, so putting it on the schema advertises it in `tools/list` and lets a client self-correct before spending a call. `search`'s balance test is not regex-expressible, and a schema-level rejection carries no `structuredContent.error.data.reason` and none of the declared recovery text — the same reasoning that keeps the pagination ceiling out of a schema `.max()`.

### Tool-composed: escape

`openfda_drug_profile` takes a `drug` name, not a query, and interpolates it into seven quoted phrases. A drug name is not caller-written Lucene, so a name carrying a delimiter is not a caller error and must not surface as one.

**Decision — escape `\` and `"`, never strip them.** `\` is replaced first, since escaping `"` introduces backslashes of its own. Stripping only `"` (the original approach) left a term ending in `\` escaping the phrase's own closing quote, and the two failure shapes were both unusable: a two-clause resolve query answered **HTTP 200 with an unrelated result set** (`openfda.generic_name:"aspirin\" OR openfda.brand_name:"aspirin\"` returns 27,101 label records against 743 for the intended query — the escaped quote pulls ` OR openfda.brand_name:` inside the phrase and the remainder re-parses as a bare term), while a single-clause query left the phrase open and failed as `token_mgr_error`. Escaping keeps every composed query well-formed with the ` OR ` boundary intact.

**Escaping costs nothing in matches, which is why it beats stripping outright.** openFDA's analyzer discards the escaped delimiters as non-word characters, so the escaped term matches whatever the stripped term would have: `drug: 'Tylenol "Extra Strength"'` returns the same 29 label records either way, and `drug: 'aspirin\'` now returns the 743 of a plain `aspirin` search where stripping produced 27,101 unrelated ones. The caller gets results, not a `ValidationError` — and the term reaches openFDA as written rather than silently mutated.

**A term of only delimiters is still rejected.** `blank_drug_name` remains the declared reason, retested as "carries no character that could belong to a drug name" rather than "stripping emptied the string" — searching for the literal delimiters would return an unrelated record set as a profile.

### Out of scope, deliberately

Not guarded, each for a reason rather than by omission:

- **Field names, boolean structure, and non-sortable fields.** `openfda_describe_fields` covers discovery, and openFDA names the field in its own 400 — a full Lucene parser buys nothing.
- **The `^` boost and `~` fuzzy operators.** openFDA refuses them itself with `Search not supported: <the whole query>`, which already names what to remove.
- **A `/.../` term carrying an unbalanced paren.** This is the one place the reject path is wider than openFDA: `reason_for_recall:/undeclared)/` is *accepted* upstream and answers 404 `No matches found!`, while the scanner reads the `)` as an unopened group and refuses it. Adding a fourth context would mean modelling Lucene's regexp grammar to know where the term ends, and the cost of not doing so is bounded — every regexp form probed answers zero matches (the slashes are stripped by the analyzer, so `/undeclared/` and `undeclared` return the identical 379), and the operators that would make a regexp meaningful are refused upstream anyway. A caller loses an empty result set, not data.
- **Anything inside `OpenFdaService`.** The service forwards whatever string it is given; `tests/services/openfda/openfda-service-security.test.ts` asserts that pass-through. `openfda_drug_profile` declares no `malformed_search` reason — it has no caller-written query to reject.

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
| **Malformed delimiters** | none — rejected locally before the request | `malformed_search`. An unterminated `"` phrase, an unbalanced `(`/`)` or `[`/`}` outside one, or a query ending on a backslash never reaches openFDA; the message names which of the six faults it is and how to escape a literal delimiter. The trailing-backslash case would otherwise answer 200 with the endpoint's own scope filter dissolved. See [Query hygiene](#implementation-notes). |
| **Malformed sort shape** | none — rejected by the schema before the request | Schema `ValidationError` showing the expected form. A field path carrying a character no openFDA field path can hold, or an empty comma-separated segment. A well-formed path naming a non-sortable field still goes upstream. |
| **Malformed query** | `400` — `{"error": {"code": "BAD_REQUEST", ...}}` with Elasticsearch parse details | `query_error`. Surface the parse error. Remaining causes after the local prechecks: invalid field names, wrong boolean syntax (`AND` instead of `+AND+`), a non-sortable field. Guide agent to fix query syntax. |
| **Not aggregatable** | `404` `"Nothing to count"`, or `5xx` `illegal_argument_exception` on a `count` query | `not_aggregatable`, naming the expression and the `.exact` correction in whichever direction applies: **drop** the suffix on an identifier field openFDA already indexes as a keyword (the 404), **add** it to tally whole values of an analyzed text field (the 5xx). Some fields have no countable form either way — on `drug/enforcement`, `reason_for_recall` answers the 5xx and `reason_for_recall.exact` answers the 404, so each direction's correction is the other's failure — so both messages name the field catalog as the next step rather than pointing at each other. The upstream `fielddata=true` advice is dropped — it is a server-side index setting no caller can reach. Only `openfda_count_values` declares the reason. |
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
| `OPENFDA_MIRROR_ENABLED` | No | Set to `true` to enable the [local bulk mirror](#local-bulk-mirror). Default `false`. Requires an out-of-band `bun run mirror:init` before it serves anything; on Node, the optional `better-sqlite3` peer dependency. Unsupported on Cloudflare Workers. |
| `OPENFDA_MIRROR_PATH` | No | Directory holding one SQLite file per mirrored dataset. Default `./data/openfda-mirror`. |
| `OPENFDA_MIRROR_REFRESH_CRON` | No | Cron expression for the in-process refresh. HTTP transport only; unset means no scheduled refresh. Requires the optional `node-cron` peer dependency — set without it, the server fails to start. |
| `OPENFDA_MIRROR_FALLBACK_LIVE` | No | Fall back to the live API when the mirror is cold, missing the record, or failing. Default `true`. |
| `OPENFDA_MIRROR_REFRESH_TIMEOUT_MS` | No | Wall-clock budget for one refresh before it is aborted. Default `21600000` (6h). |
| `OPENFDA_MIRROR_BASE_URL` | No | Host serving the bulk download manifest (`download.json`). Default `https://api.fda.gov`. |

---

## References

- [openFDA API Documentation](https://open.fda.gov/apis/)
- [openFDA Query Syntax](https://open.fda.gov/apis/query-syntax/)
- [Authentication & Rate Limits](https://open.fda.gov/apis/authentication/)
- [Drug Adverse Event Fields](https://open.fda.gov/apis/drug/event/searchable-fields/)
- [openFDA Bulk Downloads](https://open.fda.gov/data/downloads/)
- [openFDA License (CC0, with the GMDN exception)](https://open.fda.gov/license/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

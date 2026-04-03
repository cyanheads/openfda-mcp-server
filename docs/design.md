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

### `openfda_search_adverse_events`

Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics. The primary research tool for safety data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | `"drug"` \| `"food"` \| `"device"` | Yes | Product category. Each has different field schemas -- drug reports include patient demographics and suspect drugs, device reports include device details and event type, food reports include industry and outcomes. |
| `search` | string | No | Elasticsearch query string. Field-value pairs joined by `+AND+` or `+OR+`. Examples: `patient.drug.medicinalproduct:"aspirin"`, `patient.reaction.reactionmeddrapt:"nausea"+AND+serious:"1"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Example: `receivedate:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Offset for pagination (max 25000). For deeper access, narrow the search query instead of increasing skip. |

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
| `skip` | number | No | Pagination offset (max 25000). |

**Returns:** `meta` (total count) + array of enforcement/recall records: `recall_number`, `classification` (Class I/II/III), `recalling_firm`, `product_description`, `reason_for_recall`, `distribution_pattern`, `status`, `voluntary_mandated`, dates.

### `openfda_count`

Aggregate and tally unique values for any field across any openFDA endpoint. Use for trend analysis, frequency distributions, and "top N" questions. Returns `[{term, count}]` pairs instead of individual records.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `endpoint` | string | Yes | Full endpoint path. Exhaustive list as of 2026-04: `drug/event`, `drug/label`, `drug/enforcement`, `drug/ndc`, `drug/drugsfda`, `drug/shortages`, `food/event`, `food/enforcement`, `device/event`, `device/510k`, `device/pma`, `device/recall`, `device/enforcement`, `device/classification`, `device/registrationlisting`, `device/udi`, `device/covid19serology`, `animalandveterinary/event`, `other/substance`. New endpoints are rare -- check [open.fda.gov/apis](https://open.fda.gov/apis/) if a category seems missing. |
| `count` | string | Yes | Field to count. Append `.exact` for whole-phrase counting (without it, multi-word values are tokenized). Examples: `patient.reaction.reactionmeddrapt.exact`, `classification`, `openfda.brand_name.exact`. |
| `search` | string | No | Filter query to scope the count. Example: `patient.drug.medicinalproduct:"metformin"` to count reactions only for metformin. |
| `limit` | number | No | Number of top terms to return (default 100, max 1000). |

**Returns:** Array of `{term, count}` objects sorted by count descending. Example: `[{"term": "NAUSEA", "count": 752664}, {"term": "FATIGUE", "count": 742326}]`.

**Count-only endpoints.** Several endpoints are reachable via `openfda_count` but have no dedicated search tool:

| Endpoint | Reason no search tool |
|---|---|
| `drug/shortages` | Small dataset (1.7K records). Count queries cover the main use case (shortage trends by category/company). If individual record lookup proves needed, add a tool later. |
| `animalandveterinary/event` | Niche domain (1.3M records). Count covers trend analysis. A dedicated search tool is a reasonable v2 addition if veterinary safety is in scope. |
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
| `skip` | number | No | Pagination offset (max 25000). |

**Returns:** Label records with structured sections: `indications_and_usage`, `warnings`, `dosage_and_administration`, `contraindications`, `adverse_reactions`, `drug_interactions`, `active_ingredient`, `inactive_ingredient`, `purpose`, `do_not_use`, `pregnancy_or_breast_feeding`, plus `openfda` enrichment (brand name, generic name, manufacturer, route, substance, pharm class, application number).

### `openfda_search_drug_approvals`

Search the Drugs@FDA database for drug application approvals, including NDAs and ANDAs. Use to check if a drug is FDA-approved, find approval dates, review priority status, or explore a sponsor's portfolio.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query string. Examples: `openfda.brand_name:"humira"`, `sponsor_name:"pfizer"`, `submissions.submission_type:"ORIG"+AND+submissions.review_priority:"PRIORITY"`. |
| `sort` | string | No | Sort field and direction. Example: `submissions.submission_status_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset (max 25000). |

**Returns:** Application records: `application_number` (NDA/ANDA), `sponsor_name`, `submissions[]` (type, status, status date, review priority, class code), plus `openfda` enrichment (brand name, generic name, manufacturer, route, substance, product type).

### `openfda_search_device_clearances`

Search FDA device premarket notifications -- 510(k) clearances and PMA (premarket approval) records. Use to verify if a device has been cleared/approved, find predicate devices, or research a company's device portfolio.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pathway` | `"510k"` \| `"pma"` | Yes | Premarket pathway. 510(k) is the most common clearance route (174K+ records). PMA is for higher-risk devices requiring clinical evidence. |
| `search` | string | Yes | Query string. Examples: `applicant:"medtronic"`, `advisory_committee_description:"cardiovascular"`, `product_code:"DXN"`, `openfda.device_name:"catheter"`. |
| `sort` | string | No | Sort field. Example: `decision_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset (max 25000). |

**Returns:** 510(k): `k_number`, `applicant`, `device_name`, `product_code`, `decision_date`, `decision_description`, `advisory_committee`, `statement_or_summary`. PMA: `pma_number`, `applicant`, `advisory_committee`, `product_code`, `decision_date`, `decision_code`.

### `openfda_lookup_ndc`

Look up drugs in the NDC (National Drug Code) Directory. Use to identify drug products by NDC code, find active ingredients and strengths, packaging details, or manufacturer information.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query string. Examples: `product_ndc:"0363-0218"`, `brand_name:"aspirin"`, `generic_name:"metformin"`, `openfda.manufacturer_name:"walgreen"`, `active_ingredients.name:"ASPIRIN"`. |
| `sort` | string | No | Sort field and direction. Example: `listing_expiration_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). |
| `skip` | number | No | Pagination offset (max 25000). |

**Returns:** NDC records: `product_ndc`, `brand_name`, `generic_name`, `labeler_name`, `active_ingredients[]` (name, strength), `dosage_form`, `route`, `marketing_category`, `packaging[]` (package NDC, description), `finished` flag, `listing_expiration_date`, plus `openfda` enrichment (manufacturer, rxcui, pharm class, UPC).

---

## Implementation Notes

**Uniform query layer.** All 15+ openFDA endpoints share identical query mechanics: `search=field:value`, `count=field`, `sort=field:asc|desc`, `limit=N`, `skip=N`. The service layer should implement one generic query function parameterized by endpoint path, with tool handlers providing domain-specific defaults and output formatting.

**Elasticsearch syntax quirks:**
- Boolean: `+AND+`, `+OR+` (URL-encoded spaces). OR is implicit when terms are space-separated.
- Exact matching: field values in quotes (`"aspirin"`). Without quotes, tokenized matching.
- `.exact` suffix on count fields for whole-phrase aggregation vs. tokenized.
- Date ranges: `[20200101+TO+20201231]`.
- Wildcard: `field:aspir*`.

**Pagination ceiling.** `skip` maxes at 25000. For datasets larger than `skip + limit`, the agent must narrow the search query (e.g., date ranges, additional filters) rather than paginating further. Tools should surface this constraint in error messages when hit.

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
| **Skip ceiling** | `400` — `"Skip value must 25000 or less."` | Inform the agent the pagination limit is reached. Suggest narrowing the `search` query (e.g., add date range, additional filters) instead of increasing skip. |
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

---

## References

- [openFDA API Documentation](https://open.fda.gov/apis/)
- [openFDA Query Syntax](https://open.fda.gov/apis/query-syntax/)
- [Authentication & Rate Limits](https://open.fda.gov/apis/authentication/)
- [Drug Adverse Event Fields](https://open.fda.gov/apis/drug/event/searchable-fields/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

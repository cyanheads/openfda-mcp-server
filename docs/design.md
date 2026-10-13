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

**Shared `search` / `sort` contract.** Wherever a tool below takes a caller-supplied `search`, every double quote, parenthesis, and range bracket it opens must close, and it must not end on a backslash — each raises `malformed_search` locally, before the request. Wherever it takes a `sort`, the value is one or more comma-separated field paths (multi-field sort is supported, and spaces around a segment are fine), each optionally suffixed with `:asc` or `:desc` — in any letter case, with `ascending` and `descending` also accepted, each sent upstream as lowercase `asc` or `desc`; a field path holds only letters, digits, underscores, and dots, and any other direction is rejected. Where a tool composes a query from a caller-supplied *term* instead — `openfda_drug_profile` — the term is escaped for its phrase context rather than rejected. Grammar, rationale, and boundaries: [Query hygiene](#implementation-notes).

**Shared size contract.** Each of the eight multi-row search tools bounds its page of upstream records at 24,000 serialized bytes and discloses any it withheld, or the size and largest fields of a single record that exceeds it; `openfda_get_drug_label` measures the same budget but returns a section outline instead, because its payload is one document rather than many rows. Both are described under [Response size](#response-size), along with the tools the budget does not reach.

### `openfda_drug_profile`

Resolve one drug name to its FDA identity, then fan out in parallel to the bounded per-drug endpoints and merge into a single consolidated profile. Replaces chaining `openfda_get_drug_label`, `openfda_search_adverse_events`, `openfda_search_recalls`, `openfda_search_drug_approvals`, and `openfda_search_drug_shortages`, and reconciles the identifier drift between endpoints that makes that chaining error-prone.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `drug` | string | Yes | Drug name — brand or generic (e.g. `metformin`, `Humira`). Resolved once to canonical FDA identifiers, which then key every sub-query. |

`drug_name` and `name` are accepted as aliases of `drug` (`inputAliases`), rewritten before validation and never advertised — `drug` stays the only parameter in `inputSchema`. An alias sent alongside `drug` is rejected as an unknown key.

**Behavior.** Resolves the name against `drug/label` (falling back to `drug/ndc`), picking the best single-ingredient match — combination products are de-prioritized so a single-drug query doesn't resolve to a combo. Structured endpoints (`drug/enforcement`, `drug/drugsfda`, `drug/shortages`) then query by the canonical `openfda.generic_name`; the free-text adverse-event field (`drug/event` `patient.drug.medicinalproduct`) queries by the supplied term for better recall. Each section is best-effort: a failed or empty sub-query yields `null` (or `[]` for recalls) rather than failing the whole call. The adverse-event section takes three `drug/event` sub-queries for the same search — a `limit=0` request whose `meta.results.total` is the section's `total`, the `serious` tally, and the top-reaction tally — and is `null`, with one `adverse_events` entry in `degraded`, when any of the three fails. A profile costs 7 upstream requests when the label resolves the drug and 8 when it falls back to `drug/ndc`.

**Returns:** `meta` (echoed `drug`, `resolvedVia`) + `identity` (`brand_names`, `generic_name`, `product_ndc`, `rxcui`, `spl_set_id`) + `label` (`indications`, `warnings`, `dosage`) + `adverse_events` (`total`, `seriousCount`, `topReactions[]`) + `recalls[]` (`classification`, `reason`, `recalling_firm`, `date`) + `approval` (`applicationNumber`, `sponsor`, `marketingStatus`) + `shortage` (`status`, `availability`). Sections are `null` when unavailable. `adverse_events.total` counts every report the search matches, those with no seriousness recorded included, so it equals `openfda_search_adverse_events` `meta.total` for `patient.drug.medicinalproduct:"<drug>"`; `seriousCount` is the `serious=1` bucket.

**Decision — the adverse-event total is a `limit=0` search, not a sum of `serious` buckets.** A count response carries no total, and the buckets cover only reports that record a `serious` value — metformin's sum fell 106 short of its match total, aspirin's 257. One extra request per profile buys the exact figure; a `seriousnessUnknown` field was not added, since `total − seriousCount` already includes those reports and the `total` description says so.

### `openfda_search_adverse_events`

Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics. The primary research tool for safety data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | `"drug"` \| `"food"` \| `"device"` | Yes | Product category. Each has different field schemas -- drug reports include patient demographics and suspect drugs, device reports include device details and event type, food reports include industry and outcomes. |
| `search` | string | No | Elasticsearch query string. Field-value pairs joined by `+AND+` or `+OR+`. Examples: `patient.drug.medicinalproduct:"aspirin"`, `patient.reaction.reactionmeddrapt:"nausea"+AND+serious:"1"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Sortable date fields are category-specific: drug → `receivedate:desc` (or `receiptdate`), food → `date_created:desc` (or `date_started`), device → `date_received:desc` (or `date_of_event`). A field from another category (e.g. `receivedate` on food or device) causes a query error. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`; for deeper access, narrow the search query instead. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `patient.drug.medicinalproduct`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** `meta` (total count, skip, limit) + array of adverse event records. Drug records include `safetyreportid`, `patient` (age, sex, reactions[], drugs[]), `serious` flag, `receivedate`. Device records include `report_number`, `device[]` (brand, generic name, manufacturer), `event_type`. Food records include `reactions`, `outcomes`, `products`.

### `openfda_search_recalls`

Search enforcement reports and recall actions across drugs, food, and devices. Use to investigate product recalls, check a company's compliance history, or find safety actions by classification severity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | `"drug"` \| `"food"` \| `"device"` | Yes | Product category. Drug and food use `/enforcement` endpoints. Device has both `/recall` (detailed recall data) and `/enforcement` (enforcement actions). |
| `endpoint` | `"enforcement"` \| `"recall"` | No | Default `enforcement`. `recall` is only valid for devices and includes additional fields like `res_event_number` and root cause analysis. |
| `search` | string | No | Query string. Examples: `classification:"Class+I"`, `recalling_firm:"pfizer"`, `reason_for_recall:"undeclared+allergen"`. |
| `sort` | string | No | Sort field and direction. Example: `report_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `recalling_firm`, `reason_for_recall`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** `meta` (total count) + an array of records whose field set depends on the endpoint:

- **Enforcement** (`drug`/`food`/`device` `/enforcement`): `recall_number`, `classification` (Class I/II/III), `recalling_firm`, `product_description`, `reason_for_recall`, `distribution_pattern`, `status`, `voluntary_mandated`, dates.
- **Device recall** (`device/recall`): `product_res_number`, `res_event_number`, `recall_status`, `root_cause_description`, `recalling_firm`, `product_description`, `reason_for_recall`, `distribution_pattern`, `event_date_initiated`/`event_date_posted`. No recall hazard classification — `openfda.device_class` is the product's regulatory device class.

**Decision — `format()` picks its header by record shape.** `format()` never sees the `endpoint` input, so a record carrying `product_res_number` renders its identity and `recall_status` from those fields; every other record takes the enforcement header unchanged. Rendering a device recall through the enforcement header printed `Recall #N/A — Unclassified` over a record that carries both values under its own names.

### `openfda_count_values`

Aggregate and tally unique values for any field across any openFDA endpoint. Use for trend analysis, frequency distributions, and "top N" questions. Returns `[{term, count}]` pairs instead of individual records.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `endpoint` | string | Yes | Full endpoint path. Exhaustive list as of 2026-04: `drug/event`, `drug/label`, `drug/enforcement`, `drug/ndc`, `drug/drugsfda`, `drug/shortages`, `food/event`, `food/enforcement`, `device/event`, `device/510k`, `device/pma`, `device/recall`, `device/enforcement`, `device/classification`, `device/registrationlisting`, `device/udi`, `device/covid19serology`, `animalandveterinary/event`, `tobacco/problem`, `other/substance`. New endpoints are rare -- check [open.fda.gov/apis](https://open.fda.gov/apis/) if a category seems missing. |
| `count` | string | Yes | Field to count — the `countAs` expression `openfda_describe_fields` lists for the field. Outside the catalog: append `.exact` to an analyzed text field (openFDA refuses to aggregate it bare), count a keyword field bare. Examples: `patient.reaction.reactionmeddrapt.exact`, `classification.exact`, `product_ndc`. |
| `search` | string | No | Filter query to scope the count. Example: `patient.drug.medicinalproduct:"metformin"` to count reactions only for metformin. |
| `limit` | number | No | Number of top terms to return (default 100, max 1000 — openFDA answers a count `limit` above 1000 with HTTP 400). |

**Returns:** Array of `{term, count}` objects sorted by count descending. Example: `[{"term": "NAUSEA", "count": 752664}, {"term": "FATIGUE", "count": 742326}]`.

**Decision — truncation comes from a look-ahead term.** Count responses carry no distinct-term total in `meta`, so the handler requests `min(limit + 1, 1000)` terms and returns the first `limit`. `truncated` (with `shown`, `cap`, `truncationCeiling`) is set only when the extra term arrived — it costs no request, and ranking is stable between `limit` and `limit + 1`. Treating exactly `limit` rows as truncated reported a complete list (a binary field at `limit: 2`) as capped. At `limit: 1000` no look-ahead fits, so a full 1000-term list omits `truncated` and the `notice` says openFDA cannot show whether more distinct values exist; narrowing with `search` is the way past it.

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
| `limit` | number | No | Results to return (1-1000, default 5). Labels are large -- keep limit low unless browsing; a section's retrieval cost is summed across the page, so it scales with this limit. |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `sections` | string[] | No | Top-level label sections to return, e.g. `["boxed_warning","indications_and_usage"]`. Omit for the whole label; an empty list is treated as omitted. Returned whole even when the projection clears the inline budget, with its serialized size reported on the notice. |

**Returns:** `meta`, a `kind` discriminator, and one of two arms.

`kind: "full"` carries `results[]` — label records with structured sections: `indications_and_usage`, `warnings`, `dosage_and_administration`, `contraindications`, `adverse_reactions`, `drug_interactions`, `active_ingredient`, `inactive_ingredient`, `purpose`, `do_not_use`, `pregnancy_or_breast_feeding`, plus `openfda` enrichment (brand name, generic name, manufacturer, route, substance, pharm class, application number).

**Outline on overflow.** This is the one-document half of the shared [size contract](#response-size); the eight multi-row search tools bound a page of records instead. A single SPL record runs to tens of thousands of tokens — a warfarin label is ~130 KB across 36 top-level keys, of which ~39 KB is `*_table` SPL table markup. The tables are not generally restated in the adjacent prose: warfarin's genotype dosing grid and trial results exist only in table form. Trimming only `format()` would desync `content[]` from `structuredContent`, so the size lever is caller-driven instead, via the framework's `outlineOnOverflow` helper (`@cyanheads/mcp-ts-core/utils`):

- With `sections`, each record is projected to the requested keys plus the always-kept metadata (`openfda`, `set_id`, `id`, `effective_time`, `version`) and returned as `kind: "full"`. A name no record on the page carries is reported on `enrichment.notice` — with the names the page does carry when nothing matched at all, since a typo and a genuinely absent section otherwise produce the same metadata-only record. A projection over the budget is returned whole and reports its serialized size on the same notice.
- Without `sections`, the page is measured against the helper's 24,000-byte budget. Under it, the records come back whole. Over it, the response is `kind: "outline"` with `outline[]` — every section name present on the page and its serialized size, largest first — and the re-call guidance on `enrichment.notice`. The re-call is stateless: the same `search` plus `sections` reproduces the record and slices it.

Every size this tool reports — `outline[]` entries, the worked example's figure, a selection's size — is UTF-8 bytes of the serialized JSON, as the search tools' page budget measures it; label text is often non-ASCII, where JavaScript string length undercounts the bytes on the wire. The whole-or-outline threshold itself is the helper's, which measures string length, so a page whose string length fits the budget comes back whole even when its multi-byte text takes it over the budget in UTF-8 bytes.

**Sizes are per page, not per record, so the guidance is measured rather than asserted.** An `outline[]` entry sums its section across every record on the page, so a section's retrieval cost is a function of `limit` and cannot be read off the section alone. The re-call guidance therefore projects candidate sections at this page's record count and names the largest one that measures within the budget, quoting that byte figure inline — following the notice returns exactly what it claims. Two candidates are skipped: the always-kept metadata keys, which ride every response, and the page's single most expensive section, since offering it as the worked example would recommend the one re-call the outline exists to head off. When metadata alone clears the budget — 40 metformin records carry ~31 KB of it — no example can fit, and the notice says so and points at `limit`.

**Decision — the outline arm is a deliberate default-path change.** Before this, a `structuredContent` reader always got the complete label for any query that matched. Complex prescription drugs overflow the budget by 5-10x, so those queries now return an outline until the caller names sections. Bounding the default payload is the point: the alternative (one-sided `format()` truncation) hid the same data from `content[]` clients while claiming completeness.

**Decision — `*_table` sections render as Markdown tables in `content[]`, raw in `structuredContent`.** openFDA ships each `*_table` value as SPL table markup — `<table>`, `<content styleCode>`, `colspan`/`rowspan`, numeric entities — about 73% markup by character count. `format()` renders each string as a GFM pipe table (`src/mcp-server/tools/spl-table.ts`): entities decoded, spans expanded to a rectangular grid with the value in its origin cell, the caption above, `<tfoot>` rows and `[^n]:` footnote definitions below (numbered in one sequence across every table, section, and record in the response, so no label repeats; footnote IDs stay scoped to their table), `<sup>`/`<sub>` kept as `^`/`_`, and paragraphs or list items inside a cell joined by `<br>`. Markup that does not parse as balanced falls back to its decoded text. `structuredContent` keeps the provider string so the outline and selection byte figures measure what the caller receives there, and prose sections are never touched — some carry literal angle-bracket text (`<E050800>` in `inactive_ingredient`) that a markup pass would delete. No framework utility decodes SPL entities or renders these tables without optional peers, so the renderer is a small in-repo tokenizer with no new dependency.

**Decision — an over-budget `sections` selection is disclosed, never trimmed.** The selection path is the caller's own size decision, so it stays unconditional: `kind` remains `"full"`, every requested key is returned whole, and no content is stripped. What it adds is honesty about cost — the serialized size on `enrichment.notice`, which reaches `structuredContent` as `notice` and `content[]` as the enrichment trailer, so neither surface can read as in-budget when it isn't. Truncating or restructuring that arm to fit the budget would trade one silent failure for another: a caller who asked for `clinical_pharmacology_table` across ten records is asking for ~203 KB, and the useful answer is the payload plus its price, not a shortened payload.

### `openfda_search_drug_approvals`

Search the Drugs@FDA database for drug application approvals, including NDAs and ANDAs. Use to check if a drug is FDA-approved, find approval dates, review priority status, or explore a sponsor's portfolio.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query string. Examples: `openfda.brand_name:"humira"`, `sponsor_name:"PFIZER"`, `submissions.submission_type:"ORIG"+AND+submissions.review_priority:"PRIORITY"`. Exact quoted values can be case-sensitive on some fields — `sponsor_name` is stored uppercase, so a lowercase quoted value returns no matches. |
| `sort` | string | No | Sort field and direction. Example: `submissions.submission_status_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `sponsor_name`, `submissions.submission_status_date`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** Application records: `application_number` (NDA/ANDA), `sponsor_name`, `submissions[]` (type, status, status date, review priority, class code), plus `openfda` enrichment (brand name, generic name, manufacturer, route, substance, product type).

### `openfda_search_device_clearances`

Search FDA device premarket notifications -- 510(k) clearances and PMA (premarket approval) records. Use to verify if a device has been cleared/approved, find predicate devices, or research a company's device portfolio.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pathway` | `"510k"` \| `"pma"` | Yes | Premarket pathway. 510(k) is the most common clearance route (174K+ records). PMA is for higher-risk devices requiring clinical evidence. |
| `search` | string | Yes | Query string. Examples: `applicant:"medtronic"`, `advisory_committee_description:"cardiovascular"`, `product_code:"DXN"`, `openfda.device_name:"catheter"`. |
| `sort` | string | No | Sort field. Example: `decision_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `decision_date`, `applicant`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** 510(k): `k_number`, `applicant`, `device_name`, `product_code`, `decision_date`, `decision_description`, `advisory_committee`, `statement_or_summary`. PMA: `pma_number`, `applicant`, `advisory_committee`, `product_code`, `decision_date`, `decision_code`.

### `openfda_lookup_ndc`

Look up drugs in the NDC (National Drug Code) Directory. Use to identify drug products by NDC code, find active ingredients and strengths, packaging details, or manufacturer information.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | Yes | Query string. Examples: `product_ndc:"0363-0218"`, `brand_name:"aspirin"`, `generic_name:"metformin"`, `openfda.manufacturer_name:"walgreen"`, `active_ingredients.name:"ASPIRIN"`. |
| `sort` | string | No | Sort field and direction. Example: `listing_expiration_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `brand_name`, `active_ingredients.name`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** NDC records: `product_ndc`, `brand_name`, `generic_name`, `labeler_name`, `active_ingredients[]` (name, strength), `dosage_form`, `route`, `marketing_category`, `packaging[]` (package NDC, description), `finished` flag, `listing_expiration_date`, plus `openfda` enrichment (manufacturer, rxcui, pharm class, UPC).

### `openfda_search_animal_events`

Search adverse event reports for veterinary drugs and devices. Use to investigate safety signals for veterinary products, find reports by animal species or drug, or explore reaction patterns.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | openFDA query syntax. Examples: `animal.species:"Dog"`, `drug.active_ingredients.name:"Fluralaner"`, `reaction.veddra_term_name:"Vomiting"`, `serious_ae:"true"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Example: `original_receive_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `original_receive_date`, `animal.species`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** Animal adverse event records: `unique_aer_id_number`, `original_receive_date`, `serious_ae`, `animal` (species, gender, breed, age, weight), `drug[]` (brand_name, active_ingredients, route, dose, administered_by), `reaction[]` (veddra_term_name, number_of_animals_affected), `outcome[]` (medical_status), `primary_reporter`, `type_of_information`.

**Decision — masked brand names are named, never searched.** openFDA stores `MSK` (FDA's "masked" null flavor) as `drug.brand_name` and `drug.manufacturer.name` on every animal event record, so a brand filter returns zero reports that read as a negative safety finding. The tool description, the catalog notes, and the empty-result notice (when the search names either masked field) steer callers to `drug.active_ingredients.name` searched unsuffixed — `.exact` misses the product-form values (`Fluralaner Chew Tablets`) — and to `drug.manufacturer.registration_number`, the only field that narrows to one approval. `content[]` leads each drug line with its ingredient names and labels the brand `brand masked: MSK`, and a masked manufacturer renders as `**Manufacturer:** name masked: MSK; registration_number=…`; `structuredContent` keeps the raw `brand_name` and `manufacturer.name` (`"MSK"`). A `fields`-projected record renders verbatim, raw `MSK` included.

### `openfda_search_drug_shortages`

Search FDA drug shortage records. Returns per-product shortage status, availability notes, therapeutic category, dosage form, manufacturer, and timeline. The `openfda` block carries cross-reference IDs for chaining into `openfda_get_drug_label` or `openfda_lookup_ndc`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | Elasticsearch query. Examples: `status:"Current"`, `therapeutic_category:"Oncology"`, `generic_name:"carboplatin"`, `company_name:"pfizer"`. Omit to browse all. |
| `sort` | string | No | Sort field and direction. Example: `update_date:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `generic_name`, `status`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** Shortage records with `generic_name`, `status` (Current, To Be Discontinued, or Resolved), `availability`, `therapeutic_category`, `dosage_form`, `presentation`, `package_ndc`, `company_name`, `contact_info`, `initial_posting_date`, `update_date`, `update_type`, plus `openfda` block (`brand_name`, `product_ndc`, `rxcui`, `spl_set_id`).

### `openfda_describe_fields`

Return the searchable field paths for an openFDA endpoint, grouped by category with type, count expression, and description. Use before constructing a search query to discover correct dotted field names, and before `openfda_count_values` to pick a countable one. Covers all 20 endpoints `openfda_count_values` accepts.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `endpoint` | enum | Yes | One of the cataloged endpoint paths (e.g. `drug/event`, `drug/shortages`, `device/510k`). |

**Returns:** `groups[]` with `label`, `fields[]` (path, type, countAs, note); plus `queryTips` covering syntax reminders. `countAs` is the expression that aggregates the field — the bare path or `path.exact` — or `null` when neither does.

**Decision — count forms are recorded, not derived.** Each catalog entry carries `countable: bare | exact | both | none`, set by probing `count=<path>` and `count=<path>.exact` against the live API. openFDA's published `fields.yaml` can't produce it: its `is_exact: false` string fields split between keyword fields that count bare and analyzed text with no keyword subfield, which counts in neither form. Probing at runtime was rejected as the primary source — a scoped `Nothing to count` is a data-level signal, and an unscoped count costs 3–5 s on the large indexes (`drug/event`, `device/event`) — so the unscoped probe runs only as the fallback confirm for an expression outside the catalog. A test fails when an entry lacks the annotation; an openFDA index remap needs a re-probe.

**Reactive enrichment.** All search tools populate the `notice` enrichment field with a compact field hint when results are empty or a query is rejected — same catalog, reactive path. This catches agents that don't call `openfda_describe_fields` proactively.

### `openfda_search_tobacco_reports`

Search problem reports submitted to the FDA for tobacco products, including e-cigarettes, vaping products, cigarettes, and smokeless tobacco. Use to investigate safety signals, find reports by product type, or analyze health effects.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `search` | string | No | openFDA query syntax. Examples: `tobacco_products:"Electronic cigarette"`, `reported_health_problems:"Seizure"`, `nonuser_affected:"Yes"`. Omit to browse recent reports. |
| `sort` | string | No | Sort field and direction. Example: `date_submitted:desc`. |
| `limit` | number | No | Results to return (1-1000, default 10). An upper bound: the page is also bounded at 24,000 serialized bytes, and a page that overruns it returns fewer records and reports the cut on `page_omitted`. See [Response size](#response-size). |
| `skip` | number | No | Pagination offset. Above 25000 the handler raises `pagination_limit_reached`. |
| `fields` | string[] | No | Dotted record paths to keep on each record (e.g. `date_submitted`, `reported_health_problems`), plus its identity key; a path through an array applies to every element, and records are projected before the page is measured. A path no record on the page carries is named on the notice. Omit for whole records. See [Field selection](#field-selection-fields). |

**Returns:** Tobacco problem reports: `report_id`, `date_submitted`, `tobacco_products[]` (product type description), `reported_health_problems[]` (health effects), `reported_product_problems[]` (device/product defects), `number_tobacco_products`, `number_health_problems`, `number_product_problems`, `nonuser_affected`.

### `openfda_dataframe_query`

Run a read-only SQL `SELECT` against a DataCanvas table staged by a search tool (see [DataCanvas staging](#datacanvas-staging-analytical-sql)). Enables `GROUP BY`, `COUNT/SUM/AVG`, time-series, and joins across the staged result set without re-paging the API.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `canvas_id` | string | Yes | Canvas ID from a search tool response (present when the search ran with `stage: true`) — 10 URL-safe characters, declared with the framework's `CanvasIdSchema`. |
| `query` | string | Yes | SQL `SELECT`. Use the table name from `openfda_dataframe_describe`. Scalar columns are text (`CAST` for numeric math); nested objects/arrays are JSON columns (e.g. `json_extract_string(openfda, '$.brand_name[0]')`). |

**Returns:** `rows[]`, `row_count`, `truncated`, `canvas_id`. Results are capped at the canvas row limit (10,000 by default); `truncated: true` says rows beyond the cap exist and both response paths point at `ORDER BY` + `LIMIT`/`OFFSET` pagination. Only `SELECT` is allowed — DDL/DML/COPY/file-reading functions are rejected by the framework's five-layer SQL gate, and those rejections are mapped onto the tool's own `invalid_query` / `missing_table` contract so recovery text names MCP tools rather than internal canvas APIs. A `SELECT` that prepares and then fails on a staged value (DuckDB's `sql_execution_error`, typically a `CAST` over text that does not convert) maps onto `invalid_query` too, keeping the engine message and pointing at `TRY_CAST`.

### `openfda_dataframe_describe`

List the tables and column schemas on a DataCanvas. Call before `openfda_dataframe_query` to discover the exact table and column names. `row_count` is the full staged set, not the inline page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `canvas_id` | string | Yes | Canvas ID from a search tool response — 10 URL-safe characters (`CanvasIdSchema`). |

**Returns:** `tables[]` (`name`, `kind`, `row_count`, `columns[]` of `name`/`type`/`nullable`), `canvas_id`.

### `openfda_dataframe_drop`

Delete one table or view from a DataCanvas, leaving the canvas and its other tables in place. Opt-in: registered as callable only when `OPENFDA_DATAFRAME_DROP_ENABLED=true`; otherwise wrapped in `disabledTool()`, so it stays on the landing page with the enable hint and is skipped at MCP registration.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `canvas_id` | string | Yes | Canvas ID from a search tool response — 10 URL-safe characters (`CanvasIdSchema`). |
| `table` | string | Yes | Table or view name as `openfda_dataframe_describe` lists it; must match the framework's `CANVAS_IDENTIFIER_REGEX`. |

**Returns:** `canvas_id`, `table`, `remaining_tables[]`. A table that is not on the canvas (already dropped, expired, or mistyped) fails as `missing_table`; an unknown canvas as `canvas_not_found`.

**Decision — drop is off by default.** Possession of a `canvas_id` is the only access control on a canvas, so a drop tool lets any holder of the id delete data another caller staged. The surface stays read-only unless the operator opts in; staged tables otherwise age out on the canvas TTL.

---

## Response size

A response the caller cannot hold is not a successful response. openFDA payload size is driven by the upstream record shape, not by anything the caller can see in advance: a `drug/event` report averages ~34 KB and individual reports pass 250 KB, a single `device/recall` record can exceed 4 MB (one serial-number list in `code_info`), while a `food/event` report is ~440 bytes, so `limit: 10` spans three orders of magnitude across the surface and one record can outweigh the whole budget. Every tool that hands back upstream records therefore measures what it is about to return against one 24,000-byte serialized budget — the framework's `DEFAULT_OUTLINE_BUDGET_BYTES` — and one budget means one threshold a caller can reason about.

The budget is enforced differently depending on the payload's shape, because the two record-bearing shapes have different escape hatches:

| Shape | Tools | Technique |
|---|---|---|
| One large document | `openfda_get_drug_label` | Section outline plus a stateless `sections` re-call — see [Outline on overflow](#openfda_get_drug_label) |
| Many rows | the eight multi-row search tools | Bounded page plus disclosure and the routes to the rest, and a `fields` projection for records too large to shrink by count (below) |
| Aggregate | `openfda_count_values`, `openfda_describe_fields` | Not measured — a term-count pair and a field entry are fixed-width, so `limit` alone prices the response (1000 terms is ~44 KB, the default 100 is ~4 KB) |
| Composed / caller-shaped | `openfda_drug_profile`, `openfda_dataframe_query` | Not measured — a profile is a fixed set of bounded sections, and a SQL result is the caller's own projection |

### Bounded page (many rows)

`src/services/openfda/page-budget.ts` measures the `limit`/`skip` window record by record and drops records from its tail until the serialized array fits the budget. Every size is UTF-8 bytes of the serialized JSON — the size on the wire, not JavaScript string length, which undercounts multi-byte text (one device recall's `code_info` holds over 529,000 non-ASCII characters). What is withheld is disclosed on both surfaces at once — `page_bytes` and `page_omitted` in the response body, the same sentence rendered into `content[]` and onto `enrichment.notice` — and it names the routes to the withheld records: the exact `skip` the next window starts at, a lower `limit` (named only when the page holds more than one record — `limit: 1` returns the same one-record page), a `fields` projection, record-level SQL over the staged drain (the notice says `stage: true` on an unstaged call and points at the table on a staged one), and `openfda_count_values` for a distribution without records at all.

Every over-budget page is disclosed, not only one that dropped records. When the one record a page keeps exceeds the budget on its own — a by-ID lookup, `limit: 1`, the last record of a match — `page_bytes` reports its size with no `page_omitted`, `page_largest_fields` carries that record's largest fields by dotted path and serialized size, and the notice names them (array elements totalled into one path, so `patient.drug.openfda` across all of a report's drugs) plus the `fields` re-call. The path drills to the deepest field that alone holds the overrun — `patient.drug.openfda`, not `patient`, which a caller cannot leave out without losing the reactions it came for; when no single field holds it, the largest top-level fields are listed (at most three) until they do. Presence rule: `page_bytes` appears when records were dropped or the page exceeds the budget, `page_omitted` only when records were dropped, `page_largest_fields` only when the page exceeds the budget, and none on a page that fits, which returns exactly `{ meta, results }`.

**Decision — the budget is universal, not an allowlist of large endpoints.** Measured single-record averages put five endpoints over the budget at the default `limit: 10` — `drug/event` (~34,200 B/record), `device/recall` (~8,100), `device/enforcement` (~7,200), `device/event` (~6,000), `device/510k` (~4,300) — with `drug/drugsfda` (~2,400) sitting on the line. An allowlist drawn from that list would still leave every other tool open, because `limit` reaches 1000 everywhere: the smallest-record endpoints on the surface overflow at high limits, and a live `limit: 1000` call returns 50 of 1000 `tobacco/problem` records and 53 of 1000 `food/event` records. A per-endpoint threshold would also go stale silently the first time openFDA changes a record shape, whereas a measured page cannot.

**Decision — bound the page, do not merely disclose its size.** Disclosure alone would arrive inside the payload that already overran the caller's context, which describes the problem rather than fixing it. #18, #30, and #31 constrain how the bound may work, and reading their text closely, they permit it: #18 asked for `min(limit, budget-fit)` rows in as many words, and #31 asked that the page "guarantees at least one record when any matched." What those issues forbade was `limit` being *silently* overridden (a `limit: 3` call answering with 34 records) and a page *emptied* by record size (a real match rendering as "No results found."). So the bound never exceeds `limit`, never returns zero records when one matched, and states every cut in `content[]` as well as in `structuredContent` — the three properties those fixes established, intact.

**Decision — a single oversized record is returned whole, and the overrun is stated.** When the first record alone clears the budget it is kept, `page_bytes` reports a figure above the budget, and the disclosure says why — whether or not other records were dropped beside it, since lowering `limit` cannot shrink one record. Emptying the page is the failure #31 fixed; trimming *within* a record unasked is worse still, because `structuredContent` and `content[]` derive from the same array — a partial record would either desync the two surfaces or hand back a record whose missing fields are indistinguishable from openFDA's own sparsity. The caller-requested `fields` projection (below) is the way to a smaller record. Replacing an over-budget record with a field outline, the `openfda_get_drug_label` pattern, was rejected: it would put `results: []` in `structuredContent` for a real match, change the default response, and still need `fields` for the re-call.

**Decision — the oversized record is measured once and the breakdown rides the response.** `format()` receives a schema-parsed copy of the result and no context, so it cannot read the handler's notice; re-measuring there walked a multi-megabyte record a second time. `pageBudgetFields()` measures it once and carries the result as `page_largest_fields`, and both the notice and the `content[]` line render from that field.

**Decision — the page is measured, the drain is estimated.** [DataCanvas staging](#datacanvas-staging-analytical-sql) derives its row cap from an average taken over a 100-row probe, because the rows it bounds have not been fetched yet. The inline page is already in hand, so it is measured record by record instead: `drug/event`'s median record is ~6 KB against its ~34 KB mean, so an average would misprice the very page it is meant to bound. The two budgets are deliberately separate — ~16 MB for the drain, 24,000 bytes for the page — because one feeds a SQL table and the other feeds a context window.

### Field selection (`fields`)

Each of the eight multi-row search tools takes an optional `fields`: dotted record paths (`receivedate`, `patient.drug.medicinalproduct`). `src/services/openfda/record-projection.ts` projects each record to those paths plus its identity key before the page is measured, so the budget prices what the caller receives, and both surfaces carry the same projected records. Without `fields`, records come back whole.

| Tool | Identity key(s) kept on every projected record |
|---|---|
| `openfda_search_adverse_events` | `safetyreportid` (drug), `report_number` (food, device), `mdr_report_key` (device) |
| `openfda_search_recalls` | `recall_number` (enforcement), `product_res_number` (device recall) |
| `openfda_search_drug_approvals` | `application_number` |
| `openfda_search_device_clearances` | `k_number` (510(k)), `pma_number` + `supplement_number` (PMA) |
| `openfda_search_animal_events` | `unique_aer_id_number` |
| `openfda_search_drug_shortages` | `package_ndc` |
| `openfda_search_tobacco_reports` | `report_id` |
| `openfda_lookup_ndc` | `product_ndc` |

- A path through an array applies to every element, and the array keeps its length: an element carrying none of the requested paths stays as `{}` (`[]` for a nested array), so a report's drug count survives projection. An array no element of which carries the path is absent, like any missing key. A shorter path covering a longer one keeps the whole subtree.
- Each entry must be letters, digits, underscores, and dots with no leading, trailing, or doubled dot — advertised as the `pattern` on every array item, so a malformed path fails argument validation before any upstream request. An empty list is the same as omitting it.
- A path no record on the page carries is named on the notice (`enrichment.notice` and a `content[]` line), never thrown: openFDA records are sparse, so absence from one page is not proof of a typo — the same rule `openfda_get_drug_label`'s `sections` follows.
- The response carries `projected_fields` (the requested paths) only when the call projected; a call without `fields` returns the shape it always has.
- With `stage: true`, `fields` shapes only the inline page; the drain stages whole records into the table's own column projection.

**Decision — projection is server-side and caller-requested.** openFDA has no field selection: the documented query parameters are `search`, `sort`, `count`, `limit`, and `skip`, and `fields=`, `_source=`, and `_source_includes=` each answer HTTP 400. So the full page is fetched and cut after. An include list was chosen over an exclude list because it is bounded by construction — excluding `more_code_info` from a device enforcement record still leaves tens of kilobytes of `code_info`.

**Decision — a projected record renders under its identity heading, field by field.** Each tool's curated `content[]` renderer routes on record shape (`patient` vs `device` in adverse events, `product_res_number` in recalls) and fills absent fields with `N/A` or `Unknown`; a projected record would land in the wrong branch or render a projected-away field as a placeholder the response cannot back. A projected record instead renders as `### <identity key>: <value>` followed by every field it holds, verbatim, and nothing else.

**Decision — the path pattern is a flat character class with lookaheads.** `^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.]+$` accepts exactly the strings the nested `^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$` does, but stays linear on Bun's JavaScriptCore engine, where the nested form's backtracking cost on a long `a.a.a.` run with no valid end jumps roughly sixtyfold between 80,000 and 320,000 characters. The pattern runs over caller-supplied text.

---

## DataCanvas staging (analytical SQL)

**Opt-in twice over.** The deployment enables the surface with `CANVAS_PROVIDER_TYPE=duckdb` (requires the optional `@duckdb/node-api` dependency; unavailable on the Workers runtime, where it fails closed at init), and the caller asks for staging per call. Without both, a search issues exactly one upstream request and returns one page — identical to a deployment with no canvas at all.

Every multi-row search tool — `openfda_search_adverse_events`, `_recalls`, `_drug_approvals`, `_device_clearances`, `_animal_events`, `_drug_shortages`, `_tobacco_reports`, and `openfda_lookup_ndc` — carries:

- `stage` (boolean, default `false`) — stage the matched set for SQL. Passing a `canvas_id` implies it, so successive searches accumulate onto one canvas for cross-table joins. The `canvas_id` input is declared with `CanvasIdSchema` (10 URL-safe characters, advertised as a `pattern`), so a value that could never be an id fails argument validation instead of reaching the canvas registry.
- Output fields `canvas_id`, `canvas_table`, `spilled`, `staged_rows`, `truncated` (all absent unless the call staged).
- Error reasons `canvas_disabled`, `canvas_not_found` (a well-formed `canvas_id` that expired or was never minted), and `canvas_capacity_exhausted` (`RateLimited`, retryable — a mint with `canvas_id` omitted at the per-tenant canvas cap). The last two come from the framework's `canvas.acquire()`; `canvas_id_malformed` is undeclared because `CanvasIdSchema` rejects a malformed id first.

**Decision — every staging surface names `openfda_dataframe_describe` before `openfda_dataframe_query`.** The staging notice, the `content[]` staging line, the `stage` and `canvas_table` descriptions, and each staging tool's `description` point at describe first. The inline page renders nested blocks (`openfda.brand_name`, `products[].marketing_status`) that are not canvas columns, so SQL written from the page without the column list fails as `invalid_query`.

`limit`/`skip` mean the same thing in both modes: a window over the matched set, served from the drain's first page when it covers the window and fetched directly otherwise, and bounded by the same [inline byte budget](#bounded-page-many-rows). A staged call therefore never disagrees with an unstaged one about whether records exist at a given offset, about how many of a window fit inline, or about `meta.limit` — the requested limit, lowered only when the budget dropped records — and record size never empties the page. A [`fields`](#field-selection-fields) projection applies to that inline page only; the drain stages whole records.

**Bounded drain.** Staging drains from offset 0 until whichever comes first: openFDA's 25,000-row `skip` ceiling, or a ~16 MB serialized-JSON budget (`STAGE_MAX_BYTES`). The budget is converted to a row cap and a page size from a 100-row probe, because record size spans three orders of magnitude across endpoints — a `drug/shortages` row is ~1 KB, a `drug/event` report ~65 KB — so a flat row cap either starves the small endpoints or stalls the large ones. `staged_rows` versus `meta.total` discloses exactly how much of the match reached the table, in `structuredContent` and in `content[]`; `truncated: true` when they differ. A truncated stage also names `openfda_count_values` in its disclosure: a `GROUP BY` over the staged rows describes only those rows, while a count query answers the same distribution over the whole matched set server-side in one request.

**Canvas table shape.** Each endpoint registers an explicit, all-nullable column projection (`src/services/openfda/canvas-spill.ts` plus a per-tool `*_CANVAS_SCHEMA` constant): high-value scalar fields as `VARCHAR` (openFDA returns most values as strings — `CAST` in SQL for numeric math) and nested objects/arrays (`openfda`, `patient`, `products`, `submissions`, …) as `JSON` columns read with DuckDB json functions. Fields outside the projection are dropped from the table but remain in the inline page; absent fields register as `NULL`. The drain feeds the raw records straight to the appender, which projects them onto the schema — so sparse, heterogeneous records ingest without NOT-NULL failures.

**Decision — `openfda_search_recalls` stages each endpoint shape against its own projection, and each projection is every top-level field its endpoint returns.** Enforcement records (every category) stage all 25 enforcement fields, `code_info` (affected lots and expiry dates) and `more_code_info` among them: openFDA cuts `code_info` at 32,600 characters, mid-token, and continues the list in `more_code_info`, so both stage verbatim and `code_info || coalesce(more_code_info, '')` recovers the whole list. The termination and center-classification dates, the initial firm notification, and the firm address stage too. `product_code` and `res_event_number` are not staged for enforcement — no drug, device, or food enforcement record carries either (`_exists_:` answers 404 on all three), so a filter on them would silently match nothing. `device/recall` records stage every top-level field the endpoint returns — `product_res_number`, `recall_status`, `res_event_number`, `root_cause_description`, the four `event_date_*` fields, firm address and contact, `code_info`, `action`, with `k_numbers`, `pma_numbers`, and `openfda` as `JSON` — and none of the enforcement-only columns, which would always be `NULL` there. Staging device recalls against the enforcement projection dropped their identity and status from the table.

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

**Decision — one Markdown cell escaper, escaping only what would change the rendering.** `openfda_dataframe_query` header and data cells, `openfda_count_values` terms, and the SPL table cells of `openfda_get_drug_label` all pass through `escapeTableCell` (`src/mcp-server/tools/format-utils.ts`). It escapes `|`, turns line breaks into `<br>`, and escapes emphasis, code, link, and strikethrough markers. A `\`, `<`, `&`, or `_` is escaped only where the next or surrounding character would change how it renders. A blanket escape would break text agents copy out of `content[]`: a column name like `recall_number` is the next SQL query's identifier, and `p<0.05`, `AT&T`, and `CARBIDOPA\LEVODOPA` all render as written. Bare web addresses are the one place an escape itself corrupts: GFM links `http://`, `https://`, and `www.` text from the raw source, so a backslash inside one shows in the link text and its href (`http://example.com/\~user`, a device recall's `…(2)\[3\].pdf`). An address that marked and micromark both link whole is emitted verbatim up to the whitespace or `<` that ends it: it must open where GFM allows (`www.` after whitespace, `(`, `*`, `[`, `]`, or `~`; `http(s)://` after anything but a letter, digit, `.`, `_`, `+`, or `-`, which an email autolink could absorb), carry a valid ASCII domain, contain no `|`, no `](`/`][`, and no `(` left unclosed, and end in nothing GFM trims but plain punctuation — a trimmed `*`, `_`, `~`, or `&name;` would render as Markdown or decode. An address that fails any of these and needs an escape has its opener's `:` or `.` escaped instead (`xhttp\://…`, `WWW\.…`, `ftp\://…`), so neither parser links it and its text renders exactly; one with nothing to escape stays byte-identical. A parser-backed fuzz over marked and micromark+GFM checks that every value renders as one cell holding its exact text and that every link's href matches its own text. SPL text is escaped one run at a time, with whitespace collapsed first, as a fragment: the next run follows it directly, so a trailing `<` or `\` is escaped and an address reaching the run's end is never kept as a link. Markup that does not parse as balanced falls back to its decoded text on one line, escaped the same way. A block marker that opens a caption, footer, loose-text, or fallback line (`>`, an ATX `#`, a `+` or `-` bullet, a setext underline, an `n.` or `n)` ordinal) is escaped so it cannot start a block and drop out of the rendered text. Outside tables, every single-line slot that carries upstream or caller text — record headings and titles, `**Label:** value` lines (each line `formatRemainingFields` emits included), the search lead lines, and list items — flattens CR, LF, and CRLF to a space (`singleLine`), so a value cannot open a heading, list item, or quote of its own. Where the value itself opens the line's content — a list item's text, the animal-details line of `openfda_search_animal_events` — `lineContent` also escapes a block marker it starts with: an ATX `#`, `>`, a bullet or ordinal, a thematic break, setext underline, or table delimiter row, a code fence, an HTML block, a link reference or footnote definition, or a task-list box. A value with no line break and no leading marker stays byte-identical, and only the `content[]` text changes; `structuredContent` keeps every value as openFDA sent it. Two places keep upstream line breaks on purpose: `openfda_get_drug_label` prose sections are the label's own multi-line text and render verbatim, with `*_table` sections going through the SPL renderer above; and enrichment notices, which the framework renders into the `content[]` trailer from the same string `structuredContent` carries.

**Elasticsearch syntax quirks:**
- Boolean: `+AND+`, `+OR+` (URL-encoded spaces). OR is implicit when terms are space-separated.
- Exact matching: field values in quotes (`"aspirin"`). Without quotes, tokenized matching.
- `.exact` suffix on count fields for whole-phrase aggregation vs. tokenized.
- Date ranges: `[20200101+TO+20201231]`.
- Wildcard: `field:aspir*`.
- `sort` takes a comma-separated list, not a single field: `report_date:desc,status.exact:asc` is a working multi-field sort. A bare field path with no direction (`sort=report_date`) sorts ascending, any whitespace around the whole value is trimmed, and so are spaces around a segment (`a:desc, b:asc` sorts identically to `a:desc,b:asc`). Only a lowercase `asc` or `desc` direction is honoured: `DESC`, `Desc`, `ascending`, `"desc"`, or an empty `field:` answers HTTP 200 with that key silently dropped — the unsorted order for a single key, the remaining keys' order in a multi-field sort — on all 15 sortable endpoints.

**Query hygiene — two paths, two mechanisms.** A Lucene query reaching openFDA has one of two origins, and they need opposite treatment. Both are handled in `src/mcp-server/tools/schema-utils.ts` (the caller-written half) and `src/mcp-server/tools/definitions/drug-profile.tool.ts` (the tool-composed half).

| Origin | Tools | Mechanism | Failure |
|---|---|---|---|
| **Caller-written Lucene** — the caller authored the query and owns its syntax | the ten tools taking a `search` and/or `sort` input | **Reject** what is provably malformed, before the request | `malformed_search` for `search`; a schema `ValidationError` for `sort` |
| **Tool-composed Lucene** — the tool built the query from a caller-supplied *term* | `openfda_drug_profile` (seven clauses off one `drug` name) | **Escape** the term for the phrase context it lands in | none — every term produces a well-formed query |

Philosophy: **reject what is provably malformed locally; let openFDA arbitrate what is merely unknown; and never make the caller answer for a query they did not write.** Where the reject line falls is decided by the upstream's own answer, probed against `api.fda.gov` value by value: every value either mechanism refuses is one openFDA refuses outright or answers with silently wrong data (a trailing backslash, an unhonoured `sort` direction), with the single recorded exception under [Out of scope](#out-of-scope-deliberately).

### Caller-written: reject

`search` and `sort` were declared as any non-blank string, so a value that cannot be valid still cost a network round-trip and came back as a raw Lucene/Elasticsearch message — a lexer column index past the end of the submitted string, or a mapping error naming a token the caller never meant as a field.

| Input | Check | Where | Failure |
|---|---|---|---|
| `search` | Quotes, parens, and range brackets each close; no trailing escape | `assertSearchDelimitersBalanced`, first lines of each handler | `malformed_search`, naming the specific fault |
| `sort` | Comma-separated `field-path[:direction]` groups, the direction `asc`/`desc`/`ascending`/`descending` in any case, normalized to lowercase `asc`/`desc` | `SORT_EXPRESSION_PATTERN` on the schema, so it reaches the advertised `inputSchema` as `pattern`; the normalization runs in the schema after it | Schema `ValidationError` showing the expected form |

**Decision — the `search` check is a three-context scanner, not a character count.** A delimiter means different things in different contexts, and a count is wrong in both directions:

| Context | Opened by | What the delimiters mean | Upstream evidence |
|---|---|---|---|
| Normal | — | `"` opens a phrase, `[`/`{` a range, `(`/`)` group | a `)` or `]`/`}` with no opener is refused; so is a bracket mid-term (`reason_for_recall:foo[bar` → `parse_exception`, since an unquoted `[` is always a range opener) |
| Phrase | `"` | every other delimiter is literal data | `product_description:"Packaged as a) 4 FL OZ"` (one `)`, no `(`) matches a real `drug/enforcement` record |
| Range | `[` or `{`, closed by `]` or `}` | same — literal data | `report_date:[(20200101 TO 20201231]` and `report_date:["20200101 TO 20201231]` are both answered, not refused |

A backslash escapes the next character in every one of the three, ranges included — openFDA answers `Term can not end with escape character` when one eats a range's closing bracket. `product_description:"foo \" bar"` is therefore a valid three-quote query, and `[X TO Y}` closes even though the brackets differ.

**Decision — a trailing backslash is rejected, because the alternative is silently wrong data, not an error.** A `\` at the end of the query has nothing to escape. On endpoints that scope a shared index openFDA appends its own clause, so the escape lands on that clause's leading space rather than on end-of-input: `recalling_firm:pfizer\` on `drug/enforcement` answers **HTTP 200 with 18856 records against 155** for `recalling_firm:pfizer`, because the swallowed space dissolves the appended `product_type:drugs` scope and the caller is served another product type's recalls. On an endpoint with nothing appended the same value is a `token_mgr_error` whose echoed tail is empty — the least actionable shape on the surface. Both are locally detectable from one character. `recalling_firm:pfizer\\` (an escaped backslash) is valid and returns the correct 155.

**Decision — a `sort` direction is normalized when its meaning is certain and rejected otherwise.** openFDA splits a sort segment on its **last** colon and validates only the left side, so any direction answers HTTP 200 — but only a lowercase `asc` or `desc` is applied. Every other token drops its key silently, measured as an order identity (not a status code) on all 15 sortable endpoints: `report_date:DESC` returns the same records as no sort, and `classification.exact:desc,report_date:ascending` returns `classification.exact:desc` alone. A 200 is therefore no evidence that a direction works, and no token outside the accepted set is ever applied, so rejecting one loses no working call. `asc`, `desc`, `ascending`, and `descending` in any letter case are accepted and rewritten to lowercase `asc`/`desc` by a Zod `.overwrite()` inside the schema, after the pattern accepts the value — so every handler and the staged path receive the honoured form, and the advertised `pattern` (which `.overwrite()` leaves unchanged) states exactly the accepted spellings. Anything else — `"desc"`, `foo`, an empty `field:`, a prefix like `asce` — is a schema `ValidationError` naming the directions. A colon must be followed by exactly one direction, which is also what makes `report_date:desc:asc` reject: openFDA would read its field path as `report_date:desc` and refuse it.

**Decision — the `sort` pattern is lookaheads over one character class, not a repeated segment group.** The grammar is `^\s*SEG( *, *SEG)*\s*$`, but written that way JavaScriptCore's backtracking cost on a long run of segments with no valid end grows several-hundredfold between 5,000 and 320,000 characters, and the pattern runs over caller-supplied text. The advertised form validates the character set with one character-class run and rules out each structural fault with a lookahead; a test pins it to the plain grammar over every string of up to five tokens, and a CPU-time test bounds its growth across a 64× span on Bun and on Node, each timed in a child process because vitest itself runs on Node.

**Decision — whitespace around the value and spaces around a segment are accepted; whitespace inside a segment is not.** openFDA trims the whole value of any whitespace (tabs, line breaks, and no-break spaces included — the set `\s` matches) and then the spaces around each segment before looking it up, so `classification.exact:desc, report_date:asc` returns the same ordering as the space-free form, and `  report_date:asc  ` and `report_date:asc\t` sort normally; a pattern without the allowance rejects a working sort written the way a caller naturally writes a list. Neither trim reaches inside a segment — `report_date :asc` fails upstream with `No mapping found for [report_date ]`, and a tab or no-break space beside a comma answers 400 — so the field path itself stays space-free.

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
| **Malformed sort shape** | none — rejected by the schema before the request | Schema `ValidationError` showing the expected form. A field path carrying a character no openFDA field path can hold, an empty comma-separated segment, or a direction other than `asc`/`desc`/`ascending`/`descending` (any letter case), which openFDA would silently drop. A well-formed path naming a non-sortable field still goes upstream. |
| **Malformed query** | `400` — `{"error": {"code": "BAD_REQUEST", ...}}` with Elasticsearch parse details | `query_error`. Surface the parse error. Remaining causes after the local prechecks: invalid field names, wrong boolean syntax (`AND` instead of `+AND+`), a non-sortable field. Guide agent to fix query syntax. |
| **Not aggregatable** | `404` `"Nothing to count"`, or `5xx` `illegal_argument_exception` on a `count` query; also `404` `"No matches found!"` when the catalog records the expression as failing | `not_aggregatable`, non-retryable. openFDA answers a search that matched nothing before it reads the count expression, so a recorded-failing expression is rejected on that 404 too rather than returned as an empty tally that reads as countable. For a cataloged field the message is definitive: it names the recorded count expression when the caller used the other form, or says the field has no countable form and lists countable expressions on the endpoint — it never offers a form the catalog records as failing. For an expression outside the catalog it names the `.exact` correction in whichever direction applies — **drop** the suffix on a keyword field (the 404), **add** it on an analyzed text field (the 5xx) — and names `openfda_describe_fields` as the next step, since some fields fail both ways. The upstream `fielddata=true` advice is dropped — it is a server-side index setting no caller can reach. Only `openfda_count_values` declares the reason. |
| **Nothing to count, countable field** | `404` `"Nothing to count"` on a `count` query whose expression counts | Not an error — the search matched only records that carry no value for the field. Empty tally with a notice saying so. A cataloged countable expression resolves directly; one outside the catalog is confirmed with a single unscoped `limit=1` count, and a second `Nothing to count` there becomes `not_aggregatable`. The confirm gets one attempt: a transient failure propagates to the primary request's retry loop, which re-runs the scoped count and the confirm together, instead of retrying inside it and multiplying the budget. |
| **No results** | `404` — `{"error": {"code": "NOT_FOUND", "message": "No matches found!"}}` | Not an error -- the query was valid but matched nothing. Return empty results with a suggestion to broaden the search (remove filters, check spelling, try `openfda.brand_name` vs `brand_name`). `content[]` opens with the same metadata header a matched page carries (total, skip, limit, dataset date, and the canvas staging line when the call staged), then the tool's no-match line; an empty tally from `openfda_count_values` keeps its dataset date the same way. openFDA sends the same 404 for a page past the end of a matched set, so on a non-count query at `skip > 0` the service makes one `skip=0&limit=0` request for the same `search` (no `sort`): a 200 carries the real total, and the page reports the offset as past the end; a second 404 confirms nothing matched. The recovery is best-effort and gets a single attempt, with no retry backoff — if it fails the empty page returns at once, with `meta.totalUnverified: true` and both readings named. The staged arm never needs it: its `skip=0` probe already carries the total, and a window at or past it is not fetched. |
| **Skip ceiling** | `400` — `"Skip value must 25000 or less."` | Backstop only — handlers reject an over-ceiling `skip` locally with the typed `pagination_limit_reached` reason before the request goes out. Either path tells the agent to narrow the `search` query (date range, additional filters) instead of increasing skip. |
| **Rate limit** | `429` — Too Many Requests | Without key: 240 req/min, 1K/day per IP. With key: 240 req/min, 120K/day. Retry after backoff. If hitting daily limit, suggest configuring an API key. |
| **Upstream 5xx** | `500`/`503` — `{"error": {"code": "SERVER_ERROR", ...}}` | Transient openFDA/Elasticsearch issue. Retry with exponential backoff (up to 3 retries after the first attempt). If persistent, surface as upstream outage -- not a client issue. |
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
| `OPENFDA_DATAFRAME_DROP_ENABLED` | No | Set to `true` to make `openfda_dataframe_drop` callable. Default `false` (listed as disabled). Meaningful only with `CANVAS_PROVIDER_TYPE=duckdb`. |
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

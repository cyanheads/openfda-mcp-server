---
name: openfda-guide
description: Query discipline for the openfda_* tools — gates that stop false zeros and misread counts, where NDCs, application numbers, set_ids, K-numbers, and recall numbers come from, and the chains that join them across endpoints. Use before comparing adverse-event counts, concluding a drug or device has no record, or linking recalls, labels, NDCs, shortages, and clearances.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

openFDA's public API: drug, device, and food adverse-event reports, enforcement reports and device recalls, drug labels (SPL), the NDC directory, Drugs@FDA applications, drug shortages, 510(k) and PMA records, veterinary events, and tobacco problem reports. Each record is an FDA submission or listing. The API returns no exposure data, so it cannot give rates, and openFDA's API disclaimer says to treat every result as unvalidated. Trial outcomes, pricing, and prescribing volume come from other sources.

## Identifiers

| Identifier | Shape | Yielded by | Consumed by |
|:--|:--|:--|:--|
| Product NDC | `69339-364`, hyphenated labeler-product | `openfda_lookup_ndc`, `openfda_drug_profile` identity, `openfda.product_ndc` on shortage and label records | `product_ndc:"…"` in `openfda_lookup_ndc` |
| Package NDC | `69339-364-05` | shortage records (one record per package), `packaging[].package_ndc` on NDC records | `packaging.package_ndc:"…"` in `openfda_lookup_ndc` |
| Application number | `ANDA077861`, `NDA…`, `BLA…` | `openfda_search_drug_approvals`, NDC records, `openfda.application_number` blocks | `application_number:"…"` in `openfda_search_drug_approvals` |
| SPL set ID | UUID | label records, `openfda.spl_set_id` on NDC and shortage records, profile identity | `set_id:"…"` in `openfda_get_drug_label`; openFDA keeps one current label per set |
| K-number / PMA number | `K201189` / `P…` | `openfda_search_device_clearances`; `k_numbers` / `pma_numbers` on device recall records | `k_number:"…"` / `pma_number:"…"` in `openfda_search_device_clearances` |
| Product code | 3 letters, e.g. `OLO` | device recall, 510(k), and PMA records | `product_code:"…"` on those endpoints |
| Recall number | `D-321-2016`, `Z-0050-2025` | enforcement records (`recall_number`); device recall records (`product_res_number`) | device enforcement `recall_number` equals device recall `product_res_number`; enforcement `event_id` equals device recall `res_event_number` |
| `canvas_id` | 10 characters | any search tool with `stage: true` | `openfda_dataframe_describe`, `openfda_dataframe_query`, later `stage` calls |

NDCs match only in their hyphenated form: `product_ndc:"69339364"` matches nothing. An 11-digit claims-style NDC has to be re-hyphenated first.

## Gates

**Query syntax**
- Separate terms with spaces. openFDA's documentation writes `+` for a space, but these tools pass `+` through as a literal plus: `…"aspirin"+AND+serious:"1"` returns zero results and no error.
- Write `AND`, `OR`, `NOT` in uppercase. With lowercase `and`, the same aspirin-and-serious search matches 13.8M reports instead of 435K.
- Quote every identifier value. Unquoted hyphens parse as operators, so `recall_number:D-321-2016` matches about 18,000 records (nearly all of drug enforcement) where the quoted form matches one.
- Before writing a date range, check the field's note in `openfda_describe_fields`. Most dates take `[20240101 TO 20241231]`, but shortage dates take `[2026-01-01 TO 2026-12-31]`, and the YYYYMMDD form matches nothing there.

**Before concluding absence**
A zero or low count is not evidence until each of these has been ruled out:
1. **Empty `openfda` blocks.** The harmonized `openfda.*` fields exist only where FDA could link the record to a product. In drug enforcement, 3,097 of about 18,000 records carry `openfda.generic_name`. About 180,000 drug labels have an empty `openfda` block. Repeat the search on the record's own text fields: `product_description` for recalls, `spl_product_data_elements` for labels. For metformin, recalls go from 33 to 91 on `product_description`. For lisinopril, 577 labels with no `openfda` block turn up on `spl_product_data_elements`, beside 216 found by `openfda.brand_name`.
2. **Name field and spelling.** In `drug/event`, `patient.drug.medicinalproduct` is the name as the reporter typed it. For atorvastatin, `medicinalproduct:"atorvastatin"` matches 343,931 reports, `medicinalproduct:"lipitor"` matches 180,918, and `patient.drug.openfda.generic_name:"atorvastatin"` matches 249,606. OR-ing all three matches 519,687. Pick one definition, state it, and use the same one for every drug you compare.
3. **Phrase vs `.exact`.** A quoted phrase on a text field matches the words anywhere in a value: `reactionmeddrapt:"liver injury"` also matches `DRUG-INDUCED LIVER INJURY` (58,268 reports). `reactionmeddrapt.exact:"LIVER INJURY"` matches only the whole term (23,867).
4. **Case on keyword fields.** Some fields are stored uppercase and match only in that case. `sponsor_name` is one, and the tool description says so. When a lowercase quoted value returns zero, retry it in uppercase.
5. **Section failures.** A section listed in `openfda_drug_profile`'s `degraded` is unknown, not empty.

**Before attributing or comparing**
- openFDA cannot tie two clauses to the same array element. `patient.drug.medicinalproduct:"aspirin" AND patient.drug.drugcharacterization:"1"` matches any report that names aspirin and has any suspect drug. In a 25-report sample, aspirin was concomitant in 24. To count only reports where the drug is the suspect, read `drugcharacterization` on each drug entry of the returned records, or on a staged slice in SQL.
- `openfda_count_values` over an array field tallies every element of every matching report. Counting `reactionmeddrapt.exact` on reports that match `LIVER INJURY` also returns their co-reported FATIGUE, PAIN, and NAUSEA. Counting drug names under a drug search likewise lists the concomitant drugs.
- Report counts are not incidence. To compare two drugs, divide each drug's reaction count by that drug's total report count (`meta.total` from a search with `limit: 1`). Use the same name definition in both, and present the result as reporting proportions, not risk.
- `openfda_drug_profile` keys `adverse_events` on the typed name in `medicinalproduct`, and keys recalls, approval, and shortage on one canonical generic name it resolves from a label (`meta.fanOutKey`). Its recall list therefore inherits the gap in item 1, and can be narrower still when that name is a single product's (`METFORMIN ER 500 MG`): an empty or short `recalls` there does not mean the drug has never been recalled. Use `openfda_search_recalls` for the complete list.

## Workflows

**Drug safety signal (drug X vs drug Y).** Run `openfda_drug_profile` per drug for orientation. Then fix one name definition per drug (item 2). Get each drug's total with `openfda_search_adverse_events` (`limit: 1`). Tally reactions with `openfda_count_values` (`patient.reaction.reactionmeddrapt.exact`, scoped to the drug). Choose the MedDRA terms that make up the concept from that tally, since "liver injury" covers several preferred terms. Report proportions with the caveats above.

**Device maker's recalls → clearances.** Search `openfda_search_recalls` with `category: device` and `endpoint: recall`, on `recalling_firm` plus `event_date_initiated:[20240101 TO 20241231]`. Each record's `k_numbers` / `pma_numbers` go to `openfda_search_device_clearances`, and `product_code` links to the device type. The hazard class (Class I/II/III) is only on device enforcement records: look them up with `recall_number:"<product_res_number>"` and `endpoint: enforcement`. A firm's name varies across divisions ("Medtronic Navigation, Inc.", "Medtronic Perfusion Systems"), so search the shared word.

**Shortage → products.** `openfda_search_drug_shortages` with `generic_name:"<ingredient>"` returns one record per package, with `status` on each. Pass `package_ndc` to `openfda_lookup_ndc` as `packaging.package_ndc:"…"`, or use `openfda.product_ndc` / `openfda.spl_set_id` to reach the NDC record and the label.

**Label question for a brand or generic.** One name matches many labels, from repackagers and multiple manufacturers (216 for `openfda.brand_name:"lisinopril"`). Narrow by `openfda.manufacturer_name`, `sort: effective_time:desc`, or a `set_id` you already hold. When the response returns an outline, re-call with `sections` naming only the sections that answer the question. For dosing in a population, that is usually `dosage_and_administration` plus the population section listed in the outline.

**Bulk analysis.** Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `openfda_dataframe_describe` with it for the staged table and column names before writing SQL, then `openfda_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

A staged drain stops at about 16 MB. A drug adverse-event report averages about 65 KB, so the table holds a few hundred reports. Any `GROUP BY` over it describes only the staged slice, so compare `staged_rows` with `meta.total` before reading it as a population figure. For a distribution over everything that matched, use `openfda_count_values`. Stage when you need record-level logic that openFDA can't express, such as per-drug-entry suspect filtering.

## References

- [references/query-syntax.md](references/query-syntax.md): operators, phrases and `.exact`, ranges and date forms, existence tests, and the paging and count ceilings, each with its observed behavior.

# openFDA query syntax: observed behavior

Each row below was checked against `api.fda.gov`. Field paths for a given endpoint come from `openfda_describe_fields`.

## Operators and terms

| Form | Behavior |
|:--|:--|
| `a:"x" AND b:"y"` | Both clauses must match. Separate terms with spaces; a `+` reaches openFDA as a literal plus and the search silently matches nothing. |
| `and` / `or` in lowercase | Read as search words, not operators. The search widens, often to most of the index. |
| `a:"x" OR b:"y"` | Either clause. Use it to union a drug's name variants (`medicinalproduct:"atorvastatin" OR medicinalproduct:"lipitor"`). |
| `AND NOT _exists_:serious` | Excludes records that carry the field. |
| `_exists_:field` / `_missing_:field` | Tests whether a field is present. `_missing_:openfda` finds records whose harmonized block is empty. |
| `field:"two words"` on a text field | Phrase match: the words in order, anywhere inside the value. Case-insensitive. |
| `field.exact:"WHOLE VALUE"` | Matches the whole stored value only. Case did not matter on `reactionmeddrapt.exact`. |
| Unquoted value with `-` | Hyphens parse as operators. Quote every identifier (`recall_number:"D-321-2016"`). |
| Nested arrays | Each clause is tested against the whole record, not against a single array element. Two clauses on `patient.drug.*` may be satisfied by two different drugs. |

## Ranges and dates

Ranges take the form `field:[LOW TO HIGH]`, with spaces around `TO`. Most date fields take `YYYYMMDD` bounds, including some fields that store `YYYY-MM-DD` (`decision_date` on 510(k)/PMA, `event_date_initiated` on device recalls). Two fields don't:

| Endpoint | Field | Query form |
|:--|:--|:--|
| `drug/shortages` | `update_date`, `initial_posting_date` | `[2026-01-01 TO 2026-12-31]` or `[01/01/2026 TO 12/31/2026]`; `YYYYMMDD` matches nothing |
| `tobacco/problem` | `date_submitted` (stored `MM/DD/YYYY`) | `YYYYMMDD` (`YYYY-MM-DD` also matches) |

When a date-scoped search returns zero, read the field's note in `openfda_describe_fields` before deciding the window is empty.

## Ceilings

- `skip` stops at 25,000. To get past it, narrow the search, for example by splitting the date range.
- `openfda_count_values` returns at most 1,000 terms. At exactly 1,000 it cannot tell whether more exist, so narrow the search and count again.
- A staged drain stops at 25,000 rows or about 16 MB, whichever comes first. `staged_rows` reports how many rows it holds.

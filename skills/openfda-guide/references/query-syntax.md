# openFDA query syntax: observed behavior

Each row below was checked against `api.fda.gov`. Field paths for a given endpoint come from `openfda_describe_fields`.

## Operators and terms

| Form | Behavior |
|:--|:--|
| `a:"x" AND b:"y"` | Both clauses must match. Separate terms with spaces. A URL-style `+` between clauses (`+AND+`, `"x"+b:"y"`, `[a+TO+b]`) also reads as a space; a `+` inside a quoted phrase stays a literal plus. |
| `and` / `or` in lowercase | Read as search words, not operators. The search widens, often to most of the index. |
| `a:"x" OR b:"y"` | Either clause. Use it to union a drug's name variants (`medicinalproduct:"atorvastatin" OR medicinalproduct:"lipitor"`). |
| `AND NOT _exists_:serious` | Excludes records that carry the field. |
| `_exists_:field` / `_missing_:field` | Tests whether a field is present. `_missing_:openfda` finds records whose harmonized block is empty. |
| `field:"two words"` on a text field | Phrase match: the words in order, anywhere inside the value. Case-insensitive. |
| `field.exact:"WHOLE VALUE"` | Matches the whole stored value only. Case did not matter on `reactionmeddrapt.exact`. |
| Unquoted value with `-` | openFDA splits the value at its hyphens and ORs the parts, so a bare `recall_number:D-321-2016` matches nearly all of drug enforcement. Quote every identifier (`recall_number:"D-321-2016"`). The tools send an unquoted term of letters and digits joined by hyphens quoted; any other term (`1.5-mg`, `D-0123*`) goes as written. |
| A refused character: `!` `#` `$` `;` `?` `^` `\|` `~`, a backtick, or any non-ASCII character | Refused by openFDA anywhere, quoted or not (HTTP 400). The tools fail the call as `malformed_search` before the request, naming the character and its 1-based position. Use `NOT` for `!`, `OR` for `\|`, `*` for `?`; the others have no replacement. Tabs and line breaks read as spaces. |
| Nested arrays | Each clause is tested against the whole record, not against a single array element. Two clauses on `patient.drug.*` may be satisfied by two different drugs. The arrays: `patient.drug` and `patient.reaction` (drug events); `device`, `patient`, `mdr_text` (device events); `products` (food and cosmetic events, Drugs@FDA); `submissions`, `submissions.application_docs`, `submissions.submission_property_type`, `products.active_ingredients` (Drugs@FDA); `drug`, `drug.active_ingredients`, `reaction`, `outcome` (animal events); `active_ingredients`, `packaging` (NDC); `products.active_ingredients`, `patents`, `exclusivity` (Orange Book). An Orange Book record holds exactly one `products` entry, so clauses on its fields cannot split. The tools' notice names the array and the staged SQL that requires one entry. |

## Ranges and dates

Ranges take the form `field:[LOW TO HIGH]`, with spaces around `TO`. Most date fields take `YYYYMMDD` bounds, including some fields that store `YYYY-MM-DD` (`decision_date` on 510(k)/PMA, `event_date_initiated` on device recalls). The fields stored `MM/DD/YYYY` differ by endpoint:

| Endpoint | Field | Query form |
|:--|:--|:--|
| `drug/shortages` | `initial_posting_date`, `update_date`, `discontinued_date`, `change_date` (stored `MM/DD/YYYY`) | `[2026-01-01 TO 2026-12-31]`. The tools rewrite a date written `YYYYMMDD`, `M/D/YYYY`, or `YYYY-M-D` to `YYYY-MM-DD` in a term or either range bound (also in `openfda_count_values`); a group, regexp, epoch millisecond value, date-time, or date math is sent as written. Outside the tools a raw `YYYYMMDD` reads as epoch milliseconds, and an unquoted `MM/DD/YYYY` misparses as a regexp |
| `tobacco/problem` | `date_submitted` (stored `MM/DD/YYYY`) | `YYYYMMDD` (`YYYY-MM-DD` also matches) |
| `transparency/crl` | `letter_date` (stored `MM/DD/YYYY`) | `YYYYMMDD` (`[20240101 TO 20241231]` matches the same letters as `letter_year:"2024"`) |

When a date-scoped search returns zero, read the field's note in `openfda_describe_fields` before deciding the window is empty.

## Ceilings

- `skip` stops at 25,000. To get past it, start at `skip` 0 and follow `next_cursor`: pass it as `cursor` with the same endpoint, `search`, and `sort` (`limit`, `fields`, `include`, and `sections` may change). A bad token, one from another query, or a `cursor` with `skip` above 0, `stage`, or `canvas_id` fails as `invalid_cursor`. The last page notes that the walk is complete. Or narrow the search, for example by splitting the date range.
- `openfda_count_values` returns at most 1,000 terms. On a non-date field, at exactly 1,000 it cannot tell whether more exist, so narrow the search and count again. A date field returns one bucket per date, ranked by count, and its truncation is exact.
- A staged drain stops at 25,000 rows or about 16 MB, whichever comes first. `staged_rows` reports how many rows it holds.

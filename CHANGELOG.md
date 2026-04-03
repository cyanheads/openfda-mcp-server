# Changelog

## [0.1.1] - 2026-04-03

### Changed

- Removed URL-encoded syntax (`+AND+`, `+OR+`, `+`) from tool descriptions and error messages — the service layer handles encoding, so user-facing text now shows plain `AND`/`OR`/spaces
- Improved empty-result messages for `openfda_get_drug_label` and `openfda_search_recalls` — now echo the search query and suggest common field names
- PMA result headings in `openfda_search_device_clearances` now include trade/generic name when available

## [0.1.0] - 2026-04-03

Initial release.

### Added

- **openFDA service layer** — generic API client with retry (exponential backoff), rate-limit awareness, and error normalization for all openFDA endpoints
- **Server config** — lazy-parsed Zod schema for `OPENFDA_API_KEY` (optional, increases daily limit from 1K to 120K) and `OPENFDA_BASE_URL`
- **7 MCP tools:**
  - `openfda_search_adverse_events` — search adverse event reports across drugs, food, and devices
  - `openfda_search_recalls` — search enforcement reports and recall actions
  - `openfda_count` — aggregate and tally unique values for any field across any endpoint
  - `openfda_get_drug_label` — look up FDA drug labeling (package inserts / SPL documents)
  - `openfda_search_drug_approvals` — search Drugs@FDA for NDA/ANDA approvals
  - `openfda_search_device_clearances` — search 510(k) clearances and PMA approvals
  - `openfda_lookup_ndc` — look up drugs in the NDC Directory
- `.env.example` with server-specific environment variables
- Design doc at `docs/design.md` with full tool surface, error design, and implementation notes

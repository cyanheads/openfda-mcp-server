/**
 * @fileoverview Composite tool that resolves one drug name to its FDA identity, then
 * fans out in parallel to the bounded per-drug openFDA endpoints and merges the results
 * into a single profile (identity, label highlights, adverse-event summary, recalls,
 * approval, shortage). Resolving identity once and keying the recall and shortage sub-queries
 * off one fan-out key derived from it is what prevents the identifier drift that breaks naive
 * tool chaining. Identity, label, approval, and shortage are each chosen by a rule — an
 * original packager's label, the drug's own Drugs@FDA application (`pickApplication`) —
 * and name the product they describe, all inside one profile deadline.
 * @module mcp-server/tools/definitions/drug-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  approvalOf,
  first,
  openfdaOf,
  pickApplication,
  strings,
  summarizeShortage,
  wordsOf,
} from '@/mcp-server/tools/drug-profile-sections.js';
import { codeLiteral, lineContent, singleLine, truncate } from '@/mcp-server/tools/format-utils.js';
import { nonBlankString } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import type { OpenFdaQueryParams } from '@/services/openfda/types.js';

/**
 * Escape a free-text name for the quoted Lucene phrase it is interpolated into.
 *
 * `\` and `"` are the only two characters that can end a phrase early, and both
 * are escaped rather than stripped so the term reaches openFDA as the caller
 * wrote it. `\` must be replaced first: escaping `"` introduces backslashes of
 * its own, and doing them in the other order would double those back.
 *
 * A backslash is what makes this load-bearing. Stripping only `"` left a term
 * ending in `\` escaping the phrase's own closing quote — in a two-clause query
 * that re-parsed the ` OR ` boundary into the phrase and answered HTTP 200 with
 * an unrelated result set; in a one-clause query it left the phrase open and
 * failed as a `token_mgr_error`.
 */
function phrase(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * True when the term carries a character that could belong to a drug name.
 *
 * Delimiters and whitespace cannot, so a name made only of those resolves
 * nothing and raises `blank_drug_name` instead of searching for the literal
 * delimiters. This replaces the old "did stripping empty the string" test, which
 * only worked because stripping was destructive.
 */
function hasSearchableCharacter(term: string): boolean {
  return /[^\\"\s]/.test(term);
}

/**
 * True when `needle`'s words occur, consecutively and in order, among `haystack`'s —
 * the whole-word, case-insensitive match the phrase query itself makes. Matched with
 * Knuth–Morris–Pratt over the word arrays, so it stays linear in both inputs whatever
 * the caller types: a naive rescan from every start goes quadratic on repeated words.
 */
function containsWords(haystack: string, needle: string): boolean {
  const pattern = wordsOf(needle);
  const words = wordsOf(haystack);
  if (pattern.length === 0 || pattern.length > words.length) return false;
  // fallback[i]: length of the longest proper prefix of pattern[0..i] that is also its suffix.
  const fallback = new Array<number>(pattern.length).fill(0);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fallback[k - 1] as number;
    if (pattern[i] === pattern[k]) k++;
    fallback[i] = k;
  }
  for (let i = 0, k = 0; i < words.length; i++) {
    while (k > 0 && words[i] !== pattern[k]) k = fallback[k - 1] as number;
    if (words[i] === pattern[k]) k++;
    if (k === pattern.length) return true;
  }
  return false;
}

/**
 * The name the recall and shortage sub-queries key on, and the Drugs@FDA fallback when the
 * typed name matches no application, unescaped.
 *
 * The typed term when it is whole words of the resolved generic name: the caller typed
 * the ingredient, and one label's generic can be a single product's string
 * (`ADALIMUMAB-AACF`, `METFORMIN ER 500 MG`) that misses the rest of the drug's records.
 * Otherwise the resolved generic, then the first brand, then the term — so brand input
 * keys on the generic, never the brand. A resolved name with no searchable character
 * falls back to the (already validated) term rather than keying sub-queries off delimiters.
 */
export function fanOutKeyFor(
  term: string,
  genericName: string | null,
  brandName: string | undefined,
): string {
  if (genericName !== null && containsWords(genericName, term)) return term;
  const resolved = genericName ?? brandName ?? term;
  return hasSearchableCharacter(resolved) ? resolved.trim() : term;
}

/** Profile sections a sub-query populates — the key degradation is reported under. */
const SECTIONS = [
  'identity',
  'label',
  'adverse_events',
  'recalls',
  'approval',
  'shortage',
] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Wall-clock budget for one profile: every request of every round, each retry
 * and backoff included, settles by one instant this far from the start. It sits
 * below the 60 s request timeout MCP SDK clients default to, so a request it
 * cuts lands in `degraded` as a timeout and the call still answers. The
 * service's per-call default (`OPENFDA_CALL_DEADLINE_MS`) bounds one request;
 * this bounds the whole profile.
 */
const PROFILE_DEADLINE_MS = 50_000;

/**
 * Most Drugs@FDA applications ranked for the approval, and most shortage records
 * tallied — openFDA's page ceiling, so one request each. A match total above it
 * is disclosed, never silent.
 */
const CANDIDATE_LIMIT = 100;

/** A sub-query that failed, kept so the caller learns the section is unknown rather than absent. */
interface SectionFailure {
  /** Which label lookup failed, for the notice raised when another label is still shown. */
  lookup?: string;
  message: string;
  reason: string;
  section: Section;
}

/**
 * Collects every sub-query failure of one profile run, plus the first global one
 * to rethrow, and holds the caller's signal that decides whether a failure is the
 * caller cancelling.
 */
interface FailureSink {
  failures: SectionFailure[];
  fatal?: unknown;
  signal: AbortSignal;
}

/**
 * Failures that must never be absorbed into a best-effort null section.
 *
 * Auth, permission, and configuration failures are global — every sub-query fails
 * identically, and reporting them as "no data" describes a server misconfiguration
 * as a misspelled drug. Cancellation means the caller is already gone. Returns the
 * reason to report, or null when the failure is genuinely per-section (a rate limit,
 * a 5xx on one endpoint, a rejected query) and best-effort degradation is correct.
 */
function fatalReason(error: unknown): string | null {
  if (!(error instanceof McpError)) return null;
  if (error.code === JsonRpcErrorCode.Unauthorized) return 'unauthorized';
  if (error.code === JsonRpcErrorCode.Forbidden) return 'forbidden';
  if (error.code === JsonRpcErrorCode.ConfigurationError) return 'configuration_error';
  // fetchWithTimeout raises an abort of the caller's signal as RequestCancelled
  // tagged with this source.
  if ((error.data as { errorSource?: string } | undefined)?.errorSource === 'FetchAborted') {
    return 'cancelled';
  }
  return null;
}

/**
 * Machine-readable reason for a per-section failure: `timeout` for a request the
 * profile deadline or its own attempt timeout cut, else the service's own
 * `data.reason` when it set one.
 */
function failureReason(error: unknown): string {
  if (!(error instanceof McpError)) return 'unexpected_error';
  if (error.code === JsonRpcErrorCode.Timeout) return 'timeout';
  const reason = (error.data as { reason?: string } | undefined)?.reason;
  return typeof reason === 'string' ? reason : 'upstream_error';
}

/** Generic and brand names from a record's openfda block, for match scoring. */
function openfdaNames(rec: Record<string, unknown>): { generic: string; brand: string } {
  const o = openfdaOf(rec);
  return { generic: first(o.generic_name) ?? '', brand: first(o.brand_name) ?? '' };
}

/** Generic and brand names of a drug/ndc record — its own fields, else its openfda block. */
function ndcNames(rec: Record<string, unknown>): { generic: string; brand: string } {
  const o = openfdaOf(rec);
  return {
    generic: first(rec.generic_name) ?? first(o.generic_name) ?? '',
    brand: first(rec.brand_name) ?? first(o.brand_name) ?? '',
  };
}

/**
 * Whether openFDA flags a label or NDC record as its original packager's
 * (`openfda.is_original_packager`). openFDA sets the flag only to true, so a
 * harmonized record without it is a repackager's or relabeler's: false. Null
 * when the record's openfda block is empty and the flag cannot be known.
 */
function originalPackager(rec: Record<string, unknown>): boolean | null {
  const o = openfdaOf(rec);
  if (Object.keys(o).length === 0) return null;
  const flag = o.is_original_packager;
  return Array.isArray(flag) ? flag.includes(true) : flag === true;
}

/** True when `rec` is an original packager's label filed under `applicationNumber`. */
function isOwnLabelOf(rec: Record<string, unknown>, applicationNumber: string): boolean {
  return (
    originalPackager(rec) === true &&
    strings(openfdaOf(rec).application_number).includes(applicationNumber)
  );
}

/** Truncate a label section (array or string) to a readable length, or null when absent. */
function section(value: unknown, max = 600): string | null {
  const text = Array.isArray(value) ? value.filter((v) => typeof v === 'string').join('\n') : value;
  if (typeof text !== 'string' || text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

interface Identity {
  application_number: string | null;
  brand_names: string[];
  generic_name: string | null;
  is_original_packager: boolean | null;
  manufacturer: string | null;
  product_ndc: string | null;
  rxcui: string | null;
  spl_set_id: string | null;
}

const EMPTY_IDENTITY: Identity = {
  application_number: null,
  brand_names: [],
  generic_name: null,
  is_original_packager: null,
  manufacturer: null,
  product_ndc: null,
  rxcui: null,
  spl_set_id: null,
};

/**
 * Build identity from a drug/label record (the richest openfda block + set_id).
 * A label listing several applications reports `preferredApplication` when it is
 * one of them, so identity and approval name the same one where they can.
 */
function identityFromLabel(rec: Record<string, unknown>, preferredApplication?: string): Identity {
  const o = openfdaOf(rec);
  const applications = strings(o.application_number);
  return {
    application_number:
      preferredApplication !== undefined && applications.includes(preferredApplication)
        ? preferredApplication
        : (applications[0] ?? null),
    brand_names: strings(o.brand_name),
    generic_name: first(o.generic_name),
    is_original_packager: originalPackager(rec),
    manufacturer: first(o.manufacturer_name),
    product_ndc: first(o.product_ndc),
    rxcui: first(o.rxcui),
    spl_set_id: first(o.spl_set_id) ?? (typeof rec.set_id === 'string' ? rec.set_id : null),
  };
}

/** Build identity from a drug/ndc record (top-level fields + openfda cross-refs). */
function identityFromNdc(rec: Record<string, unknown>): Identity {
  const o = openfdaOf(rec);
  return {
    application_number: first(rec.application_number) ?? first(o.application_number),
    brand_names: first(rec.brand_name) ? strings(rec.brand_name) : strings(o.brand_name),
    generic_name: first(rec.generic_name) ?? first(o.generic_name),
    is_original_packager: originalPackager(rec),
    manufacturer: first(rec.labeler_name) ?? first(o.manufacturer_name),
    product_ndc: first(rec.product_ndc) ?? first(o.product_ndc),
    rxcui: first(o.rxcui),
    spl_set_id: first(o.spl_set_id),
  };
}

/**
 * Run a best-effort sub-query: resolve to its result, or null on error.
 *
 * Every failure is recorded in `failures` so the response can name the sections it
 * could not fill. A failure `fatalReason` classifies as global is additionally
 * captured in `fatal` — the handler rethrows it after the round rather than
 * rejecting mid-flight, so a second concurrent fatal never becomes an unhandled
 * rejection.
 *
 * Any failure once the caller's signal has fired is the cancellation, whatever
 * shape it arrives in: a cancel landing while `withRetry` sleeps between attempts
 * rejects with the signal's own reason, which carries no `McpError` code for
 * `fatalReason` to recognize.
 *
 * `lookup` names a label lookup, so a failure can be reported by name when
 * another label still fills the section.
 */
async function settle<T>(
  section: Section,
  fn: () => Promise<T>,
  sink: FailureSink,
  lookup?: string,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const fatal = sink.signal.aborted ? 'cancelled' : fatalReason(error);
    if (fatal !== null) sink.fatal ??= error;
    sink.failures.push({
      section,
      reason: fatal ?? failureReason(error),
      message: truncate(error instanceof Error ? error.message : String(error), 300),
      ...(lookup !== undefined && { lookup }),
    });
    return null;
  }
}

/**
 * Score a candidate by how well its generic/brand names match the requested term:
 * exact and prefix matches win, multi-ingredient combination products are penalized
 * (openFDA relevance often ranks a combo first for a single-drug query), and shorter
 * generic names (fewer ingredients) break ties toward the bare drug.
 */
function matchScore(generic: string, brand: string, termLower: string): number {
  const g = generic.toLowerCase();
  const b = brand.toLowerCase();
  let s = 0;
  if (g === termLower || b === termLower) s += 100;
  if (g.startsWith(termLower) || b.startsWith(termLower)) s += 20;
  if (g.includes(termLower) || b.includes(termLower)) s += 10;
  if (/ and |;|,/.test(g)) s -= 30; // combination product
  s -= Math.min(g.length, 80) / 10; // prefer the shortest matching generic
  return s;
}

/** Pick the candidate whose generic/brand names best match the requested term (see matchScore). */
function bestMatch<T>(
  results: T[],
  termLower: string,
  namesOf: (r: T) => { generic: string; brand: string },
): T | undefined {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const r of results) {
    const { generic, brand } = namesOf(r);
    const s = matchScore(generic, brand, termLower);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best;
}

export const drugProfileTool = tool('openfda_drug_profile', {
  description:
    "Resolve one drug name to its FDA identity, then fan out in parallel across the bounded per-drug openFDA endpoints and merge into one profile: identity, label highlights, adverse-event summary, recall history, Drugs@FDA approval, and shortage status. Identity and label come from an original packager's label when one matches (identity.is_original_packager says when they do not), approval is the drug's own application ranked over its Drugs@FDA matches, and each section names the product it describes. Replaces chaining openfda_get_drug_label, openfda_search_adverse_events, openfda_search_recalls, openfda_search_drug_approvals, and openfda_search_drug_shortages — and reconciles the identifier drift between endpoints that makes that chaining error-prone. Each section is best-effort: a miss returns null rather than failing the call, and a sub-query the 50 s profile deadline cuts is listed in degraded. For deep dives into any one area, use the dedicated tool.",
  annotations: { readOnlyHint: true },

  input: z.object({
    drug: nonBlankString().describe(
      'Drug name to profile — brand or generic (e.g. "metformin", "Humira", "Glucophage"). Resolved once to an FDA identity. The Drugs@FDA approval is ranked over this name\'s matches; meta.fanOutKey reports the name the recall and shortage sub-queries searched.',
    ),
  }),
  inputAliases: { drug_name: 'drug', name: 'drug' },

  output: z.object({
    meta: z
      .object({
        drug: z.string().describe('The drug name supplied in the request, echoed back.'),
        resolvedVia: z
          .enum(['label', 'ndc', 'none'])
          .describe(
            'Which endpoint resolved the canonical identity: drug/label, drug/ndc, or none.',
          ),
        fanOutKey: z
          .string()
          .describe(
            'Name the recall/enforcement and shortage sub-queries ran against, and the Drugs@FDA approval search when the input name matches no application — the input term when it is whole words of the resolved generic name (an ingredient such as "metformin" or "adalimumab", so one label\'s product-specific generic does not narrow them), otherwise the resolved generic name, falling back to a brand name, then the input term. Derived from the label the name itself matched, before any swap to the approval\'s own label. The adverse-event sub-queries instead key off the raw input term to match heterogeneous reporter-entered values.',
          ),
      })
      .describe('Request metadata.'),
    identity: z
      .object({
        brand_names: z
          .array(z.string())
          .describe(
            "Brand names on the resolved record: a label's openfda.brand_name, or the drug/ndc record's brand_name.",
          ),
        generic_name: z
          .string()
          .nullable()
          .describe(
            'Generic name (openfda.generic_name) of the resolved label or NDC record — it can name one product (e.g. "ADALIMUMAB-AACF" on a biosimilar\'s label). meta.fanOutKey uses it unless the input term is whole words of it.',
          ),
        product_ndc: z.string().nullable().describe('Representative product NDC, when available.'),
        manufacturer: z
          .string()
          .nullable()
          .describe(
            "Manufacturer on the resolved label (openfda.manufacturer_name), or the drug/ndc record's labeler.",
          ),
        application_number: z
          .string()
          .nullable()
          .describe(
            'Application (NDA, ANDA, BLA) the resolved label or NDC record is filed under. When it differs from approval.applicationNumber, identity and label describe another product than approval does.',
          ),
        is_original_packager: z
          .boolean()
          .nullable()
          .describe(
            "True when openFDA flags the resolved record as the original packager's (openfda.is_original_packager). False for a harmonized record openFDA leaves unflagged, as a repackager's or relabeler's is. Null when openFDA harmonized nothing for the record.",
          ),
        rxcui: z.string().nullable().describe('RxNorm concept unique identifier, when available.'),
        spl_set_id: z
          .string()
          .nullable()
          .describe('SPL set ID for the drug label, when available.'),
      })
      .describe(
        "Identity of one product: an original packager's drug/label record matching the name, else any label matching the name, else a drug/ndc record — replaced by the approval application's own original-packager label whenever the record found is not it.",
      ),
    label: z
      .object({
        indications: z.string().nullable().describe('Indications and usage (truncated).'),
        warnings: z
          .string()
          .nullable()
          .describe(
            'Warnings (truncated) — boxed warning or warnings_and_cautions for Rx labels, falling back to the OTC-monograph warnings section.',
          ),
        dosage: z.string().nullable().describe('Dosage and administration (truncated).'),
      })
      .nullable()
      .describe(
        'Label highlights from the drug/label record identity was resolved from, or null when no label matched.',
      ),
    adverse_events: z
      .object({
        total: z
          .number()
          .describe(
            'Adverse-event reports naming this drug — every matching report, including those with no seriousness recorded; equals openfda_search_adverse_events meta.total for the same medicinalproduct search.',
          ),
        seriousCount: z
          .number()
          .describe(
            'Reports flagged serious (serious=1). total − seriousCount covers both non-serious reports and those with no seriousness recorded.',
          ),
        topReactions: z
          .array(
            z
              .object({
                term: z.string().describe('MedDRA reaction term.'),
                count: z.number().describe('Reports citing this reaction.'),
              })
              .describe('A reaction term paired with its report count.'),
          )
          .describe('Most-frequent reported reactions, descending.'),
      })
      .nullable()
      .describe('Adverse-event summary aggregated over drug/event, or null when unavailable.'),
    recalls: z
      .array(
        z
          .object({
            classification: z.string().nullable().describe('Recall hazard class (Class I/II/III).'),
            reason: z.string().nullable().describe('Reason for recall (truncated).'),
            recalling_firm: z.string().nullable().describe('Firm conducting the recall.'),
            date: z.string().nullable().describe('Recall initiation or report date (YYYYMMDD).'),
          })
          .describe('A single recall or enforcement action.'),
      )
      .describe(
        'The newest 5 drug/enforcement recall actions whose openfda.generic_name or product_description matches meta.fanOutKey (may be empty); recalls_total counts every match.',
      ),
    recalls_total: z
      .number()
      .nullable()
      .describe(
        'Total drug/enforcement reports the recall search matched — recalls lists the newest 5 of them. Null when the recall sub-query failed (listed in degraded): unknown, not zero.',
      ),
    approval: z
      .object({
        applicationNumber: z.string().nullable().describe('NDA, ANDA, or BLA application number.'),
        sponsor: z.string().nullable().describe('Sponsor/applicant name.'),
        marketingStatus: z.string().nullable().describe('Derived marketing/approval status.'),
        brandNames: z
          .array(z.string())
          .describe("Brand names of the application's products (products.brand_name)."),
        candidates: z
          .number()
          .describe(
            'Drugs@FDA applications the ranked search matched. Above 100, only the first 100 were ranked, and a notice says so.',
          ),
      })
      .nullable()
      .describe(
        "The drug's own Drugs@FDA application, ranked over up to 100 matches of the input name: NDA and BLA applications by openfda.generic_name or products.active_ingredients.name, and any application whose products.brand_name is the name. Ranked on each application's own products: a brand name equal to the input that is not an ingredient name, then one ingredient (several when the name is a combination), then an ingredient without a biologic suffix, then reference_drug Yes, then NDA or BLA, then marketed over discontinued over tentative, then the lowest application number. When the name matches none, the same rank runs over meta.fanOutKey's openfda.generic_name and products.active_ingredients.name matches. Null when nothing matched or the search failed (listed in degraded).",
      ),
    shortage: z
      .object({
        status: z
          .string()
          .nullable()
          .describe(
            'Status of the shown record (Current, To Be Discontinued, or Resolved) — one presentation, not the whole drug; statusCounts tallies every record.',
          ),
        availability: z.string().nullable().describe('Availability note (truncated).'),
        product: z
          .string()
          .nullable()
          .describe(
            "Product the shown record covers: its openfda.brand_name, else its presentation's lead.",
          ),
        company: z.string().nullable().describe('Company the shown record names (company_name).'),
        presentation: z
          .string()
          .nullable()
          .describe('Presentation the shown record covers: product, dosage form, strength, NDC.'),
        namesInput: z
          .boolean()
          .describe(
            "True when the shown record names the input drug, by product or presentation, or the input itself keyed the search. False for brand input no record names: the record shown is the newest for meta.fanOutKey, another product's.",
          ),
        total: z.number().describe('Shortage records whose generic_name matches meta.fanOutKey.'),
        statusCounts: z
          .array(
            z
              .object({
                status: z.string().nullable().describe('Shortage status.'),
                count: z.number().describe('Records with this status.'),
              })
              .describe('A status paired with its record count.'),
          )
          .describe('Records per status over the newest 100 matches, most frequent first.'),
      })
      .nullable()
      .describe(
        'One drug/shortages record for meta.fanOutKey — for brand input, the newest naming the brand, else the newest — with the product, company, and presentation it covers, the match total, and per-status counts. Null when none on record or the search failed (listed in degraded).',
      ),
    degraded: z
      .array(
        z
          .object({
            section: z.enum(SECTIONS).describe('Profile section whose sub-query failed.'),
            reason: z
              .string()
              .describe(
                'Machine-readable failure reason (e.g. rate_limited, upstream_error, query_error, or timeout when the profile deadline cut the request).',
              ),
            message: z.string().describe('Upstream failure message for this section, truncated.'),
          })
          .describe('One failed sub-query and why it failed.'),
      )
      .describe(
        'Sub-queries that failed upstream, empty when every section resolved. A section listed here is unknown, not absent — a null section with no entry here genuinely has no FDA record.',
      ),
  }),

  errors: [
    {
      reason: 'blank_drug_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The drug name carries no searchable character — only quotes, backslashes, or whitespace.',
      recovery:
        'Supply a brand or generic drug name with at least one searchable character, for example "metformin".',
    },
  ],

  enrichment: {
    sectionsFound: z
      .number()
      .describe(
        'How many profile sections (label, adverse_events, recalls, approval, shortage) returned data.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the drug could not be resolved, upstream errors degraded the profile, a failed label lookup left another label shown, or the approval ranking or shortage counts covered only the first 100 matches. Absent otherwise.',
      ),
  },

  async handler(input, ctx) {
    const svc = getOpenFdaService();
    const term = input.drug.trim();
    // Guard on searchable content, not on the raw input: a name made only of
    // delimiters survives the schema, and searching for the literal delimiters
    // would return an unrelated record set as a "profile".
    if (!hasSearchableCharacter(term)) {
      throw ctx.fail(
        'blank_drug_name',
        `"${input.drug}" has no searchable characters, so it cannot be resolved to an FDA drug.`,
      );
    }
    // Escaped once here; every interpolation below uses the escaped form, so a
    // new sub-query cannot reintroduce the defect by interpolating `term` raw.
    const termPhrase = phrase(term);

    const sink: FailureSink = { failures: [], signal: ctx.signal };
    // One instant for every request of every round, so retries and backoffs in
    // successive rounds cannot add up past the client's request timeout.
    const deadline = { deadlineAtMs: Date.now() + PROFILE_DEADLINE_MS };
    const query = (endpoint: string, params: OpenFdaQueryParams) =>
      svc.query(endpoint, params, ctx, deadline);
    const termLower = term.toLowerCase();

    /*
     * 1. Resolve identity and select the approval in one round. The label search
     * asks for an original packager's label, so a repackager's never stands in for
     * the drug. The Drugs@FDA selection searches the typed name — NDAs and BLAs by
     * ingredient, any application by brand — so the drug's own application is
     * among the candidates `pickApplication` ranks.
     */
    const nameClauses = `openfda.generic_name:"${termPhrase}" OR openfda.brand_name:"${termPhrase}"`;
    const [flaggedRes, selectionRes] = await Promise.all([
      settle(
        'label',
        () =>
          query('drug/label', {
            search: `(${nameClauses}) AND openfda.is_original_packager:true`,
            limit: 5,
          }),
        sink,
        'the original-packager label search',
      ),
      settle(
        'approval',
        () =>
          query('drug/drugsfda', {
            search: `((openfda.generic_name:"${termPhrase}" OR products.active_ingredients.name:"${termPhrase}") AND (application_number:NDA* OR application_number:BLA*)) OR (products.brand_name:"${termPhrase}" AND NOT products.active_ingredients.name:"${termPhrase}")`,
            limit: CANDIDATE_LIMIT,
          }),
        sink,
      ),
    ]);
    // A global failure (bad key, forbidden endpoint, caller gone): more requests
    // would only widen the blast radius.
    if (sink.fatal) throw sink.fatal;

    let labelRecord = flaggedRes
      ? bestMatch(flaggedRes.results, termLower, openfdaNames)
      : undefined;
    let ndcRecord: Record<string, unknown> | undefined;
    /* 2. No original packager's label matched: any label, with drug/ndc beside it. */
    if (!labelRecord) {
      const [labelRes, ndcRes] = await Promise.all([
        settle(
          'label',
          () => query('drug/label', { search: nameClauses, limit: 5 }),
          sink,
          'the label search',
        ),
        settle(
          'identity',
          () =>
            query('drug/ndc', {
              search: `generic_name:"${termPhrase}" OR brand_name:"${termPhrase}"`,
              limit: 5,
            }),
          sink,
        ),
      ]);
      if (sink.fatal) throw sink.fatal;
      labelRecord = labelRes ? bestMatch(labelRes.results, termLower, openfdaNames) : undefined;
      if (!labelRecord && ndcRes) ndcRecord = bestMatch(ndcRes.results, termLower, ndcNames);
    }

    let resolvedVia: 'label' | 'ndc' | 'none' = labelRecord ? 'label' : ndcRecord ? 'ndc' : 'none';
    let identity: Identity = labelRecord
      ? identityFromLabel(labelRecord)
      : ndcRecord
        ? identityFromNdc(ndcRecord)
        : EMPTY_IDENTITY;

    /*
     * 3. Fan out in parallel off the resolved identity. Structured endpoints key off
     * `fanOutKeyFor` — a typed ingredient, else the resolved generic name; the free-text
     * adverse-event field keys off the user's term, which matches the heterogeneous
     * reporter-entered medicinalproduct values with better recall. Recalls and the
     * approval fallback also search each record's own field for the key: openFDA fills
     * `openfda.*` only on the records it could harmonize.
     */
    const key = fanOutKeyFor(term, identity.generic_name, identity.brand_names[0]);
    const keyPhrase = phrase(key);
    const picked = selectionRes ? pickApplication(selectionRes.results, term, key) : undefined;
    const pickNumber = picked ? first(picked.application_number) : null;
    if (labelRecord && pickNumber !== null) identity = identityFromLabel(labelRecord, pickNumber);
    // The label in hand is not the picked application's own: look that one up.
    const ownLabelFor =
      pickNumber !== null && !(labelRecord && isOwnLabelOf(labelRecord, pickNumber))
        ? pickNumber
        : null;
    const eventSearch = `patient.drug.medicinalproduct:"${termPhrase}"`;
    const [
      eventTotalRes,
      reactionsRes,
      seriousRes,
      recallsRes,
      shortageRes,
      ownLabelRes,
      fallbackRes,
    ] = await Promise.all([
      // The match total. A count response carries no total, and summing the
      // `serious` buckets would drop every report with no seriousness recorded.
      settle('adverse_events', () => query('drug/event', { search: eventSearch, limit: 0 }), sink),
      settle(
        'adverse_events',
        () =>
          query('drug/event', {
            search: eventSearch,
            count: 'patient.reaction.reactionmeddrapt.exact',
            limit: 5,
          }),
        sink,
      ),
      settle(
        'adverse_events',
        () => query('drug/event', { search: eventSearch, count: 'serious' }),
        sink,
      ),
      settle(
        'recalls',
        () =>
          query('drug/enforcement', {
            search: `openfda.generic_name:"${keyPhrase}" OR product_description:"${keyPhrase}"`,
            sort: 'report_date:desc',
            limit: 5,
          }),
        sink,
      ),
      settle(
        'shortage',
        () =>
          query('drug/shortages', {
            search: `generic_name:"${keyPhrase}"`,
            sort: 'update_date:desc',
            limit: CANDIDATE_LIMIT,
          }),
        sink,
      ),
      ownLabelFor === null
        ? null
        : settle(
            'label',
            () =>
              query('drug/label', {
                search: `openfda.application_number:"${phrase(ownLabelFor)}" AND openfda.is_original_packager:true`,
                limit: 5,
              }),
            sink,
            `the original-packager label search for ${ownLabelFor}`,
          ),
      // The name matched no NDA, BLA, or brand: rank the fan-out key's matches instead.
      selectionRes?.results.length === 0
        ? settle(
            'approval',
            () =>
              query('drug/drugsfda', {
                search: `openfda.generic_name:"${keyPhrase}" OR products.active_ingredients.name:"${keyPhrase}"`,
                limit: CANDIDATE_LIMIT,
              }),
            sink,
          )
        : null,
    ]);

    // Auth/config failures and cancellation stay accessible to the caller rather
    // than collapsing into an empty best-effort profile.
    if (sink.fatal) throw sink.fatal;

    /* 4. Merge sections (best-effort: absent/failed → null). */
    const ownLabel = ownLabelRes
      ? bestMatch(ownLabelRes.results, termLower, openfdaNames)
      : undefined;
    if (ownLabel && ownLabelFor !== null) {
      labelRecord = ownLabel;
      identity = identityFromLabel(ownLabel, ownLabelFor);
      resolvedVia = 'label';
    }

    const label = labelRecord
      ? {
          indications: section(labelRecord.indications_and_usage),
          // Rx SPL labels carry safety text in boxed_warning / warnings_and_cautions;
          // the bare `warnings` field is the OTC-monograph section and is null for
          // most prescription drugs. Fall back through the Rx sections first.
          warnings: section(
            labelRecord.boxed_warning ?? labelRecord.warnings_and_cautions ?? labelRecord.warnings,
          ),
          dosage: section(labelRecord.dosage_and_administration),
        }
      : null;

    let adverse_events: {
      total: number;
      seriousCount: number;
      topReactions: Array<{ term: string; count: number }>;
    } | null = null;
    // All three sub-queries or nothing: a failed one leaves the section unknown
    // (listed in `degraded`) rather than reported beside an invented figure.
    if (eventTotalRes && reactionsRes && seriousRes) {
      const topReactions = reactionsRes.results.map((r) => ({
        term: String((r as Record<string, unknown>).term),
        count: Number((r as Record<string, unknown>).count ?? 0),
      }));
      const total = eventTotalRes.meta.total;
      const seriousBucket = (seriousRes.results as Array<Record<string, unknown>>).find(
        (b) => String(b.term) === '1',
      );
      // A matched set with no serious=1 bucket has no serious reports.
      const seriousCount = Number(seriousBucket?.count ?? 0);
      if (topReactions.length > 0 || total > 0) {
        adverse_events = { total, seriousCount, topReactions };
      }
    }

    const recalls = (recallsRes?.results ?? []).map((r) => {
      const rec = r as Record<string, unknown>;
      return {
        classification: (rec.classification as string) ?? null,
        reason: rec.reason_for_recall ? truncate(rec.reason_for_recall as string, 300) : null,
        recalling_firm: (rec.recalling_firm as string) ?? null,
        date: (rec.recall_initiation_date as string) ?? (rec.report_date as string) ?? null,
      };
    });
    // Unknown, not zero, when the recall sub-query failed.
    const recalls_total = recallsRes ? recallsRes.meta.total : null;

    const fallbackPick = fallbackRes ? pickApplication(fallbackRes.results, term, key) : undefined;
    const approval =
      picked && selectionRes
        ? approvalOf(picked, selectionRes.meta.total)
        : fallbackPick && fallbackRes
          ? approvalOf(fallbackPick, fallbackRes.meta.total)
          : null;

    const shortage = shortageRes
      ? summarizeShortage(shortageRes.results, shortageRes.meta.total, term, key)
      : null;

    const sectionsFound = [
      label,
      adverse_events,
      recalls.length > 0 ? recalls : null,
      approval,
      shortage,
    ].filter((s) => s != null).length;

    /*
     * One entry per section, not per sub-query — the three adverse-event calls share
     * a section — in section order. A label in hand still fills the section, so a
     * label lookup that failed beside it is named in a notice instead; a failed
     * drug/ndc lookup matters only while identity stays unresolved.
     */
    const degraded = [
      ...new Map(
        sink.failures
          .filter(
            (f) =>
              !(f.section === 'label' && labelRecord) &&
              !(f.section === 'identity' && resolvedVia !== 'none'),
          )
          .map(({ section, reason, message }) => [section, { section, reason, message }]),
      ).values(),
    ].sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));

    ctx.log.info('Drug profile completed', {
      drug: term,
      resolvedVia,
      sectionsFound,
      approval: approval?.applicationNumber ?? null,
      degradedSections: degraded.map((d) => d.section),
    });

    // `notice` is last-wins, so every condition this call raises is joined into one.
    const notices: string[] = [];
    if (degraded.length > 0) {
      // Never attribute an upstream failure to a misspelled drug — say which
      // sections failed and why, and only then note an unresolved identity.
      const detail = degraded.map((d) => `${d.section} (${d.reason})`).join(', ');
      notices.push(
        `Partial profile — these sections failed upstream and are unknown, not empty: ${detail}. Retry for a complete profile.${
          resolvedVia === 'none'
            ? ' Identity was not resolved either, which may be a consequence of the same failures.'
            : ''
        }`,
      );
    } else if (resolvedVia === 'none' && sectionsFound === 0) {
      notices.push(
        `Could not resolve ${codeLiteral(input.drug)} to an FDA drug. Check the spelling, try the generic name, or query openfda_get_drug_label / openfda_lookup_ndc directly.`,
      );
    }
    // A failed lookup could only have found a label the rule ranks above the one
    // shown — unless the one shown is already the picked application's own.
    const failedLookups = sink.failures.filter((f) => f.section === 'label');
    if (
      labelRecord &&
      failedLookups.length > 0 &&
      !(pickNumber !== null && isOwnLabelOf(labelRecord, pickNumber))
    ) {
      const lookups = failedLookups.map((f) => `${f.lookup} (${f.reason})`).join(', ');
      const owner = identity.manufacturer ? `${identity.manufacturer}'s` : "an unnamed labeler's";
      const filing = identity.application_number
        ? `, filed under ${identity.application_number}`
        : '';
      notices.push(
        `Label lookup partly failed — ${lookups}; the label shown is ${owner}${filing}. Retry for the drug's own label.`,
      );
    }
    if (approval && approval.candidates > CANDIDATE_LIMIT) {
      notices.push(
        `Approval was ranked over the first ${CANDIDATE_LIMIT} of ${approval.candidates} matching Drugs@FDA applications, so the drug's own application may lie beyond them.`,
      );
    }
    if (shortage && shortage.total > CANDIDATE_LIMIT) {
      notices.push(
        `Shortage status counts cover the newest ${CANDIDATE_LIMIT} of ${shortage.total} matching records.`,
      );
    }

    ctx.enrich({ sectionsFound });
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      meta: { drug: input.drug, resolvedVia, fanOutKey: key },
      identity,
      label,
      adverse_events,
      recalls,
      recalls_total,
      approval,
      shortage,
      degraded,
    };
  },

  format: (result) => {
    const {
      identity,
      label,
      adverse_events,
      recalls,
      recalls_total,
      approval,
      shortage,
      degraded,
      meta,
    } = result;
    /*
     * The drug name and the fan-out key (the typed term, when it keys the
     * sub-queries) are caller text, so each rides as a code literal: a span in
     * the line, or a fence on the lines after it when the value holds a break.
     * The emphasis closes before the key, since a fence cannot sit inside it.
     */
    const lines: string[] = [
      `# Drug profile: ${codeLiteral(meta.drug)}`,
      `_Resolved via: ${meta.resolvedVia}_ · fan-out key: ${codeLiteral(meta.fanOutKey)}`,
      '',
    ];

    // Ahead of the sections themselves, so an empty section is never read as
    // "no FDA record" when the sub-query behind it actually failed.
    if (degraded.length > 0) {
      lines.push(`## Degraded (${degraded.length} section${degraded.length === 1 ? '' : 's'})`);
      lines.push('These sub-queries failed upstream — the data below is unknown, not absent:');
      for (const d of degraded) {
        lines.push(singleLine(`- **${d.section}** — ${d.reason}: ${d.message}`));
      }
      lines.push('');
    }

    lines.push('## Identity');
    lines.push(
      ...[
        `**Brand names:** ${identity.brand_names.length ? identity.brand_names.join(', ') : 'n/a'}`,
        `**Generic name:** ${identity.generic_name ?? 'n/a'}`,
        `**Product NDC:** ${identity.product_ndc ?? 'n/a'}`,
        `**Manufacturer:** ${identity.manufacturer ?? 'n/a'} | **Application number:** ${identity.application_number ?? 'n/a'} | **Original packager:** ${
          identity.is_original_packager === null
            ? 'n/a'
            : identity.is_original_packager
              ? 'yes'
              : "no — openFDA does not flag this record as the original packager's"
        }`,
        `**RxCUI:** ${identity.rxcui ?? 'n/a'}`,
        `**SPL set ID:** ${identity.spl_set_id ?? 'n/a'}`,
      ].map(singleLine),
    );
    lines.push('');

    lines.push('## Label');
    if (label) {
      lines.push(
        ...[
          `**Indications:** ${label.indications ?? 'n/a'}`,
          `**Warnings:** ${label.warnings ?? 'n/a'}`,
          `**Dosage:** ${label.dosage ?? 'n/a'}`,
        ].map(singleLine),
      );
    } else if (degraded.some((d) => d.section === 'label')) {
      lines.push('Unknown — the label search failed upstream (see Degraded).');
    } else {
      lines.push('No label on file.');
    }
    lines.push('');

    lines.push('## Adverse events');
    if (adverse_events) {
      lines.push(
        `**Total reports:** ${adverse_events.total} | **Serious count:** ${adverse_events.seriousCount}`,
      );
      lines.push('**Top reactions** (term — count):');
      if (adverse_events.topReactions.length) {
        for (const r of adverse_events.topReactions) {
          lines.push(`- ${lineContent(`${r.term}: ${r.count}`)}`);
        }
      } else {
        lines.push('- none');
      }
    } else if (degraded.some((d) => d.section === 'adverse_events')) {
      lines.push('Unknown — the adverse-event search failed upstream (see Degraded).');
    } else {
      lines.push('No adverse-event data.');
    }
    lines.push('');

    lines.push(
      `## Recalls (${recalls_total === null ? 'unknown' : `${recalls.length} of ${recalls_total}`})`,
    );
    if (recalls_total === null) {
      lines.push('Unknown — the recall search failed upstream (see Degraded).');
    } else if (recalls.length) {
      for (const r of recalls) {
        lines.push(
          singleLine(
            `- **Classification:** ${r.classification ?? 'n/a'} · **Recalling firm:** ${r.recalling_firm ?? 'n/a'} · **Date:** ${r.date ?? 'n/a'}`,
          ),
        );
        lines.push(singleLine(`  **Reason:** ${r.reason ?? 'n/a'}`));
      }
    } else {
      lines.push(
        'No drug/enforcement report matches the fan-out key in openfda.generic_name or product_description. Reports naming the drug another way are not covered; openfda_search_recalls searches any field.',
      );
    }
    lines.push('');

    lines.push('## Approval');
    if (approval) {
      const { candidates } = approval;
      lines.push(
        ...[
          `**Application number:** ${approval.applicationNumber ?? 'n/a'} | **Sponsor:** ${approval.sponsor ?? 'n/a'} | **Marketing status:** ${approval.marketingStatus ?? 'n/a'}`,
          `**Brand names:** ${approval.brandNames.length ? approval.brandNames.join(', ') : 'n/a'}`,
        ].map(singleLine),
        candidates > CANDIDATE_LIMIT
          ? `**Candidates ranked:** the first ${CANDIDATE_LIMIT} of ${candidates} matching applications — the drug's own may lie past them`
          : `**Candidates ranked:** ${candidates} matching application${candidates === 1 ? '' : 's'}`,
      );
      // Each section names its own product: identity and approval can be two applications.
      if (
        identity.application_number !== null &&
        approval.applicationNumber !== null &&
        identity.application_number !== approval.applicationNumber
      ) {
        lines.push(
          singleLine(
            `The ${label ? 'identity and label above come' : 'identity above comes'} from ${identity.application_number}, a different application.`,
          ),
        );
      }
    } else if (degraded.some((d) => d.section === 'approval')) {
      lines.push('Unknown — the Drugs@FDA search failed upstream (see Degraded).');
    } else {
      lines.push(
        'No Drugs@FDA application matches the drug name as an NDA or BLA ingredient or as a brand name, nor the fan-out key in openfda.generic_name or products.active_ingredients.name. openfda_search_drug_approvals searches any field.',
      );
    }
    lines.push('');

    lines.push('## Shortage');
    if (shortage) {
      const counts = shortage.statusCounts.map((c) => `${c.status ?? 'n/a'} ${c.count}`).join(', ');
      lines.push(
        ...[
          `**Status:** ${shortage.status ?? 'n/a'}`,
          `**Availability:** ${shortage.availability ?? 'n/a'}`,
          `**Product:** ${shortage.product ?? 'n/a'} | **Company:** ${shortage.company ?? 'n/a'}`,
          `**Presentation:** ${shortage.presentation ?? 'n/a'}`,
          shortage.total > CANDIDATE_LIMIT
            ? `**Records:** ${shortage.total} — by status over the newest ${CANDIDATE_LIMIT}: ${counts}`
            : `**Records:** ${shortage.total} — by status: ${counts}`,
        ].map(singleLine),
      );
      if (!shortage.namesInput) {
        lines.push(
          `No shortage record names ${codeLiteral(meta.drug)} itself; the record above is the newest for the fan-out key.`,
        );
      }
    } else if (degraded.some((d) => d.section === 'shortage')) {
      lines.push('Unknown — the shortage search failed upstream (see Degraded).');
    } else {
      lines.push('Not currently listed in the shortage database.');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

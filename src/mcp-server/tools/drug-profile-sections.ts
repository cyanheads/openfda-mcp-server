/**
 * @fileoverview Selection logic behind `openfda_drug_profile`: the Drugs@FDA ranking that
 * picks a drug's own application (`pickApplication`), the approval section built from it,
 * and the shortage summary over the newest records. Pure functions over openFDA records,
 * kept apart from the tool's fan-out and rendering.
 * @module mcp-server/tools/drug-profile-sections
 */

import { truncate } from '@/mcp-server/tools/format-utils.js';

/**
 * Lowercased runs of letters and digits — the words openFDA's analyzer keeps from a
 * quoted phrase, so `ADALIMUMAB-AACF` is `adalimumab aacf` and `metformin` stays one.
 */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** First non-empty string in an openFDA array field (or a bare string), else null. */
export function first(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string' && v.length > 0) return v;
    return null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Every string in an openFDA array field (or a bare string), duplicates dropped. */
export function strings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/** A record's openfda block — empty when openFDA harmonized nothing for it. */
export function openfdaOf(rec: Record<string, unknown>): Record<string, unknown> {
  return (rec.openfda ?? {}) as Record<string, unknown>;
}

/** Derive a human marketing/approval status from a Drugs@FDA application record. */
function deriveMarketingStatus(app: Record<string, unknown>): string | null {
  const products = app.products as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(products)) {
    const statuses = [
      ...new Set(
        products.map((p) => p.marketing_status).filter((s): s is string => typeof s === 'string'),
      ),
    ];
    if (statuses.length > 0) return statuses.join(', ');
  }
  const submissions = app.submissions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(submissions)) {
    if (submissions.some((s) => s.submission_status === 'AP')) return 'Approved';
    const status = submissions.find(
      (s) => typeof s.submission_status === 'string',
    )?.submission_status;
    if (typeof status === 'string') return status;
  }
  return null;
}

/** True when `a` and `b` are the same words, in order — and there are some. */
function sameWords(a: string, b: string): boolean {
  const words = wordsOf(a);
  return words.length > 0 && words.join(' ') === wordsOf(b).join(' ');
}

/** True when `lead`'s words open `text`'s, in order. */
function startsWithWords(text: string, lead: string): boolean {
  const words = wordsOf(text);
  const prefix = wordsOf(lead);
  return prefix.length > 0 && prefix.every((word, i) => words[i] === word);
}

/** A name that joins several ingredients (`sitagliptin and metformin`, `a/b`). */
const COMBINATION = /\s(?:and|with)\s|[,;/+]/i;

/** The four-letter suffix a biologic's proper name carries (`ADALIMUMAB-AACF`). */
const BIOLOGIC_SUFFIX = /-[a-z]{4}$/i;

/** Words a generic product name joins its ingredient names with. */
const CONNECTIVES = new Set(['and', 'with', 'in']);

/** Marketed, then discontinued, then anything else (a tentative approval, `None`). */
function marketingRank(status: unknown): number {
  if (status === 'Prescription' || status === 'Over-the-counter') return 2;
  return status === 'Discontinued' ? 1 : 0;
}

/** First tier where two ranks differ decides; positive when `a` ranks higher. */
function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Rank of one Drugs@FDA product as the input drug's own, one number per tier,
 * highest first: a brand name equal to the input (not one made of its ingredient
 * names, as a generic's is) → one ingredient, or several when `key` names a
 * combination → ingredients without a biologic suffix, led by the key's words
 * for a single key → `reference_drug: "Yes"` → an NDA or BLA → marketed over
 * discontinued over tentative.
 */
function productRank(
  product: Record<string, unknown>,
  applicationNumber: string,
  input: string,
  key: string,
): number[] {
  const brand = typeof product.brand_name === 'string' ? product.brand_name : '';
  const ingredients = (Array.isArray(product.active_ingredients) ? product.active_ingredients : [])
    .map((ingredient) => (ingredient as Record<string, unknown>).name)
    .filter((name): name is string => typeof name === 'string');
  const ingredientWords = new Set(ingredients.flatMap(wordsOf));
  const combination = COMBINATION.test(key);
  const brandOwn =
    sameWords(brand, input) &&
    !wordsOf(brand).every((word) => ingredientWords.has(word) || CONNECTIVES.has(word));
  const shape = combination ? ingredients.length > 1 : ingredients.length === 1;
  const plain =
    ingredients.length > 0 &&
    ingredients.every((name) => !BIOLOGIC_SUFFIX.test(name)) &&
    (combination || ingredients.some((name) => startsWithWords(name, key)));
  return [
    Number(brandOwn),
    Number(shape),
    Number(plain),
    Number(product.reference_drug === 'Yes'),
    Number(/^(?:NDA|BLA)/i.test(applicationNumber)),
    marketingRank(product.marketing_status),
  ];
}

/** Digits of an application number, for the lowest-number tie-break; unnumbered sorts last. */
function applicationOrdinal(applicationNumber: string): number {
  const digits = applicationNumber.replace(/\D/g, '');
  return digits ? Number(digits) : Number.POSITIVE_INFINITY;
}

/**
 * The input drug's own application among Drugs@FDA `applications`, or undefined
 * when there are none.
 *
 * Ranked on each application's own `products[]`, never its `openfda` block,
 * which openFDA harmonizes for some applications only and which drops a
 * biologic's suffix (`TRASTUZUMAB` for `TRASTUZUMAB-PKRB`). An application
 * ranks as its best product (see {@link productRank}); a tie goes to the lowest
 * application number, the original filing.
 */
export function pickApplication(
  applications: Record<string, unknown>[],
  input: string,
  key: string,
): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestRank: number[] = [];
  let bestOrdinal = Number.POSITIVE_INFINITY;
  for (const app of applications) {
    const number = typeof app.application_number === 'string' ? app.application_number : '';
    const products = Array.isArray(app.products) ? (app.products as Record<string, unknown>[]) : [];
    const rank = (products.length > 0 ? products : [{}])
      .map((product) => productRank(product, number, input, key))
      .reduce((a, b) => (compareRanks(a, b) >= 0 ? a : b));
    const ordinal = applicationOrdinal(number);
    const order = best === undefined ? 1 : compareRanks(rank, bestRank);
    if (order > 0 || (order === 0 && ordinal < bestOrdinal)) {
      best = app;
      bestRank = rank;
      bestOrdinal = ordinal;
    }
  }
  return best;
}

export interface Approval {
  applicationNumber: string | null;
  brandNames: string[];
  candidates: number;
  marketingStatus: string | null;
  sponsor: string | null;
}

/** The approval section for a picked application, ranked among `candidates` matches. */
export function approvalOf(app: Record<string, unknown>, candidates: number): Approval {
  const products = Array.isArray(app.products) ? (app.products as Record<string, unknown>[]) : [];
  return {
    applicationNumber: first(app.application_number),
    sponsor: first(app.sponsor_name),
    marketingStatus: deriveMarketingStatus(app),
    brandNames: strings(products.map((product) => product.brand_name)),
    candidates,
  };
}

export interface Shortage {
  availability: string | null;
  company: string | null;
  namesInput: boolean;
  presentation: string | null;
  product: string | null;
  status: string | null;
  statusCounts: Array<{ status: string | null; count: number }>;
  total: number;
}

/** The lead of a shortage presentation (`Hyrimoz` of `Hyrimoz, Injection, …`), or null. */
function presentationLead(rec: Record<string, unknown>): string | null {
  return first(rec.presentation)?.split(',')[0]?.trim() || null;
}

/**
 * The shortage section over the newest `records` of `total` matches for `key`.
 *
 * One record is shown: for brand input (`key` is not the typed `term`), the
 * newest record naming the brand by its product or presentation, else the
 * newest of all — then `namesInput` is false, since that record is another
 * product's. Status counts tally every record in hand.
 */
export function summarizeShortage(
  records: Record<string, unknown>[],
  total: number,
  term: string,
  key: string,
): Shortage | null {
  const own =
    key === term
      ? undefined
      : records.find((rec) =>
          [first(openfdaOf(rec).brand_name), presentationLead(rec)].some(
            (name) => name !== null && sameWords(name, term),
          ),
        );
  const shown = own ?? records[0];
  if (shown === undefined) return null;
  const counts = new Map<string | null, number>();
  for (const rec of records) {
    const status = first(rec.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return {
    status: first(shown.status),
    availability: shown.availability ? truncate(shown.availability as string, 300) : null,
    product: first(openfdaOf(shown).brand_name) ?? presentationLead(shown),
    company: first(shown.company_name),
    presentation: first(shown.presentation),
    namesInput: key === term || own !== undefined,
    total,
    statusCounts: [...counts]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
  };
}

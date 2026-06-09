/**
 * @fileoverview Composite tool that resolves one drug name to its FDA identity, then
 * fans out in parallel to the bounded per-drug openFDA endpoints and merges the results
 * into a single profile (identity, label highlights, adverse-event summary, recalls,
 * approval, shortage). Resolving identity once and keying every sub-query off the same
 * identifier set is what prevents the identifier drift that breaks naive tool chaining.
 * @module mcp-server/tools/definitions/drug-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { truncate } from '@/mcp-server/tools/format-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

/** Strip double quotes so a free-text drug name embeds safely in a quoted query clause. */
function sanitize(term: string): string {
  return term.replace(/"/g, '').trim();
}

/** First non-empty string in an openFDA array field (or a bare string), else null. */
function first(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string' && v.length > 0) return v;
    return null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Generic and brand names from a record's openfda block, for match scoring. */
function openfdaNames(rec: Record<string, unknown>): { generic: string; brand: string } {
  const o = (rec.openfda ?? {}) as Record<string, unknown>;
  return { generic: first(o.generic_name) ?? '', brand: first(o.brand_name) ?? '' };
}

/** Truncate a label section (array or string) to a readable length, or null when absent. */
function section(value: unknown, max = 600): string | null {
  const text = Array.isArray(value) ? value.filter((v) => typeof v === 'string').join('\n') : value;
  if (typeof text !== 'string' || text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

interface Identity {
  brand_names: string[];
  generic_name: string | null;
  product_ndc: string | null;
  rxcui: string | null;
  spl_set_id: string | null;
}

const EMPTY_IDENTITY: Identity = {
  brand_names: [],
  generic_name: null,
  product_ndc: null,
  rxcui: null,
  spl_set_id: null,
};

/** Build identity from a drug/label record (the richest openfda block + set_id). */
function identityFromLabel(rec: Record<string, unknown>): Identity {
  const o = (rec.openfda ?? {}) as Record<string, unknown>;
  const brands = Array.isArray(o.brand_name)
    ? (o.brand_name as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return {
    brand_names: [...new Set(brands)],
    generic_name: first(o.generic_name),
    product_ndc: first(o.product_ndc),
    rxcui: first(o.rxcui),
    spl_set_id: first(o.spl_set_id) ?? (typeof rec.set_id === 'string' ? rec.set_id : null),
  };
}

/** Build identity from a drug/ndc record (top-level fields + openfda cross-refs). */
function identityFromNdc(rec: Record<string, unknown>): Identity {
  const o = (rec.openfda ?? {}) as Record<string, unknown>;
  const brandTop = typeof rec.brand_name === 'string' ? rec.brand_name : null;
  const brands = brandTop
    ? [brandTop]
    : Array.isArray(o.brand_name)
      ? (o.brand_name as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
  return {
    brand_names: [...new Set(brands)],
    generic_name:
      (typeof rec.generic_name === 'string' ? rec.generic_name : null) ?? first(o.generic_name),
    product_ndc:
      (typeof rec.product_ndc === 'string' ? rec.product_ndc : null) ?? first(o.product_ndc),
    rxcui: first(o.rxcui),
    spl_set_id: first(o.spl_set_id),
  };
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

/** Run a best-effort sub-query: resolve to its result, or null (flagging degradation) on error. */
async function settle<T>(fn: () => Promise<T>, onError: () => void): Promise<T | null> {
  try {
    return await fn();
  } catch {
    onError();
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
    'Resolve one drug name to its FDA identity, then fan out in parallel across the bounded per-drug openFDA endpoints and merge into one profile: identity, label highlights, adverse-event summary, recall history, Drugs@FDA approval, and shortage status. Replaces chaining openfda_get_drug_label, openfda_search_adverse_events, openfda_search_recalls, openfda_search_drug_approvals, and openfda_search_drug_shortages — and reconciles the identifier drift between endpoints that makes that chaining error-prone. Each section is best-effort: a miss returns null rather than failing the call. For deep dives into any one area, use the dedicated tool.',
  annotations: { readOnlyHint: true },

  input: z.object({
    drug: z
      .string()
      .min(1)
      .describe(
        'Drug name to profile — brand or generic (e.g. "metformin", "Humira", "Glucophage"). Resolved once to canonical FDA identifiers, which then key every sub-query.',
      ),
  }),

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
            'Canonical key the structured sub-queries (recall/enforcement, Drugs@FDA approval, shortage) ran against — the resolved generic name, falling back to a brand name, then the input term. The adverse-event sub-query instead keys off the raw input term to match heterogeneous reporter-entered values.',
          ),
      })
      .describe('Request metadata.'),
    identity: z
      .object({
        brand_names: z.array(z.string()).describe('Brand names for the drug (openfda.brand_name).'),
        generic_name: z
          .string()
          .nullable()
          .describe(
            'Canonical generic name (openfda.generic_name) — the primary source for meta.fanOutKey.',
          ),
        product_ndc: z.string().nullable().describe('Representative product NDC, when available.'),
        rxcui: z.string().nullable().describe('RxNorm concept unique identifier, when available.'),
        spl_set_id: z
          .string()
          .nullable()
          .describe('SPL set ID for the drug label, when available.'),
      })
      .describe(
        'Identity resolved once and reused across every sub-query to avoid identifier drift.',
      ),
    label: z
      .object({
        indications: z.string().nullable().describe('Indications and usage (truncated).'),
        warnings: z.string().nullable().describe('Warnings (truncated).'),
        dosage: z.string().nullable().describe('Dosage and administration (truncated).'),
      })
      .nullable()
      .describe('Label highlights from drug/label, or null when no label matched.'),
    adverse_events: z
      .object({
        total: z.number().describe('Approximate total adverse-event reports naming this drug.'),
        seriousCount: z.number().describe('Reports flagged serious (serious=1).'),
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
      .describe('Recent drug/enforcement recall actions (may be empty).'),
    approval: z
      .object({
        applicationNumber: z.string().nullable().describe('NDA/ANDA application number.'),
        sponsor: z.string().nullable().describe('Sponsor/applicant name.'),
        marketingStatus: z.string().nullable().describe('Derived marketing/approval status.'),
      })
      .nullable()
      .describe('Drugs@FDA approval summary, or null when no application matched.'),
    shortage: z
      .object({
        status: z.string().nullable().describe('Shortage status (Current/Resolved).'),
        availability: z.string().nullable().describe('Availability note (truncated).'),
      })
      .nullable()
      .describe('Current or most-recent drug shortage status, or null when none on record.'),
  }),

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
        'Guidance when the drug could not be resolved or upstream errors degraded the profile. Absent on a fully populated profile.',
      ),
  },

  async handler(input, ctx) {
    const svc = getOpenFdaService();
    const term = sanitize(input.drug);
    let degraded = false;
    const flag = () => {
      degraded = true;
    };

    /* 1. Resolve identity once — drug/label first (richest, doubles as the label section), drug/ndc fallback. */
    let resolvedVia: 'label' | 'ndc' | 'none' = 'none';
    let identity: Identity = EMPTY_IDENTITY;
    let labelRecord: Record<string, unknown> | null = null;

    const termLower = term.toLowerCase();
    const labelResolve = await settle(
      () =>
        svc.query(
          'drug/label',
          { search: `openfda.generic_name:"${term}" OR openfda.brand_name:"${term}"`, limit: 5 },
          ctx,
        ),
      flag,
    );
    if (labelResolve && labelResolve.results.length > 0) {
      const records = labelResolve.results as Record<string, unknown>[];
      const best = bestMatch(records, termLower, openfdaNames) ?? records[0];
      if (best) {
        labelRecord = best;
        identity = identityFromLabel(best);
        resolvedVia = 'label';
      }
    } else {
      const ndcResolve = await settle(
        () =>
          svc.query(
            'drug/ndc',
            { search: `generic_name:"${term}" OR brand_name:"${term}"`, limit: 5 },
            ctx,
          ),
        flag,
      );
      if (ndcResolve && ndcResolve.results.length > 0) {
        const records = ndcResolve.results as Record<string, unknown>[];
        const best =
          bestMatch(records, termLower, (r) => {
            const o = (r.openfda ?? {}) as Record<string, unknown>;
            return {
              generic: (r.generic_name as string) ?? first(o.generic_name) ?? '',
              brand: (r.brand_name as string) ?? first(o.brand_name) ?? '',
            };
          }) ?? records[0];
        if (best) {
          identity = identityFromNdc(best);
          resolvedVia = 'ndc';
        }
      }
    }

    /*
     * 2. Fan out in parallel off the resolved identity. Structured endpoints key off the
     * canonical generic name; the free-text adverse-event field keys off the user's term,
     * which matches the heterogeneous reporter-entered medicinalproduct values with better recall.
     */
    const key = sanitize(identity.generic_name ?? identity.brand_names[0] ?? term);
    const [reactionsRes, seriousRes, recallsRes, approvalRes, shortageRes] = await Promise.all([
      settle(
        () =>
          svc.query(
            'drug/event',
            {
              search: `patient.drug.medicinalproduct:"${term}"`,
              count: 'patient.reaction.reactionmeddrapt.exact',
              limit: 5,
            },
            ctx,
          ),
        flag,
      ),
      settle(
        () =>
          svc.query(
            'drug/event',
            { search: `patient.drug.medicinalproduct:"${term}"`, count: 'serious' },
            ctx,
          ),
        flag,
      ),
      settle(
        () =>
          svc.query(
            'drug/enforcement',
            { search: `openfda.generic_name:"${key}"`, sort: 'report_date:desc', limit: 5 },
            ctx,
          ),
        flag,
      ),
      settle(
        () =>
          svc.query('drug/drugsfda', { search: `openfda.generic_name:"${key}"`, limit: 5 }, ctx),
        flag,
      ),
      settle(
        () =>
          svc.query(
            'drug/shortages',
            { search: `generic_name:"${key}"`, sort: 'update_date:desc', limit: 1 },
            ctx,
          ),
        flag,
      ),
    ]);

    /* 3. Merge sections (best-effort: absent/failed → null). */
    const label = labelRecord
      ? {
          indications: section(labelRecord.indications_and_usage),
          warnings: section(labelRecord.warnings),
          dosage: section(labelRecord.dosage_and_administration),
        }
      : null;

    let adverse_events: {
      total: number;
      seriousCount: number;
      topReactions: Array<{ term: string; count: number }>;
    } | null = null;
    if (reactionsRes) {
      const topReactions = reactionsRes.results.map((r) => ({
        term: String((r as Record<string, unknown>).term),
        count: Number((r as Record<string, unknown>).count ?? 0),
      }));
      const buckets = (seriousRes?.results ?? []) as Array<Record<string, unknown>>;
      const total = buckets.reduce((sum, b) => sum + Number(b.count ?? 0), 0);
      const seriousCount = Number(buckets.find((b) => String(b.term) === '1')?.count ?? 0);
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

    let approval: {
      applicationNumber: string | null;
      sponsor: string | null;
      marketingStatus: string | null;
    } | null = null;
    if (approvalRes && approvalRes.results.length > 0) {
      const apps = approvalRes.results as Record<string, unknown>[];
      const a = bestMatch(apps, termLower, openfdaNames) ?? apps[0];
      if (a) {
        approval = {
          applicationNumber: (a.application_number as string) ?? null,
          sponsor: (a.sponsor_name as string) ?? null,
          marketingStatus: deriveMarketingStatus(a),
        };
      }
    }

    let shortage: { status: string | null; availability: string | null } | null = null;
    if (shortageRes && shortageRes.results.length > 0) {
      const s = shortageRes.results[0] as Record<string, unknown>;
      shortage = {
        status: (s.status as string) ?? null,
        availability: s.availability ? truncate(s.availability as string, 300) : null,
      };
    }

    const sectionsFound = [
      label,
      adverse_events,
      recalls.length > 0 ? recalls : null,
      approval,
      shortage,
    ].filter((s) => s != null).length;

    ctx.log.info('Drug profile completed', { drug: term, resolvedVia, sectionsFound, degraded });

    ctx.enrich({ sectionsFound });
    if (resolvedVia === 'none' && sectionsFound === 0) {
      ctx.enrich.notice(
        `Could not resolve "${input.drug}" to an FDA drug. Check the spelling, try the generic name, or query openfda_get_drug_label / openfda_lookup_ndc directly.`,
      );
    } else if (degraded) {
      ctx.enrich.notice(
        'Some sections are unavailable due to upstream rate limiting or errors; retry for a complete profile.',
      );
    }

    return {
      meta: { drug: input.drug, resolvedVia, fanOutKey: key },
      identity,
      label,
      adverse_events,
      recalls,
      approval,
      shortage,
    };
  },

  format: (result) => {
    const { identity, label, adverse_events, recalls, approval, shortage, meta } = result;
    const lines: string[] = [
      `# Drug profile: ${meta.drug}`,
      `_Resolved via: ${meta.resolvedVia} · fan-out key: ${meta.fanOutKey}_`,
      '',
    ];

    lines.push('## Identity');
    lines.push(
      `**Brand names:** ${identity.brand_names.length ? identity.brand_names.join(', ') : 'n/a'}`,
    );
    lines.push(`**Generic name:** ${identity.generic_name ?? 'n/a'}`);
    lines.push(`**Product NDC:** ${identity.product_ndc ?? 'n/a'}`);
    lines.push(`**RxCUI:** ${identity.rxcui ?? 'n/a'}`);
    lines.push(`**SPL set ID:** ${identity.spl_set_id ?? 'n/a'}`);
    lines.push('');

    lines.push('## Label');
    if (label) {
      lines.push(`**Indications:** ${label.indications ?? 'n/a'}`);
      lines.push(`**Warnings:** ${label.warnings ?? 'n/a'}`);
      lines.push(`**Dosage:** ${label.dosage ?? 'n/a'}`);
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
        for (const r of adverse_events.topReactions) lines.push(`- ${r.term}: ${r.count}`);
      } else {
        lines.push('- none');
      }
    } else {
      lines.push('No adverse-event data.');
    }
    lines.push('');

    lines.push(`## Recalls (${recalls.length})`);
    if (recalls.length) {
      for (const r of recalls) {
        lines.push(
          `- **Classification:** ${r.classification ?? 'n/a'} · **Recalling firm:** ${r.recalling_firm ?? 'n/a'} · **Date:** ${r.date ?? 'n/a'}`,
        );
        lines.push(`  **Reason:** ${r.reason ?? 'n/a'}`);
      }
    } else {
      lines.push('No recalls on record.');
    }
    lines.push('');

    lines.push('## Approval');
    if (approval) {
      lines.push(
        `**Application number:** ${approval.applicationNumber ?? 'n/a'} | **Sponsor:** ${approval.sponsor ?? 'n/a'} | **Marketing status:** ${approval.marketingStatus ?? 'n/a'}`,
      );
    } else {
      lines.push('No Drugs@FDA approval found.');
    }
    lines.push('');

    lines.push('## Shortage');
    if (shortage) {
      lines.push(`**Status:** ${shortage.status ?? 'n/a'}`);
      lines.push(`**Availability:** ${shortage.availability ?? 'n/a'}`);
    } else {
      lines.push('Not currently listed in the shortage database.');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

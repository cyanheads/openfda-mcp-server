/**
 * @fileoverview Tool definition for looking up FDA drug labeling (package inserts / SPL documents).
 * @module mcp-server/tools/definitions/get-drug-label
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  OUTLINE_VARIANT,
  outlineOnOverflow,
  type SectionMeta,
  selectSections,
} from '@cyanheads/mcp-ts-core/utils';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import { emptyResultMessage, humanizeField } from '@/mcp-server/tools/format-utils.js';
import {
  assertSkipWithinCeiling,
  nonBlankString,
  SKIP_DESCRIPTION,
} from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';

const ENDPOINT = 'drug/label';

/**
 * Label identity kept through a `sections` projection. Without these the caller
 * cannot tell which product a returned section belongs to, or re-request the
 * same revision.
 */
const LABEL_METADATA_KEYS = ['openfda', 'set_id', 'id', 'effective_time', 'version'];

/**
 * Section outline for a page of SPL records: one entry per top-level label key,
 * bytes summed across the records on the page. The helper's default extractor
 * would treat the page wrapper itself (`results`) as the only section, which is
 * not a name `sections:[...]` accepts.
 */
function extractLabelSections(doc: { results: Record<string, unknown>[] }): SectionMeta[] {
  const bytes = new Map<string, number>();
  for (const record of doc.results) {
    for (const [name, value] of Object.entries(record)) {
      bytes.set(name, (bytes.get(name) ?? 0) + (JSON.stringify(value)?.length ?? 0));
    }
  }
  return [...bytes].map(([name, size]) => ({ name, bytes: size }));
}

/**
 * Name the requested sections no record on the page carries. Without this a
 * mistyped name is indistinguishable from a label that genuinely lacks the
 * section: both return the same metadata-only record. The available names are
 * listed only when nothing matched, since that is the case with no other way
 * back to a correct name.
 */
function unknownSectionNotice(
  unknown: string[],
  requested: string[],
  available: ReadonlySet<string>,
): string | undefined {
  if (unknown.length === 0 || available.size === 0) return;
  const listing =
    unknown.length === requested.length
      ? ` No requested section is present, so only metadata was returned. Available on this page: ${[...available].join(', ')}.`
      : '';
  return `Not present on this page: ${unknown.join(', ')}.${listing}`;
}

/** Re-call guidance for an overflowed page, naming the three largest sections. */
function outlineGuidance(sections: SectionMeta[], records: number): string {
  const largest = sections.slice(0, 3).map((s) => s.name);
  return `${records} label record(s) exceed the inline size budget, so this response lists the sections available instead of the label text. Re-call with the same search plus sections:[...] to retrieve specific ones — e.g. sections:["${largest[0]}"]. Largest sections here: ${largest.join(', ')}. Metadata (${LABEL_METADATA_KEYS.join(', ')}) is always returned.`;
}

export const getDrugLabelTool = tool('openfda_get_drug_label', {
  description:
    'Look up FDA drug labeling (package inserts / SPL documents). Check indications, warnings, dosage, contraindications, active ingredients, or any structured label section. A label runs to tens of thousands of tokens, so a page that exceeds the inline budget returns the list of available sections instead; re-call with sections to pull the ones you need.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: nonBlankString().describe(
      'Query targeting label fields. Examples: openfda.brand_name:"aspirin", openfda.generic_name:"metformin", openfda.manufacturer_name:"pfizer". For a specific revision, pass set_id with the SPL UUID returned in earlier results.',
    ),
    sort: nonBlankString()
      .optional()
      .describe(
        'Sort expression (field:asc or field:desc). Example: effective_time:desc. Invalid or non-sortable fields cause a query error — use a documented field name.',
      ),
    limit: z
      .number()
      .min(1)
      .max(1000)
      .default(5)
      .describe('Maximum number of results to return (1-1000). Default 5. Labels are large.'),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    sections: z
      .array(nonBlankString().describe('A top-level label section name.'))
      .optional()
      .describe(
        'Label sections to return, e.g. ["boxed_warning","indications_and_usage"]. Names come from the outline an oversized page returns, or from openfda_describe_fields. Omit for the whole label — which returns the section outline instead when the page exceeds the inline size budget. Metadata (openfda, set_id, id, effective_time, version) is returned either way.',
      ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching results in the dataset.'),
        skip: z.number().describe('Number of results skipped.'),
        limit: z.number().describe('Maximum results returned per request.'),
        lastUpdated: z.string().describe('Date the dataset was last updated.'),
      })
      .describe('Pagination and freshness metadata.'),
    kind: z
      .enum(['full', 'outline'])
      .describe(
        'Whether this response carries label records ("full") or only the section outline of a page too large to inline ("outline").',
      ),
    results: z
      .array(z.record(z.string(), z.any()))
      .optional()
      .describe(
        'Drug label records, present when kind is "full". Each carries an openfda block (brand_name, generic_name, manufacturer_name, route) plus optional SPL sections like indications_and_usage, warnings, dosage_and_administration, contraindications, adverse_reactions; section presence varies per label. Narrowed to the requested sections plus metadata when sections was supplied.',
      ),
    outline: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'One retrievable label section and its serialized size.',
        ),
      )
      .optional()
      .describe(
        'Section names available across the matched page and their serialized size, largest first. Present when kind is "outline" — pass names back in sections to retrieve them.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching label records in the dataset'),
    effectiveQuery: z
      .string()
      .describe('Search filter applied to the drug label query, as submitted to openFDA'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more labels matched than this page returned — page with skip for the rest.',
      ),
    shown: z.number().optional().describe('Number of labels returned in this response.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty or paging overshot — how to broaden filters or correct field names. Absent when results are returned.',
      ),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The openFDA daily or per-minute request limit is exceeded.',
      retryable: true,
      recovery:
        'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The openFDA API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
    },
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
    },
    {
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'skip exceeds the 25000 record pagination ceiling.',
      recovery:
        'Narrow the search query with additional filters or date ranges instead of increasing skip.',
    },
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);

    const service = getOpenFdaService();
    const response = await service.query(
      ENDPOINT,
      {
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        skip: input.skip,
      },
      ctx,
    );

    ctx.log.info('Drug label lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });

    /** Page-level guidance, composed with any outline guidance below — `notice` is last-wins. */
    let pageNotice: string | undefined;
    if (response.results.length === 0) {
      const fieldHint = formatFieldHint('drug/label');
      pageNotice = emptyResultMessage(
        response.meta.skip,
        response.meta.total,
        `No labels matched${input.search ? ` search: ${input.search}` : ''}. Try broader terms or check field names (e.g. openfda.brand_name, openfda.generic_name, openfda.manufacturer_name). ${fieldHint}`,
      );
    } else if (response.meta.skip + response.results.length < response.meta.total) {
      pageNotice = `${response.meta.total} labels matched; this page returned ${response.results.length}. Page with skip (e.g. skip=${response.meta.skip + response.results.length}) or narrow the search.`;
      ctx.enrich.truncated({
        shown: response.results.length,
        cap: input.limit,
        guidance: pageNotice,
      });
    }

    /* Selection path — the agent named the sections it wants, so no size decision is needed. */
    if (input.sections && input.sections.length > 0) {
      const sections = input.sections;
      const available = new Set(response.results.flatMap((r) => Object.keys(r)));
      const unknown = sections.filter((name) => !available.has(name));
      const notice = [pageNotice, unknownSectionNotice(unknown, sections, available)]
        .filter(Boolean)
        .join(' ');
      if (notice) ctx.enrich.notice(notice);
      return {
        meta: response.meta,
        kind: 'full' as const,
        results: response.results.map((record) =>
          selectSections(record as Record<string, unknown>, sections, {
            alwaysKeep: LABEL_METADATA_KEYS,
          }),
        ),
      };
    }

    /* Disclosure path — return the page whole, or its section outline when it overflows. */
    const outcome = outlineOnOverflow(
      { results: response.results as Record<string, unknown>[] },
      { extract: extractLabelSections },
    );
    if (outcome.kind === 'full') {
      if (pageNotice) ctx.enrich.notice(pageNotice);
      return { meta: response.meta, kind: 'full' as const, results: outcome.results };
    }

    ctx.log.info('Drug label page overflowed to a section outline', {
      sections: outcome.sections.length,
      records: response.results.length,
    });
    ctx.enrich.notice(
      [pageNotice, outlineGuidance(outcome.sections, response.results.length)]
        .filter(Boolean)
        .join(' '),
    );
    return { meta: response.meta, kind: 'outline' as const, outline: outcome.sections };
  },

  /**
   * Renders each arm on field presence, never on `kind` — the parity sentinel
   * populates every optional field on one synthetic sample, so a mutually
   * exclusive branch would leave the untaken arm unrendered.
   */
  format: (result) => {
    const records = result.results ?? [];
    if (records.length === 0 && !result.outline) {
      return [{ type: 'text' as const, text: 'No labels found.' }];
    }

    const lines: string[] = [
      `**${result.meta.total} total label results** (returned: ${records.length}, skip: ${result.meta.skip}, limit: ${result.meta.limit}, kind: ${result.kind}) | Data updated: ${result.meta.lastUpdated}\n`,
    ];

    /**
     * Keys the header block emits verbatim and unconditionally — skipped during
     * section iteration. `id` and `version` stay out: `id` has no header line,
     * and `version` renders only alongside a present `set_id`, so the section
     * loop below is what carries them into `content[]`.
     */
    const metaKeys = new Set(['openfda', 'set_id', 'effective_time']);

    for (const r of records) {
      const openfda = (r.openfda ?? {}) as Record<string, unknown>;
      const brandName = ((openfda.brand_name as string[]) ?? [])[0] ?? 'Unknown';
      const genericName = ((openfda.generic_name as string[]) ?? [])[0];
      const manufacturer = ((openfda.manufacturer_name as string[]) ?? [])[0];

      lines.push(`### ${brandName}${genericName ? ` (${genericName})` : ''}`);
      if (manufacturer) lines.push(`**Manufacturer:** ${manufacturer}`);
      if (r.effective_time) lines.push(`**Effective date:** ${r.effective_time}`);
      if (r.set_id) lines.push(`**Set ID:** ${r.set_id}${r.version ? ` (v${r.version})` : ''}`);

      // Every openfda field, whole — the header above shows only the first
      // entry of brand_name/generic_name/manufacturer_name, so skipping them
      // here would drop every later entry from content[].
      for (const [key, val] of Object.entries(openfda)) {
        if (val == null) continue;
        const display = Array.isArray(val) ? (val as string[]).join(', ') : String(val);
        if (display) lines.push(`**${humanizeField(key)}:** ${display}`);
      }

      // Every label section present in the record, whole — `structuredContent`
      // carries the untrimmed record, so trimming here would desync the surfaces.
      for (const [key, value] of Object.entries(r)) {
        if (metaKeys.has(key) || value == null) continue;
        const text = Array.isArray(value)
          ? value.join('\n')
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
        if (!text) continue;
        lines.push(`\n**${humanizeField(key)}:**\n${text}`);
      }
      lines.push('\n---\n');
    }

    if (result.outline) {
      lines.push(`**${result.outline.length} sections available** (page too large to inline)\n`);
      for (const section of result.outline) {
        lines.push(`- \`${section.name}\` — ${section.bytes} bytes`);
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

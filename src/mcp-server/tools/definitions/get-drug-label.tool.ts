/**
 * @fileoverview Tool definition for looking up FDA drug labeling (package inserts / SPL documents).
 * Oversized pages return a section outline whose worked re-call example is measured
 * against the same byte budget, plus the identity of each label record the outline
 * sums over (`page_labels`), and a `sections` selection that overflows that
 * budget is disclosed rather than silently returned oversized. Pages continue past
 * openFDA's `skip` ceiling by the shared `search_after` cursor.
 * @module mcp-server/tools/definitions/get-drug-label
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  OUTLINE_VARIANT,
  outlineOnOverflow,
  type SectionMeta,
  selectSections,
} from '@cyanheads/mcp-ts-core/utils';
import { first, openfdaOf, originalPackager } from '@/mcp-server/tools/drug-profile-sections.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  emptyResultMessage,
  formatCell,
  humanizeField,
  resultHeader,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  type CursorQuery,
  cursorEndNotice,
  cursorInput,
  cursorOutputShape,
  invalidCursorError,
  nextCursorField,
  resolveCursor,
} from '@/mcp-server/tools/pagination-cursor.js';
import {
  assertSkipWithinCeiling,
  CURSOR_END_NOTICE_TOPIC,
  nonBlankString,
  OPENFDA_MAX_SKIP,
  PAGE_SIZES,
  PAST_CEILING_ROUTE,
  pageLimit,
  pageMetaOutput,
  pageSizeNotice,
  paginationLimitReachedError,
  rateLimitedError,
  resolvePageSize,
  SKIP_DESCRIPTION,
  sortDescription,
  sortExpression,
  upstreamError,
} from '@/mcp-server/tools/schema-utils.js';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
  phrasePlusHint,
  SEARCH_SYNTAX_NOTE,
  searchExpression,
} from '@/mcp-server/tools/search-expression.js';
import {
  createFootnoteSequence,
  type FootnoteSequence,
  renderSplTable,
} from '@/mcp-server/tools/spl-table.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { jsonBytes } from '@/services/openfda/page-budget.js';

const ENDPOINT = 'drug/label';

/**
 * Label identity kept through a `sections` projection. Without these the caller
 * cannot tell which product a returned section belongs to, or re-request its
 * label by set_id.
 */
const LABEL_METADATA_KEYS = ['openfda', 'set_id', 'id', 'effective_time', 'version'];

/**
 * A `*_table` section's text for `content[]` — each SPL table string rendered as
 * Markdown, blank-line separated. Undefined when the value is not the string or
 * string array openFDA ships, so the generic section rendering takes it.
 * Footnotes number from `sequence`, shared across the whole text output.
 */
function renderTableSection(value: unknown, sequence: FootnoteSequence): string | undefined {
  if (typeof value === 'string') return renderSplTable(value, sequence);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
      .map((item) => renderSplTable(item, sequence))
      .filter(Boolean)
      .join('\n\n');
  }
  return;
}

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
      bytes.set(name, (bytes.get(name) ?? 0) + jsonBytes(value));
    }
  }
  return [...bytes].map(([name, size]) => ({ name, bytes: size }));
}

/**
 * Name the requested sections no record on the page carries. Without this a
 * mistyped name is indistinguishable from a label that genuinely lacks the
 * section: both return the same metadata-only record. The available names are
 * listed only when nothing matched, since that is the case with no other way
 * back to a correct name. The unmatched names are the caller's own text, so each
 * rides as a {@link codeLiteral}.
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
  return `Not present on this page: ${unknown.map(codeLiteral).join(', ')}.${listing}`;
}

/**
 * Projects a page to the requested sections plus the always-kept metadata and
 * measures the result in UTF-8 bytes ({@link jsonBytes}), so a byte figure
 * quoted in a notice is the figure a caller following that notice gets back.
 *
 * Section presence varies per label, and `selectSections` rejects a name the
 * record lacks, so each record is projected onto the requested names it
 * carries. Names absent from the whole page are reported by
 * {@link unknownSectionNotice}, not thrown.
 */
function projectPage(
  records: Record<string, unknown>[],
  sections: string[],
): { bytes: number; results: Partial<Record<string, unknown>>[] } {
  const results = records.map((record) =>
    selectSections(
      record,
      sections.filter((name) => Object.hasOwn(record, name)),
      { alwaysKeep: LABEL_METADATA_KEYS },
    ),
  );
  return { bytes: jsonBytes({ results }), results };
}

/**
 * The largest section a `sections:[name]` re-call can retrieve from this page
 * without overflowing the budget again — or nothing, when none can.
 *
 * Outline sizes are summed across every record on the page, so a section's cost
 * is a function of `limit` and can't be read off the section alone: each
 * candidate is projected and measured at this page's record count. Skipped are
 * the always-kept metadata keys (they ride every response, so naming one
 * retrieves nothing new) and the page's single most expensive section — offering
 * that as the worked example would recommend the one re-call the outline exists
 * to head off.
 */
function exampleSection(
  sections: SectionMeta[],
  records: Record<string, unknown>[],
  metadataBytes: number,
): SectionMeta | undefined {
  if (metadataBytes > DEFAULT_OUTLINE_BUDGET_BYTES) return;
  for (const { name } of sections.slice(1)) {
    if (LABEL_METADATA_KEYS.includes(name)) continue;
    const { bytes } = projectPage(records, [name]);
    if (bytes <= DEFAULT_OUTLINE_BUDGET_BYTES) return { name, bytes };
  }
  return;
}

/** The inputs that choose which labels a page holds, as a re-call of it must repeat them. */
type PageInput = 'search' | 'sort' | 'limit' | 'skip' | 'cursor';

/** Renders names as an English list: `a`, `a and b`, `a, b, and c`. */
const PAGE_INPUT_LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * Re-call guidance for an overflowed page. The worked example is a section
 * measured to fit the budget at this page's record count, with that size stated
 * inline — the names the outline lists largest-first are the cost to weigh, not
 * a retrieval to imitate. `kept` names every input the call set that chooses
 * which labels the page holds (`search` always), so a re-call repeating them
 * reads these labels again; `format()` cannot see the input, so this is the
 * surface that says so.
 */
function outlineGuidance(
  sections: SectionMeta[],
  records: Record<string, unknown>[],
  kept: readonly PageInput[],
): string {
  const metadataBytes = projectPage(records, []).bytes;
  const example = exampleSection(sections, records, metadataBytes);
  const worked = example
    ? `e.g. sections:["${example.name}"] returns ${example.bytes} bytes across the ${records.length} record(s) on this page`
    : `but no single section fits that budget across the ${records.length} record(s) on this page: metadata alone is ${metadataBytes} bytes, so lower limit before naming sections`;
  return `This page of ${records.length} label record(s) exceeds the ${DEFAULT_OUTLINE_BUDGET_BYTES}-byte inline size budget, so the response lists the sections available instead of the label text. Re-call with the same ${PAGE_INPUT_LIST.format(kept)} plus sections:[...] to retrieve specific ones — ${worked}. Each listed size is summed across the page, so a section's cost scales with limit; a selection over the budget is still returned whole and reports its size. Metadata (${LABEL_METADATA_KEYS.join(', ')}) is returned either way and counts toward these figures.`;
}

/**
 * Size disclosure for a `sections` selection that overflows the same budget the
 * outline enforces. The selection is returned whole — the escape hatch is not
 * truncated, only made to state its cost, since a caller who followed an outline
 * otherwise has no signal that the re-call blew the budget it was offered to
 * respect.
 */
function selectionOverflowNotice(bytes: number, records: number): string | undefined {
  if (bytes <= DEFAULT_OUTLINE_BUDGET_BYTES) return;
  return `Selection is ${bytes} bytes across ${records} record(s), over the ${DEFAULT_OUTLINE_BUDGET_BYTES}-byte inline size budget — returned whole, not truncated. Lower limit or name fewer sections to reduce it.`;
}

/** One record of an outline page, as `page_labels` lists it. */
const PageLabelSchema = z
  .object({
    set_id: z.string().nullable().describe('SPL set ID, the key to re-call this label alone.'),
    effective_time: z.string().nullable().describe('Label effective date (YYYYMMDD).'),
    brand_name: z.string().nullable().describe('First openfda.brand_name.'),
    generic_name: z.string().nullable().describe('First openfda.generic_name.'),
    manufacturer_name: z.string().nullable().describe('First openfda.manufacturer_name.'),
    is_original_packager: z
      .boolean()
      .nullable()
      .describe(
        "True when openFDA flags the label as the original packager's, false for a label with an openfda block but no flag (a repackager's or relabeler's), null when the openfda block is empty — which nulls the three names too.",
      ),
    bytes: z
      .number()
      .describe(
        `This label's serialized UTF-8 size; one over ${DEFAULT_OUTLINE_BUDGET_BYTES} bytes returns an outline even when re-called alone.`,
      ),
  })
  .describe('One label record on the page.');

type PageLabel = z.infer<typeof PageLabelSchema>;

/**
 * Identity of one record on an outline page, which otherwise names no record —
 * so a caller can tell the original packager's label from repackagers' copies
 * and re-call one by `set_id`. The names and flag come from the openfda block,
 * which openFDA fills only on labels it linked to a product, so an empty block
 * leaves every one of them null. `bytes` is the record's own {@link jsonBytes},
 * the measure the outline entries use.
 */
function pageLabel(record: Record<string, unknown>): PageLabel {
  const openfda = openfdaOf(record);
  return {
    set_id: first(record.set_id),
    effective_time: first(record.effective_time),
    brand_name: first(openfda.brand_name),
    generic_name: first(openfda.generic_name),
    manufacturer_name: first(openfda.manufacturer_name),
    is_original_packager: originalPackager(record),
    bytes: jsonBytes(record),
  };
}

/**
 * The two routes to the original packager's label, for a search that matched
 * more labels than the page returned — a brand search matches the original
 * packager's label and every repackager's copy. The filter route is left out
 * when the search already names the flag.
 */
function originalPackagerRoutes(search: string): string {
  const filter = search.includes('is_original_packager')
    ? ''
    : 'add AND openfda.is_original_packager:true to the search (it keeps only the labels openFDA flags, so several or none can remain), or ';
  return `For the original packager's label, ${filter}take identity.spl_set_id from openfda_drug_profile.`;
}

/**
 * The lead for a page that leaves matched labels unreturned: how to page on,
 * then {@link originalPackagerRoutes}. A page carrying `next_cursor` names it;
 * the next `skip` is named only while it is within openFDA's ceiling, and past
 * it the walk from `skip: 0` that reaches those labels. `meta.skip` is the walk
 * position on a page read by cursor.
 */
function moreLabelsLead(
  page: {
    meta: { skip: number; total: number };
    next_cursor?: string | undefined;
    results: readonly unknown[];
  },
  search: string,
): string {
  const returned = page.results.length;
  const next = page.meta.skip + returned;
  const skipWithin = next <= OPENFDA_MAX_SKIP;
  const paging = page.next_cursor
    ? `Page with next_cursor${skipWithin ? ` or skip (e.g. skip=${next})` : ''}, or narrow the search.`
    : skipWithin
      ? `Page with skip (e.g. skip=${next}) or narrow the search.`
      : `The next page would start at skip=${next}, past openFDA's ${OPENFDA_MAX_SKIP}-record pagination ceiling — to read past it, ${PAST_CEILING_ROUTE}.`;
  return `${page.meta.total} labels matched; this page returned ${returned}. ${paging} ${originalPackagerRoutes(search)}`;
}

/** A `page_labels` value as a table cell: null spelled out, so it reads apart from an empty string. */
function labelCell(value: string | number | boolean | null): string {
  return value === null ? 'null' : formatCell(value);
}

export const getDrugLabelTool = tool('openfda_get_drug_label', {
  description:
    'Look up FDA drug labeling (package inserts / SPL documents). Check indications, warnings, dosage, contraindications, active ingredients, or any structured label section. A label runs to tens of thousands of tokens, so a page that exceeds the inline budget returns the list of available sections instead; re-call with sections to pull the ones you need.',
  annotations: { readOnlyHint: true },

  input: z.object({
    search: searchExpression().describe(
      `Label query, e.g. openfda.brand_name:"aspirin", openfda.generic_name:"metformin", openfda.manufacturer_name:"pfizer". set_id with an SPL UUID from earlier results fetches that product's label, in its current revision only (openFDA serves no earlier ones). A brand search also matches repackagers' copies: to keep the original packager's label, add AND openfda.is_original_packager:true (several or none can remain), or take identity.spl_set_id from openfda_drug_profile. ${SEARCH_SYNTAX_NOTE}`,
    ),
    sort: sortExpression()
      .optional()
      .describe(sortDescription({ example: 'effective_time:desc' })),
    limit: pageLimit(
      ENDPOINT,
      'Labels per page. A sections selection costs its size summed across every label on the page, so lower this before widening one.',
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    sections: z
      .array(nonBlankString().describe('A top-level label section name.'))
      .optional()
      .describe(
        `Label sections to return, e.g. ["boxed_warning","indications_and_usage"], named by an oversized page's outline or by openfda_describe_fields. Omitted or [], the whole label comes back, or its outline when the page exceeds the inline size budget; a selection comes back whole even over that budget. Metadata (${LABEL_METADATA_KEYS.join(', ')}) always comes back and counts toward the size.`,
      ),
  }),

  output: z.object({
    meta: pageMetaOutput,
    kind: z
      .enum(['full', 'outline'])
      .describe(
        'Whether this response carries label records ("full") or only the section outline of a page too large to inline ("outline").',
      ),
    results: z
      .array(z.record(z.string(), z.any()))
      .optional()
      .describe(
        'Label records when kind is "full": an openfda block (brand_name, generic_name, manufacturer_name, route) plus the SPL sections each label has, such as indications_and_usage, warnings, dosage_and_administration, contraindications, adverse_reactions; with sections, only those plus metadata. _table sections carry raw SPL table markup as openFDA returns it; the text output renders them as Markdown tables.',
      ),
    outline: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'One retrievable label section and its serialized size.',
        ),
      )
      .optional()
      .describe(
        'When kind is "outline": the sections on the page and their serialized size summed across it, largest first; pass names back in sections.',
      ),
    page_labels: z
      .array(PageLabelSchema)
      .optional()
      .describe(
        'The label records this page holds, in page order. Present when kind is "outline", which otherwise names no record.',
      ),
    ...cursorOutputShape,
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
        'True when more labels matched than this page returned — page with next_cursor or skip for the rest.',
      ),
    shown: z.number().optional().describe('Number of labels returned in this response.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance for this page: empty result, paging on and the original packager's label, the sized re-call for an outline, section names no record carried, a selection over the inline budget, limit clamp, ${CURSOR_END_NOTICE_TOPIC}. Absent when nothing needs saying.`,
      ),
  },

  errors: [
    rateLimitedError,
    upstreamError,
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    paginationLimitReachedError,
    invalidCursorError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);
    const size = resolvePageSize(input.limit, ENDPOINT, ctx);
    const query: CursorQuery = { endpoint: ENDPOINT, search: input.search, sort: input.sort };
    const searchAfter = resolveCursor(input, query, ctx);

    const service = getOpenFdaService();
    const queried = await service.query(
      query.endpoint,
      {
        search: query.search,
        sort: query.sort,
        limit: size.limit,
        skip: input.skip,
        searchAfter,
      },
      ctx,
    );
    const response = { ...queried, meta: { ...queried.meta, limit: size.limit } };
    /** Spread into every arm's result: the continuation belongs to the page, whichever shape it takes. */
    const continuation = nextCursorField(response, query);
    const page = { ...response, ...continuation };

    ctx.log.info('Drug label lookup completed', {
      search: input.search,
      total: response.meta.total,
      returned: response.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total, effectiveQuery: input.search });

    const morePages =
      response.results.length > 0 &&
      response.meta.skip + response.results.length < response.meta.total;
    let pageLead: string | undefined;
    if (response.results.length === 0) {
      const fieldHint = formatFieldHint('drug/label');
      const plusHint = phrasePlusHint(input.search, response.meta.total);
      pageLead = emptyResultMessage(
        response.meta.skip,
        response.meta.total,
        `No labels matched search: ${codeLiteral(input.search)}. Try broader terms or check field names (e.g. openfda.brand_name, openfda.generic_name, openfda.manufacturer_name). openFDA fills the openfda block only on labels it linked to a product, so when an openfda field finds nothing, search the label's own product text with spl_product_data_elements (e.g. spl_product_data_elements:"lisinopril"). ${fieldHint}${plusHint ? ` ${plusHint}` : ''}`,
        response.meta.totalUnverified,
        searchAfter !== undefined,
      );
    } else if (morePages) {
      pageLead = moreLabelsLead(page, input.search);
    }
    /** Page guidance, joined with the section or outline guidance below (`notice` is last-wins). */
    const pageNotice = [pageLead, pageSizeNotice(size, page) ?? cursorEndNotice(page, searchAfter)]
      .filter(Boolean)
      .join(' ');
    if (morePages) {
      ctx.enrich.truncated({
        shown: response.results.length,
        cap: size.limit,
        guidance: pageNotice,
      });
    }

    const records = response.results;

    /**
     * Selection path — the agent named the sections it wants, so the size is its
     * call to make: the projection is returned whole whatever it measures, and
     * an overflow is disclosed rather than trimmed.
     */
    if (input.sections && input.sections.length > 0) {
      const sections = input.sections;
      const available = new Set(response.results.flatMap((r) => Object.keys(r)));
      const unknown = sections.filter((name) => !available.has(name));
      const { bytes, results } = projectPage(records, sections);
      const overflow = selectionOverflowNotice(bytes, response.results.length);
      if (overflow) {
        ctx.log.info('Drug label section selection exceeded the inline size budget', {
          bytes,
          budget: DEFAULT_OUTLINE_BUDGET_BYTES,
          records: response.results.length,
          sections,
        });
      }
      const notice = [pageNotice, unknownSectionNotice(unknown, sections, available), overflow]
        .filter(Boolean)
        .join(' ');
      if (notice) ctx.enrich.notice(notice);
      return { meta: response.meta, kind: 'full' as const, results, ...continuation };
    }

    // Disclosure path — return the page whole, or its section outline when it overflows.
    const outcome = outlineOnOverflow({ results: records }, { extract: extractLabelSections });
    if (outcome.kind === 'full') {
      if (pageNotice) ctx.enrich.notice(pageNotice);
      return {
        meta: response.meta,
        kind: 'full' as const,
        results: outcome.results,
        ...continuation,
      };
    }

    ctx.log.info('Drug label page overflowed to a section outline', {
      sections: outcome.sections.length,
      records: response.results.length,
    });
    // Each input the call set away from its default that the re-call must repeat. A cursor never comes with a skip.
    const kept: PageInput[] = ['search'];
    if (input.sort !== undefined) kept.push('sort');
    if (size.limit !== PAGE_SIZES[ENDPOINT].default) kept.push('limit');
    if (input.skip > 0) kept.push('skip');
    if (searchAfter !== undefined) kept.push('cursor');
    ctx.enrich.notice(
      [pageNotice, outlineGuidance(outcome.sections, records, kept)].filter(Boolean).join(' '),
    );
    return {
      meta: response.meta,
      kind: 'outline' as const,
      outline: outcome.sections,
      page_labels: records.map(pageLabel),
      ...continuation,
    };
  },

  /**
   * Renders each arm on field presence, never on `kind` — the parity sentinel
   * populates every optional field on one synthetic sample, so a mutually
   * exclusive branch would leave the untaken arm unrendered.
   */
  format: (result) => {
    const records = result.results ?? [];
    const lines = [`${singleLine(resultHeader(result.meta, records.length, result.kind))}\n`];
    // The same token as structuredContent.next_cursor, on its own line, as searchLead renders it.
    if (result.next_cursor) {
      lines.push(`${singleLine(`next_cursor: ${codeLiteral(result.next_cursor)}`)}\n`);
    }
    if (records.length === 0 && !result.outline) {
      lines.push(emptyPageBody(result, 'No labels found.'));
    }

    /**
     * Keys the header block emits verbatim and unconditionally — skipped during
     * section iteration. `id` and `version` stay out: `id` has no header line,
     * and `version` renders only alongside a present `set_id`, so the section
     * loop below is what carries them into `content[]`.
     */
    const metaKeys = new Set(['openfda', 'set_id', 'effective_time']);
    // One footnote sequence for the whole text, so no `[^n]` label repeats.
    const footnotes = createFootnoteSequence();

    for (const r of records) {
      const openfda = (r.openfda ?? {}) as Record<string, unknown>;
      const brandName = ((openfda.brand_name as string[]) ?? [])[0] ?? 'Unknown';
      const genericName = ((openfda.generic_name as string[]) ?? [])[0];
      const manufacturer = ((openfda.manufacturer_name as string[]) ?? [])[0];

      lines.push(singleLine(`### ${brandName}${genericName ? ` (${genericName})` : ''}`));
      if (manufacturer) lines.push(singleLine(`**Manufacturer:** ${manufacturer}`));
      if (r.effective_time) lines.push(singleLine(`**Effective date:** ${r.effective_time}`));
      if (r.set_id)
        lines.push(singleLine(`**Set ID:** ${r.set_id}${r.version ? ` (v${r.version})` : ''}`));

      /**
       * Every openfda field, whole — the header above shows only the first
       * entry of brand_name/generic_name/manufacturer_name, so skipping them
       * here would drop every later entry from content[].
       */
      for (const [key, val] of Object.entries(openfda)) {
        if (val == null) continue;
        const display = Array.isArray(val) ? (val as string[]).join(', ') : String(val);
        if (display) lines.push(singleLine(`**${humanizeField(key)}:** ${display}`));
      }

      /**
       * Every label section present in the record, whole — `structuredContent`
       * carries the untrimmed record, so trimming here would desync the surfaces.
       * `*_table` sections are SPL table markup and render as Markdown tables;
       * prose sections pass through verbatim, multi-line, as the label's own text.
       */
      for (const [key, value] of Object.entries(r)) {
        if (metaKeys.has(key) || value == null) continue;
        const table = key.endsWith('_table') ? renderTableSection(value, footnotes) : undefined;
        if (table !== undefined) {
          if (table) lines.push(`\n**${humanizeField(key)}:**\n\n${table}`);
          continue;
        }
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

    if (result.page_labels) {
      lines.push(`**${result.page_labels.length} labels on this page**\n`);
      lines.push(
        '| set_id | effective_time | brand_name | generic_name | manufacturer_name | is_original_packager | bytes |',
        '|---|---|---|---|---|---|---|',
      );
      for (const label of result.page_labels) {
        const cells = [
          label.set_id,
          label.effective_time,
          label.brand_name,
          label.generic_name,
          label.manufacturer_name,
          label.is_original_packager,
          label.bytes,
        ];
        lines.push(`| ${cells.map(labelCell).join(' | ')} |`);
      }
      lines.push('');
    }

    if (result.outline) {
      lines.push(`**${result.outline.length} sections available** (page too large to inline)\n`);
      for (const section of result.outline) {
        lines.push(singleLine(`- \`${section.name}\` — ${section.bytes} bytes`));
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

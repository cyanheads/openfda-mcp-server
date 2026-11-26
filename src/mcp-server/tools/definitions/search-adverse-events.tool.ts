/**
 * @fileoverview Tool definition for searching openFDA adverse event reports across
 * drugs, food, devices, and cosmetics. `drug/event` is the largest-record
 * endpoint openFDA serves, so `limit`'s default and cap follow the category, a
 * default drug page leaves each drug's `openfda` block out of its reports
 * (`include` returns it), and a page holding a report over 24,000 bytes names
 * its largest fields. A browse with neither `search` nor `sort` leads with the
 * category's newest reports. A page read at `skip` 0 or by cursor continues past
 * the `skip` ceiling through `next_cursor`.
 * @module mcp-server/tools/definitions/search-adverse-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ADVERSE_EVENT_SCHEMAS } from '@/mcp-server/tools/adverse-event-canvas-schemas.js';
import { sortOrNewest } from '@/mcp-server/tools/default-sort.js';
import {
  ADMINISTRATION_ROUTES,
  type CodeLabelSpec,
  codeLabel,
  DECHALLENGE_OUTCOMES,
  DOSAGE_INTERVAL_UNITS,
  DOSE_UNITS,
  DRUG_ACTIONS,
  EXPEDITED_REPORT_FLAGS,
  ONSET_AGE_UNITS,
  PATIENT_AGE_GROUPS,
  REACTION_OUTCOMES,
  RECEIVER_TYPES,
  RECHALLENGE_OUTCOMES,
  REPORT_TYPES,
  REPORTER_QUALIFICATIONS,
  SENDER_TYPES,
  TREATMENT_DURATION_UNITS,
  withCodeLabels,
} from '@/mcp-server/tools/drug-event-codes.js';
import { formatFieldHint } from '@/mcp-server/tools/field-catalog.js';
import {
  codeLiteral,
  emptyPageBody,
  formatRemainingFields,
  lineContent,
  projectedRecordLines,
  renderValue,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  type CursorQuery,
  cursorInput,
  cursorOutputShape,
  invalidCursorError,
  nextCursorField,
  resolveCursor,
} from '@/mcp-server/tools/pagination-cursor.js';
import {
  assertSkipWithinCeiling,
  CONJOINED_ARRAY_NOTICE_TOPIC,
  fieldSelection,
  fieldsDescription,
  limitAboveCapError,
  notSortableError,
  pageLimitBy,
  pageMetaOutput,
  paginationLimitReachedError,
  rateLimitedError,
  resolvePageSize,
  SKIP_DESCRIPTION,
  searchNoticeField,
  sortDescription,
  sortExpression,
  upstreamError,
} from '@/mcp-server/tools/schema-utils.js';
import { fieldPathsNamed } from '@/mcp-server/tools/search-clauses.js';
import { enrichSearchPage } from '@/mcp-server/tools/search-enrichment.js';
import {
  assertSearchDelimitersBalanced,
  malformedSearchError,
  SEARCH_SYNTAX_NOTE,
  searchExpression,
} from '@/mcp-server/tools/search-expression.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  CANVAS_DISABLED_MESSAGE,
  canvasCapacityExhaustedError,
  canvasDisabledError,
  canvasIdInput,
  canvasNotFoundError,
  canvasOutputShape,
  canvasResult,
  STAGING_WORKFLOW,
  spillSearch,
  stageInput,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { inlinePage, oversizedRecordOutputShape } from '@/services/openfda/page-budget.js';
import {
  includeDescription,
  LEFT_OUT_NOTICE_TOPIC,
  omissionOutputShape,
  pageProjection,
  projectionOutputShape,
} from '@/services/openfda/record-projection.js';

/**
 * Keys that tell one report apart, kept on every `fields`-projected record:
 * `safetyreportid` on drug reports, `report_number` on food, device, and
 * cosmetic reports, plus `mdr_report_key` on device reports. A category's record
 * carries only its own, so one list serves all four.
 */
const IDENTITY_KEYS = ['safetyreportid', 'report_number', 'mdr_report_key'] as const;

/** The categories, each read from `<category>/event`. */
const CATEGORIES = ['drug', 'food', 'device', 'cosmetic'] as const;

type Category = (typeof CATEGORIES)[number];

/**
 * The sort a browse with neither `search` nor `sort` sends: the category's
 * received date, newest first. Cosmetic reports sort on the date FDA first
 * received them, as `receivedate` is on drug reports: under
 * `latest_received_date` a follow-up to a years-old report leads the browse.
 * Reports sharing a date page in a stable order on the date alone, so no
 * tie-breaker is added.
 */
const NEWEST_FIRST: Record<Category, string> = {
  drug: 'receivedate:desc',
  food: 'date_created:desc',
  device: 'date_received:desc',
  cosmetic: 'initial_received_date:desc',
};

/** {@link NEWEST_FIRST} as the `sort` description states it. */
const NEWEST_FIRST_NOTE = `the category's received date (${CATEGORIES.map((category) => `${category} ${NEWEST_FIRST[category]}`).join(', ')})`;

/**
 * The product-name field an empty result points each category at. No
 * adverse-event record carries a top-level `openfda` block: drug reports nest
 * it under `patient.drug`, device reports under `device`, food and cosmetic
 * reports have none.
 */
const PRODUCT_FIELD_HINT: Record<Category, string> = {
  drug: 'patient.drug.medicinalproduct (the name as reported) or patient.drug.openfda.brand_name',
  food: 'products.name_brand',
  device: 'device.brand_name',
  cosmetic: 'products.product_name',
};

/**
 * The coded drug-report fields `content[]` renders as `label (code)`, per record
 * level. The drug's route and the reaction outcome render on their list items.
 */
const DRUG_CODES: CodeLabelSpec = {
  actiondrug: DRUG_ACTIONS,
  drugadditional: DECHALLENGE_OUTCOMES,
  drugrecurreadministration: RECHALLENGE_OUTCOMES,
  drugtreatmentdurationunit: TREATMENT_DURATION_UNITS,
  drugintervaldosagedefinition: DOSAGE_INTERVAL_UNITS,
  drugstructuredosageunit: DOSE_UNITS,
  drugcumulativedosageunit: DOSE_UNITS,
};
const PATIENT_CODES: CodeLabelSpec = {
  patientagegroup: PATIENT_AGE_GROUPS,
  patientonsetageunit: ONSET_AGE_UNITS,
};
const REPORT_CODES: CodeLabelSpec = {
  reporttype: REPORT_TYPES,
  fulfillexpeditecriteria: EXPEDITED_REPORT_FLAGS,
  primarysource: { qualification: REPORTER_QUALIFICATIONS },
  sender: { sendertype: SENDER_TYPES },
  receiver: { receivertype: RECEIVER_TYPES },
};

/** Reaction fields its list item renders; any other continues the item. */
const REACTION_ITEM_FIELDS = new Set([
  'reactionmeddrapt',
  'reactionmeddraversionpt',
  'reactionoutcome',
]);

/**
 * A drug report's reactions, one list item each: the term, its MedDRA version
 * when the reactions do not all share one, and its outcome (`Death — fatal (5)`).
 * A version every reaction shares heads the list once. The list ends with a
 * blank line so the block after it stays outside its last item.
 */
function reactionLines(reactions: Record<string, unknown>[]): string[] {
  if (reactions.length === 0) return [];
  const versions = new Set(reactions.map((rx) => renderValue(rx.reactionmeddraversionpt)));
  const shared = versions.size === 1 ? ([...versions][0] ?? null) : null;
  const lines = [singleLine(`**Reactions${shared ? ` (MedDRA ${shared})` : ''}:**`)];
  for (const rx of reactions) {
    const version = shared ? null : renderValue(rx.reactionmeddraversionpt);
    const outcome = renderValue(codeLabel(REACTION_OUTCOMES, rx.reactionoutcome));
    const term = renderValue(rx.reactionmeddrapt) ?? 'Unknown';
    lines.push(
      `- ${lineContent(`${term}${version ? ` (MedDRA ${version})` : ''}${outcome ? ` — ${outcome}` : ''}`)}`,
    );
    lines.push(...formatRemainingFields(rx, REACTION_ITEM_FIELDS));
  }
  lines.push('');
  return lines;
}

/**
 * A drug report's remaining patient fields, coded ones labelled, with the onset
 * age and its unit on one line (`3 month (802)`); a unit with no age keeps a
 * line of its own.
 */
function patientLines(patient: Record<string, unknown>): string[] {
  const labelled = withCodeLabels(patient, PATIENT_CODES);
  const rendered = new Set(['reaction', 'drug']);
  const age = renderValue(patient.patientonsetage);
  if (age !== null) {
    const unit = renderValue(labelled.patientonsetageunit);
    labelled.patientonsetage = unit === null ? age : `${age} ${unit}`;
    rendered.add('patientonsetageunit');
  }
  return formatRemainingFields(labelled, rendered);
}

/**
 * A cosmetic report: its `report_number` heading, both receipt dates, the
 * patient, reactions, and outcomes, one list item per product with its role,
 * then every other field. A line renders only what the record carries.
 */
function cosmeticLines(r: Record<string, unknown>): string[] {
  const id = renderValue(r.report_number);
  const lines = [singleLine(`### Report${id ? ` ${id}` : ''}`)];
  const received = [
    ['Initial received', renderValue(r.initial_received_date)],
    ['Latest received', renderValue(r.latest_received_date)],
  ].flatMap(([label, date]) => (date ? [`**${label}:** ${date}`] : []));
  if (received.length > 0) lines.push(singleLine(received.join(' | ')));
  for (const [label, key] of [
    ['Patient', 'patient'],
    ['Reactions', 'reactions'],
    ['Outcomes', 'outcomes'],
  ] as const) {
    const value = renderValue(r[key]);
    if (value) lines.push(singleLine(`**${label}:** ${value}`));
  }
  const rendered = new Set([
    'report_number',
    'initial_received_date',
    'latest_received_date',
    'patient',
    'reactions',
    'outcomes',
  ]);
  // A `products` that is not a list falls through to the remaining fields whole.
  const products = Array.isArray(r.products) ? (r.products as Record<string, unknown>[]) : null;
  if (products) rendered.add('products');
  if (products?.length) {
    lines.push('**Products:**');
    for (const p of products) {
      const role = renderValue(p.role);
      const item = [renderValue(p.product_name), role ? `(role: ${role})` : null];
      lines.push(`- ${lineContent(item.filter(Boolean).join(' '))}`);
      lines.push(...formatRemainingFields(p, new Set(['product_name', 'role'])));
    }
    // A blank line ends the list, so the fields below stay outside the last product's item.
    lines.push('');
  }
  lines.push(...formatRemainingFields(r, rendered));
  return lines;
}

export const searchAdverseEventsTool = tool('openfda_search_adverse_events', {
  description: `Search adverse event reports across drugs, food, devices, and cosmetics. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    category: z
      .enum(CATEGORIES)
      .describe('Product category — each has different field schemas in the response'),
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query, e.g. patient.drug.medicinalproduct:"aspirin", patient.reaction.reactionmeddrapt:"nausea" AND serious:"1". Omit both search and sort to browse the newest reports first. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        `${sortDescription({ newest: NEWEST_FIRST_NOTE })} Sortable date fields are category-specific: drug → receivedate (or receiptdate), food → date_created (or date_started), device → date_received (or date_of_event), cosmetic → initial_received_date (or latest_received_date).`,
      ),
    limit: pageLimitBy(
      'category',
      [
        ['drug', 'drug/event'],
        ['food', 'food/event'],
        ['device', 'device/event'],
        ['cosmetic', 'cosmetic/event'],
      ],
      'Records per page.',
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    cursor: cursorInput,
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['receivedate', 'patient.drug.medicinalproduct'])),
    include: fieldSelection()
      .optional()
      .describe(includeDescription([['drug', 'drug/event']])),
    stage: stageInput,
    canvas_id: canvasIdInput,
  }),

  output: z.object({
    meta: pageMetaOutput,
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Adverse event records — fields vary by category (drug: patient/reactions/drugs, device: device details/event type, food: products/outcomes, cosmetic: products/reactions/outcomes)',
      ),
    ...cursorOutputShape,
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...omissionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching adverse event records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the query, as submitted to openFDA'),
    notice: searchNoticeField([LEFT_OUT_NOTICE_TOPIC, CONJOINED_ARRAY_NOTICE_TOPIC]),
  },

  errors: [
    limitAboveCapError,
    canvasDisabledError,
    canvasNotFoundError,
    canvasCapacityExhaustedError,
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
    notSortableError,
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);

    const endpoint = `${input.category}/event` as const;
    const size = resolvePageSize(input.limit, endpoint, ctx);
    const query: CursorQuery = {
      endpoint,
      search: input.search,
      sort: sortOrNewest(input, NEWEST_FIRST[input.category]),
    };
    const searchAfter = resolveCursor(input, query, ctx);
    const noMatch = () =>
      `No adverse event reports matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''} in ${endpoint}. Try broadening filters or checking field names (for product searches use ${PRODUCT_FIELD_HINT[input.category]}). ${formatFieldHint(endpoint)}`;

    const projection = pageProjection(endpoint, IDENTITY_KEYS, {
      fields: input.fields,
      include: input.include,
      searched: input.search ? fieldPathsNamed(input.search) : undefined,
    });
    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail('canvas_disabled', CANVAS_DISABLED_MESSAGE);
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint: query.endpoint,
        search: query.search,
        sort: query.sort,
        canvasId: input.canvas_id,
        schema: ADVERSE_EVENT_SCHEMAS[input.category],
        limit: size.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      enrichSearchPage(ctx, { query, page: staged, size, noMatch, spill });
      return staged;
    }

    const svc = getOpenFdaService();
    const response = await svc.query(
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

    const page = {
      ...inlinePage(response, size.limit, projection),
      ...nextCursorField(response, query),
    };

    ctx.log.info('Adverse event search completed', {
      category: input.category,
      total: response.meta.total,
      returned: page.results.length,
    });

    enrichSearchPage(ctx, { query, page, size, noMatch, response, searchAfter });
    return page;
  },

  format: (result) => {
    const lines = searchLead(result);
    if (result.results.length === 0) {
      lines.push(emptyPageBody(result, 'No results found.'));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    for (const r of result.results) {
      if (result.projected_fields) {
        lines.push(...projectedRecordLines(r, IDENTITY_KEYS), '');
        continue;
      }
      /**
       * Device adverse events. Checked before `patient`: a device/event record
       * also carries a `patient` array, so a patient-first branch would route
       * every device report into the drug renderer.
       */
      if (r.device) {
        lines.push(singleLine(`### Report ${r.report_number ?? r.mdr_report_key ?? 'N/A'}`));
        if (r.event_type) lines.push(singleLine(`**Event type:** ${r.event_type}`));
        for (const d of Array.isArray(r.device) ? r.device : []) {
          lines.push(
            singleLine(
              `**Device:** ${d.brand_name ?? d.generic_name ?? 'Unknown'}${d.manufacturer_d_name ? ` by ${d.manufacturer_d_name}` : ''}`,
            ),
          );
          lines.push(...formatRemainingFields(d, new Set(['brand_name', 'manufacturer_d_name'])));
        }
        for (const t of (r.mdr_text ?? []) as Record<string, unknown>[]) {
          const label = t.text_type_code ? `Narrative (${t.text_type_code})` : 'Narrative';
          if (t.text) lines.push(singleLine(`**${label}:** ${t.text as string}`));
          lines.push(...formatRemainingFields(t, new Set(['text', 'text_type_code'])));
        }

        // Remaining top-level fields (date_of_event, source_type, patient, etc.)
        const renderedTop = new Set(['device', 'report_number', 'event_type', 'mdr_text']);
        lines.push(...formatRemainingFields(r, renderedTop));
      } else if (r.initial_received_date != null) {
        /**
         * Cosmetic adverse events, keyed on the date every cosmetic report carries
         * and no drug, food, or device report does. Checked before `patient`: most
         * cosmetic reports also carry a `patient` object.
         */
        lines.push(...cosmeticLines(r));
      }
      // Drug adverse events
      else if (r.patient) {
        const patient = r.patient;

        lines.push(singleLine(`### Report ${r.safetyreportid ?? 'N/A'}`));
        lines.push(
          singleLine(
            `**Date:** ${r.receivedate ?? 'N/A'} | **Serious:** ${r.serious === '1' ? 'Yes' : r.serious === '2' ? 'No' : (r.serious ?? 'N/A')}`,
          ),
        );
        if (patient.patientsex)
          lines.push(
            singleLine(
              `**Patient:** Sex ${patient.patientsex === '1' ? 'Male' : patient.patientsex === '2' ? 'Female' : patient.patientsex}`,
            ),
          );
        lines.push(...reactionLines((patient.reaction ?? []) as Record<string, unknown>[]));

        // Drugs — expanded with indication and route
        const drugList = (patient.drug ?? []) as Record<string, unknown>[];
        if (drugList.length > 0) {
          lines.push('**Drugs:**');
          for (const d of drugList) {
            const char =
              d.drugcharacterization === '1'
                ? 'Suspect'
                : d.drugcharacterization === '2'
                  ? 'Concomitant'
                  : d.drugcharacterization === '3'
                    ? 'Interacting'
                    : '';
            const detail = [
              char,
              d.drugindication ? `for ${d.drugindication}` : null,
              d.drugadministrationroute
                ? `via ${codeLabel(ADMINISTRATION_ROUTES, d.drugadministrationroute)}`
                : null,
            ]
              .filter(Boolean)
              .join(', ');
            lines.push(
              `- ${lineContent(`${d.medicinalproduct ?? 'Unknown'}${detail ? ` (${detail})` : ''}`)}`,
            );
            lines.push(
              ...formatRemainingFields(
                withCodeLabels(d, DRUG_CODES),
                new Set(['medicinalproduct', 'drugindication', 'drugadministrationroute']),
              ),
            );
          }
          // A blank line ends the list, so the fields below stay outside the last drug's item.
          lines.push('');
        }

        // Remaining patient fields (onset age, age group, weight, death, sex code, etc.)
        lines.push(...patientLines(patient));

        /**
         * Remaining top-level fields (companynumb, sender, primarysource, the
         * serious code, FDA workflow timestamps, ...).
         */
        const renderedTop = new Set(['patient', 'safetyreportid', 'receivedate']);
        lines.push(...formatRemainingFields(withCodeLabels(r, REPORT_CODES), renderedTop));
      }
      // Food adverse events
      else if (r.products || r.reactions) {
        lines.push(singleLine(`### Report ${r.report_number ?? 'N/A'}`));
        if (r.reactions)
          lines.push(
            singleLine(
              `**Reactions:** ${(Array.isArray(r.reactions) ? r.reactions : [r.reactions]).join(', ')}`,
            ),
          );
        if (r.outcomes)
          lines.push(
            singleLine(
              `**Outcomes:** ${(Array.isArray(r.outcomes) ? r.outcomes : [r.outcomes]).join(', ')}`,
            ),
          );
        const productsList = (r.products ?? []) as Record<string, unknown>[];
        if (productsList.length > 0) {
          lines.push('**Products:**');
          for (const p of productsList) {
            const name = (p.name_brand as string) ?? (p.industry_name as string) ?? 'Unknown';
            const detail = [
              p.role ? `role: ${p.role}` : null,
              p.industry_code ? `code: ${p.industry_code}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            lines.push(`- ${lineContent(`${name}${detail ? ` (${detail})` : ''}`)}`);
            lines.push(
              ...formatRemainingFields(p, new Set(['name_brand', 'role', 'industry_code'])),
            );
          }
          // A blank line ends the list, so the fields below stay outside the last product's item.
          lines.push('');
        }

        // Remaining top-level fields (date_created, date_started, consumer, etc.)
        const renderedTop = new Set(['report_number', 'reactions', 'outcomes', 'products']);
        lines.push(...formatRemainingFields(r, renderedTop));
      }
      // Fallback — dump full record
      else {
        lines.push(`### Record`);
        lines.push(`\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``);
      }
      // A list that closed the record already ended on a blank line.
      if (lines.at(-1) !== '') lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

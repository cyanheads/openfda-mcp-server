/**
 * @fileoverview Tool definition for searching openFDA adverse event reports across
 * drugs, food, and devices. `drug/event` is the largest-record endpoint openFDA
 * serves, so `limit`'s default and cap follow the category, and a page holding a
 * report over 24,000 bytes names its largest fields. A browse with neither
 * `search` nor `sort` leads with the category's newest reports.
 * @module mcp-server/tools/definitions/search-adverse-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  emptyResultMessage,
  formatRemainingFields,
  lineContent,
  projectedRecordLines,
  renderValue,
  searchLead,
  singleLine,
} from '@/mcp-server/tools/format-utils.js';
import {
  assertSearchDelimitersBalanced,
  assertSkipWithinCeiling,
  fieldSelection,
  fieldsDescription,
  limitAboveCapError,
  META_LIMIT_DESCRIPTION,
  malformedSearchError,
  pageLimitBy,
  pageSizeNotice,
  phrasePlusHint,
  resolvePageSize,
  SEARCH_SYNTAX_NOTE,
  SKIP_DESCRIPTION,
  searchExpression,
  sortExpression,
  totalUnverifiedField,
} from '@/mcp-server/tools/schema-utils.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  canvasCapacityExhaustedError,
  canvasDisabledError,
  canvasNotFoundError,
  canvasOutputShape,
  canvasResult,
  STAGING_WORKFLOW,
  spillSearch,
  stageInput,
  stagingNotice,
} from '@/services/openfda/canvas-spill.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import {
  inlinePage,
  OVERSIZED_RECORD_BYTES,
  oversizedRecordNotice,
  oversizedRecordOutputShape,
} from '@/services/openfda/page-budget.js';
import {
  projectionNotice,
  projectionOutputShape,
  recordProjection,
} from '@/services/openfda/record-projection.js';

/**
 * Keys that tell one report apart, kept on every `fields`-projected record:
 * `safetyreportid` on drug reports, `report_number` on food and device reports,
 * plus `mdr_report_key` on device reports. A category's record carries only its
 * own, so one list serves all three.
 */
const IDENTITY_KEYS = ['safetyreportid', 'report_number', 'mdr_report_key'] as const;

type Category = 'drug' | 'food' | 'device';

/**
 * The sort a browse with neither `search` nor `sort` sends: the category's
 * received date, newest first. Reports sharing a date page in a stable order on
 * the date alone, so no tie-breaker is added.
 */
const NEWEST_FIRST: Record<Category, string> = {
  drug: 'receivedate:desc',
  food: 'date_created:desc',
  device: 'date_received:desc',
};

/**
 * The product-name field an empty result points each category at. No
 * adverse-event record carries a top-level `openfda` block: drug reports nest
 * it under `patient.drug`, device reports under `device`, food reports have none.
 */
const PRODUCT_FIELD_HINT: Record<Category, string> = {
  drug: 'patient.drug.medicinalproduct (the name as reported) or patient.drug.openfda.brand_name',
  food: 'products.name_brand',
  device: 'device.brand_name',
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
 * Canvas table projections per category — each call stages one category, so the
 * schema is selected by `input.category`. Scalars are VARCHAR (openFDA returns
 * most values as strings; CAST in SQL for math); nested objects/arrays are JSON
 * columns. All nullable — openFDA records are sparse.
 */
const ADVERSE_EVENT_SCHEMAS: Record<Category, ColumnSchema[]> = {
  drug: [
    { name: 'safetyreportid', type: 'VARCHAR', nullable: true },
    { name: 'receivedate', type: 'VARCHAR', nullable: true },
    { name: 'receiptdate', type: 'VARCHAR', nullable: true },
    { name: 'serious', type: 'VARCHAR', nullable: true },
    { name: 'seriousnessdeath', type: 'VARCHAR', nullable: true },
    { name: 'seriousnesshospitalization', type: 'VARCHAR', nullable: true },
    { name: 'occurcountry', type: 'VARCHAR', nullable: true },
    { name: 'primarysourcecountry', type: 'VARCHAR', nullable: true },
    { name: 'companynumb', type: 'VARCHAR', nullable: true },
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'openfda', type: 'JSON', nullable: true },
  ],
  food: [
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'date_created', type: 'VARCHAR', nullable: true },
    { name: 'date_started', type: 'VARCHAR', nullable: true },
    { name: 'outcomes', type: 'JSON', nullable: true },
    { name: 'reactions', type: 'JSON', nullable: true },
    { name: 'products', type: 'JSON', nullable: true },
    { name: 'consumer', type: 'JSON', nullable: true },
  ],
  device: [
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'mdr_report_key', type: 'VARCHAR', nullable: true },
    { name: 'event_type', type: 'VARCHAR', nullable: true },
    { name: 'date_received', type: 'VARCHAR', nullable: true },
    { name: 'date_of_event', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_name', type: 'VARCHAR', nullable: true },
    { name: 'device', type: 'JSON', nullable: true },
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'mdr_text', type: 'JSON', nullable: true },
    { name: 'openfda', type: 'JSON', nullable: true },
  ],
};

export const searchAdverseEventsTool = tool('openfda_search_adverse_events', {
  description: `Search adverse event reports across drugs, food, and devices. Use to investigate safety signals, find reports for a specific product, or explore reactions by demographics.${STAGING_WORKFLOW}`,
  annotations: { readOnlyHint: true },

  input: z.object({
    category: z
      .enum(['drug', 'food', 'device'])
      .describe('Product category — each has different field schemas in the response'),
    search: searchExpression()
      .optional()
      .describe(
        `openFDA search query. Examples: patient.drug.medicinalproduct:"aspirin", patient.reaction.reactionmeddrapt:"nausea" AND serious:"1". Omit both search and sort to browse the newest reports first. ${SEARCH_SYNTAX_NOTE}`,
      ),
    sort: sortExpression()
      .optional()
      .describe(
        "Sort expression — a field path optionally suffixed with :asc or :desc (any letter case; :ascending and :descending are also accepted, and every direction is sent as asc or desc); comma-separate for multi-field sort. Field paths take only letters, digits, underscores, and dots; any other character or direction is rejected before the request. Sortable date fields are category-specific: drug → receivedate (or receiptdate), food → date_created (or date_started), device → date_received (or date_of_event). A field from another category (e.g. receivedate on food or device) causes a query error — use the field for this category. With search also omitted, the default is newest first: drug receivedate:desc, food date_created:desc, device date_received:desc. A search with no sort keeps openFDA's own order.",
      ),
    limit: pageLimitBy(
      'category',
      [
        ['drug', 'drug/event'],
        ['food', 'food/event'],
        ['device', 'device/event'],
      ],
      'Records per page.',
    ),
    skip: z.number().min(0).describe(SKIP_DESCRIPTION).default(0),
    fields: fieldSelection()
      .optional()
      .describe(fieldsDescription(IDENTITY_KEYS, ['receivedate', 'patient.drug.medicinalproduct'])),
    stage: stageInput,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID returned by a prior stage=true call to this tool or another openFDA search tool (openfda_search_* or openfda_lookup_ndc). Passing one stages this search onto that canvas (same effect as stage=true) so result sets accumulate for cross-table joins. Omit to stage onto a fresh canvas.',
    ),
  }),

  output: z.object({
    meta: z
      .object({
        total: z.number().describe('Total matching records in the database'),
        skip: z.number().describe('Pagination offset'),
        limit: z.number().describe(META_LIMIT_DESCRIPTION),
        lastUpdated: z.string().describe('Dataset last updated date'),
        totalUnverified: totalUnverifiedField,
      })
      .describe('Response metadata'),
    results: z
      .array(z.record(z.string(), z.any()))
      .describe(
        'Adverse event records — fields vary by category (drug: patient/reactions/drugs, device: device details/event type, food: products/outcomes)',
      ),
    ...oversizedRecordOutputShape,
    ...projectionOutputShape,
    ...canvasOutputShape,
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching adverse event records in the dataset'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Search filter applied to the query, as submitted to openFDA'),
    notice: z
      .string()
      .optional()
      .describe(
        `Canvas staging disclosure when the call staged, the limit clamp when limit exceeded the category's cap (requested value, cap, next skip), the fields projection and any requested path no record carries, the size and largest fields when a report on the page exceeds ${OVERSIZED_RECORD_BYTES} bytes, and guidance when results are empty or paging overshot — how to broaden filters or adjust the query.`,
      ),
  },

  errors: [
    limitAboveCapError,
    canvasDisabledError,
    canvasNotFoundError,
    canvasCapacityExhaustedError,
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The openFDA daily or per-minute request limit is exceeded.',
      retryable: true,
      recovery:
        'Wait briefly and retry, or configure OPENFDA_API_KEY to raise the daily limit to 120K requests.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The openFDA API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a short wait; if the error persists check api.fda.gov status.',
      thrownBy: 'service',
    },
    malformedSearchError,
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The search query was rejected by openFDA (malformed field name, invalid syntax).',
      recovery:
        'Verify field names using the openFDA field reference and correct boolean operators (AND/OR, quoted phrases).',
      thrownBy: 'service',
    },
    {
      reason: 'pagination_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'skip exceeds the 25000 record pagination ceiling.',
      recovery:
        'Narrow the search query with additional filters or date ranges instead of increasing skip.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    assertSkipWithinCeiling(input.skip, ctx);
    assertSearchDelimitersBalanced(input.search, ctx);

    const endpoint = `${input.category}/event` as const;
    const size = resolvePageSize(input.limit, endpoint, ctx);
    const sort = sortOrNewest(input, NEWEST_FIRST[input.category]);
    const emptyNotice = (skip: number, total: number, totalUnverified?: boolean) =>
      emptyResultMessage(
        skip,
        total,
        `No adverse event reports matched${input.search ? ` search: ${codeLiteral(input.search)}` : ''} in ${endpoint}. Try broadening filters or checking field names (for product searches use ${PRODUCT_FIELD_HINT[input.category]}). ${formatFieldHint(endpoint)}`,
        totalUnverified,
      );

    const projection = recordProjection(input.fields, IDENTITY_KEYS);
    const canvas = getCanvas();
    const staging = input.stage || input.canvas_id !== undefined;
    if (staging && !canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'Staging requires DataCanvas. Set CANVAS_PROVIDER_TYPE=duckdb, or drop stage/canvas_id for the inline page.',
      );
    }

    if (canvas && staging) {
      const spill = await spillSearch({
        endpoint,
        search: input.search,
        sort,
        canvasId: input.canvas_id,
        schema: ADVERSE_EVENT_SCHEMAS[input.category],
        limit: size.limit,
        skip: input.skip,
        projection,
        ctx,
      });
      const staged = canvasResult(spill);
      ctx.enrich({ totalResults: spill.total });
      if (input.search) ctx.enrich.echo(input.search);
      ctx.enrich.notice(
        [
          spill.preview.length === 0 ? emptyNotice(spill.skip, spill.total) : undefined,
          phrasePlusHint(input.search, spill.total),
          pageSizeNotice(size, staged),
          projectionNotice(staged),
          oversizedRecordNotice(staged),
          stagingNotice(spill),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return staged;
    }

    const svc = getOpenFdaService();
    const response = await svc.query(
      endpoint,
      {
        search: input.search,
        sort,
        limit: size.limit,
        skip: input.skip,
      },
      ctx,
    );

    const page = inlinePage(response, size.limit, projection);

    ctx.log.info('Adverse event search completed', {
      category: input.category,
      total: response.meta.total,
      returned: page.results.length,
    });

    ctx.enrich({ totalResults: response.meta.total });
    if (input.search) ctx.enrich.echo(input.search);
    const notices = [
      page.results.length === 0
        ? emptyNotice(response.meta.skip, response.meta.total, response.meta.totalUnverified)
        : undefined,
      phrasePlusHint(input.search, response.meta.total),
      pageSizeNotice(size, page),
      projectionNotice(page),
      oversizedRecordNotice(page),
    ].filter(Boolean);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

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
      // Device adverse events. Checked before `patient`: a device/event record
      // also carries a `patient` array, so a patient-first branch would route
      // every device report into the drug renderer.
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

        // Remaining top-level fields (companynumb, sender, primarysource, the
        // serious code, FDA workflow timestamps, ...).
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

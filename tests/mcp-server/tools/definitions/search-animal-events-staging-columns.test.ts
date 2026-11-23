/**
 * @fileoverview Staged-table columns for openfda_search_animal_events (#105).
 * Runs the real staging path end to end — the tool handler, the real
 * `spillSearch` drain, and a real DataCanvas (framework CanvasRegistry + DuckDB
 * provider) — with only the openFDA service stubbed, then reads the table back
 * through openfda_dataframe_describe and openfda_dataframe_query.
 * @module tests/mcp-server/tools/definitions/search-animal-events-staging-columns.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The records the stubbed openFDA service pages over, whatever the search. */
const DATASET: { rows: Record<string, unknown>[] } = { rows: [] };

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: () => ({
    query: vi.fn(async (_endpoint: string, params: { limit?: number; skip?: number }) => {
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 1000;
      return {
        meta: { total: DATASET.rows.length, skip, limit, lastUpdated: '2026-11-22' },
        results: structuredClone(DATASET.rows.slice(skip, skip + limit)),
      };
    }),
  }),
  initOpenFdaService: () => {},
}));

import { searchAnimalEventsTool } from '@/mcp-server/tools/definitions/search-animal-events.tool.js';
import {
  DUCKDB_SUITE,
  describeStagedTable,
  installStagingCanvas,
  queryStagedRows,
  shutdownStagingCanvas,
  stagedColumns,
} from '../../../helpers/staging-canvas.js';

const TENANT = 'animal-events-staging-columns';

/*
 * Live animalandveterinary/event records (original_receive_date desc, 2026-11-22),
 * long arrays trimmed. SPARSE carries 10 of the 20 top-level fields.
 */
const SPARSE = {
  health_assessment_prior_to_exposure: { assessed_by: 'Veterinarian' },
  reaction: [{ veddra_version: '10', veddra_term_code: '99951', veddra_term_name: 'UNPALATABLE' }],
  receiver: {
    organization: 'Food and Drug Administration Center for Veterinary Medicine',
    street_address: '7500 Standish Place (HFV-210) Room N403',
    city: 'Rockville',
    state: 'MD',
    postal_code: '20855',
    country: 'USA',
  },
  foreign_or_domestic: 'Domestic',
  unique_aer_id_number: 'USA-USFDACVM-2026-US-035617',
  report_id: 'N141521',
  original_receive_date: '20260626',
  primary_reporter: 'Other Health Care Professional',
  type_of_information: 'Manufacturing/Product Defect Manufacturing Defect With no Adverse Events',
  drug: [
    {
      lot_number: 'not given',
      brand_name: 'MSK',
      dosage_form: 'Tablet, chewable',
      manufacturer: { name: 'MSK', registration_number: 'USA-USFDACVM-N141521' },
      active_ingredients: [{ name: 'Pyrantel Pamoate;Sarolaner' }],
    },
  ],
};

/** Carries `duration`, the one added structure most records lack. */
const DURATION = {
  treated_for_ae: 'true',
  reaction: [
    {
      veddra_term_name: 'Diarrhoea',
      number_of_animals_affected: '1',
      accuracy: 'Actual',
    },
  ],
  receiver: SPARSE.receiver,
  unique_aer_id_number: 'USA-USFDACVM-2026-US-035585',
  original_receive_date: '20260626',
  number_of_animals_affected: '1',
  primary_reporter: 'Veterinarian',
  number_of_animals_treated: '1',
  secondary_reporter: 'Animal Owner',
  drug: [
    {
      administered_by: 'Animal Owner',
      route: 'Oral',
      dose: {
        numerator: '24',
        numerator_unit: 'Milligram',
        denominator: '1',
        denominator_unit: 'Animal',
      },
      brand_name: 'MSK',
      dosage_form: 'Tablet, chewable',
      manufacturer: { name: 'MSK', registration_number: 'USA-USFDACVM-N141521' },
      active_ingredients: [{ name: 'Pyrantel Pamoate;Sarolaner' }],
    },
  ],
  duration: { value: '6', unit: 'Day' },
  health_assessment_prior_to_exposure: { condition: 'Fair', assessed_by: 'Veterinarian' },
  onset_date: '20260613',
  foreign_or_domestic: 'Domestic',
  report_id: 'N141521',
  animal: { species: 'Dog', gender: 'Female', breed: { breed_component: 'Hound - Basset' } },
  type_of_information: 'Safety Issue',
  serious_ae: 'true',
  outcome: [{ medical_status: 'Recovered/Normal', number_of_animals_affected: '1' }],
};

/** Carries `time_between_exposure_and_onset` (on 45,044 of 1,378,854 reports). */
const ONSET_INTERVAL = {
  treated_for_ae: 'true',
  reaction: [
    {
      veddra_term_name: 'Lack of efficacy (endoparasite) - heartworm',
      number_of_animals_affected: '1',
      accuracy: 'Actual',
    },
  ],
  receiver: SPARSE.receiver,
  unique_aer_id_number: 'USA-USFDACVM-2026-US-035709',
  time_between_exposure_and_onset: '>12 Months',
  original_receive_date: '20260625',
  number_of_animals_affected: '1',
  primary_reporter: 'Animal Owner',
  number_of_animals_treated: '1',
  secondary_reporter: 'Veterinarian',
  drug: [
    {
      frequency_of_administration: { value: '1', unit: 'Month' },
      route: 'Oral',
      brand_name: 'MSK',
      dosage_form: 'Tablet',
      manufacturer: { name: 'MSK', registration_number: 'USA-USFDACVM-A200338' },
      active_ingredients: [
        { name: 'Ivermectin', dose: { numerator: '136', numerator_unit: 'Microgram' } },
        { name: 'Pyrantel', dose: { numerator: '114', numerator_unit: 'Milligram' } },
      ],
    },
  ],
  health_assessment_prior_to_exposure: { condition: 'Unknown', assessed_by: 'Veterinarian' },
  onset_date: '20260420',
  foreign_or_domestic: 'Domestic',
  report_id: 'A200338',
  animal: { species: 'Dog', gender: 'Male', breed: { breed_component: 'Retriever - Labrador' } },
  type_of_information: 'Lack Of Expected Effectiveness',
  serious_ae: 'true',
  outcome: [{ medical_status: 'Outcome Unknown', number_of_animals_affected: '1' }],
};

/** Three drugs, the first with three active ingredients. */
const MULTI_DRUG = {
  treated_for_ae: 'false',
  reaction: [
    { veddra_term_name: 'Panting', number_of_animals_affected: '1', accuracy: 'Actual' },
    { veddra_term_name: 'Seizure NOS', number_of_animals_affected: '1', accuracy: 'Actual' },
  ],
  receiver: SPARSE.receiver,
  unique_aer_id_number: 'USA-USFDACVM-2026-US-035746',
  original_receive_date: '20260625',
  number_of_animals_affected: '1',
  primary_reporter: 'Veterinarian',
  number_of_animals_treated: '1',
  secondary_reporter: 'Animal Owner',
  drug: [
    {
      administered_by: 'Veterinarian',
      route: 'Auricular (Otic)',
      brand_name: 'MSK',
      dosage_form: 'Solution',
      manufacturer: { name: 'MSK', registration_number: 'USA-USFDACVM-N141440' },
      active_ingredients: [
        { name: 'Florfenicol', dose: { numerator: '17', numerator_unit: 'Milligram' } },
        { name: 'Mometasone Furoate', dose: { numerator: '2', numerator_unit: 'Milligram' } },
        {
          name: 'Terbinafine Hydrochloride',
          dose: { numerator: '15', numerator_unit: 'Milligram' },
        },
      ],
    },
    {
      administered_by: 'Unknown',
      route: 'Unknown',
      brand_name: 'MSK',
      manufacturer: { name: 'MSK' },
      active_ingredients: [{ name: 'Oclacitinib Maleate' }],
    },
    {
      administered_by: 'Unknown',
      route: 'Auricular (Otic)',
      brand_name: 'MSK',
      manufacturer: { name: 'MSK' },
      active_ingredients: [{ name: 'Phytosphingosine Hydrochloride' }],
    },
  ],
  health_assessment_prior_to_exposure: { condition: 'Good', assessed_by: 'Veterinarian' },
  onset_date: '20260625',
  foreign_or_domestic: 'Domestic',
  report_id: 'N141440',
  animal: {
    species: 'Dog',
    gender: 'Male',
    breed: { breed_component: ['Retriever - Labrador', 'Poodle (unspecified)'] },
  },
  type_of_information: 'Safety Issue',
  serious_ae: 'true',
  outcome: [{ medical_status: 'Ongoing', number_of_animals_affected: '1' }],
};

const RECORDS: Record<string, unknown>[] = [SPARSE, DURATION, ONSET_INTERVAL, MULTI_DRUG];

/** The 0.10.0 staged columns, in order, with their types: every later release keeps them. */
const RELEASED_COLUMNS = [
  ...[
    'unique_aer_id_number',
    'original_receive_date',
    'serious_ae',
    'primary_reporter',
    'type_of_information',
    'number_of_animals_affected',
    'number_of_animals_treated',
    'foreign_or_domestic',
  ].map((name) => ({ name, type: 'VARCHAR' })),
  ...['animal', 'drug', 'reaction', 'outcome'].map((name) => ({ name, type: 'JSON' })),
];
const RELEASED_SCALARS = RELEASED_COLUMNS.filter((c) => c.type === 'VARCHAR').map((c) => c.name);

beforeEach(() => {
  installStagingCanvas(TENANT);
  DATASET.rows = RECORDS;
});

afterEach(() => shutdownStagingCanvas(TENANT));

async function search(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: searchAnimalEventsTool.errors, tenantId: TENANT });
  return searchAnimalEventsTool.handler(searchAnimalEventsTool.input.parse(input), ctx);
}

async function stage(input: Record<string, unknown> = {}) {
  const result = await search({ ...input, stage: true });
  expect(result.spilled).toBe(true);
  return result;
}

const describeTable = (canvasId: string, table: string) =>
  describeStagedTable(TENANT, canvasId, table);
const columnsOf = (canvasId: string, table: string) => stagedColumns(TENANT, canvasId, table);
const query = (canvasId: string, sql: string) => queryStagedRows(TENANT, canvasId, sql);

describe('openfda_search_animal_events staging — released columns (#105)', DUCKDB_SUITE, () => {
  it('keeps every 0.10.0 column with its name and type', async () => {
    const staged = await stage();
    const columns = await columnsOf(staged.canvas_id ?? '', staged.canvas_table ?? '');
    expect(columns).toEqual(expect.arrayContaining(RELEASED_COLUMNS));
  });

  it('returns a staged call naming no added column as before, on both surfaces', async () => {
    const result = await runToolContract(
      searchAnimalEventsTool,
      { search: 'animal.species:"Dog"', limit: 1, stage: true },
      { context: { tenantId: TENANT } },
    );
    const fixed = (text: string) => text.replaceAll(/spilled_[0-9a-f]{8}/g, 'spilled_TABLE');
    const structured = JSON.parse(fixed(JSON.stringify(result.structuredContent)));
    const text = result.content.flatMap((block) =>
      block.type === 'text' ? [fixed(block.text)] : [],
    );
    const notice =
      'Staged 4 of 4 matched records on canvas table "spilled_TABLE" (canvas_id "CANVAS"). Call openfda_dataframe_describe for the column names, then openfda_dataframe_query to run SQL over the staged set.';
    const canvasId = String(structured.canvas_id);

    expect(result.isError).toBeFalsy();
    expect(structured).toEqual({
      meta: { total: 4, skip: 0, limit: 1, lastUpdated: '2026-11-22' },
      results: [SPARSE],
      canvas_id: canvasId,
      canvas_table: 'spilled_TABLE',
      spilled: true,
      staged_rows: 4,
      totalResults: 4,
      effectiveQuery: 'animal.species:"Dog"',
      notice: notice.replace('CANVAS', canvasId),
    });
    expect(text).toEqual([
      [
        '**4 total results** (returned: 1, skip: 0, limit: 1) | Data updated: 2026-11-22',
        '',
        `> Staged 4 of 4 matched rows on canvas table \`spilled_TABLE\` (canvas_id \`${canvasId}\`, spilled=true) — openfda_dataframe_describe for its columns, then openfda_dataframe_query for SQL.`,
        '',
        '### Report USA-USFDACVM-2026-US-035617',
        '**Received:** 20260626 | **Serious:** N/A',
        '**Reactions:** UNPALATABLE',
        '**Veddra version:** 10',
        '**Veddra term code:** 99951',
        '**Drugs:**',
        '- Pyrantel Pamoate;Sarolaner (brand masked: MSK)',
        '**Lot number:** not given',
        '**Dosage form:** Tablet, chewable',
        '**Manufacturer:** name masked: MSK; registration_number=USA-USFDACVM-N141521',
        '**Active ingredients:** [{"name":"Pyrantel Pamoate;Sarolaner"}]',
        '',
        '**Reporter:** Other Health Care Professional',
        '**Type:** Manufacturing/Product Defect Manufacturing Defect With no Adverse Events',
        '**Origin:** Domestic',
        '**Health assessment prior to exposure:** assessed_by=Veterinarian',
        '**Receiver:** organization=Food and Drug Administration Center for Veterinary Medicine; street_address=7500 Standish Place (HFV-210) Room N403; city=Rockville; state=MD; postal_code=20855; country=USA',
        '**Report id:** N141521',
        '',
      ].join('\n'),
      `\n\n**totalResults:** 4\nQuery: \`animal.species:"Dog"\`\n> ${notice.replace('CANVAS', canvasId)}`,
    ]);
  });

  it('answers SQL over the 0.10.0 columns with the same values, nested arrays past the first level', async () => {
    const staged = await stage();
    const rows = await query(
      staged.canvas_id ?? '',
      // json_array_length is a BIGINT, which the query tool returns as a string.
      `SELECT ${RELEASED_SCALARS.join(', ')}, json_extract_string(animal, '$.breed.breed_component[1]') AS second_breed, json_array_length(drug) AS drugs, json_extract_string(drug, '$[0].active_ingredients[2].name') AS third_ingredient, json_extract_string(drug, '$[0].active_ingredients[1].dose.numerator') AS second_dose, json_extract_string(drug, '$[1].active_ingredients[0].name') AS second_drug_ingredient, json_extract_string(reaction, '$[1].veddra_term_name') AS second_reaction, json_extract_string(outcome, '$[0].medical_status') AS outcome FROM ${staged.canvas_table} ORDER BY unique_aer_id_number`,
    );
    expect(rows).toEqual([
      {
        unique_aer_id_number: 'USA-USFDACVM-2026-US-035585',
        original_receive_date: '20260626',
        serious_ae: 'true',
        primary_reporter: 'Veterinarian',
        type_of_information: 'Safety Issue',
        number_of_animals_affected: '1',
        number_of_animals_treated: '1',
        foreign_or_domestic: 'Domestic',
        second_breed: null,
        drugs: '1',
        third_ingredient: null,
        second_dose: null,
        second_drug_ingredient: null,
        second_reaction: null,
        outcome: 'Recovered/Normal',
      },
      {
        unique_aer_id_number: 'USA-USFDACVM-2026-US-035617',
        original_receive_date: '20260626',
        serious_ae: null,
        primary_reporter: 'Other Health Care Professional',
        type_of_information:
          'Manufacturing/Product Defect Manufacturing Defect With no Adverse Events',
        number_of_animals_affected: null,
        number_of_animals_treated: null,
        foreign_or_domestic: 'Domestic',
        second_breed: null,
        drugs: '1',
        third_ingredient: null,
        second_dose: null,
        second_drug_ingredient: null,
        second_reaction: null,
        outcome: null,
      },
      {
        unique_aer_id_number: 'USA-USFDACVM-2026-US-035709',
        original_receive_date: '20260625',
        serious_ae: 'true',
        primary_reporter: 'Animal Owner',
        type_of_information: 'Lack Of Expected Effectiveness',
        number_of_animals_affected: '1',
        number_of_animals_treated: '1',
        foreign_or_domestic: 'Domestic',
        second_breed: null,
        drugs: '1',
        third_ingredient: null,
        second_dose: '114',
        second_drug_ingredient: null,
        second_reaction: null,
        outcome: 'Outcome Unknown',
      },
      {
        unique_aer_id_number: 'USA-USFDACVM-2026-US-035746',
        original_receive_date: '20260625',
        serious_ae: 'true',
        primary_reporter: 'Veterinarian',
        type_of_information: 'Safety Issue',
        number_of_animals_affected: '1',
        number_of_animals_treated: '1',
        foreign_or_domestic: 'Domestic',
        second_breed: 'Poodle (unspecified)',
        drugs: '3',
        third_ingredient: 'Terbinafine Hydrochloride',
        second_dose: '2',
        second_drug_ingredient: 'Oclacitinib Maleate',
        second_reaction: 'Seizure NOS',
        outcome: 'Ongoing',
      },
    ]);
  });
});

/** The top-level fields animalandveterinary/event returns that 0.10.0 did not stage. */
const ADDED_COLUMNS = [
  ...[
    'report_id',
    'onset_date',
    'secondary_reporter',
    'treated_for_ae',
    'time_between_exposure_and_onset',
  ].map((name) => ({ name, type: 'VARCHAR' })),
  ...['receiver', 'health_assessment_prior_to_exposure', 'duration'].map((name) => ({
    name,
    type: 'JSON',
  })),
];

describe('openfda_search_animal_events staging — upstream fields (#105)', DUCKDB_SUITE, () => {
  it('stages one fixed nullable column per top-level field the endpoint returns, in schema order', async () => {
    const staged = await stage();
    const table = await describeTable(staged.canvas_id ?? '', staged.canvas_table ?? '');

    // The 0.10.0 columns keep their positions; the added ones follow them.
    expect(table?.columns.map(({ name, type }) => ({ name, type }))).toEqual([
      ...RELEASED_COLUMNS,
      ...ADDED_COLUMNS,
    ]);
    expect(table?.columns.every((c) => c.nullable === true)).toBe(true);
    const names = new Set(table?.columns.map((c) => c.name));
    for (const key of new Set(RECORDS.flatMap((r) => Object.keys(r)))) {
      expect(names.has(key), key).toBe(true);
    }
  });

  it.each([
    ['report_id', 'report_id', ['N141521', 'N141521', 'A200338', 'N141440']],
    ['onset_date', 'onset_date', ['20260613', null, '20260420', '20260625']],
    [
      'secondary_reporter',
      'secondary_reporter',
      ['Animal Owner', null, 'Veterinarian', 'Animal Owner'],
    ],
    ['treated_for_ae', 'treated_for_ae', ['true', null, 'true', 'false']],
    [
      'time_between_exposure_and_onset',
      'time_between_exposure_and_onset',
      [null, null, '>12 Months', null],
    ],
    [
      'receiver',
      `json_extract_string(receiver, '$.city')`,
      ['Rockville', 'Rockville', 'Rockville', 'Rockville'],
    ],
    [
      'health_assessment_prior_to_exposure',
      `json_extract_string(health_assessment_prior_to_exposure, '$.condition') || '/' || json_extract_string(health_assessment_prior_to_exposure, '$.assessed_by')`,
      ['Fair/Veterinarian', null, 'Unknown/Veterinarian', 'Good/Veterinarian'],
    ],
    [
      'duration',
      `json_extract_string(duration, '$.value') || ' ' || json_extract_string(duration, '$.unit')`,
      ['6 Day', null, null, null],
    ],
  ] as const)(
    'stages %s as its value where a record carries it and NULL where it does not',
    async (_column, expression, values) => {
      const staged = await stage();
      const rows = await query(
        staged.canvas_id ?? '',
        `SELECT unique_aer_id_number AS id, ${expression} AS value FROM ${staged.canvas_table} ORDER BY id`,
      );
      // Ordered by id: 035585 (DURATION), 035617 (SPARSE), 035709 (ONSET_INTERVAL), 035746 (MULTI_DRUG).
      expect(rows.map((r) => r.value)).toEqual(values);
    },
  );

  it('reads the sparse record’s structures as NULL or as the part it carries, never a fabricated value', async () => {
    const staged = await stage();
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT duration IS NULL AS no_duration, json_extract_string(health_assessment_prior_to_exposure, '$.assessed_by') AS assessed_by, json_extract_string(health_assessment_prior_to_exposure, '$.condition') AS condition, animal IS NULL AS no_animal, outcome IS NULL AS no_outcome FROM ${staged.canvas_table} WHERE unique_aer_id_number = 'USA-USFDACVM-2026-US-035617'`,
    );
    expect(rows).toEqual([
      {
        no_duration: true,
        assessed_by: 'Veterinarian',
        condition: null,
        no_animal: true,
        no_outcome: true,
      },
    ]);
  });

  it('answers a treatment-duration question in SQL from the added columns', async () => {
    const staged = await stage();
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT unique_aer_id_number AS id, onset_date, json_extract_string(duration, '$.value') AS days FROM ${staged.canvas_table} WHERE treated_for_ae = 'true' AND json_extract_string(duration, '$.unit') = 'Day'`,
    );
    expect(rows).toEqual([
      { id: 'USA-USFDACVM-2026-US-035585', onset_date: '20260613', days: '6' },
    ]);
  });

  it('unions two stagings onto one canvas positionally, whatever fields their rows carry', async () => {
    DATASET.rows = [SPARSE];
    const first = await stage();
    DATASET.rows = [DURATION, ONSET_INTERVAL, MULTI_DRUG];
    const second = await stage({ canvas_id: first.canvas_id });
    expect(second.canvas_id).toBe(first.canvas_id);

    const [firstColumns, secondColumns] = await Promise.all([
      columnsOf(first.canvas_id ?? '', first.canvas_table ?? ''),
      columnsOf(first.canvas_id ?? '', second.canvas_table ?? ''),
    ]);
    expect(secondColumns).toEqual(firstColumns);

    const rows = await query(
      first.canvas_id ?? '',
      `SELECT unique_aer_id_number AS id, time_between_exposure_and_onset AS interval FROM (SELECT * FROM ${first.canvas_table} UNION ALL SELECT * FROM ${second.canvas_table}) ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'USA-USFDACVM-2026-US-035585', interval: null },
      { id: 'USA-USFDACVM-2026-US-035617', interval: null },
      { id: 'USA-USFDACVM-2026-US-035709', interval: '>12 Months' },
      { id: 'USA-USFDACVM-2026-US-035746', interval: null },
    ]);
  });

  it('stores no object or array as text in a VARCHAR column', async () => {
    const staged = await stage();
    const columns = await columnsOf(staged.canvas_id ?? '', staged.canvas_table ?? '');
    const text = columns.filter((c) => c.type === 'VARCHAR').map((c) => c.name);
    const rows = await query(
      staged.canvas_id ?? '',
      `SELECT count(*) AS n FROM ${staged.canvas_table} WHERE ${text.map((c) => `${c} LIKE '%[object Object]%'`).join(' OR ')}`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

/*
 * #100 — the SQL a staged call's tie notice prints runs as printed on the table it
 * names, for every array the notice can name, and answers per entry: each case
 * holds a record openFDA matches by different entries (fixtures above).
 */
describe('openfda_search_animal_events staging — the tie notice SQL (#100)', DUCKDB_SUITE, () => {
  it.each([
    [
      'drug',
      'drug.active_ingredients.name:"Oclacitinib" AND drug.route:"Unknown"',
      ['USA-USFDACVM-2026-US-035746'],
    ],
    // Florfenicol is in MULTI_DRUG's first drug and route Unknown in its second.
    ['drug', 'drug.active_ingredients.name:"Florfenicol" AND drug.route:"Unknown"', []],
    [
      'drug',
      'drug.active_ingredients.name:"Ivermectin" AND drug.active_ingredients.dose.numerator:"136"',
      ['USA-USFDACVM-2026-US-035709'],
    ],
    // 114 is Pyrantel's dose numerator, not Ivermectin's.
    [
      'drug',
      'drug.active_ingredients.name:"Ivermectin" AND drug.active_ingredients.dose.numerator:"114"',
      [],
    ],
    [
      'reaction',
      'reaction.veddra_term_name:"Panting" AND reaction.accuracy:"Actual"',
      ['USA-USFDACVM-2026-US-035746'],
    ],
    [
      'outcome',
      'outcome.medical_status:"Ongoing" AND outcome.number_of_animals_affected:"1"',
      ['USA-USFDACVM-2026-US-035746'],
    ],
  ] as const)('runs the %s condition for %s and returns %j', async (array, tied, ids) => {
    const ctx = createMockContext({ errors: searchAnimalEventsTool.errors, tenantId: TENANT });
    const staged = await searchAnimalEventsTool.handler(
      searchAnimalEventsTool.input.parse({ search: tied, stage: true }),
      ctx,
    );
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain(`different \`${array}\` entries`);
    const sql = /`(SELECT \* FROM \S+ t WHERE .+)`\.$/.exec(notice)?.[1];
    expect(sql).toContain(`FROM ${staged.canvas_table} t WHERE EXISTS`);

    const rows = await query(staged.canvas_id ?? '', sql ?? '');
    expect(rows.map((r) => r.unique_aer_id_number).sort()).toEqual(ids);
  });
});

/*
 * Plain and staged calls of one input serve the same inline window: the drain
 * pages by skip and limit, `fields` cuts the page only, and the table keeps the
 * whole match with every nested array intact.
 */
describe('openfda_search_animal_events staging — inline window, both paths', DUCKDB_SUITE, () => {
  const MATRIX = [0, 2].flatMap((skip) =>
    [undefined, ['animal.species']].flatMap((fields) =>
      [false, true].map((canvasSupplied) => ({ skip, fields, canvasSupplied })),
    ),
  );

  it.each(MATRIX)(
    'skip $skip, fields $fields, canvas_id supplied: $canvasSupplied',
    async ({ skip, fields, canvasSupplied }) => {
      const call = { search: 'animal.species:"Dog"', skip, limit: 1, ...(fields && { fields }) };
      const seed = canvasSupplied ? await stage() : undefined;

      const plain = await search(call);
      const staged = await stage({ ...call, ...(seed && { canvas_id: seed.canvas_id }) });

      expect(plain).not.toHaveProperty('spilled');
      expect(staged.results).toEqual(plain.results);
      const record = RECORDS[skip]!;
      expect(staged.results.map((r) => r.unique_aer_id_number)).toEqual([
        record.unique_aer_id_number,
      ]);
      // SPARSE (skip 0) carries no animal, so the projection keeps the identity key alone.
      const keys = fields
        ? ['unique_aer_id_number', ...('animal' in record ? ['animal'] : [])].sort()
        : Object.keys(record).sort();
      expect(Object.keys(staged.results[0] ?? {}).sort()).toEqual(keys);
      expect(staged.staged_rows).toBe(RECORDS.length);
      if (seed) expect(staged.canvas_id).toBe(seed.canvas_id);
      const table = await describeTable(staged.canvas_id ?? '', staged.canvas_table ?? '');
      expect(table?.row_count).toBe(RECORDS.length);
      const nested = await query(
        staged.canvas_id ?? '',
        `SELECT json_extract_string(drug, '$[0].active_ingredients[2].name') AS third, json_extract_string(drug, '$[2].route') AS third_route FROM ${staged.canvas_table} WHERE unique_aer_id_number = 'USA-USFDACVM-2026-US-035746'`,
      );
      expect(nested).toEqual([
        { third: 'Terbinafine Hydrochloride', third_route: 'Auricular (Otic)' },
      ]);
    },
  );
});

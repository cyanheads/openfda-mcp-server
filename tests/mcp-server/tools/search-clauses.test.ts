/**
 * @fileoverview Tests for the `search` clause scanner: the field paths a search
 * names, the source spans of each field clause's value, the conjoined-pair
 * detector for clauses under one array of objects, and the notice built on it.
 * @module tests/mcp-server/tools/search-clauses.test
 */

import { describe, expect, it } from 'vitest';
import {
  arrayTieNotice,
  type FieldClause,
  fieldPathsNamed,
  findConjoinedArrayClauses,
  scanFieldClauses,
} from '@/mcp-server/tools/search-clauses.js';
import { searchExpression } from '@/mcp-server/tools/search-expression.js';
import { linearTiming } from '../../helpers/cpu-timing.js';

/**
 * Arrays of objects per endpoint, read from live records — the table the
 * detector is handed. Endpoints absent here have none.
 */
const ARRAYS: Record<string, readonly string[]> = {
  'drug/drugsfda': [
    'submissions',
    'submissions.application_docs',
    'submissions.submission_property_type',
    'products',
    'products.active_ingredients',
  ],
  'drug/event': ['patient.drug', 'patient.reaction'],
  'device/event': ['device', 'patient', 'mdr_text'],
  'food/event': ['products'],
  'animalandveterinary/event': ['drug', 'drug.active_ingredients', 'reaction', 'outcome'],
  'drug/ndc': ['active_ingredients', 'packaging'],
};
const arraysOf = (endpoint: string) => ARRAYS[endpoint] ?? [];
const ANIMAL = arraysOf('animalandveterinary/event');

describe('fieldPathsNamed', () => {
  it.each([
    ['no search text', '', []],
    ['one clause', 'animal.species:"Dog"', ['animal.species']],
    [
      'two clauses joined by AND',
      'drug.active_ingredients.name:"Fluralaner" AND serious_ae:"true"',
      ['drug.active_ingredients.name', 'serious_ae'],
    ],
    ['a repeated field once', 'a.b:x OR a.b:y', ['a.b']],
    [
      'a trailing .exact dropped',
      'patient.reaction.reactionmeddrapt.exact:"NAUSEA"',
      ['patient.reaction.reactionmeddrapt'],
    ],
    ['.exact and the bare path as one', 'a.b.exact:"X" AND a.b:y', ['a.b']],
    ['an _exists_ value', '_exists_:drug.route', ['drug.route']],
    ['a _missing_ value', '_missing_:outcome.medical_status', ['outcome.medical_status']],
    ['a quoted _exists_ value', '_exists_:"drug.route"', ['drug.route']],
    ['an _exists_ value with .exact', '_exists_:a.b.exact', ['a.b']],
    ['a bare term (default field) naming nothing', 'aspirin', []],
    ['a bare phrase naming nothing', '"aspirin tablets"', []],
    ['a field: inside a quoted phrase', 'a:"b:c d:e"', ['a']],
    ['a field: inside a range', 'a:[b:c TO d:e]', ['a']],
    ['a field: inside a regular expression', 'a:/b:c/', ['a']],
    ['an escaped colon inside a term', 'a\\:b:c', ['a\\:b']],
    ['whitespace around the colon', 'a.b : "x" AND c.d: y', ['a.b', 'c.d']],
    ['modifiers before fields', '+a:x -b:y !c:z NOT d:w', ['a', 'b', 'c', 'd']],
    ['a field group', 'a.b:(x OR y) AND c:z', ['a.b', 'c']],
    ['an explicit field inside a field group', 'a:(b:x)', ['b']],
    ['an _exists_ field group', '_exists_:(a.b OR c.d)', ['a.b', 'c.d']],
    [
      'groups nested three deep',
      '(a:1 AND (b:2 OR (c:3 AND d.exact:4))) AND e:5',
      ['a', 'b', 'c', 'd', 'e'],
    ],
    ['a boost and a fuzzy suffix', 'a:x^2 AND b:"y z"~3 AND c:w', ['a', 'b', 'c']],
    ['operator words as terms when glued', 'ANDROID:x AND ORACLE:y', ['ANDROID', 'ORACLE']],
    ['&& and || connectors', 'a:x && b:y || c:z', ['a', 'b', 'c']],
    ['a field with no value', 'a: AND b:y', ['b']],
    ['an unclosed group', '(a:x AND (b:y', ['a', 'b']],
    ['an unclosed phrase', 'a:x AND b:"y c:z', ['a', 'b']],
    ['an unclosed range', 'a:[1 TO b:2', ['a']],
    ['stray closers', ') a:x ] b:y } c:z', ['a', 'b', 'c']],
    ['a trailing backslash', 'a:x\\', ['a']],
  ] as const)('names %s', (_label, search, expected) => {
    expect(fieldPathsNamed(search)).toEqual(expected);
  });

  // Handlers read the string after the shared schema has spaced openFDA's URL-form `+`.
  it('reads the URL-form + separators as the handler receives them', () => {
    const normalized = searchExpression().parse('a.b:"x"+AND+c.d:[1+TO+2]+e:f');
    expect(fieldPathsNamed(normalized)).toEqual(['a.b', 'c.d', 'e']);
  });
});

describe('scanFieldClauses', () => {
  /** The text each value span covers, so the spans read back as the caller wrote them. */
  const spanned = (search: string, clauses: FieldClause[]) =>
    clauses.map(({ field, value }) => {
      if (value.kind === 'range') {
        return {
          field,
          bounds: value.bounds.map((b) => [search.slice(b.span.start, b.span.end), b.quoted]),
          lowerInclusive: value.lowerInclusive,
          upperInclusive: value.upperInclusive,
        };
      }
      const text = search.slice(value.span.start, value.span.end);
      return value.kind === 'term'
        ? { field, kind: value.kind, text, quoted: value.quoted }
        : { field, kind: value.kind, text };
    });

  it('reports a bare term value with its offsets', () => {
    expect(scanFieldClauses('update_date:20261120')).toEqual([
      {
        field: 'update_date',
        value: { kind: 'term', quoted: false, span: { start: 12, end: 20 } },
      },
    ]);
  });

  it('reports a quoted value by the characters between its quotes', () => {
    expect(scanFieldClauses('update_date:"2026-11-20"')).toEqual([
      { field: 'update_date', value: { kind: 'term', quoted: true, span: { start: 13, end: 23 } } },
    ]);
  });

  it('reports each range bound with its offsets, TO left out', () => {
    expect(scanFieldClauses('d:[20260101 TO 20261231]')).toEqual([
      {
        field: 'd',
        value: {
          kind: 'range',
          bounds: [
            { quoted: false, span: { start: 3, end: 11 } },
            { quoted: false, span: { start: 15, end: 23 } },
          ],
          lowerInclusive: true,
          upperInclusive: true,
        },
      },
    ]);
  });

  it.each([
    [
      'an exclusive range',
      'd:{1 TO 9}',
      [
        ['1', false],
        ['9', false],
      ],
      false,
      false,
    ],
    [
      'a half-open range',
      'd:[1 TO 9}',
      [
        ['1', false],
        ['9', false],
      ],
      true,
      false,
    ],
    [
      'quoted bounds',
      'd:["2026-01-01" TO "2026 12 31"]',
      [
        ['2026-01-01', true],
        ['2026 12 31', true],
      ],
      true,
      true,
    ],
    [
      'an open upper bound',
      'd:[20260101 TO *]',
      [
        ['20260101', false],
        ['*', false],
      ],
      true,
      true,
    ],
    [
      'a range without TO',
      'd:[1 9]',
      [
        ['1', false],
        ['9', false],
      ],
      true,
      true,
    ],
    [
      'extra spaces inside',
      'd:[  1   TO   9  ]',
      [
        ['1', false],
        ['9', false],
      ],
      true,
      true,
    ],
    [
      'an escaped closer inside a bound',
      'd:[a\\]b TO c]',
      [
        ['a\\]b', false],
        ['c', false],
      ],
      true,
      true,
    ],
    [
      'an unclosed range',
      'd:[1 TO 9',
      [
        ['1', false],
        ['9', false],
      ],
      true,
      true,
    ],
    [
      'an unclosed quoted bound',
      'd:["1 TO 9]',
      [
        ['"1', false],
        ['9', false],
      ],
      true,
      true,
    ],
  ] as const)('reads %s', (_label, search, bounds, lowerInclusive, upperInclusive) => {
    expect(spanned(search, scanFieldClauses(search))).toEqual([
      { field: 'd', bounds, lowerInclusive, upperInclusive },
    ]);
  });

  it('lists clauses in source order across nested groups, values as written', () => {
    const search =
      'a.b:"x \\" y" AND (c:[1 TO 2] OR (d.exact:e* AND NOT f:/g.h/)) AND _exists_:i.j';
    expect(spanned(search, scanFieldClauses(search))).toEqual([
      { field: 'a.b', kind: 'term', text: 'x \\" y', quoted: true },
      {
        field: 'c',
        bounds: [
          ['1', false],
          ['2', false],
        ],
        lowerInclusive: true,
        upperInclusive: true,
      },
      { field: 'd.exact', kind: 'term', text: 'e*', quoted: false },
      { field: 'f', kind: 'regexp', text: 'g.h' },
      { field: '_exists_', kind: 'term', text: 'i.j', quoted: false },
    ]);
  });

  it('reports a field group as one clause spanning its contents, explicit fields inside listed', () => {
    const search = 'update_date:(20260101 OR b:"c") AND e:f';
    expect(spanned(search, scanFieldClauses(search))).toEqual([
      { field: 'update_date', kind: 'group', text: '20260101 OR b:"c"' },
      { field: 'b', kind: 'term', text: 'c', quoted: true },
      { field: 'e', kind: 'term', text: 'f', quoted: false },
    ]);
  });

  it('runs an unclosed field group and an unclosed phrase to the end of the string', () => {
    const search = 'a:(x AND b:"y z';
    expect(spanned(search, scanFieldClauses(search))).toEqual([
      { field: 'a', kind: 'group', text: 'x AND b:"y z' },
      { field: 'b', kind: 'term', text: 'y z', quoted: true },
    ]);
  });

  it('finds nothing in a string without field clauses', () => {
    expect(scanFieldClauses('aspirin "two words" [1 TO 2] (x OR y)')).toEqual([]);
  });

  // The consumer's use: rewrite values in place from the spans, right to left.
  it('supports rewriting every value in place, right to left', () => {
    const search = 'd:20260101 AND (d:"20260102" OR d:[20260103 TO 20260104}) AND e:20260105';
    const edits: { span: { start: number; end: number }; text: string }[] = [];
    for (const { field, value } of scanFieldClauses(search)) {
      if (field !== 'd') continue;
      const spans = value.kind === 'range' ? value.bounds.map((b) => b.span) : [];
      if (value.kind === 'term') spans.push(value.span);
      for (const span of spans) {
        const v = search.slice(span.start, span.end);
        edits.push({ span, text: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` });
      }
    }
    let out = search;
    for (const { span, text } of edits.sort((x, y) => y.span.start - x.span.start)) {
      out = out.slice(0, span.start) + text + out.slice(span.end);
    }
    expect(out).toBe(
      'd:2026-01-01 AND (d:"2026-01-02" OR d:[2026-01-03 TO 2026-01-04}) AND e:20260105',
    );
  });
});

describe('findConjoinedArrayClauses', () => {
  const tied = (search: string, arrays: readonly string[] = ANIMAL) =>
    findConjoinedArrayClauses(search, arrays).map(({ array, fields }) => [array, fields]);

  it.each([
    [
      'three AND-ed clauses on one array (Drugs@FDA new molecular entities)',
      'drug/drugsfda',
      'submissions.submission_type:"ORIG" AND submissions.submission_class_code:"TYPE 1" AND submissions.submission_status_date:[20260101 TO 20261231]',
      'submissions',
      [
        'submissions.submission_type',
        'submissions.submission_class_code',
        'submissions.submission_status_date',
      ],
    ],
    [
      'the suspect-drug pair on drug/event',
      'drug/event',
      'patient.drug.medicinalproduct:"aspirin" AND patient.drug.drugcharacterization:"1" AND receivedate:[20250101 TO 20250102]',
      'patient.drug',
      ['patient.drug.medicinalproduct', 'patient.drug.drugcharacterization'],
    ],
    [
      'a NOT clause beside a positive one',
      'drug/drugsfda',
      'submissions.submission_type:"ORIG" AND NOT submissions.review_priority:"PRIORITY"',
      'submissions',
      ['submissions.submission_type', 'submissions.review_priority'],
    ],
    [
      'a - clause beside a positive one, with no operator between',
      'animalandveterinary/event',
      'drug.route:"Oral" -drug.dosage_form:"Tablet"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'a ! clause after AND',
      'animalandveterinary/event',
      'drug.route:"Oral" AND !drug.dosage_form:"Tablet"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'two +required clauses side by side',
      'drug/drugsfda',
      '+submissions.submission_type:"ORIG" +submissions.review_priority:"PRIORITY"',
      'submissions',
      ['submissions.submission_type', 'submissions.review_priority'],
    ],
    [
      'two +required clauses beside an optional one',
      'animalandveterinary/event',
      '+drug.route:"Oral" +drug.dosage_form:"Tablet" serious_ae:"true"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'a +required clause beside a prohibited one in a group with an optional one',
      'animalandveterinary/event',
      '+drug.route:"Oral" -drug.dosage_form:"Tablet" serious_ae:"true"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      '&& as the connector',
      'animalandveterinary/event',
      'drug.route:"Oral" && drug.dosage_form:"Tablet"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'an _exists_ clause on its field',
      'animalandveterinary/event',
      '_exists_:drug.lot_number AND drug.route:"Oral"',
      'drug',
      ['drug.lot_number', 'drug.route'],
    ],
    [
      'a _missing_ clause on its field',
      'animalandveterinary/event',
      '_missing_:outcome.number_of_animals_affected AND outcome.medical_status:"Died"',
      'outcome',
      ['outcome.number_of_animals_affected', 'outcome.medical_status'],
    ],
    [
      'an .exact clause beside another field',
      'animalandveterinary/event',
      'reaction.veddra_term_name.exact:"Vomiting" AND reaction.number_of_animals_affected:[2 TO *]',
      'reaction',
      ['reaction.veddra_term_name', 'reaction.number_of_animals_affected'],
    ],
    [
      'a field group beside another field',
      'animalandveterinary/event',
      'drug.route:("Oral" OR "Topical") AND drug.dosage_form:"Tablet"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'an OR group inside the conjoined group',
      'drug/drugsfda',
      'submissions.submission_type:"ORIG" AND (submissions.review_priority:"PRIORITY" OR submissions.review_priority:"STANDARD")',
      'submissions',
      ['submissions.submission_type', 'submissions.review_priority'],
    ],
    [
      'groups nested three deep, joined by AND at the lowest common group',
      'animalandveterinary/event',
      'serious_ae:"true" AND (animal.species:"Dog" AND (drug.route:"Oral" AND (drug.dosage_form:"Tablet" OR drug.dosage_form:"Chewable")))',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'a pair split across sibling groups joined by AND',
      'animalandveterinary/event',
      '(drug.route:"Oral" OR animal.species:"Dog") AND (drug.dosage_form:"Tablet" OR animal.species:"Cat")',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'a nested array beside its parent array',
      'animalandveterinary/event',
      'drug.active_ingredients.name:"Fluralaner" AND drug.route:"Oral"',
      'drug',
      ['drug.active_ingredients.name', 'drug.route'],
    ],
    [
      'two fields of a nested array, two levels down',
      'drug/drugsfda',
      'products.active_ingredients.name:"IBUPROFEN" AND products.active_ingredients.strength:"200MG"',
      'products',
      ['products.active_ingredients.name', 'products.active_ingredients.strength'],
    ],
    [
      'a negated group of two fields',
      'animalandveterinary/event',
      'NOT (drug.route:"Oral" AND drug.dosage_form:"Tablet")',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    /**
     * Lucene's classic parser, OR by default, reads `a AND b OR c` as `+a +b c`
     * and `c OR a AND b` as `c +a +b`: the AND pair is required on every match
     * and the OR-joined clause is optional beside it. openFDA answers
     * `drug.route:"Oral" AND drug.dosage_form:"Tablet" OR serious_ae:"true"` with
     * the pair's own total (215,778), not the grouped `(… AND …) OR …` (519,432).
     */
    [
      'an AND pair an OR-joined clause follows',
      'animalandveterinary/event',
      'drug.route:"Oral" AND drug.dosage_form:"Tablet" OR serious_ae:"true"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'an AND pair an OR-joined clause precedes',
      'animalandveterinary/event',
      'serious_ae:"true" OR drug.route:"Oral" AND drug.dosage_form:"Tablet"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
    [
      'an AND pair beside an optional clause with no operator between',
      'animalandveterinary/event',
      'drug.route:"Oral" AND drug.dosage_form:"Tablet" serious_ae:"true"',
      'drug',
      ['drug.route', 'drug.dosage_form'],
    ],
  ] as const)('fires on %s', (_label, endpoint, search, array, fields) => {
    expect(tied(search, arraysOf(endpoint))).toEqual([[array, fields]]);
  });

  it('reports each array that holds a pair, in the order the arrays are listed', () => {
    expect(
      tied(
        'reaction.veddra_term_name:"Vomiting" AND reaction.accuracy:"Probable" AND drug.route:"Oral" AND drug.dosage_form:"Tablet"',
      ),
    ).toEqual([
      ['drug', ['drug.route', 'drug.dosage_form']],
      ['reaction', ['reaction.veddra_term_name', 'reaction.accuracy']],
    ]);
  });

  it.each([
    [
      'the same field twice',
      'reaction.veddra_term_name:"Vomiting" AND reaction.veddra_term_name:"Diarrhea"',
    ],
    [
      'one field with and without .exact',
      'reaction.veddra_term_name.exact:"Vomiting" AND reaction.veddra_term_name:"vomiting"',
    ],
    ['OR-joined clauses', 'drug.route:"Oral" OR drug.dosage_form:"Tablet"'],
    ['||-joined clauses', 'drug.route:"Oral" || drug.dosage_form:"Tablet"'],
    ['clauses with no operator between', 'drug.route:"Oral" drug.dosage_form:"Tablet"'],
    ['one +required clause beside an optional one', '+drug.route:"Oral" drug.dosage_form:"Tablet"'],
    [
      'an array clause AND-ed to a clause outside it, beside an optional array clause',
      'drug.route:"Oral" AND serious_ae:"true" OR drug.dosage_form:"Tablet"',
    ],
    [
      'clauses under different arrays',
      'drug.route:"Oral" AND reaction.veddra_term_name:"Vomiting"',
    ],
    ['an array clause beside a top-level field', 'drug.route:"Oral" AND serious_ae:"true"'],
    ['an array clause beside a plain object field', 'drug.route:"Oral" AND animal.species:"Dog"'],
    ['two negated clauses', 'NOT drug.route:"Oral" AND NOT drug.dosage_form:"Tablet"'],
    ['two - clauses', '-drug.route:"Oral" -drug.dosage_form:"Tablet"'],
    ['a clause on the array itself', '_exists_:drug AND drug.route:"Oral"'],
    [
      'a pair in sibling groups joined by OR',
      '(drug.route:"Oral" AND serious_ae:"true") OR (drug.dosage_form:"Tablet" AND serious_ae:"false")',
    ],
    [
      'a pair whose lowest common group, three deep, is joined by OR',
      'serious_ae:"true" AND (drug.route:"Oral" OR (animal.species:"Dog" AND (drug.dosage_form:"Tablet")))',
    ],
    ['bare terms', 'Oral AND Tablet'],
    ['a field: inside a phrase', 'drug.route:"drug.dosage_form:Tablet"'],
  ] as const)('stays silent on %s', (_label, search) => {
    expect(tied(search)).toEqual([]);
  });

  it('stays silent where the endpoint has no arrays of objects', () => {
    expect(
      tied('openfda.brand_name:"x" AND openfda.generic_name:"y"', arraysOf('drug/label')),
    ).toEqual([]);
  });

  it('reads patient.drug and patient.reaction as different arrays under one object', () => {
    expect(
      tied(
        'patient.drug.medicinalproduct:"aspirin" AND patient.reaction.reactionmeddrapt:"nausea"',
        arraysOf('drug/event'),
      ),
    ).toEqual([]);
  });

  /**
   * Every example search in the 0.10.0 tool descriptions (each tool's `search`
   * description, and `openfda_count_values`'s), with its endpoint.
   */
  const DESCRIPTION_EXAMPLES: [string, string][] = [
    ['drug/event', 'patient.drug.medicinalproduct:"aspirin"'],
    ['drug/event', 'patient.reaction.reactionmeddrapt:"nausea" AND serious:"1"'],
    ['animalandveterinary/event', 'animal.species:"Dog"'],
    ['animalandveterinary/event', 'drug.active_ingredients.name:"Fluralaner"'],
    ['animalandveterinary/event', 'reaction.veddra_term_name:"Vomiting"'],
    ['animalandveterinary/event', 'serious_ae:"true"'],
    ['drug/shortages', 'status:"Current"'],
    ['drug/shortages', 'therapeutic_category:"Oncology"'],
    ['drug/shortages', 'generic_name:"carboplatin"'],
    ['drug/shortages', 'company_name:"pfizer"'],
    ['drug/enforcement', 'classification:"Class I"'],
    ['drug/enforcement', 'recalling_firm:"pfizer"'],
    ['drug/enforcement', 'reason_for_recall:"undeclared allergen"'],
    ['tobacco/problem', 'tobacco_products:"Electronic cigarette"'],
    ['tobacco/problem', 'reported_health_problems:"Seizure"'],
    ['tobacco/problem', 'nonuser_affected:"Yes"'],
    ['drug/event', 'patient.drug.medicinalproduct:"metformin"'],
    ['drug/label', 'openfda.brand_name:"aspirin"'],
    ['drug/label', 'openfda.generic_name:"metformin"'],
    ['drug/label', 'openfda.manufacturer_name:"pfizer"'],
    ['drug/drugsfda', 'products.brand_name:"eliquis"'],
    ['drug/drugsfda', 'sponsor_name:"PFIZER"'],
    [
      'drug/drugsfda',
      'submissions.submission_type:"ORIG" AND submissions.review_priority:"PRIORITY"',
    ],
    ['device/510k', 'applicant:"medtronic"'],
    ['device/510k', 'advisory_committee_description:"cardiovascular"'],
    ['device/510k', 'product_code:"DXN"'],
    ['device/510k', 'openfda.device_name:"catheter"'],
    ['drug/ndc', 'product_ndc:"0363-0218"'],
    ['drug/ndc', 'brand_name:"aspirin"'],
    ['drug/ndc', 'generic_name:"metformin"'],
    ['drug/ndc', 'labeler_name:"walgreen"'],
    ['drug/ndc', 'active_ingredients.name:"ASPIRIN"'],
  ];

  it('fires on one of the 32 description examples: the approvals example', () => {
    expect(DESCRIPTION_EXAMPLES).toHaveLength(32);
    const firing = DESCRIPTION_EXAMPLES.filter(
      ([endpoint, search]) => findConjoinedArrayClauses(search, arraysOf(endpoint)).length > 0,
    ).map(([, search]) => search);
    expect(firing).toEqual([
      'submissions.submission_type:"ORIG" AND submissions.review_priority:"PRIORITY"',
    ]);
  });
});

describe('findConjoinedArrayClauses filter', () => {
  const filterOf = (search: string, arrays: readonly string[] = ANIMAL) => {
    const [first, ...rest] = findConjoinedArrayClauses(search, arrays);
    expect(rest).toEqual([]);
    return first?.filter;
  };
  const OVER_DRUG = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '["json"]')) AS d) WHERE`;
  const OVER_INGREDIENT = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(d->'active_ingredients', '["json"]')) AS a) WHERE`;

  // The staged set's own count: 52 of the 367 records (in-process DuckDB canvas, the read-only gate included).
  it('ties the Drugs@FDA new-molecular-entity clauses in one EXISTS over the submissions column', () => {
    expect(
      filterOf(
        'submissions.submission_type:"ORIG" AND submissions.submission_class_code:"TYPE 1" AND submissions.submission_status_date:[20260101 TO 20261231]',
        arraysOf('drug/drugsfda'),
      ),
    ).toBe(
      `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.submissions, '["json"]')) AS s) WHERE s->>'submission_type' ILIKE '%ORIG%' AND s->>'submission_class_code' ILIKE '%TYPE 1%' AND (TRY_CAST(s->>'submission_status_date' AS DOUBLE) >= 20260101 AND TRY_CAST(s->>'submission_status_date' AS DOUBLE) <= 20261231))`,
    );
  });

  it('reads an array under an object column through json_extract', () => {
    expect(
      filterOf(
        'patient.drug.medicinalproduct:"aspirin" AND patient.drug.drugcharacterization:"1"',
        arraysOf('drug/event'),
      ),
    ).toBe(
      `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(json_extract(t.patient, '$.drug'), '["json"]')) AS d) WHERE d->>'medicinalproduct' ILIKE '%aspirin%' AND d->>'drugcharacterization' ILIKE '%1%')`,
    );
  });

  it('nests one EXISTS per nested array level, the nested pair tied inside it', () => {
    expect(
      filterOf(
        'products.active_ingredients.name:"IBUPROFEN" AND products.active_ingredients.strength:"200MG"',
        arraysOf('drug/drugsfda'),
      ),
    ).toBe(
      `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.products, '["json"]')) AS p) WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(p->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%IBUPROFEN%' AND a->>'strength' ILIKE '%200MG%'))`,
    );
  });

  it('puts a parent-array clause beside the nested EXISTS', () => {
    expect(filterOf('drug.active_ingredients.name:"Fluralaner" AND drug.route:"Oral"')).toBe(
      `${OVER_DRUG} d->>'route' ILIKE '%Oral%' AND ${OVER_INGREDIENT} a->>'name' ILIKE '%Fluralaner%'))`,
    );
  });

  it('gives one nested EXISTS to each value of a field named twice', () => {
    expect(
      filterOf(
        'drug.route:"Oral" AND drug.active_ingredients.name:"Fluralaner" AND drug.active_ingredients.name:"Moxidectin"',
      ),
    ).toBe(
      `${OVER_DRUG} d->>'route' ILIKE '%Oral%' AND ${OVER_INGREDIENT} a->>'name' ILIKE '%Fluralaner%') AND ${OVER_INGREDIENT} a->>'name' ILIKE '%Moxidectin%'))`,
    );
  });

  it('nests three array levels down, tying each pair at its own level', () => {
    expect(filterOf('a.b.c.x:1 AND a.b.c.y:2 AND a.b.w:3', ['a', 'a.b', 'a.b.c'])).toBe(
      `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.a, '["json"]')) AS a) WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(a->'b', '["json"]')) AS b) WHERE b->>'w' ILIKE '%3%' AND EXISTS (SELECT 1 FROM (SELECT unnest(from_json(b->'c', '["json"]')) AS c) WHERE c->>'x' ILIKE '%1%' AND c->>'y' ILIKE '%2%')))`,
    );
  });

  it.each([
    [
      'a NOT clause',
      'drug.route:"Oral" AND NOT drug.dosage_form:"Tablet"',
      `d->>'route' ILIKE '%Oral%' AND NOT (d->>'dosage_form' ILIKE '%Tablet%')`,
    ],
    [
      'an OR group',
      'drug.route:"Oral" AND (drug.dosage_form:"Tablet" OR drug.dosage_form:"Chewable")',
      `d->>'route' ILIKE '%Oral%' AND (d->>'dosage_form' ILIKE '%Tablet%' OR d->>'dosage_form' ILIKE '%Chewable%')`,
    ],
    [
      'a field group',
      'drug.route:("Oral" OR Topical) AND drug.dosage_form:"Tablet"',
      `(d->>'route' ILIKE '%Oral%' OR d->>'route' ILIKE '%Topical%') AND d->>'dosage_form' ILIKE '%Tablet%'`,
    ],
    [
      'an .exact clause, case-sensitive',
      'drug.route.exact:"Oral" AND drug.dosage_form:"Tablet"',
      `d->>'route' LIKE '%Oral%' AND d->>'dosage_form' ILIKE '%Tablet%'`,
    ],
    [
      '_exists_ and _missing_',
      '_exists_:drug.lot_number AND _missing_:drug.route',
      `d->>'lot_number' IS NOT NULL AND d->>'route' IS NULL`,
    ],
    [
      'an exclusive numeric range and an open one',
      'drug.number_of_defective_items:{1 TO 9} AND drug.first_exposure_date:[20250101 TO *]',
      `(TRY_CAST(d->>'number_of_defective_items' AS DOUBLE) > 1 AND TRY_CAST(d->>'number_of_defective_items' AS DOUBLE) < 9) AND TRY_CAST(d->>'first_exposure_date' AS DOUBLE) >= 20250101`,
    ],
    [
      'wildcards in a bare term',
      'drug.route:Or*l? AND drug.dosage_form:"Tablet"',
      `d->>'route' ILIKE '%Or%l_%' AND d->>'dosage_form' ILIKE '%Tablet%'`,
    ],
    [
      'escapes, a quote, and an apostrophe in values',
      `drug.route:"O\\"ral's" AND drug.dosage_form:Tab\\*let`,
      `d->>'route' ILIKE '%O"ral''s%' AND d->>'dosage_form' ILIKE '%Tab*let%'`,
    ],
    [
      'an object path inside the element',
      'drug.manufacturer.registration_number:"USA-1" AND drug.route:"Oral"',
      `d->'manufacturer'->>'registration_number' ILIKE '%USA-1%' AND d->>'route' ILIKE '%Oral%'`,
    ],
    [
      'a top-level clause, which the staged rows already meet',
      'serious_ae:"true" AND drug.route:"Oral" AND drug.dosage_form:"Tablet"',
      `d->>'route' ILIKE '%Oral%' AND d->>'dosage_form' ILIKE '%Tablet%'`,
    ],
    [
      'clauses it cannot state per element: a regular expression and a date-math range',
      'drug.route:/Or.l/ AND drug.first_exposure_date:[now-30d TO now] AND drug.dosage_form:"Tablet"',
      `d->>'dosage_form' ILIKE '%Tablet%'`,
    ],
    [
      'an OR with a clause outside the array, left unstated',
      'drug.route:"Oral" AND (drug.dosage_form:"Tablet" OR serious_ae:"true")',
      `d->>'route' ILIKE '%Oral%'`,
    ],
    [
      '- beside a lone positive clause',
      'drug.route:"Oral" -drug.dosage_form:"Tablet"',
      `NOT (d->>'dosage_form' ILIKE '%Tablet%') AND d->>'route' ILIKE '%Oral%'`,
    ],
  ] as const)('states %s', (_label, search, condition) => {
    expect(filterOf(search)).toBe(`${OVER_DRUG} ${condition})`);
  });

  it('never prints the lateral unnest form the read-only gate refuses', () => {
    for (const [endpoint, arrays] of Object.entries(ARRAYS)) {
      const pair = arrays.map((array) => `${array}.x:1 AND ${array}.y:2`).join(' AND ');
      for (const { filter } of findConjoinedArrayClauses(pair, arrays)) {
        expect(filter, endpoint).not.toMatch(/FROM\s+unnest/);
        expect(filter, endpoint).toMatch(/^EXISTS \(SELECT 1 FROM \(SELECT unnest\(from_json\(/);
      }
    }
  });
});

/**
 * An array holding one entry per record cannot split clauses on its own fields:
 * every Orange Book record carries exactly one `products` entry (all 48,990,
 * read 2026-11-22), while the ingredients under it can be several. The same
 * three searches run against a `products` array that holds many entries, as on
 * Drugs@FDA, and against the Orange Book's, marked single-entry.
 */
describe('arrays holding one entry per record', () => {
  const ORANGE_BOOK = ['products', 'products.active_ingredients', 'patents', 'exclusivity'];
  const ONE_PRODUCT = ['products'];
  const DIRECT = 'products.application_number:"210274" AND products.application_type:"N"';
  const NESTED =
    'products.active_ingredients.name:"AMLODIPINE BESYLATE" AND products.active_ingredients.strength:"10MG"';
  const BOTH = `products.application_number:"210274" AND ${NESTED}`;

  const OVER_PRODUCTS = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.products, '["json"]')) AS p) WHERE`;
  const INGREDIENT_TIE = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(p->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%AMLODIPINE BESYLATE%' AND a->>'strength' ILIKE '%10MG%')`;
  const DIRECT_FILTER = `${OVER_PRODUCTS} p->>'application_number' ILIKE '%210274%' AND p->>'application_type' ILIKE '%N%')`;
  const NESTED_FILTER = `${OVER_PRODUCTS} ${INGREDIENT_TIE})`;
  const BOTH_FILTER = `${OVER_PRODUCTS} p->>'application_number' ILIKE '%210274%' AND ${INGREDIENT_TIE})`;
  const sentence = (fields: string, array: string, filter: string) =>
    `openFDA matches each clause against the whole record, so the clauses on ${fields} can be met by different \`${array}\` entries. For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${filter}\`.`;

  // Characterization: what every caller that marks no array single-entry gets.
  describe('on an array holding many entries', () => {
    it.each([
      [
        'a pair of its own fields',
        DIRECT,
        ['products.application_number', 'products.application_type'],
        DIRECT_FILTER,
        sentence(
          '`products.application_number` and `products.application_type`',
          'products',
          DIRECT_FILTER,
        ),
      ],
      [
        'a pair of fields of its nested array',
        NESTED,
        ['products.active_ingredients.name', 'products.active_ingredients.strength'],
        NESTED_FILTER,
        sentence(
          '`products.active_ingredients.name` and `products.active_ingredients.strength`',
          'products',
          NESTED_FILTER,
        ),
      ],
      [
        'one of its own fields beside a nested pair',
        BOTH,
        [
          'products.application_number',
          'products.active_ingredients.name',
          'products.active_ingredients.strength',
        ],
        BOTH_FILTER,
        sentence(
          '`products.application_number`, `products.active_ingredients.name`, and `products.active_ingredients.strength`',
          'products',
          BOTH_FILTER,
        ),
      ],
    ] as const)('names the array itself on %s', (_label, search, fields, filter, notice) => {
      expect(findConjoinedArrayClauses(search, ORANGE_BOOK)).toEqual([
        { array: 'products', fields, filter },
      ]);
      expect(arrayTieNotice(search, 2, ORANGE_BOOK, { kind: 'restage' })).toBe(notice);
    });
  });

  describe('on an array holding one entry per record', () => {
    it('stays silent on a pair of its own fields', () => {
      expect(findConjoinedArrayClauses(DIRECT, ORANGE_BOOK, ONE_PRODUCT)).toEqual([]);
      expect(
        arrayTieNotice(DIRECT, 2, ORANGE_BOOK, { kind: 'restage' }, ONE_PRODUCT),
      ).toBeUndefined();
    });

    it('names the nested array for a pair of its fields, unnesting from the top column as before', () => {
      expect(findConjoinedArrayClauses(NESTED, ORANGE_BOOK, ONE_PRODUCT)).toEqual([
        {
          array: 'products.active_ingredients',
          fields: ['products.active_ingredients.name', 'products.active_ingredients.strength'],
          filter: NESTED_FILTER,
        },
      ]);
      expect(arrayTieNotice(NESTED, 2, ORANGE_BOOK, { kind: 'restage' }, ONE_PRODUCT)).toBe(
        sentence(
          '`products.active_ingredients.name` and `products.active_ingredients.strength`',
          'products.active_ingredients',
          NESTED_FILTER,
        ),
      );
    });

    /*
     * The filter ties all three, as on a many-entry array: the one product's
     * application number holds per entry exactly when it holds per record, so
     * stating it inside the products EXISTS keeps the same staged rows, and the
     * SQL a caller copies is the one the staged-table tests run.
     */
    it('names the nested array beside one of its own fields, the filter tying all three', () => {
      expect(findConjoinedArrayClauses(BOTH, ORANGE_BOOK, ONE_PRODUCT)).toEqual([
        {
          array: 'products.active_ingredients',
          fields: ['products.active_ingredients.name', 'products.active_ingredients.strength'],
          filter: BOTH_FILTER,
        },
      ]);
      expect(
        arrayTieNotice(
          BOTH,
          2,
          ORANGE_BOOK,
          { kind: 'staged', table: 'spilled_ab12' },
          ONE_PRODUCT,
        ),
      ).toBe(
        `openFDA matches each clause against the whole record, so the clauses on \`products.active_ingredients.name\` and \`products.active_ingredients.strength\` can be met by different \`products.active_ingredients\` entries. For one entry meeting them together, query the staged table in openfda_dataframe_query: \`SELECT * FROM spilled_ab12 t WHERE ${BOTH_FILTER}\`.`,
      );
    });

    it('still ties the other arrays of the endpoint', () => {
      const search = `${DIRECT} AND patents.patent_number:"6967208" AND patents.patent_use_code:"U-1729"`;
      expect(
        findConjoinedArrayClauses(search, ORANGE_BOOK, ONE_PRODUCT).map(({ array, fields }) => [
          array,
          fields,
        ]),
      ).toEqual([['patents', ['patents.patent_number', 'patents.patent_use_code']]]);
    });

    it('gives each nested array under it its own sentence', () => {
      const arrays = ['a', 'a.b', 'a.c'];
      const search = '(a.b.x:1 AND a.b.y:2) AND (a.c.x:1 AND a.c.y:2) AND a.z:3';
      expect(
        findConjoinedArrayClauses(search, arrays, ['a']).map(({ array, fields }) => [
          array,
          fields,
        ]),
      ).toEqual([
        ['a.b', ['a.b.x', 'a.b.y']],
        ['a.c', ['a.c.x', 'a.c.y']],
      ]);
      expect(findConjoinedArrayClauses(search, arrays).map(({ array }) => array)).toEqual(['a']);
    });
  });
});

describe('arrayTieNotice', () => {
  const SEARCH = 'drug.active_ingredients.name:"Fluralaner" AND drug.route:"Oral"';
  const FILTER = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '["json"]')) AS d) WHERE d->>'route' ILIKE '%Oral%' AND EXISTS (SELECT 1 FROM (SELECT unnest(from_json(d->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%Fluralaner%'))`;
  const LEAD =
    'openFDA matches each clause against the whole record, so the clauses on `drug.active_ingredients.name` and `drug.route` can be met by different `drug` entries.';

  it('sends an inline page back to stage the search', () => {
    expect(arrayTieNotice(SEARCH, 3, ANIMAL, { kind: 'restage' })).toBe(
      `${LEAD} For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`,
    );
  });

  it('names the staged table on a staged call', () => {
    expect(arrayTieNotice(SEARCH, 3, ANIMAL, { kind: 'staged', table: 'spilled_ab12' })).toBe(
      `${LEAD} For one entry meeting them together, query the staged table in openfda_dataframe_query: \`SELECT * FROM spilled_ab12 t WHERE ${FILTER}\`.`,
    );
  });

  it('names the endpoint search tool for a count', () => {
    expect(
      arrayTieNotice(SEARCH, 3, ANIMAL, {
        kind: 'search_tool',
        tool: 'openfda_search_animal_events',
      }),
    ).toBe(
      `${LEAD} For one entry meeting them together, stage this search with openfda_search_animal_events (stage: true) and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`,
    );
  });

  it('names the input that selects the endpoint on the search tool for a count', () => {
    const products = 'products.name_brand:"x" AND products.role:"SUSPECT"';
    const notice = arrayTieNotice(products, 3, ['products'], {
      kind: 'search_tool',
      tool: 'openfda_search_adverse_events',
      selector: 'category: "cosmetic"',
    });
    expect(notice).toContain(
      'For one entry meeting them together, stage this search with openfda_search_adverse_events (category: "cosmetic", stage: true) and query the staged table, aliased t, in openfda_dataframe_query: `WHERE EXISTS (',
    );
  });

  it('tells a page read by cursor to drop the cursor when it stages', () => {
    expect(arrayTieNotice(SEARCH, 3, ANIMAL, { kind: 'restage', byCursor: true })).toBe(
      `${LEAD} For one entry meeting them together, call again without cursor and with stage: true, and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${FILTER}\`.`,
    );
    expect(arrayTieNotice(SEARCH, 3, ANIMAL, { kind: 'restage', byCursor: false })).toBe(
      arrayTieNotice(SEARCH, 3, ANIMAL, { kind: 'restage' }),
    );
  });

  it('lists three or more fields with commas', () => {
    expect(
      arrayTieNotice(
        'drug.route:"Oral" AND drug.dosage_form:"Tablet" AND drug.lot_number:"A1"',
        1,
        ANIMAL,
        { kind: 'restage' },
      ),
    ).toContain(
      'the clauses on `drug.route`, `drug.dosage_form`, and `drug.lot_number` can be met by different `drug` entries.',
    );
  });

  it('gives each array its own sentences', () => {
    const notice = arrayTieNotice(
      'drug.route:"Oral" AND drug.dosage_form:"Tablet" AND reaction.veddra_term_name:"Vomiting" AND reaction.accuracy:"Probable"',
      1,
      ANIMAL,
      { kind: 'restage' },
    );
    expect(notice?.match(/openFDA matches each clause/g)).toHaveLength(2);
    expect(notice).toContain('different `drug` entries');
    expect(notice).toContain('different `reaction` entries');
  });

  it('sizes the SQL code span past a backtick in a caller value', () => {
    const notice = arrayTieNotice('drug.route:"a`b" AND drug.dosage_form:"c"', 1, ANIMAL, {
      kind: 'restage',
    });
    expect(notice).toContain(
      "``WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.drug, '[\"json\"]')) AS d) WHERE d->>'route' ILIKE '%a`b%'",
    );
  });

  it.each([
    ['a total of 0', SEARCH, 0],
    ['no search', undefined, 3],
    ['a search with no conjoined pair', 'drug.route:"Oral" OR drug.dosage_form:"Tablet"', 3],
  ] as const)('says nothing for %s', (_label, search, total) => {
    expect(arrayTieNotice(search, total, ANIMAL, { kind: 'restage' })).toBeUndefined();
  });
});

/*
 * The scanner walks caller-sized text: each shape is timed from 5k characters,
 * doubling to 320k, with the absolute bound checked at every size and the
 * full-span ratio checked at the end, on this thread's CPU time.
 */
describe('search clause scanner timing', { timeout: 300_000 }, () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: [string, (n: number) => string][] = [
    ['a run of unclosed openers', (n) => '('.repeat(n)],
    ['groups nested and closed', (n) => `${'('.repeat(n / 8)}a:b${')'.repeat(n / 8)}`],
    ['a run of field-group openers', (n) => 'a:('.repeat(n / 3)],
    ['many short clauses', (n) => 'a.b:c '.repeat(n / 6)],
    ['many short clauses joined by AND', (n) => 'a:b AND '.repeat(n / 8)],
    ['a term before a long whitespace run', (n) => `a${' '.repeat(n - 2)}b`],
    ['terms each before whitespace', (n) => 'a '.repeat(n / 2)],
    ['an unclosed phrase', (n) => `a:"${'x'.repeat(n - 3)}`],
    ['phrases back to back', (n) => 'a:"b"'.repeat(n / 5)],
    ['an unclosed range of quotes', (n) => `a:[${'"x '.repeat(n / 3)}`],
    ['ranges back to back', (n) => 'a:[1 TO 2]'.repeat(n / 10)],
    ['an unclosed regular expression', (n) => `a:/${'x'.repeat(n - 3)}`],
    ['repeated backslashes', (n) => '\\'.repeat(n)],
    ['stray closers', (n) => ')]}:'.repeat(n / 4)],
    ['modifiers and operators', (n) => '+-!NOT AND OR && || '.repeat(n / 20)],
    ['one long line ending in a break', (n) => `${'a:b '.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    // Clauses under one array, which the detector pairs and the filter translates.
    ['thousands of conjoined array clauses', (n) => 'drug.a:1 AND drug.b:2 AND '.repeat(n / 26)],
    [
      'thousands of array clauses on distinct fields',
      (n) => Array.from({ length: n / 16 }, (_, i) => `drug.f${i}:1 AND `).join(''),
    ],
    [
      'array clauses nested and closed',
      (n) => `${'(drug.a:1 AND '.repeat(n / 15)}drug.b:2${')'.repeat(n / 15)}`,
    ],
    ['array clauses under unclosed openers', (n) => '(drug.a:1 AND drug.b:2 '.repeat(n / 23)],
    [
      'nested-array clauses',
      (n) => 'drug.active_ingredients.name:x AND drug.route:y AND '.repeat(n / 52),
    ],
    ['OR-joined array clauses', (n) => 'drug.a:1 OR drug.b:2 OR '.repeat(n / 24)],
    ['required and prohibited array clauses', (n) => '+drug.a:1 -drug.b:2 '.repeat(n / 20)],
    ['array clauses in OR groups', (n) => '(drug.a:1 OR drug.b:2) AND '.repeat(n / 27)],
  ];
  const scanners: [string, (search: string) => unknown][] = [
    ['fieldPathsNamed', (search) => fieldPathsNamed(search)],
    ['scanFieldClauses', (search) => scanFieldClauses(search)],
    ['findConjoinedArrayClauses', (search) => findConjoinedArrayClauses(search, ANIMAL)],
    // `drug` held one per record, so its ties fall to the ingredient array under it.
    [
      'findConjoinedArrayClauses over a single-entry array',
      (search) => findConjoinedArrayClauses(search, ANIMAL, ['drug']),
    ],
    ['arrayTieNotice', (search) => arrayTieNotice(search, 1, ANIMAL, { kind: 'restage' })],
  ];

  for (const [scanner, run] of scanners) {
    it.each(shapes)(`${scanner} stays linear on %s`, (_name, build) => {
      const small = build(SIZES[0]!);
      let ratio = 0;
      for (const size of SIZES.slice(1)) {
        const { t5k, t320k: tSize } = linearTiming(run, small, build(size));
        expect(tSize, `${size} characters`).toBeLessThan(500_000);
        ratio = tSize / t5k;
      }
      expect(ratio).toBeLessThan(256);
    });
  }
});

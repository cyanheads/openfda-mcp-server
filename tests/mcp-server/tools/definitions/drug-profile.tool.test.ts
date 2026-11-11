import {
  forbidden,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

import { drugProfileTool, fanOutKeyFor } from '@/mcp-server/tools/definitions/drug-profile.tool.js';
import { pickApplication } from '@/mcp-server/tools/drug-profile-sections.js';
import { findSearchDelimiterFault } from '@/mcp-server/tools/schema-utils.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { codeLiteralsIn, renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';
import { linearTiming } from '../../../helpers/cpu-timing.js';

const mockQuery = vi.fn();

const meta = (over: Record<string, unknown> = {}) => ({
  total: 0,
  skip: 0,
  limit: 10,
  lastUpdated: '2026-01-01',
  ...over,
});

/**
 * A fully-populated upstream, keyed by endpoint + count expression. The
 * `drug/event` match total (2007) deliberately exceeds the sum of the `serious`
 * buckets (2000): seven reports carry no `serious` value, as real ones do.
 */
function fullUpstream(endpoint: string, params: { count?: string; limit?: number }) {
  if (endpoint === 'drug/label') {
    return {
      meta: meta({ total: 1 }),
      results: [
        {
          set_id: 'spl-abc-123',
          openfda: {
            brand_name: ['Glucophage', 'Glucophage XR'],
            generic_name: ['metformin hydrochloride'],
            product_ndc: ['0087-6060'],
            rxcui: ['860975'],
            spl_set_id: ['spl-abc-123'],
          },
          indications_and_usage: ['Adjunct to diet to improve glycemic control.'],
          warnings: ['Risk of lactic acidosis.'],
          dosage_and_administration: ['Start 500 mg twice daily.'],
        },
      ],
    };
  }
  if (endpoint === 'drug/event' && params.count?.startsWith('patient.reaction')) {
    return {
      meta: meta(),
      results: [
        { term: 'NAUSEA', count: 1200 },
        { term: 'DIARRHOEA', count: 900 },
      ],
    };
  }
  if (endpoint === 'drug/event' && params.count === 'serious') {
    return {
      meta: meta(),
      results: [
        { term: '1', count: 500 },
        { term: '2', count: 1500 },
      ],
    };
  }
  if (endpoint === 'drug/event' && params.count === undefined && params.limit === 0) {
    return { meta: meta({ total: 2007, limit: 0 }), results: [] };
  }
  if (endpoint === 'drug/enforcement') {
    return {
      meta: meta({ total: 1 }),
      results: [
        {
          classification: 'Class II',
          reason_for_recall: 'Failed dissolution specification.',
          recalling_firm: 'Acme Pharma',
          recall_initiation_date: '20240110',
          report_date: '20240115',
        },
      ],
    };
  }
  if (endpoint === 'drug/drugsfda') {
    return {
      meta: meta({ total: 1 }),
      results: [
        {
          application_number: 'NDA020357',
          sponsor_name: 'Bristol Myers Squibb',
          products: [{ marketing_status: 'Prescription' }],
          submissions: [{ submission_status: 'AP' }],
        },
      ],
    };
  }
  if (endpoint === 'drug/shortages') {
    return {
      meta: meta({ total: 1 }),
      results: [{ status: 'Current', availability: 'Limited supply through Q3.' }],
    };
  }
  return { meta: meta(), results: [] };
}

/*
 * #85 fixtures — records as api.fda.gov returned them on 2026-11-10, trimmed to
 * the fields the profile reads. Drugs@FDA rows are `[application_number,
 * sponsor_name, products]`, each product `[brand_name, marketing_status,
 * reference_drug, active ingredient names]`.
 */
type ProductRow = [brand: string, status: string, reference: string, ingredients: string[]];
type ApplicationRow = [applicationNumber: string, sponsor: string, products: ProductRow[]];

/** Drugs@FDA application records from compact rows. */
const applications = (rows: ApplicationRow[]) =>
  rows.map(([application_number, sponsor_name, products]) => ({
    application_number,
    sponsor_name,
    products: products.map(([brand_name, marketing_status, reference_drug, ingredients]) => ({
      brand_name,
      marketing_status,
      reference_drug,
      active_ingredients: ingredients.map((name) => ({ name })),
    })),
  }));

/** A drug/label record carrying the openfda fields identity reads. */
const labelRecord = (o: {
  set: string;
  generic: string;
  brand: string;
  manufacturer: string;
  ndc: string;
  application: string;
  original: boolean;
}) => ({
  set_id: o.set,
  openfda: {
    generic_name: [o.generic],
    brand_name: [o.brand],
    manufacturer_name: [o.manufacturer],
    product_ndc: [o.ndc],
    application_number: [o.application],
    spl_set_id: [o.set],
    // openFDA sets the flag `[true]` on an original packager's label and omits it otherwise.
    ...(o.original ? { is_original_packager: [true] } : {}),
  },
  indications_and_usage: [`Indications from the ${o.manufacturer} label.`],
});

const LABELS = {
  westminsterMetformin: labelRecord({
    set: '07b4ee2a',
    generic: 'METFORMIN HYDROCHLORIDE',
    brand: 'METFORMIN HYDROCHLORIDE',
    manufacturer: 'Westminster Pharmaceuticals, LLC',
    ndc: '69367-412',
    application: 'ANDA203832',
    original: true,
  }),
  zituvimet: labelRecord({
    set: '0098dec4',
    generic: 'SITAGLIPTIN AND METFORMIN HYDROCHLORIDE',
    brand: 'ZITUVIMET',
    manufacturer: 'Zydus Lifesciences Limited',
    ndc: '70771-1859',
    application: 'NDA216743',
    original: true,
  }),
  asMedicationMetformin: labelRecord({
    set: '011de1a5',
    generic: 'METFORMIN HYDROCHLORIDE',
    brand: 'Metformin Hydrochloride',
    manufacturer: 'A-S Medication Solutions',
    ndc: '50090-7011',
    application: 'ANDA090564',
    original: false,
  }),
  idacio: labelRecord({
    set: '08dbaffe',
    generic: 'ADALIMUMAB-AACF',
    brand: 'IDACIO',
    manufacturer: 'Fresenius Kabi USA, LLC',
    ndc: '65219-558',
    application: 'BLA761255',
    original: true,
  }),
  cyltezo: labelRecord({
    set: '115ea79b',
    generic: 'ADALIMUMAB-ADBM',
    brand: 'Cyltezo',
    manufacturer: 'Boehringer Ingelheim Pharmaceuticals, Inc.',
    ndc: '0597-0370',
    application: 'BLA761058',
    original: true,
  }),
  humiraCordavis: labelRecord({
    set: '4977567e',
    generic: 'ADALIMUMAB',
    brand: 'Humira',
    manufacturer: 'Cordavis Limited',
    ndc: '83457-124',
    application: 'BLA125057',
    original: true,
  }),
  humiraAbbvie: labelRecord({
    set: '608d4f0d',
    generic: 'ADALIMUMAB',
    brand: 'Humira',
    manufacturer: 'AbbVie Inc.',
    ndc: '0074-0124',
    application: 'BLA125057',
    original: true,
  }),
  lipitorViatris: labelRecord({
    set: 'a60cc18b',
    generic: 'ATORVASTATIN CALCIUM',
    brand: 'Lipitor',
    manufacturer: 'Viatris Specialty LLC',
    ndc: '58151-155',
    application: 'NDA020702',
    original: true,
  }),
  apixabanIndoco: labelRecord({
    set: '095a08ac',
    generic: 'APIXABAN',
    brand: 'apixaban',
    manufacturer: 'Indoco Remedies Limited',
    ndc: '14445-149',
    application: 'ANDA209898',
    original: true,
  }),
  eliquisAphena: labelRecord({
    set: '1523ab32',
    generic: 'APIXABAN',
    brand: 'ELIQUIS',
    manufacturer: 'Aphena Pharma Solutions - Tennessee, LLC',
    ndc: '71610-811',
    application: 'NDA202155',
    original: false,
  }),
};

/** Drugs@FDA matches of the selection search per input, trimmed to the contenders. */
const APPLICATION_ROWS = {
  metformin: [
    [
      'NDA021202',
      'EMD SERONO INC',
      [['GLUCOPHAGE XR', 'Discontinued', 'Yes', ['METFORMIN HYDROCHLORIDE']]],
    ],
    [
      'NDA205879',
      'JANSSEN PHARMS',
      [['INVOKAMET XR', 'Prescription', 'Yes', ['CANAGLIFLOZIN', 'METFORMIN HYDROCHLORIDE']]],
    ],
    [
      'NDA021574',
      'ANDRX LABS LLC',
      [['FORTAMET', 'Discontinued', 'Yes', ['METFORMIN HYDROCHLORIDE']]],
    ],
    ['NDA021591', 'RANBAXY', [['RIOMET', 'Discontinued', 'Yes', ['METFORMIN HYDROCHLORIDE']]]],
    [
      'NDA020357',
      'EMD SERONO INC',
      [['GLUCOPHAGE', 'Discontinued', 'Yes', ['METFORMIN HYDROCHLORIDE']]],
    ],
    [
      'NDA022044',
      'MSD SUB MERCK',
      [['JANUMET', 'Prescription', 'Yes', ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN PHOSPHATE']]],
    ],
  ],
  adalimumab: [
    ['BLA761255', 'FRESENIUS KABI USA', [['IDACIO', 'Prescription', 'No', ['ADALIMUMAB-AACF']]]],
    ['BLA761299', 'ALVOTECH USA INC', [['SIMLANDI', 'Prescription', 'No', ['ADALIMUMAB-RYVK']]]],
    ['BLA125057', 'ABBVIE INC', [['HUMIRA', 'Prescription', 'No', ['ADALIMUMAB']]]],
    ['BLA761024', 'AMGEN INC', [['AMJEVITA', 'Prescription', 'No', ['ADALIMUMAB-ATTO']]]],
    ['BLA761071', 'SANDOZ INC', [['HYRIMOZ', 'Prescription', 'No', ['ADALIMUMAB-ADAZ']]]],
  ],
  humira: [['BLA125057', 'ABBVIE INC', [['HUMIRA', 'Prescription', 'No', ['ADALIMUMAB']]]]],
  atorvastatin: [
    [
      'NDA021540',
      'PHARMACIA',
      [['CADUET', 'Prescription', 'Yes', ['AMLODIPINE BESYLATE', 'ATORVASTATIN CALCIUM']]],
    ],
    [
      'NDA200153',
      'ORGANON',
      [['LIPTRUZET', 'Discontinued', 'Yes', ['ATORVASTATIN CALCIUM', 'EZETIMIBE']]],
    ],
    ['NDA213260', 'CMP DEV LLC', [['ATORVALIQ', 'Prescription', 'Yes', ['ATORVASTATIN CALCIUM']]]],
    ['NDA020702', 'UPJOHN', [['LIPITOR', 'Prescription', 'Yes', ['ATORVASTATIN CALCIUM']]]],
  ],
  lipitor: [
    ['NDA020702', 'UPJOHN', [['LIPITOR', 'Prescription', 'Yes', ['ATORVASTATIN CALCIUM']]]],
  ],
  apixaban: [
    ['NDA221024', 'AZURITY', [['ABANTA', 'None (Tentative Approval)', 'No', ['APIXABAN']]]],
    ['NDA202155', 'BRISTOL MYERS SQUIBB', [['ELIQUIS', 'Prescription', 'Yes', ['APIXABAN']]]],
    [
      'NDA220073',
      'BRISTOL',
      [
        ['ELIQUIS', 'Prescription', 'No', ['APIXABAN']],
        ['ELIQUIS SPRINKLE', 'Prescription', 'Yes', ['APIXABAN']],
      ],
    ],
    ['NDA220446', 'LUPIN', [['APIXABAN', 'Prescription', 'No', ['APIXABAN']]]],
  ],
  eliquis: [
    ['NDA202155', 'BRISTOL MYERS SQUIBB', [['ELIQUIS', 'Prescription', 'Yes', ['APIXABAN']]]],
    [
      'NDA220073',
      'BRISTOL',
      [
        ['ELIQUIS', 'Prescription', 'No', ['APIXABAN']],
        ['ELIQUIS SPRINKLE', 'Prescription', 'Yes', ['APIXABAN']],
      ],
    ],
  ],
  insulinGlargine: [
    ['BLA210605', 'MYLAN PHARMS INC', [['SEMGLEE', 'Prescription', 'No', ['INSULIN GLARGINE']]]],
    [
      'BLA761412',
      'SUNSHINE LAKE PHARMA CO LTD',
      [['LANGLARA', 'Prescription', 'No', ['INSULIN GLARGINE-ALDY']]],
    ],
    [
      'BLA208673',
      'SANOFI-AVENTIS US',
      [['SOLIQUA 100/33', 'Prescription', 'No', ['INSULIN GLARGINE', 'LIXISENATIDE']]],
    ],
    ['BLA205692', 'ELI LILLY AND CO', [['BASAGLAR', 'Prescription', 'No', ['INSULIN GLARGINE']]]],
    [
      'BLA021081',
      'SANOFI AVENTIS US',
      [
        ['LANTUS', 'Prescription', 'No', ['INSULIN GLARGINE RECOMBINANT']],
        ['LANTUS SOLOSTAR', 'Prescription', 'No', ['INSULIN GLARGINE RECOMBINANT']],
      ],
    ],
    [
      'BLA761201',
      'MYLAN PHARMS INC',
      [['SEMGLEE', 'Prescription', 'No', ['INSULIN GLARGINE-YFGN']]],
    ],
  ],
  trastuzumab: [
    [
      'BLA761346',
      'ACCORD BIOPHARMA INC.',
      [['HERCESSI', 'Prescription', 'No', ['TRASTUZUMAB-STRF']]],
    ],
    ['BLA125427', 'GENENTECH', [['KADCYLA', 'Prescription', 'No', ['ADO-TRASTUZUMAB EMTANSINE']]]],
    ['BLA761091', 'CELLTRION INC', [['HERZUMA', 'Prescription', 'No', ['TRASTUZUMAB-PKRB']]]],
    [
      'BLA761106',
      'GENENTECH INC',
      [['HERCEPTIN HYLECTA', 'Prescription', 'No', ['TRASTUZUMAB AND HYALURONIDASE-OYSK']]],
    ],
    ['BLA103792', 'GENENTECH', [['HERCEPTIN', 'Prescription', 'No', ['TRASTUZUMAB']]]],
  ],
  warfarin: [
    [
      'NDA011771',
      'PHARM RES ASSOC',
      [
        ['ATHROMBIN', 'Discontinued', 'No', ['WARFARIN SODIUM']],
        ['ATHROMBIN-K', 'Discontinued', 'No', ['WARFARIN POTASSIUM']],
      ],
    ],
    [
      'NDA009218',
      'BRISTOL MYERS SQUIBB',
      [
        ['COUMADIN', 'Discontinued', 'No', ['WARFARIN SODIUM']],
        ['COUMADIN', 'Discontinued', 'Yes', ['WARFARIN SODIUM']],
      ],
    ],
    ['NDA017020', 'ABBOTT', [['PANWARFIN', 'Discontinued', 'No', ['WARFARIN SODIUM']]]],
  ],
  ibuprofen: [
    [
      'NDA019012',
      'KENVUE BRANDS',
      [
        ['MOTRIN IB', 'Over-the-counter', 'Yes', ['IBUPROFEN']],
        ['NUPRIN', 'Discontinued', 'No', ['IBUPROFEN']],
      ],
    ],
    [
      'NDA019771',
      'HALEON US HOLDINGS',
      [
        [
          'ADVIL COLD AND SINUS',
          'Over-the-counter',
          'Yes',
          ['IBUPROFEN', 'PSEUDOEPHEDRINE HYDROCHLORIDE'],
        ],
      ],
    ],
    ['NDA022348', 'APOTEX', [['CALDOLOR', 'Prescription', 'Yes', ['IBUPROFEN']]]],
    ['NDA017463', 'MCNEIL CONSUMER', [['MOTRIN', 'Discontinued', 'Yes', ['IBUPROFEN']]]],
    ['NDA018989', 'HALEON US HOLDINGS', [['ADVIL', 'Over-the-counter', 'Yes', ['IBUPROFEN']]]],
    [
      'NDA201803',
      'HALEON US HOLDINGS',
      [['ADVIL', 'Over-the-counter', 'Yes', ['IBUPROFEN SODIUM']]],
    ],
  ],
  sitagliptinAndMetformin: [
    [
      'ANDA216644',
      'ANNORA PHARMA PRIVATE LIMITED',
      [
        [
          'SITAGLIPTIN AND METFORMIN HYDROCHLORIDE',
          'None (Tentative Approval)',
          'No',
          ['SITAGLIPTIN, METFORMIN HYDROCHLORIDE'],
        ],
      ],
    ],
    [
      'ANDA202426',
      'APOTEX',
      [
        [
          'SITAGLIPTIN AND METFORMIN HYDROCHLORIDE',
          'Prescription',
          'No',
          ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN PHOSPHATE'],
        ],
      ],
    ],
    [
      'NDA216743',
      'ZYDUS LIFESCIENCES',
      [['ZITUVIMET', 'Prescription', 'Yes', ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN']]],
    ],
    [
      'NDA202270',
      'MSD SUB MERCK',
      [['JANUMET XR', 'Prescription', 'Yes', ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN PHOSPHATE']]],
    ],
    [
      'NDA022044',
      'MSD SUB MERCK',
      [['JANUMET', 'Prescription', 'Yes', ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN PHOSPHATE']]],
    ],
  ],
  jantoven: [
    ['ANDA040416', 'UPSHER SMITH LABS', [['JANTOVEN', 'Prescription', 'No', ['WARFARIN SODIUM']]]],
  ],
  troglitazone: [
    ['NDA020720', 'PFIZER PHARMS', [['REZULIN', 'Discontinued', 'No', ['TROGLITAZONE']]]],
    ['NDA020719', 'SANKYO', [['PRELAY', 'Discontinued', 'No', ['TROGLITAZONE']]]],
  ],
} satisfies Record<string, ApplicationRow[]>;

/** A drug/shortages record, one presentation. */
const shortageRecord = (o: {
  generic: string;
  status: string;
  company: string;
  presentation: string;
  brand: string;
  updated: string;
}) => ({
  generic_name: o.generic,
  status: o.status,
  company_name: o.company,
  presentation: o.presentation,
  update_date: o.updated,
  openfda: { brand_name: [o.brand] },
});

const hyrimoz = (presentation: string) =>
  shortageRecord({
    generic: 'Adalimumab-adaz Injection',
    status: 'To Be Discontinued',
    company: 'Sandoz Inc.',
    presentation,
    brand: 'HYRIMOZ',
    updated: '01/13/2026',
  });
const ADALIMUMAB_SHORTAGES = [
  hyrimoz('Hyrimoz, Injection, 80 mg/.8 mL (NDC 61314-454-36)'),
  hyrimoz('Hyrimoz, Injection, 40 mg/.4 mL (NDC 61314-473-64)'),
  hyrimoz('Hyrimoz, Injection, Kit (NDC 61314-531-64)'),
  hyrimoz('Hyrimoz, Injection, 80 mg/.8 mL (NDC 61314-454-68)'),
  hyrimoz('Hyrimoz, Injection, Kit (NDC 61314-517-36)'),
  shortageRecord({
    generic: 'Adalimumab-ryvk Kit',
    status: 'To Be Discontinued',
    company: 'Teva Pharmaceuticals USA, Inc.',
    presentation: 'Simlandi, Kit, Kit (NDC 51759-523-21)',
    brand: 'SIMLANDI',
    updated: '11/13/2025',
  }),
];
const mylanMetformin = (strength: string, ndc: string) =>
  shortageRecord({
    generic: 'Metformin Hydrochloride Tablet, Extended Release',
    status: 'To Be Discontinued',
    company: 'Mylan Pharmaceuticals Inc., a Viatris Company',
    presentation: `Metformin Hydrochloride, Tablet, Extended Release, ${strength} (NDC ${ndc})`,
    brand: 'METFORMIN HYDROCHLORIDE',
    updated: '10/22/2026',
  });
const METFORMIN_SHORTAGES = [
  mylanMetformin('1000 mg', '0378-6001-91'),
  mylanMetformin('500 mg', '0378-6002-91'),
];

/** What each profile sub-query answers, keyed by the search that identifies it. */
interface ProfileUpstream {
  /** The Drugs@FDA fallback for the fan-out key. */
  fallback?: { results: unknown[]; total?: number };
  /** The original-packager label search for the name. */
  flagged?: unknown[];
  ndc?: unknown[];
  /** The original-packager label search for the picked application; an Error fails it. */
  ownLabel?: unknown[] | Error;
  /** The Drugs@FDA selection for the name. */
  selection?: { results: unknown[]; total?: number };
  shortage?: { results: unknown[]; total?: number };
  /** The label search without the original-packager filter. */
  unrestricted?: unknown[];
}

/** A `query` stub answering each profile sub-query from `upstream`; events and recalls from `fullUpstream`. */
function serveProfile(upstream: ProfileUpstream) {
  const page = (results: unknown[] = [], total = results.length) => ({
    meta: meta({ total }),
    results,
  });
  return async (endpoint: string, params: { search?: string; count?: string; limit?: number }) => {
    const search = params.search ?? '';
    if (endpoint === 'drug/label') {
      if (search.startsWith('openfda.application_number:')) {
        if (upstream.ownLabel instanceof Error) throw upstream.ownLabel;
        return page(upstream.ownLabel);
      }
      return page(
        search.includes('openfda.is_original_packager:true')
          ? upstream.flagged
          : upstream.unrestricted,
      );
    }
    if (endpoint === 'drug/ndc') return page(upstream.ndc);
    if (endpoint === 'drug/drugsfda') {
      const answer = search.includes('application_number:NDA*')
        ? upstream.selection
        : upstream.fallback;
      return page(answer?.results, answer?.total);
    }
    if (endpoint === 'drug/shortages') {
      return page(upstream.shortage?.results, upstream.shortage?.total);
    }
    return fullUpstream(endpoint, params);
  };
}

/** The profile's composed searches for a typed name, as the handler sends them. */
const flaggedLabelSearch = (term: string) =>
  `(openfda.generic_name:"${term}" OR openfda.brand_name:"${term}") AND openfda.is_original_packager:true`;
const selectionSearch = (term: string) =>
  `((openfda.generic_name:"${term}" OR products.active_ingredients.name:"${term}") AND (application_number:NDA* OR application_number:BLA*)) OR (products.brand_name:"${term}" AND NOT products.active_ingredients.name:"${term}")`;
const ownLabelSearch = (application: string) =>
  `openfda.application_number:"${application}" AND openfda.is_original_packager:true`;

describe('openfda_drug_profile', () => {
  let ctx: ReturnType<typeof createMockContext<typeof drugProfileTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: drugProfileTool.errors });
  });

  it('resolves identity via drug/label and merges all sections', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
      fullUpstream(endpoint, params),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'metformin' }),
      ctx,
    );

    expect(result.meta.resolvedVia).toBe('label');
    // The typed ingredient is a word of the resolved generic, so it is the key (#82).
    expect(result.meta.fanOutKey).toBe('metformin');
    expect(result.identity.generic_name).toBe('metformin hydrochloride');
    expect(result.identity.brand_names).toContain('Glucophage');
    expect(result.identity.rxcui).toBe('860975');
    expect(result.identity.spl_set_id).toBe('spl-abc-123');
    expect(result.label?.indications).toContain('glycemic');
    // The match total, not the serious-bucket sum (2000): reports with no
    // seriousness recorded count toward total only (#63).
    expect(result.adverse_events?.total).toBe(2007);
    expect(result.adverse_events?.seriousCount).toBe(500);
    expect(result.adverse_events?.topReactions[0]).toEqual({ term: 'NAUSEA', count: 1200 });
    const text = textOf(drugProfileTool.format!(result));
    expect(text).toContain('**Total reports:** 2007 | **Serious count:** 500');
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0]!.classification).toBe('Class II');
    expect(result.recalls[0]!.date).toBe('20240110');
    expect(result.approval?.applicationNumber).toBe('NDA020357');
    expect(result.approval?.marketingStatus).toBe('Prescription');
    expect(result.shortage?.status).toBe('Current');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.sectionsFound).toBe(5);
    expect(enrichment.notice).toBeUndefined();
  });

  it('keys recalls and shortage off the resolved generic, approval and the free-text AE field off the user term', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
      fullUpstream(endpoint, params),
    );

    await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'Glucophage' }), ctx);

    const calls = mockQuery.mock.calls;
    const keyed = calls.filter(([endpoint]) =>
      ['drug/enforcement', 'drug/shortages'].includes(endpoint),
    );
    expect(keyed).toHaveLength(2);
    for (const [, params] of keyed) {
      expect(params.search).toContain('metformin hydrochloride');
      expect(params.search).not.toContain('Glucophage');
    }
    // The approval selection ranks the typed name's own matches, a brand's included (#85).
    expect(
      calls.filter(([endpoint]) => endpoint === 'drug/drugsfda').map(([, params]) => params.search),
    ).toEqual([selectionSearch('Glucophage')]);

    const events = calls.filter(([endpoint]) => endpoint === 'drug/event');
    expect(events).toHaveLength(3);
    for (const [, params] of events) {
      expect(params.search).toBe('patient.drug.medicinalproduct:"Glucophage"');
    }
    // The total is a records search for the same match, asking for no records.
    expect(events.map(([, params]) => params)).toContainEqual({
      search: 'patient.drug.medicinalproduct:"Glucophage"',
      limit: 0,
    });

    // The profile's own sorts stay in the lowercase form openFDA honours (#64).
    const sortOf = (endpoint: string) => calls.find(([e]) => e === endpoint)?.[1]?.sort;
    expect(sortOf('drug/enforcement')).toBe('report_date:desc');
    expect(sortOf('drug/shortages')).toBe('update_date:desc');
  });

  it('is best-effort: a failing sub-query nulls its section without failing the call', async () => {
    mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
      if (endpoint === 'drug/enforcement') throw new Error('boom');
      return fullUpstream(endpoint, params);
    });

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'metformin' }),
      ctx,
    );

    expect(result.recalls).toEqual([]);
    expect(result.label).not.toBeNull();
    expect(result.adverse_events).not.toBeNull();
    expect(getEnrichment(ctx).notice).toMatch(/unavailable|retry/i);
  });

  it('falls back to drug/ndc when no label matches', async () => {
    mockQuery.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'drug/ndc') {
        return {
          meta: meta({ total: 1 }),
          results: [
            {
              brand_name: 'Tylenol',
              generic_name: 'acetaminophen',
              product_ndc: '50580-449',
              openfda: { rxcui: ['198440'] },
            },
          ],
        };
      }
      return { meta: meta(), results: [] };
    });

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'Tylenol' }),
      ctx,
    );

    expect(result.meta.resolvedVia).toBe('ndc');
    expect(result.meta.fanOutKey).toBe('acetaminophen');
    expect(result.identity.generic_name).toBe('acetaminophen');
    expect(result.identity.product_ndc).toBe('50580-449');
    expect(result.identity.rxcui).toBe('198440');
    expect(result.label).toBeNull();
  });

  it('sets a notice when the drug cannot be resolved at all', async () => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'notadrug' }),
      ctx,
    );

    expect(result.meta.resolvedVia).toBe('none');
    expect(result.meta.fanOutKey).toBe('notadrug');
    expect(result.identity.generic_name).toBeNull();
    expect(result.identity.brand_names).toEqual([]);
    expect(getEnrichment(ctx).sectionsFound).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/could not resolve/i);
  });

  // #81 — the caller's drug name rides in the notice as a code literal.
  it('quotes the unresolved drug name as a code literal on both surfaces', async () => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });
    const drug = '*not*a_drug_`x`';

    const result = await runToolContract(drugProfileTool, { drug });
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toBe(
      `Could not resolve \`\` ${drug} \`\` to an FDA drug. Check the spelling, try the generic name, or query openfda_get_drug_label / openfda_lookup_ndc directly.`,
    );
    const html = renderCommonMark(textOf(result.content, result.content.length - 1));
    expect(codeLiteralsIn(html)).toEqual([drug]);
    expect(html).not.toMatch(/<em>/);
  });

  /*
   * The heading echoes the caller's drug name and the resolution line its typed
   * term (the fan-out key after #82), so both ride as code literals: a CommonMark
   * read of the profile block gives back the exact string `structuredContent`
   * carries, with no emphasis made of its `*` and `_`. One case per side of
   * codeLiteral's branch: a span inside the heading and the line, and a fence on
   * the lines after them — where a line of the name that reads as a heading
   * stays text inside the fence (#67).
   */
  it.each([
    ['*x*_y_', '<h1>Drug profile: <code>*x*_y_</code></h1>'],
    ['*x*\n# _y_', '<h1>Drug profile:</h1>'],
  ])('renders the caller drug name %j as a code literal in format()', async (drug, heading) => {
    mockQuery.mockResolvedValue({ meta: meta(), results: [] });

    const result = await runToolContract(drugProfileTool, { drug });
    const structured = result.structuredContent as { meta: { drug: string; fanOutKey: string } };
    expect(structured.meta).toMatchObject({ drug, fanOutKey: drug });

    const html = renderCommonMark(textOf(result.content, 0));
    expect(html).toContain(heading);
    expect(html.match(/<h\d>/g)).toHaveLength(7);
    expect(codeLiteralsIn(html)).toEqual([drug, drug]);
    expect(html.match(/<em>[\s\S]*?<\/em>/g)).toEqual(['<em>Resolved via: none</em>']);
  });

  it('renders every section header in format(), even when sections are null', () => {
    const content = drugProfileTool.format!({
      meta: { drug: 'mystery', resolvedVia: 'none', fanOutKey: 'mystery' },
      identity: {
        brand_names: [],
        generic_name: null,
        product_ndc: null,
        manufacturer: null,
        application_number: null,
        is_original_packager: null,
        rxcui: null,
        spl_set_id: null,
      },
      label: null,
      adverse_events: null,
      recalls: [],
      recalls_total: 0,
      approval: null,
      shortage: null,
      degraded: [],
    });

    const text = textOf(content);
    for (const header of [
      '## Identity',
      '## Label',
      '## Adverse events',
      '## Recalls',
      '## Approval',
      '## Shortage',
    ]) {
      expect(text).toContain(header);
    }
    expect(text).toContain('# Drug profile: `mystery`');
    expect(text).toContain('_Resolved via: none_ · fan-out key: `mystery`');
  });

  /**
   * A null section reads as unknown when its sub-query failed, and as absent only
   * when the search succeeded and matched nothing (#86).
   */
  describe.each([
    ['label', 'Unknown — the label search failed upstream (see Degraded).', 'No label on file.'],
    [
      'adverse_events',
      'Unknown — the adverse-event search failed upstream (see Degraded).',
      'No adverse-event data.',
    ],
    [
      'shortage',
      'Unknown — the shortage search failed upstream (see Degraded).',
      'Not currently listed in the shortage database.',
    ],
  ] as const)('format() for a null %s section', (section, unknownLine, absentLine) => {
    const nullProfile = (degraded: Array<{ section: string; reason: string; message: string }>) =>
      drugProfileTool.format!({
        meta: { drug: 'metformin', resolvedVia: 'none', fanOutKey: 'metformin' },
        identity: {
          brand_names: [],
          generic_name: null,
          product_ndc: null,
          manufacturer: null,
          application_number: null,
          is_original_packager: null,
          rxcui: null,
          spl_set_id: null,
        },
        label: null,
        adverse_events: null,
        recalls: [],
        recalls_total: 0,
        approval: null,
        shortage: null,
        degraded,
      } as Parameters<NonNullable<typeof drugProfileTool.format>>[0]);

    it('reads as unknown when the section is degraded', () => {
      const text = textOf(
        nullProfile([{ section, reason: 'upstream_error', message: 'gateway timeout' }]),
      );
      expect(text).toContain(unknownLine);
      expect(text).not.toContain(absentLine);
    });

    it('reads as absent when the search succeeded and matched nothing', () => {
      const text = textOf(nullProfile([]));
      expect(text).toContain(absentLine);
      expect(text).not.toContain(unknownLine);
    });
  });

  // Issue #19 — Rx labels carry safety text in boxed_warning / warnings_and_cautions,
  // not the OTC-monograph `warnings` field. The label.warnings mapping falls back
  // through those sections so major Rx drugs stop returning warnings: null.
  const labelOnly = (rec: Record<string, unknown>) => async (endpoint: string) =>
    endpoint === 'drug/label'
      ? { meta: meta({ total: 1 }), results: [rec] }
      : { meta: meta(), results: [] };

  it('populates label.warnings from boxed_warning, which wins over other sections (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        set_id: 'spl-metformin',
        openfda: { generic_name: ['metformin hydrochloride'], brand_name: ['Glucophage'] },
        indications_and_usage: ['Improve glycemic control.'],
        boxed_warning: ['WARNING: LACTIC ACIDOSIS. Postmarketing cases reported.'],
        warnings_and_cautions: ['Monitor renal function.'],
        warnings: ['Generic OTC warning text.'],
        dosage_and_administration: ['Start 500 mg twice daily.'],
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'metformin' }),
      ctx,
    );

    expect(result.label?.warnings).toContain('LACTIC ACIDOSIS');
    expect(result.label?.warnings).not.toContain('OTC warning');
    expect(result.label?.indications).toContain('glycemic');
    expect(result.label?.dosage).toContain('500 mg');
  });

  it('falls back to warnings_and_cautions when the label has no boxed_warning (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        openfda: { generic_name: ['adalimumab'], brand_name: ['Humira'] },
        warnings_and_cautions: ['Serious infections leading to hospitalization.'],
        // no boxed_warning, no `warnings`
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'Humira' }),
      ctx,
    );

    expect(result.label?.warnings).toContain('Serious infections');
  });

  it('still surfaces the OTC-monograph warnings section when it is all the label has (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        openfda: { generic_name: ['ibuprofen'], brand_name: ['Advil'] },
        warnings: ['Stomach bleeding warning.'],
        // no boxed_warning, no warnings_and_cautions (OTC monograph shape)
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'ibuprofen' }),
      ctx,
    );

    expect(result.label?.warnings).toContain('Stomach bleeding');
  });

  it('leaves warnings null when the label carries no warning section at all (#19)', async () => {
    mockQuery.mockImplementation(
      labelOnly({
        openfda: { generic_name: ['placebo'], brand_name: ['Placebo'] },
        indications_and_usage: ['No active ingredient.'],
      }),
    );

    const result = await drugProfileTool.handler(
      drugProfileTool.input.parse({ drug: 'placebo' }),
      ctx,
    );

    expect(result.label?.warnings).toBeNull();
    expect(result.label?.indications).toContain('No active');
  });

  // Issue #25 — the schema guards the raw input, but a name made only of delimiter
  // characters survived it and keyed every sub-query off content openFDA cannot
  // match: an unrelated record set returned as a "profile".
  describe('blank fan-out key (#25)', () => {
    it('rejects a drug name with no searchable character, without any upstream request', async () => {
      const failCtx = createMockContext({ errors: drugProfileTool.errors });

      const err = (await Promise.resolve(drugProfileTool.handler({ drug: '"""' }, failCtx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'blank_drug_name' });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('falls back to the input term when the resolved identity yields a blank key', async () => {
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/label'
          ? { meta: meta({ total: 1 }), results: [{ openfda: { generic_name: ['"'] } }] }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.meta.fanOutKey).toBe('metformin');
      // Recalls, shortage, and both Drugs@FDA searches: the name's selection
      // matched nothing, so the key's fallback ran beside them (#85).
      const structured = mockQuery.mock.calls.filter(([endpoint]) =>
        ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint),
      );
      expect(structured).toHaveLength(4);
      for (const [, params] of structured) {
        expect(params.search).toContain('"metformin"');
      }
    });
  });

  /**
   * Issue #42 — the caller's `drug` term is interpolated into seven quoted Lucene
   * phrases. Stripping only `"` left a term ending in `\\` escaping the phrase's own
   * closing quote, so the composed query no longer meant what the tool intended.
   *
   * Both live-verified against api.fda.gov. The two-clause identity resolve was the
   * silent case: `openfda.generic_name:"aspirin\\" OR openfda.brand_name:"aspirin\\"`
   * answers HTTP 200 with total 27101 against 743 for the intended query, because the
   * escaped quote pulls ` OR openfda.brand_name:` inside the phrase and the remainder
   * re-parses as a bare term. The five single-clause sub-queries instead left a phrase
   * open and failed as `token_mgr_error`. Escaping both `\\` and `"` keeps every
   * composed query well-formed with the ` OR ` boundary intact — proven upstream by an
   * escaped no-match first clause leaving the second clause's own total unchanged.
   */
  describe('term escaping in composed queries (#42)', () => {
    /** Every search string the handler sent, across all sub-queries. */
    const sentSearches = () =>
      mockQuery.mock.calls.map(([, params]) => (params as { search: string }).search);

    beforeEach(() => {
      mockQuery.mockResolvedValue({ meta: meta(), results: [] });
    });

    /** The identity searches — the original-packager one, then the unrestricted one (#85). */
    const labelResolves = () =>
      mockQuery.mock.calls
        .filter(([endpoint]) => endpoint === 'drug/label')
        .map(([, params]) => (params as { search: string }).search);

    it('escapes a trailing backslash so the OR boundary is not re-parsed', async () => {
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'aspirin\\' }), ctx);

      // The escaped form: the phrase closes on its own quote, so ` OR ` stays an operator.
      const escaped = 'openfda.generic_name:"aspirin\\\\" OR openfda.brand_name:"aspirin\\\\"';
      expect(labelResolves()).toEqual([
        `(${escaped}) AND openfda.is_original_packager:true`,
        escaped,
      ]);
      // The pre-fix composition, which openFDA answered 200 with unrelated records.
      expect(labelResolves()).not.toContain(
        'openfda.generic_name:"aspirin\\" OR openfda.brand_name:"aspirin\\"',
      );
    });

    it('escapes embedded quotes instead of dropping them from the term', async () => {
      await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'Tylenol "Extra Strength"' }),
        ctx,
      );

      const escaped =
        'openfda.generic_name:"Tylenol \\"Extra Strength\\"" OR openfda.brand_name:"Tylenol \\"Extra Strength\\""';
      expect(labelResolves()).toEqual([
        `(${escaped}) AND openfda.is_original_packager:true`,
        escaped,
      ]);
    });

    it('leaves every composed query with balanced, escape-aware delimiters', async () => {
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'aspirin\\' }), ctx);

      const searches = sentSearches();
      expect(searches.length).toBeGreaterThan(1);
      for (const search of searches) {
        expect(findSearchDelimiterFault(search)).toBeUndefined();
      }
    });

    it('escapes the resolved fan-out key on the structured sub-queries', async () => {
      // Brand input, so the key is the resolved generic rather than the typed term (#82).
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/label'
          ? {
              meta: meta({ total: 1 }),
              results: [{ openfda: { generic_name: ['odd\\name'], brand_name: ['Oddbrand'] } }],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'Oddbrand' }),
        ctx,
      );

      // fanOutKey is reported unescaped — escaping is a query-encoding concern.
      expect(result.meta.fanOutKey).toBe('odd\\name');
      const structured = mockQuery.mock.calls
        .filter(([endpoint]) =>
          ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint as string),
        )
        .map(([, params]) => (params as { search: string }).search);
      // The approval selection searches the typed name; recalls, shortage, and the
      // approval fallback the selection's empty match sent search the key (#85).
      expect(structured).toHaveLength(4);
      const keyed = structured.filter((search) => search !== selectionSearch('Oddbrand'));
      expect(keyed).toHaveLength(3);
      for (const search of keyed) expect(search).toContain('odd\\\\name');
      for (const search of structured) expect(findSearchDelimiterFault(search)).toBeUndefined();
    });

    it('keeps a plain term byte-identical to the pre-escape composition', async () => {
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);

      expect(sentSearches()).toContain(
        'openfda.generic_name:"metformin" OR openfda.brand_name:"metformin"',
      );
    });
  });

  /** The search each structured sub-query (recalls, approval, shortage) sent. */
  const structuredSearches = () =>
    Object.fromEntries(
      mockQuery.mock.calls
        .filter(([endpoint]) =>
          ['drug/enforcement', 'drug/drugsfda', 'drug/shortages'].includes(endpoint as string),
        )
        .map(([endpoint, params]) => [endpoint, (params as { search: string }).search]),
    ) as Record<'drug/enforcement' | 'drug/drugsfda' | 'drug/shortages', string>;

  /**
   * Issue #82 — the structured sub-queries keyed on one label's `openfda.generic_name`,
   * which can be a single product's string (`ADALIMUMAB-AACF`, `METFORMIN ER 500 MG`).
   * When the typed term is words of that generic, the caller typed the ingredient and
   * it is the key; brand input keeps keying on the resolved generic (#10).
   */
  describe('fan-out key follows a typed ingredient (#82)', () => {
    const labelWith = (generic: string, brand: string) => async (endpoint: string) =>
      endpoint === 'drug/label'
        ? {
            meta: meta({ total: 1 }),
            results: [{ openfda: { generic_name: [generic], brand_name: [brand] } }],
          }
        : { meta: meta(), results: [] };

    it('keys on the typed term when it is a word of a product-specific generic', async () => {
      mockQuery.mockImplementation(labelWith('ADALIMUMAB-AACF', 'IDACIO'));

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'adalimumab' }),
        ctx,
      );

      expect(result.meta.fanOutKey).toBe('adalimumab');
      // Identity still reports the label it resolved; only the key changes.
      expect(result.identity.generic_name).toBe('ADALIMUMAB-AACF');
      const searches = Object.values(structuredSearches());
      expect(searches).toHaveLength(3);
      for (const search of searches) {
        expect(search).toContain('"adalimumab"');
        expect(search).not.toContain('AACF');
      }
    });

    it.each(['METFORMIN HCL', 'METFORMIN ER 500 MG', 'METFORMIN HYDROCHLORIDE'])(
      'keys metformin on the typed term whichever label resolves (%s)',
      async (generic) => {
        mockQuery.mockImplementation(labelWith(generic, 'Metformin'));

        const result = await drugProfileTool.handler(
          drugProfileTool.input.parse({ drug: 'metformin' }),
          ctx,
        );

        expect(result.meta.fanOutKey).toBe('metformin');
        expect(structuredSearches()['drug/shortages']).toBe('generic_name:"metformin"');
      },
    );

    it('keeps the resolved generic when the term is not whole words of it', async () => {
      mockQuery.mockImplementation(labelWith('METFORMIN HCL', 'Metform'));

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'Metform' }),
        ctx,
      );

      expect(result.meta.fanOutKey).toBe('METFORMIN HCL');
    });

    it('applies the same rule to an identity resolved through drug/ndc', async () => {
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/ndc'
          ? {
              meta: meta({ total: 1 }),
              results: [{ brand_name: 'Tylenol', generic_name: 'ACETAMINOPHEN 500 MG' }],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'acetaminophen' }),
        ctx,
      );

      expect(result.meta.resolvedVia).toBe('ndc');
      expect(result.meta.fanOutKey).toBe('acetaminophen');
      expect(structuredSearches()['drug/shortages']).toBe('generic_name:"acetaminophen"');
    });
  });

  /**
   * Issue #79 — `drug/enforcement` and `drug/drugsfda` fill `openfda.generic_name`
   * only for records openFDA could harmonize, so each sub-query also searches the
   * record's own field for the key, and the recall section reports its match total.
   */
  describe('recall and approval searches reach unharmonized records (#79)', () => {
    it('composes each structured search with its own-field clause', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        fullUpstream(endpoint, params),
      );

      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);

      expect(structuredSearches()).toEqual({
        'drug/enforcement': 'openfda.generic_name:"metformin" OR product_description:"metformin"',
        // The approval selection: an NDA or BLA by either ingredient field, or any
        // application by brand (#85). The key's own-field fallback is pinned with #85.
        'drug/drugsfda': selectionSearch('metformin'),
        // drug/shortages carries generic_name on the record itself — no harmonization gap.
        'drug/shortages': 'generic_name:"metformin"',
      });
      const enforcement = mockQuery.mock.calls.find(([e]) => e === 'drug/enforcement')?.[1];
      expect(enforcement).toMatchObject({ sort: 'report_date:desc', limit: 5 });
    });

    it('costs 8 upstream requests resolved by label and 10 when no original-packager label matches', async () => {
      // The label carries no original-packager flag, so the picked application's
      // own label is looked up beside the fan-out (#85).
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        fullUpstream(endpoint, params),
      );
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);
      expect(mockQuery).toHaveBeenCalledTimes(8);

      // Nothing matches: the unrestricted label and drug/ndc, then the approval fallback.
      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ meta: meta(), results: [] });
      await drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx);
      expect(mockQuery).toHaveBeenCalledTimes(10);
    });

    /** Upstream with the recall search answering `results` out of `total` matches. */
    const withRecalls =
      (results: unknown[], total: number) => async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/enforcement'
          ? { meta: meta({ total }), results }
          : fullUpstream(endpoint, params);
    const RECALL = {
      classification: 'Class II',
      reason_for_recall: 'Failed dissolution specification.',
      recalling_firm: 'Acme Pharma',
      report_date: '20240115',
    };

    it('reports the recall match total beside the newest five, on both surfaces', async () => {
      mockQuery.mockImplementation(
        withRecalls(
          Array.from({ length: 5 }, () => RECALL),
          91,
        ),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        recalls: unknown[];
        recalls_total: number | null;
      };
      expect(structured.recalls).toHaveLength(5);
      expect(structured.recalls_total).toBe(91);
      expect(textOf(result.content)).toContain('## Recalls (5 of 91)');
    });

    it('names the searched fields when no recall report matches', async () => {
      mockQuery.mockImplementation(withRecalls([], 0));

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as { recalls_total: number | null };
      expect(structured.recalls_total).toBe(0);
      const text = textOf(result.content);
      expect(text).toContain('## Recalls (0 of 0)');
      expect(text).toContain('openfda.generic_name or product_description');
      expect(text).not.toContain('No recalls on record.');
    });

    it('reports the recall total as unknown, never 0, when the recall search fails', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/enforcement') {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as {
        recalls_total: number | null;
        degraded: Array<{ section: string }>;
      };
      expect(structured.recalls_total).toBeNull();
      expect(structured.degraded.map((d) => d.section)).toEqual(['recalls']);
      const text = textOf(result.content);
      expect(text).toContain('## Recalls (unknown)');
      expect(text).not.toContain('openfda.generic_name or product_description');
    });

    it('names the searched fields when no Drugs@FDA application matches', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/drugsfda'
          ? { meta: meta(), results: [] }
          : fullUpstream(endpoint, params),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect((result.structuredContent as { approval: unknown }).approval).toBeNull();
      const text = textOf(result.content);
      expect(text).toContain('openfda.generic_name or products.active_ingredients.name');
      expect(text).not.toContain('No Drugs@FDA approval found.');
    });

    it('says the approval is unknown, not unmatched, when its search fails', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/drugsfda') {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const text = textOf(result.content);
      expect(text).toMatch(/## Approval\nUnknown/);
      expect(text).not.toContain('products.active_ingredients.name');
    });

    /** Drugs@FDA application shapes as api.fda.gov returns them (metformin, 2026-10-26). */
    const app = (
      application_number: string,
      products: Array<{ brand_name: string; ingredients: string[] }>,
      openfda?: { generic_name: string[]; brand_name: string[] },
    ) => ({
      application_number,
      sponsor_name: `Sponsor of ${application_number}`,
      products: products.map((p) => ({
        brand_name: p.brand_name,
        marketing_status: 'Prescription',
        active_ingredients: p.ingredients.map((name) => ({ name, strength: '500MG' })),
      })),
      ...(openfda ? { openfda } : {}),
    });

    it('ranks applications on their own products, with or without an openfda block', async () => {
      const apps = [
        // Unharmonized combination ranked first by relevance.
        app('ANDA211466', [
          {
            brand_name: 'DAPAGLIFLOZIN AND METFORMIN HYDROCHLORIDE',
            ingredients: ['DAPAGLIFLOZIN', 'METFORMIN HYDROCHLORIDE'],
          },
        ]),
        app(
          'ANDA205981',
          [
            {
              brand_name: 'SAXAGLIPTIN AND METFORMIN HYDROCHLORIDE',
              ingredients: ['METFORMIN HYDROCHLORIDE', 'SAXAGLIPTIN HYDROCHLORIDE'],
            },
          ],
          {
            generic_name: ['SAXAGLIPTIN AND METFORMIN'],
            brand_name: ['SAXAGLIPTIN AND METFORMIN'],
          },
        ),
        // The single-ingredient application, unharmonized.
        app('ANDA076869', [
          { brand_name: 'METFORMIN HYDROCHLORIDE', ingredients: ['METFORMIN HYDROCHLORIDE'] },
        ]),
      ];
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/drugsfda'
          ? { meta: meta({ total: 214 }), results: apps }
          : fullUpstream(endpoint, params),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.approval).toEqual({
        applicationNumber: 'ANDA076869',
        sponsor: 'Sponsor of ANDA076869',
        marketingStatus: 'Prescription',
        brandNames: ['METFORMIN HYDROCHLORIDE'],
        candidates: 214,
      });
    });

    it('prefers a harmonized single-ingredient application over an unharmonized combination', async () => {
      const apps = [
        app('ANDA211466', [
          {
            brand_name: 'DAPAGLIFLOZIN AND METFORMIN HYDROCHLORIDE',
            ingredients: ['DAPAGLIFLOZIN', 'METFORMIN HYDROCHLORIDE'],
          },
        ]),
        app('NDA020357', [{ brand_name: 'GLUCOPHAGE', ingredients: ['METFORMIN HYDROCHLORIDE'] }], {
          generic_name: ['METFORMIN HYDROCHLORIDE'],
          brand_name: ['GLUCOPHAGE'],
        }),
      ];
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        endpoint === 'drug/drugsfda'
          ? { meta: meta({ total: 214 }), results: apps }
          : fullUpstream(endpoint, params),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.approval?.applicationNumber).toBe('NDA020357');
    });

    it('finds an approval for a drug no label or NDC resolves (troglitazone)', async () => {
      const discontinued = (n: string, brand: string) => ({
        ...app(n, [{ brand_name: brand, ingredients: ['TROGLITAZONE'] }]),
        products: [
          {
            brand_name: brand,
            marketing_status: 'Discontinued',
            active_ingredients: [{ name: 'TROGLITAZONE', strength: '200MG' }],
          },
        ],
      });
      mockQuery.mockImplementation(async (endpoint: string) =>
        endpoint === 'drug/drugsfda'
          ? {
              meta: meta({ total: 2 }),
              results: [discontinued('NDA020720', 'REZULIN'), discontinued('NDA020719', 'PRELAY')],
            }
          : { meta: meta(), results: [] },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'troglitazone' }),
        ctx,
      );

      expect(result.meta.resolvedVia).toBe('none');
      expect(structuredSearches()['drug/drugsfda']).toBe(selectionSearch('troglitazone'));
      // Equal on every tier, so the lower application number wins (#85).
      expect(result.approval).toMatchObject({
        applicationNumber: 'NDA020719',
        marketingStatus: 'Discontinued',
      });
    });
  });

  // Issue #26 — every section failure used to be swallowed into an empty best-effort
  // result, so an invalid API key was reported as a drug that could not be resolved.
  describe('section failure classification (#26)', () => {
    it('propagates an auth failure instead of reporting an unresolved drug', async () => {
      mockQuery.mockRejectedValue(
        unauthorized('openFDA API key is missing or invalid.', { reason: 'unauthorized' }),
      );

      const err = (await Promise.resolve(drugProfileTool.handler({ drug: 'metformin' }, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('stops before the fan-out when identity resolution fails globally', async () => {
      mockQuery.mockRejectedValue(
        forbidden('Access to this openFDA endpoint is forbidden.', { reason: 'forbidden' }),
      );

      await expect(
        drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx),
      ).rejects.toThrow(McpError);
      // Only the first round — the label search and the approval selection beside it (#85).
      expect(mockQuery.mock.calls.map(([endpoint]) => endpoint)).toEqual([
        'drug/label',
        'drug/drugsfda',
      ]);
    });

    it('propagates cancellation rather than returning a half-built profile', async () => {
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.InternalError, 'Request was aborted.', {
          errorSource: 'FetchAborted',
        }),
      );

      const err = (await Promise.resolve(drugProfileTool.handler({ drug: 'metformin' }, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.message).toMatch(/aborted/i);
    });

    it('reports a per-section failure in structuredContent and content[]', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/enforcement') {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.degraded).toEqual([
        {
          section: 'recalls',
          reason: 'upstream_error',
          message: expect.stringContaining('gateway timeout'),
        },
      ]);
      expect(result.recalls).toEqual([]);
      expect(result.label).not.toBeNull();

      const text = textOf(drugProfileTool.format!(result));
      expect(text).toContain('## Degraded');
      expect(text).toContain('recalls');
      expect(text).toContain('upstream_error');
      expect(text).toContain('gateway timeout');

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('recalls (upstream_error)');
      expect(notice).not.toMatch(/spelling/i);
    });

    it('collapses the three adverse-event sub-queries into one degraded entry', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) => {
        if (endpoint === 'drug/event') {
          throw serviceUnavailable('openFDA upstream error: shard failure', {
            reason: 'upstream_error',
          });
        }
        return fullUpstream(endpoint, params);
      });

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(mockQuery.mock.calls.filter(([endpoint]) => endpoint === 'drug/event')).toHaveLength(
        3,
      );
      expect(result.degraded.map((d) => d.section)).toEqual(['adverse_events']);
      expect(result.adverse_events).toBeNull();
    });

    /**
     * Any one adverse-event sub-query failing leaves the section unknown: no
     * bucket sum or zero stands in for the figure that failed, and the reactions
     * that did arrive are not reported beside a fabricated total (#63).
     */
    it.each([
      ['the match total', (params: { count?: string }) => params.count === undefined],
      ['the serious tally', (params: { count?: string }) => params.count === 'serious'],
      [
        'the reaction tally',
        (params: { count?: string }) => params.count?.startsWith('patient.reaction') === true,
      ],
    ])('nulls adverse_events when %s fails alone', async (_name, failing) => {
      mockQuery.mockImplementation(
        async (endpoint: string, params: { count?: string; limit?: number }) => {
          if (endpoint === 'drug/event' && failing(params)) {
            throw serviceUnavailable('openFDA upstream error: shard failure', {
              reason: 'upstream_error',
            });
          }
          return fullUpstream(endpoint, params);
        },
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.adverse_events).toBeNull();
      expect(result.degraded).toEqual([
        {
          section: 'adverse_events',
          reason: 'upstream_error',
          message: expect.stringContaining('shard failure'),
        },
      ]);
      // Every other section still resolves.
      expect(result.label).not.toBeNull();
      expect(result.recalls).toHaveLength(1);
      expect(getEnrichment(ctx).sectionsFound).toBe(4);
      expect(getEnrichment(ctx).notice).toMatch(
        /Partial profile .* adverse_events \(upstream_error\)/,
      );

      const text = textOf(drugProfileTool.format!(result));
      expect(text).toContain('Unknown — the adverse-event search failed upstream (see Degraded).');
      expect(text).not.toContain('No adverse-event data.');
      expect(text).not.toContain('**Total reports:**');
      expect(text).toContain('## Degraded (1 section)');
    });

    it('propagates cancellation of the match total rather than reporting the section degraded', async () => {
      mockQuery.mockImplementation(
        async (endpoint: string, params: { count?: string; limit?: number }) => {
          if (endpoint === 'drug/event' && params.count === undefined) {
            throw new McpError(JsonRpcErrorCode.InternalError, 'Request was aborted.', {
              errorSource: 'FetchAborted',
            });
          }
          return fullUpstream(endpoint, params);
        },
      );

      const err = (await Promise.resolve(
        drugProfileTool.handler(drugProfileTool.input.parse({ drug: 'metformin' }), ctx),
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.message).toMatch(/aborted/i);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('never blames spelling when every section failed upstream', async () => {
      mockQuery.mockRejectedValue(
        serviceUnavailable('openFDA upstream error: HTTP 503', { reason: 'upstream_error' }),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.meta.resolvedVia).toBe('none');
      expect(getEnrichment(ctx).sectionsFound).toBe(0);
      expect(result.degraded.length).toBeGreaterThan(0);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).not.toMatch(/spelling/i);
      expect(notice).toMatch(/failed upstream/i);
      expect(notice).toMatch(/identity was not resolved/i);
    });

    it('leaves degraded empty on a fully resolved profile', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { count?: string }) =>
        fullUpstream(endpoint, params),
      );

      const result = await drugProfileTool.handler(
        drugProfileTool.input.parse({ drug: 'metformin' }),
        ctx,
      );

      expect(result.degraded).toEqual([]);
      expect(textOf(drugProfileTool.format!(result))).not.toContain('## Degraded');
    });
  });

  /**
   * Issue #85 — identity, label, approval, and shortage were each the first record
   * an arbitrary openFDA window returned, so a repackager's label, a biosimilar's, a
   * generic's application, or another product's shortage read as the drug's. Each
   * section is now chosen by a rule and names the product it describes.
   */
  describe('product selection (#85)', () => {
    type Structured = {
      identity: Record<string, unknown>;
      label: Record<string, unknown> | null;
      approval: Record<string, unknown> | null;
      shortage: Record<string, unknown> | null;
      degraded: Array<{ section: string; reason: string; message: string }>;
      notice?: string;
    };
    const labelSearches = () =>
      mockQuery.mock.calls
        .filter(([endpoint]) => endpoint === 'drug/label')
        .map(([, params]) => (params as { search: string }).search);
    const METFORMIN: ProfileUpstream = {
      flagged: [LABELS.zituvimet, LABELS.westminsterMetformin],
      unrestricted: [LABELS.asMedicationMetformin],
      ownLabel: [],
      selection: { results: applications(APPLICATION_ROWS.metformin), total: 28 },
      shortage: { results: METFORMIN_SHORTAGES },
    };

    it('metformin: an original-packager label, the GLUCOPHAGE application, each naming its own', async () => {
      mockQuery.mockImplementation(serveProfile(METFORMIN));

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as Structured;
      expect(structured.identity).toMatchObject({
        product_ndc: '69367-412',
        manufacturer: 'Westminster Pharmaceuticals, LLC',
        application_number: 'ANDA203832',
        is_original_packager: true,
      });
      expect(structured.approval).toEqual({
        applicationNumber: 'NDA020357',
        sponsor: 'EMD SERONO INC',
        marketingStatus: 'Discontinued',
        brandNames: ['GLUCOPHAGE'],
        candidates: 28,
      });
      // GLUCOPHAGE has no original-packager label, so the one in hand stays; the
      // unrestricted search (the repackager's 50090-7011) never runs.
      expect(labelSearches()).toEqual([
        flaggedLabelSearch('metformin'),
        ownLabelSearch('NDA020357'),
      ]);
      expect(mockQuery).toHaveBeenCalledTimes(8);
      expect(structured.degraded).toEqual([]);

      const text = textOf(result.content);
      expect(text).toContain(
        '**Manufacturer:** Westminster Pharmaceuticals, LLC | **Application number:** ANDA203832 | **Original packager:** yes',
      );
      expect(text).toContain(
        '**Application number:** NDA020357 | **Sponsor:** EMD SERONO INC | **Marketing status:** Discontinued',
      );
      expect(text).toContain('**Brand names:** GLUCOPHAGE');
      expect(text).toContain(
        'The identity and label above come from ANDA203832, a different application.',
      );
    });

    it('metformin: names both Mylan presentations the shortage records cover', async () => {
      mockQuery.mockImplementation(serveProfile(METFORMIN));

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect((result.structuredContent as Structured).shortage).toEqual({
        status: 'To Be Discontinued',
        availability: null,
        product: 'METFORMIN HYDROCHLORIDE',
        company: 'Mylan Pharmaceuticals Inc., a Viatris Company',
        presentation:
          'Metformin Hydrochloride, Tablet, Extended Release, 1000 mg (NDC 0378-6001-91)',
        namesInput: true,
        total: 2,
        statusCounts: [{ status: 'To Be Discontinued', count: 2 }],
      });
      const text = textOf(result.content);
      expect(text).toContain(
        '**Product:** METFORMIN HYDROCHLORIDE | **Company:** Mylan Pharmaceuticals Inc., a Viatris Company',
      );
      expect(text).toContain(
        '**Presentation:** Metformin Hydrochloride, Tablet, Extended Release, 1000 mg (NDC 0378-6001-91)',
      );
      expect(text).toContain('**Records:** 2 — by status: To Be Discontinued 2');
      expect(text).not.toContain('No shortage record names');
      expect(mockQuery.mock.calls.find(([e]) => e === 'drug/shortages')?.[1]).toMatchObject({
        sort: 'update_date:desc',
        limit: 100,
      });
    });

    it("adalimumab: a biosimilar's label gives way to BLA125057's original-packager label", async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [LABELS.idacio, LABELS.cyltezo],
          ownLabel: [LABELS.humiraCordavis, LABELS.humiraAbbvie],
          selection: { results: applications(APPLICATION_ROWS.adalimumab), total: 11 },
          shortage: { results: ADALIMUMAB_SHORTAGES },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'adalimumab' });

      const structured = result.structuredContent as Structured & {
        meta: { fanOutKey: string; resolvedVia: string };
      };
      expect(structured.approval).toMatchObject({
        applicationNumber: 'BLA125057',
        brandNames: ['HUMIRA'],
      });
      expect(structured.identity).toMatchObject({
        generic_name: 'ADALIMUMAB',
        application_number: 'BLA125057',
        is_original_packager: true,
      });
      expect(structured.identity.generic_name).not.toBe('ADALIMUMAB-AACF');
      expect(structured.label?.indications).toContain('Cordavis Limited');
      // The key comes from the name's own resolution, before the label moved (#82).
      expect(structured.meta).toMatchObject({ fanOutKey: 'adalimumab', resolvedVia: 'label' });
      expect(mockQuery).toHaveBeenCalledTimes(8);
      expect(textOf(result.content)).not.toContain('a different application');
    });

    it("Humira: the brand's own label and application in 7 requests; the shortage names Hyrimoz", async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [LABELS.humiraCordavis, LABELS.humiraAbbvie],
          selection: { results: applications(APPLICATION_ROWS.humira), total: 1 },
          shortage: { results: ADALIMUMAB_SHORTAGES },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'Humira' });

      const structured = result.structuredContent as Structured;
      expect(structured.approval).toMatchObject({ applicationNumber: 'BLA125057' });
      expect(structured.identity).toMatchObject({ application_number: 'BLA125057' });
      // The label in hand is already BLA125057's own: no by-application lookup.
      expect(labelSearches()).toEqual([flaggedLabelSearch('Humira')]);
      expect(mockQuery).toHaveBeenCalledTimes(7);
      expect(structured.shortage).toEqual({
        status: 'To Be Discontinued',
        availability: null,
        product: 'HYRIMOZ',
        company: 'Sandoz Inc.',
        presentation: 'Hyrimoz, Injection, 80 mg/.8 mL (NDC 61314-454-36)',
        namesInput: false,
        total: 6,
        statusCounts: [{ status: 'To Be Discontinued', count: 6 }],
      });

      const text = textOf(result.content, 0);
      expect(text).toContain('**Product:** HYRIMOZ | **Company:** Sandoz Inc.');
      expect(text).toContain('**Records:** 6 — by status: To Be Discontinued 6');
      const html = renderCommonMark(text);
      expect(html).toContain(
        'No shortage record names <code>Humira</code> itself; the record above is the newest for the fan-out key.',
      );
      // The heading's name, the fan-out key, and the shortage line's name.
      expect(codeLiteralsIn(html)).toEqual(['Humira', 'ADALIMUMAB', 'Humira']);
    });

    it("shows a brand's own shortage record ahead of a newer one for the same ingredient", async () => {
      const simlandi = ADALIMUMAB_SHORTAGES[5]!;
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [
            labelRecord({
              set: 's-simlandi',
              generic: 'ADALIMUMAB-RYVK',
              brand: 'Simlandi',
              manufacturer: 'Teva Pharmaceuticals USA, Inc.',
              ndc: '51759-274',
              application: 'BLA761299',
              original: true,
            }),
          ],
          shortage: { results: ADALIMUMAB_SHORTAGES.slice(0, 1).concat(simlandi) },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'Simlandi' });

      expect((result.structuredContent as Structured).shortage).toMatchObject({
        product: 'SIMLANDI',
        company: 'Teva Pharmaceuticals USA, Inc.',
        namesInput: true,
        total: 2,
      });
    });

    it('Lipitor: label and approval both NDA020702, in 7 requests', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [LABELS.lipitorViatris],
          selection: { results: applications(APPLICATION_ROWS.lipitor), total: 1 },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'Lipitor' });

      const structured = result.structuredContent as Structured;
      expect(structured.approval).toMatchObject({
        applicationNumber: 'NDA020702',
        brandNames: ['LIPITOR'],
      });
      expect(structured.identity).toMatchObject({
        application_number: 'NDA020702',
        manufacturer: 'Viatris Specialty LLC',
      });
      expect(mockQuery).toHaveBeenCalledTimes(7);
    });

    it('names the picked application on identity when the label lists it beside another', async () => {
      const lipitor = LABELS.lipitorViatris;
      const listingBoth = {
        ...lipitor,
        openfda: { ...lipitor.openfda, application_number: ['ANDA090000', 'NDA020702'] },
      };
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [listingBoth],
          selection: { results: applications(APPLICATION_ROWS.lipitor), total: 1 },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'Lipitor' });

      expect((result.structuredContent as Structured).identity).toMatchObject({
        application_number: 'NDA020702',
      });
      expect(textOf(result.content)).not.toContain('a different application');
      // The label already lists the pick, so no by-application lookup runs.
      expect(mockQuery).toHaveBeenCalledTimes(7);
    });

    it('names the looked-up application on identity when the label it finds lists it beside another', async () => {
      const glucophage = labelRecord({
        set: 'glucophage-1',
        generic: 'METFORMIN HYDROCHLORIDE',
        brand: 'Glucophage',
        manufacturer: 'EMD Serono Inc',
        ndc: '0000-0001',
        application: 'ANDA000001',
        original: true,
      });
      const listingBoth = {
        ...glucophage,
        openfda: { ...glucophage.openfda, application_number: ['ANDA000001', 'NDA020357'] },
      };
      mockQuery.mockImplementation(serveProfile({ ...METFORMIN, ownLabel: [listingBoth] }));

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect((result.structuredContent as Structured).identity).toMatchObject({
        manufacturer: 'EMD Serono Inc',
        application_number: 'NDA020357',
      });
    });

    it('apixaban: the reference NDA, never the tentative approval', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [LABELS.apixabanIndoco],
          ownLabel: [],
          selection: { results: applications(APPLICATION_ROWS.apixaban), total: 4 },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'apixaban' });

      const structured = result.structuredContent as Structured;
      expect(structured.approval).toMatchObject({
        applicationNumber: 'NDA202155',
        marketingStatus: 'Prescription',
      });
      expect(structured.identity).toMatchObject({
        application_number: 'ANDA209898',
        manufacturer: 'Indoco Remedies Limited',
      });
    });

    it("Eliquis: only repackager labels — still resolves, and says the label is not an original packager's", async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [],
          unrestricted: [LABELS.eliquisAphena],
          ndc: [{ brand_name: 'Eliquis', generic_name: 'apixaban', product_ndc: '0003-0893' }],
          ownLabel: [],
          selection: { results: applications(APPLICATION_ROWS.eliquis), total: 2 },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'Eliquis' });

      const structured = result.structuredContent as Structured & {
        meta: { resolvedVia: string };
      };
      expect(structured.meta.resolvedVia).toBe('label');
      expect(structured.identity).toMatchObject({
        product_ndc: '71610-811',
        manufacturer: 'Aphena Pharma Solutions - Tennessee, LLC',
        application_number: 'NDA202155',
        is_original_packager: false,
      });
      expect(structured.approval).toMatchObject({ applicationNumber: 'NDA202155' });
      expect(labelSearches()).toEqual([
        flaggedLabelSearch('Eliquis'),
        'openfda.generic_name:"Eliquis" OR openfda.brand_name:"Eliquis"',
        ownLabelSearch('NDA202155'),
      ]);
      expect(mockQuery).toHaveBeenCalledTimes(10);
      expect(textOf(result.content)).toContain(
        "**Original packager:** no — openFDA does not flag this record as the original packager's",
      );
    });

    it('reads identity from drug/ndc, labeler and application included, when no label matches', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [],
          unrestricted: [],
          ndc: [
            {
              brand_name: 'Tylenol',
              generic_name: 'acetaminophen',
              product_ndc: '50580-449',
              labeler_name: 'Kenvue Brands LLC',
              application_number: 'M013',
              openfda: { is_original_packager: [true] },
            },
          ],
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'Tylenol' });

      expect((result.structuredContent as Structured).identity).toMatchObject({
        manufacturer: 'Kenvue Brands LLC',
        application_number: 'M013',
        is_original_packager: true,
      });
    });

    it('keeps the label in hand, named, with a notice when the by-application lookup fails', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          ...METFORMIN,
          ownLabel: serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          }),
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as Structured;
      expect(structured.identity).toMatchObject({ application_number: 'ANDA203832' });
      expect(structured.label?.indications).toContain('Westminster');
      // The label is known — the one in hand — so the section is not degraded.
      expect(structured.degraded).toEqual([]);
      expect(structured.notice).toBe(
        "Label lookup partly failed — the original-packager label search for NDA020357 (upstream_error); the label shown is Westminster Pharmaceuticals, LLC's, filed under ANDA203832. Retry for the drug's own label.",
      );
    });

    it('raises no lookup notice when a failed lookup leaves the picked application’s own label shown', async () => {
      const answer = serveProfile({
        unrestricted: [LABELS.humiraAbbvie],
        ndc: [],
        selection: { results: applications(APPLICATION_ROWS.humira) },
      });
      mockQuery.mockImplementation(async (endpoint: string, params: { search?: string }) => {
        if (endpoint === 'drug/label' && params.search === flaggedLabelSearch('Humira')) {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return answer(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'Humira' });

      const structured = result.structuredContent as Structured;
      // The unrestricted search found BLA125057's own original-packager label: nothing to retry for.
      expect(structured.identity).toMatchObject({ application_number: 'BLA125057' });
      expect(structured.approval).toMatchObject({ applicationNumber: 'BLA125057' });
      expect(structured.degraded).toEqual([]);
      expect(structured.notice).toBeUndefined();
    });

    it('reports the label unknown when the by-application lookup fails with no label in hand', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [],
          unrestricted: [],
          ndc: [],
          ownLabel: serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          }),
          selection: { results: applications(APPLICATION_ROWS.troglitazone), total: 2 },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'troglitazone' });

      const structured = result.structuredContent as Structured;
      expect(structured.label).toBeNull();
      expect(structured.degraded).toEqual([
        { section: 'label', reason: 'upstream_error', message: expect.stringContaining('gateway') },
      ]);
      expect(structured.approval).toMatchObject({ applicationNumber: 'NDA020719' });
      expect(textOf(result.content)).toContain(
        'Unknown — the label search failed upstream (see Degraded).',
      );
    });

    it('falls back to the fan-out key query, ranked the same, when the name matches no NDA, BLA, or brand', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [LABELS.westminsterMetformin],
          selection: { results: [] },
          fallback: {
            results: applications([
              [
                'ANDA211309',
                'SAPTALIS',
                [['METFORMIN HYDROCHLORIDE', 'Prescription', 'No', ['METFORMIN HYDROCHLORIDE']]],
              ],
              [
                'ANDA075975',
                'TEVA',
                [['METFORMIN HYDROCHLORIDE', 'Prescription', 'No', ['METFORMIN HYDROCHLORIDE']]],
              ],
            ]),
            total: 2,
          },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const drugsfda = mockQuery.mock.calls
        .filter(([endpoint]) => endpoint === 'drug/drugsfda')
        .map(([, params]) => params);
      expect(drugsfda).toEqual([
        { search: selectionSearch('metformin'), limit: 100 },
        {
          search:
            'openfda.generic_name:"metformin" OR products.active_ingredients.name:"metformin"',
          limit: 100,
        },
      ]);
      expect((result.structuredContent as Structured).approval).toMatchObject({
        applicationNumber: 'ANDA075975',
        candidates: 2,
      });
      // The fallback stands in for the by-application lookup, never beside it.
      expect(labelSearches()).toEqual([flaggedLabelSearch('metformin')]);
      expect(mockQuery).toHaveBeenCalledTimes(8);
    });

    it('leaves the approval unknown, with no fallback search, when the selection fails', async () => {
      // A failed selection is unknown, not a name that matched nothing: the fallback would answer here.
      const answer = serveProfile({
        ...METFORMIN,
        fallback: {
          results: applications([
            [
              'ANDA075975',
              'TEVA',
              [['METFORMIN HYDROCHLORIDE', 'Prescription', 'No', ['METFORMIN HYDROCHLORIDE']]],
            ],
          ]),
          total: 1,
        },
      });
      mockQuery.mockImplementation(async (endpoint: string, params: { search?: string }) => {
        if (endpoint === 'drug/drugsfda' && params.search?.includes('application_number:NDA*')) {
          throw serviceUnavailable('openFDA upstream error: gateway timeout', {
            reason: 'upstream_error',
          });
        }
        return answer(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as Structured;
      expect(structured.approval).toBeNull();
      expect(structured.degraded).toEqual([
        {
          section: 'approval',
          reason: 'upstream_error',
          message: expect.stringContaining('gateway'),
        },
      ]);
      expect(
        mockQuery.mock.calls.filter(([endpoint]) => endpoint === 'drug/drugsfda'),
      ).toHaveLength(1);
    });

    it.each([
      [100, false],
      [101, true],
    ])('discloses an approval match total of %d only above 100: %s', async (total, disclosed) => {
      mockQuery.mockImplementation(
        serveProfile({
          ...METFORMIN,
          selection: { results: applications(APPLICATION_ROWS.metformin), total },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as Structured;
      expect(structured.approval).toMatchObject({ candidates: total });
      const text = textOf(result.content);
      if (disclosed) {
        expect(structured.notice).toBe(
          "Approval was ranked over the first 100 of 101 matching Drugs@FDA applications, so the drug's own application may lie beyond them.",
        );
        expect(text).toContain(
          "**Candidates ranked:** the first 100 of 101 matching applications — the drug's own may lie past them",
        );
      } else {
        expect(structured.notice).toBeUndefined();
        expect(text).toContain('**Candidates ranked:** 100 matching applications');
      }
    });

    it.each([
      [100, false],
      [101, true],
    ])('discloses a shortage match total of %d only above 100: %s', async (total, disclosed) => {
      mockQuery.mockImplementation(
        serveProfile({ ...METFORMIN, shortage: { results: METFORMIN_SHORTAGES, total } }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      const structured = result.structuredContent as Structured;
      expect(structured.shortage).toMatchObject({ total });
      const text = textOf(result.content);
      if (disclosed) {
        expect(structured.notice).toBe(
          'Shortage status counts cover the newest 100 of 101 matching records.',
        );
        expect(text).toContain(
          '**Records:** 101 — by status over the newest 100: To Be Discontinued 2',
        );
      } else {
        expect(structured.notice).toBeUndefined();
        expect(text).toContain('**Records:** 100 — by status: To Be Discontinued 2');
      }
    });

    it('joins every notice one profile raises into one', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          ...METFORMIN,
          selection: { results: applications(APPLICATION_ROWS.metformin), total: 101 },
          shortage: { results: METFORMIN_SHORTAGES, total: 101 },
        }),
      );

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect((result.structuredContent as Structured).notice).toBe(
        "Approval was ranked over the first 100 of 101 matching Drugs@FDA applications, so the drug's own application may lie beyond them. Shortage status counts cover the newest 100 of 101 matching records.",
      );
    });

    /**
     * Rounds counted at the stub: a request issued before any earlier one settled
     * is in the same round. The cheapest path, the by-application path, and the
     * no-original-packager path, never more than three rounds.
     */
    it.each([
      [
        'the label already belongs to the picked application',
        'Humira',
        {
          flagged: [LABELS.humiraAbbvie],
          selection: { results: applications(APPLICATION_ROWS.humira) },
        },
        7,
      ],
      ['the label belongs to another application', 'metformin', METFORMIN, 8],
      [
        'no original-packager label matches the name',
        'Eliquis',
        {
          flagged: [],
          unrestricted: [LABELS.eliquisAphena],
          ownLabel: [],
          selection: { results: applications(APPLICATION_ROWS.eliquis) },
        },
        10,
      ],
    ] as const)(
      'when %s, %s takes its request count in at most three rounds',
      async (_why, drug, upstream, requests) => {
        const answer = serveProfile(upstream as ProfileUpstream);
        let settled = 0;
        const rounds = new Set<number>();
        mockQuery.mockImplementation(async (endpoint: string, params: { search?: string }) => {
          rounds.add(settled);
          try {
            return await answer(endpoint, params);
          } finally {
            settled++;
          }
        });

        await runToolContract(drugProfileTool, { drug });

        expect(mockQuery).toHaveBeenCalledTimes(requests);
        expect(rounds.size).toBeLessThanOrEqual(3);
      },
    );

    it('passes one deadline, 50 s from the start, to every request of every round', async () => {
      mockQuery.mockImplementation(
        serveProfile({
          flagged: [],
          unrestricted: [LABELS.eliquisAphena],
          ownLabel: [],
          selection: { results: applications(APPLICATION_ROWS.eliquis) },
        }),
      );

      const before = Date.now();
      await runToolContract(drugProfileTool, { drug: 'Eliquis' });
      const after = Date.now();

      const deadlines = mockQuery.mock.calls.map(
        ([, , , options]) => (options as { deadlineAtMs?: number } | undefined)?.deadlineAtMs,
      );
      expect(deadlines).toHaveLength(10);
      expect(new Set(deadlines).size).toBe(1);
      const [deadline] = deadlines as number[];
      expect(deadline).toBeGreaterThanOrEqual(before + 50_000);
      expect(deadline).toBeLessThanOrEqual(after + 50_000);
    });

    it('reports a sub-query the deadline cut as a timeout in degraded, never failing the call', async () => {
      mockQuery.mockImplementation(async (endpoint: string, params: { search?: string }) => {
        if (endpoint === 'drug/shortages') {
          throw timeout(
            'openFDA:drug/shortages exceeded its 2000ms retry deadline after 1 attempt.',
            {
              reason: 'retry_deadline_exceeded',
            },
          );
        }
        return serveProfile(METFORMIN)(endpoint, params);
      });

      const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Structured;
      expect(structured.shortage).toBeNull();
      expect(structured.degraded).toEqual([
        { section: 'shortage', reason: 'timeout', message: expect.stringContaining('deadline') },
      ]);
      expect(structured.notice).toContain('shortage (timeout)');
    });
  });
});

/**
 * The adverse-event total against the real OpenFdaService, with only the HTTP
 * boundary stubbed: the outgoing `limit=0` request, the total it carries into
 * both response surfaces, and openFDA's no-match 404 (#63).
 */
describe('openfda_drug_profile adverse-event total at the HTTP boundary', () => {
  const http = createFetchMock();
  const NO_MATCHES = () =>
    Response.json({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }, { status: 404 });
  const page = (results: unknown[], total: number) =>
    Response.json({
      meta: { results: { skip: 0, limit: results.length, total }, last_updated: '2026-07-30' },
      results,
    });
  const paramsOf = (req: Request) => new URL(req.url).searchParams;
  const isEvent = (req: Request) => new URL(req.url).pathname === '/drug/event.json';
  const eventRequests = () => http.calls.map((call) => call.request).filter(isEvent);

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/services/openfda/openfda-service.js')>(
      '@/services/openfda/openfda-service.js',
    );
    actual.initOpenFdaService();
    vi.mocked(getOpenFdaService).mockImplementation(actual.getOpenFdaService);
  });

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('reads total from a limit=0 search for the same match, on both surfaces', async () => {
    http.route(
      {
        match: (req) => isEvent(req) && paramsOf(req).get('count') === 'serious',
        respond: () =>
          page(
            [
              { term: 1, count: 293498 },
              { term: 2, count: 139294 },
            ],
            0,
          ),
      },
      {
        match: (req) => isEvent(req) && paramsOf(req).has('count'),
        respond: () => page([{ term: 'NAUSEA', count: 31210 }], 0),
      },
      { match: isEvent, respond: () => page([], 432898) },
      { match: () => true, respond: NO_MATCHES },
    );

    const result = await runToolContract(drugProfileTool, { drug: 'metformin' });

    expect(result.isError).toBeFalsy();
    const totalRequests = eventRequests()
      .map(paramsOf)
      .filter((params) => !params.has('count'));
    expect(totalRequests).toHaveLength(1);
    // The service wraps every search in one pair of parentheses on the wire (#84).
    expect(totalRequests[0]!.get('search')).toBe('(patient.drug.medicinalproduct:"metformin")');
    expect(totalRequests[0]!.get('limit')).toBe('0');
    expect(totalRequests[0]!.has('sort')).toBe(false);

    const structured = result.structuredContent as {
      adverse_events: { total: number; seriousCount: number } | null;
      degraded: unknown[];
    };
    expect(structured.adverse_events).toMatchObject({ total: 432898, seriousCount: 293498 });
    expect(structured.degraded).toEqual([]);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('**Total reports:** 432898 | **Serious count:** 293498');
  });

  it('leaves adverse_events null and nothing degraded when drug/event matches nothing', async () => {
    http.route({ match: () => true, respond: NO_MATCHES });

    const result = await runToolContract(drugProfileTool, { drug: 'zzqxnotadrug' });

    expect(result.isError).toBeFalsy();
    expect(eventRequests()).toHaveLength(3);
    // Both label searches, drug/ndc, and the Drugs@FDA selection miss: the
    // fallback profile's 10 requests (#85).
    expect(http.calls).toHaveLength(10);
    const structured = result.structuredContent as {
      adverse_events: unknown;
      recalls_total: number | null;
      degraded: unknown[];
    };
    expect(structured.adverse_events).toBeNull();
    // openFDA's no-match 404 is a known zero, not the unknown a failed search reports (#79).
    expect(structured.recalls_total).toBe(0);
    expect(structured.degraded).toEqual([]);
  });

  /**
   * A caller that cancels while a sub-query sleeps between retries. `withRetry`
   * rejects the backoff with the signal's own reason — no `McpError` — so a check
   * keyed on the error's shape files the cancellation as one more degraded
   * section and completes the call. Driven through the real service and the real
   * `withRetry`, on fake timers so the backoff is held open until the abort lands.
   */
  describe('cancellation during a retry backoff', () => {
    const pathOf = (req: Request) => new URL(req.url).pathname;
    const SERVER_ERROR = () =>
      Response.json({ error: { code: 'SERVER_ERROR', message: 'shard failure' } }, { status: 500 });
    const LABEL = () =>
      page(
        [{ set_id: 's-1', openfda: { generic_name: ['metformin'], brand_name: ['Glucophage'] } }],
        1,
      );

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Identity resolution and every sub-query of the fan-out after it. */
    const SUB_QUERIES: Array<[string, (req: Request) => boolean]> = [
      ['the drug/label identity lookup', (req) => pathOf(req) === '/drug/label.json'],
      ['the adverse-event match total', (req) => isEvent(req) && !paramsOf(req).has('count')],
      [
        'the reactions count',
        (req) =>
          isEvent(req) && paramsOf(req).get('count') === 'patient.reaction.reactionmeddrapt.exact',
      ],
      ['the seriousness count', (req) => isEvent(req) && paramsOf(req).get('count') === 'serious'],
      ['the recall search', (req) => pathOf(req) === '/drug/enforcement.json'],
      ['the approval search', (req) => pathOf(req) === '/drug/drugsfda.json'],
      ['the shortage search', (req) => pathOf(req) === '/drug/shortages.json'],
    ];

    it.each(SUB_QUERIES)(
      'reports the call cancelled when the cancel lands while %s backs off',
      async (_label, failing) => {
        vi.useFakeTimers();
        http.route(
          { match: failing, respond: SERVER_ERROR },
          { match: (req) => pathOf(req) === '/drug/label.json', respond: LABEL },
          { match: () => true, respond: NO_MATCHES },
        );
        const controller = new AbortController();
        const pending = runToolContract(
          drugProfileTool,
          { drug: 'metformin' },
          { context: { signal: controller.signal } },
        );

        // Settle every request without moving the clock, so the failed one sits in its backoff.
        const failed = () => http.calls.filter((call) => failing(call.request));
        for (let i = 0; i < 200 && failed().length === 0; i++) await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(0);
        expect(failed()).toHaveLength(1);
        const requestsBeforeCancel = http.calls.length;

        controller.abort();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
          JsonRpcErrorCode.RequestCancelled,
        );
        // The retry never fired, and nothing further went upstream once the caller left.
        expect(failed()).toHaveLength(1);
        expect(http.calls).toHaveLength(requestsBeforeCancel);
      },
    );

    it('stops before the fan-out when the cancel lands while the drug/ndc fallback backs off', async () => {
      vi.useFakeTimers();
      http.route(
        { match: (req) => pathOf(req) === '/drug/ndc.json', respond: SERVER_ERROR },
        { match: () => true, respond: NO_MATCHES },
      );
      const controller = new AbortController();
      const pending = runToolContract(
        drugProfileTool,
        { drug: 'metformin' },
        { context: { signal: controller.signal } },
      );

      const ndc = () => http.calls.filter((call) => pathOf(call.request) === '/drug/ndc.json');
      for (let i = 0; i < 200 && ndc().length === 0; i++) await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(0);
      expect(ndc()).toHaveLength(1);

      controller.abort();
      const result = await pending;

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      // Only the first round (label, approval selection) and the second (the
      // unrestricted label, the one ndc attempt) went upstream (#85).
      expect(http.calls.map((call) => pathOf(call.request))).toEqual([
        '/drug/label.json',
        '/drug/drugsfda.json',
        '/drug/label.json',
        '/drug/ndc.json',
      ]);
    });
  });

  /**
   * One profile deadline across every round (#85), through the real service and
   * the real `withRetry` on fake timers. The approval selection holds the first
   * round for 14 s, then the shortage search never answers: its attempts (15 s,
   * 15 s, then the 3 s left) and backoffs (1 s, 2 s) end on the profile's
   * instant, 50 s from the start. A deadline of its own, started with the
   * fan-out, would hold the call open until 62 s — past the 60 s client default.
   */
  describe('profile deadline', () => {
    const pathIs = (path: string) => (req: Request) => new URL(req.url).pathname === path;
    let random: { mockRestore: () => void };

    beforeEach(() => {
      vi.useFakeTimers();
      // Jitter at its midpoint, so backoff is exactly 1 s, then 2 s.
      random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.useRealTimers();
      random.mockRestore();
    });

    it('cuts a sub-query that never answers at 50 s from the start, as a degraded timeout', async () => {
      http.route(
        {
          match: pathIs('/drug/drugsfda.json'),
          respond: () =>
            new Promise<Response>((resolve) =>
              setTimeout(() => resolve(page(applications(APPLICATION_ROWS.lipitor), 1)), 14_000),
            ),
        },
        { match: pathIs('/drug/label.json'), respond: () => page([LABELS.lipitorViatris], 1) },
        {
          match: pathIs('/drug/shortages.json'),
          respond: (req) =>
            new Promise<Response>((_resolve, reject) => {
              req.signal.addEventListener('abort', () => reject(req.signal.reason), {
                once: true,
              });
            }),
        },
        { match: () => true, respond: NO_MATCHES },
      );
      const start = Date.now();
      let settledAt: number | undefined;
      const pending = runToolContract(drugProfileTool, { drug: 'Lipitor' });
      const settle = () => {
        settledAt = Date.now();
      };
      pending.then(settle, settle);

      await vi.advanceTimersByTimeAsync(49_999);
      expect(settledAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 50 && settledAt === undefined; i++) await vi.advanceTimersByTimeAsync(0);

      expect(settledAt).toBe(start + 50_000);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        approval: { applicationNumber: string } | null;
        shortage: unknown;
        degraded: Array<{ section: string; reason: string; message: string }>;
      };
      expect(structured.approval?.applicationNumber).toBe('NDA020702');
      expect(structured.shortage).toBeNull();
      expect(structured.degraded).toEqual([
        { section: 'shortage', reason: 'timeout', message: expect.stringContaining('deadline') },
      ]);
      expect(
        http.calls.filter((call) => pathIs('/drug/shortages.json')(call.request)),
      ).toHaveLength(3);
    });

    /**
     * Every request hangs: the first round's retries end at 48 s, the second
     * round gets the 2 s left, and the fan-out round starts on the deadline
     * itself. With nothing left, it must send nothing — a request issued with
     * no budget still reaches openFDA before its 0 ms timeout cuts it.
     */
    it('sends no request once the profile deadline has passed', async () => {
      const started: number[] = [];
      http.route({
        match: () => true,
        respond: (req) => {
          started.push(Date.now());
          return new Promise<Response>((_resolve, reject) => {
            req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
          });
        },
      });
      const start = Date.now();
      let settledAt: number | undefined;
      const pending = runToolContract(drugProfileTool, { drug: 'Lipitor' });
      const settle = () => {
        settledAt = Date.now();
      };
      pending.then(settle, settle);

      await vi.advanceTimersByTimeAsync(50_000);
      for (let i = 0; i < 50 && settledAt === undefined; i++) await vi.advanceTimersByTimeAsync(0);

      expect(settledAt).toBe(start + 50_000);
      expect(started.every((at) => at < start + 50_000)).toBe(true);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        degraded: Array<{ section: string; reason: string }>;
      };
      expect(structured.degraded.map((d) => d.reason)).toEqual(
        structured.degraded.map(() => 'timeout'),
      );
    });
  });
});

/**
 * The approval rule at its own seam (#85): every application ranked on its own
 * products, tier by tier, the lowest application number breaking a tie. The
 * corpus rows are each input's live selection matches. Each precedence pair
 * gives the winner nothing but its one tier — the loser is better on every
 * later tier and carries the lower number — and each look-alike pair shows a
 * near miss that earns no tier. The handler tests above prove the wiring.
 */
describe('pickApplication', () => {
  const pick = (rows: ApplicationRow[], input: string, key: string) =>
    pickApplication(applications(rows), input, key)?.application_number;

  it.each([
    // [input, fan-out key, rows, pick]
    ['metformin', 'metformin', APPLICATION_ROWS.metformin, 'NDA020357'],
    ['adalimumab', 'adalimumab', APPLICATION_ROWS.adalimumab, 'BLA125057'],
    ['Humira', 'ADALIMUMAB', APPLICATION_ROWS.humira, 'BLA125057'],
    ['atorvastatin', 'atorvastatin', APPLICATION_ROWS.atorvastatin, 'NDA020702'],
    ['Lipitor', 'ATORVASTATIN CALCIUM', APPLICATION_ROWS.lipitor, 'NDA020702'],
    ['apixaban', 'apixaban', APPLICATION_ROWS.apixaban, 'NDA202155'],
    ['Eliquis', 'APIXABAN', APPLICATION_ROWS.eliquis, 'NDA202155'],
    ['insulin glargine', 'insulin glargine', APPLICATION_ROWS.insulinGlargine, 'BLA021081'],
    ['trastuzumab', 'trastuzumab', APPLICATION_ROWS.trastuzumab, 'BLA103792'],
    ['ibuprofen', 'ibuprofen', APPLICATION_ROWS.ibuprofen, 'NDA018989'],
    ['warfarin', 'warfarin', APPLICATION_ROWS.warfarin, 'NDA009218'],
    [
      'sitagliptin and metformin',
      'sitagliptin and metformin',
      APPLICATION_ROWS.sitagliptinAndMetformin,
      'NDA022044',
    ],
    ['Jantoven', 'WARFARIN SODIUM', APPLICATION_ROWS.jantoven, 'ANDA040416'],
    ['troglitazone', 'troglitazone', APPLICATION_ROWS.troglitazone, 'NDA020719'],
  ] as const)('%s (key %j) picks from its corpus', (input, key, rows, expected) => {
    expect(pick([...rows] as ApplicationRow[], input, key)).toBe(expected);
  });

  it.each([
    // [why, input, key, rows, pick]
    [
      'a brand equal to the input outranks every later tier',
      'Jantoven',
      'WARFARIN SODIUM',
      [
        ['NDA009218', 'BMS', [['COUMADIN', 'Prescription', 'Yes', ['WARFARIN SODIUM']]]],
        ['ANDA040416', 'UPSHER', [['JANTOVEN', 'Discontinued', 'No', ['WARFARIN SODIUM']]]],
      ],
      'ANDA040416',
    ],
    [
      'a brand equal to the input outranks a one-ingredient match for a single name',
      'Prevpac',
      'LANSOPRAZOLE',
      [
        ['NDA020406', 'TAKEDA', [['PREVACID', 'Prescription', 'Yes', ['LANSOPRAZOLE']]]],
        [
          'NDA050757',
          'TAKEDA',
          [['PREVPAC', 'Discontinued', 'No', ['AMOXICILLIN', 'CLARITHROMYCIN', 'LANSOPRAZOLE']]],
        ],
      ],
      'NDA050757',
    ],
    [
      'a brand named for its ingredient is no brand',
      'apixaban',
      'apixaban',
      [
        ['NDA202155', 'BMS', [['ELIQUIS', 'Prescription', 'Yes', ['APIXABAN']]]],
        ['NDA200446', 'LUPIN', [['APIXABAN', 'Prescription', 'No', ['APIXABAN']]]],
      ],
      'NDA202155',
    ],
    [
      'a brand of ingredient names and connectives is no brand',
      'sitagliptin and metformin hydrochloride',
      'sitagliptin and metformin hydrochloride',
      [
        [
          'NDA022044',
          'MSD',
          [['JANUMET', 'Prescription', 'Yes', ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN']]],
        ],
        [
          'ANDA002426',
          'APOTEX',
          [
            [
              'SITAGLIPTIN AND METFORMIN HYDROCHLORIDE',
              'Prescription',
              'Yes',
              ['METFORMIN HYDROCHLORIDE', 'SITAGLIPTIN'],
            ],
          ],
        ],
      ],
      'NDA022044',
    ],
    [
      'one ingredient outranks a combination for a single name',
      'metformin',
      'metformin',
      [
        [
          'NDA005000',
          'A',
          [['DUO', 'Prescription', 'Yes', ['GLIPIZIDE', 'METFORMIN HYDROCHLORIDE']]],
        ],
        ['ANDA076869', 'B', [['M', 'Discontinued', 'No', ['METFORMIN HYDROCHLORIDE']]]],
      ],
      'ANDA076869',
    ],
    [
      'a combination outranks one ingredient for a combination name',
      'glipizide and metformin',
      'glipizide and metformin',
      [
        ['NDA005000', 'A', [['M', 'Prescription', 'Yes', ['METFORMIN HYDROCHLORIDE']]]],
        [
          'ANDA076869',
          'B',
          [['DUO', 'Discontinued', 'No', ['GLIPIZIDE', 'METFORMIN HYDROCHLORIDE']]],
        ],
      ],
      'ANDA076869',
    ],
    [
      'one ingredient outranks a combination even when only the combination is plain',
      'insulin glargine',
      'insulin glargine',
      [
        [
          'NDA208673',
          'A',
          [['SOLIQUA', 'Prescription', 'Yes', ['INSULIN GLARGINE', 'LIXISENATIDE']]],
        ],
        ['BLA761201', 'B', [['SEMGLEE', 'Discontinued', 'No', ['INSULIN GLARGINE-YFGN']]]],
      ],
      'BLA761201',
    ],
    [
      'an ingredient without a biologic suffix outranks a suffixed one',
      'adalimumab',
      'adalimumab',
      [
        ['BLA100000', 'A', [['BIOSIM', 'Prescription', 'Yes', ['ADALIMUMAB-AACF']]]],
        ['BLA125057', 'B', [['HUMIRA', 'Discontinued', 'No', ['ADALIMUMAB']]]],
      ],
      'BLA125057',
    ],
    [
      "an ingredient led by the key's words outranks one that is not",
      'trastuzumab',
      'trastuzumab',
      [
        ['BLA100000', 'A', [['KADCYLA', 'Prescription', 'Yes', ['ADO-TRASTUZUMAB EMTANSINE']]]],
        ['BLA103792', 'B', [['HERCEPTIN', 'Discontinued', 'No', ['TRASTUZUMAB']]]],
      ],
      'BLA103792',
    ],
    [
      'a reference drug outranks NDA over ANDA and every later tier',
      'atorvastatin',
      'atorvastatin',
      [
        ['NDA000100', 'A', [['A', 'Prescription', 'No', ['ATORVASTATIN CALCIUM']]]],
        ['ANDA020702', 'B', [['B', 'Discontinued', 'Yes', ['ATORVASTATIN CALCIUM']]]],
      ],
      'ANDA020702',
    ],
    [
      'an NDA or BLA outranks an ANDA',
      'atorvastatin',
      'atorvastatin',
      [
        ['ANDA000100', 'A', [['A', 'Prescription', 'No', ['ATORVASTATIN CALCIUM']]]],
        ['NDA020702', 'B', [['B', 'Discontinued', 'No', ['ATORVASTATIN CALCIUM']]]],
      ],
      'NDA020702',
    ],
    [
      'a marketed product outranks a discontinued one',
      'apixaban',
      'apixaban',
      [
        ['NDA100000', 'A', [['A', 'Discontinued', 'No', ['APIXABAN']]]],
        ['NDA202155', 'B', [['B', 'Prescription', 'No', ['APIXABAN']]]],
      ],
      'NDA202155',
    ],
    [
      'an over-the-counter product is marketed',
      'ibuprofen',
      'ibuprofen',
      [
        ['NDA017463', 'A', [['A', 'Discontinued', 'Yes', ['IBUPROFEN']]]],
        ['NDA018989', 'B', [['B', 'Over-the-counter', 'Yes', ['IBUPROFEN']]]],
      ],
      'NDA018989',
    ],
    [
      'a discontinued product outranks a tentative approval',
      'apixaban',
      'apixaban',
      [
        ['NDA100000', 'A', [['A', 'None (Tentative Approval)', 'No', ['APIXABAN']]]],
        ['NDA202155', 'B', [['B', 'Discontinued', 'No', ['APIXABAN']]]],
      ],
      'NDA202155',
    ],
    [
      'an application ranks as its best product',
      'apixaban',
      'apixaban',
      [
        ['NDA100000', 'A', [['A', 'Prescription', 'No', ['APIXABAN']]]],
        [
          'NDA202155',
          'B',
          [
            ['B', 'Discontinued', 'No', ['APIXABAN']],
            ['B SPRINKLE', 'Prescription', 'Yes', ['APIXABAN']],
          ],
        ],
      ],
      'NDA202155',
    ],
    [
      'an equal rank goes to the lowest application number, in any order',
      'troglitazone',
      'troglitazone',
      [
        ['NDA020720', 'A', [['REZULIN', 'Discontinued', 'No', ['TROGLITAZONE']]]],
        ['NDA020719', 'B', [['PRELAY', 'Discontinued', 'No', ['TROGLITAZONE']]]],
      ],
      'NDA020719',
    ],
  ] as const)('%s', (_why, input, key, rows, expected) => {
    expect(pick(rows as unknown as ApplicationRow[], input, key)).toBe(expected);
    // Each pair decides on its tier alone, so the order the applications arrive in cannot matter.
    expect(pick([...rows].reverse() as unknown as ApplicationRow[], input, key)).toBe(expected);
  });

  it('ranks on products, never the openfda block', () => {
    // openFDA drops HERZUMA's suffix from its block; read there, HERZUMA would
    // pass as plain trastuzumab and win on the lower number.
    const [herzuma, herceptin] = applications([
      ['BLA100001', 'CELLTRION', [['HERZUMA', 'Prescription', 'No', ['TRASTUZUMAB-PKRB']]]],
      ['BLA103792', 'GENENTECH', [['HERCEPTIN', 'Prescription', 'No', ['TRASTUZUMAB']]]],
    ]);
    const harmonized = { ...herzuma!, openfda: { generic_name: ['TRASTUZUMAB'] } };

    expect(
      pickApplication([harmonized, herceptin!], 'trastuzumab', 'trastuzumab')?.application_number,
    ).toBe('BLA103792');
  });

  it('ranks an application with no products below any that match', () => {
    expect(
      pickApplication(
        [
          { application_number: 'NDA000001', sponsor_name: 'SPARSE' },
          ...applications([
            ['ANDA076869', 'B', [['M', 'Prescription', 'No', ['METFORMIN HYDROCHLORIDE']]]],
          ]),
        ],
        'metformin',
        'metformin',
      )?.application_number,
    ).toBe('ANDA076869');
  });

  it('picks nothing from no applications', () => {
    expect(pickApplication([], 'metformin', 'metformin')).toBeUndefined();
  });
});

/**
 * The fan-out key rule at its own seam (#82): the typed term when its words occur,
 * in order and case-insensitively, in the resolved generic name; otherwise the
 * resolved generic, then the brand, then the term, with #25's blank guard. The
 * handler tests above prove the wiring; this table is the rule.
 */
describe('fanOutKeyFor', () => {
  it.each([
    // [term, generic, brand, key, why]
    ['adalimumab', 'ADALIMUMAB-AACF', 'IDACIO', 'adalimumab', 'a hyphen ends a word'],
    ['metformin', 'METFORMIN HYDROCHLORIDE', 'Glucophage', 'metformin', 'a salt name'],
    ['metformin', 'METFORMIN ER 500 MG', undefined, 'metformin', 'a strength suffix'],
    ['insulin glargine', 'INSULIN GLARGINE-YFGN', undefined, 'insulin glargine', 'two words'],
    ['Insulin  Glargine', 'INSULIN GLARGINE', undefined, 'Insulin  Glargine', 'spacing, case'],
    ['glargine insulin', 'INSULIN GLARGINE', undefined, 'INSULIN GLARGINE', 'word order'],
    [
      'sitagliptin and metformin',
      'SITAGLIPTIN AND METFORMIN HYDROCHLORIDE',
      'Janumet',
      'sitagliptin and metformin',
      'a combination',
    ],
    ['metform', 'METFORMIN HCL', undefined, 'METFORMIN HCL', 'a prefix, not a word'],
    ['formin', 'METFORMIN', undefined, 'METFORMIN', 'a suffix, not a word'],
    ['metfor.*', 'METFORMIN HCL', undefined, 'METFORMIN HCL', 'regex syntax is literal'],
    ['café', 'CAFÉ EXTRACT', undefined, 'café', 'non-ASCII letters'],
    ['a a b', 'A A A B', undefined, 'a a b', 'a repeated first word'],
    ['a b a b c', 'A B A B A B C', undefined, 'a b a b c', 'an overlapping restart'],
    ['a a b', 'A A A', undefined, 'A A A', 'a near miss on repeated words'],
    [
      'metformin hydrochloride extended',
      'METFORMIN HYDROCHLORIDE',
      undefined,
      'METFORMIN HYDROCHLORIDE',
      'more words than the generic',
    ],
    ['---', 'METFORMIN', undefined, 'METFORMIN', 'a term with no words'],
    ['Glucophage', 'metformin hydrochloride', 'Glucophage', 'metformin hydrochloride', 'a brand'],
    ['Lipitor', 'ATORVASTATIN CALCIUM', 'Lipitor', 'ATORVASTATIN CALCIUM', 'a brand'],
    ['metformin', null, 'Glucophage', 'Glucophage', 'no generic resolved'],
    ['notadrug', null, undefined, 'notadrug', 'nothing resolved'],
    ['metformin', '"', undefined, 'metformin', 'a blank resolved generic (#25)'],
    ['metform', '  METFORMIN HCL  ', undefined, 'METFORMIN HCL', 'a padded resolved generic'],
  ] as const)('%j in %j (brand %j) keys %j — %s', (term, generic, brand, key, _why) => {
    expect(fanOutKeyFor(term, generic, brand)).toBe(key);
  });

  /**
   * The match reads caller text, so it is timed on its worst shapes across a 64×
   * span on this thread's CPU time, growing by doubling and checking the bound at
   * each size. A naive rescan from every start goes quadratic on the first shape.
   */
  describe('timing', { timeout: 120_000 }, () => {
    const shapes: [string, (n: number) => [string, string]][] = [
      ['repeated words with a near miss', (n) => [`${'a '.repeat(n / 4)}b`, 'a '.repeat(n / 2)]],
      [
        'one long line ending in a break',
        (n) => [`${'§1 x'.repeat(n / 4)}\ny`, `${'§1 x'.repeat(n / 4)}\nz`],
      ],
      ['breaks throughout', (n) => ['  \r\n'.repeat(n / 4), '  \r\n'.repeat(n / 4)]],
      ['a long digit run', (n) => ['1'.repeat(n), '1'.repeat(n)]],
    ];

    it.each(shapes)('stays linear on %s', (_name, build) => {
      const run = ([term, generic]: [string, string]) => fanOutKeyFor(term, generic, undefined);
      let ratio = 0;
      for (let n = 10_000; n <= 320_000; n *= 2) {
        const { t5k, t320k: tN } = linearTiming(run, build(5_000), build(n));
        expect(tN).toBeLessThan(500_000);
        ratio = tN / t5k;
      }
      expect(ratio).toBeLessThan(256);
    });
  });
});

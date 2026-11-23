import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfda/openfda-service.js', () => ({
  getOpenFdaService: vi.fn(),
}));

// No canvas unless a test stages one.
vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(() => undefined),
}));

import { z } from '@cyanheads/mcp-ts-core';
import { resetServerConfig } from '@/config/server-config.js';
import { searchDrugApprovalsTool } from '@/mcp-server/tools/definitions/search-drug-approvals.tool.js';
import { OBJECT_ARRAY_PATHS } from '@/mcp-server/tools/field-catalog.js';
import { invalidCursorError } from '@/mcp-server/tools/pagination-cursor.js';
import { paginationLimitReachedError } from '@/mcp-server/tools/schema-utils.js';
import { findConjoinedArrayClauses } from '@/mcp-server/tools/search-clauses.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getOpenFdaService } from '@/services/openfda/openfda-service.js';
import { codeLiteralsIn, renderCommonMark } from '../../../helpers/commonmark.js';
import { textOf } from '../../../helpers/content.js';

const mockQuery = vi.fn();

/**
 * Live Orange Book product records (drug/orangebook, 2026-11-22): ELIQUIS NDA
 * 202155 product 001 with its patents, their pediatric (`*PED`) extensions, and
 * two exclusivities; and TRANXENE 017105/007, approved before 1982 — no
 * approval_date, no patents or exclusivity.
 */
const OB_ELIQUIS = {
  approval_date: '20121228',
  exclusivity: [
    { exclusivity_code: 'NPP', exclusivity_expiration_date: '20280417' },
    { exclusivity_code: 'PED', exclusivity_expiration_date: '20281017' },
  ],
  patents: [
    {
      patent_number: '6967208',
      expiration_date: '20261121',
      drug_substance_flag: true,
      drug_product_flag: true,
      patent_use_code: 'U-1729',
      patent_submission_date: '20130125',
    },
    { patent_number: '6967208*PED', expiration_date: '20270521' },
    {
      patent_number: '9326945',
      expiration_date: '20310224',
      drug_product_flag: true,
      patent_submission_date: '20160526',
    },
    { patent_number: '9326945*PED', expiration_date: '20310824' },
  ],
  product_number: '001',
  products: [
    {
      active_ingredients: [{ name: 'APIXABAN', strength: '2.5MG' }],
      brand_name: 'ELIQUIS',
      application_name: 'BRISTOL MYERS SQUIBB',
      application_type: 'N',
      application_number: '202155',
      therapeutic_equivalence_codes: ['AB'],
      reference_listed_drug: true,
      reference_standard: false,
      marketing_status: 'HUMAN PRESCRIPTION DRUG',
      application_full_name: 'BRISTOL MYERS SQUIBB CO PHARMACEUTICAL RESEARCH INSTITUTE',
      dosage_form: 'TABLET',
      route: 'ORAL',
    },
  ],
};

const OB_PRIOR_1982 = {
  approved_prior_to_1982: true,
  product_number: '007',
  products: [
    {
      active_ingredients: [{ name: 'CLORAZEPATE DIPOTASSIUM', strength: '7.5MG' }],
      brand_name: 'TRANXENE',
      application_name: 'AJENAT PHARMS',
      application_type: 'N',
      application_number: '017105',
      reference_listed_drug: true,
      reference_standard: false,
      marketing_status: 'HUMAN PRESCRIPTION DRUG',
      application_full_name: 'AJENAT PHARMACEUTICALS LLC',
      dosage_form: 'TABLET',
      route: 'ORAL',
    },
  ],
};

/**
 * Live Complete Response Letters (transparency/crl, 2026-11-22): BLA 761458,
 * filed under two application numbers, with an empty office list and a null
 * approver title — its text cut to its first lines — and the one letter that
 * carries only four fields.
 */
const CRL_LETTER = {
  letter_date: '12/16/2025',
  approver_title: null,
  file_name: 'CRL_BLA761458_20251216.pdf',
  letter_year: '2025',
  approval_status: 'Unapproved',
  approver_name: 'Center for Drug Evaluation and Research',
  approver_center: [],
  company_rep: 'David Colton',
  company_address: '200 Cambridge Park Drive\nCambridge, Massachusetts 02140',
  company_name: 'GlaxoSmithKline LLC',
  text: 'f ¢ PN U.S. FOOD & DRUG\n“en\n\nADMINISTRATION\n\nBLA 761458/Original 2\nCOMPLETE RESPONSE',
  application_number: ['BLA 761458/Original 2', 'BLA 761458'],
  letter_type: 'COMPLETE RESPONSE',
};

const CRL_SPARSE = {
  letter_date: '02/27/2026',
  approval_status: 'Unapproved',
  file_name: 'Under Review for Release',
  company_name: 'Chiesi Farmaceutici S.p.A',
};

/** Every scalar leaf under `value`, as `path=value`. */
function leaves(value: unknown, path = ''): string[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  }
  return [`${path}=${String(value)}`];
}

describe('openfda_search_drug_approvals', () => {
  let ctx: ReturnType<typeof createMockContext<typeof searchDrugApprovalsTool.errors>>;

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(getOpenFdaService).mockReturnValue({ query: mockQuery } as never);
    ctx = createMockContext({ errors: searchDrugApprovalsTool.errors });
  });

  it('queries drug/drugsfda endpoint', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345', sponsor_name: 'Pfizer' }],
    });

    const result = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![0]).toBe('drug/drugsfda');
    expect(result.results[0]!.application_number).toBe('NDA012345');
  });

  // #92 — the endpoint's default page size reaches the request and meta.limit.
  it('pages drug/drugsfda at its default of 25 when limit is omitted', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' },
      results: [],
    });

    const result = await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({}),
      ctx,
    );

    expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    expect(result.meta.limit).toBe(25);
  });

  // #88 — a bare browse is newest first by each application's latest submission.
  describe('default sort (#88)', () => {
    const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

    it('sends submissions.submission_status_date:desc with neither search nor sort', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugApprovalsTool.handler(searchDrugApprovalsTool.input.parse({}), ctx);

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({
        sort: 'submissions.submission_status_date:desc',
      });
    });

    it('sends no sort when the call names a search alone', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugApprovalsTool.handler(
        searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: undefined });
    });

    it('sends an explicit sort as given', async () => {
      mockQuery.mockResolvedValue(EMPTY);

      await searchDrugApprovalsTool.handler(
        searchDrugApprovalsTool.input.parse({ sort: 'application_number:asc' }),
        ctx,
      );

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ sort: 'application_number:asc' });
    });

    it('states the newest-first browse on search and each default sort, by latest submission, on sort', () => {
      const shape = searchDrugApprovalsTool.input.shape;
      expect(shape.search.description).toContain('Omit to browse newest first.');
      expect(shape.sort.description).toContain(
        "With neither search nor sort, records come newest first by submissions.submission_status_date:desc (an application's latest submission status date, supplements included, not its approval date; approval_date:desc on orangebook, letter_date:desc on crl).",
      );
    });
  });

  // #89 — openFDA fills openfda.* on harmonized applications only, so a brand
  // search on openfda.brand_name misses applications products.brand_name finds.
  describe('product-name field (#89)', () => {
    it('leads the search examples with products.brand_name', () => {
      const description = searchDrugApprovalsTool.input.shape.search.description ?? '';
      expect(description).toMatch(/^openFDA search query, e\.g\. products\.brand_name:"/);
      expect(description).not.toContain('openfda.brand_name:"humira"');
    });

    it('names products.brand_name in the empty-result notice and scopes openfda.* to harmonized applications', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'openfda.brand_name:"eliquis"',
      });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toContain('products.brand_name');
      expect(notice).toContain('openfda.* covers harmonized applications only');
      // The six-field hint reaches the product-name field.
      expect(notice).toMatch(/Key searchable fields for drug\/drugsfda: [^.]*products\.brand_name/);
      // A lowercase quoted sponsor matches nothing: the hint says how it is stored.
      expect(notice).toContain(
        'sponsor_name for the applicant, stored uppercase (sponsor_name:"PFIZER")',
      );
    });

    it('heads an application openFDA never harmonized with its products[] brand name', () => {
      const content = searchDrugApprovalsTool.format!({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [
          {
            application_number: 'NDA202155',
            sponsor_name: 'BRISTOL MYERS SQUIBB',
            products: [
              {
                brand_name: 'ELIQUIS',
                active_ingredients: [{ name: 'APIXABAN', strength: '2.5MG' }],
              },
            ],
          },
        ],
      });

      const text = textOf(content);
      expect(text).toContain('### ELIQUIS\n');
      expect(text).not.toContain('### NDA202155');
    });
  });

  it('populates enrichment.totalResults', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 15, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345' }],
    });

    await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalResults).toBe(15);
  });

  it('echoes search filter in enrichment.effectiveQuery', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [{ application_number: 'NDA012345' }],
    });

    await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'sponsor_name:"PFIZER"' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('sponsor_name:"PFIZER"');
  });

  it('sets enrichment.notice when empty', async () => {
    mockQuery.mockResolvedValue({
      meta: { total: 0, skip: 0, limit: 10, lastUpdated: '' },
      results: [],
    });

    await searchDrugApprovalsTool.handler(
      searchDrugApprovalsTool.input.parse({ search: 'nonexistent' }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no drug approvals/i);
  });

  // #75 wiring: the shared search schema reads a URL-form `+` separator as a
  // space, so the service and the echo carry the spaced string.
  describe('search wiring (#75)', () => {
    const resultText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      String((result.structuredContent as { notice?: string }).notice);

    it('sends and echoes a URL-form +AND+ search with spaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [{ application_number: 'NDA012345' }],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'sponsor_name:"PFIZER"+AND+submissions.submission_type:"ORIG"',
      });

      const spaced = 'sponsor_name:"PFIZER" AND submissions.submission_type:"ORIG"';
      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: spaced });
      expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(spaced);
      expect(resultText(result)).toContain(`Query: \`${spaced}\``);
    });

    it('adds the phrase-plus hint to a zero-total notice on both surfaces', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 10, lastUpdated: '2026-10-26' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'openfda.brand_name.exact:"HUMIRA+PEN"',
      });

      expect(noticeOf(result)).toContain('write them with spaces: `"HUMIRA PEN"`.');
      expect(resultText(result)).toContain(`> ${noticeOf(result)}`);
    });
  });

  /**
   * #93 adds `dataset`; a call that names none sends the request and returns
   * both surfaces exactly as before. Pinned against the pre-change code.
   */
  describe('a call without dataset (#93 characterization)', () => {
    const RECORD = {
      application_number: 'NDA202155',
      sponsor_name: 'BRISTOL MYERS SQUIBB',
      openfda: {
        brand_name: ['ELIQUIS'],
        generic_name: ['APIXABAN'],
        route: ['ORAL'],
        product_type: ['HUMAN PRESCRIPTION DRUG'],
        rxcui: ['1364430'],
      },
      products: [
        {
          product_number: '001',
          reference_drug: 'Yes',
          brand_name: 'ELIQUIS',
          active_ingredients: [{ name: 'APIXABAN', strength: '2.5MG' }],
          dosage_form: 'TABLET',
          route: 'ORAL',
          marketing_status: 'Prescription',
          te_code: 'AB',
        },
      ],
      submissions: [
        {
          submission_type: 'ORIG',
          submission_number: '1',
          submission_status: 'AP',
          submission_status_date: '20121228',
          review_priority: 'PRIORITY',
          submission_class_code: 'TYPE 1',
        },
      ],
    };
    const textBlocks = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));

    it('sends drug/drugsfda with the default page, the newest-first sort, and no search', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [RECORD],
      });

      await runToolContract(searchDrugApprovalsTool, {});

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0]![0]).toBe('drug/drugsfda');
      expect(mockQuery.mock.calls[0]![1]).toEqual({
        search: undefined,
        sort: 'submissions.submission_status_date:desc',
        limit: 25,
        skip: 0,
      });
    });

    it('returns the record whole on structuredContent and renders it field by field in content[]', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [RECORD],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {});

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [RECORD],
        totalResults: 1,
      });
      expect(textBlocks(result)[0]).toBe(
        [
          '**1 total results** (returned: 1, skip: 0, limit: 25) | Data updated: 2026-11-20\n',
          '### ELIQUIS',
          '**Application:** NDA202155 | **Sponsor:** BRISTOL MYERS SQUIBB',
          '**Brand:** ELIQUIS | **Generic:** APIXABAN',
          '**Route:** ORAL',
          '**Type:** HUMAN PRESCRIPTION DRUG',
          '**Brand name:** ELIQUIS',
          '**Generic name:** APIXABAN',
          '**Rxcui:** 1364430',
          '**Products:**',
          '- ELIQUIS | (APIXABAN 2.5MG) | TABLET | ORAL | Prescription',
          '**Product number:** 001',
          '**Reference drug:** Yes',
          '**Te code:** AB',
          '',
          '**Submissions:**',
          '- ORIG | #1 | AP | 20121228 | (PRIORITY)',
          '**Submission class code:** TYPE 1',
          '',
          '',
        ].join('\n'),
      );
    });

    it('answers an empty page with the Drugs@FDA miss line and notice', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'sponsor_name:"NOBODY"',
      });
      const notice = (result.structuredContent as { notice?: string }).notice;

      expect(notice).toBe(
        'No drug approvals matched the query. Try broader terms, check field names — products.brand_name for a product name (openfda.* covers harmonized applications only), sponsor_name for the applicant, stored uppercase (sponsor_name:"PFIZER") — or remove filters. Key searchable fields for drug/drugsfda: application_number, sponsor_name, products.brand_name, submissions.submission_type, submissions.submission_status, submissions.submission_status_date. Call openfda_describe_fields({ endpoint: "drug/drugsfda" }) for the full list.',
      );
      expect(textBlocks(result)[0]).toBe(
        '**0 total results** (returned: 0, skip: 0, limit: 25) | Data updated: 2026-11-20\n\nNo drug application records found.',
      );
    });
  });

  it('formats submissions list', () => {
    const content = searchDrugApprovalsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '2026-01-01' },
      results: [
        {
          application_number: 'NDA012345',
          sponsor_name: 'Pfizer',
          openfda: { brand_name: ['Lipitor'], generic_name: ['atorvastatin'] },
          submissions: [
            {
              submission_type: 'ORIG',
              submission_number: '1',
              submission_status: 'AP',
              submission_status_date: '19961217',
              review_priority: 'STANDARD',
            },
          ],
        },
      ],
    });

    const text = textOf(content);
    expect(text).toContain('Lipitor');
    expect(text).toContain('NDA012345');
    expect(text).toContain('Pfizer');
    expect(text).toContain('ORIG');
  });

  it('renders every submission in format — parity with structuredContent (no cap)', () => {
    const submissions = Array.from({ length: 15 }, (_, i) => ({
      submission_type: 'SUPPL',
      submission_number: String(i + 1),
      submission_status: 'AP',
    }));

    const content = searchDrugApprovalsTool.format!({
      meta: { total: 1, skip: 0, limit: 10, lastUpdated: '' },
      results: [{ application_number: 'NDA999', sponsor_name: 'Test', submissions }],
    });

    const text = textOf(content);
    // All 15 submissions render — entries 11–15 were previously capped at slice(0, 10).
    const submissionLines = text.split('\n').filter((l) => l.startsWith('- SUPPL'));
    expect(submissionLines).toHaveLength(15);
    expect(text).toContain('#15');
    expect(text).not.toContain('...');
  });

  /**
   * Under CommonMark a line right after a list item, with no blank line between,
   * continues that item — so the Submissions label rendered inside the last
   * product's `<li>` and the submissions joined the products list. Each
   * product's and submission's own fields still belong in its item.
   */
  it('ends the products and submissions lists before the next block, under CommonMark', () => {
    const text = textOf(
      searchDrugApprovalsTool.format!({
        meta: { total: 1, skip: 0, limit: 25, lastUpdated: '2026-11-10' },
        results: [
          {
            application_number: 'NDA202155',
            sponsor_name: 'BRISTOL MYERS SQUIBB',
            products: [
              { product_number: '001', brand_name: 'ELIQUIS', dosage_form: 'TABLET' },
              { product_number: '002', brand_name: 'ELIQUIS', dosage_form: 'TABLET' },
            ],
            submissions: [
              { submission_type: 'ORIG', submission_number: '1', submission_class_code: 'TYPE 1' },
              {
                submission_type: 'SUPPL',
                submission_number: '37',
                submission_class_code: 'LABELING',
              },
            ],
            record_note: 'top-level field',
          },
        ],
      }),
    );

    const html = renderCommonMark(text);
    expect([...html.matchAll(/<ul>/g)]).toHaveLength(2);
    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '');
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('Product number:</strong> 001');
    expect(items[3]).toContain('Submission class code:</strong> LABELING');
    expect(items.join('\n')).not.toContain('Submissions:');
    expect(items.join('\n')).not.toContain('Record note:');
    expect(html).toContain('<p><strong>Submissions:</strong></p>');
    expect(text).toContain('**Record note:** top-level field');
  });

  /* --- #93: the Orange Book and Complete Response Letters --- */

  const META = { total: 2, skip: 0, limit: 25, lastUpdated: '2026-11-20' };
  const textBlocks = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { notice?: string }).notice;
  const EMPTY = { meta: { total: 0, skip: 0, limit: 0, lastUpdated: '' }, results: [] };

  describe('dataset selects the endpoint, its bare-browse sort, and its page size (#93)', () => {
    /** [dataset, endpoint, bare-browse sort, default limit, cap] */
    const ROUTES = [
      ['orangebook', 'drug/orangebook', 'approval_date:desc', 25, 1000],
      ['crl', 'transparency/crl', 'letter_date:desc', 5, 75],
      ['drugsfda', 'drug/drugsfda', 'submissions.submission_status_date:desc', 25, 375],
    ] as const;

    it.each(ROUTES)(
      '%s queries %s sorted by %s, %i per page',
      async (dataset, endpoint, sort, limit) => {
        mockQuery.mockResolvedValue(EMPTY);

        const result = await runToolContract(searchDrugApprovalsTool, { dataset });

        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0]![0]).toBe(endpoint);
        expect(mockQuery.mock.calls[0]![1]).toEqual({ search: undefined, sort, limit, skip: 0 });
        expect((result.structuredContent as { meta: { limit: number } }).meta.limit).toBe(limit);
      },
    );

    it.each(ROUTES)(
      '%s: a search sends no sort, a sort is sent as given',
      async (dataset, endpoint) => {
        mockQuery.mockResolvedValue(EMPTY);

        await runToolContract(searchDrugApprovalsTool, { dataset, search: 'x:"1"' });
        await runToolContract(searchDrugApprovalsTool, { dataset, sort: 'file_name:asc' });

        expect(mockQuery.mock.calls.map(([e]) => e)).toEqual([endpoint, endpoint]);
        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ search: 'x:"1"', sort: undefined });
        expect(mockQuery.mock.calls[1]![1]).toMatchObject({ sort: 'file_name:asc' });
      },
    );

    it.each(ROUTES)(
      '%s clamps a limit above its cap',
      async (dataset, endpoint, _sort, _limit, cap) => {
        mockQuery.mockResolvedValue({
          meta: { total: cap * 3, skip: 0, limit: cap, lastUpdated: '2026-11-20' },
          results: Array.from({ length: cap }, (_, i) => ({ letter_date: `d-${i}` })),
        });

        const result = await runToolContract(searchDrugApprovalsTool, { dataset, limit: 5000 });
        const notice = `limit=5000 is above the ${cap}-record cap for ${endpoint}, so ${cap} was applied. The next page starts at skip=${cap}.`;

        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: cap });
        expect(noticeOf(result)).toBe(notice);
        expect(textBlocks(result).join('\n')).toContain(`> ${notice}`);
      },
    );

    it('takes a limit up to the selected dataset’s cap without a notice', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 75, skip: 0, limit: 75, lastUpdated: '2026-11-20' },
        results: [CRL_SPARSE],
      });

      const result = await runToolContract(searchDrugApprovalsTool, { dataset: 'crl', limit: 75 });

      expect(mockQuery.mock.calls[0]![1]).toMatchObject({ limit: 75 });
      expect(noticeOf(result)).toBeUndefined();
    });

    it('rejects an unknown dataset at the schema, before any request', async () => {
      const result = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'unii',
      } as never);

      expect(result.isError).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    describe('with OPENFDA_CLAMP_LIMITS=false', () => {
      beforeEach(() => {
        vi.stubEnv('OPENFDA_CLAMP_LIMITS', 'false');
        resetServerConfig();
      });

      afterEach(() => {
        vi.unstubAllEnvs();
        resetServerConfig();
      });

      type ErrorEnvelope = {
        error: { code: number; data?: { cap?: number; reason?: string }; message: string };
      };
      const STRICT = [
        ['crl', 'transparency/crl', 75],
        ['drugsfda', 'drug/drugsfda', 375],
      ] as const;

      it.each(STRICT)(
        'rejects %s limit=cap+1 as limit_above_cap',
        async (dataset, endpoint, cap) => {
          const result = await runToolContract(searchDrugApprovalsTool, {
            dataset,
            limit: cap + 1,
          });
          const { error } = result.structuredContent as ErrorEnvelope;

          expect(result.isError).toBe(true);
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.data?.reason).toBe('limit_above_cap');
          expect(error.data?.cap).toBe(cap);
          expect(error.message).toBe(`limit=${cap + 1} exceeds the ${cap} cap for ${endpoint}.`);
          expect(mockQuery).not.toHaveBeenCalled();
        },
      );

      it('rejects a limit above the largest cap (orangebook, 1000) at the schema', async () => {
        const result = await runToolContract(searchDrugApprovalsTool, { limit: 1001 });
        const { error } = result.structuredContent as ErrorEnvelope;

        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(mockQuery).not.toHaveBeenCalled();
      });
    });

    it.each([
      [
        'orangebook',
        'No Orange Book products matched the query.',
        'Key searchable fields for drug/orangebook: products.application_number, products.application_type, products.application_name, product_number, products.brand_name, approval_date.',
      ],
      [
        'crl',
        'No Complete Response Letters matched the query.',
        'Key searchable fields for transparency/crl: application_number, company_name, letter_date, letter_type, approval_status, letter_year.',
      ],
    ] as const)('names the %s fields in the empty-result notice', async (dataset, miss, hint) => {
      mockQuery.mockResolvedValue({
        meta: { total: 0, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, { dataset, search: 'x:"1"' });
      const notice = String(noticeOf(result));

      expect(notice.startsWith(miss)).toBe(true);
      expect(notice).toContain(hint);
      expect(notice).not.toContain('sponsor_name');
      expect(textBlocks(result).join('\n')).toContain(`> ${notice}`);
      // The empty page's body line names no one dataset: format() never sees it.
      expect(textBlocks(result)[0]?.split('\n\n')).toEqual([
        expect.stringMatching(/^\*\*0 total results\*\* /),
        'No drug application records found.',
      ]);
    });
  });

  describe('Orange Book products on both surfaces (#93)', () => {
    const ELIQUIS_LINES = [
      '### ELIQUIS — N 202155, product 001',
      '**Approval date:** 20121228',
      '**Product number:** 001',
      '**Products:**',
      '- ELIQUIS | (APIXABAN 2.5MG) | TABLET | ORAL | HUMAN PRESCRIPTION DRUG',
      '**Application name:** BRISTOL MYERS SQUIBB',
      '**Application type:** N',
      '**Application number:** 202155',
      '**Therapeutic equivalence codes:** AB',
      '**Reference listed drug:** true',
      '**Reference standard:** false',
      '**Application full name:** BRISTOL MYERS SQUIBB CO PHARMACEUTICAL RESEARCH INSTITUTE',
      '',
      '**Patents:**',
      '- 6967208 | expires 20261121 | U-1729',
      '**Drug substance flag:** true',
      '**Drug product flag:** true',
      '**Patent submission date:** 20130125',
      '- 6967208*PED | expires 20270521',
      '- 9326945 | expires 20310224',
      '**Drug product flag:** true',
      '**Patent submission date:** 20160526',
      '- 9326945*PED | expires 20310824',
      '',
      '**Exclusivity:**',
      '- NPP | expires 20280417',
      '- PED | expires 20281017',
      '',
      '',
    ];
    const PRIOR_1982_LINES = [
      '### TRANXENE — N 017105, product 007',
      '**Approved prior to 1982:** true',
      '**Product number:** 007',
      '**Products:**',
      '- TRANXENE | (CLORAZEPATE DIPOTASSIUM 7.5MG) | TABLET | ORAL | HUMAN PRESCRIPTION DRUG',
      '**Application name:** AJENAT PHARMS',
      '**Application type:** N',
      '**Application number:** 017105',
      '**Reference listed drug:** true',
      '**Reference standard:** false',
      '**Application full name:** AJENAT PHARMACEUTICALS LLC',
      '',
      '',
    ];

    it('returns each record whole and renders every field of it, patents and exclusivities included', async () => {
      mockQuery.mockResolvedValue({ meta: META, results: [OB_ELIQUIS, OB_PRIOR_1982] });

      const result = await runToolContract(searchDrugApprovalsTool, { dataset: 'orangebook' });

      expect(result.structuredContent).toEqual({
        meta: META,
        results: [OB_ELIQUIS, OB_PRIOR_1982],
        totalResults: 2,
      });
      expect(textBlocks(result)[0]).toBe(
        [
          '**2 total results** (returned: 2, skip: 0, limit: 25) | Data updated: 2026-11-20\n',
          ...ELIQUIS_LINES,
          ...PRIOR_1982_LINES,
        ].join('\n'),
      );
    });

    it('carries every scalar leaf of a record into content[]', () => {
      const text = textOf(
        searchDrugApprovalsTool.format!({ meta: META, results: [OB_ELIQUIS, OB_PRIOR_1982] }),
      );
      const missing = [...leaves(OB_ELIQUIS), ...leaves(OB_PRIOR_1982)].filter(
        (leaf) => !text.includes(leaf.slice(leaf.indexOf('=') + 1)),
      );
      expect(missing).toEqual([]);
    });

    it('renders products, patents, and exclusivity as three lists under CommonMark, *PED kept literal', () => {
      const html = renderCommonMark(
        textOf(searchDrugApprovalsTool.format!({ meta: META, results: [OB_ELIQUIS] })),
      );

      expect([...html.matchAll(/<ul>/g)]).toHaveLength(3);
      const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '');
      expect(items).toHaveLength(7);
      expect(items[1]).toContain('6967208 | expires 20261121 | U-1729');
      expect(items[1]).toContain('Drug substance flag:</strong> true');
      expect(items[2]).toBe('6967208*PED | expires 20270521');
      expect(items[6]).toBe('PED | expires 20281017');
      expect(html).not.toContain('<em>');
    });

    it('heads a sparse product with only the parts it carries, with no placeholder', () => {
      const text = textOf(
        searchDrugApprovalsTool.format!({
          meta: META,
          results: [{ product_number: '002', products: [{ application_number: '999999' }] }],
        }),
      );

      expect(text).toContain(
        '\n### 999999, product 002\n**Product number:** 002\n**Products:**\n- \n',
      );
      expect(text).toContain('**Application number:** 999999');
      expect(text).not.toMatch(/N\/A|Unknown|undefined/);
    });
  });

  describe('Complete Response Letters on both surfaces (#93)', () => {
    const LETTER_LINES = [
      '### BLA 761458/Original 2, BLA 761458 — COMPLETE RESPONSE — 12/16/2025',
      '**File name:** CRL_BLA761458_20251216.pdf',
      '**Letter year:** 2025',
      '**Approval status:** Unapproved',
      '**Approver name:** Center for Drug Evaluation and Research',
      '**Company rep:** David Colton',
      '**Company name:** GlaxoSmithKline LLC',
      '**Company address:** \n```\n200 Cambridge Park Drive\nCambridge, Massachusetts 02140\n```\n',
      `**Text:** \n\`\`\`\n${CRL_LETTER.text}\n\`\`\`\n`,
      '',
    ];
    const SPARSE_LINES = [
      '### 02/27/2026',
      '**Approval status:** Unapproved',
      '**File name:** Under Review for Release',
      '**Company name:** Chiesi Farmaceutici S.p.A',
      '',
    ];

    it('returns each letter whole and renders it, its address and text as fenced blocks', async () => {
      mockQuery.mockResolvedValue({ meta: META, results: [CRL_LETTER, CRL_SPARSE] });

      const result = await runToolContract(searchDrugApprovalsTool, { dataset: 'crl' });

      // meta.limit is the page size applied: the letters' default of 5.
      expect(result.structuredContent).toEqual({
        meta: { ...META, limit: 5 },
        results: [CRL_LETTER, CRL_SPARSE],
        totalResults: 2,
      });
      expect(textBlocks(result)[0]).toBe(
        [
          '**2 total results** (returned: 2, skip: 0, limit: 5) | Data updated: 2026-11-20\n',
          ...LETTER_LINES,
          ...SPARSE_LINES,
        ].join('\n'),
      );
    });

    it('carries every scalar leaf of a letter into content[]', () => {
      const text = textOf(
        searchDrugApprovalsTool.format!({ meta: META, results: [CRL_LETTER, CRL_SPARSE] }),
      );
      const missing = [...leaves(CRL_LETTER), ...leaves(CRL_SPARSE)].filter(
        (leaf) => !text.includes(leaf.slice(leaf.indexOf('=') + 1)),
      );
      expect(missing).toEqual([]);
    });

    it('round-trips a text holding backtick runs, a fence-like line, and indentation through its fence', () => {
      const tricky = [
        'Deficiency 1:',
        '```',
        '    The ``assay`` was not validated; see `Table 4`.',
        '````five````',
        '',
        '- not a list',
        '# not a heading',
      ].join('\n');
      const html = renderCommonMark(
        textOf(
          searchDrugApprovalsTool.format!({
            meta: META,
            results: [{ ...CRL_LETTER, text: tricky }],
          }),
        ),
      );

      expect(codeLiteralsIn(html)).toEqual([CRL_LETTER.company_address, tricky]);
      expect(html).not.toContain('<h1>');
      expect(html.match(/<h3>/g)).toHaveLength(1);
    });

    it('reads a CRLF text back with each break kept, as a fence reads them', () => {
      const html = renderCommonMark(
        textOf(
          searchDrugApprovalsTool.format!({
            meta: META,
            results: [{ ...CRL_LETTER, text: 'Line one\r\nLine two\rLine three' }],
          }),
        ),
      );

      expect(codeLiteralsIn(html)[1]).toBe('Line one\nLine two\nLine three');
    });

    it('renders a one-line address as a code span that reads back exactly', () => {
      const text = textOf(
        searchDrugApprovalsTool.format!({
          meta: META,
          results: [{ ...CRL_SPARSE, company_address: '1 Main St, *Suite* 2' }],
        }),
      );

      expect(text).toContain('**Company address:** `1 Main St, *Suite* 2`');
      expect(codeLiteralsIn(renderCommonMark(text))).toEqual(['1 Main St, *Suite* 2']);
    });

    it('renders a non-string text through the field lines rather than dropping it', () => {
      const text = textOf(
        searchDrugApprovalsTool.format!({
          meta: META,
          results: [{ ...CRL_SPARSE, text: ['page 1', 'page 2'] }],
        }),
      );

      expect(text).toContain('**Text:** page 1, page 2');
    });
  });

  describe('fields with a dotted identity key (#93)', () => {
    it('keeps an Orange Book product’s application and product number, and heads it with the application number', async () => {
      mockQuery.mockResolvedValue({ meta: { ...META, total: 1 }, results: [OB_ELIQUIS] });

      const result = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'orangebook',
        fields: ['patents.patent_number'],
      });
      const structured = result.structuredContent as {
        projected_fields?: string[];
        results: unknown[];
      };

      expect(structured.projected_fields).toEqual(['patents.patent_number']);
      expect(structured.results).toEqual([
        {
          products: [{ application_number: '202155', application_type: 'N' }],
          product_number: '001',
          patents: [
            { patent_number: '6967208' },
            { patent_number: '6967208*PED' },
            { patent_number: '9326945' },
            { patent_number: '9326945*PED' },
          ],
        },
      ]);
      expect(textBlocks(result)[0]).toContain(
        [
          '### products.application_number: 202155',
          '**Products:** [{"application_number":"202155","application_type":"N"}]',
          '**Product number:** 001',
          '**Patents:** [{"patent_number":"6967208"},{"patent_number":"6967208*PED"},{"patent_number":"9326945"},{"patent_number":"9326945*PED"}]',
          '',
        ].join('\n'),
      );
    });

    it('projects and renders a fields list naming the dotted identity path itself', async () => {
      mockQuery.mockResolvedValue({ meta: { ...META, total: 1 }, results: [OB_PRIOR_1982] });

      const result = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'orangebook',
        fields: ['products.application_number'],
      });

      expect((result.structuredContent as { results: unknown[] }).results).toEqual([
        {
          products: [{ application_number: '017105', application_type: 'N' }],
          product_number: '007',
        },
      ]);
      expect(textBlocks(result)[0]).toContain('\n### products.application_number: 017105\n');
    });

    it('keeps a letter’s three identity keys and drops its text when fields leaves it out', async () => {
      mockQuery.mockResolvedValue({ meta: { ...META, total: 1 }, results: [CRL_LETTER] });

      const result = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'crl',
        fields: ['company_name'],
      });

      expect((result.structuredContent as { results: unknown[] }).results).toEqual([
        {
          application_number: ['BLA 761458/Original 2', 'BLA 761458'],
          file_name: 'CRL_BLA761458_20251216.pdf',
          letter_date: '12/16/2025',
          company_name: 'GlaxoSmithKline LLC',
        },
      ]);
      const text = textBlocks(result)[0] ?? '';
      expect(text).toContain(
        [
          '### application_number: BLA 761458/Original 2, BLA 761458',
          '**File name:** CRL_BLA761458_20251216.pdf',
          '**Letter date:** 12/16/2025',
          '**Company name:** GlaxoSmithKline LLC',
        ].join('\n'),
      );
      expect(text).not.toContain('ADMINISTRATION');
    });
  });

  /**
   * #97 — a page that links its continuation carries next_cursor, bound to the
   * dataset's endpoint, the search, and the sort the call sent; following it
   * sends openFDA's search_after with no skip.
   */
  describe('cursor (#97)', () => {
    /** Answer a first page that links the next: `n` of `total` records. */
    const linkedPage = (records: Record<string, unknown>[], total: number) => ({
      meta: { total, skip: 0, limit: records.length, lastUpdated: '2026-11-20' },
      results: records,
      nextSearchAfter: '0=1794182400000;1=Xn23-qEBx5cBmaooYU3L',
    });
    const structuredOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.structuredContent as {
        error?: { data?: { reason?: string } };
        next_cursor?: string;
        results: unknown[];
      };

    it('advertises cursor with its base64url pattern and next_cursor as an optional output', () => {
      const input = z.toJSONSchema(searchDrugApprovalsTool.input) as unknown as {
        properties: Record<string, { pattern?: string }>;
        required?: string[];
      };
      expect(input.properties.cursor?.pattern).toBe('^[A-Za-z0-9_-]+$');
      expect(input.required ?? []).not.toContain('cursor');
      const output = z.toJSONSchema(searchDrugApprovalsTool.output) as unknown as {
        properties: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(output.properties.next_cursor?.type).toBe('string');
      expect(output.required ?? []).not.toContain('next_cursor');
    });

    it('declares the shared invalid_cursor and pagination_limit_reached entries', () => {
      expect(searchDrugApprovalsTool.errors).toContain(invalidCursorError);
      expect(searchDrugApprovalsTool.errors).toContain(paginationLimitReachedError);
    });

    it.each(['drugsfda', 'orangebook', 'crl'] as const)(
      '%s sends no searchAfter and returns no next_cursor key without a cursor or a link',
      async (dataset) => {
        mockQuery.mockResolvedValue({
          meta: { total: 3, skip: 0, limit: 25, lastUpdated: '2026-11-20' },
          results: [CRL_SPARSE],
        });

        const result = await searchDrugApprovalsTool.handler(
          searchDrugApprovalsTool.input.parse({ dataset }),
          ctx,
        );

        expect(mockQuery.mock.calls[0]![1].searchAfter).toBeUndefined();
        expect(Object.keys(result).sort()).toEqual(['meta', 'results']);
      },
    );

    it.each([
      ['orangebook', 'drug/orangebook', 'approval_date:desc', [OB_ELIQUIS, OB_PRIOR_1982]],
      ['crl', 'transparency/crl', 'letter_date:desc', [CRL_LETTER, CRL_SPARSE]],
    ] as const)(
      '%s issues next_cursor on a linked page and follows it on %s with %s',
      async (dataset, endpoint, sort, records) => {
        mockQuery.mockResolvedValueOnce(linkedPage([...records], 9));
        const first = await runToolContract(searchDrugApprovalsTool, { dataset, limit: 2 });
        const cursor = structuredOf(first).next_cursor;

        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(textBlocks(first)[0]?.split('\n')[2]).toBe(`next_cursor: \`${cursor}\``);

        mockQuery.mockResolvedValueOnce({
          meta: { total: 9, skip: 2, limit: 2, lastUpdated: '2026-11-20' },
          results: [records[1]],
        });
        const second = await runToolContract(searchDrugApprovalsTool, {
          dataset,
          limit: 2,
          cursor,
        });

        expect(second.isError).toBeFalsy();
        expect(mockQuery.mock.calls[1]![0]).toBe(endpoint);
        expect(mockQuery.mock.calls[1]![1]).toMatchObject({
          sort,
          searchAfter: { value: '0=1794182400000;1=Xn23-qEBx5cBmaooYU3L', position: 2 },
        });
        expect(mockQuery.mock.calls[1]![1].skip ?? 0).toBe(0);
      },
    );

    it('refuses a cursor issued for one dataset on another, before any request', async () => {
      mockQuery.mockResolvedValueOnce(linkedPage([CRL_LETTER], 9));
      const first = await runToolContract(searchDrugApprovalsTool, { dataset: 'crl', limit: 1 });
      const cursor = structuredOf(first).next_cursor;
      mockQuery.mockClear();

      const crossed = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'orangebook',
        limit: 1,
        cursor,
      });

      expect(crossed.isError).toBe(true);
      expect(structuredOf(crossed).error?.data?.reason).toBe('invalid_cursor');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('refuses a cursor with stage, before any request', async () => {
      mockQuery.mockResolvedValueOnce(linkedPage([OB_ELIQUIS], 9));
      const first = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'orangebook',
        limit: 1,
      });
      mockQuery.mockClear();

      const staged = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'orangebook',
        limit: 1,
        cursor: structuredOf(first).next_cursor,
        stage: true,
      });

      expect(structuredOf(staged).error?.data?.reason).toBe('invalid_cursor');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('says the walk is complete on a cursor page holding the last letter', async () => {
      mockQuery.mockResolvedValueOnce(linkedPage([CRL_LETTER], 2));
      const first = await runToolContract(searchDrugApprovalsTool, { dataset: 'crl', limit: 1 });
      mockQuery.mockResolvedValueOnce({
        meta: { total: 2, skip: 1, limit: 1, lastUpdated: '2026-11-20' },
        results: [CRL_SPARSE],
        nextSearchAfter: '0=1;1=x',
      });

      const last = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'crl',
        limit: 1,
        cursor: structuredOf(first).next_cursor,
      });

      expect(structuredOf(last).next_cursor).toBeUndefined();
      expect(noticeOf(last)).toBe(
        'This page holds the last 1 of the 2 matched records, so the cursor walk is complete.',
      );
    });
  });

  describe('inline paging across datasets (#93)', () => {
    it.each([
      ['orangebook', [OB_ELIQUIS, OB_PRIOR_1982]],
      ['crl', [CRL_LETTER, CRL_SPARSE]],
    ] as const)(
      '%s sends skip and limit as given and reports the page it got',
      async (dataset, records) => {
        mockQuery.mockResolvedValue({
          meta: { total: 3, skip: 1, limit: 2, lastUpdated: '2026-11-20' },
          results: records,
        });

        const result = await runToolContract(searchDrugApprovalsTool, {
          dataset,
          skip: 1,
          limit: 2,
        });

        expect(mockQuery.mock.calls[0]![1]).toMatchObject({ skip: 1, limit: 2 });
        expect((result.structuredContent as { results: unknown[] }).results).toEqual(records);
        expect(textBlocks(result)[0]).toContain('(returned: 2, skip: 1, limit: 2)');
      },
    );

    it('explains a page past the end of a matched letter set rather than reporting no letters', async () => {
      mockQuery.mockResolvedValue({
        meta: { total: 466, skip: 500, limit: 5, lastUpdated: '2026-11-20' },
        results: [],
      });

      const result = await runToolContract(searchDrugApprovalsTool, { dataset: 'crl', skip: 500 });

      expect(noticeOf(result)).toContain(
        'No records at skip=500: 466 matched, so the offset is past the end of the result set.',
      );
      expect(textBlocks(result)[0]).toContain('skip=500 is past the end of the result set');
    });
  });

  /*
   * #100 — openFDA tests each clause against the whole record, so AND-ed clauses
   * on fields of one submissions, products, patents, or exclusivity array can be
   * met by different entries; a matched page says so and gives the per-entry
   * SQL. Letters hold no array of objects, so they never carry it. The notice
   * itself is tabled in search-clauses.test.ts; these cases prove the wiring.
   */
  describe('clauses one array entry must meet together (#100)', () => {
    const META_2 = { total: 2, skip: 0, limit: 5, lastUpdated: '2026-11-20' };
    const HEADER =
      '**2 total results** (returned: 1, skip: 0, limit: 5) | Data updated: 2026-11-20\n\n';
    const APPLICATION = {
      application_number: 'NDA212725',
      sponsor_name: 'GENENTECH INC',
      submissions: [
        {
          submission_type: 'ORIG',
          submission_status_date: '20190815',
          review_priority: 'PRIORITY',
        },
      ],
    };
    const APPLICATION_LINES =
      '### NDA212725\n**Application:** NDA212725 | **Sponsor:** GENENTECH INC\n**Submissions:**\n- ORIG | 20190815 | (PRIORITY)\n\n';
    const PRODUCT = {
      approval_date: '20121228',
      product_number: '001',
      products: [{ brand_name: 'ELIQUIS', application_type: 'N', application_number: '202155' }],
    };
    const PRODUCT_LINES =
      '### ELIQUIS — N 202155, product 001\n**Approval date:** 20121228\n**Product number:** 001\n**Products:**\n- ELIQUIS\n**Application type:** N\n**Application number:** 202155\n\n';
    const LETTER = {
      letter_date: '08/25/2021',
      file_name: '210274_2023_Orig1s000OtherActionLtrs.pdf',
      application_number: ['NDA 210274'],
      letter_type: 'COMPLETE RESPONSE',
      company_name: 'Zhejiang Novus Pharmaceuticals Co. Ltd.',
    };
    const LETTER_LINES =
      '### NDA 210274 — COMPLETE RESPONSE — 08/25/2021\n**File name:** 210274_2023_Orig1s000OtherActionLtrs.pdf\n**Company name:** Zhejiang Novus Pharmaceuticals Co. Ltd.\n';
    const pageOf = (record: Record<string, unknown>) => ({ meta: META_2, results: [record] });
    const EMPTY_PAGE = { meta: { ...META_2, total: 0 }, results: [] };

    /** A canvas that drains what it is given. */
    const stageOnto = () => {
      const instance = {
        canvasId: 'cv_tie',
        isNew: true,
        registerTable: vi.fn(async (name: string, rows: AsyncIterable<unknown>) => {
          let rowCount = 0;
          for await (const _row of rows) rowCount++;
          return { tableName: name, rowCount, columns: [] };
        }),
        drop: vi.fn(),
      };
      vi.mocked(getCanvas).mockReturnValue({
        acquire: vi.fn().mockResolvedValue(instance),
      } as never);
    };
    /** Both surfaces, every text block, with the random staged table name fixed so they compare as literals. */
    const surfaces = (result: Awaited<ReturnType<typeof runToolContract>>) => {
      const fixed = (text: string) => text.replaceAll(/spilled_[0-9a-f]{8}/g, 'spilled_TABLE');
      return {
        structured: JSON.parse(fixed(JSON.stringify(result.structuredContent))),
        text: textBlocks(result).map(fixed),
      };
    };
    const STAGED_NOTICE =
      'Staged 2 of 2 matched records on canvas table "spilled_TABLE" (canvas_id "cv_tie"). Call openfda_dataframe_describe for the column names, then openfda_dataframe_query to run SQL over the staged set.';
    const STAGED_LINE =
      '> Staged 2 of 2 matched rows on canvas table `spilled_TABLE` (canvas_id `cv_tie`, spilled=true) — openfda_dataframe_describe for its columns, then openfda_dataframe_query for SQL.\n\n';
    const STAGED_FIELDS = {
      canvas_id: 'cv_tie',
      canvas_table: 'spilled_TABLE',
      spilled: true,
      staged_rows: 2,
    };

    afterEach(() => {
      vi.mocked(getCanvas).mockReset();
    });

    it('gives no example pair one array entry must meet, and states the rule and the staged route', () => {
      const description = searchDrugApprovalsTool.input.shape.search.description ?? '';
      // Every AND-ed pair of field clauses the description writes out.
      const pairs = [
        ...description.matchAll(
          /[\w.]+:(?:"[^"]*"|\[[^\]]*\]|\S+) AND [\w.]+:(?:"[^"]*"|\[[^\]]*\]|[^\s,;]+)/g,
        ),
      ].map((match) => match[0]);

      expect(description).not.toContain('submissions.review_priority:"PRIORITY"');
      for (const endpoint of ['drug/drugsfda', 'drug/orangebook']) {
        for (const pair of pairs) {
          expect(findConjoinedArrayClauses(pair, OBJECT_ARRAY_PATHS[endpoint] ?? []), pair).toEqual(
            [],
          );
        }
      }
      expect(description).toContain(
        "openFDA tests each clause against the whole record, so AND-ed clauses on one array's fields can be met by different entries (an ORIG submission and a PRIORITY one); to require one entry, stage the search and filter per entry in openfda_dataframe_query.",
      );
    });

    /** Per dataset: a record, its content[] lines, and an AND-ed search with no pair under one array. */
    const NO_PAIR = [
      [
        'drugsfda',
        APPLICATION,
        APPLICATION_LINES,
        'sponsor_name:"GENENTECH INC" AND submissions.submission_type:"ORIG"',
      ],
      [
        'orangebook',
        PRODUCT,
        PRODUCT_LINES,
        'products.brand_name:"ELIQUIS" AND patents.patent_number:"6967208"',
      ],
      ['crl', LETTER, LETTER_LINES, 'application_number:"NDA 210274" AND company_name:"Novus"'],
    ] as const;

    it.each(NO_PAIR)(
      '%s returns a search with no pair under one array exactly as before, inline',
      async (dataset, record, lines, search) => {
        mockQuery.mockResolvedValue(pageOf(record));

        const result = await runToolContract(searchDrugApprovalsTool, {
          dataset,
          search,
          limit: 5,
        });

        expect(surfaces(result)).toEqual({
          structured: { ...pageOf(record), totalResults: 2, effectiveQuery: search },
          text: [`${HEADER}${lines}`, `\n\n**totalResults:** 2\nQuery: \`${search}\``],
        });
      },
    );

    it.each(NO_PAIR)(
      '%s returns a search with no pair under one array exactly as before, staged',
      async (dataset, record, lines, search) => {
        stageOnto();
        mockQuery.mockResolvedValue(pageOf(record));

        const result = await runToolContract(searchDrugApprovalsTool, {
          dataset,
          search,
          limit: 5,
          stage: true,
        });

        expect(surfaces(result)).toEqual({
          structured: {
            ...pageOf(record),
            ...STAGED_FIELDS,
            totalResults: 2,
            effectiveQuery: search,
            notice: STAGED_NOTICE,
          },
          text: [
            `${HEADER}${STAGED_LINE}${lines}`,
            `\n\n**totalResults:** 2\nQuery: \`${search}\`\n> ${STAGED_NOTICE}`,
          ],
        });
      },
    );

    const TIED_SUBMISSIONS =
      'submissions.submission_type:"ORIG" AND submissions.review_priority:"PRIORITY"';
    const SUBMISSIONS_FILTER = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.submissions, '["json"]')) AS s) WHERE s->>'submission_type' ILIKE '%ORIG%' AND s->>'review_priority' ILIKE '%PRIORITY%')`;
    const SUBMISSIONS_LEAD =
      'openFDA matches each clause against the whole record, so the clauses on `submissions.submission_type` and `submissions.review_priority` can be met by different `submissions` entries.';
    const restage = (lead: string, filter: string) =>
      `${lead} For one entry meeting them together, call again with stage: true and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${filter}\`.`;
    const SUBMISSIONS_NOTICE = restage(SUBMISSIONS_LEAD, SUBMISSIONS_FILTER);
    // An Orange Book record holds one product, so a pair ties only on the ingredients under it.
    const INGREDIENT_PAIR =
      'products.active_ingredients.name:"AMLODIPINE BESYLATE" AND products.active_ingredients.strength:"10MG"';
    const INGREDIENT_FILTER = `EXISTS (SELECT 1 FROM (SELECT unnest(from_json(t.products, '["json"]')) AS p) WHERE EXISTS (SELECT 1 FROM (SELECT unnest(from_json(p->'active_ingredients', '["json"]')) AS a) WHERE a->>'name' ILIKE '%AMLODIPINE BESYLATE%' AND a->>'strength' ILIKE '%10MG%'))`;
    const INGREDIENT_LEAD =
      'openFDA matches each clause against the whole record, so the clauses on `products.active_ingredients.name` and `products.active_ingredients.strength` can be met by different `products.active_ingredients` entries.';
    const ONE_PRODUCT_PAIR =
      'products.application_number:"210274" AND products.application_type:"N"';

    it.each([
      ['drugsfda', APPLICATION, APPLICATION_LINES, TIED_SUBMISSIONS, SUBMISSIONS_NOTICE],
      [
        'orangebook',
        PRODUCT,
        PRODUCT_LINES,
        INGREDIENT_PAIR,
        restage(INGREDIENT_LEAD, INGREDIENT_FILTER),
      ],
    ] as const)(
      '%s sends an inline page to stage the search, on both surfaces',
      async (dataset, record, lines, search, notice) => {
        mockQuery.mockResolvedValue(pageOf(record));

        const result = await runToolContract(searchDrugApprovalsTool, {
          dataset,
          search,
          limit: 5,
        });

        expect(surfaces(result)).toEqual({
          structured: { ...pageOf(record), totalResults: 2, effectiveQuery: search, notice },
          text: [`${HEADER}${lines}`, `\n\n**totalResults:** 2\nQuery: \`${search}\`\n> ${notice}`],
        });
      },
    );

    it('names the staged table on a staged call, joined after the staging notice', async () => {
      stageOnto();
      mockQuery.mockResolvedValue(pageOf(APPLICATION));

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: TIED_SUBMISSIONS,
        limit: 5,
        stage: true,
      });

      const notice = `${STAGED_NOTICE} ${SUBMISSIONS_LEAD} For one entry meeting them together, query the staged table in openfda_dataframe_query: \`SELECT * FROM spilled_TABLE t WHERE ${SUBMISSIONS_FILTER}\`.`;
      expect(surfaces(result).structured).toMatchObject({ ...STAGED_FIELDS, notice });
      expect(surfaces(result).text[1]).toBe(
        `\n\n**totalResults:** 2\nQuery: \`${TIED_SUBMISSIONS}\`\n> ${notice}`,
      );
    });

    it('names the ingredient array on a staged Orange Book call, joined after the staging notice', async () => {
      stageOnto();
      mockQuery.mockResolvedValue(pageOf(PRODUCT));

      const result = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'orangebook',
        search: INGREDIENT_PAIR,
        limit: 5,
        stage: true,
      });

      const notice = `${STAGED_NOTICE} ${INGREDIENT_LEAD} For one entry meeting them together, query the staged table in openfda_dataframe_query: \`SELECT * FROM spilled_TABLE t WHERE ${INGREDIENT_FILTER}\`.`;
      expect(surfaces(result).structured).toMatchObject({ ...STAGED_FIELDS, notice });
      expect(surfaces(result).text[1]).toBe(
        `\n\n**totalResults:** 2\nQuery: \`${INGREDIENT_PAIR}\`\n> ${notice}`,
      );
    });

    it.each([
      ['inline', {}],
      ['staged', { stage: true }],
    ] as const)(
      'returns two fields of the one Orange Book product exactly as a search with no pair, %s',
      async (mode, extra) => {
        if ('stage' in extra) stageOnto();
        mockQuery.mockResolvedValue(pageOf(PRODUCT));

        const result = await runToolContract(searchDrugApprovalsTool, {
          dataset: 'orangebook',
          search: ONE_PRODUCT_PAIR,
          limit: 5,
          ...extra,
        });

        const query = `\n\n**totalResults:** 2\nQuery: \`${ONE_PRODUCT_PAIR}\``;
        expect(surfaces(result)).toEqual(
          mode === 'staged'
            ? {
                structured: {
                  ...pageOf(PRODUCT),
                  ...STAGED_FIELDS,
                  totalResults: 2,
                  effectiveQuery: ONE_PRODUCT_PAIR,
                  notice: STAGED_NOTICE,
                },
                text: [`${HEADER}${STAGED_LINE}${PRODUCT_LINES}`, `${query}\n> ${STAGED_NOTICE}`],
              }
            : {
                structured: {
                  ...pageOf(PRODUCT),
                  totalResults: 2,
                  effectiveQuery: ONE_PRODUCT_PAIR,
                },
                text: [`${HEADER}${PRODUCT_LINES}`, query],
              },
        );
      },
    );

    it('joins the notice after the limit clamp when both fire', async () => {
      mockQuery.mockResolvedValue({ ...pageOf(APPLICATION), meta: { ...META_2, limit: 375 } });

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: TIED_SUBMISSIONS,
        limit: 5000,
      });

      const notice = `limit=5000 is above the 375-record cap for drug/drugsfda, so 375 was applied. The next page starts at skip=1. ${SUBMISSIONS_NOTICE}`;
      expect(noticeOf(result)).toBe(notice);
      expect(textBlocks(result)[1]).toContain(`> ${notice}`);
    });

    it.each([
      ['inline', {}],
      ['staged', { stage: true }],
    ] as const)('says nothing about entries on a %s total of 0', async (_mode, extra) => {
      if ('stage' in extra) stageOnto();
      mockQuery.mockResolvedValue(EMPTY_PAGE);

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: TIED_SUBMISSIONS,
        limit: 5,
        ...extra,
      });

      const notice = String(noticeOf(result));
      expect(notice).toMatch(/^No drug approvals matched the query\./);
      expect(notice).not.toContain('openFDA matches each clause');
    });

    it('says nothing about entries when the clauses are OR-joined', async () => {
      mockQuery.mockResolvedValue(pageOf(APPLICATION));

      const result = await runToolContract(searchDrugApprovalsTool, {
        search: 'submissions.submission_type:"ORIG" OR submissions.review_priority:"PRIORITY"',
        limit: 5,
      });

      expect(noticeOf(result)).toBeUndefined();
    });

    // transparency/crl lists no array of objects, so even a pair that ties on Drugs@FDA stays silent there.
    it.each([
      ['inline', {}],
      ['staged', { stage: true }],
    ] as const)('says nothing about entries on letters, %s', async (mode, extra) => {
      if ('stage' in extra) stageOnto();
      mockQuery.mockResolvedValue(pageOf(LETTER));

      const result = await runToolContract(searchDrugApprovalsTool, {
        dataset: 'crl',
        search: TIED_SUBMISSIONS,
        limit: 5,
        ...extra,
      });

      expect(surfaces(result).structured.notice).toBe(
        mode === 'staged' ? STAGED_NOTICE : undefined,
      );
    });

    /** Answer each cursor page with one record of three, linking the next. */
    const cursorPages = () =>
      mockQuery.mockImplementation(
        async (_endpoint: string, params: { searchAfter?: { position: number } }) => {
          const position = params.searchAfter?.position ?? 0;
          return {
            meta: { total: 3, skip: position, limit: 1, lastUpdated: '2026-11-20' },
            results: [{ ...APPLICATION, application_number: `NDA00000${position}` }],
            nextSearchAfter: `0=NDA00000${position}`,
          };
        },
      );
    /** Walk `pages` cursor pages of `search`, each page's notice and text. */
    const walk = async (search: string, pages: number) => {
      const seen: { notice?: string; text: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < pages; page++) {
        const result = await runToolContract(searchDrugApprovalsTool, {
          search,
          limit: 1,
          ...(cursor && { cursor }),
        });
        const structured = result.structuredContent as { next_cursor?: string; notice?: string };
        seen.push({
          ...(structured.notice && { notice: structured.notice }),
          text: textBlocks(result).join(''),
        });
        cursor = structured.next_cursor;
      }
      return seen;
    };

    // A call carrying both cursor and stage is refused, so a page read by cursor says to drop it.
    it('keeps the notice on every page of a cursor walk, joined after the walk end', async () => {
      cursorPages();

      const pages = await walk(TIED_SUBMISSIONS, 3);

      expect(mockQuery.mock.calls.map((call) => call[1].searchAfter)).toEqual([
        undefined,
        { position: 1, value: '0=NDA000000' },
        { position: 2, value: '0=NDA000001' },
      ]);
      const byCursor = `${SUBMISSIONS_LEAD} For one entry meeting them together, call again without cursor and with stage: true, and query the staged table, aliased t, in openfda_dataframe_query: \`WHERE ${SUBMISSIONS_FILTER}\`.`;
      expect(pages.map((p) => p.notice)).toEqual([
        SUBMISSIONS_NOTICE,
        byCursor,
        `This page holds the last 1 of the 3 matched records, so the cursor walk is complete. ${byCursor}`,
      ]);
      for (const page of pages) expect(page.text).toContain(`> ${page.notice}`);
    });

    it('says nothing about entries on a cursor page of a search with no pair', async () => {
      cursorPages();

      const pages = await walk(NO_PAIR[0][3], 2);

      expect(mockQuery.mock.calls[1]?.[1].searchAfter).toEqual({
        position: 1,
        value: '0=NDA000000',
      });
      expect(pages.map((p) => p.notice)).toEqual([undefined, undefined]);
      expect(pages[1]?.text).not.toContain('\n> ');
    });
  });
});

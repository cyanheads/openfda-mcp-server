/**
 * @fileoverview Tests for openfda_describe_fields tool.
 * @module tests/mcp-server/tools/definitions/describe-fields.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { describeFieldsTool } from '@/mcp-server/tools/definitions/describe-fields.tool.js';
import { textOf } from '../../../helpers/content.js';

describe('openfda_describe_fields', () => {
  let ctx: ReturnType<typeof createMockContext<typeof describeFieldsTool.errors>>;

  beforeEach(() => {
    ctx = createMockContext({ errors: describeFieldsTool.errors });
  });

  it('returns groups for drug/event', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/event' }),
      ctx,
    );

    expect(result.endpoint).toBe('drug/event');
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.queryTips).toBeTruthy();
  });

  // #90 fold-in — the coded drug/event fields carry their code meanings and
  // count form in the content[] table.
  it('renders the coded drug/event fields with their code meanings (#90)', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/event' }),
      ctx,
    );
    const text = textOf(describeFieldsTool.format!(result));

    expect(text).toMatch(
      /^\| `patient\.patientonsetageunit` \| string \| not countable \| [^|]*802 = month[^|]*\|$/m,
    );
    expect(text).toMatch(
      /^\| `patient\.drug\.actiondrug` \| string \| `patient\.drug\.actiondrug` \| [^|]*1 = drug withdrawn[^|]*\|$/m,
    );
  });

  it('returns groups for drug/shortages', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/shortages' }),
      ctx,
    );

    expect(result.endpoint).toBe('drug/shortages');
    // Should include status and generic_name fields
    const allPaths = result.groups.flatMap((g) => g.fields.map((f) => f.path));
    expect(allPaths).toContain('status');
    expect(allPaths).toContain('generic_name');
    expect(allPaths).toContain('therapeutic_category');
  });

  it('returns groups for device/510k', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'device/510k' }),
      ctx,
    );

    expect(result.endpoint).toBe('device/510k');
    const allPaths = result.groups.flatMap((g) => g.fields.map((f) => f.path));
    expect(allPaths).toContain('k_number');
    expect(allPaths).toContain('applicant');
  });

  it('every field entry has path, type, and note', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/event' }),
      ctx,
    );

    for (const group of result.groups) {
      for (const field of group.fields) {
        expect(field.path).toBeTruthy();
        expect(field.type).toBeTruthy();
        expect(field.note).toBeTruthy();
      }
    }
  });

  it('format renders a markdown table with field paths', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/shortages' }),
      ctx,
    );
    const content = describeFieldsTool.format!(result);

    const text = textOf(content);
    expect(text).toContain('drug/shortages');
    expect(text).toContain('| `generic_name`');
    expect(text).toContain('| `status`');
    expect(text).toContain('Query tips:');
  });

  it('format includes all groups as headings', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'animalandveterinary/event' }),
      ctx,
    );
    const content = describeFieldsTool.format!(result);

    const text = textOf(content);
    expect(text).toContain('### Report');
    expect(text).toContain('### Animal');
    expect(text).toContain('### Drug');
  });

  it('queryTips mentions syntax reminders', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/label' }),
      ctx,
    );

    expect(result.queryTips).toContain('.exact');
    expect(result.queryTips).toContain('AND');
  });

  // Issue #34 — the tips used to present .exact as the default for every string
  // field, steering callers straight into "Nothing to count" on the identifier
  // fields openFDA already indexes as keywords.
  it('queryTips does not present .exact as the default for string fields', async () => {
    const { queryTips } = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/ndc' }),
      ctx,
    );

    expect(queryTips).not.toContain('Append .exact to string fields');
    expect(queryTips).toMatch(/count identifier fields bare/i);
    expect(queryTips).toContain('product_ndc');
    expect(queryTips).toMatch(/free-text fields/i);
  });

  // Issue #62 — drug/shortages dates answer 404 to every YYYYMMDD query, so the
  // generic tip defers to the field note, which names the accepted forms.
  it('queryTips defers the date format to the field note (#62)', async () => {
    const result = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/shortages' }),
      ctx,
    );

    expect(result.queryTips).not.toContain('Date fields accept YYYYMMDD format');
    expect(result.queryTips).toMatch(/unless the field's note names another form/);

    const text = textOf(describeFieldsTool.format!(result));
    expect(text).toMatch(
      /\| `update_date` \| date \| `update_date` \| [^|]*\[2026-01-01 TO 2026-12-31\][^|]*\|$/m,
    );
  });

  // The tips are where a caller learns query syntax before writing a `search`, so
  // they state the delimiter rule the handlers enforce locally. They also must not
  // promise that counting an analyzed field bare tallies its words — openFDA
  // refuses that with illegal_argument_exception (drug/label openfda.brand_name).
  it('queryTips states the delimiter rule and the .exact direction for free-text fields', async () => {
    const { queryTips } = await describeFieldsTool.handler(
      describeFieldsTool.input.parse({ endpoint: 'drug/label' }),
      ctx,
    );

    expect(queryTips).toMatch(/must close/i);
    expect(queryTips).toMatch(/cannot end on a backslash/i);
    expect(queryTips).toContain('openfda.brand_name.exact');
    expect(queryTips).not.toMatch(/tallies individual words/i);
  });

  // Issue #49 — every field carries the count expression a live probe verified,
  // so a caller can pick a countable field before openfda_count_values rejects it.
  describe('count expression (#49)', () => {
    const countAsByPath = (result: {
      groups: { fields: { path: string; countAs: string | null }[] }[];
    }) => new Map(result.groups.flatMap((g) => g.fields.map((f) => [f.path, f.countAs] as const)));

    it('marks the uncountable device/classification fields and names the .exact form', async () => {
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint: 'device/classification' }),
        ctx,
      );
      const countAs = countAsByPath(result);

      for (const path of [
        'device_class',
        'product_code',
        'implant_flag',
        'life_sustain_support_flag',
        'gmp_exempt_flag',
        'third_party_flag',
      ]) {
        expect(countAs.get(path)).toBeNull();
      }
      expect(countAs.get('medical_specialty_description')).toBe(
        'medical_specialty_description.exact',
      );
      expect(countAs.get('openfda.k_number')).toBe('openfda.k_number');
    });

    // #96 — the classification fields a product-code lookup reads, with their probed forms.
    it('lists the device/classification submission type and malfunction-reporting fields on both surfaces', async () => {
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint: 'device/classification' }),
        ctx,
      );
      const countAs = countAsByPath(result);
      expect(countAs.get('submission_type_id')).toBeNull();
      expect(countAs.get('summary_malfunction_reporting')).toBe('summary_malfunction_reporting');
      expect(countAs.get('openfda.pma_number')).toBe('openfda.pma_number');

      const text = textOf(describeFieldsTool.format!(result));
      expect(text).toMatch(
        /^\| `submission_type_id` \| string \| not countable \| [^|]*"4" = 510\(k\) exempt[^|]*\|$/m,
      );
      expect(text).toMatch(
        /^\| `device_class` \| string \| not countable \| [^|]*"f" \(HDE[^|]*\|$/m,
      );
      expect(text).toContain(
        '| `summary_malfunction_reporting` | string | `summary_malfunction_reporting` |',
      );
    });

    // #107 — the original-packager flag, the filter that isolates the NDA holder's label.
    it('lists drug/label openfda.is_original_packager as a boolean on both surfaces', async () => {
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint: 'drug/label' }),
        ctx,
      );
      const field = result.groups
        .flatMap((g) => g.fields)
        .find((f) => f.path === 'openfda.is_original_packager');
      expect(field).toMatchObject({ type: 'boolean', countAs: 'openfda.is_original_packager' });
      expect(textOf(describeFieldsTool.format!(result))).toContain(
        '| `openfda.is_original_packager` | boolean | `openfda.is_original_packager` |',
      );
    });

    it('renders the count expression in the content[] table', async () => {
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint: 'device/classification' }),
        ctx,
      );
      const text = textOf(describeFieldsTool.format!(result));

      expect(text).toContain('| Field path | Type | Count as | Description |');
      expect(text).toMatch(/\| `device_class` \| string \| not countable \|/);
      expect(text).toContain(
        '| `medical_specialty_description` | string | `medical_specialty_description.exact` |',
      );
    });

    it('queryTips points at the per-field count expression', async () => {
      const { queryTips } = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint: 'drug/enforcement' }),
        ctx,
      );

      expect(queryTips).toMatch(/countAs/);
    });

    // #89 — the Drugs@FDA product name, which openfda.brand_name misses on every
    // application openFDA never harmonized.
    it('lists drug/drugsfda products.brand_name with count form .exact on both surfaces', async () => {
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint: 'drug/drugsfda' }),
        ctx,
      );

      expect(countAsByPath(result).get('products.brand_name')).toBe('products.brand_name.exact');
      expect(textOf(describeFieldsTool.format!(result))).toContain(
        '| `products.brand_name` | string | `products.brand_name.exact` |',
      );
    });
  });

  /**
   * Endpoints this batch catalogs (#93, #94, #95): each is describable, and a
   * field's count form reaches both surfaces — `countAs` in structuredContent,
   * the Count-as cell in the content[] table.
   */
  describe.each<[string, string, string, string | null, string]>([
    ['drug/orangebook', 'Patents', 'patents.patent_number', 'patents.patent_number', 'string'],
    ['transparency/crl', 'Text', 'text', null, 'string'],
    ['other/nsde', 'Package', 'package_ndc11', 'package_ndc11', 'string'],
    ['cosmetic/event', 'Products and reactions', 'reactions', 'reactions.exact', 'string'],
  ])('%s', (endpoint, groupLabel, path, countAs, type) => {
    it(`lists ${path} under ${groupLabel} on both surfaces`, async () => {
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ endpoint }),
        ctx,
      );
      expect(result.endpoint).toBe(endpoint);
      const group = result.groups.find((g) => g.label === groupLabel);
      expect(group?.fields.find((f) => f.path === path)).toMatchObject({ type, countAs });

      const text = textOf(describeFieldsTool.format!(result));
      expect(text).toContain(`## Searchable fields — \`${endpoint}\``);
      expect(text).toContain(`### ${groupLabel}`);
      const cell = countAs === null ? 'not countable' : `\`${countAs}\``;
      expect(text).toContain(`| \`${path}\` | ${type} | ${cell} |`);
      for (const field of result.groups.flatMap((g) => g.fields)) {
        expect(text).toContain(`| \`${field.path}\` | ${field.type} |`);
      }
    });
  });

  // Issue #16 — the count-only endpoints exposed by openfda_count_values now have
  // field catalogs, so openfda_describe_fields accepts them too.
  const countOnlyEndpoints: Array<[string, string]> = [
    ['device/classification', 'product_code'],
    ['device/registrationlisting', 'registration.registration_number'],
    ['device/udi', 'identifiers.id'],
    ['device/covid19serology', 'igg_result'],
    ['other/substance', 'unii'],
  ];

  it('accepts the five count-only endpoints in its input enum (issue #16)', () => {
    for (const [endpoint] of countOnlyEndpoints) {
      expect(() => describeFieldsTool.input.parse({ endpoint })).not.toThrow();
    }
  });

  it.each(countOnlyEndpoints)(
    'returns a representative field group for %s (issue #16)',
    async (endpoint, expectedPath) => {
      const input = describeFieldsTool.input.parse({ endpoint });
      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.endpoint).toBe(endpoint);
      expect(result.groups.length).toBeGreaterThan(0);
      const allPaths = result.groups.flatMap((g) => g.fields.map((f) => f.path));
      expect(allPaths).toContain(expectedPath);
    },
  );
});

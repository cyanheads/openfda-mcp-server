/**
 * @fileoverview Coverage for the bulk-dump reader: the incremental JSON scanner,
 * the single-entry ZIP framing openFDA publishes, and the download manifest.
 * Archives are synthesised in-process, so nothing here downloads a dump.
 * @module tests/services/openfda/mirror/bulk-stream
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DumpScanner,
  fetchBulkManifest,
  streamPartition,
} from '@/services/openfda/mirror/index.js';

const NEVER_ABORTS = new AbortController().signal;

/** A dump document in openFDA's published shape. */
function dumpDocument(records: Array<Record<string, unknown>>, lastUpdated = '2026-07-22'): string {
  return JSON.stringify({
    meta: {
      disclaimer: 'Do not rely on openFDA to make decisions regarding medical care.',
      last_updated: lastUpdated,
      results: { skip: 0, limit: records.length, total: records.length },
    },
    results: records,
  });
}

/** Wrap `content` in the single-entry, deflate-raw, descriptor-free ZIP layout. */
async function zipArchive(name: string, content: string): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(content);
  const deflated = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x0403_4b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, 0, true); // flags — no data descriptor
  view.setUint16(8, 8, true); // deflate
  view.setUint32(18, deflated.length, true);
  view.setUint32(22, raw.length, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);

  const out = new Uint8Array(header.length + deflated.length);
  out.set(header, 0);
  out.set(deflated, header.length);
  return out;
}

function binaryResponse(body: Uint8Array): Response {
  return new Response(body, { status: 200 });
}

describe('DumpScanner', () => {
  const records = [
    { recall_number: 'D-321-2016', note: 'braces {} and brackets [] inside a string' },
    { recall_number: 'D-322-2016', note: 'an escaped quote \\" and a backslash \\\\' },
    { recall_number: 'D-323-2016', nested: { results: [1, 2, 3] } },
  ];

  it('emits every top-level result and captures meta.last_updated', () => {
    const scanner = new DumpScanner();
    const emitted = scanner.push(dumpDocument(records));
    scanner.finish('test');
    expect(emitted).toEqual(records);
    expect(scanner.lastUpdated).toBe('2026-07-22');
  });

  it('produces the same records regardless of chunk boundaries', () => {
    const document = dumpDocument(records);
    for (const size of [1, 7, 64, 4096]) {
      const scanner = new DumpScanner();
      const emitted: Array<Record<string, unknown>> = [];
      for (let i = 0; i < document.length; i += size) {
        emitted.push(...scanner.push(document.slice(i, i + size)));
      }
      scanner.finish('test');
      expect(emitted, `chunk size ${size}`).toEqual(records);
    }
  });

  it('is not fooled by a "results" key inside the meta block', () => {
    const scanner = new DumpScanner();
    expect(scanner.push(dumpDocument([{ recall_number: 'D-1-2016' }]))).toHaveLength(1);
  });

  it('rejects a truncated transfer instead of reporting a short dataset', () => {
    const scanner = new DumpScanner();
    scanner.push(dumpDocument(records).slice(0, 120));
    expect(() => scanner.finish('partial.json.zip')).toThrow(McpError);
  });

  it('handles an empty results array', () => {
    const scanner = new DumpScanner();
    expect(scanner.push(dumpDocument([]))).toEqual([]);
    expect(() => scanner.finish('test')).not.toThrow();
  });
});

describe('streamPartition', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams a real archive in batches', async () => {
    const records = Array.from({ length: 7 }, (_, i) => ({ recall_number: `D-${i}-2016` }));
    mockFetch.mockResolvedValue(
      binaryResponse(await zipArchive('drug-enforcement.json', dumpDocument(records))),
    );

    const batches = [];
    for await (const batch of streamPartition('https://example.test/x.zip', 3, NEVER_ABORTS)) {
      batches.push(batch);
    }

    expect(batches.map((b) => b.records.length)).toEqual([3, 3, 1]);
    expect(batches.flatMap((b) => b.records)).toEqual(records);
    expect(batches[0]?.lastUpdated).toBe('2026-07-22');
  });

  it('refuses an archive that is not a ZIP', async () => {
    mockFetch.mockResolvedValue(binaryResponse(new TextEncoder().encode('plain text')));
    await expect(drain('https://example.test/x.zip')).rejects.toThrow(McpError);
  });

  it('refuses an archive whose sizes are deferred to a data descriptor', async () => {
    const archive = await zipArchive('x.json', dumpDocument([]));
    new DataView(archive.buffer).setUint16(6, 0x08, true);
    mockFetch.mockResolvedValue(binaryResponse(archive));
    await expect(drain('https://example.test/x.zip')).rejects.toThrow(/data descriptor/);
  });

  it('surfaces a non-200 as an upstream failure', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(drain('https://example.test/x.zip')).rejects.toThrow(McpError);
  });

  async function drain(url: string): Promise<void> {
    for await (const _ of streamPartition(url, 10, NEVER_ABORTS)) {
      // consume
    }
  }
});

describe('fetchBulkManifest', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const manifest = {
    results: {
      drug: {
        enforcement: {
          export_date: '2026-07-22',
          total_records: 17816,
          partitions: [{ file: 'https://download.test/a.json.zip', records: 17816 }],
        },
        shortages: { export_date: '2026-07-22', partitions: [] },
      },
    },
  };

  it('extracts the descriptor for an endpoint', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(manifest), { status: 200 }));
    await expect(
      fetchBulkManifest('https://api.fda.gov', 'drug/enforcement', NEVER_ABORTS),
    ).resolves.toEqual({
      exportDate: '2026-07-22',
      totalRecords: 17816,
      partitions: [{ file: 'https://download.test/a.json.zip', records: 17816 }],
    });
  });

  it.each(['drug/shortages', 'device/classification', 'nonsense'])(
    'raises when %s publishes no partitions',
    async (endpoint) => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(manifest), { status: 200 }));
      await expect(
        fetchBulkManifest('https://api.fda.gov', endpoint, NEVER_ABORTS),
      ).rejects.toThrow(McpError);
    },
  );
});

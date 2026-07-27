/**
 * @fileoverview Streaming reader for an openFDA bulk dump partition.
 *
 * A partition is a single-entry ZIP holding one `{ "meta": {...}, "results":
 * [...] }` document that unpacks to hundreds of megabytes, so neither the
 * archive nor the JSON is ever held whole: the ZIP local header is parsed off the
 * front of the response, the remainder is inflated with `DecompressionStream`,
 * and a depth-aware scanner emits `results[]` elements in batches as they
 * complete.
 *
 * @module services/openfda/mirror/bulk-stream
 */

import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';

/** ZIP local file header signature. */
const LOCAL_FILE_HEADER = 0x0403_4b50;
/** Deflate — the only compression method openFDA publishes. */
const METHOD_DEFLATE = 8;
/** General-purpose bit 3: sizes deferred to a trailing data descriptor. */
const FLAG_DATA_DESCRIPTOR = 0x08;
/** Fixed portion of a ZIP local file header, before the name and extra fields. */
const LOCAL_HEADER_BYTES = 30;
/** Drop consumed text from the scan buffer once this many bytes have been scanned. */
const COMPACT_THRESHOLD = 1 << 20;
/** Structural JSON characters — the only positions {@link DumpScanner} must inspect. */
const STRUCTURAL_CHARS = /["\\{}[\]]/g;

/** One partition of a bulk dataset. */
export interface BulkPartition {
  /** Fully qualified `.json.zip` URL. */
  file: string;
  /** Record count openFDA reports for this partition. */
  records: number;
}

/** The published bulk download descriptor for one endpoint. */
export interface BulkManifest {
  /** Date openFDA exported the dump, `YYYY-MM-DD`. */
  exportDate: string;
  partitions: BulkPartition[];
  totalRecords: number;
}

/**
 * Fetch `download.json` and extract the descriptor for one endpoint. The
 * manifest is keyed by the endpoint's two path segments (`drug` / `label`).
 */
export async function fetchBulkManifest(
  baseUrl: string,
  endpoint: string,
  signal: AbortSignal,
): Promise<BulkManifest> {
  const url = new URL('/download.json', baseUrl);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw serviceUnavailable(`openFDA bulk download manifest returned HTTP ${response.status}.`, {
      url: url.toString(),
      status: response.status,
    });
  }
  const body = (await response.json()) as {
    results?: Record<string, Record<string, unknown>>;
  };
  const [category, dataset] = endpoint.split('/');
  const entry =
    category && dataset
      ? (body.results?.[category]?.[dataset] as
          | {
              export_date?: string;
              partitions?: Array<{ file?: string; records?: number }>;
              total_records?: number;
            }
          | undefined)
      : undefined;
  if (!entry?.export_date || !Array.isArray(entry.partitions) || entry.partitions.length === 0) {
    throw serviceUnavailable(`openFDA publishes no bulk download for ${endpoint}.`, {
      endpoint,
      url: url.toString(),
    });
  }
  return {
    exportDate: entry.export_date,
    totalRecords: entry.total_records ?? 0,
    partitions: entry.partitions.map((partition) => {
      if (!partition.file) {
        throw serviceUnavailable(`openFDA bulk manifest entry for ${endpoint} has no file URL.`, {
          endpoint,
        });
      }
      return { file: partition.file, records: partition.records ?? 0 };
    }),
  };
}

/** A batch of records read from one partition, plus the dump's own freshness stamp. */
export interface DumpBatch {
  /** `meta.last_updated` from the dump, once the leading metadata block has been read. */
  lastUpdated: string | undefined;
  records: Record<string, unknown>[];
}

/**
 * Stream one partition, yielding batches of at most `batchSize` records.
 *
 * @throws {McpError} `ValidationError` when the archive is not the single-entry,
 *   deflate-compressed, descriptor-free layout openFDA publishes — a silent
 *   best-effort parse of an unexpected archive would produce a partial mirror.
 */
export async function* streamPartition(
  url: string,
  batchSize: number,
  signal: AbortSignal,
): AsyncGenerator<DumpBatch> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw serviceUnavailable(`openFDA bulk partition returned HTTP ${response.status}.`, {
      url,
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const { rest } = await readLocalHeader(reader, url);
  const entryBytes = concatAfterHeader(rest, reader, signal);
  const text = toStream(entryBytes)
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .pipeThrough(new TextDecoderStream());

  const scanner = new DumpScanner();
  const textReader = text.getReader();
  let pending: Record<string, unknown>[] = [];
  try {
    for (;;) {
      const { done, value } = await textReader.read();
      if (done) break;
      signal.throwIfAborted();
      pending.push(...scanner.push(value));
      while (pending.length >= batchSize) {
        yield { records: pending.slice(0, batchSize), lastUpdated: scanner.lastUpdated };
        pending = pending.slice(batchSize);
      }
    }
  } finally {
    await textReader.cancel().catch(() => undefined);
  }
  scanner.finish(url);
  if (pending.length > 0) yield { records: pending, lastUpdated: scanner.lastUpdated };
}

/* --- ZIP --- */

/** Parse the ZIP local file header off the front of the response body. */
async function readLocalHeader(
  reader: ReadableStreamDefaultReader<NodeJS.NonSharedUint8Array>,
  url: string,
): Promise<{ rest: NodeJS.NonSharedUint8Array }> {
  let head = new Uint8Array(0);
  const need = async (bytes: number): Promise<void> => {
    while (head.length < bytes) {
      const { done, value } = await reader.read();
      if (done) {
        throw validationError(`openFDA bulk partition ended inside its ZIP header.`, { url });
      }
      head = concat(head, value);
    }
  };

  await need(LOCAL_HEADER_BYTES);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER) {
    throw validationError('openFDA bulk partition is not a ZIP archive.', { url });
  }
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  if (method !== METHOD_DEFLATE) {
    throw validationError(`openFDA bulk partition uses ZIP compression method ${method}.`, {
      url,
      method,
    });
  }
  if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) {
    throw validationError('openFDA bulk partition defers its sizes to a data descriptor.', { url });
  }
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataStart = LOCAL_HEADER_BYTES + nameLength + extraLength;
  await need(dataStart);
  return { rest: head.subarray(dataStart) };
}

/**
 * The compressed entry: the bytes already read past the header, then the rest of
 * the response. The trailing central directory is left in the stream —
 * `DecompressionStream` stops at the end of the deflate member.
 */
async function* concatAfterHeader(
  leading: NodeJS.NonSharedUint8Array,
  reader: ReadableStreamDefaultReader<NodeJS.NonSharedUint8Array>,
  signal: AbortSignal,
): AsyncGenerator<NodeJS.NonSharedUint8Array> {
  if (leading.length > 0) yield leading;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    signal.throwIfAborted();
    yield value;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Adapt the byte generator to a stream. Its chunks are typed `NodeJS.BufferSource` —
 * the type `DecompressionStream` declares on its writable end — so the
 * `pipeThrough` below lines up without a cast.
 */
function toStream(
  source: AsyncGenerator<NodeJS.NonSharedUint8Array>,
): ReadableStream<NodeJS.BufferSource> {
  return new ReadableStream<NodeJS.BufferSource>({
    async pull(controller) {
      const { done, value } = await source.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await source.return?.(reason);
    },
  });
}

/* --- JSON --- */

/**
 * Incremental scanner for an openFDA dump document. Tracks brace depth and
 * string state so `"results"` inside the leading `meta` block (which has its own
 * `results` pagination object) is not mistaken for the record array, and emits
 * each element of the top-level `results` array once it is complete in the
 * buffer.
 */
export class DumpScanner {
  /** `meta.last_updated`, available once the metadata block has been scanned. */
  lastUpdated: string | undefined;

  private buffer = '';
  /** Next unscanned index into {@link buffer}. */
  private cursor = 0;
  private phase: 'head' | 'array' | 'done' = 'head';

  /** Feed a chunk and return every record completed by it. */
  push(chunk: string): Record<string, unknown>[] {
    this.buffer += chunk;
    const records: Record<string, unknown>[] = [];
    for (;;) {
      if (this.phase === 'done') break;
      const progressed = this.phase === 'head' ? this.scanHead() : this.scanArrayElement(records);
      if (!progressed) break;
    }
    this.compact();
    return records;
  }

  /**
   * Assert the document closed cleanly. A truncated transfer otherwise reads as
   * a complete but short dataset, which would mark the sync complete on partial
   * data.
   */
  finish(url: string): void {
    if (this.phase !== 'done') {
      throw validationError('openFDA bulk partition ended before its results array closed.', {
        url,
      });
    }
  }

  /**
   * Scan the root object for its top-level keys. Captures `meta` and stops at
   * the opening bracket of `results`.
   */
  private scanHead(): boolean {
    const key = this.readTopLevelKey();
    if (key === undefined) return false;
    const valueStart = this.skipWhitespace(key.after);
    if (valueStart >= this.buffer.length) return false;
    const first = this.buffer[valueStart];

    if (key.name === 'results' && first === '[') {
      this.cursor = valueStart + 1;
      this.phase = 'array';
      return true;
    }
    const end = this.scanValue(valueStart);
    if (end === undefined) return false;
    if (key.name === 'meta') {
      const meta = JSON.parse(this.buffer.slice(valueStart, end)) as { last_updated?: string };
      this.lastUpdated = meta.last_updated;
    }
    this.cursor = end;
    return true;
  }

  /**
   * Read the next `"key":` token of the root object. Returns `undefined` when the
   * buffer holds no complete key yet.
   */
  private readTopLevelKey(): { after: number; name: string } | undefined {
    let index = this.cursor;
    for (; index < this.buffer.length; index += 1) {
      const char = this.buffer[index] as string;
      if (char === '"') break;
      if (char === '}') {
        this.phase = 'done';
        return;
      }
    }
    if (index >= this.buffer.length) return;
    const end = this.scanValue(index);
    if (end === undefined) return;
    const colon = this.skipWhitespace(end);
    if (colon >= this.buffer.length) return;
    return { name: JSON.parse(this.buffer.slice(index, end)) as string, after: colon + 1 };
  }

  /** Read the next element of the `results` array into `sink`. */
  private scanArrayElement(sink: Record<string, unknown>[]): boolean {
    let index = this.skipWhitespace(this.cursor);
    while (index < this.buffer.length && this.buffer[index] === ',') {
      index = this.skipWhitespace(index + 1);
    }
    if (index >= this.buffer.length) {
      this.cursor = index;
      return false;
    }
    if (this.buffer[index] === ']') {
      this.cursor = index + 1;
      this.phase = 'done';
      return false;
    }
    if (this.buffer[index] !== '{') {
      throw validationError('openFDA bulk partition holds a non-object result element.', {
        char: this.buffer[index],
      });
    }
    const end = this.scanValue(index);
    if (end === undefined) {
      this.cursor = index;
      return false;
    }
    sink.push(JSON.parse(this.buffer.slice(index, end)) as Record<string, unknown>);
    this.cursor = end;
    return true;
  }

  /**
   * Index one past the JSON value starting at `start`, or `undefined` when the
   * value is not yet complete in the buffer.
   */
  private scanValue(start: number): number | undefined {
    // Jump between structural characters instead of walking every byte — a dump
    // partition is hundreds of megabytes and is mostly string content.
    const structural = STRUCTURAL_CHARS;
    structural.lastIndex = start;
    let depth = 0;
    let inString = false;
    let match = structural.exec(this.buffer);
    while (match !== null) {
      const char = match[0];
      if (inString) {
        if (char === '\\') structural.lastIndex += 1;
        else if (char === '"') {
          inString = false;
          if (depth === 0) return match.index + 1;
        }
      } else if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return match.index + 1;
      }
      match = structural.exec(this.buffer);
    }
    return;
  }

  private skipWhitespace(from: number): number {
    let index = from;
    while (index < this.buffer.length && /\s/.test(this.buffer[index] as string)) index += 1;
    return index;
  }

  /** Drop the scanned prefix so the buffer tracks the in-flight value, not the file. */
  private compact(): void {
    if (this.cursor < COMPACT_THRESHOLD) return;
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
  }
}

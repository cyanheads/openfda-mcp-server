#!/usr/bin/env bun
/**
 * @fileoverview Lifecycle CLI for the openFDA bulk mirror. A harvest re-downloads
 * and re-parses whole dump partitions, so it runs here — out-of-band — never
 * inline with the MCP server.
 *
 * ```
 * bun run mirror:init    [dataset...]   # full harvest; resumable, idempotent
 * bun run mirror:refresh [dataset...]   # re-harvest when the dump has advanced
 * bun run mirror:verify  [dataset...]   # integrity check + row counts
 * bun run mirror:status  [dataset...]   # sync state, no network
 * ```
 *
 * `dataset` is an endpoint (`drug/label`) or its slug (`drug-label`); omit to
 * act on all four.
 *
 * @module scripts/openfda-mirror
 */

import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import {
  closeMirrors,
  DATASETS,
  getMirror,
  MIRRORED_ENDPOINTS,
  type MirroredEndpoint,
  mirrorPathFor,
} from '@/services/openfda/mirror/index.js';

const MODES = ['init', 'refresh', 'verify', 'status'] as const;
type Mode = (typeof MODES)[number];

const consoleLog: MirrorLogger = {
  info: report,
  notice: report,
  warning: report,
  error: report,
};

function report(message: string, meta?: object): void {
  process.stderr.write(`${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
}

function parseTargets(args: string[]): MirroredEndpoint[] {
  if (args.length === 0) return [...MIRRORED_ENDPOINTS];
  return args.map((arg) => {
    const match = MIRRORED_ENDPOINTS.find(
      (endpoint) => endpoint === arg || DATASETS[endpoint].slug === arg,
    );
    if (!match) {
      throw new Error(
        `Unknown dataset "${arg}". Mirrorable datasets: ${MIRRORED_ENDPOINTS.join(', ')}.`,
      );
    }
    return match;
  });
}

const [mode, ...rest] = process.argv.slice(2);
if (!mode || !(MODES as readonly string[]).includes(mode)) {
  report(`Usage: bun run scripts/openfda-mirror.ts <${MODES.join('|')}> [dataset...]`);
  process.exit(1);
}

const targets = parseTargets(rest);
const config = getServerConfig();
const timeoutMs = config.mirrorRefreshTimeoutMs;
let failed = false;

for (const endpoint of targets) {
  const mirror = getMirror(endpoint, consoleLog);
  const path = mirrorPathFor(endpoint);
  try {
    switch (mode as Mode) {
      case 'init':
      case 'refresh': {
        const started = Date.now();
        const result = await mirror.runSync({
          mode: mode === 'init' ? 'init' : 'refresh',
          signal: AbortSignal.timeout(timeoutMs),
          onProgress: ({ records }) => {
            if (records % 50_000 === 0) report(`${endpoint}: ${records} records applied`);
          },
        });
        report(
          `${endpoint}: ${mode} complete in ${Math.round((Date.now() - started) / 1000)}s`,
          result,
        );
        break;
      }
      case 'verify': {
        const integrity = await mirror.store.integrityCheck();
        const total = await mirror.store.count();
        report(`${endpoint}: ${integrity.ok ? 'ok' : 'CORRUPT'}`, {
          path,
          total,
          ...(integrity.ok ? {} : { results: integrity.results }),
        });
        if (!integrity.ok) failed = true;
        break;
      }
      case 'status': {
        report(`${endpoint}:`, { path, ...(await mirror.status()) });
        break;
      }
    }
  } catch (error) {
    failed = true;
    report(`${endpoint}: ${mode} FAILED`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await closeMirrors();
process.exit(failed ? 1 : 0);

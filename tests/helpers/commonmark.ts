/**
 * @fileoverview CommonMark rendering for tests that read a value back out of
 * `content[]` the way a Markdown client would. Uses the runtime's own parser —
 * Bun's built-in `Bun.markdown` (md4c) — so no dependency is added; the Node
 * lane reaches the same parser through a `bun` subprocess.
 * @module tests/helpers/commonmark
 */

import { execFileSync } from 'node:child_process';

type BunMarkdown = { markdown: { html(text: string): string } };

/** `text` rendered to HTML by a CommonMark parser. */
export function renderCommonMark(text: string): string {
  const bun = (globalThis as { Bun?: BunMarkdown }).Bun;
  if (bun) return bun.markdown.html(text);
  return execFileSync(
    'bun',
    ['-e', 'process.stdout.write(Bun.markdown.html(await Bun.stdin.text()))'],
    { input: text, encoding: 'utf8' },
  );
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&gt;': '>',
  '&lt;': '<',
  '&quot;': '"',
};

/**
 * The text of every code literal in `html` — inline spans and fenced blocks —
 * entity-decoded, in document order. A block's text drops the one line feed
 * CommonMark ends it with, so it compares against the value the fence wraps.
 */
export function codeLiteralsIn(html: string): string[] {
  return [...html.matchAll(/(<pre>)?<code(?: [^>]*)?>([\s\S]*?)<\/code>/g)].map((match) => {
    const text = (match[2] ?? '').replace(/&(?:amp|gt|lt|quot);/g, (e) => ENTITIES[e] ?? e);
    return match[1] ? text.replace(/\n$/, '') : text;
  });
}

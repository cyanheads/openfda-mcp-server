import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { '@/': new URL('./src/', import.meta.url).pathname },
  },
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    globals: true,
    environment: 'node',
    // Vitest's forks pool calls `child.channel.unref()`, which Bun lacks, so the Bun lane runs worker threads.
    pool: process.versions.bun ? 'threads' : 'forks',
    isolate: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});

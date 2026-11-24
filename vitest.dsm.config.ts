import { defineConfig } from 'vitest/config';
/**
 * The suites on real DSM (test/real-dsm): real dsm-app-host accounts on a real storage set, one
 * suite at a time, each a single sequence of steps on the same accounts. See test/real-dsm/hosts.ts.
 */
export default defineConfig({
  test: {
    include: ['test/real-dsm/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});

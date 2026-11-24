import { defineConfig } from 'vitest/config';
// test/real-dsm runs against real DSM accounts and storage nodes: `npm run test:dsm` (vitest.dsm.config.ts).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['test/real-dsm/**', '**/node_modules/**'] } });

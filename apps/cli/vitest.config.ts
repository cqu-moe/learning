import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
    exclude: ['tests/e2e.test.ts', '**/node_modules/**', '**/dist/**'],
    // Each file launches real CLI processes; reserve CPU for those children in CI.
    maxWorkers: 2,
    env: { CI: '1' },
  },
});

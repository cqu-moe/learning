import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { CI: '1' },
    include: ['tests/e2e.test.ts'],
  },
});

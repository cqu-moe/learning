import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/interop.test.ts"], testTimeout: 15000 },
});

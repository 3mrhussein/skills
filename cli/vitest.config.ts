import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests drive real git and the real skills CLI.
    testTimeout: 60_000,
  },
});

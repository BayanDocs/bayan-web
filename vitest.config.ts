import { defineConfig } from "vitest/config";

// Unit tests run in Node.js. Browser behaviour is tested end to end with Playwright in three engines (tests/e2e).
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});

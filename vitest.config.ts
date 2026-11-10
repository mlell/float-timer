// Unit tests run against the pure timer core and view code in jsdom-free node
// where possible; coverage is limited to src so generated dist/ never skews numbers.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
    },
  },
});

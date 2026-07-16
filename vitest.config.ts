import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@arbor/schema": r("./packages/schema/src/index.ts"),
      "@arbor/store": r("./packages/store/src/index.ts"),
      "@arbor/engine": r("./packages/engine/src/index.ts"),
    },
  },
});

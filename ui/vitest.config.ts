import { defineConfig } from "vitest/config";

// Dedicated Vitest config (kept separate from vite.config.ts so the dev-server
// proxy/Tauri settings don't affect the test run). Node environment — our tests
// cover pure graph/data algorithms, no DOM needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      // Focus coverage on the pure logic we actually unit-test; UI components
      // and app shell are exercised manually / via build, not unit tests (yet).
      include: [
        "src/features/graph/collapse.ts",
        "src/features/graph/branches.ts",
        "src/features/graph/CommitGraph.tsx",
      ],
    },
  },
});

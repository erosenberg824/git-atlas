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
      // Coverage is scoped to the pure-logic modules we unit-test — see the
      // "Testing" section in .kiro/steering (git-atlas). The rest of the UI
      // (React components, app shell) is verified via build + manual, so it's
      // deliberately out of the coverage report: including whole component
      // files would swamp the number with untestable JSX and make the headline
      // % meaningless.
      //
      // Note on the tested exports that live *inside* components — assignLanes
      // and computeWorkingPlacement (CommitGraph.tsx) and isSearchDisabled
      // (SearchPanel.tsx): they ARE unit-tested (lanes/workingPlacement/
      // SearchPanel .test.ts), but v8 can't scope coverage to part of a file,
      // and pulling the whole component in just to count a few functions
      // distorts the aggregate. The tests still guard those functions; we just
      // don't fold the component bodies into the coverage %. Prefer extracting
      // such logic into a plain .ts module (then add it below).
      //
      // KEEP IN SYNC: when you add a pure-logic .ts module with a *.test.ts,
      // add its source file here so the report reflects it.
      include: [
        "src/features/graph/collapse.ts",
        "src/features/graph/branches.ts",
        "src/features/graph/branchGroups.ts",
        "src/features/graph/refBadge.ts",
        "src/features/graph/controlStyles.ts",
        "src/features/tree/fileTree.ts",
      ],
    },
  },
});

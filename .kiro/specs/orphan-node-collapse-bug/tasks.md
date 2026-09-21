# Implementation Plan

## Overview

This plan follows the exploratory bugfix workflow: surface counterexamples that
demonstrate each defect on the **unfixed** code first, capture the behavior that
must be preserved, then apply the targeted fixes and re-run the same tests to
confirm the bugs are resolved with no regressions.

Because the highest-value logic lives in the pure functions in
`ui/src/features/graph/collapse.ts` (covered by `collapse.test.ts` under Vitest,
node environment), most defects are validated directly against those pure
functions. Selection propagation (Defect 2), the reversible expand/collapse
state machine (Defect 4), and the label-truncation layout (Defect 7) are the
React Flow / `CommitGraph.tsx` / `RunNodeComponent.tsx` concerns; where possible
the pure decision is extracted into a unit-testable helper in `collapse.ts`, with
the remaining DOM/`App.tsx` wiring verified via build + manual check per the
project's testing conventions.

This document covers **three rounds** of fixes:

- **Round 1 (Tasks 1–4, complete):** the original Defects 1–3 (large rollup won't
  expand; stale right pane; single-commit rollup).
- **Round 2 (Tasks 5–8, complete):** Defects 4–7 surfaced during manual
  verification of Round 1 — one of them (Defect 4) a **regression** introduced by
  Round 1's expand-plumbing change. See design.md Correctness Properties 5–9 and
  Fix Implementation "follow-up defects (4–7)".
- **Round 3 (Tasks 9–12, follow-up):** Defects 1.8/1.9/1.10 surfaced during
  manual verification of Round 2. Rounds 1–2 patched the *existing* fold model
  in place (auto-detected linear runs `__run__<head>__<tail>` + non-contiguous
  branch rollups `__branch__<name>`); that model is still unsound — folds still
  orphan nodes (non-contiguous set boundaries), trunk expand/collapse is
  inconsistent (membership-derived ids desync on graph shift), and there is no
  on-demand fold control. Round 3 **replaces** the fold unit with an on-demand,
  **contiguous-region** model keyed on the clicked commit's stable oid
  (`__region__<anchorOid>`). Because a contiguous region has exactly one entry
  and one exit edge, folding it is structurally orphan-free. See design.md's
  **"Round 3: On-Demand Contiguous-Region Collapse Model"** section (Correctness
  Properties 10–15, Round-3 Fix Implementation helpers) and bugfix.md defects
  1.8/1.9/1.10, expected 2.8–2.14, preservation 3.6 (reconciled) / 3.8–3.11.
  Round 3 preserves the reused pieces: `applyCollapse` edge rerouting,
  `selectionForSummaryNode`, `RunNodeComponent`, the `effectiveExpanded`
  reversibility concept (re-keyed on anchor oids), and branch-visibility
  server-ref scoping.

Run tests with `mise run test-ui` (or `npx vitest --run` inside `ui/`). Do NOT
use watch mode.

## Tasks

- [x] 1. Write bug condition exploration tests (BEFORE implementing any fix)
  - **Property 1: Bug Condition** - Summary Nodes Are Broken On The Unfixed Code
  - **CRITICAL**: These tests MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when they fail** at this stage
  - **NOTE**: These tests encode the expected post-fix behavior — they validate the fix once they pass after implementation
  - **GOAL**: Surface concrete counterexamples that demonstrate each defect and confirm the root-cause analysis
  - **Scoped PBT Approach**: These are deterministic defects, so scope each property to concrete failing fixtures (single-commit collapsed branch; a branch rollup with an expand override; a summary-node click with known `runNodes`)
  - Add tests in `ui/src/features/graph/collapse.test.ts` (and a small harness for the selection decision):
    - **Defect 3 (single-commit rollup)**: build a collapsed branch whose `unique` set is exactly one commit; assert `detectBranchRollups(...)` returns `[]` (no rollup). From Bug Condition `renderDefect3`: `input.group.oids.length == 1 AND renderedAsRollupNode(group)`.
    - **Defect 1 (expand override ignored)**: build a branch-rollup group, add its id to an expand-override set, and assert the effective graph produced by the group-assembly + `applyCollapse` path contains **no** summary node for that id and un-folds its member oids. From Bug Condition `clickDefect1`: `isCollapsedRunId(nodeId) AND clickDoesNotRevealFoldedCommits(nodeId)`.
    - **Defect 2 (stale right pane)**: given a clicked summary-node id plus the current `runNodes`, assert the derived selection equals the group's newest oid (`oids[0]`). From Bug Condition `clickDefect2`: `isCollapsedRunId(nodeId) AND selectedOidAfterClick == selectedOidBeforeClick`. On unfixed code there is no such decision function / it is not called, so this test cannot pass.
  - Run the tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — it proves the bugs exist)
  - Document the counterexamples found, e.g.:
    - `detectBranchRollups` emits a `Run` with `oids.length === 1`
    - `applyCollapse` keeps a branch rollup folded despite the expand override
    - No `selectedOid` update is derivable from a summary-node click
  - Mark this task complete when the tests are written, run, and their failures are documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing any fix)
  - **Property 2: Preservation** - Non-Buggy Inputs Behave Identically
  - **IMPORTANT**: Follow the observation-first methodology — run the UNFIXED code for non-bug-condition inputs, record the actual outputs, then write tests asserting those outputs
  - Observe and capture baseline behavior on UNFIXED code for cases where `isBugCondition` is false:
    - **Multi-commit rollup preserved**: a collapsed branch with `>= 2` unique commits yields exactly one rollup with the correct `count`/`oids`.
    - **Linear-run expansion preserved**: a `__run__...` linear run added to the expand override un-folds (existing `applyCollapse` expand behavior).
    - **Zero-unique-commit preserved**: a fully-shared collapsed branch still produces no rollup (guard change from `=== 0` to `< 2` must not regress this).
    - **Branch-control scoping preserved**: for a fixed `branchVisibility`, the set of rollups produced and `shownBranchNames`/`defaultVisibility` outputs are unchanged.
  - Write property-based tests where practical (project uses Vitest; fast-check may be added if not already present, otherwise generate randomized fixtures manually):
    - Generate random linear chains and branch topologies; assert **no** emitted group ever has `oids.length < 2` is NOT asserted here (that is the fix) — instead assert that for **multi-commit** inputs the emitted groups match the observed baseline.
    - Generate random non-buggy inputs (multi-commit groups, normal-commit "clicks"); assert the effective graph and any derived selection match the pre-fix baseline.
  - Keep all fixtures deterministic and offline (fixed timestamps, temp/in-memory data) per project conventions
  - Run the tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline behavior to preserve)
  - Mark this task complete when the tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix summary-node expand/select/single-commit defects

  - [x] 3.1 Add a minimum-size guard to `detectBranchRollups` (Defect 3)
    - In `ui/src/features/graph/collapse.ts`, change the early-out in `detectBranchRollups` from `if (unique.length === 0) continue;` to `if (unique.length < 2) continue;`
    - This mirrors the `run.length >= threshold` floor already enforced by `detectRuns`, so a single-commit group is never emitted and the lone commit flows through the normal commit-node render path
    - No change to `RunNodeComponent.tsx` / `CollapsedRunData` — the fix is upstream at detection time
    - _Bug_Condition: isBugCondition(input) where input.kind == "group" AND input.group.oids.length == 1_
    - _Expected_Behavior: expectedBehavior — length-1 group emits no rollup; the commit renders as a normal commit node with no "click to expand" affordance (Property 3)_
    - _Preservation: multi-commit (>= 2) and zero-unique groups unchanged (Property 4)_
    - _Requirements: 2.3_

  - [x] 3.2 Thread the expand override into group assembly and `applyCollapse` (Defect 1)
    - In `ui/src/features/graph/CommitGraph.tsx`, build `allGroups` from `runsToCollapse` plus `branchRollups.filter((r) => !expandedRuns.has(r.id))` so branch rollups (re-derived from `branchVisibility` every render) honor a force-expand
    - Pass `expandedRuns` as the `expanded` argument to `applyCollapse(...)` instead of the hardcoded `new Set<string>()`, so both linear runs and branch rollups expand consistently
    - Leave `runsToCollapse` as-is (it already respects `expandedRuns` for linear runs)
    - _Bug_Condition: isBugCondition(input) where input.kind == "click" AND isCollapsedRunId(input.nodeId) AND clickDoesNotRevealFoldedCommits(nodeId)_
    - _Expected_Behavior: expectedBehavior — after expanding, the summary node is absent and every folded oid renders as its own commit node (Property 1)_
    - _Preservation: correctly-wired linear-run expansion and branch-control scoping unchanged (Property 4)_
    - _Requirements: 2.1_

  - [x] 3.3 Select the group's newest commit on summary-node click (Defect 2)
    - Extract the selection decision into a pure, unit-testable helper in `ui/src/features/graph/collapse.ts` (e.g. `selectionForSummaryNode(nodeId, runNodes): string | null`) that returns the group's newest member `oids[0]`, or `null` when the group data is unavailable
    - In `onNodeClick` in `CommitGraph.tsx`, after `expandRun(node.id)` in the `isCollapsedRunId(node.id)` branch, compute the representative oid via the helper and call `onSelectCommit(repOid)` when non-null; fall back to leaving selection unchanged only if the group data is unavailable (never leave it silently stale in the common path)
    - No change to `RunNodeComponent.tsx` — its `onClick` already calls `d.onExpand(d.id)`; expansion + selection are handled centrally
    - _Bug_Condition: isBugCondition(input) where input.kind == "click" AND isCollapsedRunId(input.nodeId) AND selectedOidAfterClick == selectedOidBeforeClick_
    - _Expected_Behavior: expectedBehavior — clicking a summary node updates the right pane by selecting the group's newest oid (Property 2)_
    - _Preservation: normal commit-node clicks still select that commit and update the right pane (Property 4)_
    - _Requirements: 2.2_

  - [x] 3.4 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Summary Nodes Expand, Select, And Skip Single-Commit Rollups
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The tests from task 1 encode the expected behavior; when they pass they confirm Properties 1, 2, and 3 are satisfied
    - Run the bug condition exploration tests from task 1 (`mise run test-ui`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms Defects 1, 2, and 3 are fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Buggy Inputs Still Behave Identically
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run the preservation property tests from task 2 (`mise run test-ui`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions to normal commit selection, linear-run expansion, multi-commit rollup rendering, and branch-control scoping)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 4. Checkpoint - Ensure all tests pass and wiring is verified
  - Run the full frontend suite: `mise run test-ui` — all tests green (Rust suite unaffected but keep it green: `mise run test-server`)
  - Build the UI (`cd ui && npm run build`) to confirm no TypeScript/strict-mode errors from the new helper and rewired `onNodeClick`
  - Manual verification for the React Flow / `App.tsx` wiring that pure tests cannot cover (per project conventions):
    - Set a branch to "collapsed" with many unique commits, click its rollup → the individual commits appear AND the right pane updates to the group's newest commit (Defects 1 + 2)
    - Cycle a branch through expanded / collapsed / hidden → rollups appear/disappear as before, with no "1 commit" nodes (Defect 3 + preservation 3.4)
    - Click a normal commit node → still selects and updates the right pane (preservation 3.2)
  - Ask the user if any questions arise
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

## Round 2 — follow-up defects (4–7) surfaced during manual verification

- [x] 5. Write bug condition exploration tests for the follow-up defects (BEFORE implementing any Round-2 fix)
  - **Property 3: Bug Condition** - Collapse/Expand Round-Trip Is Broken On The Round-1 Code
  - **CRITICAL**: These tests MUST FAIL on the current (Round-1) code — failure confirms Defects 4, 5, and 6 exist (Defect 4 is a regression from Round 1)
  - **DO NOT attempt to fix the test or the code when they fail** at this stage
  - **NOTE**: These tests encode the expected post-fix behavior — they validate the Round-2 fix once they pass after implementation
  - **GOAL**: Surface concrete counterexamples that demonstrate each follow-up defect and confirm the root-cause analysis in design.md (root causes 5, 6, 7)
  - **Scoped PBT Approach**: These are deterministic defects, so scope each property to concrete failing fixtures (a fold→expand→collapse sequence on one group id; a branch rollup with a shared-ancestor boundary; a long linear run force-expanded once)
  - Add tests in `ui/src/features/graph/collapse.test.ts` (extract pure helpers from `CommitGraph.tsx`/`collapse.ts` where practical so the state decisions are unit-testable without the DOM):
    - **Defect 4 (round-trip not reversible)**: model the fold state via a single pure `effectiveExpanded(expandedRuns, collapsedRuns)` (or equivalent resolver) and drive a fold → expand → collapse sequence on one group id; assert the effective graph after the final collapse equals the effective graph before the expand (the group is folded again). From Bug Condition `reversibilityDefect4`: `input.kind == "round-trip" AND isCollapsedRunId(groupId) AND userRequestedCollapse(groupId) AND groupStillExpandedAfterCollapse(groupId)`. On the Round-1 code, `expandedRuns` is a one-way, triple-filtered override, so a re-collapse leaves the group expanded and this test FAILS.
    - **Defect 5 (expand leaves an orphan)**: build a branch rollup whose oldest member's parent is a shared ancestor and whose newest member has an out-of-group child; expand it and assert every un-folded member retains its original in/out edges in the effective edge set — no parentless member. From Bug Condition `edgeDefect5`: `input.action == "expand" AND EXISTS oid IN group.oids, edge e IN originalEdges(oid) SUCH THAT e is absent after expansion`. On the Round-1 code the boundary edge is dropped by the dangling filter, so this test FAILS.
    - **Defect 6 (partial un-fold)**: build a linear chain long enough to fold (>= `AUTO_COLLAPSE_LEN`), force-expand the run once, then re-run detection over the resulting node set and assert no sub-run of the same members re-folds (all members visible in one action). From Bug Condition `membershipDefect6`: `input.action == "expand" AND revealedCommits(groupId).length < group.oids.length`. On the Round-1 code the membership-derived `__run__<head>__<tail>` id changes after expansion, so all-but-one commit re-folds ("33 commits" → "32 rolled up") and this test FAILS.
  - Run the tests on the CURRENT (Round-1) code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — it proves the follow-up defects exist)
  - Document the counterexamples found, e.g.:
    - fold→expand→collapse leaves the group still expanded (Defect 4)
    - an expanded rollup has a member with no in-edge to a rendered node (Defect 5)
    - re-detection after expand produces a new `__run__` id that re-folds all-but-one commit (Defect 6)
  - Mark this task complete when the tests are written, run, and their failures are documented
  - _Requirements: 2.4, 2.5, 2.6_

- [x] 6. Write preservation property tests for the round-trip pipeline (BEFORE implementing any Round-2 fix)
  - **Property 4: Preservation** - Round-Trip Connectivity, Auto-Collapse Default, And Per-Group Independence Are Unchanged
  - **IMPORTANT**: Follow the observation-first methodology — run the CURRENT (Round-1) code for non-bug-condition inputs, record the actual outputs, then write tests asserting those outputs
  - Observe and capture baseline behavior on the CURRENT code for cases where `isBugCondition` is false (Property 8 in design):
    - **Round-trip connectivity preserved (3.5)**: for any fold or expand action, `applyCollapse` keeps the DAG connected — every edge into/out of a folded group is rerouted through its summary node and there are no dangling edges (mirrors the existing `flowEdges` dangling filter).
    - **Auto-collapse default preserved (3.6)**: when the user has made no manual override, runs at or above `AUTO_COLLAPSE_LEN` still fold by default; below-threshold runs stay expanded.
    - **Per-group independence preserved (3.7)**: expanding one summary node leaves all other summary nodes and unrelated commits in their prior folded/unfolded state.
    - **Correctly-wired linear-run expansion preserved (3.1)**: a `__run__...` linear run added to the expand override still un-folds.
    - **Multi-commit rollup / branch-control scoping preserved (3.3, 3.4)**: multi-commit groups still render as one rollup with the correct count/oids; `shownBranchNames`/`defaultVisibility` and the set of rollups for a fixed `branchVisibility` are unchanged.
  - Write property-based tests where practical (generate random linear chains, branch topologies, and fold/expand sequences; assert connectivity, auto-collapse default, and independence hold across the domain); keep fixtures deterministic and offline (fixed timestamps, in-memory data) per project conventions
  - Run the tests on the CURRENT code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline behavior to preserve through the Round-2 fix)
  - Mark this task complete when the tests are written, run, and passing on the current code
  - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 7. Fix reversibility, orphaned edges, whole-group expansion, and label overflow

  - [x] 7.1 Collapse the triple-filtered expand override into one coherent notion and make expand/collapse a real toggle (Defect 4 — regression)
    - In `ui/src/features/graph/CommitGraph.tsx`, replace the three independent `expandedRuns` filters (`runsToCollapse`, the `branchRollups.filter(...)` in `allGroups`, and the `expanded` arg to `applyCollapse`) with a single `effectiveExpanded = new Set([...expandedRuns].filter((id) => !collapsedRuns.has(id)))` used uniformly in all three places, so a manual collapse authoritatively wins over a prior expand
    - Add a real toggle/`collapseRun(id)` callback that removes the id from `expandedRuns` (`setExpandedRuns((prev) => { const n = new Set(prev); n.delete(id); return n; })`) and, for below-threshold runs, records it in `collapsedRuns`; ensure `collapseAtCommit` continues to remove the id from `expandedRuns`
    - Wire an expand/collapse affordance onto the run/rollup summary node (and the expanded group) so the round-trip is reachable from the UI, mirroring the existing `canCollapse`/`onCollapse` control on commit nodes that head a run
    - Extract the resolver as a pure helper (e.g. `effectiveExpanded(expandedRuns, collapsedRuns)`) in `collapse.ts` so the fold-state decision is unit-testable
    - _Bug_Condition: isBugCondition(input) where input.kind == "round-trip" AND isCollapsedRunId(input.groupId) AND userRequestedCollapse(input.groupId) AND groupStillExpandedAfterCollapse(input.groupId)_
    - _Expected_Behavior: expectedBehavior — for a fold→expand→collapse sequence the group returns to its folded state, and manual collapse of any foldable run works; expand never permanently overrides collapse (Property 5)_
    - _Preservation: auto-collapse default (3.6) and per-group independence (3.7) unchanged; a single expand still un-folds a correctly-wired linear run (3.1) (Property 8)_
    - _Requirements: 2.4_

  - [x] 7.2 Restore all boundary edges on expansion so no member is orphaned (Defect 5)
    - In `ui/src/features/graph/collapse.ts`, fix `applyCollapse`'s edge reconstruction so edges are rebuilt over the **final** effective render-id set (all currently-folded groups considered together): map every endpoint through `renderId` so a boundary edge whose counterpart folded into a *different* group is rerouted to that group's summary id rather than dropped downstream by the `flowEdges` dangling filter
    - Add a `collapse.ts`-level invariant usable by tests: in the effective graph, every non-root rendered node that had a parent in `graph.edges` has at least one in-edge to a rendered node (no parentless member after a fold→expand round-trip)
    - _Bug_Condition: isBugCondition(input) where input.kind == "round-trip" AND input.action == "expand" AND EXISTS oid IN group.oids, edge e IN originalEdges(oid) absent after expansion_
    - _Expected_Behavior: expectedBehavior — expanding a group restores every original edge of every un-folded commit (between members and to the surrounding graph); no orphan results (Property 6)_
    - _Preservation: folding still reroutes every edge into/out of a group through its summary node, keeping the DAG connected with no dangling edges (3.5) (Property 8)_
    - _Requirements: 2.5_

  - [x] 7.3 Expand the whole group in one action by keying expansion on a stable identity (Defect 6)
    - In `ui/src/features/graph/collapse.ts`, add a pure helper `runIdsOverlapping(oids, runs)` that returns every foldable-run id whose `oids` intersect a given member set
    - In `CommitGraph.tsx`, when expanding a summary node resolve its member oids from `runNodes.get(id).oids` and seed the override with **all** run ids overlapping the clicked group (via `runIdsOverlapping`), so re-detection over the changed node set cannot produce a new un-tracked `__run__<head>__<tail>` sub-run that re-folds the remainder
    - _Bug_Condition: isBugCondition(input) where input.kind == "round-trip" AND input.action == "expand" AND revealedCommits(input.groupId).length < input.group.oids.length_
    - _Expected_Behavior: expectedBehavior — one expand reveals every commit the node represents; the count of newly-visible commits equals the node's reported count with no residual folded remainder (Property 7)_
    - _Preservation: multi-commit rollup rendering (3.3) and per-group independence (3.7) unchanged; other summary nodes stay in their prior state (Property 8)_
    - _Requirements: 2.6_

  - [x] 7.4 Truncate the rollup label so it stays within the node box (Defect 7)
    - In `ui/src/features/graph/RunNodeComponent.tsx`, apply `truncate` (with `min-w-0` on the flex row so truncation engages) to the `⑂ ${d.label}` header line and add `title={d.label}` so the full branch name is available on hover — mirroring `CommitNodeComponent`'s summary/ref-badge truncation
    - Clamp/allow-wrap the `${d.count} commits · <range>` sub-line within the existing `max-w-[210px]` node box so neither line overflows the border
    - Presentational-only: no logic or state change; DOM not unit-tested per project conventions (verified via build + manual)
    - _Bug_Condition: isBugCondition(input) where input.kind == "render" AND isRollupNode(input.node) AND renderedTextWidth(input.node) > input.node.maxWidth_
    - _Expected_Behavior: expectedBehavior — the label/range text is truncated within the node box (full name on hover) so no text overflows the node border (Property 9)_
    - _Preservation: node geometry, handles, selection styling, and expand-on-click behavior of `RunNodeComponent` unchanged (Property 8)_
    - _Requirements: 2.7_

  - [x] 7.5 Verify the follow-up bug condition exploration tests now pass
    - **Property 3: Expected Behavior** - Round-Trip Is Reversible, Edge-Complete, And Whole-Group
    - **IMPORTANT**: Re-run the SAME tests from task 5 — do NOT write new tests
    - The tests from task 5 encode the expected behavior; when they pass they confirm Properties 5, 6, and 7 are satisfied
    - Run the follow-up bug condition exploration tests from task 5 (`mise run test-ui`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms Defects 4, 5, and 6 are fixed)
    - _Requirements: 2.4, 2.5, 2.6_

  - [x] 7.6 Verify the round-trip preservation tests still pass
    - **Property 4: Preservation** - Connectivity, Auto-Collapse Default, And Independence Still Hold
    - **IMPORTANT**: Re-run the SAME tests from task 6 — do NOT write new tests
    - Run the preservation property tests from task 6 (`mise run test-ui`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions to round-trip connectivity, the auto-collapse default, per-group independence, correctly-wired run expansion, and branch-control scoping)
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 8. Checkpoint - Ensure all tests pass and Round-2 wiring is verified
  - Run the full frontend suite: `mise run test-ui` — all tests green (keep the Rust suite green too: `mise run test-server`)
  - Build the UI (`cd ui && npm run build`) to confirm no TypeScript/strict-mode errors from the new pure helpers (`effectiveExpanded`, `runIdsOverlapping`), the rewired expand/collapse toggle, and the `RunNodeComponent` label change
  - Manual verification for the React Flow / `App.tsx` / DOM wiring that pure tests cannot cover (per project conventions):
    - **Defect 4 (reversible):** expand a "20 commits" rollup, then collapse it again via the summary-node/collapse control → it re-folds; manually collapse a nearby linear run → it folds
    - **Defects 5 + 6 (whole-group, no orphan):** click a large ("33 commits") rollup → all 33 commits appear connected in one action with no floating/parentless node
    - **Defect 7 (label truncation):** a collapsed branch with a very long name renders a rollup whose label is truncated within the node box, full name on hover
    - **Preservation:** cycle a branch through expanded/collapsed/hidden → rollups appear/disappear as before with no "1 commit" nodes; clicking a normal commit node still selects it and updates the right pane
  - Ask the user if any questions arise
  - _Requirements: 2.4, 2.5, 2.6, 2.7, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7_

## Round 3 — replace the collapse model with an on-demand contiguous-region model (defects 1.8–1.10)

- [x] 9. Write Round-3 bug condition exploration tests (BEFORE implementing any Round-3 fix)
  - **Property 5: Bug Condition** - The Patched Round-1/2 Fold Model Is Still Unsound
  - **CRITICAL**: These tests MUST FAIL on the current (Round-2) code — failure confirms Defects 1.8, 1.9, and 1.10 exist and that the fold model must be replaced
  - **DO NOT attempt to fix the test or the code when they fail** at this stage
  - **NOTE**: These tests encode the expected post-fix behavior of the new contiguous-region model — they validate the Round-3 fix once they pass after implementation
  - **GOAL**: Surface concrete counterexamples that demonstrate each Round-3 defect and confirm the root-cause analysis in design.md's Round-3 section (root causes 1–5)
  - **Scoped PBT Approach**: These are deterministic/structural defects, so scope each property to concrete fixtures (a branch/merge topology with a non-contiguous fold set; a fold→shift→toggle sequence; a foldable mid-branch commit that is not an auto-detected run head), and add randomized DAG generation where practical for the contiguity/orphan invariants
  - Add tests in `ui/src/features/graph/collapse.test.ts` exercising the new pure helpers the design specifies (they do not exist yet, so the tests fail to compile/resolve on current code — that failure documents the model gap):
    - **Region contiguity + boundary exclusion (Defect 1.10 / 2.9, Property 10)**: build a DAG with a branch point (a commit with ≥ 2 children) below and a merge point (a commit with ≥ 2 parents) above a chain of one-parent/one-child commits; assert `regionAround(anchor, nodes, edges, refsByOid, selectedOid)` returns the maximal contiguous chain that STOPS BEFORE (excludes) the nearest branch point below and the nearest merge point above, both left visible as their own nodes, and that the members form a single connected chain in `graph.edges`.
    - **Orphan-freeness of a region fold (Defect 1.8 / 2.10, Property 10)**: fold a `regionAround` result via `regionsFromAnchors` + `applyCollapse` and assert `orphanedMembers(nodes, eff)` is `[]` — including when an ADJACENT region is folded at the same time (the existing branch-rollup `detectBranchRollups` path, by contrast, leaves a non-empty `orphanedMembers` on the same fixture, documenting the old model's unsoundness).
    - **Stable-identity round-trip (Defect 1.9 / 2.11, Property 11)**: assert `regionRollupId(anchorOid) === "__region__" + anchorOid` and `isRegionId(...)`/`isCollapsedRunId(...)` recognize it; drive a fold → (simulate a graph shift that would change a run's head/tail boundary) → expand/collapse sequence keyed on the anchor oid and assert the SAME region toggles consistently (whereas the old `collapsedRunId(head, tail)` id changes across the shift and desyncs).
    - **On-demand eligibility (Defect 1.10 / 2.8, Property 12)**: assert `regionAround(oid) !== null` (control shown) for a commit whose contiguous region has ≥ 2 members, and `regionAround(oid) === null` (no control) for a lone commit wedged directly between a branch point and a merge point (region length < 2) and for a non-foldable anchor (carries a ref/HEAD/tag or is the selected commit).
  - Run the tests on the CURRENT (Round-2) code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — the Round-3 helpers don't exist yet and the current model uses membership-derived run ids / non-contiguous folds)
  - Document the counterexamples found, e.g.:
    - `detectBranchRollups` + `applyCollapse` yields a non-empty `orphanedMembers` on a non-contiguous fold set (Defect 1.8)
    - the `__run__<head>__<tail>` id changes across a graph shift while the region's members are unchanged (Defect 1.9)
    - a foldable mid-branch commit has no entry in `runHeadOf` even though its region has ≥ 2 members (Defect 1.10)
  - Mark this task complete when the tests are written, run, and their failures are documented
  - _Requirements: 2.8, 2.9, 2.10, 2.11_

- [x] 10. Write Round-3 preservation tests (BEFORE implementing any Round-3 fix)
  - **Property 6: Preservation** - Reused Guarantees Survive The Model Replacement
  - **IMPORTANT**: Follow the observation-first methodology — run the CURRENT (Round-2) code for non-bug-condition inputs, record the actual outputs, then write tests asserting those outputs (Property 15 in design)
  - Observe and capture baseline behavior on the CURRENT code for the pieces Round 3 REUSES (so the model replacement cannot regress them):
    - **Edge rerouting / connectivity preserved (3.5)**: `applyCollapse` reroutes every edge into/out of a folded group through its summary node and keeps the DAG connected with no dangling edge; assert `orphanedMembers`/render-id closure holds for a folded region-shaped chain (the region model reuses `applyCollapse` unchanged).
    - **Selection preserved (3.10)**: `selectionForSummaryNode(regionId, runNodes)` returns the region's newest member (`oids[0]`), and `null` for an unknown id.
    - **Single-commit region → no rollup (3.8)**: `regionAround` returning `null` for a length-< 2 region means such a commit renders as a normal commit node (consistent with the earlier single-commit fix); assert no summary node is produced for it.
    - **Whole-region expansion + all edges (3.9)**: expanding a folded region via the anchor reveals every member in one action and `orphanedMembers` stays `[]` (reuses the Round-2 whole-group/edge-complete guarantees, now trivially satisfied by one contiguous chain keyed on one anchor).
    - **Branch-visibility server-ref scoping preserved (3.11)**: `shownBranchNames` / `defaultVisibility` (in `branches.ts`) and the set of refs scoped for a fixed `branchVisibility` are UNCHANGED — the branch picker still decides which refs are fetched/shown, independent of the new client-side fold unit.
  - Write property-based tests where practical (random region-shaped chains for connectivity/orphan invariants; keep `branches.ts` scoping assertions as fixed fixtures); keep everything deterministic and offline (fixed timestamps, in-memory data) per project conventions
  - Run the tests on the CURRENT code
  - **EXPECTED OUTCOME**: Tests PASS for the reused guarantees that already exist on current code (`applyCollapse`, `selectionForSummaryNode`, `branches.ts`); the region-model-specific assertions that depend on `regionAround` are part of Task 9's failing set and are re-verified in Task 11.6 — this task pins the baseline for the REUSED functions so the model swap provably does not change them
  - Mark this task complete when the tests are written, run, and passing on the current code
  - _Requirements: 3.5, 3.6, 3.8, 3.9, 3.10, 3.11_

- [ ] 11. Replace the fold unit with the on-demand contiguous-region model

  - [x] 11.1 Add `regionAround` + region-id helpers to `collapse.ts` (Defects 1.8, 1.10)
    - In `ui/src/features/graph/collapse.ts`, add the pure `regionAround(oid, nodes, edges, refsByOid, selectedOid)` per design.md's Round-3 Fix Implementation pseudocode: reuse the existing `detectRuns` `foldable` predicate (one in-graph parent, one in-graph child, no ref/tag/HEAD, not the selected commit); walk DOWN via first-parent while foldable (stops before the nearest branch point) and UP via the single child while foldable (stops before the nearest merge point); order members newest-first; return `null` when fewer than 2 members or the anchor is not foldable
    - Add `regionRollupId(anchorOid) => `__region__${anchorOid}`` and `isRegionId(id) => id.startsWith("__region__")`; extend `isCollapsedRunId` to also match `__region__` so `selectionForSummaryNode`, MiniMap coloring, and jump handling treat region nodes as summary nodes; add `anchorFromId(id)` that strips the `__region__` prefix
    - Add `regionsFromAnchors(anchors, nodes, edges, refsByOid, selectedOid)` mapping each anchor to `regionAround(...)`, dropping nulls and de-duplicating overlapping regions, producing `{ oids, id: regionRollupId(anchor) }` `Run[]` that flow straight into the existing `applyCollapse`
    - _Bug_Condition: isBugConditionRound3(input) where input.kind == "fold" AND EXISTS oid IN renderedCommits(afterFold) SUCH THAT hadParentInGraph(oid) AND hasNoInEdge(oid, afterFold) (orphanOnCollapse, Defect 1.8); AND input.kind == "eligible-node" AND regionAround(input.oid).length >= 2 AND NOT controlPresent(input.oid) (missingOnDemandControl, Defect 1.10)_
    - _Expected_Behavior: expectedBehavior — a region is the maximal contiguous one-parent/one-child chain bounded by (excluding) the nearest branch point below and merge point above; it has exactly one entry and one exit edge, so folding it via `applyCollapse` is orphan-free; a lone commit (region < 2) yields `null` and no control (Properties 10, 12)_
    - _Preservation: `applyCollapse` edge rerouting reused unchanged; single-commit region renders as a normal commit node (3.5, 3.8) (Property 15)_
    - _Requirements: 2.8, 2.9, 2.10_

  - [x] 11.2 Add the auto-collapse seed with HEAD-trunk exemption (2.13)
    - In `ui/src/features/graph/collapse.ts`, add `autoCollapseAnchors(nodes, edges, refsByOid, selectedOid, headOid, minLen)`: compute the HEAD-trunk oid set by walking `nodeByOid.get(cur).parents[0]` from `headOid` while present and in-graph (the same first-parent chain `assignLanes` pins to lane 0); enumerate one representative anchor per maximal region, keep those with `members.length >= minLen`, and DROP any region whose members intersect the trunk set; return the representative anchor oids
    - Manual collapse via `collapseRegion` must still fold trunk regions on demand — the exemption applies ONLY to the auto-collapse seed
    - _Bug_Condition: isBugConditionRound3(input) where input.kind == "on-load" AND regionIntersectsHeadTrunk(input.region) AND input.region.autoCollapsedOnLoad (trunkAutoCollapsed, 2.13)_
    - _Expected_Behavior: expectedBehavior — on load, every contiguous region ≥ auto length auto-collapses EXCEPT any region intersecting the checked-out branch's first-parent chain, which stays expanded; every eligible node still exposes a manual control and any auto-collapsed region remains expandable (Property 14)_
    - _Preservation: the auto-collapse heuristic still applies on load, now region-scoped (reconciled 3.6) (Property 15)_
    - _Requirements: 2.13_

  - [x] 11.3 Drive folding from anchor-keyed state in `CommitGraph.tsx` (Defects 1.9, 1.10; 2.12, 2.14)
    - In `ui/src/features/graph/CommitGraph.tsx`, replace `runs`/`runsToCollapse`/`branchRollups`(as fold unit)/`allGroups` with anchor-keyed state: a `foldAnchors` set (anchor oids currently folded) plus a `userExpanded` set (anchors of auto-folded regions the user opened)
    - On load / when `graph` changes, seed `foldAnchors` from `autoCollapseAnchors(..., headOid, AUTO_COLLAPSE_LEN)` (2.13)
    - Build `groups = regionsFromAnchors(effectiveFolded, ...)` where `effectiveFolded` is derived via `effectiveExpanded` re-keyed on anchor oids, then `collapsed = applyCollapse(graph.nodes, graph.edges, groups, effExpandedAnchors, nodeByOid)` — `applyCollapse` UNCHANGED
    - Add `collapseRegion(anchorOid)` (adds to `foldAnchors`, removes from `userExpanded`) and `expandRegion(anchorOid)` (removes from `foldAnchors` / adds to `userExpanded`) as the single fold/expand entry points, structured so a future BranchControl per-branch fold/unfold can call them with a branch-derived anchor — do NOT wire the picker (2.14 out of scope)
    - In `onNodeClick`, reuse the Defect-1/2 path: `if (isCollapsedRunId(node.id)) { expandRegion(anchorFromId(node.id)); const rep = selectionForSummaryNode(node.id, runNodes); if (rep) onSelectCommit(rep); }`
    - Retire `detectRuns` / `detectBranchRollups` / `runIdsOverlapping` / `expandSeed` AS THE FOLD MECHANISM; keep `detectBranchRollups` ONLY if it still feeds server-ref branch scoping per 3.11 — otherwise leave the branch-visibility scoping in `App.tsx` / `branches.ts` untouched
    - _Bug_Condition: isBugConditionRound3(input) where input.kind == "round-trip" AND graphShiftedBetween(input.foldAction, input.unfoldAction) AND foldIdBefore(input) != foldIdAfter(input) AND regionMembers(input.foldAction) == regionMembers(input.unfoldAction) (inconsistentIdentity, Defect 1.9); AND input.kind (any collapse interaction) using the region model in place of both prior fold units (2.12)_
    - _Expected_Behavior: expectedBehavior — fold/expand state is keyed on the clicked commit's stable oid (`__region__<anchorOid>`), so the round-trip stays consistent when the graph shifts or an adjacent region expands; the on-demand contiguous-region model is the sole fold unit (Properties 11, 13)_
    - _Preservation: per-group independence and selection unchanged; edge rerouting / no dangling edges preserved; branch controls still scope at the server-ref level independent of folding (3.5, 3.7, 3.10, 3.11) (Property 15)_
    - _Requirements: 2.11, 2.12, 2.14_

  - [x] 11.4 Enable the collapse control on every eligible node (Defect 1.10; 2.8, Property 12)
    - In `ui/src/features/graph/CommitGraph.tsx`, when building `flowNodes` set `canCollapse: regionAround(id, ...) !== null` (memoize a `regionEligible` set over the loaded graph to avoid recomputing per node) and `onCollapse: collapseRegion`; remove the `runHeadOf`-only gating
    - In `ui/src/features/graph/CommitNodeComponent.tsx`, no structural change — reuse the existing `canCollapse`/`onCollapse` control; only its enablement predicate changes (now region eligibility, wired from `CommitGraph.tsx`); keep the Defect-7 label truncation
    - Keep `RunNodeComponent` + `selectionForSummaryNode` reused unchanged; re-express the `effectiveExpanded` reversibility predicate over anchor-oid sets (fold→expand→collapse by anchor returns the folded effective graph)
    - _Bug_Condition: isBugConditionRound3(input) where input.kind == "eligible-node" AND regionAround(input.oid).length >= 2 AND NOT controlPresent(input.oid) (missingOnDemandControl, Defect 1.10)_
    - _Expected_Behavior: expectedBehavior — a commit node shows a collapse control iff its region has ≥ 2 members, and clicking it folds that region; a lone commit shows no control (Property 12)_
    - _Preservation: `RunNodeComponent`, selection, and reversibility (keyed on anchors) unchanged; expansion still reveals the whole region and restores all edges (3.9, 3.10) (Property 15)_
    - _Requirements: 2.8_

  - [x] 11.5 Verify the Round-3 bug condition exploration tests now pass
    - **Property 5: Expected Behavior** - The Contiguous-Region Model Is Orphan-Free, Stable-Identity, And On-Demand
    - **IMPORTANT**: Re-run the SAME tests from task 9 — do NOT write new tests
    - The tests from task 9 encode the expected behavior; when they pass they confirm Properties 10, 11, and 12 are satisfied
    - Run the Round-3 bug condition exploration tests from task 9 (`mise run test-ui`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms Defects 1.8, 1.9, and 1.10 are fixed by the model replacement)
    - _Requirements: 2.8, 2.9, 2.10, 2.11_

  - [x] 11.6 Verify the Round-3 preservation tests still pass
    - **Property 6: Preservation** - Reused Guarantees And Auto-Collapse Default Still Hold
    - **IMPORTANT**: Re-run the SAME tests from task 10 — do NOT write new tests
    - Run the preservation property tests from task 10 (`mise run test-ui`)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions to edge rerouting/connectivity, selection, single-commit rendering, whole-region expansion, the region-scoped auto-collapse default, and branch-visibility server-ref scoping)
    - _Requirements: 3.5, 3.6, 3.8, 3.9, 3.10, 3.11_

- [x] 12. Checkpoint - Ensure all tests pass and Round-3 wiring is verified
  - Run the full frontend suite: `mise run test-ui` — all tests green (keep the Rust suite green too: `mise run test-server`)
  - Build the UI (`cd ui && npm run build`) to confirm no TypeScript/strict-mode errors from the new pure helpers (`regionAround`, `regionsFromAnchors`, `autoCollapseAnchors`, `regionRollupId`/`isRegionId`/`anchorFromId`), the anchor-keyed `CommitGraph.tsx` state, and the region-eligibility `canCollapse` wiring
  - Manual verification for the React Flow / `App.tsx` / DOM wiring that pure tests cannot cover (per project conventions — note the earlier Defect-5 caveat that the orphan manifests at the React Flow/DOM layer, so manual confirmation against a REAL repo is required):
    - **On-demand control (2.8 / Defect 1.10):** every eligible commit node shows a collapse control; a lone commit wedged directly between a branch point and a merge point shows NO control
    - **Orphan-free fold (2.10 / Defect 1.8):** clicking a commit's collapse control folds the contiguous region into a rollup with NO floating/parentless node, and the boundary commits (branch point below, merge point above) stay visible
    - **Consistent trunk toggle (2.11 / Defect 1.9):** on the `main` trunk, collapse then expand then collapse repeatedly (including after a live update / graph shift) → the round-trip is consistent every time (no more "works sometimes")
    - **HEAD-exempt auto-collapse on load (2.13):** on load, off-trunk long regions are auto-collapsed while the checked-out branch's first-parent trunk stays expanded; an auto-collapsed region still expands on click
    - **Whole-region expand + selection (2.6, 2.2 reused):** clicking a rollup reveals the entire region in one action AND updates the right pane to the region's newest commit
    - **Preservation:** clicking a normal commit node still selects it and updates the right pane; branch controls (hidden/collapsed/expanded) still scope the graph at the server-ref level as before; no "1 commit" nodes appear
  - Ask the user if any questions arise
  - _Requirements: 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11_

## Notes

- **Three rounds**: Tasks 1–4 (Round 1, complete) fixed the original Defects 1–3.
  Tasks 5–8 (Round 2, complete) fixed the follow-up Defects 4–7 found during
  manual verification of Round 1 — Defect 4 is a regression introduced by
  Round 1. Tasks 9–12 (Round 3) **replace** the fold model with an on-demand
  contiguous-region model to fix Defects 1.8/1.9/1.10 found during manual
  verification of Round 2 — the patched Round-1/2 model is still unsound (orphans
  on non-contiguous folds, inconsistent trunk toggling from membership-derived
  ids, no on-demand fold control).
- **Round 3 supersession**: the on-demand contiguous-region model
  (`regionAround`/`__region__<anchorOid>`) becomes the sole fold unit,
  superseding both the auto-detected linear runs (`detectRuns`) and the
  non-contiguous branch rollups (`detectBranchRollups`) AS THE FOLD MECHANISM.
  Reused unchanged: `applyCollapse` edge rerouting, `selectionForSummaryNode`,
  `RunNodeComponent`, the `effectiveExpanded` reversibility concept (re-keyed on
  anchor oids), and branch-visibility server-ref scoping (3.11).
- **Ordering (Round 3)**: Tasks 9 and 10 (tests) MUST be completed before Task 11
  (fix). Task 9 must FAIL and Task 10 must PASS (for the reused functions) on the
  current (Round-2) code first. Sub-tasks 11.1–11.4 build on each other (11.1's
  `regionAround` underpins 11.2's seed and 11.3/11.4's wiring) and should be
  implemented in order. Sub-tasks 11.5 and 11.6 depend on the fixes (11.1–11.4)
  being applied. Task 12 depends on 11.5 and 11.6 passing.
- **Ordering (Round 1)**: Tasks 1 and 2 (tests) were completed before Task 3
  (fix); Task 1 failed and Task 2 passed on the unfixed code first.
- **Ordering (Round 2)**: Tasks 5 and 6 (tests) MUST be completed before Task 7
  (fix). Task 5 must FAIL and Task 6 must PASS on the current (Round-1) code
  first. Sub-tasks 7.1–7.4 have no hard interdependencies and may be implemented
  in any order, though 7.1 (the single `effectiveExpanded` notion) and 7.3
  (`runIdsOverlapping` seeding) both touch the expand path and should be
  reconciled together. Sub-tasks 7.5 and 7.6 depend on the fixes (7.1–7.4) being
  applied. Task 8 depends on 7.5 and 7.6 passing.
- **Regression note**: Defect 4 (Task 7.1) is a regression from Round 1's
  expand-plumbing change — the reversibility exploration test in Task 5 must
  fail on the current code to confirm it.
- **Testing conventions**: keep all fixtures deterministic and offline (fixed
  timestamps, in-memory data), extract pure logic out of components so it can be
  unit-tested (as with `assignLanes`, `collapse.ts`), run tests with
  `mise run test-ui`, and do NOT use watch mode. DOM/React Flow/`App.tsx` wiring
  and the presentational `RunNodeComponent` truncation (Defect 7) are verified
  via build + manual check per project conventions.

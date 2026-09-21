# Orphan Node Collapse Bug Bugfix Design

## Overview

The commit graph folds groups of commits into summary "run"/"rollup" nodes rendered by `RunNodeComponent` ("N commits", "click to expand"). Seven defects have been observed with these summary nodes — three original defects, and three follow-up defects (one a regression) plus a minor layout issue surfaced during manual verification of the first fix:

1. A branch-rollup summary node reporting a large count (e.g. "35 commits") does not expand when clicked.
2. Clicking any summary node does not update the right-hand detail pane — it keeps showing the previously selected commit.
3. A group that resolves to exactly one commit is still rendered as a rollup summary node ("1 commit", "click to expand").
4. After expanding a summary node it can no longer be re-collapsed, and manual collapse of any run is broken (a regression from the first fix).
5. Expanding a rollup leaves the newest un-folded commit orphaned with a missing parent edge.
6. Expanding a summary node un-folds only one commit at a time instead of the whole group.
7. A rollup node's label (long branch name) overruns the node box.

> **Round 3 (model replacement).** Continued manual verification after the follow-up fixes showed the *patched* Round-1/2 model is still not sound: collapsing into a rollup still orphans nodes (the non-contiguous branch-rollup fold cannot always reroute its boundary edges), expand/collapse on the `main` trunk is inconsistent (the run id is derived from shifting membership boundaries), and the user can only fold where an auto-detected run head happens to offer a control. Rather than keep patching, Round 3 **replaces** the fold unit with an on-demand, contiguous-region model. Its analysis, root causes, properties, fix, and tests are in the **"Round 3: On-Demand Contiguous-Region Collapse Model"** section below; that section supersedes the Defect 1–7 machinery *for the collapse mechanism* while preserving the parts that remain valid (edge rerouting, selection, reversibility concept, `RunNodeComponent`, and branch-visibility server-ref scoping).

Investigation of the source shows these are three independent defects in the client-side collapse/expand pipeline (`collapse.ts`) and the React Flow integration (`CommitGraph.tsx`), not one shared cause:

- **Defect 1** is a state-plumbing gap: `applyCollapse` is called with a hardcoded empty `expanded` set, and branch rollups are re-derived from `branchVisibility` on every render, so the `expandRun` override recorded in `expandedRuns` never actually suppresses a branch rollup.
- **Defect 2** is a missing selection call: `onNodeClick` expands a collapsed node but returns before ever calling `onSelectCommit`, so `selectedOid` in `App.tsx` is left stale.
- **Defect 3** is a missing minimum-size guard: `detectBranchRollups` emits a rollup group whenever `unique.length > 0`, including single-commit groups. `detectRuns` already guards with a `threshold >= 2`; branch rollups have no equivalent floor.

The fix strategy for these first three is targeted and minimal: add a genuine expand override that both linear runs and branch rollups respect (so large rollups can expand), make summary-node clicks propagate a coherent selection to the right pane, and drop single-commit rollup groups so a lone commit renders as a normal commit node. The bulk of the logic lives in the pure functions in `collapse.ts`, which are already unit-tested (`collapse.test.ts`), so the fix is expressed and validated primarily through those pure functions.

### Follow-up defects (found during manual verification of the first fix)

Manual verification of the first fix surfaced three further defects — one a direct **regression** introduced by the expand-plumbing change above — plus a minor presentational overflow:

4. **Expand/collapse is no longer reversible (regression).** After expanding a run/rollup, there is no way to re-collapse it, and manual collapse of *any* foldable run is now broken. The first fix made `expandedRuns` an authoritative, one-way override at three independent points (see root cause), so nothing the user does can put an expanded group back into the folded state.
5. **Expanding a rollup leaves an orphan.** After expanding a branch rollup, the first (newest) commit of the un-folded set appears with a missing/incorrect parent edge, so it renders as a disconnected node. The fold→expand round-trip does not fully restore the original edges.
6. **Expanding un-folds only one level.** Expanding a large summary node sometimes reveals a single commit instead of the whole group (e.g. a "33 commits" rollup becomes "32 rolled up"), forcing the user to click many times.
7. **Rollup label overruns the node.** A branch-rollup node's label (a long branch name) and/or its date-range line overflows the fixed-width node box, spilling text outside the node border. This is a minor presentational defect in `RunNodeComponent` (no truncation on the label line).

Defects 4–6 share a theme — the collapse/expand *round-trip* is neither reversible (Defect 4) nor edge- and membership-complete (Defects 5, 6); Defect 7 is an independent, purely presentational overflow. Their root causes and fixes are analysed alongside the first three below. Like the first three, the fixes are centred on the pure functions in `collapse.ts` (unit-tested via `collapse.test.ts`), with the React Flow / `CommitGraph.tsx` state wiring and the `RunNodeComponent` layout tweak verified via build + manual check per project conventions.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — a user clicks a summary node that should expand or select, or a foldable group resolves to a single commit.
- **Property (P)**: The desired behavior — summary nodes expand into their commits, clicks update the right pane coherently, and single-commit groups render as normal commit nodes.
- **Preservation**: Existing behavior that must remain unchanged — normal commit selection, correctly-wired linear-run expansion, multi-commit rollup rendering, and branch-control scoping.
- **Summary node**: A folded node rendered by `RunNodeComponent`. Two kinds share the `RunNodeComponent`/`CollapsedRunData` shape: **linear runs** (id `__run__<head>__<tail>`, from `detectRuns`) and **branch rollups** (id `__branch__<name>`, from `detectBranchRollups`).
- **`detectRuns`**: Pure function in `ui/src/features/graph/collapse.ts` that finds maximal foldable linear chains of length `>= threshold`.
- **`detectBranchRollups`**: Pure function in `collapse.ts` that folds a collapsed branch's unique (non-shared) commits into one rollup `Run`.
- **`applyCollapse`**: Pure function in `collapse.ts` that turns detected groups + an `expanded` override set into the effective graph (`runNodes`, `foldedInto`, rerouted `edges`).
- **`expandRun` / `expandedRuns`**: The `CommitGraph.tsx` callback and state set recording which summary nodes the user has force-expanded. `expandRun` currently only ever *adds* to the set.
- **`collapseAtCommit` / `collapsedRuns`**: The `CommitGraph.tsx` callback and state set recording which foldable runs the user has manually force-collapsed (including short runs below the auto-collapse threshold).
- **`runsToCollapse` / `allGroups`**: In `CommitGraph.tsx`, `runsToCollapse` is the set of linear runs currently rendered folded (auto-collapse OR manual collapse, minus `expandedRuns`); `allGroups` merges those with the (override-filtered) branch rollups and is the input to `applyCollapse`.
- **Round-trip**: A fold followed by an expand (or vice-versa) of the same group. A correct round-trip is *reversible* (the group returns to its prior state), *edge-complete* (every original edge is restored), and *membership-complete* (the entire group folds/un-folds as a unit).
- **`onNodeClick`**: The React Flow node-click handler in `CommitGraph.tsx`.
- **`onSelectCommit` / `selectedOid`**: The selection callback and state (in `App.tsx`) that drive the right-hand detail pane.
- **`isCollapsedRunId`**: Predicate that returns true for both `__run__` and `__branch__` ids.
- **`collapsedRunId(head, tail)`**: Builds a linear run's synthetic id from its newest (`head`) and oldest (`tail`) member oids — so the id *changes* if the run's membership boundaries change.

## Bug Details

### Bug Condition

The bug manifests in several distinct ways. Each is captured below; a single formal predicate covers all of them by disjunction over the input's shape.

**Defect 1 (large rollup won't expand):** the user clicks a branch-rollup summary node (id `__branch__<name>`, count large), and the graph does not re-render with the folded commits made visible. Root: `applyCollapse` is invoked as `applyCollapse(graph.nodes, graph.edges, allGroups, new Set<string>(), nodeByOid)` — the `expanded` argument is always empty, so `expandedRuns` is never consulted. Additionally `allGroups` includes `branchRollups`, which are recomputed from `branchVisibility` each render, so even if the override were consulted the rollup would reappear.

**Defect 2 (stale right pane):** the user clicks any summary node; `onNodeClick` routes through `isCollapsedRunId(node.id) → expandRun(node.id); return;`, never calling `onSelectCommit`. `selectedOid` in `App.tsx` is unchanged, so the right pane shows the previously selected commit.

**Defect 3 (single-commit rollup):** a collapsed branch's `unique` commit set has length exactly 1; `detectBranchRollups` still pushes a rollup `Run`, which `applyCollapse` renders via `RunNodeComponent` as "1 commits · click to expand".

**Defect 4 (expand/collapse not reversible — regression):** after the first fix, three independent code paths suppress any group whose id is in `expandedRuns`: (a) `runsToCollapse` filters `!expandedRuns.has(r.id)`; (b) `allGroups` is built from `branchRollups.filter((r) => !expandedRuns.has(r.id))`; (c) `applyCollapse(..., expandedRuns, ...)` filters again with `collapsedRuns.filter((r) => !expanded.has(r.id))`. Meanwhile `expandRun` only ever *adds* to `expandedRuns`. There is no UI affordance and no state transition that removes an id from `expandedRuns` or lets `collapsedRuns` win, so once expanded a group can never re-fold, and manual `collapseAtCommit` is silently overridden.

**Defect 5 (expand leaves an orphan):** after expanding a branch rollup, the newest un-folded commit has no visible parent edge. A branch rollup folds only the branch's `unique` (non-shared) commits — not a contiguous chain terminating at a rendered node. In `applyCollapse`, edges are rebuilt by mapping each endpoint through `renderId` and dropping intra-group edges (`s === t`) and duplicates (`seen`). While folded, the edges into/out of the group are correctly rerouted through the summary node. But the raw `graph.edges` for the newest unique commit's link to its child (which lives outside the group) — and the oldest unique commit's link to its shared parent — depend on those endpoints being present in the render set; when the group boundary commit's counterpart is itself folded into a *different* group (or is a shared ancestor not rendered as a distinct lane neighbour), the reconstructed edge is dropped by the `flowEdges` dangling-edge filter, leaving the expanded commit parentless.

**Defect 6 (expand un-folds only one level):** expanding sometimes reveals only a single commit. `detectRuns` with `threshold = 2` produces runs whose id is `__run__<head>__<tail>`. When a long chain is force-expanded, the id in `expandedRuns` reflects the *old* head/tail boundary; on the next render the effective graph re-detects runs over the changed node set and produces a run with a *different* id (new head/tail), which is not in `expandedRuns`, so all-but-one commit re-folds. The override is keyed on a membership-dependent id, so it only "sticks" for one commit's worth of boundary change.

**Defect 7 (rollup label overruns the node):** on a branch-rollup node, `RunNodeComponent` renders `⑂ ${d.label}` (the branch name) and a `${d.count} commits · <range>` line without truncation. A long branch name (or a long date range) overflows the fixed `max-w-[210px]` node box, spilling text outside the node border.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input — a click event on a graph node, a foldable-group candidate,
         a fold/expand round-trip, or a rollup-node render
  OUTPUT: boolean

  // Defect 1: a summary node was clicked but its folded commits are not revealed
  clickDefect1 := input.kind == "click"
                  AND isCollapsedRunId(input.nodeId)
                  AND clickDoesNotRevealFoldedCommits(input.nodeId)

  // Defect 2: a summary node was clicked but the right pane selection is stale
  clickDefect2 := input.kind == "click"
                  AND isCollapsedRunId(input.nodeId)
                  AND selectedOidAfterClick == selectedOidBeforeClick

  // Defect 3: a foldable group of exactly one commit is rendered as a rollup
  renderDefect3 := input.kind == "group"
                   AND input.group.oids.length == 1
                   AND renderedAsRollupNode(input.group)

  // Defect 4: an expanded group cannot be re-collapsed (expand overrides collapse permanently)
  reversibilityDefect4 := input.kind == "round-trip"
                          AND isCollapsedRunId(input.groupId)
                          AND userRequestedCollapse(input.groupId)
                          AND groupStillExpandedAfterCollapse(input.groupId)

  // Defect 5: expanding a group leaves a member with a missing original edge
  edgeDefect5 := input.kind == "round-trip"
                 AND input.action == "expand"
                 AND EXISTS oid IN input.group.oids, edge e IN originalEdges(oid)
                     SUCH THAT e is absent after expansion

  // Defect 6: expanding a group un-folds fewer than all its members
  membershipDefect6 := input.kind == "round-trip"
                       AND input.action == "expand"
                       AND revealedCommits(input.groupId).length < input.group.oids.length

  // Defect 7: a rollup node's label/range text overflows the node box
  layoutDefect7 := input.kind == "render"
                   AND isRollupNode(input.node)
                   AND renderedTextWidth(input.node) > input.node.maxWidth

  RETURN clickDefect1 OR clickDefect2 OR renderDefect3
         OR reversibilityDefect4 OR edgeDefect5 OR membershipDefect6
         OR layoutDefect7
END FUNCTION
```

### Examples

- **Defect 1**: A branch `feature/x` is set to "collapsed" and has 35 unique commits. The graph shows a "35 commits" rollup node. Expected: clicking it reveals the 35 commits. Actual: nothing happens.
- **Defect 2**: A commit is selected in the right pane. The user clicks a "12 commits" run node. Expected: the right pane updates to reflect the click (a representative commit selected, or a clear "no single commit selected" state). Actual: the right pane still shows the previously selected commit.
- **Defect 3**: A collapsed branch has exactly one commit not shared with any expanded branch. Expected: that commit renders as a normal commit node. Actual: it renders as a "1 commits · click to expand" rollup node.
- **Defect 4**: The user expands a "20 commits" rollup, then tries to collapse it again (or manually collapse a nearby linear run). Expected: it re-folds. Actual: it stays expanded; manual collapse does nothing.
- **Defect 5**: The user expands a branch rollup of 5 commits. Expected: all 5 render connected in a chain back to their shared parent. Actual: the newest of the 5 appears with no parent edge — a floating orphan node.
- **Defect 6**: The user clicks a "33 commits" rollup. Expected: all 33 commits appear. Actual: 32 remain folded ("32 rolled up") and 32 more clicks are needed to fully expand.
- **Defect 7**: A collapsed branch named `feature/really-long-descriptive-branch-name` renders as a rollup whose label text spills past the right edge of the node box. Expected: the label is truncated (with the full name available on hover) and stays within the node.
- **Edge case**: A collapsed branch has zero unique commits (fully shared history). Expected (unchanged): no rollup node is produced. Actual (already correct): `detectBranchRollups` skips it via `unique.length === 0`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Clicking a normal commit node SHALL continue to select that commit and update the right-hand detail pane (`onSelectCommit` → `handleSelectCommit` in `App.tsx`).
- Clicking a correctly-wired linear-run summary node (`__run__...`) SHALL continue to expand it into its individual commits.
- A foldable group of two or more commits meeting the collapse criteria SHALL continue to render as a single rollup/run summary node with the correct count and date range.
- Branch controls (expanded / collapsed / hidden) SHALL continue to scope the graph and produce rollup nodes for collapsed branches as before.
- Folding (collapsing) a run or branch rollup SHALL continue to reroute every edge into and out of the folded commits through the summary node, keeping the DAG connected with no dangling edges (preserves 3.5).
- The automatic collapse heuristic (folding runs at or above `AUTO_COLLAPSE_LEN`) SHALL continue to apply when the user has neither expanded nor manually collapsed a group (preserves 3.6).
- Expanding one summary node SHALL leave all *other* summary nodes and unrelated commits in their current folded/unfolded state (preserves 3.7).
- Working-tree and stash pseudo-nodes, lane assignment (`assignLanes`), dangling-edge dropping, find/jump behavior, and live updates SHALL be unaffected.

**Scope:**
All inputs that do NOT involve a summary-node click, a fold/expand round-trip, a single-commit foldable group, or a rollup-node render should be completely unaffected by this fix. This includes:
- Clicks on normal commit nodes.
- Clicks on working-tree / stash pseudo-nodes.
- Multi-commit (>= 2) foldable groups (linear runs and branch rollups alike) in their default state.
- Branch visibility cycling and server ref-scoping.

**Note:** The expected correct behavior for buggy inputs is defined in the Correctness Properties section (Properties 1–9). This section focuses on what must NOT change.

## Hypothesized Root Cause

Based on reading `collapse.ts`, `CommitGraph.tsx`, `RunNodeComponent.tsx`, and `App.tsx`, the most likely causes are:

1. **Expand override never applied (Defect 1)**: `applyCollapse(..., new Set<string>(), ...)` hardcodes an empty `expanded` set. The `expandedRuns` state, updated by `expandRun`, is not threaded into `applyCollapse`.
   - Even if it were, `branchRollups` is recomputed from `branchVisibility` on every render, so a branch rollup would reappear unless the expand override is applied to the combined `allGroups` (or the rollup detection itself is filtered by the override).
   - `expandRun`/`collapseAtCommit` and the `runsToCollapse` filter only account for linear runs, not branch-rollup ids.

2. **Click handler omits selection (Defect 2)**: In `onNodeClick`, the `isCollapsedRunId(node.id)` branch calls `expandRun(node.id)` and returns without calling `onSelectCommit`. There is no code path that updates `selectedOid` for a summary-node click, so the right pane is left stale.
   - A coherent choice must be made: either select a representative commit from the group (e.g. its newest member) or explicitly clear the selection. Selecting the newest member is preferred because it keeps the right pane meaningful and matches the node the user visually clicked.

3. **No minimum-size guard on branch rollups (Defect 3)**: `detectBranchRollups` pushes a rollup for any `unique.length > 0`. Unlike `detectRuns` (which requires `run.length >= threshold`, effectively `>= 2`), there is no lower bound, so a single-commit group becomes a "1 commit" rollup.

4. **Shared render path assumes multi-commit (contributing to Defect 3)**: `RunNodeComponent` and `CollapsedRunData` always render a "click to expand" affordance and a count; there is no single-commit special-case. The correct fix is upstream — never emit a single-commit group — so a lone commit flows through the normal commit-node render path.

5. **Expand is a one-way, triply-enforced override (Defect 4 — regression)**: the first fix's expand plumbing makes `expandedRuns` win everywhere and never releases:
   - `expandRun` only ever *adds* an id (`setExpandedRuns((prev) => new Set(prev).add(id))`); no code path removes an id from `expandedRuns`.
   - `runsToCollapse` excludes `expandedRuns` (`!expandedRuns.has(r.id)`), `allGroups` excludes them again (`branchRollups.filter((r) => !expandedRuns.has(r.id))`), and `applyCollapse(..., expandedRuns, ...)` filters a third time (`runs.filter((r) => !expanded.has(r.id))`).
   - `collapseAtCommit` adds to `collapsedRuns` and removes from `expandedRuns`, but nothing invokes it for a *rollup* node, and there is no toggle on the expanded state, so the user has no way to re-fold. Because the three filters above are unconditional, even if `collapsedRuns` gained the id, the id's continued presence in `expandedRuns` would still expand it.
   - Correct model: folding should be decided from a single coherent predicate — "is this group currently expanded?" — where a manual collapse (or a toggle click) authoritatively removes the id from `expandedRuns` (and, for below-threshold runs, records it in `collapsedRuns`). `applyCollapse` should fold a group when it is *not* in the effective-expanded set, and manual collapse must be able to flip a group out of that set.

6. **Rollup folds a non-contiguous subset; boundary edges are lost on the round-trip (Defect 5)**: `detectBranchRollups` folds a branch's `unique` commits — a set that need not terminate at a rendered neighbour. In `applyCollapse`, edges are rebuilt by mapping endpoints through `renderId` and dropping `s === t` (intra-group) and duplicate edges. While folded this is fine. On expand, the group's members are restored from the raw `graph.edges`, but the newest unique commit's edge to its child (outside the group) and the oldest unique commit's edge to its shared parent are only preserved if *both* endpoints are present as distinct rendered ids. When the counterpart endpoint is itself folded into another group — or is a shared ancestor that other rollups also claim — the reconstructed edge is dropped by the `flowEdges` dangling-edge filter (`indexByOid.has(source) && indexByOid.has(target)`), leaving the boundary commit with no parent edge. The fix must ensure the boundary edges of a group are reconstructed against the *effective* render ids of the surrounding graph so no member is left parentless after expansion.

7. **Override keyed on a membership-dependent id (Defect 6)**: linear-run ids are `__run__<head>__<tail>`, derived from the run's current boundary oids. When a run is force-expanded, `expandedRuns` holds the id computed from the *pre-expansion* boundary. On re-render `detectRuns` recomputes runs over the changed foldable set and produces a run with a *new* head/tail (hence a new id) for the still-foldable remainder; that new id is not in `expandedRuns`, so the remainder re-folds and only the one boundary commit stays revealed. The override must be robust to membership changes — e.g. key expansion on a stable identity (a member oid, or expanding by clearing every run id that overlaps the clicked group) so the whole group un-folds in one action and stays un-folded.

8. **Rollup label rendered without truncation (Defect 7)**: in `RunNodeComponent`, the header renders `⑂ ${d.label}` and the sub-line renders `${d.count} commits · ${oldest} → ${newest}` inside a `max-w-[210px]` box with no `truncate`/`overflow` handling on the label line. A long branch name overflows the box. The fix is a presentational change in `RunNodeComponent.tsx`: apply `truncate` (and a `title` for the full name on hover) to the label so it stays within the node bounds — mirroring how `CommitNodeComponent` truncates its summary and ref badges.

## Correctness Properties

Property 1: Bug Condition - Summary Nodes Expand On Click

_For any_ summary node (linear run `__run__...` or branch rollup `__branch__...`) that the user clicks, the fixed code SHALL reveal the individual commits that node represents — i.e. after the click, every oid folded into that node renders as its own commit node and the summary node is no longer present.

**Validates: Requirements 2.1**

Property 2: Bug Condition - Summary-Node Click Updates Right Pane

_For any_ summary node the user clicks, the fixed code SHALL update the right-hand detail pane coherently rather than leaving a stale previously-selected commit — specifically by selecting a representative commit from the group (its newest member), so the right pane reflects the click.

**Validates: Requirements 2.2**

Property 3: Bug Condition - Single-Commit Groups Render As Normal Commits

_For any_ foldable group (linear run or branch rollup) whose resolved membership is exactly one commit, the fixed code SHALL NOT emit a rollup/run summary node; that commit SHALL render as a normal commit node with no "click to expand" affordance.

**Validates: Requirements 2.3**

Property 4: Preservation - Non-Buggy Inputs Unchanged

_For any_ input where the bug condition does NOT hold (a click on a normal commit or pseudo-node, a click on a correctly-wired linear run, or a foldable group of two or more commits), the fixed code SHALL produce the same result as the original code, preserving normal commit selection, correctly-wired run expansion, multi-commit rollup rendering, and branch-control scoping.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

Property 5: Bug Condition - Expand/Collapse Is Reversible

_For any_ summary node (linear run or branch rollup) that the user has expanded, the fixed code SHALL allow it to be collapsed again, and SHALL continue to allow manual collapse of any foldable run — so that for a fold→expand→collapse sequence the group returns to its folded state, and expand never permanently overrides collapse.

**Validates: Requirements 2.4**

Property 6: Bug Condition - Expansion Restores All Original Edges

_For any_ summary node the user expands, the fixed code SHALL restore every original edge of every un-folded commit — both edges among the un-folded commits and edges to the surrounding graph — so that no member is left without its parent/child links and no orphan node results from the fold→expand round-trip.

**Validates: Requirements 2.5**

Property 7: Bug Condition - Expansion Un-folds The Entire Group

_For any_ summary node the user expands, the fixed code SHALL reveal every commit the node represents in a single action, so that after one expand the group's member count of newly-visible commits equals the node's reported count (no residual folded remainder).

**Validates: Requirements 2.6**

Property 8: Preservation - Round-Trip Connectivity And Independence

_For any_ fold or expand action, the fixed code SHALL keep the DAG connected with no dangling edges (every edge into/out of a folded group rerouted through its summary node), SHALL continue to apply the automatic collapse heuristic when the user has made no manual override, and SHALL leave all other summary nodes and unrelated commits in their prior state — preserving connectivity, the auto-collapse default, and per-group independence.

**Validates: Requirements 3.5, 3.6, 3.7**

Property 9: Bug Condition - Rollup Label Stays Within The Node

_For any_ branch-rollup node whose label (branch name) or date-range line would exceed the node's fixed width, the fixed code SHALL truncate the text within the node box and expose the full label on hover, so no text overflows the node border.

**Validates: Requirements 2.7**

## Fix Implementation

### Changes Required

Assuming our root-cause analysis is correct:

**File**: `ui/src/features/graph/collapse.ts`

**Function**: `detectBranchRollups`

1. **Add a minimum-size guard (Defect 3)**: after computing `unique`, skip groups that do not have at least two commits.
   - Change the early-out from `if (unique.length === 0) continue;` to `if (unique.length < 2) continue;`.
   - This mirrors the `threshold`/`run.length >= threshold` floor already enforced in `detectRuns`, and leaves the single-commit commits to render as normal commit nodes.
   - Rationale: fixing it at detection time is minimal and keeps `RunNodeComponent`/`CollapsedRunData` unchanged, so no single-commit render path is needed.

**File**: `ui/src/features/graph/CommitGraph.tsx`

**Function**: expand plumbing (`expandRun`, `runsToCollapse`, `branchRollups`/`allGroups`, `applyCollapse` call)

2. **Thread the expand override into collapsing (Defect 1)**: pass the user's expand overrides to `applyCollapse` instead of a hardcoded empty set, AND ensure branch rollups honor the override (they are re-derived from `branchVisibility`, so filtering them by `expandedRuns` at group-assembly time is the reliable place).
   - Filter `branchRollups` (or `allGroups`) to exclude any group whose `id` is in `expandedRuns`, e.g. build `allGroups` from `runsToCollapse` plus `branchRollups.filter((r) => !expandedRuns.has(r.id))`.
   - Alternatively/additionally pass `expandedRuns` as the `expanded` argument to `applyCollapse` so the override is respected uniformly for both group kinds. The chosen approach is to filter branch rollups by `expandedRuns` and pass `expandedRuns` to `applyCollapse`, so both kinds expand consistently.
   - Keep `runsToCollapse` as-is (it already respects `expandedRuns` for linear runs).

**Function**: `onNodeClick`

3. **Select a representative commit on summary-node click (Defect 2)**: in the `isCollapsedRunId(node.id)` branch, after `expandRun(node.id)`, also select the newest commit of that group via `onSelectCommit`, so the right pane updates coherently.
   - Look up the group's `runNodes` entry by `node.id` to get `oids[0]` (newest member) and call `onSelectCommit(oids[0])`.
   - If for some reason the group data is unavailable, fall back to not changing selection (never leave it stale silently in the common path).
   - This satisfies "select a representative commit" from Requirement 2.2.

4. **No change to `RunNodeComponent.tsx` for Defects 1–3**: its `onClick` already calls `d.onExpand(d.id)`; expansion + selection are handled centrally. Its own `onExpand` path benefits from the same fixes. (The `${d.count} commits` label reading "1 commits" disappears once Defect 3 stops emitting single-commit groups.)

5. **No server-side changes**: this is entirely a client-side view-transform bug.

### Changes Required — follow-up defects (4–7)

**File**: `ui/src/features/graph/CommitGraph.tsx`

**Concern**: reversible expand/collapse (Defect 4) and whole-group, edge-complete expansion (Defects 5, 6)

6. **Make folding decisions flow from one coherent "expanded" notion (Defect 4)**: reduce the three independent `expandedRuns` filters to a single decision and give the user a way to release an expansion.
   - Add a real *toggle*: clicking an already-expanded group (via a collapse control on the expanded commits, or re-clicking to re-fold) removes its id from `expandedRuns`. Introduce a `collapseRun(id)`/`toggleRun(id)` callback that does `setExpandedRuns(prev => { const n = new Set(prev); n.delete(id); return n; })` and, for below-threshold runs, adds the id to `collapsedRuns`.
   - Ensure manual collapse wins: `collapseAtCommit` must remove the run id from `expandedRuns` (it already does) AND the folding filters must treat a group as folded when it is in `collapsedRuns` regardless of prior expansion. Concretely, compute a single `effectiveExpanded = new Set([...expandedRuns].filter(id => !collapsedRuns.has(id)))` and use *only* that set in `runsToCollapse`, `allGroups`, and the `applyCollapse` call — eliminating the triple-filter divergence.
   - Wire an expand/collapse affordance onto the run/rollup summary node and onto the expanded group so the round-trip is reachable from the UI (mirrors the existing `canCollapse`/`onCollapse` control already present on commit nodes that head a run).

7. **Expand the whole group by a stable identity, not the membership-derived id (Defect 6)**: expanding must un-fold every commit the clicked node represents in one action and stay un-folded across the re-render.
   - When expanding, resolve the clicked summary node's member oids from `runNodes.get(id).oids` and record expansion in a form that survives re-detection — e.g. add *all* run ids that the group's member oids belong to (so an adjacent still-foldable remainder does not silently re-fold), or track expanded *member oids* and have `detectRuns`/`runsToCollapse` skip any run overlapping an expanded oid.
   - Preferred: keep the id-based override but, on expand, mark every foldable-run id whose `oids` intersect the clicked group as expanded, so re-detection cannot produce a new un-tracked sub-run. This is a small, testable change to how `expandRun` seeds the override set (a pure helper `runIdsOverlapping(oids, runs)` in `collapse.ts`).

8. **Restore all boundary edges on expansion (Defect 5)**: guarantee no member is orphaned after a fold→expand round-trip.
   - Root the orphan in `applyCollapse`'s edge rebuild + the `flowEdges` dangling filter: when a group is expanded its members are back in the render set, but a boundary edge whose *other* endpoint folded into a different group must be rerouted to that group's summary id — not dropped. Ensure `applyCollapse` rebuilds edges over the *final* effective render-id set (all currently-folded groups considered together), so `renderId` maps every endpoint to a present node and no boundary edge is filtered out downstream.
   - Add a `collapse.ts`-level invariant check (used by tests): for the effective graph, every non-root rendered node has at least one in-edge to a rendered node — i.e. expansion never produces a parentless member that had a parent in `graph.edges`.

**File**: `ui/src/features/graph/RunNodeComponent.tsx`

**Concern**: label overflow (Defect 7)

9. **Truncate the rollup label so it stays within the node (Defect 7)**: apply `truncate` (with `min-w-0` on the flex row so truncation engages) to the `⑂ ${d.label}` header and add a `title={d.label}` so the full branch name is available on hover — mirroring `CommitNodeComponent`'s summary/ref-badge truncation. Also clamp/allow-wrap the `${d.count} commits · <range>` sub-line within `max-w-[210px]`. This is a presentational-only change; no logic or state is affected.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate each defect on the unfixed code, then verify the fix works correctly and preserves existing behavior. Because the highest-value logic lives in the pure functions in `collapse.ts` (already covered by `collapse.test.ts` under Vitest, node environment), Defects 1 and 3 are validated directly against those pure functions. Defect 2 (selection propagation) is a component-integration concern; per the project's testing conventions, the pure decision ("which oid to select on a summary-node click") should be extracted so it can be unit-tested without the DOM, with the wiring verified via build + manual check.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bugs BEFORE implementing the fix. Confirm or refute the root-cause analysis. If refuted, re-hypothesize.

**Test Plan**: Add tests in `collapse.test.ts` that exercise `detectBranchRollups` and `applyCollapse` with a single-commit collapsed branch and with an expand override, and a small harness for the "which oid to select" decision. Run on the UNFIXED code to observe failures.

**Test Cases**:
1. **Single-commit rollup (Defect 3)**: build a collapsed branch whose unique set is exactly one commit; assert `detectBranchRollups` returns no rollup (will fail on unfixed code — it returns a length-1 rollup).
2. **Expand override on a branch rollup (Defect 1)**: build a collapsed branch rollup, add its id to the expand override, and assert `applyCollapse` (or the group-assembly step) produces no summary node for it and un-folds its commits (will fail on unfixed code — the empty `expanded` set ignores the override).
3. **Summary-node click selection (Defect 2)**: given a clicked summary-node id and the current `runNodes`/`foldedInto`, assert the derived selection is the group's newest oid (will fail on unfixed code — no selection is derived).
4. **Reversible round-trip (Defect 4)**: fold → expand → collapse the same group id and assert the effective graph after the final collapse equals the effective graph before the expand (the group is folded again). Model the state transition with the single `effectiveExpanded` predicate; will fail on unfixed code where `expandedRuns` is never released and a re-collapse leaves the group expanded.
5. **Whole-group expansion (Defect 6)**: build a linear chain long enough to fold, force-expand the run, then re-run detection over the resulting node set and assert no sub-run of the same members re-folds (all members visible in one action); will fail on unfixed code where a new head/tail id re-folds all but one commit.
6. **No orphan on expansion (Defect 5)**: build a branch rollup whose oldest member's parent is a shared ancestor and whose newest member has an out-of-group child; expand it and assert every un-folded member has its original in/out edges present in the effective edge set — no parentless member; will fail on unfixed code where the boundary edge is dropped by the dangling filter.
7. **Zero-unique-commit branch (edge case)**: collapsed branch with fully shared history; assert no rollup (already passes — confirms the guard change from `=== 0` to `< 2` doesn't regress the zero case).

**Expected Counterexamples**:
- `detectBranchRollups` emits a `Run` with `oids.length === 1`.
- `applyCollapse` keeps a branch rollup folded despite an expand override.
- No `selectedOid` update is derivable from a summary-node click.
- After expand, re-collapse does not re-fold (Defect 4); an expanded group has a member with no in-edge (Defect 5); expansion reveals fewer commits than the group's count (Defect 6).
- Possible causes: missing size guard, hardcoded empty `expanded` set + rollups re-derived from `branchVisibility`, `onNodeClick` returning before selecting, one-way triple-filtered `expandedRuns`, membership-derived run ids, boundary edges dropped by the dangling filter.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed code produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedBehavior(input)
  ASSERT expectedBehavior(result)
    // Defect 1: clicking a summary node → its folded oids all render as commit nodes
    // Defect 2: clicking a summary node → selectedOid becomes the group's newest oid
    // Defect 3: a length-1 group → no rollup node; the commit renders normally
    // Defect 4: fold→expand→collapse → group is folded again (reversible)
    // Defect 5: expanding a group → every member keeps all its original edges (no orphan)
    // Defect 6: expanding a group → all members revealed in one action
    // Defect 7: a rollup render → label/range text stays within the node box
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code produces the same result as the original code.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalBehavior(input) = fixedBehavior(input)
    // normal commit click → same selection
    // correctly-wired linear-run click → same expansion
    // multi-commit (>=2) group → same rollup/run node
    // branch-control scoping → same shown branches / rollups
    // any fold/expand → DAG stays connected, no dangling edges (3.5)
    // no manual override → auto-collapse heuristic still applies (3.6)
    // expanding one node → other summary nodes unchanged (3.7)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (random linear chains, random branch topologies, random group sizes).
- It catches edge cases that manual unit tests might miss (e.g. the size-2 boundary).
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs.

**Test Plan**: Observe behavior on UNFIXED code first for multi-commit groups and normal clicks, then write tests (unit + property-based where practical) capturing that behavior against the pure functions in `collapse.ts`.

**Test Cases**:
1. **Multi-commit rollup preserved**: a collapsed branch with `>= 2` unique commits still yields exactly one rollup with the correct count and `oids` — unchanged before and after the fix.
2. **Linear-run expansion preserved**: a linear run added to the expand override un-folds, matching prior behavior for `__run__` ids.
3. **Branch-control scoping preserved**: `shownBranchNames`/`defaultVisibility` outputs and the set of rollups produced for a fixed `branchVisibility` are unchanged.
4. **Zero-unique-commit preserved**: a fully-shared collapsed branch still produces no rollup.

### Unit Tests

- `detectBranchRollups`: single-commit group → no rollup; two-commit group → one rollup; zero-unique → no rollup.
- `applyCollapse`: expand override on a branch-rollup id un-folds its commits; multi-commit group without override stays folded.
- Selection-decision helper (`selectionForSummaryNode`): given a summary-node id + `runNodes`, returns the newest oid; unknown id → null.
- Reversibility helper: a pure `effectiveExpanded(expandedRuns, collapsedRuns)` (or equivalent) such that `collapsedRuns` membership removes an id — assert fold→expand→collapse returns the folded effective graph.
- Whole-group expansion helper: `runIdsOverlapping(oids, runs)` returns every run id intersecting a member set, so seeding the override with it prevents a residual re-fold.
- Edge-integrity check: `applyCollapse` output has no rendered member without an in-edge that existed in `graph.edges` (orphan invariant), across fold and expand.
- Regression: `detectRuns` behavior unchanged (threshold still applies).

### Property-Based Tests

- Generate random linear chains and branch topologies; assert no emitted group ever has `oids.length < 2`.
- Generate random expand-override subsets; assert every overridden group id is absent from the effective `runNodes` and its member oids appear as commit nodes.
- Generate random fold→expand→collapse sequences; assert the final effective graph equals the pre-expand effective graph (reversibility, Defect 4) and that a single expand reveals the full group (Defect 6).
- Generate random branch topologies with shared ancestors; assert that after expanding any rollup, every un-folded member retains all its original edges to the effective render set — no orphan (Defect 5).
- Generate random non-buggy inputs (multi-commit groups, normal clicks); assert effective graph and selection match the pre-fix baseline (preservation, incl. connectivity 3.5, auto-collapse default 3.6, per-group independence 3.7).

### Integration Tests

- Full graph flow: set a branch "collapsed", click its rollup → commits appear AND the right pane updates to the newest commit of the group (verified via build + manual per project conventions, since this crosses React Flow + `App.tsx`).
- Reversible round-trip flow: expand a rollup, then collapse it again via the summary-node/collapse control → it re-folds; manually collapse a nearby linear run → it folds (Defect 4, build + manual).
- Whole-group + no-orphan flow: expand a large ("33 commits") rollup → all 33 appear connected in one action with no floating node (Defects 5, 6, build + manual).
- Layout flow: a collapsed branch with a very long name renders a rollup whose label is truncated within the node box, full name on hover (Defect 7, build + manual).
- Context/branch-control flow: cycle a branch through expanded/collapsed/hidden and confirm rollups appear/disappear as before, with no "1 commit" nodes.
- Visual feedback: clicking a large rollup expands it and the right pane reflects the selected representative commit.


---

# Round 3: On-Demand Contiguous-Region Collapse Model

## Round 3 Overview

Rounds 1 and 2 patched the *existing* fold model in place: auto-detected linear runs keyed by a membership-derived id (`__run__<head>__<tail>`), plus non-contiguous "branch rollups" (`__branch__<name>`) that fold a branch's set of unique (non-shared) commits. Continued manual testing shows this model is still unsound in three ways that no further patch to it can fully close:

- **Still orphans (Defect 1.8).** A branch rollup folds a *non-contiguous set* of commits. Its boundary is not a single entry/exit edge, so `applyCollapse`'s renderId rerouting cannot always reconnect every severed side-edge — some folds still leave a disconnected node. Defect 5's fix reduced this but could not eliminate it, because the *fold unit itself* has an ill-defined boundary.
- **Inconsistent trunk expand/collapse (Defect 1.9).** A linear run's identity is `collapsedRunId(head, tail)` — derived from its current membership boundaries. Any shift in the graph (a live update, or an adjacent region expanding) changes the head/tail, hence the id, so the recorded `expandedRuns`/`collapsedRuns` entry desyncs from the re-detected run. On `main` this shows up as fold/unfold that "works sometimes." Defect 6's `expandSeed`/`runIdsOverlapping` mitigation papered over this for a single expand action but did not give the state a stable key.
- **No on-demand folding (Defect 1.10).** `detectRuns` only surfaces a collapse control on an auto-detected run *head* (`runHeadOf`). The user cannot fold an arbitrary region of their choosing.

Round 3 **replaces** the fold unit with an **on-demand, contiguous-region** model:

- The atomic fold unit is the maximal *contiguous chain* of foldable commits around a chosen commit, bounded by the nearest branch point below (exclusive) and the nearest merge point above (exclusive). Because that region is a single chain with exactly **one entry edge** and **one exit edge**, folding it is *inherently orphan-free* — the orphan class of Defect 1.8 becomes structurally impossible (2.10).
- Fold/expand state is keyed on the **clicked commit's stable oid** (`__region__<anchorOid>`), not a boundary-derived id, so the round-trip stays consistent as the graph shifts (2.11) — closing Defect 1.9's id churn at the source.
- **Every eligible commit** exposes a collapse control (any commit whose region has ≥ 2 members), so the user can fold on demand (2.8, 2.10) — closing Defect 1.10.
- On load, the auto-collapse heuristic folds every region at/above the auto-collapse length **except** regions on the checked-out branch's first-parent chain (the HEAD trunk), leaving that trunk expanded (2.13, reconciling 3.6).

This model **supersedes** both the auto-detected linear-run rollups and the non-contiguous branch rollups *as the fold unit* (2.12). What is preserved: `applyCollapse`'s renderId edge-rerouting and summary-node emission, `selectionForSummaryNode`, `RunNodeComponent`, the `effectiveExpanded` reversibility concept (now keyed on anchor oids), and — crucially independent — the branch picker's server-ref scoping (`detectBranchRollups`' role in choosing which *refs* are fetched/shown stays; only the client-side *fold unit* changes; 3.11). The bulk of the new logic is a pure function (`regionAround`) in `collapse.ts`, unit-testable without the DOM; the `CommitGraph.tsx`/`CommitNodeComponent.tsx` wiring is verified via build + manual per project conventions.

### What stays vs. what is replaced (migration map)

| Concern | Round 1/2 | Round 3 |
|---|---|---|
| Fold unit | `detectRuns` linear runs + `detectBranchRollups` non-contiguous sets | `regionAround(oid)` contiguous chain |
| Fold-node id | `__run__<head>__<tail>` / `__branch__<name>` (membership-derived) | `__region__<anchorOid>` (stable, anchor-keyed) |
| Where a control appears | only auto-detected run *heads* (`runHeadOf`) | **every** commit whose region has ≥ 2 members (`canCollapse`) |
| Whole-group expand fix | `expandSeed` / `runIdsOverlapping` (seed every overlapping run id) | not needed — one anchor id un-folds the whole region |
| Reversibility | `effectiveExpanded(expandedRuns, collapsedRuns)` over run ids | same predicate, keyed on **anchor oids** |
| Edge rerouting / no dangling | `applyCollapse` renderId + dangling filter | **reused unchanged** (contiguity guarantees one entry/one exit) |
| Selection on click | `selectionForSummaryNode` | **reused unchanged** |
| Summary node render | `RunNodeComponent` / `CollapsedRunData` | **reused unchanged** |
| Branch picker scoping | `detectBranchRollups` decides shown refs / server scope | **preserved** as *ref scoping* only (3.11); no longer the fold unit |
| Auto-collapse default | fold runs ≥ `AUTO_COLLAPSE_LEN` | fold regions ≥ length, **excluding HEAD-trunk chain** (2.13) |

`detectRuns`, `runIdsOverlapping`, and `expandSeed` are retired as the collapse mechanism. `detectBranchRollups` is *retained only* for its branch-visibility → server-ref scoping contribution (which refs to fetch/show), decoupled from folding.

## Round 3 Glossary

- **Contiguous region**: The maximal chain of foldable commits reachable from an anchor commit by walking DOWN through first-parents (toward older commits) until — but excluding — the nearest **branch point**, and UP through the single child (toward newer commits) until — but excluding — the nearest **merge point**. A region is a single connected chain.
- **Branch point**: An in-graph commit with **2 or more children** (a source of ≥ 2 edges). The region stops *before* it; it remains its own visible node and is the region's entry.
- **Merge point**: An in-graph commit with **2 or more parents**. The region stops *before* it; it remains its own visible node and is the region's exit.
- **Foldable commit (Round 3)**: An in-graph commit with exactly one in-graph parent AND exactly one in-graph child, carrying no ref/tag/HEAD badge, and not the selected commit. (Same predicate `detectRuns` used, now applied to region growth.)
- **Entry edge / exit edge**: The single edge from the branch point below into the region's oldest member (entry), and the single edge from the region's newest member up to the merge point above (exit). Folding reroutes exactly these two to/from the rollup.
- **Anchor oid**: The stable oid the fold state is keyed on — the clicked commit's oid. The rollup id is `__region__<anchorOid>`. Because the anchor oid never moves, the fold/expand state does not desync when the graph shifts (2.11).
- **`regionAround(oid, nodes, edges, refsByOid, selectedOid)`**: New pure function in `collapse.ts` returning the region's ordered member oids (newest-first) or `null` when the region has < 2 members (2.8/3.8 — a lone commit gets no control).
- **HEAD trunk**: The checked-out branch's first-parent chain — the walk from `headOid` (`refs.find(is_head).oid`) through `parents[0]` via `nodeByOid`. The same chain `assignLanes` pins to lane 0. Regions intersecting this chain are exempt from auto-collapse on load (2.13).
- **`foldAnchors`**: Round-3 state set of anchor oids the user (or auto-collapse) has folded. Replaces the `expandedRuns`/`collapsedRuns` run-id sets for the region model. `effectiveExpanded` is re-expressed over anchors.
- **`collapseRegion(anchorOid)` / `expandRegion(anchorOid)`**: The single fold/expand entry points. Structured so a future BranchControl per-branch fold/unfold can call the same mechanism (2.14, out of scope to wire).

## Round 3 Bug Details

### Round 3 Bug Condition

The Round-3 defects concern the *fold unit* and its *identity*, not the click/selection/label surface of Defects 1–7 (which remain fixed). Three failure shapes:

**Defect 1.8 (orphan on contiguous/branch collapse):** the user folds a branch or region into a rollup and the effective graph still contains a disconnected node, because the non-contiguous branch-rollup fold has boundary edges that cannot be reliably rerouted. Root: the fold unit is a *set*, not a single-entry/single-exit chain.

**Defect 1.9 (inconsistent trunk expand/collapse):** folding/unfolding a region on `main` works on some attempts and not others. Root: the rollup id is `collapsedRunId(head, tail)`; a graph shift changes head/tail → changes the id → the `expandedRuns`/`collapsedRuns` entry no longer matches the re-detected run.

**Defect 1.10 (no on-demand control):** the user wants to fold an arbitrary contiguous region but there is no control on it. Root: a collapse control is offered only on `runHeadOf` (auto-detected run heads).

**Defect (auto-collapse trunk exemption, 2.13):** on load the auto-collapse heuristic folds regions on the checked-out branch's trunk, hiding the mainline the user most wants visible. The new model must exempt the HEAD-trunk first-parent chain from the auto-collapse seed while still allowing manual collapse of trunk regions on demand.

**Formal Specification (extends `isBugCondition` with Round-3 disjuncts):**
```
FUNCTION isBugConditionRound3(input)
  INPUT: input — a region fold, an expand/collapse round-trip on a shifting graph,
         a request to fold an arbitrary region, or an on-load auto-collapse pass
  OUTPUT: boolean

  // Defect 1.8: folding a region/branch leaves a disconnected node
  orphanOnCollapse := input.kind == "fold"
                      AND EXISTS oid IN renderedCommits(afterFold)
                          SUCH THAT hadParentInGraph(oid) AND hasNoInEdge(oid, afterFold)

  // Defect 1.9: fold state desyncs when the graph shifts (id derived from boundaries)
  inconsistentIdentity := input.kind == "round-trip"
                          AND graphShiftedBetween(input.foldAction, input.unfoldAction)
                          AND foldIdBefore(input) != foldIdAfter(input)
                          AND regionMembers(input.foldAction) == regionMembers(input.unfoldAction)

  // Defect 1.10: an arbitrary contiguous region of >= 2 commits offers no fold control
  missingOnDemandControl := input.kind == "eligible-node"
                            AND regionAround(input.oid).length >= 2
                            AND NOT controlPresent(input.oid)

  // Auto-collapse trunk exemption (2.13): a HEAD-trunk region is auto-folded on load
  trunkAutoCollapsed := input.kind == "on-load"
                        AND regionIntersectsHeadTrunk(input.region)
                        AND input.region.autoCollapsedOnLoad

  RETURN orphanOnCollapse OR inconsistentIdentity
         OR missingOnDemandControl OR trunkAutoCollapsed
END FUNCTION
```
This composes by disjunction with the Defect 1–7 `isBugCondition` above; the full bug condition is `isBugCondition(input) OR isBugConditionRound3(input)`.

### Round 3 Examples

- **Defect 1.8**: A branch marked "collapsed" folds 12 non-contiguous unique commits; after folding, one commit that also had a child on a sibling branch appears floating. Expected (Round 3): folding a *contiguous region* reroutes exactly one entry + one exit edge, so no node is ever disconnected.
- **Defect 1.9**: On `main`, the user folds a region, an unrelated live update shifts the loaded window, then the user clicks the rollup to expand — nothing happens because the run id changed. Expected (Round 3): the rollup id is `__region__<anchorOid>`; the anchor oid is unchanged, so expand works.
- **Defect 1.10**: The user wants to fold a 5-commit stretch in the middle of a branch that isn't an auto-detected run head. There is no control. Expected (Round 3): every commit whose region has ≥ 2 members shows a collapse control.
- **2.13**: On load, `main`'s long first-parent trunk is auto-folded into a rollup, hiding the mainline. Expected (Round 3): the HEAD-trunk chain stays expanded on load; other long regions auto-collapse; the trunk can still be folded manually.
- **Edge case**: An anchor commit wedged directly between a branch point and a merge point (region length 1). Expected: `regionAround` returns `null`; no control; it renders as a normal commit node (consistent with 2.3/2.8/3.8).

## Round 3 Expected Behavior

### Round 3 Preservation Requirements

**Unchanged Behaviors (Round 3):**
- Single-commit regions SHALL continue to render as normal commit nodes, never as rollups (preserves 2.3 / 3.8 — enforced now by `regionAround` returning `null` for length < 2).
- Expanding a folded region SHALL continue to restore every original edge and reveal the whole region in one action (preserves 2.5, 2.6 / 3.9 — trivially satisfied since the region is one chain keyed on one anchor).
- Clicking a rollup SHALL continue to select the region's representative (newest) commit and update the right pane (preserves 2.2 / 3.10 — `selectionForSummaryNode` reused).
- Folding/expanding any region SHALL keep the DAG connected with no dangling edges (preserves 3.5 — `applyCollapse` rerouting reused; contiguity makes it exact).
- Branch controls (hidden/collapsed/expanded) SHALL continue to scope the graph at the **server-ref level** as before, independent of the new region fold mechanism (preserves 3.11 — the branch picker still decides which refs are fetched/shown; only the client-side fold unit changed).
- The auto-collapse *heuristic* SHALL continue to apply on load — now scoped to the contiguous-region model and exempting the HEAD-trunk chain (partially supersedes 3.6 per 2.13).

**Scope (Round 3):** Inputs not involving a region fold, a fold/expand round-trip, an on-demand fold request, or the on-load auto-collapse pass are unaffected — including all Defect 1–7 behaviors, normal commit/pseudo-node clicks, lane assignment, find/jump, and live updates.

**Note:** The expected correct behavior for Round-3 buggy inputs is defined in the Correctness Properties section (Properties 10–15). This subsection focuses on what must NOT change.

## Round 3 Hypothesized Root Cause

1. **Fold unit is a set, not a single-entry/single-exit chain (Defect 1.8)**: `detectBranchRollups` folds a branch's `unique` commit *set*. Such a set can have multiple boundary edges to sibling branches; `applyCollapse`'s renderId rerouting has no single entry/exit to collapse onto, so some boundary edges are dropped by the dangling filter → orphan. **Fix**: make the fold unit a contiguous chain (`regionAround`) whose boundary is provably one entry + one exit; then the existing rerouting is exact and the orphan class is structurally impossible.
2. **Identity derived from shifting boundaries (Defect 1.9)**: `collapsedRunId(head, tail)` and `branchRollupId(name)` change when membership/topology shifts, so `expandedRuns`/`collapsedRuns` desync. **Fix**: key the rollup id and fold state on the **clicked commit's stable oid** (`__region__<anchorOid>`); the anchor oid does not move when the graph shifts.
3. **Control only on auto-detected run heads (Defect 1.10)**: `runHeadOf` maps only `detectRuns` heads, so `canCollapse` is true only there. **Fix**: set `canCollapse = regionAround(oid) !== null` for *any* commit, and have `onCollapse(oid)` fold `regionAround(oid)`.
4. **Auto-collapse folds the trunk on load (2.13)**: the heuristic folds every long region including the checked-out branch's first-parent chain, hiding the mainline. **Fix**: compute the HEAD-trunk oid set (first-parent walk from `headOid`) and exclude any region intersecting it from the *auto-collapse seed* only; manual collapse of trunk regions still works.
5. **Two overlapping fold mechanisms (2.12)**: linear runs and branch rollups coexist as fold units with different id schemes and different boundary semantics, which is the underlying source of the inconsistency. **Fix**: collapse both into the single on-demand region model; retire `detectRuns`/`runIdsOverlapping`/`expandSeed` as the fold mechanism and repurpose `detectBranchRollups` to ref-scoping only.

## Round 3 Correctness Properties

Property 10: Bug Condition - Region Contiguity And Orphan-Freeness

_For any_ commit whose `regionAround` is non-null, the fixed code SHALL fold exactly the contiguous chain bounded by the nearest branch point below (exclusive) and the nearest merge point above (exclusive), rerouting the region's single entry edge and single exit edge through the rollup and severing no side-branch edge — so the resulting effective graph has no orphaned/disconnected node (every non-root rendered node retains an in-edge to a rendered node).

**Validates: Requirements 2.9, 2.10**

Property 11: Bug Condition - Stable-Identity Round-Trip Consistency

_For any_ region the user folds and later expands, the fixed code SHALL key the fold/expand state on the clicked commit's stable oid (`__region__<anchorOid>`) rather than a boundary-derived id, so that a fold→expand round-trip stays consistent even when the graph shifts or an adjacent region expands (the recorded state still matches the same region).

**Validates: Requirements 2.11**

Property 12: Bug Condition - On-Demand Control Eligibility

_For any_ commit node, the fixed code SHALL show a collapse control if and only if that commit's contiguous foldable region has two or more members (`regionAround(oid) !== null`), and clicking it SHALL fold that region — so the user can fold an arbitrary eligible region on demand, and no control is shown for a lone commit (region length < 2).

**Validates: Requirements 2.8**

Property 13: Bug Condition - Model Supersession

_For any_ collapse interaction, the fixed code SHALL use the on-demand contiguous-region model as the fold unit in place of both the auto-detected linear-run rollups and the non-contiguous branch rollups — no fold node is produced by `detectRuns` or by `detectBranchRollups` as a fold unit; folds are produced only by `regionAround`/`collapseRegion`.

**Validates: Requirements 2.12**

Property 14: Bug Condition - HEAD-Exempt Auto-Collapse On Load

_For any_ repository loaded, the fixed code SHALL auto-collapse every contiguous region at or above the auto-collapse length EXCEPT any region intersecting the checked-out branch's first-parent chain (the HEAD trunk, `headOid` walked via `parents[0]`), leaving that trunk expanded on load, while every eligible node still exposes a manual collapse control and any auto-collapsed region remains expandable.

**Validates: Requirements 2.13**

Property 15: Preservation - Round 3 Non-Buggy Inputs And Reused Guarantees

_For any_ input where the Round-3 bug condition does NOT hold, the fixed code SHALL produce the same result as the pre-Round-3 (Round-2-fixed) code for the reused guarantees: single-commit regions render as normal commit nodes (3.8), expansion restores all edges and reveals the whole region in one action (3.9), a rollup click selects the newest member and updates the right pane (3.10), folding/expanding keeps the DAG connected with no dangling edges (3.5), the auto-collapse heuristic still applies on load scoped to the region model (reconciled 3.6), and branch controls continue to scope the graph at the server-ref level independent of the fold mechanism (3.11).

**Validates: Requirements 3.5, 3.6, 3.8, 3.9, 3.10, 3.11**

## Round 3 Fix Implementation

### Changes Required

**File**: `ui/src/features/graph/collapse.ts`

1. **Add `regionAround` (Defects 1.8, 1.10; Properties 10, 12)** — the new pure fold-unit function:
   ```
   FUNCTION regionAround(oid, nodes, edges, refsByOid, selectedOid)
     INPUT:  anchor oid; loaded nodes/edges; refsByOid; selectedOid
     OUTPUT: ordered member oids (newest-first) OR null

     Build in-graph childCount(source) and parentCount(target) (as detectRuns does).
     Build parentOf: child.target -> its single in-graph first-parent (edge source).
     Build childOf:  parent.source -> its single in-graph child.

     foldable(x) := selectedOid != x
                    AND (refsByOid.get(x)?.length ?? 0) == 0
                    AND parentCount(x) == 1
                    AND childCount(x) == 1

     IF NOT foldable(anchor) RETURN null   // anchor is a boundary itself

     // Walk DOWN (older) via first-parent while foldable; STOP before a branch point.
     members := [anchor]
     cur := anchor
     WHILE parentOf(cur) exists AND foldable(parentOf(cur)):
        cur := parentOf(cur); append cur   // still one-parent/one-child

     // Walk UP (newer) via the single child while foldable; STOP before a merge point.
     cur := anchor
     WHILE childOf(cur) exists AND foldable(childOf(cur)):
        cur := childOf(cur); prepend cur

     Order members newest-first by graph order.
     RETURN members.length >= 2 ? members : null
   END FUNCTION
   ```
   Notes: the `foldable` predicate already excludes branch points (childCount ≥ 2) and merge points (parentCount ≥ 2), so the walk naturally *stops before* them and the boundary commits stay visible as their own nodes (2.9). Because every member has exactly one parent and one child in-graph, the region has exactly one entry edge (from the branch point below into the oldest member) and one exit edge (from the newest member to the merge point above) (2.10). Returning `null` for length < 2 keeps a lone commit rendering as a normal node (2.8/3.8).

2. **Add `regionRollupId` / `isRegionId` (Property 11)**: `regionRollupId(anchorOid) => \`__region__${anchorOid}\``; extend `isCollapsedRunId` to also match `__region__` (so `selectionForSummaryNode`, MiniMap coloring, and jump handling treat region nodes as summary nodes). The id is keyed on the stable anchor oid, not head/tail — this is the fix for Defect 1.9.

3. **Build region `Run` groups from anchors (Property 13)**: add a helper that turns a set of fold anchors into `Run[]` for `applyCollapse`: `regionsFromAnchors(anchors, nodes, edges, refsByOid, selectedOid)` maps each anchor to `regionAround(anchor)` (dropping nulls and de-duplicating overlapping regions by anchor), producing `{ oids, id: regionRollupId(anchor) }`. These flow straight into the existing `applyCollapse` (edge rerouting **reused unchanged** — contiguity makes the reroute exact, no orphan).

4. **Add the auto-collapse seed with HEAD-trunk exemption (Property 14)**: add `autoCollapseAnchors(nodes, edges, refsByOid, selectedOid, headOid, minLen)`:
   - Compute the HEAD-trunk oid set: start at `headOid`, follow `nodeByOid.get(cur).parents[0]` while present and in-graph (the same first-parent chain `assignLanes` pins to lane 0).
   - Enumerate candidate regions (one representative anchor per maximal region), keep those with `members.length >= minLen`, and **drop any region whose members intersect the trunk set**.
   - Return the representative anchor oids. Manual collapse via `collapseRegion` still works on trunk regions on demand (the exemption is *only* on the auto seed).

5. **Re-express reversibility over anchors**: keep `effectiveExpanded` as the reversibility concept, but the sets it operates on are now anchor-oid sets (`foldAnchors` folded; a `userExpanded` set for auto-folded regions the user opened). A region is rendered folded when its anchor is in the effective-folded set. `runIdsOverlapping`/`expandSeed` are **removed** as the collapse mechanism (no longer needed — one anchor = one whole region).

6. **Retire the old fold units (Property 13)**: `detectRuns` and its `__run__` ids are no longer used to produce fold nodes. `detectBranchRollups` is **retained only** for the branch picker's server-ref scoping (which refs are fetched/shown for hidden/collapsed/expanded branches, 3.11) — its output no longer feeds `applyCollapse` as a fold unit.

**File**: `ui/src/features/graph/CommitGraph.tsx`

7. **Replace run/rollup assembly with region assembly**: replace `runs`/`runsToCollapse`/`branchRollups`(as-fold-unit)/`allGroups` with:
   - `foldAnchors` state (anchor oids) + a `userExpanded` state (anchors of auto-folded regions the user opened).
   - On load / when `graph` changes, seed `foldAnchors` from `autoCollapseAnchors(..., headOid, AUTO_COLLAPSE_LEN)` (2.13).
   - `groups = regionsFromAnchors(effectiveFolded, ...)`, then `collapsed = applyCollapse(graph.nodes, graph.edges, groups, effExpandedAnchors, nodeByOid)` — **`applyCollapse` unchanged**.
8. **`collapseRegion(anchorOid)` / `expandRegion(anchorOid)` (Defect 1.9, 2.14)**: `collapseRegion` adds the anchor to `foldAnchors` (and removes from `userExpanded`); `expandRegion` removes it / adds to `userExpanded`. These are the single fold/expand entry points, structured so a future BranchControl per-branch fold/unfold can call them with a branch-derived anchor (2.14 — wiring the picker is OUT OF SCOPE).
9. **`canCollapse` on every eligible node (Defect 1.10, Property 12)**: in `flowNodes`, set `canCollapse: regionAround(id, ...) !== null` (memoize a `regionAnchorEligible` set for the loaded graph to avoid recomputing per node) and `onCollapse: collapseRegion`. Remove the `runHeadOf`-only gating.
10. **`onNodeClick` on a region node**: reuse the Defect-1/2 fix path — `if (isCollapsedRunId(node.id)) { expandRegion(anchorFromId(node.id)); const rep = selectionForSummaryNode(node.id, runNodes); if (rep) onSelectCommit(rep); }`. `selectionForSummaryNode` and `RunNodeComponent` are **reused unchanged**; the summary node still shows count + range + "click to expand". `anchorFromId` strips the `__region__` prefix.
11. **No server-side changes** — entirely a client-side view transform, as before.

**File**: `ui/src/features/graph/CommitNodeComponent.tsx`

12. **No structural change** — the existing `canCollapse`/`onCollapse` control is reused; only its enablement predicate changes (now driven by region eligibility, wired from `CommitGraph.tsx`). Label truncation from Defect 7 stays.

## Round 3 Testing Strategy

### Round 3 Validation Approach

As with Rounds 1–2, the high-value logic is pure and lives in `collapse.ts` (`regionAround`, `regionsFromAnchors`, `autoCollapseAnchors`, `regionRollupId`), so it is validated directly with Vitest (node environment) — no DOM. The `CommitGraph.tsx`/`CommitNodeComponent.tsx` wiring (per-node control enablement, click routing, seeding on load) is verified via build + manual check per project conventions. The reused pure functions (`applyCollapse`, `selectionForSummaryNode`, `effectiveExpanded`, `orphanedMembers`) keep their existing tests green; the region model is tested through the same `orphanedMembers` invariant.

### Round 3 Exploratory Bug Condition Checking

**Goal**: Surface counterexamples for Defects 1.8/1.9/1.10 and the trunk-exemption on the current (Round-2) code, confirming the model must change.

**Test Cases**:
1. **Orphan on non-contiguous fold (Defect 1.8)**: build a branch whose `unique` set has a member with a sibling-branch child; fold via `detectBranchRollups`+`applyCollapse`; assert `orphanedMembers` is non-empty on the old model (will fail to be orphan-free), then assert the region model (`regionsFromAnchors`+`applyCollapse`) yields `orphanedMembers == []`.
2. **Id churn on shift (Defect 1.9)**: fold a linear run, mutate the loaded node set (simulate a shift changing head/tail), re-detect; assert the old `collapsedRunId` differs while the new `regionRollupId(anchor)` is stable.
3. **No control on arbitrary region (Defect 1.10)**: pick a foldable mid-branch commit that is not a `detectRuns` head; assert old `runHeadOf` lacks it while `regionAround(oid) !== null`.
4. **Trunk auto-collapsed (2.13)**: build a repo with a long `main` first-parent chain; assert the old auto-collapse folds part of the trunk, while `autoCollapseAnchors(..., headOid, minLen)` excludes every trunk-intersecting region.

### Round 3 Fix Checking

```
FOR ALL input WHERE isBugConditionRound3(input) DO
  result := fixedBehavior(input)
  ASSERT expectedBehavior(result)
    // 1.8: fold a region → orphanedMembers(effective) == []   (Property 10)
    // 1.9: fold→shift→expand by anchor → same region toggled   (Property 11)
    // 1.10: regionAround(oid) has >=2 → canCollapse true; <2 → false (Property 12)
    // model: no fold node from detectRuns/detectBranchRollups (Property 13)
    // 2.13: on-load seed excludes HEAD-trunk regions; others auto-fold (Property 14)
END FOR
```

### Round 3 Preservation Checking

```
FOR ALL input WHERE NOT isBugConditionRound3(input) DO
  ASSERT round2FixedBehavior(input) == round3FixedBehavior(input)
    // single-commit region → normal node (3.8)
    // expand → all edges restored, whole region in one action (3.9)
    // rollup click → newest member selected, right pane updated (3.10)
    // any fold/expand → DAG connected, no dangling edges (3.5)
    // no manual override → auto-collapse still applies, region-scoped (3.6)
    // branch controls → same server-ref scoping, fold-independent (3.11)
END FOR
```

**Testing Approach**: Property-based testing (fast-check under Vitest) is used for the region invariants because it exercises many random topologies:
- Generate random DAGs (linear stretches, branch points, merge points); for every foldable anchor assert `regionAround` returns a contiguous chain that (a) excludes the nearest branch/merge boundary commits, (b) has exactly one entry and one exit edge in `graph.edges`, and (c) yields `orphanedMembers == []` after `applyCollapse` (Property 10).
- Generate random fold→shift→expand sequences keyed by anchor oid; assert the same region toggles regardless of boundary shifts (Property 11).
- Generate random anchors; assert `canCollapse` ⇔ `regionAround(oid) !== null` and never true for a lone commit (Property 12).
- Generate repos with random trunks; assert `autoCollapseAnchors` never seeds a HEAD-trunk-intersecting region and always seeds non-trunk regions ≥ minLen (Property 14).
- Generate non-buggy inputs; assert region-model effective graph and selection match the Round-2 baseline for the reused guarantees (Property 15).

### Round 3 Unit Tests

- `regionAround`: contiguity (returns the maximal one-parent/one-child chain); boundary exclusion (stops before the nearest branch point below and merge point above, both left visible); ref/HEAD/selected commits break a region; returns `null` for length < 2 and for a non-foldable anchor.
- `regionRollupId`/`isCollapsedRunId`: `__region__` ids are recognized as summary ids; `anchorFromId` round-trips.
- `regionsFromAnchors` + `applyCollapse`: folding a region reroutes exactly one entry + one exit edge; `orphanedMembers(effective) == []` across fold and expand (orphan invariant over the region model).
- `autoCollapseAnchors`: seeds regions ≥ `AUTO_COLLAPSE_LEN`; excludes every region intersecting the HEAD-trunk first-parent chain; a manual `collapseRegion` on a trunk anchor still folds it.
- `effectiveExpanded` over anchor sets: fold→expand→collapse by anchor returns the folded effective graph (reversibility keyed on anchors).
- Regression: `applyCollapse`, `selectionForSummaryNode`, and the Defect 1–7 tests remain green; `detectBranchRollups` still produces the correct ref-scoping output (branch-visibility path), now decoupled from folding.

### Round 3 Integration Tests (build + manual per conventions)

- On load, `main`'s trunk is expanded while other long regions are auto-folded; clicking a rollup expands its whole region and selects the newest commit.
- Fold an arbitrary mid-branch region via its node's collapse control → it folds with no floating node; expand it → the whole region returns connected.
- Live update shifts the window; a previously folded region still expands/collapses correctly (stable anchor id).
- Cycle a branch through hidden/collapsed/expanded → server-ref scoping changes as before, independent of region folds; no "1 commit" nodes appear.

# Merge & trunk rendering — design notes

Status: agreed model, NOT yet implemented. Captured from a design discussion.
These are the intended semantics for how the commit graph should render merges
and the trunk. Implement deliberately with tests; do not rush.

## PRIMARY layout model — leaf-seeded lanes with reuse (transit-map)

This is the intended direction and supersedes the "trunk is special / fold
branches in" framing below (which is kept for context). Layout is topology-
driven; refs are just LABELS on lanes, not what creates them. This dissolves the
trunk-vs-P1/P2 layout fight: lanes come from topology, refs only annotate.

Model: lanes are seeded from LEAF commits (a commit with no children in the
loaded window), NOT from refs. Each leaf gets a lane; walking DOWN (toward
parents) a commit passes its lane to its FIRST parent, so a leaf + its
first-parent ancestry form one continuous run in one lane. Merge commits are
JUNCTIONS where flow crosses between lanes — nothing stops or folds. When two
runs converge, a lane is FREED and reused by a later (lower) leaf, so lane count
tracks CONCURRENT runs, not total branches.

Allocator sketch (commits ordered newest→oldest, as today):
1. Top-down, an unassigned commit is a leaf → allocate a lane (reuse a freed
   one, else a new column).
2. A commit passes its lane to its FIRST parent (run continues straight down).
3. Non-first parents are their own runs (own leaf → own lane); the merge draws a
   crossing edge into that lane.
4. When a parent already has a lane (two runs converge), release the current
   commit's lane for reuse below.

Why this beats ref-seeding:
- No N-times-drawn trunk: shared ancestry below a fork is one lane (whoever
  reaches it first top-down), not one lane per ref.
- Ref-less branches (merged + deleted) still get a lane — a leaf is a leaf with
  or without a ref. Refs annotate lanes; they don't create them.
- Lane reuse bounds width to max concurrent runs (what you want to see).

Design details to pin down (NOT decided yet):
- Which parent keeps the lane: FIRST parent by default (local P1 convention,
  consistent with the whole doc). Second parents are separate runs joined by an
  edge. Trunk need not be special for layout — but we MAY bias lane assignment so
  trunk lands in lane 0 / stays leftmost (a stable-column nicety, layered on top,
  not structural).
- Lane reuse policy: reuse lowest-index (or nearest) free lane to avoid lines
  jumping columns. Strong readability lever; needs tuning.
- Leaves are WINDOW-relative (no children *in the loaded window*), so scroll/
  limit changes leaves. Allocator must be deterministic per window and stable-ish
  across windows (e.g. seed leaves in fixed order by timestamp then oid) so the
  layout doesn't reshuffle on scroll.
- Merges are junctions, not folds. The fold affordance (item A) becomes OPTIONAL
  sugar (collapse a run's segment), no longer the primary way branches are shown.
- Scale: real repos have many refs but few concurrent runs; lane reuse handles
  it. Still cap + recycle lanes (register-allocation style).

Relationship to existing code: `assignLanes` in `CommitGraph.tsx` already packs
lanes and knows first-parent, so this is an EVOLUTION of it (leaf-seeding +
explicit lane free/reuse + junction edges), not a foreign engine — but still a
substantial rewrite of lane assignment. This replaces/absorbs work items A & B
below; C, D, E still stand.

## Core mental model

Git stores only the DAG skeleton: each commit is a snapshot + parent pointers.
A branch is a movable pointer to a commit, not a container. "Which branch is a
commit on" is NOT stored — it is reconstructed by walking parents from refs.

Consequences that drive the design:

- **Trunk spine continuity is a property of the trunk's ref, not of any merge's
  parent order.** `main` is one unbroken lane, walked from `refs/heads/main`
  down its FIRST-PARENT history. A merge on some *other* branch that pulled an
  older `main` into itself must NEVER truncate main's spine. main continues to
  wherever its ref points.
- A merge commit only decides **where an incoming edge attaches** to a spine —
  never whether the spine continues.
- **P1/P2 convention is local, structural, and kept.** `parents[0]` = the branch
  that was checked out at merge time (drawn as the spine-at-that-node);
  `parents[1..]` = what was merged in (drawn looping in). This matches
  `git log --first-parent`. It is the well-defined default and the fallback.

### Two orthogonal concerns (were previously conflated — do not re-conflate)

1. **Spine continuity (global):** the trunk lane is driven by the trunk REF, not
   by any merge's P1/P2. Draw main from its tip down first-parents as one lane.
2. **Incoming side at a merge node (local):** P1/P2 decides which side looped in
   AT that node. This is fine as-is and does not affect (1).

A merge that recorded an *old* main as P2 (e.g. "merge main into feature to stay
current") says nothing about whether main continues — and it does.

## Worked example (the demo that surfaced this)

- `feature-alpha` merge `fbea557` has parents `[8d622d7 (feature work), 06d07b2
  (main tip AT MERGE TIME)]`.
- main later advanced to `83b818c` (not reachable from feature-alpha).
- Correct rendering: main spine = `83b818c → 06d07b2 → 01d7e1e → 0e571bb → …`
  unbroken. `fbea557` sits on feature-alpha's line; its second-parent edge
  attaches to `06d07b2` ON the main spine. main keeps going ABOVE that point.
- The older demo merge `0e571bb` (feature-into-main) sits ON the main spine with
  `demo-feature` looping in — same rule, consistent.

## Work items (build when fresh; share the "which ref is trunk" core)

### A. Trunk-aware fold (visibility) — decides what hides behind the affordance
- Today `mergeSecondaryPath`/`mergeHideGroups` in `ui/src/features/graph/
  collapse.ts` hardcode `parents[0]` as the kept/mainline side. This is wrong
  when trunk was merged INTO a branch (trunk is `parents[1]`, gets offered for
  folding).
- Fix: choose kept-vs-folded parent by TRUNK, not by parent index. Fold the
  NON-trunk side. Fall back to P1/P2 when no trunk is identifiable.
- Trunk signal: prefer a real default branch (main/master, or `origin/HEAD`),
  NOT the checked-out HEAD (which moves and would reintroduce the bug). Cheapest
  correct source is a new server field on the graph response (see D); a
  client-only `is_head` heuristic is checkout-dependent and insufficient.
- Change points (from investigation): `mergeSecondaryPath`, `mergeHideGroups`,
  `leafTipVisibility`, `visibleMergeHideGroups`, `resolveMergeAndRegionFold`, and
  the `mergePathId`/`parseMergePathId` id contract (keep trunk fixed so the
  folded index stays >= 1, or relax the guard). Wire a trunk arg from
  `CommitGraph.tsx` (seed effect + resolve call).
- Tests: new fixture in `merge.test.ts` with trunk on `parents[1]`; assert the
  FEATURE side folds and `orphanedMembers === []`.

### B. Trunk spine continuity (layout) — decides lane placement
- `assignLanes` (in `CommitGraph.tsx`) has no trunk concept today.
- Draw the trunk as one unbroken lane from its ref down first-parents. Merge
  incoming edges attach to the correct point on that lane without truncating it.
- This is the larger layout change; do after A.

### C. "Commits included in this merge" in the detail panel
- Same set as the fold: `reachable(mergedSide) \ reachable(base)`.
- Prefer a SERVER revwalk (`push(secondary parents); hide(first/trunk parent)`)
  for an exact, window-independent list (git2 supports `revwalk.push`/`.hide`).
  Client-only reuse of `mergeSecondaryPath` is approximate (bounded by loaded
  window) and shares A's parent-selection issue.
- Surface in `CommitPanel.tsx` as a collapsible "Included N commits" list
  (short-oid/summary/author, clickable to select), near the existing
  "Merge commit (N parents)" line.
- Must be trunk-aware for the "included" side to read correctly.

### D. Server: expose the default/trunk branch on the graph response (enables A/C)
- Server already computes the default branch in `server/src/git/containment.rs`
  (`collect_ref_tips` → `is_default_branch`), but the graph endpoint does not
  carry it.
- Add `default_branch: Option<String>` (or `trunk_oid`) to `GraphData`
  (`server/src/git/graph.rs`) + `GraphResponse` (`server/src/routes/graph.rs`) +
  client `GraphResponse` (`ui/src/api/client.ts`).

### E. Merge diff semantics in the panel (related, from earlier)
- The panel's "files changed" for a merge is diff-vs-first-parent only, which is
  the least informative view and HIDES conflict-resolution ("evil merge")
  content unique to the merge commit.
- Consider a combined `--cc` diff mode (only hunks differing from ALL parents)
  and/or a "vs parent 1 / vs parent 2" toggle. Combined diff needs new server
  work; "vs parent 2" is reachable via existing `diff_two_commits`.
- Cheap first step: label the existing diff as "vs parent 1" and render
  `commit.parents` as clickable short-oids.

## Demo artifacts (keep for evaluation; unwind later on request)

- Branch `demo-feature` + merge `0e571bb` on main (feature-into-main shape).
- Branch `feature-alpha` + merge `fbea557` (main-into-feature shape) +
  `DEMO_ALPHA.md` + commit `8d622d7`.
- 4 test stashes.
Real fixes now live on main: `06d07b2` (merge labels), `83b818c` (stash fix).
`feature-alpha` holds the same fixes plus the demo commits.

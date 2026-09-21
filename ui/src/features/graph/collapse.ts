import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";

/**
 * Collapse/expand of long linear commit chains.
 *
 * Heuristic (tunable): a maximal run of consecutive commits where each commit
 * has exactly one parent AND one child *within the loaded graph*, carries no
 * ref/tag/HEAD badge, is not a merge or branch point, and isn't the selected
 * commit, is "foldable". Runs of length >= COLLAPSE_THRESHOLD are collapsed by
 * default into a single summary node ("N commits"); the user can expand any run.
 *
 * This is a pure client-side view transform over the already-loaded graph — no
 * server involvement.
 */

export const COLLAPSE_THRESHOLD = 8;

/** Synthetic id for a collapsed run summary node. Stable = first..last oid. */
export const collapsedRunId = (headOid: string, tailOid: string) =>
  `__run__${headOid}__${tailOid}`;
/**
 * True for any summary-node id: legacy linear runs (`__run__`) and branch
 * rollups (`__branch__`), plus the Round-3 on-demand contiguous-region nodes
 * (`__region__`). Used so `selectionForSummaryNode`, MiniMap coloring, and jump
 * handling treat region nodes as summary nodes too.
 */
export const isCollapsedRunId = (id: string) =>
  id.startsWith("__run__") ||
  id.startsWith("__branch__") ||
  isRegionId(id) ||
  isMergePathId(id);

/** Synthetic id for a branch "virtual squash" rollup node. */
export const branchRollupId = (branch: string) => `__branch__${branch}`;
export const isBranchRollupId = (id: string) => id.startsWith("__branch__");

// ── Round 3: on-demand contiguous-region fold ids ─────────────────────────
//
// A region's identity is keyed on the CLICKED commit's stable oid (the anchor),
// not on shifting membership boundaries. This is the fix for the inconsistent
// trunk expand/collapse (Defect 1.9): the anchor oid never moves when the graph
// shifts, so the recorded fold/expand state stays in sync with the re-detected
// region.

/** Synthetic id for a contiguous-region summary node, keyed on its anchor oid. */
export const regionRollupId = (anchorOid: string) => `__region__${anchorOid}`;
/** True for a Round-3 region summary-node id. */
export const isRegionId = (id: string) => id.startsWith("__region__");
/** Strip the `__region__` prefix to recover the anchor oid. */
export const anchorFromId = (id: string) =>
  id.startsWith("__region__") ? id.slice("__region__".length) : id;

// ── Merge secondary-path fold ids ─────────────────────────────────────────
//
// A merge's hidden secondary path is keyed on (mergeOid, parentIndex) so its
// fold identity is stable as the graph shifts — the merge oid never moves, the
// same rationale as the Round-3 region anchor (Defect 1.9). parentIndex is the
// index into `CommitNode.parents` (>= 1 for a secondary parent).

/** Synthetic id for a merge's hidden secondary-path group, keyed on the merge. */
export const mergePathId = (mergeOid: string, parentIndex: number) =>
  `__merge__${mergeOid}__${parentIndex}`;
/** True for a merge secondary-path summary-node id. */
export const isMergePathId = (id: string) => id.startsWith("__merge__");

/**
 * Parse a `mergePathId(M, k)` string back into its `(mergeOid, parentIndex)`
 * components. The id shape is `__merge__<oid>__<index>`, and because the oid is
 * a git hash (which never contains `__`) the parent index is the segment after
 * the final `__`. Returns `null` for a non-merge id or a malformed suffix. Used
 * by the wiring to rebuild `mergeSecondaryPath` groups from folded ids and to
 * key affordance metadata on the stable merge oid.
 */
export function parseMergePathId(
  id: string,
): { mergeOid: string; parentIndex: number } | null {
  if (!isMergePathId(id)) return null;
  const body = id.slice("__merge__".length);
  const sep = body.lastIndexOf("__");
  if (sep < 0) return null;
  const mergeOid = body.slice(0, sep);
  const parentIndex = Number(body.slice(sep + "__".length));
  if (!mergeOid || !Number.isInteger(parentIndex) || parentIndex < 1) return null;
  return { mergeOid, parentIndex };
}

/**
 * The ancestor closure of `roots`, INCLUSIVE of the roots themselves, walking
 * PARENT links (from a commit to its parents). Edges run parent(source) →
 * child(target), so ancestors are found by following `target → source`. The
 * walk is bounded to in-graph commits: out-of-graph roots contribute nothing,
 * every returned oid is in-graph, and `roots ∩ inGraph ⊆ result`.
 *
 * This mirrors `detectBranchRollups`' internal `ancestorsOf`, lifted to module
 * scope for reuse by the merge secondary-path helpers.
 */
export function reachableFrom(
  roots: string[],
  nodes: CommitNode[],
  edges: CommitEdge[],
): Set<string> {
  const inGraph = new Set(nodes.map((n) => n.oid));
  // child(target) → parents(sources), among in-graph commits.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }

  const seen = new Set<string>();
  const stack = roots.filter((oid) => inGraph.has(oid)); // out-of-graph roots contribute nothing
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const p of parentsOf.get(oid) ?? []) {
      if (!seen.has(p)) stack.push(p);
    }
  }
  return seen;
}

/**
 * Best-effort merge base of two commits computed from the loaded DAG: a
 * *lowest* common ancestor of `a` and `b` over the loaded edges. A commit is a
 * common ancestor when it is reachable (via parent links) from BOTH `a` and `b`
 * (`reachableFrom` is inclusive of its roots, so `a`/`b` themselves count when
 * one is an ancestor of the other). Among the common ancestors, the *lowest*
 * are those with no in-graph child that is also a common ancestor — i.e. nothing
 * newer than them is still common.
 *
 * Returns `null` when there is no common ancestor in the loaded window (e.g. two
 * disconnected roots, or the true base scrolled out of the window). When several
 * lowest common ancestors exist (a criss-cross history), returns the newest by
 * graph order (nodes are newest-first) for determinism.
 *
 * The hide-set computation does NOT depend on this value —
 * `reachable(Pk) \ reachable(P1)` already excludes the base and everything below
 * it. `mergeBaseFromEdges` is provided for display ("branch off @ <base>") and
 * as an explicit floor assertion in tests.
 */
export function mergeBaseFromEdges(
  a: string,
  b: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
): string | null {
  const fromA = reachableFrom([a], nodes, edges);
  const fromB = reachableFrom([b], nodes, edges);

  // Common ancestors: reachable from both a and b.
  const common = new Set<string>();
  for (const oid of fromA) {
    if (fromB.has(oid)) common.add(oid);
  }
  if (common.size === 0) return null;

  // In-graph child links (edges run parent(source) → child(target)).
  const inGraph = new Set(nodes.map((n) => n.oid));
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(e.target);
  }

  // Lowest common ancestors: a common ancestor with no child that is also a
  // common ancestor (nothing newer than it is still common).
  const lcas: string[] = [];
  for (const oid of common) {
    const hasCommonChild = (childrenOf.get(oid) ?? []).some((c) =>
      common.has(c),
    );
    if (!hasCommonChild) lcas.push(oid);
  }
  if (lcas.length === 0) return null;

  // Deterministic pick: newest by graph order (nodes are newest-first).
  const order = new Map(nodes.map((n, i) => [n.oid, i]));
  lcas.sort((x, y) => (order.get(x)! - order.get(y)!));
  return lcas[0];
}

/** Classification of a merge commit's parents for secondary-path folding. */
export interface MergeParents {
  mergeOid: string;
  firstParent: string; // P1 — mainline continuation
  secondaryParents: string[]; // P2..Pn — merged-in tips, in parent order
}

/**
 * A hidden secondary path behind a merge, keyed on (mergeOid, parentIndex).
 * The hide set is a SUB-DAG (branch-shaped), not necessarily a linear chain.
 */
export interface MergeHideSet {
  mergeOid: string;
  parentIndex: number; // index into CommitNode.parents (>= 1)
  secondaryParent: string; // the Pk this path descends from
  oids: string[]; // hidden commits, newest-first in graph order
  mergeBase: string | null; // merge_base(P1, Pk); the floor (stays visible)
}

/**
 * The hide set for one secondary parent of a merge: the commits reachable from
 * `Pk = parents[parentIndex]` but NOT reachable from the first parent
 * `P1 = parents[0]`.
 *
 *   hide(M, k) = reachable(Pk) \ reachable(P1)
 *
 * By construction `P1` and all of its ancestors are excluded (they are in
 * `reachable(P1)`), and the merge `M` itself is never a member (it stays visible
 * as the expand point) — guarded explicitly. `Pk` is included iff it was not
 * already merged into the mainline (i.e. `Pk ∉ reachable(P1)`). The result is a
 * SUB-DAG (branch-shaped, possibly containing inner merges), ordered newest-first
 * by graph order (nodes are newest-first / topological).
 *
 * Returns `null` when `mergeOid` is out-of-graph, `parentIndex` is not a valid
 * secondary parent (`< 1` or `>= parents.length`), `Pk` is not an in-graph
 * commit, or the hide set is empty (nothing unique to this side — e.g. an
 * already-fully-merged parent).
 *
 * `mergeBase` is populated via `mergeBaseFromEdges(P1, Pk)` — a display/floor
 * value that does not affect the hide-set oids (`reachable(Pk) \ reachable(P1)`
 * already excludes the base and everything below it). It is `null` when no
 * common ancestor is present in the loaded window.
 */
export function mergeSecondaryPath(
  mergeOid: string,
  parentIndex: number,
  nodes: CommitNode[],
  edges: CommitEdge[],
): MergeHideSet | null {
  const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
  const merge = nodeByOid.get(mergeOid);
  if (!merge) return null; // merge out-of-graph
  if (parentIndex < 1 || parentIndex >= merge.parents.length) return null; // not a secondary parent

  const firstParent = merge.parents[0];
  const secondaryParent = merge.parents[parentIndex];
  if (!nodeByOid.has(secondaryParent)) return null; // Pk not an in-graph commit

  const fromP1 = reachableFrom([firstParent], nodes, edges);
  const fromPk = reachableFrom([secondaryParent], nodes, edges);

  // hide(M,k) = reachable(Pk) \ reachable(P1). The set difference automatically
  // excludes P1 and all its ancestors; guard the merge itself so M is never a
  // member even in a degenerate graph.
  const hide = new Set<string>();
  for (const oid of fromPk) {
    if (oid === mergeOid) continue; // M stays visible as the expand point
    if (fromP1.has(oid)) continue; // reachable from P1 → excluded (base + mainline)
    hide.add(oid);
  }
  if (hide.size === 0) return null; // nothing unique to this side

  // Order newest-first by graph order (nodes are newest-first, topological) —
  // same ordering approach as regionAround / detectBranchRollups.
  const oids = nodes.map((n) => n.oid).filter((o) => hide.has(o));

  return {
    mergeOid,
    parentIndex,
    secondaryParent,
    oids,
    // Display / floor value only — does NOT affect the hide-set oids above.
    // Null when the true base is out of the loaded window (under-hide, never
    // orphan).
    mergeBase: mergeBaseFromEdges(firstParent, secondaryParent, nodes, edges),
  };
}

/**
 * All secondary-path hide sets for a merge — one per secondary parent with a
 * non-empty hide set. Iterates `parentIndex` from `1..parents.length-1` and
 * collects the non-null `mergeSecondaryPath` results, so an octopus merge with
 * `n` parents yields up to `n-1` independently collapsible groups. Returns `[]`
 * when `mergeOid` is out-of-graph or is not a merge (fewer than 2 parents).
 */
export function mergeHideGroups(
  mergeOid: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
): MergeHideSet[] {
  const merge = nodes.find((n) => n.oid === mergeOid);
  if (!merge || merge.parents.length < 2) return []; // out-of-graph or not a merge

  const groups: MergeHideSet[] = [];
  for (let k = 1; k < merge.parents.length; k++) {
    const set = mergeSecondaryPath(mergeOid, k, nodes, edges);
    if (set) groups.push(set);
  }
  return groups;
}

/**
 * Compute the DEFAULT-view fold seed: which merges' secondary paths are folded
 * on load. A "line" is shown only when its tip is a LEAF frontier — a LOCAL
 * branch tip or HEAD that is NOT reachable from any OTHER local tip / HEAD.
 * Remote-tracking refs and tags are NOT counted as "other tips" (so a branch
 * caught up with its remote doesn't collapse itself, and fetching doesn't cause
 * flicker). Everything reachable from another local tip is "already merged" and
 * is folded behind its merge node's secondary-path hide set.
 *
 * Algorithm (Property 4 / design §leafTipVisibility):
 *   1. Candidate tips = oids of local branch tips (`kind === "branch"`) + HEAD
 *      (`is_head` / `kind === "head"`); `remotebranch` and `tag` are ignored.
 *   2. `leafTips` = candidate tips whose oid is NOT reachable from any OTHER
 *      candidate tip (i.e. not an ancestor of another local tip / HEAD). A lone
 *      candidate tip is trivially a leaf (no other tip to be reachable from).
 *   3. For every merge `M` and each secondary parent, fold its hide set — add
 *      `mergePathId(M, k)` — iff none of the hide set's members is a leaf tip;
 *      leave it expanded when any member is a leaf tip (that line stays open).
 *
 * Returns the set of `mergePathId(M, k)` strings to fold by default.
 */
export function leafTipVisibility(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refs: RefLabel[],
): Set<string> {
  const inGraph = new Set(nodes.map((n) => n.oid));

  // 1. Candidate tips: local branches + HEAD; remote-tracking refs and tags are
  //    excluded entirely from the "other tip" comparison.
  const candidateTips = new Set<string>();
  for (const r of refs) {
    if (r.kind === "branch" || r.kind === "head" || r.is_head) {
      if (inGraph.has(r.oid)) candidateTips.add(r.oid);
    }
  }

  // 2. leafTips = candidate tips not reachable from any OTHER candidate tip. A
  //    lone tip has no "other tips", so `reachableFrom([])` is empty → it's a
  //    leaf.
  const tips = [...candidateTips];
  const leafTips = new Set<string>();
  for (const t of tips) {
    const others = tips.filter((o) => o !== t);
    const fromOthers = reachableFrom(others, nodes, edges);
    if (!fromOthers.has(t)) leafTips.add(t);
  }

  // 3. For every merge, fold each secondary path whose hide set contains no leaf
  //    tip; leave paths whose hide set includes a leaf tip expanded.
  const toFold = new Set<string>();
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      const hasLeaf = group.oids.some((o) => leafTips.has(o));
      if (!hasLeaf) toFold.add(mergePathId(group.mergeOid, group.parentIndex));
    }
  }
  return toFold;
}

/**
 * Recursion (Property 3 / Requirement 4): the hide groups that should be
 * OFFERED right now, given which secondary paths are currently FOLDED.
 *
 * A hidden secondary path is a sub-DAG that may contain inner merges. While an
 * enclosing path is folded, its inner merges are NOT rendered (they are members
 * of the enclosing hide set), so they must not offer their own affordance
 * (4.1). When the enclosing path is expanded, those inner merges become visible
 * and — because `mergeHideGroups` is per-merge and stateless — re-running it
 * over the current node set naturally surfaces their own hide sets (4.2, 4.3).
 *
 * This helper makes that contract explicit and pure: it re-runs
 * `mergeHideGroups` for every in-graph merge, but SKIPS any merge whose oid is
 * hidden behind a currently-folded path. `foldedPathIds` is the set of
 * `mergePathId(M, k)` strings that are folded right now (a subset of what the
 * UI records in its fold state). The result is the flat list of hide groups
 * that should currently show an affordance — inner merges appear in it exactly
 * when their enclosing path is expanded.
 *
 * Recursion is therefore *inherent* in the stateless per-merge design; this
 * function only encodes "don't offer a control for a merge you can't see yet"
 * so the caller (CommitGraph wiring, task 6) stays trivial and the recursion
 * contract is directly unit-testable.
 */
export function visibleMergeHideGroups(
  nodes: CommitNode[],
  edges: CommitEdge[],
  foldedPathIds: Set<string>,
): MergeHideSet[] {
  // Which commits are currently hidden behind a folded secondary path? A merge
  // whose oid is in this set is not rendered, so it offers no affordance.
  const hidden = new Set<string>();
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      if (foldedPathIds.has(mergePathId(group.mergeOid, group.parentIndex))) {
        for (const oid of group.oids) hidden.add(oid);
      }
    }
  }

  // Offer hide groups only for merges that are themselves visible (not hidden
  // behind a folded enclosing path).
  const visible: MergeHideSet[] = [];
  for (const n of nodes) {
    if (n.parents.length < 2) continue; // not a merge
    if (hidden.has(n.oid)) continue; // merge is itself folded away
    for (const group of mergeHideGroups(n.oid, nodes, edges)) {
      visible.push(group);
    }
  }
  return visible;
}

/**
 * A ref carried by a commit hidden inside a fold, tagged with where it sits.
 * `buried === false` → the ref is on the fold's head member (`oids[0]`, the
 * newest / tip of the group); `buried === true` → it is carried by an interior
 * (non-head) member. Used so a folded branch/remote-branch/tag never silently
 * disappears — it resurfaces as a badge on the summary node, styled head-vs-
 * buried (Requirements 16/17).
 */
export interface FoldedRef {
  ref: RefLabel;
  buried: boolean;
}

/**
 * Collect the refs carried by a group's member commits, tagged head-vs-buried.
 * `oids` is the group's ordered members, newest-first, so `oids[0]` is the head
 * member: a ref on `oids[0]` is head (`buried:false`) and a ref on any later
 * member is buried (`buried:true`). Emits one `FoldedRef` per (member, ref) pair,
 * preserving member order then ref order, and returns `[]` when no member carries
 * a ref (Requirement 16.4). Pure and DOM-free.
 */
export function foldedRefsFor(
  oids: string[],
  refsByOid: Map<string, RefLabel[]>,
): FoldedRef[] {
  const out: FoldedRef[] = [];
  oids.forEach((oid, index) => {
    for (const ref of refsByOid.get(oid) ?? []) {
      out.push({ ref, buried: index > 0 });
    }
  });
  return out;
}

export interface CollapsedRunData {
  kind: "run";
  id: string;
  count: number;
  /** oids folded into this node, newest-first (for expansion + info). */
  oids: string[];
  firstSummary: string; // newest commit summary in the run
  lastSummary: string; // oldest commit summary in the run
  newestTs: number;
  oldestTs: number;
  /** For branch rollups: the branch name being virtually squashed. */
  label?: string;
  /**
   * Refs carried by hidden members, tagged head-vs-buried (Requirements 16/17).
   * Populated when `applyCollapse` receives `refsByOid`; empty/undefined ⇒ no
   * folded-ref badge on the summary node.
   */
  foldedRefs?: FoldedRef[];
}

/** A detected foldable group (linear run OR branch rollup). */
export interface Run {
  oids: string[]; // newest-first, in graph order
  id: string;
  /** Optional branch-name label (present for branch rollups). */
  label?: string;
  /**
   * Option-A merge fold: an EXISTING rendered commit oid that folded members
   * map onto, instead of minting a `CollapsedRunData` summary node. When set,
   * `applyCollapse` creates no summary node for this group; every member oid is
   * routed to `renderAnchor` via `foldedInto`, so the boundary edge (e.g. the
   * merge's `Pk → M` secondary edge) reroutes onto the still-visible anchor and
   * the resulting self-loop is dropped. The anchor commit itself stays a normal
   * rendered node and MUST NOT appear in `oids`.
   */
  renderAnchor?: string;
}

/**
 * Detect foldable runs in the graph. Returns runs (length >= threshold) in
 * graph order. `refsByOid` includes HEAD/branch/tag; any presence blocks fold.
 */
export function detectRuns(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
  selectedOid: string | null,
  threshold = COLLAPSE_THRESHOLD,
): Run[] {
  const inGraph = new Set(nodes.map((n) => n.oid));

  // In-graph parent/child degree per commit.
  const childCount = new Map<string, number>(); // how many children point at it (source=parent)
  const parentCount = new Map<string, number>(); // how many parents it has in-graph
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    childCount.set(e.source, (childCount.get(e.source) ?? 0) + 1);
    parentCount.set(e.target, (parentCount.get(e.target) ?? 0) + 1);
  }

  const foldable = (oid: string): boolean => {
    if (selectedOid === oid) return false;
    if ((refsByOid.get(oid)?.length ?? 0) > 0) return false; // has a ref/tag/HEAD
    if ((parentCount.get(oid) ?? 0) !== 1) return false; // root or merge
    if ((childCount.get(oid) ?? 0) !== 1) return false; // tip or branch point
    return true;
  };

  // nodes are newest-first and topologically ordered. Group maximal consecutive
  // foldable commits that are actually chained (each one's parent is the next).
  const parentOf = new Map<string, string>(); // single in-graph parent
  for (const e of edges) {
    if (inGraph.has(e.source) && inGraph.has(e.target)) {
      // e: source=parent -> target=child; record child's parent
      parentOf.set(e.target, e.source);
    }
  }

  const runs: Run[] = [];
  let i = 0;
  const order = nodes.map((n) => n.oid);
  const indexOf = new Map(order.map((o, idx) => [o, idx]));
  while (i < order.length) {
    const oid = order[i];
    if (!foldable(oid)) {
      i++;
      continue;
    }
    // Start a run; extend while the chain stays foldable and contiguous.
    const run: string[] = [oid];
    let current = oid;
    while (true) {
      const parent = parentOf.get(current);
      if (parent && foldable(parent) && indexOf.has(parent)) {
        run.push(parent);
        current = parent;
      } else {
        break;
      }
    }
    if (run.length >= threshold) {
      runs.push({ oids: run, id: collapsedRunId(run[0], run[run.length - 1]) });
    }
    // Advance past the whole run (foldable or not, we consumed these).
    i = (indexOf.get(current) ?? i) + 1;
  }
  return runs;
}

// ─────────────────────────────────────────────────────────────────────────
// Round 3: on-demand contiguous-region collapse model.
//
// The atomic fold unit is the maximal *contiguous chain* of foldable commits
// around a chosen anchor commit, bounded by (and EXCLUDING) the nearest branch
// point below and the nearest merge point above. Because such a region is a
// single chain with exactly one entry edge and one exit edge, folding it via
// `applyCollapse` is inherently orphan-free (Defect 1.8 becomes structurally
// impossible). Every eligible commit (region of >= 2 members) can be folded on
// demand (Defect 1.10), and the fold identity is keyed on the anchor's stable
// oid (Defect 1.9). This supersedes `detectRuns`/`detectBranchRollups` AS THE
// FOLD MECHANISM (branch rollups remain only for server-ref scoping).
// ─────────────────────────────────────────────────────────────────────────

/**
 * The maximal contiguous foldable chain around `oid`.
 *
 * Walks DOWN via the single in-graph first-parent while each commit is foldable
 * (stops BEFORE the nearest branch point — a commit with >= 2 children), and UP
 * via the single in-graph child while foldable (stops BEFORE the nearest merge
 * point — a commit with >= 2 parents). A commit is foldable when it has exactly
 * one in-graph parent AND one in-graph child, carries no ref/tag/HEAD, and is
 * not the selected commit.
 *
 * Returns the region's member oids newest-first, or `null` when the region has
 * fewer than 2 members (a lone commit renders as a normal node — 2.8/3.8) or
 * the anchor itself is not foldable (it's a boundary/HEAD commit).
 *
 * Foldability is purely topological plus the HEAD carve-out — selection is NOT
 * a region boundary (Property 11): the selected commit is treated exactly like
 * any other commit, so the region set is invariant across different selections
 * and the selected commit keeps its fold control.
 */
export function regionAround(
  oid: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
): string[] | null {
  const inGraph = new Set(nodes.map((n) => n.oid));
  if (!inGraph.has(oid)) return null;

  // In-graph parent/child degree per commit (edges run parent(source)→child(target)).
  const childCount = new Map<string, number>();
  const parentCount = new Map<string, number>();
  const parentOf = new Map<string, string>(); // child.target -> its single in-graph parent
  const childOf = new Map<string, string>(); // parent.source -> its single in-graph child
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    childCount.set(e.source, (childCount.get(e.source) ?? 0) + 1);
    parentCount.set(e.target, (parentCount.get(e.target) ?? 0) + 1);
    parentOf.set(e.target, e.source);
    childOf.set(e.source, e.target);
  }

  // A commit carries the checked-out HEAD when its ref list has a HEAD entry
  // (`is_head` primarily; `kind === "head"` belt-and-suspenders).
  const isHead = (x: string): boolean =>
    (refsByOid.get(x) ?? []).some((r) => r.is_head || r.kind === "head");

  const foldable = (x: string): boolean => {
    // Refs (branch/remote-branch/tag) NO LONGER block folding — they surface as
    // badges on the summary node (tasks 12/13) so nothing silently disappears.
    // Only the checked-out HEAD commit stays pinned inline, so the user's current
    // position is never hidden inside a fold. The common HEAD-at-tip case is
    // already non-foldable by the one-child rule below; this gate only bites for
    // an interior/detached HEAD (one parent AND one child).
    //
    // Selection is likewise NOT a boundary (Property 11): the selected commit is
    // foldable like any other, so the region set is invariant across selections.
    if (isHead(x)) return false;
    if ((parentCount.get(x) ?? 0) !== 1) return false; // root or merge point
    if ((childCount.get(x) ?? 0) !== 1) return false; // tip or branch point
    return true;
  };

  if (!foldable(oid)) return null; // anchor is a boundary/HEAD commit itself

  // Collect members as a set first (order fixed at the end via graph order).
  const members = new Set<string>([oid]);

  // Walk DOWN (older) via first-parent while foldable; stops before a branch point.
  let cur = oid;
  while (true) {
    const parent = parentOf.get(cur);
    if (parent && !members.has(parent) && foldable(parent)) {
      members.add(parent);
      cur = parent;
    } else break;
  }

  // Walk UP (newer) via the single child while foldable; stops before a merge point.
  cur = oid;
  while (true) {
    const child = childOf.get(cur);
    if (child && !members.has(child) && foldable(child)) {
      members.add(child);
      cur = child;
    } else break;
  }

  if (members.size < 2) return null;

  // Order newest-first by graph order (nodes are newest-first, topological).
  const ordered = nodes.map((n) => n.oid).filter((o) => members.has(o));
  return ordered;
}

/**
 * Turn a set of fold anchors into `Run[]` groups for `applyCollapse`. Each anchor
 * maps to `regionAround(anchor)`; nulls are dropped and overlapping regions are
 * de-duplicated (an anchor whose region is already covered by an earlier region
 * is skipped) so no commit is claimed by two groups. The resulting `Run.id` is
 * the anchor-keyed `regionRollupId(anchor)`.
 */
export function regionsFromAnchors(
  anchors: Iterable<string>,
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
): Run[] {
  const groups: Run[] = [];
  const claimed = new Set<string>();
  for (const anchor of anchors) {
    if (claimed.has(anchor)) continue;
    const members = regionAround(anchor, nodes, edges, refsByOid);
    if (!members) continue;
    // Skip if this region overlaps an already-claimed region (dedupe).
    if (members.some((o) => claimed.has(o))) continue;
    for (const o of members) claimed.add(o);
    groups.push({ oids: members, id: regionRollupId(anchor) });
  }
  return groups;
}

/**
 * Result of `foldableNodeIds`: the set of nodes that should render a fold
 * control, plus the canonical anchor each node folds its containing region from.
 */
export interface FoldableNodes {
  /** Every node oid that should render a fold control. */
  eligible: Set<string>;
  /** node oid -> canonical region anchor oid `collapseRegion` should use. */
  anchorFor: Map<string, string>;
}

/**
 * Discover every foldable region once and mark EVERY member of each ≥ 2-member
 * region as eligible for a fold control (not just the region head) AND every
 * in-lane node IMMEDIATELY ADJACENT to such a region (Req 26.3), mapping each to
 * the region's canonical anchor.
 *
 * For each node, `regionAround(node.oid, …)` returns the ordered members
 * (newest-first) of the maximal contiguous foldable region CONTAINING that node,
 * or `null` when the region has fewer than 2 members. Because the walk expands
 * both up and down from ANY starting member, `regionAround` returns the SAME
 * ordered member list for every member of a region — so choosing the canonical
 * anchor as `members[0]` (the region's newest member) is deterministic and
 * identical no matter which member seeded the lookup. Every member is added to
 * `eligible` and mapped to that canonical anchor in `anchorFor`; re-visiting a
 * member already present is idempotent (it maps to the identical anchor).
 *
 * ADJACENCY CLAUSE (Req 26.3): a region is a contiguous linear chain bounded by
 * (and EXCLUDING) two in-lane neighbors — the region head's single in-graph
 * CHILD (the node just NEWER than the region — a tip, or a branch/merge point)
 * and the region tail's single in-graph PARENT (the node just OLDER — a root or
 * branch point). Those neighbors are NOT region members (they fail the foldable
 * topology test — e.g. a tip has zero children, a root has zero parents), so
 * without this clause they'd show no control even though clicking one should
 * fold the neighboring region. Each such neighbor is marked eligible and mapped
 * to the SAME canonical anchor, so `collapseRegion(anchorFor.get(neighbor))`
 * folds the adjacent region.
 *
 * MEMBER PRIORITY (Req 27.1): region MEMBER mappings are applied FIRST for every
 * region; adjacency mappings are added only when a node has no mapping yet
 * (`!anchorFor.has(neighbor)`). So a node that heads its OWN foldable region
 * folds ITS region — never a neighbor's.
 *
 * EXCLUSIONS (Req 26.4): the checked-out HEAD_Commit is never marked eligible by
 * the adjacency clause (it stays pinned inline). Merge-hidden exclusion (Req
 * 26.8) is NOT applied here: that happens at the graph-composition layer in
 * `CommitGraph.tsx`, which subtracts merge-hidden oids from `eligible` before
 * wiring `canCollapse`.
 *
 * Purely topological and **selection-invariant** — it takes no `selectedOid`
 * (Property 11: selection is never a region boundary), so the result is
 * identical across selections. HEAD is already excluded from region membership
 * by `regionAround`'s `foldable` predicate, and a single-commit fold is never
 * offered (`regionAround` returns `null` for < 2 members).
 */
export function foldableNodeIds(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
): FoldableNodes {
  const eligible = new Set<string>();
  const anchorFor = new Map<string, string>();

  const inGraph = new Set(nodes.map((n) => n.oid));

  // In-graph child-of / parent-of maps (edges run parent(source)→child(target)),
  // same style as regionAround. A region is linear so its head/tail each have a
  // single in-graph child/parent — the adjacency neighbors we look up below.
  const childOf = new Map<string, string>(); // parent.source -> single in-graph child
  const parentOf = new Map<string, string>(); // child.target -> single in-graph parent
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    childOf.set(e.source, e.target);
    parentOf.set(e.target, e.source);
  }

  // A commit carries the checked-out HEAD when its ref list has a HEAD entry.
  const isHead = (x: string): boolean =>
    (refsByOid.get(x) ?? []).some((r) => r.is_head || r.kind === "head");

  // Discover the distinct regions once (keyed by canonical anchor) so member
  // mappings can be applied for ALL regions BEFORE any adjacency mapping — this
  // guarantees member priority (Req 27.1) regardless of node iteration order.
  const regionByAnchor = new Map<string, string[]>();
  for (const n of nodes) {
    const members = regionAround(n.oid, nodes, edges, refsByOid);
    if (!members) continue; // lone commit / boundary / HEAD → no region
    regionByAnchor.set(members[0], members); // idempotent: same anchor => same list
  }

  // Pass 1 — members. Mark every member eligible and map to its region's
  // canonical anchor (region's newest member, members[0]).
  for (const [anchor, members] of regionByAnchor) {
    for (const m of members) {
      eligible.add(m);
      anchorFor.set(m, anchor);
    }
  }

  // Pass 2 — adjacency. For each region, mark its two immediate in-lane
  // neighbors eligible mapped to the SAME anchor, WITHOUT clobbering a node's
  // own-region mapping (members keep priority — Req 27.1) and excluding the
  // checked-out HEAD_Commit (Req 26.4).
  for (const [anchor, members] of regionByAnchor) {
    const head = members[0]; // newest member
    const tail = members[members.length - 1]; // oldest member
    // Region head's single in-graph child = the node just NEWER than the region.
    const newerNeighbor = childOf.get(head);
    // Region tail's single in-graph parent = the node just OLDER than the region.
    const olderNeighbor = parentOf.get(tail);
    for (const neighbor of [newerNeighbor, olderNeighbor]) {
      if (neighbor === undefined) continue; // no such in-graph neighbor
      if (!inGraph.has(neighbor)) continue;
      if (isHead(neighbor)) continue; // HEAD stays pinned inline (Req 26.4)
      if (anchorFor.has(neighbor)) continue; // own-region mapping wins (Req 27.1)
      eligible.add(neighbor);
      anchorFor.set(neighbor, anchor);
    }
  }

  return { eligible, anchorFor };
}

/**
 * The on-load auto-collapse seed for the contiguous-region model. Returns one
 * representative anchor oid per maximal contiguous region whose length is
 * `>= minLen`, EXCEPT any region intersecting the checked-out branch's
 * first-parent chain (the HEAD trunk — the same chain `assignLanes` pins to lane
 * 0). This keeps the mainline expanded on load while auto-folding long off-trunk
 * regions (2.13, reconciling 3.6). Manual `collapseRegion` still folds trunk
 * regions on demand — the exemption applies ONLY to this auto seed.
 */
export function autoCollapseAnchors(
  nodes: CommitNode[],
  edges: CommitEdge[],
  headOid: string | null,
  refsByOid: Map<string, RefLabel[]>,
  minLen: number,
): string[] {
  const inGraph = new Set(nodes.map((n) => n.oid));
  const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

  // HEAD-trunk oid set: first-parent walk from headOid via parents[0].
  const trunk = new Set<string>();
  if (headOid && inGraph.has(headOid)) {
    let cur: string | undefined = headOid;
    while (cur && inGraph.has(cur) && !trunk.has(cur)) {
      trunk.add(cur);
      cur = nodeByOid.get(cur)?.parents[0];
    }
  }

  // Enumerate maximal regions: one representative anchor per region, skipping
  // commits already covered by an emitted region.
  const anchors: string[] = [];
  const covered = new Set<string>();
  for (const n of nodes) {
    const oid = n.oid;
    if (covered.has(oid)) continue;
    const members = regionAround(oid, nodes, edges, refsByOid);
    if (!members) continue;
    for (const m of members) covered.add(m);
    if (members.length < minLen) continue;
    // Exempt any region intersecting the HEAD trunk.
    if (members.some((m) => trunk.has(m))) continue;
    anchors.push(oid);
  }
  return anchors;
}

/**
 * Decide which commit the right-hand detail pane should select when the user
 * clicks a summary node (linear run or branch rollup). Returns the group's
 * newest member (`oids[0]`), or `null` when the summary node id is unknown /
 * has no members (in which case the caller should leave the selection
 * unchanged rather than clearing it silently).
 */
export function selectionForSummaryNode(
  nodeId: string,
  runNodes: Map<string, CollapsedRunData>,
): string | null {
  const data = runNodes.get(nodeId);
  if (!data || data.oids.length === 0) return null;
  return data.oids[0]; // newest member
}

export interface EffectiveGraph {
  nodes: CommitNode[];
  edges: CommitEdge[];
  /** run summary nodes to render, keyed by their synthetic id. */
  runNodes: Map<string, CollapsedRunData>;
  /** oid -> run id, for any commit folded away. */
  foldedInto: Map<string, string>;
}

/**
 * Resolve the set of summary-node ids that are currently *effectively* expanded,
 * given the user's force-expand set (`expandedRuns`) and force-collapse set
 * (`collapsedRuns`). A group counts as expanded only when the user expanded it
 * AND has not since (re-)collapsed it — so a manual collapse authoritatively
 * wins over a prior expand, making the fold→expand→collapse round-trip
 * reversible (Defect 4).
 *
 * This single predicate is meant to be used uniformly wherever the graph
 * decides whether to fold a group (`runsToCollapse`, branch-rollup assembly,
 * and the `applyCollapse` override argument), replacing the three independent —
 * and previously one-way — `expandedRuns` filters.
 */
export function effectiveExpanded(
  expandedRuns: Set<string>,
  collapsedRuns: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of expandedRuns) {
    if (!collapsedRuns.has(id)) out.add(id);
  }
  return out;
}

/**
 * Every foldable-run id whose member set intersects `oids`. Used when expanding
 * a summary node so the override is seeded with ALL runs overlapping the clicked
 * group — not just the clicked id. Because a linear run's id is derived from its
 * current head/tail boundary (`__run__<head>__<tail>`), re-detection over the
 * changed node set can otherwise mint a *new* sub-run id for the still-foldable
 * remainder that isn't in the override, re-folding all but one commit (Defect 6).
 * Seeding with every overlapping id makes the whole group un-fold in one action
 * and stay un-folded across the re-render.
 */
export function runIdsOverlapping(oids: string[], runs: Run[]): string[] {
  const want = new Set(oids);
  const ids: string[] = [];
  for (const run of runs) {
    if (run.oids.some((o) => want.has(o))) ids.push(run.id);
  }
  return ids;
}

/**
 * Pure model of the graph's fold/expand resolution — the decision logic
 * extracted out of `CommitGraph.tsx` so it can be unit-tested without the DOM.
 *
 * Given the detected linear runs, the detected branch rollups, and the user's
 * force-expand (`expandedRuns`) / force-collapse (`collapsedRuns`) sets, it
 * returns the effective graph the component should render.
 *
 * A group is folded when it is NOT in the single `effectiveExpanded` set — so a
 * manual collapse authoritatively wins over a prior expand (reversible
 * round-trip, Defect 4). The effective edge set is reconciled against the FINAL
 * render-id set so no un-folded member is left parentless by the downstream
 * dangling-edge filter (Defect 5).
 */
export function resolveFoldState(
  nodes: CommitNode[],
  edges: CommitEdge[],
  linearRuns: Run[],
  branchRollups: Run[],
  expandedRuns: Set<string>,
  collapsedRuns: Set<string>,
  nodeByOid: Map<string, CommitNode>,
): EffectiveGraph {
  // Single coherent notion of "expanded": expanded unless the user re-collapsed
  // it. Used uniformly for both linear runs and branch rollups (Defect 4).
  const eff = effectiveExpanded(expandedRuns, collapsedRuns);
  const runsToCollapse = linearRuns.filter((r) => !eff.has(r.id));
  const rollupsToCollapse = branchRollups.filter((r) => !eff.has(r.id));
  const allGroups = [...rollupsToCollapse, ...runsToCollapse];
  const collapsed = applyCollapse(nodes, edges, allGroups, eff, nodeByOid);

  // Reconcile edges against the FINAL render-id set (all rendered commit oids +
  // all summary node ids). `applyCollapse` already reroutes endpoints through
  // renderId, so every effective edge endpoint is a present render id; this
  // filter is therefore a no-op safety net that guarantees no dangling edge and
  // — combined with correct rerouting — no orphaned member (Defect 5).
  const renderIds = new Set<string>([
    ...collapsed.nodes.map((n) => n.oid),
    ...collapsed.runNodes.keys(),
  ]);
  const reconciledEdges = collapsed.edges.filter(
    (e) => renderIds.has(e.source) && renderIds.has(e.target),
  );

  return { ...collapsed, edges: reconciledEdges };
}

/**
 * Pure model of the override the graph records when the user EXPANDS a summary
 * node by clicking it. Seeds the override with EVERY foldable-run id whose
 * members overlap the clicked group, so re-detection over the changed node set
 * cannot mint a new sub-run id that re-folds the remainder — the whole group
 * un-folds in one action and stays un-folded (Defect 6). The clicked id itself
 * is always included (covers branch-rollup ids, which aren't in `linearRuns`).
 */
export function expandSeed(
  clickedId: string,
  clickedOids: string[],
  linearRuns: Run[],
): Set<string> {
  const ids = new Set<string>([clickedId]);
  for (const id of runIdsOverlapping(clickedOids, linearRuns)) ids.add(id);
  return ids;
}

/**
 * No-orphan invariant checker (used by tests). Returns the oids of rendered
 * commit members that HAD a parent in the original `graph.edges` but end up with
 * no in-edge to a rendered node in the effective graph — i.e. orphaned/dangling
 * after a fold→expand round-trip (Defect 5). An empty array means the effective
 * graph is orphan-free.
 *
 * A rendered node's "in-edge" here is an effective edge whose `target` is that
 * node (edges run parent(source) → child(target), so an in-edge is the link to
 * the node's parent). Root commits (no parent in the original graph) are exempt.
 */
export function orphanedMembers(
  originalNodes: CommitNode[],
  eff: EffectiveGraph,
): string[] {
  // Which original commits had at least one parent?
  const hadParent = new Set<string>();
  for (const n of originalNodes) {
    if (n.parents.length > 0) hadParent.add(n.oid);
  }
  // Rendered commit ids (exclude summary nodes — they are synthetic).
  const renderedCommits = new Set(eff.nodes.map((n) => n.oid));
  // Which rendered ids have an in-edge (are some effective edge's target)?
  const hasInEdge = new Set<string>();
  for (const e of eff.edges) hasInEdge.add(e.target);

  const orphans: string[] = [];
  for (const oid of renderedCommits) {
    if (hadParent.has(oid) && !hasInEdge.has(oid)) orphans.push(oid);
  }
  return orphans;
}

/**
 * Produce the effective graph given which runs are expanded. Collapsed runs are
 * replaced by a single summary node; edges into/out of the run are rerouted to
 * the summary node so the DAG stays connected.
 */
export function applyCollapse(
  nodes: CommitNode[],
  edges: CommitEdge[],
  runs: Run[],
  expanded: Set<string>,
  nodeByOid: Map<string, CommitNode>,
  refsByOid?: Map<string, RefLabel[]>,
): EffectiveGraph {
  const runNodes = new Map<string, CollapsedRunData>();
  const foldedInto = new Map<string, string>();

  const collapsedRuns = runs.filter((r) => !expanded.has(r.id));
  for (const run of collapsedRuns) {
    // Option-A merge fold: fold members onto an EXISTING rendered commit
    // (the anchor) instead of minting a summary node. The anchor stays a
    // normal node; the boundary edge reroutes onto it via `renderId` and the
    // resulting self-loop is dropped by the `s === t` guard below.
    if (run.renderAnchor) {
      for (const oid of run.oids) foldedInto.set(oid, run.renderAnchor);
      continue;
    }
    const first = nodeByOid.get(run.oids[0])!; // newest
    const last = nodeByOid.get(run.oids[run.oids.length - 1])!; // oldest
    runNodes.set(run.id, {
      kind: "run",
      id: run.id,
      count: run.oids.length,
      oids: run.oids,
      firstSummary: first.summary,
      lastSummary: last.summary,
      newestTs: first.timestamp,
      oldestTs: last.timestamp,
      label: run.label,
      // Additive display metadata: refs carried by the folded members, tagged
      // head-vs-buried. Only populated when refsByOid is supplied (merge path
      // folds via renderAnchor mint no node and are handled above).
      foldedRefs: refsByOid ? foldedRefsFor(run.oids, refsByOid) : undefined,
    });
    for (const oid of run.oids) foldedInto.set(oid, run.id);
  }

  // Effective nodes: keep unfolded commits; drop folded ones (represented by run node).
  const effNodes = nodes.filter((n) => !foldedInto.has(n.oid));

  // Map an oid to its rendering id (itself, or the run node it folded into).
  // Because `foldedInto` is populated from ALL groups in this single pass, every
  // endpoint maps to its FINAL render id (a commit oid or a summary node id) —
  // so a boundary edge whose counterpart folds into a DIFFERENT group is
  // rerouted to that group's summary node rather than dropped (Defect 5).
  const renderId = (oid: string) => foldedInto.get(oid) ?? oid;

  // The final set of rendered ids (un-folded commit oids + summary node ids).
  const renderIds = new Set<string>([
    ...effNodes.map((n) => n.oid),
    ...runNodes.keys(),
  ]);

  // Rebuild edges through run nodes, dropping intra-run edges and duplicates.
  const seen = new Set<string>();
  const effEdges: CommitEdge[] = [];
  for (const e of edges) {
    const s = renderId(e.source);
    const t = renderId(e.target);
    if (s === t) continue; // edge internal to a collapsed run
    // Reconcile against the final render-id set: keep an edge only when BOTH
    // endpoints resolve to a rendered node. With correct rerouting above this is
    // a safety net (it never drops a legitimate boundary edge), but it keeps the
    // effective edge set self-consistent so no member is orphaned downstream.
    if (!renderIds.has(s) || !renderIds.has(t)) continue;
    const key = `${s}->${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    effEdges.push({ source: s, target: t });
  }

  return { nodes: effNodes, edges: effEdges, runNodes, foldedInto };
}


/**
 * Detect branch "virtual squash" rollups. For each collapsed branch, fold the
 * commits reachable from its tip but NOT reachable from any expanded anchor
 * (expanded branch tips / the rest of the shown graph) into a single rollup
 * group. The result plugs straight into `applyCollapse` (as `Run[]`).
 *
 * @param nodes           loaded commit nodes
 * @param edges           parent(source)→child(target) edges
 * @param collapsedTips   [branchName, tipOid] for each COLLAPSED branch
 * @param expandedTips    tip oids of EXPANDED branches (anchors we keep visible)
 */
export function detectBranchRollups(
  nodes: CommitNode[],
  edges: CommitEdge[],
  collapsedTips: { name: string; tip: string }[],
  expandedTips: string[],
): Run[] {
  const inGraph = new Set(nodes.map((n) => n.oid));
  // child(target) → parents(sources), among in-graph commits.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!inGraph.has(e.source) || !inGraph.has(e.target)) continue;
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }

  // Ancestors (inclusive) of a set of tips, walking first+all parents.
  const ancestorsOf = (tips: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!inGraph.has(oid) || seen.has(oid)) continue;
      seen.add(oid);
      for (const p of parentsOf.get(oid) ?? []) stack.push(p);
    }
    return seen;
  };

  // Commits kept visible by expanded branches — never fold these.
  const expandedReach = ancestorsOf(expandedTips);

  // Order lookup (newest-first) so each rollup's oids stay in graph order.
  const orderIndex = new Map(nodes.map((n, i) => [n.oid, i]));

  const rollups: Run[] = [];
  // Track commits already claimed by an earlier (more-recent) collapsed branch
  // so two collapsed branches sharing history don't double-fold.
  const claimed = new Set<string>();

  for (const { name, tip } of collapsedTips) {
    if (!inGraph.has(tip)) continue;
    const branchReach = ancestorsOf([tip]);
    const unique = [...branchReach].filter(
      (oid) => !expandedReach.has(oid) && !claimed.has(oid),
    );
    if (unique.length < 2) continue;
    unique.sort((a, b) => (orderIndex.get(a)! - orderIndex.get(b)!)); // newest-first
    for (const oid of unique) claimed.add(oid);
    rollups.push({ oids: unique, id: branchRollupId(name), label: name });
  }
  return rollups;
}


// ─────────────────────────────────────────────────────────────────────────
// Merge-fold ⨉ Region-collapse composition (task 6.1 / 6.2).
//
// Both fold mechanisms flow through the same `applyCollapse` pass, so they
// compose in one place. The rules (design §"Coexistence with Round 3
// Region-Collapse", Properties 5 + 6):
//
//   1. Compute the MERGE folds first, from the currently effectively-folded
//      merge-path ids. Each folded `mergePathId(M, k)` becomes a group with
//      `renderAnchor = M` (Option A — no minted summary node). The union of all
//      folded hide sets is the "merge-hidden" member set `Hm`.
//   2. Region seeding/eligibility is computed ONLY over commits not in `Hm`
//      (merge precedence — Requirement 7.1/7.2/12.1): a commit hidden behind a
//      merge is not also a region candidate and offers no region control.
//   3. Both group kinds fold in ONE `applyCollapse` pass, producing one
//      EffectiveGraph. Expanding a merge path removes its members from `Hm`, so
//      they regain region candidacy on the next recompute (7.3) — this falls
//      out naturally because everything is recomputed from the effective folded
//      sets.
//
// This is the DOM-free decision core the wiring (`CommitGraph.tsx`) drives and
// the reversibility / coexistence property tests exercise directly.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// Task 8.1 — Global default-view toggle: "Active lines only" vs "Full DAG".
//
// The graph's effective folded set is composed from a DEFAULT SEED plus the
// user's own manual overrides. The seed has two independent parts:
//
//   • regionSeed — long off-trunk linear regions auto-fold (Round-3
//     `autoCollapseAnchors`). This is ALWAYS applied, in both view modes.
//   • mergeSeed  — the merge default-view leaf-tip fold (`leafTipVisibility`),
//     which folds every merged line behind its merge node. This is applied
//     ONLY in "active" mode; in "full" mode it is omitted so the full DAG shows
//     with merged branches expanded by default.
//
// Crucially (Requirement 13.3) the user's manual fold/expand overrides must
// survive a view-mode flip. They are tracked SEPARATELY from the seed
// (`userCollapsed` / `userExpanded`) and are NOT reset when `viewMode` changes.
// `composeFoldSeed` is the single pure decision that combines them:
//
//   effectiveFolded = (regionSeed ∪ activeMergeSeed ∪ userCollapsed) \ userExpanded
//
// where `activeMergeSeed = viewMode === "active" ? mergeSeed : ∅`. Because the
// user overrides are applied last and are independent of `viewMode`, a
// user-collapsed path stays folded and a user-expanded path stays expanded in
// BOTH modes — only the unoverridden (default) merge paths flip.
// ─────────────────────────────────────────────────────────────────────────

/** Which default-view mode the graph is in (Requirement 13.1/13.2). */
export type ViewMode = "active" | "full";

/**
 * Compose the effective folded-id set from the default seeds and the user's
 * manual overrides, for the given view mode. Pure and DOM-free so the
 * view-mode toggle's seed logic is unit-testable (Task 8.2).
 *
 * @param viewMode       "active" applies the merge leaf-tip seed; "full" omits it
 * @param regionSeed     Round-3 region auto-collapse anchors (always applied)
 * @param mergeSeed      merge default-view leaf-tip fold ids (`leafTipVisibility`)
 * @param userCollapsed  ids the user manually folded (applied in both modes)
 * @param userExpanded   ids the user manually expanded (win over every fold)
 *
 * @returns the set of ids to fold:
 *   (regionSeed ∪ (viewMode==="active" ? mergeSeed : ∅) ∪ userCollapsed) \ userExpanded
 *
 * A user expand authoritatively wins over any seed or manual collapse (the
 * reversible round-trip of task 6), so it is subtracted last.
 */
export function composeFoldSeed(
  viewMode: ViewMode,
  regionSeed: Iterable<string>,
  mergeSeed: Iterable<string>,
  userCollapsed: Iterable<string>,
  userExpanded: Set<string>,
): Set<string> {
  const folded = new Set<string>();
  for (const id of regionSeed) folded.add(id);
  if (viewMode === "active") {
    for (const id of mergeSeed) folded.add(id);
  }
  for (const id of userCollapsed) folded.add(id);
  // A manual expand wins over every fold source (seed or manual collapse).
  for (const id of userExpanded) folded.delete(id);
  return folded;
}

/** Affordance metadata for one merge's secondary paths, threaded to the node. */
export interface MergeAffordance {
  parentIndex: number;
  id: string; // mergePathId(M, parentIndex)
  hiddenCount: number; // commits hidden behind this path
  folded: boolean; // currently folded?
  /**
   * Refs carried by commits on this secondary path, tagged head-vs-buried by
   * `group.oids` order (Requirements 16.2/17). Empty ⇒ no folded-ref badge.
   */
  foldedRefs: FoldedRef[];
}

/** Result of the composed merge + region fold resolution. */
export interface MergeRegionFold {
  /** The single effective graph after folding merge paths AND regions. */
  eff: EffectiveGraph;
  /** Union of all currently-folded merge hide-set members (`Hm`). */
  mergeHidden: Set<string>;
  /** Merge-fold groups (renderAnchor = merge oid) that were folded. */
  mergeGroups: Run[];
  /** Region groups that were folded (excludes any merge-hidden commit). */
  regionGroups: Run[];
  /**
   * Affordance metadata per merge oid: one entry per secondary parent that is
   * currently OFFERED (recursion-aware — a merge hidden behind another folded
   * path is omitted). `folded` reflects whether that path is in `foldedMergePathIds`.
   */
  affordancesByMerge: Map<string, MergeAffordance[]>;
}

/**
 * Compose the merge secondary-path folds and the Round-3 region-collapse folds
 * into one effective graph, with merge folds taking precedence.
 *
 * @param nodes                loaded commit nodes (newest-first)
 * @param edges                parent(source)→child(target) edges
 * @param refsByOid            ref badges per oid (for region foldability)
 * @param selectedOid          the selected commit. NOT used for region
 *                             foldability (Property 11 — selection is never a
 *                             region boundary); retained for the selection-follow
 *                             wiring (task 16, §3).
 * @param foldedMergePathIds   the set of `mergePathId(M,k)` currently folded
 *                             (already resolved through expand/collapse state)
 * @param regionAnchors        region fold anchors currently effective (region
 *                             oids from the auto seed + manual collapses, minus
 *                             user-expanded — resolved by the caller)
 *
 * Region anchors and members that fall inside a merge-hidden commit are dropped
 * so the two membership sets stay disjoint (Requirement 7.4).
 */
export function resolveMergeAndRegionFold(
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
  selectedOid: string | null,
  foldedMergePathIds: Set<string>,
  regionAnchors: Iterable<string>,
): MergeRegionFold {
  const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
  const inGraph = new Set(nodes.map((n) => n.oid));

  // `selectedOid` is intentionally NOT consulted for region foldability
  // (Property 11 — selection is never a region boundary). It is retained on the
  // signature for the selection-follow wiring added in task 16 (§3).
  void selectedOid;

  // 1. Merge folds first. For each folded merge-path id, rebuild its hide set
  //    via `mergeSecondaryPath` and fold it onto its merge oid (renderAnchor).
  //    A stale id whose merge/hide set is absent yields no group (inert — 10.4).
  const mergeGroups: Run[] = [];
  const mergeHidden = new Set<string>();
  for (const id of foldedMergePathIds) {
    const parsed = parseMergePathId(id);
    if (!parsed) continue;
    if (!inGraph.has(parsed.mergeOid)) continue; // stale anchor → inert
    const hide = mergeSecondaryPath(
      parsed.mergeOid,
      parsed.parentIndex,
      nodes,
      edges,
    );
    if (!hide) continue; // empty / invalid → nothing to fold
    mergeGroups.push({
      oids: hide.oids,
      id,
      renderAnchor: hide.mergeOid,
    });
    for (const oid of hide.oids) mergeHidden.add(oid);
  }

  // 2. Region seeding/eligibility excludes merge-hidden commits (merge wins).
  //    Drop any region anchor that is itself merge-hidden, and drop any region
  //    group whose members intersect `Hm`, so the two memberships are disjoint.
  const regionGroups: Run[] = [];
  const regionClaimed = new Set<string>();
  for (const anchor of regionAnchors) {
    if (mergeHidden.has(anchor)) continue; // merge precedence (7.1/7.2)
    if (regionClaimed.has(anchor)) continue;
    const members = regionAround(anchor, nodes, edges, refsByOid);
    if (!members) continue;
    // Merge-hidden overlap or already-claimed overlap → skip (disjoint, 7.4).
    if (members.some((o) => mergeHidden.has(o) || regionClaimed.has(o))) continue;
    for (const o of members) regionClaimed.add(o);
    regionGroups.push({ oids: members, id: regionRollupId(anchor) });
  }

  // 3. Fold both kinds in ONE pass. Merge groups first so their renderAnchor
  //    routing is established; regions never overlap them by construction.
  //    Pass refsByOid so minted region rollups get `foldedRefs` populated.
  const eff = applyCollapse(
    nodes,
    edges,
    [...mergeGroups, ...regionGroups],
    new Set<string>(),
    nodeByOid,
    refsByOid,
  );

  // Affordance metadata: which secondary paths are OFFERED right now
  // (recursion-aware via `visibleMergeHideGroups`), with their folded state.
  const affordancesByMerge = new Map<string, MergeAffordance[]>();
  for (const group of visibleMergeHideGroups(nodes, edges, foldedMergePathIds)) {
    const id = mergePathId(group.mergeOid, group.parentIndex);
    const entry: MergeAffordance = {
      parentIndex: group.parentIndex,
      id,
      hiddenCount: group.oids.length,
      folded: foldedMergePathIds.has(id),
      // Refs carried by this path's hidden members, head-vs-buried by group.oids
      // order (newest-first, so oids[0] is the head member) — Req 16.2/17.
      foldedRefs: foldedRefsFor(group.oids, refsByOid),
    };
    if (!affordancesByMerge.has(group.mergeOid)) {
      affordancesByMerge.set(group.mergeOid, []);
    }
    affordancesByMerge.get(group.mergeOid)!.push(entry);
  }

  return { eff, mergeHidden, mergeGroups, regionGroups, affordancesByMerge };
}

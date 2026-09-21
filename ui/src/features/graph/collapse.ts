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
  id.startsWith("__run__") || id.startsWith("__branch__") || isRegionId(id);

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
}

/** A detected foldable group (linear run OR branch rollup). */
export interface Run {
  oids: string[]; // newest-first, in graph order
  id: string;
  /** Optional branch-name label (present for branch rollups). */
  label?: string;
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
 * the anchor itself is not foldable (it's a boundary/ref/selected commit).
 */
export function regionAround(
  oid: string,
  nodes: CommitNode[],
  edges: CommitEdge[],
  refsByOid: Map<string, RefLabel[]>,
  selectedOid: string | null,
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

  const foldable = (x: string): boolean => {
    if (selectedOid === x) return false;
    if ((refsByOid.get(x)?.length ?? 0) > 0) return false; // has a ref/tag/HEAD
    if ((parentCount.get(x) ?? 0) !== 1) return false; // root or merge point
    if ((childCount.get(x) ?? 0) !== 1) return false; // tip or branch point
    return true;
  };

  if (!foldable(oid)) return null; // anchor is a boundary/ref/selected commit itself

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
  selectedOid: string | null,
): Run[] {
  const groups: Run[] = [];
  const claimed = new Set<string>();
  for (const anchor of anchors) {
    if (claimed.has(anchor)) continue;
    const members = regionAround(anchor, nodes, edges, refsByOid, selectedOid);
    if (!members) continue;
    // Skip if this region overlaps an already-claimed region (dedupe).
    if (members.some((o) => claimed.has(o))) continue;
    for (const o of members) claimed.add(o);
    groups.push({ oids: members, id: regionRollupId(anchor) });
  }
  return groups;
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
    const members = regionAround(oid, nodes, edges, refsByOid, null);
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
): EffectiveGraph {
  const runNodes = new Map<string, CollapsedRunData>();
  const foldedInto = new Map<string, string>();

  const collapsedRuns = runs.filter((r) => !expanded.has(r.id));
  for (const run of collapsedRuns) {
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

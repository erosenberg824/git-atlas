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
export const isCollapsedRunId = (id: string) => id.startsWith("__run__") || id.startsWith("__branch__");

/** Synthetic id for a branch "virtual squash" rollup node. */
export const branchRollupId = (branch: string) => `__branch__${branch}`;
export const isBranchRollupId = (id: string) => id.startsWith("__branch__");

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

export interface EffectiveGraph {
  nodes: CommitNode[];
  edges: CommitEdge[];
  /** run summary nodes to render, keyed by their synthetic id. */
  runNodes: Map<string, CollapsedRunData>;
  /** oid -> run id, for any commit folded away. */
  foldedInto: Map<string, string>;
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
  const renderId = (oid: string) => foldedInto.get(oid) ?? oid;

  // Rebuild edges through run nodes, dropping intra-run edges and duplicates.
  const seen = new Set<string>();
  const effEdges: CommitEdge[] = [];
  for (const e of edges) {
    const s = renderId(e.source);
    const t = renderId(e.target);
    if (s === t) continue; // edge internal to a collapsed run
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
    if (unique.length === 0) continue;
    unique.sort((a, b) => (orderIndex.get(a)! - orderIndex.get(b)!)); // newest-first
    for (const oid of unique) claimed.add(oid);
    rollups.push({ oids: unique, id: branchRollupId(name), label: name });
  }
  return rollups;
}

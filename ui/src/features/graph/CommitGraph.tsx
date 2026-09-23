import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import type { CommitNode, RefLabel, GraphResponse, StatusSummary } from "../../api/client";
import CommitNodeComponent from "./CommitNodeComponent";
import SpecialNodeComponent from "./SpecialNodeComponent";
import RunNodeComponent from "./RunNodeComponent";
import MergeNodeComponent from "./MergeNodeComponent";
import {
  regionAround,
  foldableNodeIds,
  autoCollapseAnchors,
  isCollapsedRunId,
  isMergePathId,
  parseMergePathId,
  mergePathId,
  mergeSecondaryPath,
  anchorFromId,
  selectionForSummaryNode,
  leafTipVisibility,
  resolveMergeAndRegionFold,
  composeFoldSeed,
  type MergeAffordance,
  type ViewMode,
} from "./collapse";

interface CommitGraphProps {
  graph: GraphResponse;
  status?: StatusSummary | null;
  selectedOid: string | null;
  onSelectCommit: (oid: string) => void;
  /**
   * Per-branch visibility. Round 3: folding is no longer driven by this — it
   * governs server-ref scoping in App.tsx (branches.ts) only, and is retained
   * here for a future BranchControl-driven per-branch fold (2.14, out of scope).
   */
  branchVisibility?: Map<string, import("./branches").BranchVisibility>;
  /** When set, center + select this commit oid (find/jump). */
  jumpToOid?: string | null;
  /** Called once a jump has been handled, so the parent can clear it. */
  onJumpConsumed?: () => void;
  /**
   * Merge-fold view mode, lifted to App.tsx so the "Collapse merged branches"
   * switch can live in the left scope overlay. `"active"` folds merged
   * side-branches behind their merge nodes; `"full"` expands the whole DAG.
   */
  viewMode?: ViewMode;
}

/** Synthetic node id for the working-tree (working + staged) pseudo-node. */
export const WORKING_NODE_ID = "__working__";
/** Synthetic node id prefix for stash nodes: `__stash__<index>`. */
export const stashNodeId = (index: number) => `__stash__${index}`;
export const isWorkingId = (id: string) => id === WORKING_NODE_ID;
export const isStashId = (id: string) => id.startsWith("__stash__");
export const stashIndexFromId = (id: string) => Number(id.slice("__stash__".length));

const nodeTypes: NodeTypes = {
  commit: CommitNodeComponent,
  special: SpecialNodeComponent,
  run: RunNodeComponent,
  merge: MergeNodeComponent,
};

/**
 * Assign each rendered item (commit OR summary/run node) a lane (column).
 *
 * Improvements over the old algorithm:
 *  - **Tight packing**: when a branch ends its lane is reclaimed and the lowest
 *    free lane is always reused, so total width = max *concurrent* branches, not
 *    the total number of branches (fixes the graph "fanning out").
 *  - **Trunk in lane 0**: the first-parent chain from the trunk tip (HEAD) is
 *    pinned to lane 0, giving a straight mainline on the left.
 *  - **Summary-node aware**: operates over `order` (the combined render order of
 *    commit oids and summary/run node ids) using `edges` already rewritten to
 *    reference those ids, so rollup nodes are first-class.
 *
 * `order` is newest-first (topological). `edges` are parent(source)→child(target)
 * among rendered ids. `trunkTip` is the id that should anchor lane 0.
 */
export function assignLanes(
  order: string[],
  edges: { source: string; target: string }[],
  trunkTip: string | null,
  firstParentOf: Map<string, string>,
): Map<string, number> {
  const lanes = new Map<string, number>();
  const rendered = new Set(order);

  // child(source=parent) → [children], and child(target) → [parents], rendered-only.
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!rendered.has(e.source) || !rendered.has(e.target)) continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(e.target);
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }

  // Trunk = first-parent chain from the trunk tip; pinned to lane 0.
  const trunkSet = new Set<string>();
  if (trunkTip && rendered.has(trunkTip)) {
    let cur: string | undefined = trunkTip;
    while (cur && rendered.has(cur) && !trunkSet.has(cur)) {
      trunkSet.add(cur);
      cur = firstParentOf.get(cur);
    }
  }
  const hasTrunk = trunkSet.size > 0;

  // activeLanes[i] = id currently occupying lane i (awaiting its parent), or null.
  const activeLanes: (string | null)[] = [];
  const claimLowestFree = (from: number): number => {
    for (let i = from; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) return i;
    }
    activeLanes.push(null);
    return activeLanes.length - 1;
  };

  for (const id of order) {
    const kids = childrenOf.get(id) ?? [];
    let lane = -1;

    if (trunkSet.has(id)) {
      lane = 0;
    } else {
      // Reuse a child's lane ONLY if this commit is that child's FIRST parent
      // (the mainline continuation). A merge's 2nd+ parents must NOT inherit the
      // merge's lane — they branch into their own lane. This is what keeps merge
      // side-branches in a separate column instead of stacking on the trunk.
      for (let i = 0; i < activeLanes.length; i++) {
        const occupant = activeLanes[i];
        if (occupant !== null && kids.includes(occupant) && firstParentOf.get(occupant) === id) {
          lane = i;
          break;
        }
      }
      if (lane === -1) lane = claimLowestFree(hasTrunk ? 1 : 0);
    }

    // Reclaim lanes held by this node's OTHER children (merged branches collapse
    // back), freeing their columns for reuse below this row.
    for (let i = 0; i < activeLanes.length; i++) {
      if (i !== lane && activeLanes[i] !== null && kids.includes(activeLanes[i]!)) {
        activeLanes[i] = null;
      }
    }

    lanes.set(id, lane);
    while (activeLanes.length <= lane) activeLanes.push(null);
    activeLanes[lane] = id;
  }

  return lanes;
}

// Node card is ~110px tall at its largest (padding + ref badges + hash/date +
// summary + author). Keep ROW_HEIGHT comfortably above that so rows never overlap.
const ROW_HEIGHT = 120;
// Lane spacing must exceed the widest node card (special/run cards are up to
// 210px, commit/merge up to 200px) plus a gap, or adjacent-lane cards overlap
// on their edges. 210px max card + 30px gap = 240.
const LANE_WIDTH = 240;
const X_BASE = 24;
const Y_BASE = 24;

export interface WorkingPlacement {
  /** Lane (column) the working node occupies. */
  lane: number;
  /** Row index the working node occupies (HEAD's row − 1). */
  row: number;
  /** True when the node sits right of HEAD's lane (HEAD is not a leaf). */
  offset: boolean;
  x: number;
  y: number;
}

/**
 * Find a collision-free cell one row ABOVE a base node for a pseudo-node
 * (working tree or a stash) that "grows out of" that base. Prefers the base's
 * own lane when free (base is a leaf / that lane is empty on the row above);
 * otherwise slides RIGHT to the lowest free lane on that row so it never
 * overlaps the base's child commit(s), another branch on that row, or any
 * previously-placed pseudo-node.
 *
 * `reserved` is an in/out set of already-claimed `"lane,row"` cells (real nodes
 * are pre-seeded; each placement adds its own cell) so multiple pseudo-nodes
 * anchored above the same base (e.g. the working node + a stash both built on
 * HEAD) fan out into distinct lanes instead of stacking on top of each other.
 *
 * Pure except for the documented mutation of `reserved`. Returns null when the
 * base isn't in the rendered window.
 */
export function placeAboveBase(
  baseOid: string | null,
  rowOf: Map<string, number>,
  laneOf: Map<string, number>,
  reserved: Set<string>,
): WorkingPlacement | null {
  if (!baseOid) return null;
  const baseRow = rowOf.get(baseOid);
  if (baseRow === undefined) return null;
  const baseLane = laneOf.get(baseOid) ?? 0;
  const targetRow = baseRow - 1;

  // Lowest free lane at or to the right of the base's lane that isn't already
  // occupied by a rendered node or an earlier pseudo-node on the target row.
  let lane = baseLane;
  while (reserved.has(`${lane},${targetRow}`)) lane++;
  reserved.add(`${lane},${targetRow}`);

  return {
    lane,
    row: targetRow,
    offset: lane !== baseLane,
    x: X_BASE + lane * LANE_WIDTH,
    y: Y_BASE + targetRow * ROW_HEIGHT,
  };
}

/** Seed a reserved-cell set from every rendered node's `"lane,row"`. */
export function reservedCellsFrom(
  rowOf: Map<string, number>,
  laneOf: Map<string, number>,
): Set<string> {
  const reserved = new Set<string>();
  for (const [id, r] of rowOf) reserved.add(`${laneOf.get(id) ?? 0},${r}`);
  return reserved;
}

/**
 * Decide where the "Working tree" pseudo-node sits. It anchors one row ABOVE
 * HEAD. In HEAD's own lane when that cell is free (HEAD is a leaf); otherwise it
 * slides RIGHT to the lowest free lane on that row so it never overlaps HEAD's
 * child commit(s) or any other branch occupying that row.
 *
 * Pure and total: given the row index of every rendered node (`rowOf`) and each
 * node's lane (`laneOf`), it returns a cell guaranteed not to collide with any
 * rendered node — the chosen (lane, row) is checked against every occupant of
 * that row. Returns null when HEAD isn't in the rendered window.
 *
 * Exported for unit testing (no DOM / React Flow needed).
 */
export function computeWorkingPlacement(
  headOid: string | null,
  rowOf: Map<string, number>,
  laneOf: Map<string, number>,
): WorkingPlacement | null {
  return placeAboveBase(headOid, rowOf, laneOf, reservedCellsFrom(rowOf, laneOf));
}

export default function CommitGraph({
  graph,
  status,
  selectedOid,
  onSelectCommit,
  jumpToOid,
  onJumpConsumed,
  viewMode = "active",
}: CommitGraphProps) {
  const refsByOid = useMemo(() => {
    const map = new Map<string, RefLabel[]>();
    for (const ref of graph.refs) {
      if (!map.has(ref.oid)) map.set(ref.oid, []);
      map.get(ref.oid)!.push(ref);
    }
    return map;
  }, [graph.refs]);

  // ── On-demand contiguous-region collapse (Round 3) + merge default view ───
  // The fold unit is a contiguous region keyed on the CLICKED commit's stable
  // oid (its anchor), OR a merge secondary path keyed on its stable merge oid
  // (`mergePathId(M, k)`). Fold/expand state is anchor-keyed so it stays
  // consistent as the graph shifts (Defect 1.9).
  //
  // The effective folded set is COMPOSED from two independent inputs so the
  // view-mode toggle (task 8) can flip the merge default seed WITHOUT discarding
  // the user's manual fold/expand state (Requirement 13.3):
  //
  //   • Default seeds — re-derived from the loaded graph on every graph change:
  //       - regionSeed: long off-trunk linear regions (`autoCollapseAnchors`),
  //         ALWAYS applied in both view modes.
  //       - mergeSeed:  the merge leaf-tip default view (`leafTipVisibility`),
  //         applied ONLY in "active" mode.
  //   • User overrides — the user's manual actions, kept SEPARATE from the
  //     seeds and NOT reset on a mere view-mode flip (only re-seeded on a graph
  //     change, like the defaults):
  //       - userCollapsed: ids the user manually folded (applied in both modes).
  //       - userExpanded:  ids the user manually expanded (win over every fold).
  //
  // `composeFoldSeed` combines them:
  //   effectiveFolded = (regionSeed ∪ activeMergeSeed ∪ userCollapsed) \ userExpanded
  // A manual expand authoritatively wins over the seed and over a manual
  // collapse, so the fold→expand→collapse round-trip stays reversible (Defect 4).
  // NOTE: `viewMode` is now a prop (lifted to App.tsx) so the "Collapse merged
  // branches" switch can live in the left scope overlay.
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());

  const nodeByOid = useMemo(() => {
    const m = new Map<string, CommitNode>();
    for (const n of graph.nodes) m.set(n.oid, n);
    return m;
  }, [graph.nodes]);

  const AUTO_COLLAPSE_LEN = 8;

  // The commit HEAD points at — anchors the trunk (lane 0) and the working node,
  // and is the exemption anchor for the auto-collapse seed (2.13).
  const headOid = useMemo(() => {
    const head = graph.refs.find((r) => r.is_head);
    return head?.oid ?? graph.nodes[0]?.oid ?? null;
  }, [graph.refs, graph.nodes]);

  // On load / whenever the graph changes, RE-DERIVE the default seeds from the
  // current node set and reset the user's manual overrides. Both seeds are
  // stable string ids keyed on a stable oid (region anchor oid / merge oid), so
  // a live-update graph shift / re-fetch doesn't desync the fold state — they're
  // re-derived from anchors that persist across the window (6.3).
  //
  //   - regionSeed: long off-trunk linear regions auto-fold (Round 3), HEAD
  //     trunk exempt (2.13). Applied in BOTH view modes.
  //   - mergeSeed:  the merge default view (`leafTipVisibility`) folds every
  //     merge whose secondary path is not a leaf line. Applied ONLY in "active"
  //     mode (the view-mode toggle flips this on/off — 13.3).
  //
  // Manual fold/expand overrides layer on top via composeFoldSeed and are reset
  // here (a genuine graph change) but NOT on a mere view-mode toggle.
  const [regionSeed, setRegionSeed] = useState<Set<string>>(new Set());
  const [mergeSeed, setMergeSeed] = useState<Set<string>>(new Set());

  // A stable signature of the current window's commit set. Live updates re-fetch
  // the graph and hand us a NEW object even when nothing relevant changed (e.g. a
  // staging-only .git write); comparing OIDs lets us tell a genuine window change
  // from a no-op refetch so we don't blow away the user's manual fold/expand.
  const nodeSig = useMemo(
    () => graph.nodes.map((n) => n.oid).join(","),
    [graph.nodes],
  );
  const prevNodeSig = useRef<string | null>(null);

  // A stable signature of EVERYTHING the default seeds are derived from — the
  // commit set (`nodeSig`), the edge set, and the ref set (branch/tag/HEAD oids
  // + which is HEAD). The seeds (`autoCollapseAnchors`, `leafTipVisibility`) are
  // pure functions of exactly these, so when the signature is unchanged a
  // live-update refetch that hands us fresh-but-identical objects would
  // recompute the SAME seeds — gating on this signature skips that wasted work
  // (the collapse passes are the graph's hot path). A genuine change (window
  // slide, branch move, new commit) changes the signature and re-seeds.
  const seedSig = useMemo(() => {
    const edgeSig = graph.edges.map((e) => `${e.source}>${e.target}`).join(",");
    const refSig = graph.refs
      .map((r) => `${r.oid}:${r.kind}:${r.is_head ? 1 : 0}`)
      .join(",");
    return `${nodeSig}|${edgeSig}|${refSig}`;
  }, [nodeSig, graph.edges, graph.refs]);
  const prevSeedSig = useRef<string | null>(null);

  useEffect(() => {
    // Gate: skip the recompute entirely when nothing the seeds depend on has
    // changed. Without this, every no-op live-update refetch re-runs the O(N+E)
    // collapse seed passes over the full node set for an identical result.
    if (prevSeedSig.current === seedSig) return;
    prevSeedSig.current = seedSig;

    const region = autoCollapseAnchors(
      graph.nodes,
      graph.edges,
      headOid,
      refsByOid,
      AUTO_COLLAPSE_LEN,
    );
    const merge = leafTipVisibility(graph.nodes, graph.edges, graph.refs);
    setRegionSeed(new Set(region));
    setMergeSeed(merge);
    // Only discard the user's manual overrides when the actual commit set
    // changed (opened a different repo, moved the time window, changed branch
    // visibility). A live-update refetch that yields the same commits preserves
    // whatever the user manually folded/expanded. This is a SEPARATE, stricter
    // condition than the seed gate above: a branch move re-seeds (seedSig
    // changed) but keeps the user's folds (nodeSig unchanged).
    if (prevNodeSig.current !== nodeSig) {
      setUserCollapsed(new Set());
      setUserExpanded(new Set());
      prevNodeSig.current = nodeSig;
    }
  }, [graph.nodes, graph.edges, graph.refs, headOid, refsByOid, nodeSig, seedSig]);

  // Effective folded ids: compose the default seeds (region always, merge only
  // in "active" mode) with the user's manual overrides. A view-mode flip only
  // changes whether `mergeSeed` participates — `userCollapsed`/`userExpanded`
  // are unchanged, so per-merge manual state survives the toggle (13.3).
  const effectiveFolded = useMemo(
    () => composeFoldSeed(viewMode, regionSeed, mergeSeed, userCollapsed, userExpanded),
    [viewMode, regionSeed, mergeSeed, userCollapsed, userExpanded],
  );

  // Build the composed fold: merge secondary-path folds AND Round-3 region
  // folds resolved in ONE pass, with merge folds taking precedence. The
  // effectively-folded set carries BOTH kinds of stable ids; split it into
  // merge-path ids and region anchors for the resolver. `resolveMergeAndRegionFold`:
  //   - rebuilds each folded merge path's hide set (renderAnchor = merge oid,
  //     Option A — no minted node) and computes the merge-hidden member set Hm,
  //   - seeds regions ONLY over commits not in Hm (a merge-hidden commit is not
  //     a region candidate — 7.1/7.2/7.4), keeping the two memberships disjoint,
  //   - folds both kinds via `applyCollapse` (reused UNCHANGED) into one graph.
  // Expanding a merge path drops its members from Hm, so those commits regain
  // region candidacy on the next recompute (7.3) — no special handling needed.
  const foldedMergePathIds = useMemo(() => {
    const s = new Set<string>();
    for (const id of effectiveFolded) if (isMergePathId(id)) s.add(id);
    return s;
  }, [effectiveFolded]);

  const regionAnchors = useMemo(() => {
    const s = new Set<string>();
    for (const id of effectiveFolded) if (!isMergePathId(id)) s.add(id);
    return s;
  }, [effectiveFolded]);

  const resolved = useMemo(
    () =>
      resolveMergeAndRegionFold(
        graph.nodes,
        graph.edges,
        refsByOid,
        selectedOid,
        foldedMergePathIds,
        regionAnchors,
      ),
    [graph.nodes, graph.edges, refsByOid, selectedOid, foldedMergePathIds, regionAnchors]
  );

  const collapsed = resolved.eff;

  // Effective edge list + region summary nodes after collapsing — everything
  // downstream (lanes, positions, flow nodes/edges) operates on these.
  const effEdges = collapsed.edges;
  const runNodes = collapsed.runNodes;

  // Fold the contiguous region OR merge secondary path anchored at `anchorId`
  // (manual collapse). `anchorId` is a stable id: a region anchor oid OR a
  // `mergePathId(M,k)` (both stable-oid-derived). Recorded as a USER override
  // (userCollapsed) separate from the default seed, so it survives a view-mode
  // toggle (13.3). Single fold entry point for both kinds — the resolver keys
  // off `isMergePathId` to route it.
  //
  // Selection-follow (Req 22 / Property 12): when the group being folded
  // includes the currently selected commit, move selection onto the resulting
  // summary node by re-selecting the fold's representative — its newest member
  // `oids[0]`, matching `selectionForSummaryNode` and the existing expand path.
  // Folds that do NOT contain the selected commit leave selection unchanged.
  const collapseRegion = useCallback(
    (anchorId: string) => {
      setUserCollapsed((prev) => new Set(prev).add(anchorId));
      setUserExpanded((prev) => {
        if (!prev.has(anchorId)) return prev;
        const next = new Set(prev);
        next.delete(anchorId);
        return next;
      });

      // Determine the folded group's members for `anchorId`, keyed on its id
      // kind: a merge secondary path (`mergePathId`) vs a region anchor.
      if (selectedOid === null) return;
      let members: string[] | null | undefined;
      const parsed = isMergePathId(anchorId) ? parseMergePathId(anchorId) : null;
      if (parsed) {
        members = mergeSecondaryPath(
          parsed.mergeOid,
          parsed.parentIndex,
          graph.nodes,
          graph.edges,
        )?.oids;
      } else {
        members = regionAround(
          anchorFromId(anchorId),
          graph.nodes,
          graph.edges,
          refsByOid,
        );
      }
      if (!members || members.length === 0) return;
      // Re-select the representative (newest member) only when the fold hides
      // the selected commit; `members[0]` = `selectionForSummaryNode` semantics.
      if (members.includes(selectedOid)) onSelectCommit(members[0]);
    },
    [selectedOid, onSelectCommit, graph.nodes, graph.edges, refsByOid],
  );

  // Expand the region OR merge secondary path anchored at `anchorId` (records a
  // USER expand override, clears any user collapse). A manual expand
  // authoritatively wins over the default seed and a prior manual collapse via
  // `composeFoldSeed`, so the whole group un-folds in one action and stays
  // un-folded across re-renders and view-mode toggles (Defect 6 / 13.3).
  const expandRegion = useCallback((anchorId: string) => {
    setUserExpanded((prev) => new Set(prev).add(anchorId));
    setUserCollapsed((prev) => {
      if (!prev.has(anchorId)) return prev;
      const next = new Set(prev);
      next.delete(anchorId);
      return next;
    });
  }, []);

  // Toggle a single merge secondary path (mergeOid, parentIndex). Threaded onto
  // merge node data so task 7's MergeNodeComponent can flip a path folded ⇄
  // expanded via one call, keyed on the stable merge oid (6.2). The `folded`
  // flag comes from the affordance metadata computed by the resolver.
  const onTogglePath = useCallback(
    (mergeOid: string, parentIndex: number, folded: boolean) => {
      const id = mergePathId(mergeOid, parentIndex);
      if (folded) expandRegion(id);
      else collapseRegion(id);
    },
    [collapseRegion, expandRegion]
  );

  // Which commits are eligible for an on-demand region-collapse control: any
  // commit whose contiguous region has >= 2 members (Defect 1.10, 2.8) AND that
  // is NOT currently hidden behind a merge secondary path. Merge folds take
  // precedence, so a merge-hidden commit is offered no region control (7.2);
  // once its merge path is expanded it drops out of `mergeHidden` and regains
  // candidacy here (7.3). Memoized over the loaded graph + merge-hidden set.
  // Fold-control eligibility (Task 18.3). `foldableNodeIds` is a single pure,
  // selection-invariant sweep that marks EVERY member of every >= 2-member
  // foldable region eligible (not just the head) and maps each to the canonical
  // anchor `collapseRegion` should fold from. Merge folds still take precedence
  // (7.2): subtract the merge-hidden members so a commit hidden behind a merge
  // secondary path is offered no region control; it regains candidacy once its
  // merge path is expanded and it drops out of `mergeHidden` (7.3).
  const { eligible, anchorFor } = useMemo(
    () => foldableNodeIds(graph.nodes, graph.edges, refsByOid),
    [graph.nodes, graph.edges, refsByOid],
  );
  const regionEligible = useMemo(() => {
    const set = new Set<string>();
    for (const id of eligible) {
      if (resolved.mergeHidden.has(id)) continue; // merge precedence (7.2)
      set.add(id);
    }
    return set;
  }, [eligible, resolved.mergeHidden]);

  // Fold the node's CONTAINING region when its control is activated: any member
  // resolves to the same canonical anchor via `anchorFor`, so a click on an
  // interior member folds the whole region (not just when the head is clicked).
  const onCollapseNode = useCallback(
    (oid: string) => collapseRegion(anchorFor.get(oid) ?? oid),
    [collapseRegion, anchorFor],
  );

  // Combined render order: walk the ORIGINAL graph order; when we hit a commit
  // that folded into a run, emit the run node once (at the position of its
  // newest member) and skip the rest. This gives run nodes a row index inline
  // with the surrounding commits.
  const renderOrder = useMemo(() => {
    const order: string[] = [];
    const emittedRun = new Set<string>();
    for (const n of graph.nodes) {
      const runId = collapsed.foldedInto.get(n.oid);
      if (runId) {
        if (!emittedRun.has(runId)) {
          order.push(runId);
          emittedRun.add(runId);
        }
      } else {
        order.push(n.oid);
      }
    }
    return order;
  }, [graph.nodes, collapsed.foldedInto]);

  // First-parent map among RENDERED ids (commit oids + summary node ids). Used
  // by the lane algorithm so a merge's 2nd+ parents branch into their own lane
  // instead of inheriting the merge's lane. A commit's first parent is
  // graph parents[0], mapped through any collapse fold to its render id.
  const firstParentOf = useMemo(() => {
    const renderId = (oid: string) => collapsed.foldedInto.get(oid) ?? oid;
    const m = new Map<string, string>();
    for (const n of graph.nodes) {
      const self = renderId(n.oid);
      const fp = n.parents[0];
      if (!fp) continue;
      const fpRender = renderId(fp);
      if (fpRender !== self && !m.has(self)) m.set(self, fpRender);
    }
    return m;
  }, [graph.nodes, collapsed.foldedInto]);

  const lanes = useMemo(
    () => assignLanes(renderOrder, effEdges, headOid, firstParentOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderOrder, effEdges, headOid, firstParentOf]
  );

  // Row index of each rendered id (commit oid OR run id).
  const indexByOid = useMemo(() => {
    const m = new Map<string, number>();
    renderOrder.forEach((id, i) => m.set(id, i));
    return m;
  }, [renderOrder]);

  // ── Stash badges ──────────────────────────────────────────────────────────
  // A stash is not a ref pointing at a commit; it's a set of changes layered on
  // top of the commit it was created on (its first parent = `base_oid`). So we
  // DON'T float a node in its own lane — that reads as clutter "just hanging
  // around". Instead each base commit gets a compact stash badge; CLICKING it
  // SELECTS the stash (its synthetic `__stash__<index>` id), which drives the
  // existing StashPanel diff in the right pane and shades the base commit as the
  // active context. No node is ever minted for a based stash. Stashes whose base
  // is off-window have no badge host, so they still render as a node (orphans)
  // so they're never lost.

  // Stashes grouped by the in-window base commit they were created on. Drives
  // the compact per-commit stash badge.
  const stashesByBase = useMemo(() => {
    const m = new Map<string, import("../../api/client").StashEntry[]>();
    if (!status) return m;
    for (const stash of status.stashes) {
      if (stash.base_oid && indexByOid.has(stash.base_oid)) {
        if (!m.has(stash.base_oid)) m.set(stash.base_oid, []);
        m.get(stash.base_oid)!.push(stash);
      }
    }
    return m;
  }, [status, indexByOid]);

  // Stashes whose base is NOT in the loaded window: no badge host → render as a
  // node so they stay visible.
  const orphanStashIndices = useMemo(() => {
    const s = new Set<number>();
    if (!status) return s;
    for (const stash of status.stashes) {
      if (!stash.base_oid || !indexByOid.has(stash.base_oid)) s.add(stash.index);
    }
    return s;
  }, [status, indexByOid]);

  // Only orphan stashes render as a node — based stashes live purely as a badge
  // on their base commit and are opened via the right-pane StashPanel.
  const visibleStashIndices = orphanStashIndices;

  // The stash index currently selected (its `__stash__<index>` node is the
  // selection), or null. Used to shade its base commit's badge as active.
  const selectedStashIndex = useMemo(
    () => (selectedOid && isStashId(selectedOid) ? stashIndexFromId(selectedOid) : null),
    [selectedOid],
  );

  const flowNodes: Node[] = useMemo(
    () =>
      renderOrder.map((id, index) => {
        const y = Y_BASE + index * ROW_HEIGHT;
        const runData = runNodes.get(id);
        if (runData) {
          // Collapsed run summary node.
          return {
            id,
            type: "run",
            position: { x: X_BASE + (lanes.get(id) ?? 0) * LANE_WIDTH, y },
            data: {
              ...runData,
              selected: id === selectedOid,
              onExpand: (rid: string) => expandRegion(anchorFromId(rid)),
            },
            selected: id === selectedOid,
          } as Node;
        }
        // Regular commit node, OR a first-class merge node when the commit has
        // >= 2 parents. Merge commits carry per-secondary-parent affordance
        // metadata + a toggle so `MergeNodeComponent` can render the
        // hidden-branch affordances; the data object is identical for both types
        // (non-merges just have an empty `hiddenGroups`).
        const commit = nodeByOid.get(id)!;
        const hiddenGroups: MergeAffordance[] =
          resolved.affordancesByMerge.get(id) ?? [];
        const isMerge = commit.parents.length >= 2;
        return {
          id,
          type: isMerge ? "merge" : "commit",
          position: { x: X_BASE + (lanes.get(id) ?? 0) * LANE_WIDTH, y },
          data: {
            commit,
            refs: refsByOid.get(id) ?? [],
            selected: id === selectedOid,
            onSelect: onSelectCommit,
            canCollapse: regionEligible.has(id),
            onCollapse: onCollapseNode,
            // Merge affordance data (empty for non-merges / merges with no
            // non-empty hide set → no affordance rendered).
            hiddenGroups,
            onTogglePath,
            // Compact stash badge: the stashes based on THIS commit, and
            // whether one of them is the current selection (so the badge shades
            // as active). Clicking selects a stash → drives the StashPanel diff.
            // Empty array → no badge rendered.
            stashes: stashesByBase.get(id) ?? [],
            selectedStashIndex,
            onSelectStash: (index: number) => onSelectCommit(stashNodeId(index)),
          },
          selected: id === selectedOid,
        } as Node;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderOrder, lanes, refsByOid, selectedOid, onSelectCommit, runNodes, nodeByOid, effEdges, regionEligible, onCollapseNode, expandRegion, resolved.affordancesByMerge, onTogglePath, stashesByBase, selectedStashIndex]
  );

  // Working-tree pseudo-node placement (shared by the node and its edge). It
  // normally sits one row ABOVE HEAD in HEAD's lane. But when HEAD is NOT a leaf,
  // that row/lane is occupied by HEAD's child commit(s), so we place the working
  // node in a FREE lane on that row: compute the lanes occupied at the target row
  // (HEAD's row index − 1) across all rendered nodes, then pick the lowest free
  // lane at or to the RIGHT of HEAD's lane. If HEAD is a leaf its own lane is
  // free and the node sits straight above, as before. `offset` is true when the
  // node ended up right of HEAD (used to route the edge through HEAD's side).
  const workingPlacement = useMemo(
    () => computeWorkingPlacement(headOid, indexByOid, lanes),
    [headOid, indexByOid, lanes],
  );

  // Stash pseudo-node placements. Each stash "grows out of" its base commit
  // (the commit it was created on), so — like the working node above HEAD — it
  // anchors one row ABOVE its base in a collision-free lane. We share ONE
  // reserved-cell set seeded with every rendered node AND the working node's
  // cell, then place stashes in order, so a stash never overlaps a commit, the
  // working node, or another stash (e.g. several stashes all based on HEAD fan
  // out to the right). Stashes whose base is outside the loaded window fall back
  // to a dedicated far-right column near the top so they stay visible.
  const stashPlacements = useMemo(() => {
    const map = new Map<number, WorkingPlacement | null>();
    if (!status) return map;
    const reserved = reservedCellsFrom(indexByOid, lanes);
    // Reserve the working node's cell so stashes never land on it.
    if (workingPlacement) {
      reserved.add(`${workingPlacement.lane},${workingPlacement.row}`);
    }
    // Only VISIBLE stashes (expanded or orphaned) claim a cell — collapsed
    // stashes live as a badge on their base commit and take no lane.
    status.stashes.forEach((stash) => {
      if (!visibleStashIndices.has(stash.index)) return;
      const base = stash.base_oid && indexByOid.has(stash.base_oid)
        ? stash.base_oid
        : null;
      map.set(stash.index, placeAboveBase(base, indexByOid, lanes, reserved));
    });
    return map;
  }, [status, workingPlacement, indexByOid, lanes, visibleStashIndices]);

  // Working-tree pseudo-node (working + staged) + one node per stash.
  const specialNodes: Node[] = useMemo(() => {
    if (!status) return [];
    const out: Node[] = [];

    if (workingPlacement) {
      out.push({
        id: WORKING_NODE_ID,
        type: "special",
        position: { x: workingPlacement.x, y: workingPlacement.y },
        data: {
          id: WORKING_NODE_ID,
          kind: "working",
          title: "Working tree",
          subtitle: status.is_dirty ? undefined : "clean — no changes",
          badges: status.is_dirty
            ? [
                { label: "staged", value: status.staged_count },
                { label: "unstaged", value: status.unstaged_count },
              ]
            : undefined,
          selected: selectedOid === WORKING_NODE_ID,
          onSelect: onSelectCommit,
        },
        selected: selectedOid === WORKING_NODE_ID,
      });
    }

    // Stash nodes: only ORPHAN stashes (their base is off-window, so there's no
    // badge host commit to attach to). Based stashes never mint a node — they
    // live as a badge on their base commit. With no in-window base an orphan
    // falls back to a far-right column near the top.
    status.stashes.forEach((stash) => {
      if (!visibleStashIndices.has(stash.index)) return;
      const placement = stashPlacements.get(stash.index);
      const id = stashNodeId(stash.index);
      const pos = placement
        ? { x: placement.x, y: placement.y }
        : { x: X_BASE, y: Y_BASE + stash.index * ROW_HEIGHT };
      out.push({
        id,
        type: "special",
        position: pos,
        data: {
          id,
          kind: "stash",
          title: `stash@{${stash.index}}`,
          subtitle: stash.message,
          selected: selectedOid === id,
          onSelect: onSelectCommit,
        },
        selected: selectedOid === id,
      });
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, workingPlacement, stashPlacements, visibleStashIndices, indexByOid, lanes, selectedOid, onSelectCommit]);

  const flowEdges: Edge[] = useMemo(
    () =>
      effEdges
        // Defensive: React Flow throws (blanking the whole canvas) if an edge
        // references a node that isn't present. Drop any such dangling edges.
        .filter((e) => indexByOid.has(e.source) && indexByOid.has(e.target))
        .map((e) => {
        // source = parent (lower on screen), target = child (higher on screen).
        // source = parent (lower on screen), target = child (higher on screen).
        // `lanes` now covers commits AND summary nodes, so a plain lookup works.
        const sourceLane = lanes.get(e.source) ?? 0;
        const targetLane = lanes.get(e.target) ?? 0;

        // Same lane → straight vertical: parent emits from its top, child
        // receives at its bottom. Different lanes (branch/merge) → route through
        // the side facing the other lane so the line bends cleanly instead of
        // crossing over intervening nodes.
        let sourceHandle = "s-top";
        let targetHandle = "t-bottom";
        if (targetLane < sourceLane) {
          // child is to the LEFT of the parent
          sourceHandle = "s-left";
          targetHandle = "t-right";
        } else if (targetLane > sourceLane) {
          // child is to the RIGHT of the parent
          sourceHandle = "s-right";
          targetHandle = "t-left";
        }

        return {
          id: `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          sourceHandle,
          targetHandle,
          type: "default",
          style: { stroke: "#30363d", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#30363d" },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effEdges, lanes, indexByOid]
  );

  // Dashed edges connecting pseudo-nodes to the commits they build on.
  const specialEdges: Edge[] = useMemo(() => {
    if (!status) return [];
    const out: Edge[] = [];

    // Working → HEAD dashed edge. Rendered whenever HEAD is in the loaded
    // window, matching the always-on working node above (independent of dirty).
    if (headOid && indexByOid.has(headOid)) {
      // Arrow points HEAD → working: HEAD (below on screen) emits toward the
      // working node's bottom. Direction reads as "the tip commit leads into
      // the uncommitted working state". When the working node is offset to the
      // RIGHT (HEAD is not a leaf), emit from HEAD's right side so the line
      // bends cleanly instead of cutting across HEAD's children; otherwise emit
      // straight up from HEAD's top.
      const offset = workingPlacement?.offset ?? false;
      out.push({
        id: `${headOid}-${WORKING_NODE_ID}`,
        source: headOid,
        target: WORKING_NODE_ID,
        sourceHandle: offset ? "s-right" : "s-top",
        targetHandle: "t-bottom",
        type: "default",
        style: { stroke: "#2f855a", strokeWidth: 2, strokeDasharray: "4 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2f855a" },
      });
    }

    status.stashes.forEach((stash) => {
      // Only draw the edge when this stash is actually shown as a node.
      if (!visibleStashIndices.has(stash.index)) return;
      if (stash.base_oid && indexByOid.has(stash.base_oid)) {
        const id = stashNodeId(stash.index);
        // Arrow points base → stash, matching the HEAD → working direction: the
        // base commit (below on screen) leads into the stashed state above it.
        // The stash sits one row ABOVE its base; when it's offset to the RIGHT
        // (base is not a leaf, or it dodged the working node / another stash),
        // emit from the base's right side so the line bends cleanly instead of
        // cutting across the base's children; otherwise emit straight up.
        const offset = stashPlacements.get(stash.index)?.offset ?? false;
        out.push({
          id: `${stash.base_oid}-${id}`,
          source: stash.base_oid,
          target: id,
          sourceHandle: offset ? "s-right" : "s-top",
          targetHandle: "t-bottom",
          type: "default",
          style: { stroke: "#b7791f", strokeWidth: 2, strokeDasharray: "4 3" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#b7791f" },
        });
      }
    });

    return out;
  }, [status, headOid, indexByOid, workingPlacement, stashPlacements, visibleStashIndices]);

  const allNodes = useMemo(
    () => [...flowNodes, ...specialNodes],
    [flowNodes, specialNodes]
  );
  const allEdges = useMemo(
    () => [...flowEdges, ...specialEdges],
    [flowEdges, specialEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(allEdges);

  useEffect(() => {
    setNodes(allNodes);
    setEdges(allEdges);
  }, [allNodes, allEdges, setNodes, setEdges]);

  // Initial viewport, computed once: "home" = HEAD (or the top of the graph)
  // near the top-left with a little padding. This makes the default state land
  // on HEAD without any imperative jump after render.
  const initialViewport = useMemo(() => {
    const homeId = (headOid && indexByOid.has(headOid)) ? headOid : renderOrder[0];
    const zoom = 0.9;
    if (!homeId) return { x: 40, y: 40, zoom };
    const nodeX = X_BASE + (lanes.get(homeId) ?? 0) * LANE_WIDTH;
    const nodeY = Y_BASE + (indexByOid.get(homeId) ?? 0) * ROW_HEIGHT;
    // Place the home node ~40px from the top-left of the pane.
    return { x: 40 - nodeX * zoom, y: 40 - nodeY * zoom, zoom };
    // Compute once on mount; later navigation uses setCenter/fitView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React Flow instance (captured on init) for imperative centering on jump.
  const rfRef = React.useRef<ReactFlowInstance | null>(null);

  // Find/jump: when jumpToOid changes, center + select the target commit. The
  // target may be folded into a rollup/run — center on its render node.
  useEffect(() => {
    if (!jumpToOid) return;
    const renderId = collapsed.foldedInto.get(jumpToOid) ?? jumpToOid;
    const idx = indexByOid.get(renderId);
    if (idx !== undefined) {
      const x = X_BASE + (lanes.get(renderId) ?? 0) * LANE_WIDTH + 90; // ~card center
      const y = Y_BASE + idx * ROW_HEIGHT + 40;
      rfRef.current?.setCenter(x, y, { zoom: 1, duration: 400 });
      if (!isCollapsedRunId(renderId)) onSelectCommit(renderId);
    }
    onJumpConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToOid]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Clicking a collapsed region summary node expands the whole region AND
      // selects a representative commit (its newest member) so the right pane
      // updates coherently. Otherwise select the clicked commit.
      if (isCollapsedRunId(node.id)) {
        expandRegion(anchorFromId(node.id));
        const rep = selectionForSummaryNode(node.id, runNodes);
        if (rep) onSelectCommit(rep);
      } else {
        onSelectCommit(node.id);
      }
    },
    [onSelectCommit, expandRegion, runNodes]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={(inst) => (rfRef.current = inst)}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        defaultViewport={initialViewport}
        fitViewOptions={{ padding: 0.15, minZoom: 0.02, maxZoom: 1.2 }}
        minZoom={0.02}
        maxZoom={1.5}
        attributionPosition="bottom-right"
        colorMode="dark"
        // Only mount nodes/edges within the viewport. With a full window of up to
        // ~500 commit cards (+ edges + MiniMap), this keeps the DOM/paint cost
        // proportional to what's on screen rather than the whole window — the
        // main client-side win for responsiveness on large graphs.
        onlyRenderVisibleElements
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          color="#21262d"
        />
        <Controls />
        <MiniMap
          pannable
          zoomable
          bgColor="#0d1117"
          nodeColor={(node) => {
            if (node.id === WORKING_NODE_ID) return "#34d399";
            if (isStashId(node.id)) return "#fbbf24";
            if (isCollapsedRunId(node.id)) return "#a855f7";
            // Brighter default fill so nodes stay legible when a tall graph is
            // scaled way down and each node becomes a couple of pixels.
            return node.selected ? "#79c0ff" : "#8b949e";
          }}
          nodeStrokeColor="#484f58"
          // Node rects are drawn in flow coordinates then scaled to fit the map,
          // so on a large graph they shrink to dots. A wider stroke keeps each
          // node's outline visible instead of fading into the background.
          nodeStrokeWidth={6}
          nodeBorderRadius={4}
          // Darken the area outside the viewport and give the viewport rect a
          // bright outline, so the current view stays findable even when it's a
          // tiny sliver of a tall graph.
          maskColor="rgba(1,4,9,0.6)"
          maskStrokeColor="#3d6fb0"
          maskStrokeWidth={2}
          // No width/height props in v12 — size the widget purely with CSS. A
          // fixed, capped box letterboxes tall graphs inside it (SVG preserves
          // aspect ratio) instead of stretching the widget tall with empty
          // space down the sides.
          style={{ width: 200, height: 160 }}
          className="!bg-[#161b22] !border !border-[#484f58] !rounded"
        />
      </ReactFlow>
    </div>
  );
}

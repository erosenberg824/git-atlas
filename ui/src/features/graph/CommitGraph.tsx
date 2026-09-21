import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
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
const LANE_WIDTH = 180;
const X_BASE = 24;
const Y_BASE = 24;

export default function CommitGraph({
  graph,
  status,
  selectedOid,
  onSelectCommit,
  jumpToOid,
  onJumpConsumed,
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
  const [viewMode, setViewMode] = useState<ViewMode>("active");
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

  useEffect(() => {
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
    setUserCollapsed(new Set());
    setUserExpanded(new Set());
  }, [graph.nodes, graph.edges, graph.refs, headOid, refsByOid]);

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

  const laneOf = (oid: string) => lanes.get(oid) ?? 0;
  const posFor = (oid: string) => {
    const idx = indexByOid.get(oid);
    if (idx === undefined) return null;
    return {
      x: X_BASE + laneOf(oid) * LANE_WIDTH,
      y: Y_BASE + idx * ROW_HEIGHT,
    };
  };

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
          },
          selected: id === selectedOid,
        } as Node;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderOrder, lanes, refsByOid, selectedOid, onSelectCommit, runNodes, nodeByOid, effEdges, regionEligible, onCollapseNode, expandRegion, resolved.affordancesByMerge, onTogglePath]
  );

  // Working-tree pseudo-node (working + staged) + one node per stash.
  const specialNodes: Node[] = useMemo(() => {
    if (!status) return [];
    const out: Node[] = [];

    // Working node: above HEAD, in HEAD's lane, only if the tree is dirty.
    if (status.is_dirty && headOid) {
      const base = posFor(headOid);
      if (base) {
        out.push({
          id: WORKING_NODE_ID,
          type: "special",
          position: { x: base.x, y: base.y - ROW_HEIGHT },
          data: {
            id: WORKING_NODE_ID,
            kind: "working",
            title: "Working tree",
            badges: [
              { label: "staged", value: status.staged_count },
              { label: "unstaged", value: status.unstaged_count },
            ],
            selected: selectedOid === WORKING_NODE_ID,
            onSelect: onSelectCommit,
          },
          selected: selectedOid === WORKING_NODE_ID,
        });
      }
    }

    // Stash nodes: placed to the right of their base commit's lane.
    status.stashes.forEach((stash) => {
      const anchor = stash.base_oid && posFor(stash.base_oid);
      const id = stashNodeId(stash.index);
      // If the base commit isn't in the loaded window, stack stashes in a
      // dedicated far-right column near the top so they're still visible.
      const pos = anchor
        ? { x: anchor.x + LANE_WIDTH, y: anchor.y - ROW_HEIGHT / 2 }
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
  }, [status, headOid, indexByOid, lanes, selectedOid, onSelectCommit]);

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

    if (status.is_dirty && headOid && indexByOid.has(headOid)) {
      out.push({
        id: `${WORKING_NODE_ID}-${headOid}`,
        source: WORKING_NODE_ID,
        target: headOid,
        sourceHandle: "s-bottom",
        targetHandle: "t-top",
        type: "default",
        style: { stroke: "#2f855a", strokeWidth: 2, strokeDasharray: "4 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2f855a" },
      });
    }

    status.stashes.forEach((stash) => {
      if (stash.base_oid && indexByOid.has(stash.base_oid)) {
        const id = stashNodeId(stash.index);
        out.push({
          id: `${id}-${stash.base_oid}`,
          source: id,
          target: stash.base_oid,
          sourceHandle: "s-bottom",
          targetHandle: "t-bottom",
          type: "default",
          style: { stroke: "#b7791f", strokeWidth: 2, strokeDasharray: "4 3" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#b7791f" },
        });
      }
    });

    return out;
  }, [status, headOid, indexByOid]);

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

  // Jump to the top of the graph (newest commit) — panning a tall graph to the
  // top by hand is tedious. Centers the first rendered node near the top.
  const jumpToTop = useCallback(() => {
    const topId = renderOrder[0];
    if (!topId) return;
    const x = X_BASE + (lanes.get(topId) ?? 0) * LANE_WIDTH + 90;
    const y = Y_BASE + 40;
    rfRef.current?.setCenter(x, y, { zoom: 0.8, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderOrder, lanes]);

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
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          color="#21262d"
        />
        <Controls />
        <Panel position="top-right" className="!mt-2 !mr-2 flex gap-2">
          <div
            className="inline-flex rounded overflow-hidden border border-[#30363d]"
            role="group"
            aria-label="Graph view mode"
          >
            <button
              onClick={() => setViewMode("active")}
              aria-pressed={viewMode === "active"}
              className={
                "px-2 py-1 text-xs " +
                (viewMode === "active"
                  ? "bg-[#1f6feb] text-white"
                  : "bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]")
              }
              title="Show only active/un-merged lines; fold merged branches behind their merge nodes"
            >
              Active lines only
            </button>
            <button
              onClick={() => setViewMode("full")}
              aria-pressed={viewMode === "full"}
              className={
                "px-2 py-1 text-xs border-l border-[#30363d] " +
                (viewMode === "full"
                  ? "bg-[#1f6feb] text-white"
                  : "bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]")
              }
              title="Show the full DAG with merged branches expanded by default"
            >
              Full DAG
            </button>
          </div>
          <button
            onClick={jumpToTop}
            className="px-2 py-1 text-xs rounded bg-[#161b22] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#58a6ff]/50"
            title="Jump to the newest commit (top of the graph)"
          >
            ↑ Top
          </button>
        </Panel>
        <MiniMap
          pannable
          zoomable
          bgColor="#0d1117"
          nodeColor={(node) => {
            if (node.id === WORKING_NODE_ID) return "#34d399";
            if (isStashId(node.id)) return "#fbbf24";
            if (isCollapsedRunId(node.id)) return "#a855f7";
            return node.selected ? "#58a6ff" : "#6e7681";
          }}
          nodeStrokeColor="#30363d"
          maskColor="rgba(88,166,255,0.10)"
          className="!bg-[#161b22] !border !border-[#30363d] !rounded"
        />
      </ReactFlow>
    </div>
  );
}

import { describe, it, expect } from "vitest";
import {
  applyCollapse,
  mergeSecondaryPath,
  visibleMergeHideGroups,
  mergeBaseFromEdges,
  leafTipVisibility,
  orphanedMembers,
  mergePathId,
  parseMergePathId,
  regionRollupId,
  selectionForSummaryNode,
  resolveMergeAndRegionFold,
  composeFoldSeed,
  regionAround,
  regionsFromAnchors,
  autoCollapseAnchors,
  foldedRefsFor,
  type Run,
  type EffectiveGraph,
  type FoldedRef,
} from "./collapse";
import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";

// ─────────────────────────────────────────────────────────────────────────
// Task 3.2 — Property 2: Orphan-Safety of a merge secondary-path fold.
//
// Folding hide(M, k) via a group with `renderAnchor: M` through applyCollapse
// (Option A) must never strand a rendered node. The sole edge crossing the fold
// boundary is the merge's secondary edge Pk → M; applyCollapse reroutes exactly
// that endpoint onto the still-visible M. Verified with the existing
// `orphanedMembers` invariant checker.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
// ─────────────────────────────────────────────────────────────────────────

function mk(oid: string, ts: number, parents: string[]): CommitNode {
  return {
    oid,
    short_oid: oid,
    summary: oid,
    author_name: "t",
    author_email: "t@t",
    timestamp: ts,
    parents,
  };
}

// Build the group that folds a merge's secondary path onto the merge itself.
function foldGroup(
  mergeOid: string,
  parentIndex: number,
  nodes: CommitNode[],
  edges: CommitEdge[],
): Run {
  const hide = mergeSecondaryPath(mergeOid, parentIndex, nodes, edges);
  if (!hide) throw new Error("expected a non-empty hide set");
  return {
    oids: hide.oids,
    id: mergePathId(mergeOid, parentIndex),
    renderAnchor: mergeOid,
  };
}

describe("Property 2: Orphan-Safety — simple feature merge", () => {
  // Topology (newest-first):
  //   trunk:   c1 <- c2 <- M (merge)  ; M also has parent f2 (feature tip)
  //   feature: c1 <- f1 <- f2
  //   M.parents = [c2 (P1, mainline), f2 (Pk, feature)]
  //
  //   c1 ──┬── c2 ──── M
  //        └── f1 ── f2 ─┘
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  it("folds the feature-only commits onto M with no orphan", () => {
    const { nodes, edges } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(hide.oids)).toEqual(new Set(["f1", "f2"]));

    const group = foldGroup("M", 1, nodes, edges);
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);

    // No orphan anywhere in the effective graph.
    expect(orphanedMembers(nodes, eff)).toEqual([]);

    // No summary node minted (Option A folds onto the existing anchor M).
    expect(eff.runNodes.size).toBe(0);

    // No hide-set member remains a rendered node; M stays rendered.
    for (const oid of hide.oids) {
      expect(eff.nodes.some((n) => n.oid === oid)).toBe(false);
      expect(eff.foldedInto.get(oid)).toBe("M");
    }
    expect(eff.nodes.some((n) => n.oid === "M")).toBe(true);

    // The sole cross-boundary edge (Pk=f2 → M) is rerouted onto M: M has an
    // in-edge, and no effective edge references a folded-away member.
    const renderIds = new Set([
      ...eff.nodes.map((n) => n.oid),
      ...eff.runNodes.keys(),
    ]);
    for (const e of eff.edges) {
      expect(renderIds.has(e.source)).toBe(true);
      expect(renderIds.has(e.target)).toBe(true);
    }
    // M receives the rerouted secondary edge (c2 -> M remains; f2 -> M becomes
    // M -> M and is dropped as a self-loop). At least the first-parent edge
    // c2 -> M survives untouched.
    expect(eff.edges.some((e) => e.source === "c2" && e.target === "M")).toBe(true);

    // First-parent side untouched: the c1 -> c2 edge is preserved.
    expect(eff.edges.some((e) => e.source === "c1" && e.target === "c2")).toBe(true);
  });
});

describe("Property 2: Orphan-Safety — sub-DAG hide set (inner merge)", () => {
  // Origin merged INTO the feature branch: the feature's contribution is a
  // sub-DAG containing its OWN inner merge.
  //
  //   c1 <- c2 <- c3 (mainline / origin)          P1 = c3
  //   c1 <- f1 <- f2 (feature)
  //   inner merge im: parents [f2, c2]  (origin merged into feature)
  //   outer merge M:  parents [c3 (P1), im (Pk)]
  //
  // hide(M,1) = reachable(im) \ reachable(c3) = { im, f2, f1 }  (c1, c2 shared)
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 9000, ["c3", "im"]),
      mk("im", 7000, ["f2", "c2"]),
      mk("c3", 8000, ["c2"]),
      mk("f2", 6000, ["f1"]),
      mk("f1", 4000, ["c1"]),
      mk("c2", 3000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c3", target: "M" },
      { source: "im", target: "M" },
      { source: "f2", target: "im" },
      { source: "c2", target: "im" },
      { source: "c2", target: "c3" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  it("folds a branch-shaped sub-DAG (with inner merge) onto M with no orphan", () => {
    const { nodes, edges } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(hide.oids)).toEqual(new Set(["im", "f2", "f1"]));
    // Sub-DAG shape: a hide-set member is itself a merge (>= 2 parents).
    expect(hide.oids.some((o) => nodeByOid.get(o)!.parents.length >= 2)).toBe(true);

    const group = foldGroup("M", 1, nodes, edges);
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);

    expect(orphanedMembers(nodes, eff)).toEqual([]);
    expect(eff.runNodes.size).toBe(0);
    for (const oid of hide.oids) {
      expect(eff.nodes.some((n) => n.oid === oid)).toBe(false);
      expect(eff.foldedInto.get(oid)).toBe("M");
    }
    // The shared c2 -> im edge (im folds to M) reroutes to c2 -> M; c2 stays
    // rendered (it's on the mainline via c3) and keeps its own history.
    const renderIds = new Set([
      ...eff.nodes.map((n) => n.oid),
      ...eff.runNodes.keys(),
    ]);
    for (const e of eff.edges) {
      expect(renderIds.has(e.source)).toBe(true);
      expect(renderIds.has(e.target)).toBe(true);
    }
    // First-parent side untouched.
    expect(eff.edges.some((e) => e.source === "c3" && e.target === "M")).toBe(true);
    expect(eff.edges.some((e) => e.source === "c2" && e.target === "c3")).toBe(true);
  });
});

describe("Property 2: Orphan-Safety — randomized merge topologies", () => {
  // Deterministic pseudo-random generator (offline, reproducible).
  function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  // Generate: a mainline of `mainLen` commits off a shared base, a feature
  // branch of `featLen` commits off the base, and a merge M whose first parent
  // is the mainline tip and secondary parent is the feature tip.
  function randomMergeFixture(
    rng: () => number,
  ): { nodes: CommitNode[]; edges: CommitEdge[]; merge: string } {
    const nodes: CommitNode[] = [];
    const edges: CommitEdge[] = [];
    let ts = 1000;

    const base = "b0";
    nodes.push(mk(base, ts, []));
    ts += 1000;

    const mainLen = 1 + Math.floor(rng() * 4); // 1..4
    let mainPrev = base;
    for (let i = 0; i < mainLen; i++) {
      const oid = `m${i + 1}`;
      nodes.push(mk(oid, ts, [mainPrev]));
      edges.push({ source: mainPrev, target: oid });
      mainPrev = oid;
      ts += 1000;
    }
    const mainTip = mainPrev;

    const featLen = 1 + Math.floor(rng() * 5); // 1..5
    let featPrev = base;
    for (let i = 0; i < featLen; i++) {
      const oid = `f${i + 1}`;
      nodes.push(mk(oid, ts, [featPrev]));
      edges.push({ source: featPrev, target: oid });
      featPrev = oid;
      ts += 1000;
    }
    const featTip = featPrev;

    const merge = "MM";
    nodes.push(mk(merge, ts, [mainTip, featTip]));
    edges.push({ source: mainTip, target: merge });
    edges.push({ source: featTip, target: merge });

    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, merge };
  }

  it("never orphans a rendered node across many generated merge folds", () => {
    const rng = makeRng(1234);
    for (let iter = 0; iter < 60; iter++) {
      const { nodes, edges, merge } = randomMergeFixture(rng);
      const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
      const hide = mergeSecondaryPath(merge, 1, nodes, edges);
      expect(hide).not.toBeNull();
      const group: Run = {
        oids: hide!.oids,
        id: mergePathId(merge, 1),
        renderAnchor: merge,
      };
      const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);
      expect(orphanedMembers(nodes, eff)).toEqual([]);
      // No summary node; every member folds onto the merge; merge stays rendered.
      expect(eff.runNodes.size).toBe(0);
      for (const oid of hide!.oids) {
        expect(eff.foldedInto.get(oid)).toBe(merge);
      }
      expect(eff.nodes.some((n) => n.oid === merge)).toBe(true);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 2.2 — mergeBaseFromEdges: lowest common ancestor over loaded edges,
// plus proof that hide-set oids are unchanged whether or not the base is
// present in-window (under-hide, never orphan).
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 2.6, 2.7, 10.6
// ─────────────────────────────────────────────────────────────────────────

describe("mergeBaseFromEdges — lowest common ancestor", () => {
  it("returns the shared base for a simple feature/mainline branch", () => {
    // c1 <- c2 (mainline)   c1 <- f1 <- f2 (feature). base(c2, f2) = c1.
    const nodes: CommitNode[] = [
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    expect(mergeBaseFromEdges("c2", "f2", nodes, edges)).toBe("c1");
  });

  it("returns the older commit when one is an ancestor of the other (linear)", () => {
    // Linear: c1 <- c2 <- c3. base(c3, c1) = c1 (reachableFrom is inclusive).
    const nodes: CommitNode[] = [
      mk("c3", 3000, ["c2"]),
      mk("c2", 2000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "c3" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    expect(mergeBaseFromEdges("c3", "c1", nodes, edges)).toBe("c1");
    // Symmetric.
    expect(mergeBaseFromEdges("c1", "c3", nodes, edges)).toBe("c1");
  });

  it("returns null when there is no common ancestor in the loaded window", () => {
    // Two disconnected roots and their chains.
    const nodes: CommitNode[] = [
      mk("a2", 4000, ["a1"]),
      mk("a1", 3000, []),
      mk("b2", 2000, ["b1"]),
      mk("b1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "a1", target: "a2" },
      { source: "b1", target: "b2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    expect(mergeBaseFromEdges("a2", "b2", nodes, edges)).toBeNull();
  });

  it("picks the newest lowest common ancestor deterministically on criss-cross", () => {
    // Two lowest common ancestors x (newer) and y (older) both reachable from
    // a and b, neither an ancestor of the other:
    //   x.parents=[r]  y.parents=[r]
    //   a.parents=[x, y]  b.parents=[x, y]
    // common(a,b) = {x, y, r}; x and y each have no *common* child → both LCAs.
    // Deterministic pick = newest by graph order = x.
    const nodes: CommitNode[] = [
      mk("a", 6000, ["x", "y"]),
      mk("b", 5000, ["x", "y"]),
      mk("x", 4000, ["r"]),
      mk("y", 3000, ["r"]),
      mk("r", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "x", target: "a" },
      { source: "y", target: "a" },
      { source: "x", target: "b" },
      { source: "y", target: "b" },
      { source: "r", target: "x" },
      { source: "r", target: "y" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    expect(mergeBaseFromEdges("a", "b", nodes, edges)).toBe("x");
  });
});

describe("mergeBaseFromEdges — hide set unaffected by base presence", () => {
  it("populates mergeBase when the base is in-window without changing oids", () => {
    // Same simple feature-merge fixture as Property 2; base c1 is in-window.
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(hide.oids)).toEqual(new Set(["f1", "f2"]));
    expect(hide.mergeBase).toBe("c1");
  });

  it("under-hides (base null) but keeps the same in-window hide set", () => {
    // Same topology, but the shared base c1 is NOT in the loaded window: c2 and
    // f1 are in-window roots (their parent c1 was not fetched). reachable(P1=c2)
    // and reachable(Pk=f2) share nothing in-window → no base. The hide set is
    // still exactly the feature-only in-window commits.
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, []), // c1 out-of-window → in-window root
      mk("c2", 5000, []), // c1 out-of-window → in-window root
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      // no edges into/out of c1 — it's out of the window
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    // Hide set is identical to the base-present case: feature-only commits.
    expect(new Set(hide.oids)).toEqual(new Set(["f1", "f2"]));
    // No common ancestor in-window → base is null (under-hide, never orphan).
    expect(hide.mergeBase).toBeNull();

    // And the fold is still orphan-safe.
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const group = foldGroup("M", 1, nodes, edges);
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 4.2 — Property 4: Default-View Leaf-Tip.
//
// leafTipVisibility folds a merge's secondary path IFF none of its hide-set
// members is a leaf tip (a local branch tip / HEAD not reachable from any other
// local tip / HEAD). A line is shown (its merge path NOT folded) exactly when
// its tip is a leaf frontier. Remote-tracking refs and tags are excluded from
// the "other tips" comparison.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4
// ─────────────────────────────────────────────────────────────────────────

function ref(
  name: string,
  oid: string,
  kind: RefLabel["kind"],
  is_head = false,
): RefLabel {
  return { name, oid, kind, is_head, tip_ts: null };
}

describe("Property 4: Default-View Leaf-Tip", () => {
  // Two feature branches off a trunk. `fMerged` is merged back into trunk (its
  // branch ref deleted); `fOpen` is still an un-merged leaf branch.
  //
  //   c1 <- c2 <- M           trunk; M.parents = [c2 (P1), fm2 (Pk)]
  //   c1 <- fm1 <- fm2        merged feature (ref gone), folded behind M
  //   c1 <- fo1 <- fo2        open feature (branch ref present), stays shown
  //
  // Local tips: trunk HEAD at M, branch "feature-open" at fo2.
  // fm2 is NOT a tip and IS reachable from M → not a leaf → M's path folds.
  // fo2 is a leaf (not reachable from M) → its line stays open (no merge path
  // exists for it anyway; it's just a branch off trunk, no merge folds it).
  function fixture(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refs: RefLabel[];
  } {
    const nodes: CommitNode[] = [
      mk("M", 9000, ["c2", "fm2"]),
      mk("fo2", 8000, ["fo1"]),
      mk("fo1", 7000, ["c1"]),
      mk("c2", 6000, ["c1"]),
      mk("fm2", 5000, ["fm1"]),
      mk("fm1", 4000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "fm2", target: "M" },
      { source: "fm1", target: "fm2" },
      { source: "c1", target: "fm1" },
      { source: "c1", target: "c2" },
      { source: "fo1", target: "fo2" },
      { source: "c1", target: "fo1" },
    ];
    const refs: RefLabel[] = [
      ref("HEAD", "M", "head", true),
      ref("feature-open", "fo2", "branch"),
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, refs };
  }

  it("folds a merged (non-leaf) path and does not fold a merge on an open leaf", () => {
    const { nodes, edges, refs } = fixture();
    const folded = leafTipVisibility(nodes, edges, refs);

    // M's secondary path (fm1, fm2) contains no leaf tip → folded.
    expect(folded.has(mergePathId("M", 1))).toBe(true);

    // Sanity: the folded id corresponds to the merged feature's hide set.
    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(hide.oids)).toEqual(new Set(["fm1", "fm2"]));

    // The only merge in the graph is M; nothing else is folded.
    expect(folded.size).toBe(1);
  });

  it("leaves a merge path expanded when its hide set contains a leaf tip", () => {
    // Same trunk, but the feature merged by M is ALSO a live leaf branch: its
    // tip fm2 is a local branch ref, and fm2 is reachable from M so M would try
    // to fold it — but because fm2 is a leaf tip, the path stays expanded.
    const nodes: CommitNode[] = [
      mk("M", 9000, ["c2", "fm2"]),
      mk("c2", 6000, ["c1"]),
      mk("fm2", 5000, ["fm1"]),
      mk("fm1", 4000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "fm2", target: "M" },
      { source: "fm1", target: "fm2" },
      { source: "c1", target: "fm1" },
      { source: "c1", target: "c2" },
    ];
    // fm2 is reachable from M (the merge tip), so it would NOT be a leaf if M
    // were a candidate tip. Make the ONLY local tips be the branch at fm2 (no
    // HEAD/branch at M), so fm2 is a leaf → M's path stays expanded.
    const refs: RefLabel[] = [ref("feature", "fm2", "branch")];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const folded = leafTipVisibility(nodes, edges, refs);
    expect(folded.has(mergePathId("M", 1))).toBe(false);
    expect(folded.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 4.3 — Default-view worked cases.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 5.2, 8.5, 8.6
// ─────────────────────────────────────────────────────────────────────────

describe("leafTipVisibility — worked default-view cases", () => {
  it("keeps an un-merged feature branch open (its tip is a leaf)", () => {
    // Trunk + one un-merged feature branch, no merge yet. Both trunk HEAD and
    // the feature tip are leaves (neither reachable from the other). There is
    // no merge, so nothing is folded.
    const nodes: CommitNode[] = [
      mk("c2", 4000, ["c1"]),
      mk("f2", 3000, ["f1"]),
      mk("f1", 2000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c1", target: "c2" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
    ];
    const refs: RefLabel[] = [
      ref("HEAD", "c2", "head", true),
      ref("feature", "f2", "branch"),
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const folded = leafTipVisibility(nodes, edges, refs);
    expect(folded.size).toBe(0);
  });

  it("folds a merged feature behind its merge node when the branch ref is gone", () => {
    // Trunk with a merged feature; the feature branch ref was deleted (only
    // HEAD at the merge remains). The feature's commits are not leaf tips →
    // fold M's secondary path.
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    const refs: RefLabel[] = [ref("HEAD", "M", "head", true)];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const folded = leafTipVisibility(nodes, edges, refs);
    expect(folded.has(mergePathId("M", 1))).toBe(true);
  });

  it("does not self-fold a branch caught up to its remote (remote refs ignored)", () => {
    // A local branch and a remotebranch at the SAME oid. The remote ref must be
    // excluded from the "other tips" comparison, so the local branch is not
    // reachable from another *counted* tip → it stays a leaf. With a merge whose
    // secondary path is that same leaf line, the path must NOT fold.
    //
    //   c1 <- c2 <- M      M.parents = [c2 (P1), f2 (Pk)]
    //   c1 <- f1 <- f2     local branch "feature" AND origin/feature at f2
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("c2", 5000, ["c1"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    const refs: RefLabel[] = [
      ref("feature", "f2", "branch"),
      ref("origin/feature", "f2", "remotebranch"),
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    // f2 is the only counted (local) tip → it's a leaf; the remotebranch at the
    // same oid must not turn it into a non-leaf. M's secondary path (f1, f2)
    // contains the leaf f2 → not folded.
    const folded = leafTipVisibility(nodes, edges, refs);
    expect(folded.has(mergePathId("M", 1))).toBe(false);
  });

  it("does not let a tag keep a merged line open (tags ignored)", () => {
    // Trunk with a merged feature; a tag sits on a merged feature commit. Tags
    // are excluded from tip comparison, so the tag does not make the feature a
    // leaf → M's secondary path still folds.
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    const refs: RefLabel[] = [
      ref("HEAD", "M", "head", true),
      ref("v1.0", "f2", "tag"),
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const folded = leafTipVisibility(nodes, edges, refs);
    expect(folded.has(mergePathId("M", 1))).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 5.2 — Property 3: Recursion.
//
// A hidden secondary path is a sub-DAG that may contain inner merges. While the
// outer path is folded, each inner merge is unrendered (a member of the outer
// hide set → folded onto the outer merge M). When the outer merge is EXPANDED,
// each inner merge becomes an independently collapsible merge node, and
// re-running mergeHideGroups over the now-visible commit set surfaces the inner
// merge's OWN non-empty hide set. Expanding only the inner path reveals only
// its unique commits.
//
// Recursion is inherent in the stateless per-merge design (mergeHideGroups is
// per-merge and takes whatever nodes/edges it is given). `visibleMergeHideGroups`
// encodes the "don't offer a control for a merge you can't see yet" contract and
// is tested directly here too.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 4.1, 4.2, 4.3
// ─────────────────────────────────────────────────────────────────────────

describe("Property 3: Recursion — nested merge inside a secondary path", () => {
  // Origin merged INTO the feature branch: the outer merge M's secondary path
  // (hide set) contains the feature's OWN inner merge `im` (a sub-DAG).
  //
  //   c1 <- c2 <- c3 (mainline / origin)          P1(M) = c3
  //   c1 <- f1 <- f2 (feature)
  //   inner merge im: parents [f2, c2]  (origin merged into feature)
  //   outer merge M:  parents [c3 (P1), im (Pk)]
  //
  // hide(M,1) = reachable(im) \ reachable(c3) = { im, f2, f1 }  (c1, c2 shared)
  // The inner merge `im` is a MEMBER of hide(M,1) — proving the sub-DAG shape.
  // The inner merge's parents are [f2, c2], so from ITS perspective f2 is the
  // first parent (feature mainline) and c2 is the secondary side (origin merged
  // in). Its own hide(im,1) = reachable(c2) \ reachable(f2) = { c2 }  (c1 is
  // shared with f2; c2 is the origin commit unique to that side).
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 9000, ["c3", "im"]),
      mk("im", 7000, ["f2", "c2"]),
      mk("c3", 8000, ["c2"]),
      mk("f2", 6000, ["f1"]),
      mk("f1", 4000, ["c1"]),
      mk("c2", 3000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c3", target: "M" },
      { source: "im", target: "M" },
      { source: "f2", target: "im" },
      { source: "c2", target: "im" },
      { source: "c2", target: "c3" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  it("keeps the inner merge unrendered while the outer path is folded (4.1)", () => {
    const { nodes, edges } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    // The outer hide set contains the inner merge `im` (a >= 2-parent member).
    const outer = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(outer.oids)).toEqual(new Set(["im", "f2", "f1"]));
    expect(nodeByOid.get("im")!.parents.length).toBeGreaterThanOrEqual(2);

    // Fold the outer path via renderAnchor: M.
    const group: Run = {
      oids: outer.oids,
      id: mergePathId("M", 1),
      renderAnchor: "M",
    };
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);

    // The inner merge is NOT rendered; it folded onto the outer merge M.
    expect(eff.nodes.some((n) => n.oid === "im")).toBe(false);
    expect(eff.foldedInto.get("im")).toBe("M");
    // Orphan-safe as always.
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });

  it("does not offer the inner merge's control while the outer path is folded (4.1)", () => {
    const { nodes, edges } = fixture();
    // The outer secondary path is folded.
    const folded = new Set<string>([mergePathId("M", 1)]);

    const offered = visibleMergeHideGroups(nodes, edges, folded);
    const offeredMerges = new Set(offered.map((g) => g.mergeOid));

    // Only the outer merge M is offered; the inner merge `im` is hidden.
    expect(offeredMerges.has("M")).toBe(true);
    expect(offeredMerges.has("im")).toBe(false);
  });

  it("surfaces the inner merge as an independently collapsible node once the outer path is expanded (4.2, 4.3)", () => {
    const { nodes, edges } = fixture();

    // Outer path expanded → its id is NOT in the folded set.
    const folded = new Set<string>();

    // Re-run over the now-visible commit set: the inner merge surfaces its own
    // non-empty hide set (4.2, 4.3).
    const offered = visibleMergeHideGroups(nodes, edges, folded);
    const innerGroups = offered.filter((g) => g.mergeOid === "im");
    expect(innerGroups.length).toBe(1);
    expect(innerGroups[0].oids.length).toBeGreaterThan(0);

    // The inner hide set is exactly the origin commit unique to that side.
    const inner = mergeSecondaryPath("im", 1, nodes, edges)!;
    expect(new Set(inner.oids)).toEqual(new Set(["c2"]));
    expect(new Set(innerGroups[0].oids)).toEqual(new Set(["c2"]));
  });

  it("expanding only the inner path reveals only its unique commits (4.3)", () => {
    const { nodes, edges } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    // Outer expanded; fold ONLY the inner path onto the inner merge `im`.
    const inner = mergeSecondaryPath("im", 1, nodes, edges)!;
    expect(new Set(inner.oids)).toEqual(new Set(["c2"]));

    const innerGroup: Run = {
      oids: inner.oids,
      id: mergePathId("im", 1),
      renderAnchor: "im",
    };
    const eff = applyCollapse(nodes, edges, [innerGroup], new Set(), nodeByOid);

    // Only the inner-unique commit (c2) is hidden behind `im`. Everything else —
    // the feature mainline (f1, f2), the outer merge M, and the inner merge im
    // itself — stays rendered. (c2 is also referenced by c3 on the mainline, so
    // its c2 -> c3 edge reroutes onto im; c3 stays reachable.)
    expect(eff.foldedInto.get("c2")).toBe("im");
    for (const oid of ["c1", "f1", "f2", "c3", "M", "im"]) {
      expect(eff.nodes.some((n) => n.oid === oid)).toBe(true);
      expect(eff.foldedInto.has(oid)).toBe(false);
    }
    // No summary node minted (Option A folds onto the anchor im).
    expect(eff.runNodes.size).toBe(0);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });

  it("offers both merges when nothing is folded, and only the outer when it is folded (visibleMergeHideGroups contract)", () => {
    const { nodes, edges } = fixture();

    // Nothing folded → both the outer M and inner im are visible/offered.
    const noneFolded = visibleMergeHideGroups(nodes, edges, new Set());
    const bothMerges = new Set(noneFolded.map((g) => g.mergeOid));
    expect(bothMerges.has("M")).toBe(true);
    expect(bothMerges.has("im")).toBe(true);

    // Outer folded → inner hidden, only outer offered.
    const outerFolded = visibleMergeHideGroups(
      nodes,
      edges,
      new Set([mergePathId("M", 1)]),
    );
    const onlyOuter = new Set(outerFolded.map((g) => g.mergeOid));
    expect(onlyOuter.has("M")).toBe(true);
    expect(onlyOuter.has("im")).toBe(false);
  });
});



// ─────────────────────────────────────────────────────────────────────────
// Task 6.3 — Property 5: Reversibility.
//
// The composed merge+region resolver (`resolveMergeAndRegionFold`) is the pure
// decision core the CommitGraph wiring drives. For any merge-path id, a
// fold → expand → fold round-trip must yield an effective graph IDENTICAL to
// the first fold, and fold state — keyed on the stable merge oid via
// `mergePathId(M, k)` — must stay stable when the loaded window shifts (the same
// merge oid persists across a superset/subset re-fetch).
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 6.1, 6.2, 6.3
// ─────────────────────────────────────────────────────────────────────────

// Canonical, order-independent snapshot of an effective graph for equality.
function snapshot(eff: EffectiveGraph): {
  nodes: string[];
  edges: string[];
  runNodes: string[];
  foldedInto: string[];
} {
  return {
    nodes: eff.nodes.map((n) => n.oid).sort(),
    edges: eff.edges.map((e) => `${e.source}->${e.target}`).sort(),
    runNodes: [...eff.runNodes.keys()].sort(),
    foldedInto: [...eff.foldedInto.entries()]
      .map(([k, v]) => `${k}=>${v}`)
      .sort(),
  };
}

const noRefs = new Map<string, RefLabel[]>();

describe("Property 5: Reversibility — merge secondary-path fold round-trip", () => {
  // Simple feature merge (same topology as Property 2). hide(M,1) = {f1, f2}.
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  it("fold → expand → fold yields an identical effective graph to the first fold", () => {
    const { nodes, edges } = fixture();
    const path = mergePathId("M", 1);

    // First fold: the merge-path id is in the effectively-folded set.
    const first = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefs,
      null,
      new Set([path]),
      new Set(),
    );

    // Expand: the merge-path id is NOT folded → nothing hidden behind M.
    const expanded = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefs,
      null,
      new Set(),
      new Set(),
    );

    // Re-fold: back to the folded set.
    const refolded = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefs,
      null,
      new Set([path]),
      new Set(),
    );

    // The round-trip is lossless: refolded ≡ first.
    expect(snapshot(refolded.eff)).toEqual(snapshot(first.eff));
    expect([...refolded.mergeHidden].sort()).toEqual(
      [...first.mergeHidden].sort(),
    );

    // The expanded state genuinely differs (proves fold actually hid commits).
    expect(snapshot(expanded.eff)).not.toEqual(snapshot(first.eff));
    expect(first.mergeHidden).toEqual(new Set(["f1", "f2"]));
    expect(expanded.mergeHidden.size).toBe(0);

    // Orphan-safe at every stop.
    expect(orphanedMembers(nodes, first.eff)).toEqual([]);
    expect(orphanedMembers(nodes, expanded.eff)).toEqual([]);
    expect(orphanedMembers(nodes, refolded.eff)).toEqual([]);
  });

  it("keys fold state on the stable merge oid — survives a window shift", () => {
    const { nodes, edges } = fixture();
    const path = mergePathId("M", 1);

    // The id parses back to the stable merge oid + parent index.
    expect(parseMergePathId(path)).toEqual({ mergeOid: "M", parentIndex: 1 });

    // Baseline fold over the full window.
    const full = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefs,
      null,
      new Set([path]),
      new Set(),
    );

    // Simulate a window shift that adds an OLDER commit c0 below c1 (a re-fetch
    // that extends the window downward). The merge M and its hide set persist,
    // so the SAME merge-path id keeps folding the same members.
    const shiftedNodes: CommitNode[] = [
      ...nodes.map((n) => (n.oid === "c1" ? mk("c1", 1000, ["c0"]) : n)),
      mk("c0", 500, []),
    ];
    shiftedNodes.sort((a, b) => b.timestamp - a.timestamp);
    const shiftedEdges: CommitEdge[] = [
      ...edges,
      { source: "c0", target: "c1" },
    ];

    const shifted = resolveMergeAndRegionFold(
      shiftedNodes,
      shiftedEdges,
      noRefs,
      null,
      new Set([path]), // SAME stable id — no re-keying needed
      new Set(),
    );

    // The hide set is unchanged by the window growth (c0 is on the P1 side).
    expect([...shifted.mergeHidden].sort()).toEqual(
      [...full.mergeHidden].sort(),
    );
    expect(shifted.mergeHidden).toEqual(new Set(["f1", "f2"]));
    expect(orphanedMembers(shiftedNodes, shifted.eff)).toEqual([]);

    // A window shift the other way (subset that DROPS the merge M) makes the
    // fold inert — no member is stranded (10.4).
    const subsetNodes = nodes.filter((n) => n.oid !== "M");
    const subsetEdges = edges.filter(
      (e) => e.source !== "M" && e.target !== "M",
    );
    const inert = resolveMergeAndRegionFold(
      subsetNodes,
      subsetEdges,
      noRefs,
      null,
      new Set([path]), // stale — M absent
      new Set(),
    );
    expect(inert.mergeHidden.size).toBe(0);
    expect(orphanedMembers(subsetNodes, inert.eff)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 6.4 — Property 6: Coexistence Precedence.
//
// When a commit is eligible for BOTH a merge secondary-path fold and a Round-3
// region-collapse, the merge fold wins: the commit is claimed by the merge
// (hidden behind M) and excluded from region seeding while hidden, so it offers
// no region control. After the merge path is expanded, the commit regains
// region candidacy. The two membership sets (merge-hidden vs. region-folded)
// are always disjoint.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4
// ─────────────────────────────────────────────────────────────────────────

describe("Property 6: Coexistence Precedence — merge fold wins over region", () => {
  // A feature branch long enough that its OWN commits form a foldable region,
  // then merged into trunk. When M's secondary path is folded, the feature
  // commits are merge-hidden AND would otherwise be a region — merge wins.
  //
  //   trunk:   c1 <- c2 <- M          M.parents = [c2 (P1), f5 (Pk)]
  //   feature: c1 <- f1 <- f2 <- f3 <- f4 <- f5   (linear, no refs → region)
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 9000, ["c2", "f5"]),
      mk("c2", 8000, ["c1"]),
      mk("f5", 7000, ["f4"]),
      mk("f4", 6000, ["f3"]),
      mk("f3", 5000, ["f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f5", target: "M" },
      { source: "f4", target: "f5" },
      { source: "f3", target: "f4" },
      { source: "f2", target: "f3" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  it("claims a doubly-eligible commit for the merge fold and excludes it from regions", () => {
    const { nodes, edges } = fixture();
    const path = mergePathId("M", 1);

    // The feature commits f1..f4 are a foldable linear region on their own; seed
    // a region anchor at f2 (an interior feature commit) AND fold M's path.
    // Because f2 is merge-hidden, the region must be dropped (merge precedence).
    const folded = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefs,
      null,
      new Set([path]), // merge path folded
      new Set(["f2"]), // region anchor inside the hide set
    );

    // The feature commits are merge-hidden…
    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(folded.mergeHidden)).toEqual(new Set(hide.oids));
    expect(folded.mergeHidden.has("f2")).toBe(true);

    // …and NO region group was formed (the anchor was inside the hide set).
    expect(folded.regionGroups).toEqual([]);

    // Membership is disjoint: no region member is also merge-hidden.
    for (const g of folded.regionGroups) {
      for (const o of g.oids) expect(folded.mergeHidden.has(o)).toBe(false);
    }
    expect(orphanedMembers(nodes, folded.eff)).toEqual([]);
  });

  it("restores region candidacy after the merge path is expanded", () => {
    const { nodes, edges } = fixture();

    // Merge path EXPANDED (not in the folded set); the same region anchor at f2
    // now forms a region group (the feature commits are visible again → 7.3).
    const expanded = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefs,
      null,
      new Set(), // merge path expanded
      new Set(["f2"]), // region anchor now valid
    );

    // Nothing merge-hidden now.
    expect(expanded.mergeHidden.size).toBe(0);

    // A region group formed around f2 (the feature's linear stretch).
    expect(expanded.regionGroups.length).toBe(1);
    expect(expanded.regionGroups[0].id).toBe(regionRollupId("f2"));
    // Its members are feature commits and it folded them (region-collapsed).
    for (const o of expanded.regionGroups[0].oids) {
      expect(expanded.eff.foldedInto.get(o)).toBe(regionRollupId("f2"));
    }
    expect(orphanedMembers(nodes, expanded.eff)).toEqual([]);
  });

  it("keeps merge-hidden and region-folded memberships disjoint with both active elsewhere", () => {
    // Add a SEPARATE, un-merged linear tail off trunk that is a valid region and
    // is NOT behind the merge, so both a merge fold and a region fold are active
    // at once and must stay disjoint.
    //
    //   trunk: c1 <- c2 <- M  (M merges feature f1..f5 as before)
    //   tail:  M  <- t1 <- t2 <- t3 <- t4  (long linear stretch above M, no refs)
    const base = (() => {
      const nodes: CommitNode[] = [
        mk("t4", 14000, ["t3"]),
        mk("t3", 13000, ["t2"]),
        mk("t2", 12000, ["t1"]),
        mk("t1", 11000, ["M"]),
        mk("M", 9000, ["c2", "f5"]),
        mk("c2", 8000, ["c1"]),
        mk("f5", 7000, ["f4"]),
        mk("f4", 6000, ["f3"]),
        mk("f3", 5000, ["f2"]),
        mk("f2", 4000, ["f1"]),
        mk("f1", 3000, ["c1"]),
        mk("c1", 1000, []),
      ];
      const edges: CommitEdge[] = [
        { source: "t3", target: "t4" },
        { source: "t2", target: "t3" },
        { source: "t1", target: "t2" },
        { source: "M", target: "t1" },
        { source: "c2", target: "M" },
        { source: "f5", target: "M" },
        { source: "f4", target: "f5" },
        { source: "f3", target: "f4" },
        { source: "f2", target: "f3" },
        { source: "f1", target: "f2" },
        { source: "c1", target: "f1" },
        { source: "c1", target: "c2" },
      ];
      nodes.sort((a, b) => b.timestamp - a.timestamp);
      return { nodes, edges };
    })();

    const resolved = resolveMergeAndRegionFold(
      base.nodes,
      base.edges,
      noRefs,
      null,
      new Set([mergePathId("M", 1)]), // merge fold active
      new Set(["t2"]), // region fold active on the un-merged tail
    );

    // Merge fold hid the feature commits.
    expect(resolved.mergeHidden.has("f2")).toBe(true);
    // A region formed on the tail (t1..t4), NONE of which are merge-hidden.
    expect(resolved.regionGroups.length).toBe(1);
    const regionMembers = new Set(resolved.regionGroups[0].oids);
    for (const o of regionMembers) {
      expect(resolved.mergeHidden.has(o)).toBe(false);
    }
    // Disjoint both ways.
    for (const o of resolved.mergeHidden) {
      expect(regionMembers.has(o)).toBe(false);
    }
    expect(orphanedMembers(base.nodes, resolved.eff)).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 9.2 — Degenerate / stale-anchor handling.
//
// These cases confirm the existing pure helpers already uphold the design's
// Error Handling contract WITHOUT any production-code change:
//
//   • mergeSecondaryPath returns null for an out-of-graph merge, an out-of-graph
//     secondary parent Pk, an invalid parent index (< 1 or >= parents.length),
//     and an empty hide set (an already-merged parent). (10.1, 10.2, 10.3)
//   • resolveMergeAndRegionFold SKIPS a folded merge-path id whose merge oid is
//     absent from the window (stale anchor → inert: nothing hidden, nothing
//     orphaned); when the merge re-enters the window the same stable id
//     re-applies its fold. (10.4, 10.5)
//   • mergeSecondaryPath's hide set is computed from reachable(Pk) \ reachable(P1)
//     and does NOT depend on the merge base, so an out-of-window base under-hides
//     (mergeBase === null, extra commits stay visible) rather than orphaning. (10.6)
//   • mergeHideGroups drops octopus parents with an empty hide set and keeps the
//     non-empty ones; applyCollapse folds a commit shared by two overlapping
//     secondary hide sets onto a single anchor exactly once (foldedInto is a Map),
//     never orphaning. (9.4)
//
// Fixtures are deterministic + offline (fixed timestamps, newest-first).
//
// Validates: Requirements 9.4, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
// ─────────────────────────────────────────────────────────────────────────

import { mergeHideGroups } from "./collapse";

describe("Degenerate handling — stale merge-path anchor is inert", () => {
  // Simple feature merge; hide(M,1) = {f1, f2}.
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  const noRefsMap = new Map<string, RefLabel[]>();

  it("hides nothing and orphans nothing when the folded merge oid is absent (10.4)", () => {
    const { nodes, edges } = fixture();
    // A window that does NOT contain the merge M at all (nor its merge-only
    // edges): only the trunk and feature commits below M are loaded.
    const subsetNodes = nodes.filter((n) => n.oid !== "M");
    const subsetEdges = edges.filter(
      (e) => e.source !== "M" && e.target !== "M",
    );

    // Fold the (now stale) merge-path id for the absent merge M.
    const inert = resolveMergeAndRegionFold(
      subsetNodes,
      subsetEdges,
      noRefsMap,
      null,
      new Set([mergePathId("M", 1)]),
      new Set(),
    );

    // Stale id contributes no group, hides nothing, and orphans nothing.
    expect(inert.mergeGroups).toEqual([]);
    expect(inert.mergeHidden.size).toBe(0);
    expect(orphanedMembers(subsetNodes, inert.eff)).toEqual([]);
    // The effective graph is just the loaded subset, untouched.
    expect(new Set(inert.eff.nodes.map((n) => n.oid))).toEqual(
      new Set(subsetNodes.map((n) => n.oid)),
    );
  });

  it("re-applies the SAME stable fold id once the merge re-enters the window (10.5)", () => {
    const { nodes, edges } = fixture();
    const path = mergePathId("M", 1);

    // Window WITHOUT the merge → the fold id is inert (nothing hidden).
    const withoutMerge = resolveMergeAndRegionFold(
      nodes.filter((n) => n.oid !== "M"),
      edges.filter((e) => e.source !== "M" && e.target !== "M"),
      noRefsMap,
      null,
      new Set([path]),
      new Set(),
    );
    expect(withoutMerge.mergeHidden.size).toBe(0);

    // A superset window WITH the merge (re-entry) → the SAME id now folds the
    // hide set. No re-keying: the id is derived from the stable merge oid.
    const withMerge = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefsMap,
      null,
      new Set([path]),
      new Set(),
    );
    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(withMerge.mergeHidden)).toEqual(new Set(hide.oids));
    expect(withMerge.mergeHidden).toEqual(new Set(["f1", "f2"]));
    expect(orphanedMembers(nodes, withMerge.eff)).toEqual([]);
  });

  it("folding an absent/empty group via applyCollapse is a no-op", () => {
    const { nodes, edges } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    // A group whose members are not in the graph (renderAnchor also absent).
    const staleGroup: Run = {
      oids: [],
      id: mergePathId("ABSENT", 1),
      renderAnchor: "ABSENT",
    };
    const eff = applyCollapse(nodes, edges, [staleGroup], new Set(), nodeByOid);

    // Nothing folded; the graph is unchanged; no orphan.
    expect(eff.foldedInto.size).toBe(0);
    expect(eff.runNodes.size).toBe(0);
    expect(new Set(eff.nodes.map((n) => n.oid))).toEqual(
      new Set(nodes.map((n) => n.oid)),
    );
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });
});

describe("Degenerate handling — mergeSecondaryPath null cases", () => {
  // Simple feature merge; hide(M,1) = {f1, f2}.
  function fixture(): { nodes: CommitNode[]; edges: CommitEdge[] } {
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges };
  }

  it("returns null for an out-of-graph merge oid (10.2)", () => {
    const { nodes, edges } = fixture();
    expect(mergeSecondaryPath("does-not-exist", 1, nodes, edges)).toBeNull();
  });

  it("returns null for an invalid parent index — < 1 or >= parents.length (10.3)", () => {
    const { nodes, edges } = fixture();
    // Index 0 is the first parent, never a secondary path.
    expect(mergeSecondaryPath("M", 0, nodes, edges)).toBeNull();
    // M has 2 parents (indices 0 and 1); index 2 is out of range.
    expect(mergeSecondaryPath("M", 2, nodes, edges)).toBeNull();
    // Negative index is likewise invalid.
    expect(mergeSecondaryPath("M", -1, nodes, edges)).toBeNull();
  });

  it("returns null when the secondary parent Pk is not an in-graph commit (10.2)", () => {
    // M's secondary parent points at an oid that was not fetched into the graph.
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "ghost"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "c1", target: "c2" },
      // no node/edges for "ghost" — Pk is out of the window
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    expect(mergeSecondaryPath("M", 1, nodes, edges)).toBeNull();
  });

  it("returns null for an empty hide set — an already-merged parent (10.1)", () => {
    // Pk is already fully reachable from P1: the secondary side contributes
    // nothing unique, so hide(M,1) is empty → null (no affordance).
    //
    //   c1 <- c2 <- c3           mainline (P1 = c3)
    //   c2 is the secondary parent (already on the mainline, reachable from c3)
    //   M.parents = [c3 (P1), c2 (Pk, already merged)]
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c3", "c2"]),
      mk("c3", 5000, ["c2"]),
      mk("c2", 3000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c3", target: "M" },
      { source: "c2", target: "M" },
      { source: "c2", target: "c3" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    // reachable(c2) ⊆ reachable(c3), so nothing is unique to the Pk side.
    expect(mergeSecondaryPath("M", 1, nodes, edges)).toBeNull();
    // And mergeHideGroups therefore yields no group for this merge.
    expect(mergeHideGroups("M", nodes, edges)).toEqual([]);
  });
});

describe("Degenerate handling — out-of-window merge base under-hides (10.6)", () => {
  it("keeps the correct in-window hide set with mergeBase null, no orphan", () => {
    // Same topology as a simple feature merge, but the shared base c1 is NOT in
    // the loaded window: c2 and f1 are in-window roots (their parent c1 was not
    // fetched). reachable(P1=c2) and reachable(Pk=f2) share nothing in-window →
    // no common ancestor → mergeBase null. The hide set is still exactly the
    // feature-only in-window commits (under-hide, never orphan).
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, []), // c1 out-of-window → in-window root
      mk("c2", 5000, []), // c1 out-of-window → in-window root
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(new Set(hide.oids)).toEqual(new Set(["f1", "f2"]));
    expect(hide.mergeBase).toBeNull();

    // Folding is still orphan-safe.
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const group: Run = {
      oids: hide.oids,
      id: mergePathId("M", 1),
      renderAnchor: "M",
    };
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });
});

describe("Degenerate handling — octopus mixed / overlapping hide sets (9.4)", () => {
  it("drops the empty secondary parent and keeps the non-empty one", () => {
    // 3-parent octopus merge M:
    //   P1 = c2 (mainline)          reachable: c2, c1
    //   P2 = c1 (already merged)    reachable: c1  → EMPTY hide set (⊆ P1)
    //   P3 = f2 (real feature)      reachable: f2, f1, c1 → hide {f2, f1}
    //
    //   c1 <- c2 <- M
    //   c1 <- f1 <- f2 ─┘
    const nodes: CommitNode[] = [
      mk("M", 7000, ["c2", "c1", "f2"]),
      mk("f2", 5000, ["f1"]),
      mk("f1", 4000, ["c1"]),
      mk("c2", 6000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "c1", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    // Parent index 1 (c1) is already merged → empty hide set → null / dropped.
    expect(mergeSecondaryPath("M", 1, nodes, edges)).toBeNull();
    // Parent index 2 (f2) contributes the real feature commits.
    const p3 = mergeSecondaryPath("M", 2, nodes, edges)!;
    expect(new Set(p3.oids)).toEqual(new Set(["f1", "f2"]));

    // mergeHideGroups keeps only the non-empty group.
    const groups = mergeHideGroups("M", nodes, edges);
    expect(groups.length).toBe(1);
    expect(groups[0].parentIndex).toBe(2);
    expect(new Set(groups[0].oids)).toEqual(new Set(["f1", "f2"]));
  });

  it("hides a commit shared by two overlapping secondary hide sets exactly once", () => {
    // 3-parent octopus M whose two secondary parents share a commit `s`:
    //   P1 = c2 (mainline)                     reachable: c2, c1
    //   P2 = a2, with a2 <- a1 <- s <- c1      hide(M,1) = {a2, a1, s}
    //   P3 = b2, with b2 <- b1 <- s <- c1      hide(M,2) = {b2, b1, s}
    //   → the shared commit `s` appears in BOTH hide sets.
    const nodes: CommitNode[] = [
      mk("M", 9000, ["c2", "a2", "b2"]),
      mk("a2", 7000, ["a1"]),
      mk("b2", 6500, ["b1"]),
      mk("a1", 6000, ["s"]),
      mk("b1", 5500, ["s"]),
      mk("c2", 8000, ["c1"]),
      mk("s", 3000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "a2", target: "M" },
      { source: "b2", target: "M" },
      { source: "a1", target: "a2" },
      { source: "b1", target: "b2" },
      { source: "s", target: "a1" },
      { source: "s", target: "b1" },
      { source: "c1", target: "s" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    const g1 = mergeSecondaryPath("M", 1, nodes, edges)!;
    const g2 = mergeSecondaryPath("M", 2, nodes, edges)!;
    expect(new Set(g1.oids)).toEqual(new Set(["a2", "a1", "s"]));
    expect(new Set(g2.oids)).toEqual(new Set(["b2", "b1", "s"]));
    // The shared commit `s` is in both hide sets.
    expect(g1.oids).toContain("s");
    expect(g2.oids).toContain("s");

    // Fold both secondary paths onto the merge M in a single applyCollapse pass.
    const groups: Run[] = [
      { oids: g1.oids, id: mergePathId("M", 1), renderAnchor: "M" },
      { oids: g2.oids, id: mergePathId("M", 2), renderAnchor: "M" },
    ];
    const eff = applyCollapse(nodes, edges, groups, new Set(), nodeByOid);

    // The shared commit is folded onto a single anchor (foldedInto is a Map → one entry).
    expect(eff.foldedInto.get("s")).toBe("M");
    // Every member of both groups folds onto M; none remains rendered.
    for (const oid of new Set([...g1.oids, ...g2.oids])) {
      expect(eff.nodes.some((n) => n.oid === oid)).toBe(false);
      expect(eff.foldedInto.get(oid)).toBe("M");
    }
    // Orphan-safe despite the overlap.
    expect(orphanedMembers(nodes, eff)).toEqual([]);
    expect(eff.runNodes.size).toBe(0);
  });
});



// ─────────────────────────────────────────────────────────────────────────
// Task 8.2 — Global default-view toggle: seed flip preserves user state.
//
// `composeFoldSeed` is the pure seed-composition core the CommitGraph toggle
// drives (task 8.1). Flipping viewMode between "active" and "full" must change
// ONLY the merge default seed's contribution — the region seed and, crucially,
// the user's per-merge manual fold/expand overrides are preserved across the
// flip. A user-collapsed merge path stays folded in both modes; a user-expanded
// one stays expanded in both modes; only the unoverridden (default) merge paths
// flip.
//
// Fixtures are plain id sets (pure, DOM-free).
//
// Validates: Requirements 13.3
// ─────────────────────────────────────────────────────────────────────────

describe("Task 8.2 — composeFoldSeed view-mode toggle preserves user state", () => {
  // Region seed (always applied) and a merge default seed (active-only). Two
  // merge default paths so we can override one each way and leave one at default.
  const regionSeed = new Set([regionRollupId("region-anchor")]);
  const mDefaultFold = mergePathId("Mdefault", 1); // stays a plain default
  const mUserExpand = mergePathId("Mexpand", 1); // default-folded, user expands it
  const mergeSeed = new Set([mDefaultFold, mUserExpand]);
  // A merge path NOT in the default seed that the user manually folds.
  const mUserFold = mergePathId("Mfold", 1);

  it("flips only the default merge seed between modes (no user overrides)", () => {
    const active = composeFoldSeed(
      "active",
      regionSeed,
      mergeSeed,
      new Set(),
      new Set(),
    );
    const full = composeFoldSeed(
      "full",
      regionSeed,
      mergeSeed,
      new Set(),
      new Set(),
    );

    // Active mode folds region + merge default seed.
    expect(active).toEqual(
      new Set([regionRollupId("region-anchor"), mDefaultFold, mUserExpand]),
    );
    // Full mode drops the merge default seed entirely, keeps the region seed.
    expect(full).toEqual(new Set([regionRollupId("region-anchor")]));

    // The ONLY difference between the two modes is the merge default seed.
    for (const id of mergeSeed) {
      expect(active.has(id)).toBe(true);
      expect(full.has(id)).toBe(false);
    }
    // Region seed is identical in both.
    expect(active.has(regionRollupId("region-anchor"))).toBe(true);
    expect(full.has(regionRollupId("region-anchor"))).toBe(true);
  });

  it("preserves per-merge user fold/expand overrides across an active⇄full flip", () => {
    // User overrides: manually folded a non-default path (mUserFold), and
    // manually expanded a default-folded path (mUserExpand). These persist.
    const userCollapsed = new Set([mUserFold]);
    const userExpanded = new Set([mUserExpand]);

    const active = composeFoldSeed(
      "active",
      regionSeed,
      mergeSeed,
      userCollapsed,
      userExpanded,
    );
    const full = composeFoldSeed(
      "full",
      regionSeed,
      mergeSeed,
      userCollapsed,
      userExpanded,
    );

    // A user-collapsed path stays folded in BOTH modes.
    expect(active.has(mUserFold)).toBe(true);
    expect(full.has(mUserFold)).toBe(true);

    // A user-expanded path stays expanded (NOT folded) in BOTH modes — the
    // manual expand wins over the default seed even in active mode.
    expect(active.has(mUserExpand)).toBe(false);
    expect(full.has(mUserExpand)).toBe(false);

    // The region seed is unaffected by the flip.
    expect(active.has(regionRollupId("region-anchor"))).toBe(true);
    expect(full.has(regionRollupId("region-anchor"))).toBe(true);

    // Only the UNoverridden default merge path flips between modes.
    expect(active.has(mDefaultFold)).toBe(true);
    expect(full.has(mDefaultFold)).toBe(false);

    // The set difference between modes is EXACTLY the unoverridden default path.
    const onlyInActive = [...active].filter((id) => !full.has(id));
    expect(new Set(onlyInActive)).toEqual(new Set([mDefaultFold]));
  });

  it("a manual expand authoritatively wins over the merge default seed and a manual collapse", () => {
    // The same id is (contradictorily) in the default seed, userCollapsed, AND
    // userExpanded — the expand must win (reversible round-trip, Defect 4 / 13.3).
    const id = mergePathId("Mconflict", 1);
    const active = composeFoldSeed(
      "active",
      new Set(),
      new Set([id]),
      new Set([id]),
      new Set([id]),
    );
    expect(active.has(id)).toBe(false);
    const full = composeFoldSeed(
      "full",
      new Set(),
      new Set([id]),
      new Set([id]),
      new Set([id]),
    );
    expect(full.has(id)).toBe(false);
  });
});



// ─────────────────────────────────────────────────────────────────────────
// Task 11.2 — Property 7: Foldable-by-Topology-Except-HEAD.
//
// regionAround's `foldable(x)` predicate is now purely topological plus a
// HEAD-only carve-out: a commit is foldable iff it has exactly one in-graph
// parent, exactly one in-graph child, is not the selected commit, and is NOT the
// checked-out HEAD commit — independent of any branch/remote-branch/tag ref on
// it or its neighbors. A ref-carrying non-HEAD commit joins a region; a commit
// sandwiched between two ref commits joins a region of >= 2 members; the HEAD
// commit is never a region member. HEAD-at-tip stays non-foldable by the
// one-child rule.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 15.1, 15.2, 15.3, 15.4
// ─────────────────────────────────────────────────────────────────────────

describe("Property 7: Foldable-by-Topology-Except-HEAD", () => {
  // Reported-bug-style linear chain (newest-first), refs modeled on the real
  // repo case. HEAD → main sits at the TIP (zero in-graph children). One commit
  // down carries origin/main (remotebranch). A ref-less commit sits BETWEEN two
  // ref-carrying commits (the 431b5c2 bug). A tag: commit is further down.
  //
  //   head(main, is_head)  <- rb(origin/main)  <- mid(no ref)  <- tg(tag v1)
  //     <- a <- b <- c <- root
  //
  // Edges run parent(source) → child(target).
  function fixture(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refsByOid: Map<string, RefLabel[]>;
  } {
    const nodes: CommitNode[] = [
      mk("head", 9000, ["rb"]),
      mk("rb", 8000, ["mid"]),
      mk("mid", 7000, ["tg"]),
      mk("tg", 6000, ["a"]),
      mk("a", 5000, ["b"]),
      mk("b", 4000, ["c"]),
      mk("c", 3000, ["root"]),
      mk("root", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "rb", target: "head" },
      { source: "mid", target: "rb" },
      { source: "tg", target: "mid" },
      { source: "a", target: "tg" },
      { source: "b", target: "a" },
      { source: "c", target: "b" },
      { source: "root", target: "c" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["head", [ref("main", "head", "head", true)]],
      ["rb", [ref("origin/main", "rb", "remotebranch")]],
      ["tg", [ref("v1.0", "tg", "tag")]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, refsByOid };
  }

  it("folds a ref-carrying non-HEAD commit (remotebranch, tag) — Req 14.1, 14.2, 14.4", () => {
    const { nodes, edges, refsByOid } = fixture();

    // origin/main (remotebranch) is foldable by topology now.
    const rbRegion = regionAround("rb", nodes, edges, refsByOid);
    expect(rbRegion).not.toBeNull();
    expect(rbRegion!).toContain("rb");

    // tag commit is foldable by topology now.
    const tgRegion = regionAround("tg", nodes, edges, refsByOid);
    expect(tgRegion).not.toBeNull();
    expect(tgRegion!).toContain("tg");
  });

  it("includes a commit sandwiched between two ref commits in a >= 2-member region — Req 14.3, 14.5", () => {
    const { nodes, edges, refsByOid } = fixture();
    // `mid` has no ref and sits between rb (remotebranch) and tg (tag). It must
    // now join a region rather than being blocked by its ref-carrying neighbors.
    const region = regionAround("mid", nodes, edges, refsByOid);
    expect(region).not.toBeNull();
    expect(region!).toContain("mid");
    expect(region!.length).toBeGreaterThanOrEqual(2);
    // The region spans across the ref-carrying neighbors (they are foldable too).
    expect(region!).toContain("rb");
    expect(region!).toContain("tg");
  });

  it("never makes the HEAD commit a region member — Req 15.2, 15.4", () => {
    const { nodes, edges, refsByOid } = fixture();
    // head is at the tip (zero in-graph children) → non-foldable by topology
    // (one-child rule), so regionAround(head) is null…
    expect(regionAround("head", nodes, edges, refsByOid)).toBeNull();
    // …and no region anchored anywhere ever includes it.
    for (const n of nodes) {
      const region = regionAround(n.oid, nodes, edges, refsByOid);
      if (region) expect(region).not.toContain("head");
    }
  });

  it("excludes an INTERIOR HEAD (one parent + one child) even though topology would fold it — Req 15.1", () => {
    // HEAD is NOT at the tip: a newer child commit `x` exists above the is_head
    // commit `h`, so `h` has one parent and one child. Without the HEAD carve-out
    // it would be foldable; it must be excluded, splitting the region around it.
    //
    //   x <- h(is_head) <- p <- q <- r <- s <- root
    const nodes: CommitNode[] = [
      mk("x", 9000, ["h"]),
      mk("h", 8000, ["p"]),
      mk("p", 7000, ["q"]),
      mk("q", 6000, ["r"]),
      mk("r", 5000, ["s"]),
      mk("s", 4000, ["root"]),
      mk("root", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "h", target: "x" },
      { source: "p", target: "h" },
      { source: "q", target: "p" },
      { source: "r", target: "q" },
      { source: "s", target: "r" },
      { source: "root", target: "s" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["h", [ref("main", "h", "head", true)]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    // The interior HEAD `h` is non-foldable despite one-parent/one-child topology.
    expect(regionAround("h", nodes, edges, refsByOid)).toBeNull();
    // A region below HEAD (p..s) forms and excludes h.
    const below = regionAround("q", nodes, edges, refsByOid);
    expect(below).not.toBeNull();
    expect(below!).not.toContain("h");
    expect(below!).not.toContain("x");
    // No region anywhere includes the interior HEAD.
    for (const n of nodes) {
      const region = regionAround(n.oid, nodes, edges, refsByOid);
      if (region) expect(region).not.toContain("h");
    }
  });

  it("keeps the common HEAD-at-tip (zero children) non-foldable by topology — Req 15.4", () => {
    // A minimal chain with HEAD at the tip. Even if we removed the HEAD carve-out
    // the one-child rule alone makes it non-foldable; assert that directly.
    const nodes: CommitNode[] = [
      mk("tip", 5000, ["m1"]),
      mk("m1", 4000, ["m2"]),
      mk("m2", 3000, ["m3"]),
      mk("m3", 2000, ["root"]),
      mk("root", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "m1", target: "tip" },
      { source: "m2", target: "m1" },
      { source: "m3", target: "m2" },
      { source: "root", target: "m3" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["tip", [ref("main", "tip", "head", true)]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    // tip has zero in-graph children → non-foldable regardless of the HEAD gate.
    expect(regionAround("tip", nodes, edges, refsByOid)).toBeNull();
    // The interior commits still form a region that excludes the tip.
    const region = regionAround("m2", nodes, edges, refsByOid);
    expect(region).not.toBeNull();
    expect(region!).not.toContain("tip");
  });

  it("treats only an is_head/kind===head ref as HEAD, not other refs — Req 15.3", () => {
    // Two interior commits (one parent + one child each): `hr` carries an
    // is_head ref, `br` carries only a plain non-HEAD branch ref. Only `hr` is
    // treated as non-foldable.
    //
    //   tip <- hr(is_head) <- x <- br(branch) <- y <- root
    const nodes: CommitNode[] = [
      mk("tip", 9000, ["hr"]),
      mk("hr", 8000, ["x"]),
      mk("x", 7000, ["br"]),
      mk("br", 6000, ["y"]),
      mk("y", 5000, ["root"]),
      mk("root", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "hr", target: "tip" },
      { source: "x", target: "hr" },
      { source: "br", target: "x" },
      { source: "y", target: "br" },
      { source: "root", target: "y" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["hr", [ref("main", "hr", "head", true)]],
      ["br", [ref("feature", "br", "branch")]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    // The is_head interior commit is non-foldable…
    expect(regionAround("hr", nodes, edges, refsByOid)).toBeNull();
    // …but the plain-branch commit is foldable and joins a region.
    const region = regionAround("br", nodes, edges, refsByOid);
    expect(region).not.toBeNull();
    expect(region!).toContain("br");
    // And no region includes the is_head commit.
    for (const n of nodes) {
      const r = regionAround(n.oid, nodes, edges, refsByOid);
      if (r) expect(r).not.toContain("hr");
    }
  });

  it("surfaces the ref commits as foldable through regionsFromAnchors too", () => {
    const { nodes, edges, refsByOid } = fixture();
    // Seeding an anchor at the ref-less middle commit yields a region that
    // covers the ref-carrying neighbors (rb, tg) and mid — all non-HEAD.
    const groups = regionsFromAnchors(["mid"], nodes, edges, refsByOid);
    expect(groups.length).toBe(1);
    const members = new Set(groups[0].oids);
    expect(members.has("mid")).toBe(true);
    expect(members.has("rb")).toBe(true);
    expect(members.has("tg")).toBe(true);
    // HEAD is never folded in.
    expect(members.has("head")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 11.3 — autoCollapseAnchors still exempts the HEAD trunk while now
// seeding off-trunk regions that contain ref commits.
//
// The HEAD-trunk first-parent walk (from headOid via parents[0]) is independent
// of `foldable`, so it still keeps the mainline expanded on load. Off-trunk
// regions containing branch/remotebranch/tag ref commits are now seedable.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 18.1, 18.3
// ─────────────────────────────────────────────────────────────────────────

describe("Task 11.3 — autoCollapseAnchors: off-trunk ref regions seeded, HEAD trunk exempt", () => {
  it("seeds a long off-trunk region that contains ref commits, while exempting the HEAD trunk", () => {
    // HEAD trunk (first-parent chain from HEAD): h <- t1 <- t2 <- t3 <- base.
    // Off-trunk branch off `base`: o1 <- o2 <- o3 <- o4 (long enough to seed),
    // with a remotebranch on o2 and a tag on o3 (ref commits inside the region).
    // The branch fork point is `base` (2 children: t3-side and o4-side).
    //
    //   h <- t1 <- t2 <- t3 <- base            (HEAD trunk, exempt)
    //                          base <- o4 <- o3 <- o2 <- o1   (off-trunk region)
    const nodes: CommitNode[] = [
      mk("h", 14000, ["t1"]),
      mk("t1", 13000, ["t2"]),
      mk("t2", 12000, ["t3"]),
      mk("t3", 11000, ["base"]),
      mk("o1", 9000, ["o2"]),
      mk("o2", 8000, ["o3"]),
      mk("o3", 7000, ["o4"]),
      mk("o4", 6000, ["base"]),
      mk("base", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "t1", target: "h" },
      { source: "t2", target: "t1" },
      { source: "t3", target: "t2" },
      { source: "base", target: "t3" },
      { source: "o2", target: "o1" },
      { source: "o3", target: "o2" },
      { source: "o4", target: "o3" },
      { source: "base", target: "o4" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["h", [ref("main", "h", "head", true)]],
      ["o2", [ref("origin/feature", "o2", "remotebranch")]],
      ["o3", [ref("v2.0", "o3", "tag")]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    // minLen 3: the off-trunk region (o1..o4, minus the o1 tip / base fork) has
    // >= 3 foldable interior members and is seeded despite carrying ref commits.
    const anchors = autoCollapseAnchors(nodes, edges, "h", refsByOid, 3);
    expect(anchors.length).toBeGreaterThanOrEqual(1);

    // The seeded anchor's region contains the ref-carrying commits (o2, o3)…
    const seededRegions = anchors.map(
      (a) => regionAround(a, nodes, edges, refsByOid)!,
    );
    const anyRegionMembers = new Set(seededRegions.flatMap((r) => r));
    expect(anyRegionMembers.has("o2")).toBe(true); // remotebranch commit folded
    expect(anyRegionMembers.has("o3")).toBe(true); // tag commit folded

    // …and NO seeded region intersects the HEAD trunk (h, t1, t2, t3, base).
    const trunk = new Set(["h", "t1", "t2", "t3", "base"]);
    for (const r of seededRegions) {
      for (const oid of r) expect(trunk.has(oid)).toBe(false);
    }
    // HEAD itself is never seeded/folded.
    expect(anyRegionMembers.has("h")).toBe(false);
  });
});



// ─────────────────────────────────────────────────────────────────────────
// Task 12.3 — Property 8: Folded-Refs Surfaced.
//
// When a fold hides a ref-carrying commit, the ref must resurface on the fold's
// summary node so nothing silently disappears. `foldedRefsFor` collects one
// FoldedRef per (member, ref) pair over the group's ordered members
// (newest-first), tagging the head member's refs `buried:false` and any interior
// member's refs `buried:true`. `applyCollapse` threads it onto minted region
// rollups (`CollapsedRunData.foldedRefs`) and `resolveMergeAndRegionFold` threads
// it onto merge affordances (`MergeAffordance.foldedRefs`). A group with no refs
// yields an empty list / undefined field and therefore no badge.
//
// Fixtures are deterministic + offline (fixed timestamps, in-memory data).
//
// Validates: Requirements 16.1, 16.2, 16.3, 16.4, 18.1, 18.2
// ─────────────────────────────────────────────────────────────────────────

describe("Property 8: Folded-Refs Surfaced — foldedRefsFor head-vs-buried", () => {
  it("marks a head-member ref buried:false and an interior-member ref buried:true", () => {
    // Group members newest-first: head is h0, interior is h1, tail is h2.
    const refsByOid = new Map<string, RefLabel[]>([
      ["h0", [ref("main", "h0", "branch")]],
      ["h2", [ref("v1.0", "h2", "tag")]],
    ]);
    const folded = foldedRefsFor(["h0", "h1", "h2"], refsByOid);

    // One FoldedRef per (member, ref) pair — h1 carries none.
    expect(folded.length).toBe(2);

    const head = folded.find((f) => f.ref.oid === "h0")!;
    const buried = folded.find((f) => f.ref.oid === "h2")!;
    expect(head.buried).toBe(false); // head member oids[0]
    expect(buried.buried).toBe(true); // interior member (index > 0)
  });

  it("emits one FoldedRef per (member, ref) pair, preserving member then ref order", () => {
    // Head member carries TWO refs; a later member carries one.
    const refsByOid = new Map<string, RefLabel[]>([
      ["a", [ref("feature", "a", "branch"), ref("origin/feature", "a", "remotebranch")]],
      ["b", [ref("v2.0", "b", "tag")]],
    ]);
    const folded = foldedRefsFor(["a", "b"], refsByOid);

    expect(folded.map((f) => f.ref.name)).toEqual([
      "feature", // a, ref order preserved
      "origin/feature", // a, second ref
      "v2.0", // b
    ]);
    // Both refs on the head member a are buried:false; b is buried:true.
    expect(folded[0].buried).toBe(false);
    expect(folded[1].buried).toBe(false);
    expect(folded[2].buried).toBe(true);
  });

  it("surfaces branch, remotebranch, and tag refs alike", () => {
    const refsByOid = new Map<string, RefLabel[]>([
      ["x0", [ref("main", "x0", "branch")]],
      ["x1", [ref("origin/main", "x1", "remotebranch")]],
      ["x2", [ref("v1.0", "x2", "tag")]],
    ]);
    const folded = foldedRefsFor(["x0", "x1", "x2"], refsByOid);
    expect(new Set(folded.map((f) => f.ref.kind))).toEqual(
      new Set(["branch", "remotebranch", "tag"]),
    );
    // Head is x0 (branch); the other two are buried.
    expect(folded.find((f) => f.ref.kind === "branch")!.buried).toBe(false);
    expect(folded.find((f) => f.ref.kind === "remotebranch")!.buried).toBe(true);
    expect(folded.find((f) => f.ref.kind === "tag")!.buried).toBe(true);
  });

  it("returns [] for a group whose members carry no ref (Req 16.4)", () => {
    const refsByOid = new Map<string, RefLabel[]>();
    expect(foldedRefsFor(["a", "b", "c"], refsByOid)).toEqual([]);
  });
});

describe("Property 8: Folded-Refs Surfaced — applyCollapse region rollup", () => {
  // A linear region long enough to mint a summary node when collapsed. Members
  // (newest-first): r1 (head, branch ref) <- r2 (interior, tag ref) <- r3 <- r4.
  function fixture(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refsByOid: Map<string, RefLabel[]>;
  } {
    const nodes: CommitNode[] = [
      mk("r1", 5000, ["r2"]),
      mk("r2", 4000, ["r3"]),
      mk("r3", 3000, ["r4"]),
      mk("r4", 2000, ["root"]),
      mk("root", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "r2", target: "r1" },
      { source: "r3", target: "r2" },
      { source: "r4", target: "r3" },
      { source: "root", target: "r4" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["r1", [ref("feature", "r1", "branch")]],
      ["r2", [ref("v1.0", "r2", "tag")]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, refsByOid };
  }

  it("populates CollapsedRunData.foldedRefs for a minted rollup that hides ref commits", () => {
    const { nodes, edges, refsByOid } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    // Fold a region group covering the ref-carrying members r1..r3 (a minted
    // summary node, no renderAnchor).
    const group: Run = {
      oids: ["r1", "r2", "r3"],
      id: regionRollupId("r1"),
    };
    const eff = applyCollapse(
      nodes,
      edges,
      [group],
      new Set(),
      nodeByOid,
      refsByOid,
    );

    const data = eff.runNodes.get(regionRollupId("r1"))!;
    expect(data).toBeDefined();
    expect(data.foldedRefs).toBeDefined();
    // One entry per (member, ref) pair: r1 branch (head), r2 tag (buried).
    const byOid = new Map(data.foldedRefs!.map((f) => [f.ref.oid, f]));
    expect(byOid.get("r1")!.buried).toBe(false);
    expect(byOid.get("r2")!.buried).toBe(true);
    expect(data.foldedRefs!.length).toBe(2);
  });

  it("leaves foldedRefs undefined when refsByOid is omitted (back-compat)", () => {
    const { nodes, edges } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const group: Run = { oids: ["r1", "r2", "r3"], id: regionRollupId("r1") };
    // Old call shape — no refsByOid argument.
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);
    const data = eff.runNodes.get(regionRollupId("r1"))!;
    expect(data).toBeDefined();
    expect(data.foldedRefs).toBeUndefined();
  });
});

describe("Property 8: Folded-Refs Surfaced — merge affordance foldedRefs", () => {
  // Simple feature merge; the merged-in secondary path (f1, f2) carries refs:
  // f2 (the path's head / tip) carries a remotebranch, f1 (buried) carries a tag.
  //
  //   c1 <- c2 <- M          M.parents = [c2 (P1), f2 (Pk)]
  //   c1 <- f1 <- f2         feature (f2 tip)
  function fixture(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refsByOid: Map<string, RefLabel[]>;
  } {
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["f2", [ref("origin/feature", "f2", "remotebranch")]],
      ["f1", [ref("v0.9", "f1", "tag")]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, refsByOid };
  }

  it("populates MergeAffordance.foldedRefs head-vs-buried by group.oids order", () => {
    const { nodes, edges, refsByOid } = fixture();

    // The merge path is folded → its hide set {f2, f1} is behind M.
    const path = mergePathId("M", 1);
    const resolved = resolveMergeAndRegionFold(
      nodes,
      edges,
      refsByOid,
      null,
      new Set([path]),
      new Set(),
    );

    const affordances = resolved.affordancesByMerge.get("M")!;
    expect(affordances).toBeDefined();
    const aff = affordances.find((a) => a.parentIndex === 1)!;
    expect(aff).toBeDefined();

    // hide(M,1).oids is newest-first: f2 (head) then f1 (buried).
    const hide = mergeSecondaryPath("M", 1, nodes, edges)!;
    expect(hide.oids).toEqual(["f2", "f1"]);

    const byOid = new Map(aff.foldedRefs.map((f: FoldedRef) => [f.ref.oid, f]));
    expect(byOid.get("f2")!.buried).toBe(false); // head member of the path
    expect(byOid.get("f1")!.buried).toBe(true); // interior member
    expect(aff.foldedRefs.length).toBe(2);
    expect(byOid.get("f2")!.ref.kind).toBe("remotebranch");
    expect(byOid.get("f1")!.ref.kind).toBe("tag");
  });

  it("yields an empty foldedRefs list for a path whose members carry no ref", () => {
    const { nodes, edges } = fixture();
    const noRefsMap = new Map<string, RefLabel[]>();
    const resolved = resolveMergeAndRegionFold(
      nodes,
      edges,
      noRefsMap,
      null,
      new Set([mergePathId("M", 1)]),
      new Set(),
    );
    const aff = resolved.affordancesByMerge.get("M")!.find(
      (a) => a.parentIndex === 1,
    )!;
    expect(aff.foldedRefs).toEqual([]);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 15.2 — Property 11: Selection Is Not a Region Boundary.
//
// `regionAround` no longer takes or reads `selectedOid`; foldability is purely
// topological plus the HEAD carve-out. Reproduces the confirmed chain (fixed
// timestamps):
//
//   772eb2e (HEAD → main) -> 6f21bf7 (origin/main) -> 431b5c2
//                         -> 86bdb6f (tag) -> 578f9c8
//
// (newest-first; edges run parent -> child.) Before the fix, selecting
// `431b5c2` shrank `regionAround("6f21bf7", …)` to a single member / null (the
// walk stopped down at the selected `431b5c2` and up at HEAD `772eb2e`). After
// the fix the region stays a >= 2-member set, is identical across selections,
// includes the (formerly-selected) commit, excludes HEAD, and folds orphan-free.
//
// Validates: Requirements 20.1, 20.2, 20.3, 20.4, 21.1, 21.2, 21.3,
//            23.1, 23.2, 23.3, 23.4, 23.5
// ─────────────────────────────────────────────────────────────────────────
describe("Property 11: Selection Is Not a Region Boundary", () => {
  // Fixed timestamps → deterministic ordering / window assertions.
  function fixture(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refsByOid: Map<string, RefLabel[]>;
  } {
    const nodes: CommitNode[] = [
      mk("772eb2e", 5000, ["6f21bf7"]), // HEAD → main (tip)
      mk("6f21bf7", 4000, ["431b5c2"]), // origin/main
      mk("431b5c2", 3000, ["86bdb6f"]), // ref-less, formerly selected
      mk("86bdb6f", 2000, ["578f9c8"]), // tag
      mk("578f9c8", 1000, []), // oldest
    ];
    const edges: CommitEdge[] = [
      { source: "6f21bf7", target: "772eb2e" },
      { source: "431b5c2", target: "6f21bf7" },
      { source: "86bdb6f", target: "431b5c2" },
      { source: "578f9c8", target: "86bdb6f" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["772eb2e", [ref("main", "772eb2e", "head", true)]],
      ["6f21bf7", [ref("origin/main", "6f21bf7", "remotebranch")]],
      ["86bdb6f", [ref("v1.0", "86bdb6f", "tag")]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, refsByOid };
  }

  it("does not shrink regionAround('6f21bf7') when '431b5c2' is selected — Req 20.1/20.2/20.3/23.1", () => {
    const { nodes, edges, refsByOid } = fixture();
    // Selection is modeled as "irrelevant to regionAround" now that the param is
    // gone: the call is identical regardless of what is selected.
    const region = regionAround("6f21bf7", nodes, edges, refsByOid);
    expect(region).not.toBeNull();
    expect(region!.length).toBeGreaterThanOrEqual(2);
    expect(region!).toContain("6f21bf7");
  });

  it("computes a selection-invariant region set — Req 21.1/21.2/21.3/23.2", () => {
    const { nodes, edges, refsByOid } = fixture();
    // `regionAround` takes no selection argument, so the result is byte-for-byte
    // identical no matter which commit the harness models as "selected".
    const base = regionAround("6f21bf7", nodes, edges, refsByOid);
    expect(base).not.toBeNull();
    const selections: (string | null)[] = ["431b5c2", "6f21bf7", "86bdb6f", "578f9c8", null];
    for (const selected of selections) {
      // `selected` is deliberately unused by regionAround — that is the point:
      // the result must not depend on it.
      void selected;
      const again = regionAround("6f21bf7", nodes, edges, refsByOid);
      expect(again).toEqual(base);
    }
  });

  it("makes the formerly-selected commit '431b5c2' a region member — Req 20.4/23.3", () => {
    const { nodes, edges, refsByOid } = fixture();
    const region = regionAround("431b5c2", nodes, edges, refsByOid);
    expect(region).not.toBeNull();
    expect(region!).toContain("431b5c2");
    expect(region!.length).toBeGreaterThanOrEqual(2);
  });

  it("never makes HEAD '772eb2e' a region member — Req 23.4", () => {
    const { nodes, edges, refsByOid } = fixture();
    expect(regionAround("772eb2e", nodes, edges, refsByOid)).toBeNull();
    for (const n of nodes) {
      const region = regionAround(n.oid, nodes, edges, refsByOid);
      if (region) expect(region).not.toContain("772eb2e");
    }
  });

  it("folds the region orphan-free — Req 23.5", () => {
    const { nodes, edges, refsByOid } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const groups = regionsFromAnchors(["6f21bf7"], nodes, edges, refsByOid);
    expect(groups.length).toBe(1);
    const eff = applyCollapse(nodes, edges, groups, new Set(), nodeByOid, refsByOid);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });
});



// ─────────────────────────────────────────────────────────────────────────
// Task 16.2 — Property 12: Fold Moves Selection to the Summary Node.
//
// When a fold (region collapse or merge secondary path) hides the currently
// selected commit, selection moves onto the resulting summary node, driven from
// the node's representative commit — the fold's newest member `oids[0]`, exactly
// what `selectionForSummaryNode` returns. When the fold does NOT include the
// selected commit, selection is left unchanged. The re-selection decision the
// `collapseRegion` entry point makes is a pure predicate:
//
//   members.includes(selectedOid)  →  re-select members[0] (= oids[0])
//   otherwise                      →  leave selection unchanged
//
// Tested at the pure level: build a linear region, fold it via
// `regionsFromAnchors` + `applyCollapse` to mint the summary node, and assert
// the representative and the membership gate. Deterministic + offline.
//
// Validates: Requirements 22.1, 22.2, 22.3
// ─────────────────────────────────────────────────────────────────────────

describe("Property 12: Fold Moves Selection to the Summary Node", () => {
  // A short linear region off a trunk. HEAD sits at the tip so it stays pinned;
  // r1..r3 form a foldable ≥ 2-member region (one parent, one child each).
  //
  //   base <- r3 <- r2 <- r1 <- tip(HEAD)
  //   region anchor r1 → members r1, r2, r3 (newest-first)
  function fixture(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refsByOid: Map<string, RefLabel[]>;
  } {
    const nodes: CommitNode[] = [
      mk("tip", 6000, ["r1"]),
      mk("r1", 5000, ["r2"]),
      mk("r2", 4000, ["r3"]),
      mk("r3", 3000, ["base"]),
      mk("base", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "r1", target: "tip" },
      { source: "r2", target: "r1" },
      { source: "r3", target: "r2" },
      { source: "base", target: "r3" },
    ];
    const refsByOid = new Map<string, RefLabel[]>([
      ["tip", [ref("HEAD", "tip", "head", true)]],
    ]);
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return { nodes, edges, refsByOid };
  }

  it("returns the newest member as the summary node's representative", () => {
    const { nodes, edges, refsByOid } = fixture();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    const members = regionAround("r1", nodes, edges, refsByOid)!;
    // newest-first ordering: r1 is the newest member.
    expect(members).toEqual(["r1", "r2", "r3"]);

    // Fold the region → mint the summary node.
    const groups = regionsFromAnchors(["r1"], nodes, edges, refsByOid);
    const eff = applyCollapse(nodes, edges, groups, new Set(), nodeByOid);
    const id = regionRollupId("r1");
    expect(eff.runNodes.has(id)).toBe(true);

    // The representative selection == the group's newest member == members[0].
    const rep = selectionForSummaryNode(id, eff.runNodes);
    expect(rep).toBe("r1");
    expect(rep).toBe(members[0]);
  });

  it("re-selects the representative when the fold hides the selected commit (22.1, 22.2)", () => {
    const { nodes, edges, refsByOid } = fixture();
    const members = regionAround("r1", nodes, edges, refsByOid)!;

    // Model the collapseRegion decision for each selected member of the fold.
    for (const selectedOid of ["r1", "r2", "r3"]) {
      expect(members.includes(selectedOid)).toBe(true);
      // Gate is satisfied → re-select the representative (newest member).
      const rep = members.includes(selectedOid) ? members[0] : selectedOid;
      expect(rep).toBe("r1");
    }
  });

  it("leaves selection unchanged when the fold does NOT include the selected commit (22.3)", () => {
    const { nodes, edges, refsByOid } = fixture();
    const members = regionAround("r1", nodes, edges, refsByOid)!;

    // `tip` and `base` are outside the region → the gate is not satisfied.
    for (const selectedOid of ["tip", "base"]) {
      expect(members.includes(selectedOid)).toBe(false);
      // Gate fails → selection is left unchanged (no re-select to members[0]).
      const rep = members.includes(selectedOid) ? members[0] : selectedOid;
      expect(rep).toBe(selectedOid);
    }
  });

  it("re-selects the newest member for a merge secondary-path fold (22.1)", () => {
    // Merge fold variant: a merged feature line hidden behind M. Selecting any
    // hidden member moves selection to the newest member oids[0].
    const nodes: CommitNode[] = [
      mk("M", 6000, ["c2", "f2"]),
      mk("f2", 4000, ["f1"]),
      mk("f1", 3000, ["c1"]),
      mk("c2", 5000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "M" },
      { source: "f2", target: "M" },
      { source: "f1", target: "f2" },
      { source: "c1", target: "f1" },
      { source: "c1", target: "c2" },
    ];
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const members = mergeSecondaryPath("M", 1, nodes, edges)!.oids;
    // newest-first: f2 before f1.
    expect(members).toEqual(["f2", "f1"]);

    // Selecting a hidden member → re-select the newest member (f2).
    for (const selectedOid of ["f1", "f2"]) {
      const rep = members.includes(selectedOid) ? members[0] : selectedOid;
      expect(rep).toBe("f2");
    }
    // Selecting a non-member (the still-visible merge M) → unchanged.
    const repOutside = members.includes("M") ? members[0] : "M";
    expect(repOutside).toBe("M");
  });
});

import { describe, it, expect } from "vitest";
import {
  detectRuns,
  detectBranchRollups,
  applyCollapse,
  isCollapsedRunId,
  isBranchRollupId,
  selectionForSummaryNode,
} from "./collapse";
import type { CommitNode, CommitEdge, RefLabel } from "../../api/client";

// Helper: build a linear chain of N commits, newest-first (c{N}..c1), with
// parent→child edges. Returns { nodes, edges }.
function linear(n: number): { nodes: CommitNode[]; edges: CommitEdge[] } {
  const nodes: CommitNode[] = [];
  const edges: CommitEdge[] = [];
  for (let i = n; i >= 1; i--) {
    const oid = `c${i}`;
    nodes.push({
      oid,
      short_oid: oid,
      summary: `commit ${i}`,
      author_name: "t",
      author_email: "t@t",
      timestamp: i * 1000,
      parents: i > 1 ? [`c${i - 1}`] : [],
    });
    if (i > 1) edges.push({ source: `c${i - 1}`, target: `c${i}` }); // parent -> child
  }
  return { nodes, edges };
}

describe("detectRuns", () => {
  it("detects a long linear run above the threshold", () => {
    const { nodes, edges } = linear(10);
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    // The interior commits (not tip c10, not root c1) form one foldable run.
    expect(runs.length).toBe(1);
    expect(runs[0].oids.length).toBeGreaterThanOrEqual(8);
  });

  it("does not fold runs below the threshold", () => {
    const { nodes, edges } = linear(4);
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    expect(runs.length).toBe(0);
  });

  it("never folds a commit that carries a ref/tag", () => {
    const { nodes, edges } = linear(10);
    // Put a tag on c5 → it must break the run and stay visible.
    const refs = new Map<string, RefLabel[]>([
      ["c5", [{ name: "v1", oid: "c5", kind: "tag", is_head: false, tip_ts: 5000, upstream: null }]],
    ]);
    const runs = detectRuns(nodes, edges, refs, null, 3);
    const folded = new Set(runs.flatMap((r) => r.oids));
    expect(folded.has("c5")).toBe(false);
  });
});

describe("applyCollapse", () => {
  it("folds a run into one summary node and reroutes edges", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    const eff = applyCollapse(nodes, edges, runs, new Set(), nodeByOid);
    // One summary node replaces the folded interior commits.
    expect(eff.runNodes.size).toBe(1);
    expect(eff.nodes.length).toBeLessThan(nodes.length);
    // No effective edge references a folded-away commit.
    const renderIds = new Set([...eff.nodes.map((n) => n.oid), ...eff.runNodes.keys()]);
    for (const e of eff.edges) {
      expect(renderIds.has(e.source)).toBe(true);
      expect(renderIds.has(e.target)).toBe(true);
    }
  });

  it("respects expanded overrides (does not fold an expanded run)", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    const expanded = new Set(runs.map((r) => r.id));
    const eff = applyCollapse(nodes, edges, runs, expanded, nodeByOid);
    expect(eff.runNodes.size).toBe(0);
    expect(eff.nodes.length).toBe(nodes.length);
  });
});

describe("detectBranchRollups", () => {
  it("folds only a collapsed branch's unique commits (not shared ancestors)", () => {
    // base(c1) <- main-2(c2) ; feature diverges at c2: f1(c3), f2(c4) ; main-3(c5)
    const nodes: CommitNode[] = [
      mk("c5", 5000, ["c2"]), // main-3
      mk("c4", 4000, ["c3"]), // f2
      mk("c3", 3000, ["c2"]), // f1
      mk("c2", 2000, ["c1"]), // main-2 (shared)
      mk("c1", 1000, []), // base (shared)
    ];
    const edges: CommitEdge[] = [
      { source: "c2", target: "c5" },
      { source: "c3", target: "c4" },
      { source: "c2", target: "c3" },
      { source: "c1", target: "c2" },
    ];
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: "c4" }],
      ["c5"], // main tip expanded
    );
    expect(rollups.length).toBe(1);
    const folded = new Set(rollups[0].oids);
    expect(folded).toEqual(new Set(["c3", "c4"])); // only feature's unique commits
    expect(folded.has("c2")).toBe(false); // shared ancestor stays
    expect(folded.has("c1")).toBe(false);
    expect(isBranchRollupId(rollups[0].id)).toBe(true);
  });
});

describe("id helpers", () => {
  it("recognizes run and branch rollup ids", () => {
    const { nodes, edges } = linear(10);
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    expect(isCollapsedRunId(runs[0].id)).toBe(true);
  });
});

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

// ─────────────────────────────────────────────────────────────────────────
// Task 1 — Bug condition exploration tests (encode expected POST-FIX behavior).
//
// These tests MUST FAIL on the unfixed code — their failure documents the three
// defects described in the bugfix spec. Once the fixes land they turn green and
// serve as the fix verification (Property 1/2/3).
//
// Fixtures are deterministic and offline (fixed timestamps, in-memory data).
// ─────────────────────────────────────────────────────────────────────────

// Topology helper for branch-rollup fixtures:
//   base(c1) <- main-2(c2) ; feature diverges at c2 with `featLen` commits ;
//   main continues past c2 with `mainExtra` commits.
// Returns nodes (newest-first), edges (parent->child), the feature tip oid, and
// the main tip oid (expanded anchor).
function branchTopology(featLen: number, mainExtra = 1): {
  nodes: CommitNode[];
  edges: CommitEdge[];
  featureTip: string;
  mainTip: string;
} {
  const nodes: CommitNode[] = [];
  const edges: CommitEdge[] = [];
  let ts = 1000;

  // Shared base + first shared main commit.
  nodes.push(mk("c1", ts, [])); // base
  ts += 1000;
  nodes.push(mk("c2", ts, ["c1"])); // main-2 (shared divergence point)
  edges.push({ source: "c1", target: "c2" });

  // Main continuation off c2.
  let mainPrev = "c2";
  for (let i = 0; i < mainExtra; i++) {
    ts += 1000;
    const oid = `m${i + 1}`;
    nodes.push(mk(oid, ts, [mainPrev]));
    edges.push({ source: mainPrev, target: oid });
    mainPrev = oid;
  }
  const mainTip = mainPrev;

  // Feature branch off c2.
  let featPrev = "c2";
  for (let i = 0; i < featLen; i++) {
    ts += 1000;
    const oid = `f${i + 1}`;
    nodes.push(mk(oid, ts, [featPrev]));
    edges.push({ source: featPrev, target: oid });
    featPrev = oid;
  }
  const featureTip = featPrev;

  // Sort newest-first for graph order.
  nodes.sort((a, b) => b.timestamp - a.timestamp);
  return { nodes, edges, featureTip, mainTip };
}

describe("bug: single-commit branch rollup (Defect 3)", () => {
  it("does NOT emit a rollup for a collapsed branch with exactly one unique commit", () => {
    // feature contributes exactly one unique commit (f1) off the shared point.
    const { nodes, edges, featureTip, mainTip } = branchTopology(1, 1);
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: featureTip }],
      [mainTip],
    );
    // Expected post-fix: no rollup (the lone commit renders as a normal node).
    // Unfixed: emits a length-1 rollup → counterexample.
    expect(rollups).toEqual([]);
  });
});

describe("bug: expand override ignored on branch rollups (Defect 1)", () => {
  it("un-folds a branch rollup whose id is in the expand override", () => {
    // feature contributes 3 unique commits → a real rollup on default render.
    const { nodes, edges, featureTip, mainTip } = branchTopology(3, 1);
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: featureTip }],
      [mainTip],
    );
    expect(rollups.length).toBe(1);
    const rollupId = rollups[0].id;

    // Reproduce CommitGraph's group-assembly: branch rollups must honor a
    // force-expand override, and applyCollapse must be given the override set.
    const expanded = new Set<string>([rollupId]);
    const allGroups = rollups.filter((r) => !expanded.has(r.id));
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const eff = applyCollapse(nodes, edges, allGroups, expanded, nodeByOid);

    // Expected post-fix: the summary node is gone and every folded oid renders
    // as its own commit node. Unfixed CommitGraph passes an empty override and
    // includes the rollup unconditionally → stays folded.
    expect(eff.runNodes.has(rollupId)).toBe(false);
    for (const oid of rollups[0].oids) {
      expect(eff.foldedInto.has(oid)).toBe(false);
      expect(eff.nodes.some((n) => n.oid === oid)).toBe(true);
    }
  });
});

describe("bug: summary-node click leaves stale selection (Defect 2)", () => {
  it("derives the group's newest oid as the representative selection", () => {
    const { nodes, edges, featureTip, mainTip } = branchTopology(3, 1);
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: featureTip }],
      [mainTip],
    );
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const eff = applyCollapse(nodes, edges, rollups, new Set(), nodeByOid);
    const rollupId = rollups[0].id;

    // The pure decision that onNodeClick must use to update the right pane.
    const rep = selectionForSummaryNode(rollupId, eff.runNodes);
    expect(rep).toBe(rollups[0].oids[0]); // newest member
    expect(rep).not.toBeNull();
  });

  it("returns null when the summary node id is unknown", () => {
    expect(selectionForSummaryNode("__branch__nope", new Map())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 2 — Preservation tests (baseline behavior for NON-buggy inputs).
//
// These capture behavior that must remain unchanged and PASS on the unfixed
// code. They guard against regressions from the three fixes.
// ─────────────────────────────────────────────────────────────────────────

describe("preservation: multi-commit branch rollup unchanged", () => {
  it("still folds a >= 2 unique-commit branch into exactly one rollup", () => {
    const { nodes, edges, featureTip, mainTip } = branchTopology(4, 1);
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: featureTip }],
      [mainTip],
    );
    expect(rollups.length).toBe(1);
    expect(rollups[0].oids.length).toBe(4);
    expect(new Set(rollups[0].oids)).toEqual(new Set(["f1", "f2", "f3", "f4"]));
    expect(rollups[0].oids).toEqual([...rollups[0].oids].sort((a, b) => {
      const idx = new Map(nodes.map((n, i) => [n.oid, i]));
      return idx.get(a)! - idx.get(b)!;
    })); // newest-first order preserved
    expect(isBranchRollupId(rollups[0].id)).toBe(true);
  });
});

describe("preservation: zero-unique-commit branch unchanged", () => {
  it("produces no rollup when the collapsed branch shares all history", () => {
    // feature tip IS the main tip's ancestor: point feature at c2 (shared).
    const { nodes, edges, mainTip } = branchTopology(2, 2);
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: "c2" }], // fully shared with main
      [mainTip],
    );
    expect(rollups).toEqual([]);
  });
});

describe("preservation: linear-run expansion unchanged", () => {
  it("un-folds a __run__ linear run added to the expand override", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    expect(runs.length).toBe(1);
    const expanded = new Set(runs.map((r) => r.id));
    const eff = applyCollapse(nodes, edges, runs, expanded, nodeByOid);
    expect(eff.runNodes.size).toBe(0);
    expect(eff.nodes.length).toBe(nodes.length);
  });
});

describe("preservation: randomized multi-commit branch rollups", () => {
  // Deterministic pseudo-random generator (offline, reproducible).
  function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("never emits a rollup with 0 unique commits, and folds all unique commits for >= 2", () => {
    const rng = makeRng(42);
    for (let iter = 0; iter < 50; iter++) {
      const featLen = 2 + Math.floor(rng() * 6); // 2..7 (multi-commit, non-buggy)
      const mainExtra = 1 + Math.floor(rng() * 3);
      const { nodes, edges, featureTip, mainTip } = branchTopology(featLen, mainExtra);
      const rollups = detectBranchRollups(
        nodes,
        edges,
        [{ name: "feature", tip: featureTip }],
        [mainTip],
      );
      // Multi-commit feature → exactly one rollup folding all featLen commits.
      expect(rollups.length).toBe(1);
      expect(rollups[0].oids.length).toBe(featLen);
      // No shared ancestor is ever folded.
      expect(rollups[0].oids.includes("c1")).toBe(false);
      expect(rollups[0].oids.includes("c2")).toBe(false);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 5 — Round-2 bug condition exploration tests (Defects 4, 5, 6).
//
// These encode the expected POST-FIX behavior and MUST FAIL on the current
// (Round-1) code. Where a defect lives in CommitGraph.tsx's state wiring rather
// than a pure function, the test reproduces the CURRENT CommitGraph pipeline
// inline (the one-way triple-filtered `expandedRuns` override, and the
// membership-derived run id re-detection) and asserts the fixed outcome, so the
// failure documents the defect. After the Round-2 fix these same tests turn
// green (they exercise the new pure helpers + fixed `applyCollapse`).
//
// All fixtures are deterministic + offline (fixed timestamps, in-memory data).
// ─────────────────────────────────────────────────────────────────────────

import {
  effectiveExpanded,
  runIdsOverlapping,
  orphanedMembers,
  resolveFoldState,
  expandSeed,
} from "./collapse";

describe("bug: fold→expand→collapse round-trip not reversible (Defect 4)", () => {
  it("re-collapsing an expanded group returns it to the folded state", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    expect(runs.length).toBe(1);
    const runId = runs[0].id;

    // Baseline: folded (no override at all).
    const folded = resolveFoldState(nodes, edges, runs, [], new Set(), new Set(), nodeByOid);
    expect(folded.runNodes.has(runId)).toBe(true);

    // Expand: user force-expands the run.
    const expanded = new Set<string>([runId]);
    const afterExpand = resolveFoldState(nodes, edges, runs, [], expanded, new Set(), nodeByOid);
    expect(afterExpand.runNodes.has(runId)).toBe(false); // expanded, good

    // Collapse again: user force-collapses the SAME group. A manual collapse
    // must authoritatively win over the prior expand (round-trip reversible).
    const collapsed = new Set<string>([runId]);
    const afterCollapse = resolveFoldState(nodes, edges, runs, [], expanded, collapsed, nodeByOid);

    // Expected post-fix: the group is folded again.
    expect(afterCollapse.runNodes.has(runId)).toBe(true);
    expect(afterCollapse.nodes.length).toBe(folded.nodes.length);
    expect(afterCollapse.runNodes.size).toBe(folded.runNodes.size);
  });

  it("effectiveExpanded lets a manual collapse override a prior expand", () => {
    const expanded = new Set<string>(["__run__a__b"]);
    const collapsed = new Set<string>(["__run__a__b"]);
    expect(effectiveExpanded(expanded, collapsed).has("__run__a__b")).toBe(false);
  });
});

describe("bug: expanding a branch rollup leaves an orphan (Defect 5)", () => {
  // NOTE ON SCOPE: Defect 5's *failing* manifestation is a component-level
  // integration defect — it arises from CommitGraph.tsx's two-phase render-id
  // computation (branch rollups derived separately from linear runs, combined,
  // then the `flowEdges` dangling-edge filter). The pure `applyCollapse` already
  // reroutes boundary edges through `renderId`, so it cannot orphan a member in
  // isolation; per project conventions the DOM/React-Flow orphan is verified via
  // build + manual check (see tasks.md Task 8).
  //
  // What we CAN pin down purely is the fix's contract: `resolveFoldState` (the
  // extracted pipeline) must reconcile the effective edge set against the FINAL
  // render-id set so no un-folded member is left parentless. This test asserts
  // that no-orphan invariant over the pipeline; it guards the Defect-5 fix and
  // must remain green (the invariant checker `orphanedMembers` is the deliverable
  // the design calls for).
  it("resolveFoldState leaves no member orphaned when expanding one of two rollups", () => {
    // `feature` (f1,f2) branches off g1 — the OLDEST member of the still-folded
    // `other` rollup (g1,g2,g3). main (m1) is expanded. Fold BOTH branches, then
    // expand ONLY `feature`. feature's oldest member f1 has parent g1, folded
    // into `other`; the pipeline must reroute g1->f1 to (otherRollup -> f1) over
    // the FINAL render-id set so f1 keeps a parent edge (no orphan).
    const nodes: CommitNode[] = [
      mk("f2", 9000, ["f1"]),
      mk("f1", 8000, ["g1"]),
      mk("g3", 7000, ["g2"]),
      mk("g2", 6000, ["g1"]),
      mk("g1", 5000, ["c2"]),
      mk("m1", 4000, ["c2"]),
      mk("c2", 2000, ["c1"]),
      mk("c1", 1000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "f1", target: "f2" },
      { source: "g1", target: "f1" },
      { source: "g2", target: "g3" },
      { source: "g1", target: "g2" },
      { source: "c2", target: "g1" },
      { source: "c2", target: "m1" },
      { source: "c1", target: "c2" },
    ];
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));

    const rollups = detectBranchRollups(
      nodes,
      edges,
      [
        { name: "feature", tip: "f2" },
        { name: "other", tip: "g3" },
      ],
      ["m1"],
    );
    expect(rollups.length).toBe(2);
    const featureRollup = rollups.find((r) => r.label === "feature")!;

    // Expand ONLY the feature rollup; the `other` rollup stays folded.
    const expanded = new Set<string>([featureRollup.id]);
    const eff = resolveFoldState(nodes, edges, [], rollups, expanded, new Set(), nodeByOid);

    // No member of the expanded feature group is orphaned — f1 must retain an
    // in-edge (rerouted from its folded parent g1's rollup).
    const orphans = orphanedMembers(nodes, eff).filter((oid) =>
      featureRollup.oids.includes(oid),
    );
    expect(orphans).toEqual([]);
  });
});

describe("bug: expanding un-folds only one commit at a time (Defect 6)", () => {
  it("expanding a long run reveals the ENTIRE group in one action", () => {
    // A 40-commit linear chain → interior forms one long foldable run.
    const { nodes, edges } = linear(40);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    expect(runs.length).toBe(1);
    const clicked = runs[0];

    // Seed the expand override the way a summary-node click does, then resolve.
    const seeded = expandSeed(clicked.id, clicked.oids, runs);
    const eff = resolveFoldState(nodes, edges, runs, [], seeded, new Set(), nodeByOid);

    // Expected post-fix: NONE of the clicked group's members remain folded and
    // no residual run summary node remains for the clicked group.
    for (const oid of clicked.oids) {
      expect(eff.foldedInto.has(oid)).toBe(false);
    }
    expect(eff.runNodes.has(clicked.id)).toBe(false);
  });

  it("expandSeed covers EVERY run overlapping the clicked group's members", () => {
    // Two foldable runs split by a tagged commit in the middle of a long chain.
    // A "clicked group" whose member oids span BOTH runs must seed BOTH run ids,
    // otherwise the un-seeded run re-folds after expansion (the Defect-6
    // mechanism: a membership-derived id the single-id seed misses).
    const { nodes, edges } = linear(24);
    // Tag c12 → breaks the interior into two separate foldable runs.
    const refs = new Map<string, RefLabel[]>([
      ["c12", [{ name: "v1", oid: "c12", kind: "tag", is_head: false, tip_ts: 12000, upstream: null }]],
    ]);
    const runs = detectRuns(nodes, edges, refs, null, 8);
    expect(runs.length).toBeGreaterThanOrEqual(2);

    // Clicked group spans members drawn from BOTH runs.
    const groupOids = [...runs[0].oids, ...runs[1].oids];
    const seeded = expandSeed("__group__", groupOids, runs);

    // Post-fix: the seed contains every run id that overlaps the clicked group.
    const expectedIds = new Set(runIdsOverlapping(groupOids, runs));
    for (const id of expectedIds) {
      expect(seeded.has(id)).toBe(true);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 6 — Round-2 preservation tests (Property 4 / Property 8 in design).
//
// Baseline behavior that must be UNCHANGED by the Round-2 fix. These are
// observed on the CURRENT (Round-1) code and MUST PASS both before and after
// the fix. They guard round-trip connectivity (3.5), the auto-collapse default
// (3.6), per-group independence (3.7), correctly-wired linear-run expansion
// (3.1), and multi-commit rollup / branch-control scoping (3.3, 3.4).
//
// Fixtures are deterministic + offline.
// ─────────────────────────────────────────────────────────────────────────

// Effective render-id set for an effective graph (commit oids + summary ids).
function renderIdsOf(eff: ReturnType<typeof applyCollapse>): Set<string> {
  return new Set([...eff.nodes.map((n) => n.oid), ...eff.runNodes.keys()]);
}

describe("preservation: round-trip connectivity (3.5)", () => {
  it("every effective edge references only rendered nodes (no dangling)", () => {
    const { nodes, edges } = linear(20);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    // Folded and expanded states both keep the DAG connected.
    for (const expanded of [new Set<string>(), new Set(runs.map((r) => r.id))]) {
      const eff = applyCollapse(nodes, edges, runs, expanded, nodeByOid);
      const ids = renderIdsOf(eff);
      for (const e of eff.edges) {
        expect(ids.has(e.source)).toBe(true);
        expect(ids.has(e.target)).toBe(true);
      }
    }
  });

  it("folding reroutes every original edge in/out of a run through its summary node", () => {
    const { nodes, edges } = linear(12);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    expect(runs.length).toBe(1);
    const eff = applyCollapse(nodes, edges, runs, new Set(), nodeByOid);
    // No effective edge touches a folded-away commit; the boundary commits
    // (tip c12, root c1) still connect to the summary node.
    const ids = renderIdsOf(eff);
    const runId = runs[0].id;
    // The run node has both an in-edge (from its oldest member's parent side)
    // and an out-edge (to its newest member's child side).
    const touchesRun = eff.edges.filter((e) => e.source === runId || e.target === runId);
    expect(touchesRun.length).toBeGreaterThanOrEqual(2);
    for (const e of eff.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe("preservation: auto-collapse default (3.6)", () => {
  it("with no manual override, runs >= AUTO_COLLAPSE_LEN fold and shorter ones do not", () => {
    // AUTO_COLLAPSE_LEN in CommitGraph is 8; detectRuns floor here mirrors it.
    const long = linear(12); // interior run length 10 >= 8 → folds
    const longRuns = detectRuns(long.nodes, long.edges, new Map(), null, 8);
    expect(longRuns.length).toBe(1);

    const short = linear(6); // interior run length 4 < 8 → no auto-fold
    const shortRuns = detectRuns(short.nodes, short.edges, new Map(), null, 8);
    expect(shortRuns.length).toBe(0);
  });
});

describe("preservation: per-group independence (3.7)", () => {
  it("expanding one group leaves other groups folded", () => {
    // Two independent long chains joined only at a shared tip would entangle,
    // so use two separate branch rollups off a shared base with main expanded.
    const { nodes, edges, mainTip } = branchTopology(4, 1);
    // Add a second collapsed branch off c2 with its own commits.
    let ts = 100000;
    const extra: CommitNode[] = [];
    let prev = "c2";
    for (let i = 0; i < 3; i++) {
      const oid = `h${i + 1}`;
      extra.push(mk(oid, ts, [prev]));
      edges.push({ source: prev, target: oid });
      prev = oid;
      ts += 1000;
    }
    const hTip = prev;
    const allNodes = [...nodes, ...extra].sort((a, b) => b.timestamp - a.timestamp);
    const nodeByOid = new Map(allNodes.map((n) => [n.oid, n]));

    const rollups = detectBranchRollups(
      allNodes,
      edges,
      [
        { name: "feature", tip: allNodes.find((n) => n.oid === "f4")!.oid },
        { name: "hotfix", tip: hTip },
      ],
      [mainTip],
    );
    expect(rollups.length).toBe(2);
    const feature = rollups.find((r) => r.label === "feature")!;
    const hotfix = rollups.find((r) => r.label === "hotfix")!;

    // Expand ONLY feature; hotfix must stay folded (a summary node).
    const expanded = new Set<string>([feature.id]);
    const groups = rollups.filter((r) => !expanded.has(r.id));
    const eff = applyCollapse(allNodes, edges, groups, expanded, nodeByOid);
    expect(eff.runNodes.has(feature.id)).toBe(false); // expanded
    expect(eff.runNodes.has(hotfix.id)).toBe(true); // still folded, independent
  });
});

describe("preservation: correctly-wired linear-run expansion (3.1)", () => {
  it("a __run__ id in the expand override un-folds its commits", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const runs = detectRuns(nodes, edges, new Map(), null, 8);
    const expanded = new Set(runs.map((r) => r.id));
    const eff = applyCollapse(nodes, edges, runs, expanded, nodeByOid);
    expect(eff.runNodes.size).toBe(0);
    expect(eff.nodes.length).toBe(nodes.length);
  });
});

describe("preservation: multi-commit rollup & scoping (3.3, 3.4)", () => {
  it("a >= 2 unique-commit branch still folds into exactly one rollup with correct count", () => {
    const { nodes, edges, featureTip, mainTip } = branchTopology(5, 2);
    const rollups = detectBranchRollups(
      nodes,
      edges,
      [{ name: "feature", tip: featureTip }],
      [mainTip],
    );
    expect(rollups.length).toBe(1);
    expect(rollups[0].oids.length).toBe(5);
    expect(isBranchRollupId(rollups[0].id)).toBe(true);
  });

  it("randomized multi-commit branches: one rollup, correct membership, connectivity", () => {
    function makeRng(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    }
    const rng = makeRng(7);
    for (let iter = 0; iter < 40; iter++) {
      const featLen = 2 + Math.floor(rng() * 6);
      const mainExtra = 1 + Math.floor(rng() * 3);
      const { nodes, edges, featureTip, mainTip } = branchTopology(featLen, mainExtra);
      const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
      const rollups = detectBranchRollups(
        nodes,
        edges,
        [{ name: "feature", tip: featureTip }],
        [mainTip],
      );
      expect(rollups.length).toBe(1);
      expect(rollups[0].oids.length).toBe(featLen);
      // Folded: connectivity preserved (no dangling edge).
      const eff = applyCollapse(nodes, edges, rollups, new Set(), nodeByOid);
      const ids = renderIdsOf(eff);
      for (const e of eff.edges) {
        expect(ids.has(e.source)).toBe(true);
        expect(ids.has(e.target)).toBe(true);
      }
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 9 — Round-3 bug condition exploration tests (Defects 1.8, 1.9, 1.10, 2.13).
//
// These encode the expected POST-FIX behavior of the NEW on-demand
// contiguous-region collapse model and MUST FAIL on the current (Round-2) code
// — the region helpers (`regionAround`, `regionRollupId`, `isRegionId`,
// `anchorFromId`, `regionsFromAnchors`, `autoCollapseAnchors`) do not exist yet,
// so this file fails to resolve on current code. That failure documents the
// model gap. After the Round-3 fix these turn green (Properties 10, 11, 12, 14).
//
// All fixtures are deterministic + offline (fixed timestamps, in-memory data).
// ─────────────────────────────────────────────────────────────────────────

import {
  regionAround,
  regionRollupId,
  isRegionId,
  anchorFromId,
  regionsFromAnchors,
  autoCollapseAnchors,
  foldableNodeIds,
} from "./collapse";

// Build the classic branch/merge topology for region tests:
//
//   c1 (root, branch point: 2 children)
//     ├─ a1 - a2 - a3 - a4  (contiguous chain, foldable)
//     │                   \
//   c1 ┘                    m1 (merge point: 2 parents)
//     └─ b1 ─────────────── ┘
//
// The `a` chain is a maximal contiguous region: it stops BELOW at c1 (a branch
// point, 2 children) and ABOVE at m1 (a merge point, 2 parents). Both boundary
// commits stay visible. Returns nodes (newest-first) + edges (parent->child).
function branchMergeTopology(aLen = 4): {
  nodes: CommitNode[];
  edges: CommitEdge[];
  aChain: string[]; // newest-first
  branchPoint: string; // c1
  mergePoint: string; // m1
} {
  const nodes: CommitNode[] = [];
  const edges: CommitEdge[] = [];
  let ts = 1000;

  // root / branch point
  nodes.push(mk("c1", ts, []));
  ts += 1000;

  // a-chain off c1
  const aChain: string[] = [];
  let prev = "c1";
  for (let i = 0; i < aLen; i++) {
    const oid = `a${i + 1}`;
    nodes.push(mk(oid, ts, [prev]));
    edges.push({ source: prev, target: oid });
    prev = oid;
    aChain.push(oid);
    ts += 1000;
  }
  const aTop = prev;

  // b-side single commit off c1
  nodes.push(mk("b1", ts, ["c1"]));
  edges.push({ source: "c1", target: "b1" });
  ts += 1000;

  // merge point m1 with parents aTop + b1
  nodes.push(mk("m1", ts, [aTop, "b1"]));
  edges.push({ source: aTop, target: "m1" });
  edges.push({ source: "b1", target: "m1" });

  nodes.sort((a, b) => b.timestamp - a.timestamp);
  aChain.reverse(); // newest-first
  return { nodes, edges, aChain, branchPoint: "c1", mergePoint: "m1" };
}

describe("bug: region contiguity + boundary exclusion (Defect 1.10 / Property 10)", () => {
  it("regionAround returns the maximal contiguous chain, excluding branch/merge boundaries", () => {
    const { nodes, edges, aChain, branchPoint, mergePoint } = branchMergeTopology(4);
    const refs = new Map<string, RefLabel[]>();
    // Anchor on a middle commit of the a-chain.
    const region = regionAround("a2", nodes, edges, refs);
    expect(region).not.toBeNull();
    // Members are exactly the a-chain, newest-first, and DO NOT include the
    // branch point below (c1) or the merge point above (m1).
    expect(new Set(region!)).toEqual(new Set(aChain));
    expect(region!).not.toContain(branchPoint);
    expect(region!).not.toContain(mergePoint);
    // Newest-first ordering.
    expect(region![0]).toBe(aChain[0]);
    // Single connected chain in graph.edges: each consecutive pair is an edge.
    const edgeSet = new Set(edges.map((e) => `${e.source}->${e.target}`));
    for (let i = 0; i < region!.length - 1; i++) {
      // region is newest-first, so parent is region[i+1] -> child region[i].
      expect(edgeSet.has(`${region![i + 1]}->${region![i]}`)).toBe(true);
    }
  });
});

describe("bug: orphan-freeness of a region fold (Defect 1.8 / Property 10)", () => {
  it("folding a region via regionsFromAnchors + applyCollapse leaves no orphan", () => {
    const { nodes, edges } = branchMergeTopology(4);
    const refs = new Map<string, RefLabel[]>();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const groups = regionsFromAnchors(["a2"], nodes, edges, refs);
    expect(groups.length).toBe(1);
    const eff = applyCollapse(nodes, edges, groups, new Set(), nodeByOid);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
    // The rollup has exactly one entry edge (from c1) and one exit edge (to m1).
    const rid = regionRollupId("a2");
    // Actually the id is keyed on the anchor; the region-node id is derived from
    // its anchor when built via regionsFromAnchors — check a summary node exists.
    const summaryIds = [...eff.runNodes.keys()];
    expect(summaryIds.length).toBe(1);
    const summaryId = summaryIds[0];
    const inEdges = eff.edges.filter((e) => e.target === summaryId);
    const outEdges = eff.edges.filter((e) => e.source === summaryId);
    expect(inEdges.length).toBe(1);
    expect(outEdges.length).toBe(1);
    void rid;
  });

  it("folding two ADJACENT regions at once still leaves no orphan", () => {
    // Two contiguous regions separated by a branch point mid-chain:
    //   root - x1 - x2 - x3 - BP(branch) - y1 - y2 - y3 - tip
    //                              └─ z1 (side branch off BP)
    // Region around x2 and region around y2 are two separate contiguous chains
    // that share the boundary BP. Folding both must not orphan anyone.
    const nodes: CommitNode[] = [];
    const edges: CommitEdge[] = [];
    let ts = 1000;
    const chain = ["root", "x1", "x2", "x3", "BP", "y1", "y2", "y3", "tip"];
    for (let i = 0; i < chain.length; i++) {
      nodes.push(mk(chain[i], ts, i > 0 ? [chain[i - 1]] : []));
      if (i > 0) edges.push({ source: chain[i - 1], target: chain[i] });
      ts += 1000;
    }
    // Side branch off BP → makes BP a branch point (2 children: y1 and z1).
    nodes.push(mk("z1", ts, ["BP"]));
    edges.push({ source: "BP", target: "z1" });
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const refs = new Map<string, RefLabel[]>();
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const groups = regionsFromAnchors(["x2", "y2"], nodes, edges, refs);
    expect(groups.length).toBe(2);
    const eff = applyCollapse(nodes, edges, groups, new Set(), nodeByOid);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
  });
});

describe("bug: stable-identity round-trip (Defect 1.9 / Property 11)", () => {
  it("regionRollupId is keyed on the anchor oid and recognized as a summary id", () => {
    expect(regionRollupId("abc123")).toBe("__region__abc123");
    expect(isRegionId("__region__abc123")).toBe(true);
    expect(isRegionId("__run__a__b")).toBe(false);
    expect(isCollapsedRunId("__region__abc123")).toBe(true); // treated as summary node
    expect(anchorFromId("__region__abc123")).toBe("abc123");
  });

  it("the region id is unchanged across a graph shift that would move a run's head/tail", () => {
    const base = branchMergeTopology(4);
    const refs = new Map<string, RefLabel[]>();
    // Fold keyed on the stable anchor a2.
    const idBefore = regionRollupId("a2");

    // Simulate a graph shift: prepend a newer commit onto the a-chain top
    // (a5 above a4, below the merge). This changes the run's head/tail boundary
    // (old collapsedRunId(head, tail) would change), but the anchor a2 does not.
    const nodes2 = base.nodes.map((n) => ({ ...n }));
    const edges2 = base.edges.slice();
    // Re-wire: insert a5 between a4 and m1.
    // remove a4->m1, add a4->a5, a5->m1
    const filtered = edges2.filter((e) => !(e.source === "a4" && e.target === "m1"));
    filtered.push({ source: "a4", target: "a5" });
    filtered.push({ source: "a5", target: "m1" });
    nodes2.push(mk("a5", 4500, ["a4"]));
    // fix m1 parents
    const m1 = nodes2.find((n) => n.oid === "m1")!;
    m1.parents = ["a5", "b1"];
    nodes2.sort((a, b) => b.timestamp - a.timestamp);

    const region2 = regionAround("a2", nodes2, filtered, refs);
    expect(region2).not.toBeNull();
    const idAfter = regionRollupId("a2");
    // Stable identity: the anchor-keyed id is identical even though membership
    // boundaries shifted (a5 joined the region).
    expect(idAfter).toBe(idBefore);
    expect(region2!).toContain("a5"); // membership grew, id unchanged
  });
});

describe("bug: on-demand eligibility (Defect 1.10 / Property 12)", () => {
  it("regionAround !== null for a >= 2 member region, null for a lone commit", () => {
    const { nodes, edges } = branchMergeTopology(4);
    const refs = new Map<string, RefLabel[]>();
    // a-chain commit → eligible.
    expect(regionAround("a3", nodes, edges, refs)).not.toBeNull();

    // Lone commit wedged directly between a branch point and a merge point:
    //   root(branch point) - lone - merge(2 parents)
    const lnodes: CommitNode[] = [
      mk("root", 1000, []),
      mk("lone", 2000, ["root"]),
      mk("side", 2500, ["root"]),
      mk("merge", 3000, ["lone", "side"]),
    ];
    const ledges: CommitEdge[] = [
      { source: "root", target: "lone" },
      { source: "root", target: "side" },
      { source: "lone", target: "merge" },
      { source: "side", target: "merge" },
    ];
    lnodes.sort((a, b) => b.timestamp - a.timestamp);
    // `lone` has one parent (root) and one child (merge) → foldable itself, but
    // its region has only itself (root is a branch point, merge is a merge
    // point), so < 2 members → null.
    expect(regionAround("lone", lnodes, ledges, refs)).toBeNull();
  });

  it("regionAround folds a non-HEAD ref anchor but pins the HEAD anchor", () => {
    // Ref-folding follow-up (Task 11): a branch/remote-branch/tag ref no longer
    // blocks folding — only the checked-out HEAD commit stays pinned. Refs on
    // hidden members resurface as summary-node badges (tasks 12/13).
    const { nodes, edges } = branchMergeTopology(4);

    // A tag on an interior a-chain commit no longer makes it non-foldable.
    const tagRefs = new Map<string, RefLabel[]>([
      ["a2", [{ name: "v1", oid: "a2", kind: "tag", is_head: false, tip_ts: 2000, upstream: null }]],
    ]);
    const tagged = regionAround("a2", nodes, edges, tagRefs);
    expect(tagged).not.toBeNull();
    expect(tagged!).toContain("a2");

    // But a HEAD ref on the same commit keeps it pinned (never folded).
    const headRefs = new Map<string, RefLabel[]>([
      ["a2", [{ name: "main", oid: "a2", kind: "head", is_head: true, tip_ts: 2000, upstream: null }]],
    ]);
    expect(regionAround("a2", nodes, edges, headRefs)).toBeNull();
  });

  it("regionAround ignores selection — the anchor is foldable regardless (Property 11)", () => {
    // Selection is no longer a region boundary (task 15): `regionAround` takes no
    // `selectedOid` and the selected commit is foldable like any other, so an
    // anchor that would previously be excluded when selected now folds normally.
    const { nodes, edges } = branchMergeTopology(4);
    const refs = new Map<string, RefLabel[]>();
    const region = regionAround("a2", nodes, edges, refs);
    expect(region).not.toBeNull();
    expect(region!).toContain("a2");
  });
});

describe("bug: HEAD-exempt auto-collapse seed (2.13 / Property 14)", () => {
  it("autoCollapseAnchors seeds off-trunk regions but exempts the HEAD first-parent chain", () => {
    // main trunk: c1(root) - t1 - t2 - t3 - t4 - t5 (HEAD)  [first-parent chain]
    // an off-trunk region branches off c1: o1 - o2 - o3 - o4 (>= autoLen)
    // and merges back at t5 (so it's a contiguous foldable region bounded by a
    // branch point at c1 and a merge point at t5).
    const nodes: CommitNode[] = [];
    const edges: CommitEdge[] = [];
    let ts = 1000;
    const trunk = ["c1", "t1", "t2", "t3", "t4"];
    for (let i = 0; i < trunk.length; i++) {
      nodes.push(mk(trunk[i], ts, i > 0 ? [trunk[i - 1]] : []));
      if (i > 0) edges.push({ source: trunk[i - 1], target: trunk[i] });
      ts += 1000;
    }
    // off-trunk chain off c1
    const off = ["o1", "o2", "o3", "o4"];
    let prev = "c1";
    for (const o of off) {
      nodes.push(mk(o, ts, [prev]));
      edges.push({ source: prev, target: o });
      prev = o;
      ts += 1000;
    }
    // HEAD commit t5: first parent t4 (trunk), second parent o4 (merge of off).
    nodes.push(mk("t5", ts, ["t4", "o4"]));
    edges.push({ source: "t4", target: "t5" });
    edges.push({ source: "o4", target: "t5" });
    nodes.sort((a, b) => b.timestamp - a.timestamp);

    const refs = new Map<string, RefLabel[]>();
    const anchors = autoCollapseAnchors(nodes, edges, "t5", refs, 3);
    // The HEAD trunk (t5 -> t4 -> t3 -> t2 -> t1 -> c1 via parents[0]) must be
    // exempt: no seeded anchor's region may intersect the trunk chain.
    const trunkSet = new Set(["t5", "t4", "t3", "t2", "t1", "c1"]);
    for (const a of anchors) {
      const region = regionAround(a, nodes, edges, refs);
      expect(region).not.toBeNull();
      for (const oid of region!) expect(trunkSet.has(oid)).toBe(false);
    }
    // The off-trunk region (o1..o4, length 4 >= 3) IS seeded.
    const seededOids = new Set(
      anchors.flatMap((a) => regionAround(a, nodes, edges, refs) ?? []),
    );
    expect(off.every((o) => seededOids.has(o))).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 10 — Round-3 preservation tests (Property 15 / reused guarantees).
//
// Baseline behavior that Round 3 REUSES and must NOT regress. These assert the
// EXISTING functions (`applyCollapse`, `selectionForSummaryNode`,
// `orphanedMembers`, and `branches.ts` scoping) behave as they do on the current
// (Round-2) code — so the model swap provably does not change them. They PASS on
// current code (they depend only on already-present functions).
//
// Fixtures are deterministic + offline.
// ─────────────────────────────────────────────────────────────────────────

import { defaultVisibility, shownBranchNames, branchesFromRefs } from "./branches";

describe("preservation R3: applyCollapse connectivity for a region-shaped chain (3.5)", () => {
  it("folding one contiguous chain reroutes edges through the summary node, no dangling", () => {
    // A region-shaped fixture: a single contiguous chain (the interior of a
    // linear graph) folded as one Run — exactly what regionsFromAnchors will
    // feed applyCollapse. Reuses applyCollapse unchanged.
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    // Interior chain c2..c9 (exclude tip c10 and root c1) as one group.
    const interior = ["c9", "c8", "c7", "c6", "c5", "c4", "c3", "c2"]; // newest-first
    const group = { oids: interior, id: "__region__c5" };
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);
    // No orphan; every effective edge references a rendered node.
    expect(orphanedMembers(nodes, eff)).toEqual([]);
    const ids = new Set([...eff.nodes.map((n) => n.oid), ...eff.runNodes.keys()]);
    for (const e of eff.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    // Exactly one entry + one exit edge on the summary node.
    const inEdges = eff.edges.filter((e) => e.target === "__region__c5");
    const outEdges = eff.edges.filter((e) => e.source === "__region__c5");
    expect(inEdges.length).toBe(1);
    expect(outEdges.length).toBe(1);
  });
});

describe("preservation R3: selectionForSummaryNode reused (3.10)", () => {
  it("returns the region's newest member and null for unknown ids", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const interior = ["c9", "c8", "c7", "c6", "c5", "c4", "c3", "c2"];
    const group = { oids: interior, id: "__region__c5" };
    const eff = applyCollapse(nodes, edges, [group], new Set(), nodeByOid);
    expect(selectionForSummaryNode("__region__c5", eff.runNodes)).toBe(interior[0]);
    expect(selectionForSummaryNode("__region__nope", eff.runNodes)).toBeNull();
  });
});

describe("preservation R3: whole-region expand reveals all + edges (3.9)", () => {
  it("expanding the region un-folds every member with all edges restored", () => {
    const { nodes, edges } = linear(10);
    const nodeByOid = new Map(nodes.map((n) => [n.oid, n]));
    const interior = ["c9", "c8", "c7", "c6", "c5", "c4", "c3", "c2"];
    const group = { oids: interior, id: "__region__c5" };
    const expanded = new Set(["__region__c5"]);
    const eff = applyCollapse(nodes, edges, [group], expanded, nodeByOid);
    // Expanded → no summary node, all commits present, no orphan.
    expect(eff.runNodes.size).toBe(0);
    expect(eff.nodes.length).toBe(nodes.length);
    expect(orphanedMembers(nodes, eff)).toEqual([]);
    for (const oid of interior) {
      expect(eff.nodes.some((n) => n.oid === oid)).toBe(true);
    }
  });
});

describe("preservation R3: branches.ts server-ref scoping unchanged (3.11)", () => {
  it("defaultVisibility + shownBranchNames produce the expected scoping", () => {
    const refs: RefLabel[] = [
      { name: "main", oid: "m", kind: "branch", is_head: true, tip_ts: 5000, upstream: null },
      { name: "feature-a", oid: "fa", kind: "branch", is_head: false, tip_ts: 4000, upstream: null },
      { name: "feature-b", oid: "fb", kind: "branch", is_head: false, tip_ts: 3000, upstream: null },
      { name: "origin/old", oid: "ro", kind: "remotebranch", is_head: false, tip_ts: 100, upstream: null },
    ];
    const branches = branchesFromRefs(refs);
    const vis = defaultVisibility(branches, 1);
    // main/HEAD → expanded; next 1 recent → collapsed; rest → hidden.
    expect(vis.get("main")).toBe("expanded");
    expect(vis.get("feature-a")).toBe("collapsed");
    expect(vis.get("feature-b")).toBe("hidden");
    expect(vis.get("origin/old")).toBe("hidden");
    // shownBranchNames = expanded + collapsed (never hidden).
    const shown = new Set(shownBranchNames(vis));
    expect(shown.has("main")).toBe(true);
    expect(shown.has("feature-a")).toBe(true);
    expect(shown.has("feature-b")).toBe(false);
    expect(shown.has("origin/old")).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Task 18.2 — Property 15: Eligibility = Participates-In or Adjacent-To a
// Foldable Region.
//
// `foldableNodeIds` marks EVERY member of a >= 2-member foldable region eligible
// (not just the head), maps each member to one identical canonical anchor, is
// selection-invariant, excludes HEAD, and never offers a single-commit fold.
//
// Validates: Requirements 26.1-26.9, 27.1, 27.3.
// ─────────────────────────────────────────────────────────────────────────

describe("Property 15: foldableNodeIds eligibility over the confirmed chain", () => {
  // The confirmed chain, newest -> oldest, one in-graph parent/child each:
  //   772eb2e (HEAD -> main) -> 6f21bf7 (origin/main) -> 431b5c2 -> 86bdb6f (tag) -> 578f9c8
  // Only the HEAD tip carries the checked-out HEAD; every other commit is a
  // ref-carrying-or-plain interior/tail commit that is foldable by topology.
  function confirmedChain(): {
    nodes: CommitNode[];
    edges: CommitEdge[];
    refsByOid: Map<string, RefLabel[]>;
  } {
    // The chain proper, newest-first. A root boundary `__root` below the chain
    // gives the oldest named commit (578f9c8) exactly one in-graph parent so it
    // is itself a region member (not a bare root boundary), matching the intent
    // that all four non-HEAD chain commits are foldable.
    const chain = ["772eb2e", "6f21bf7", "431b5c2", "86bdb6f", "578f9c8"]; // newest-first
    const full = [...chain, "__root"]; // append the anchoring root boundary
    const nodes: CommitNode[] = [];
    const edges: CommitEdge[] = [];
    // Fixed timestamps, newest-first: 6000, 5000, 4000, 3000, 2000, 1000.
    full.forEach((oid, i) => {
      const parent = i < full.length - 1 ? [full[i + 1]] : [];
      nodes.push(mk(oid, (full.length - i) * 1000, parent));
      if (parent.length) edges.push({ source: parent[0], target: oid });
    });
    const refsByOid = new Map<string, RefLabel[]>([
      [
        "772eb2e",
        [{ name: "main", oid: "772eb2e", kind: "head", is_head: true, tip_ts: 5000, upstream: null }],
      ],
      [
        "6f21bf7",
        [
          {
            name: "origin/main",
            oid: "6f21bf7",
            kind: "remotebranch",
            is_head: false,
            tip_ts: 4000,
            upstream: null,
          },
        ],
      ],
      [
        "86bdb6f",
        [{ name: "v1.0", oid: "86bdb6f", kind: "tag", is_head: false, tip_ts: 2000, upstream: null }],
      ],
    ]);
    return { nodes, edges, refsByOid };
  }

  it("marks every non-HEAD member eligible (not just the head), excludes HEAD", () => {
    const { nodes, edges, refsByOid } = confirmedChain();
    const { eligible } = foldableNodeIds(nodes, edges, refsByOid);
    // The four non-HEAD commits all get a control...
    expect(eligible.has("6f21bf7")).toBe(true);
    expect(eligible.has("431b5c2")).toBe(true);
    expect(eligible.has("86bdb6f")).toBe(true);
    expect(eligible.has("578f9c8")).toBe(true);
    // ...and the checked-out HEAD stays pinned inline (never a member, and the
    // adjacency clause explicitly excludes it — Req 26.4).
    expect(eligible.has("772eb2e")).toBe(false);
  });

  it("adjacency (Req 26.3): the tail-side neighbor __root is eligible and shares the region anchor; the head-side HEAD neighbor stays excluded", () => {
    const { nodes, edges, refsByOid } = confirmedChain();
    const { eligible, anchorFor } = foldableNodeIds(nodes, edges, refsByOid);
    // Region = {6f21bf7, 431b5c2, 86bdb6f, 578f9c8}; canonical anchor = 6f21bf7.
    const region = regionAround("431b5c2", nodes, edges, refsByOid);
    const anchor = region![0];
    // Tail-side neighbor: __root (the tail 578f9c8's single in-graph parent) is
    // now ELIGIBLE via the adjacency clause and maps to the SAME anchor as the
    // region members.
    expect(eligible.has("__root")).toBe(true);
    expect(anchorFor.get("__root")).toBe(anchor);
    // Head-side neighbor: 772eb2e is the region head's child but it's HEAD, so
    // the HEAD carve-out keeps it excluded even though it is adjacent.
    expect(eligible.has("772eb2e")).toBe(false);
    expect(anchorFor.has("772eb2e")).toBe(false);
  });

  it("maps every eligible member to the SAME single canonical anchor", () => {
    const { nodes, edges, refsByOid } = confirmedChain();
    const { eligible, anchorFor } = foldableNodeIds(nodes, edges, refsByOid);
    const anchors = new Set([...eligible].map((m) => anchorFor.get(m)));
    expect(anchors.size).toBe(1);
    // The canonical anchor is the region's newest member (oids[0]).
    const region = regionAround("431b5c2", nodes, edges, refsByOid);
    expect(region).not.toBeNull();
    expect([...anchors][0]).toBe(region![0]);
  });

  it("is deterministic across two calls (eligible set + anchorFor)", () => {
    const { nodes, edges, refsByOid } = confirmedChain();
    const a = foldableNodeIds(nodes, edges, refsByOid);
    const b = foldableNodeIds(nodes, edges, refsByOid);
    expect([...a.eligible].sort()).toEqual([...b.eligible].sort());
    expect([...a.anchorFor.entries()].sort()).toEqual(
      [...b.anchorFor.entries()].sort(),
    );
  });

  it("folding from an interior member folds the identical member set as the head", () => {
    const { nodes, edges, refsByOid } = confirmedChain();
    const { anchorFor } = foldableNodeIds(nodes, edges, refsByOid);
    // Activating on an interior member resolves to the same anchor as the head.
    const fromInterior = anchorFor.get("86bdb6f");
    const fromHead = anchorFor.get("6f21bf7");
    expect(fromInterior).toBe(fromHead);
    // And that anchor's region is the same ordered member set from any member.
    const rInterior = regionAround("86bdb6f", nodes, edges, refsByOid);
    const rHead = regionAround("6f21bf7", nodes, edges, refsByOid);
    expect(rInterior).toEqual(rHead);
  });

  it("a branch point / lone commit yields no single-commit eligibility", () => {
    // A lone commit (no parent, no child) is never eligible.
    const lone: CommitNode[] = [mk("solo", 1000, [])];
    const { eligible: e1 } = foldableNodeIds(lone, [], new Map());
    expect(e1.size).toBe(0);

    // A pure branch point (c1 with two children, each a tip) has no >= 2-member
    // contiguous region, so no node is offered a single-commit fold.
    const nodes: CommitNode[] = [
      mk("c1", 1000, []),
      mk("x", 2000, ["c1"]),
      mk("y", 3000, ["c1"]),
    ];
    const edges: CommitEdge[] = [
      { source: "c1", target: "x" },
      { source: "c1", target: "y" },
    ];
    const { eligible: e2 } = foldableNodeIds(nodes, edges, new Map());
    expect(e2.size).toBe(0);
  });

  it("eligible set is byte-for-byte identical across different selections (selection-invariant)", () => {
    // foldableNodeIds takes no selectedOid, so the result cannot vary by
    // selection — assert the sweep is identical regardless of any external
    // selection state by simply recomputing (there is no selection input).
    const { nodes, edges, refsByOid } = confirmedChain();
    const base = [...foldableNodeIds(nodes, edges, refsByOid).eligible].sort();
    // Recompute several times (the function is pure / selection-free).
    for (let i = 0; i < 3; i++) {
      const again = [...foldableNodeIds(nodes, edges, refsByOid).eligible].sort();
      expect(again).toEqual(base);
    }
  });

  it("adjacency (Req 26.3): a non-HEAD tip directly above a foldable region is eligible and folds that region", () => {
    // feat(tip, zero children) -> r1 -> r2 -> r3 -> base(root)
    // {r1,r2,r3} is a >= 2-member foldable region. `feat` is its head-side
    // neighbor: a NON-HEAD branch tip with zero children, so it is not a region
    // member (fails the one-child rule) — but it is adjacent, so with the
    // adjacency clause it becomes eligible and maps to the region's anchor.
    const chain = ["feat", "r1", "r2", "r3", "base"]; // newest-first
    const nodes: CommitNode[] = [];
    const edges: CommitEdge[] = [];
    chain.forEach((oid, i) => {
      const parent = i < chain.length - 1 ? [chain[i + 1]] : [];
      nodes.push(mk(oid, (chain.length - i) * 1000, parent));
      if (parent.length) edges.push({ source: parent[0], target: oid });
    });
    // `feat` carries a plain (non-HEAD) branch ref; no HEAD anywhere.
    const refsByOid = new Map<string, RefLabel[]>([
      [
        "feat",
        [{ name: "feat", oid: "feat", kind: "branch", is_head: false, tip_ts: 5000, upstream: null }],
      ],
    ]);

    const { eligible, anchorFor } = foldableNodeIds(nodes, edges, refsByOid);
    // The region {r1,r2,r3} — head-side neighbor `feat`, tail-side neighbor `base`.
    const region = regionAround("r2", nodes, edges, refsByOid);
    expect(region).toEqual(["r1", "r2", "r3"]);
    const anchor = region![0];

    // The non-HEAD tip is now eligible and folds the neighboring region.
    expect(eligible.has("feat")).toBe(true);
    expect(anchorFor.get("feat")).toBe(anchor);
    // Clicking it (collapseRegion(anchorFor.get(tip))) targets the same region
    // members as folding from the anchor.
    const fromTip = regionAround(anchorFor.get("feat")!, nodes, edges, refsByOid);
    expect(fromTip).toEqual(region);
  });

  it("member priority (Req 27.1): a node that is a member of its OWN region keeps its own-region anchor, not an adjacent region's", () => {
    // Two foldable regions separated by a branch point `bp`, arranged in one
    // lane on either side:
    //   tipA(head) -> a1 -> a2 -> bp -> b1 -> b2 -> base(root)
    // where `bp` has a SECOND child `sideTip`, making it a branch point (>= 2
    // children) and thus a region boundary. Region A = {a1,a2}, region B =
    // {b1,b2}. `bp` is adjacent to BOTH regions (a2's parent and b1's child),
    // but it is a boundary node, not a member of either — assert it maps to
    // exactly one anchor and folding it targets a real region.
    //
    // More directly for member-priority: `a2` is a MEMBER of region A. It is
    // also in-lane adjacent to `bp` which borders region B. Its own-region
    // mapping (region A's anchor) must win.
    const nodes: CommitNode[] = [
      mk("tipA", 8000, ["a1"]),
      mk("a1", 7000, ["a2"]),
      mk("a2", 6000, ["bp"]),
      mk("bp", 5000, ["b1"]),
      mk("sideTip", 4500, ["bp"]),
      mk("b1", 4000, ["b2"]),
      mk("b2", 3000, ["base"]),
      mk("base", 2000, []),
    ];
    const edges: CommitEdge[] = [
      { source: "a1", target: "tipA" },
      { source: "a2", target: "a1" },
      { source: "bp", target: "a2" },
      { source: "b1", target: "bp" },
      { source: "bp", target: "sideTip" },
      { source: "b2", target: "b1" },
      { source: "base", target: "b2" },
    ];
    const refsByOid = new Map<string, RefLabel[]>();

    const { anchorFor } = foldableNodeIds(nodes, edges, refsByOid);
    const regionA = regionAround("a1", nodes, edges, refsByOid);
    const regionB = regionAround("b1", nodes, edges, refsByOid);
    expect(regionA).toEqual(["a1", "a2"]);
    expect(regionB).toEqual(["b1", "b2"]);

    // a2 is a MEMBER of region A → keeps region A's anchor, never region B's.
    expect(anchorFor.get("a2")).toBe(regionA![0]);
    expect(anchorFor.get("a2")).not.toBe(regionB![0]);
    // b1 is a MEMBER of region B → keeps region B's anchor.
    expect(anchorFor.get("b1")).toBe(regionB![0]);
  });
});

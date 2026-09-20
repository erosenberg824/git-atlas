import { describe, it, expect } from "vitest";
import {
  detectRuns,
  detectBranchRollups,
  applyCollapse,
  isCollapsedRunId,
  isBranchRollupId,
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
      ["c5", [{ name: "v1", oid: "c5", kind: "tag", is_head: false, tip_ts: 5000 }]],
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

import { describe, it, expect } from "vitest";
import { assignLanes } from "./CommitGraph";

// Edges are parent(source) -> child(target). order is newest-first.

describe("assignLanes", () => {
  it("keeps a linear trunk entirely in lane 0", () => {
    const order = ["c3", "c2", "c1"];
    const edges = [
      { source: "c2", target: "c3" },
      { source: "c1", target: "c2" },
    ];
    const fp = new Map([
      ["c3", "c2"],
      ["c2", "c1"],
    ]);
    const lanes = assignLanes(order, edges, "c3", fp);
    expect(lanes.get("c1")).toBe(0);
    expect(lanes.get("c2")).toBe(0);
    expect(lanes.get("c3")).toBe(0);
  });

  it("puts a merge side-branch in its own lane, not stacked on the trunk", () => {
    // trunk: m2(c4) -> merge(c1)... build: merge commit M with two parents A(trunk) and B(feature)
    // order newest-first: M, F, A, base
    // M parents = [A, F] (A first = trunk continues)
    const order = ["M", "F", "A", "base"];
    const edges = [
      { source: "A", target: "M" }, // first parent (trunk)
      { source: "F", target: "M" }, // second parent (feature)
      { source: "base", target: "A" },
      { source: "base", target: "F" },
    ];
    const fp = new Map([
      ["M", "A"],
      ["A", "base"],
      ["F", "base"],
    ]);
    const lanes = assignLanes(order, edges, "M", fp);
    // Trunk M, A, base in lane 0; feature F in a separate lane (>0).
    expect(lanes.get("M")).toBe(0);
    expect(lanes.get("A")).toBe(0);
    expect(lanes.get("base")).toBe(0);
    expect(lanes.get("F")).toBeGreaterThan(0);
  });

  it("packs lanes tightly: merged branches don't fan out unboundedly", () => {
    // Two sequential feature merges back into trunk. Width should stay small
    // (bounded by concurrent branches), NOT grow one lane per branch.
    // order newest-first: M2, F2, M1, F1, base
    const order = ["M2", "F2", "M1", "F1", "base"];
    const edges = [
      { source: "M1", target: "M2" }, // trunk M1 -> M2 (first parent)
      { source: "F2", target: "M2" }, // feature2 -> M2
      { source: "base", target: "M1" },
      { source: "F1", target: "M1" }, // feature1 -> M1
      { source: "base", target: "F2" },
      { source: "base", target: "F1" },
    ];
    const fp = new Map([
      ["M2", "M1"],
      ["M1", "base"],
      ["F2", "base"],
      ["F1", "base"],
    ]);
    const lanes = assignLanes(order, edges, "M2", fp);
    const maxLane = Math.max(...[...lanes.values()]);
    // Trunk stays in lane 0; features occupy side lanes but stay bounded (<= 2),
    // i.e. they don't fan out to a new lane per branch.
    expect(lanes.get("M2")).toBe(0);
    expect(lanes.get("M1")).toBe(0);
    expect(lanes.get("base")).toBe(0);
    expect(maxLane).toBeLessThanOrEqual(2);
  });
});

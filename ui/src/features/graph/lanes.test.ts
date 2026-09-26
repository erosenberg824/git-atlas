import { describe, it, expect } from "vitest";
import { assignLanes } from "./CommitGraph";

// Edges are parent(source) -> child(target). order is newest-first.
// `assignLanes(order, edges, trunkTip, firstParentOf)`: trunkTip is a single id
// (or null) pinned to lane 0; everything else is pure leaf-seeding with P1
// continuation.

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
    // order newest-first: M, F, A, base; M parents = [A(trunk), F(feature)]
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
    expect(lanes.get("M")).toBe(0);
    expect(lanes.get("A")).toBe(0);
    expect(lanes.get("base")).toBe(0);
    expect(lanes.get("F")).toBeGreaterThan(0);
  });

  it("a merge lands in its P1's lane (first-parent continuation)", () => {
    // A feature-side merge: order F-tip, merge, feat, base. The merge's P1 is
    // the feature commit (feat), P2 is trunk. With NO trunk pin, the merge and
    // its feature-side P1 share one lane; trunk is a separate run.
    //   ftip -> merge; merge parents = [feat(P1), trunkTip(P2)]
    const order = ["ftip", "merge", "trunkTip", "feat", "base"];
    const edges = [
      { source: "merge", target: "ftip" },
      { source: "feat", target: "merge" }, // P1 (feature)
      { source: "trunkTip", target: "merge" }, // P2 (trunk)
      { source: "base", target: "feat" },
      { source: "base", target: "trunkTip" },
    ];
    const fp = new Map([
      ["ftip", "merge"],
      ["merge", "feat"], // P1
      ["feat", "base"],
      ["trunkTip", "base"],
    ]);
    const lanes = assignLanes(order, edges, "trunkTip", fp);
    // Trunk pinned to lane 0.
    expect(lanes.get("trunkTip")).toBe(0);
    // The merge sits in the SAME lane as its P1 (feat), and NOT lane 0.
    expect(lanes.get("merge")).toBe(lanes.get("feat"));
    expect(lanes.get("merge")).not.toBe(0);
  });

  it("packs lanes tightly: merged branches don't fan out unboundedly", () => {
    const order = ["M2", "F2", "M1", "F1", "base"];
    const edges = [
      { source: "M1", target: "M2" },
      { source: "F2", target: "M2" },
      { source: "base", target: "M1" },
      { source: "F1", target: "M1" },
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
    expect(lanes.get("M2")).toBe(0);
    expect(lanes.get("M1")).toBe(0);
    expect(lanes.get("base")).toBe(0);
    expect(maxLane).toBeLessThanOrEqual(2);
  });

  it("reuses a freed lane after two runs converge (transit-map reuse)", () => {
    const order = ["M2", "G", "M1", "F", "base"];
    const edges = [
      { source: "M1", target: "M2" },
      { source: "G", target: "M2" },
      { source: "base", target: "M1" },
      { source: "F", target: "M1" },
      { source: "base", target: "G" },
      { source: "base", target: "F" },
    ];
    const fp = new Map([
      ["M2", "M1"],
      ["M1", "base"],
      ["G", "base"],
      ["F", "base"],
    ]);
    const lanes = assignLanes(order, edges, "M2", fp);
    expect(lanes.get("M2")).toBe(0);
    expect(lanes.get("M1")).toBe(0);
    expect(lanes.get("base")).toBe(0);
    expect(Math.max(...[...lanes.values()])).toBe(1);
    expect(lanes.get("F")).toBe(1);
    expect(lanes.get("G")).toBe(1);
  });

  it("gives a ref-less leaf its own lane (topology, not refs, seeds lanes)", () => {
    // No trunk pin (null): two independent leaves off a shared base.
    const order = ["A", "B", "base"];
    const edges = [
      { source: "base", target: "A" },
      { source: "base", target: "B" },
    ];
    const fp = new Map([
      ["A", "base"],
      ["B", "base"],
    ]);
    const lanes = assignLanes(order, edges, null, fp);
    expect(lanes.get("A")).toBe(0);
    expect(lanes.get("B")).toBe(1);
    expect(lanes.get("base")).toBe(0);
  });

  it("lets the caller pick ANY tip for lane 0 (not just the newest)", () => {
    // Two independent branches A (newest) and B. Pinning B to lane 0 must put B
    // in lane 0 and push A to a side lane, even though A is first in order.
    const order = ["A", "B", "base"];
    const edges = [
      { source: "base", target: "A" },
      { source: "base", target: "B" },
    ];
    const fp = new Map([
      ["A", "base"],
      ["B", "base"],
    ]);
    const lanes = assignLanes(order, edges, "B", fp);
    expect(lanes.get("B")).toBe(0);
    expect(lanes.get("A")).toBeGreaterThan(0);
    expect(lanes.get("base")).toBe(0); // trunk run continues in lane 0
  });

  it("keeps a feature-side merge OFF lane 0 whether its branch is expanded or folded", () => {
    // Models the real fbea557 case: `main` (trunk) has its own first-parent
    // spine; a feature branch `falpha` has a merge `M` (P1 = feature side, P2 =
    // main side `pm`) and a tip `ftip` above it. The merge must sit in the
    // feature lane (with its P1), NOT lane 0, and that must NOT change when the
    // feature tip above the merge is folded away (collapsed view).
    //
    //   trunk spine:  mainTip -> m1 -> pm -> base   (all first-parent)
    //   feature:      ftip -> M ; M parents [fside(P1), pm(P2)] ; fside -> base
    const fp = new Map([
      ["mainTip", "m1"],
      ["m1", "pm"],
      ["pm", "base"],
      ["ftip", "M"],
      ["M", "fside"], // P1 = feature side
      ["fside", "base"],
    ]);
    const edges = [
      { source: "m1", target: "mainTip" },
      { source: "pm", target: "m1" },
      { source: "base", target: "pm" },
      { source: "M", target: "ftip" },
      { source: "fside", target: "M" }, // P1 (feature)
      { source: "pm", target: "M" }, // P2 (main)
      { source: "base", target: "fside" },
    ];

    // Expanded: ftip present above the merge.
    const expandedOrder = ["mainTip", "ftip", "m1", "M", "pm", "fside", "base"];
    const expanded = assignLanes(expandedOrder, edges, "mainTip", fp);
    expect(expanded.get("mainTip")).toBe(0);
    expect(expanded.get("m1")).toBe(0);
    expect(expanded.get("pm")).toBe(0);
    expect(expanded.get("base")).toBe(0);
    expect(expanded.get("M")).not.toBe(0);
    expect(expanded.get("M")).toBe(expanded.get("fside"));

    // Collapsed: the feature tip above the merge is folded away, so `ftip` and
    // its edge to M are gone and the merge M is now the top of the feature run.
    const collapsedOrder = ["mainTip", "m1", "M", "pm", "fside", "base"];
    const collapsedEdges = edges.filter(
      (e) => e.source !== "M" || e.target !== "ftip",
    );
    const collapsed = assignLanes(collapsedOrder, collapsedEdges, "mainTip", fp);
    expect(collapsed.get("mainTip")).toBe(0);
    expect(collapsed.get("pm")).toBe(0);
    expect(collapsed.get("base")).toBe(0);
    // The merge is STILL off lane 0 and STILL shares its P1's lane — no flip.
    expect(collapsed.get("M")).not.toBe(0);
    expect(collapsed.get("M")).toBe(collapsed.get("fside"));
    // And its lane matches the expanded view.
    expect(collapsed.get("M")).toBe(expanded.get("M"));
  });
});

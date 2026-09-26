import { describe, it, expect } from "vitest";
import {
  estimateNodeHeight,
  estimateBadgeRows,
  computeRowTops,
  assignRows,
  ROW_GAP,
} from "./nodeLayout";

describe("estimateBadgeRows", () => {
  it("is 0 with no badges", () => {
    expect(estimateBadgeRows([])).toBe(0);
  });

  it("is 1 for a single short badge", () => {
    expect(estimateBadgeRows(["main"])).toBe(1);
  });

  it("wraps to multiple rows when many badges exceed the width", () => {
    const many = Array.from({ length: 12 }, (_, i) => `branch-name-${i}`);
    expect(estimateBadgeRows(many)).toBeGreaterThan(1);
  });

  it("packs more badges per row on a wider card", () => {
    const labels = Array.from({ length: 6 }, (_, i) => `b${i}`);
    const narrow = estimateBadgeRows(labels, 80);
    const wide = estimateBadgeRows(labels, 400);
    expect(wide).toBeLessThanOrEqual(narrow);
  });
});

describe("estimateNodeHeight", () => {
  it("a bare commit is the base height", () => {
    const bare = estimateNodeHeight({ kind: "commit" });
    expect(bare).toBeGreaterThan(0);
    // Adding ref badges makes it taller.
    const withRefs = estimateNodeHeight({ kind: "commit", refLabels: ["main"] });
    expect(withRefs).toBeGreaterThan(bare);
  });

  it("a stash badge adds height to a commit", () => {
    const bare = estimateNodeHeight({ kind: "commit" });
    const withStash = estimateNodeHeight({ kind: "commit", hasStash: true });
    expect(withStash).toBeGreaterThan(bare);
  });

  it("merge affordances add height per affordance", () => {
    const none = estimateNodeHeight({ kind: "merge" });
    const one = estimateNodeHeight({ kind: "merge", affordanceCount: 1 });
    const three = estimateNodeHeight({ kind: "merge", affordanceCount: 3 });
    expect(one).toBeGreaterThan(none);
    expect(three).toBeGreaterThan(one);
  });

  it("run node grows with folded refs", () => {
    const none = estimateNodeHeight({ kind: "run" });
    const some = estimateNodeHeight({
      kind: "run",
      foldedRefLabels: ["feature-a", "feature-b"],
    });
    expect(some).toBeGreaterThan(none);
  });

  it("many wrapping ref badges make a much taller card", () => {
    const short = estimateNodeHeight({ kind: "commit", refLabels: ["main"] });
    const tall = estimateNodeHeight({
      kind: "commit",
      refLabels: Array.from({ length: 10 }, (_, i) => `release/v${i}.0.0`),
    });
    expect(tall).toBeGreaterThan(short);
  });
});

describe("computeRowTops", () => {
  it("first row starts at the base", () => {
    const tops = computeRowTops([100, 120, 90], 24);
    expect(tops[0]).toBe(24);
  });

  it("each row is separated from the previous by height + gap", () => {
    const heights = [100, 120, 90];
    const base = 24;
    const tops = computeRowTops(heights, base);
    expect(tops[1]).toBe(base + heights[0] + ROW_GAP);
    expect(tops[2]).toBe(tops[1] + heights[1] + ROW_GAP);
  });

  it("guarantees no overlap: each row's top clears the previous card's bottom", () => {
    const heights = [200, 80, 300, 72];
    const tops = computeRowTops(heights, 0);
    for (let i = 1; i < heights.length; i++) {
      const prevBottom = tops[i - 1] + heights[i - 1];
      // Next row starts strictly below the previous card's bottom edge.
      expect(tops[i]).toBeGreaterThanOrEqual(prevBottom);
      // ...with exactly the constant gap (uniform spacing).
      expect(tops[i] - prevBottom).toBe(ROW_GAP);
    }
  });

  it("uses a custom gap when provided", () => {
    const tops = computeRowTops([100, 100], 0, 10);
    expect(tops[1]).toBe(110);
  });

  it("returns an empty array for no rows", () => {
    expect(computeRowTops([], 24)).toEqual([]);
  });
});

describe("assignRows", () => {
  // Edges are parent(source) -> child(target). order is newest-first.

  it("stacks a linear chain one row per commit", () => {
    const order = ["c3", "c2", "c1"];
    const edges = [
      { source: "c2", target: "c3" },
      { source: "c1", target: "c2" },
    ];
    const rows = assignRows(order, edges);
    expect(rows.get("c3")).toBe(0);
    expect(rows.get("c2")).toBe(1);
    expect(rows.get("c1")).toBe(2);
  });

  it("makes a parent hug its lowest child (one row below), ignoring unrelated side-lane depth", () => {
    // Trunk: tip -> base (lane 0). A side branch off `base` has a TALL stack of
    // its own commits (s1..s3) that merge back at `tip` via a second parent.
    // The old flat-index model put `base` many rows below `tip` because s1..s3
    // sat between them in the order. Topology rows must keep `base` right under
    // whichever of its children is lowest — NOT pushed down by the side stack.
    //   order newest-first: tip, s3, s2, s1, base
    //   tip parents = [base(first), s3];  s3->s2->s1->base
    const order = ["tip", "s3", "s2", "s1", "base"];
    const edges = [
      { source: "base", target: "tip" }, // trunk first-parent edge
      { source: "s3", target: "tip" }, // merged-in second parent
      { source: "s2", target: "s3" },
      { source: "s1", target: "s2" },
      { source: "base", target: "s1" },
    ];
    const rows = assignRows(order, edges);
    expect(rows.get("tip")).toBe(0);
    // Side stack descends from tip: s3=1, s2=2, s1=3.
    expect(rows.get("s3")).toBe(1);
    expect(rows.get("s2")).toBe(2);
    expect(rows.get("s1")).toBe(3);
    // `base` is the parent of BOTH tip (row 0) and s1 (row 3); it hugs its
    // LOWEST child s1 → row 4. (It is NOT at row 1 just because tip is row 0 —
    // it must clear the whole side stack it also parents — and that is correct,
    // because base genuinely sits below s1 which descends from it.)
    expect(rows.get("base")).toBe(4);
  });

  it("does not push a trunk commit down for an unrelated concurrent branch", () => {
    // Two INDEPENDENT branches sharing only `base`. The side branch (b2,b1) has
    // no edge into the trunk tip, so trunk `t1` must NOT be pushed down by it.
    //   order: t1, b2, b1, base
    //   t1 -> base (trunk);  b2 -> b1 -> base (side)
    const order = ["t1", "b2", "b1", "base"];
    const edges = [
      { source: "base", target: "t1" },
      { source: "b1", target: "b2" },
      { source: "base", target: "b1" },
    ];
    const rows = assignRows(order, edges);
    expect(rows.get("t1")).toBe(0); // trunk tip
    expect(rows.get("b2")).toBe(0); // independent branch tip, same depth
    expect(rows.get("b1")).toBe(1);
    // base parents t1 (row 0) and b1 (row 1) → hugs lowest child → row 2.
    expect(rows.get("base")).toBe(2);
  });

  it("assigns every leaf (childless node) to row 0", () => {
    const order = ["a", "b", "c"]; // three disconnected leaves
    const rows = assignRows(order, []);
    expect(rows.get("a")).toBe(0);
    expect(rows.get("b")).toBe(0);
    expect(rows.get("c")).toBe(0);
  });

  it("ignores edges to/from non-rendered ids", () => {
    const order = ["child", "parent"];
    const edges = [
      { source: "parent", target: "child" },
      { source: "offwindow", target: "parent" }, // parent's parent not rendered
      { source: "child", target: "gone" }, // child's child not rendered
    ];
    const rows = assignRows(order, edges);
    expect(rows.get("child")).toBe(0);
    expect(rows.get("parent")).toBe(1);
  });
});

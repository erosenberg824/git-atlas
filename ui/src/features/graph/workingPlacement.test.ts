import { describe, it, expect } from "vitest";
import { computeWorkingPlacement } from "./CommitGraph";

/**
 * Tests for `computeWorkingPlacement` — where the "Working tree" pseudo-node
 * sits relative to HEAD. Core invariant: the chosen (lane, row) cell never
 * coincides with any rendered node's (lane, row) cell.
 */

/** Build the (rowOf, laneOf) maps from a compact fixture. */
function grid(nodes: { oid: string; row: number; lane: number }[]) {
  const rowOf = new Map<string, number>();
  const laneOf = new Map<string, number>();
  for (const n of nodes) {
    rowOf.set(n.oid, n.row);
    laneOf.set(n.oid, n.lane);
  }
  return { rowOf, laneOf };
}

/** Assert the placement does not land on any rendered node's cell. */
function assertNoOverlap(
  placement: { lane: number; row: number } | null,
  nodes: { oid: string; row: number; lane: number }[],
) {
  expect(placement).not.toBeNull();
  const p = placement!;
  for (const n of nodes) {
    expect(`${p.lane},${p.row}`).not.toBe(`${n.lane},${n.row}`);
  }
}

describe("computeWorkingPlacement", () => {
  it("returns null when HEAD is not in the rendered window", () => {
    const { rowOf, laneOf } = grid([{ oid: "a", row: 0, lane: 0 }]);
    expect(computeWorkingPlacement("missing", rowOf, laneOf)).toBeNull();
    expect(computeWorkingPlacement(null, rowOf, laneOf)).toBeNull();
  });

  it("places straight above HEAD when HEAD is a leaf (topmost node)", () => {
    // HEAD at row 0, lane 0; nothing above it.
    const nodes = [
      { oid: "head", row: 0, lane: 0 },
      { oid: "p1", row: 1, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = computeWorkingPlacement("head", rowOf, laneOf)!;
    expect(p.lane).toBe(0);
    expect(p.row).toBe(-1);
    expect(p.offset).toBe(false);
    assertNoOverlap(p, nodes);
  });

  it("stays in HEAD's lane when the row above is empty (HEAD mid-history, no child in that lane)", () => {
    // HEAD at row 2, lane 0. Row 1 has a node only in lane 1 → lane 0 free.
    const nodes = [
      { oid: "x", row: 0, lane: 1 },
      { oid: "y", row: 1, lane: 1 },
      { oid: "head", row: 2, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = computeWorkingPlacement("head", rowOf, laneOf)!;
    expect(p.lane).toBe(0);
    expect(p.row).toBe(1);
    expect(p.offset).toBe(false);
    assertNoOverlap(p, nodes);
  });

  it("shifts RIGHT when HEAD's child occupies the cell directly above (HEAD not a leaf)", () => {
    // Mainline child continues in lane 0 directly above HEAD.
    const nodes = [
      { oid: "child", row: 1, lane: 0 },
      { oid: "head", row: 2, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = computeWorkingPlacement("head", rowOf, laneOf)!;
    expect(p.lane).toBe(1); // lane 0 taken by child → next free
    expect(p.row).toBe(1);
    expect(p.offset).toBe(true);
    assertNoOverlap(p, nodes);
  });

  it("keeps shifting right past multiple occupied lanes on the target row", () => {
    // Row above HEAD is packed in lanes 0,1,2 → node lands in lane 3.
    const nodes = [
      { oid: "c0", row: 1, lane: 0 },
      { oid: "c1", row: 1, lane: 1 },
      { oid: "c2", row: 1, lane: 2 },
      { oid: "head", row: 2, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = computeWorkingPlacement("head", rowOf, laneOf)!;
    expect(p.lane).toBe(3);
    expect(p.offset).toBe(true);
    assertNoOverlap(p, nodes);
  });

  it("only considers the target row, not other rows", () => {
    // Lane 0 is busy on rows 0 and 3 but FREE on the target row (row 1).
    const nodes = [
      { oid: "top", row: 0, lane: 0 },
      { oid: "other", row: 1, lane: 5 },
      { oid: "head", row: 2, lane: 0 },
      { oid: "below", row: 3, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = computeWorkingPlacement("head", rowOf, laneOf)!;
    expect(p.lane).toBe(0);
    expect(p.offset).toBe(false);
    assertNoOverlap(p, nodes);
  });

  it("respects HEAD not being in lane 0 (detached / branch tip)", () => {
    // HEAD in lane 2; its child sits above in lane 2 → shift to lane 3.
    const nodes = [
      { oid: "child", row: 0, lane: 2 },
      { oid: "head", row: 1, lane: 2 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = computeWorkingPlacement("head", rowOf, laneOf)!;
    expect(p.lane).toBe(3);
    expect(p.offset).toBe(true);
    assertNoOverlap(p, nodes);
  });

  it("never overlaps across randomized fixtures (property check)", () => {
    // Deterministic pseudo-random generator for reproducibility.
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 500; trial++) {
      const rows = 1 + Math.floor(rand() * 8);
      const maxLane = 1 + Math.floor(rand() * 5);
      const nodes: { oid: string; row: number; lane: number }[] = [];
      // One node per (row, lane) cell with ~50% probability, ensuring unique ids.
      for (let r = 0; r < rows; r++) {
        for (let l = 0; l <= maxLane; l++) {
          if (rand() < 0.5) nodes.push({ oid: `${r}_${l}`, row: r, lane: l });
        }
      }
      // Guarantee HEAD exists somewhere.
      const headRow = Math.floor(rand() * rows);
      const headLane = Math.floor(rand() * (maxLane + 1));
      // Remove any node already at HEAD's cell, then add HEAD.
      const filtered = nodes.filter(
        (n) => !(n.row === headRow && n.lane === headLane),
      );
      filtered.push({ oid: "HEAD", row: headRow, lane: headLane });

      const { rowOf, laneOf } = grid(filtered);
      const p = computeWorkingPlacement("HEAD", rowOf, laneOf);
      assertNoOverlap(p, filtered);
    }
  });
});

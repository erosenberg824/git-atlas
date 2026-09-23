import { describe, it, expect } from "vitest";
import { placeAboveBase, reservedCellsFrom } from "./CommitGraph";

/**
 * Tests for stash pseudo-node placement. Stashes anchor one row ABOVE their
 * base commit (like the working node above HEAD) in a collision-free lane,
 * sharing ONE reserved-cell set with the working node and each other so no two
 * pseudo-nodes ever land on the same cell — even when several stashes and the
 * working node are all based on HEAD.
 */

/** Build (rowOf, laneOf) maps from a compact fixture. */
function grid(nodes: { oid: string; row: number; lane: number }[]) {
  const rowOf = new Map<string, number>();
  const laneOf = new Map<string, number>();
  for (const n of nodes) {
    rowOf.set(n.oid, n.row);
    laneOf.set(n.oid, n.lane);
  }
  return { rowOf, laneOf };
}

describe("placeAboveBase", () => {
  it("returns null when the base is not in the rendered window", () => {
    const { rowOf, laneOf } = grid([{ oid: "a", row: 0, lane: 0 }]);
    expect(placeAboveBase("missing", rowOf, laneOf, new Set())).toBeNull();
    expect(placeAboveBase(null, rowOf, laneOf, new Set())).toBeNull();
  });

  it("anchors straight above the base when its lane is free on the row above", () => {
    const nodes = [
      { oid: "base", row: 2, lane: 0 },
      { oid: "p", row: 3, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = placeAboveBase("base", rowOf, laneOf, reservedCellsFrom(rowOf, laneOf))!;
    expect(p.lane).toBe(0);
    expect(p.row).toBe(1);
    expect(p.offset).toBe(false);
  });

  it("shifts right when the base's child occupies the cell directly above", () => {
    const nodes = [
      { oid: "child", row: 1, lane: 0 },
      { oid: "base", row: 2, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const p = placeAboveBase("base", rowOf, laneOf, reservedCellsFrom(rowOf, laneOf))!;
    expect(p.lane).toBe(1);
    expect(p.offset).toBe(true);
  });

  it("mutates the reserved set so later placements dodge earlier ones", () => {
    // Working node + two stashes all based on HEAD (a leaf at row 1, lane 0).
    // They must fan out into distinct lanes on the row above (row 0).
    const nodes = [{ oid: "head", row: 1, lane: 0 }];
    const { rowOf, laneOf } = grid(nodes);
    const reserved = reservedCellsFrom(rowOf, laneOf);

    const working = placeAboveBase("head", rowOf, laneOf, reserved)!;
    const stash0 = placeAboveBase("head", rowOf, laneOf, reserved)!;
    const stash1 = placeAboveBase("head", rowOf, laneOf, reserved)!;

    // Same target row, three distinct lanes.
    expect([working.row, stash0.row, stash1.row]).toEqual([0, 0, 0]);
    const lanes = [working.lane, stash0.lane, stash1.lane];
    expect(new Set(lanes).size).toBe(3);
    expect(lanes).toEqual([0, 1, 2]);
    // Only the first (base's own lane) is non-offset.
    expect(working.offset).toBe(false);
    expect(stash0.offset).toBe(true);
    expect(stash1.offset).toBe(true);
  });

  it("does not collide with real nodes already on the target row", () => {
    // HEAD at row 2 lane 0 is NOT a leaf: children fill lanes 0 and 1 on row 1.
    const nodes = [
      { oid: "c0", row: 1, lane: 0 },
      { oid: "c1", row: 1, lane: 1 },
      { oid: "head", row: 2, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const reserved = reservedCellsFrom(rowOf, laneOf);
    const working = placeAboveBase("head", rowOf, laneOf, reserved)!;
    const stash = placeAboveBase("head", rowOf, laneOf, reserved)!;
    expect(working.lane).toBe(2); // dodged c0/c1
    expect(stash.lane).toBe(3); // dodged c0/c1 AND the working node
    expect(working.offset).toBe(true);
    expect(stash.offset).toBe(true);
  });

  it("places stashes based on different commits each above their own base", () => {
    const nodes = [
      { oid: "head", row: 0, lane: 0 },
      { oid: "mid", row: 3, lane: 0 },
      { oid: "old", row: 4, lane: 0 },
    ];
    const { rowOf, laneOf } = grid(nodes);
    const reserved = reservedCellsFrom(rowOf, laneOf);
    const s0 = placeAboveBase("mid", rowOf, laneOf, reserved)!;
    const s1 = placeAboveBase("old", rowOf, laneOf, reserved)!;
    expect(s0.row).toBe(2); // above "mid" (row 3)
    expect(s1.row).toBe(3); // above "old" (row 4)
    expect(s0.lane).toBe(0);
    // "mid" occupies lane 0 on row 3, so the stash above "old" dodges to lane 1.
    expect(s1.lane).toBe(1);
    expect(s1.offset).toBe(true);
  });
});

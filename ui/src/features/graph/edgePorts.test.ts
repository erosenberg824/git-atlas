import { describe, it, expect } from "vitest";
import { pickEdgePorts, type Cell } from "./edgePorts";

/**
 * `pickEdgePorts` chooses edge ports from the two nodes' grid positions AND an
 * occupancy predicate:
 *   - SAME lane → straight vertical (top/bottom).
 *   - CROSS lane → each end leaves/enters VERTICALLY only when its own column is
 *     clear between the two rows; otherwise through the facing SIDE, so a line
 *     never runs behind a stacked card.
 * Without a predicate it falls back to "immediate neighbour ⇒ clear".
 */

const at = (lane: number, row: number): Cell => ({ lane, row });

/** Occupancy predicate from a list of occupied cells. */
const grid = (cells: [number, number][]) => {
  const set = new Set(cells.map(([l, r]) => `${l},${r}`));
  return (lane: number, row: number) => set.has(`${lane},${row}`);
};

describe("pickEdgePorts — same lane (straight vertical)", () => {
  it("target directly above → source top, target bottom", () => {
    expect(pickEdgePorts(at(0, 5), at(0, 4))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-bottom",
    });
  });

  it("target several rows above, same lane → still top/bottom", () => {
    expect(pickEdgePorts(at(0, 30), at(0, 0))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-bottom",
    });
  });

  it("target below the source, same lane → source bottom, target top", () => {
    expect(pickEdgePorts(at(2, 1), at(2, 9))).toEqual({
      sourceHandle: "s-bottom",
      targetHandle: "t-top",
    });
  });

  it("same cell → stable vertical default", () => {
    expect(pickEdgePorts(at(1, 1), at(1, 1))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-bottom",
    });
  });
});

describe("pickEdgePorts — cross lane with occupancy", () => {
  it("branch tip far below a merge, both columns blocked → both ends use facing sides", () => {
    // Branch tip (lane 4, row 28) → merge (lane 0, row 0). The merge's own
    // column (lane 0) is packed by the mainline below it, and the tip's column
    // (lane 4) has its own branch below — so BOTH ends route through the facing
    // side: source leaves its LEFT (target is to the left), target entered on
    // its RIGHT (source is to the right).
    const occ = grid([
      [0, 10], // mainline card under the merge, blocking lane 0
      [4, 20], // a branch card under the tip, blocking lane 4
    ]);
    expect(pickEdgePorts(at(4, 28), at(0, 0), occ)).toEqual({
      sourceHandle: "s-left",
      targetHandle: "t-right",
    });
  });

  it("source column clear → source leaves vertically and climbs its lane", () => {
    // Nothing between the tip and the top in the tip's own lane (4), so it can
    // climb: source leaves the TOP. The target's column (0) is blocked, so the
    // target is entered on its RIGHT (facing the source).
    const occ = grid([[0, 5]]); // only the target column is blocked
    expect(pickEdgePorts(at(4, 28), at(0, 0), occ)).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-right",
    });
  });

  it("target column clear → target entered vertically at its bottom", () => {
    // Fork (lane 0) to a branch's first commit (lane 4) one row up. The branch's
    // column above the fork is empty, so the target is entered at its BOTTOM
    // ("grows up out of the fork"). The source's column is also clear between
    // the two rows (the [0,31] card is BELOW the fork, outside the span), so the
    // source leaves through its TOP.
    const occ = grid([[0, 31]]); // a card below the fork in lane 0
    expect(pickEdgePorts(at(0, 30), at(4, 29), occ)).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-bottom",
    });
  });

  it("source column blocked → source leaves through the facing side", () => {
    // A card sits in the SOURCE's column (lane 0) BETWEEN the two rows, so the
    // source can't climb vertically — it leaves through the facing (right) side
    // toward the target. The target column (4) is clear → entered vertically.
    const occ = grid([[0, 10]]);
    expect(pickEdgePorts(at(0, 30), at(4, 0), occ)).toEqual({
      sourceHandle: "s-right",
      targetHandle: "t-bottom",
    });
  });

  it("both columns clear → straight vertical exits on both ends", () => {
    // No occupied cells at all → both columns clear → both ends vertical.
    const occ = grid([]);
    expect(pickEdgePorts(at(0, 30), at(4, 0), occ)).toEqual({
      sourceHandle: "s-top", // target above → climb out the top
      targetHandle: "t-bottom", // source below → enter target's bottom
    });
  });
});

describe("pickEdgePorts — fallback (no occupancy predicate)", () => {
  it("diagonally adjacent is treated as clear (both ends vertical)", () => {
    // dRow = 29-30 = -1 (target above). Fallback treats a one-row gap as clear,
    // so both ends are vertical: source out the top, target in the bottom.
    expect(pickEdgePorts(at(0, 30), at(4, 29))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-bottom",
    });
  });

  it("far apart cross-lane falls back to facing sides on both ends", () => {
    // dRow = -20 (far). Fallback: neither column clear → both ends use the
    // facing side. Target to the RIGHT → source leaves right, target entered left.
    expect(pickEdgePorts(at(1, 20), at(5, 0))).toEqual({
      sourceHandle: "s-right",
      targetHandle: "t-left",
    });
  });
});

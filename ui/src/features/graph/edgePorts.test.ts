import { describe, it, expect } from "vitest";
import { pickEdgePorts, type Cell } from "./edgePorts";

/**
 * `pickEdgePorts` chooses bezier-edge ports with the two ends decided
 * independently:
 *   - TARGET: vertical port when SAME lane, else the facing SIDE (so a
 *     cross-lane edge clears the target's stacked mainline neighbour).
 *   - SOURCE: dominant axis of the vector (ties → vertical).
 * These tests pin the rule and the concrete graph cases it drives.
 */

const at = (lane: number, row: number): Cell => ({ lane, row });

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

describe("pickEdgePorts — cross lane: target enters the facing side", () => {
  it("branch tip far below-left of a merge → source climbs (top), target side", () => {
    // 3de7379 (lane 4, row 28) → merge 0e571bb (lane 0, row 0). Vertical
    // dominates for the SOURCE (|dRow|=28 > |dLane|=4) so it leaves the TOP and
    // climbs its own lane; the TARGET is cross-lane so the edge enters the
    // merge's RIGHT side (source is to the right), clearing the mainline commit
    // stacked directly under the merge.
    expect(pickEdgePorts(at(4, 28), at(0, 0))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-right",
    });
  });

  it("fork to a first branch commit one row up several lanes over → side/bottom", () => {
    // 9f89d2e (lane 0, row 30) → 6c18fa6 (lane 4, row 29). Diagonally adjacent
    // (one row up), so the branch's first commit is entered at its BOTTOM (grows
    // up out of the fork — the bottom of the loop). Source: horizontal dominates
    // (|dLane|=4 > |dRow|=1) → leaves the RIGHT toward the branch.
    expect(pickEdgePorts(at(0, 30), at(4, 29))).toEqual({
      sourceHandle: "s-right",
      targetHandle: "t-bottom",
    });
  });

  it("diagonally-adjacent target to the LEFT → enters its bottom too", () => {
    expect(pickEdgePorts(at(4, 10), at(1, 9))).toEqual({
      sourceHandle: "s-left",
      targetHandle: "t-bottom",
    });
  });

  it("target to the LEFT and far above → source top, target right", () => {
    expect(pickEdgePorts(at(5, 20), at(1, 0))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-right",
    });
  });

  it("target to the RIGHT and far above → source top, target left", () => {
    expect(pickEdgePorts(at(1, 20), at(5, 0))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-left",
    });
  });
});

describe("pickEdgePorts — symmetry of the side choice", () => {
  it("mirrors target side when the lane delta flips sign (far above)", () => {
    // Far above (vert > 1) so the target uses a SIDE; source climbs (vertical
    // dominant) out its top.
    expect(pickEdgePorts(at(1, 20), at(5, 0))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-left",
    });
    expect(pickEdgePorts(at(5, 20), at(1, 0))).toEqual({
      sourceHandle: "s-top",
      targetHandle: "t-right",
    });
  });
});

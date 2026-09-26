/**
 * Dynamic edge-port routing for the commit graph.
 *
 * Edges are drawn as bezier CURVES (React Flow "default" edges). The curve looks
 * best when it leaves the source and enters the target through ports that don't
 * force the line across a neighbouring card. We pick those ports purely from the
 * two nodes' relative grid positions (lane = column, row = vertical index).
 *
 * Coordinates: `lane` increases to the RIGHT, `row` increases DOWNWARD (row 0 is
 * the topmost/newest commit). A node with a smaller row sits ABOVE one with a
 * larger row. Graph edges run parent(source, lower) → child(target, higher), so
 * the target is normally ABOVE the source (dRow < 0), but the rule is symmetric.
 *
 * The two ends are chosen INDEPENDENTLY:
 *
 * The intent: a merged branch should read as a LOOP off the mainline — it bulges
 * out to its own lane and curves back in, while the mainline stays a straight
 * vertical spine. The bottom of the loop (fork → branch's first commit) grows UP
 * out of the fork into the branch commit's BOTTOM; the top of the loop (branch
 * tip → merge) curves back into the merge node's SIDE. Between, the branch runs
 * straight down its own lane.
 *
 *   • TARGET port — keyed on lane crossing AND vertical proximity:
 *       – SAME lane → the parent is directly below/above on the same column, so
 *         enter through the VERTICAL port facing it (bottom if the source is
 *         below, top if above). Keeps the straight mainline docking into bottom.
 *       – DIFFERENT lane, but the source is DIAGONALLY ADJACENT (one row away)
 *         → enter through the VERTICAL port facing the source. This is a branch's
 *         first commit sitting one row above its fork point in another lane: it
 *         "grows up out of" the fork, so the link enters its BOTTOM (the bottom
 *         of the loop). Its own column directly below is empty (the branch
 *         starts here), so nothing is in the way.
 *       – DIFFERENT lane and MORE than one row away → the target's own column
 *         directly below/above it is (almost always) occupied by its
 *         first-parent/mainline neighbour, so a vertical entry would run BEHIND
 *         that stacked card. Enter through the SIDE facing the source instead
 *         (the top of the loop curving back in). This is why a branch tip
 *         merging in from another lane, far below the merge, docks into the
 *         merge node's SIDE rather than crossing the mainline commit sitting
 *         just under the merge.
 *
 *   • SOURCE port — dominant axis of the vector (ties → vertical, since history
 *     reads top-to-bottom):
 *       – VERTICAL dominant (|dRow| >= |dLane|) → leave through TOP/BOTTOM, so a
 *         branch climbs its own lane before curving across (rather than shooting
 *         sideways immediately).
 *       – HORIZONTAL dominant (|dLane| > |dRow|) → leave through the facing SIDE,
 *         so a fork that is nearly level with its child steps straight out.
 */

/** A node's grid position: lane (column, →) and row (vertical index, ↓). */
export interface Cell {
  lane: number;
  row: number;
}

/** React Flow handle ids defined on the commit/merge/special nodes. */
export type SourceHandle = "s-top" | "s-bottom" | "s-left" | "s-right";
export type TargetHandle = "t-top" | "t-bottom" | "t-left" | "t-right";

export interface EdgePorts {
  sourceHandle: SourceHandle;
  targetHandle: TargetHandle;
}

/**
 * Pick the source + target ports for an edge from `source` to `target`, from
 * their relative grid positions. Target: vertical when same-lane or when the
 * facing vertical port is unobstructed; else the facing side. Source: leaves
 * vertically when it can climb its own column, else the facing side.
 *
 * `isOccupied(lane, row)` — when supplied — reports whether a NODE sits in a
 * given cell. It makes routing occupancy-driven instead of guessing from row
 * distance (which was unreliable once rows became topology-derived rather than a
 * dense per-node index): a vertical entry/exit is only chosen when the cells
 * between the two endpoints in that column are actually empty, so a line never
 * runs behind a stacked card. With no predicate it falls back to the previous
 * distance heuristic (diagonally-adjacent ⇒ vertical).
 */
export function pickEdgePorts(
  source: Cell,
  target: Cell,
  isOccupied?: (lane: number, row: number) => boolean,
): EdgePorts {
  const dLane = target.lane - source.lane; // >0: target is to the RIGHT
  const dRow = target.row - source.row; // <0: target is ABOVE (smaller row)

  // Same lane → straight vertical at both ends. Nothing sits between two nodes
  // stacked in one column, so use the facing top/bottom ports.
  if (dLane === 0) {
    return dRow <= 0
      ? { sourceHandle: "s-top", targetHandle: "t-bottom" } // target above
      : { sourceHandle: "s-bottom", targetHandle: "t-top" }; // target below
  }

  // Is the TARGET's own column clear between the target and the source's row?
  // If so the edge can enter the target vertically (from the side the source is
  // on) without crossing a card stacked under/over the target; otherwise it must
  // enter through the target's SIDE. Same question for the SOURCE's column.
  const columnClear = (lane: number, fromRowExclusive: number, toRowExclusive: number) => {
    if (!isOccupied) {
      // Fallback: treat only immediate neighbours as clear (old heuristic).
      return Math.abs(toRowExclusive - fromRowExclusive) <= 1;
    }
    const lo = Math.min(fromRowExclusive, toRowExclusive);
    const hi = Math.max(fromRowExclusive, toRowExclusive);
    for (let r = lo + 1; r < hi; r++) {
      if (isOccupied(lane, r)) return false;
    }
    return true;
  };

  // TARGET port: enter vertically (facing the source) when the target's column
  // is clear between them; else enter through the facing side.
  const targetColumnClear = columnClear(target.lane, target.row, source.row);
  const targetHandle: TargetHandle = targetColumnClear
    ? dRow <= 0
      ? "t-bottom" // source below the target → enter target's bottom
      : "t-top"
    : dLane > 0
      ? "t-left" // source is to the LEFT → enter target's left side
      : "t-right";

  // SOURCE port: leave vertically (climbing its own column toward the target)
  // when the source's column is clear between them; else leave through the
  // facing side.
  const sourceColumnClear = columnClear(source.lane, source.row, target.row);
  const sourceHandle: SourceHandle = sourceColumnClear
    ? dRow <= 0
      ? "s-top" // target above → leave through the top
      : "s-bottom"
    : dLane > 0
      ? "s-right" // target is to the RIGHT → leave through the right side
      : "s-left";

  return { sourceHandle, targetHandle };
}

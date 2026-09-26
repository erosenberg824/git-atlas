/**
 * Vertical layout math for the commit graph.
 *
 * The graph places one row per rendered item (commit / merge / run / special),
 * newest at the top. Node CARDS are variable-height — a commit with several
 * wrapping ref badges, a merge with hidden-branch affordances, or a run node
 * with folded-ref badges is much taller than a bare commit. A single fixed
 * ROW_HEIGHT (the old model) therefore let tall cards overflow into and overlap
 * the row below.
 *
 * This module makes row placement height-aware while keeping the GAP between
 * consecutive rows constant, so parent→child→grandchild spacing reads evenly no
 * matter how tall individual cards are:
 *
 *   - `estimateNodeHeight` gives a deterministic, DOM-free height estimate for a
 *     node from its data (badge/affordance counts), matching the card layout in
 *     the *NodeComponent files.
 *   - `computeRowTops` turns a per-row height (the MAX height of any node in that
 *     row — rows can hold several lanes) into the absolute Y (top) of each row:
 *     `top[i+1] = top[i] + height[i] + gap`. The gap is constant, so the visual
 *     space between every parent and child is identical.
 *
 * Both are pure and unit-tested (see `nodeLayout.test.ts`); the React component
 * only supplies the per-node data and consumes the resulting tops.
 */

/** Vertical gap (px) between the bottom of one row's tallest card and the top of
 *  the next row's card. Constant for every row so spacing is uniform. */
export const ROW_GAP = 40;

/** Height (px) contributions of the fixed parts of a commit/merge card:
 *  vertical padding (py-2 = 8px top + 8px bottom) + hash/date line + summary
 *  line + author line, at the node's ~12px font. Empirically ~72px. */
const COMMIT_BASE_HEIGHT = 72;
/** A single wrapping row of ref/affordance/stash badges (~20px incl. gap). */
const BADGE_ROW_HEIGHT = 22;
/** Run (collapsed) card base: header label + range line + "click to expand". */
const RUN_BASE_HEIGHT = 76;
/** Special (working/stash) pseudo-node card base height. */
const SPECIAL_BASE_HEIGHT = 64;
/** Approx card width (px) available for wrapping badges — matches max-w-[200px]
 *  minus horizontal padding. Used to estimate how many badge rows will wrap. */
const BADGE_WRAP_WIDTH = 176;
/** Rough per-character width (px) of a badge label at text-[10px] font-mono,
 *  plus the badge's own horizontal padding/gap. */
const BADGE_CHAR_WIDTH = 6.5;
const BADGE_PADDING = 14;

/** A minimal description of a rendered node for height estimation. */
export interface NodeHeightInput {
  kind: "commit" | "merge" | "run" | "special";
  /** Ref-badge labels shown on the card (branch/tag/HEAD names). */
  refLabels?: string[];
  /** Number of merge hidden-branch affordance rows (merge nodes). */
  affordanceCount?: number;
  /** Whether the card shows a stash badge (commit nodes). */
  hasStash?: boolean;
  /** Folded-ref badge labels shown on a run/merge card. */
  foldedRefLabels?: string[];
}

/**
 * Estimate how many rows a set of wrapping badges occupies given the card's
 * usable width. Badges wrap left-to-right; a badge that doesn't fit on the
 * current line starts a new one. Always ≥ 1 row when there is at least one
 * badge, 0 when there are none.
 */
export function estimateBadgeRows(labels: string[], width = BADGE_WRAP_WIDTH): number {
  if (labels.length === 0) return 0;
  let rows = 1;
  let used = 0;
  for (const label of labels) {
    const w = label.length * BADGE_CHAR_WIDTH + BADGE_PADDING;
    if (used > 0 && used + w > width) {
      rows += 1;
      used = w;
    } else {
      used += w;
    }
  }
  return rows;
}

/**
 * Deterministic, DOM-free height estimate (px) for a rendered node card. Mirrors
 * the structure of the *NodeComponent files: a fixed base plus a badge row for
 * each wrapping row of ref badges, each merge affordance, a stash badge, and any
 * folded-ref badges. Deliberately errs slightly HIGH (over-, not under-,
 * estimating) so cards never overlap even if a label is a touch wider than the
 * per-character approximation.
 */
export function estimateNodeHeight(input: NodeHeightInput): number {
  const refRows = estimateBadgeRows(input.refLabels ?? []);
  const foldedRows = estimateBadgeRows(input.foldedRefLabels ?? []);
  switch (input.kind) {
    case "run":
      return RUN_BASE_HEIGHT + foldedRows * BADGE_ROW_HEIGHT;
    case "special":
      return SPECIAL_BASE_HEIGHT;
    case "commit":
      return (
        COMMIT_BASE_HEIGHT +
        refRows * BADGE_ROW_HEIGHT +
        (input.hasStash ? BADGE_ROW_HEIGHT : 0)
      );
    case "merge":
      return (
        COMMIT_BASE_HEIGHT +
        refRows * BADGE_ROW_HEIGHT +
        (input.affordanceCount ?? 0) * BADGE_ROW_HEIGHT +
        // Folded-ref badges on a merge share the affordance rows, so count any
        // extra folded refs beyond what the affordance lines already cover.
        foldedRows * BADGE_ROW_HEIGHT
      );
  }
}

/**
 * Given the per-row heights (index = row, value = the MAX card height across all
 * lanes in that row) and a base Y, return the absolute TOP y-coordinate of every
 * row. Consecutive rows are separated by exactly `gap`, so:
 *   top[0] = yBase
 *   top[i] = top[i-1] + height[i-1] + gap
 * This guarantees the tallest card in a row can never reach the next row's card
 * (no overlap) while keeping the inter-row gap constant (uniform spacing).
 */
export function computeRowTops(
  rowHeights: number[],
  yBase: number,
  gap = ROW_GAP,
): number[] {
  const tops: number[] = [];
  let y = yBase;
  for (let i = 0; i < rowHeights.length; i++) {
    tops.push(y);
    y += rowHeights[i] + gap;
  }
  return tops;
}

/**
 * Assign each rendered node a ROW (vertical level) from the DAG topology, so a
 * parent sits DIRECTLY below its lowest child — one row down — regardless of how
 * many UNRELATED nodes in OTHER lanes exist between them in the flat order.
 *
 * Rule: `row(node) = max(row(child)) + 1` over the node's rendered children;
 * a node with no rendered child (a leaf / branch tip) is row 0. Nodes at the
 * same depth in different lanes share a row (they never collide — different
 * columns), which is exactly the compact "parent hugs child" layout.
 *
 * This replaces the old "row = position in the flat newest-first list" model,
 * which reserved a row for EVERY node — so a stack of side-lane (lane ≥ 1) nodes
 * pushed the next trunk (lane 0) commit far down, leaving large empty vertical
 * gaps in lane 0 opposite side-lane nodes it has no relationship with.
 *
 * `order` is the caller's newest-first topological order (children before
 * parents); processing in that order guarantees a child's row is known before
 * its parent's. `edges` are parent(source)→child(target) among rendered ids.
 * Returns a row index per rendered id; the max row + 1 is the row count.
 */
export function assignRows(
  order: string[],
  edges: { source: string; target: string }[],
): Map<string, number> {
  const rendered = new Set(order);
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!rendered.has(e.source) || !rendered.has(e.target)) continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(e.target);
  }

  const rowOf = new Map<string, number>();
  for (const id of order) {
    const kids = childrenOf.get(id) ?? [];
    let row = 0;
    for (const k of kids) {
      const kr = rowOf.get(k);
      // A child not yet placed (edge cycle / out-of-window) is ignored; the
      // caller's order places children first for a DAG so this is defensive.
      if (kr !== undefined && kr + 1 > row) row = kr + 1;
    }
    rowOf.set(id, row);
  }
  return rowOf;
}

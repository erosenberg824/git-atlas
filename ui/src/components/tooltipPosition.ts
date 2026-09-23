/**
 * Pure positioning math for `Tooltip.tsx`, extracted so it can be unit-tested
 * without a DOM. Given the trigger's rect, the measured tooltip size, the
 * viewport size, and the desired placement, it returns fixed-position
 * `{ left, top }` coordinates that:
 *  - horizontally center the tooltip on the trigger, then clamp it so it never
 *    crosses the viewport edge (kept `MARGIN` px inside);
 *  - place it on the requested side (`bottom`/`top`) offset by `OFFSET` px, and
 *    flip to the opposite side when the preferred side would overflow.
 *
 * The React component measures with `getBoundingClientRect()` / `window` and
 * feeds the numbers here; all the fiddly clamp/flip logic lives in this one
 * testable function.
 */

/** Gap in px between the trigger and the tooltip. */
export const OFFSET = 6;
/** Keep at least this many px between the tooltip and the viewport edge. */
export const MARGIN = 8;

/** A minimal rect — just the fields the math needs from `DOMRect`. */
export interface Rect {
  left: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type Placement = "top" | "bottom";

export interface Position {
  left: number;
  top: number;
}

/**
 * Compute the clamped, flip-aware fixed position for a tooltip.
 *
 * @param trigger   The trigger element's viewport rect.
 * @param tip       The measured tooltip size.
 * @param viewport  The viewport (typically `window.innerWidth/Height`).
 * @param placement Preferred side; flips if it would overflow that edge.
 */
export function computeTooltipPosition(
  trigger: Rect,
  tip: Size,
  viewport: Viewport,
  placement: Placement,
): Position {
  // Horizontally center on the trigger, then clamp to the viewport. When the
  // tooltip is wider than the space, the lower `MARGIN` bound wins (Math.max
  // last) so the left edge stays visible rather than the right.
  let left = trigger.left + trigger.width / 2 - tip.width / 2;
  left = Math.max(MARGIN, Math.min(left, viewport.width - tip.width - MARGIN));

  // Prefer the requested side; flip if it would overflow that edge.
  let top =
    placement === "bottom"
      ? trigger.bottom + OFFSET
      : trigger.top - tip.height - OFFSET;

  if (placement === "bottom" && top + tip.height > viewport.height - MARGIN) {
    top = trigger.top - tip.height - OFFSET;
  } else if (placement === "top" && top < MARGIN) {
    top = trigger.bottom + OFFSET;
  }

  return { left, top };
}

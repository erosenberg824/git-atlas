import { describe, it, expect } from "vitest";
import {
  computeTooltipPosition,
  OFFSET,
  MARGIN,
  type Rect,
} from "./tooltipPosition";

/** A 1000x800 viewport used by most cases. */
const VIEWPORT = { width: 1000, height: 800 };

/**
 * Build a trigger rect from left/top/width/height; `bottom` is derived so tests
 * read naturally. (`computeTooltipPosition` only reads left/top/bottom/width/height.)
 */
function trigger(
  left: number,
  top: number,
  width: number,
  height: number,
): Rect {
  return { left, top, width, height, bottom: top + height };
}

describe("computeTooltipPosition — horizontal centering + clamping", () => {
  it("centers the tooltip on the trigger when there is room on both sides", () => {
    // Trigger centered at x=500; a 100-wide tip should center at 450.
    const t = trigger(480, 100, 40, 20);
    const { left } = computeTooltipPosition(
      t,
      { width: 100, height: 30 },
      VIEWPORT,
      "bottom",
    );
    expect(left).toBe(500 - 100 / 2); // trigger center (500) minus half tip width
  });

  it("clamps to the left margin when the trigger is near the left edge", () => {
    // Trigger hugging the left edge; centering would push left negative.
    const t = trigger(0, 100, 20, 20);
    const { left } = computeTooltipPosition(
      t,
      { width: 200, height: 30 },
      VIEWPORT,
      "bottom",
    );
    expect(left).toBe(MARGIN);
  });

  it("clamps to the right margin when the trigger is near the right edge", () => {
    // Trigger hugging the right edge; centering would overflow the right side.
    const t = trigger(980, 100, 20, 20);
    const { left } = computeTooltipPosition(
      t,
      { width: 200, height: 30 },
      VIEWPORT,
      "bottom",
    );
    expect(left).toBe(VIEWPORT.width - 200 - MARGIN);
  });

  it("keeps the left edge visible when the tip is wider than the viewport", () => {
    // Tip wider than viewport: the left-margin lower bound must win so the
    // start of the content stays on-screen (right overflow is unavoidable).
    const t = trigger(400, 100, 40, 20);
    const { left } = computeTooltipPosition(
      t,
      { width: 2000, height: 30 },
      VIEWPORT,
      "bottom",
    );
    expect(left).toBe(MARGIN);
  });
});

describe("computeTooltipPosition — vertical placement + flip", () => {
  it("places below the trigger for bottom placement when it fits", () => {
    const t = trigger(480, 100, 40, 20); // bottom = 120
    const { top } = computeTooltipPosition(
      t,
      { width: 100, height: 30 },
      VIEWPORT,
      "bottom",
    );
    expect(top).toBe(120 + OFFSET);
  });

  it("places above the trigger for top placement when it fits", () => {
    const t = trigger(480, 400, 40, 20); // top = 400
    const { top } = computeTooltipPosition(
      t,
      { width: 100, height: 30 },
      VIEWPORT,
      "top",
    );
    expect(top).toBe(400 - 30 - OFFSET);
  });

  it("flips bottom→top when there is no room below", () => {
    // Trigger near the viewport bottom: below would overflow, so flip above.
    const t = trigger(480, 770, 40, 20); // bottom = 790, viewport height 800
    const { top } = computeTooltipPosition(
      t,
      { width: 100, height: 30 },
      VIEWPORT,
      "bottom",
    );
    // Flipped: sits above the trigger top (770) by tip height + offset.
    expect(top).toBe(770 - 30 - OFFSET);
  });

  it("flips top→bottom when there is no room above", () => {
    // Trigger near the viewport top: above would go off-screen, so flip below.
    const t = trigger(480, 5, 40, 20); // top = 5, bottom = 25
    const { top } = computeTooltipPosition(
      t,
      { width: 100, height: 30 },
      VIEWPORT,
      "top",
    );
    // Flipped: sits below the trigger bottom (25) by the offset.
    expect(top).toBe(25 + OFFSET);
  });

  it("does not flip bottom placement when it fits exactly within the margin", () => {
    // Boundary: tip bottom lands exactly at viewport.height - MARGIN → no flip.
    const tipH = 30;
    const bottomEdge = VIEWPORT.height - MARGIN; // 792
    const topWanted = bottomEdge - tipH; // where the tip top must be
    // top = trigger.bottom + OFFSET ⇒ trigger.bottom = topWanted - OFFSET
    const triggerBottom = topWanted - OFFSET;
    const t = trigger(480, triggerBottom - 20, 40, 20);
    const { top } = computeTooltipPosition(
      t,
      { width: 100, height: tipH },
      VIEWPORT,
      "bottom",
    );
    expect(top).toBe(triggerBottom + OFFSET);
  });
});

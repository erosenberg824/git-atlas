import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computeTooltipPosition, type Position } from "./tooltipPosition";

/**
 * Shared styled tooltip used across the app in place of the native `title`
 * attribute (which is slow to appear, unstyled, OS-dependent, and single-line).
 *
 * WHY A PORTAL: a tooltip rendered as a normal descendant gets clipped by any
 * ancestor with `overflow: hidden`/`auto`/`scroll` (React Flow nodes, scrollable
 * panels) — and `z-index` can't rescue it, because `overflow` clips geometry
 * before stacking is considered. So the popup is portaled to `document.body`
 * and positioned with `position: fixed` from the trigger's bounding rect. That
 * takes it out of every clipping ancestor and into a top-level stacking context.
 *
 * The trigger is wrapped in an inline-flex `<span>` that forwards mouse/focus so
 * the tooltip also appears on keyboard focus (the native `title` never does).
 * Content is two optional lines — a prominent `primary` and a muted `secondary`
 * (which may carry a trailing icon) — matching the branch panel's design.
 */

export interface TooltipProps {
  /** Prominent first line (e.g. a branch name). */
  primary: ReactNode;
  /** Optional muted second line (e.g. "click to expand"). */
  secondary?: ReactNode;
  /**
   * Render the primary line in a monospace font — for identifiers like branch
   * names, refs, and hashes. Prose hints leave this off. Default false.
   */
  mono?: boolean;
  /** Which side of the trigger to place the tooltip. Default "bottom". */
  placement?: "top" | "bottom";
  /** The element the tooltip describes. */
  children: ReactNode;
  /** Extra classes for the trigger wrapper (layout only). */
  className?: string;
}

export default function Tooltip({
  primary,
  secondary,
  mono = false,
  placement = "bottom",
  children,
  className,
}: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);

  // Measure after paint so we know the tooltip's real size, then clamp it into
  // the viewport (the pure math lives in `computeTooltipPosition`). Runs while
  // open and re-runs if content changes size.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;

    const t = trigger.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    setPos(
      computeTooltipPosition(
        t,
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
      ),
    );
  }, [open, placement, primary, secondary]);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    setOpen(false);
    setPos(null);
  }, []);

  return (
    <span
      ref={triggerRef}
      className={["inline-flex", className].filter(Boolean).join(" ")}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="pointer-events-none fixed z-50 flex max-w-xs flex-col gap-1 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-xs shadow-lg"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              // Hide until measured so it never flashes at the wrong spot.
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <span
              className={[
                "break-words text-[#e6edf3]",
                mono ? "font-mono" : "",
              ].join(" ")}
            >
              {primary}
            </span>
            {secondary != null && (
              <span className="flex items-center gap-1 text-[10px] text-[#8b949e]">
                {secondary}
              </span>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}

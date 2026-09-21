import { memo } from "react";
import type { RefLabel } from "../../api/client";
import type { FoldedRef } from "./collapse";

/**
 * The four ref "hues" a badge can take, matching CommitNodeComponent's ref
 * badges: green for the checked-out HEAD, yellow for a tag, orange for a
 * remote-tracking branch, blue for a plain local branch.
 */
type Hue = "green" | "yellow" | "orange" | "blue";

function hueFor(ref: RefLabel): Hue {
  if (ref.is_head) return "green";
  if (ref.kind === "tag") return "yellow";
  if (ref.kind === "remotebranch") return "orange";
  return "blue";
}

/**
 * SOLID badge classes for a HEAD-member (non-buried) ref — copied verbatim from
 * `CommitNodeComponent`'s ref-badge styling so a surfaced head ref looks exactly
 * like the ref badge on an un-folded commit. Static literal strings so Tailwind
 * v4's content scanner sees every class (no dynamic hue interpolation).
 */
const SOLID_BADGE_CLASSES: Record<Hue, string> = {
  green: "bg-green-900/60 text-green-300 border border-green-700/50",
  yellow: "bg-yellow-900/60 text-yellow-300 border border-yellow-700/50",
  orange: "bg-orange-900/40 text-orange-300 border border-orange-700/50",
  blue: "bg-blue-900/60 text-blue-300 border border-blue-700/50",
};

/**
 * OUTLINE / ghost badge classes for a BURIED ref (carried by an interior member
 * of a fold, not the fold's head). Transparent background + a same-hue border +
 * muted text — visibly distinct from the solid head badge, distinguishing
 * head-vs-buried by styling ALONE (no count or position number). Static literal
 * strings for Tailwind v4.
 */
const BURIED_BADGE_CLASSES: Record<Hue, string> = {
  green: "bg-transparent text-green-300/70 border border-dashed border-green-700/60",
  yellow: "bg-transparent text-yellow-300/70 border border-dashed border-yellow-700/60",
  orange: "bg-transparent text-orange-300/70 border border-dashed border-orange-700/60",
  blue: "bg-transparent text-blue-300/70 border border-dashed border-blue-700/60",
};

/**
 * A badge for a ref carried by a commit hidden inside a fold (a region rollup or
 * a merged-in secondary path). It ensures a folded branch/remote-branch/tag
 * never silently disappears — it resurfaces on the summary node.
 *
 * Head-vs-buried is conveyed by styling alone (Requirements 17.1–17.4):
 *  - `buried === false` → the ref is on the fold's head/tip member → SOLID style
 *    (identical to the ref badge `CommitNodeComponent` renders).
 *  - `buried === true`  → the ref is on an interior member → OUTLINE/ghost style
 *    with a tooltip noting it sits inside the folded run.
 */
function FoldedRefBadge({ ref, buried }: FoldedRef) {
  const hue = hueFor(ref);
  const cls = buried ? BURIED_BADGE_CLASSES[hue] : SOLID_BADGE_CLASSES[hue];
  return (
    <span
      title={buried ? `${ref.name} — inside this folded run` : ref.name}
      className={[
        "px-1.5 py-0 rounded text-[10px] font-mono leading-4 max-w-full truncate inline-block align-bottom",
        cls,
      ].join(" ")}
    >
      {ref.is_head ? "● " : ""}
      {ref.name}
    </span>
  );
}

export default memo(FoldedRefBadge);

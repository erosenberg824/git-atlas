/**
 * Shared visual language for ref badges (branches, tags, remotes, HEAD).
 *
 * The same color coding is used in two places — the graph commit nodes
 * (`CommitNodeComponent`) and the commit pane's "At this commit" / "Contained
 * in" sections (`CommitPanel`) — so it lives here to stay consistent. Extracted
 * from the previously-inline classnames in `CommitNodeComponent`.
 */

/** The subset of ref fields that determine a badge's appearance. */
export interface RefBadgeLike {
  kind: "branch" | "remotebranch" | "tag" | "head";
  is_head?: boolean;
}

/** Base classes shared by every badge size/variant. */
const BADGE_BASE =
  "rounded font-mono max-w-full truncate inline-block align-bottom border";

/**
 * Tailwind classes for a ref badge's color scheme, chosen by kind/HEAD:
 * - HEAD / default branch: green
 * - tag: yellow
 * - remote branch: orange
 * - local branch: blue
 *
 * The same scheme is used everywhere a badge appears (graph nodes, the "At
 * commit" tips, and the "Contained in" groups) so a given ref looks identical
 * in all three. The tip-vs-contained distinction is conveyed by section
 * grouping/labels, not by restyling the badge.
 */
export function refBadgeColor(ref: RefBadgeLike): string {
  return ref.is_head
    ? "bg-green-900/60 text-green-300 border-green-700/50"
    : ref.kind === "tag"
      ? "bg-yellow-900/60 text-yellow-300 border-yellow-700/50"
      : ref.kind === "remotebranch"
        ? "bg-orange-900/40 text-orange-300 border-orange-700/50"
        : "bg-blue-900/60 text-blue-300 border-blue-700/50";
}

/**
 * Full className for a ref badge. `size` controls padding/text-size:
 * - "node": the compact badge used inside graph nodes (10px)
 * - "panel": the slightly larger badge used in the commit pane (11px)
 */
export function refBadgeClass(
  ref: RefBadgeLike,
  opts: { size?: "node" | "panel" } = {},
): string {
  const { size = "node" } = opts;
  const sizing =
    size === "panel"
      ? "px-1.5 py-0.5 text-[11px] leading-4"
      : "px-1.5 py-0 text-[10px] leading-4";
  return [BADGE_BASE, sizing, refBadgeColor(ref)].join(" ");
}

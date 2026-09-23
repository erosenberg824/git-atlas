/**
 * Shared styling for the graph's scope-control buttons (Branches toggle, the
 * "Collapse merged branches" switch, and any future scope filters like "Show
 * orphans"). Centralising this keeps every scope control on ONE active-state
 * look and ONE hover treatment, fixing the prior inconsistency where the
 * view-mode segmented control used a solid-blue active fill and no hover border
 * while the Branches button used a translucent-blue active fill with a border.
 *
 * Active   → solid accent fill (Primer primary-button treatment): a solid blue
 *            surface with a matching border and white text, so the fill and
 *            border read as one clean surface rather than a translucent fill
 *            bleeding the graph through under a crisp bright border.
 * Inactive → neutral border/fill, brightening text and gaining a blue border on
 *            hover (`hover:border-[#58a6ff]/50`) — the shared hover convention.
 */

/** Base classes shared by every scope-control button, regardless of state. */
export const CONTROL_BUTTON_BASE =
  "self-start flex items-center gap-1 px-2 py-1 text-xs border rounded-md transition-colors";

/** Active (pressed/on) state classes. */
export const CONTROL_BUTTON_ACTIVE =
  "text-white border-[#1f6feb] bg-[#1f6feb] hover:bg-[#388bfd] hover:border-[#388bfd]";

/** Inactive (off) state classes, including the shared hover treatment. */
export const CONTROL_BUTTON_INACTIVE =
  "text-[#8b949e] hover:text-[#e6edf3] border-[#30363d] bg-[#161b22] hover:border-[#58a6ff]/50";

/**
 * Full className for a scope-control button in the given state. Combines the
 * shared base with the active or inactive variant.
 */
export function controlButtonClass(active: boolean): string {
  return `${CONTROL_BUTTON_BASE} ${active ? CONTROL_BUTTON_ACTIVE : CONTROL_BUTTON_INACTIVE}`;
}

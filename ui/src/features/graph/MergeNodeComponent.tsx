import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitMerge, GitBranch, ChevronsDownUp } from "lucide-react";
import type { CommitNode, RefLabel } from "../../api/client";
import type { MergeAffordance } from "./collapse";
import FoldedRefBadge from "./FoldedRefBadge";
import Tooltip from "../../components/Tooltip";

interface MergeNodeData {
  commit: CommitNode;
  refs: RefLabel[];
  selected: boolean;
  onSelect: (oid: string) => void;
  /** True when this commit heads a foldable linear run (shows a collapse control). */
  canCollapse?: boolean;
  /** Collapse the linear run this commit heads. */
  onCollapse?: (oid: string) => void;
  /**
   * One entry per secondary parent that currently has a non-empty hide set and
   * is being OFFERED (recursion-aware). Empty for a merge with nothing to
   * reveal (in which case this node still renders as a normal merge commit).
   */
  hiddenGroups: MergeAffordance[];
  /** Fold/expand a specific secondary path, keyed on the stable merge oid. */
  onTogglePath: (mergeOid: string, parentIndex: number, folded: boolean) => void;
}

/**
 * A merge commit rendered as a first-class node type. It looks like
 * `CommitNodeComponent` (same visual structure AND the SAME handle geometry so
 * edge routing / lane assignment behave identically) plus a discoverable
 * hidden-branch affordance per secondary parent.
 *
 * Affordance model (Requirements 1.2–1.6, 9.2, 9.3, 11.1):
 *  - one independently toggleable badge per secondary parent with a non-empty
 *    hide set (octopus merges → multiple badges);
 *  - folded → an "expand" affordance (branch glyph + hidden-commit count) whose
 *    tooltip invites revealing the merged-in branch;
 *  - expanded → a "collapse" affordance so the fold round-trip is reachable;
 *  - clicking a badge calls `onTogglePath(mergeOid, parentIndex, folded)` and
 *    stops propagation so it doesn't also select the commit.
 *
 * React Flow types `NodeProps.data` as `unknown`, so we cast it to
 * `MergeNodeData` — the shape set when building nodes in `CommitGraph`.
 */
function MergeNodeComponent({ data }: NodeProps) {
  const {
    commit,
    refs,
    selected,
    onSelect,
    canCollapse,
    onCollapse,
    hiddenGroups,
    onTogglePath,
  } = data as unknown as MergeNodeData;

  const date = new Date(commit.timestamp * 1000);
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      onClick={() => onSelect(commit.oid)}
      className={[
        "relative px-3 py-2 rounded-md border text-xs cursor-pointer min-w-[180px] max-w-[200px]",
        "transition-colors duration-100",
        selected
          ? "border-blue-400 bg-blue-950/60 shadow-[0_0_0_2px_rgba(88,166,255,0.3)]"
          : "border-purple-700/50 bg-[#161b22] hover:border-purple-400/60",
      ].join(" ")}
    >
      {/* Fold control: collapse the linear run this merge node heads. Anchored at
          the node's TOP-RIGHT corner so it lines up with the summary node's
          expand affordance — the control does not jump on fold/expand
          (Req 19.1–19.3, Property 10). This is the region-collapse control; the
          per-secondary-parent hidden-branch affordances below are separate. */}
      {canCollapse && (
        <Tooltip
          primary="Collapse this linear run of commits"
          placement="top"
          className="absolute top-1 right-1 z-10"
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCollapse?.(commit.oid);
            }}
            className="rounded p-0.5 text-purple-300/80 hover:text-purple-200 hover:bg-purple-900/40"
          >
            <ChevronsDownUp size={11} />
          </button>
        </Tooltip>
      )}

      {/* Handle geometry note (copied verbatim from CommitNodeComponent so a
          merge node routes edges identically):
          Server edges run parent (source) → child (target). Commits are ordered
          newest-first, so a CHILD sits ABOVE its PARENT on screen. That means:
          - the source (parent) emits UPWARD  → source handle on the TOP
          - the target (child) receives from BELOW → target handle on the BOTTOM
          Side handles (left/right) are hidden alternates so React Flow can route
          cross-lane (branch/merge) edges through the nearest side. */}

      {/* Target handles (child receives from its parent below) */}
      <Handle
        id="t-bottom"
        type="target"
        position={Position.Bottom}
        className="!bg-[#30363d] !border-0"
      />
      {/* Top target handle: retained as a hidden alternate. (The working-tree
          node now connects via HEAD's top source handle, not into this one.) */}
      <Handle
        id="t-top"
        type="target"
        position={Position.Top}
        className="!bg-transparent !border-0"
      />
      <Handle
        id="t-left"
        type="target"
        position={Position.Left}
        className="!bg-[#30363d] !border-0 !opacity-0"
      />
      <Handle
        id="t-right"
        type="target"
        position={Position.Right}
        className="!bg-[#30363d] !border-0 !opacity-0"
      />

      {/* Ref badges */}
      {refs.length > 0 && (
        <div className={["flex flex-wrap gap-1 mb-1", canCollapse ? "pr-5" : ""].join(" ")}>
          {refs.map((ref) => (
            <Tooltip key={ref.name} primary={ref.name} mono className="min-w-0 max-w-full">
              <span
                className={[
                  "px-1.5 py-0 rounded text-[10px] font-mono leading-4 max-w-full truncate inline-block align-bottom",
                  ref.is_head
                    ? "bg-green-900/60 text-green-300 border border-green-700/50"
                    : ref.kind === "tag"
                    ? "bg-yellow-900/60 text-yellow-300 border border-yellow-700/50"
                    : ref.kind === "remotebranch"
                    ? "bg-orange-900/40 text-orange-300 border border-orange-700/50"
                    : "bg-blue-900/60 text-blue-300 border border-blue-700/50",
                ].join(" ")}
              >
                {ref.is_head ? "● " : ""}
                {ref.name}
              </span>
            </Tooltip>
          ))}
        </div>
      )}

      {/* Commit hash + date (+ merge glyph for the 2+-parent commit).
          `pr-5` when `canCollapse` reserves room for the absolutely-positioned
          top-right fold control so the date never sits under it — needed on
          THIS (topmost) row for merge nodes with no ref badges (Req 24.1, 24.2,
          24.4, 24.5, 25.1, 25.2). */}
      <div
        className={[
          "flex items-center justify-between gap-2 mb-0.5",
          canCollapse ? "pr-5" : "",
        ].join(" ")}
      >
        <span className="font-mono text-[#8b949e] flex items-center gap-1">
          <GitMerge size={11} className="text-purple-400/80" aria-label="merge commit" />
          {commit.short_oid}
        </span>
        <span className="text-[#8b949e]">{dateStr}</span>
      </div>

      {/* Summary */}
      <div className="text-[#e6edf3] truncate leading-tight">
        {commit.summary || "(no message)"}
      </div>

      {/* Author */}
      <div className="text-[#8b949e] truncate mt-0.5">{commit.author_name}</div>

      {/* Hidden-branch affordances: one per secondary parent with a non-empty
          hide set. Folded → "reveal" control; expanded → "hide" control. Each
          path also surfaces the refs carried by its hidden members as folded-ref
          badges (head solid, buried outline) so a merged-in branch/tag is
          visible without expanding it. */}
      {hiddenGroups.length > 0 && (
        <div className="flex flex-col gap-1 mt-1.5">
          {hiddenGroups.map((g) => {
            // The branch/ref name(s) this secondary path carries — the branch
            // that merged in. Prefer the head ref; fall back to the first.
            const fromName =
              g.foldedRefs.find((fr) => !fr.buried)?.ref.name ??
              g.foldedRefs[0]?.ref.name;
            return (
              <div key={g.id} className="flex flex-wrap items-center gap-1">
                <Tooltip
                  primary={g.folded ? "Merged branch" : "Merged branch revealed"}
                  secondary={
                    g.folded
                      ? `${g.hiddenCount} commits — click to reveal`
                      : `${g.hiddenCount} commits — click to hide`
                  }
                  placement="top"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePath(commit.oid, g.parentIndex, g.folded);
                    }}
                    className={[
                      "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono leading-4 border transition-colors duration-100 max-w-full",
                      g.folded
                        ? "bg-purple-900/50 text-purple-200 border-purple-700/60 hover:border-purple-400/70"
                        : "bg-purple-950/40 text-purple-300/80 border-dashed border-purple-700/50 hover:border-purple-400/70",
                    ].join(" ")}
                  >
                    <GitBranch size={10} className="shrink-0" />
                    {/* Count stays right after the branch glyph (its original
                        spot). When expanded, the branch that merged in is named
                        next to it — consolidated into the purple indicator
                        rather than a separate, cramped badge. When folded, the
                        branch commits are hidden, so only the count shows here
                        and the branch surfaces as full FoldedRefBadges below. */}
                    <span>{g.hiddenCount}</span>
                    {!g.folded && fromName && (
                      <span className="truncate max-w-[130px]">{fromName}</span>
                    )}
                    {g.folded ? null : (
                      <ChevronsDownUp size={10} className="shrink-0 opacity-70" />
                    )}
                  </button>
                </Tooltip>
                {/* While FOLDED the branch commits are hidden, so surface the
                    branch/tag refs here as full FoldedRefBadges (their only home,
                    with head-vs-buried styling). While EXPANDED the branch name
                    already lives inside the affordance above and the branch
                    renders its own badges, so nothing extra is shown here. */}
                {g.folded &&
                  g.foldedRefs.length > 0 &&
                  g.foldedRefs.map((fr, i) => (
                    <FoldedRefBadge
                      key={`${g.id}-${fr.ref.name}-${i}`}
                      ref={fr.ref}
                      buried={fr.buried}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Source handles (parent emits up to its child above) */}
      <Handle
        id="s-top"
        type="source"
        position={Position.Top}
        className="!bg-[#30363d] !border-0"
      />
      <Handle
        id="s-bottom"
        type="source"
        position={Position.Bottom}
        className="!bg-[#30363d] !border-0 !opacity-0"
      />
      <Handle
        id="s-left"
        type="source"
        position={Position.Left}
        className="!bg-[#30363d] !border-0 !opacity-0"
      />
      <Handle
        id="s-right"
        type="source"
        position={Position.Right}
        className="!bg-[#30363d] !border-0 !opacity-0"
      />
    </div>
  );
}

export default memo(MergeNodeComponent);

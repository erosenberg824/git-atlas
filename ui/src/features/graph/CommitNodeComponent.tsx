import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitMerge, ChevronsDownUp, Archive } from "lucide-react";
import type { CommitNode, RefLabel, StashEntry } from "../../api/client";
import { refBadgeClass } from "./refBadge";
import Tooltip from "../../components/Tooltip";

interface CommitNodeData {
  commit: CommitNode;
  refs: RefLabel[];
  selected: boolean;
  onSelect: (oid: string) => void;
  /** True when this commit heads a foldable linear run (shows a collapse control). */
  canCollapse?: boolean;
  /** Collapse the linear run this commit heads. */
  onCollapse?: (oid: string) => void;
  /** Stashes created on this commit (its `base_oid`). Empty → no stash badge. */
  stashes?: StashEntry[];
  /** The stash index currently selected (drives the badge's active shading), or null. */
  selectedStashIndex?: number | null;
  /** Select a stash (by index) → opens its diff in the right pane. */
  onSelectStash?: (index: number) => void;
}

/**
 * Classes for the amber stash pill/badge. `active` (a stash on this commit is
 * the current selection) brightens the border/fill; otherwise it's a muted
 * amber that lifts on hover.
 */
function stashBadgeClass(active: boolean): string {
  return [
    "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono leading-4 border transition-colors cursor-default",
    active
      ? "border-amber-400 bg-amber-900/50 text-amber-200"
      : "border-amber-700/60 bg-amber-950/30 text-amber-300/90 hover:border-amber-400/70",
  ].join(" ");
}

/**
 * A single commit node in the React Flow graph. Renders the short hash, date,
 * summary, author, and any ref badges (branches/tags/HEAD) pointing at the
 * commit. Clicking it selects the commit (drives the detail panels).
 *
 * React Flow types `NodeProps.data` as `unknown`, so we cast it to
 * `CommitNodeData` — the shape we set when building nodes in `CommitGraph`.
 * Handle positions here are intentional: see CommitGraph's edge-routing notes
 * (parent commits sit BELOW their children, so the source handle is on top).
 */
function CommitNodeComponent({ data }: NodeProps) {
  const { commit, refs, selected, onSelect, canCollapse, onCollapse, stashes, selectedStashIndex, onSelectStash } =
    data as unknown as CommitNodeData;

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
          : "border-[#30363d] bg-[#161b22] hover:border-[#58a6ff]/50",
      ].join(" ")}
    >
      {/* Fold control: collapse the linear run this commit heads. Anchored at the
          node's TOP-RIGHT corner so it occupies the SAME spot as a summary
          node's expand affordance — the control does not jump on fold/expand
          (Req 19.1–19.3, Property 10). */}
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

      {/* Handle geometry note:
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
              <span className={refBadgeClass(ref, { size: "node" })}>
                {ref.is_head ? "● " : ""}
                {ref.name}
              </span>
            </Tooltip>
          ))}
        </div>
      )}

      {/* Commit hash + date (+ subtle merge indicator for 2+ parents).
          `pr-5` when `canCollapse` reserves room for the absolutely-positioned
          top-right fold control so the date never sits under it — needed on
          THIS (topmost) row for nodes with no ref badges (Req 24.1, 24.2, 24.4,
          24.5, 25.1, 25.2). */}
      <div
        className={[
          "flex items-center justify-between gap-2 mb-0.5",
          canCollapse ? "pr-5" : "",
        ].join(" ")}
      >
        <span className="font-mono text-[#8b949e] flex items-center gap-1">
          {commit.parents.length >= 2 && (
            <GitMerge size={11} className="text-purple-400/80" aria-label="merge commit" />
          )}
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

      {/* Stash badge: compact amber pill showing how many stashes were created
          on this commit. A stash isn't a node "just hanging around"; it lives
          here on the commit it was built on, one click from its diff. Hovering
          the badge opens an interactive tooltip that lists every stash as its
          own clickable row — whether there's one stash or several, you always
          pick the diff to view the same way (from the tooltip). The badge itself
          is just the hover host; it shades "active" while one of this commit's
          stashes is the current selection. */}
      {stashes && stashes.length > 0 && (() => {
        const activeIdx = selectedStashIndex ?? -1;
        const isActive = stashes.some((s) => s.index === activeIdx);

        // ONE consistent interaction whether there's a single stash or several:
        // the badge hosts an interactive tooltip listing each stash as its own
        // clickable row, and you always pick the diff to view from that list.
        return (
          <Tooltip
            interactive
            primary={
              <span className="flex flex-col gap-1">
                {stashes.map((s) => {
                  const rowActive = s.index === activeIdx;
                  return (
                    <button
                      key={s.index}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectStash?.(s.index);
                      }}
                      className={[
                        "flex items-start gap-1.5 rounded px-1 py-0.5 text-left transition-colors",
                        rowActive
                          ? "bg-amber-900/50 text-amber-100"
                          : "text-[#e6edf3] hover:bg-amber-950/50",
                      ].join(" ")}
                    >
                      <Archive size={10} className="mt-0.5 shrink-0 text-amber-300/90" />
                      <span className="min-w-0">
                        <span className="font-mono text-amber-300/90">
                          stash@{`{${s.index}}`}
                        </span>{" "}
                        <span className="break-words">{s.message}</span>
                      </span>
                    </button>
                  );
                })}
              </span>
            }
            secondary={
              stashes.length === 1
                ? "click to view its diff"
                : "click a stash to view its diff"
            }
            placement="bottom"
            className="mt-1 inline-block"
          >
            <span aria-pressed={isActive} className={stashBadgeClass(isActive)}>
              <Archive size={10} />
              {stashes.length === 1 ? "stash" : `${stashes.length} stashes`}
            </span>
          </Tooltip>
        );
      })()}

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

export default memo(CommitNodeComponent);

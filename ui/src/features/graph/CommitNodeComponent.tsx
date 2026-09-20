import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CommitNode, RefLabel } from "../../api/client";

interface CommitNodeData {
  commit: CommitNode;
  refs: RefLabel[];
  selected: boolean;
  onSelect: (oid: string) => void;
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
  const { commit, refs, selected, onSelect } = data as unknown as CommitNodeData;

  const date = new Date(commit.timestamp * 1000);
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      onClick={() => onSelect(commit.oid)}
      className={[
        "px-3 py-2 rounded-md border text-xs cursor-pointer min-w-[180px] max-w-[200px]",
        "transition-colors duration-100",
        selected
          ? "border-blue-400 bg-blue-950/60 shadow-[0_0_0_2px_rgba(88,166,255,0.3)]"
          : "border-[#30363d] bg-[#161b22] hover:border-[#58a6ff]/50",
      ].join(" ")}
    >
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
      {/* Top target handle: used by the "Working tree" pseudo-node, which sits
          above HEAD and connects down into the top of the HEAD commit. */}
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
        <div className="flex flex-wrap gap-1 mb-1">
          {refs.map((ref) => (
            <span
              key={ref.name}
              title={ref.name}
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
          ))}
        </div>
      )}

      {/* Commit hash + date */}
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="font-mono text-[#8b949e]">{commit.short_oid}</span>
        <span className="text-[#8b949e]">{dateStr}</span>
      </div>

      {/* Summary */}
      <div className="text-[#e6edf3] truncate leading-tight">
        {commit.summary || "(no message)"}
      </div>

      {/* Author */}
      <div className="text-[#8b949e] truncate mt-0.5">{commit.author_name}</div>

      {/* Source handles (parent emits up to its child above) */}
      <Handle
        id="s-top"
        type="source"
        position={Position.Top}
        className="!bg-[#30363d] !border-0"
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

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronsUpDown } from "lucide-react";
import type { CollapsedRunData } from "./collapse";

interface RunNodeProps extends CollapsedRunData {
  selected: boolean;
  onExpand: (id: string) => void;
}

/**
 * A collapsed run of linear commits, rendered as one node ("N commits") with a
 * date range. Clicking expands the run back into individual commit nodes.
 * Handle geometry matches CommitNodeComponent (source on top, target on bottom)
 * so it sits inline in the lane between the surrounding commits.
 *
 * Re-collapsing an expanded run is offered on the run-head commit node (the
 * `ChevronsDownUp` control wired to `collapseAtCommit`), so the expand/collapse
 * round-trip is reachable once a run is expanded (Defect 4).
 */
function RunNodeComponent({ data }: NodeProps) {
  const d = data as unknown as RunNodeProps;
  const newest = new Date(d.newestTs * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const oldest = new Date(d.oldestTs * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  const labelText = d.label ? `⑂ ${d.label}` : `${d.count} commits`;
  const rangeText = d.label
    ? `${d.count} commits · ${oldest} → ${newest}`
    : `${oldest} → ${newest}`;

  return (
    <div
      onClick={() => d.onExpand(d.id)}
      title="Click to expand this run of commits"
      className={[
        "px-3 py-2 rounded-md border border-dashed text-xs cursor-pointer min-w-[180px] max-w-[210px]",
        "transition-colors duration-100 bg-[#161b22]",
        d.selected
          ? "border-purple-400 shadow-[0_0_0_2px_rgba(192,132,252,0.3)]"
          : "border-purple-700/60 hover:border-purple-400/70",
      ].join(" ")}
    >
      {/* Source handle on top (toward newer child), target on bottom (toward
          older parent) — same convention as commit nodes. */}
      <Handle id="s-top" type="source" position={Position.Top} className="!bg-[#30363d] !border-0" />
      <Handle id="t-bottom" type="target" position={Position.Bottom} className="!bg-[#30363d] !border-0" />

      {/* Header row: icon + label. `min-w-0` lets the label `truncate` engage so
          a long branch name stays within the fixed-width node box (Defect 7);
          the full label is available on hover via `title`. */}
      <div className="flex items-center gap-1.5 mb-0.5 text-purple-200 font-semibold">
        <ChevronsUpDown size={12} className="text-purple-300 shrink-0" />
        <span className="min-w-0 truncate" title={labelText}>
          {labelText}
        </span>
      </div>
      <div className="text-[#8b949e] text-[11px] truncate" title={rangeText}>
        {rangeText}
      </div>
      <div className="text-[#6e7681] text-[10px] mt-0.5 truncate">click to expand</div>
    </div>
  );
}

export default memo(RunNodeComponent);

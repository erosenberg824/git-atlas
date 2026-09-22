import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileEdit, Archive } from "lucide-react";

export interface SpecialNodeData {
  kind: "working" | "stash";
  title: string;
  subtitle?: string;
  /** Badge counts, e.g. staged/unstaged for the working node. */
  badges?: { label: string; value: number }[];
  selected: boolean;
  onSelect: (id: string) => void;
  id: string;
}

/**
 * Renders the non-commit pseudo-nodes: the "Working tree" node (working +
 * staged changes) and each stash node. Styled distinctly (dashed, tinted) so
 * they read as "not a real commit" in the DAG.
 */
function SpecialNodeComponent({ data }: NodeProps) {
  const d = data as unknown as SpecialNodeData;
  const isWorking = d.kind === "working";

  return (
    <div
      onClick={() => d.onSelect(d.id)}
      className={[
        "px-3 py-2 rounded-md border border-dashed text-xs cursor-pointer min-w-[180px] max-w-[210px]",
        "transition-colors duration-100",
        isWorking
          ? d.selected
            ? "border-emerald-400 bg-emerald-950/50 shadow-[0_0_0_2px_rgba(52,211,153,0.3)]"
            : "border-emerald-700/60 bg-emerald-950/20 hover:border-emerald-400/70"
          : d.selected
            ? "border-amber-400 bg-amber-950/50 shadow-[0_0_0_2px_rgba(251,191,36,0.3)]"
            : "border-amber-700/60 bg-amber-950/20 hover:border-amber-400/70",
      ].join(" ")}
    >
      {/* Source handle: kept for stash pseudo-nodes, which sit beside their
          base commit and emit toward it. */}
      <Handle
        id="s-bottom"
        type="source"
        position={Position.Bottom}
        className="!bg-transparent !border-0"
      />

      {/* Target handle: the working-tree node sits ABOVE HEAD and receives the
          HEAD → working edge into its bottom. */}
      <Handle
        id="t-bottom"
        type="target"
        position={Position.Bottom}
        className="!bg-transparent !border-0"
      />

      <div className="flex items-center gap-1.5 mb-0.5">
        {isWorking ? (
          <FileEdit size={12} className="text-emerald-300" />
        ) : (
          <Archive size={12} className="text-amber-300" />
        )}
        <span
          className={[
            "font-semibold",
            isWorking ? "text-emerald-200" : "text-amber-200",
          ].join(" ")}
        >
          {d.title}
        </span>
      </div>

      {d.subtitle && (
        <div className="text-[#8b949e] truncate leading-tight">{d.subtitle}</div>
      )}

      {d.badges && d.badges.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {d.badges.map((b) => (
            <span
              key={b.label}
              className="px-1.5 py-0 rounded text-[10px] font-mono leading-4 bg-[#161b22] border border-[#30363d] text-[#8b949e]"
            >
              {b.label} {b.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(SpecialNodeComponent);

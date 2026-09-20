import { useState } from "react";
import { GitBranch, Eye, EyeOff, ChevronsDownUp, X } from "lucide-react";
import type { BranchInfo, BranchVisibility } from "./branches";

/**
 * Branch visibility control: lists branches with a tri-state per branch —
 * Hidden / Collapsed (virtual squash) / Expanded. Clicking a branch cycles it
 * Expanded → Collapsed → Hidden → Expanded. Drives server ref-scoping + rollups.
 */
export default function BranchControl({
  branches,
  visibility,
  onCycle,
  onClose,
}: {
  branches: BranchInfo[];
  visibility: Map<string, BranchVisibility>;
  onCycle: (name: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const icon = (v: BranchVisibility) =>
    v === "expanded" ? (
      <Eye size={13} className="text-emerald-400" />
    ) : v === "collapsed" ? (
      <ChevronsDownUp size={13} className="text-purple-300" />
    ) : (
      <EyeOff size={13} className="text-[#6e7681]" />
    );

  return (
    <div className="absolute top-2 right-2 z-20 w-64 max-h-[70%] flex flex-col rounded-md border border-[#30363d] bg-[#161b22] shadow-lg text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-[#30363d] shrink-0">
        <GitBranch size={13} className="text-blue-400" />
        <span className="font-semibold text-[#e6edf3]">Branches</span>
        <button onClick={onClose} className="ml-auto text-[#8b949e] hover:text-[#e6edf3]" title="Close">
          <X size={13} />
        </button>
      </div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter branches…"
        className="m-2 px-2 py-1 bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder:text-[#6e7681] outline-none focus:border-blue-500/60"
      />
      <div className="overflow-auto px-1 pb-2">
        {shown.map((b) => {
          const v = visibility.get(b.name) ?? "hidden";
          return (
            <button
              key={b.name}
              onClick={() => onCycle(b.name)}
              className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[#21262d] text-left"
              title={`${v} — click to cycle (expanded → collapsed → hidden)`}
            >
              {icon(v)}
              <span
                className={[
                  "font-mono truncate",
                  v === "hidden" ? "text-[#6e7681]" : "text-[#e6edf3]",
                ].join(" ")}
              >
                {b.isHead ? "● " : ""}
                {b.name}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <div className="px-2 py-2 text-[#6e7681]">No branches match.</div>
        )}
      </div>
    </div>
  );
}

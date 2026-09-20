import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, type DiffResponse } from "../../api/client";
import DiffViewer from "../diff/DiffViewer";

type Section = "unstaged" | "staged";

/**
 * Right-pane content for the "Working tree" pseudo-node: two collapsible-ish
 * sections (Staged / Unstaged), each showing a diff. Read-only.
 */
export function WorkingPanel() {
  const [section, setSection] = useState<Section>("unstaged");
  const [staged, setStaged] = useState<DiffResponse | null>(null);
  const [unstaged, setUnstaged] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.diff.staged(), api.diff.working()])
      .then(([s, u]) => {
        setStaged(s);
        setUnstaged(u);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[#8b949e]">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const active = section === "staged" ? staged : unstaged;
  const stagedN = staged?.stats.files_changed ?? 0;
  const unstagedN = unstaged?.stats.files_changed ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Section switch */}
      <div className="flex border-b border-[#30363d] bg-[#0d1117] shrink-0">
        {([
          ["unstaged", "Unstaged", unstagedN],
          ["staged", "Staged", stagedN],
        ] as [Section, string, number][]).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={[
              "flex items-center gap-1.5 px-4 py-2 text-xs border-b-2 transition-colors",
              section === key
                ? "border-emerald-400 text-emerald-300"
                : "border-transparent text-[#8b949e] hover:text-[#e6edf3]",
            ].join(" ")}
          >
            {label}
            <span className="px-1.5 rounded-full bg-[#21262d] text-[10px] text-[#8b949e]">
              {count}
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {active && active.files.length > 0 ? (
          <DiffViewer diff={active} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[#8b949e]">
            No {section} changes
          </div>
        )}
      </div>
    </div>
  );
}

/** Right-pane content for a stash node: a single read-only diff. */
export function StashPanel({ index }: { index: number }) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.diff
      .stash(index)
      .then(setDiff)
      .finally(() => setLoading(false));
  }, [index]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[#8b949e]">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  if (!diff || diff.files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[#8b949e]">
        Stash is empty
      </div>
    );
  }
  return <DiffViewer diff={diff} />;
}

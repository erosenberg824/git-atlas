import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { RefLabel } from "../../api/client";

/**
 * Find/jump control: type a branch or tag name; selecting a match asks the
 * graph to center + highlight that ref's tip commit (via `onJump(oid)`).
 */
export default function FindRefBox({
  refs,
  onJump,
}: {
  refs: RefLabel[];
  onJump: (oid: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  // Branch + tag refs, de-duplicated by name.
  const named = useMemo(
    () => refs.filter((r) => r.kind === "branch" || r.kind === "remotebranch" || r.kind === "tag"),
    [refs],
  );
  const matches = useMemo(() => {
    if (!q.trim()) return [];
    const ql = q.toLowerCase();
    return named.filter((r) => r.name.toLowerCase().includes(ql)).slice(0, 8);
  }, [q, named]);

  const jump = (r: RefLabel) => {
    onJump(r.oid);
    setQ(r.name);
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-1 px-2 py-1 rounded-md border border-[#30363d] bg-[#161b22]">
        <Search size={12} className="text-[#8b949e]" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches.length > 0) jump(matches[0]);
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Find branch/tag…"
          className="w-36 bg-transparent text-xs text-[#e6edf3] placeholder:text-[#6e7681] outline-none"
        />
      </div>
      {open && matches.length > 0 && (
        <div className="absolute mt-1 w-56 rounded-md border border-[#30363d] bg-[#161b22] shadow-lg overflow-hidden">
          {matches.map((r) => (
            <button
              key={`${r.kind}-${r.name}`}
              onClick={() => jump(r)}
              className="w-full text-left px-2 py-1 text-xs font-mono text-[#e6edf3] hover:bg-[#21262d] flex items-center gap-2"
            >
              <span
                className={
                  r.kind === "tag" ? "text-yellow-300" : "text-blue-300"
                }
              >
                {r.kind === "tag" ? "⌂" : "⑂"}
              </span>
              <span className="truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

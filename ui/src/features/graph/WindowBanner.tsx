import { Clock, Home } from "lucide-react";

/**
 * Status bar above the graph. Always visible: shows the date range of what's
 * displayed, how many commits are shown (and the total across visible branches),
 * and — when a time window hides commits — how many are after/before it.
 *
 * The Home button resets the time window and jumps to HEAD (main/master).
 *
 * Dates read newest → oldest to match the top-down graph + scrubber direction.
 */
export default function WindowBanner({
  newest,
  oldest,
  shownCount,
  totalCount,
  beforeCount,
  afterCount,
  onHome,
}: {
  newest: number;
  oldest: number;
  shownCount: number;
  totalCount: number;
  beforeCount: number;
  afterCount: number;
  onHome: () => void;
}) {
  // Split into parts so the MONTH (the only variable-width piece — 3-letter
  // abbreviations differ by a pixel or two in a proportional font) gets its own
  // fixed-width cell. Day (2-digit) + year are constant with tabular-nums, so
  // the whole date is constant width and the count after it never shifts.
  const parts = (ts: number) => {
    const d = new Date(ts * 1000);
    return {
      month: d.toLocaleDateString(undefined, { month: "short" }),
      day: d.toLocaleDateString(undefined, { day: "2-digit" }),
      year: d.toLocaleDateString(undefined, { year: "numeric" }),
    };
  };
  const DatePart = ({ ts }: { ts: number }) => {
    const p = parts(ts);
    return (
      <span className="tabular-nums whitespace-nowrap">
        {/* Fixed-width month cell absorbs the only variable-width part. */}
        <span className="inline-block w-[1.7rem]">{p.month}</span>
        {p.day}, {p.year}
      </span>
    );
  };

  const hidden = beforeCount > 0 || afterCount > 0 || shownCount < totalCount;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[#161b22] border-b border-[#30363d] text-[#e6edf3]">
      <Clock size={13} className="text-blue-300 shrink-0" />
      <span className="font-medium whitespace-nowrap">
        <DatePart ts={newest} /> → <DatePart ts={oldest} />
      </span>
      <span className="text-[#8b949e] whitespace-nowrap">
        · {shownCount}{hidden ? ` of ${totalCount}` : ""} commit{totalCount !== 1 ? "s" : ""}
      </span>
      {(afterCount > 0 || beforeCount > 0) && (
        <span className="text-[#6e7681] whitespace-nowrap">
          · {afterCount} after · {beforeCount} before
        </span>
      )}
      {/* Home: reset time + jump to HEAD. Custom tooltip (native title is slow/
          unreliable), shown instantly on hover via group-hover. */}
      <div className="relative ml-auto shrink-0 group">
        <button
          onClick={onHome}
          className="flex items-center px-2 py-1 rounded border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#58a6ff]/50 transition-colors"
          aria-label="Home: reset time filter and jump to HEAD"
        >
          <Home size={15} />
        </button>
        <span className="pointer-events-none absolute right-0 top-full mt-1 whitespace-nowrap rounded bg-[#0d1117] border border-[#30363d] px-1.5 py-0.5 text-[10px] text-[#e6edf3] opacity-0 group-hover:opacity-100 transition-opacity z-30">
          Home — reset time & go to HEAD
        </span>
      </div>
    </div>
  );
}

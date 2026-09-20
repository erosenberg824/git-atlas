import { Clock, X } from "lucide-react";

/**
 * Breadcrumb banner shown when a time window is active. Communicates WHAT you're
 * looking at (date range + commit count) and orientation-to-now (how far the
 * window's end sits before the newest commit), with a one-click "back to latest".
 */
export default function WindowBanner({
  since,
  until,
  newestTs,
  commitCount,
  onClear,
}: {
  since: number;
  until: number;
  newestTs: number;
  commitCount: number;
  onClear: () => void;
}) {
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  // Orientation to "now" (the newest commit): how far the window END is behind it.
  const behindSecs = Math.max(0, newestTs - until);
  const humanGap = (secs: number): string => {
    const day = 86400;
    if (secs < day) return "up to the latest commit";
    const days = Math.round(secs / day);
    if (days < 30) return `ends ~${days}d before latest`;
    const months = Math.round(days / 30);
    if (months < 24) return `ends ~${months}mo before latest`;
    return `ends ~${Math.round(months / 12)}y before latest`;
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-blue-950/40 border-b border-blue-800/40 text-[#e6edf3]">
      <Clock size={13} className="text-blue-300 shrink-0" />
      <span className="font-medium">
        {fmt(since)} → {fmt(until)}
      </span>
      <span className="text-[#8b949e]">· {commitCount} commit{commitCount !== 1 ? "s" : ""}</span>
      <span className="text-amber-300/80">· {humanGap(behindSecs)}</span>
      <button
        onClick={onClear}
        className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-blue-700/50 text-blue-200 hover:bg-blue-900/40 transition-colors shrink-0"
        title="Clear the time filter and return to the latest commits"
      >
        <X size={11} />
        Back to latest
      </button>
    </div>
  );
}

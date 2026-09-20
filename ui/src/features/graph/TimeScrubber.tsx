import { useCallback, useRef } from "react";

/**
 * Vertical time scrubber. Represents the repo's full commit-time range along a
 * vertical track (top = newest, bottom = oldest). A draggable window selects the
 * visible time span:
 *  - drag the window body  → pan through time
 *  - drag the top/bottom   → widen/narrow the window (zoom out/in)
 *
 * Values are unix seconds. `onChange` fires continuously during drag; the parent
 * is expected to debounce the actual graph re-query.
 */
export interface TimeScrubberProps {
  /** Full range extent. */
  newestTs: number;
  oldestTs: number;
  /** Current window (unix seconds). */
  since: number;
  until: number;
  onChange: (since: number, until: number) => void;
}

type DragMode = "body" | "top" | "bottom";

export default function TimeScrubber({
  newestTs,
  oldestTs,
  since,
  until,
  onChange,
}: TimeScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1, newestTs - oldestTs);

  // Map a timestamp to a fraction down the track (0 = top/newest, 1 = bottom/oldest).
  const tsToFrac = (ts: number) => (newestTs - ts) / span;
  // Window rectangle position as percentages from the top.
  const topPct = tsToFrac(until) * 100; // until = newer bound = higher up
  const bottomPct = tsToFrac(since) * 100; // since = older bound = lower down
  const heightPct = Math.max(2, bottomPct - topPct);

  const drag = useRef<{
    mode: DragMode;
    startY: number;
    startSince: number;
    startUntil: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (mode: DragMode) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { mode, startY: e.clientY, startSince: since, startUntil: until };
    },
    [since, until],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      const track = trackRef.current;
      if (!d || !track) return;
      const h = track.getBoundingClientRect().height || 1;
      // Pixels dragged → seconds (down = older = decreasing ts).
      const deltaSecs = ((e.clientY - d.startY) / h) * span;

      let nextSince = d.startSince;
      let nextUntil = d.startUntil;
      const MIN_SPAN = Math.max(3600, Math.floor(span * 0.005)); // >= 1h or 0.5%

      if (d.mode === "body") {
        // Pan: shift both bounds by -deltaSecs (drag down → move window to older).
        nextSince = d.startSince - deltaSecs;
        nextUntil = d.startUntil - deltaSecs;
      } else if (d.mode === "top") {
        // Top handle = the `until` (newer) bound.
        nextUntil = d.startUntil - deltaSecs;
        if (nextUntil < nextSince + MIN_SPAN) nextUntil = nextSince + MIN_SPAN;
      } else {
        // Bottom handle = the `since` (older) bound.
        nextSince = d.startSince - deltaSecs;
        if (nextSince > nextUntil - MIN_SPAN) nextSince = nextUntil - MIN_SPAN;
      }

      // Clamp to full extent.
      if (nextSince < oldestTs) {
        const shift = oldestTs - nextSince;
        nextSince = oldestTs;
        if (d.mode === "body") nextUntil += shift;
      }
      if (nextUntil > newestTs) {
        const shift = nextUntil - newestTs;
        nextUntil = newestTs;
        if (d.mode === "body") nextSince -= shift;
      }
      nextSince = Math.max(oldestTs, Math.round(nextSince));
      nextUntil = Math.min(newestTs, Math.round(nextUntil));

      onChange(nextSince, nextUntil);
    },
    [span, oldestTs, newestTs, onChange],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });

  return (
    <div className="flex flex-col items-center h-full w-14 shrink-0 border-r border-[#30363d] bg-[#0d1117] py-2 select-none">
      <div className="text-[9px] text-[#6e7681] mb-1">{fmt(newestTs)}</div>
      <div
        ref={trackRef}
        className="relative flex-1 w-3 rounded bg-[#161b22] border border-[#30363d]"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Selected window */}
        <div
          className="absolute left-0 right-0 rounded bg-blue-500/30 border border-blue-400/70 cursor-grab active:cursor-grabbing"
          style={{ top: `${topPct}%`, height: `${heightPct}%` }}
          onPointerDown={onPointerDown("body")}
          title="Drag to pan through time; drag ends to zoom"
        >
          {/* Top resize handle */}
          <div
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-2 rounded bg-blue-400 cursor-ns-resize"
            onPointerDown={onPointerDown("top")}
          />
          {/* Bottom resize handle */}
          <div
            className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-2 rounded bg-blue-400 cursor-ns-resize"
            onPointerDown={onPointerDown("bottom")}
          />
        </div>
      </div>
      <div className="text-[9px] text-[#6e7681] mt-1">{fmt(oldestTs)}</div>
    </div>
  );
}

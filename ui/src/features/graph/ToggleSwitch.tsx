import type { ReactNode } from "react";

/**
 * A compact on/off switch for the graph scope-control overlay, styled to match
 * the Primer dark palette used throughout the app. Use this (rather than a
 * `controlButtonClass` button) for controls that are a true binary state with
 * no other action — e.g. "Collapse merged branches". Panel-opening controls
 * like "Branches" stay buttons, since they trigger an action beyond on/off.
 *
 * Renders a native checkbox for accessibility (label association, keyboard
 * focus/space toggle, `role`), visually hidden behind the custom track/thumb.
 * The whole thing is a `<label>` so clicking the text toggles it too.
 *
 * `pending` reflects that the toggle's downstream work (e.g. the graph
 * re-layout the parent runs in a `useTransition`) is still in flight. The
 * switch itself always flips instantly; `pending` just dims it slightly so the
 * user can see the heavier work is catching up rather than wondering if the
 * click registered.
 */
export default function ToggleSwitch({
  checked,
  onChange,
  children,
  title,
  pending = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  title?: string;
  pending?: boolean;
}) {
  return (
    <label
      title={title}
      className="group self-start flex items-center gap-2 px-2 py-1 text-xs text-[#8b949e] hover:text-[#e6edf3] cursor-pointer select-none transition-colors"
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      {/* Track */}
      <span
        aria-hidden
        className={[
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors duration-100 ease-out",
          "border",
          checked
            ? "bg-[#1f6feb] border-[#1f6feb]"
            : "bg-[#161b22] border-[#30363d]",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-[#58a6ff]/60",
          // Press cue: nudge the whole track on active so the click always
          // feels acknowledged the instant the pointer goes down.
          "group-active:brightness-110",
          pending ? "opacity-70" : "",
        ].join(" ")}
      >
        {/* Thumb */}
        <span
          className={[
            "inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-100 ease-out",
            checked ? "translate-x-3.5" : "translate-x-0.5",
          ].join(" ")}
        />
      </span>
      <span className="flex items-center gap-1">{children}</span>
    </label>
  );
}

import { useEffect, useMemo, useState } from "react";
import { GitBranch, Tag, Cloud } from "lucide-react";
import {
  api,
  type ContainingRef,
  type ContainmentResponse,
} from "../../api/client";
import { refBadgeClass } from "../graph/refBadge";

/** How many badges to show per group before collapsing behind "+N more". */
const COLLAPSED_LIMIT = 6;

/**
 * Fetch containment for `oid` once. Shared by the header tip badges
 * (`TipBadges`) and the "Contained in" section (`ContainmentSection`) so there
 * is a single request, not two. Returns `null` until loaded and on error —
 * containment is supplementary, so the pane degrades to simply omitting it.
 * Fetched independently of the commit metadata/diff so those never wait on the
 * (possibly cold, larger) containment build.
 */
export function useContainment(oid: string): ContainmentResponse | null {
  const [data, setData] = useState<ContainmentResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    api.commits
      .containment(oid)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* supplementary; leave as null */
      });
    return () => {
      cancelled = true;
    };
  }, [oid]);

  return data;
}

/** A single ref badge; the default branch is styled like HEAD (green). */
function Badge({ ref }: { ref: ContainingRef }) {
  // The default branch is styled like HEAD (green) to match the graph node,
  // where the current branch shows green. Containment refs never carry
  // `is_head`, so we synthesize it for the default branch here.
  const styled = ref.is_default_branch ? { ...ref, is_head: true } : ref;
  return (
    <span title={ref.name} className={refBadgeClass(styled, { size: "panel" })}>
      {ref.is_default_branch ? "● " : ""}
      {ref.name}
    </span>
  );
}

/**
 * Tip badges — refs pointing *exactly at* the commit. Rendered in the commit
 * header because a tip is part of the commit's identity ("this is HEAD /
 * v2.1.0"), so it reads alongside the message/hash rather than down in the
 * containment section. Renders nothing when there are no tips.
 */
export function TipBadges({ data }: { data: ContainmentResponse | null }) {
  if (!data || data.tips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {data.tips.map((r) => (
        <Badge key={`tip:${r.kind}:${r.name}`} ref={r} />
      ))}
    </div>
  );
}

/**
 * A same-kind group rendered as a single wrapping row: the label + count sit
 * inline to the LEFT of the badges (rather than on their own line) to keep the
 * pane compact. Collapses to `COLLAPSED_LIMIT` badges behind a "+N" expander.
 */
function BadgeGroup({
  label,
  icon,
  refs,
}: {
  label: string;
  icon: React.ReactNode;
  refs: ContainingRef[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (refs.length === 0) return null;

  const shown = expanded ? refs : refs.slice(0, COLLAPSED_LIMIT);
  const hidden = refs.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* Inline label + count, min-width so badges roughly align across groups. */}
      <span className="flex items-center gap-1 text-[11px] text-[#8b949e] shrink-0 whitespace-nowrap min-w-[78px]">
        {icon}
        <span className="whitespace-nowrap">
          {label} ({refs.length})
        </span>
      </span>
      {shown.map((r) => (
        <Badge key={`${r.kind}:${r.name}`} ref={r} />
      ))}
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="px-1.5 py-0.5 rounded text-[11px] text-[#8b949e] border border-[#30363d] hover:border-[#58a6ff]/50 hover:text-[#e6edf3] transition-colors"
          title={`Show ${hidden} more`}
        >
          +{hidden}
        </button>
      )}
      {expanded && refs.length > COLLAPSED_LIMIT && (
        <button
          onClick={() => setExpanded(false)}
          className="px-1 py-0.5 rounded text-[11px] text-[#8b949e] border border-transparent hover:text-[#e6edf3] transition-colors"
        >
          less
        </button>
      )}
    </div>
  );
}

/**
 * "Contained in" section — the branches/tags/remotes whose history includes
 * this commit, grouped and collapsible. Tip refs are NOT rendered here (they
 * live in the header via `TipBadges`); the groups still include them so the
 * counts stay honest. Renders nothing when the commit is contained in no refs.
 */
export default function ContainmentSection({
  data,
}: {
  data: ContainmentResponse | null;
}) {
  const groups = useMemo(() => {
    const branches: ContainingRef[] = [];
    const remotes: ContainingRef[] = [];
    const tags: ContainingRef[] = [];
    if (data) {
      for (const r of data.contained_in) {
        if (r.kind === "tag") tags.push(r);
        else if (r.kind === "remotebranch") remotes.push(r);
        else branches.push(r);
      }
      // Default branch first, then alphabetical.
      branches.sort((a, b) =>
        a.is_default_branch === b.is_default_branch
          ? a.name.localeCompare(b.name)
          : a.is_default_branch
            ? -1
            : 1,
      );
      remotes.sort((a, b) => a.name.localeCompare(b.name));
      // Tags newest first (most recent release most relevant to "what's it in").
      tags.sort((a, b) => (b.tip_ts ?? 0) - (a.tip_ts ?? 0));
    }
    return { branches, remotes, tags };
  }, [data]);

  if (!data || data.contained_in.length === 0) return null;

  return (
    <div className="p-4 border-b border-[#30363d] shrink-0 flex flex-col gap-2">
      <div className="text-[11px] text-[#8b949e]">Contained in</div>
      {/* The "first released" tag is the one genuinely useful text summary;
          default-branch membership is already conveyed by the ●-marked green
          badge in the Branches row, so it's not repeated as text. */}
      {data.summary.earliest_tag && (
        <div className="text-xs text-[#e6edf3] flex items-center gap-1.5">
          <Tag size={12} className="text-yellow-400/80 shrink-0" />
          <span>first released {data.summary.earliest_tag}</span>
        </div>
      )}
      <BadgeGroup label="Tags" icon={<Tag size={11} />} refs={groups.tags} />
      <BadgeGroup
        label="Branches"
        icon={<GitBranch size={11} />}
        refs={groups.branches}
      />
      <BadgeGroup label="Remotes" icon={<Cloud size={11} />} refs={groups.remotes} />
    </div>
  );
}

import { useEffect, useState } from "react";
import { GitCommit, GitMerge, Loader2, ChevronRight, ChevronDown } from "lucide-react";
import { api, type CommitDetail, type DiffResponse, type IncludedCommit } from "../../api/client";
import ContainmentSection, {
  TipBadges,
  useContainment,
} from "./ContainmentSection";

interface CommitPanelProps {
  /** The commit OID whose metadata + changed files to show. */
  oid: string;
  /** Called when the user clicks a changed file (opens it in the diff view). */
  onSelectFile: (path: string) => void;
  /** Select another commit (e.g. clicking an "included in this merge" entry). */
  onSelectCommit?: (oid: string) => void;
}

/**
 * Right-pane view for a selected commit: shows author/committer/message
 * metadata and the list of files changed vs. its first parent. Fetches the
 * commit detail and diff for `oid`; clicking a file calls `onSelectFile`.
 *
 * For a merge commit it also fetches and offers the "included in this merge"
 * set — the commits brought in by the merged-in side(s), i.e.
 * `reachable(secondary parents) \ reachable(first parent)` computed exactly on
 * the server (window-independent). Shown as a collapsible list; each entry is
 * clickable to select that commit.
 */
export default function CommitPanel({ oid, onSelectFile, onSelectCommit }: CommitPanelProps) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Commits included in this merge" — fetched only for merge commits (≥ 2
  // parents), lazily. `null` = not loaded/not a merge; [] = merge with none.
  const [included, setIncluded] = useState<IncludedCommit[] | null>(null);
  const [includedOpen, setIncludedOpen] = useState(false);

  // Containment (tips + contained-in refs), fetched once and shared between the
  // header tip badges and the "Contained in" section below.
  const containment = useContainment(oid);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setCommit(null);
    setDiff(null);
    setIncluded(null);
    setIncludedOpen(false);

    Promise.all([api.commits.get(oid), api.diff.forCommit(oid)])
      .then(([c, d]) => {
        setCommit(c);
        setDiff(d);
        // Fetch the merged-in set only for merges; ignore failures (the rest of
        // the panel still renders).
        if (c.parents.length > 1) {
          api.commits
            .included(oid)
            .then(setIncluded)
            .catch(() => setIncluded([]));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load commit"))
      .finally(() => setLoading(false));
  }, [oid]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[#8b949e]">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-sm text-red-400">{error}</div>;
  }

  if (!commit || !diff) return null;

  const authorDate = new Date(commit.author.timestamp * 1000).toLocaleString();

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Commit header */}
      <div className="p-4 border-b border-[#30363d] shrink-0">
        {/* Metadata first: author/date/hash, then tip refs (identity info),
            then the log message below. */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#8b949e]">
          <span>
            <span className="text-[#e6edf3]">{commit.author.name}</span>
            {" <"}{commit.author.email}{">"}
          </span>
          <span>{authorDate}</span>
          <span className="font-mono">{commit.short_oid}</span>
        </div>
        {commit.parents.length > 1 && (
          <div className="mt-1">
            <div className="flex items-center gap-1 text-xs text-yellow-400">
              <GitMerge size={12} className="shrink-0" />
              Merge commit ({commit.parents.length} parents)
            </div>
            {/* "Commits included in this merge": the merged-in side(s), computed
                exactly on the server. Collapsible; each entry selects that
                commit. Hidden until loaded; when a merge brought in nothing new
                (already up to date) we still show a 0-count, disabled line. */}
            {included !== null && (
              <div className="mt-1.5">
                <button
                  onClick={() => setIncludedOpen((o) => !o)}
                  disabled={included.length === 0}
                  className={[
                    "flex items-center gap-1 text-xs transition-colors",
                    included.length === 0
                      ? "text-[#6e7681] cursor-default"
                      : "text-[#8b949e] hover:text-[#e6edf3]",
                  ].join(" ")}
                >
                  {included.length > 0 &&
                    (includedOpen ? (
                      <ChevronDown size={12} className="shrink-0" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0" />
                    ))}
                  Included {included.length} commit{included.length !== 1 ? "s" : ""}
                </button>
                {includedOpen && included.length > 0 && (
                  <div className="mt-1 max-h-44 overflow-auto rounded border border-[#30363d]">
                    {included.map((c) => (
                      <button
                        key={c.oid}
                        onClick={() => onSelectCommit?.(c.oid)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1 hover:bg-[#21262d] transition-colors"
                      >
                        <span className="font-mono text-[11px] text-[#8b949e] shrink-0">
                          {c.short_oid}
                        </span>
                        <span className="text-[11px] text-[#e6edf3] truncate">
                          {c.summary || "(no message)"}
                        </span>
                        <span className="ml-auto text-[10px] text-[#6e7681] truncate shrink-0 max-w-[90px]">
                          {c.author_name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Tip refs (branches/tags pointing exactly here) — part of the
            commit's identity, so shown near the top with the metadata. */}
        <TipBadges data={containment} />
        {/* Log message last. */}
        <div className="flex items-start gap-2 mt-3">
          <GitCommit size={16} className="text-[#8b949e] mt-0.5 shrink-0" />
          <p className="text-sm text-[#e6edf3] leading-snug whitespace-pre-wrap">
            {commit.message}
          </p>
        </div>
      </div>

      {/* "Contained in" branches/tags. Fetched independently (via useContainment)
          so it doesn't block the metadata/files. */}
      <ContainmentSection data={containment} />

      {/* Changed files list */}
      <div className="border-b border-[#30363d] shrink-0">
        <div className="px-4 py-1.5 text-xs text-[#8b949e]">
          {diff.stats.files_changed} file{diff.stats.files_changed !== 1 ? "s" : ""} changed
          {" "}
          <span className="text-green-400">+{diff.stats.additions}</span>
          {" "}
          <span className="text-red-400">−{diff.stats.deletions}</span>
        </div>
        <div className="max-h-40 overflow-auto">
          {diff.files.map((f) => {
            const color =
              f.status === "added" ? "text-green-400" :
              f.status === "deleted" ? "text-red-400" :
              f.status === "renamed" ? "text-yellow-400" :
              "text-[#e6edf3]";
            return (
              <button
                key={f.path}
                onClick={() => onSelectFile(f.path)}
                className="w-full text-left flex items-center gap-2 px-4 py-1 hover:bg-[#21262d] transition-colors"
              >
                <span className={`text-xs font-mono ${color} shrink-0 w-4`}>
                  {f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M"}
                </span>
                <span className="text-xs font-mono text-[#e6edf3] truncate">{f.path}</span>
                <span className="ml-auto flex gap-2 text-xs shrink-0">
                  <span className="text-green-400">+{f.additions}</span>
                  <span className="text-red-400">−{f.deletions}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { GitCommit, Loader2 } from "lucide-react";
import { api, type CommitDetail, type DiffResponse } from "../../api/client";

interface CommitPanelProps {
  /** The commit OID whose metadata + changed files to show. */
  oid: string;
  /** Called when the user clicks a changed file (opens it in the diff view). */
  onSelectFile: (path: string) => void;
}

/**
 * Right-pane view for a selected commit: shows author/committer/message
 * metadata and the list of files changed vs. its first parent. Fetches the
 * commit detail and diff for `oid`; clicking a file calls `onSelectFile`.
 */
export default function CommitPanel({ oid, onSelectFile }: CommitPanelProps) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setCommit(null);
    setDiff(null);

    Promise.all([api.commits.get(oid), api.diff.forCommit(oid)])
      .then(([c, d]) => {
        setCommit(c);
        setDiff(d);
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
        <div className="flex items-start gap-2 mb-2">
          <GitCommit size={16} className="text-[#8b949e] mt-0.5 shrink-0" />
          <p className="text-sm text-[#e6edf3] leading-snug whitespace-pre-wrap">
            {commit.message}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#8b949e] ml-6">
          <span>
            <span className="text-[#e6edf3]">{commit.author.name}</span>
            {" <"}{commit.author.email}{">"}
          </span>
          <span>{authorDate}</span>
          <span className="font-mono">{commit.short_oid}</span>
        </div>
        {commit.parents.length > 1 && (
          <div className="ml-6 mt-1 text-xs text-yellow-400">
            Merge commit ({commit.parents.length} parents)
          </div>
        )}
      </div>

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

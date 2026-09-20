import type { DiffResponse, FileDiff, Hunk } from "../../api/client";

interface DiffViewerProps {
  /** A parsed diff (from any of the /diff endpoints: commit, working, staged, stash). */
  diff: DiffResponse;
}

/** One row of a unified diff: old/new line numbers + the +/-/context line,
 *  color-coded by origin (green add, red delete, grey context). */
function DiffLineRow({ origin, content, oldLineno, newLineno }: {
  origin: string;
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}) {
  const bg =
    origin === "+" ? "bg-green-950/40" :
    origin === "-" ? "bg-red-950/40" :
    "";
  const text =
    origin === "+" ? "text-green-300" :
    origin === "-" ? "text-red-400" :
    "text-[#8b949e]";

  return (
    <tr className={`${bg} font-mono text-xs leading-5`}>
      <td className="px-2 text-right text-[#8b949e] select-none w-10 border-r border-[#30363d]">
        {oldLineno ?? ""}
      </td>
      <td className="px-2 text-right text-[#8b949e] select-none w-10 border-r border-[#30363d]">
        {newLineno ?? ""}
      </td>
      <td className={`pl-2 pr-4 whitespace-pre ${text}`}>
        <span className="select-none mr-1">{origin === "+" || origin === "-" ? origin : " "}</span>
        {content}
      </td>
    </tr>
  );
}

/** A single diff hunk: its `@@ ... @@` header row followed by its lines. */
function HunkView({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="px-3 py-0.5 text-xs font-mono text-[#8b949e] bg-blue-950/20 border-y border-[#30363d]">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((line, i) => (
        <DiffLineRow
          key={i}
          origin={line.origin}
          content={line.content}
          oldLineno={line.old_lineno}
          newLineno={line.new_lineno}
        />
      ))}
    </>
  );
}

/** One file's diff: a header (status, path/rename, +/- counts) and either a
 *  "Binary file" note or the file's hunks rendered as a line table. */
function FileDiffView({ file }: { file: FileDiff }) {
  const statusColor =
    file.status === "added" ? "text-green-400" :
    file.status === "deleted" ? "text-red-400" :
    file.status === "renamed" ? "text-yellow-400" :
    "text-[#8b949e]";

  return (
    <div className="mb-4 border border-[#30363d] rounded-md overflow-hidden">
      {/* File header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#161b22] border-b border-[#30363d]">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold uppercase ${statusColor}`}>
            {file.status}
          </span>
          <span className="text-sm font-mono text-[#e6edf3]">
            {file.old_path && file.old_path !== file.path
              ? `${file.old_path} → ${file.path}`
              : file.path}
          </span>
        </div>
        {!file.is_binary && (
          <div className="flex gap-3 text-xs">
            <span className="text-green-400">+{file.additions}</span>
            <span className="text-red-400">−{file.deletions}</span>
          </div>
        )}
      </div>

      {file.is_binary ? (
        <div className="px-3 py-2 text-xs text-[#8b949e] italic">Binary file</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <tbody>
              {file.hunks.map((hunk, i) => (
                <HunkView key={i} hunk={hunk} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Renders a unified diff: a stats summary (files changed, +/−) followed by each
 * changed file. Purely presentational — the caller supplies the `DiffResponse`,
 * so the same component serves commit, working-tree, staged, and stash diffs.
 */
export default function DiffViewer({ diff }: DiffViewerProps) {
  return (
    <div className="flex flex-col h-full overflow-auto p-4">
      {/* Stats bar */}
      <div className="flex gap-4 text-sm mb-4 text-[#8b949e]">
        <span>{diff.stats.files_changed} file{diff.stats.files_changed !== 1 ? "s" : ""} changed</span>
        <span className="text-green-400">+{diff.stats.additions}</span>
        <span className="text-red-400">−{diff.stats.deletions}</span>
      </div>

      {diff.files.map((file) => (
        <FileDiffView key={file.path} file={file} />
      ))}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from "react";
import { GitBranch, Search, FolderOpen, Loader2, AlertCircle, GitCommit } from "lucide-react";
import { api, type GraphResponse, type TreeResponse, type StatusSummary } from "./api/client";
import { isTauri, pickDirectory, onFolderDrop } from "./lib/tauri";
import { useLiveUpdates } from "./lib/useLiveUpdates";
import CommitGraph, {
  isWorkingId,
  isStashId,
  stashIndexFromId,
} from "./features/graph/CommitGraph";
import CommitPanel from "./features/commit/CommitPanel";
import DiffViewer from "./features/diff/DiffViewer";
import FileBrowser from "./features/tree/FileBrowser";
import FileViewer from "./features/tree/FileViewer";
import SearchPanel from "./features/search/SearchPanel";
import { WorkingPanel, StashPanel } from "./features/working/WorkingPanel";

type RightPanel = "commit" | "diff" | "tree" | "search";

export default function App() {
  const [repoPath, setRepoPath] = useState<string>("");
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [openingRepo, setOpeningRepo] = useState(false);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  // When true, show the repo picker even if a repo is already open (used by "Change repo").
  const [showPicker, setShowPicker] = useState(false);
  // Native folder drag-and-drop hover state (Tauri only).
  const [dragOver, setDragOver] = useState(false);
  const tauri = isTauri();

  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusSummary | null>(null);

  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<RightPanel>("commit");

  const [treeData, setTreeData] = useState<TreeResponse | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  async function openRepo(path?: string) {
    const target = path ?? repoPath.trim();
    if (!target) return;
    setOpeningRepo(true);
    setRepoError(null);
    try {
      await api.repo.open(target);
      setRepoOpen(true);
      setShowPicker(false);
      setSelectedOid(null);
      setSelectedFilePath(null);
      setRepoPath(target);
      // Refresh the recent list so the just-opened repo moves to the front.
      api.repo.recent().then(setRecentRepos).catch(() => {});
      loadGraph();
    } catch (e) {
      setRepoError(e instanceof Error ? e.message : "Failed to open repository");
    } finally {
      setOpeningRepo(false);
    }
  }

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const g = await api.graph.get({ limit: 500 });
      setGraph(g);
      if (g.nodes.length > 0) {
        setSelectedOid(g.nodes[0].oid);
      }
      // Working/staged/stash status drives the pseudo-nodes. Non-fatal if it fails.
      api.status.get().then(setStatus).catch(() => setStatus(null));
    } catch (e) {
      setGraphError(e instanceof Error ? e.message : "Failed to load graph");
    } finally {
      setGraphLoading(false);
    }
  }, []);

  // Seamless refresh for live updates: re-fetch graph + status WITHOUT showing
  // the loading spinner or resetting the current selection, so the view updates
  // in place when the repo changes on disk.
  const refreshGraph = useCallback(async () => {
    try {
      const g = await api.graph.get({ limit: 500 });
      setGraph(g);
      // Keep the current selection if it still exists; otherwise fall back to
      // the newest commit (only when nothing is selected).
      setSelectedOid((prev) =>
        prev && g.nodes.some((n) => n.oid === prev)
          ? prev
          : prev ?? (g.nodes[0]?.oid ?? null),
      );
      api.status.get().then(setStatus).catch(() => setStatus(null));
    } catch {
      // Non-fatal: a transient failure shouldn't disrupt the current view.
    }
  }, []);

  // Load recent repos and auto-open last repo on startup
  useEffect(() => {
    api.repo.recent().then((recent) => {
      setRecentRepos(recent);
      api.repo.get().then((info) => {
        setRepoPath(info.path);
        setRepoOpen(true);
        loadGraph();
      }).catch(() => {
        if (recent.length > 0) setRepoPath(recent[0]);
      });
    }).catch(() => {});
  }, [loadGraph]);

  // Native folder drag-and-drop (Tauri only): dropping a folder anywhere opens
  // it as the repo. No-ops in the browser.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onFolderDrop(
      (path) => {
        setDragOver(false);
        setRepoPath(path);
        openRepo(path);
      },
      () => setDragOver(true),
      () => setDragOver(false),
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // openRepo is stable enough for this purpose; we intentionally subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates: refresh the graph/status when the repo changes on disk.
  // The callback checks repoOpen via a ref so we don't refetch before a repo
  // is opened. The hook itself subscribes once and auto-reconnects.
  const repoOpenRef = useRef(repoOpen);
  repoOpenRef.current = repoOpen;
  useLiveUpdates(() => {
    if (repoOpenRef.current) refreshGraph();
  });

  const handleSelectCommit = useCallback((oid: string) => {
    setSelectedOid(oid);
    // Special pseudo-nodes (working tree, stashes) are not commits — don't try
    // to fetch commit detail or a tree for them; their panels fetch their own data.
    if (isWorkingId(oid) || isStashId(oid)) {
      return;
    }
    setActivePanel("commit");
    // Load tree for this commit
    api.tree.list(oid).then(setTreeData).catch(() => {});
  }, []);

  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedFilePath(path);
    setActivePanel("diff");
  }, []);

  // Files-tab file click: show the file's CONTENTS (not a diff), staying on the
  // Files tab. Separate from handleSelectFile (used by the commit panel), which
  // shows the diff for a changed file.
  const [contentsPath, setContentsPath] = useState<string | null>(null);
  const handleSelectFileContents = useCallback((path: string) => {
    setContentsPath(path);
  }, []);

  function handleRepoKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") openRepo();
  }

  if (!repoOpen || showPicker) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0d1117]">
        <div
          className={[
            "w-full max-w-md px-6 py-6 rounded-lg transition-colors",
            dragOver ? "ring-2 ring-blue-400 bg-blue-950/10" : "",
          ].join(" ")}
        >
          <div className="flex items-center gap-3 mb-8">
            <GitBranch size={32} className="text-blue-400" />
            <h1 className="text-2xl font-semibold text-[#e6edf3]">git-atlas</h1>
          </div>
          <p className="text-[#8b949e] mb-4 text-sm">
            {dragOver
              ? "Drop the folder to open it…"
              : showPicker
                ? "Open a different git repository."
                : "Enter the path to a local git repository to get started."}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              onKeyDown={handleRepoKeyDown}
              placeholder="/path/to/your/repo"
              className="flex-1 bg-[#161b22] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#e6edf3] placeholder:text-[#8b949e] outline-none focus:border-blue-500/60"
            />
            <button
              onClick={() => openRepo()}
              disabled={openingRepo || !repoPath.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors flex items-center gap-2"
            >
              {openingRepo ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              Open
            </button>
            {tauri && (
              <button
                onClick={async () => {
                  const picked = await pickDirectory();
                  if (picked) {
                    setRepoPath(picked);
                    openRepo(picked);
                  }
                }}
                disabled={openingRepo}
                className="px-3 py-2 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-50 text-[#e6edf3] text-sm rounded-md border border-[#30363d] transition-colors flex items-center gap-2"
                title="Browse for a folder"
              >
                Browse…
              </button>
            )}
          </div>
          {repoError && (
            <div className="flex items-center gap-2 mt-3 text-sm text-red-400">
              <AlertCircle size={14} />
              {repoError}
            </div>
          )}

          {/* Recent repos */}
          {recentRepos.length > 0 && (
            <div className="mt-6">
              <p className="text-xs text-[#8b949e] mb-2">Recent</p>
              <div className="border border-[#30363d] rounded-md overflow-hidden">
                {recentRepos.map((path) => (
                  <button
                    key={path}
                    onClick={() => openRepo(path)}
                    className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] border-b border-[#30363d] last:border-0 transition-colors font-mono truncate"
                  >
                    {path}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Cancel — only when reopening over an already-open repo */}
          {showPicker && repoOpen && (
            <button
              onClick={() => {
                setShowPicker(false);
                setRepoError(null);
              }}
              className="mt-6 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            >
              ← Back to current repository
            </button>
          )}

          {/* Runtime hint */}
          <p className="mt-6 text-[11px] text-[#6e7681]">
            {tauri
              ? "Tip: drag a folder onto the window, or use Browse…"
              : "Tip: type or paste an absolute path. The native folder picker and drag-and-drop are available in the desktop app."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-[#e6edf3]">
      {/* Folder drag-and-drop overlay (Tauri) */}
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0d1117]/80 backdrop-blur-sm pointer-events-none">
          <div className="flex items-center gap-3 px-6 py-4 rounded-lg border-2 border-dashed border-blue-400 bg-[#161b22]">
            <FolderOpen size={20} className="text-blue-400" />
            <span className="text-sm text-[#e6edf3]">Drop folder to open repository</span>
          </div>
        </div>
      )}
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 h-10 border-b border-[#30363d] shrink-0 bg-[#161b22]">
        <GitBranch size={16} className="text-blue-400" />
        <span className="text-sm font-semibold text-[#e6edf3]">git-atlas</span>
        <span className="text-[#8b949e] text-xs font-mono truncate">{repoPath}</span>
        <button
          onClick={() => {
            api.repo.recent().then(setRecentRepos).catch(() => {});
            setShowPicker(true);
          }}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] hover:border-[#58a6ff]/50 rounded-md transition-colors shrink-0"
          title="Open a different repository"
        >
          <FolderOpen size={13} />
          Change repo
        </button>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left: commit graph */}
        <div className="flex flex-col w-[55%] min-w-0 border-r border-[#30363d]">
          {graphLoading ? (
            <div className="flex items-center justify-center h-full text-[#8b949e]">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading graph…
            </div>
          ) : graphError ? (
            <div className="flex items-center justify-center h-full text-red-400 text-sm gap-2">
              <AlertCircle size={16} /> {graphError}
            </div>
          ) : graph ? (
            <CommitGraph
              graph={graph}
              status={status}
              selectedOid={selectedOid}
              onSelectCommit={handleSelectCommit}
            />
          ) : null}
        </div>

        {/* Right: detail panels */}
        <div className="flex flex-col w-[45%] min-w-0">
          {selectedOid && isWorkingId(selectedOid) ? (
            <>
              <div className="flex items-center gap-2 px-4 h-9 border-b border-[#30363d] bg-[#161b22] shrink-0">
                <span className="text-xs font-semibold text-emerald-300">Working tree</span>
                <span className="text-[10px] text-[#8b949e]">uncommitted changes</span>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <WorkingPanel />
              </div>
            </>
          ) : selectedOid && isStashId(selectedOid) ? (
            <>
              <div className="flex items-center gap-2 px-4 h-9 border-b border-[#30363d] bg-[#161b22] shrink-0">
                <span className="text-xs font-semibold text-amber-300">
                  stash@{`{${stashIndexFromId(selectedOid)}}`}
                </span>
                <span className="text-[10px] text-[#8b949e]">stashed changes</span>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <StashPanel index={stashIndexFromId(selectedOid)} />
              </div>
            </>
          ) : (
            <>
              {/* Panel tab bar */}
              <div className="flex border-b border-[#30363d] bg-[#161b22] shrink-0">
                {(["commit", "diff", "tree", "search"] as RightPanel[]).map((panel) => {
                  const icons: Record<RightPanel, React.ReactNode> = {
                    commit: <GitCommit size={13} />,
                    diff: <span className="text-[10px] font-mono">±</span>,
                    tree: <FolderOpen size={13} />,
                    search: <Search size={13} />,
                  };
                  const labels: Record<RightPanel, string> = {
                    commit: "Commit",
                    diff: "Diff",
                    tree: "Files",
                    search: "Search",
                  };
                  return (
                    <button
                      key={panel}
                      onClick={() => setActivePanel(panel)}
                      className={[
                        "flex items-center gap-1.5 px-4 py-2 text-xs border-b-2 transition-colors",
                        activePanel === panel
                          ? "border-blue-400 text-blue-400"
                          : "border-transparent text-[#8b949e] hover:text-[#e6edf3]",
                      ].join(" ")}
                    >
                      {icons[panel]}
                      {labels[panel]}
                    </button>
                  );
                })}
              </div>

              {/* Panel content */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {activePanel === "commit" && selectedOid && (
                  <CommitPanel oid={selectedOid} onSelectFile={handleSelectFile} />
                )}
                {activePanel === "diff" && selectedOid && (
                  <DiffViewerWrapper oid={selectedOid} filePath={selectedFilePath} />
                )}
                {activePanel === "tree" && selectedOid && treeData && (
                  <div className="flex flex-col h-full min-h-0">
                    <div className="flex-1 min-h-0 overflow-auto border-b border-[#30363d]">
                      <FileBrowser
                        entries={treeData.entries}
                        onSelectFile={handleSelectFileContents}
                        selectedPath={contentsPath}
                      />
                    </div>
                    <div className="flex-1 min-h-0">
                      {contentsPath ? (
                        <FileViewer oid={selectedOid} path={contentsPath} />
                      ) : (
                        <div className="flex items-center justify-center h-full text-xs text-[#8b949e]">
                          Select a file to view its contents
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {activePanel === "search" && (
                  <SearchPanel
                    commitOid={selectedOid}
                    onSelectFile={handleSelectFile}
                  />
                )}
                {!selectedOid && activePanel !== "search" && (
                  <div className="flex items-center justify-center h-full text-sm text-[#8b949e]">
                    Select a commit in the graph
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Loads and displays diff for a commit, optionally filtered to a single file */
function DiffViewerWrapper({ oid, filePath }: { oid: string; filePath: string | null }) {
  const [diff, setDiff] = useState<import("./api/client").DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.diff.forCommit(oid)
      .then((d) => {
        if (filePath) {
          setDiff({ ...d, files: d.files.filter((f) => f.path === filePath) });
        } else {
          setDiff(d);
        }
      })
      .finally(() => setLoading(false));
  }, [oid, filePath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[#8b949e]">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  if (!diff) return null;
  return <DiffViewer diff={diff} />;
}

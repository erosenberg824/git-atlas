/**
 * HTTP client for the git-atlas Rust backend.
 *
 * In development: Vite proxies /api/* to the Rust server (port resolved from
 * lockfile or ATLAS_PORT env var). The frontend never needs to know the port.
 *
 * In Tauri (production): requests go directly to the embedded server. The
 * base URL is resolved from the Tauri `get_server_port` command.
 */

let baseUrl: string | null = null;

/**
 * Default max commits fetched into a single graph view. The server caps at this
 * when no `limit` is passed; the client passes it explicitly at every graph
 * fetch so there's ONE knob (not four drifting call sites + a separate server
 * default).
 *
 * This is a SAFETY CAP, not a target: the graph is meant to stay readable via
 * aggressive default collapse (a large linear history folds to far fewer
 * rendered nodes), and the time scrubber / branch scoping are how you reach
 * commits beyond the cap. Raising it mainly loosens the ceiling for the "show
 * me everything" case; the collapse seed passes are O(N+E) so the cost of a
 * larger fetch is bounded. When a window/scope has more commits than this, the
 * overflow is reported as `hidden_count` and surfaced in the window banner.
 */
export const GRAPH_NODE_LIMIT = 500;

/** Detect the Tauri runtime without importing the API (which throws in a browser). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getBaseUrl(): Promise<string> {
  if (baseUrl !== null) return baseUrl;

  // Browser / dev: no Tauri runtime → use a relative path so Vite's proxy
  // forwards /api/* to the server. Cache it; it never changes.
  if (!inTauri()) {
    baseUrl = "";
    return baseUrl;
  }

  // Tauri (packaged): the webview talks directly to the sidecar server, so we
  // need its real port. On a cold launch the sidecar may not have printed its
  // port yet, so `get_server_port` can return null for a moment — poll until it
  // is available rather than caching an empty base URL (which would make every
  // request fail permanently with "Load failed").
  const { invoke } = await import("@tauri-apps/api/core");
  const maxAttempts = 50; // ~10s at 200ms
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const port = await invoke<number | null>("get_server_port");
      if (port) {
        baseUrl = `http://localhost:${port}`;
        return baseUrl;
      }
    } catch {
      // ignore and retry
    }
    await sleep(200);
  }
  // Give up after the window: fall back to relative (last resort). Do NOT cache
  // so a later call can still succeed if the server comes up late.
  return "";
}

async function get<T>(path: string): Promise<T> {
  const base = await getBaseUrl();
  const res = await fetch(`${base}/api/v1${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const base = await getBaseUrl();
  const res = await fetch(`${base}/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepoInfo {
  path: string;
  head: string | null;
  is_bare: boolean;
}

export interface CommitNode {
  oid: string;
  short_oid: string;
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parents: string[];
}

export interface CommitEdge {
  source: string;
  target: string;
}

export interface RefLabel {
  name: string;
  oid: string;
  kind: "branch" | "remotebranch" | "tag" | "head";
  is_head: boolean;
  tip_ts: number | null;
}

export interface GraphResponse {
  nodes: CommitNode[];
  edges: CommitEdge[];
  refs: RefLabel[];
  /** Visible-branch commits older than the window's start (hidden below). */
  before_count: number;
  /** Visible-branch commits newer than the window's end (hidden above). */
  after_count: number;
  /** In-window commits dropped because the node limit was reached. Non-zero
   *  even with no time filter — makes the total correct on full-history views
   *  that exceed the limit. */
  hidden_count: number;
}

export interface TimeBounds {
  newest_ts: number | null;
  oldest_ts: number | null;
  count: number;
}

export interface Signature {
  name: string;
  email: string;
  timestamp: number;
}

export interface CommitDetail {
  oid: string;
  short_oid: string;
  message: string;
  author: Signature;
  committer: Signature;
  parents: string[];
  tree_oid: string;
}

export interface DiffLine {
  origin: string;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  is_binary: boolean;
}

export interface DiffStats {
  files_changed: number;
  additions: number;
  deletions: number;
}

export interface DiffResponse {
  files: FileDiff[];
  stats: DiffStats;
}

export interface StashEntry {
  index: number;
  message: string;
  oid: string;
  base_oid: string | null;
}

export interface StatusSummary {
  staged_count: number;
  unstaged_count: number;
  is_dirty: boolean;
  stashes: StashEntry[];
}

export interface TreeEntry {
  path: string;
  kind: "blob" | "tree" | "symlink" | "commit";
  size: number | null;
  oid: string;
}

export interface TreeResponse {
  commit_oid: string;
  entries: TreeEntry[];
}

export interface BlobResponse {
  path: string;
  content: string;
  size: number;
  is_binary: boolean;
}

export interface SearchResult {
  path: string;
  score: number;
  snippets: string[];
}

export interface SearchResponse {
  query: string;
  commit_oid: string;
  results: SearchResult[];
}

export interface PrSummary {
  id: number;
  title: string;
  state: string;
  author: string;
  source_branch: string;
  destination_branch: string;
  url: string;
  tip_oid: string | null;
}

// ─── API calls ───────────────────────────────────────────────────────────────

export const api = {
  repo: {
    open: (path: string) => post<RepoInfo>("/repo", { path }),
    get: () => get<RepoInfo>("/repo"),
    recent: () => get<string[]>("/repo/recent"),
  },
  graph: {
    get: (params?: { limit?: number; start?: string; since?: number; until?: number; refs?: string[] }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.start) q.set("start", params.start);
      if (params?.since != null) q.set("since", String(params.since));
      if (params?.until != null) q.set("until", String(params.until));
      if (params?.refs && params.refs.length > 0) q.set("refs", params.refs.join(","));
      return get<GraphResponse>(`/graph?${q}`);
    },
    timeBounds: () => get<TimeBounds>("/timebounds"),
  },
  commits: {
    get: (oid: string) => get<CommitDetail>(`/commits/${oid}`),
  },
  diff: {
    forCommit: (oid: string) => get<DiffResponse>(`/diff/${oid}`),
    between: (base: string, target: string, path?: string) => {
      const q = new URLSearchParams({ base, target });
      if (path) q.set("path", path);
      return get<DiffResponse>(`/diff?${q}`);
    },
    working: () => get<DiffResponse>("/diff/working"),
    staged: () => get<DiffResponse>("/diff/staged"),
    stash: (index: number) => get<DiffResponse>(`/diff/stash/${index}`),
  },
  status: {
    get: () => get<StatusSummary>("/status"),
  },
  tree: {
    list: (oid: string) => get<TreeResponse>(`/tree/${oid}`),
    blob: (oid: string, path: string) =>
      get<BlobResponse>(`/tree/${oid}/blob?path=${encodeURIComponent(path)}`),
  },
  search: {
    query: (q: string, commit?: string, limit?: number) => {
      const params = new URLSearchParams({ q });
      if (commit) params.set("commit", commit);
      if (limit) params.set("limit", String(limit));
      return get<SearchResponse>(`/search?${params}`);
    },
    buildIndex: (commit?: string) =>
      post<{ status: string; commit_oid: string }>("/search/index", { commit }),
  },
  forge: {
    listPrs: (state?: string) => {
      const q = new URLSearchParams();
      if (state) q.set("state", state);
      return get<PrSummary[]>(`/forge/prs?${q}`);
    },
  },
};

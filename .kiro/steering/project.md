# git-atlas — Project Steering

## What this project is

A local-first desktop tool for visualising and searching git repositories. The primary UI is an interactive directed acyclic graph (DAG) of commits, similar to graph database UIs. Users can browse commit history, inspect diffs and file contents at any commit, and full-text search file contents across the repository at any point in history.

## Architecture

```
Tauri shell (Mac/Win/Linux)
  └── launches Rust HTTP server as sidecar (release) or separately (dev)
       └── git2 (libgit2 bindings) — all git operations
       └── tantivy — full-text search index per commit tree
       └── reqwest — forge API calls (Bitbucket/GitHub/GitLab)
  └── WebView pointing at localhost HTTP server
       └── React + TypeScript + Tailwind v4 + React Flow
```

The Rust server is also runnable standalone (`git-atlas`) for WSL users or browser-only access. This is intentional — the Tauri shell is a wrapper, not a requirement. The standalone binary **embeds and serves the built web UI** (via `rust-embed`), so a browser pointed at `http://localhost:PORT` gets the full app with no Vite/dev server. The desktop app bundles `git-atlas` as a Tauri **sidecar** (spawns it, discovers its port from stdout, kills it on exit).

## Key decisions and rationale

**No authentication on localhost.** The server binds to 127.0.0.1 only. Auth was explicitly deferred — do not add it without discussion.

**git2 with vendored-libgit2, SSH disabled.** SSH support was disabled to avoid the openssl-sys dependency (no system OpenSSL required). The tool only reads repos, never pushes/clones over SSH, so this is fine.

**reqwest with rustls-tls, no OpenSSL.** Same reason — keeps the build self-contained, no Homebrew/pkgconf required on macOS.

**Rust 1.88.0 pinned in mise.toml.** This is the minimum that satisfies all transitive dependency requirements (encoding_rs, icu crates, time require 1.88).

**git2::Repository is !Send.** All git operations must run inside `tokio::task::spawn_blocking`. Never hold a `git2::Repository` across an `.await` point. This pattern is used throughout `server/src/routes/`.

**Tantivy indexes are per-commit, in-memory, cached by commit OID.** The cache lives in `AppState.inner.index_cache`. Indexes are built on demand when a search or index request arrives for a commit not yet cached.

**API versioned at /api/v1/.** All routes are under this prefix. Do not add unversioned routes.

**VSCode extension and Bitbucket plugin are low-priority future concerns.** Do not make architectural decisions to accommodate them.

**Single repo per instance.** Multiple repos = multiple app instances. Do not add multi-repo support to the server. Multiple *views* (a browser tab + the desktop app) can point at one server, but they share its single open repo.

**Standalone server embeds the UI (`rust-embed`).** `server/src/static_assets.rs` embeds `ui/dist` and serves it as a fallback under all non-`/api/v1` routes (SPA fallback to `index.html`). This makes `git-atlas` a single self-contained binary — the primary path for WSL/browser users. Build order matters: `ui/dist` must be built before the server (see `scripts/prepare-sidecar.sh`).

**Sidecar port discovery via stdout, not the lockfile.** The desktop app spawns the server with `ATLAS_NO_LOCKFILE=1` and reads the bound port from the server's stdout line `ATLAS_LISTENING_PORT=<port>`. It does NOT read the shared `server.port` lockfile (that would let instances collide / attach to a stale port). The lockfile remains only for the standalone-server + browser convenience.

**Live updates via filesystem watcher + WebSocket.** `server/src/watcher.rs` watches the open repo's `.git` (debounced), broadcasting on a `tokio::broadcast` channel; `GET /api/v1/events` is a WebSocket forwarding `{"type":"repo-changed"}`. The client (`ui/src/lib/useLiveUpdates.ts`) re-fetches graph + status per event. Core requirement — keep it working when adding graph features.

**Graph traversal seeds from all refs.** `build_graph` uses `push_glob("refs/*")` (not just HEAD) so commits from any branch/tag/remote appear; it drops edges whose endpoints fall outside the returned node set (dangling edges break React Flow); refs are peeled with `peel_to_commit` so annotated tags attach correctly.

## Project structure

```
git-atlas/
├── mise.toml                        # Tool versions (Rust 1.88.0, Node 22.19.0) + dev tasks
├── Cargo.toml                       # Workspace root
├── scripts/prepare-sidecar.sh       # Builds ui/dist + release server, stages the sidecar binary
├── server/src/
│   ├── main.rs                      # Entry: --help/--version, sidecar detection, browser open, startup
│   ├── config.rs                    # AppConfig, env vars (ATLAS_*), CLI repo-path arg, lockfile, data dir
│   ├── error.rs                     # AppError enum, IntoResponse impl
│   ├── state.rs                     # AppState (repo_path RwLock, index_cache, events broadcast, watch handle)
│   ├── static_assets.rs             # Embedded ui/dist (rust-embed) + SPA fallback handler
│   ├── watcher.rs                   # notify-based .git watcher → debounced RepoChanged broadcast
│   ├── git/
│   │   ├── mod.rs                   # resolve_ref() helper
│   │   ├── graph.rs                 # DAG traversal (all refs), lane data, ref collection, time_bounds
│   │   ├── commits.rs               # CommitDetail struct and getter
│   │   ├── diff.rs                  # FileDiff/Hunk/DiffLine; commit/two-commit/working/staged/stash diffs; status
│   │   └── tree.rs                  # TreeEntry, BlobResponse; list_tree, get_blob_at_commit
│   ├── search/mod.rs                # Tantivy index build + query; IndexCache type
│   ├── forge/
│   │   ├── mod.rs                   # Module root
│   │   └── bitbucket.rs             # Bitbucket Cloud REST API v2.0 client (stub)
│   └── routes/
│       ├── mod.rs                   # build_router(), all routes + static fallback registered here
│       ├── repo.rs                  # POST/GET /repo, /repo/recent, /status
│       ├── graph.rs                 # GET /graph (limit/start/since/until), /timebounds
│       ├── commits.rs               # GET /commits/:oid
│       ├── diff.rs                  # /diff/:oid, /diff?base=&target=, /diff/working|staged|stash/:index
│       ├── tree.rs                  # GET /tree/:oid and /tree/:oid/blob
│       ├── search.rs                # GET /search and POST /search/index
│       ├── forge.rs                 # POST /forge/config and GET /forge/prs
│       └── events.rs                # GET /events — live-update WebSocket
└── ui/
    ├── src/
    │   ├── api/client.ts            # Typed HTTP client for all API routes
    │   ├── App.tsx                  # Root layout: time scrubber + graph (left) + tabbed panels (right)
    │   ├── lib/
    │   │   ├── tauri.ts             # isTauri(), native folder picker + drag-drop (Tauri-only)
    │   │   └── useLiveUpdates.ts    # WebSocket subscription → debounced graph/status refresh
    │   └── features/
    │       ├── graph/
    │       │   ├── CommitGraph.tsx           # React Flow DAG, lane layout, collapse integration
    │       │   ├── CommitNodeComponent.tsx   # Commit node: hash, summary, author, ref/tag badges
    │       │   ├── SpecialNodeComponent.tsx  # Working-tree + stash pseudo-nodes
    │       │   ├── RunNodeComponent.tsx      # Collapsed linear-run summary node
    │       │   ├── collapse.ts               # Detect/fold linear runs (pure client transform)
    │       │   └── TimeScrubber.tsx          # Vertical time-window scrubber (pan/zoom)
    │       ├── commit/CommitPanel.tsx        # Commit metadata + changed files list
    │       ├── diff/DiffViewer.tsx           # Unified diff: hunks, line numbers, +/- highlighting
    │       ├── tree/FileBrowser.tsx          # Recursive file tree built from flat path list
    │       ├── tree/fileTree.ts              # Pure tree-building/sort/format helpers (unit-tested)
    │       ├── tree/FileViewer.tsx           # File contents (blob) viewer for the Files tab
    │       ├── working/WorkingPanel.tsx      # Working/staged sections + stash diff panels
    │       └── search/SearchPanel.tsx        # Full-text search input + results
    └── src-tauri/
        ├── src/lib.rs               # Sidecar spawn + port discovery (stdout), get_server_port, dialog
        ├── src/logging.rs           # Shared multi-instance log (flock rotation)
        ├── capabilities/default.json # Shell (sidecar) + dialog permissions
        └── tauri.conf.json          # App config: product git-atlas, externalBin sidecar, 1400x900

```

## Development workflow

```bash
# Install tools
mise install
cd ui && npm install && cd ..

# Dev: run in two terminals
cargo run --bin git-atlas          # Terminal 1
cd ui && npm run dev                       # Terminal 2 → http://localhost:1420

# Or full Tauri dev app
cd ui && npm run tauri dev
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ATLAS_PORT` | `0` (random) | Server port |
| `ATLAS_REPO_PATH` | — | Repo to open on startup |
| `ATLAS_DATA_DIR` | platform default | Indexes + lockfile location |
| `RUST_LOG` | `git_atlas=debug` | Log level |

## Code conventions

- Rust: errors use `thiserror` (`AppError` enum in `error.rs`). Route handlers return `ApiResult<Json<T>>`.
- All git operations in route handlers go inside `tokio::task::spawn_blocking` — never hold `git2::Repository` across `.await`.
- TypeScript: strict mode, no `any`. API types live in `src/api/client.ts` and are imported from there.
- Tailwind v4 (no config file — uses CSS `@import "tailwindcss"`). Dark theme with CSS custom properties in `index.css`.
- React Flow node data is typed as `unknown` then cast with `as unknown as MyType` due to React Flow's generic constraints.

## Testing

The project has a real test suite; keep it green and extend it when changing logic.

**What to test (priority order):**
- **Server git/graph logic** (`server/src/git/graph.rs`) — the highest-value, trickiest code: `build_graph` (all-refs seeding, dangling-edge dropping, `since`/`until` window + `before_count`/`after_count`, ref-scoping), tag peeling, `time_bounds`. Test against **real temp repos** built with `git2` (see the `temp_repo`/`commit` helpers in the `#[cfg(test)] mod tests` there) — deterministic, no network, cleaned up after.
- **Other server git modules** — `diff.rs` (status classification add/modify/delete, addition/deletion counts, two-commit + path filter, staged vs working incl. untracked, unborn-HEAD staged diff, `status_summary` dirty flag, stash list + `diff_stash`), `tree.rs` (recursive `list_tree` with nested `a/b/c` paths, blob-only sizing, binary blob → empty content, not-found errors), `commits.rs` (`get_commit_detail` signature/message/parents/tree_oid, ref resolution, not-found), and `containment.rs`. All use the same real-temp-repo pattern as `graph.rs`.
- **Pure frontend algorithms** — `collapse.ts` (`detectRuns`, `detectBranchRollups`, `applyCollapse`, merge/region folding), `assignLanes` + `computeWorkingPlacement` (exported from `CommitGraph.tsx`: tight packing, trunk-in-lane-0, merge first-parent lane, working-node non-overlap), `branches.ts` (`defaultVisibility`, `shownBranchNames`), `refBadge.ts` (`refBadgeColor`, `refBadgeClass`), `fileTree.ts` (`buildTree`, `compareTreeNodes`/`sortedTreeNodes`, `formatSize` — flat path list → nested tree, dirs-first sort), and `isSearchDisabled` (from `SearchPanel.tsx`). These are pure functions — unit-test them directly, no DOM.
- **Not (yet) tested:** React components / DOM and the app shell — verified via build + manual for now. Prefer extracting pure logic out of components so it can be unit-tested (as with `assignLanes`, `collapse.ts`).

**Coverage scope (important — read before judging the number):** `ui/vitest.config.ts` sets `coverage.include` to *only* the pure-logic `.ts` modules we unit-test (`collapse.ts`, `branches.ts`, `refBadge.ts`, `fileTree.ts`) — so the reported % reflects our tested logic, not the whole UI. Functions that are unit-tested but live *inside* React components (`assignLanes`/`computeWorkingPlacement` in `CommitGraph.tsx`, `isSearchDisabled` in `SearchPanel.tsx`) are intentionally left out of the report: v8 can't scope coverage to part of a file, and folding whole component bodies in just to count a few functions swamps the number with untestable JSX. Those functions are still guarded by their tests — the fix when you want them counted is to extract them into a plain `.ts` module and add it to `include`. When you add a pure-logic `.ts` module with a `*.test.ts`, **add its source file to `include`** so the report stays honest and in sync.

**Where:** Rust tests are colocated in `#[cfg(test)]` modules. Frontend tests are colocated `*.test.ts` next to the source, run under **Vitest** (node environment; `ui/vitest.config.ts`).

**Conventions:** tests must be deterministic and offline — no network, no reliance on the developer's real repos/HOME. Build git fixtures in temp dirs. Use fixed timestamps for commits so ordering/window assertions are stable.

**How to run:**
```bash
mise run test          # everything (Rust + frontend)
mise run test-server   # cargo test --workspace
mise run test-ui       # vitest
mise run coverage-ui   # frontend coverage (v8)
mise run coverage-server  # Rust coverage (needs: cargo install cargo-llvm-cov)
```

**CI:** `.github/workflows/build.yml` has a `test` job that runs both suites with
coverage on every push/PR (fast — no bundling) and uploads coverage as artifacts.
The 3-OS `build` jobs declare `needs: test`, so nothing is built/released unless
tests pass; the build itself only runs on version tags or manual dispatch.

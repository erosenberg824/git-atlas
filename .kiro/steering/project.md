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

The Rust server is also runnable standalone (`git-atlas`) for WSL users or browser-only access. This is intentional — the Tauri shell is a wrapper, not a requirement.

## Key decisions and rationale

**No authentication on localhost.** The server binds to 127.0.0.1 only. Auth was explicitly deferred — do not add it without discussion.

**git2 with vendored-libgit2, SSH disabled.** SSH support was disabled to avoid the openssl-sys dependency (no system OpenSSL required). The tool only reads repos, never pushes/clones over SSH, so this is fine.

**reqwest with rustls-tls, no OpenSSL.** Same reason — keeps the build self-contained, no Homebrew/pkgconf required on macOS.

**Rust 1.88.0 pinned in mise.toml.** This is the minimum that satisfies all transitive dependency requirements (encoding_rs, icu crates, time require 1.88).

**git2::Repository is !Send.** All git operations must run inside `tokio::task::spawn_blocking`. Never hold a `git2::Repository` across an `.await` point. This pattern is used throughout `server/src/routes/`.

**Tantivy indexes are per-commit, in-memory, cached by commit OID.** The cache lives in `AppState.inner.index_cache`. Indexes are built on demand when a search or index request arrives for a commit not yet cached.

**API versioned at /api/v1/.** All routes are under this prefix. Do not add unversioned routes.

**VSCode extension and Bitbucket plugin are low-priority future concerns.** Do not make architectural decisions to accommodate them.

**Single repo per instance.** Multiple repos = multiple app instances. Do not add multi-repo support to the server.

## Project structure

```
git-atlas/
├── mise.toml                        # Tool versions (Rust 1.88.0, Node 22.19.0) + dev tasks
├── Cargo.toml                       # Workspace root
├── server/src/
│   ├── main.rs                      # Entry point, server startup, lockfile write
│   ├── config.rs                    # AppConfig, env vars, lockfile
│   ├── error.rs                     # AppError enum, IntoResponse impl
│   ├── state.rs                     # AppState (repo_path RwLock, index_cache)
│   ├── git/
│   │   ├── mod.rs                   # resolve_ref() helper
│   │   ├── graph.rs                 # DAG traversal, lane assignment, ref collection
│   │   ├── commits.rs               # CommitDetail struct and getter
│   │   ├── diff.rs                  # FileDiff, Hunk, DiffLine; diff_commit_vs_parent, diff_two_commits
│   │   └── tree.rs                  # TreeEntry, BlobResponse; list_tree, get_blob_at_commit
│   ├── search/mod.rs                # Tantivy index build + query; IndexCache type
│   ├── forge/
│   │   ├── mod.rs                   # Module root
│   │   └── bitbucket.rs             # Bitbucket Cloud REST API v2.0 client (stub)
│   └── routes/
│       ├── mod.rs                   # build_router(), all routes registered here
│       ├── repo.rs                  # POST/GET /repo
│       ├── graph.rs                 # GET /graph
│       ├── commits.rs               # GET /commits/:oid
│       ├── diff.rs                  # GET /diff/:oid and GET /diff?base=&target=
│       ├── tree.rs                  # GET /tree/:oid and GET /tree/:oid/blob
│       ├── search.rs                # GET /search and POST /search/index
│       └── forge.rs                 # POST /forge/config and GET /forge/prs
└── ui/
    ├── src/
    │   ├── api/client.ts            # Typed HTTP client for all API routes
    │   ├── App.tsx                  # Root layout: graph (left) + tabbed panels (right)
    │   └── features/
    │       ├── graph/
    │       │   ├── CommitGraph.tsx          # React Flow DAG, lane layout algorithm
    │       │   └── CommitNodeComponent.tsx  # Custom node: hash, summary, author, ref badges
    │       ├── commit/CommitPanel.tsx       # Commit metadata + changed files list
    │       ├── diff/DiffViewer.tsx          # Unified diff: hunks, line numbers, +/- highlighting
    │       ├── tree/FileBrowser.tsx         # Recursive file tree built from flat path list
    │       └── search/SearchPanel.tsx       # Full-text search input + results
    └── src-tauri/
        ├── src/lib.rs               # Port discovery (lockfile/env), get_server_port command
        └── tauri.conf.json          # App config: product name git-atlas, 1400x900 window

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
| `RUST_LOG` | `git_atlas_server=debug` | Log level |

## Code conventions

- Rust: errors use `thiserror` (`AppError` enum in `error.rs`). Route handlers return `ApiResult<Json<T>>`.
- All git operations in route handlers go inside `tokio::task::spawn_blocking` — never hold `git2::Repository` across `.await`.
- TypeScript: strict mode, no `any`. API types live in `src/api/client.ts` and are imported from there.
- Tailwind v4 (no config file — uses CSS `@import "tailwindcss"`). Dark theme with CSS custom properties in `index.css`.
- React Flow node data is typed as `unknown` then cast with `as unknown as MyType` due to React Flow's generic constraints.

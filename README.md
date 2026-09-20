# git-atlas

[![build](https://github.com/erosenberg824/git-atlas/actions/workflows/build.yml/badge.svg)](https://github.com/erosenberg824/git-atlas/actions/workflows/build.yml)

A local-first tool for visualising and searching git repositories. Browse commit history as an interactive directed graph, inspect diffs and file contents at any commit, and full-text search across the repository at any point in history.

## Features

- **Commit graph** — interactive DAG with branch/tag labels, powered by React Flow
- **Diff viewer** — unified diff for any commit or between any two commits
- **File browser** — explore the full repository tree at any commit
- **Full-text search** — search file contents at any commit using tantivy
- **PR overlay** *(planned)* — display open pull requests from Bitbucket, GitHub, or GitLab overlaid on the graph

## Architecture

```
┌──────────────────────────────────┐
│  Tauri shell (desktop app)       │  Mac / Windows / Linux
│  Launches server as sidecar      │
└────────────┬─────────────────────┘
             │ localhost HTTP
┌────────────▼─────────────────────┐
│  Rust HTTP server (Axum)         │  also runnable standalone
│  git2 · tantivy · reqwest        │
└────────────┬─────────────────────┘
             │ filesystem
         Git repositories
```

The Rust server can run standalone (`git-atlas`) for WSL users or browser-based access — just point a browser at `http://localhost:PORT`.

## Two ways to run git-atlas

git-atlas ships as **two binaries** that share the same Rust core, for two distinct usage paths:

**1. Desktop app (`git-atlas-app`)** — the packaged Tauri application (Mac/Windows/Linux).
Launch it and it runs everything for you: it spawns the `git-atlas` server as a bundled
[sidecar](https://tauri.app/develop/sidecar/), discovers its port, shows the UI in a native window,
and shuts the server down on exit. No terminal, no separate steps. This is the path for most desktop
users.

```bash
open -a git-atlas          # macOS (or launch from Finder / Start menu)
```

**2. Standalone server (`git-atlas`) + browser** — run the server yourself and use it from a web
browser. This is the primary path for **WSL** users (run the server inside WSL, browse from Windows)
and anyone who prefers the browser over the desktop app.

```bash
git-atlas ~/code/my-project     # starts the server, opens your browser to the app
```

The standalone binary **serves the full web UI itself** — the built frontend is embedded in the
binary, so a browser pointed at `http://localhost:PORT` gets the complete app with no Vite / dev
server and no extra files. On startup the server prints the access URL and **auto-opens your default
browser** (pass `--no-browser` or `--headless` to skip). Because the browser and the API share one
origin, there are no ports to coordinate.

> **WSL:** run `git-atlas` inside WSL and browse from Windows. If auto-open can't reach the Windows
> browser, just open the printed `http://localhost:PORT` URL manually.

Both binaries are produced by the same build, and the desktop bundle contains both — so a single
installed package gives you the app *and* the standalone server.

## Prerequisites

### macOS
- Xcode Command Line Tools: `xcode-select --install`
- [mise](https://mise.jdx.dev) — manages Rust and Node versions

### Windows
- [Visual Studio Build Tools](https://aka.ms/vs/17/release/vs_BuildTools.exe) (MSVC, C++ workload)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (ships with Windows 11)
- [mise](https://mise.jdx.dev)

### Linux
```bash
# Ubuntu / Debian
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```
Plus [mise](https://mise.jdx.dev).

## Setup

```bash
# 1. Install pinned Rust + Node via mise
mise install

# 2. Install frontend dependencies
cd ui && npm install && cd ..
```

## Development

Run the backend server and the Vite dev server in separate terminals:

```bash
# Terminal 1 — Rust backend (auto-reloads with cargo-watch if installed)
mise run dev-server
# or: cargo run --bin git-atlas

# Terminal 2 — Vite frontend dev server
mise run dev-ui
# or: cd ui && npm run dev
```

Then open http://localhost:1420 in a browser, or run the full Tauri dev app:

```bash
mise run tauri-dev
# or: cd ui && npm run tauri dev
```

## Building

### Quick build (everything)

```bash
mise run build
# equivalent to: cargo build --release && (cd ui && npm run tauri build)
```

Outputs:

- **Standalone server binary:** `target/release/git-atlas`
- **Packaged desktop app:** `target/release/bundle/`

## Packaged desktop client

The desktop client is a [Tauri](https://tauri.app) app (`productName: git-atlas`, identifier
`dev.git-atlas.app`). Building it produces native, installable artifacts for the platform you build
on — Tauri does **not** cross-compile, so build each OS on that OS (or in CI).

### Build the installer

```bash
# 1. Install toolchain + frontend deps (once)
mise install
cd ui && npm install && cd ..

# 2. Build the release server binary
cargo build --release

# 3. Build and bundle the desktop app
cd ui && npm run tauri build
```

`npm run tauri build` first runs `scripts/prepare-sidecar.sh` (builds the release
`git-atlas` and copies it to `ui/src-tauri/binaries/git-atlas-<target-triple>` so Tauri
can bundle it), then runs the frontend production build (`npm run build` → `ui/dist`), compiles the
Tauri shell in release mode, and bundles installers. Because `bundle.targets` is set to `"all"`, you
get every installer type your platform supports. (Using `mise run build` does the sidecar prep for
you; if you call `npm run tauri build` directly, run `./scripts/prepare-sidecar.sh` first.)

### Where the artifacts land

All under `target/release/bundle/` (workspace root):

| Platform | Artifacts | Location |
|----------|-----------|----------|
| **macOS** | `git-atlas.app`, `.dmg` | `bundle/macos/`, `bundle/dmg/` |
| **Windows** | `.msi`, `.exe` (NSIS) | `bundle/msi/`, `bundle/nsis/` |
| **Linux** | `.deb`, `.rpm`, `.AppImage` | `bundle/deb/`, `bundle/rpm/`, `bundle/appimage/` |

The bundled `git-atlas` sits alongside the app executable inside the package (e.g. on macOS,
`git-atlas.app/Contents/MacOS/git-atlas`).

### Running the packaged client

The desktop app **bundles `git-atlas` as a Tauri
[sidecar](https://tauri.app/develop/sidecar/)** and manages its lifecycle: on launch it spawns the
server (binding to a random free port), discovers the port from the server's stdout, and terminates
the server when the app window closes. Just open the installed app — no separate server needed:

```bash
#    macOS:
open -a git-atlas
#    Linux (AppImage example):
./git-atlas_0.1.0_amd64.AppImage
#    Windows: launch from the Start menu, or:
& "C:\Program Files\git-atlas\git-atlas.exe"
```

**Overriding the server (optional).** If you set `ATLAS_PORT` (or a running server has written its
lockfile in `ATLAS_DATA_DIR`), the app connects to that already-running server instead of spawning
its own sidecar. Useful for pointing the packaged app at a dev server:

```bash
ATLAS_PORT=7842 ./target/release/git-atlas   # run your own server
ATLAS_PORT=7842 open -a git-atlas                    # app uses it instead of the sidecar
```

## API

The server exposes a versioned REST API at `http://localhost:PORT/api/v1/`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/repo` | Open a repository by path |
| `GET` | `/repo` | Get info about the open repository |
| `GET` | `/graph` | Commit DAG (nodes + edges + refs) |
| `GET` | `/commits/:oid` | Commit detail |
| `GET` | `/diff/:oid` | Commit vs parent diff |
| `GET` | `/diff?base=&target=` | Diff between two commits |
| `GET` | `/tree/:oid` | File tree at a commit |
| `GET` | `/tree/:oid/blob?path=` | File contents at a commit |
| `GET` | `/search?q=&commit=` | Full-text search at a commit |
| `POST` | `/search/index` | Build search index for a commit |
| `POST` | `/forge/config` | Save forge credentials (OS keychain) |
| `GET` | `/forge/prs` | List pull requests |

### Server usage

```bash
git-atlas [REPO_PATH]
```

`REPO_PATH` is an optional positional argument — the repository to open on
startup. If omitted, the server falls back to `ATLAS_REPO_PATH`, then to the
last-opened repo. Precedence (highest first): **CLI arg → `ATLAS_REPO_PATH` →
last repo**.

```bash
# open a specific repo directly
git-atlas ~/code/my-project
# or via cargo in dev
cargo run --bin git-atlas -- ~/code/my-project
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PORT` | `0` (random) | Port to bind the server to |
| `ATLAS_REPO_PATH` | — | Repository to open on startup (overridden by the positional CLI arg) |
| `ATLAS_DATA_DIR` | platform default | Where to store search indexes, the port lockfile, and recent/last-repo state |
| `RUST_LOG` | `git_atlas=debug` | Log level |

## WSL

Run the server inside WSL so it has native access to Linux filesystem paths:

```bash
ATLAS_PORT=7842 git-atlas ~/code/my-project
```

The server serves the full UI and tries to auto-open your browser. Since Windows and WSL2 share
localhost (Windows 10 2004+), the app is reachable at `http://localhost:7842` from a Windows browser —
if auto-open can't reach it, open that URL manually. (Pass `--no-browser` to skip the auto-open, or
point the Windows Tauri app at the server by setting `ATLAS_PORT=7842` before launching it.)

## Project structure

```
git-atlas/
├── mise.toml                  # Tool versions + dev tasks
├── Cargo.toml                 # Workspace root
├── server/                    # Rust HTTP server
│   └── src/
│       ├── main.rs
│       ├── config.rs
│       ├── error.rs
│       ├── state.rs
│       ├── git/               # git2 operations
│       │   ├── graph.rs       # DAG traversal
│       │   ├── commits.rs     # Commit detail
│       │   ├── diff.rs        # Diff computation
│       │   └── tree.rs        # Tree + blob reading
│       ├── search/            # tantivy full-text index
│       ├── forge/             # Bitbucket/GitHub/GitLab clients
│       └── routes/            # Axum route handlers
└── ui/                        # Tauri + React frontend
    ├── src/
    │   ├── api/client.ts      # Typed API client
    │   └── features/
    │       ├── graph/         # React Flow commit graph
    │       ├── commit/        # Commit detail panel
    │       ├── diff/          # Diff viewer
    │       ├── tree/          # File browser
    │       └── search/        # Search panel
    └── src-tauri/             # Tauri shell (Rust)
```

use anyhow::Result;
use std::net::SocketAddr;
use tracing::info;

mod config;
mod error;
mod git;
mod routes;
mod search;
mod forge;
mod state;
mod static_assets;

#[tokio::main]
async fn main() -> Result<()> {
    // Handle --help / --version before doing any real work.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        print_usage();
        return Ok(());
    }
    if args.iter().any(|a| a == "-V" || a == "--version") {
        println!("git-atlas {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    // Suppress auto-opening the browser (for headless/server-only use).
    let no_browser = args.iter().any(|a| a == "--no-browser" || a == "--headless");

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "git_atlas_server=debug,tower_http=debug".into()),
        )
        .init();

    // Load configuration
    let cfg = config::AppConfig::load()?;

    // Build shared application state
    let state = state::AppState::new(cfg.clone())?;

    // Build the router
    let app = routes::build_router(state);

    // Bind to a random available port on loopback only
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    let bound_port = listener.local_addr()?.port();
    info!("git-atlas server listening on http://127.0.0.1:{}", bound_port);

    // Emit a clean, stable line on stdout so a parent process (the Tauri
    // sidecar host) can reliably discover the bound port regardless of the
    // tracing/log configuration. Format: `ATLAS_LISTENING_PORT=<port>`.
    println!("ATLAS_LISTENING_PORT={bound_port}");

    // Whether we're running as the Tauri sidecar (the shell sets this). When we
    // are, skip the human-facing banner — the desktop app opens its own window.
    let is_sidecar = std::env::var("ATLAS_NO_LOCKFILE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !is_sidecar {
        // Human-facing access URL for standalone / browser (WSL) use.
        let url = format!("http://127.0.0.1:{bound_port}");
        println!();
        println!("  git-atlas is running.");
        println!("  Open in your browser:  {url}");
        println!();

        if !static_assets::ui_embedded() {
            info!(
                "web UI is not embedded in this build; serving REST API only. \
                 Build the frontend (cd ui && npm run build) and rebuild to embed it."
            );
        }

        // Auto-open the default browser for standalone use, unless suppressed
        // with --no-browser/--headless. Never do this as the desktop sidecar.
        if !no_browser {
            open_in_browser(&url);
        }
    }

    use std::io::Write;
    let _ = std::io::stdout().flush();

    // Write port to lockfile so the Tauri shell can discover it — unless we're
    // running as a sidecar (ATLAS_NO_LOCKFILE=1). Multiple sidecar-launched
    // instances would otherwise clobber this shared file (last-writer-wins),
    // which can make a second app window attach to the first's server.
    let skip_lockfile = is_sidecar;
    if skip_lockfile {
        info!("ATLAS_NO_LOCKFILE set — not writing shared server.port lockfile");
    } else {
        config::write_lockfile(bound_port)?;
    }

    axum::serve(listener, app).await?;

    Ok(())
}

/// Open `url` in the system default browser (best-effort, non-blocking).
/// Uses the platform's standard opener; failure is logged, not fatal.
///
/// Note: under WSL, `xdg-open` may not reach the Windows browser depending on
/// setup; users can always open the printed URL manually.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<&str>) = ("open", vec![url]);
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", url]);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let (cmd, args): (&str, Vec<&str>) = ("xdg-open", vec![url]);

    match std::process::Command::new(cmd).args(&args).spawn() {
        Ok(_) => {}
        Err(e) => info!("could not auto-open browser ({cmd}): {e}. Open {url} manually."),
    }
}

/// Print the CLI usage/help text.
fn print_usage() {
    let v = env!("CARGO_PKG_VERSION");
    println!(
        "git-atlas {v}
A local-first server for visualising and searching git repositories.

USAGE:
    git-atlas [OPTIONS] [REPO_PATH]

ARGS:
    [REPO_PATH]    Optional path to a git repository to open on startup.
                   Precedence (highest first): REPO_PATH arg > ATLAS_REPO_PATH
                   > last-opened repo.

OPTIONS:
    -h, --help       Print this help and exit
    -V, --version    Print version and exit
        --no-browser Do not auto-open the default browser on startup
        --headless   Alias for --no-browser

ENVIRONMENT:
    ATLAS_PORT         Port to bind (default: 0 = OS-assigned random port)
    ATLAS_REPO_PATH    Repo to open on startup (overridden by the REPO_PATH arg)
    ATLAS_DATA_DIR     Directory for search indexes, the port lockfile, and
                       recent/last-repo state (default: platform data dir)
    ATLAS_NO_LOCKFILE  Set to 1 to skip writing the shared server.port lockfile
                       (used when running as the desktop app's sidecar)
    RUST_LOG           Log filter (default: git_atlas_server=debug,tower_http=debug)

The server listens on http://127.0.0.1:<port> and prints the access URL on
startup. Point a browser there (handy under WSL), or let the desktop app
manage it as a bundled sidecar."
    );
}

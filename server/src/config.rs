use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Application configuration loaded from env / config file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Port to bind the HTTP server to. 0 = OS-assigned random port.
    pub port: u16,

    /// Optional path to a git repository to open on startup.
    pub repo_path: Option<PathBuf>,

    /// Directory where git-atlas stores its data (search indexes, lockfile, etc.)
    pub data_dir: PathBuf,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            port: 0,
            repo_path: None,
            data_dir: default_data_dir(),
        }
    }
}

impl AppConfig {
    pub fn load() -> Result<Self> {
        // Start with defaults, then layer in overrides. Precedence for the repo
        // path (highest first): positional CLI arg > ATLAS_REPO_PATH env >
        // last-opened repo. ATLAS_PORT and ATLAS_DATA_DIR also override defaults.
        let mut cfg = AppConfig::default();

        if let Ok(port_str) = std::env::var("ATLAS_PORT") {
            cfg.port = port_str.parse()?;
        }

        // 1. Positional CLI argument, e.g. `git-atlas /path/to/repo`.
        //    The first non-flag argument is treated as the repo path.
        if let Some(arg) = repo_path_from_args() {
            cfg.repo_path = Some(PathBuf::from(arg));
        }
        // 2. Fall back to ATLAS_REPO_PATH if no CLI arg was given.
        if cfg.repo_path.is_none() {
            if let Ok(path) = std::env::var("ATLAS_REPO_PATH") {
                cfg.repo_path = Some(PathBuf::from(path));
            }
        }
        // 3. Fall back to the last opened repo if neither was provided.
        if cfg.repo_path.is_none() {
            cfg.repo_path = load_repo_path();
        }

        if let Ok(path) = std::env::var("ATLAS_DATA_DIR") {
            cfg.data_dir = PathBuf::from(path);
        }

        // Ensure data directory exists
        std::fs::create_dir_all(&cfg.data_dir)?;

        Ok(cfg)
    }
}

/// Return the first positional (non-flag) command-line argument, if any.
/// Used as the repo path: `git-atlas [PATH]`. Anything starting with
/// `-` is skipped so future flags don't get mistaken for the path.
fn repo_path_from_args() -> Option<String> {
    std::env::args()
        .skip(1) // skip the program name
        .find(|a| !a.starts_with('-'))
}

/// Write the bound port to a lockfile so the Tauri shell can read it.
pub fn write_lockfile(port: u16) -> Result<()> {
    let dir = default_data_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("server.port"), port.to_string())?;
    Ok(())
}

/// Persist the last opened repo path so it survives server restarts.
pub fn save_repo_path(path: &std::path::Path) -> Result<()> {
    let dir = default_data_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("last_repo"), path.to_string_lossy().as_bytes())?;
    add_recent_repo(path)?;
    Ok(())
}

/// Load the last opened repo path if one was saved.
pub fn load_repo_path() -> Option<std::path::PathBuf> {
    let dir = default_data_dir();
    std::fs::read_to_string(dir.join("last_repo"))
        .ok()
        .map(|s| std::path::PathBuf::from(s.trim()))
        .filter(|p| p.exists())
}

const MAX_RECENT: usize = 10;

/// Add a path to the recent repos list (most recent first, deduped, capped at 10).
fn add_recent_repo(path: &std::path::Path) -> Result<()> {
    let mut recent = load_recent_repos();
    let path_str = path.to_string_lossy().to_string();
    // Remove existing entry for this path so we can re-insert at the front
    recent.retain(|p| p != &path_str);
    recent.insert(0, path_str);
    recent.truncate(MAX_RECENT);
    let dir = default_data_dir();
    std::fs::write(dir.join("recent_repos"), recent.join("\n"))?;
    Ok(())
}

/// Load the list of recently opened repos (most recent first).
pub fn load_recent_repos() -> Vec<String> {
    let dir = default_data_dir();
    std::fs::read_to_string(dir.join("recent_repos"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .collect()
}

fn default_data_dir() -> PathBuf {
    // Honor an explicit ATLAS_DATA_DIR override first so every consumer
    // (lockfile, last_repo, recent_repos, indexes) agrees on the location.
    // Falls back to the platform data dir:
    //   ~/.local/share/git-atlas on Linux, ~/Library/Application Support/git-atlas
    //   on macOS, %APPDATA%\git-atlas on Windows.
    if let Ok(dir) = std::env::var("ATLAS_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs_next()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("git-atlas")
}

fn dirs_next() -> Option<PathBuf> {
    // Use the platform data dir via std::env for portability without adding a dep yet.
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA").ok().map(PathBuf::from)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".local").join("share"))
            })
    }
}

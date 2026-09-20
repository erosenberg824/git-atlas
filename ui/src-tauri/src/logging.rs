//! Multi-instance-safe logging for the desktop shell.
//!
//! Several git-atlas app instances can run at once (one per repo). They all
//! share a single `git-atlas.log` in the data dir; each line is tagged with the
//! writing process's PID so a single instance can be isolated with
//! `grep "[pid 12345]"`.
//!
//! Concurrency model:
//! - The file is opened in append mode and each log line is written with a
//!   single `write` call, so on unix `O_APPEND` guarantees lines from different
//!   processes don't shred into each other.
//! - Size-based rotation is coordinated with an advisory `flock(LOCK_EX)` so
//!   only one instance rotates at a time, and every write reopens the path
//!   (rather than holding a long-lived fd) so all instances follow the file
//!   across a rotation instead of writing into a deleted inode.

use std::fs::{File, OpenOptions};
use std::io::{IsTerminal, Write};
use std::path::PathBuf;
/// Rotate when the active log exceeds this size. One rollover (`.1`) is kept,
/// so total footprint is bounded at ~2x this.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

/// Platform data dir where the shared log lives (matches the server's dir).
/// `GIT_ATLAS_LOG_DIR` overrides it (used by tests and advanced setups).
fn data_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("GIT_ATLAS_LOG_DIR") {
        return Some(PathBuf::from(dir));
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join("git-atlas")
        })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("git-atlas"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".local").join("share").join("git-atlas"))
    }
}

fn log_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("git-atlas.log"))
}

/// Stable lock file. Its inode never changes (we never rotate/rename it), so an
/// exclusive flock on it reliably serializes all rotation+append work across
/// every instance, even while the actual log file is being rotated out.
fn lock_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("git-atlas.log.lock"))
}

/// A minimal ISO-8601-ish UTC timestamp without pulling in a date crate.
/// Format: `YYYY-MM-DDTHH:MM:SSZ` is overkill to compute by hand, so we use a
/// monotonic-ish wall clock via `SystemTime` and print epoch millis, which is
/// unambiguous and sortable. Example: `t=1758300000123`.
fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("t={ms}")
}

#[cfg(unix)]
fn lock_exclusive(file: &File) {
    use std::os::unix::io::AsRawFd;
    unsafe {
        libc::flock(file.as_raw_fd(), libc::LOCK_EX);
    }
}

#[cfg(unix)]
fn unlock(file: &File) {
    use std::os::unix::io::AsRawFd;
    unsafe {
        libc::flock(file.as_raw_fd(), libc::LOCK_UN);
    }
}

#[cfg(not(unix))]
fn lock_exclusive(_file: &File) {}
#[cfg(not(unix))]
fn unlock(_file: &File) {}

/// Rotate the log if it is over the size cap. Caller must already hold the
/// exclusive lock on the dedicated lock file. Keeps a single `.1` rollover.
fn maybe_rotate(path: &PathBuf) {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size < MAX_LOG_BYTES {
        return;
    }
    let rolled = path.with_extension("log.1");
    // Best-effort: drop the previous rollover, then move current -> .1.
    let _ = std::fs::remove_file(&rolled);
    let _ = std::fs::rename(path, &rolled);
    // The next append to `path` creates a fresh file.
}

/// Write a single tagged line to the shared log and echo it to stdout.
/// `tag` is a short source label such as `server` or `app`.
pub fn log_line(tag: &str, message: &str) {
    let pid = std::process::id();
    let line = format!("{} [pid {}] [{}] {}", timestamp(), pid, tag, message);

    // Echo to stdout only when stdout is an actual terminal, so running the
    // binary from a shell shows output live, while a GUI launch (no attached
    // terminal) stays silent and writes to the log file only.
    if std::io::stdout().is_terminal() {
        println!("{line}");
    }

    let (Some(path), Some(lockp)) = (log_path(), lock_path()) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    // Acquire the stable cross-process lock for the whole rotate+append.
    let lock_file = match OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .open(&lockp)
    {
        Ok(f) => f,
        Err(_) => {
            // Couldn't get the lock file; degrade to a best-effort append so we
            // never lose logging entirely.
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
                let _ = f.write_all(format!("{line}\n").as_bytes());
            }
            return;
        }
    };

    lock_exclusive(&lock_file);

    maybe_rotate(&path);
    // Open in append mode *after* any rotation so we write to the fresh file.
    // O_APPEND keeps the single write atomic on unix.
    if let Ok(mut active) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = active.write_all(format!("{line}\n").as_bytes());
    }

    unlock(&lock_file);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Every written line must match `t=<digits> [pid <digits>] [<tag>] <msg>`.
    /// If two processes/threads shredded a line, this regex-free check fails.
    fn assert_well_formed(contents: &str) -> usize {
        let mut count = 0;
        for line in contents.lines() {
            assert!(line.starts_with("t="), "bad line start: {line:?}");
            assert!(line.contains("[pid "), "missing pid tag: {line:?}");
            // exactly one pid tag per line (no interleave)
            assert_eq!(line.matches("[pid ").count(), 1, "interleaved line: {line:?}");
            count += 1;
        }
        count
    }

    // GIT_ATLAS_LOG_DIR is process-global, so tests that set it must not run
    // concurrently with each other. Serialize them behind this mutex.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn concurrent_writes_are_line_atomic() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "gal-log-atomic-{}-{}",
            std::process::id(),
            uuid_like()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("GIT_ATLAS_LOG_DIR", &dir);

        let threads = 8;
        let per = 200;
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                std::thread::spawn(move || {
                    for i in 0..per {
                        log_line("test", &format!("thread {t} line {i} with some padding text"));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let mut contents = String::new();
        File::open(dir.join("git-atlas.log"))
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        let n = assert_well_formed(&contents);
        assert_eq!(n, threads * per, "expected all lines present");

        std::env::remove_var("GIT_ATLAS_LOG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_keeps_one_rollover() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "gal-log-rot-{}-{}",
            std::process::id(),
            uuid_like()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("GIT_ATLAS_LOG_DIR", &dir);

        let path = dir.join("git-atlas.log");
        // Pre-seed an oversized active log so the next write triggers rotation.
        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();

        log_line("test", "trigger rotation");

        assert!(dir.join("git-atlas.log.1").exists(), "rollover file should exist");
        // Active file is fresh and small again.
        let active_size = std::fs::metadata(&path).unwrap().len();
        assert!(active_size < MAX_LOG_BYTES, "active log should be small after rotation");

        std::env::remove_var("GIT_ATLAS_LOG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Small unique-ish suffix without pulling in a uuid dependency here.
    fn uuid_like() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    }
}

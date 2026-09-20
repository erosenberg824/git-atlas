use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod logging;
use logging::log_line;

/// Shared state: the port the server is listening on, and (when we launched it
/// ourselves as a sidecar) the child process handle so we can kill it on exit.
struct ServerState {
    port: Mutex<Option<u16>>,
    /// Sidecar child handle. `None` in dev mode where the server runs separately.
    child: Mutex<Option<CommandChild>>,
}

/// Called from the frontend to get the server's port.
///
/// - Dev mode: the port comes from the `ATLAS_PORT` env var or the lockfile
///   written by a separately-run `git-atlas` server.
/// - Packaged mode: the port is discovered from the sidecar's stdout once it
///   has bound and printed `ATLAS_LISTENING_PORT=<port>`. Until then this
///   returns `None` and the frontend should retry.
#[tauri::command]
fn get_server_port(state: tauri::State<ServerState>) -> Option<u16> {
    *state.port.lock().unwrap()
}

/// Spawn the bundled `git-atlas` server sidecar. Reads its stdout, and when it
/// prints `ATLAS_LISTENING_PORT=<port>`, records the port in state. Stores the
/// child handle so it can be killed when the app exits.
fn spawn_sidecar(app: &tauri::AppHandle) {
    let sidecar = match app.shell().sidecar("git-atlas") {
        Ok(cmd) => cmd,
        Err(e) => {
            log_line("app", &format!("failed to create sidecar command: {e}"));
            return;
        }
    };

    // Bind to a random free port; the server prints the chosen port on stdout.
    // ATLAS_NO_LOCKFILE=1 tells the server NOT to write the shared server.port
    // file — each sidecar-launched instance is independent and hands its port
    // to us via stdout, so the shared lockfile would only let instances collide
    // (last-writer-wins) and cause a second window to attach to another's server.
    let sidecar = sidecar
        .env("ATLAS_PORT", "0")
        .env("ATLAS_NO_LOCKFILE", "1");

    let (mut rx, child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            log_line("app", &format!("failed to spawn sidecar: {e}"));
            return;
        }
    };

    let child_pid = child.pid();
    log_line("app", &format!("spawned sidecar pid={child_pid}"));

    // Stash the child handle for cleanup on exit.
    if let Some(state) = app.try_state::<ServerState>() {
        *state.child.lock().unwrap() = Some(child);
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    log_line("server", line);
                    if let Some(port) = parse_port_line(line) {
                        if let Some(state) = app_handle.try_state::<ServerState>() {
                            *state.port.lock().unwrap() = Some(port);
                        }
                        log_line("app", &format!("discovered server port={port}"));
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    log_line("server", line.trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    log_line(
                        "app",
                        &format!("sidecar terminated: code={:?} signal={:?}", payload.code, payload.signal),
                    );
                }
                CommandEvent::Error(err) => {
                    log_line("app", &format!("sidecar error: {err}"));
                }
                _ => {}
            }
        }
    });
}

/// Extract the port from a `ATLAS_LISTENING_PORT=<port>` line, ignoring any
/// surrounding log/ANSI noise.
fn parse_port_line(line: &str) -> Option<u16> {
    let idx = line.find("ATLAS_LISTENING_PORT=")?;
    let rest = &line[idx + "ATLAS_LISTENING_PORT=".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Only an EXPLICIT `ATLAS_PORT` makes us skip spawning our own server (used
    // to point the app at a dev server you started yourself). We deliberately do
    // NOT consult the shared `server.port` lockfile here: it's process-global and
    // can be stale (a dead port) or belong to another instance, which previously
    // caused the packaged app to skip its sidecar and then fail every request
    // with "Load failed". A sidecar-based app gets its port from its own child's
    // stdout, so it never needs the lockfile.
    let preset_port = std::env::var("ATLAS_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p != 0);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerState {
            port: Mutex::new(preset_port),
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_server_port])
        .setup(|app| {
            log_line("app", "git-atlas shell starting");
            // Only launch the sidecar if we didn't already find a running
            // server (dev mode runs the server separately).
            let already = app
                .state::<ServerState>()
                .port
                .lock()
                .unwrap()
                .is_some();
            if already {
                log_line("app", "using pre-existing server (env/lockfile); not spawning sidecar");
            } else {
                spawn_sidecar(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // When the last window is closing, kill the sidecar so we don't
            // leak the server process.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<ServerState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        let pid = child.pid();
                        match child.kill() {
                            Ok(_) => log_line("app", &format!("killed sidecar pid={pid} on window close")),
                            Err(e) => log_line("app", &format!("failed to kill sidecar pid={pid}: {e}")),
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running git-atlas");
}

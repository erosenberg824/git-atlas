//! Build script: guarantee the `rust-embed` source directory exists.
//!
//! `static_assets.rs` embeds `../ui/dist` via `rust-embed`, which resolves and
//! validates that folder at compile time. On a fresh clone `ui/dist` has not
//! been produced yet (it is gitignored and created by `cd ui && npm run build`,
//! orchestrated by `scripts/prepare-sidecar.sh`), so the crate would fail to
//! compile. To keep a bare `cargo build` working, we ensure the directory
//! exists here — creating it empty if absent.
//!
//! When `ui/dist` has been built, this is a no-op and the real assets are
//! embedded and served exactly as before. When it is absent, an empty dir is
//! created, `ui_embedded()` returns false, and the server degrades to the
//! actionable "UI not embedded" message at runtime.

use std::path::Path;

fn main() {
    // Path is relative to this crate's manifest dir (server/), matching the
    // `#[folder = "../ui/dist"]` used by rust-embed in static_assets.rs.
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/dist");

    if !dist.exists() {
        if let Err(e) = std::fs::create_dir_all(&dist) {
            // Don't hard-fail the build over this; surface a warning instead.
            println!(
                "cargo:warning=failed to create embed dir {}: {e}",
                dist.display()
            );
        }
    }

    // Re-run only if the dist directory's presence/mtime changes.
    println!("cargo:rerun-if-changed=../ui/dist");
}

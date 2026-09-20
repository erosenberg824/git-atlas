/**
 * Runtime helpers for native desktop (Tauri) features that gracefully no-op in
 * a plain browser. Browsers deliberately do not expose absolute filesystem
 * paths, so the native folder picker and folder drag-and-drop only work inside
 * the packaged Tauri app.
 */

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Open the native directory picker. Returns the selected absolute path, or
 * null if the user cancelled or we're not in Tauri.
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");

  // Default the picker to the user's home directory rather than letting the OS
  // pick (macOS otherwise opens to Documents). Best-effort: if resolving home
  // fails, fall back to the OS default by omitting defaultPath.
  let defaultPath: string | undefined;
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    defaultPath = await homeDir();
  } catch {
    defaultPath = undefined;
  }

  const selected = (await open({
    directory: true,
    multiple: false,
    title: "Open a git repository",
    defaultPath,
  })) as string | string[] | null;
  // `open` returns string | string[] | null depending on options.
  if (typeof selected === "string") return selected;
  if (Array.isArray(selected) && selected.length > 0) return selected[0];
  return null;
}

/**
 * Subscribe to native folder drag-and-drop on the app window. Calls `onDrop`
 * with the absolute path of the first dropped item. Returns an unsubscribe
 * function. No-ops (returns a noop unsubscriber) outside Tauri.
 *
 * `onHover`/`onCancel` let the caller show a drop-target highlight.
 */
export async function onFolderDrop(
  onDrop: (path: string) => void,
  onHover?: () => void,
  onCancel?: () => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const t = event.payload.type;
    if (t === "over" || t === "enter") {
      onHover?.();
    } else if (t === "drop") {
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        onDrop(paths[0]);
      }
    } else {
      // "leave"/"cancel"
      onCancel?.();
    }
  });
  return unlisten;
}

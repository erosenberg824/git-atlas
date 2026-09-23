import { useEffect, useRef } from "react";
import { isTauri } from "./tauri";

/**
 * Subscribe to the server's live-update WebSocket (`/api/v1/events`) and invoke
 * `onChange` (debounced) whenever the repo changes on disk. Auto-reconnects with
 * backoff if the socket drops.
 *
 * The WebSocket URL is derived the same way as the REST base URL:
 * - Tauri (packaged): connect directly to the sidecar server via its port.
 * - Browser/dev: same origin (Vite proxies /api, and it proxies ws too).
 */
export function useLiveUpdates(onChange: () => void) {
  // Keep the latest callback without resubscribing.
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 500; // ms, grows to a cap
    // False until the first successful open. Used to distinguish the initial
    // connection (no catch-up needed) from a reconnect (catch-up refresh).
    let hadConnection = false;

    const fireDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      // Short client-side debounce to coalesce the rare double-message (e.g. a
      // broadcast immediately followed by a Lagged notice). The server already
      // debounces filesystem bursts, so this only needs to be small — keeping
      // it low keeps the working-tree count feeling responsive.
      debounceTimer = setTimeout(() => cb.current(), 100);
    };

    async function wsBaseUrl(): Promise<string> {
      // Same-origin by default (browser/dev): ws(s)://<host>/api/v1/events
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let host = location.host;
      if (isTauri()) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const port = await invoke<number | null>("get_server_port");
          if (port) host = `localhost:${port}`;
        } catch {
          // fall back to same-origin
        }
      }
      return `${proto}//${host}/api/v1/events`;
    }

    async function connect() {
      if (closed) return;
      const url = await wsBaseUrl();
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        // If this open follows a drop (backoff grew past its initial value), the
        // repo may have changed while we were disconnected — e.g. the dev server
        // restarted, or the machine slept. Do a catch-up refresh so the
        // working-tree count and graph re-sync instead of waiting for the next
        // filesystem event. The very first connection skips this (initial load
        // already fetched everything).
        if (hadConnection) {
          fireDebounced();
        }
        hadConnection = true;
        backoff = 500; // reset backoff on a good connection
      };
      ws.onmessage = (ev) => {
        // Any repo-changed message triggers a debounced refresh. (The initial
        // "connected" message is ignored.)
        if (typeof ev.data === "string" && ev.data.includes("repo-changed")) {
          fireDebounced();
        }
      };
      ws.onclose = () => {
        if (!closed) scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose will follow; let it handle reconnect.
        ws?.close();
      };
    }

    function scheduleReconnect() {
      if (closed) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000); // cap at 10s
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      ws?.close();
    };
  }, []);
}

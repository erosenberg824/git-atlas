import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/**
 * Read the port the git-atlas server is listening on.
 * Resolution order:
 *   1. ATLAS_PORT env var (set explicitly)
 *   2. Lockfile written by the server at startup
 *   3. Default 7842
 */
function resolveServerPort(): number {
  if (process.env.ATLAS_PORT) {
    return parseInt(process.env.ATLAS_PORT, 10);
  }

  // Platform-specific lockfile location (mirrors server/src/config.rs)
  let dataDir: string;
  if (process.platform === "darwin") {
    dataDir = path.join(os.homedir(), "Library", "Application Support", "git-atlas");
  } else if (process.platform === "win32") {
    dataDir = path.join(process.env.APPDATA ?? os.homedir(), "git-atlas");
  } else {
    dataDir = path.join(
      process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
      "git-atlas"
    );
  }

  const lockfile = path.join(dataDir, "server.port");
  try {
    const port = parseInt(fs.readFileSync(lockfile, "utf8").trim(), 10);
    if (!isNaN(port) && port > 0) {
      console.log(`[vite] git-atlas server port from lockfile: ${port}`);
      return port;
    }
  } catch {
    // Lockfile doesn't exist yet — server not started or using default
  }

  console.log("[vite] git-atlas server port not found, defaulting to 7842");
  return 7842;
}

const serverPort = resolveServerPort();

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [tailwindcss(), react()],

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // Proxy all /api calls to the Rust server — frontend never needs to know the port
    proxy: {
      "/api": {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
        // Proxy WebSocket upgrades too (used by /api/v1/events live updates).
        ws: true,
      },
    },
  },
}));

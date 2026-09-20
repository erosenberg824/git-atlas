// Frontend entry point: mounts the root <App> into #root. Vite serves this in
// dev; in the packaged Tauri app the built bundle is loaded from disk.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ReplayApp } from "./ReplayApp";
import "./styles.css";
import { applyTheme, initialTheme } from "./theme";

// Apply the remembered (or URL-forced) theme before the first paint.
applyTheme(initialTheme());

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

// A replay build (`vite build --mode replay`) is the static, zero-cost replay
// page: recorded runs only, no Worker, no launcher. The flag is replaced at
// build time, so the live console is tree-shaken out of that bundle.
const Root = import.meta.env.VITE_REPLAY === "1" ? ReplayApp : App;

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/tauri";
import "./theme/tokens.css";
import "./theme/base.css";

if (isTauri()) document.documentElement.classList.add("tauri");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/tauri";
import "./styles.css";

// In the Tauri window the native vibrancy shows through a translucent body;
// in a plain browser the same gradient is painted opaque.
if (isTauri()) document.documentElement.classList.add("tauri");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/spline-sans-mono/index.css";
// Order matters: page rules sit on the base, and primitives win over both.
import "./ui/tokens.css";
import "./ui/base.css";
import "./styles.css";
import "./runs/runs.css";
import "./ui/primitives.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { followLegacyHash } from "./router";

// Old shared #/runs links become real URLs before anything renders or fetches.
followLegacyHash();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

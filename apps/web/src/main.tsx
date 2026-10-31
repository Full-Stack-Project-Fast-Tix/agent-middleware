import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/red-hat-mono/wght.css";
// Order matters: tokens, then the base, then primitives, then pages, so a page can
// adjust a primitive with one plain class.
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/primitives.css";
import "./styles.css";
import "./topbar-controls.css";
import "./auth.css";
import "./playground.css";
import "./safety.css";
import "./runs/runs.css";
import "./members/members.css";
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

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { followEffects } from "./effects";
import { reloadOnFailedImports } from "./module-reload";
// Inter ships with the client, so the page reaches nothing but its home.
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "./styles.css";

reloadOnFailedImports();
followEffects();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";

import { App } from "./App.js";
import { SessionProvider } from "./session.js";
import { ToastProvider } from "./ui/index.js";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("No #root element — index.html is wrong.");
}

// HashRouter rather than BrowserRouter: the prototype is opened straight from a
// file server or a static host, and deep links must survive a refresh without
// server-side rewrite rules.
createRoot(container).render(
  <StrictMode>
    <HashRouter>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </HashRouter>
  </StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/app/queryClient";
import { App } from "@/app/App";
import "@/design/tokens.css";

// StrictMode is intentionally OFF: its dev-only double-invocation would
// double-subscribe the Centrifugo rail and make the realtime/resume demo
// non-deterministic to observe. (Effects are idempotent regardless.)
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.Fragment>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.Fragment>
);

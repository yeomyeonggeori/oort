import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/app/queryClient";
import { App } from "@/app/App";
import { initSessionStore } from "@/lib/session";
import { trackViewportHeight } from "@/app/viewportHeight";
import "@/design/tokens.css";

// 셸 높이의 근거 (goal B9). 첫 렌더보다 먼저 켠다: 로그인 화면도 셸 밖의 표면이라
// 같은 높이를 쓰고, 컴포저가 있는 첫 프레임이 이미 맞아 있어야 한다. 해제 함수는
// 쓰지 않는다 — 이 구독은 문서와 수명이 같다.
trackViewportHeight();

// StrictMode is intentionally OFF: its dev-only double-invocation would
// double-subscribe the Centrifugo rail and make the realtime/resume demo
// non-deterministic to observe. (Effects are idempotent regardless.)
function render() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.Fragment>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.Fragment>
  );
}

// Settle session storage BEFORE the first render (ADR-0133 P2, MOMO-603). In the
// desktop shell the refresh token comes from the OS keychain, which is async, and
// the first render decides "restoring vs anonymous" synchronously and for good —
// rendering first would strand a signed-in person on the login screen. In a
// browser this resolves on the first microtask, because localStorage was already
// read at import. `initSessionStore` never rejects; `finally` keeps the app
// booting even if that ever stops being true.
void initSessionStore().finally(render);

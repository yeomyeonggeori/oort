// FIRST, and before anything that can issue a request: this side-effect import
// gives @momo/core its platform answers (server base, session tokens). See
// src/lib/coreHost.ts.
import "@/lib/coreHost";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/app/queryClient";
import { App } from "@/app/App";
import { PwaBanner } from "@/features/pwa/PwaBanner";
import { startPwa } from "@/features/pwa/store";
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
//
// 셸 위의 한 줄 (goal B10). PwaBanner가 App 바깥에 있는 이유는 그 줄이 어느 화면
// 에도 속하지 않기 때문이다: 연결 화면에서도, 로그인한 뒤에도 같은 사실("홈
// 화면에 추가할 수 있다", "새 버전이 준비됐다")을 말한다. 라우터 안에 두면 화면
// 마다 같은 줄을 다시 붙여야 하고, 그중 하나는 빠진다.
//
// 세로 상자가 두 겹인 것은 셸의 높이 계약(MOMO-610) 때문이다. 배너는 자기 높이를
// 가져가고 앱은 **남은 높이**를 받아야 하며, 문서 자체는 절대 스크롤되지 않는다.
// `min-h-0`이 그 두 번째 문장을 지킨다: 없으면 자식의 내용 높이가 바닥이 되어
// 창보다 큰 문서가 만들어지고, 사이드바가 화면 밖으로 밀려난다. 배너가 아무것도
// 그리지 않는 평소(데스크탑, 이미 설치, 이미 본 사람)에는 앱이 예전과 똑같이
// 창 전체를 받는다.
function render() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.Fragment>
      <QueryClientProvider client={queryClient}>
        <div className="flex h-full min-h-0 flex-col">
          <PwaBanner />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <App />
          </div>
        </div>
      </QueryClientProvider>
    </React.Fragment>
  );
}

// 첫 프레임보다 먼저 (goal B10). 여기서 하는 일은 리스너를 거는 것뿐이고,
// 서비스 워커 등록은 store.ts가 load 이후로 미룬다. 그래서 렌더와 경쟁하지
// 않으면서, 아주 이른 프레임에 올 수 있는 beforeinstallprompt를 놓치지 않는다.
startPwa();

// Settle session storage BEFORE the first render (ADR-0133 P2, MOMO-603). In the
// desktop shell the refresh token comes from the OS keychain, which is async, and
// the first render decides "restoring vs anonymous" synchronously and for good —
// rendering first would strand a signed-in person on the login screen. In a
// browser this resolves on the first microtask, because localStorage was already
// read at import. `initSessionStore` never rejects; `finally` keeps the app
// booting even if that ever stops being true.
void initSessionStore().finally(render);

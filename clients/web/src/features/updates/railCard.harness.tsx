import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { UpdateButton } from "@/features/updates/UpdateButton";
import { seedUpdateStateForTest } from "@/features/updates/store";

/**
 * 접힌 레일 카드 자리 시험대(#5661 수리 2회차 H2). 제품 경로가 아니다. 앱과 같은 줄기로 왼쪽 레일(바닥에 「업데이트」 알약과 아바타)과
 * 대화 판(바닥에 입력창 독 `composer-dock` · 그릇 `composer-card`)을 세우고, 설치를 마친 업데이트를 심어 카드가 저절로 열리게 한다.
 * `window.__railCardMode`: "hold"(작업을 기다림) · "countdown"(기다린 뒤 예고).
 */

const UPDATE = { version: "0.1.46", currentVersion: "0.1.45", notes: null, publishedAt: null };

export function Shell() {
  return createElement(
    "div",
    { className: "flex h-full" },
    createElement(
      "nav",
      { "data-testid": "workspace-rail", className: "flex w-14 shrink-0 flex-col items-center justify-end gap-2 pb-3" },
      createElement(UpdateButton, { placement: "rail" }),
      createElement("div", { "data-testid": "profile-card", className: "size-8 rounded-full bg-surface-muted" })
    ),
    createElement(
      "main",
      { className: "flex min-w-0 flex-1 flex-col" },
      createElement("div", { className: "min-h-0 flex-1" }),
      createElement(
        "div",
        { "data-composer-shell": "", "data-testid": "composer", className: "composer-dock shrink-0" },
        createElement(
          "div",
          { className: "composer-card" },
          createElement("textarea", { "data-testid": "composer-input", rows: 3, className: "w-full" })
        )
      )
    )
  );
}

if (window.__railCardMode === "countdown") seedUpdateStateForTest({ kind: "installed", update: UPDATE }, 30, null);
else seedUpdateStateForTest({ kind: "installed", update: UPDATE }, null, { cut: { kind: "busy", panes: 1, sessions: 0, unknown: false } });

const root = document.getElementById("root");
if (root) createRoot(root).render(createElement(Shell));

declare global {
  interface Window {
    __railCardMode?: "hold" | "countdown";
  }
}

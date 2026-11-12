import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BEFORE_RELAUNCH_EVENT } from "@/features/updates/relaunchFlush";
import { UpdateButton } from "@/features/updates/UpdateButton";
import { seedUpdateStateForTest } from "@/features/updates/store";

/**
 * 업데이트 카드 시험대(#5661 수리 2·3회차). 제품 경로가 아니다. 앱과 같은 줄기로 왼쪽 열과 대화 판(바닥에 입력창 독 `composer-dock` ·
 * 그릇 `composer-card`)을 세우고, 설치를 마친 업데이트를 심어 카드가 저절로 열리게 한다.
 * - `window.__railCardMode`: "hold"(작업을 기다림) · "countdown"(기다린 뒤 예고).
 * - `window.__railCardPlacement`: "rail"(접힌 레일 바닥, 기본) · "row"(펼친 사이드바의 프로필 줄).
 * - `window.__railCard.relaunches()`: 다시 시작 문을 지난 횟수(다시 시작 직전 신호 `BEFORE_RELAUNCH_EVENT`를 센다).
 */

const UPDATE = { version: "0.1.46", currentVersion: "0.1.45", notes: null, publishedAt: null };
const placement = window.__railCardPlacement ?? "rail";
let relaunches = 0;
window.addEventListener(BEFORE_RELAUNCH_EVENT, () => {
  relaunches += 1;
});

export function Shell() {
  const side =
    placement === "rail"
      ? createElement(
          "nav",
          { "data-testid": "workspace-rail", className: "flex w-14 shrink-0 flex-col items-center justify-end gap-2 pb-3" },
          createElement(UpdateButton, { placement: "rail" }),
          createElement("div", { "data-testid": "profile-card", className: "size-8 rounded-full bg-surface-muted" })
        )
      : createElement(
          "aside",
          { className: "flex w-pane-picker shrink-0 flex-col justify-end p-2" },
          createElement(
            "div",
            { "data-testid": "sidebar-profile-foot", className: "flex items-center gap-1 pt-2" },
            createElement("div", { "data-testid": "profile-card", className: "size-8 rounded-full bg-surface-muted" }),
            createElement(UpdateButton, { placement: "row" })
          )
        );
  return createElement(
    "div",
    { className: "flex h-full" },
    side,
    createElement(
      "main",
      { className: "flex min-w-0 flex-1 flex-col" },
      createElement("p", { "data-testid": "conversation", className: "min-h-0 flex-1 p-4" }),
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

window.__railCard = { relaunches: () => relaunches };

const root = document.getElementById("root");
if (root) createRoot(root).render(createElement(Shell));

declare global {
  interface Window {
    __railCardMode?: "hold" | "countdown";
    __railCardPlacement?: "rail" | "row";
    __railCard: { relaunches: () => number };
  }
}

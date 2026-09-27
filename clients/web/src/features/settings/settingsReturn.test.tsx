// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_CONNECT_SETTINGS_HASH,
  aiConnectReturnHash,
  leaveAiConnectReentry,
  openAiConnectReentry,
  readAiConnectReentry,
} from "@/features/welcome/aiConnectReentry";
import { leaveSettings } from "./settingsReturn";

// =============================================================================
// #2938 ③ 「앱으로 돌아가기」 무한 루프.
//
// 재현(성재 0.1.12): 설정 › AI 연결 → 「구독 추가」(재진입 #/ai-connect) → [뒤로]
// → 「앱으로 돌아가기」가 설정을 나가지 않고 AI 연결 화면으로 다시 간다.
//
// 원인: 재진입의 닫기가 출발지 해시를 **새 항목으로 쌓았다**(`location.hash =`).
// 스택은 [앱, 설정, ai-connect, 설정?section=ai]가 되고, 「앱으로 돌아가기」는
// navigate(-1)이라 바로 아래의 ai-connect로 간다. 거기서 다시 [뒤로]를 누르면
// 설정이 하나 더 쌓여 끝나지 않는다.
//
// 이 시험은 실제 HashRouter와 실제 열기·닫기·돌아가기 함수로 진입 경로별 복귀를
// 잰다. 화면은 이 세 함수만 부르는 얇은 대역이다(FirstAgentStage·SettingsRoute가
// 같은 함수를 부르는 것은 각자의 시험이 잰다).
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.history.replaceState(null, "", "/#/");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function Place({ name }: { name: string }) {
  const navigate = useNavigate();
  return createElement(
    "div",
    { "data-testid": `place-${name}` },
    createElement(
      "button",
      { type: "button", "data-testid": "to-settings", onClick: () => navigate("/settings") },
      "설정"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "to-reentry-agents",
        onClick: () => openAiConnectReentry("agents"),
      },
      "구독 연결"
    )
  );
}

function SettingsStub() {
  const navigate = useNavigate();
  return createElement(
    "div",
    { "data-testid": "place-settings" },
    createElement(
      "button",
      { type: "button", "data-testid": "back-to-app", onClick: () => leaveSettings(navigate) },
      "앱으로 돌아가기"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "subscription-add",
        onClick: () => openAiConnectReentry("settings"),
      },
      "구독 추가"
    )
  );
}

function ReentryStub() {
  const from = readAiConnectReentry(window.location.hash)?.from ?? "agents";
  return createElement(
    "div",
    { "data-testid": "place-ai-connect" },
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "reentry-back",
        onClick: () => leaveAiConnectReentry(aiConnectReturnHash(from)),
      },
      "뒤로"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "reentry-api-key",
        onClick: () => leaveAiConnectReentry(AI_CONNECT_SETTINGS_HASH),
      },
      "API 키"
    )
  );
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        HashRouter,
        null,
        createElement(
          Routes,
          null,
          createElement(Route, { path: "/", element: createElement(Place, { name: "home" }) }),
          createElement(Route, {
            path: "/channels/:id",
            element: createElement(Place, { name: "channel" }),
          }),
          createElement(Route, { path: "/agents", element: createElement(Place, { name: "agents" }) }),
          createElement(Route, { path: "/settings", element: createElement(SettingsStub) }),
          createElement(Route, { path: "/ai-connect", element: createElement(ReentryStub) })
        )
      )
    );
  });
}

function place(): string | null {
  return (
    document.querySelector("[data-testid^='place-']")?.getAttribute("data-testid")?.slice(6) ??
    null
  );
}

async function press(testId: string): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
  });
}

/** 히스토리 이동은 jsdom에서도 비동기다. 도착한 자리를 기다린다. */
async function arrive(name: string): Promise<void> {
  await vi.waitFor(() => expect(place()).toBe(name), { timeout: 2_000 });
  // 한 번 더 도는 이동(루프)이 있으면 여기서 드러나게 잠깐 더 흘린다.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(place()).toBe(name);
}

/** 설정 → 구독 추가 → [뒤로] → 설정 AI 절 → 「앱으로 돌아가기」. */
async function roundTripFromSettings(): Promise<void> {
  await press("subscription-add");
  await arrive("ai-connect");
  await press("reentry-back");
  await arrive("settings");
  expect(window.location.hash).toBe("#/settings?section=ai");
  await press("back-to-app");
}

describe("#2938 ③ 설정 진입 경로별 「앱으로 돌아가기」", () => {
  it("사이드바(프로필 메뉴)로 들어온 설정: 재진입을 다녀와도 홈으로 나간다", async () => {
    await mount();
    await arrive("home");
    await press("to-settings");
    await arrive("settings");
    await roundTripFromSettings();
    await arrive("home");
  });

  it("⌘K로 채널에서 들어온 설정: 원래 채널로 나간다", async () => {
    window.history.replaceState(null, "", "/#/channels/c1");
    await mount();
    await arrive("channel");
    await press("to-settings");
    await arrive("settings");
    await roundTripFromSettings();
    await arrive("channel");
    expect(window.location.hash).toBe("#/channels/c1");
  });

  it("재진입을 두 번 다녀와도 한 번에 나간다", async () => {
    await mount();
    await press("to-settings");
    await arrive("settings");
    await press("subscription-add");
    await arrive("ai-connect");
    await press("reentry-back");
    await arrive("settings");
    await roundTripFromSettings();
    await arrive("home");
  });

  it("딥링크로 앱이 설정에서 시작했다: 앱 밖이 아니라 홈으로 나간다", async () => {
    // 앞에 다른 사이트(여기서는 채널 주소)가 있어도 한 칸 뒤로 나가지 않는다.
    window.history.pushState(null, "", "/#/channels/outside");
    window.history.pushState(null, "", "/#/settings?section=ai");
    await mount();
    await arrive("settings");
    await roundTripFromSettings();
    await arrive("home");
  });

  it("온보딩 뒤(셸 밖에서 해시로 설정에 옴): 홈으로 나간다", async () => {
    // 온보딩은 HashRouter 밖에서 `location.hash =`로 설정 AI 절에 넘긴다.
    window.history.pushState(null, "", "/#/channels/outside");
    window.location.hash = "#/settings?section=ai";
    await mount();
    await arrive("settings");
    await roundTripFromSettings();
    await arrive("home");
  });

  it("재진입 주소로 바로 열린 앱: 닫으면 설정, 설정에서 나가면 홈", async () => {
    window.history.pushState(null, "", "/#/channels/outside");
    window.history.pushState(null, "", "/#/ai-connect?from=settings");
    await mount();
    await arrive("ai-connect");
    await press("reentry-back");
    await arrive("settings");
    await press("back-to-app");
    await arrive("home");
  });

  it("에이전트 화면 → 재진입 → API 키 줄(설정) → 돌아가기는 에이전트 화면이다", async () => {
    window.history.replaceState(null, "", "/#/agents");
    await mount();
    await arrive("agents");
    await press("to-reentry-agents");
    await arrive("ai-connect");
    await press("reentry-api-key");
    await arrive("settings");
    await press("back-to-app");
    await arrive("agents");
  });

  it("에이전트 화면에서 연 재진입의 [뒤로]는 에이전트 화면이고, 거기서 브라우저 뒤로가 재진입을 다시 열지 않는다", async () => {
    window.history.replaceState(null, "", "/#/agents");
    await mount();
    await press("to-reentry-agents");
    await arrive("ai-connect");
    await press("reentry-back");
    await arrive("agents");
    await act(async () => {
      window.history.back();
    });
    await vi.waitFor(() => expect(place()).not.toBe("agents"), { timeout: 2_000 }).catch(() => undefined);
    expect(place()).not.toBe("ai-connect");
  });
});

// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { __peekEntryDraft, __resetEntryDrafts, statusDraftKey } from "@/lib/entryDrafts";
import { SetStatusDialog } from "./SetStatusDialog";

// 알림 클릭이 상태 설정 대화상자(내 프로필의 상태 편집)를 닫아도 쓰던 입력은 남는다(#5058). 데스크탑은 포커스로 클릭을 어림해, 글을
// 쓰다 다른 창에 갔다 돌아온 것만으로도 걷힐 수 있다. 폰의 `entryDrafts` 와 같은 규칙: 방송이 올 때만 맡기고, 다시 열 때 한 번 돌려준다.

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const NOW = 1_800_000_000_000;

vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  __resetEntryDrafts();
  HTMLElement.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const SELF: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  presenceStatus: "auto",
  statusEmoji: "🏠",
  statusText: "재택",
  statusExpiresAtMs: NOW + 3 * 60 * 60_000,
  createdAtMs: 0,
  updatedAtMs: 0,
};

const session: SessionContextValue = {
  session: {
    accessToken: "access",
    refreshToken: "refresh",
    member: { id: MEMBER_ID, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

/** 프로필 카드가 쥐는 모양 그대로 — 열림은 호스트의 상태이고 대화상자는 마운트된 채 열림만 바뀐다. */
function Host() {
  const [open, setOpen] = useState(true);
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "reopen", onClick: () => setOpen(true) }, "열기"),
    createElement(SetStatusDialog, {
      open,
      onOpenChange: setOpen,
      workspaceId: WS,
      selfMemberId: MEMBER_ID,
      selfMember: SELF,
      opener: null,
      nowMs: NOW,
    })
  );
}

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mountedHost = document.createElement("div");
  document.body.append(mountedHost);
  mountedRoot = createRoot(mountedHost);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(SessionProvider, { value: session }, createElement(Host))
  );
  act(() => mountedRoot?.render(tree));
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="set-status-dialog"]');
const field = () => document.querySelector<HTMLInputElement>('[data-testid="set-status-text"]')!;
const click = (testId: string) =>
  act(async () => {
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
  });
const typeText = (value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
const enter = () =>
  act(async () => {
    dismissTemporarySurfaces();
  });

describe("상태 설정 대화상자 — 알림 클릭이 닫아도 쓰던 입력은 남는다 (#5058)", () => {
  it("고친 글이 있는 채 알림 클릭이 닫으면, 다시 연 대화상자가 그 글로 선다 — 한 번만이고 사람이 닫으면 저장된 상태로 돌아간다", async () => {
    mount();
    expect(field().value).toBe("재택");
    await typeText("회의가 길어져요");

    await enter();
    expect(dialog()).toBeNull();
    // 맡겨졌다 — 아래의 값이 「저장된 상태가 그대로 보인다」로 헛돌지 않는다는 증거.
    expect(__peekEntryDraft(statusDraftKey(WS))).toMatchObject({ text: "회의가 길어져요", emoji: "🏠" });

    await click("reopen");
    expect(field().value).toBe("회의가 길어져요");
    expect(__peekEntryDraft(statusDraftKey(WS))).toBeUndefined();

    // 돌려받은 대화상자를 사람이 취소로 닫으면 평소처럼 버려진다 — 다음에 연 대화상자는 저장된 상태에서 시작한다.
    await click("set-status-cancel");
    expect(dialog()).toBeNull();
    await click("reopen");
    expect(field().value).toBe("재택");
  });

  it("고친 것이 없으면 맡기지 않고, 사람이 취소로 닫은 대화상자도 맡기지 않는다", async () => {
    mount();
    await enter();
    expect(dialog()).toBeNull();
    expect(__peekEntryDraft(statusDraftKey(WS))).toBeUndefined();

    await click("reopen");
    await typeText("회의가 길어져요");
    await click("set-status-cancel");
    expect(dialog()).toBeNull();
    expect(__peekEntryDraft(statusDraftKey(WS))).toBeUndefined();

    await click("reopen");
    expect(field().value).toBe("재택");
  });
});

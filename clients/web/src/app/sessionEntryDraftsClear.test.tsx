// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { clearSession, markAuthExpired } from "@/lib/session";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";
import { __peekEntryDraft, __resetEntryDrafts, useHoldDraftOnEntry } from "@/lib/entryDrafts";

// #5058: 알림 클릭이 걷어 간 대화상자의 입력(`lib/entryDrafts.ts`)은 「이 페이지에서 이 사람이 쓰던 글」이라 계정 경계에서 지워져야 한다.
// 같은 페이지에서 같은 워크스페이스로 다른 사람이 이어 들어오면 앞 사람의 검색어·상태 문구가 그 사람의 대화상자에 나타난다.
// 지우는 함수가 있어도 **부르는 자리**가 빠지면 아무 일도 안 하므로 세션 훅 쪽을 따로 잠근다 — 로그아웃과 로그인 만료 둘 다다.
// (`sessionDownloadHistoryClear.test.tsx` 는 같은 규칙을 호출 횟수로 잰다. 여기는 **맡겨 둔 값이 실제로 사라졌는가**로 잰다.)

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  logout: vi.fn(async () => undefined),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let lifecycle: SessionLifecycle | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  __resetEntryDrafts();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  lifecycle = null;
  clearSession();
});

const KEY = "ws:new-dm";

/** 세션 훅과, 방송이 오면 입력을 맡기는 대화상자 하나 — 두 훅이 한 트리에 있다. */
function Probe() {
  lifecycle = useRestoredSession();
  useHoldDraftOnEntry<string>(KEY, () => "쓰던 검색어");
  return null;
}

async function mountProbe(): Promise<SessionLifecycle> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
  if (lifecycle === null) throw new Error("hook did not render");
  return lifecycle;
}

const LOGIN = {
  accessToken: "access",
  refreshToken: "refresh",
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  member: {
    id: "00000000-0000-7000-8000-0000000001ff",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  },
} as unknown as LoginResponse;

/** 알림 클릭이 대화상자를 걷는다 — 쓰던 입력이 맡겨진다. 맡겨졌다는 것을 먼저 확인해 아래의 「사라졌다」가 헛돌지 않게 한다. */
async function holdADraft(): Promise<void> {
  await act(async () => {
    dismissTemporarySurfaces();
  });
  expect(__peekEntryDraft(KEY)).toBe("쓰던 검색어");
}

describe("맡겨 둔 대화상자 입력은 계정 경계에서 지워진다 (#5058)", () => {
  it("로그아웃이 지운다. 로그인만으로는 지우지 않는다", async () => {
    const first = await mountProbe();
    await holdADraft();
    await act(async () => {
      first.signIn(LOGIN);
    });
    expect(__peekEntryDraft(KEY)).toBe("쓰던 검색어");

    await act(async () => {
      lifecycle?.signOut();
    });
    expect(__peekEntryDraft(KEY)).toBeUndefined();
  });

  it("로그인이 만료돼 로그인 화면으로 돌아갈 때도 지운다", async () => {
    const first = await mountProbe();
    await act(async () => {
      first.signIn(LOGIN);
    });
    await holdADraft();

    await act(async () => {
      markAuthExpired();
    });
    expect(__peekEntryDraft(KEY)).toBeUndefined();
  });
});

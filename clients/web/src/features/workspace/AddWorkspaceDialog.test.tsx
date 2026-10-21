// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { NEW_WORKSPACE_ENTRY_GUIDE } from "@/features/auth/loginWorkspaceEntry";
import { AddWorkspaceDialog, type WorkspaceDraft } from "./AddWorkspaceDialog";

// 레일 「+」 완료 패널의 막다른 길 (#4198, 멀티 조직 P0-A).
//
// 옛 패널은 슬러그로 다시 로그인하라고 말하면서 ID는 보여 주지 않았다. 로그인 폼이 받는 것은
// 슬러그가 아니라 워크스페이스 ID(UUID)이고 서버는 슬러그를 400으로 거절한다. 그래서 만든
// 사람은 들어갈 방법을 얻지 못했다.

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
/** 서버는 새 워크스페이스 ID를 대문자 UUID로 돌려준다(`CreatedWorkspace.workspaceId` 주석). */
const NEW_WS_ID = "019FA000-1111-7222-8333-444455556666";

const createWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    createWorkspace: (...args: unknown[]) => createWorkspaceMock(...args) as Promise<unknown>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
const writeText = vi.fn();

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  createWorkspaceMock.mockReset();
  createWorkspaceMock.mockResolvedValue({
    schema: "momo.workspace.created.v1",
    workspaceId: NEW_WS_ID,
    slug: "design-team",
    name: "디자인팀",
  });
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
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
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  Reflect.deleteProperty(window.navigator, "clipboard");
  vi.unstubAllGlobals();
});

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

/** 초안은 호출자(AddWorkspaceProvider)가 들고 있다. 같은 모양으로 상태를 들고 선다. */
function Harness() {
  const [draft, setDraft] = useState<WorkspaceDraft>({ name: "", slug: "" });
  return createElement(AddWorkspaceDialog, {
    open: true,
    onOpenChange: () => undefined,
    draft,
    setDraft,
  });
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() =>
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: sessionValue() }, createElement(Harness))
      )
    )
  );
}

/** 대화상자는 포털로 body에 선다. */
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function createThroughTheDialog() {
  mount();
  act(() => setInputValue(q("add-workspace-name") as HTMLInputElement, "디자인팀"));
  act(() => setInputValue(q("add-workspace-slug") as HTMLInputElement, "design-team"));
  await act(async () => {
    q("add-workspace-submit")?.click();
  });
  await vi.waitFor(() => {
    expect(q("add-workspace-created")).not.toBeNull();
  });
}

describe("워크스페이스 추가 완료 패널 (#4198)", () => {
  it("응답의 워크스페이스 ID가 패널 글자에 그대로 들어 있다(줄을 지우면 빨개진다)", async () => {
    await createThroughTheDialog();
    expect(createWorkspaceMock).toHaveBeenCalledWith("design-team", "디자인팀");

    const panel = q("add-workspace-created");
    // 서버가 준 모양 그대로(대문자) 보여 준다: 다시 쓰거나 줄이면 붙여 넣는 값이 달라진다.
    expect(panel?.textContent).toContain(NEW_WS_ID);
    expect(q("add-workspace-created-id")?.textContent).toBe(NEW_WS_ID);
    // 슬러그는 이름표로 남는다. 로그인 값이 아니라는 것은 아래 안내가 말한다.
    expect(panel?.textContent).toContain("design-team");
  });

  it("「복사」 단추가 그 ID를 클립보드에 쓰고 「복사됨」으로 바뀐다", async () => {
    await createThroughTheDialog();
    const copy = q("add-workspace-created-copy") as HTMLButtonElement | null;
    expect(copy).not.toBeNull();
    expect(copy?.textContent).toBe("복사");
    // 보이는 글자는 짧고, 접근 이름은 무엇을 복사하는지 말한다(보이는 글자를 포함한다).
    expect(copy?.getAttribute("aria-label")).toBe("워크스페이스 ID 복사");

    await act(async () => {
      copy?.click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(NEW_WS_ID);
    await vi.waitFor(() => {
      expect(copy?.textContent).toBe("복사됨");
    });
    expect(copy?.getAttribute("aria-label")).toBe("워크스페이스 ID 복사됨");
  });

  it("안내는 로그인 화면이 실제로 받는 길을 이름으로 말하고, 슬러그로 들어간다고 하지 않는다", async () => {
    await createThroughTheDialog();
    const text = q("add-workspace-created")?.textContent ?? "";

    expect(q("add-workspace-created-guide")?.textContent).toBe(NEW_WORKSPACE_ENTRY_GUIDE);
    // 두 낱말은 로그인 화면(ConnectPage)의 접힘 단추·칸 이름이다. ConnectPage.test.tsx가 그쪽 글자를
    // 따로 고정하므로 어느 한쪽만 바뀌면 둘 중 하나가 빨개진다.
    expect(text).toContain("로그아웃한 뒤");
    expect(text).toContain("「다른 워크스페이스로 로그인」");
    expect(text).toContain("워크스페이스 ID 칸");
    // 슬러그 로그인(P1-A)이 서버에 들어오기 전까지 슬러그는 로그인 값이 아니다.
    expect(text).not.toContain("그 슬러그로 다시 로그인");
    expect(text).not.toMatch(/슬러그로/);
    // 설정 화면의 합쇼체 금지와 같은 문체 규칙: 해요체.
    expect(text).not.toMatch(/(습니다|됩니다|십시오)/);
  });
});

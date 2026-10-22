// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import {
  NEW_WORKSPACE_ENTRY_GUIDE,
  NEW_WORKSPACE_ENTRY_TEXT,
  NEW_WORKSPACE_ID_ONCE_NOTICE,
} from "@/features/auth/loginWorkspaceEntry";
import { AddWorkspaceDialog, type WorkspaceDraft } from "./AddWorkspaceDialog";

// 레일 「+」 완료 패널의 막다른 길 (#4198, 멀티 조직 P0-A).
//
// 옛 패널은 슬러그로 다시 로그인하라고 말하면서 ID는 보여 주지 않았다. 로그인 폼이 받는 것은
// 슬러그가 아니라 워크스페이스 ID(UUID)이고 서버는 슬러그를 400으로 거절한다. 그래서 만든
// 사람은 들어갈 방법을 얻지 못했다.

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
/**
 * 코어 타입 주석(`CreatedWorkspace.workspaceId`)은 서버 UUID가 대문자로 올 수 있다고 경고한다(옛 Swift
 * 서버). 지금 Rust 서버는 소문자를 돌려준다(`workspaces.rs` `Uuid::to_string()`). 시험은 일부러
 * 대문자 값을 써서 「받은 모양 그대로」를 못 박는다: 줄이거나 다시 쓰면(`toLowerCase` 등) 붙여 넣는
 * 값이 달라진다.
 */
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
  onOpenChange.mockReset();
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

/**
 * 초안은 호출자(AddWorkspaceProvider)가 들고 있다. 같은 모양으로 상태를 들고 선다. `open`은 늘 참이라
 * 닫으려는 시도는 `onOpenChange(false)` 호출로만 보인다.
 */
function Harness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState<WorkspaceDraft>({ name: "", slug: "" });
  return createElement(AddWorkspaceDialog, {
    open: true,
    onOpenChange,
    draft,
    setDraft,
  });
}

const onOpenChange = vi.fn();

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
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(Harness, { onOpenChange })
        )
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

/**
 * 스크림을 누른다. 이 Radix 판은 바깥 누름의 해제를 pointerdown이 아니라 이어지는 click까지
 * 미루고(`deferPointerDownOutside`), 누른 자리가 해제 면(스크림)이 아니면 그 상호작용을 다른 곳이
 * 가져간 것으로 보고 해제하지 않는다. 그래서 `body`가 아니라 스크림에 두 이벤트를 모두 보낸다.
 */
function clickScrim() {
  const scrim = document.querySelector('[data-overlay-layer="scrim"]');
  if (!scrim) throw new Error("scrim not found");
  act(() => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      scrim.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  });
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

    expect(q("add-workspace-created-guide")?.textContent).toBe(NEW_WORKSPACE_ENTRY_TEXT);
    expect(text).toContain(NEW_WORKSPACE_ENTRY_GUIDE);
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

  it("한 번만 보인다는 사실을 말한다: 이 화면을 벗어나면 ID를 다시 볼 수 없다", async () => {
    await createThroughTheDialog();
    const text = q("add-workspace-created")?.textContent ?? "";
    expect(text).toContain(NEW_WORKSPACE_ID_ONCE_NOTICE);
    // 문장이 바뀌어도 사실과 행동(벗어나기 전에 복사)은 남아야 한다.
    expect(text).toContain("다시 볼 수 없");
    expect(text).toContain("복사해 두세요");
  });

  it("완료 직후 초점이 이름 붙은 완료 묶음으로 간다(눌렀던 만들기 단추는 사라졌다)", async () => {
    await createThroughTheDialog();
    const group = q("add-workspace-created");
    // status(live region)가 아니라 group이다: 36자 ID와 안내가 뜨는 순간 통째로 낭독되지 않는다.
    expect(group?.getAttribute("role")).toBe("group");
    expect(document.activeElement).toBe(group);
    const labelledBy = group?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toBe("디자인팀 워크스페이스를 만들었어요.");
  });

  it("나가는 길 「닫기」는 스크롤 상자 밖 바닥에 있다(낮은 창에서 내용만 스크롤된다)", async () => {
    await createThroughTheDialog();
    // Esc·바깥 클릭을 막은 분기의 유일한 출구다. 스크롤 상자 안에 있거나 상자가 없으면 패널 높이
    // 상한 아래로 흘러내려 낮은 창(가로 폰 667x375, 브라우저 200%)에서 화면 밖에 걸린다
    // (design-review 2차 B1, 실측). jsdom은 레이아웃을 재지 못하므로 구조로 못 박고, 높이 축의
    // 실측은 capture-4198.mjs의 낮은 창 장면이 진다.
    const group = q("add-workspace-created");
    const done = q("add-workspace-done");
    const scroller = group?.closest(".overflow-y-auto") ?? null;
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(done ?? null)).toBe(false);
    // 폼 분기와 같은 모양: 출구는 위에 선 한 줄 선(border-t) 바닥 줄에 있다.
    expect(done?.parentElement?.className).toContain("border-t");
  });

  it("만드는 중에도 Esc와 바깥 클릭으로는 닫히지 않는다", async () => {
    let resolveCreate: (value: unknown) => void = () => undefined;
    createWorkspaceMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );
    mount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => setInputValue(q("add-workspace-name") as HTMLInputElement, "디자인팀"));
    act(() => setInputValue(q("add-workspace-slug") as HTMLInputElement, "design-team"));
    await act(async () => {
      q("add-workspace-submit")?.click();
    });
    expect(q("add-workspace-submit")?.getAttribute("aria-busy")).toBe("true");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    clickScrim();
    expect(onOpenChange).not.toHaveBeenCalled();

    // 응답이 오면 완료 묶음이 선다(요청이 날아가는 동안 닫히지 않았으므로 ID를 받는다).
    await act(async () => {
      resolveCreate({
        schema: "momo.workspace.created.v1",
        workspaceId: NEW_WS_ID,
        slug: "design-team",
        name: "디자인팀",
      });
    });
    await vi.waitFor(() => {
      expect(q("add-workspace-created")?.textContent).toContain(NEW_WS_ID);
    });
  });

  it("완료 패널이 떠 있는 동안 Esc와 바깥 클릭으로는 닫히지 않고 「닫기」만 닫는다", async () => {
    mount();
    // 라이브러리가 바깥 누름 리스너를 다음 틱에 단다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 대조군: 폼이 떠 있을 때는 Esc가 닫는다(이 시험대가 닫으려는 시도를 볼 수 있다는 증거).
    // 실제 키 이벤트처럼 cancelable이어야 한다: cancelable이 아니면 `preventDefault()`가 아무것도
    // 막지 못해서 아래 단정이 거짓으로 빨개진다.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    // 바깥 누름도 같다. 이 대조군이 없으면 아래 「닫히지 않는다」는 라이브러리가 이 이벤트를 아예
    // 못 듣는 시험대에서도 초록이다.
    clickScrim();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();

    act(() => setInputValue(q("add-workspace-name") as HTMLInputElement, "디자인팀"));
    act(() => setInputValue(q("add-workspace-slug") as HTMLInputElement, "design-team"));
    await act(async () => {
      q("add-workspace-submit")?.click();
    });
    await vi.waitFor(() => {
      expect(q("add-workspace-created")).not.toBeNull();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 그 ID는 다른 어디에도 없다. 반사적인 Esc·바깥 클릭이 지우지 못한다.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    clickScrim();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(q("add-workspace-created")).not.toBeNull();

    // 나가는 길은 이름 붙은 하나다.
    act(() => q("add-workspace-done")?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { RosterMember } from "@momo/core/lib/api";
import { parseJoinFromPageUrl } from "@momo/core/features/auth/deepLink";
import { LocaleContext } from "@/i18n/localeContext";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import {
  NEW_WORKSPACE_ENTRY_GUIDE,
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
const fetchRosterMock = vi.hoisted(() => vi.fn());
const logoutMock = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: (...args: unknown[]) => fetchRosterMock(...args) as Promise<unknown>,
  };
});

// 닿는지 보는 걸음은 진짜 fetch를 타지 않는다(jsdom): 시험마다 답을 정한다.
const probeMock = vi.hoisted(() => vi.fn());
vi.mock("./joinHandoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./joinHandoff")>();
  return { ...actual, probeServerReachable: (...args: unknown[]) => probeMock(...args) as Promise<boolean> };
});

// 셸 판정: 웹(false)은 다른 서버를 새 탭으로 열고, 데스크탑(true)은 확인 → 로그아웃 → 넘김이다.
const shell = vi.hoisted(() => ({ tauri: false }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return shell.tauri;
    },
  };
});

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
let korean: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

/** 명부의 내 줄. 역할이 「만들기」 카드의 말을 가른다(소유자·관리자 / 멤버·게스트). */
function selfRow(role: RosterMember["role"]): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "김도현",
    handle: "dohyeon",
    role,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

beforeEach(() => {
  onOpenChange.mockReset();
  createWorkspaceMock.mockReset();
  createWorkspaceMock.mockResolvedValue({
    schema: "momo.workspace.created.v1",
    workspaceId: NEW_WS_ID,
    slug: "design-team",
    name: "디자인팀",
  });
  fetchRosterMock.mockReset();
  fetchRosterMock.mockResolvedValue([selfRow("owner")]);
  logoutMock.mockReset();
  shell.tauri = false;
  probeMock.mockReset();
  probeMock.mockResolvedValue(true);
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
        displayName: "김도현",
        handle: "dohyeon",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: logoutMock,
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
          createElement(
            LocaleContext.Provider,
            { value: korean },
            createElement(Harness, { onOpenChange })
          )
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

/** 첫 화면의 「새 워크스페이스 만들기」 카드를 눌러 폼으로 들어간다. */
async function openCreateForm() {
  await vi.waitFor(() => {
    expect(q("add-workspace-choose-create")).not.toBeNull();
  });
  await act(async () => {
    q("add-workspace-choose-create")?.click();
  });
  await vi.waitFor(() => {
    expect(q("add-workspace-name")).not.toBeNull();
  });
}

async function createThroughTheDialog() {
  mount();
  await openCreateForm();
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
    // 대화상자 전체: 경고는 머리의 설명이고 방법은 완료 묶음 안이다.
    const text = q("add-workspace-dialog")?.textContent ?? "";

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

  it("한 번만 보인다는 사실을 말한다: 이 화면을 벗어나면 ID를 다시 볼 수 없다", async () => {
    await createThroughTheDialog();
    const notice = q("add-workspace-created-notice");
    expect(notice?.textContent).toBe(NEW_WORKSPACE_ID_ONCE_NOTICE);
    // 문장이 바뀌어도 사실과 행동(벗어나기 전에 복사)은 남아야 한다.
    expect(notice?.textContent).toContain("다시 볼 수 없");
    expect(notice?.textContent).toContain("복사해 두세요");
    // 폼 설명(「새 워크스페이스를 만들거나 …」)은 만든 뒤에 쓸모가 없어서 그 자리를 경고가 쓴다.
    expect(q("add-workspace-dialog")?.textContent).not.toContain("만든 사람이 소유자가 되고");
  });

  it("경고는 값보다 앞에 서고 스크롤 상자 밖 고정 머리에 있다(낮은 창에서도 보인다), 방법은 값 뒤다", async () => {
    await createThroughTheDialog();
    const group = q("add-workspace-created");
    const notice = q("add-workspace-created-notice");
    const id = q("add-workspace-created-id");
    const guide = q("add-workspace-created-guide");
    expect(notice && id && guide).toBeTruthy();
    // 한 번만 보이는 값의 집 모양: 경고가 값보다 앞이다(OneTimeSecretCard·웹훅 발급 카드). 경고가 값
    // 뒤에 서면 낮은 창에서 접힌 아래로 사라져 Esc가 왜 안 닫히는지의 이유가 보이지 않는다
    // (design-review 3차 H1, 실측).
    expect(notice!.compareDocumentPosition(id!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(id!.compareDocumentPosition(guide!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 경고는 스크롤 상자 밖이다: 내용이 스크롤돼도 늘 화면에 있다.
    const scroller = group?.closest(".overflow-y-auto") ?? null;
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(notice ?? null)).toBe(false);
    // 초점이 묶음에 도착할 때 경고가 이름 다음에 낭독된다.
    expect(group?.getAttribute("aria-describedby")).toBe(notice?.id);
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
    await openCreateForm();
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

    await openCreateForm();
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

// =============================================================================
// #5785 (QA 14 1단): 첫 화면은 두 카드다. 만들기 / 이미 있는 곳에 참여.
// =============================================================================

const text = (id: string) => q(id)?.textContent ?? "";
const press = (key: string) =>
  act(() => {
    (document.activeElement as HTMLElement | null)?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });

async function waitForRoster() {
  await vi.waitFor(() => expect(fetchRosterMock).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openJoin() {
  await vi.waitFor(() => expect(q("add-workspace-choose-join")).not.toBeNull());
  await act(async () => {
    q("add-workspace-choose-join")?.click();
  });
  await vi.waitFor(() => expect(q("add-workspace-join-link")).not.toBeNull());
}

async function submitJoin(value: string) {
  act(() => setInputValue(q("add-workspace-join-link") as HTMLInputElement, value));
  await act(async () => {
    q("add-workspace-join-next")?.click();
  });
}

describe("워크스페이스 추가: 두 카드 (#5785)", () => {
  it("첫 화면은 큰 제목 + 한 줄 설명 아래 두 카드이고, 폼은 아직 없다", async () => {
    mount();
    await waitForRoster();
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("choose");
    expect(text("add-workspace-dialog")).toContain("워크스페이스 추가");
    expect(text("add-workspace-choose-create")).toContain("새 워크스페이스 만들기");
    expect(text("add-workspace-choose-join")).toContain("이미 있는 곳에 참여");
    expect(q("add-workspace-name")).toBeNull();
    // 참여 카드는 지금 하는 일을 숨기지 않는다: 로그아웃한 뒤 로그인 화면에서 이어 간다.
    expect(text("add-workspace-choose-join")).toContain("로그아웃한 뒤 로그인 화면");
  });

  it("두 카드는 Tab 순서의 단추이고 ↑/↓로 오간다(끝에서 감는다)", async () => {
    mount();
    await waitForRoster();
    const create = q("add-workspace-choose-create")!;
    const join = q("add-workspace-choose-join")!;
    for (const card of [create, join]) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.getAttribute("tabindex")).toBeNull();
    }
    act(() => create.focus());
    press("ArrowDown");
    expect(document.activeElement).toBe(join);
    press("ArrowDown");
    expect(document.activeElement).toBe(create);
    press("ArrowUp");
    expect(document.activeElement).toBe(join);
    // 카드의 접근 이름은 제목이고 설명은 한 문장이다(아이콘·화살표는 읽지 않는다).
    const name = document.getElementById(join.getAttribute("aria-labelledby") ?? "");
    expect(name?.textContent).toBe("이미 있는 곳에 참여");
  });

  it("소유자에게 만들기 카드는 「서버 운영자만」을 말하고 누르면 폼, 초점은 이름 칸", async () => {
    mount();
    await waitForRoster();
    const card = q("add-workspace-choose-create")!;
    expect(card.getAttribute("aria-disabled")).toBeNull();
    expect(card.textContent).toContain("서버 운영자만 만들 수 있어요");
    await act(async () => card.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("add-workspace-name")));
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("create");
  });

  it("명부가 멤버로 확정되면 만들기 카드는 「이 계정으로는 만들 수 없어요」이고 폼으로 가지 않는다", async () => {
    fetchRosterMock.mockResolvedValue([selfRow("member")]);
    mount();
    await waitForRoster();
    await vi.waitFor(() =>
      expect(q("add-workspace-choose-create")?.getAttribute("aria-disabled")).toBe("true")
    );
    const card = q("add-workspace-choose-create")!;
    expect(card.textContent).toContain("이 계정으로는 만들 수 없어요");
    // 숨기지 않는다: 이유가 보이고 Tab으로 닿는다.
    expect(card.getAttribute("tabindex")).toBeNull();
    await act(async () => card.click());
    expect(q("add-workspace-name")).toBeNull();
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("choose");
  });

  it("명부를 아직 못 읽었으면 단정하지 않는다(누구에게나 참인 문장, 카드는 열린다)", async () => {
    fetchRosterMock.mockReturnValue(new Promise(() => undefined));
    mount();
    const card = q("add-workspace-choose-create")!;
    expect(card.getAttribute("aria-disabled")).toBeNull();
    expect(card.textContent).toContain("서버 운영자만 만들 수 있어요");
  });

  it("「뒤로」는 첫 화면으로 돌아가 눌렀던 카드에 초점을 놓고, 만들기 초안은 남는다", async () => {
    mount();
    await waitForRoster();
    await openCreateForm();
    act(() => setInputValue(q("add-workspace-name") as HTMLInputElement, "디자인팀"));
    await act(async () => q("add-workspace-back")?.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("add-workspace-choose-create")));
    await openCreateForm();
    expect((q("add-workspace-name") as HTMLInputElement).value).toBe("디자인팀");
  });
});

describe("워크스페이스 추가: 이미 있는 곳에 참여 (#5785)", () => {
  // 서버가 만드는 초대 코드 모양(22자 이상 base64url). 시험용 값이다.
  const INVITE = "Q".repeat(24);
  // 데스크탑 길(확인 → 확인 걸음 → 그 자리에서 로그아웃·넘김). 웹 길은 아래 「웹」 묶음이다.
  beforeEach(() => {
    shell.tauri = true;
  });

  it("빈 칸·읽을 수 없는 글·claim 링크는 그 칸에서 말하고 로그아웃하지 않는다", async () => {
    mount();
    await openJoin();
    expect(document.activeElement).toBe(q("add-workspace-join-link"));

    await submitJoin("");
    expect(text("add-workspace-join-link-error")).toBe("주소나 초대 링크를 넣으세요.");
    await submitJoin("그냥 글자");
    expect(text("add-workspace-join-link-error")).toContain("팀 주소나 초대 링크로 읽을 수 없습니다");
    await submitJoin("https://team.example.com/claim/");
    expect(q("add-workspace-join-link-error")).not.toBeNull();
    await submitJoin(`https://team.example.com/claim/${"C".repeat(43)}`);
    expect(text("add-workspace-join-link-error")).toContain("첫 소유자 링크와 재설정 링크");
    expect(q("add-workspace-join-link")?.getAttribute("aria-invalid")).toBe("true");
    expect(logoutMock).not.toHaveBeenCalled();
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("join");
  });

  it("주소를 넣으면 확인 걸음이 로그아웃과 넘어갈 곳을 말하고(초안은 말하지 않는다), 초점은 확인 묶음이다", async () => {
    mount();
    await openJoin();
    await submitJoin("team.example.com");
    await vi.waitFor(() =>
      expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("confirm")
    );
    const dialog = text("add-workspace-dialog");
    expect(dialog).toContain("로그아웃하고 넘어갈까요?");
    expect(dialog).toContain("로그아웃돼요");
    // 로그아웃 뒤에도 초안이 남는 기존 결함이 고쳐지기 전까지 「지워져요」는 거짓이다(#5785 수리 1회차).
    expect(dialog).not.toContain("초안");
    expect(text("add-workspace-join-target")).toBe("team.example.com의 로그인 화면으로 넘어가요.");
    await vi.waitFor(() => expect(document.activeElement).toBe(q("add-workspace-join-confirm")));
    // 확인 걸음은 아직 아무것도 하지 않았다.
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("확인하면 주소를 로그인 화면이 읽는 모양으로 얹은 뒤 로그아웃한다(서버 주소)", async () => {
    const before = window.location.href;
    mount();
    await openJoin();
    await submitJoin("https://team.example.com");
    await vi.waitFor(() => expect(q("add-workspace-join-logout")).not.toBeNull());
    let hrefAtLogout = "";
    logoutMock.mockImplementation(() => {
      hrefAtLogout = window.location.href;
    });
    await act(async () => q("add-workspace-join-logout")?.click());
    expect(logoutMock).toHaveBeenCalledTimes(1);
    // 로그아웃이 불린 순간에 주소가 이미 바뀌어 있다(로그인 화면은 마운트될 때 읽는다).
    expect(parseJoinFromPageUrl(hrefAtLogout)).toEqual({
      serverUrl: "https://team.example.com",
      inviteCode: "",
    });
    window.history.replaceState(null, "", before);
  });

  it("초대 링크면 서버와 초대 코드를 함께 넘긴다", async () => {
    const before = window.location.href;
    mount();
    await openJoin();
    await submitJoin(`초대 받았어요 https://team.example.com/?code=${INVITE} 여기로`);
    await vi.waitFor(() => expect(q("add-workspace-join-target")).not.toBeNull());
    expect(text("add-workspace-join-target")).toBe("team.example.com의 초대로 넘어가요.");
    await act(async () => q("add-workspace-join-logout")?.click());
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(parseJoinFromPageUrl(window.location.href)).toEqual({
      serverUrl: "https://team.example.com",
      inviteCode: INVITE,
    });
    window.history.replaceState(null, "", before);
  });

  it("지금 붙어 있는 서버의 주소(초대 코드 없이)는 로그아웃하지 않고 「이미 이 서버에 있어요」를 말한다", async () => {
    mount();
    await openJoin();
    // 끝 슬래시·대문자가 달라도 같은 서버다.
    await submitJoin(`${window.location.origin.toUpperCase()}/`);
    expect(text("add-workspace-join-link-error")).toContain("이미 이 서버에 있어요");
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("join");
    expect(probeMock).not.toHaveBeenCalled();
    expect(logoutMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q("add-workspace-join-link"));
  });

  it("닿지 않는 주소는 확인 걸음에 가지 않고 로그아웃하지 않는다(사유를 그 칸에서 말한다)", async () => {
    probeMock.mockResolvedValue(false);
    mount();
    await openJoin();
    await submitJoin("tema.exmaple.com");
    await vi.waitFor(() =>
      expect(text("add-workspace-join-link-error")).toContain("tema.exmaple.com에 닿지 않아서 로그아웃하지 않았어요")
    );
    expect(probeMock).toHaveBeenCalledWith("https://tema.exmaple.com");
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("join");
    expect(logoutMock).not.toHaveBeenCalled();
    // 다시 시도할 수 있다: 「계속」이 풀려 있다.
    expect(q("add-workspace-join-next")?.hasAttribute("disabled")).toBe(false);
  });

  it("확인하는 동안 「계속」은 한 번만 받고 「확인하는 중」을 말한다", async () => {
    let answer: (ok: boolean) => void = () => undefined;
    probeMock.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    mount();
    await openJoin();
    await submitJoin("team.example.com");
    expect(q("add-workspace-join-next")?.textContent).toBe("확인 중");
    expect(q("add-workspace-join-next")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => q("add-workspace-join-next")?.click());
    expect(probeMock).toHaveBeenCalledTimes(1);
    await act(async () => answer(true));
    await vi.waitFor(() =>
      expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("confirm")
    );
  });

  it("확인하는 중에 「뒤로」를 누르면 늦게 온 답이 걸음을 바꾸지 않는다", async () => {
    let answer: (ok: boolean) => void = () => undefined;
    probeMock.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    mount();
    await openJoin();
    await submitJoin("team.example.com");
    await act(async () => q("add-workspace-back")?.click());
    await vi.waitFor(() =>
      expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("choose")
    );
    await act(async () => answer(true));
    expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("choose");
  });

  it("확인 걸음의 「뒤로」는 칸으로 돌아가고 로그아웃하지 않는다", async () => {
    mount();
    await openJoin();
    await submitJoin("team.example.com");
    await vi.waitFor(() => expect(q("add-workspace-confirm-back")).not.toBeNull());
    await act(async () => q("add-workspace-confirm-back")?.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("add-workspace-join-link")));
    expect((q("add-workspace-join-link") as HTMLInputElement).value).toBe("team.example.com");
    expect(logoutMock).not.toHaveBeenCalled();
  });
});

describe("워크스페이스 추가: 웹에서 다른 서버로 참여 (#5785 수리 2회차)", () => {
  const INVITE = "Q".repeat(24);
  beforeEach(() => {
    shell.tauri = false;
  });

  it("다른 서버 주소: 확인도 로그아웃도 없이 새 탭으로 그 주소를 연다(「닿지 않아서」 0)", async () => {
    mount();
    await openJoin();
    await submitJoin("https://team.example.com");
    await vi.waitFor(() =>
      expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("confirm")
    );
    expect(probeMock).not.toHaveBeenCalled();
    expect(logoutMock).not.toHaveBeenCalled();
    const open = q("add-workspace-join-open") as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("https://team.example.com/");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(q("add-workspace-join-logout")).toBeNull();
    const dialog = text("add-workspace-dialog");
    expect(dialog).toContain("새 탭에서 열까요?");
    expect(dialog).toContain("지금 워크스페이스는 그대로 있어요");
    expect(dialog).not.toContain("닿지 않아서");
    expect(text("add-workspace-join-target")).toBe("team.example.com의 로그인 화면을 새 탭에서 열어요.");
  });

  it("초대 링크: 그 서버의 주소에 초대 코드를 실어 연다", async () => {
    mount();
    await openJoin();
    await submitJoin(`https://team.example.com/?code=${INVITE}`);
    await vi.waitFor(() => expect(q("add-workspace-join-open")).not.toBeNull());
    const url = new URL(q("add-workspace-join-open")!.getAttribute("href")!);
    expect(url.origin).toBe("https://team.example.com");
    expect(url.searchParams.get("code")).toBe(INVITE);
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("「새 탭에서 열기」를 누르면 창이 닫히고 로그아웃은 없다", async () => {
    mount();
    await openJoin();
    await submitJoin("https://team.example.com");
    await vi.waitFor(() => expect(q("add-workspace-join-open")).not.toBeNull());
    const open = q("add-workspace-join-open") as HTMLAnchorElement;
    open.addEventListener("click", (event) => event.preventDefault());
    await act(async () => open.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("javascript:·data:·ftp: 주소는 확인 걸음에 가지 않는다", async () => {
    mount();
    await openJoin();
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://team.example.com"]) {
      await submitJoin(bad);
      expect(q("add-workspace-join-open")).toBeNull();
      expect(q("add-workspace-dialog")?.getAttribute("data-step")).toBe("join");
      expect(q("add-workspace-join-link-error")).not.toBeNull();
    }
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("지금 서버의 주소는 웹에서도 「이미 이 서버에 있어요」다", async () => {
    mount();
    await openJoin();
    await submitJoin(window.location.origin);
    expect(text("add-workspace-join-link-error")).toContain("이미 이 서버에 있어요");
    expect(q("add-workspace-join-open")).toBeNull();
  });
});


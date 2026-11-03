// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type MembershipRole,
  type PasswordResetIssue,
  type RosterMember,
} from "@momo/core/lib/api";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { MemberProfileProvider } from "@/features/directory/MemberProfileDialog";
import { useOpenMemberProfile } from "@/features/directory/memberProfileContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

// =============================================================================
// 멤버 프로필의 「재설정 링크 만들기」 (ADR-0215 D6, #4603). 서버는 모의다(E-4 #4596 전).
//
// 한국어 사전을 실제로 올려서(`koreanLocaleForTest`) 사람이 읽는 문장 그대로 단정한다: 다섯 줄 중
// 하나가 빠지거나 오류 문장이 바뀌면 여기서 빨개진다. 링크는 **한 번만** 보이고 닫으면 DOM 어디에도
// 없다는 것이 이 계약의 핵심이라 토큰 조각이 화면 전체 글자에 남는지를 직접 잰다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const OWNER_ID = "00000000-0000-7000-8000-000000000101";
const ADMIN_ID = "00000000-0000-7000-8000-0000000005d1";
const MEMBER_ID = "00000000-0000-7000-8000-0000000005d2";
const AGENT_ID = "00000000-0000-7000-8000-000000000102";
const TOKEN = "Zk3".repeat(14) + "Q"; // 43 chars, a made-up token shape for the link
const LINK = `https://team.example.com/claim/${TOKEN}`;

const issueMemberPasswordReset = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());
const changeWorkspaceMemberRole = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    issueMemberPasswordReset: (...args: unknown[]) =>
      issueMemberPasswordReset(...args) as Promise<PasswordResetIssue>,
    fetchRoster: (workspaceId: string) => fetchRoster(workspaceId) as Promise<RosterMember[]>,
    changeWorkspaceMemberRole: (...args: unknown[]) => changeWorkspaceMemberRole(...args) as Promise<unknown>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let koLocale: AppLocale;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  koLocale = await koreanLocaleForTest();
});

beforeEach(() => {
  issueMemberPasswordReset.mockReset();
  fetchRoster.mockReset();
  changeWorkspaceMemberRole.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
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
  unmount();
  vi.unstubAllGlobals();
});

function unmount() {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
}

function person(
  over: Partial<RosterMember> & { id: string; role?: MembershipRole }
): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const OWNER = person({ id: OWNER_ID, displayName: "데모 사용자", handle: "demo", role: "owner" });
const ADMIN = person({ id: ADMIN_ID, displayName: "정하윤", handle: "hayun", role: "admin" });
const INTERN = person({ id: MEMBER_ID, displayName: "김인턴", handle: "intern-kim", role: "member" });
const AGENT = person({
  id: AGENT_ID,
  displayName: "허미스",
  handle: "hermes",
  kind: "agent",
  role: "member",
  ownerHumanId: OWNER_ID,
});
const ROSTER = [OWNER, ADMIN, INTERN, AGENT];

function sessionValue(
  viewer: RosterMember,
  connStatus: SessionContextValue["connStatus"] = "connected"
): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: viewer.id,
        workspaceId: WS,
        kind: viewer.kind,
        displayName: viewer.displayName,
        handle: viewer.handle,
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function workspace(): WorkspaceIdentity {
  return {
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: 0,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: false,
  };
}

function OpenOnMount({ memberId }: { memberId: string }) {
  const open = useOpenMemberProfile();
  useEffect(() => {
    open(memberId);
  }, [memberId, open]);
  return null;
}

/** A button that reopens the profile of the same member: what a second visit looks like. */
function Reopen({ memberId }: { memberId: string }) {
  const open = useOpenMemberProfile();
  return createElement("button", { type: "button", "data-testid": "reopen", onClick: () => open(memberId) });
}

function mountProfile(
  viewer: RosterMember,
  targetId: string,
  connStatus: SessionContextValue["connStatus"] = "connected"
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(workspaceIdentityKey(WS), workspace());
  client.setQueryData(["roster", WS], ROSTER);
  fetchRoster.mockResolvedValue(ROSTER);

  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const profile = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue(viewer, connStatus) },
      createElement(
        MemoryRouter,
        null,
        createElement(
          OpenAgentProfileContext.Provider,
          { value: () => undefined },
          createElement(
            MemberProfileProvider,
            null,
            createElement(OpenOnMount, { memberId: targetId }),
            createElement(Reopen, { memberId: targetId })
          )
        )
      )
    )
  );
  const tree: ReactElement = <LocaleProvider locale={koLocale}>{profile}</LocaleProvider>;
  act(() => mountedRoot?.render(tree));
}

const byId = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

async function waitForDialog(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const dialog = byId("member-profile-dialog");
    expect(dialog).not.toBeNull();
    return dialog!;
  });
}

async function openStage() {
  await waitForDialog();
  const open = byId<HTMLButtonElement>("member-profile-reset-open");
  expect(open).not.toBeNull();
  await act(async () => {
    open!.click();
  });
  await vi.waitFor(() => expect(byId("member-profile-reset-stage")).not.toBeNull());
}

function typePassword(value: string) {
  const input = byId<HTMLInputElement>("member-profile-reset-password")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    byId<HTMLButtonElement>("member-profile-reset-submit")!.click();
  });
}

const ISSUE: PasswordResetIssue = {
  claimUrl: LINK,
  claimUrlSecure: true,
  expiresAtMs: Date.UTC(2026, 10, 4, 5, 30),
};

describe("재설정 링크 만들기: 누구에게 보이나 (D6 사다리의 거울)", () => {
  it("소유자가 멤버를 볼 때 보이고, 단추가 단계를 연다", async () => {
    mountProfile(OWNER, MEMBER_ID);
    await waitForDialog();
    expect(byId("member-profile-reset-open")).not.toBeNull();
    expect(byId("member-profile-reset-open")?.textContent).toBe("재설정 링크 만들기");
  });

  it("관리자는 멤버에게는 보이고 다른 관리자에게는 안 보인다", async () => {
    const other = person({ id: "00000000-0000-7000-8000-0000000005d9", displayName: "관리자2", handle: "admin2", role: "admin" });
    mountProfile(ADMIN, MEMBER_ID);
    await waitForDialog();
    expect(byId("member-profile-reset-open")).not.toBeNull();
    unmount();
    // 같은 명부에 다른 관리자를 더해 그 사람의 프로필을 연다.
    ROSTER.push(other);
    try {
      mountProfile(ADMIN, other.id);
      await waitForDialog();
      expect(byId("member-profile-reset-open")).toBeNull();
    } finally {
      ROSTER.pop();
    }
  });

  it("멤버가 볼 때, 자기 프로필에서, 에이전트에게는 안 보인다", async () => {
    mountProfile(INTERN, ADMIN_ID);
    await waitForDialog();
    expect(byId("member-profile-reset-open")).toBeNull();
    unmount();
    mountProfile(OWNER, OWNER_ID);
    await waitForDialog();
    expect(byId("member-profile-reset-open")).toBeNull();
    unmount();
    mountProfile(OWNER, AGENT_ID);
    await waitForDialog();
    expect(byId("member-profile-reset-open")).toBeNull();
  });
});

describe("재설정 링크 만들기: 오프라인", () => {
  // 쓰기 게이트는 연결 상태 모델 하나다(#5220 `useOffline`): 기기 오프라인·서버에 닿지 못함일 때만 막고,
  // 실시간(소켓)만 끊긴 것으로는 막지 않는다(#5201 결정 ③).
  afterEach(() => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  });

  it("기기가 오프라인이면 단추가 잠기고 사유를 가리킨다(요청이 나갈 수 없는데 누르게 두지 않는다)", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    mountProfile(OWNER, MEMBER_ID);
    await waitForDialog();
    const open = byId<HTMLButtonElement>("member-profile-reset-open")!;
    expect(open.disabled).toBe(true);
    expect(open.getAttribute("aria-describedby")).toBe("member-profile-offline-reason");
    expect(document.getElementById("member-profile-offline-reason")).not.toBeNull();
    open.click();
    expect(byId("member-profile-reset-stage")).toBeNull();
    expect(issueMemberPasswordReset).not.toHaveBeenCalled();
  });

  it("실시간만 끊겼으면 단추는 열려 있다(재설정 링크는 REST라 소켓 끊김으로 막지 않는다)", async () => {
    mountProfile(OWNER, MEMBER_ID, "disconnected");
    await waitForDialog();
    const open = byId<HTMLButtonElement>("member-profile-reset-open")!;
    expect(open.disabled).toBe(false);
    expect(open.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById("member-profile-offline-reason")).toBeNull();
  });
});

describe("재설정 링크 만들기: 확인 단계", () => {
  it("다섯 줄을 모두 보이고 서버를 부르지 않는다 (수용 12c)", async () => {
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    const text = byId("member-profile-reset-lines")!.textContent ?? "";
    expect(text).toContain("이전에 만든 링크는 못 쓰게 돼요.");
    expect(text).toContain("링크는 24시간 안에 한 번만 쓸 수 있어요.");
    expect(text).toContain("받는 사람이 비밀번호를 정하면 그 사람의 모든 기기가 로그아웃돼요.");
    expect(text).toContain("본인 확인은 관리자가 해요.");
    expect(text).toContain("계정이 도용됐을 수 있는 같은 채팅으로는 보내지 마세요.");
    expect(text).toContain("먼저 끝내고 링크를 만드세요");
    expect(byId("member-profile-reset-lines")!.querySelectorAll("li")).toHaveLength(5);
    expect(issueMemberPasswordReset).not.toHaveBeenCalled();
  });

  it("빈 비밀번호는 서버에 묻기 전에 그 칸에서 말한다", async () => {
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    await submit();
    expect(issueMemberPasswordReset).not.toHaveBeenCalled();
    expect(byId("member-profile-reset-password-error")?.textContent).toBe("내 비밀번호를 입력하세요.");
    expect(byId("member-profile-reset-password")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("틀린 비밀번호(403 current_password_incorrect)는 그 칸에서 말하고, 칸을 비우고, 링크는 없다", async () => {
    issueMemberPasswordReset.mockRejectedValue(
      new ApiError(403, "current password is incorrect", "current_password_incorrect")
    );
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword("wrong one");
    await submit();
    await vi.waitFor(() => expect(byId("member-profile-reset-password-error")).not.toBeNull());
    expect(byId("member-profile-reset-password-error")?.textContent).toBe(
      "내 비밀번호가 맞지 않아요. 다시 입력하세요."
    );
    expect(byId<HTMLInputElement>("member-profile-reset-password")?.value).toBe("");
    expect(document.activeElement).toBe(byId("member-profile-reset-password"));
    expect(byId("member-profile-reset-issued")).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("코드 없는 403은 비밀번호가 틀렸다고 말하지 않고, 입력을 지키고, 사다리를 말한다", async () => {
    issueMemberPasswordReset.mockRejectedValue(new ApiError(403, "forbidden"));
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword("right one");
    await submit();
    await vi.waitFor(() => expect(byId("member-profile-reset-error")).not.toBeNull());
    expect(byId("member-profile-reset-error")?.textContent).toContain("권한이 없어요");
    expect(document.body.textContent).not.toContain("맞지 않아요");
    expect(byId<HTMLInputElement>("member-profile-reset-password")?.value).toBe("right one");
  });

  it("너무 잦은 요청(429)은 Retry-After 초를 말한다", async () => {
    issueMemberPasswordReset.mockRejectedValue(new ApiError(429, "slow down", undefined, 42));
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword("right one");
    await submit();
    await vi.waitFor(() => expect(byId("member-profile-reset-error")).not.toBeNull());
    expect(byId("member-profile-reset-error")?.textContent).toContain("42초 뒤에 다시 시도하세요");
  });

  it("같은 틱에 겹친 두 제출은 요청을 한 번만 보낸다 (둘째 요청은 첫째 링크를 못 쓰게 만든다)", async () => {
    let release: (issue: PasswordResetIssue) => void = () => undefined;
    issueMemberPasswordReset.mockImplementation(
      () => new Promise<PasswordResetIssue>((resolve) => { release = resolve; })
    );
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword("right one");
    const form = byId<HTMLFormElement>("member-profile-reset-stage")!;
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(issueMemberPasswordReset).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(ISSUE);
    });
    await vi.waitFor(() => expect(byId("member-profile-reset-issued")).not.toBeNull());
  });

  it("Esc는 확인 단계만 닫고 프로필로 돌아가며, 초점은 단계를 연 단추로 돌아온다", async () => {
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(byId("member-profile-dialog")).not.toBeNull();
    expect(byId("member-profile-reset-stage")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(byId("member-profile-reset-open")));
  });
});

describe("재설정 링크 만들기: 링크는 한 번만 보인다", () => {
  async function issue() {
    issueMemberPasswordReset.mockResolvedValue(ISSUE);
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword(" 내 비밀번호 Pw1 ");
    await submit();
    await vi.waitFor(() => expect(byId("member-profile-reset-issued")).not.toBeNull());
  }

  it("내 비밀번호를 입력 그대로 보내고 링크·만료·전달 안내를 한 카드에 보인다", async () => {
    await issue();
    expect(issueMemberPasswordReset).toHaveBeenCalledWith(WS, MEMBER_ID, " 내 비밀번호 Pw1 ");
    expect(byId("member-profile-reset-link")?.textContent).toBe(LINK);
    const card = byId("member-profile-reset-issued")!;
    expect(card.textContent).toContain("재설정 링크를 만들었어요");
    expect(card.textContent).toContain("닫으면 다시 볼 수 없으니 지금 전하세요");
    expect(card.textContent).toContain("메신저로 보내거나 직접 전해 주세요.");
    expect(byId("member-profile-reset-expires")?.textContent).toMatch(/까지 한 번만 쓸 수 있어요\.$/);
    // 입력한 비밀번호는 카드 어디에도 남지 않는다.
    expect(document.body.textContent).not.toContain("내 비밀번호 Pw1");
    expect(document.activeElement).toBe(card);
  });

  it("복사 단추가 링크를 클립보드에 쓰고 「복사됨」으로 바뀐다", async () => {
    await issue();
    await act(async () => {
      byId<HTMLButtonElement>("member-profile-reset-copy")!.click();
    });
    expect(writeText).toHaveBeenCalledWith(LINK);
    await vi.waitFor(() => expect(byId("member-profile-reset-copy")?.textContent).toBe("복사됨"));
  });

  it("서버가 이 컴퓨터에서만 열린다고 하면(claimUrlSecure false) 그 한 줄을 더한다", async () => {
    issueMemberPasswordReset.mockResolvedValue({ ...ISSUE, claimUrl: `http://192.168.0.7:8080/claim/${TOKEN}`, claimUrlSecure: false });
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword("pw");
    await submit();
    await vi.waitFor(() => expect(byId("member-profile-reset-local-only")).not.toBeNull());
    expect(byId("member-profile-reset-local-only")?.textContent).toContain("이 컴퓨터(같은 네트워크)에서만 열릴 수 있어요");
  });

  it("공개 주소이거나 서버가 말하지 않으면 그 줄이 없다", async () => {
    await issue();
    expect(byId("member-profile-reset-local-only")).toBeNull();
    unmount();
    issueMemberPasswordReset.mockResolvedValue({ ...ISSUE, claimUrlSecure: undefined });
    mountProfile(OWNER, MEMBER_ID);
    await openStage();
    typePassword("pw");
    await submit();
    await vi.waitFor(() => expect(byId("member-profile-reset-issued")).not.toBeNull());
    expect(byId("member-profile-reset-local-only")).toBeNull();
  });

  it("바깥을 눌러도 링크는 닫히지 않는다 (다시 볼 길이 없는 값이다)", async () => {
    await issue();
    // Radix는 바깥 누름 리스너를 마운트 다음 틱에 단다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // 이 Radix는 바깥 누름을 같은 누름의 `click`까지 미룬다: 둘 다 보내야 닫는 쪽 길이 실제로 걷는다.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(byId("member-profile-dialog")).not.toBeNull();
    expect(byId("member-profile-reset-link")?.textContent).toBe(LINK);
  });

  it("Esc는 링크를 닫지 않고, 「닫기」만 닫는다. 닫은 뒤 다시 열면 링크는 화면 어디에도 없다", async () => {
    await issue();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    // 링크가 선 뒤의 Esc는 아무 일도 하지 않는다.
    expect(byId("member-profile-dialog")).not.toBeNull();
    expect(byId("member-profile-reset-link")?.textContent).toBe(LINK);

    await act(async () => {
      byId<HTMLButtonElement>("member-profile-reset-close")!.click();
    });
    await vi.waitFor(() => expect(byId("member-profile-dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(TOKEN);

    // 같은 멤버를 다시 열면 프로필이고, 링크도 단계도 없다.
    await act(async () => {
      byId<HTMLButtonElement>("reopen")!.click();
    });
    await waitForDialog();
    expect(byId("member-profile-reset-issued")).toBeNull();
    expect(byId("member-profile-reset-link")).toBeNull();
    expect(byId("member-profile-reset-open")).not.toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(issueMemberPasswordReset).toHaveBeenCalledTimes(1);
  });
});

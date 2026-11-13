// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type MembershipRole, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { RoleLabels } from "@momo/core/features/directory/model";
import { DEFAULT_ROLE_LABELS } from "@momo/core/features/directory/model";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { MemberProfileProvider } from "./MemberProfileDialog";
import { useOpenMemberProfile } from "./memberProfileContext";

const WS = "00000000-0000-7000-8000-000000000001";
const OWNER_ID = "00000000-0000-7000-8000-000000000101";
const OWNER2_ID = "00000000-0000-7000-8000-000000000105";
const ADMIN_ID = "00000000-0000-7000-8000-0000000005d1";
const ADMIN2_ID = "00000000-0000-7000-8000-0000000005d3";
const MEMBER_ID = "00000000-0000-7000-8000-0000000005d2";
const GUEST_ID = "00000000-0000-7000-8000-0000000005d9";
const AGENT_ID = "00000000-0000-7000-8000-000000000102";

const changeWorkspaceMemberRole = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    changeWorkspaceMemberRole: (
      workspaceId: string,
      memberId: string,
      role: MembershipRole
    ) => changeWorkspaceMemberRole(workspaceId, memberId, role) as Promise<unknown>,
    fetchRoster: (workspaceId: string) =>
      fetchRoster(workspaceId) as Promise<RosterMember[]>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let ko: AppLocale;
const writeText = vi.fn(async (_text: string) => undefined);
beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});

beforeEach(() => {
  changeWorkspaceMemberRole.mockReset();
  fetchRoster.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
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
  document.body.innerHTML = "";
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  vi.unstubAllGlobals();
});

function rosterMember(
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

// 가상 인물만(김도현·이서연 …). 사람은 모두 이메일이 있고, 에이전트는 없다(서버 명부와 같다).
const OWNER = rosterMember({ id: OWNER_ID, displayName: "김도현", handle: "dohyeon", role: "owner", email: "dohyeon@example.com" });
const OWNER2 = rosterMember({ id: OWNER2_ID, displayName: "박지우", handle: "jiwoo", role: "owner", email: "jiwoo@example.com" });
const ADMIN = rosterMember({ id: ADMIN_ID, displayName: "이서연", handle: "seoyeon", role: "admin", email: "seoyeon@example.com" });
const ADMIN2 = rosterMember({ id: ADMIN2_ID, displayName: "최민수", handle: "minsu", role: "admin", email: "minsu@example.com" });
const INTERN = rosterMember({ id: MEMBER_ID, displayName: "김인턴", handle: "intern-kim", role: "member", email: "intern@example.com" });
const GUEST = rosterMember({ id: GUEST_ID, displayName: "이도현", handle: "dohyun", role: "guest", email: "dohyun@example.com" });
const AGENT = rosterMember({
  id: AGENT_ID,
  displayName: "김인턴",
  handle: "kim-intern",
  kind: "agent",
  role: "member",
  ownerHumanId: OWNER_ID,
});

const ROSTER = [OWNER, OWNER2, ADMIN, ADMIN2, INTERN, GUEST, AGENT];

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

function workspace(labels: RoleLabels): WorkspaceIdentity {
  return {
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: 0,
    roleLabels: labels,
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

function mountProfile(options: {
  viewer: RosterMember;
  targetId: string;
  labels?: RoleLabels;
  roster?: RosterMember[];
  connStatus?: SessionContextValue["connStatus"];
  /** 기기 오프라인은 브라우저가 안다. 소켓만 끊긴 것(`connStatus`)과 다른 사실이다(#5201 결정 ③). */
  deviceOffline?: boolean;
  /** 명부를 읽지 못하게 한다(받아 둔 명부 없음, #5242). */
  rosterFailure?: { error: Error };
}): { host: HTMLElement; client: QueryClient } {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: options.deviceOffline !== true });
  const roster = options.roster ?? ROSTER;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(workspaceIdentityKey(WS), workspace(options.labels ?? {}));
  if (options.rosterFailure) {
    fetchRoster.mockRejectedValue(options.rosterFailure.error);
  } else {
    client.setQueryData(["roster", WS], roster);
    fetchRoster.mockResolvedValue(roster);
  }

  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue(options.viewer, options.connStatus) },
      createElement(
        MemoryRouter,
        null,
        createElement(
          OpenAgentProfileContext.Provider,
          { value: () => undefined },
          createElement(
            MemberProfileProvider,
            null,
            createElement(OpenOnMount, { memberId: options.targetId })
          )
        )
      )
    )
  );
  // 한국어 사전으로 그린다: 공급자 밖이면 번들된 영어로 물러난다(`useMessages`).
  act(() => mountedRoot?.render(createElement(LocaleProvider, { locale: ko, children: tree })));
  return { host, client };
}

const byId = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

async function waitForDialog(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const dialog = byId("member-profile-dialog");
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  });
}

const roleSelect = () => byId<HTMLButtonElement>("member-profile-role");
const optionEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

async function openRoleList() {
  const select = roleSelect();
  expect(select).not.toBeNull();
  await act(async () => {
    select!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
}

/** 고르개에서 역할 하나를 고른다. 다른 역할이면 확인 단계가 선다. */
async function pickRole(role: MembershipRole) {
  if (!document.querySelector('[role="listbox"]')) await openRoleList();
  const option = optionEls().find((o) => o.dataset.value === role)!;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
}

async function confirmStage() {
  const confirm = byId<HTMLButtonElement>("member-profile-role-stage-confirm");
  expect(confirm).not.toBeNull();
  await act(async () => {
    confirm!.click();
  });
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

describe("멤버 프로필 커스텀 상태 (#1889)", () => {
  it("shows declared presence and custom status as separate facts", async () => {
    const working = rosterMember({
      ...INTERN,
      presenceStatus: "away",
      statusEmoji: "🏠",
      statusText: "재택",
    });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, working, AGENT] });
    const dialog = await waitForDialog();
    expect(byId("member-profile-presence")?.textContent).toBe("자리 비움");
    expect(dialog.textContent).toContain("재택");
    expect(dialog.querySelector('[data-testid="custom-status-emoji"]')?.textContent).toBe("🏠");
    // 활성은 말할 가치가 없다: 옛 「상태: 활성」 줄도, 칩도 없다(#5780).
    expect(dialog.textContent).not.toContain("활성");
    expect(byId("member-profile-status-chip")).toBeNull();
  });

  it("does not draw an expired custom status", async () => {
    const expired = rosterMember({
      ...INTERN,
      presenceStatus: "auto",
      statusEmoji: "📅",
      statusText: "회의 중",
      statusExpiresAtMs: 1,
    });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, expired, AGENT] });
    const dialog = await waitForDialog();
    expect(dialog.querySelector('[data-testid="custom-status"]')).toBeNull();
    expect(dialog.textContent).not.toContain("온라인");
    expect(dialog.textContent).not.toContain("회의 중");
  });

  it("does not assert 온라인 for auto, and still names away/dnd", async () => {
    const auto = rosterMember({ ...INTERN, presenceStatus: "auto" });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, auto, AGENT] });
    const dialog = await waitForDialog();
    expect(byId("member-profile-handle")?.textContent).toBe("@intern-kim · 멤버");
    expect(byId("member-profile-presence")).toBeNull();
    expect(dialog.textContent).not.toContain("온라인");
  });

  // #4692: the roster now carries availability, so `auto` can be named once the server has said so. Unknown
  // availability (the case above) still says nothing.
  it.each([
    [true, "온라인", "ok"],
    [false, "오프라인", "muted"],
  ] as const)("says what the roster knows for auto: online=%s → %s", async (online, word, tone) => {
    const person = rosterMember({ ...INTERN, presenceStatus: "auto", online });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, person, AGENT] });
    await waitForDialog();
    expect(byId("member-profile-presence")?.textContent).toBe(word);
    expect(byId("member-profile-handle")?.textContent).toBe("@intern-kim · 멤버");
    expect(document.querySelector('[data-testid="presence-dot"]')?.getAttribute("data-tone")).toBe(tone);
  });

  it("a declared away wins over a known connection, in the word and in the dot", async () => {
    const person = rosterMember({ ...INTERN, presenceStatus: "away", online: true });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, person, AGENT] });
    const dialog = await waitForDialog();
    expect(byId("member-profile-presence")?.textContent).toBe("자리 비움");
    expect(dialog.textContent).not.toContain("온라인");
    expect(dialog.querySelector('[data-testid="presence-dot"]')?.getAttribute("data-tone")).toBe("warn");
  });

  it("an agent's profile carries no person's dot or word, whatever its row says", async () => {
    const agent = rosterMember({ ...AGENT, online: true });
    mountProfile({ viewer: OWNER, targetId: AGENT_ID, roster: [OWNER, INTERN, agent] });
    const dialog = await waitForDialog();
    expect(dialog.querySelector('[data-testid="presence-dot"]')).toBeNull();
    expect(dialog.textContent).not.toContain("온라인");
    expect(byId("member-profile-handle")?.textContent).toBe("@kim-intern · 에이전트");
  });

  it("the viewer's own profile follows this client's connection, not the broker's view of it", async () => {
    mountProfile({ viewer: OWNER, targetId: OWNER_ID });
    await waitForDialog();
    // The roster row says nothing about the viewer; the socket is up.
    expect(byId("member-profile-presence")?.textContent).toBe("온라인");
  });

  it("wraps a long custom status instead of truncating mid-word", async () => {
    const long = rosterMember({ ...INTERN, presenceStatus: "dnd", statusText: "urgent outage bridge" });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, long, AGENT] });
    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("방해 금지");
    const text = dialog.querySelector('[data-testid="custom-status-text"]');
    expect(text?.className).toContain("break-words");
    expect(text?.className).not.toContain("truncate");
  });

  it("keeps an emoji-only status in the accessibility tree", async () => {
    const emojiOnly = rosterMember({ ...INTERN, statusEmoji: "🤒" });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, emojiOnly, AGENT] });
    const dialog = await waitForDialog();
    const emoji = dialog.querySelector('[data-testid="custom-status-emoji"]');
    expect(emoji?.textContent).toBe("🤒");
    expect(emoji?.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("멤버 프로필 구성 (#5780)", () => {
  it("종류·상태 키-값 줄과 글자 「닫기」가 없고, 창의 X 가 닫는다", async () => {
    mountProfile({ viewer: INTERN, targetId: ADMIN_ID });
    const dialog = await waitForDialog();
    expect(dialog.querySelector("dl dt")?.textContent).not.toBe("종류");
    expect(dialog.textContent).not.toContain("종류");
    expect(dialog.textContent).not.toContain("사람");
    const buttons = [...dialog.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).not.toContain("닫기");
    const close = byId<HTMLButtonElement>("member-profile-close");
    expect(close?.getAttribute("aria-label")).toBe("프로필 닫기");
    expect(close?.textContent).toBe("");
    await act(async () => {
      close!.click();
    });
    await vi.waitFor(() => expect(byId("member-profile-dialog")).toBeNull());
  });

  it("열리면 첫 초점은 X 가 아니라 주 행동(메시지 보내기)이다", async () => {
    mountProfile({ viewer: INTERN, targetId: ADMIN_ID });
    await waitForDialog();
    await vi.waitFor(() => expect(document.activeElement).toBe(byId("member-profile-dm")));
    expect(byId("member-profile-dm")?.textContent).toBe("메시지 보내기");
  });

  it("이름 아래 「@핸들 · 역할」, 활성이 아니면 이름 옆 칩", async () => {
    const invited = rosterMember({ ...INTERN, status: "invited" });
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, roster: [OWNER, invited] });
    await waitForDialog();
    expect(byId("member-profile-name")?.textContent).toBe("김인턴");
    expect(byId("member-profile-handle")?.textContent).toBe("@intern-kim · 멤버");
    expect(byId("member-profile-status-chip")?.textContent).toBe("초대됨");
    // 비활성이면 메시지 행동이 없고 까닭 문장이 선다.
    expect(byId("member-profile-dm")).toBeNull();
    expect(byId("member-profile-dm-unavailable")?.textContent).toBe("초대됨 상태에서는 다이렉트 메시지를 열 수 없습니다.");
  });

  it("멘션 복사는 @핸들을 클립보드에 쓰고 그 자리에서 「복사됨」이 된다", async () => {
    mountProfile({ viewer: INTERN, targetId: ADMIN_ID });
    await waitForDialog();
    const copy = byId<HTMLButtonElement>("member-profile-copy-mention")!;
    expect(copy.textContent).toBe("멘션 복사");
    await act(async () => {
      copy.click();
    });
    expect(writeText).toHaveBeenCalledWith("@seoyeon");
    await vi.waitFor(() => expect(byId("member-profile-copy-mention")?.textContent).toBe("복사됨"));
  });

  it("에이전트는 라우팅 설정 행동과 책임자 줄을 갖고, 이메일·관리 묶음은 없다", async () => {
    mountProfile({ viewer: OWNER, targetId: AGENT_ID });
    await waitForDialog();
    expect(byId("member-profile-routing")?.textContent).toBe("라우팅 설정");
    expect(byId("member-profile-owner")?.textContent).toBe("김도현 님이 관리");
    expect(byId("member-profile-email")).toBeNull();
    expect(byId("member-profile-manage")).toBeNull();
  });
});

// 수용 1: 네 시점 × 대상에서 보이는 줄과 고를 수 있는 역할이 서버 사다리(`membership_lifecycle.rs`·
// `workspace_authorization.rs`)와 같다. 코어 `assignableWorkspaceRoles` 의 16칸 표가 규칙을 재고, 여기는 그 답이
// 화면에 그대로 그려지는지를 잰다.
describe("네 시점의 프로필 (수용 1·3)", () => {
  type Row = {
    viewer: RosterMember;
    target: RosterMember;
    manage: boolean;
    options: string[] | null; // 고르개 선택지(라벨), 없으면 null
    text: string | null; // 고르개 대신 선 글
    lock: string | null;
    reset: boolean;
    email: string | null;
  };
  const ALL = ["소유자", "관리자", "멤버", "게스트"];
  const LOW = ["멤버", "게스트"];
  const OWNER_PEER = "소유자끼리는 서로의 역할을 바꿀 수 없어요.";
  const ADMIN_CEIL = "관리자는 관리자나 소유자의 역할을 바꿀 수 없어요.";
  const rows: Row[] = [
    { viewer: OWNER, target: OWNER2, manage: true, options: null, text: "소유자", lock: OWNER_PEER, reset: true, email: "jiwoo@example.com" },
    { viewer: OWNER, target: ADMIN, manage: true, options: ALL, text: null, lock: null, reset: true, email: "seoyeon@example.com" },
    { viewer: OWNER, target: INTERN, manage: true, options: ALL, text: null, lock: null, reset: true, email: "intern@example.com" },
    { viewer: OWNER, target: GUEST, manage: true, options: ALL, text: null, lock: null, reset: true, email: "dohyun@example.com" },
    { viewer: OWNER, target: AGENT, manage: false, options: null, text: null, lock: null, reset: false, email: null },
    { viewer: OWNER, target: OWNER, manage: false, options: null, text: null, lock: null, reset: false, email: "dohyeon@example.com" },
    { viewer: ADMIN, target: OWNER, manage: true, options: null, text: "소유자", lock: ADMIN_CEIL, reset: false, email: "dohyeon@example.com" },
    { viewer: ADMIN, target: ADMIN2, manage: true, options: null, text: "관리자", lock: ADMIN_CEIL, reset: false, email: "minsu@example.com" },
    { viewer: ADMIN, target: INTERN, manage: true, options: LOW, text: null, lock: null, reset: true, email: "intern@example.com" },
    { viewer: ADMIN, target: GUEST, manage: true, options: LOW, text: null, lock: null, reset: true, email: "dohyun@example.com" },
    { viewer: ADMIN, target: AGENT, manage: false, options: null, text: null, lock: null, reset: false, email: null },
    { viewer: INTERN, target: OWNER, manage: false, options: null, text: null, lock: null, reset: false, email: "dohyeon@example.com" },
    { viewer: INTERN, target: GUEST, manage: false, options: null, text: null, lock: null, reset: false, email: "dohyun@example.com" },
    { viewer: GUEST, target: OWNER, manage: false, options: null, text: null, lock: null, reset: false, email: null },
    { viewer: GUEST, target: INTERN, manage: false, options: null, text: null, lock: null, reset: false, email: null },
    { viewer: GUEST, target: GUEST, manage: false, options: null, text: null, lock: null, reset: false, email: null },
  ];

  it.each(rows.map((row) => [row.viewer.role, row.target.handle, row] as const))(
    "%s 가 @%s 를 본다",
    async (_viewer, _target, row) => {
      mountProfile({ viewer: row.viewer, targetId: row.target.id });
      await waitForDialog();
      expect(byId("member-profile-manage") !== null).toBe(row.manage);
      if (row.options === null) {
        expect(roleSelect()).toBeNull();
      } else {
        await openRoleList();
        expect(optionEls().map((o) => o.textContent)).toEqual(row.options);
      }
      expect(byId("member-profile-role-text")?.textContent ?? null).toBe(row.text);
      expect(byId("member-profile-role-locked")?.textContent ?? null).toBe(row.lock);
      expect(byId("member-profile-reset-open") !== null).toBe(row.reset);
      expect(byId("member-profile-email")?.textContent ?? null).toBe(row.email);
    }
  );

  it("이메일 복사 단추가 그 주소를 쓰고 「복사됨」으로 이름이 바뀐다", async () => {
    mountProfile({ viewer: INTERN, targetId: ADMIN_ID });
    await waitForDialog();
    const copy = byId<HTMLButtonElement>("member-profile-email-copy")!;
    expect(copy.getAttribute("aria-label")).toBe("이메일 복사");
    await act(async () => {
      copy.click();
    });
    expect(writeText).toHaveBeenCalledWith("seoyeon@example.com");
    await vi.waitFor(() => expect(byId("member-profile-email-copy")?.getAttribute("aria-label")).toBe("복사됨"));
  });
});

// 수용 2: 역할 변경은 확인 뒤에만 나가고, 소유자 승격은 경고 문장과 위험 단추를 거친다.
describe("역할 바꾸기 확인 단계 (수용 2)", () => {
  it("고르면 확인 단계가 본문 자리에 서고, 요청은 아직 나가지 않으며, 초점은 취소에 있다", async () => {
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    await pickRole("admin");
    const stage = await vi.waitFor(() => {
      const node = byId("member-profile-role-stage");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(changeWorkspaceMemberRole).not.toHaveBeenCalled();
    // 겹쳐 뜬 두 번째 대화상자가 아니다: 같은 창 안의 단계다(§3.4).
    expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(1);
    // 단계가 서 있는 동안 문은 그 단계의 취소다: 창의 X 는 비켜선다.
    expect(byId("member-profile-close")).toBeNull();
    expect(stage.getAttribute("role")).toBe("group");
    expect(stage.textContent).toContain("김인턴 님의 역할을 바꿀까요?");
    expect(byId("member-profile-role-pair")?.textContent).toBe("멤버관리자");
    expect(stage.textContent).toContain("지금 역할 멤버, 바꿀 역할 관리자");
    expect(stage.textContent).toContain("관리자는 채널을 만들고 채널에 멤버를 넣고 뺄 수 있어요.");
    expect(byId("member-profile-role-stage-warning")).toBeNull();
    expect(byId("member-profile-role-stage-confirm")?.dataset.tone).toBe("default");
    await vi.waitFor(() => expect(document.activeElement).toBe(byId("member-profile-role-stage-cancel")));
  });

  it("같은 역할을 고르면 아무 단계도 서지 않는다", async () => {
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    await pickRole("member");
    expect(byId("member-profile-role-stage")).toBeNull();
    expect(changeWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it("취소하면 요청 없이 프로필로 돌아오고 값은 그대로, 초점은 고르개로", async () => {
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    await pickRole("guest");
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).not.toBeNull());
    await act(async () => {
      byId<HTMLButtonElement>("member-profile-role-stage-cancel")!.click();
    });
    expect(byId("member-profile-role-stage")).toBeNull();
    expect(changeWorkspaceMemberRole).not.toHaveBeenCalled();
    expect(roleSelect()?.dataset.value).toBe("member");
    await vi.waitFor(() => expect(document.activeElement).toBe(roleSelect()));
  });

  it("Esc 는 확인 단계만 내린다(창은 남고 요청은 없다)", async () => {
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    await pickRole("guest");
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).not.toBeNull());
    await pressEscape();
    expect(byId("member-profile-dialog")).not.toBeNull();
    expect(byId("member-profile-role-stage")).toBeNull();
    expect(changeWorkspaceMemberRole).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.activeElement).toBe(roleSelect()));
  });

  it("확인하면 PATCH 를 한 번 보내고, 명부를 다시 읽고, 그 자리에 「바뀜」이 서며 초점이 역할 자리로 돌아온다", async () => {
    changeWorkspaceMemberRole.mockResolvedValue({ memberId: MEMBER_ID, scope: "workspace", role: "admin" });
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    // 다시 읽은 명부는 바뀐 역할을 싣는다(마운트가 처음 명부를 심은 뒤에 바꾼다).
    fetchRoster.mockResolvedValue(
      ROSTER.map((row) => (row.id === MEMBER_ID ? { ...row, role: "admin" as const } : row))
    );
    await waitForDialog();
    expect(byId("member-profile-role-receipt")?.getAttribute("role")).toBe("status");
    expect(byId("member-profile-role-receipt")?.textContent).toBe("");
    await pickRole("admin");
    await confirmStage();
    await vi.waitFor(() => expect(changeWorkspaceMemberRole).toHaveBeenCalledTimes(1));
    expect(changeWorkspaceMemberRole).toHaveBeenCalledWith(WS, MEMBER_ID, "admin");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
    invalidate.mockRestore();
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).toBeNull());
    expect(byId("member-profile-role-receipt")?.textContent).toBe("바뀜");
    await vi.waitFor(() => expect(roleSelect()?.dataset.value).toBe("admin"));
    await vi.waitFor(() => expect(document.activeElement).toBe(roleSelect()));
  });

  it("소유자로 올리기는 「되돌릴 수 없어요」 경고와 위험 단추를 거치고, 올린 뒤에는 고르개가 글이 되고 영수증은 남는다", async () => {
    changeWorkspaceMemberRole.mockResolvedValue({ memberId: ADMIN_ID, scope: "workspace", role: "owner" });
    mountProfile({ viewer: OWNER, targetId: ADMIN_ID });
    fetchRoster.mockResolvedValue(
      ROSTER.map((row) => (row.id === ADMIN_ID ? { ...row, role: "owner" as const } : row))
    );
    await waitForDialog();
    await pickRole("owner");
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).not.toBeNull());
    expect(byId("member-profile-role-stage-warning")?.textContent).toBe(
      "되돌릴 수 없어요. 소유자끼리는 서로의 역할을 바꿀 수 없어서 다시 내릴 수 없어요."
    );
    expect(byId("member-profile-role-stage-confirm")?.dataset.tone).toBe("destructive");
    await confirmStage();
    await vi.waitFor(() => expect(changeWorkspaceMemberRole).toHaveBeenCalledWith(WS, ADMIN_ID, "owner"));
    await vi.waitFor(() => expect(byId("member-profile-role-text")?.textContent).toBe("소유자"));
    expect(roleSelect()).toBeNull();
    expect(byId("member-profile-role-receipt")?.textContent).toBe("바뀜");
    expect(byId("member-profile-role-locked")?.textContent).toBe("소유자끼리는 서로의 역할을 바꿀 수 없어요.");
    await vi.waitFor(() => expect(document.activeElement).toBe(byId("member-profile-role-text")));
  });

  it("관리자에서 내릴 때는 닫히는 일을 말한다", async () => {
    mountProfile({ viewer: OWNER, targetId: ADMIN_ID });
    await waitForDialog();
    await pickRole("member");
    const stage = await vi.waitFor(() => {
      const node = byId("member-profile-role-stage");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(stage.textContent).toContain("채널을 만들거나 채널에 멤버를 넣고 뺄 수 없게 돼요.");
  });

  it.each([
    [new ApiError(409, "workspace must retain at least one owner"), "마지막 소유자"],
    [new ApiError(403, "cannot manage an equal or higher role"), "같거나 높은 역할"],
    [new NetworkError("unreachable", 15_000), "역할을 바꾸지 못했습니다."],
  ])("서버가 거절하면(%s) 단계 안에서 말하고, 값과 명부는 그대로다", async (failure, phrase) => {
    changeWorkspaceMemberRole.mockRejectedValue(failure);
    const { client } = mountProfile({ viewer: OWNER, targetId: ADMIN_ID });
    await waitForDialog();
    await pickRole("member");
    await confirmStage();
    const error = await vi.waitFor(() => {
      const node = byId("member-profile-role-stage-error");
      expect(node?.textContent).toContain(phrase);
      return node!;
    });
    expect(error.getAttribute("role")).toBe("alert");
    expect(byId("member-profile-role-stage")).not.toBeNull();
    const after = (client.getQueryData(["roster", WS]) as RosterMember[]).find((row) => row.id === ADMIN_ID);
    expect(after?.role).toBe("admin");
    expect(fetchRoster).not.toHaveBeenCalled();
    // 취소하면 실패 문장은 다음 단계로 따라오지 않는다.
    await act(async () => {
      byId<HTMLButtonElement>("member-profile-role-stage-cancel")!.click();
    });
    await pickRole("guest");
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).not.toBeNull());
    expect(byId("member-profile-role-stage-error")).toBeNull();
  });

  it("요청이 도는 동안 확정은 진행 낱말이고 다시 눌러도 한 번이며, X·Esc 가 닫지 않는다", async () => {
    let resolvePatch: (value: unknown) => void = () => undefined;
    changeWorkspaceMemberRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        })
    );
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    await pickRole("admin");
    await confirmStage();
    await vi.waitFor(() =>
      expect(byId("member-profile-role-stage-confirm")?.getAttribute("aria-busy")).toBe("true")
    );
    expect(byId("member-profile-role-stage-confirm")?.textContent).toBe("바꾸는 중");
    await confirmStage();
    expect(changeWorkspaceMemberRole).toHaveBeenCalledTimes(1);
    expect(byId("member-profile-close")).toBeNull();
    await pressEscape();
    expect(byId("member-profile-role-stage")).not.toBeNull();
    await act(async () => {
      resolvePatch({ memberId: MEMBER_ID, scope: "workspace", role: "admin" });
    });
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).toBeNull());
    expect(byId("member-profile-close")).not.toBeNull();
  });

  // #5780 검수 r1 H1: 요청이 나간 뒤의 「취소」는 아무것도 되돌리지 못한다. 눌러도 단계가 그대로 서서 결과를 기다리고,
  // 끝나면 화면이 실제 결과(바뀐 역할)를 보인다 — 취소된 것처럼 물러섰다가 몇 초 뒤 역할이 바뀌는 일이 없다.
  it.each([
    ["멤버 → 관리자", MEMBER_ID, "admin" as const],
    ["관리자 → 소유자(되돌릴 수 없는 길)", ADMIN_ID, "owner" as const],
  ])("요청이 도는 동안 「취소」는 잠기고 단계가 그대로다: %s", async (_label, targetId, to) => {
    let resolvePatch: (value: unknown) => void = () => undefined;
    changeWorkspaceMemberRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        })
    );
    mountProfile({ viewer: OWNER, targetId });
    fetchRoster.mockResolvedValue(ROSTER.map((row) => (row.id === targetId ? { ...row, role: to } : row)));
    await waitForDialog();
    await pickRole(to);
    await confirmStage();
    await vi.waitFor(() =>
      expect(byId("member-profile-role-stage-confirm")?.getAttribute("aria-busy")).toBe("true")
    );
    const cancel = byId<HTMLButtonElement>("member-profile-role-stage-cancel")!;
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      cancel.click();
    });
    expect(byId("member-profile-role-stage")).not.toBeNull();
    expect(changeWorkspaceMemberRole).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePatch({ memberId: targetId, scope: "workspace", role: to });
    });
    await vi.waitFor(() => expect(byId("member-profile-role-stage")).toBeNull());
    expect(byId("member-profile-role-receipt")?.textContent).toBe("바뀜");
    if (to === "owner") {
      await vi.waitFor(() => expect(byId("member-profile-role-text")?.textContent).toBe("소유자"));
    } else {
      await vi.waitFor(() => expect(roleSelect()?.dataset.value).toBe(to));
    }
    expect(changeWorkspaceMemberRole).toHaveBeenCalledTimes(1);
  });

  it("role_labels 오버라이드가 고르개·확인 문장에 반영된다", async () => {
    mountProfile({
      viewer: OWNER,
      targetId: MEMBER_ID,
      labels: { owner: "마스터", admin: "리드", member: "동료", guest: "방문" },
    });
    await waitForDialog();
    const select = roleSelect()!;
    expect(select.getAttribute("role")).toBe("combobox");
    expect(select.getAttribute("aria-label")).toBe("역할");
    expect(select.dataset.variant).toBe("inline");
    await openRoleList();
    const labels = optionEls().map((option) => option.textContent);
    expect(labels).toEqual(["마스터", "리드", "동료", "방문"]);
    expect(labels).not.toEqual([
      DEFAULT_ROLE_LABELS.owner,
      DEFAULT_ROLE_LABELS.admin,
      DEFAULT_ROLE_LABELS.member,
      DEFAULT_ROLE_LABELS.guest,
    ]);
    await pickRole("admin");
    await vi.waitFor(() => expect(byId("member-profile-role-pair")?.textContent).toBe("동료리드"));
  });

  it("실시간만 끊겨도 고르개는 열려 있고 오프라인 배너도 없다(결정 ③)", async () => {
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, connStatus: "disconnected" });
    await waitForDialog();
    expect(byId("member-profile-offline")).toBeNull();
    expect(roleSelect()?.disabled).toBe(false);
  });

  it("오프라인이면 고르개를 잠그고 배너 사유를 가리킨다", async () => {
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID, deviceOffline: true });
    await waitForDialog();
    expect(byId("member-profile-offline")).not.toBeNull();
    expect(roleSelect()?.disabled).toBe(true);
    expect(roleSelect()?.getAttribute("aria-describedby")).toBe("member-profile-offline-reason");
  });
});

// #5242: 멤버 프로필을 불러오지 못했을 때. 옛 「멤버 프로필을 불러오지 못했습니다.」 배너는 원인 상자다.
describe("멤버 프로필: 불러오기 실패 (#5242)", () => {
  // 지키는 것: 받아 둔 명부가 없으면 상자(제목 + 이유 + 다시 시도). 이유는 원인을 따라가고 다시 시도가 명부를 다시 읽는다.
  it("명부를 읽지 못하면 원인 상자가 서고, 이유가 원인을 따라가며, 다시 시도가 명부를 다시 읽는다", async () => {
    // 기기가 꺼져 있으면 이 대화상자는 자기 「연결 끊김」 줄을 먼저 말하므로(`memberProfileViewState`), 상자의 원인은 둘이다.
    const cases: [Error, string, string][] = [
      [new NetworkError("unreachable", 15_000), "serverUnreachable", "서버에 닿지 못했어요."],
      [new ApiError(500, "boom", "internal"), "", "문제가 생겼어요."],
    ];
    for (const [error, cause, reason] of cases) {
      fetchRoster.mockReset();
      mountProfile({ viewer: OWNER, targetId: MEMBER_ID, rosterFailure: { error } });
      const box = await vi.waitFor(() => {
        const node = document.querySelector<HTMLElement>('[data-testid="member-profile-error"]');
        expect(node).not.toBeNull();
        return node as HTMLElement;
      });
      expect(box.getAttribute("role")).toBe("alert");
      expect(box.getAttribute("data-cause") ?? "").toBe(cause);
      expect(box.textContent).toContain("멤버 프로필을 불러오지 못했어요");
      expect(box.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
      expect(document.body.textContent).not.toContain("멤버 프로필을 불러오지 못했습니다");
      // 불러오지 못한 동안에도 창은 이름을 갖고 X 로 닫힌다.
      expect(byId("member-profile-close")).not.toBeNull();
      const reads = fetchRoster.mock.calls.length;
      await act(async () => {
        box.querySelector("button")?.click();
      });
      await vi.waitFor(() => expect(fetchRoster.mock.calls.length).toBeGreaterThan(reads));
      act(() => mountedRoot?.unmount());
      mountedHost?.remove();
      document.body.innerHTML = "";
      mountedRoot = null;
      mountedHost = null;
    }
  });
});

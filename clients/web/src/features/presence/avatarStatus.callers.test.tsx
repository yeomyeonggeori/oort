// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";

// =============================================================================
// 아바타 점을 부르는 자리가 **실제 아바타 크기**를 넘기는가, 에이전트 경고가 사람의 「자리 비움」 그림이 아닌가
// (#5786 수리 1회차, design-review r1 M4·H2).
//
// 점의 크기는 부르는 쪽이 넘기는 `face` 로 정해진다(인라인 스타일을 쓰지 않아 부품이 자식의 크기를 잴 수 없다). 그래서 실제
// 화면을 그려 `.avatar-status` 마다 `data-status-face` 가 안의 아바타 크기와 같은지 잰다 — 채널 멤버 패널의 에이전트 줄에
// `face={24}`(아바타는 32)를 넘기거나 프로필 창이 `face={112}` 를 빼먹으면 붉다(r1 사보타주 E·F 가 초록이던 구멍).
// 아바타 크기는 그 아바타의 크기 클래스에서 읽는다: Tailwind 고정 눈금 `size-N` = N×4px, 큰 얼굴 `avatar-hero` = 112.
// =============================================================================

const api = vi.hoisted(() => ({
  fetchAllActiveAgentRuns: vi.fn(),
  fetchAgentLiveness: vi.fn(),
  fetchRoster: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { statusBadgeShape } from "@momo/core/features/presence/statusBadge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/design/ui/dropdown-menu";
import { ChannelMemberPanel } from "@/features/channels/ChannelContextControls";
import { PresenceStatusItems } from "@/features/sidebar/PresenceControl";
import { MemberProfileProvider } from "@/features/directory/MemberProfileDialog";
import { useOpenMemberProfile } from "@/features/directory/memberProfileContext";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";
const HAYUN = "00000000-0000-7000-8000-000000000102";
const SEOJUN = "00000000-0000-7000-8000-000000000103";
const DALMURI = "00000000-0000-7000-8000-000000000301";
const SAEBYEOK = "00000000-0000-7000-8000-000000000302";

function member(id: string, kind: "human" | "agent", name: string, handle: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

// 가상 인물만.
const MEMBERS: RosterMember[] = [
  member(ME, "human", "김도현", "dohyun", { role: "owner", online: true, email: "dohyun@example.com" }),
  member(HAYUN, "human", "정하윤", "hayun", { online: true, presenceStatus: "away", email: "hayun@example.com" }),
  member(SEOJUN, "human", "박서준", "seojun", { online: false, email: "seojun@example.com" }),
  member(DALMURI, "agent", "달무리봇", "dalmuri", { ownerHumanId: ME }),
  member(SAEBYEOK, "agent", "새벽봇", "saebyeok", { ownerHumanId: ME }),
];
// 달무리봇 = 일이 안 가져가짐(owner 에게 경고 = warn), 새벽봇 = 응답함(ok).
const LIVENESS: Record<string, string> = { [DALMURI]: "work_waiting", [SAEBYEOK]: "responsive" };

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});

beforeEach(() => {
  api.fetchAllActiveAgentRuns.mockResolvedValue({ runs: [] });
  api.fetchAgentLiveness.mockImplementation(async (_ws: string, agentId: string) => ({
    agentMemberId: agentId,
    state: LIVENESS[agentId] ?? "responsive",
    lastSignalAtMs: Date.now(),
  }));
  api.fetchRoster.mockResolvedValue(MEMBERS);
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
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
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

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(child: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["roster", WS], MEMBERS);
  client.setQueryData(workspaceIdentityKey(WS), workspace());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(LocaleProvider, {
        locale: ko,
        children: createElement(
          QueryClientProvider,
          { client },
          createElement(SessionProvider, { value: session() }, createElement(MemoryRouter, null, child))
        ),
      })
    );
  });
  await settle();
}

/** 아바타 크기(px): 크기 클래스에서 — `size-N` = N×4, `avatar-hero` = 112. */
function avatarPx(el: Element): number | null {
  const cls = el.getAttribute("class") ?? "";
  if (/(^|\s)avatar-hero(\s|$)/.test(cls)) return 112;
  const size = /(^|\s)size-(\d+)(\s|$)/.exec(cls);
  return size ? Number(size[2]) * 4 : null;
}

/** 화면의 모든 점 상자: 넘긴 `face` 와 안의 아바타 크기. */
function frames(): { face: number; avatar: number | null; testId: string | null }[] {
  return [...document.querySelectorAll<HTMLElement>(".avatar-status")].map((frame) => {
    const avatar = frame.querySelector(":scope > [data-avatar-status-face] > *");
    return {
      face: Number(frame.dataset.statusFace),
      avatar: avatar ? avatarPx(avatar) : null,
      testId: frame.getAttribute("data-testid"),
    };
  });
}

describe("점을 부르는 자리의 face = 실제 아바타 크기 (r1 M4)", () => {
  it("채널 멤버 패널: 사람 줄·에이전트 줄 모두 넘긴 face 가 아바타 크기(32)다", async () => {
    await render(
      createElement(ChannelMemberPanel, {
        channelId: CH,
        channelName: "design-lab",
        members: MEMBERS,
        status: "ready",
        offline: false,
        onRetry: () => undefined,
        onAddMember: () => undefined,
      })
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!.click();
    });
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="agent-liveness-dot"]').length).toBe(2));
    const all = frames();
    expect(all.filter((f) => f.testId === "avatar-with-liveness")).toHaveLength(2);
    expect(all.filter((f) => f.testId === "avatar-with-presence").length).toBeGreaterThanOrEqual(2);
    for (const f of all) expect(f, JSON.stringify(f)).toEqual({ ...f, avatar: f.face });
  });

  it("멤버 프로필 창: 큰 얼굴의 face 가 112 다", async () => {
    function OpenOnMount() {
      const open = useOpenMemberProfile();
      useEffect(() => open(HAYUN), [open]);
      return null;
    }
    await render(
      createElement(
        OpenAgentProfileContext.Provider,
        { value: () => undefined },
        createElement(MemberProfileProvider, null, createElement(OpenOnMount))
      )
    );
    await vi.waitFor(() => expect(document.querySelector('[data-testid="member-profile-hero"] .avatar-status')).not.toBeNull());
    const hero = document.querySelector<HTMLElement>('[data-testid="member-profile-hero"] .avatar-status')!;
    const avatar = hero.querySelector(":scope > [data-avatar-status-face] > *")!;
    expect([Number(hero.dataset.statusFace), avatarPx(avatar)]).toEqual([112, 112]);
  });
});

describe("에이전트 경고는 채운 원 — 사람의 자리 비움(초승달)과 같은 그림이 아니다 (r1 H2)", () => {
  it("채널 멤버 패널: 에이전트 warn 은 fill(모양 클래스 없음), 사람 away 는 moon", async () => {
    await render(
      createElement(ChannelMemberPanel, {
        channelId: CH,
        channelName: "design-lab",
        members: MEMBERS,
        status: "ready",
        offline: false,
        onRetry: () => undefined,
        onAddMember: () => undefined,
      })
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!.click();
    });
    const agentDot = () =>
      document.querySelector<HTMLElement>(
        `[data-member-id="${DALMURI}"] [data-testid="agent-liveness-dot"]`
      );
    await vi.waitFor(() => expect(agentDot()?.dataset.tone).toBe("warn"));
    expect(agentDot()!.dataset.shape).toBe("fill");
    expect(agentDot()!.className).not.toMatch(/status-shape/);
    const human = document.querySelector<HTMLElement>(`[data-member-id="${HAYUN}"] [data-avatar-status-dot]`)!;
    expect([human.dataset.tone, human.dataset.shape]).toEqual(["warn", "moon"]);
    expect(human.className).toContain("status-shape-moon");
  });
});

describe("「내 상태」 메뉴의 표지 = 배지와 같은 모양 (r1 M1)", () => {
  it("온라인 채운 원 · 자리 비움 초승달 · 방해 금지 가로 줄 — 코어 statusBadgeShape(사람)와 같다", async () => {
    await render(
      createElement(
        DropdownMenu,
        { open: true },
        createElement(DropdownMenuTrigger, null, "상태"),
        createElement(
          DropdownMenuContent,
          null,
          createElement(PresenceStatusItems, {
            workspaceId: WS,
            selfMemberId: ME,
            selfMember: MEMBERS[0],
            onChooseDnd: () => undefined,
          })
        )
      )
    );
    const SHAPE_CLASS = { fill: null, moon: "status-shape-moon", bar: "status-shape-bar", ring: "status-shape-ring" } as const;
    const rows = [
      ["auto", "ok", "bg-ok"],
      ["away", "warn", "bg-warn"],
      ["dnd", "danger", "bg-danger"],
    ] as const;
    for (const [status, tone, fill] of rows) {
      const marker = await vi.waitFor(() => {
        const el = document.querySelector<HTMLElement>(`[data-testid="presence-option-${status}"] [class~="${fill}"]`);
        expect(el, status).not.toBeNull();
        return el!;
      });
      const want = SHAPE_CLASS[statusBadgeShape(tone, "human")];
      const shapes = [...marker.classList].filter((c) => c.startsWith("status-shape-"));
      expect([status, shapes]).toEqual([status, want === null ? [] : [want]]);
      // 모양 규칙이 읽는 크기 변수(점 · 틈)를 표지가 갖는다.
      expect(marker.classList.contains("status-mark"), status).toBe(true);
    }
  });
});

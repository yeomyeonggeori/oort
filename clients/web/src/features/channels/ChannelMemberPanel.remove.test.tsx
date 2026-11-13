// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type MembershipRole, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import koTimeline from "../../../../../packages/momo-core/src/i18n/catalogs/ko-KR/timeline.json";

// =============================================================================
// 채널 멤버 패널의 「채널에서 내보내기」 (#5778) — jsdom 판. 실제 서버·브라우저 왕복은 인계의 e2e 스크립트가 잰다.
//
//   - 줄 끝 ⋯ 은 서버 사다리의 거울에서만 선다: 소유자는 관리자·멤버·게스트, 관리자는 멤버·게스트, 그 밖은 0. 나·에이전트 줄 0
//   - 확인은 패널 **안의** 단계(`ConfirmStage`)이고, 서버가 답하기 전에는 줄이 그대로이며 취소가 잠긴다
//   - 성공하면 그 줄이 사라지고 발치에 한 줄 영수증, 실패하면 단계 안에 사전의 사유 문장
// =============================================================================

const api = vi.hoisted(() => ({
  fetchAllActiveAgentRuns: vi.fn(),
  fetchAgentLiveness: vi.fn(),
  fetchRoster: vi.fn(),
  removeChannelMember: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { ChannelMemberPanel } from "./ChannelContextControls";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const DOHYEON = "00000000-0000-7000-8000-00000000a001"; // 소유자
const SEOYEON = "00000000-0000-7000-8000-00000000a002"; // 관리자
const HANEUL = "00000000-0000-7000-8000-00000000a003"; // 멤버
const SERIN = "00000000-0000-7000-8000-00000000a005"; // 게스트
const AGENT = "00000000-0000-7000-8000-000000000102";
const KO = koTimeline as Record<string, string>;

function member(id: string, kind: "human" | "agent", name: string, handle: string, role: MembershipRole): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    role,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  } as RosterMember;
}

const MEMBERS: RosterMember[] = [
  member(DOHYEON, "human", "김도현", "dohyeon", "owner"),
  member(SEOYEON, "human", "이서연", "seoyeon", "admin"),
  member(HANEUL, "human", "정하늘", "haneul", "member"),
  member(SERIN, "human", "오세린", "serin", "guest"),
  member(AGENT, "agent", "김인턴", "kim-intern", "member"),
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
let korean: AppLocale;
/** 가짜 서버의 명부. 내보내기를 받으면 그 사람의 이 채널이 빠진다(다시 읽기가 서버의 지금을 돌려준다). */
let serverRoster: RosterMember[] = MEMBERS;
const serverRemoves = (memberId: string) => {
  serverRoster = serverRoster.map((m) => (m.id === memberId ? { ...m, channelIds: [], channelCount: 0 } : m));
};

function session(viewer: string): SessionContextValue {
  const me = MEMBERS.find((m) => m.id === viewer)!;
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: viewer, workspaceId: WS, kind: "human", displayName: me.displayName, handle: me.handle },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function tree(viewer: string, members: RosterMember[], offline: boolean) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(LocaleProvider, {
      locale: korean,
      children: createElement(
        SessionProvider,
        { value: session(viewer) },
        createElement(ChannelMemberPanel, {
          channelId: CH,
          channelName: "release-notes",
          members,
          status: "ready",
          offline,
          onRetry: () => undefined,
          onAddMember: () => undefined,
        })
      ),
    })
  );
}

async function mountOpen(viewer: string, offline = false) {
  client.setQueryData(["roster", WS], MEMBERS);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree(viewer, MEMBERS, offline));
  });
  await settle();
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!.click();
  });
  await settle();
}

/** 명부 캐시가 바뀌면 셸은 채널의 멤버를 다시 세어 넘긴다 — 그 재계산을 흉내 낸다. */
async function rerenderFromRoster(viewer: string) {
  const roster = client.getQueryData<RosterMember[]>(["roster", WS]) ?? [];
  await act(async () => {
    root?.render(tree(viewer, roster.filter((m) => m.channelIds.includes(CH)), false));
  });
  await settle();
}

const rowMenus = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="channel-member-row-menu"]')].map(
    (button) => button.closest<HTMLElement>('[data-testid="channel-member-item"]')!.dataset.memberId
  );
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rowOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="channel-member-item"][data-member-id="${id}"]`);

async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await settle();
}

async function openStageFor(id: string) {
  const trigger = rowOf(id)!.querySelector<HTMLElement>('[data-testid="channel-member-row-menu"]')!;
  await press(trigger);
  await press(byId("channel-member-remove")!);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  for (const fn of Object.values(api)) fn.mockReset();
  serverRoster = MEMBERS;
  api.fetchRoster.mockImplementation(async () => serverRoster);
  api.fetchAllActiveAgentRuns.mockResolvedValue({ runs: [], truncated: false, pages: 1 });
  api.fetchAgentLiveness.mockRejectedValue(new ApiError(404, "not hosted"));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("줄 끝 ⋯ 은 서버 사다리의 거울에서만 선다 (#5778)", () => {
  it("소유자: 관리자·멤버·게스트 줄에만 — 내 줄·에이전트 줄에는 없다", async () => {
    await mountOpen(DOHYEON);
    expect(rowMenus().sort()).toEqual([SEOYEON, HANEUL, SERIN].sort());
  });

  it("관리자: 멤버·게스트 줄에만 — 소유자·다른 관리자(나)에게는 없다", async () => {
    await mountOpen(SEOYEON);
    expect(rowMenus().sort()).toEqual([HANEUL, SERIN].sort());
  });

  it.each([
    ["멤버", HANEUL],
    ["게스트", SERIN],
  ])("%s: 줄이 아예 없다", async (_name, viewer) => {
    await mountOpen(viewer);
    expect(rowMenus()).toEqual([]);
    expect(byId("channel-member-remove")).toBeNull();
  });
});

describe("확인 단계 → 서버 → 줄과 영수증 (#5778)", () => {
  it("단계는 패널 안에 서고, 답하기 전에는 줄이 그대로이며 취소가 잠긴다. 받으면 줄이 사라지고 발치에 영수증", async () => {
    const pending = deferred<unknown>();
    api.removeChannelMember.mockReturnValue(pending.promise);
    await mountOpen(SEOYEON);
    await openStageFor(HANEUL);

    const stage = byId("channel-member-remove-stage")!;
    expect(stage).not.toBeNull();
    // 두 번째 대화상자가 아니라 패널 안의 단계다(§3.4).
    expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(1);
    expect(stage.textContent).toContain(KO["timeline.memberPanel.removeTitle"].replace("{name}", "정하늘"));
    expect(api.removeChannelMember).not.toHaveBeenCalled();

    await press(byId("channel-member-remove-stage-confirm")!);
    expect(api.removeChannelMember).toHaveBeenCalledWith(WS, CH, HANEUL);
    expect(byId("channel-member-remove-stage-confirm")!.getAttribute("aria-busy")).toBe("true");
    expect(byId("channel-member-remove-stage-cancel")!.getAttribute("aria-disabled")).toBe("true");
    await press(byId("channel-member-remove-stage-cancel")!);
    expect(byId("channel-member-remove-stage")).not.toBeNull();
    expect(rowOf(HANEUL)).not.toBeNull();
    // 셸은 명부 캐시로 채널 멤버를 센다: 서버가 답하기 전에는 캐시도 그대로다(낙관 삭제 없음).
    expect(client.getQueryData<RosterMember[]>(["roster", WS])!.find((m) => m.id === HANEUL)!.channelIds).toEqual([CH]);

    await act(async () => {
      serverRemoves(HANEUL);
      pending.resolve({});
      await Promise.resolve();
    });
    await settle();
    await rerenderFromRoster(SEOYEON);

    expect(byId("channel-member-remove-stage")).toBeNull();
    expect(rowOf(HANEUL)).toBeNull();
    const receipt = byId("channel-member-removed")!;
    expect(receipt.getAttribute("role")).toBe("status");
    expect(receipt.textContent).toBe(KO["timeline.memberPanel.removed"].replace("{name}", "정하늘"));
    // 명부 캐시에서도 그 사람의 이 채널만 빠졌다.
    const roster = client.getQueryData<RosterMember[]>(["roster", WS])!;
    expect(roster.find((m) => m.id === HANEUL)!.channelIds).toEqual([]);
    expect(roster.find((m) => m.id === SERIN)!.channelIds).toEqual([CH]);
  });

  it("거절되면 단계 안에서 사전의 사유 문장을 말하고 줄은 그대로다", async () => {
    api.removeChannelMember.mockRejectedValue(new ApiError(403, "workspace owner or admin role required"));
    await mountOpen(SEOYEON);
    await openStageFor(SERIN);
    await press(byId("channel-member-remove-stage-confirm")!);
    await settle();
    expect(byId("channel-member-remove-stage-error")!.textContent).toBe(KO["timeline.memberPanel.removeErrorForbidden"]);
    expect(byId("channel-member-remove-stage")).not.toBeNull();
    expect(rowOf(SERIN)).not.toBeNull();
  });

  it("오프라인이면 확정이 잠기고 까닭을 가리킨다", async () => {
    await mountOpen(SEOYEON, true);
    await openStageFor(HANEUL);
    const confirm = byId("channel-member-remove-stage-confirm")!;
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toBeTruthy();
    await press(confirm);
    expect(api.removeChannelMember).not.toHaveBeenCalled();
  });

  it("취소하면 단계가 내려가고 목록이 다시 보인다", async () => {
    await mountOpen(SEOYEON);
    await openStageFor(HANEUL);
    await press(byId("channel-member-remove-stage-cancel")!);
    expect(byId("channel-member-remove-stage")).toBeNull();
    expect(rowOf(HANEUL)).not.toBeNull();
    expect(api.removeChannelMember).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";
import type { ScheduledMessageFrame } from "@momo/core/features/scheduled/events";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";

// =============================================================================
// ADR-0208 부록 B 상태 6·7·8(#4215): 「예약됨」 목록 화면.
//
// 서버 대신 `@momo/core/features/scheduled/api`를 막는다. 그 밖은 진짜다: 진짜 `ScheduledRoute`, 진짜 병합(`useScheduled`),
// 진짜 Radix 메뉴·대화상자, 진짜 초점 규칙. 시계는 2026-10-22(목) 14:30 KST로 고정한다.
// =============================================================================

const scheduledApi = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => scheduledApi);

const api = vi.hoisted(() => ({ listChannels: vi.fn(), fetchRoster: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { resetSchedulerDisabledForTest } from "./useScheduled";
import { ScheduledRoute } from "./ScheduledRoute";

const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const TOMORROW_9 = new Date("2026-10-23T09:00:00+09:00").getTime();
const MONDAY_9 = new Date("2026-10-26T09:00:00+09:00").getTime();
const HOUR = 3_600_000;

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const KIM = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const DEPLOY = "00000000-0000-7000-8000-000000000202";
const DM = "00000000-0000-7000-8000-000000000204";
const GONE = "00000000-0000-7000-8000-0000000002ff";
const ROOT = "00000000-0000-7000-8000-000000000301";

const CHANNELS = [
  { id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false },
  { id: DEPLOY, workspaceId: WS, kind: "public", name: "배포", muted: false },
  { id: DM, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, KIM] },
] as unknown as Channel[];

const ROSTER = [
  { id: ME, workspaceId: WS, kind: "human", status: "active", role: "owner", displayName: "박서연", handle: "seoyeon", channelCount: 3, channelIds: [CH, DEPLOY], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: KIM, workspaceId: WS, kind: "agent", status: "active", displayName: "김인턴", handle: "kim-intern", ownerHumanId: ME, channelCount: 1, channelIds: [DM], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
] as unknown as RosterMember[];

let serial = 0;
const id = (n: number) => `00000000-0000-7000-8000-0000000004${String(n).padStart(2, "0")}`;

function row(over: Partial<ScheduledMessage> = {}): ScheduledMessage {
  serial += 1;
  const sendAtMs = over.sendAtMs ?? TOMORROW_9;
  const status = over.status ?? "pending";
  return {
    id: id(serial),
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "내일 회의 전에 자료 올려 둘게요",
    sendAtMs,
    status,
    rev: 0,
    createdAtMs: NOW - 2 * HOUR,
    updatedAtMs: NOW - 2 * HOUR,
    ...(status === "pending" ? { editableUntilMs: sendAtMs - 30_000 } : {}),
    ...over,
  };
}

function frame(over: Partial<ScheduledMessageFrame> = {}): ScheduledMessageFrame {
  return {
    workspaceId: WS.toUpperCase(),
    memberId: ME.toUpperCase(),
    scheduledMessageId: id(1).toUpperCase(),
    channelId: CH.toUpperCase(),
    status: "failed",
    failureReason: "sessions_ended",
    sendAtMs: TOMORROW_9,
    rev: 1,
    ...over,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let here = "";
let writeText: ReturnType<typeof vi.fn>;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  serial = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue(ROSTER);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  // React Query의 온라인 관리자는 모듈 하나를 시험 파일 전체가 쓴다: 오프라인 시험이 끊어 둔 채로 넘기면 다음 시험의
  // 읽기가 멈춘다.
  onlineManager.setOnline(true);
  window.dispatchEvent(new Event("online"));
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function fakeRealtime() {
  const handlers: Array<{ onEvent: (f: ScheduledMessageFrame) => void; onResync: () => void }> = [];
  const handle = {
    subscribeScheduled: vi.fn((_member: string, next: (typeof handlers)[number]) => {
      handlers.push(next);
      return () => undefined;
    }),
  } as unknown as RealtimeHandle;
  return { handle, handlers };
}

function session(realtime: RealtimeHandle | null): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function Probe() {
  const location = useLocation();
  here = `${location.pathname}${location.search}`;
  return null;
}

async function mount(entry = "/scheduled", realtime: RealtimeHandle | null = null) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [entry] },
          createElement(
            SessionProvider,
            { value: session(realtime) },
            createElement(
              ShellNavProvider,
              { value: { isMobile: false, drawerOpen: false, openDrawer: () => undefined, closeDrawer: () => undefined } },
              createElement(Probe),
              createElement(
                Routes,
                null,
                createElement(Route, { path: "/scheduled", element: createElement(ScheduledRoute) }),
                createElement(Route, { path: "*", element: createElement("div", { "data-testid": "elsewhere" }) })
              )
            )
          )
        )
      )
    );
  });
  await settle();
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const byId = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
function need(testId: string): HTMLElement {
  const el = byId(testId);
  if (!el) throw new Error(`없다: ${testId}`);
  return el;
}
const textOf = (testId: string): string => (byId(testId)?.textContent ?? "").replace(/\s+/g, " ").trim();
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="scheduled-row"]')];
const rowById = (rowId: string): HTMLElement => {
  const el = rows().find((r) => r.getAttribute("data-row-id")?.toLowerCase() === rowId.toLowerCase());
  if (!el) throw new Error(`행이 없다: ${rowId}`);
  return el;
};
const inRow = (rowId: string, testId: string): HTMLElement => {
  const el = rowById(rowId).querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`행 안에 없다: ${testId}`);
  return el;
};
const rowTexts = (testId: string): string[] =>
  rows().map((r) => (r.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "").replace(/\s+/g, " ").trim());

async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}
const clickById = (testId: string) => press(need(testId));

async function openRowMenu(rowId: string) {
  await act(async () => {
    inRow(rowId, "scheduled-row-menu").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await settle(1);
}
async function chooseFromMenu(rowId: string, action: string) {
  await openRowMenu(rowId);
  await press(need(`scheduled-row-menu-${action}`));
  await settle(3);
}
const menuLabels = (): string[] =>
  [...document.querySelectorAll('[data-testid="scheduled-row-menu-panel"] [role="menuitem"]')].map((el) => (el.firstElementChild?.textContent ?? el.textContent ?? "").trim());

async function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle(1);
}

/** 조건이 설 때까지 기다린다(고정된 잠을 자지 않는다: 부하가 높은 CI에서도 마진에 기대지 않는다). */
async function until(condition: () => boolean, label: string, limitMs = 5_000) {
  // `Date`는 시험이 고정했으므로 실제 시계(`performance.now`)로 잰다.
  const wall = performance.now();
  while (!condition()) {
    if (performance.now() - wall > limitMs) throw new Error(`기다렸지만 서지 않았다: ${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function setValue(testId: string, value: string) {
  const el = need(testId) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  return act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const focusedRow = (): string | null =>
  document.activeElement?.closest('[data-testid="scheduled-row"]')?.getAttribute("data-row-id") ?? null;

/** 서버의 목록 읽기를 이 행들로 돌려준다. */
function server(list: ScheduledMessage[]) {
  scheduledApi.listAllScheduledMessages.mockResolvedValue(list);
}

describe("이 화면의 네 상태: 빈 · 로딩 · 오류 · 오프라인", () => {
  it("빈: 「예약한 메시지가 없어요」와 쓰는 법과 「대화로 돌아가기」", async () => {
    await mount();
    expect(textOf("scheduled-empty")).toContain("예약한 메시지가 없어요");
    expect(textOf("scheduled-empty")).toContain("메시지를 쓰고 보내기 옆 화살표에서 시각을 고르면 예약돼요");
    expect(byId("scheduled-count")).toBe(textOf("scheduled-count") === "내 예약 0개" ? byId("scheduled-count") : null);
    await clickById("scheduled-empty-back");
    expect(here).toBe("/");
  });

  it("로딩: 첫 목록이 오기 전에는 스켈레톤이고 제목은 서 있다", async () => {
    let release!: (rows: ScheduledMessage[]) => void;
    scheduledApi.listAllScheduledMessages.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await mount();
    expect(textOf("scheduled-heading")).toBe("예약됨");
    expect(byId("scheduled-empty")).toBeNull();
    expect(byId("scheduled-count")).toBeNull();
    expect(document.querySelector('[data-testid="scheduled-route"] [aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      release([row()]);
    });
    await settle();
    expect(rows()).toHaveLength(1);
    expect(textOf("scheduled-count")).toBe("내 예약 1개");
  });

  it("오류: 「예약 목록을 불러오지 못했어요」와 「다시 불러오기」, 누르면 다시 읽는다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValueOnce(new ApiError(503, "down"));
    await mount();
    expect(textOf("scheduled-error")).toContain("예약 목록을 불러오지 못했어요");
    expect(need("scheduled-error").getAttribute("role")).toBe("alert");
    server([row()]);
    await press(need("scheduled-error").querySelector("button")!);
    await settle();
    expect(byId("scheduled-error")).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("이 서버에는 예약이 없다(첫 목록 404): 옛 링크로 온 사람에게만 이 줄이 보인다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(404, "not found"));
    await mount();
    expect(textOf("scheduled-absent")).toContain("이 서버에서는 예약을 쓸 수 없어요");
    expect(textOf("scheduled-absent")).toContain("관리자에게 물어보세요");
    // 막다른 화면이 아니다: 형제 빈 화면과 같이 「대화로 돌아가기」가 있다(design-review #4215 N5).
    expect(textOf("scheduled-absent-back")).toBe("대화로 돌아가기");
    await clickById("scheduled-absent-back");
    expect(here).toBe("/");
    expect(byId("scheduled-count")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("오프라인: 캐시된 목록은 그대로 보이고 안내 한 줄이 서며 모든 동작이 흐리다", async () => {
    server([
      row({ status: "failed", failureReason: "missed", sendAtMs: NOW - HOUR, rev: 2 }),
      row({ sendAtMs: TOMORROW_9 }),
    ]);
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(textOf("scheduled-offline")).toContain("연결이 없어요. 연결되면 예약을 바꿀 수 있어요.");
    expect(rows()).toHaveLength(2);
    for (const testId of ["scheduled-row-sendNow", "scheduled-row-rearm"]) {
      expect(need(testId).getAttribute("aria-disabled")).toBe("true");
    }
    const pending = rows().find((r) => r.getAttribute("data-status") === "pending")!;
    await openRowMenu(pending.getAttribute("data-row-id")!);
    const items = [...document.querySelectorAll('[data-testid="scheduled-row-menu-panel"] [role="menuitem"]')];
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.getAttribute("aria-disabled") === "true")).toBe(true);
    // 흐린 항목을 눌러도 아무것도 부르지 않는다.
    await press(need("scheduled-row-menu-sendNow"));
    expect(scheduledApi.sendScheduledMessageNow).not.toHaveBeenCalled();
  });
});

describe("머리의 상태줄은 고정 자리다 (design-review #4215 M1)", () => {
  it("보내기 전: 낭독 노드는 늘 있고 안 보이며, 「내 예약 N개」가 자리를 쓴다. 보낸 직후: 같은 자리가 상태줄로 바뀐다", async () => {
    const r = row();
    server([r]);
    scheduledApi.sendScheduledMessageNow.mockResolvedValue({ ...r, status: "sent", rev: 1 });
    await mount();
    expect(need("scheduled-status").className).toContain("sr-only");
    expect(need("scheduled-status").textContent).toBe("");
    expect(textOf("scheduled-count")).toBe("내 예약 1개");
    expect(byId("scheduled-status-line")).toBeNull();
    await chooseFromMenu(r.id, "sendNow");
    // 같은 머리(header) 안에서 하나가 다른 하나를 대신한다: 두 칸이 함께 서는 일이 없다.
    const header = need("scheduled-route").querySelector("header") as HTMLElement;
    expect(header.contains(need("scheduled-status-line"))).toBe(true);
    expect(header.querySelector('[data-testid="scheduled-count"]')).toBeNull();
    // 낭독 노드는 목록 머리 밖의 별도 노드이고 높이 0이다: 줄을 만들지 않는다.
    expect(header.contains(need("scheduled-status"))).toBe(false);
    expect(need("scheduled-status").className).toBe("sr-only");
  });
});

describe("구획과 행 (UI 명세 1.7)", () => {
  const all = () => [
    row({ channelId: DEPLOY, body: "금요일 배포 공지", sendAtMs: NOW - 2 * HOUR, status: "failed", failureReason: "not_member", rev: 2 }),
    row({ body: "점심 투표 올려 둘게요", sendAtMs: NOW - HOUR, status: "failed", failureReason: "missed", rev: 2 }),
    row({ body: "내일 회의 전에 자료 올려 둘게요", sendAtMs: TOMORROW_9, attachments: [
      { id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 10 },
      { id: "a2", name: "변경목록.csv", mime: "text/csv", sizeBytes: 10 },
    ] }),
    row({ channelId: DM, body: "어제 회의록 정리해서 보내 줘", sendAtMs: MONDAY_9 }),
    row({ body: "곧 나갈 공지예요", sendAtMs: NOW + 20_000 }),
    row({ channelId: GONE, body: "나간 채널에 걸어 둔 글", sendAtMs: NOW + 5 * 24 * HOUR }),
  ];

  it("보내지 못함이 위, 보낼 예정이 아래(마감 임박순)이고 구획이 비면 제목도 없다", async () => {
    server(all());
    await mount();
    const titles = [...document.querySelectorAll('[data-testid^="scheduled-section-"] h2')].map((h) => h.textContent);
    expect(titles).toEqual(["보내지 못함", "보낼 예정"]);
    expect(rowTexts("scheduled-row-place")).toEqual(["배포", "일반", "일반", "일반", "김인턴과의 대화", "알 수 없는 채널"]);
    expect(textOf("scheduled-count")).toBe("내 예약 6개");

    server([row()]);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  });

  it("보낼 예정만 있으면 「보내지 못함」 제목이 없다", async () => {
    server([row()]);
    await mount();
    expect(byId("scheduled-section-failed")).toBeNull();
    expect(textOf("scheduled-section-pending")).toContain("보낼 예정");
  });

  it("시각 줄: 내일·그 밖·마감 30초 안은 「곧 보내요」·지난 뒤는 「보내는 중」", async () => {
    server([
      row({ sendAtMs: NOW - 5_000, editableUntilMs: NOW - 35_000 }),
      row({ sendAtMs: NOW + 20_000 }),
      row({ sendAtMs: TOMORROW_9 }),
      row({ sendAtMs: MONDAY_9 }),
    ]);
    await mount();
    expect(rowTexts("scheduled-row-when")).toEqual([
      "보내는 중",
      "곧 보내요",
      "내일 오전 9:00에 보내요",
      "10월 26일 (월) 오전 9:00에 보내요",
    ]);
  });

  it("첨부 칩과 미리보기: 줄바꿈은 공백으로 접고 두 줄에서 접힌다", async () => {
    server([row({ body: "첫 줄\n\n둘째 줄", attachments: [{ id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 10 }] })]);
    await mount();
    expect(textOf("scheduled-row-attachments")).toBe("첨부 1개");
    expect(textOf("scheduled-row-preview")).toBe("첫 줄 둘째 줄");
    expect(need("scheduled-row-preview").className).toContain("line-clamp-2");
  });

  it("낭독 이름: 보낼 예정은 「{채널}, {미리보기}, {시각}에 보내요」, 보내지 못함은 「{채널}, {미리보기}, {사유}」", async () => {
    const [failed, pending] = [
      row({ channelId: DEPLOY, body: "금요일 배포 공지", sendAtMs: NOW - HOUR, status: "failed", failureReason: "not_member", rev: 2 }),
      row({ body: "내일 회의 전에 자료 올려 둘게요", sendAtMs: TOMORROW_9 }),
    ];
    server([failed!, pending!]);
    await mount();
    const names = rows().map((r) => r.querySelector('[role="group"]')?.getAttribute("aria-label"));
    expect(names).toEqual([
      "배포, 금요일 배포 공지, 이 채널에서 나가서 보내지 못했어요",
      "일반, 내일 회의 전에 자료 올려 둘게요, 내일 오전 9:00, 10월 23일 금요일에 보내요",
    ]);
    const menuNames = rows().map((r) => r.querySelector('[data-testid="scheduled-row-menu"]')?.getAttribute("aria-label"));
    expect(new Set(menuNames).size).toBe(2);
    expect(menuNames.every((name) => name?.endsWith("예약 동작"))).toBe(true);
  });

  it("보낼 예정 행에는 상시 버튼이 없다. 실패 행만 맥락 안의 다음 행동이 보인다", async () => {
    server(all());
    await mount();
    const inlineOf = (r: HTMLElement) =>
      [...r.querySelectorAll("button")].filter((b) => b.getAttribute("data-testid") !== "scheduled-row-menu").map((b) => b.textContent);
    const [notMember, missed, ...pending] = rows();
    expect(inlineOf(notMember!)).toEqual(["내용 복사"]);
    expect(inlineOf(missed!)).toEqual(["지금 보내기", "다시 예약"]);
    for (const r of pending) expect(inlineOf(r)).toEqual([]);
    // 사유 줄은 위험 어조, 다음 행동 줄은 보조 어조.
    expect(need("scheduled-section-failed").querySelector('[data-testid="scheduled-row-reason"]')?.className).toContain("text-danger");
    expect(need("scheduled-section-failed").querySelector('[data-testid="scheduled-row-next"]')?.className).toContain("text-ink-muted");
  });

  it("사유 여덟 가지가 3.2의 두 줄로 선다", async () => {
    const reasons = [
      ["sessions_ended", "로그인이 끝나서 예약을 멈췄어요", "내용을 확인하고 보내거나 다시 예약해 주세요"],
      ["author_inactive", "계정이 정지돼 있어서 보내지 못했어요", "정지가 풀린 뒤에 다시 예약해 주세요"],
      ["missed", "예약한 시각이 많이 지나서 보내지 않았어요", "지금 보내거나 다시 예약할 수 있어요"],
      ["send_error", "서버 문제로 보내지 못했어요", "잠시 뒤에 지금 보내기로 다시 해 볼 수 있어요"],
      ["not_member", "이 채널에서 나가서 보내지 못했어요", "채널에 다시 들어간 뒤에 보낼 수 있어요"],
      ["root_unavailable", "답하려던 메시지가 지워져서 보내지 못했어요", "내용을 복사해서 채널에 새로 보내 주세요"],
      ["attachment_unavailable", "첨부한 파일을 쓸 수 없어서 보내지 못했어요", "파일을 다시 올려서 새로 예약해 주세요"],
      ["not_allowed", "이 채널의 규칙 때문에 보내지 못했어요", "관리자에게 물어보세요"],
    ] as const;
    server(reasons.map(([reason], index) => row({ status: "failed", failureReason: reason, sendAtMs: NOW - (index + 1) * HOUR, rev: 2 })));
    await mount();
    const byReason = new Map(rows().map((r) => [r.getAttribute("data-failure"), [
      r.querySelector('[data-testid="scheduled-row-reason"]')?.textContent,
      r.querySelector('[data-testid="scheduled-row-next"]')?.textContent,
    ]]));
    for (const [reason, line, next] of reasons) expect(byReason.get(reason)).toEqual([line, next]);
  });

  it("DM 행은 상대의 아바타(24px)가 앞머리이고, 채널 행은 종류 아이콘이다(명세 1.7: 「{이름}과의 대화」와 아바타)", async () => {
    server([
      row({ channelId: DM, body: "DM 글", sendAtMs: TOMORROW_9 }),
      row({ channelId: CH, body: "채널 글", sendAtMs: TOMORROW_9 + 60_000 }),
    ]);
    await mount();
    const [dm, channel] = rows();
    const avatar = dm!.querySelector('[data-testid="member-avatar"]');
    expect(avatar).not.toBeNull();
    // 김인턴은 에이전트라 둥근 사각 + 24px(sm)이다.
    expect(avatar?.getAttribute("data-avatar-kind")).toBe("agent");
    expect(avatar?.getAttribute("data-avatar-size")).toBe("sm");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(dm!.textContent).toContain("김인턴과의 대화");
    expect(channel!.querySelector('[data-testid="member-avatar"]')).toBeNull();
    expect(channel!.querySelector("svg.lucide-hash")).not.toBeNull();
  });

  it("DM 행의 사유는 「채널」이 아니라 「대화」로 말한다", async () => {
    server([row({ channelId: DM, status: "failed", failureReason: "not_member", sendAtMs: NOW - HOUR, rev: 2 })]);
    await mount();
    expect(textOf("scheduled-row-reason")).toBe("이 대화에서 나가서 보내지 못했어요");
    expect(textOf("scheduled-row-next")).toBe("대화에 다시 들어간 뒤에 보낼 수 있어요");
  });
});

describe("채널·스레드로 거르기 (UI 명세 1.7)", () => {
  const list = () => [
    row({ channelId: CH, body: "일반 글" }),
    row({ channelId: CH, rootId: ROOT, body: "일반 스레드 글", sendAtMs: TOMORROW_9 + 60_000 }),
    row({ channelId: DEPLOY, body: "배포 글", sendAtMs: TOMORROW_9 + 120_000 }),
  ];

  it("?channel=<id>: 머리에 「#일반 예약만 보고 있어요」와 「모두 보기」가 서고 그 채널의 행만 보인다", async () => {
    server(list());
    await mount(`/scheduled?channel=${CH}`);
    expect(textOf("scheduled-filter")).toContain("#일반 예약만 보고 있어요");
    expect(need("scheduled-filter").getAttribute("role")).not.toBe("alert");
    expect(rows()).toHaveLength(2);
    await press(need("scheduled-filter").querySelector("button")!);
    expect(here).toBe("/scheduled");
    expect(rows()).toHaveLength(3);
    expect(byId("scheduled-filter")).toBeNull();
  });

  it("&thread=<rootId>: 그 스레드의 행만 보인다", async () => {
    server(list());
    await mount(`/scheduled?channel=${CH}&thread=${ROOT}`);
    expect(textOf("scheduled-filter")).toContain("#일반 스레드 예약만 보고 있어요");
    expect(rowTexts("scheduled-row-preview")).toEqual(["일반 스레드 글"]);
  });

  it("거른 결과가 비면 빈 화면의 「대화로 돌아가기」가 그 채널로 돌아간다", async () => {
    server([row({ channelId: DEPLOY })]);
    await mount(`/scheduled?channel=${CH}`);
    expect(byId("scheduled-empty")).not.toBeNull();
    await clickById("scheduled-empty-back");
    expect(here).toBe(`/c/${CH}`);
  });
});

describe("행 동작: 메뉴와 지금 보내기 (UI 명세 1.7)", () => {
  it("보낼 예정 행의 ⋯: 지금 보내기 · 시간 바꾸기 · 고치기 · 지우기, 지우기는 위험 어조", async () => {
    const r = row();
    server([r]);
    await mount();
    await openRowMenu(r.id);
    expect(menuLabels()).toEqual(["지금 보내기", "시간 바꾸기", "고치기", "지우기"]);
    expect(need("scheduled-row-menu-delete").className).toContain("text-danger");
    expect(need("scheduled-row-menu").getAttribute("aria-expanded")).toBe("true");
  });

  it("흐린 항목은 낱말만 흐리다: 이유 줄(왜 흐린가)은 흐린 상자 안에 있지 않아 제 대비를 지킨다 (design-review #4215 M2)", async () => {
    const r = row({ sendAtMs: NOW + 20_000 });
    server([r]);
    await mount();
    await openRowMenu(r.id);
    for (const action of ["change", "edit"]) {
      const item = need(`scheduled-row-menu-${action}`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      // 항목 자체는 흐리지 않다(`data-[disabled]:opacity-50`은 Radix `disabled` 항목용 변형이고 이 항목은 `aria-disabled`다).
      expect(item.className).not.toMatch(/(^|\s)opacity-50(\s|$)/);
      const [label, reason] = [...item.querySelectorAll("span")];
      expect(label!.className).toContain("opacity-50");
      expect(reason!.textContent).toBe("곧 보내서 바꿀 수 없어요");
      expect(reason!.closest(".opacity-50")).toBeNull();
    }
    // 흐리지 않은 항목은 아무것도 흐리지 않다.
    expect(need("scheduled-row-menu-sendNow").querySelector(".opacity-50")).toBeNull();
  });

  it("마감 30초 안의 행: 시간 바꾸기·고치기는 이유와 함께 흐리고 눌러도 열리지 않으며, 지금 보내기·지우기는 된다", async () => {
    const r = row({ sendAtMs: NOW + 20_000 });
    server([r]);
    await mount();
    await openRowMenu(r.id);
    for (const action of ["change", "edit"]) {
      const item = need(`scheduled-row-menu-${action}`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain("곧 보내서 바꿀 수 없어요");
    }
    expect(need("scheduled-row-menu-sendNow").getAttribute("aria-disabled")).toBeNull();
    expect(need("scheduled-row-menu-delete").getAttribute("aria-disabled")).toBeNull();
    await press(need("scheduled-row-menu-edit"));
    expect(byId("scheduled-edit-dialog")).toBeNull();
    await press(need("scheduled-row-menu-change"));
    expect(byId("schedule-dialog")).toBeNull();
  });

  it("지금 보내기: 한 번 누르면 가고(확인 없음), 행이 사라지고 목록 머리에 상태줄이 서며, 초점은 다음 행의 첫 컨트롤이다", async () => {
    const first = row({ sendAtMs: TOMORROW_9, body: "첫째" });
    const second = row({ sendAtMs: TOMORROW_9 + 60_000, body: "둘째" });
    const third = row({ sendAtMs: TOMORROW_9 + 120_000, body: "셋째" });
    server([first, second, third]);
    scheduledApi.sendScheduledMessageNow.mockResolvedValue({ ...second, status: "sent", rev: 1, sentMessageId: "m1", sentAtMs: NOW });
    await mount();
    await chooseFromMenu(second.id, "sendNow");
    expect(scheduledApi.sendScheduledMessageNow).toHaveBeenCalledTimes(1);
    expect(scheduledApi.sendScheduledMessageNow).toHaveBeenCalledWith(WS, second.id);
    expect(byId("scheduled-delete-dialog")).toBeNull();
    expect(rows().map((el) => el.getAttribute("data-row-id"))).toEqual([first.id, third.id]);
    expect(textOf("scheduled-status")).toBe("메시지를 보냈어요");
    expect(need("scheduled-status").getAttribute("role")).toBe("status");
    // 목록 머리의 고정 자리(「내 예약 N개」)를 3초 대신 쓴다: 새 줄을 만들지 않아 목록이 밀렸다 당겨지지 않는다(M1).
    const line = need("scheduled-status-line");
    expect(line.textContent).toBe("메시지를 보냈어요");
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.closest("header")).not.toBeNull();
    expect(byId("scheduled-count")).toBeNull();
    // 낭독 노드는 늘 붙어 있고 눈에 보이는 줄을 만들지 않는다(높이 0).
    expect(need("scheduled-status").className).toContain("sr-only");
    expect(focusedRow()).toBe(third.id);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    // 3초 동안은 상태줄이 「내 예약 N개」의 자리를 쓴다(돌아오는 시점은 `useTransientStatus.test`가 잰다).
    expect(byId("scheduled-count")).toBeNull();
  });

  it("다음 행이 없으면 앞 행으로, 행이 하나도 없으면 목록 제목으로 초점이 간다", async () => {
    const first = row({ sendAtMs: TOMORROW_9, body: "첫째" });
    const last = row({ sendAtMs: TOMORROW_9 + 60_000, body: "마지막" });
    server([first, last]);
    scheduledApi.sendScheduledMessageNow.mockImplementation(async (_ws: string, rowId: string) => ({ ...(rowId === last.id ? last : first), status: "sent", rev: 1 }));
    await mount();
    await chooseFromMenu(last.id, "sendNow");
    expect(focusedRow()).toBe(first.id);
    await chooseFromMenu(first.id, "sendNow");
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(need("scheduled-heading"));
    expect(byId("scheduled-empty")).not.toBeNull();
  });

  it("보내는 동안 같은 행의 두 번째 누름은 요청을 만들지 않는다", async () => {
    const r = row();
    server([r]);
    let finish!: (value: ScheduledMessage) => void;
    scheduledApi.sendScheduledMessageNow.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    await chooseFromMenu(r.id, "sendNow");
    await openRowMenu(r.id);
    await press(need("scheduled-row-menu-sendNow"));
    expect(scheduledApi.sendScheduledMessageNow).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ...r, status: "sent", rev: 1 });
    });
    await settle();
    expect(rows()).toHaveLength(0);
  });

  it("실패한 행의 「지금 보내기」: 버튼 안에 「보내는 중」이 서고 성공하면 사라진다", async () => {
    const r = row({ status: "failed", failureReason: "missed", sendAtMs: NOW - HOUR, rev: 2 });
    server([r]);
    let finish!: (value: ScheduledMessage) => void;
    scheduledApi.sendScheduledMessageNow.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    const button = need("scheduled-row-sendNow");
    expect(button.getAttribute("aria-busy")).toBeNull();
    await press(button);
    expect(need("scheduled-row-sendNow").getAttribute("aria-busy")).toBe("true");
    expect(need("scheduled-row-sendNow").textContent).toBe("보내는 중");
    await act(async () => {
      finish({ ...r, status: "sent", rev: 3 });
    });
    await settle();
    expect(rows()).toHaveLength(0);
    expect(textOf("scheduled-status")).toBe("메시지를 보냈어요");
  });

  it("연결이 끊겨 결과를 모르면 행에 시간으로 사라지지 않는 오류 두 줄이 서고 행은 그대로다", async () => {
    const r = row();
    server([r]);
    scheduledApi.sendScheduledMessageNow.mockRejectedValue(new NetworkError("unreachable", 10_000));
    await mount();
    await chooseFromMenu(r.id, "sendNow");
    const error = inRow(r.id, "scheduled-row-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("보냈는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요.");
    expect(rows()).toHaveLength(1);
  });

  it("서버가 사유를 돌려주며 거절하면(409 not_member) 행이 보내지 못함으로 옮겨 가고 같은 말을 행에 한 번 더 쓰지 않는다", async () => {
    const r = row({ sendAtMs: NOW + 20_000 });
    server([r]);
    scheduledApi.sendScheduledMessageNow.mockImplementation(async () => {
      // 거절되며 행이 실패로 마감됐다: 이어지는 목록 읽기가 그 사실을 돌려준다.
      server([{ ...r, status: "failed", failureReason: "not_member", rev: 1, editableUntilMs: undefined }]);
      throw new ApiError(409, "not a member", "not_member");
    });
    await mount();
    await chooseFromMenu(r.id, "sendNow");
    await settle(4);
    expect(byId("scheduled-row-error")).toBeNull();
    expect(inRow(r.id, "scheduled-row-reason").textContent).toBe("이 채널에서 나가서 보내지 못했어요");
    expect(byId("scheduled-section-failed")).not.toBeNull();
    expect(byId("scheduled-section-pending")).toBeNull();
  });

  it("「내용 복사」가 실패하면 행 안에 이유와 다음 행동이 서고, 다음 복사가 성공하면 걷힌다 (design-review #4215 2회차 M5)", async () => {
    const r = row({ channelId: DEPLOY, body: "금요일 배포 공지", status: "failed", failureReason: "not_member", sendAtMs: NOW - HOUR, rev: 2 });
    server([r]);
    await mount();
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await press(need("scheduled-row-copy"));
    await settle(2);
    const error = inRow(r.id, "scheduled-row-copy-error");
    expect(error.getAttribute("role")).toBe("alert");
    // 단추 **아래**에 선다(위에 서면 방금 누른 단추가 밀려 포인터 밑에서 움직인다).
    expect(need("scheduled-row-copy").compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...error.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "복사하지 못했어요",
      "고치기에서 글을 열어 복사할 수 있어요",
    ]);
    // 말없는 무동작이 아니다: 단추는 「복사됨」으로 바뀌지 않았다.
    expect(need("scheduled-row-copy").textContent).toBe("내용 복사");
    await press(need("scheduled-row-copy"));
    await settle(2);
    expect(byId("scheduled-row-copy-error")).toBeNull();
    expect(need("scheduled-row-copy").textContent).toBe("복사됨");
  });

  it("메뉴의 「내용 복사」가 실패해도 같은 줄이 선다", async () => {
    const r = row({ channelId: DEPLOY, body: "금요일 배포 공지", status: "failed", failureReason: "not_member", sendAtMs: NOW - HOUR, rev: 2 });
    server([r]);
    await mount();
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await openRowMenu(r.id);
    await press(need("scheduled-row-menu-copy"));
    await settle(2);
    expect(inRow(r.id, "scheduled-row-copy-error").textContent).toBe("복사하지 못했어요고치기에서 글을 열어 복사할 수 있어요");
    // 메뉴는 열린 채 남고 항목은 「복사됨」이 되지 않는다.
    expect(need("scheduled-row-menu-copy").textContent).not.toContain("복사됨");
  });

  it("「내용 복사」: 본문을 복사하고 라벨이 「복사됨」으로 바뀐다", async () => {
    const r = row({ channelId: DEPLOY, body: "금요일 배포 공지", status: "failed", failureReason: "not_member", sendAtMs: NOW - HOUR, rev: 2 });
    server([r]);
    await mount();
    await press(need("scheduled-row-copy"));
    expect(writeText).toHaveBeenCalledWith("금요일 배포 공지");
    expect(need("scheduled-row-copy").textContent).toBe("복사됨");
  });
});

describe("지우기 (UI 명세 1.7)", () => {
  const two = () => [row({ body: "첫째", sendAtMs: TOMORROW_9 }), row({ body: "둘째", sendAtMs: TOMORROW_9 + 60_000 })];

  it("대화상자: 제목 · 본문 · 취소 · 지우기(파괴 채움). 취소하면 아무것도 지우지 않고 초점은 ⋯로 돌아간다", async () => {
    const list = two();
    server(list);
    await mount();
    await chooseFromMenu(list[0]!.id, "delete");
    const dialog = need("scheduled-delete-dialog");
    expect(dialog.textContent).toContain("예약을 지울까요?");
    expect(dialog.textContent).toContain("지우면 이 메시지는 보내지 않아요. 되돌릴 수 없어요.");
    expect(need("scheduled-delete-confirm").className).toContain("bg-danger-fill");
    await clickById("scheduled-delete-cancel");
    await settle(2);
    expect(byId("scheduled-delete-dialog")).toBeNull();
    expect(scheduledApi.deleteScheduledMessage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(inRow(list[0]!.id, "scheduled-row-menu"));
  });

  it("Esc로 닫아도 같다", async () => {
    const list = two();
    server(list);
    await mount();
    await chooseFromMenu(list[1]!.id, "delete");
    await keydown(need("scheduled-delete-dialog"), "Escape");
    await settle(2);
    expect(byId("scheduled-delete-dialog")).toBeNull();
    expect(document.activeElement).toBe(inRow(list[1]!.id, "scheduled-row-menu"));
  });

  it("지우면 행이 사라지고 초점은 다음 행의 첫 컨트롤로 간다(대화상자의 초점 반환이 가로채지 않는다)", async () => {
    const list = two();
    server(list);
    scheduledApi.deleteScheduledMessage.mockResolvedValue(undefined);
    await mount();
    await chooseFromMenu(list[0]!.id, "delete");
    await clickById("scheduled-delete-confirm");
    await settle(4);
    expect(scheduledApi.deleteScheduledMessage).toHaveBeenCalledWith(WS, list[0]!.id);
    expect(byId("scheduled-delete-dialog")).toBeNull();
    expect(rows().map((el) => el.getAttribute("data-row-id"))).toEqual([list[1]!.id]);
    expect(focusedRow()).toBe(list[1]!.id);
  });

  it("마지막 행을 지우면 초점은 목록 제목으로 간다", async () => {
    const [only] = two();
    server([only!]);
    scheduledApi.deleteScheduledMessage.mockResolvedValue(undefined);
    await mount();
    await chooseFromMenu(only!.id, "delete");
    await clickById("scheduled-delete-confirm");
    await settle(4);
    expect(document.activeElement).toBe(need("scheduled-heading"));
  });

  it("실패하면 대화상자가 열린 채 연산에 맞는 문장이 서고 다시 누를 수 있다", async () => {
    const list = two();
    server(list);
    scheduledApi.deleteScheduledMessage
      .mockRejectedValueOnce(new NetworkError("unreachable", 10_000))
      .mockResolvedValueOnce(undefined);
    await mount();
    await chooseFromMenu(list[0]!.id, "delete");
    await clickById("scheduled-delete-confirm");
    expect(need("scheduled-delete-dialog").textContent).toContain("지워졌는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요.");
    expect(rows()).toHaveLength(2);
    await clickById("scheduled-delete-confirm");
    await settle(3);
    expect(byId("scheduled-delete-dialog")).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("행이 이미 지워졌으면(404) 「예약을 찾을 수 없어요」", async () => {
    const list = two();
    server(list);
    scheduledApi.deleteScheduledMessage.mockRejectedValue(new ApiError(404, "gone"));
    await mount();
    await chooseFromMenu(list[0]!.id, "delete");
    await clickById("scheduled-delete-confirm");
    expect(need("scheduled-delete-dialog").textContent).toContain("예약을 찾을 수 없어요. 이미 지워졌을 수 있어요.");
  });

  it("대화상자가 열린 동안 연결이 끊기면 지우기가 흐려지고 안내가 선다", async () => {
    const list = two();
    server(list);
    await mount();
    await chooseFromMenu(list[0]!.id, "delete");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(need("scheduled-delete-dialog").textContent).toContain("연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.");
    expect((need("scheduled-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("고치기 (UI 명세 1.7: 글만 고치면 sendAtMs를 싣지 않는다)", () => {
  it("글만 고치면 body만 보낸다: sendAtMs 키가 없다", async () => {
    const r = row({ body: "처음 글" });
    server([r]);
    scheduledApi.updateScheduledMessage.mockImplementation(async (_ws: string, _id: string, patch: { body?: string }) => ({ ...r, body: patch.body ?? r.body, rev: 1 }));
    await mount();
    await chooseFromMenu(r.id, "edit");
    expect((need("scheduled-edit-body") as HTMLTextAreaElement).value).toBe("처음 글");
    expect(textOf("scheduled-edit-place")).toBe("#일반");
    await setValue("scheduled-edit-body", "고친 글");
    await clickById("scheduled-edit-commit");
    await settle(3);
    expect(scheduledApi.updateScheduledMessage).toHaveBeenCalledTimes(1);
    const [, rowId, patch] = scheduledApi.updateScheduledMessage.mock.calls[0]!;
    expect(rowId).toBe(r.id);
    expect(patch).toEqual({ body: "고친 글" });
    expect(Object.keys(patch)).not.toContain("sendAtMs");
    expect(byId("scheduled-edit-dialog")).toBeNull();
    expect(textOf("scheduled-row-preview")).toBe("고친 글");
    expect(document.activeElement).toBe(inRow(r.id, "scheduled-row-menu"));
  });

  it("시각을 고르는 자리는 칸을 건드리기 전에도 시간대를 적는다(명세 0.2), 결과 문장은 건드린 뒤에만 선다 (design-review #4215 N8)", async () => {
    const r = row({ sendAtMs: MONDAY_9 });
    server([r]);
    await mount();
    await chooseFromMenu(r.id, "edit");
    expect(textOf("scheduled-edit-zone")).toBe("Asia/Seoul (UTC+9) 기준이에요");
    expect(byId("scheduled-edit-result")).toBeNull();
    await setValue("scheduled-edit-date", "2026-10-27");
    expect(textOf("scheduled-edit-zone")).toBe("Asia/Seoul (UTC+9) 기준이에요");
    expect(textOf("scheduled-edit-result")).toBe("10월 27일 (화) 오전 9:00에 보내요");
  });

  it("고치기의 글 칸도 넘치면 스크롤 막대가 늘 보인다(오버레이 스크롤바는 스크롤해야 나타난다)", async () => {
    const r = row({ body: "긴 글\n".repeat(60) });
    server([r]);
    await mount();
    await chooseFromMenu(r.id, "edit");
    expect(need("scheduled-edit-body").className).toContain("scrollbar-visible");
  });

  it("첨부를 못 바꾼다는 말은 한 번만 있고 그 한 줄이 대화상자의 설명이다(숨은 설명과 보이는 줄을 둘 두지 않는다) (N8)", async () => {
    const r = row();
    server([r]);
    await mount();
    await chooseFromMenu(r.id, "edit");
    const dialog = need("scheduled-edit-dialog");
    const note = need("scheduled-edit-attach-note");
    expect(note.textContent).toBe("첨부는 바꿀 수 없어요. 바꾸려면 지우고 다시 예약해 주세요.");
    expect(dialog.getAttribute("aria-describedby")).toBe(note.id);
    expect((dialog.textContent ?? "").split("첨부는 바꿀 수 없어요").length - 1).toBe(1);
  });

  it("시각 칸을 건드리면 그때만 sendAtMs를 싣고, 시각만 바꾸면 body를 싣지 않는다", async () => {
    const r = row({ body: "처음 글" });
    server([r]);
    scheduledApi.updateScheduledMessage.mockImplementation(async (_ws: string, _id: string, patch: { sendAtMs?: number }) => ({ ...r, sendAtMs: patch.sendAtMs ?? r.sendAtMs, rev: 1 }));
    await mount();
    await chooseFromMenu(r.id, "edit");
    await setValue("scheduled-edit-date", "2026-10-24");
    await clickById("scheduled-edit-commit");
    await settle(3);
    const [, , patch] = scheduledApi.updateScheduledMessage.mock.calls[0]!;
    expect(patch).toEqual({ sendAtMs: new Date("2026-10-24T09:00:00+09:00").getTime() });
    expect(Object.keys(patch)).not.toContain("body");
  });

  it("아무것도 안 바꾸면 요청 없이 닫힌다", async () => {
    const r = row();
    server([r]);
    await mount();
    await chooseFromMenu(r.id, "edit");
    await clickById("scheduled-edit-commit");
    await settle(2);
    expect(scheduledApi.updateScheduledMessage).not.toHaveBeenCalled();
    expect(byId("scheduled-edit-dialog")).toBeNull();
  });

  it("글을 비우면(첨부도 없으면) 서버를 부르기 전에 말한다. 첨부가 있으면 비워도 된다", async () => {
    const plain = row({ body: "글" });
    const withFile = row({ body: "글", sendAtMs: TOMORROW_9 + 60_000, attachments: [{ id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 10 }] });
    server([plain, withFile]);
    scheduledApi.updateScheduledMessage.mockResolvedValue({ ...withFile, body: "", rev: 1 });
    await mount();
    await chooseFromMenu(plain.id, "edit");
    await setValue("scheduled-edit-body", "   ");
    await clickById("scheduled-edit-commit");
    expect(need("scheduled-edit-dialog").textContent).toContain("보낼 글이나 첨부를 넣어 주세요");
    expect(scheduledApi.updateScheduledMessage).not.toHaveBeenCalled();
    await clickById("scheduled-edit-cancel");
    await settle(2);

    await chooseFromMenu(withFile.id, "edit");
    expect(need("scheduled-edit-dialog").textContent).toContain("첨부는 바꿀 수 없어요");
    await setValue("scheduled-edit-body", "");
    await clickById("scheduled-edit-commit");
    await settle(2);
    expect(scheduledApi.updateScheduledMessage).toHaveBeenCalledWith(WS, withFile.id, { body: "" });
  });

  it("sessions_ended 행의 고치기에는 시각 칸이 없다(시각을 주면 행이 되살아나 내용 확인을 비켜 간다)", async () => {
    const r = row({ status: "failed", failureReason: "sessions_ended", sendAtMs: TOMORROW_9, rev: 2 });
    server([r]);
    scheduledApi.updateScheduledMessage.mockResolvedValue({ ...r, body: "고친 글", rev: 3 });
    await mount();
    await chooseFromMenu(r.id, "edit");
    expect(byId("scheduled-edit-date")).toBeNull();
    expect(byId("scheduled-edit-time")).toBeNull();
    await setValue("scheduled-edit-body", "고친 글");
    await clickById("scheduled-edit-commit");
    await settle(3);
    expect(scheduledApi.updateScheduledMessage).toHaveBeenCalledWith(WS, r.id, { body: "고친 글" });
    // 행은 여전히 내용 확인이 필요한 실패 행이다.
    expect(inRow(r.id, "scheduled-row-review").textContent).toBe("내용 확인");
  });

  it("마감 직전의 거절(409 scheduled_too_late)은 대화상자 안의 문장으로 선다", async () => {
    const r = row();
    server([r]);
    scheduledApi.updateScheduledMessage.mockRejectedValue(new ApiError(409, "late", "scheduled_too_late"));
    await mount();
    await chooseFromMenu(r.id, "edit");
    await setValue("scheduled-edit-body", "고친 글");
    await clickById("scheduled-edit-commit");
    expect(need("scheduled-edit-dialog").querySelector('[role="alert"]')?.textContent).toBe("곧 보내서 바꿀 수 없어요. 지금 보내거나 지울 수 있어요.");
    expect(byId("scheduled-edit-dialog")).not.toBeNull();
  });
});

describe("서버가 예약을 껐다(503 scheduler_disabled): 시간 바꾸기·다시 예약의 확인이 흐리다 (명세 0.5 ③)", () => {
  it("지금 보내기가 503으로 거절돼 서버가 껐다는 것을 알게 되면, 이어서 여는 시간 바꾸기 대화상자의 확인이 흐리고 이유와 다음 행동이 선다", async () => {
    const a = row({ body: "첫째" });
    const b = row({ body: "둘째", sendAtMs: MONDAY_9 });
    server([a, b]);
    scheduledApi.sendScheduledMessageNow.mockRejectedValue(new ApiError(503, "off", "scheduler_disabled"));
    await mount();
    await chooseFromMenu(a.id, "sendNow");
    await chooseFromMenu(b.id, "change");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
    expect([...need("schedule-dialog-error").querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "이 서버에서는 예약을 쓸 수 없어요",
      "관리자에게 물어보세요",
    ]);
    await clickById("schedule-dialog-commit");
    expect(scheduledApi.updateScheduledMessage).not.toHaveBeenCalled();
    // 취소로 닫을 수 있다.
    await clickById("schedule-dialog-cancel");
    await settle(2);
    expect(byId("schedule-dialog")).toBeNull();
  });

  it("서버가 끄지 않았으면 확인은 평소대로 눌린다", async () => {
    const r = row({ sendAtMs: MONDAY_9 });
    server([r]);
    scheduledApi.updateScheduledMessage.mockResolvedValue({ ...r, rev: 1 });
    await mount();
    await chooseFromMenu(r.id, "change");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(false);
    expect(byId("schedule-dialog-error")).toBeNull();
  });
});

describe("시간 바꾸기와 다시 예약", () => {
  it("시간 바꾸기: 그 행의 시각이 처음 값이고 sendAtMs만 보낸다", async () => {
    const r = row({ sendAtMs: MONDAY_9 });
    server([r]);
    scheduledApi.updateScheduledMessage.mockImplementation(async (_ws: string, _id: string, patch: { sendAtMs?: number }) => ({ ...r, sendAtMs: patch.sendAtMs!, editableUntilMs: patch.sendAtMs! - 30_000, rev: 1 }));
    await mount();
    await chooseFromMenu(r.id, "change");
    expect(textOf("schedule-dialog")).toContain("보낼 시각 바꾸기");
    expect((need("schedule-dialog-date") as HTMLInputElement).value).toBe("2026-10-26");
    expect((need("schedule-dialog-time") as HTMLInputElement).value).toBe("09:00");
    expect(textOf("schedule-dialog-place")).toBe("#일반");
    expect(need("schedule-dialog-commit").textContent).toBe("변경하기");
    await setValue("schedule-dialog-date", "2026-10-27");
    await clickById("schedule-dialog-commit");
    await settle(3);
    const [, rowId, patch] = scheduledApi.updateScheduledMessage.mock.calls[0]!;
    expect(rowId).toBe(r.id);
    expect(patch).toEqual({ sendAtMs: new Date("2026-10-27T09:00:00+09:00").getTime() });
    expect(byId("schedule-dialog")).toBeNull();
    expect(textOf("scheduled-row-when")).toBe("10월 27일 (화) 오전 9:00에 보내요");
    expect(document.activeElement).toBe(inRow(r.id, "scheduled-row-menu"));
  });

  it("시각이 이미 지난 행은 내일 오전 9:00이 처음 값이다", async () => {
    const r = row({ status: "failed", failureReason: "missed", sendAtMs: NOW - 3 * HOUR, rev: 2 });
    server([r]);
    await mount();
    await press(need("scheduled-row-rearm"));
    expect(textOf("schedule-dialog")).toContain("다시 예약하기");
    expect((need("schedule-dialog-date") as HTMLInputElement).value).toBe("2026-10-23");
    expect((need("schedule-dialog-time") as HTMLInputElement).value).toBe("09:00");
  });

  it("다시 예약이 성공하면 행이 보낼 예정으로 옮겨 가고 초점은 행이 사라질 때와 같은 규칙을 따른다", async () => {
    const failed = row({ status: "failed", failureReason: "missed", sendAtMs: NOW - 3 * HOUR, rev: 2, body: "실패한 글" });
    const pending = row({ sendAtMs: MONDAY_9, body: "대기 중인 글" });
    server([failed, pending]);
    scheduledApi.updateScheduledMessage.mockImplementation(async (_ws: string, _id: string, patch: { sendAtMs: number }) => ({
      ...failed, status: "pending", failureReason: undefined, sendAtMs: patch.sendAtMs, editableUntilMs: patch.sendAtMs - 30_000, rev: 3,
    }));
    await mount();
    await press(need("scheduled-row-rearm"));
    await clickById("schedule-dialog-commit");
    await settle(4);
    expect(scheduledApi.updateScheduledMessage).toHaveBeenCalledWith(WS, failed.id, { sendAtMs: TOMORROW_9 });
    expect(byId("scheduled-section-failed")).toBeNull();
    expect(rowTexts("scheduled-row-preview")).toEqual(["실패한 글", "대기 중인 글"]);
    // 행이 보내지 못함에서 사라졌으므로 다음 행의 첫 컨트롤이 초점을 받는다.
    expect(focusedRow()).toBe(pending.id);
  });

  it("시각 오류는 서버를 부르기 전에 대화상자 안에서 말한다", async () => {
    const r = row({ sendAtMs: MONDAY_9 });
    server([r]);
    await mount();
    await chooseFromMenu(r.id, "change");
    await setValue("schedule-dialog-date", "2026-10-22");
    await setValue("schedule-dialog-time", "14:30");
    await clickById("schedule-dialog-commit");
    expect(textOf("schedule-dialog-error")).toBe("1분 뒤부터 예약할 수 있어요");
    expect(scheduledApi.updateScheduledMessage).not.toHaveBeenCalled();
  });
});

const REVIEW_BODY = ["금요일 배포 공지 초안이에요.", "", "1. 배포 시간은 금요일 오후 4시예요.", "2. 롤백 계획은 Notion에 있어요.", "", "끝까지 읽은 뒤에 보내 주세요."].join("\n");

function ended(over: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return row({
    channelId: DEPLOY,
    body: REVIEW_BODY,
    status: "failed",
    failureReason: "sessions_ended",
    sendAtMs: TOMORROW_9,
    rev: 2,
    attachments: [
      { id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 10 },
      { id: "a2", name: "변경목록.csv", mime: "text/csv", sizeBytes: 10 },
    ],
    ...over,
  });
}

/** 대화상자 안의 눌러지는 것들을 문서 순서로(Tab 순서의 근사). */
function tabStops(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('button, [tabindex="0"]')]
    .filter((el) => !(el as HTMLButtonElement).disabled)
    .map((el) => el.getAttribute("aria-label") ?? (el.textContent ?? "").trim());
}

describe("내용 확인: sessions_ended 행은 본문 전체를 본 뒤에만 나간다 (ADR-0208 D14)", () => {
  it("행에는 「내용 확인」만 보이고 ⋯에도 지금 보내기·다시 예약이 없다", async () => {
    const r = ended();
    server([r]);
    await mount();
    const inline = [...rowById(r.id).querySelectorAll("button")].filter((b) => b.getAttribute("data-testid") !== "scheduled-row-menu").map((b) => b.textContent);
    expect(inline).toEqual(["내용 확인"]);
    await openRowMenu(r.id);
    expect(menuLabels()).toEqual(["내용 확인", "고치기", "내용 복사", "지우기"]);
    // 한 번 눌러 나가는 길이 없다: 이 화면 어디서도 서버의 보내기를 부르지 않았다.
    expect(scheduledApi.sendScheduledMessageNow).not.toHaveBeenCalled();
  });

  it("열리면 초점은 제목이고, 본문 전체·첨부 이름·채널·보내려던 시각이 보인다", async () => {
    const r = ended();
    server([r]);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    const dialog = need("scheduled-review-dialog");
    expect(document.activeElement?.textContent).toBe("내용을 확인해 주세요");
    expect(dialog.textContent).toContain("로그인이 끝나서 멈춘 예약이에요. 내가 쓴 글이 맞는지 확인한 뒤에 보내 주세요.");
    expect(textOf("scheduled-review-place")).toBe("#배포");
    const body = need("scheduled-review-body");
    expect(body.textContent).toBe(REVIEW_BODY);
    // 넘치는 본문은 막대가 **늘** 보여야 한다(오버레이 스크롤바는 스크롤을 시작해야 나타나서, 맨 아래 줄이 곧 글의 끝으로
    // 읽힌다). 이 상자는 「본문 전체를 보기 전에는 나가지 않는다」(D14)의 문이다(design-review #4215 H1). 실제 막대의 폭은
    // 진짜 브라우저 캡처(`capture-4215.mjs`의 s7 「긴 본문」: offsetWidth - clientWidth)가 잰다.
    expect(body.className).toContain("scrollbar-visible");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("max-h-pane");
    expect(body.getAttribute("role")).toBe("region");
    expect(body.getAttribute("aria-label")).toBe("예약한 메시지 본문");
    expect(body.getAttribute("tabindex")).toBe("0");
    expect(textOf("scheduled-review-attachments")).toBe("첨부 2개: 일정.pdf, 변경목록.csv");
    expect(textOf("scheduled-review-when")).toBe("내일 오전 9:00에 보내려던 예약이에요");
  });

  it("Tab 순서: 본문 스크롤 영역 → 닫기 → 지우기 → 다시 예약 → 지금 보내기", async () => {
    const r = ended();
    server([r]);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    expect(tabStops(need("scheduled-review-dialog"))).toEqual(["예약한 메시지 본문", "닫기", "지우기", "다시 예약", "지금 보내기"]);
  });

  it("지금 보내기는 이 대화상자 안에서만 서버를 부르고, 성공하면 닫히고 상태줄이 서며 초점 규칙을 따른다", async () => {
    const r = ended({ sendAtMs: NOW - HOUR });
    const next = row({ sendAtMs: TOMORROW_9, body: "다음 행" });
    server([r, next]);
    scheduledApi.sendScheduledMessageNow.mockResolvedValue({ ...r, status: "sent", rev: 3 });
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    expect(scheduledApi.sendScheduledMessageNow).not.toHaveBeenCalled();
    await clickById("scheduled-review-send-now");
    await settle(4);
    expect(scheduledApi.sendScheduledMessageNow).toHaveBeenCalledTimes(1);
    expect(scheduledApi.sendScheduledMessageNow).toHaveBeenCalledWith(WS, r.id);
    expect(byId("scheduled-review-dialog")).toBeNull();
    expect(textOf("scheduled-status")).toBe("메시지를 보냈어요");
    expect(rows().map((el) => el.getAttribute("data-row-id"))).toEqual([next.id]);
    expect(focusedRow()).toBe(next.id);
  });

  it("지금 보내기가 거절되면(409 not_member) 대화상자 안에 이유 줄이 서고 대화상자는 열려 있다", async () => {
    const r = ended();
    server([r]);
    scheduledApi.sendScheduledMessageNow.mockRejectedValue(new ApiError(409, "not a member", "not_member"));
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await clickById("scheduled-review-send-now");
    await settle(3);
    expect(byId("scheduled-review-dialog")).not.toBeNull();
    expect(need("scheduled-review-dialog").querySelector('[role="alert"]')?.textContent).toBe("이 채널에서 나가서 보내지 못했어요");
  });

  it("다시 예약은 이 대화상자를 닫고 「다시 예약하기」를 연다(겹치지 않는다). Esc로 닫으면 초점은 행의 「내용 확인」", async () => {
    const r = ended();
    server([r]);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await clickById("scheduled-review-rearm");
    await settle(3);
    expect(byId("scheduled-review-dialog")).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(textOf("schedule-dialog")).toContain("다시 예약하기");
    await keydown(need("schedule-dialog"), "Escape");
    await settle(3);
    expect(byId("schedule-dialog")).toBeNull();
    expect(document.activeElement).toBe(inRow(r.id, "scheduled-row-review"));
  });

  it("다시 예약을 걸면 서버에는 sendAtMs만 간다(본문 확인은 이미 했다)", async () => {
    const r = ended({ sendAtMs: NOW - HOUR });
    server([r]);
    scheduledApi.updateScheduledMessage.mockImplementation(async (_ws: string, _id: string, patch: { sendAtMs: number }) => ({ ...r, status: "pending", failureReason: undefined, sendAtMs: patch.sendAtMs, editableUntilMs: patch.sendAtMs - 30_000, rev: 3 }));
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await clickById("scheduled-review-rearm");
    await settle(3);
    await clickById("schedule-dialog-commit");
    await settle(4);
    expect(scheduledApi.updateScheduledMessage).toHaveBeenCalledWith(WS, r.id, { sendAtMs: TOMORROW_9 });
    expect(byId("scheduled-section-failed")).toBeNull();
  });

  it("지우기: 푸터만 확인 줄로 바뀌고(초점은 「취소」), Esc는 확인만 취소하고 한 번 더 누르면 닫힌다", async () => {
    const r = ended();
    server([r]);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await clickById("scheduled-review-delete");
    await settle(2);
    const confirm = need("scheduled-review-confirm");
    expect(confirm.getAttribute("role")).toBe("group");
    expect(document.getElementById(confirm.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("예약을 지울까요?");
    expect(confirm.textContent).toContain("지우면 이 메시지는 보내지 않아요. 되돌릴 수 없어요.");
    expect(document.activeElement).toBe(need("scheduled-review-confirm-cancel"));
    // 본문은 그대로 보인다(대화상자는 겹치지 않는다).
    expect(byId("scheduled-review-body")).not.toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    await keydown(need("scheduled-review-dialog"), "Escape");
    await settle(2);
    expect(byId("scheduled-review-confirm")).toBeNull();
    expect(byId("scheduled-review-dialog")).not.toBeNull();
    expect(document.activeElement).toBe(need("scheduled-review-delete"));
    await keydown(need("scheduled-review-dialog"), "Escape");
    await settle(3);
    expect(byId("scheduled-review-dialog")).toBeNull();
    expect(document.activeElement).toBe(inRow(r.id, "scheduled-row-review"));
    expect(scheduledApi.deleteScheduledMessage).not.toHaveBeenCalled();
  });

  it("지우기 확인에서 「지우기」를 누르면 행이 사라지고 초점 규칙을 따른다", async () => {
    const r = ended();
    const other = ended({ sendAtMs: TOMORROW_9 + 60_000, body: "다른 행" });
    server([r, other]);
    scheduledApi.deleteScheduledMessage.mockResolvedValue(undefined);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await clickById("scheduled-review-delete");
    await clickById("scheduled-review-confirm-delete");
    await settle(4);
    expect(scheduledApi.deleteScheduledMessage).toHaveBeenCalledWith(WS, r.id);
    expect(byId("scheduled-review-dialog")).toBeNull();
    expect(focusedRow()).toBe(other.id);
  });

  it("「닫기」와 Esc는 같다: 아무것도 보내거나 지우지 않는다", async () => {
    const r = ended();
    server([r]);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await clickById("scheduled-review-close");
    await settle(3);
    expect(byId("scheduled-review-dialog")).toBeNull();
    expect(document.activeElement).toBe(inRow(r.id, "scheduled-row-review"));
    expect(scheduledApi.sendScheduledMessageNow).not.toHaveBeenCalled();
    expect(scheduledApi.deleteScheduledMessage).not.toHaveBeenCalled();
  });

  it("오프라인이면 보내기·다시 예약·지우기가 흐려지고 안내가 선다", async () => {
    const r = ended();
    server([r]);
    await mount();
    await press(inRow(r.id, "scheduled-row-review"));
    await settle(2);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(need("scheduled-review-dialog").textContent).toContain("연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.");
    expect((need("scheduled-review-send-now") as HTMLButtonElement).disabled).toBe(true);
    expect((need("scheduled-review-rearm") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("이벤트: sessions_ended로 멈춘 예약이 멈춘 즉시 보인다 (owner 결정 6)", () => {
  it("대기 행이 이벤트 도착 즉시(재조회를 기다리지 않고) 「보내지 못함」 구획으로 옮겨 가 사유 줄을 보인다", async () => {
    const r = row({ id: id(1), sendAtMs: TOMORROW_9 });
    server([r]);
    const rt = fakeRealtime();
    await mount("/scheduled", rt.handle);
    expect(byId("scheduled-section-failed")).toBeNull();
    expect(rt.handlers).toHaveLength(1);
    const callsBefore = scheduledApi.listAllScheduledMessages.mock.calls.length;
    await act(async () => {
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: r.id.toUpperCase(), rev: 1 }));
    });
    await settle();
    // 서버를 다시 부르지 않고도 바뀐다.
    expect(scheduledApi.listAllScheduledMessages.mock.calls.length).toBe(callsBefore);
    expect(byId("scheduled-section-pending")).toBeNull();
    expect(inRow(r.id, "scheduled-row-reason").textContent).toBe("로그인이 끝나서 예약을 멈췄어요");
    expect(inRow(r.id, "scheduled-row-next").textContent).toBe("내용을 확인하고 보내거나 다시 예약해 주세요");
    expect(inRow(r.id, "scheduled-row-review").textContent).toBe("내용 확인");
    // 본문은 이벤트에 없다: 아는 행은 본문을 그대로 쥔다.
    expect(textOf("scheduled-row-preview")).toBe("내일 회의 전에 자료 올려 둘게요");
  });

  it("알려진 rev보다 낮거나 같은 이벤트는 무시한다", async () => {
    const r = row({ id: id(1), sendAtMs: TOMORROW_9, rev: 5 });
    server([r]);
    const rt = fakeRealtime();
    await mount("/scheduled", rt.handle);
    await act(async () => {
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: r.id.toUpperCase(), rev: 5 }));
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: r.id.toUpperCase(), rev: 3 }));
    });
    await settle();
    expect(byId("scheduled-section-failed")).toBeNull();
    expect(rowById(r.id).getAttribute("data-status")).toBe("pending");
  });

  it("모르는 행은 본문 자리가 막대인 뼈대 행으로 서고, 뒤따르는 읽기가 본문을 채운다. 그동안 내용 확인의 보내기·다시 예약은 흐리다", async () => {
    server([]);
    const rt = fakeRealtime();
    await mount("/scheduled", rt.handle);
    expect(byId("scheduled-empty")).not.toBeNull();
    const full = ended({ id: id(9) });
    // 이벤트가 먼저 오고, 그 뒤의 읽기가 본문을 가져온다.
    server([full]);
    await act(async () => {
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: full.id.toUpperCase(), channelId: DEPLOY.toUpperCase(), rev: 2 }));
    });
    await settle();
    expect(byId("scheduled-empty")).toBeNull();
    expect(byId("scheduled-row-stub")).not.toBeNull();
    // 본문 자리는 낭독에서 빠진 중성 막대다(`Skeleton`을 못 쓰는 이유는 `ScheduledRow`의 주석).
    expect(need("scheduled-row-stub").getAttribute("aria-hidden")).toBe("true");
    expect(need("scheduled-row-stub").className).toContain("bg-surface-hover");
    expect(textOf("scheduled-row-reason")).toBe("로그인이 끝나서 예약을 멈췄어요");
    await press(inRow(full.id, "scheduled-row-review"));
    await settle(2);
    expect((need("scheduled-review-send-now") as HTMLButtonElement).disabled).toBe(true);
    expect((need("scheduled-review-rearm") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("scheduled-review-body")).toBeNull();

    // 재조회(이벤트를 모으는 250ms 뒤)가 끝나면 본문이 채워지고 두 단추가 선다.
    await until(() => byId("scheduled-review-body") !== null, "내용 확인의 본문");
    expect(byId("scheduled-review-body")?.textContent).toBe(REVIEW_BODY);
    expect((need("scheduled-review-send-now") as HTMLButtonElement).disabled).toBe(false);
    expect((need("scheduled-review-rearm") as HTMLButtonElement).disabled).toBe(false);
  });

  it("보낸 행(sent)의 이벤트는 목록에서 행을 지운다", async () => {
    const r = row({ id: id(1) });
    server([r]);
    const rt = fakeRealtime();
    await mount("/scheduled", rt.handle);
    await act(async () => {
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: r.id.toUpperCase(), status: "sent", failureReason: undefined, rev: 1, sentMessageId: "M1" }));
    });
    await settle();
    expect(rows()).toHaveLength(0);
  });
});

// ---- 행의 우클릭 메뉴 (명세 1.1: 「행 끝 ⋯ 오버플로 + 컨텍스트 메뉴」) ----------------------------------------

async function rightClick(rowId: string) {
  await act(async () => {
    rowById(rowId).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40, button: 2 })
    );
  });
  await settle(2);
}

const contextLabels = (): string[] =>
  [...document.querySelectorAll('[data-testid="scheduled-row-context-panel"] [role="menuitem"]')].map((el) =>
    (el.firstElementChild?.textContent ?? el.textContent ?? "").trim()
  );

describe("행의 우클릭 메뉴: ⋯와 같은 동작을 포인터의 문으로도 연다", () => {
  it("우클릭하면 ⋯ 메뉴와 같은 항목이 같은 순서로 열리고 이름은 ⋯와 같다", async () => {
    const r = row();
    server([r]);
    await mount();
    await rightClick(r.id);
    expect(contextLabels()).toEqual(["지금 보내기", "시간 바꾸기", "고치기", "지우기"]);
    expect(need("scheduled-row-context-panel").getAttribute("aria-label")).toBe(inRow(r.id, "scheduled-row-menu").getAttribute("aria-label"));
    expect(need("scheduled-row-context-delete").className).toContain("text-danger");
    await keydown(need("scheduled-row-context-panel"), "Escape");
    await settle(2);
    expect(byId("scheduled-row-context-panel")).toBeNull();
    await openRowMenu(r.id);
    expect(menuLabels()).toEqual(["지금 보내기", "시간 바꾸기", "고치기", "지우기"]);
  });

  it("보내지 못함 행: 되살릴 수 있는 사유(missed)도 아닌 사유(not_member)도 메뉴에는 전체 동작이 있다(상시 버튼만 다르다)", async () => {
    const missed = row({ status: "failed", failureReason: "missed", sendAtMs: NOW - HOUR, rev: 2 });
    const left = row({ status: "failed", failureReason: "not_member", sendAtMs: NOW - 2 * HOUR, rev: 2 });
    server([missed, left]);
    await mount();
    await rightClick(missed.id);
    expect(contextLabels()).toEqual(["지금 보내기", "다시 예약", "고치기", "내용 복사", "지우기"]);
    await keydown(need("scheduled-row-context-panel"), "Escape");
    await settle(2);
    await rightClick(left.id);
    expect(contextLabels()).toEqual(["지금 보내기", "다시 예약", "고치기", "내용 복사", "지우기"]);
  });

  it("sessions_ended 행의 우클릭에도 지금 보내기·다시 예약이 없다: 내용 확인 하나가 문이다", async () => {
    const r = ended();
    server([r]);
    await mount();
    await rightClick(r.id);
    expect(contextLabels()).toEqual(["내용 확인", "고치기", "내용 복사", "지우기"]);
    await press(need("scheduled-row-context-review"));
    await settle(3);
    expect(byId("scheduled-review-dialog")).not.toBeNull();
    expect(scheduledApi.sendScheduledMessageNow).not.toHaveBeenCalled();
  });

  it("마감 30초 안의 행: 시간 바꾸기·고치기는 이유와 함께 흐리고 눌러도 열리지 않으며 메뉴는 열린 채 남는다", async () => {
    const r = row({ sendAtMs: NOW + 20_000 });
    server([r]);
    await mount();
    await rightClick(r.id);
    for (const action of ["change", "edit"]) {
      const item = need(`scheduled-row-context-${action}`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain("곧 보내서 바꿀 수 없어요");
    }
    await press(need("scheduled-row-context-edit"));
    expect(byId("scheduled-edit-dialog")).toBeNull();
    expect(byId("scheduled-row-context-panel")).not.toBeNull();
  });

  it("오프라인이면 모든 항목이 흐리고 눌러도 아무것도 부르지 않는다", async () => {
    const r = row();
    server([r]);
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await rightClick(r.id);
    const items = [...document.querySelectorAll('[data-testid="scheduled-row-context-panel"] [role="menuitem"]')];
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.getAttribute("aria-disabled") === "true")).toBe(true);
    await press(need("scheduled-row-context-sendNow"));
    expect(scheduledApi.sendScheduledMessageNow).not.toHaveBeenCalled();
  });

  it("지우기: 대화상자가 열리고, 취소하면 초점이 그 행의 ⋯로 돌아간다", async () => {
    const r = row();
    server([r]);
    await mount();
    await rightClick(r.id);
    await press(need("scheduled-row-context-delete"));
    await settle(3);
    expect(byId("scheduled-delete-dialog")).not.toBeNull();
    await clickById("scheduled-delete-cancel");
    await settle(3);
    expect(byId("scheduled-delete-dialog")).toBeNull();
    expect(document.activeElement).toBe(inRow(r.id, "scheduled-row-menu"));
    expect(scheduledApi.deleteScheduledMessage).not.toHaveBeenCalled();
  });

  it("지금 보내기: 한 번에 가고 행이 사라지며 초점 규칙을 따른다", async () => {
    const first = row({ body: "첫째" });
    const second = row({ body: "둘째", sendAtMs: TOMORROW_9 + 60_000 });
    server([first, second]);
    scheduledApi.sendScheduledMessageNow.mockResolvedValue({ ...first, status: "sent", rev: 1 });
    await mount();
    await rightClick(first.id);
    await press(need("scheduled-row-context-sendNow"));
    await settle(4);
    expect(scheduledApi.sendScheduledMessageNow).toHaveBeenCalledWith(WS, first.id);
    expect(rows().map((el) => el.getAttribute("data-row-id"))).toEqual([second.id]);
    expect(textOf("scheduled-status")).toBe("메시지를 보냈어요");
    expect(focusedRow()).toBe(second.id);
  });

  it("내용 복사: 메뉴를 열어 둔 채 항목이 「복사됨」으로 바뀐다", async () => {
    const r = row({ status: "failed", failureReason: "not_member", body: "복사할 글", sendAtMs: NOW - HOUR, rev: 2 });
    server([r]);
    await mount();
    await rightClick(r.id);
    await press(need("scheduled-row-context-copy"));
    expect(writeText).toHaveBeenCalledWith("복사할 글");
    expect(need("scheduled-row-context-copy").textContent).toContain("복사됨");
    expect(byId("scheduled-row-context-panel")).not.toBeNull();
  });

  it("터치(hover: none)에서는 우클릭 문을 닫는다: 목록을 끌려는 손가락이 길게 눌러 메뉴를 열지 않는다", async () => {
    const r = row();
    server([r]);
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("hover: none"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      await mount();
      await rightClick(r.id);
      expect(byId("scheduled-row-context-panel")).toBeNull();
      // ⋯의 문은 그대로 열려 있다.
      await openRowMenu(r.id);
      expect(menuLabels()).toEqual(["지금 보내기", "시간 바꾸기", "고치기", "지우기"]);
    } finally {
      window.matchMedia = original;
    }
  });
});

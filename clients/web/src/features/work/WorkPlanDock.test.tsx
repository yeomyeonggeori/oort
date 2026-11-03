// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, WorkSession } from "@momo/core/lib/api";
import type { WorkSessionACPFrame, WorkSessionLifecycleFrame } from "@momo/core/lib/realtimeEvents";
import { workPlanProgress } from "@momo/core/features/work/workPlan";
import type { WorkPlanItem } from "@momo/core/features/work/workSessionModel";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import type { RealtimeHandle } from "@/lib/realtime";
import { closeWorkPanel, openWorkPanel, workPanelSnapshot } from "@/features/agents/workLogStore";
import { WorkPlanDock, WorkPlanDockView } from "./WorkPlanDock";

const api = vi.hoisted(() => ({ fetchWorkSessions: vi.fn(), fetchThreadReplies: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchWorkSessions: api.fetchWorkSessions,
    fetchThreadReplies: api.fetchThreadReplies,
  };
});
// 작업 표면 판정(호스트 존재)은 이 시험의 관심사가 아니다: 판정이 참인 서버를 가정한다.
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({
  useSurfaceProvidedWhileOpen: () => true,
}));

// =============================================================================
// 대화 머리 계획 독 (#4578). 합계·대상 고르기·문장은 코어가 가진다(`workPlan.test.ts`). 여기서 지키는 것은
// 그것이 **화면에 그대로 서는가**다: 계획이 있을 때만 서는가, 「2 of 4」·지금 단계·완료 체크가 읽히는가, 계획 글이
// 마크업이 되지 않는가, 키보드로 열고 닫히는가, 라이브 프레임이 합계를 움직이고 끊김 뒤에는 낡은 꼬리를 버리는가.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const OTHER_CH = "00000000-0000-7000-8000-000000000202";
const SESSION_ID = "019F9A34-5405-7FDA-9FB2-C6806F69D8A6";
const ROOT_ID = "019F9A34-5406-77A9-AB33-B011D56B91F8";
const T = 1_800_000_000_000;

const PLAN_2_OF_4: WorkPlanItem[] = [
  { content: "코어 모델 읽기", status: "completed" },
  { content: "독 만들기", status: "completed" },
  { content: "시험 쓰기", status: "in_progress" },
  { content: "캡처 장면 적기", status: "pending" },
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let korean: AppLocale;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  api.fetchWorkSessions.mockReset();
  api.fetchThreadReplies.mockReset();
  closeWorkPanel();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  closeWorkPanel();
});

const q = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

function mount(element: ReactElement): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(LocaleProvider, { locale: korean, children: element }));
  });
}

// ---- 화면(순수): 데이터 없이 마크업만 -----------------------------------------------------

function view(over: Partial<Parameters<typeof WorkPlanDockView>[0]> = {}) {
  const progress = workPlanProgress(PLAN_2_OF_4, true);
  if (progress === null) throw new Error("fixture");
  return createElement(WorkPlanDockView, {
    progress,
    options: [{ id: "s1", label: "독 시안 정리 · 실행 중" }],
    selectedId: "s1",
    maybeStale: false,
    onSelect: () => undefined,
    onOpenAll: () => undefined,
    ...over,
  });
}

describe("독의 마크업", () => {
  it("단추는 「4단계 중 2단계」와 남은 수를 말하고, 누르면 지금 단계가 선 계획이 열린다", () => {
    mount(
      view({
        progress:
          workPlanProgress(
            [...PLAN_2_OF_4, { content: "<img src=x onerror=alert(1)>", status: "pending" }],
            true
          ) ?? undefined,
      })
    );
    const dock = q("work-plan-dock");
    // 이름과 툴팁이 같은 글이고 네이티브 title은 없다(머리 단추 규칙, #4591).
    expect(dock?.getAttribute("aria-label")).toBe("계획 5단계 중 2단계 완료");
    expect(dock?.hasAttribute("title")).toBe(false);
    expect(q("work-plan-remaining")?.textContent).toBe("3");
    expect(q("work-plan-popover")).toBeNull();

    act(() => dock?.click());
    expect(q("work-plan-title")?.textContent).toBe("계획 · 5단계 중 2단계 완료");
    // 열리면 보조기술이 제목을 읽는다: 대화상자의 이름이 제목이다.
    expect(q("work-plan-title")?.id).not.toBe("");
    expect(q("work-plan-popover")?.getAttribute("aria-labelledby")).toBe(q("work-plan-title")?.id);
    const steps = qa("work-plan-step");
    expect(steps.map((step) => step.getAttribute("data-step"))).toEqual([
      "done",
      "done",
      "current",
      "pending",
      "pending",
    ]);
    // 색에만 기대지 않는다: 단계마다 낱말이 읽힌다.
    expect(steps.map((step) => step.querySelector(".sr-only")?.textContent)).toEqual([
      "완료",
      "완료",
      "지금 단계",
      "대기",
      "대기",
    ]);
    // 계획 글은 마크업이 아니라 글자다.
    expect(steps[4]?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(steps[4]?.querySelector("img")).toBeNull();
    // 돌고 있는 세션이라 한정 문장이 없다.
    expect(q("work-plan-note")).toBeNull();
  });

  it("다 끝나면 숫자 대신 체크이고 제목이 「모두 마쳤어요」다", () => {
    const finished = workPlanProgress(
      PLAN_2_OF_4.map((item) => ({ ...item, status: "completed" as const })),
      false
    );
    if (finished === null) throw new Error("fixture");
    mount(view({ progress: finished }));
    const dock = q("work-plan-dock");
    expect(dock?.getAttribute("aria-label")).toBe("계획 4단계 모두 완료");
    expect(q("work-plan-remaining")).toBeNull();
    expect(dock?.getAttribute("data-remaining")).toBe("0");
    act(() => dock?.click());
    expect(q("work-plan-title")?.textContent).toBe("계획 · 모두 마쳤어요");
    expect(qa("work-plan-step").every((step) => step.getAttribute("data-step") === "done")).toBe(true);
  });

  it("남은 수는 옆 단추(멤버 수)와 같은 맨 숫자다: 채운 원 배지가 아니다 (#5174 L4)", () => {
    mount(view());
    const count = q("work-plan-remaining");
    expect(count?.textContent).toBe("2");
    expect(count?.hasAttribute("data-numeric")).toBe(true);
    // 그릇(둥근 면·안쪽 여백·글자 크기)을 만드는 클래스가 하나도 없다: 숫자는 단추의 글자 문법을 그대로 따른다.
    expect(count?.getAttribute("class")).toBeNull();
  });

  it("단계 목록은 초점을 받고 이름이 있다: 계획 50개도 방향키·PageDown으로 읽는다 (#5166)", () => {
    const long: WorkPlanItem[] = Array.from({ length: 50 }, (_, index) => ({
      content: `단계 ${index + 1}`,
      status: index < 10 ? "completed" : "pending",
    }));
    mount(view({ progress: workPlanProgress(long, true) ?? undefined }));
    act(() => q("work-plan-dock")?.click());
    const list = q("work-plan-steps");
    expect(qa("work-plan-step")).toHaveLength(50);
    // 초점을 받을 수 있고(tab 순서에 든다), 이름은 머리 제목이다.
    expect(list?.tabIndex).toBe(0);
    expect(list?.getAttribute("aria-labelledby")).toBe(q("work-plan-title")?.id);
    expect(list?.className).toContain("focus-visible:focus-ring");
    act(() => list?.focus());
    expect(document.activeElement).toBe(list);
  });

  it("다른 세션의 계획을 읽는 중이면 목록이 읽는 중임을 알리고 그 사실을 한 줄로 말한다 (#5166)", () => {
    mount(view({ switching: true }));
    act(() => q("work-plan-dock")?.click());
    expect(q("work-plan-steps")?.getAttribute("aria-busy")).toBe("true");
    expect(qa("work-plan-note").map((note) => note.textContent)).toEqual([
      "고른 세션의 계획을 불러오는 중이에요. 아래는 마지막으로 읽은 계획이에요.",
    ]);
    act(() => root?.unmount());
    root = null;
    host?.remove();
    mount(view());
    act(() => q("work-plan-dock")?.click());
    expect(q("work-plan-steps")?.hasAttribute("aria-busy")).toBe(false);
    expect(q("work-plan-note")).toBeNull();
  });

  it("세션이 여럿이면 팝오버 머리에서 고르고, 「모두 보기」는 기존 화면을 열며 팝오버를 닫는다", () => {
    const picked: string[] = [];
    let opened = 0;
    mount(
      view({
        options: [
          { id: "s1", label: "독 시안 정리 · 실행 중" },
          { id: "s2", label: "캡처 하네스 · 종료됨" },
        ],
        onSelect: (id) => picked.push(id),
        onOpenAll: () => (opened += 1),
      })
    );
    act(() => q("work-plan-dock")?.click());
    const select = q("work-plan-session-select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
      "독 시안 정리 · 실행 중",
      "캡처 하네스 · 종료됨",
    ]);
    act(() => {
      if (select === null) return;
      select.value = "s2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picked).toEqual(["s2"]);

    act(() => q("work-plan-open-all")?.click());
    expect(opened).toBe(1);
    expect(q("work-plan-popover")).toBeNull();
  });

  it("세션이 하나면 고르는 칸이 없고, 키보드로 열고 Esc로 닫으면 캐럿이 단추로 돌아온다", async () => {
    mount(view());
    const dock = q("work-plan-dock") as HTMLButtonElement;
    act(() => dock.focus());
    // 단추를 키보드로 활성화하면 브라우저가 click을 낸다.
    act(() => dock.click());
    expect(dock.getAttribute("aria-expanded")).toBe("true");
    expect(q("work-plan-session-select")).toBeNull();
    // 단추를 키보드로 닿을 수 있다: 탭 순서에서 빠지지 않는다.
    expect(dock.tabIndex).toBe(0);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q("work-plan-popover")).toBeNull();
    expect(dock.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(dock);
  });
});

// ---- 데이터까지: 서는 때·라이브·끊김 -------------------------------------------------------

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: SESSION_ID,
    workspaceId: WS,
    channelId: CH,
    memberId: ME,
    hostId: "019F9A34-53F2-793D-9CA7-5D5480407C9E",
    rootMessageId: ROOT_ID,
    tool: "claude",
    label: "독 시안 정리",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: T,
    ...over,
  };
}

/** 세션 스레드의 `agent.status` 한 줄(서버가 쓰는 모양). */
function statusRow(seq: number, plan: WorkPlanItem[] | undefined): Message {
  return {
    id: `0199aa11-2222-7000-8000-00000000${String(seq).padStart(4, "0")}`,
    seq,
    hlcTs: T + seq,
    type: "text",
    props: {
      kind: "work_session_event",
      schema: "momo.work_session.acp_event.v1",
      event_type: "agent.status",
      event_id: `0199aa11-3333-7000-8000-00000000${String(seq).padStart(4, "0")}`,
      event_ts: T + seq,
      event: {
        work_session_id: SESSION_ID,
        ...(plan === undefined ? { detail: "도구를 썼어요" } : { plan }),
      },
    },
  } as unknown as Message;
}

function liveFrame(seq: number, type: WorkSessionACPFrame["type"], extra: Record<string, unknown>) {
  return {
    type,
    v: 1,
    ts: T + 10_000 + seq,
    seq,
    payload: {
      work_session_id: SESSION_ID,
      run_id: "0199aa11-2222-7000-8000-0000000000b1",
      channel_id: CH,
      event_id: `0199aa11-4444-7000-8000-00000000${String(seq).padStart(4, "0")}`,
      message_id: `0199aa11-5555-7000-8000-00000000${String(seq).padStart(4, "0")}`,
      root_message_id: ROOT_ID,
      ...extra,
    },
  } as WorkSessionACPFrame;
}

type Handlers = Parameters<RealtimeHandle["subscribeWorkSession"]>[2];

function sessionValue(realtime: RealtimeHandle | null): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as SessionContextValue;
}

/** 독을 진짜 훅·진짜 쿼리 캐시로 올린다. 라이브 핸들러는 가짜 realtime이 붙잡아 둔다. */
function mountDock(onOpenSession: (id: string) => void = () => undefined) {
  let handlers: Handlers | null = null;
  const unsubscribe = vi.fn();
  const realtime = {
    subscribeWorkSession: vi.fn((_ws: string, _channel: string, h: Handlers) => {
      handlers = h;
      return unsubscribe;
    }),
  } as unknown as RealtimeHandle;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        SessionProvider,
        { value: sessionValue(realtime) },
        createElement(WorkPlanDock, { workspaceId: WS, channelId: CH, onOpenSession })
      )
    )
  );
  return {
    handlers: () => {
      if (handlers === null) throw new Error("작업 프레임 구독이 아직 없다");
      return handlers;
    },
    unsubscribe,
  };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (check()) return;
  }
  throw new Error(`기다린 조건이 서지 않았다: ${label}`);
}

describe("독이 서는 때", () => {
  it("이 채널의 세션에 계획이 있을 때만 선다: 세션 없음·남의 채널·계획 없음에는 자리도 없다", async () => {
    // (가) 세션이 없다.
    api.fetchWorkSessions.mockResolvedValue([]);
    mountDock();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(q("work-plan-dock")).toBeNull();
    expect(api.fetchThreadReplies).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;
    host?.remove();

    // (나) 계획이 있어도 남의 채널의 세션이다: 이 채널에는 대상이 없다.
    api.fetchWorkSessions.mockResolvedValue([session({ channelId: OTHER_CH })]);
    api.fetchThreadReplies.mockResolvedValue({ messages: [statusRow(1, PLAN_2_OF_4)] });
    mountDock();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(q("work-plan-dock")).toBeNull();
    expect(api.fetchThreadReplies).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;
    host?.remove();

    // (다) 이 채널의 세션이지만 계획을 한 번도 알리지 않았다: 「계획 없음」 자리표시도 없다.
    api.fetchWorkSessions.mockResolvedValue([session()]);
    api.fetchThreadReplies.mockResolvedValue({ messages: [statusRow(1, undefined)] });
    mountDock();
    await until(() => api.fetchThreadReplies.mock.calls.length > 0, "스레드 읽기");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(q("work-plan-dock")).toBeNull();
    act(() => root?.unmount());
    root = null;
    host?.remove();

    // (라) 계획이 있으면 선다.
    api.fetchThreadReplies.mockResolvedValue({ messages: [statusRow(1, undefined), statusRow(2, PLAN_2_OF_4)] });
    mountDock();
    await until(() => q("work-plan-dock") !== null, "독");
    expect(q("work-plan-dock")?.getAttribute("aria-label")).toBe("계획 4단계 중 2단계 완료");
    expect(q("work-plan-remaining")?.textContent).toBe("2");
  });

  it("라이브 계획 프레임이 합계를 움직이고, 글 조각은 건드리지 않고, 끊긴 뒤에는 낡은 꼬리를 버린다", async () => {
    api.fetchWorkSessions.mockResolvedValue([session()]);
    api.fetchThreadReplies.mockResolvedValue({ messages: [statusRow(1, PLAN_2_OF_4)] });
    const dock = mountDock();
    await until(() => q("work-plan-dock") !== null, "독");
    expect(q("work-plan-remaining")?.textContent).toBe("2");
    const reads = api.fetchThreadReplies.mock.calls.length;

    // 글 조각(`agent.partial`)은 계획이 아니다: 합계도 읽기도 움직이지 않는다.
    act(() => dock.handlers().onAcpEvent(liveFrame(5, "agent.partial", { text_delta: "읽는 중" })));
    expect(q("work-plan-remaining")?.textContent).toBe("2");

    // 계획을 실은 프레임은 다시 읽지 않고 곧바로 합계를 바꾼다.
    const advanced = PLAN_2_OF_4.map((item, index) =>
      index === 2 ? { ...item, status: "completed" as const } : item
    );
    act(() => dock.handlers().onAcpEvent(liveFrame(6, "agent.status", { plan: advanced })));
    expect(q("work-plan-remaining")?.textContent).toBe("1");
    expect(q("work-plan-dock")?.getAttribute("aria-label")).toBe("계획 4단계 중 3단계 완료");
    expect(api.fetchThreadReplies.mock.calls.length).toBe(reads);

    // 끊겼다 이어지면 꼬리를 버리고 Postgres를 다시 읽는다: 낡은 꼬리가 새 읽기 위에 남지 않는다.
    act(() => dock.handlers().onResync());
    await until(() => api.fetchThreadReplies.mock.calls.length > reads, "다시 읽기");
    await until(() => q("work-plan-remaining")?.textContent === "2", "읽은 값으로 복귀");

    // 세션이 끝나면 꼬리를 버리고 스레드와 세션 목록을 다시 읽는다: 마지막 계획은 읽은 값이 확정한다.
    act(() => dock.handlers().onAcpEvent(liveFrame(7, "agent.status", { plan: advanced })));
    await until(() => q("work-plan-remaining")?.textContent === "1", "꼬리가 다시 쌓임");
    const threadReads = api.fetchThreadReplies.mock.calls.length;
    const listReads = api.fetchWorkSessions.mock.calls.length;
    const ended = {
      type: "work.session.ended",
      v: 1,
      ts: T + 20_000,
      seq: 8,
      payload: { session_id: SESSION_ID, channel_id: CH },
    } as unknown as WorkSessionLifecycleFrame;
    act(() => dock.handlers().onLifecycle(ended));
    await until(
      () =>
        api.fetchThreadReplies.mock.calls.length > threadReads &&
        api.fetchWorkSessions.mock.calls.length > listReads,
      "스레드·세션 목록 다시 읽기"
    );
    await until(() => q("work-plan-remaining")?.textContent === "2", "읽은 값이 확정");
  });

  it("멈춘 세션은 지금 단계를 세우지 않고 한정 문장을 말하며, 기록이 길면 낡았을 수 있다고 말한다", async () => {
    const opened: string[] = [];
    api.fetchWorkSessions.mockResolvedValue([session({ status: "ended", endedAtMs: T + 1 })]);
    // 매 쪽이 다음 쪽을 가리킨다: 읽기 상한(5쪽)에서 잘린 기록이다.
    api.fetchThreadReplies.mockResolvedValue({ messages: [statusRow(1, PLAN_2_OF_4)], nextCursor: 1 });
    mountDock((id) => opened.push(id));
    await until(() => q("work-plan-dock") !== null, "독");
    act(() => q("work-plan-dock")?.click());

    expect(qa("work-plan-step").map((step) => step.getAttribute("data-step"))).toEqual([
      "done",
      "done",
      "pending",
      "pending",
    ]);
    expect(qa("work-plan-note").map((note) => note.textContent)).toEqual([
      "지금은 돌고 있지 않아요. 마지막으로 알린 계획이에요.",
      "기록이 길어서 마지막 계획이 아닐 수 있어요.",
    ]);

    // 「모두 보기」는 같은 오른쪽 자리를 쓰는 에이전트 작업 패널을 닫고 이 세션으로 기존 화면을 연다.
    openWorkPanel({ runId: "0199aa11-2222-7000-8000-0000000000b1", memberId: ME, channelId: CH, origin: "activity" });
    expect(workPanelSnapshot()).not.toBeNull();
    act(() => q("work-plan-open-all")?.click());
    expect(opened).toEqual([SESSION_ID]);
    expect(workPanelSnapshot()).toBeNull();
  });
});

describe("세션을 바꿀 때 (#5166)", () => {
  const SESSION_B = "019F9A34-5405-7FDA-9FB2-C6806F69D8B7";
  const ROOT_B = "019F9A34-5406-77A9-AB33-B011D56B91F9";
  const PLAN_B: WorkPlanItem[] = [
    { content: "배포 확인", status: "completed" },
    { content: "알림 보내기", status: "pending" },
  ];

  /** B 세션의 스레드 줄: `statusRow`와 같은 모양이고 세션 id만 B다. */
  function statusRowB(seq: number, plan: WorkPlanItem[]): Message {
    const row = statusRow(seq, plan) as unknown as { props: { event: { work_session_id: string } } };
    row.props.event.work_session_id = SESSION_B;
    return row as unknown as Message;
  }

  it("팝오버를 연 채 다른 세션을 고르면 새 계획을 읽는 동안에도 독이 서 있고 팝오버는 열린 채 새 내용으로 바뀐다", async () => {
    let resolveB: (page: { messages: Message[] }) => void = () => undefined;
    const pageB = new Promise<{ messages: Message[] }>((resolve) => {
      resolveB = resolve;
    });
    api.fetchWorkSessions.mockResolvedValue([
      session(),
      session({ id: SESSION_B, rootMessageId: ROOT_B, label: "배포 점검", status: "ended", endedAtMs: T, startedAtMs: T - 5000 }),
    ]);
    // B의 스레드는 늦게 온다: 키가 바뀐 그 한 순간에 B의 `data`가 없다(60초 신선 시간 때문에 캐시된 스레드로는 재현되지 않는다).
    api.fetchThreadReplies.mockImplementation((_ws: string, _channel: string, rootId: string) =>
      rootId === ROOT_B ? pageB : Promise.resolve({ messages: [statusRow(1, PLAN_2_OF_4)] })
    );
    mountDock();
    await until(() => q("work-plan-dock") !== null, "독");
    const dock = q("work-plan-dock");
    act(() => dock?.click());
    expect(q("work-plan-title")?.textContent).toBe("계획 · 4단계 중 2단계 완료");
    const select = q("work-plan-session-select") as HTMLSelectElement;

    // 한 번이라도 사라지면 안 된다: 변이를 지켜보다가 독 노드가 DOM에서 빠진 적이 있으면 기록한다.
    let dockRemoved = false;
    const watcher = new MutationObserver(() => {
      if (!document.body.contains(dock)) dockRemoved = true;
    });
    watcher.observe(document.body, { childList: true, subtree: true });

    act(() => {
      select.value = SESSION_B;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // B를 읽는 동안: 독은 같은 노드로 서 있고, 팝오버는 열려 있고, 목록은 마지막으로 읽은 값에 「읽는 중」 표시가 붙는다.
    expect(q("work-plan-dock")).toBe(dock);
    expect(q("work-plan-popover")).not.toBeNull();
    expect((q("work-plan-session-select") as HTMLSelectElement).value).toBe(SESSION_B);
    expect(q("work-plan-steps")?.getAttribute("aria-busy")).toBe("true");
    expect(qa("work-plan-note").map((note) => note.textContent)).toEqual([
      "고른 세션의 계획을 불러오는 중이에요. 아래는 마지막으로 읽은 계획이에요.",
      "지금은 돌고 있지 않아요. 마지막으로 알린 계획이에요.",
    ].slice(0, 1));

    resolveB({ messages: [statusRowB(1, PLAN_B)] });
    await until(() => q("work-plan-title")?.textContent === "계획 · 2단계 중 1단계 완료", "B의 계획");
    watcher.disconnect();
    expect(dockRemoved).toBe(false);
    expect(q("work-plan-dock")).toBe(dock);
    expect(q("work-plan-popover")).not.toBeNull();
    expect(q("work-plan-steps")?.hasAttribute("aria-busy")).toBe(false);
    expect(qa("work-plan-step").map((step) => step.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "배포 확인완료",
      "알림 보내기대기",
    ]);
  });

  it("읽기가 실패하면 마지막 값을 붙들지 않고 독이 선다고 우기지 않는다", async () => {
    api.fetchWorkSessions.mockResolvedValue([
      session(),
      session({ id: SESSION_B, rootMessageId: ROOT_B, label: "배포 점검", status: "ended", endedAtMs: T, startedAtMs: T - 5000 }),
    ]);
    api.fetchThreadReplies.mockImplementation((_ws: string, _channel: string, rootId: string) =>
      rootId === ROOT_B ? Promise.reject(new Error("읽지 못했다")) : Promise.resolve({ messages: [statusRow(1, PLAN_2_OF_4)] })
    );
    mountDock();
    await until(() => q("work-plan-dock") !== null, "독");
    act(() => q("work-plan-dock")?.click());
    const select = q("work-plan-session-select") as HTMLSelectElement;
    act(() => {
      select.value = SESSION_B;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 실패한 읽기는 낡은 값을 새 세션의 계획인 척 두지 않는다: 독이 서지 않는다(읽지 못한 것을 「계획 없음」이라 말하지도 않는다).
    await until(() => q("work-plan-dock") === null, "읽기 실패 뒤 독 없음");
  });
});

describe("대화 머리에 꽂힌다", () => {
  it("채널 도구 묶음 안에 서고 기존 작업 세션 열기를 그대로 부른다(채널·스트레스 아닌 대화에서만)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/features/chat/ChatShell.tsx"), "utf8");
    // 주석은 반례를 그대로 인용한다: 코드만 본다.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    const group = code.slice(code.indexOf("channel-header-controls"), code.indexOf("</header>", code.indexOf("channel-header-controls")));
    expect(group.length).toBeGreaterThan(500);
    const mount = group.slice(group.indexOf("<WorkPlanDock"));
    expect(mount.startsWith("<WorkPlanDock")).toBe(true);
    expect(mount.slice(0, mount.indexOf("/>"))).toMatch(/onOpenSession=\{openWorkSession\}/);
    // 스트레스 픽스처와 채널 없는 상태에서는 서지 않는다(핀 목록과 같은 조건).
    const before = group.slice(Math.max(0, group.indexOf("<WorkPlanDock") - 120), group.indexOf("<WorkPlanDock"));
    expect(before).toMatch(/stressCount === 0 && channelId !== null/);
  });
});

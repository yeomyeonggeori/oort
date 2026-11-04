// @vitest-environment jsdom
// 실제 MessageRow를 그려 트리거 메시지의 상태 칩(#4619 B)·스레드 요약 줄 칩(E)·예외 줄(D)이 제자리에 서는지 본다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunProgress, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { UNCOLLECTED_WORD } from "@momo/core/features/agents/runWaiting";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { MessageRow } from "./MessageRow";

const api = vi.hoisted(() => ({ fetchAgentLiveness: vi.fn(), fetchAgentRunEvents: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const AGENT = "00000000-0000-7000-8000-000000000102";
const MSG = "0199eeee-0000-7000-8000-000000000501";
const T0 = new Date("2026-10-27T03:00:00Z").getTime();
const MIN = 60_000;

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

// 공급자 밖의 화면은 번들된 영어로 물러나므로(`useFormatMessage`), 한국어 문구(「답글 2개」)를 단정하는 이 파일은 한국어 공급자로 감싼다.
let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  api.fetchAgentLiveness.mockReset();
  api.fetchAgentLiveness.mockRejectedValue(new Error("no liveness in this test"));
  api.fetchAgentRunEvents.mockReset();
  api.fetchAgentRunEvents.mockResolvedValue({ runId: "0199aa11-2222-7000-8000-0000000000b1", events: [] });
});
afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function member(id: string, kind: "human" | "agent", name: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const directory = makeDirectory([
  member(ME, "human", "정하윤", "hayun"),
  member(AGENT, "agent", "달무리봇", "dalmuri-bot"),
]);

function message(extra: Partial<Message> = {}): Message {
  return {
    id: MSG,
    channelId: CH,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "@달무리봇 이번 주 회의록 정리해 줘",
    state: "sent",
    createdAtMs: T0 - 30 * MIN,
    ...extra,
  };
}

function run(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000b1",
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: MSG,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    startedAtMs: T0 - 2 * MIN,
    createdAtMs: T0 - 3 * MIN,
    updatedAtMs: T0 - 3 * MIN,
    ...extra,
  };
}

const DONE = { status: "succeeded", phase: "succeeded", finishedAtMs: T0 - 1_000 } as const;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mount(props: Partial<Parameters<typeof MessageRow>[0]> & { startsGroup: boolean }): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const node: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocaleProvider, { locale: ko, children: createElement(MessageRow, { message: message(), directory, ...props }) })
      )
    )
  );
  act(() => mountedRoot?.render(node));
  return host;
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("머리 줄의 칩 (B)", () => {
  it("헤더가 있는 행: 칩이 **시각 옆**, 같은 줄에 선다", () => {
    const el = mount({ startsGroup: true, runStatus: [run()] });
    const chip = q(el, "trigger-chip");
    const time = q(el, "row-time");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-kind")).toBe("working");
    expect(q(el, "trigger-chip-word")?.textContent).toBe("작업 중");
    expect(chip?.parentElement).toBe(time?.parentElement);
    // 시각 뒤다.
    expect(time!.compareDocumentPosition(chip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("헤더가 없는 이어지는 행: 머리 줄 칩 대신 시각이 서는 거터 칸에 아이콘 칩이 선다(#4619 planner 결정 2). 예외 줄은 그대로 선다", () => {
    const el = mount({ startsGroup: false, runStatus: [run()] });
    const chip = q(el, "trigger-chip");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-variant")).toBe("mark");
    expect(chip?.getAttribute("data-kind")).toBe("working");
    // 칩은 거터 칸 안에, 그 행의 시각(hover로 서는 시계) 곁에 있다. 머리 줄도 낱말 칩도 없다.
    const time = q(el, "row-time");
    expect(time?.hasAttribute("data-row-clock")).toBe(true);
    expect(chip?.closest("[data-row-chip]")?.parentElement).toBe(time?.parentElement);
    expect(q(el, "trigger-chip-word")).toBeNull();
    // 평소의 진행에는 문장 행도 없다(칩·레일이 말한다).
    expect(q(el, "message-run-status-slot")?.childElementCount ?? 0).toBe(0);
    act(() => mountedRoot?.unmount());
    host?.remove();

    const failed = mount({
      startsGroup: false,
      runStatus: [run({ status: "failed", phase: "failed", endReason: "agent_error", finishedAtMs: T0 - 1_000 })],
    });
    expect(q(failed, "trigger-chip")?.getAttribute("data-kind")).toBe("failed");
    expect(q(failed, "trigger-chip")?.getAttribute("data-variant")).toBe("mark");
    expect(q(failed, "run-exception")?.getAttribute("data-kind")).toBe("failed");
  });

  it("머리 줄이 있는 행에는 거터 칩이 없다(아바타가 거터에 있다): 칩은 머리 줄에 하나뿐이다", () => {
    const el = mount({ startsGroup: true, runStatus: [run()] });
    expect(el.querySelectorAll('[data-testid="trigger-chip"]')).toHaveLength(1);
    expect(el.querySelector("[data-row-chip]")).toBeNull();
  });

  it("칩이 서는 머리 줄은 줄바꿈이 없고(@container) 시각은 줄지 않는다 — 칩이 없는 줄은 그대로 flex-wrap이다", () => {
    const withChip = mount({ startsGroup: true, runStatus: [run()] });
    const head = q(withChip, "row-time")?.parentElement;
    expect(head?.className).toContain("@container");
    expect(head?.className).not.toContain("flex-wrap");
    expect(q(withChip, "row-time")?.className).toContain("shrink-0");
    expect(q(withChip, "row-time")?.className).toContain("whitespace-nowrap");
    act(() => mountedRoot?.unmount());
    host?.remove();
    const without = mount({ startsGroup: true });
    const plainHead = q(without, "row-time")?.parentElement;
    expect(plainHead?.className).toContain("flex-wrap");
    expect(plainHead?.className).not.toContain("@container");
    expect(q(without, "row-time")?.className).not.toContain("shrink-0");
  });

  it("run을 주지 않은 행(남의 메시지·스레드 패널)과 run이 없는 행에는 칩도 칸도 없다", () => {
    const other = mount({ startsGroup: true });
    expect(q(other, "trigger-chip")).toBeNull();
    expect(q(other, "message-run-status-slot")).toBeNull();
    act(() => mountedRoot?.unmount());
    host?.remove();
    const none = mount({ startsGroup: true, runStatus: [] });
    expect(q(none, "trigger-chip")).toBeNull();
  });

  it("평소의 진행에는 칩만 있고 문장 행은 없다: 받음·가져감·작업 중·승인 필요·답함", () => {
    const states: [Partial<AgentRunProgress>, string][] = [
      [{ status: "queued", phase: "queued", leaseState: "none", startedAtMs: undefined, createdAtMs: T0 - 10_000 }, "받음"],
      [{ status: "queued", phase: "claimed", claimedAtMs: T0 - 5_000, startedAtMs: undefined }, "가져감"],
      [{}, "작업 중"],
      [{ status: "awaiting_approval", phase: "awaiting_approval" }, "승인 필요"],
      [DONE, "답함"],
    ];
    for (const [extra, word] of states) {
      const el = mount({ startsGroup: true, runStatus: [run(extra)] });
      expect(q(el, "trigger-chip-word")?.textContent, word).toBe(word);
      expect(q(el, "run-exception"), word).toBeNull();
      expect(q(el, "message-run-status-slot")?.childElementCount ?? 0, word).toBe(0);
      act(() => mountedRoot?.unmount());
      host?.remove();
    }
  });

  it("「답함 ✓」을 누르면 답 메시지로 간다(onJumpToMessage에 id와 seq)", () => {
    const jump = vi.fn();
    const done = run(DONE);
    const el = mount({
      startsGroup: true,
      runStatus: [done],
      runAnswers: new Map([[done.id.toLowerCase(), { id: "answer-1", seq: 42 }]]),
      onJumpToMessage: jump,
    });
    act(() => q(el, "trigger-chip")?.click());
    expect(jump).toHaveBeenCalledWith("answer-1", 42);
  });

  it("답을 모르면 같은 칩이 눌리지 않는다", () => {
    const jump = vi.fn();
    const el = mount({ startsGroup: true, runStatus: [run(DONE)], onJumpToMessage: jump });
    expect(q(el, "trigger-chip")?.tagName).toBe("SPAN");
    act(() => q(el, "trigger-chip")?.click());
    expect(jump).not.toHaveBeenCalled();
  });
});

describe("스레드 요약 줄의 「작업 중」 칩 (E)", () => {
  const withReplies = { thread: { reply_count: 2, last_reply_seq: 5, last_reply_at: T0 - MIN } };

  it("답글이 달린 루트를 내가 불렀고 일이 진행 중이면 요약 줄에 같은 칩이 선다", () => {
    const el = mount({ startsGroup: true, message: message(withReplies), runStatus: [run()] });
    const meta = q(el, "message-meta");
    expect(q(meta!, "thread-anchor")?.textContent).toContain("답글 2개");
    expect(q(meta!, "thread-work-chip")).not.toBeNull();
    expect(q(meta!, "thread-work-chip")?.textContent).toContain("작업 중");
  });

  it("일이 끝났거나(답함) 답글이 없는 루트에는 서지 않는다", () => {
    const done = mount({ startsGroup: true, message: message(withReplies), runStatus: [run(DONE)] });
    expect(q(done, "thread-work-chip")).toBeNull();
    act(() => mountedRoot?.unmount());
    host?.remove();
    const noReplies = mount({ startsGroup: true, runStatus: [run()] });
    expect(q(noReplies, "thread-work-chip")).toBeNull();
  });
});

describe("한 행의 칩과 예외 줄은 같은 낱말이다 (#4619)", () => {
  it("유예를 넘어 아무도 가져가지 않은 요청: 칩도 줄도 「아직 받지 않았어요」", () => {
    const el = mount({
      startsGroup: true,
      runStatus: [
        run({
          status: "queued",
          phase: "queued",
          leaseState: "none",
          startedAtMs: undefined,
          createdAtMs: T0 - 10 * MIN,
          updatedAtMs: T0 - 10 * MIN,
        }),
      ],
    });
    expect(q(el, "trigger-chip-word")?.textContent).toBe(UNCOLLECTED_WORD);
    expect(q(el, "run-exception")?.getAttribute("data-kind")).toBe("uncollected");
    expect(q(el, "run-exception-text")?.textContent).toBe(`달무리봇: ${UNCOLLECTED_WORD}`);
  });

  it("서버가 아무도 가져가지 않아 끝낸 요청(timed_out + woken_not_collected)도 같다 — 시간 초과가 아니다", () => {
    const el = mount({
      startsGroup: true,
      runStatus: [
        run({
          status: "timed_out",
          phase: "timed_out",
          endReason: "woken_not_collected",
          startedAtMs: undefined,
          finishedAtMs: T0 - 1_000,
        }),
      ],
    });
    expect(q(el, "trigger-chip-word")?.textContent).toBe(UNCOLLECTED_WORD);
    expect(q(el, "run-exception-text")?.textContent).toBe(
      `달무리봇: ${UNCOLLECTED_WORD} · 깨웠지만 가져가지 않아 끝냈어요`
    );
    expect(q(el, "run-exception-text")?.textContent).not.toContain("시간 초과");
    // 끝난 run에는 되돌릴 행동이 없다.
    expect(q(el, "agent-work-panel-stop-arm")).toBeNull();
    expect(q(el, "run-exception-settings")).toBeNull();
  });
});

describe("예외 줄 (D)", () => {
  it("실패한 run은 메시지 아래 한 줄로 서고 칩은 「실패」다", () => {
    const el = mount({
      startsGroup: true,
      runStatus: [run({ status: "failed", phase: "failed", endReason: "agent_error", finishedAtMs: T0 - 1_000 })],
    });
    expect(q(el, "trigger-chip-word")?.textContent).toBe("실패");
    expect(q(el, "run-exception-text")?.textContent).toBe("달무리봇: 실패 · 에이전트가 오류로 끝냈어요");
  });
});

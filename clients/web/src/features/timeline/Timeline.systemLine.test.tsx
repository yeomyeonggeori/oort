// @vitest-environment jsdom

import { act, createElement, forwardRef, useImperativeHandle, type ReactElement, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { MARKER_DIVIDER_PAD_CLASS } from "./spacing";
import { Timeline } from "./Timeline";

// =============================================================================
// 실행 중단 시스템 줄 (#5079, 폰 #5067의 짝).
//
// 서버는 사람이 에이전트 실행을 멈추면 `type: system`·`props.kind = agent_run_cancelled` 줄을 **멈춘 사람의 이름으로** 남긴다
// (`routes/agent_runs.rs`). 웹은 그 줄을 일반 행으로 그려서 멈춘 사람이 쓴 글처럼 붙였다. 이 파일은 **진짜 `Timeline`·`MessageRow`**
// 를 그려(가상 목록과 두 대화상자만 가짜) 그 줄이 시스템 줄 부품으로 서는지, 그 둘레(다음 행의 이름 머리·사람 글의 흉내·본문
// 없는 줄)가 그대로인지 잰다. 실제 서버가 보내는 props 모양을 그대로 쓴다.
// =============================================================================

const virtuoso = vi.hoisted(() => ({ data: [] as { kind: string; key: string }[] }));
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) => createElement("div", { key: item.key }, props.itemContent(index, item)))
    );
  }),
}));
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "0199cccc-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000000a1";
const AGENT = "00000000-0000-7000-8000-0000000000b1";
const BASE_MS = 1_700_000_000_000;

/** 서버가 중단 때 쓰는 문장 그대로(`CANCEL_SYSTEM_LINE`). 이 시험은 문장을 지어내지 않는다. */
const SERVER_LINE = "사람이 실행을 중단했어요.";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
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
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function member(id: string, name: string, kind: "human" | "agent" = "human"): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle: name,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const directory = makeDirectory([member(ME, "정하윤"), member(OTHER, "가영"), member(AGENT, "김인턴", "agent")]);

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

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};

function text(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `0199eeee-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: BASE_MS + seq * 1_000,
    ...over,
  };
}

/** `agent_runs.rs` 가 싣는 props 모양 그대로. 작성자는 멈춘 사람이다. */
function cancelLine(seq: number, over: Partial<Message> = {}): Message {
  return text(seq, {
    type: "system",
    body: SERVER_LINE,
    props: {
      kind: "agent_run_cancelled",
      run_id: "run-1",
      agent_member_id: AGENT,
      cancelled_by: ME,
      linked_work_session_ids: [],
      work_sessions_terminated: false,
    },
    ...over,
  });
}

function show(messages: Message[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
  }
  const node = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocaleProvider, {
          locale: ko,
          children: createElement(Timeline, {
            messages,
            directory,
            status: "ready",
            reachedStart: true,
            actions,
            onOpenThread: () => undefined,
          }),
        })
      )
    )
  );
  act(() => mountedRoot?.render(node));
}

const rows = () => Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="timeline-message"]') ?? []);
const rowAt = (seq: number) => host?.querySelector<HTMLElement>(`[data-testid="timeline-message"][data-seq="${seq}"]`) ?? null;
/** 묶음의 머리 행만 아바타 단추를 단다(이어지는 행은 거터에 시각만 있다). */
const startsGroup = (seq: number) => rowAt(seq)?.querySelector('[data-testid="row-avatar-profile"]') != null;
const systemLines = () => Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="system-line"]') ?? []);

describe("중단 시스템 줄이 서는 모양", () => {
  it("말풍선(행)이 아니라 시스템 줄 부품으로 서고, 서버 문장을 그대로 가운데에 말한다", () => {
    const cancel = cancelLine(3);
    show([text(1, { authorMemberId: OTHER, body: "배포 확인 부탁해요" }), text(2, { body: "이 일을 맡아 줘" }), cancel]);

    expect(systemLines()).toHaveLength(1);
    const line = systemLines()[0] as HTMLElement;
    expect(line.textContent).toBe(SERVER_LINE); // 서버 문장 그대로 - 부품은 낱말을 고쳐 쓰지 않는다
    // 행은 사람 글 둘뿐이다 - 중단 줄은 행이 아니다(옛 판은 세 행이었다).
    expect(rows().map((row) => row.dataset.seq)).toEqual(["1", "2"]);
    expect(rowAt(3)).toBeNull();
    // 문장은 화면에 정확히 한 번, 시스템 줄 안에만 있다.
    expect((host?.textContent ?? "").split(SERVER_LINE).length - 1).toBe(1);
    // 항법의 신원은 일반 행과 같은 속성으로 선다(소문자 id).
    expect(line.dataset.seq).toBe("3");
    expect(line.dataset.messageId).toBe(cancel.id.toLowerCase());
    // 작성자(멈춘 사람)의 아바타·이름·시각, 눌릴 것(행 동작)이 하나도 없다.
    expect(line.querySelector('[data-testid="row-avatar-profile"], [data-testid="row-time"], time, button, [data-row-action]')).toBeNull();
    // 가운데의 조용한 줄: 안 읽음·복구 표지와 같은 여백, 가운데 정렬, 물러난 잉크의 보조 글씨.
    expect(line.className).toContain("justify-center");
    expect(line.className).toContain(MARKER_DIVIDER_PAD_CLASS);
    const sentence = line.querySelector("p") as HTMLElement;
    expect(sentence.className).toContain("text-center");
    expect(sentence.className).toContain("text-meta");
    expect(sentence.className).toContain("text-ink-muted");
  });

  it("줄 바로 다음 행은 작성자(멈춘 사람)가 같아도 새 묶음으로 시작한다 - 이름 머리가 걷히지 않는다", () => {
    // 대조: 중단 줄이 없으면 같은 사람이 5분 안에 이어 쓴 글은 이어지는 행이다(머리 없음). 하네스가 묶음을 실제로 잰다는 증거.
    show([text(1), text(2)]);
    expect(startsGroup(1)).toBe(true);
    expect(startsGroup(2)).toBe(false);

    // 중단 줄(작성자 = 멈춘 사람) 다음에 멈춘 사람이 곧바로 쓴 글: 위에는 시스템 줄이 있으니 자기를 다시 소개해야 한다.
    show([text(1), cancelLine(2), text(3)]);
    expect(systemLines()).toHaveLength(1);
    expect(startsGroup(1)).toBe(true);
    expect(startsGroup(3)).toBe(true);
    // 줄 뒤의 그다음 글은 평소처럼 이어진다(끊김은 줄 바로 다음 한 행뿐이다).
    show([text(1), cancelLine(2), text(3), text(4)]);
    expect(startsGroup(3)).toBe(true);
    expect(startsGroup(4)).toBe(false);
  });

  it("사람이 보낸 글은 표식을 흉내 내도 시스템 줄이 아니다 - 코어 판정이 type 까지 본다", () => {
    const spoof = text(1, { type: "text", props: { kind: "agent_run_cancelled" }, body: SERVER_LINE });
    show([spoof]);
    expect(systemLines()).toHaveLength(0);
    expect(rowAt(1)).not.toBeNull();
    expect(rowAt(1)?.textContent).toContain(SERVER_LINE);
  });

  it("본문이 없는 중단 줄은 숨지 않고 일반 행으로 남는다 - 그릴 말이 없는 줄을 조용히 지우지 않는다", () => {
    show([cancelLine(1, { body: "" }), cancelLine(2, { body: undefined })]);
    expect(systemLines()).toHaveLength(0);
    expect(rows().map((row) => row.dataset.seq)).toEqual(["1", "2"]);
  });
});

// @vitest-environment jsdom
// #5326: 고치기를 찾기 쉽게(내 메시지 호버 도구 막대의 연필) + 고친 메시지의 「수정됨」 옆 고친 시각.
//   · 연필은 **내 글에만** 선다. 남의 글·에이전트 글·보내지 못한 글에는 없다. 눌러서 그 행 안에 편집기가 열리고 저장은 기존 길이다.
//   · 「수정됨」은 사전 낱말이고, 가리키거나(초점) 하면 「…에 수정됨」 툴팁이 뜬다. 시각은 오늘·어제·다른 날·다른 해로 달라진다.
//   · 실시간 `message.edited` 가 같은 행에 새 `editedAtMs` 를 실어 오면(행의 메시지 객체가 바뀐다) 이름과 시각이 같이 바뀐다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { LocaleContext } from "@/i18n/localeContext";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { MessageRow } from "./MessageRow";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000301";
const MINE_ID = "0199eeee-0000-7000-8000-000000000601";

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
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
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  ko = await koreanLocaleForTest();
});

// 「오늘」의 기준은 그리는 순간의 시계다. 시계만 고정하고 타이머는 건드리지 않는다(툴팁 지연·초점 핸드오프가 진짜 타이머를 쓴다).
// 한국 시간 2026-11-05 14:30(서울, 한국어 문맥).
const NOW = Date.UTC(2026, 10, 5, 5, 30);
const kst = (day: number, hh: number, mm: number, month = 11, year = 2026) => Date.UTC(year, month - 1, day, hh - 9, mm);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function member(id: string, displayName: string, handle: string, kind: "human" | "agent" = "human"): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: MINE_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 7,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "회의 시간은 3시예요",
    state: "sent",
    createdAtMs: 7000,
    ...over,
  };
}

const onEditMessage = vi.fn(async () => undefined);
const actions = {
  myMemberId: ME,
  chips: [],
  pinned: false,
  onToggleReaction: async () => undefined,
  onTogglePin: async () => undefined,
  onEditMessage,
  onDeleteMessage: async () => undefined,
};

function rowElement(msg: Message): ReactElement {
  return createElement(MessageRow, {
    message: msg,
    startsGroup: true,
    directory: makeDirectory([
      member(OTHER, "이도현", "dohyeon"),
      member(ME, "박서연", "seoyeon"),
      member(AGENT, "달무리봇", "dalmuri-bot", "agent"),
    ]),
    actions,
    // 답글은 열 곳(스레드 패널)이 있어야 서는 항목이다: 막대의 순서(답글 · 연필 · ⋯)를 재려면 있어야 한다.
    onOpenThread: () => undefined,
  });
}

function tree(msg: Message): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(
    MemoryRouter,
    null,
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        OpenMemberProfileContext.Provider,
        { value: () => undefined },
        createElement(
          QueryClientProvider,
          { client },
          createElement(LocaleContext.Provider, { value: ko }, rowElement(msg))
        )
      )
    )
  );
}

function mountRow(msg: Message): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(tree(msg)));
  return host;
}

/** 같은 행을 새 메시지 객체로 다시 그린다: `message.edited` 프레임이 `applyEditedMessage` 를 지나 행에 닿는 모양이다. */
function rerenderRow(msg: Message) {
  act(() => mountedRoot?.render(tree(msg)));
}

const rowOf = (root: HTMLElement) => root.querySelector('[data-testid="timeline-message"]') as HTMLElement;
const toolbarOf = (root: HTMLElement) => root.querySelector('[data-testid="message-hover-toolbar"]');
const pencilOf = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-testid="toolbar-edit"]');
const markOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="edited-mark"]');

/** 포인터가 행에 들어왔다(React 의 `onMouseEnter` 는 `mouseover` 로 온다). */
function hover(root: HTMLElement) {
  act(() => {
    rowOf(root).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
}

describe("내 메시지 호버 도구 막대의 연필(고치기)", () => {
  it("내 글에 포인터를 올리면 도구 막대에 연필이 서고, 이름은 「고치기」이며 답글과 ⋯ 사이다", () => {
    const root = mountRow(message());
    hover(root);
    const pencil = pencilOf(root);
    expect(pencil).not.toBeNull();
    expect(pencil?.getAttribute("aria-label")).toBe("고치기");
    expect(pencil?.hasAttribute("data-row-action")).toBe(true);
    const order = Array.from(toolbarOf(root)!.querySelectorAll<HTMLElement>("[data-testid]")).map((el) => el.dataset.testid);
    const at = (id: string) => order.indexOf(id);
    expect(at("toolbar-reply")).toBeGreaterThan(-1);
    expect(at("toolbar-edit")).toBe(at("toolbar-reply") + 1);
    expect(at("message-actions-trigger")).toBe(at("toolbar-edit") + 1);
  });

  it("남의 글·에이전트 글에는 연필이 없다(도구 막대 자체는 선다)", () => {
    for (const authorMemberId of [OTHER, AGENT]) {
      const root = mountRow(message({ authorMemberId }));
      hover(root);
      expect(toolbarOf(root), authorMemberId).not.toBeNull();
      expect(pencilOf(root), authorMemberId).toBeNull();
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      host?.remove();
      host = null;
    }
  });

  it("보내지 못한 내 글에는 연필이 없다(서버에 행이 없다)", () => {
    const root = mountRow(message({ state: "failed" }));
    hover(root);
    expect(pencilOf(root)).toBeNull();
  });

  it("글·첨부 든 글·답글·스레드 루트 모두 같은 연필이다", () => {
    const kinds: Array<[string, Partial<Message>]> = [
      ["글", {}],
      ["첨부 든 글", { attachments: [{ id: "0199eeee-0000-7000-8000-0000000006f1", name: "현장.png", mime: "image/png", sizeBytes: 4096 }] }],
      ["답글", { rootId: "0199eeee-0000-7000-8000-000000000600" }],
      ["스레드 루트", { thread: { reply_count: 2, last_reply_seq: 9, last_reply_at: 9000 } }],
    ];
    for (const [name, over] of kinds) {
      const root = mountRow(message(over));
      hover(root);
      expect(pencilOf(root), name).not.toBeNull();
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      host?.remove();
      host = null;
    }
  });

  it("연필을 누르면 그 행 안에 지금 글로 편집기가 열리고 도구 막대는 걷힌다", () => {
    const root = mountRow(message());
    hover(root);
    act(() => pencilOf(root)?.click());
    const input = root.querySelector<HTMLTextAreaElement>('[data-testid="message-editor-input"]');
    expect(input).not.toBeNull();
    expect(input?.value).toBe("회의 시간은 3시예요");
    expect(toolbarOf(root)).toBeNull();
  });

  it("⋯ 메뉴의 첫 줄 「고치기」도 그대로 있다(연필은 복사본이고 우클릭·키보드 길을 지우지 않는다)", () => {
    const root = mountRow(message());
    hover(root);
    act(() => {
      root.querySelector<HTMLButtonElement>('[data-testid="message-actions-trigger"]')?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
      );
      root.querySelector<HTMLButtonElement>('[data-testid="message-actions-trigger"]')?.click();
    });
    const menuEdit = document.querySelector('[data-testid="menu-edit"]');
    expect(menuEdit).not.toBeNull();
  });
});

describe("「수정됨」과 고친 시각", () => {
  it("고치지 않은 글에는 표지가 없다", () => {
    const root = mountRow(message());
    expect(markOf(root)).toBeNull();
    expect(root.textContent).not.toContain("수정됨");
  });

  it("오늘 고친 글: 낱말은 「수정됨」이고 접근성 이름·툴팁은 시각 문장이다", () => {
    const root = mountRow(message({ state: "edited", editedAtMs: kst(5, 9, 5) }));
    const mark = markOf(root)!;
    expect(mark.textContent).toBe("수정됨");
    const label = mark.getAttribute("aria-label")!;
    expect(label).toMatch(/9:05에 수정됨$/);
    expect(label).not.toMatch(/어제|월/);
    // 보이는 글자는 접근성 이름 안에 든다(라벨-인-네임).
    expect(label).toContain(mark.textContent!);
    // 로빙 그룹의 구성원이다: 행에 탭 정거장을 하나 더 만들지 않고 ←/→ 로 닿는다.
    expect(mark.hasAttribute("data-row-action")).toBe(true);
    // 읽기 전용 표지다: 눌러서 되는 일이 없으니 `button` 이 아니라 이름 붙은 `note` 다(눌림 원장·화면 낭독 모두 거짓 신호를 받지 않는다).
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("role")).toBe("note");
  });

  it("초점(키보드)이 가면 같은 문장이 툴팁으로 뜬다", () => {
    const root = mountRow(message({ state: "edited", editedAtMs: kst(5, 9, 5) }));
    const mark = markOf(root)!;
    expect(root.querySelector(".tooltip-surface")).toBeNull();
    act(() => mark.focus());
    const tip = root.querySelector(".tooltip-surface");
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toBe(mark.getAttribute("aria-label"));
  });

  it("어제 고친 글은 「어제」가, 다른 날은 날짜가, 다른 해는 연도까지 붙는다", () => {
    const cases: Array<[string, number, RegExp]> = [
      ["어제", kst(4, 23, 50), /^어제 .*에 수정됨$/],
      ["같은 해 다른 날", kst(3, 9, 5), /^11월 3일 .*9:05에 수정됨$/],
      ["다른 해", kst(31, 9, 5, 12, 2025), /^2025년 12월 31일 .*9:05에 수정됨$/],
    ];
    for (const [name, editedAtMs, expected] of cases) {
      const root = mountRow(message({ state: "edited", editedAtMs }));
      expect(markOf(root)?.getAttribute("aria-label"), name).toMatch(expected);
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      host?.remove();
      host = null;
    }
  });

  it("고친 시각을 모르는 줄은 글자 하나다(초점 정거장도 툴팁도 없다)", () => {
    const root = mountRow(message({ state: "edited" }));
    const mark = markOf(root)!;
    expect(mark.textContent).toBe("수정됨");
    expect(mark.tagName).toBe("SPAN");
    expect(mark.hasAttribute("data-row-action")).toBe(false);
    expect(mark.hasAttribute("aria-label")).toBe(false);
  });

  it("실시간: 같은 행이 새 고친 시각으로 다시 그려지면 이름과 툴팁 시각이 같이 바뀐다", () => {
    const root = mountRow(message({ state: "edited", editedAtMs: kst(5, 9, 5) }));
    expect(markOf(root)?.getAttribute("aria-label")).toMatch(/9:05에 수정됨$/);
    // 다른 사람이 한 번 더 고쳤다: 프레임은 행의 현재 값(`edited_at_ms`)을 그대로 싣는다.
    rerenderRow(message({ state: "edited", body: "회의 시간은 4시예요", editedAtMs: kst(5, 11, 40) }));
    const mark = markOf(root)!;
    expect(mark.getAttribute("aria-label")).toMatch(/11:40에 수정됨$/);
    expect(mark.getAttribute("aria-label")).not.toMatch(/9:05/);
    expect(root.textContent).toContain("회의 시간은 4시예요");
  });

  it("실시간: 처음 고쳐진 글에 표지가 새로 선다(고치기 전에는 없었다)", () => {
    const root = mountRow(message());
    expect(markOf(root)).toBeNull();
    rerenderRow(message({ state: "edited", body: "회의 시간은 3시 30분이에요", editedAtMs: kst(5, 14, 20) }));
    expect(markOf(root)?.getAttribute("aria-label")).toMatch(/에 수정됨$/);
  });

  it("편집기가 열려 있는 동안에는 표지를 그리지 않는다(고치는 글에 「수정됨」은 이르다)", () => {
    const root = mountRow(message({ state: "edited", editedAtMs: kst(5, 9, 5) }));
    hover(root);
    act(() => pencilOf(root)?.click());
    expect(root.querySelector('[data-testid="message-editor-input"]')).not.toBeNull();
    expect(markOf(root)).toBeNull();
  });
});

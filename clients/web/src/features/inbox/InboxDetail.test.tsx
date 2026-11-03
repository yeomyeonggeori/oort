// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { MARKER_DIVIDER_PAD_CLASS, SYSTEM_LINE_STRADDLE_CLEAR_CLASS } from "@/features/timeline/spacing";
import { InboxDetail } from "./InboxDetail";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;

const api = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  fetchThreadReplies: vi.fn(),
  sendMessage: vi.fn(),
  members: new Map<string, unknown>(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchMessages: api.fetchMessages,
  fetchThreadReplies: api.fetchThreadReplies,
  sendMessage: api.sendMessage,
}));
vi.mock("@/features/workspace/useWorkspace", () => ({
  memberFor: (_d: unknown, id: string) => api.members.get(id) ?? null,
  useChannels: () => ({ groups: { channels: [], dms: [] } }),
}));
// 아바타는 글자가 없는 표지만 낸다: 행 글자(`textContent`)를 재는 시험은 그대로이고, 「이 줄에 아바타가 있는가」는 값으로 잴 수 있다(#5128).
vi.mock("@/features/timeline/MessageRow", () => ({
  Avatar: () => createElement("i", { "data-testid": "context-avatar" }),
}));
vi.mock("@/features/timeline/MessageBody", () => ({
  MessageBody: ({ body }: { body: string }) => createElement("span", null, body),
}));
vi.mock("@/features/timeline/ThreadComposer", () => ({
  ThreadComposer: ({ rootId }: { rootId: string }) =>
    createElement("div", { "data-testid": "thread-composer", "data-root": rootId }),
}));
vi.mock("./InboxApprovalActions", () => ({
  InboxApprovalActions: ({ approvalId }: { approvalId: string }) =>
    createElement("div", { "data-testid": "approval-actions", "data-id": approvalId }),
}));

const directory = { members: [], byId: new Map() } as never;
const BOT = "00000000-0000-7000-8000-000000000301";

function msg(seq: number, body: string, extra: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, channelId: CH, seq, hlcTs: NOW, hlcCount: 0, authorMemberId: ME,
    type: "text", body, createdAtMs: NOW + seq, ...extra,
  };
}

function entry(over: Partial<MailboxEntry>): MailboxEntry {
  return {
    key: "k", kind: "dm", channelId: CH, channelLabel: "서연", typeLabel: "DM · 서연", actor: "서연",
    actorIsAgent: false, preview: "p", atMs: NOW, timeLabel: "방금", unread: true, unreadCount: 1,
    seq: 5, reason: "r", ...over,
  };
}

const task: FeedItem = {
  key: "approval:a1", kind: "approval", tone: "warn", actor: "@kim-intern", actorIsAgent: true,
  predicate: "세션 종료 허가를 요청했어요", outcome: null, outcomeTone: "muted", channelId: CH,
  channelLabel: "#workbench", timeLabel: "5분 후 만료", sortAtMs: NOW, pending: true, reason: "r",
  approvalId: "a1", expiresAtMs: undefined,
} as FeedItem;

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a", refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "나", handle: "me" },
      realtimeWebSocketUrl: "wss://x.test/ws",
    },
    workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as SessionContextValue;
}

/** `korean`은 사전 문장을 단정하는 시험만 켠다(공급자가 없으면 번들된 영어로 물러난다). */
async function mount(e: MailboxEntry, offline = false, korean = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = createElement(
    QueryClientProvider, { client },
    createElement(SessionProvider, { value: session() },
      createElement(MemoryRouter, null,
        createElement(InboxDetail, {
          entry: e, directory, offline, onToggleRead: () => undefined,
          onDecided: () => undefined, readBusy: false,
        })))
  );
  await act(async () => {
    root?.render(korean ? createElement(LocaleProvider, { locale: ko, children: page }) : page);
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return host;
}

let ko: AppLocale;
beforeAll(async () => { ko = await koreanLocale(); env.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  api.fetchMessages.mockResolvedValue({ messages: [msg(6, "둘째"), msg(5, "첫째")] });
  api.fetchThreadReplies.mockResolvedValue({ messages: [msg(9, "답글 하나")] });
  api.sendMessage.mockResolvedValue(msg(10, "ok"));
  api.members.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null; host?.remove(); host = null;
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe("InboxDetail", () => {
  it("DM: 최근 대화를 오래된 순으로 보이고 답장 입력이 있다", async () => {
    const h = await mount(entry({}));
    const rows = Array.from(h.querySelectorAll('[data-testid="inbox-context-row"]'));
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("첫째"), expect.stringContaining("둘째"),
    ]);
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="inbox-open-conversation"]')?.getAttribute("href")).toBe(`/c/${CH}?seq=5`);
  });

  it("멘션: 그 메시지를 강조하고, 보내면 그 메시지를 인용(replyToId)해 보낸다", async () => {
    const h = await mount(entry({ key: "mention:m5", kind: "mention", messageId: "m5", typeLabel: "멘션 · #w" }));
    expect(h.querySelector('[data-highlighted="true"]')?.textContent).toContain("첫째");
    // #4324: 착지 면은 폰과 같은 `landed-surface`(--warn-soft + 1px 테두리)다.
    expect(h.querySelector('[data-highlighted="true"]')?.classList.contains("landed-surface")).toBe(true);
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, CH, { limit: 20, before: 8 });
    const input = h.querySelector<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(input, "확인했어요");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="inbox-reply-send"]')!.click();
      await Promise.resolve();
    });
    expect(api.sendMessage).toHaveBeenCalledWith(WS, CH, expect.any(String), "확인했어요", { replyToId: "m5" });
  });

  it("답글: 인용된 내 글을 보이고, 그 메시지를 강조하며, 인용(replyToId)해 답한다", async () => {
    const h = await mount(
      entry({
        key: "inbox:r1", itemId: "r1", kind: "reply", messageId: "m5",
        typeLabel: "답글 · #agent-lab", quotedPreview: "배포 어떻게 됐어?",
      })
    );
    expect(h.querySelector('[data-testid="inbox-quoted"]')?.textContent).toContain("배포 어떻게 됐어?");
    expect(h.querySelector('[data-highlighted="true"]')?.textContent).toContain("첫째");
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, CH, { limit: 20, before: 8 });
    const input = h.querySelector<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(input, "고마워요");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="inbox-reply-send"]')!.click();
      await Promise.resolve();
    });
    expect(api.sendMessage).toHaveBeenCalledWith(WS, CH, expect.any(String), "고마워요", { replyToId: "m5" });
  });

  it("서버 투영: 읽은 항목에는 「안 읽음으로 표시」가 없다(되돌리는 길이 없다), 안 읽은 항목에는 읽음 버튼이 있다", async () => {
    const read = await mount(entry({ key: "inbox:1", itemId: "i1", kind: "mention", unread: false }));
    expect(read.querySelector('[data-testid="inbox-toggle-read"]')).toBeNull();
    if (root) act(() => root?.unmount());
    root = null; host?.remove(); host = null;
    const unread = await mount(entry({ key: "inbox:2", itemId: "i2", kind: "mention", unread: true }));
    expect(unread.querySelector('[data-testid="inbox-toggle-read"]')?.textContent).toBe("읽음으로 표시");
  });

  it("구 서버 항목은 읽은 뒤에도 안 읽음으로 되돌릴 수 있다", async () => {
    const h = await mount(entry({ unread: false }));
    expect(h.querySelector('[data-testid="inbox-toggle-read"]')?.textContent).toBe("안 읽음으로 표시");
  });

  it("스레드: 내 글과 답글을 보이고 스레드 입력을 쓴다 (채널 입력이 아니다)", async () => {
    const h = await mount(entry({ key: "thread:r1", kind: "thread", rootId: "r1", rootPreview: "배포 언제?" }));
    expect(h.querySelector('[data-testid="inbox-thread-root"]')?.textContent).toContain("배포 언제?");
    expect(h.textContent).toContain("답글 하나");
    expect(h.querySelector('[data-testid="thread-composer"]')?.getAttribute("data-root")).toBe("r1");
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).toBeNull();
    expect(api.fetchThreadReplies).toHaveBeenCalled();
  });

  it("처리할 일: 결정 버튼이 있고 대화는 불러오지 않는다", async () => {
    const h = await mount(entry({ key: "approval:a1", kind: "task", task, typeLabel: "처리할 일", seq: undefined }));
    expect(h.querySelector('[data-testid="approval-actions"]')?.getAttribute("data-id")).toBe("a1");
    expect(api.fetchMessages).not.toHaveBeenCalled();
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).toBeNull();
    expect(h.querySelector('[data-testid="inbox-toggle-read"]')).toBeNull();
  });

  it("처리할 일 + 오프라인이면 버튼 대신 이유를 말한다", async () => {
    const h = await mount(entry({ key: "approval:a1", kind: "task", task, seq: undefined }), true);
    expect(h.querySelector('[data-testid="approval-actions"]')).toBeNull();
    expect(h.querySelector('[data-testid="inbox-approval-offline"]')).not.toBeNull();
  });

  it("오프라인에서는 답장 입력 대신 이유를 말한다", async () => {
    const h = await mount(entry({}), true);
    expect(h.querySelector('[data-testid="inbox-reply-input"]')).toBeNull();
    expect(h.querySelector('[data-testid="inbox-reply-offline"]')).not.toBeNull();
  });

  it("맥락을 못 불러오면 오류와 다시 시도", async () => {
    api.fetchMessages.mockRejectedValue(new Error("boom"));
    const h = await mount(entry({}));
    expect(h.querySelector('[data-testid="inbox-context-error"]')).not.toBeNull();
  });

  // #5242: 옛 「대화를 불러오지 못했어요.」 배너는 원인 상자다. 이유가 원인을 따르고 다시 시도가 맥락을 다시 읽는다.
  it("맥락을 못 불러오면 원인 상자가 서고, 이유가 원인을 따라가며, 다시 시도가 다시 읽는다", async () => {
    const cases: [Error, string, string][] = [
      [new NetworkError("unreachable", 15_000), "serverUnreachable", "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요."],
      [new ApiError(500, "boom", "internal"), "", "문제가 생겼어요. 다시 시도해 주세요."],
    ];
    for (const [error, cause, reason] of cases) {
      vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(true);
      api.fetchMessages.mockReset();
      api.fetchMessages.mockRejectedValue(error);
      const h = await mount(entry({}), false, true);
      const box = h.querySelector<HTMLElement>('[data-testid="inbox-context-error"]');
      expect(box, cause).not.toBeNull();
      expect(box?.getAttribute("role")).toBe("alert");
      expect(box?.getAttribute("data-cause") ?? "").toBe(cause);
      expect(box?.textContent).toContain("대화를 불러오지 못했어요");
      expect(box?.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
      const reads = api.fetchMessages.mock.calls.length;
      await act(async () => {
        box?.querySelector("button")?.click();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(api.fetchMessages.mock.calls.length).toBeGreaterThan(reads);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
      vi.restoreAllMocks();
    }
  });

  it("전송이 실패하면 입력은 남고 이유가 보인다", async () => {
    api.sendMessage.mockRejectedValue(new Error("x"));
    const h = await mount(entry({}));
    const input = h.querySelector<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "안녕");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="inbox-reply-send"]')!.click();
      await Promise.resolve();
    });
    expect(h.querySelector('[data-testid="inbox-reply-error"]')).not.toBeNull();
    expect(input.value).toBe("안녕");
  });

  it("긴 채널 기록에서 인용 답은 그 메시지 앞뒤 몇 개만 열고, 그 줄로 스크롤하며 잠깐 물들인다(#3694)", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: Array.from({ length: 20 }, (_, i) => msg(i + 1, `기록 ${i + 1}`)),
    });
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() { return (this as HTMLElement).dataset.target === "true" ? 900 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return (this as HTMLElement).dataset.testid === "inbox-detail-scroll" ? 400 : 40; },
    });
    try {
      const h = await mount(
        entry({ key: "inbox:r1", itemId: "r1", kind: "reply", messageId: "m15", seq: 15, typeLabel: "답글 · #agent-lab" })
      );
      const rows = Array.from(h.querySelectorAll('[data-testid="inbox-context-row"]'));
      // 20개를 다 깔면 맨 처음(기록 1)부터 보인다 — 항목 앞 4·뒤 2만 남아야 한다.
      expect(rows.map((r) => r.textContent?.match(/기록 \d+/)?.[0])).toEqual([
        "기록 11", "기록 12", "기록 13", "기록 14", "기록 15", "기록 16", "기록 17",
      ]);
      expect(h.querySelector('[data-target="true"]')?.textContent).toContain("기록 15");
      // 목표 줄이 패널 한가운데 오도록: offsetTop - (패널 높이 - 줄 높이) / 2.
      expect(h.querySelector<HTMLElement>('[data-testid="inbox-detail-scroll"]')!.scrollTop).toBe(900 - (400 - 40) / 2);
      expect(h.querySelector('[data-highlighted="true"]')?.textContent).toContain("기록 15");
      await act(async () => { await new Promise((r) => setTimeout(r, 1_700)); });
      expect(h.querySelector('[data-highlighted="true"]')).toBeNull();
      expect(h.querySelector('[data-target="true"]')).not.toBeNull();
    } finally {
      if (offset) Object.defineProperty(HTMLElement.prototype, "offsetTop", offset);
      else delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
      if (client) Object.defineProperty(HTMLElement.prototype, "clientHeight", client);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it("에이전트 글쓴이는 패널에서도 목록처럼 @핸들이다(연결 이름 grok이 아니다)(#3694)", async () => {
    api.members.set(BOT, { id: BOT, kind: "agent", displayName: "grok", handle: "grokbot", ownerHumanId: ME });
    api.fetchMessages.mockResolvedValue({ messages: [msg(5, "배포 로그 확인했어요", { authorMemberId: BOT })] });
    const h = await mount(
      entry({ key: "inbox:r1", itemId: "r1", kind: "reply", messageId: "m5", seq: 5, actor: "@grokbot" })
    );
    const row = h.querySelector('[data-testid="inbox-context-row"]')!;
    expect(row.textContent).toContain("@grokbot");
    expect(row.textContent).not.toContain("grok배포");
  });
});

describe("InboxDetail: 글 없이 첨부만 보낸 메시지의 맥락 줄 (#4294)", () => {
  const att = (n: number, mime = "image/png") =>
    Array.from({ length: n }, (_, i) => ({ id: `att-${mime}-${i}`, name: `파일${i}`, mime, sizeBytes: 2048 }));
  const contextRows = (h: HTMLElement) =>
    Array.from(h.querySelectorAll('[data-testid="inbox-context-row"]'));

  it("사진만 보낸 줄은 빈 칸이 아니라 「사진 2장」으로 말하고, 옆 줄은 그대로다", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [msg(6, "", { attachments: att(2) }), msg(5, "첫째")],
    });
    const h = await mount(entry({}));
    const rows = contextRows(h);
    expect(rows).toHaveLength(2);
    // 오래된 순: [첫째, 사진 2장]. 둘 다 서야 「행을 통째로 비워도 통과」가 막힌다.
    expect(rows[0].textContent).toContain("첫째");
    expect(rows[1].textContent).toContain("사진 2장");
    expect(rows[1].querySelector('[data-testid="inbox-context-attachments"]')).not.toBeNull();
    expect(rows[0].querySelector('[data-testid="inbox-context-attachments"]')).toBeNull();
  });

  it("사진과 파일이 섞이면 사진이 먼저다", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [msg(5, "", { attachments: [...att(1, "application/pdf"), ...att(1)] })],
    });
    const h = await mount(entry({}));
    expect(contextRows(h)[0].textContent).toContain("사진 1장, 파일 1개");
  });

  it("글이 있으면 글이 이긴다 (첨부는 문구가 되지 않는다)", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [msg(5, "자료 올려요", { attachments: att(1) })],
    });
    const h = await mount(entry({}));
    const row = contextRows(h)[0];
    expect(row.textContent).toContain("자료 올려요");
    expect(row.textContent).not.toContain("사진 1장");
    expect(row.querySelector('[data-testid="inbox-context-attachments"]')).toBeNull();
  });

  it("지워진 줄은 첨부가 남아 있어도 삭제 문장이다", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [msg(5, "", { state: "deleted", attachments: att(1) })],
    });
    const h = await mount(entry({}));
    const row = contextRows(h)[0];
    expect(row.textContent).toContain("삭제된 메시지예요.");
    expect(row.textContent).not.toContain("사진 1장");
  });

  it("대조: 글도 첨부도 없으면 문구를 지어내지 않는다", async () => {
    api.fetchMessages.mockResolvedValue({ messages: [msg(5, "", { attachments: [] })] });
    const h = await mount(entry({}));
    const row = contextRows(h)[0];
    expect(row.querySelector('[data-testid="inbox-context-attachments"]')).toBeNull();
    expect(row.textContent).not.toMatch(/사진|파일/);
  });
});

// =============================================================================
// 실행 중단 시스템 줄 (#5128, 타임라인 #5079·폰 #5067의 짝).
//
// 서버는 사람이 에이전트 실행을 멈추면 `type: system`·`props.kind = agent_run_cancelled` 줄을 **멈춘 사람의 이름으로** 남긴다
// (`routes/agent_runs.rs`). 이 창은 `MessageRow` 가 아니라 자기 행(`ContextRow`)을 그려서 그 줄을 멈춘 사람이 쓴 글처럼 붙였다.
// 진짜 `InboxDetail`·`SystemLine`·`isSystemLineMessage` 를 그려(API·명부·본문·스레드 입력만 가짜) 줄이 가운데의 조용한 줄로 서는지,
// 그 줄이 항목 행의 신원(`aria-current`·스크롤 기준·착지 면)과 어떤 관계인지 잰다. 서버가 보내는 props 모양을 그대로 쓴다.
// =============================================================================
describe("InboxDetail: 실행 중단 시스템 줄 (#5128)", () => {
  /** 서버가 중단 때 쓰는 문장 그대로(`CANCEL_SYSTEM_LINE`). 이 시험은 문장을 지어내지 않는다. */
  const SERVER_LINE = "사람이 실행을 중단했어요.";
  const OTHER = "00000000-0000-7000-8000-000000000102";

  /** `agent_runs.rs` 가 싣는 props 모양 그대로. 작성자는 멈춘 사람(ME)이다. */
  const cancelLine = (seq: number, over: Partial<Message> = {}): Message =>
    msg(seq, SERVER_LINE, {
      type: "system",
      props: {
        kind: "agent_run_cancelled",
        run_id: "run-1",
        agent_member_id: BOT,
        cancelled_by: ME,
        linked_work_session_ids: [],
        work_sessions_terminated: false,
      },
      ...over,
    });

  /** 채널 기록 1~20. `lines` 에 든 seq 는 같은 자리의 중단 줄이다. */
  const history = (lines: number[]): Message[] =>
    Array.from({ length: 20 }, (_, i) => i + 1).map((seq) =>
      lines.includes(seq) ? cancelLine(seq) : msg(seq, `기록 ${seq}`)
    );

  /** 맥락 목록의 칸을 위에서부터 「행」(글쓴이가 있는 행) / 「줄」(중단 시스템 줄)로 읽는다. */
  const kindsOf = (h: HTMLElement): string[] =>
    Array.from(h.querySelector('[data-testid="inbox-context"]')?.children ?? []).map((cell) =>
      cell.querySelector('[data-testid="system-line"]') === null ? "행" : "줄"
    );

  const scrollTopOf = (h: HTMLElement): number =>
    h.querySelector<HTMLElement>('[data-testid="inbox-detail-scroll"]')!.scrollTop;

  /**
   * jsdom 은 배치를 모른다: 항목 행의 위치(900)·패널 높이(400)·행 높이(40)·스크롤 길이(1234)를 값으로 준다
   * (위의 「긴 채널 기록」 시험과 같은 방식). 항목 행(`data-target`)만 900에 있어서, 스크롤 기준이 엉뚱한 칸이면 값이 달라진다.
   */
  async function withLayout(run: () => Promise<void>): Promise<void> {
    const names = ["offsetTop", "clientHeight", "scrollHeight"] as const;
    const saved = names.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    const isBox = (el: HTMLElement) => el.dataset.testid === "inbox-detail-scroll";
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() { return (this as HTMLElement).dataset.target === "true" ? 900 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return isBox(this as HTMLElement) ? 400 : 40; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return isBox(this as HTMLElement) ? 1_234 : 0; },
    });
    try {
      await run();
    } finally {
      names.forEach((name, i) => {
        const before = saved[i];
        if (before) Object.defineProperty(HTMLElement.prototype, name, before);
        else Reflect.deleteProperty(HTMLElement.prototype, name);
      });
    }
  }

  beforeEach(() => {
    api.members.set(ME, { id: ME, kind: "human", displayName: "정하윤", handle: "hayun" });
    api.members.set(OTHER, { id: OTHER, kind: "human", displayName: "가영", handle: "gayoung" });
  });

  it("중단 줄은 행(아바타·이름·시각)이 아니라 가운데의 조용한 줄로, 서버 문장 그대로 제자리에 선다", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [
        msg(5, "배포 로그 한 번 봐 줄래요?", { authorMemberId: OTHER }),
        msg(6, "@김인턴 canary 롤아웃 이어서 해 줘"),
        cancelLine(7),
        msg(8, "일단 멈췄어요. 롤백 먼저 확인할게요"),
      ],
    });
    const h = await mount(entry({ seq: 8, messageId: "m8" }));

    // seq 순서 그대로 행 · 행 · 줄 · 행. 줄은 글쓴이가 있는 행으로 세어지지 않는다(옛 판은 행 넷이었다).
    expect(kindsOf(h)).toEqual(["행", "행", "줄", "행"]);
    const rows = Array.from(h.querySelectorAll('[data-testid="inbox-context-row"]'));
    expect(rows).toHaveLength(3);
    // 하네스가 아바타를 실제로 재고 있다는 증거: 행 셋은 모두 아바타를 든다.
    expect(rows.every((row) => row.querySelector('[data-testid="context-avatar"]') !== null)).toBe(true);

    const lines = Array.from(h.querySelectorAll<HTMLElement>('[data-testid="system-line"]'));
    expect(lines).toHaveLength(1);
    const line = lines[0] as HTMLElement;
    const cell = line.closest("li") as HTMLElement;
    // 칸의 글자가 서버 문장 하나뿐이다: 멈춘 사람의 이름(정하윤)·시각이 없고 아바타도 없다.
    expect(cell.textContent).toBe(SERVER_LINE);
    expect(cell.querySelector('[data-testid="context-avatar"]')).toBeNull();
    expect((h.textContent ?? "").split(SERVER_LINE).length - 1).toBe(1);
    // 타임라인과 같은 부품이 같은 모양으로 선다: 가운데, 안 읽음·복구 표지와 같은 여백, 물러난 잉크의 보조 글씨.
    expect(line.className).toContain("justify-center");
    expect(line.className).toContain(MARKER_DIVIDER_PAD_CLASS);
    const sentence = line.querySelector("p") as HTMLElement;
    expect(sentence.className).toContain("text-center");
    expect(sentence.className).toContain("text-meta");
    expect(sentence.className).toContain("text-ink-muted");
    // 이 창은 호버 툴바가 없다: 타임라인과 달리 툴바 straddle 띠를 비우는 여유를 받지 않는다(좁은 패널에서도 줄은 34 그대로, #5173).
    expect((sentence.parentElement as HTMLElement).className).not.toContain(SYSTEM_LINE_STRADDLE_CLEAR_CLASS);
    // 초점 정거장이 아니다: 칸 안에 단추·링크·입력·tabindex 가 하나도 없다(칸 자신도 포함).
    const stops = [cell, ...Array.from(cell.querySelectorAll("*"))].filter((el) =>
      el.matches('a, button, input, textarea, select, [tabindex], [role="button"]')
    );
    expect(stops).toEqual([]);
    // 줄 바로 뒤가 항목이어도(DM의 마지막 말) 「현재」는 그 항목 행 하나다.
    const current = Array.from(h.querySelectorAll("[aria-current]"));
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("롤백 먼저");
    expect(cell.hasAttribute("aria-current")).toBe(false);
  });

  it("항목 행 옆의 줄은 항목 행의 신원을 건드리지 않는다: aria-current·스크롤 기준·착지 면은 항목 행 하나에만 있다", async () => {
    api.fetchMessages.mockResolvedValue({ messages: history([14, 16]) });
    await withLayout(async () => {
      const h = await mount(
        entry({ key: "inbox:r1", itemId: "r1", kind: "reply", messageId: "m15", seq: 15, typeLabel: "답글 · #agent-lab" })
      );
      // 앞 4·뒤 2 창에서 줄은 메시지 한 칸을 차지한다(자르기는 종류를 가리지 않는다): 11 12 13 [14] 15 [16] 17.
      expect(kindsOf(h)).toEqual(["행", "행", "행", "줄", "행", "줄", "행"]);
      // 「현재」는 항목 행(15) 하나뿐이다.
      const current = Array.from(h.querySelectorAll<HTMLElement>("[aria-current]"));
      expect(current).toHaveLength(1);
      expect(current[0]?.dataset.testid).toBe("inbox-context-row");
      expect(current[0]?.dataset.target).toBe("true");
      expect(current[0]?.textContent).toContain("기록 15");
      // 줄의 칸은 신원 속성이 하나도 없다.
      for (const line of Array.from(h.querySelectorAll('[data-testid="system-line"]'))) {
        const cell = line.closest("li") as HTMLElement;
        expect(cell.hasAttribute("aria-current")).toBe(false);
        expect(cell.hasAttribute("data-target")).toBe(false);
        expect(cell.hasAttribute("data-highlighted")).toBe(false);
      }
      // 착지 면은 항목 행에만, 스크롤 기준도 항목 행이다(줄이 아니다): 900 - (400 - 40) / 2.
      const flashed = Array.from(h.querySelectorAll('[data-highlighted="true"]'));
      expect(flashed).toHaveLength(1);
      expect(flashed[0]?.textContent).toContain("기록 15");
      expect(flashed[0]?.classList.contains("landed-surface")).toBe(true);
      expect(scrollTopOf(h)).toBe(900 - (400 - 40) / 2);
    });
  });

  it("항목이 줄을 가리키는 방어 경로: 줄은 신원을 달지 않고, 패널은 없는 대상처럼 대화 끝으로 간다", async () => {
    // 서버 투영은 이 줄을 항목으로 만들지 않는다(migration 126: text·artifact 만). 그래도 항목이 줄을 가리키면 일어나는 일을
    // 못 박아 둔다: 눌릴 곳도 답할 곳도 없는 글줄에 「현재」 표식·착지 면을 얹지 않고, 대상을 못 찾은 때와 같은 길(끝)로 간다.
    api.fetchMessages.mockResolvedValue({ messages: history([14]) });
    await withLayout(async () => {
      const h = await mount(
        entry({ key: "inbox:r2", itemId: "r2", kind: "mention", messageId: "m14", seq: 14, typeLabel: "멘션 · #agent-lab" })
      );
      // 창은 줄을 가운데 두고 열린다(10 11 12 13 [14] 15 16), 줄은 줄로 선다.
      expect(kindsOf(h)).toEqual(["행", "행", "행", "행", "줄", "행", "행"]);
      expect(h.querySelectorAll("[aria-current], [data-target], [data-highlighted]")).toHaveLength(0);
      expect(scrollTopOf(h)).toBe(1_234);
    });
  });

  it("줄이 아닌 것은 줄로 그리지 않는다: 표식을 흉내 낸 사람 글·본문 없는 줄·지워진 줄은 글쓴이가 있는 일반 행이다", async () => {
    api.fetchMessages.mockResolvedValue({
      messages: [
        msg(5, SERVER_LINE, { type: "text", props: { kind: "agent_run_cancelled" } }),
        cancelLine(6, { body: "" }),
        cancelLine(7, { body: undefined, state: "deleted" }),
        msg(8, "나머지는 내가 이어서 볼게요"),
      ],
    });
    const h = await mount(entry({ seq: 8, messageId: "m8" }));

    expect(h.querySelectorAll('[data-testid="system-line"]')).toHaveLength(0);
    const rows = Array.from(h.querySelectorAll('[data-testid="inbox-context-row"]'));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.querySelector('[data-testid="context-avatar"]') !== null)).toBe(true);
    // 사람이 쓴 글은 표식(props.kind)을 흉내 내도 줄이 아니다(코어 판정이 type 까지 본다): 글쓴이와 문장이 그대로 선다.
    expect(rows[0]?.textContent).toContain("정하윤");
    expect(rows[0]?.textContent).toContain(SERVER_LINE);
    // 그릴 말이 없는 줄은 숨지 않고 행으로 남고, 지워진 줄은 삭제 문장이 이긴다(서버는 지울 때 본문을 비운다).
    expect(rows[1]?.textContent).toContain("정하윤");
    expect(rows[2]?.textContent).toContain("삭제된 메시지예요.");
  });
});

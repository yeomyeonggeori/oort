// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { InboxRoute } from "./InboxRoute";

// =============================================================================
// 화면 검수 3회차 L5: 결정 직후 같은 영수증 문장이 화면에 두 번 섰다(위 배너 「승인을 기록했어요.」 + 상세 줄
// 「✓ 승인을 기록했어요.」). 진짜 `InboxRoute` + 진짜 `InboxDetail` + 진짜 `InboxApprovalActions`(영수증 저장소를
// 쓰는 쪽)를 태우고, 네트워크를 건너는 `ApprovalActions` 한 겹과 서버 읽기 훅만 바꾼다.
//
// 지키는 행동(#5092 · #5116): 결정 뒤 승인·거부 0개 · 컨트롤 자리에 결과 줄 · 결과는 `role=status` 노드가 한 번 읽어
// 준다 · 원장이 답해 패널이 닫혀도 결과가 남는다. 이 시험이 더하는 것은 하나다: **눈에 보이는 문장은 한 자리**.
// 두 번 서던 이유: 배너는 결정 응답(이벤트)에서, 상세 줄은 영수증 저장소(상태)에서 같은 상수를 따로 지었다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;
const APPROVED = "승인을 기록했어요.";
const REJECTED = "거부를 기록했어요.";

vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/features/reminders/useReminders", () => ({
  useReminders: () => ({
    isLoading: false, isError: false, data: { reminders: [] }, dataUpdatedAt: NOW, refetch: () => undefined,
  }),
}));
vi.mock("@/features/workspace/useWorkspace", async (original) => ({
  ...(await original<typeof import("@/features/workspace/useWorkspace")>()),
  memberFor: () => null,
  useChannels: () => ({ groups: { channels: [], dms: [] } }),
}));
vi.mock("@/features/timeline/MessageRow", () => ({ Avatar: () => null }));
vi.mock("@/features/timeline/MessageBody", () => ({
  MessageBody: ({ body }: { body: string }) => createElement("span", null, body),
}));
vi.mock("@/features/timeline/ThreadComposer", () => ({ ThreadComposer: () => null }));

// 서버로 나가는 결정 컨트롤만 바꾼다: 누르면 `onSettled`가 지정한 결과로 닿는다.
const settleWith = vi.hoisted(() => ({ outcome: null as null | Record<string, unknown> }));
vi.mock("@/features/timeline/ApprovalActions", () => ({
  ApprovalActions: ({ approvalId, onSettled }: { approvalId: string; onSettled: (outcome: DecisionOutcome) => void }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "inbox-approval-approve",
        "data-id": approvalId,
        onClick: () => onSettled(settleWith.outcome as unknown as DecisionOutcome),
      },
      "승인"
    ),
}));

const state = { entries: [] as MailboxEntry[], ledgerAnswered: false };
vi.mock("./useMailbox", () => ({
  useMailbox: () => ({
    source: "composed", serverUnreadCount: null, hasMore: false, isFetchingMore: false, moreError: false,
    fetchMore: () => undefined, entries: state.entries, isLoading: false, error: false, tasksAbsent: false,
    ledgerAnswered: state.ledgerAnswered, capped: false, updatedAtMs: NOW, refetch: () => undefined,
  }),
  useMailboxReadActions: () => ({
    markRead: () => Promise.resolve(), markUnread: () => Promise.resolve(),
    markAllRead: () => Promise.resolve({ marked: 0, unreadCount: 0 }),
  }),
}));
vi.mock("./useInbox", () => ({
  useNeedsAction: () => ({ items: [], isLoading: false, error: false, absent: false, updatedAtMs: NOW, refetch: () => undefined }),
  useFeedContext: () => ({
    directory: { members: [], byId: new Map() }, labelFor: (id: string) => id,
    actorFor: () => ({ name: "x", isAgent: false }), isLoading: false,
  }),
  useMentionCount: () => 0,
  useUnreadMentionChannels: () => [],
  useMarkRead: () => () => undefined,
  useInvalidateApprovals: () => () => undefined,
}));

function task(approvalId: string): FeedItem {
  return {
    key: `approval:${approvalId}`, kind: "approval", tone: "warn", actor: "@kim-intern", actorIsAgent: true,
    predicate: "세션 종료 허가를 요청했어요", outcome: null, outcomeTone: "muted", channelId: CH,
    channelLabel: "#workbench", timeLabel: "5분 후 만료", sortAtMs: NOW, pending: true, reason: "r", approvalId,
    expiresAtMs: undefined,
  } as FeedItem;
}
function taskEntry(approvalId: string): MailboxEntry {
  return {
    key: `approval:${approvalId}`, kind: "task", channelId: CH, channelLabel: "#workbench", typeLabel: "처리할 일",
    actor: "@kim-intern", actorIsAgent: true, preview: "p", atMs: NOW, timeLabel: "방금", unread: true,
    unreadCount: 0, reason: "r", task: task(approvalId),
  };
}

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
function tree(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(
    QueryClientProvider, { client },
    createElement(SessionProvider, { value: session() }, createElement(MemoryRouter, { initialEntries: ["/inbox"] }, createElement(InboxRoute)))
  );
}
async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(tree()); await Promise.resolve(); });
  return host;
}
async function rerender(): Promise<void> {
  await act(async () => { root?.render(tree()); await Promise.resolve(); });
}
const byId = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

/** 눈에 보이는 자리의 수: 문장을 **자기 글 노드**로 가진 요소 가운데 「패널이 말함」(`data-said-in-pane`) 안이 아닌 것. */
function drawn(sentence: string): number {
  let count = 0;
  host?.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("");
    if (own.includes(sentence) && el.closest("[data-said-in-pane]") === null) count += 1;
  });
  return count;
}
async function decideFirstRow(): Promise<void> {
  await act(async () => { (host?.querySelector('[data-testid="mailbox-row"]') as HTMLElement).click(); await Promise.resolve(); });
  await act(async () => { byId("inbox-approval-approve")?.click(); await Promise.resolve(); });
}

beforeAll(() => { env.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  resetSettledApprovalsForTest();
  state.entries = [taskEntry("a1"), taskEntry("a2")];
  state.ledgerAnswered = false;
  settleWith.outcome = { kind: "committed", status: "approved", decidedAtMs: NOW, decidedByMemberId: ME };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetSettledApprovalsForTest();
  vi.unstubAllGlobals();
});

describe("인박스 결정 영수증: 눈에 보이는 문장은 한 자리 (L5)", () => {
  it("결정 직후 같은 문장이 배너와 상세 줄에서 두 번 서지 않는다", async () => {
    await mount();
    await decideFirstRow();

    // 지키는 행동: 컨트롤은 사라졌고, 컨트롤 자리에 결과가 서고, `role=status` 노드가 결과를 읽어 준다.
    expect(byId("inbox-approval-approve")).toBeNull();
    expect(byId("inbox-approval-settled")?.textContent).toContain(APPROVED);
    const note = byId("inbox-decision-note");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toContain(APPROVED);
    // 새 단정: 눈에 보이는 문장은 정확히 하나. 위에서 두 노드(배너 · 상세 줄)가 모두 DOM에 있음을 이미 보았으므로,
    // 이 단정은 「둘 중 하나만 그려진다」가 아니라 「둘이 있되 눈에 보이는 것은 하나」를 잰다.
    expect(drawn(APPROVED)).toBe(1);
  });

  it("거부도 같다: 거부 영수증이 눈에 보이는 자리는 하나다", async () => {
    settleWith.outcome = { kind: "committed", status: "rejected", decidedAtMs: NOW, decidedByMemberId: ME };
    await mount();
    await decideFirstRow();
    expect(byId("inbox-approval-settled")?.textContent).toContain(REJECTED);
    expect(byId("inbox-decision-note")?.textContent).toContain(REJECTED);
    expect(drawn(REJECTED)).toBe(1);
  });

  it("원장이 답해 패널이 닫히면 같은 노드가 눈에 보이게 올라온다: 다시 만들어지지 않아 낭독은 한 번이고, 닫기가 선다", async () => {
    await mount();
    await decideFirstRow();
    const before = byId("inbox-decision-note");
    expect(before).not.toBeNull();
    // 패널이 상세 줄로 말하는 동안에는 닫기 단추가 없다(보이지 않는 단추에 초점이 앉지 않게).
    expect(before?.querySelector("button")).toBeNull();

    state.entries = [taskEntry("a2")];
    state.ledgerAnswered = true;
    await rerender();

    expect(byId("inbox-detail")).toBeNull();
    const after = byId("inbox-decision-note");
    expect(after).toBe(before);
    expect(drawn(APPROVED)).toBe(1);
    expect(after?.closest("[data-said-in-pane]")).toBeNull();
    const close = after?.querySelector("button");
    expect(close?.textContent).toBe("닫기");
    await act(async () => { close?.click(); await Promise.resolve(); });
    expect(byId("inbox-decision-note")).toBeNull();
    expect(drawn(APPROVED)).toBe(0);
  });

  it("다른 문장은 접지 않는다: 이미 결정되어 있던 요청의 안내는 배너로 그대로 선다", async () => {
    settleWith.outcome = { kind: "superseded", status: "rejected" };
    await mount();
    await decideFirstRow();
    // 상세 줄은 영수증 저장소의 상태(거부)를 말하고, 배너는 이 클릭의 결과(이미 거부로 기록됨)를 말한다: 문장이 달라 둘 다 선다.
    expect(byId("inbox-decision-note")?.textContent).toContain("이미 거부로 기록되어 있었어요.");
    expect(byId("inbox-decision-note")?.closest("[data-said-in-pane]")).toBeNull();
    expect(drawn("이미 거부로 기록되어 있었어요.")).toBe(1);
  });
});

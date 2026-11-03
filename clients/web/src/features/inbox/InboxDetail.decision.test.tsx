// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import {
  rememberSettledApproval,
  resetSettledApprovalsForTest,
} from "@/features/timeline/settledApprovals";
import { InboxDetail } from "./InboxDetail";

// =============================================================================
// 결정한 승인의 패널 (#5092 D1). 인박스 패널은 고른 줄의 스냅샷을 들고 있어서 원장이 그 행을
// 대기에서 뺀 뒤에도 같은 `approvalId`로 남는다. 그 스냅샷에 승인·거부가 다시 서면 이미 결정된
// 건에 두 번째 결정이 나간다(서버는 409). 여기서 진짜 `InboxDetail`과 진짜 `InboxApprovalActions`
// (영수증 저장소를 쓰는 쪽)를 태우고, 네트워크를 건너는 `ApprovalActions` 한 겹만 바꾼다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;

vi.mock("@/features/workspace/useWorkspace", () => ({
  memberFor: () => null,
  useChannels: () => ({ groups: { channels: [], dms: [] } }),
}));
vi.mock("@/features/timeline/MessageRow", () => ({ Avatar: () => null }));
vi.mock("@/features/timeline/MessageBody", () => ({
  MessageBody: ({ body }: { body: string }) => createElement("span", null, body),
}));
vi.mock("@/features/timeline/ThreadComposer", () => ({ ThreadComposer: () => null }));
// 서버로 나가는 결정 컨트롤만 바꾼다: 누르면 `onSettled`가 지정한 결과로 닿는다. 영수증을 적는 곳은
// 진짜 `InboxApprovalActions`, 패널의 반응은 진짜 `InboxDetail`이다.
const settleWith = vi.hoisted(() => ({ outcome: null as null | Record<string, unknown> }));
vi.mock("@/features/timeline/ApprovalActions", () => ({
  ApprovalActions: ({
    approvalId,
    onSettled,
  }: {
    approvalId: string;
    onSettled: (outcome: DecisionOutcome) => void;
  }) =>
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

function task(approvalId: string): FeedItem {
  return {
    key: `approval:${approvalId}`, kind: "approval", tone: "warn", actor: "@kim-intern",
    actorIsAgent: true, predicate: "세션 종료 허가를 요청했어요", outcome: null,
    outcomeTone: "muted", channelId: CH, channelLabel: "#workbench", timeLabel: "5분 후 만료",
    sortAtMs: NOW, pending: true, reason: "r", approvalId, expiresAtMs: undefined,
  } as FeedItem;
}

function taskEntry(approvalId: string): MailboxEntry {
  return {
    key: `approval:${approvalId}`, kind: "task", channelId: CH, channelLabel: "#workbench",
    typeLabel: "처리할 일", actor: "@kim-intern", actorIsAgent: true, preview: "p", atMs: NOW,
    timeLabel: "방금", unread: true, unreadCount: 0, reason: "r", task: task(approvalId),
  };
}

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
const onDecided = vi.fn();

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

async function mount(entry: MailboxEntry): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider, { client },
        createElement(SessionProvider, { value: session() },
          createElement(MemoryRouter, null,
            createElement(InboxDetail, {
              entry, directory: { members: [], byId: new Map() } as never, offline: false,
              onToggleRead: () => undefined, onDecided, readBusy: false,
            })))
      )
    );
  });
  return host;
}

function unmount(): void {
  if (root) act(() => root?.unmount());
  root = null; host?.remove(); host = null;
}

beforeAll(() => { env.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  resetSettledApprovalsForTest();
  onDecided.mockClear();
  settleWith.outcome = {
    kind: "committed", status: "approved", decidedAtMs: NOW, decidedByMemberId: ME,
  };
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  unmount();
  resetSettledApprovalsForTest();
  vi.unstubAllGlobals();
});

describe("InboxDetail: 결정한 승인 (#5092 D1)", () => {
  it("결정이 닿으면 승인·거부 컨트롤은 사라지고 결정 결과가 서며 초점은 패널이 받는다", async () => {
    const h = await mount(taskEntry("a1"));
    const approve = h.querySelector<HTMLButtonElement>('[data-testid="inbox-approval-approve"]')!;
    expect(approve.getAttribute("data-id")).toBe("a1");
    approve.focus();
    expect(document.activeElement).toBe(approve);

    await act(async () => {
      approve.click();
      await Promise.resolve();
    });

    // 누른 컨트롤은 그 자리에 없다: 한 번 더 누를 길이 없다.
    expect(h.querySelector('[data-testid="inbox-approval-approve"]')).toBeNull();
    // 컨트롤 자리에는 원장에 적힌 결과가 선다(「승인을 기록했어요.」, 라이브 리전이 아니다).
    const settled = h.querySelector('[data-testid="inbox-approval-settled"]');
    expect(settled?.textContent).toContain("승인을 기록했어요.");
    expect(settled?.getAttribute("role")).toBeNull();
    // 초점은 사라진 버튼이 아니라 패널이 받는다(body로 버려지지 않는다).
    const panel = h.querySelector('[data-testid="inbox-detail"]');
    expect(document.activeElement).toBe(panel);
    // 라우트의 영수증 줄이 이 결정을 한 번 알린다.
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(onDecided.mock.calls[0]?.[0]).toMatchObject({ kind: "committed", status: "approved" });
  });

  it("이미 결정한 승인은 스냅샷으로 다시 열어도 컨트롤이 서지 않고, 다른 승인에는 번지지 않는다", async () => {
    rememberSettledApproval("a1", { status: "rejected", decidedAtMs: NOW });

    const decided = await mount(taskEntry("a1"));
    expect(decided.querySelector('[data-testid="inbox-approval-approve"]')).toBeNull();
    expect(decided.querySelector('[data-testid="inbox-approval-settled"]')?.textContent).toContain(
      "거부를 기록했어요."
    );
    // 열기만 한 것은 초점을 가져가지 않는다: 초점은 결정이 닿는 순간에만 옮겨 간다.
    expect(document.activeElement).toBe(document.body);
    unmount();

    // 같은 영수증 저장소를 보는 다른 승인은 그대로 대기다.
    const other = await mount(taskEntry("a2"));
    expect(other.querySelector('[data-testid="inbox-approval-approve"]')?.getAttribute("data-id")).toBe("a2");
    expect(other.querySelector('[data-testid="inbox-approval-settled"]')).toBeNull();
  });
});

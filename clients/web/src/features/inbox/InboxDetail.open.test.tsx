// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { taskEntry, type MailboxEntry } from "@momo/core/features/inbox/mailbox";
import { approvalItem, type ActorNames } from "@momo/core/features/inbox/model";
import type { Approval } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { rememberSettledApproval, resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { InboxDetail } from "./InboxDetail";

// =============================================================================
// 받은함 오른쪽 칸의 「처리할 일」: 카드로 보내는 승인 (#5462, planner 2026-11-07).
//
// 이모티콘 세트의 계획 카드(`expression.set.plan`)와 세트 카드(`expression.set.create`)는 받은함의 일반 승인 단추로 확정하지 않는다
// (계획 카드는 썸네일·장수·고지를 본 채로 눌러야 하고, 세트 카드는 칸을 골라야 한다). 두 행동의 칸은 승인·거부 대신 「열기」 하나이고,
// 누르면 「대화에서 보기」와 같은 자리, 곧 그 대화의 그 카드로 간다. 다른 행동의 칸은 그대로다.
//
// 진짜 `InboxDetail`·`InboxApprovalActions`·`approvalItem`·`taskEntry`를 태우고, 네트워크를 건너는 `ApprovalActions` 한 겹만 바꾼다. 바꾼
// 겹은 진짜와 같은 시험 id(`<접두>-approve`·`<접두>-reject`)로 두 단추를 그려서, 단추가 서면 아래 단정이 잡는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const CARD = "0199AA11-2222-7000-8000-0000000000D1";
const NOW = 1_800_000_000_000;
const AGENT: ActorNames = { name: "오르트 도우미", handle: "oort", isAgent: true, ownerName: "곽성재" };

vi.mock("@/features/workspace/useWorkspace", () => ({
  memberFor: () => null,
  useChannels: () => ({ groups: { channels: [], dms: [] } }),
}));
vi.mock("@/features/timeline/MessageRow", () => ({ Avatar: () => null }));
vi.mock("@/features/timeline/MessageBody", () => ({
  MessageBody: ({ body }: { body: string }) => createElement("span", null, body),
}));
vi.mock("@/features/timeline/ThreadComposer", () => ({ ThreadComposer: () => null }));
vi.mock("@/features/timeline/ApprovalActions", () => ({
  ApprovalActions: ({ approvalId, testIdPrefix }: { approvalId: string; testIdPrefix: string }) =>
    createElement(
      "div",
      { "data-testid": `${testIdPrefix}-actions`, "data-id": approvalId },
      createElement("button", { type: "button", "data-testid": `${testIdPrefix}-reject` }, "거부"),
      createElement("button", { type: "button", "data-testid": `${testIdPrefix}-approve` }, "승인")
    ),
}));

function entryFor(workspaceActionId: string, decisionMode?: "inline" | "open", id = "a1"): MailboxEntry {
  const approval: Approval = {
    id,
    workspaceId: WS,
    runId: "00000000-0000-7000-8000-000000000301",
    channelId: CH,
    requestMessageId: CARD,
    requestedBy: "00000000-0000-7000-8000-000000000102",
    actionType: "workspace_action",
    workspaceActionId,
    status: "pending",
    expiresAtMs: NOW + 600_000,
    ...(decisionMode === undefined ? {} : { decisionMode }),
  };
  const entry = taskEntry(approvalItem(approval, AGENT, "#emoji", NOW), NOW);
  if (entry === null) throw new Error("대기 중인 승인은 처리할 일이 된다");
  return entry;
}

/** 「대화에서 보기」와 「열기」가 가야 하는 자리: 그 카드의 메시지 앵커. */
const CARD_PATH = `/c/${CH}?msg=${CARD.toLowerCase()}`;

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "나", handle: "me" },
      realtimeWebSocketUrl: "wss://x.test/ws",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as SessionContextValue;
}

function Where() {
  const location = useLocation();
  return createElement("output", { "data-testid": "where" }, `${location.pathname}${location.search}`);
}

async function mount(entry: MailboxEntry, offline = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      createElement(
        LocaleProvider,
        { locale: korean },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session() },
            createElement(
              MemoryRouter,
              { initialEntries: ["/inbox"] },
              createElement(InboxDetail, {
                entry,
                directory: { members: [], byId: new Map() } as never,
                offline,
                onToggleRead: () => undefined,
                onDecided: () => undefined,
                readBusy: false,
              }),
              createElement(Where)
            )
          )
        )
      )
    );
  });
  return host;
}

function unmount(): void {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

const byId = (h: HTMLElement, id: string) => Array.from(h.querySelectorAll(`[data-testid="${id}"]`));
/** 이 칸에서 누를 수 있는 것의 글자(단추와 링크). */
const pressables = (h: HTMLElement) =>
  Array.from(h.querySelectorAll("button, a")).map((node) => node.textContent?.trim() ?? "");

beforeAll(async () => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  resetSettledApprovalsForTest();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});
afterEach(() => {
  unmount();
  resetSettledApprovalsForTest();
  vi.unstubAllGlobals();
});

describe("InboxDetail: 카드로 보내는 승인은 열기만 선다 (#5462)", () => {
  it.each([
    ["계획 카드", "expression.set.plan"],
    ["세트 카드", "expression.set.create"],
  ])("%s: 승인 단추 0, 거부 단추 0, 열기 1 — 서버가 값을 안 실어도 inline 이라 해도 같다", async (_name, actionId) => {
    for (const mode of [undefined, "inline", "open"] as const) {
      const h = await mount(entryFor(actionId, mode));
      expect(byId(h, "inbox-approval-approve"), `승인 단추 (서버 ${mode ?? "값 없음"})`).toHaveLength(0);
      expect(byId(h, "inbox-approval-reject"), `거부 단추 (서버 ${mode ?? "값 없음"})`).toHaveLength(0);
      const open = byId(h, "inbox-approval-open");
      expect(open, `열기 (서버 ${mode ?? "값 없음"})`).toHaveLength(1);
      expect(open[0]?.textContent).toBe("열기");
      // 이 칸이 말하는 누를 것은 「열기」와 머리의 「대화에서 보기」뿐이다.
      expect(pressables(h).filter((text) => text === "승인" || text === "거부")).toEqual([]);
      unmount();
    }
  });

  it("열기는 「대화에서 보기」와 같은 자리, 곧 그 대화의 그 카드를 가리키고 누르면 거기로 간다", async () => {
    const h = await mount(entryFor("expression.set.plan"));
    const open = byId(h, "inbox-approval-open")[0] as HTMLAnchorElement;
    const conversation = byId(h, "inbox-open-conversation")[0] as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(CARD_PATH);
    expect(open.getAttribute("href")).toBe(conversation.getAttribute("href"));
    expect(byId(h, "where")[0]?.textContent).toBe("/inbox");

    await act(async () => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    expect(byId(h, "where")[0]?.textContent).toBe(CARD_PATH);
  });

  it("열기는 연결이 끊겨도 서 있다 — 오프라인 줄로 대신하지 않는다", async () => {
    const h = await mount(entryFor("expression.set.create"), true);
    expect(byId(h, "inbox-approval-open")).toHaveLength(1);
    expect(byId(h, "inbox-approval-offline")).toHaveLength(0);
  });

  it("이미 결정한 승인에는 열기가 서지 않고 결정 결과가 선다", async () => {
    rememberSettledApproval("a1", { status: "approved", decidedAtMs: NOW });
    const h = await mount(entryFor("expression.set.plan"));
    expect(byId(h, "inbox-approval-open")).toHaveLength(0);
    expect(byId(h, "inbox-approval-approve")).toHaveLength(0);
    expect(byId(h, "inbox-approval-settled")[0]?.textContent).toContain("승인을 기록했어요.");
  });

  it("다른 행동은 그대로다: 승인·거부 단추가 서고 열기는 없다 (서버 값이 없거나 inline)", async () => {
    for (const mode of [undefined, "inline"] as const) {
      const h = await mount(entryFor("channel.create", mode, "b1"));
      expect(byId(h, "inbox-approval-approve"), `승인 (서버 ${mode ?? "값 없음"})`).toHaveLength(1);
      expect(byId(h, "inbox-approval-reject"), `거부 (서버 ${mode ?? "값 없음"})`).toHaveLength(1);
      expect(byId(h, "inbox-approval-open"), `열기 (서버 ${mode ?? "값 없음"})`).toHaveLength(0);
      expect(byId(h, "inbox-approval-actions")[0]?.getAttribute("data-id")).toBe("b1");
      unmount();
    }
  });

  it("서버가 open 을 찍은 다른 행동도 열기만 선다 (둘 중 하나라도 open 이면 연다)", async () => {
    const h = await mount(entryFor("channel.create", "open", "c1"));
    expect(byId(h, "inbox-approval-approve")).toHaveLength(0);
    expect(byId(h, "inbox-approval-reject")).toHaveLength(0);
    expect(byId(h, "inbox-approval-open")).toHaveLength(1);
  });
});

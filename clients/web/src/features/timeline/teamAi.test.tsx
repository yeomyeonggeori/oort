// @vitest-environment jsdom
// ADR-0201 (#3836): 도우미 카드의 제안자 표기, 넘기는 줄의 「○○에게 맡기기」.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import { parseTeamAiDelegate } from "@momo/core/features/timeline/teamAi";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { AgentCard } from "./AgentCard";
import { MessageRow } from "./MessageRow";
import { TeamAiDelegateStrip } from "./TeamAiDelegateStrip";
import { resetSettledApprovalsForTest } from "./settledApprovals";

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, sendMessage };
});
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000001aa";
const HELPER = "00000000-0000-7000-8000-000000000301";
const GROK = "00000000-0000-7000-8000-000000000302";
const SOURCE = "00000000-0000-7000-8000-0000000004a1";
const DELEGATE_KEY = "0e5fa1d0-c0de-5201-9d00-7e4a11a12023";

function roster(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    role: "member",
    displayName,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const DIRECTORY = makeDirectory([
  roster(ME, "human", "곽성재", "seongjae"),
  roster(OTHER, "human", "김하늘", "haneul"),
  roster(HELPER, "agent", "oort 도우미", "oort-helper"),
  roster(GROK, "agent", "그록봇", "grokbot"),
]);

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
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
});

beforeEach(() => {
  resetSettledApprovalsForTest();
  sendMessage.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(
            OpenMemberProfileContext.Provider,
            { value: () => undefined },
            createElement(QueryClientProvider, { client }, node)
          )
        )
      )
    );
  });
  return host;
}

function message(over: Partial<Message>): Message {
  return {
    id: "00000000-0000-7000-8000-0000000004b1",
    channelId: CH,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: HELPER,
    type: "text",
    body: null,
    state: "sent",
    createdAtMs: 1_760_000_000_000,
    ...over,
  } as Message;
}

// 서버 `propose_in_tx` (PR #3837) 가 싣는 모양.
function approvalProps(withVia: boolean): Record<string, unknown> {
  return {
    approval_id: "00000000-0000-7000-8000-0000000005a1",
    action_type: "workspace_action",
    status: "pending",
    title: "채널 만들기",
    action: {
      id: "channel.create",
      rows: [{ label: "채널 이름", value: "ideas" }],
      rationale: "아이디어 채널을 만들어 달라고 했어요",
      required_role: "member",
    },
    ...(withVia
      ? { proposed_via: { kind: "team_ai", requester_id: OTHER, requester_name: "서버가 쓴 이름" } }
      : {}),
  };
}

function mountApproval(withVia: boolean): HTMLElement {
  const card = agentCardModel(message({ type: "approval_request", props: approvalProps(withVia) }));
  if (card === null) throw new Error("no card");
  const view = mount(createElement(AgentCard, { card, directory: DIRECTORY }));
  openDetails(view);
  return view;
}

function openDetails(view: HTMLElement) {
  const details = view.querySelector<HTMLDetailsElement>('[data-testid="request-bundle-details"]')!;
  act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
}

describe("도우미 승인 카드 (ADR-0201 D6-3)", () => {
  it("누가 부탁했는지와 사유가 AI 글이라는 것을 결정 전에 말한다", () => {
    const view = mountApproval(true);
    const row = view.querySelector('[data-testid="approval-team-ai"]');
    // 디렉터리 이름이 서버가 박은 이름보다 먼저다.
    expect(row?.textContent).toContain("도우미 제안 · 요청: 김하늘");
    expect(row?.textContent).toContain("승인한 사람의 권한으로 실행돼요");
    const rationale = view.querySelector('[data-testid="approval-action-rationale"]');
    expect(rationale?.querySelector("dt")?.textContent).toBe("도우미가 쓴 사유");
    expect(view.querySelector('[data-testid="approval-team-ai-rationale-note"]')).not.toBeNull();
  });

  it("도우미가 아닌 카드는 한 글자도 달라지지 않는다", () => {
    const view = mountApproval(false);
    expect(view.querySelector('[data-testid="approval-team-ai"]')).toBeNull();
    const rationale = view.querySelector('[data-testid="approval-action-rationale"]');
    expect(rationale?.querySelector("dt")?.textContent).toBe("사유");
    expect(view.querySelector('[data-testid="approval-team-ai-rationale-note"]')).toBeNull();
  });
});

// 서버 `fallback_props` (PR #3837) 가 싣는 모양.
const DELEGATE_PROPS = {
  source: "team_ai_fallback",
  kind: "team_ai.delegate.v1",
  reason: "out_of_scope",
  agent_member_id: HELPER,
  notice_for_member_id: ME,
  run_id: "00000000-0000-7000-8000-0000000006a1",
  delegate: {
    source_message_id: SOURCE,
    candidates: [
      { member_id: GROK, handle: "grokbot", display_name: "그록봇", client_msg_id: DELEGATE_KEY },
    ],
  },
};

function mountStrip(viewer: string | undefined, sourceBody: string | null): HTMLElement {
  const delegate = parseTeamAiDelegate(DELEGATE_PROPS);
  if (delegate === null) throw new Error("no delegate");
  return mount(
    createElement(TeamAiDelegateStrip, {
      delegate,
      workspaceId: WS,
      channelId: CH,
      authorMemberId: HELPER,
      viewerMemberId: viewer,
      sourceBody,
      directory: DIRECTORY,
    })
  );
}

describe("「그록봇에게 맡기기」 (ADR-0201 D5)", () => {
  it("요청자에게 버튼이 서고, 누르면 도우미 멘션을 뺀 원래 요청을 그록봇에게 보낸다", async () => {
    sendMessage.mockResolvedValue({});
    const view = mountStrip(ME, "@oort-helper 이 레포 테스트 고쳐 줘");
    expect(view.querySelector('[data-testid="team-ai-delegate-reason"]')?.textContent).toBe(
      "넘긴 이유: 도우미가 바로 하기엔 큰 일"
    );
    const button = view.querySelector<HTMLButtonElement>('[data-testid="team-ai-delegate-button"]');
    expect(button?.textContent).toBe("그록봇에게 맡기기");
    await act(async () => {
      button?.click();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      WS,
      CH,
      DELEGATE_KEY,
      "@grokbot 이 레포 테스트 고쳐 줘",
      { replyToId: SOURCE }
    );
    expect(view.querySelector('[data-testid="team-ai-delegate-sent"]')?.textContent).toContain(
      "그록봇에게 맡겼어요"
    );
  });

  it("보내는 동안 다시 눌러도 두 번 보내지 않고, 다시 보낼 때도 같은 키를 쓴다", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    sendMessage.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        fail = reject;
      })
    );
    const view = mountStrip(ME, "채널 만들어 줘");
    const button = () =>
      view.querySelector<HTMLButtonElement>('[data-testid="team-ai-delegate-button"]');
    await act(async () => {
      button()?.click();
    });
    await act(async () => {
      button()?.click();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      fail(new Error("offline"));
    });
    expect(view.querySelector('[data-testid="team-ai-delegate-error"]')).not.toBeNull();
    sendMessage.mockResolvedValueOnce({});
    await act(async () => {
      button()?.click();
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[2]).toBe(DELEGATE_KEY);
  });

  // #3844 design-review H-2: 누른 버튼이 사라져도 키보드 초점이 body 로 떨어지지 않는다.
  it("키보드로 맡기면 초점이 「맡겼어요」 줄로 옮겨 간다", async () => {
    sendMessage.mockResolvedValue({});
    const view = mountStrip(ME, "채널 만들어 줘");
    const button = view.querySelector<HTMLButtonElement>('[data-testid="team-ai-delegate-button"]');
    button?.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => {
      button?.click();
    });
    const sent = view.querySelector('[data-testid="team-ai-delegate-sent"]');
    expect(sent).not.toBeNull();
    expect(document.activeElement).toBe(sent);
  });

  it("요청자가 아닌 사람에게는 버튼이 없다 (이유 줄만)", () => {
    const view = mountStrip(OTHER, "채널 만들어 줘");
    expect(view.querySelector('[data-testid="team-ai-delegate-button"]')).toBeNull();
    expect(view.querySelector('[data-testid="team-ai-delegate-reason"]')).not.toBeNull();
  });

  it("행은 서버가 보낸 이유 문장을 본문으로 두고 그 아래 줄을 세운다", () => {
    const view = mount(
      createElement(MessageRow, {
        message: message({
          body: "이건 제가 바로 처리하기엔 큰 일이에요. 다른 에이전트에게 맡길 수 있어요.",
          props: DELEGATE_PROPS,
          replyToId: SOURCE,
        }),
        startsGroup: true,
        directory: DIRECTORY,
      })
    );
    expect(view.textContent).toContain("이건 제가 바로 처리하기엔 큰 일이에요.");
    expect(view.querySelector('[data-testid="team-ai-delegate"]')).not.toBeNull();
    // `actions` 가 없는 읽기 전용 표면에는 버튼이 없다.
    expect(view.querySelector('[data-testid="team-ai-delegate-button"]')).toBeNull();
  });

  it("이 키를 모르는 줄에는 아무 것도 세우지 않는다", () => {
    const view = mount(
      createElement(MessageRow, {
        message: message({ body: "안녕하세요", props: { source: "team_ai" } }),
        startsGroup: true,
        directory: DIRECTORY,
      })
    );
    expect(view.querySelector('[data-testid="team-ai-delegate"]')).toBeNull();
  });
});

// ADR-0201 증보 v2 (#3893): 도우미 답의 꼬리와 새 설정 카드.
describe("도우미 답의 꼬리 (v2 H4·H5·H9-I9)", () => {
  const V2_REPLY = {
    source: "team_ai",
    run_id: "00000000-0000-7000-8000-0000000006b1",
    model_label: "Claude Sonnet 4.5",
    tools_used: [{ name: "search_messages" }, { name: "read_channel", channel: "마케팅" }, { name: "web_search" }],
    web_citations: [
      { url: "https://www.example.com/rust-2026", title: "Rust 2026 로드맵" },
      { url: "javascript:alert(1)", title: "나쁜 주소" },
    ],
  };

  it("찾아본 것 · 모델 칩 · 출처 링크를 본문 아래에 세운다", () => {
    const view = mount(
      createElement(MessageRow, {
        message: message({ body: "지난주 마케팅 채널에서 정한 건 세 가지예요.", props: V2_REPLY }),
        startsGroup: true,
        directory: DIRECTORY,
      })
    );
    expect(view.querySelector('[data-testid="team-ai-tools-line"]')?.textContent).toContain(
      "찾아본 것: 메시지 검색 · #마케팅 읽기 · 웹 검색"
    );
    expect(view.querySelector('[data-testid="team-ai-model-chip"]')?.textContent).toBe(
      "팀 AI · Claude Sonnet 4.5"
    );
    const links = view.querySelectorAll<HTMLAnchorElement>('[data-testid="team-ai-citation"]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://www.example.com/rust-2026");
    expect(links[0].getAttribute("rel")).toBe("noreferrer noopener");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("aria-label")).toBe("Rust 2026 로드맵, example.com, 새 창에서 열기");
  });

  it("칸이 없는 도우미 답(옛 서버)에는 꼬리가 없다", () => {
    const view = mount(
      createElement(MessageRow, {
        message: message({ body: "안녕하세요", props: { source: "team_ai", run_id: "r" } }),
        startsGroup: true,
        directory: DIRECTORY,
      })
    );
    expect(view.querySelector('[data-testid="team-ai-reply-meta"]')).toBeNull();
  });
});

describe("도우미의 워크스페이스 설정 카드 (v2 H6-1)", () => {
  function mountAction(id: string): HTMLElement {
    const card = agentCardModel(
      message({
        type: "approval_request",
        props: {
          approval_id: "00000000-0000-7000-8000-0000000005b1",
          action_type: "workspace_action",
          status: "pending",
          title: "링크 미리보기 끄기",
          action: {
            id,
            rows: [{ label: "링크 미리보기", value: "켜짐 → 꺼짐" }],
            rationale: "링크 카드가 너무 커서 꺼 달라고 했어요",
            required_role: "workspace_operator",
          },
          proposed_via: { kind: "team_ai", requester_id: OTHER, requester_name: "김하늘" },
        },
      })
    );
    if (card === null) throw new Error("no card");
    return mount(createElement(AgentCard, { card, directory: DIRECTORY }));
  }

  it("설정 액션 카드는 서버 행 아래에 「적용 범위: 워크스페이스 전체」를 말한다", () => {
    const view = mountAction("workspace.unfurl.update");
    openDetails(view);
    const row = view.querySelector('[data-testid="approval-workspace-wide"]');
    expect(row?.querySelector("dt")?.textContent).toBe("적용 범위");
    expect(row?.textContent).toContain("워크스페이스 전체");
    expect(row?.textContent).toContain("승인하면 모든 멤버에게 바로 적용돼요.");
    expect(view.querySelector('[data-testid="approval-action-row"]')?.textContent).toContain("켜짐 → 꺼짐");
  });

  it("채널 하나에 닿는 행동에는 그 줄이 없다", () => {
    const view = mountAction("channel.create");
    expect(view.querySelector('[data-testid="approval-workspace-wide"]')).toBeNull();
  });
});

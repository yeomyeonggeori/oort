// @vitest-environment jsdom
// 「쓴 앱」 꼬리와 막힘 문장 (ADR-0113 증보 2 E8·E10, #3950 U-S2): 행에 실제로 배선됐는가.
// 코어가 문장을 정하고(teamAiReply.test.ts · appNotice.test.ts), 여기서는 데이터가 모이는
// 길과 화면의 모양을 못으로 박는다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import type { Message, PluginCatalog, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MessageRow } from "./MessageRow";
import { ChannelAudienceContext } from "./appsTail";
import { resetSettledApprovalsForTest } from "./settledApprovals";

const listPlugins = vi.hoisted(() => vi.fn());
const fetchAgentRunDetail = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, listPlugins, fetchAgentRunDetail };
});
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000001aa";
const HERMES = "00000000-0000-7000-8000-000000000302";
const TRIGGER = "00000000-0000-7000-8000-0000000004a1";
const RUN = "00000000-0000-7000-8000-0000000006b1";

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
  roster(HERMES, "agent", "Hermes", "hermes"),
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

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
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

const GMAIL = {
  pluginId: "gmail",
  name: "Gmail",
  version: "1",
  description: "",
  official: true,
  recommended: true,
  egressDomains: ["gmailmcp.googleapis.com"],
  recommendedFor: [],
  installed: true,
  enabled: true,
};
const catalog = (installed: boolean): PluginCatalog => ({
  plugins: [{ ...GMAIL, installed }],
  toolsByPlugin: new Map(),
});

beforeEach(() => {
  resetSettledApprovalsForTest();
  listPlugins.mockReset();
  fetchAgentRunDetail.mockReset();
  listPlugins.mockResolvedValue(catalog(true));
  fetchAgentRunDetail.mockResolvedValue({
    appsUsed: [{ pluginId: "gmail", tool: "search_threads", calls: 2 }],
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount(node: ReactElement, audience: number | null = null): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
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
            createElement(
              QueryClientProvider,
              { client },
              createElement(ChannelAudienceContext.Provider, { value: audience }, node)
            )
          )
        )
      )
    );
  });
  // 앱 목록 → run 상세 순서로 두 번 흐른다.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return host;
}

function reply(props: Record<string, unknown>): Message {
  return {
    id: "00000000-0000-7000-8000-0000000004b1",
    channelId: CH,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: HERMES,
    type: "text",
    body: "받은편지함에서 두 건을 찾았어요.",
    state: "sent",
    createdAtMs: 1_760_000_000_000,
    replyToId: TRIGGER,
    replyTo: { id: TRIGGER, seq: 9, authorMemberId: ME, type: "text", state: "sent", body: "메일 찾아줘" },
    props,
    ...{},
  } as Message;
}
const HERMES_PROPS = { source: "hermes_gateway", status: "succeeded", run_id: RUN };
const row = (message: Message) =>
  createElement(MessageRow, { message, startsGroup: true, directory: DIRECTORY });

describe("쓴 앱 꼬리 (E8·E10)", () => {
  it("run 의 보고를 모아 한 줄로 세운다: 앱·횟수 · 실행 장소, 나머지는 「자세히」 뒤", async () => {
    const view = await mount(row(reply(HERMES_PROPS)));
    expect(fetchAgentRunDetail).toHaveBeenCalledWith(WS, RUN);
    expect(view.querySelector('[data-testid="apps-used-line"]')?.textContent).toBe(
      "쓴 앱: Gmail 검색 2회 · Hermes에서"
    );
    // 접힌 동안 명의·연결 주소는 화면에 없다.
    expect(view.querySelector('[data-testid="apps-details"]')).toBeNull();
    const toggle = view.querySelector<HTMLButtonElement>('[data-testid="apps-details-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle?.click());
    const details = view.querySelector('[data-testid="apps-details"]')?.textContent ?? "";
    expect(details).toContain("곽성재 명의로 썼어요.");
    expect(details).toContain("연결: gmailmcp.googleapis.com");
    // 자기 보고 안내가 화면에 있다(수용기준 9).
    expect(details).toContain("에이전트가 알려 준 대로예요. oort는 확인하지 못해요.");
    expect(view.querySelector('[data-testid="apps-details-toggle"]')?.textContent).toBe("접기");
  });

  it("채널이면 같은 한 줄에 「이 채널 n명에게 보여요」, 개인 앱의 「요약만」 원칙·확인 불가 안내는 자세히에", async () => {
    const view = await mount(row(reply(HERMES_PROPS)), 12);
    expect(view.querySelector('[data-testid="apps-used-line"]')?.textContent).toBe(
      "쓴 앱: Gmail 검색 2회 · Hermes에서 · 이 채널 12명에게 보여요"
    );
    act(() => view.querySelector<HTMLButtonElement>('[data-testid="apps-details-toggle"]')?.click());
    const details = view.querySelector('[data-testid="apps-details"]')?.textContent ?? "";
    expect(details).toContain("요약만 올리는 게 원칙이에요");
    expect(details).toContain("oort는 지키는지 확인하지 못해요");
    // 스크린리더는 접힌 것까지 한 번에 읽는다.
    expect(view.querySelector('[data-testid="apps-used-tail"] .sr-only')?.textContent).toContain("요약만 올리는 게 원칙이에요");
  });

  it("보고가 없으면 꼬리 자체가 없다(영수증을 만들지 않는다)", async () => {
    fetchAgentRunDetail.mockResolvedValue({});
    const view = await mount(row(reply(HERMES_PROPS)), 12);
    expect(view.querySelector('[data-testid="apps-used-tail"]')).toBeNull();
    expect(view.querySelector('[data-testid="team-ai-reply-meta"]')).toBeNull();
  });

  it("켜진 앱이 하나도 없는 워크스페이스는 run 을 부르지 않는다", async () => {
    listPlugins.mockResolvedValue(catalog(false));
    const view = await mount(row(reply(HERMES_PROPS)));
    expect(fetchAgentRunDetail).not.toHaveBeenCalled();
    expect(view.querySelector('[data-testid="apps-used-tail"]')).toBeNull();
  });

  it("게이트웨이 답이 아니거나 실패한 답은 부르지 않는다", async () => {
    await mount(row(reply({ source: "something", run_id: RUN })));
    expect(fetchAgentRunDetail).not.toHaveBeenCalled();
    expect(listPlugins).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;
    host?.remove();
    await mount(row(reply({ ...HERMES_PROPS, status: "failed" })));
    expect(fetchAgentRunDetail).not.toHaveBeenCalled();
  });

  it("받는 글의 작성자가 에이전트이면 명의를 말하지 않는다", async () => {
    const message = reply(HERMES_PROPS);
    message.replyTo = { ...message.replyTo!, authorMemberId: HERMES };
    const view = await mount(row(message));
    act(() => view.querySelector<HTMLButtonElement>('[data-testid="apps-details-toggle"]')?.click());
    expect(view.querySelector('[data-testid="apps-details"]')?.textContent).not.toContain("명의");
  });

  it("사람이 쓴 메시지에 같은 props 를 실어도 꼬리를 달지 않고 run 도 부르지 않는다(표시 위조)", async () => {
    const message = reply(HERMES_PROPS);
    message.authorMemberId = OTHER;
    const view = await mount(row(message), 12);
    expect(fetchAgentRunDetail).not.toHaveBeenCalled();
    expect(view.querySelector('[data-testid="apps-used-tail"]')).toBeNull();
  });

  it("run 조회가 실패하면 꼬리만 없고 답은 그대로다", async () => {
    fetchAgentRunDetail.mockRejectedValue(new Error("boom"));
    const view = await mount(row(reply(HERMES_PROPS)));
    expect(view.querySelector('[data-testid="apps-used-tail"]')).toBeNull();
    expect(view.textContent).toContain("받은편지함에서 두 건을 찾았어요.");
  });
});

describe("막힘 문장 (2.5절)", () => {
  const blocked = (app_notice: Record<string, unknown>) =>
    reply({ source: "hermes_gateway", status: "failed", run_id: RUN, app_notice });

  it("로그인 끊김(내 맥): 한 문장과 행동 하나(앱 화면 링크)", async () => {
    const view = await mount(row(blocked({ kind: "login_lost", plugin_id: "gmail", site: "mac" })));
    const notice = view.querySelector('[data-testid="app-notice"]');
    expect(notice?.textContent).toContain("Gmail 로그인이 끊겼어요.");
    const action = view.querySelector<HTMLAnchorElement>('[data-testid="app-notice-action"]');
    expect(action?.textContent).toBe("다시 로그인");
    expect(action?.getAttribute("href")).toBe("/ai/external/apps");
    expect(view.querySelectorAll('[data-testid="app-notice-action"]')).toHaveLength(1);
  });

  it("행동이 없는 막힘에는 링크를 만들지 않는다", async () => {
    const view = await mount(row(blocked({ kind: "grant_revoked" })));
    expect(view.querySelector('[data-testid="app-notice"]')?.textContent).toContain(
      "실행 중에 허용이 회수돼서 여기서 멈췄어요. 이미 한 일은 그대로예요."
    );
    expect(view.querySelector('[data-testid="app-notice-action"]')).toBeNull();
  });

  it("칸이 없는 행(옛 서버)은 변화 0이고 앱 목록도 부르지 않는다", async () => {
    const view = await mount(row(reply({ source: "hermes_gateway", status: "failed", run_id: RUN })));
    expect(view.querySelector('[data-testid="app-notice"]')).toBeNull();
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it("모르는 kind 는 그리지 않는다", async () => {
    const view = await mount(row(blocked({ kind: "explode" })));
    expect(view.querySelector('[data-testid="app-notice"]')).toBeNull();
  });
});

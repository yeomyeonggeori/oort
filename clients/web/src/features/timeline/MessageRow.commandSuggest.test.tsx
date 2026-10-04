// @vitest-environment jsdom
// #2948 GC-7: 에이전트 메시지의 `momo.command_suggest(ai.connect)`를 진짜
// MessageRow가 보는 사람별로 그린다(ADR-0186 증보 G4·G6).
//
// - 대상 본인: GC-3 카드와 같은 절 + 제안 머리. 에이전트의 본문은 위에 그대로.
// - 운영자(대상 아님): 한 줄 + 「팀 AI 키 보기」 → 팀 줄만.
// - 그 밖: 한 줄, 입력·버튼 0.
// - 상태는 props가 아니라 보는 사람의 스토어에서(모의 CLI 감지·provider_link).

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, type Message, type RosterMember } from "@momo/core/lib/api";
import {
  fetchProviderChain,
  fetchProviderLink,
  fetchWorkspace,
  type ProviderLink,
} from "@momo/core/features/settings/api";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { COMMAND_SUGGEST_PROP_KEY } from "@momo/core/features/timeline/commandSuggest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { detectLocalHarnesses } from "@/lib/tauri";
import { MemoryRouter } from "react-router-dom";
import { AiConnectCard, AiConnectSuggestion } from "@/features/chat/AiConnectCard";
import { CommandSuggestSlot, ThreadSurfaceRoot } from "./commandSuggestSlot";
import { readDraft, writeDraft } from "@/features/chat/draftStore";
import { MessageRow, type MessageRowActions } from "./MessageRow";
import { ThreadComposer } from "./ThreadComposer";

const envSlot = vi.hoisted(() => ({ tauri: true, flag: true }));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
    get SUBSCRIPTION_AGENTS_BUILD_FLAG() {
      return envSlot.flag;
    },
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, detectLocalHarnesses: vi.fn(), openExternalUrl: vi.fn() };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn() };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(),
    fetchProviderChain: vi.fn(),
    fetchWorkspace: vi.fn(),
    putProviderLink: vi.fn(),
    testProviderLink: vi.fn(),
  };
});

vi.mock("@/features/welcome/harnessLogin/HarnessLoginDialog", () => ({
  HarnessLoginDialog: () => null,
}));
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const REQUESTER = "00000000-0000-7000-8000-000000000101";
const SKY = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000401";

const KEY_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://api.openai.com/v1",
  endpointLabel: "OpenAI",
  bearerConfigured: true,
  bearerLast4: "a4f2",
  availability: "live",
  keyConfigured: true,
  updatedAtMs: 1_790_000_000_000,
  diagnostics: [] as string[],
  credentialKind: "bearer",
  presets: [],
} as unknown as ProviderLink;

const LOGIN: LocalHarnessProbe[] = [
  { id: "claude", installed: true, auth: "needs_login" },
  { id: "codex", installed: true, auth: "needs_login" },
];

function person(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
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

const directory = makeDirectory([
  person(REQUESTER, "human", "곽성재", "seongjae"),
  { ...person(SKY, "human", "김하늘", "sky"), role: "owner" },
  person(AGENT, "agent", "hermes", "hermes"),
]);

const G3 = {
  v: 1,
  command_id: "ai.connect",
  args: { harness: "claude", scope: "mine" },
  for_member_id: REQUESTER,
  label: "Claude 구독 연결",
};

const BODY = "아래 카드에서 바로 연결하고 확인할 수 있어요.";

function suggestion(envelope: unknown, author = AGENT): Message {
  return {
    id: "0199eeee-0000-7000-8000-000000000402",
    channelId: CH,
    seq: 2,
    hlcTs: 2,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body: BODY,
    state: "sent",
    createdAtMs: 2000,
    props: { [COMMAND_SUGGEST_PROP_KEY]: envelope },
  };
}

function sessionValue(me: string): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: me, workspaceId: WS, kind: "human", displayName: "나", handle: "me" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function actionsFor(me: string): MessageRowActions {
  return {
    myMemberId: me,
    chips: [],
    onToggleReaction: vi.fn(),
    pinned: false,
    onTogglePin: vi.fn(),
    onEditMessage: vi.fn(),
    onDeleteMessage: vi.fn(),
  } as unknown as MessageRowActions;
}

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let roots: Root[] = [];
let hosts: HTMLElement[] = [];

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
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
  envSlot.tauri = true;
  envSlot.flag = true;
  vi.mocked(fetchWorkspace).mockReset().mockResolvedValue({
    id: WS,
    slug: "team",
    name: "우리 팀",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: true,
  });
  vi.mocked(fetchRoster)
    .mockReset()
    .mockResolvedValue([{ ...person(REQUESTER, "human", "곽성재", "seongjae"), role: "owner" }]);
  vi.mocked(fetchProviderLink).mockReset().mockResolvedValue(KEY_LINK);
  vi.mocked(fetchProviderChain).mockReset().mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(detectLocalHarnesses).mockReset().mockResolvedValue(LOGIN);
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const host of hosts) host.remove();
  roots = [];
  hosts = [];
});

function mount(node: ReactElement, me: string): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  hosts.push(host);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SessionProvider,
          { value: sessionValue(me) },
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

function rowElement(message: Message, me: string | null) {
  return createElement(MessageRow, {
    message,
    startsGroup: true,
    directory,
    ...(me !== null ? { actions: actionsFor(me) } : {}),
  });
}

/** 채널 표면(ChatShell)처럼 카드 자리를 건넨 행. */
function mountRow(message: Message, me: string | null): HTMLElement {
  return mount(
    createElement(CommandSuggestSlot.Provider, { value: AiConnectSuggestion }, rowElement(message, me)),
    me ?? SKY
  );
}

function q(host: ParentNode, testId: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function until(host: HTMLElement, testId: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!q(host, testId)) throw new Error(`missing ${testId}`);
  });
  return q(host, testId) as HTMLElement;
}

/** 제안 자리 안의 조작 요소 수(G6: 비대상·비운영자 0). */
function controls(el: HTMLElement): number {
  return el.querySelectorAll("button, input, select, textarea, a[href]").length;
}

function pillText(el: HTMLElement | null): string {
  return el?.querySelector("[data-tone]")?.textContent?.trim() ?? "";
}

describe("대상 본인 — 조작 카드(시안 ③ 요청자)", () => {
  it("본문 아래에 GC-3 절 + 제안 머리, 닫기 없음, 초점을 가져가지 않는다", async () => {
    const before = document.activeElement;
    const host = mountRow(suggestion(G3), REQUESTER);
    const card = await until(host, "ai-suggest");
    await until(host, "ai-connect-card-claude");
    expect(card.dataset.viewer).toBe("target");
    expect(host.textContent).toContain(BODY);
    expect(card.textContent).toContain("hermes가 제안했어요");
    expect(q(card, "ai-suggest-only-me")?.textContent).toContain("나에게만 조작돼요");
    expect(card.textContent).toContain("내 계정 · 이 맥");
    // harness=claude: 구독은 그 줄만, 팀 절은 함께(시안 ③ 요청자).
    expect(q(card, "ai-connect-card-codex")).toBeNull();
    expect(q(card, "ai-connect-card-grok")).toBeNull();
    await until(card, "ai-connect-card-team");
    expect(q(card, "ai-connect-card-close")).toBeNull();
    expect(q(card, "ai-connect-card-claude-login")?.textContent).toBe("Claude Code로 로그인");
    // 서버가 파생한 label도 그리지 않는다(클라가 문구를 만든다).
    expect(card.textContent).not.toContain("Claude 구독 연결");
    expect(document.activeElement).toBe(before);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("알약은 props가 아니라 이 기기 스토어에서: GC-3 로컬 카드와 같은 알약", async () => {
    const host = mountRow(suggestion({ ...G3, args: {} }), REQUESTER);
    const card = await until(host, "ai-suggest");
    await until(card, "ai-connect-card-claude");
    await until(card, "ai-connect-card-team");
    const local = mount(
      createElement(AiConnectCard, { line: null, focusNonce: 0, offline: false, onClose: () => undefined, claimFocus: () => false }),
      REQUESTER
    );
    await until(local, "ai-connect-card-claude");
    await until(local, "ai-connect-card-team");
    for (const id of ["ai-connect-card-claude", "ai-connect-card-codex", "ai-connect-card-team"]) {
      expect(pillText(q(card, id))).not.toBe("");
      expect(pillText(q(card, id))).toBe(pillText(q(local, id)));
    }
    expect(pillText(q(card, "ai-connect-card-claude"))).toBe("로그인 필요");
  });

  it("props에 상태를 실어도 믿지 않는다: 모르는 키는 한 줄 폴백, 조작 0", async () => {
    const host = mountRow(suggestion({ ...G3, state: "ready", status: "connected" }), REQUESTER);
    const line = await until(host, "ai-suggest");
    expect(line.dataset.viewer).toBe("other");
    expect(line.textContent).toContain("곽성재에게 AI 계정 연결을 제안했어요");
    expect(controls(line)).toBe(0);
    expect(host.textContent).not.toMatch(/준비됨|connected/);
  });
});

describe("대상이 아닌 사람 — 한 줄(시안 ③ 김하늘)", () => {
  it("비운영자(403): 한 줄만, 입력·버튼 0", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const host = mountRow(suggestion(G3), SKY);
    const line = await until(host, "ai-suggest");
    await waitFor(() => expect(fetchProviderLink).toHaveBeenCalled());
    await act(async () => undefined);
    expect(line.dataset.viewer).toBe("other");
    expect(q(line, "ai-suggest-line")?.textContent).toBe("곽성재에게 AI 계정 연결을 제안했어요");
    expect(controls(line)).toBe(0);
    expect(line.textContent).not.toContain("내 계정");
    expect(host.textContent).toContain(BODY);
  });

  it("읽기 전용 표면(actions 없음)은 대상이 아니다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const host = mountRow(suggestion(G3), null);
    const line = await until(host, "ai-suggest");
    await act(async () => undefined);
    expect(line.dataset.viewer).toBe("other");
    expect(controls(line)).toBe(0);
  });

  it("운영자: 한 줄 + 「팀 AI 키 보기」 → 팀 줄만(남의 구독 줄 없음)", async () => {
    const host = mountRow(suggestion(G3), SKY);
    const open = await until(host, "ai-suggest-team-open");
    const line = q(host, "ai-suggest") as HTMLElement;
    expect(line.dataset.viewer).toBe("operator");
    expect(open.textContent).toBe("팀 AI 키 보기");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(q(line, "ai-suggest-team-panel")).toBeNull();
    act(() => open.click());
    const panel = await until(host, "ai-suggest-team-panel");
    await until(panel, "ai-connect-card-team");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(q(panel, "ai-connect-card-team-check")?.textContent).toContain("연결 확인");
    expect(q(line, "ai-connect-card-claude")).toBeNull();
    expect(line.textContent).not.toContain("내 계정");
  });
});

describe("본문 폴백 — 카드를 세울 근거가 없다", () => {
  it.each([
    ["사람이 쓴 메시지", suggestion(G3, SKY)],
    ["모르는 command_id", suggestion({ ...G3, command_id: "invite.create" })],
    ["멤버 목록에 없는 대상", suggestion({ ...G3, for_member_id: "nobody" })],
    ["문자열 봉투", suggestion(JSON.stringify(G3))],
  ])("%s", async (_name, message) => {
    const host = mountRow(message, REQUESTER);
    await act(async () => undefined);
    expect(q(host, "ai-suggest")).toBeNull();
    expect(host.textContent).toContain(BODY);
  });

  it("label의 마크업은 글자로도 그려지지 않는다(XSS 없음)", async () => {
    const host = mountRow(suggestion({ ...G3, label: "<img src=x onerror=alert(1)>" }), SKY);
    await until(host, "ai-suggest");
    expect(host.querySelector("img[src='x']")).toBeNull();
    expect(host.textContent).not.toContain("onerror");
  });
});

describe("비운영자 대상 — 「운영자에게 부탁하기」(G4 · 시안 ③ 이도윤)", () => {
  const TEAM = { ...G3, args: { harness: "team_key", scope: "team" } };

  it("거절 줄 밑의 버튼이 컴포저에 운영자 멘션만 채운다(보내지 않는다)", async () => {
    localStorage.clear();
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const host = mountRow(suggestion(TEAM), REQUESTER);
    const ask = await until(host, "ai-connect-card-ask-operator");
    expect(q(host, "ai-connect-card-team-denied")).not.toBeNull();
    expect(ask.textContent).toBe("운영자에게 부탁하기");
    act(() => ask.click());
    expect(readDraft(WS, CH)).toBe("@sky ");
    expect(q(host, "ai-connect-card-ask-note")).toBeNull();
  });

  it("쓰던 글은 덮지 않고 그 자리에서 말한다", async () => {
    localStorage.clear();
    writeDraft(WS, CH, "쓰던 글");
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const host = mountRow(suggestion(TEAM), REQUESTER);
    const ask = await until(host, "ai-connect-card-ask-operator");
    act(() => ask.click());
    expect(readDraft(WS, CH)).toBe("쓰던 글");
    expect(q(host, "ai-connect-card-ask-note")?.textContent).toContain("쓰던 글이 있어");
  });

  it("운영자 본인에게는 부탁 버튼이 없다", async () => {
    const host = mountRow(suggestion(TEAM), REQUESTER);
    await until(host, "ai-connect-card-team");
    expect(q(host, "ai-connect-card-ask-operator")).toBeNull();
  });
});

describe("카드 자리가 없는 표면", () => {
  it("채널 표면 밖(자리 없음)에서는 본문만 그린다", async () => {
    const host = mount(rowElement(suggestion(G3), REQUESTER), REQUESTER);
    await act(async () => undefined);
    expect(q(host, "ai-suggest")).toBeNull();
    expect(host.textContent).toContain(BODY);
  });
});

describe("스레드 답글로 온 제안 — 부탁은 그 스레드 입력창에(design-review #2948 B)", () => {
  const TEAM = { ...G3, args: { harness: "team_key", scope: "team" } };
  const ROOT = "0199eeee-0000-7000-8000-000000000400";
  const reply = () => ({ ...suggestion(TEAM), rootId: ROOT });

  it("열린 스레드 입력창에 멘션을 심고, 채널 초안은 건드리지 않는다", async () => {
    localStorage.clear();
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const host = mount(
      createElement(
        CommandSuggestSlot.Provider,
        { value: AiConnectSuggestion },
        createElement("div", null,
          rowElement(reply(), REQUESTER),
          createElement(ThreadComposer, {
            workspaceId: WS,
            channelId: CH,
            rootId: ROOT,
            directory,
            channels: [],
            onSent: () => undefined,
          })
        )
      ),
      REQUESTER
    );
    const ask = await until(host, "ai-connect-card-ask-operator");
    act(() => ask.click());
    const box = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.value).toBe("@sky ");
    expect(readDraft(WS, CH)).toBe("");
    expect(q(host, "ai-connect-card-ask-note")).toBeNull();
  });

  it("스레드 입력창이 없으면 조용히 끝나지 않고 그 자리에서 말한다", async () => {
    localStorage.clear();
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const host = mountRow(reply(), REQUESTER);
    const ask = await until(host, "ai-connect-card-ask-operator");
    act(() => ask.click());
    expect(readDraft(WS, CH)).toBe("");
    expect(q(host, "ai-connect-card-ask-note")?.textContent).toBe("스레드를 열고 운영자를 멘션해 주세요.");
  });
  it("스레드 패널의 뿌리 행(자기 rootId 없음)도 그 스레드 입력창을 채운다", async () => {
    localStorage.clear();
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    const rootMessage = suggestion(TEAM);
    const host = mount(
      createElement(
        CommandSuggestSlot.Provider,
        { value: AiConnectSuggestion },
        createElement(
          ThreadSurfaceRoot.Provider,
          { value: rootMessage.id },
          createElement("div", null,
            rowElement(rootMessage, REQUESTER),
            createElement(ThreadComposer, {
              workspaceId: WS,
              channelId: CH,
              rootId: rootMessage.id,
              directory,
              channels: [],
              onSent: () => undefined,
            })
          )
        )
      ),
      REQUESTER
    );
    const ask = await until(host, "ai-connect-card-ask-operator");
    act(() => ask.click());
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("@sky ");
    expect(readDraft(WS, CH)).toBe("");
  });
});

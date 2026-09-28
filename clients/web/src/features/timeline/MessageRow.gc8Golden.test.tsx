// @vitest-environment jsdom
// #2949 GC-8(#2986) — 서버 E2E가 실제로 게시한 props(골든 벡터
// `docs/api/command-suggest-ai-connect.golden.json`)를 GC-7의 진짜 MessageRow에 넣는다.
// 서버 쪽(Rust card_suggest 단위 시험·remote_host_r0_conformance_pg GC-8 E2E)과 같은
// 파일을 읽으므로 한쪽에서만 모양이 바뀌면 다른 쪽이 실패한다.
//
// - 대상 본인: 조작 카드(폴백 아님), 로그인 뒤 그 줄이 제자리에서 「준비됨」.
// - 그 밖(비운영자): 한 줄, 입력·버튼 0.
// - 상태는 props가 아니라 보는 사람의 스토어에서(모의 CLI 감지·provider_link).

import golden from "../../../../../docs/api/command-suggest-ai-connect.golden.json";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ApiError,
  fetchRoster,
  type Message,
  type RosterMember,
} from "@momo/core/lib/api";
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
import { AiConnectSuggestion } from "@/features/chat/AiConnectCard";
import { CommandSuggestSlot } from "./commandSuggestSlot";
import { MessageRow, type MessageRowActions } from "./MessageRow";

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
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
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
  HarnessLoginDialog: (props: {
    harness: string | null;
    onClose: () => void;
    onConnected: (id: string) => void;
  }) =>
    props.harness === null
      ? null
      : createElement(
          "div",
          {
            role: "dialog",
            "data-testid": "login-dialog",
            "data-harness": props.harness,
          },
          createElement(
            "button",
            {
              "data-testid": "login-ok",
              onClick: () => {
                props.onConnected(props.harness as string);
                props.onClose();
              },
            },
            "ok",
          ),
        ),
}));
vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: () => null,
}));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({
  EmojiPickerDialog: () => null,
}));

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

function person(
  id: string,
  kind: "human" | "agent",
  displayName: string,
  handle: string,
): RosterMember {
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
      member: {
        id: me,
        workspaceId: WS,
        kind: "human",
        displayName: "나",
        handle: "me",
      },
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

const actEnv = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
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
    .mockResolvedValue([
      { ...person(REQUESTER, "human", "곽성재", "seongjae"), role: "owner" },
    ]);
  vi.mocked(fetchProviderLink).mockReset().mockResolvedValue(KEY_LINK);
  vi.mocked(fetchProviderChain)
    .mockReset()
    .mockRejectedValue(new ApiError(404, "not found"));
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
            createElement(QueryClientProvider, { client }, node),
          ),
        ),
      ),
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
    createElement(
      CommandSuggestSlot.Provider,
      { value: AiConnectSuggestion },
      rowElement(message, me),
    ),
    me ?? SKY,
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

const READY: LocalHarnessProbe[] = [
  { id: "claude", installed: true, auth: "logged_in" },
  { id: "codex", installed: true, auth: "needs_login" },
];

function goldenCase(name: string): unknown {
  const found = (
    golden.cases as { name: string; props: Record<string, unknown> }[]
  ).find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found.props[COMMAND_SUGGEST_PROP_KEY];
}

describe("GC-8: 서버가 게시한 골든 props → 보는 사람별 렌더", () => {
  it("골든의 자리표시 요청자는 이 시험의 REQUESTER다", () => {
    expect(golden.for_member_id_placeholder).toBe(REQUESTER);
  });

  it.each(["no_args", "claude", "codex", "team_key"])(
    "%s: 대상 본인에게 조작 카드(폴백 아님)",
    async (name) => {
      const host = mountRow(suggestion(goldenCase(name)), REQUESTER);
      const card = await until(host, "ai-suggest");
      expect(card.dataset.viewer).toBe("target");
    },
  );

  it("요청 → 카드 → 로그인 모달(가짜 CLI) → 그 줄이 제자리에서 「준비됨」", async () => {
    const host = mountRow(suggestion(goldenCase("claude")), REQUESTER);
    const card = await until(host, "ai-suggest");
    const login = await until(card, "ai-connect-card-claude-login");
    expect(pillText(q(card, "ai-connect-card-claude"))).toBe("로그인 필요");
    act(() => login.click());
    expect(q(host, "login-dialog")?.getAttribute("data-harness")).toBe(
      "claude",
    );
    vi.mocked(detectLocalHarnesses).mockResolvedValue(READY);
    act(() => q(host, "login-ok")?.click());
    await waitFor(() =>
      expect(pillText(q(card, "ai-connect-card-claude"))).toBe("준비됨"),
    );
    // 같은 메시지 안, 같은 카드다(새 메시지·새 카드가 아니다).
    expect(host.querySelectorAll('[data-testid="ai-suggest"]').length).toBe(1);
  });

  it("남(비운영자)에게는 한 줄, 입력·버튼 0", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(
      new ApiError(403, "forbidden"),
    );
    const host = mountRow(suggestion(goldenCase("claude")), SKY);
    const line = await until(host, "ai-suggest");
    await waitFor(() => expect(fetchProviderLink).toHaveBeenCalled());
    await act(async () => undefined);
    expect(line.dataset.viewer).toBe("other");
    expect(q(line, "ai-suggest-line")?.textContent).toBe(
      "곽성재에게 AI 연결을 제안했어요",
    );
    expect(controls(line)).toBe(0);
  });
});

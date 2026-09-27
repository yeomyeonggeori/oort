// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, type RosterMember } from "@momo/core/lib/api";
import {
  fetchProviderChain,
  fetchProviderLink,
  fetchWorkspace,
  putProviderLink,
  testProviderLink,
  type ProviderLink,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { linkPill } from "@momo/core/features/settings/aiLinkPill";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { detectLocalHarnesses } from "@/lib/tauri";
import { AiLinkSection } from "@/features/settings/AiLinkSection";
import { AiConnectCard } from "./AiConnectCard";

// =============================================================================
// 로컬 연결 카드 (#2944 GC-3). brief §3.3~3.5, §5.
//
// - 교차: 같은 입력(모의 link·probe·CLI 감지)에 설정 › AI 연결과 카드가 **같은
//   알약**을 말한다(#2941 판정 한 곳).
// - 흐름 넷: 구독 로그인(#2816 모달) · 팀 키(운영자) · 연결 확인 · 실패 제자리.
// - 비밀값: 키가 React 상태·뮤테이션 캐시·브라우저 저장소·로그에 남지 않는다.
// =============================================================================

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

// 모달의 PTY는 이 시험의 몫이 아니다(#2816 시험이 잰다). 카드가 부르는 계약
// (harness · onConnected · onClose · onFallbackStarted)만 남긴 대역이다.
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
          { role: "dialog", "data-testid": "login-dialog", "data-harness": props.harness },
          createElement(
            "button",
            {
              "data-testid": "login-ok",
              onClick: () => {
                props.onConnected(props.harness as string);
                props.onClose();
              },
            },
            "ok"
          ),
          createElement("button", { "data-testid": "login-cancel", onClick: props.onClose }, "취소")
        ),
}));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
];

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
  presets: PRESETS,
} as ProviderLink;

const EMPTY_LINK = {
  schema: "momo.provider_link.v0",
  configured: false,
  source: "environment",
  mode: "local-mock",
  baseUrl: "http://mock",
  endpointLabel: "mock",
  bearerConfigured: false,
  availability: "mock",
  keyConfigured: false,
  diagnostics: [] as string[],
  presets: PRESETS,
} as ProviderLink;

const probe = (ok: boolean, reason?: string): ProviderLinkTest => ({
  schema: "momo.provider_link.test.v0",
  ok,
  reason,
  source: "database",
  mode: "external-hermes",
  endpointLabel: "OpenAI",
  checkedAtMs: 1_790_000_000_000,
});

const LOGIN: LocalHarnessProbe[] = [
  { id: "claude", installed: true, auth: "needs_login" },
  { id: "codex", installed: true, auth: "needs_login" },
];
const READY: LocalHarnessProbe[] = [
  { id: "claude", installed: true, auth: "logged_in" },
  { id: "codex", installed: true, auth: "needs_login" },
];

function me(role: RosterMember["role"]): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function session(): SessionContextValue {
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
  };
}

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let roots: Root[] = [];
let hosts: HTMLElement[] = [];
let client: QueryClient;

function renderInto(root: Root, element: ReturnType<typeof createElement>) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: session() },
          createElement(MemoryRouter, null, element)
        )
      )
    );
  });
}

function mountEl(element: ReturnType<typeof createElement>): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  hosts.push(host);
  roots.push(root);
  renderInto(root, element);
  return host;
}

function mountCard(opts: { line?: "claude" | "codex" | "team" | null; offline?: boolean; onClose?: () => void } = {}) {
  return mountEl(
    createElement(AiConnectCard, {
      line: opts.line ?? null,
      focusNonce: 1,
      offline: opts.offline ?? false,
      onClose: opts.onClose ?? (() => undefined),
    })
  );
}

function q(host: HTMLElement, testId: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function until(host: HTMLElement, testId: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!q(host, testId)) throw new Error(`missing ${testId}`);
  });
  return q(host, testId) as HTMLElement;
}

function pillOf(el: HTMLElement | null): { tone: string | null; text: string } {
  const pill = el?.querySelector("[data-tone]");
  return { tone: pill?.getAttribute("data-tone") ?? null, text: pill?.textContent?.trim() ?? "" };
}

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  envSlot.tauri = true;
  envSlot.flag = true;
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(fetchRoster).mockReset().mockResolvedValue([me("owner")]);
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
  vi.mocked(fetchProviderLink).mockReset().mockResolvedValue(KEY_LINK);
  vi.mocked(fetchProviderChain).mockReset().mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(putProviderLink).mockReset();
  vi.mocked(testProviderLink).mockReset();
  vi.mocked(detectLocalHarnesses).mockReset().mockResolvedValue(LOGIN);
});

afterEach(() => {
  onlineManager.setOnline(true);
  for (const root of roots) act(() => root.unmount());
  for (const host of hosts) host.remove();
  roots = [];
  hosts = [];
});

describe("카드의 겉 (#2944 시안 ①)", () => {
  it("「나에게만 보여요」, 에이전트 이름·아바타 없음, 두 절과 Grok 준비 중", async () => {
    const host = mountCard();
    await until(host, "ai-connect-card-team");
    await until(host, "ai-connect-card-claude");
    expect(q(host, "ai-connect-card-only-me")?.textContent).toContain("나에게만 보여요");
    const card = q(host, "ai-connect-card") as HTMLElement;
    expect(card.textContent).toContain("내 계정 · 이 맥");
    expect(card.textContent).toContain("팀 연결 · 이 서버");
    expect(card.textContent).not.toMatch(/hermes|에이전트가 제안/);
    expect(pillOf(q(host, "ai-connect-card-grok")).text).toBe("준비 중");
    // 알약 하나에 버튼 하나.
    expect(q(host, "ai-connect-card-claude-login")?.textContent).toBe("Claude Code로 로그인");
    expect(q(host, "ai-connect-card-team-check")?.textContent).toContain("연결 확인");
  });

  it("열리면 제목에 초점, 다시 마운트돼 claimFocus가 거짓이면 초점을 빼앗지 않는다", async () => {
    const host = mountCard();
    await until(host, "ai-connect-card-team");
    expect(document.activeElement?.textContent).toBe("AI 연결");
    const other = document.createElement("textarea");
    document.body.append(other);
    other.focus();
    const again = mountEl(
      createElement(AiConnectCard, {
        line: null,
        focusNonce: 1,
        offline: false,
        onClose: () => undefined,
        claimFocus: () => false,
      })
    );
    await until(again, "ai-connect-card-team");
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("줄 인자(/연결 codex)는 그 줄만 펼친다", async () => {
    const host = mountCard({ line: "codex" });
    await until(host, "ai-connect-card-codex");
    expect(q(host, "ai-connect-card-claude")).toBeNull();
    expect(q(host, "ai-connect-card-grok")).toBeNull();
    expect(q(host, "ai-connect-card-team-section")).toBeNull();
  });

  it("× 와 Esc 가 닫는다", async () => {
    const onClose = vi.fn();
    const host = mountCard({ onClose });
    await until(host, "ai-connect-card-team");
    act(() => q(host, "ai-connect-card-close")?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    const card = q(host, "ai-connect-card") as HTMLElement;
    act(() => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("브라우저 탭에서는 내 계정 절이 설정과 같은 한 줄이다", async () => {
    envSlot.tauri = false;
    const host = mountCard();
    const line = await until(host, "ai-connect-card-browser");
    expect(line.textContent).toBe(
      "구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요. 이 브라우저 탭에는 이 맥의 CLI가 없어요."
    );
  });
});

describe("같은 입력 → 같은 알약: 설정 × 카드 (#2941·#2944)", () => {
  const links: Array<[string, ProviderLink]> = [
    ["저장된 키", KEY_LINK],
    ["모의", { ...KEY_LINK, availability: "mock" } as ProviderLink],
    ["자격증명 없음", { ...KEY_LINK, keyConfigured: false } as ProviderLink],
    // 내부용(legacy OAuth) 연결은 두 표면 모두 「읽기 전용」(review #2961 M2).
    ["내부용", { ...KEY_LINK, credentialKind: "oauth-openai" } as ProviderLink],
  ];
  it.each(links)("팀 줄: %s", async (_name, link) => {
    vi.mocked(fetchProviderLink).mockResolvedValue(link);
    const settings = mountEl(createElement(AiLinkSection, { offline: false }));
    const card = mountCard();
    const settingsRow = await until(settings, "ai-link-row");
    const cardRow = await until(card, "ai-connect-card-team");
    expect(pillOf(cardRow)).toEqual(pillOf(settingsRow.querySelector("[data-slot='state']") as HTMLElement));
  });

  it("팀 줄: 내부용 연결은 두 표면 모두 정확히 「읽기 전용」", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue({ ...KEY_LINK, credentialKind: "oauth-openai" } as ProviderLink);
    const settings = mountEl(createElement(AiLinkSection, { offline: false }));
    const card = mountCard();
    const settingsRow = await until(settings, "ai-link-row");
    const cardRow = await until(card, "ai-connect-card-team");
    expect(pillOf(cardRow)).toEqual({ tone: "mute", text: "읽기 전용" });
    expect(pillOf(settingsRow.querySelector("[data-slot='state']") as HTMLElement)).toEqual(pillOf(cardRow));
  });

  it("팀 줄: 빈 서버(설정은 줄 없이 「API 키 추가」)는 카드가 코어 판정 그대로", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    const card = mountCard();
    const cardRow = await until(card, "ai-connect-card-team");
    expect(pillOf(cardRow)).toEqual(linkPill({ link: EMPTY_LINK, offline: false, probe: null, checking: false }));
  });

  it("팀 줄: 같은 test 응답(실패)에 두 표면이 같은 알약", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(probe(false, "provider_auth_failed"));
    const settings = mountEl(createElement(AiLinkSection, { offline: false }));
    const card = mountCard();
    await until(settings, "ai-link-row");
    act(() => (q(settings, "ai-link-row-more") as HTMLButtonElement).click());
    const settingsCheck = await until(settings, "ai-link-check");
    const cardCheck = await until(card, "ai-connect-card-team-check");
    act(() => settingsCheck.click());
    act(() => cardCheck.click());
    await waitFor(() => expect(pillOf(q(card, "ai-connect-card-team"))).toEqual({ tone: "bad", text: "확인 실패" }));
    const settingsRow = await until(settings, "ai-link-row");
    await waitFor(() =>
      expect(pillOf(settingsRow.querySelector("[data-slot='state']") as HTMLElement)).toEqual(
        pillOf(q(card, "ai-connect-card-team"))
      )
    );
  });

  it("팀 줄: 오프라인이면 둘 다 「확인할 수 없음」", async () => {
    const settings = mountEl(createElement(AiLinkSection, { offline: true }));
    const card = mountCard({ offline: true });
    const settingsRow = await until(settings, "ai-link-row");
    const cardRow = await until(card, "ai-connect-card-team");
    expect(pillOf(cardRow)).toEqual({ tone: "mute", text: "확인할 수 없음" });
    expect(pillOf(settingsRow.querySelector("[data-slot='state']") as HTMLElement)).toEqual(pillOf(cardRow));
  });

  it("구독 줄: 같은 CLI 감지에 같은 알약", async () => {
    vi.mocked(detectLocalHarnesses).mockResolvedValue(READY);
    const settings = mountEl(createElement(AiLinkSection, { offline: false }));
    const card = mountCard();
    for (const id of ["claude", "codex"] as const) {
      const settingsPill = await until(settings, `my-account-${id}-state`);
      const cardRow = await until(card, `ai-connect-card-${id}`);
      await waitFor(() => expect(pillOf(cardRow).text).not.toBe("확인 중…"));
      expect(pillOf(cardRow)).toEqual(pillOf(settingsPill));
    }
    expect(pillOf(q(card, "ai-connect-card-claude"))).toEqual({ tone: "ok", text: "준비됨" });
    expect(pillOf(q(card, "ai-connect-card-codex"))).toEqual({ tone: "warn", text: "로그인 필요" });
  });
});

describe("흐름 ① 구독 로그인 (#2816 모달)", () => {
  it("로그인 성공: 모달이 닫히면 그 줄만 「준비됨」+ 결과 줄", async () => {
    const host = mountCard();
    const login = await until(host, "ai-connect-card-claude-login");
    act(() => login.click());
    expect(q(host, "login-dialog")?.getAttribute("data-harness")).toBe("claude");
    vi.mocked(detectLocalHarnesses).mockResolvedValue(READY);
    act(() => q(host, "login-ok")?.click());
    await waitFor(() => expect(pillOf(q(host, "ai-connect-card-claude")).text).toBe("준비됨"));
    expect(q(host, "ai-connect-card-claude-result")?.textContent).toMatch(/^방금 연결됐어요 · \d{2}:\d{2}$/);
    expect(q(host, "ai-connect-card-claude-check")).not.toBeNull();
    // 다른 줄은 그대로다.
    expect(pillOf(q(host, "ai-connect-card-codex")).text).toBe("로그인 필요");
    expect(q(host, "ai-connect-card-codex-result")).toBeNull();
    expect(q(host, "ai-connect-card")).not.toBeNull();
  });

  it("취소: 카드는 남고 그 줄에 「로그인이 끝나지 않았어요」+ 다시 시도", async () => {
    const host = mountCard();
    const login = await until(host, "ai-connect-card-codex-login");
    act(() => login.click());
    act(() => q(host, "login-cancel")?.click());
    expect(q(host, "login-dialog")).toBeNull();
    const result = await until(host, "ai-connect-card-codex-result");
    expect(result.textContent).toBe("로그인이 끝나지 않았어요");
    expect(result.getAttribute("data-tone")).toBe("warn");
    const retry = q(host, "ai-connect-card-codex-retry") as HTMLButtonElement;
    act(() => retry.click());
    expect(q(host, "login-dialog")?.getAttribute("data-harness")).toBe("codex");
  });
});

describe("흐름 ② 팀 키 (운영자) · 비밀값", () => {
  const SECRET = ["sk", "-test-", "Q7mZ2xL9vB4nR8tK1wE6yU3i"].join("");

  it("키 넣기 → 저장하고 확인: 기존 PUT → test, 줄이 제자리에서 바뀌고 키는 어디에도 남지 않는다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const host = mountCard();
    const row = await until(host, "ai-connect-card-team");
    expect(pillOf(row)).toEqual({ tone: "mute", text: "연결 안 됨" });
    act(() => q(host, "ai-connect-card-team-key")?.click());
    const input = (await until(host, "ai-connect-card-key-input")) as HTMLInputElement;
    // password 칸이어야 접근성 트리에 값이 평문으로 나가지 않는다(design-review #2961 H1).
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    // 비밀번호 관리자가 이 칸을 로그인 비밀번호로 잡지 않게(review #2961 M3).
    for (const attr of ["data-1p-ignore", "data-lpignore", "data-bwignore", "data-form-type"]) {
      expect(input.hasAttribute(attr)).toBe(true);
    }
    expect(q(host, "ai-connect-card-key-form")?.getAttribute("autocomplete")).toBe("off");
    act(() => (q(host, "ai-connect-card-preset-anthropic") as HTMLInputElement).click());

    let resolvePut: (link: ProviderLink) => void = () => undefined;
    vi.mocked(putProviderLink).mockImplementation(
      () => new Promise<ProviderLink>((resolve) => (resolvePut = resolve))
    );
    vi.mocked(testProviderLink).mockResolvedValue(probe(true));
    input.value = SECRET;
    await act(async () => (q(host, "ai-connect-card-key-save") as HTMLButtonElement).click());

    // 누른 순간 칸이 비고, 요청 한 번에만 키가 실린다.
    expect(input.value).toBe("");
    expect(putProviderLink).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putProviderLink).mock.calls[0]?.[0]).toEqual({
      baseUrl: "https://api.anthropic.com/v1",
      bearer: SECRET,
      mode: "external-hermes",
      format: "anthropic",
    });
    vi.mocked(fetchProviderLink).mockResolvedValue({ ...KEY_LINK, bearerLast4: "i0k2" } as ProviderLink);
    await act(async () => resolvePut({ ...KEY_LINK, bearerLast4: "i0k2" } as ProviderLink));

    await waitFor(() => expect(testProviderLink).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pillOf(q(host, "ai-connect-card-team"))).toEqual({ tone: "ok", text: "확인됨" }));
    expect(q(host, "ai-connect-card-key-form")).toBeNull();
    expect(q(host, "ai-connect-card-team")?.textContent).toContain("••••i0k2");
    expect(q(host, "ai-connect-card-team-result")?.getAttribute("data-tone")).toBe("ok");
    // 시안 `.flash`: 방금 성공한 그 줄만 옅은 ok 바탕.
    expect(q(host, "ai-connect-card-team")?.hasAttribute("data-flash")).toBe(true);

    // 비밀값이 남지 않는다: 뮤테이션 캐시·쿼리 캐시·브라우저 저장소·DOM·로그.
    const mutationState = JSON.stringify(client.getMutationCache().getAll().map((m) => m.state));
    expect(mutationState).not.toContain(SECRET);
    expect(JSON.stringify(client.getQueryCache().getAll().map((c) => c.state.data))).not.toContain(SECRET);
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        expect(store.getItem(store.key(i) as string) ?? "").not.toContain(SECRET);
      }
    }
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      spy.mockRestore();
    }
  });

  it("빈 키는 보내지 않고 칸 옆에서 말한다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    const host = mountCard({ line: "team" });
    // /연결 팀키 + 빈 서버: 폼이 바로 열린다.
    await until(host, "ai-connect-card-key-input");
    act(() => (q(host, "ai-connect-card-key-save") as HTMLButtonElement).click());
    expect(putProviderLink).not.toHaveBeenCalled();
    expect(q(host, "ai-connect-card-key-form")?.textContent).toContain("키를 붙여 넣으세요");
  });

  it("Esc 는 폼을 먼저 닫고, 카드는 그다음이다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    const onClose = vi.fn();
    const host = mountCard({ line: "team", onClose });
    const input = await until(host, "ai-connect-card-key-input");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q(host, "ai-connect-card-key-form")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("ai-connect-card-team-key");
  });
});

describe("오프라인 저장 (review #2961 H1)", () => {
  const SECRET = ["sk", "-test-", "Off1ine7Paused3Key9Zq"].join("");

  function cardEl(offline: boolean) {
    return createElement(AiConnectCard, { line: "team", focusNonce: 1, offline, onClose: () => undefined });
  }

  it("폼을 연 채 끊기면 저장은 잠기고, 닫은 뒤 다시 이어져도 요청은 0회", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    vi.mocked(putProviderLink).mockResolvedValue(KEY_LINK);
    vi.mocked(testProviderLink).mockResolvedValue(probe(true));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    hosts.push(host);
    renderInto(root, cardEl(false));
    const input = (await until(host, "ai-connect-card-key-input")) as HTMLInputElement;

    // 연결이 끊긴다: 소켓(useOffline)과 react-query onlineManager 둘 다.
    act(() => onlineManager.setOnline(false));
    renderInto(root, cardEl(true));
    const save = q(host, "ai-connect-card-key-save") as HTMLButtonElement;
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(save.getAttribute("aria-describedby")?.split(" ")[0] ?? "")?.textContent).toContain(
      "연결이 끊겨"
    );
    input.value = SECRET;
    await act(async () => save.click());
    expect(putProviderLink).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll().filter((m) => m.state.isPaused)).toHaveLength(0);

    // 카드를 닫고(×·Esc·채널 이동) 다시 이어진다.
    act(() => root.unmount());
    await act(async () => {
      onlineManager.setOnline(true);
      await client.resumePausedMutations();
    });
    expect(putProviderLink).not.toHaveBeenCalled();
  });

  it("소켓은 붙어 있고 브라우저만 오프라인이어도 저장을 대기열에 두지 않는다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    vi.mocked(putProviderLink).mockRejectedValue(new TypeError("Failed to fetch"));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    hosts.push(host);
    renderInto(root, cardEl(false));
    const input = (await until(host, "ai-connect-card-key-input")) as HTMLInputElement;
    act(() => onlineManager.setOnline(false));
    input.value = SECRET;
    await act(async () => (q(host, "ai-connect-card-key-save") as HTMLButtonElement).click());
    // 바로 한 번 시도하고(실패는 제자리 오류 줄), 멈춰 둔 뮤테이션은 없다.
    expect(putProviderLink).toHaveBeenCalledTimes(1);
    expect(client.getMutationCache().getAll().filter((m) => m.state.isPaused)).toHaveLength(0);
    await until(host, "ai-connect-card-save-error");
    act(() => root.unmount());
    await act(async () => {
      onlineManager.setOnline(true);
      await client.resumePausedMutations();
    });
    expect(putProviderLink).toHaveBeenCalledTimes(1);
  });
});

describe("이미 쓰는 키를 바꿀 때 (design-review #2944 H1)", () => {
  it("버튼 이름이 순서를 말하고, 대체 전에 한 번 묻는다. 묻는 동안 저장은 없다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(probe(false, "provider_auth_failed"));
    const host = mountCard();
    const check = await until(host, "ai-connect-card-team-check");
    act(() => check.click());
    const swap = await until(host, "ai-connect-card-team-key");
    act(() => swap.click());
    const input = (await until(host, "ai-connect-card-key-input")) as HTMLInputElement;
    const save = q(host, "ai-connect-card-key-save") as HTMLButtonElement;
    expect(save.textContent).toBe("저장하고 확인");
    input.value = "replacement-key-000000000000000000";
    await act(async () => save.click());
    expect(putProviderLink).not.toHaveBeenCalled();
    expect(q(host, "ai-connect-card-key-replace")?.textContent).toContain("••••a4f2");
    expect(save.textContent).toBe("바꿔 저장하고 확인");
    // 묻는 동안 키는 칸에만 있다.
    expect(input.value).toBe("replacement-key-000000000000000000");
    expect(q(host, "ai-connect-card-key-replace")?.textContent).toContain("방금 확인에 실패했어요");
    // 칸을 고치면 묻기는 처음으로(다른 키가 두 번째 누름으로 저장되지 않게).
    act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    expect(q(host, "ai-connect-card-key-replace")).toBeNull();
    await act(async () => save.click());
    expect(putProviderLink).not.toHaveBeenCalled();
    vi.mocked(putProviderLink).mockResolvedValue(KEY_LINK);
    await act(async () => save.click());
    expect(putProviderLink).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
  });
});

describe("프리셋에 없는 지금 주소 (review #2961 M4)", () => {
  const CORP = {
    ...KEY_LINK,
    baseUrl: "https://llm.corp.example/v1",
    endpointLabel: "사내 프록시",
    format: "anthropic",
  } as ProviderLink;

  it("키 바꾸기는 지금 주소를 고른 채 열리고, 그 주소·와이어로 저장한다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(CORP);
    vi.mocked(testProviderLink).mockResolvedValue(probe(false, "provider_auth_failed"));
    const host = mountCard();
    const check = await until(host, "ai-connect-card-team-check");
    act(() => check.click());
    const swap = await until(host, "ai-connect-card-team-key");
    act(() => swap.click());
    const input = (await until(host, "ai-connect-card-key-input")) as HTMLInputElement;
    const current = q(host, "ai-connect-card-preset-current") as HTMLInputElement;
    expect(current.checked).toBe(true);
    expect(current.closest("label")?.textContent).toContain("사내 프록시");
    // 긴 주소는 칩 한 줄에서 말줄임, 전체는 title로(design-review #2961 N2).
    expect(current.closest("label")?.getAttribute("title")).toBe("사내 프록시");
    expect((q(host, "ai-connect-card-preset-openai") as HTMLInputElement).checked).toBe(false);
    input.value = "corp-key-0000000000000000";
    const save = q(host, "ai-connect-card-key-save") as HTMLButtonElement;
    await act(async () => save.click());
    expect(q(host, "ai-connect-card-key-replace")?.textContent).not.toContain("주소도");
    vi.mocked(putProviderLink).mockResolvedValue(CORP);
    await act(async () => save.click());
    expect(vi.mocked(putProviderLink).mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://llm.corp.example/v1",
      format: "anthropic",
    });
  });

  it("다른 프리셋을 고르면 대체 확인이 주소가 바뀐다고 말한다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(CORP);
    vi.mocked(testProviderLink).mockResolvedValue(probe(false, "provider_auth_failed"));
    const host = mountCard();
    const check = await until(host, "ai-connect-card-team-check");
    act(() => check.click());
    const swap = await until(host, "ai-connect-card-team-key");
    act(() => swap.click());
    const input = (await until(host, "ai-connect-card-key-input")) as HTMLInputElement;
    act(() => (q(host, "ai-connect-card-preset-openai") as HTMLInputElement).click());
    input.value = "openai-key-000000000000000";
    await act(async () => (q(host, "ai-connect-card-key-save") as HTMLButtonElement).click());
    expect(putProviderLink).not.toHaveBeenCalled();
    expect(q(host, "ai-connect-card-key-replace")?.textContent).toContain("주소도 OpenAI 주소로 바뀌어요");
  });
});

describe("흐름 ③ 연결 확인 · ④ 실패 제자리", () => {
  it("확인 중… → 확인됨, 그 줄에서만", async () => {
    let resolveTest: (t: ProviderLinkTest) => void = () => undefined;
    vi.mocked(testProviderLink).mockImplementation(
      () => new Promise<ProviderLinkTest>((resolve) => (resolveTest = resolve))
    );
    const host = mountCard();
    const check = await until(host, "ai-connect-card-team-check");
    act(() => check.click());
    await waitFor(() => expect(pillOf(q(host, "ai-connect-card-team"))).toEqual({ tone: "run", text: "확인 중…" }));
    expect(check.getAttribute("aria-busy")).toBe("true");
    expect(check.textContent).toBe("확인 중");
    expect(check.className).toContain("opacity-50");
    await act(async () => resolveTest(probe(true)));
    expect(pillOf(q(host, "ai-connect-card-team"))).toEqual({ tone: "ok", text: "확인됨" });
  });

  it("확인 실패: 알약은 bad, 결과 줄이 사유를 말하고 행동은 「키 바꾸기」 하나", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(probe(false, "provider_auth_failed"));
    const host = mountCard();
    const check = await until(host, "ai-connect-card-team-check");
    act(() => check.click());
    await waitFor(() => expect(pillOf(q(host, "ai-connect-card-team"))).toEqual({ tone: "bad", text: "확인 실패" }));
    const result = q(host, "ai-connect-card-team-result") as HTMLElement;
    expect(result.getAttribute("data-tone")).toBe("bad");
    expect(result.textContent).toBe("provider가 키를 거절했어요.");
    expect(q(host, "ai-connect-card-team-key")?.textContent).toContain("키 바꾸기");
    expect(q(host, "ai-connect-card-team-check")).toBeNull();
    expect(q(host, "ai-connect-card")).not.toBeNull();
  });

  it("구독 연결 확인은 상태 명령만 다시 묻는다", async () => {
    vi.mocked(detectLocalHarnesses).mockResolvedValue(READY);
    const host = mountCard();
    const check = await until(host, "ai-connect-card-claude-check");
    const before = vi.mocked(detectLocalHarnesses).mock.calls.length;
    act(() => check.click());
    await waitFor(() => expect(vi.mocked(detectLocalHarnesses).mock.calls.length).toBe(before + 1));
    await waitFor(() =>
      expect(q(host, "ai-connect-card-claude-result")?.textContent).toBe("마지막 확인 방금")
    );
    vi.mocked(detectLocalHarnesses).mockResolvedValue([
      { id: "claude", installed: true, auth: "unknown" },
      { id: "codex", installed: true, auth: "needs_login" },
    ]);
    act(() => q(host, "ai-connect-card-claude-check")?.click());
    await waitFor(() => expect(q(host, "ai-connect-card-claude-result")?.textContent).toBe("CLI가 답하지 않았어요"));
    expect(pillOf(q(host, "ai-connect-card-claude")).text).toBe("다시 확인");
  });
});

describe("네 상태 · 권한", () => {
  it("운영자가 아니면(403) 한 줄, 입력·버튼 0", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "operator required"));
    const host = mountCard({ line: "team" });
    const line = await until(host, "ai-connect-card-team-denied");
    expect(line.textContent).toBe("팀 키는 운영자만 바꾸고 확인할 수 있어요.");
    // 권한 문장은 한 번만(카드 발).
    expect(q(host, "ai-connect-card")?.textContent?.match(/운영자만/g)).toHaveLength(1);
    const section = q(host, "ai-connect-card-team-section") as HTMLElement;
    expect(section.querySelectorAll("input, button")).toHaveLength(0);
  });

  it("불러오기 실패는 그 절에서 말하고 다시 불러온다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(500, "서버 오류"));
    const host = mountCard({ line: "team" });
    const error = await until(host, "ai-connect-card-team-error");
    expect(error.textContent).toContain("팀 연결을 불러오지 못했어요");
    vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
    act(() => error.querySelector("button")?.click());
    await until(host, "ai-connect-card-team");
  });

  it("오프라인: 알약은 확인할 수 없음, 확인은 잠기고 사유가 붙는다", async () => {
    const host = mountCard({ offline: true });
    const check = await until(host, "ai-connect-card-team-check");
    expect(check.getAttribute("aria-disabled")).toBe("true");
    const reason = check.getAttribute("aria-describedby") as string;
    expect(document.getElementById(reason)?.textContent).toContain("연결이 끊겨");
    act(() => check.click());
    expect(testProviderLink).not.toHaveBeenCalled();
  });

  it("로딩 중에는 높이를 지키는 막대", async () => {
    vi.mocked(fetchProviderLink).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(detectLocalHarnesses).mockImplementation(() => new Promise(() => undefined));
    const host = mountCard();
    // 두 절이 각자 막대를 세운다(내 계정은 명부·CLI, 팀 연결은 provider_link).
    await waitFor(() =>
      expect(host.querySelectorAll("[data-testid='skeleton'][aria-busy='true']").length).toBe(2)
    );
    expect(q(host, "ai-connect-card-team")).toBeNull();
    expect(q(host, "ai-connect-card-claude")).toBeNull();
  });
});

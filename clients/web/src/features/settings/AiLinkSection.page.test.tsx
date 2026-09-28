// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, listChannels, type RosterMember } from "@momo/core/lib/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import {
  deleteProviderLink,
  fetchProviderChain,
  fetchProviderLink,
  fetchWorkspace,
  putProviderLink,
  testProviderLink,
} from "@momo/core/features/settings/api";
import {
  fetchProviderDefaultAi,
  putProviderDefaultAi,
} from "@momo/core/features/settings/defaultAi";
import { escapeIsClaimed } from "@/design/ui/escapeLayer";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiLinkSection } from "./AiLinkSection";

// =============================================================================
// 설정 › AI 연결 틀 (#2877). 시안 §1·§6: 두 절(내 계정 · 이 맥 / 팀 연결 · 이
// 서버), 곁판, 네 상태(비어 있음·운영자 아님·오프라인·브라우저 탭), 그리고
// auth.json 붙여넣기 제거(기존 링크는 읽기 전용 줄 + 끊기만).
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

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn(), listChannels: vi.fn() };
});

vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>();
  return { ...actual, listHostedConnections: vi.fn() };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(),
    fetchProviderChain: vi.fn(),
    fetchWorkspace: vi.fn(),
    deleteProviderLink: vi.fn(),
    putProviderLink: vi.fn(),
    testProviderLink: vi.fn(),
  };
});

vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, fetchProviderDefaultAi: vi.fn(), putProviderDefaultAi: vi.fn() };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

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
};

const OAUTH_LINK = {
  ...KEY_LINK,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  endpointLabel: "ChatGPT",
  credentialKind: "oauth-openai",
  credentialMeta: {
    accountLabel: "성재 개인",
    accessTokenPresent: true,
    accessTokenExpiresAtMs: 1_790_000_000_000,
    notice: "개인 구독으로 동작하는 내부용 연결입니다.",
  },
};

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
};

function session(connStatus: SessionContextValue["connStatus"]): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

let client: QueryClient | null = null;

function tree(offline: boolean) {
  return createElement(
    QueryClientProvider,
    { client: client as QueryClient },
    createElement(
      SessionProvider,
      { value: session(offline ? "disconnected" : "connected") },
      createElement(AiLinkSection, { offline, workspaceId: WS })
    )
  );
}

/** 같은 캐시로 오프라인 여부만 바꿔 다시 그린다(창이 열린 채 끊기는 경우). */
function setOffline(offline: boolean) {
  act(() => root?.render(tree(offline)));
}

function mount(offline = false): HTMLElement {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(tree(offline));
  });
  return host;
}

/** 문서 전체에서 찾는다: 확인 창은 body 로 포털된다. */
function dq(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function q(testId: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
}

async function until(testId: string): Promise<HTMLElement> {
  await rtlWaitFor(() => {
    if (!q(testId)) throw new Error(testId);
  });
  return q(testId) as HTMLElement;
}

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  envSlot.tauri = true;
  envSlot.flag = true;
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(putProviderLink).mockReset();
  vi.mocked(deleteProviderLink).mockReset();
  vi.mocked(fetchRoster).mockResolvedValue([me("owner")]);
  vi.mocked(fetchWorkspace).mockReset();
  vi.mocked(fetchWorkspace).mockResolvedValue({
    id: WS,
    slug: "team",
    name: "우리 팀",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: true,
  });
  vi.mocked(fetchProviderLink).mockReset();
  vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
  vi.mocked(fetchProviderChain).mockReset();
  vi.mocked(fetchProviderChain).mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(listChannels).mockReset();
  vi.mocked(listChannels).mockResolvedValue([]);
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(fetchProviderDefaultAi).mockReset();
  vi.mocked(fetchProviderDefaultAi).mockResolvedValue({ teamAgent: null, summary: null });
  vi.mocked(putProviderDefaultAi).mockReset();
  vi.mocked(testProviderLink).mockReset();
  vi.mocked(testProviderLink).mockResolvedValue({
    schema: "momo.provider_link.test.v0",
    ok: false,
    reason: "probe_not_run",
    source: "database",
    mode: "external-hermes",
    endpointLabel: "OpenAI",
    checkedAtMs: Date.now(),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("틀: 두 절과 순서 (#2877 시안 §1)", () => {
  it("내 계정 · 이 맥 → 팀 연결 · 이 서버 → 기본 AI 순서로 선다", async () => {
    mount();
    await until("ai-link-row");
    const titles = Array.from(
      host?.querySelectorAll("#ai-my-accounts-title, #ai-team-title, #ai-defaults-title") ?? []
    ).map((h) => h.textContent);
    expect(titles).toEqual(["내 계정", "팀 연결", "기본 AI"]);
    expect(q("ai-my-accounts")?.textContent).toContain("이 맥");
    expect(q("ai-team")?.textContent).toContain("이 서버");
    expect(q("ai-team")?.textContent).toContain("운영자 설정");
  });

  it("팀 줄은 마스킹 꼬리만 보이고, 곁판은 줄의 ⋯ 로 열리고 닫힌다", async () => {
    mount();
    const row = await until("ai-link-row");
    expect(row.textContent).toContain("••••a4f2");
    expect(row.textContent).toContain("API 키");
    expect(q("ai-team-aside")).toBeNull();
    const more = q("ai-link-row-more") as HTMLButtonElement;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(q("ai-team-aside")).not.toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(q("ai-board")?.hasAttribute("data-aside-open")).toBe(true);
    act(() => (q("ai-team-aside-close") as HTMLButtonElement).click());
    expect(q("ai-team-aside")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("키 연결의 곁판에는 확인·키 바꾸기·끊기가 있고, 키 바꾸기는 채팅 카드와 같은 키 폼이다", async () => {
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    expect(q("ai-link-check")).not.toBeNull();
    // 문구는 「연결 끊기」(#2878: 팀 API 키 줄).
    expect(q("ai-link-unlink")?.textContent).toBe("연결 끊기");
    act(() => (q("ai-link-edit") as HTMLButtonElement).click());
    expect(q("ai-link-key-form")).not.toBeNull();
    expect(q("ai-link-key-input")?.getAttribute("type")).toBe("password");
    expect(q("ai-link-key-input")?.getAttribute("autocomplete")).toBe("new-password");
    expect(host?.querySelector("textarea")).toBeNull();
    expect(q("ai-link-key-form")?.textContent).not.toContain("auth.json");
  });
});

describe("예비 provider 순서는 운영자에게 접혀 남는다 (#2877)", () => {
  it("접힘을 열면 기존 순서 편집기가 선다", async () => {
    mount();
    const toggle = await until("ai-team-chain-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host?.querySelector("#ai-team-chain")).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host?.querySelector("#ai-team-chain")).not.toBeNull();
  });

  it("운영자가 아니면 접힘도 없다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "operator required"));
    mount();
    await until("operator-notice");
    expect(q("ai-team-chain-toggle")).toBeNull();
  });
});

describe("기본 AI 표의 운영자 판정 = 팀 연결의 서버 답 (#2881)", () => {
  it("provider link 200이면 운영자 줄, 팀 요약 칸은 그 연결 이름", async () => {
    mount();
    const foot = await until("ai-defaults-team-foot");
    expect(foot.dataset.operator).toBe("yes");
    expect(q("ai-default-summary")?.textContent).toContain("팀 API 키");
  });

  it("403이면 운영자 아님 줄, 팀 키가 있다고도 없다고도 하지 않는다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "operator required"));
    mount();
    const foot = await until("ai-defaults-team-foot");
    expect(foot.dataset.operator).toBe("no");
    expect(q("ai-default-summary")?.textContent).toContain("팀 API 키 · 운영자 설정");
    expect(q("ai-default-teamAgent")?.dataset.state).toBe("ok");
  });
});

describe("기본 AI 팀 줄 저장 = default-ai 서버 답 (#3042)", () => {
  const CHECKED = {
    schema: "momo.provider_link.test.v0",
    ok: true,
    source: "database",
    mode: "external-hermes",
    endpointLabel: "OpenAI",
    checkedAtMs: Date.now(),
    entries: [
      {
        position: 0,
        source: "provider_link",
        mode: "external-hermes",
        endpointLabel: "https://api.openai.com/v1",
        enabled: true,
        ok: true,
        disposition: "ok",
        probe: { outcome: "ok", method: "models", latencyMs: 90, probedAtMs: 1, cached: false, modelIds: ["gpt-4o"] },
      },
    ],
  };

  async function checkNow() {
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    act(() => (q("ai-link-check") as HTMLButtonElement).click());
    await rtlWaitFor(() => expect(testProviderLink).toHaveBeenCalledTimes(1));
  }

  it("운영자(200)는 확인한 모델에서 골라 서버에 저장한다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(CHECKED as never);
    vi.mocked(putProviderDefaultAi).mockResolvedValue({
      teamAgent: { linkPosition: 0, endpointLabel: "https://api.openai.com/v1", linkResolved: true, modelId: "gpt-4o" },
      summary: null,
    });
    mount();
    // 확인 전: 칸이 아니라 할 일.
    await rtlWaitFor(() =>
      expect(q("ai-default-teamAgent-model")?.textContent).toBe("연결 확인을 하면 고를 수 있는 모델이 보여요.")
    );
    await checkNow();
    const select = (await until("ai-default-teamAgent-select")) as HTMLSelectElement;
    act(() => {
      select.value = "link:0:gpt-4o";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await rtlWaitFor(() => expect(putProviderDefaultAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putProviderDefaultAi).mock.calls[0]).toEqual([
      "teamAgent",
      { linkPosition: 0, modelId: "gpt-4o" },
    ]);
    await rtlWaitFor(() =>
      expect((q("ai-default-teamAgent-select") as HTMLSelectElement).value).toBe("link:0:gpt-4o")
    );
    expect(q("ai-defaults-team-foot")?.textContent).toContain("팀 줄의 선택은 서버에 저장돼요.");
  });

  it("default-ai 가 403이면 확인한 뒤에도 칸이 없다(서버 판정)", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(CHECKED as never);
    vi.mocked(fetchProviderDefaultAi).mockRejectedValue(new ApiError(403, "operator required"));
    mount();
    await checkNow();
    await until("ai-link-probe");
    expect(q("ai-default-teamAgent-select")).toBeNull();
    expect(q("ai-default-summary-select")).toBeNull();
  });

  it("비운영자(link 403)는 default-ai 를 부르지도 않는다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "operator required"));
    mount();
    await until("ai-defaults-team-foot");
    expect(fetchProviderDefaultAi).not.toHaveBeenCalled();
    expect(q("ai-default-teamAgent-select")).toBeNull();
  });

  it("저장이 403이면 그 줄에 누가 바꿀 수 있는지 말한다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(CHECKED as never);
    vi.mocked(putProviderDefaultAi).mockRejectedValue(new ApiError(403, "operator required"));
    mount();
    await checkNow();
    const select = (await until("ai-default-summary-select")) as HTMLSelectElement;
    act(() => {
      select.value = "link:0:";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const error = await until("ai-default-summary-error");
    expect(error.textContent).toBe("팀 줄은 이 서버의 운영자만 바꿀 수 있어요.");
    expect((q("ai-default-summary-select") as HTMLSelectElement | null)?.value ?? "").toBe("");
  });
});

describe("곁판의 키보드 길 (design-review #2877 H-1·H-2)", () => {
  function esc() {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  }

  it("편집 중 Esc 는 [취소]와 같다: 폼만 닫히고 곁판·설정은 남고 초점은 「키 바꾸기」", async () => {
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    act(() => (q("ai-link-edit") as HTMLButtonElement).click());
    (q("ai-link-key-save") as HTMLButtonElement).focus();
    expect(escapeIsClaimed()).toBe(true);
    esc();
    expect(q("ai-link-key-form")).toBeNull();
    expect(q("ai-team-aside")).not.toBeNull();
    expect(document.activeElement).toBe(q("ai-link-edit"));
  });

  it("비어 있는 서버: 「API 키 추가」 폼을 취소하면 초점은 「API 키 추가」, Esc 층도 내려간다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    const add = await until("ai-team-add");
    act(() => add.click());
    // 프리셋을 주지 않는 서버: 설정 폼은 「직접 주소」로 열리고 주소 칸이 첫 칸이다.
    expect(document.activeElement).toBe(q("ai-link-custom-url"));
    const cancel = Array.from(q("ai-link-key-form")?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "취소"
    ) as HTMLButtonElement;
    act(() => cancel.click());
    expect(q("ai-team-aside")).toBeNull();
    expect(document.activeElement).toBe(q("ai-team-add"));
    expect(escapeIsClaimed()).toBe(false);
  });

  it("비어 있는 서버: 저장이 끝나면 새 줄의 곁판 제목으로 초점이 간다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    vi.mocked(putProviderLink).mockResolvedValue(KEY_LINK as never);
    mount();
    const add = await until("ai-team-add");
    act(() => add.click());
    const url = q("ai-link-custom-url") as HTMLInputElement;
    const key = q("ai-link-key-input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(url, "https://api.openai.com/v1");
      url.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(key, "sk-test-a4f2");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
    act(() => (q("ai-link-key-save") as HTMLButtonElement).click());
    await until("ai-link-row");
    await rtlWaitFor(() => {
      const heading = q("ai-team-aside")?.querySelector("h3");
      if (!heading || document.activeElement !== heading) throw new Error("focus");
    });
  });

  it("편집이 아닐 때 Esc 는 곁판만 닫고 ⋯ 로 돌아온다", async () => {
    mount();
    await until("ai-link-row");
    const more = q("ai-link-row-more") as HTMLButtonElement;
    act(() => more.click());
    esc();
    expect(q("ai-team-aside")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("키 바꾸기 → 첫 칸, 취소 → 「키 바꾸기」 로 초점이 간다", async () => {
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    act(() => (q("ai-link-edit") as HTMLButtonElement).click());
    // 저장된 주소가 있으면 「지금 주소」로 열리고 키 칸이 첫 칸이다.
    expect(document.activeElement).toBe(q("ai-link-key-input"));
    const cancel = Array.from(q("ai-link-key-form")?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "취소"
    ) as HTMLButtonElement;
    act(() => cancel.click());
    expect(q("ai-link-key-form")).toBeNull();
    expect(document.activeElement).toBe(q("ai-link-edit"));
  });

  it("끊기가 끝나면 초점은 새 목록의 「API 키 추가」로 간다", async () => {
    vi.mocked(deleteProviderLink).mockResolvedValue(undefined as never);
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    act(() => (q("ai-link-unlink") as HTMLButtonElement).click());
    await rtlWaitFor(() => {
      if (dq("ai-link-unlink-confirm")?.getAttribute("aria-disabled") !== null) throw new Error("loading");
    });
    act(() => (dq("ai-link-unlink-confirm") as HTMLButtonElement).click());
    await until("ai-team-add");
    await rtlWaitFor(() => {
      if (document.activeElement !== q("ai-team-add")) throw new Error("focus");
    });
  });
});

describe("auth.json 붙여넣기 제거 (#2877, 제안서 Q3)", () => {
  it("기존 OAuth 링크는 「내부용 · 새로 만들 수 없음」 읽기 전용 줄이고 끊기만 있다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(OAUTH_LINK);
    mount();
    const row = await until("ai-link-row");
    expect(row.textContent).toContain("내부용");
    expect(row.textContent).toContain("새로 만들 수 없음");
    expect(row.textContent).toContain("읽기 전용");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    expect(q("ai-link-unlink")?.textContent).toBe("연결 끊기");
    expect(q("ai-link-edit")).toBeNull();
    expect(q("ai-link-check")).toBeNull();
    expect(q("ai-link-key-form")).toBeNull();
    expect(q("ai-team-add")).toBeNull();
  });

  it("비어 있는 서버에서 「API 키 추가」가 여는 폼에 등록 방식 선택도 붙여넣기 칸도 없다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    await until("ai-link-empty");
    act(() => (q("ai-team-add") as HTMLButtonElement).click());
    expect(q("ai-link-key-form")).not.toBeNull();
    expect(host?.querySelector("textarea")).toBeNull();
    expect(host?.querySelector('input[name="provider-method"]')).toBeNull();
    expect(host?.textContent).not.toContain("ChatGPT 계정 (OAuth)");
  });

  it("소스에 붙여넣기 경로가 남아 있지 않다", () => {
    const source = readFileSync("src/features/settings/AiLinkSection.tsx", "utf8");
    expect(source).not.toContain("parseAuthJson");
    expect(source).not.toContain("buildOAuthLinkBody");
    expect(source).not.toContain("<textarea");
  });
});

describe("네 상태 (#2877 시안 §6)", () => {
  it("비어 있음: 내 계정은 한 줄 + [구독 추가], 팀 연결은 한 줄 + [API 키 추가]", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    await until("ai-link-empty");
    await until("subscription-entry-open");
    expect(q("subscription-entry-open")?.textContent).toBe("구독 추가");
    expect(q("subscription-entry")?.textContent).toContain("아직 연결한 구독이 없어요.");
    expect(q("ai-team-add")?.textContent).toContain("API 키 추가");
    expect(q("ai-link-row")).toBeNull();
  });

  it("운영자 아님: 팀 절은 자물쇠와 문장, 행동 없음. 내 계정은 그대로", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "operator required"));
    mount();
    const notice = await until("operator-notice");
    expect(notice.textContent).toContain("운영자만");
    expect(q("ai-team")?.textContent).toContain("운영자 설정");
    expect(q("ai-team-add")).toBeNull();
    expect(q("ai-link-row")).toBeNull();
    await until("subscription-entry-open");
  });

  it("오프라인: 페이지 배너 하나, 팀 줄은 마지막 값을 「확인할 수 없음」으로", async () => {
    mount(true);
    const row = await until("ai-link-row");
    expect(q("ai-offline-banner")?.textContent).toContain("서버와 연결이 끊겼어요.");
    expect(row.textContent).toContain("확인할 수 없음");
    expect(row.textContent).toContain("마지막으로 받은 값");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    expect(q("ai-link-check")?.getAttribute("aria-disabled")).toBe("true");
    expect(q("ai-link-edit")?.getAttribute("aria-disabled")).toBe("true");
    expect(q("ai-link-offline")).not.toBeNull();
  });

  it("브라우저 탭: 내 계정 절은 데스크탑 앱 이유 한 줄, 행동 없음", async () => {
    envSlot.tauri = false;
    mount();
    const entry = await until("subscription-entry");
    expect(entry.getAttribute("data-surface")).toBe("desktop-only");
    expect(entry.textContent).toContain("데스크탑 앱에서만");
    expect(q("subscription-entry-open")).toBeNull();
  });
});

describe("팀 연결 AA-7 (#2880 시안 §3·§4 2b)", () => {
  const agent = (id: string, displayName: string, channelIds: string[], paused?: boolean): RosterMember => ({
    ...me("member"),
    id,
    kind: "agent",
    displayName,
    handle: displayName,
    role: undefined,
    channelIds,
    channelCount: channelIds.length,
    paused,
  });
  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  async function openUnlink() {
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    act(() => (q("ai-link-unlink") as HTMLButtonElement).click());
    await rtlWaitFor(() => {
      if (!dq("ai-link-unlink-impact")) throw new Error("loading");
    });
    return dq("ai-link-unlink-dialog") as HTMLElement;
  }

  it("끊기 확인 창은 이 키로 대답하는 팀 에이전트를 이름으로 보이고, 호스티드 에이전트는 빼고, 이름은 누를 수 없다", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([
      me("owner"),
      agent("a-1", "hermes", ["c-1"]),
      agent("a-2", "김인턴", ["c-2"], true),
      agent("a-3", "내 Claude", ["c-1"]),
    ]);
    vi.mocked(listChannels).mockResolvedValue([
      { id: "c-1", name: "리서치", kind: "public" },
      { id: "c-2", name: "전체", kind: "public" },
    ] as never);
    vi.mocked(listHostedConnections).mockResolvedValue({
      connections: [
        {
          id: "hc-1",
          agentMemberId: "a-3",
          status: "active",
          authMode: "bearer",
          audience: "x",
          approvedChannelIds: [],
          approvedScopes: [],
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });
    const dialog = await openUnlink();
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("OpenAI · 팀 기본 연결을 끊을까요?");
    expect(dq("ai-link-unlink-body")?.textContent).toBe(
      "이 키를 쓰는 팀 에이전트 2개가 대답할 수 없게 됩니다. 저장된 키는 서버에서 지워지고 다시 볼 수 없어요."
    );
    const names = Array.from(document.querySelectorAll('[data-testid="ai-link-unlink-agent"]')).map((li) => li.textContent);
    expect(names).toEqual(["@김인턴 (전체 채널 · 일시정지)", "@hermes (리서치 채널)"]);
    expect(dialog.textContent).not.toContain("내 Claude");
    // inert: 이름 줄에 누를 것이 없다.
    for (const li of document.querySelectorAll('[data-testid="ai-link-unlink-agent"]')) {
      expect(li.querySelector("a, button, [tabindex]")).toBeNull();
    }
    expect(dq("ai-link-unlink-no-switch")?.textContent).toContain("예비 provider로 조용히 넘어가지 않아요.");
    expect(dq("ai-link-unlink-confirm")?.textContent).toBe("연결 끊기");
  });

  it("호스티드 목록을 못 읽으면 숫자를 말하지 않고 그 사실을 말한다", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([me("owner"), agent("a-1", "hermes", [])]);
    vi.mocked(listHostedConnections).mockRejectedValue(new ApiError(403, "forbidden"));
    await openUnlink();
    expect(dq("ai-link-unlink-body")?.textContent).not.toMatch(/\d/);
    expect(dq("ai-link-unlink-unknown")?.textContent).toContain("목록을 불러오지 못했어요");
    expect(dq("ai-link-unlink-confirm")?.getAttribute("aria-disabled")).toBeNull();
  });

  it("창이 열린 채 연결이 끊기면 「연결 끊기」가 잠기고 까닭을 든다(design-review #2880 B1)", async () => {
    vi.mocked(deleteProviderLink).mockResolvedValue(undefined as never);
    await openUnlink();
    setOffline(true);
    const confirm = dq("ai-link-unlink-confirm") as HTMLButtonElement;
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    const reason = dq("ai-link-unlink-offline");
    expect(reason?.textContent).toContain("연결이 끊겨");
    expect(confirm.getAttribute("aria-describedby")).toBe(reason?.id);
    act(() => confirm.click());
    expect(deleteProviderLink).not.toHaveBeenCalled();
  });

  it("목록을 읽는 동안에는 끊지 못한다(누가 멈추는지 보기 전)", async () => {
    vi.mocked(listHostedConnections).mockReturnValue(new Promise(() => undefined));
    vi.mocked(deleteProviderLink).mockResolvedValue(undefined as never);
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    act(() => (q("ai-link-unlink") as HTMLButtonElement).click());
    const confirm = dq("ai-link-unlink-confirm") as HTMLButtonElement;
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    act(() => confirm.click());
    expect(deleteProviderLink).not.toHaveBeenCalled();
  });

  it("프리셋 칩으로 넣으면 그 주소·와이어로 저장하고 곧바로 확인한다. 지금 서버의 결과는 「확인 전」", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue({
      ...EMPTY_LINK,
      presets: [
        { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
        { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
      ],
    } as never);
    vi.mocked(putProviderLink).mockResolvedValue(KEY_LINK as never);
    mount();
    act(() => (q("ai-team-add") as HTMLButtonElement | null)?.click());
    const add = await until("ai-team-add");
    act(() => add.click());
    act(() => (q("ai-link-preset-anthropic") as HTMLInputElement).click());
    setValue(q("ai-link-key-input") as HTMLInputElement, "sk-ant-9c1e");
    vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
    act(() => (q("ai-link-key-save") as HTMLButtonElement).click());
    await rtlWaitFor(() => expect(putProviderLink).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putProviderLink).mock.calls[0][0]).toEqual({
      baseUrl: "https://api.anthropic.com/v1",
      bearer: "sk-ant-9c1e",
      mode: "external-hermes",
      format: "anthropic",
    });
    await rtlWaitFor(() => expect(testProviderLink).toHaveBeenCalledTimes(1));
    const result = await until("ai-link-probe");
    expect(result.textContent).toContain("확인 전");
    expect(q("ai-link-probe-text")?.textContent).toBe("이 서버는 아직 키를 직접 확인하지 않아요. 키는 저장됐어요.");
    expect(result.textContent).not.toContain("거절");
    // 쓰기 전용: 저장한 키가 화면 어디에도 없다.
    expect(host?.innerHTML).not.toContain("sk-ant-9c1e");
    expect(document.body.innerHTML).not.toContain("sk-ant-9c1e");
  });

  it("「직접 주소」는 주소를 검사하고, 틀리면 저장하지 않는다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    act(() => (q("ai-team-add") as HTMLButtonElement | null)?.click());
    const add = await until("ai-team-add");
    act(() => add.click());
    setValue(q("ai-link-custom-url") as HTMLInputElement, "api.example.com");
    setValue(q("ai-link-key-input") as HTMLInputElement, "sk-x");
    act(() => (q("ai-link-key-save") as HTMLButtonElement).click());
    expect(putProviderLink).not.toHaveBeenCalled();
    expect(q("ai-link-key-form")?.textContent).toContain("http:// 또는 https://");
  });
});

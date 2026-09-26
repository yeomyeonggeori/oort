// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, type RosterMember } from "@momo/core/lib/api";
import {
  deleteProviderLink,
  fetchProviderChain,
  fetchProviderLink,
  fetchWorkspace,
  putProviderLink,
} from "@momo/core/features/settings/api";
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
    deleteProviderLink: vi.fn(),
    putProviderLink: vi.fn(),
  };
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

function mount(offline = false): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: session(offline ? "disconnected" : "connected") },
          createElement(AiLinkSection, { offline })
        )
      )
    );
  });
  return host;
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

  it("키 연결의 곁판에는 확인·키 바꾸기·해제가 있고, 키 바꾸기는 키 한 벌 폼이다", async () => {
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    expect(q("ai-link-check")).not.toBeNull();
    expect(q("ai-link-unlink")).not.toBeNull();
    act(() => (q("ai-link-edit") as HTMLButtonElement).click());
    expect(q("ai-link-form")).not.toBeNull();
    expect(host?.querySelector("#provider-bearer")?.getAttribute("type")).toBe("password");
    expect(host?.querySelector("textarea")).toBeNull();
    expect(q("ai-link-form")?.textContent).not.toContain("auth.json");
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
    (q("ai-link-save") as HTMLButtonElement).focus();
    expect(escapeIsClaimed()).toBe(true);
    esc();
    expect(q("ai-link-form")).toBeNull();
    expect(q("ai-team-aside")).not.toBeNull();
    expect(document.activeElement).toBe(q("ai-link-edit"));
  });

  it("비어 있는 서버: 「API 키 추가」 폼을 취소하면 초점은 「API 키 추가」, Esc 층도 내려간다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    const add = await until("ai-team-add");
    act(() => add.click());
    expect(document.activeElement?.id).toBe("provider-base-url");
    const cancel = Array.from(q("ai-link-form")?.querySelectorAll("button") ?? []).find(
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
    const url = host?.querySelector("#provider-base-url") as HTMLInputElement;
    const key = host?.querySelector("#provider-bearer") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(url, "https://api.openai.com/v1");
      url.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(key, "sk-test-a4f2");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
    act(() => (q("ai-link-save") as HTMLButtonElement).click());
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
    expect(document.activeElement?.id).toBe("provider-base-url");
    const cancel = Array.from(q("ai-link-form")?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "취소"
    ) as HTMLButtonElement;
    act(() => cancel.click());
    expect(q("ai-link-form")).toBeNull();
    expect(document.activeElement).toBe(q("ai-link-edit"));
  });

  it("해제가 끝나면 초점은 새 목록의 「API 키 추가」로 간다", async () => {
    vi.mocked(deleteProviderLink).mockResolvedValue(undefined as never);
    mount();
    await until("ai-link-row");
    act(() => (q("ai-link-row-more") as HTMLButtonElement).click());
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    act(() => (q("ai-link-unlink") as HTMLButtonElement).click());
    act(() => (q("ai-link-unlink-confirm") as HTMLButtonElement).click());
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
    expect(q("ai-link-unlink")?.textContent).toContain("연결 해제");
    expect(q("ai-link-edit")).toBeNull();
    expect(q("ai-link-check")).toBeNull();
    expect(q("ai-link-form")).toBeNull();
    expect(q("ai-team-add")).toBeNull();
  });

  it("비어 있는 서버에서 「API 키 추가」가 여는 폼에 등록 방식 선택도 붙여넣기 칸도 없다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue(EMPTY_LINK);
    mount();
    await until("ai-link-empty");
    act(() => (q("ai-team-add") as HTMLButtonElement).click());
    expect(q("ai-link-form")).not.toBeNull();
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

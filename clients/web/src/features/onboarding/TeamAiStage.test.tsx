// @vitest-environment jsdom
// #4945 (ADR-0201 증보 v3 B3·B10): 온보딩의 건너뛸 수 있는 팀 AI 단계.
// 키 넣기와 연결 확인 → 이름 → 역할 → 켜기. 「나중에」는 서버에 아무것도 쓰지 않는다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TeamAiStage } from "./TeamAiStage";

const calls = vi.hoisted(() => ({ log: [] as string[] }));
const fetchLink = vi.hoisted(() => vi.fn());
const putLink = vi.hoisted(() => vi.fn());
const testLink = vi.hoisted(() => vi.fn());
const putDefaultAi = vi.hoisted(() => vi.fn());
const patchRoles = vi.hoisted(() => vi.fn());
const setSwitch = vi.hoisted(() => vi.fn());
const fetchBag = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: () => fetchLink() as Promise<unknown>,
    putProviderLink: (...args: unknown[]) => putLink(...args) as Promise<unknown>,
    testProviderLink: () => testLink() as Promise<unknown>,
  };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, putProviderDefaultAi: (...args: unknown[]) => putDefaultAi(...args) as Promise<unknown> };
});
vi.mock("@momo/core/features/settings/teamAiSwitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiSwitch")>();
  return {
    ...actual,
    setTeamAiSwitch: (...args: unknown[]) => setSwitch(...args) as Promise<unknown>,
    fetchWorkspaceSettingsBag: (...args: unknown[]) => fetchBag(...args) as Promise<unknown>,
  };
});
vi.mock("@momo/core/features/settings/teamAiRoles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiRoles")>();
  return { ...actual, patchTeamAiRoles: (...args: unknown[]) => patchRoles(...args) as Promise<unknown> };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, renameAgent: (...args: unknown[]) => rename(...args) as Promise<unknown> };
});

const WS = "00000000-0000-7000-8000-000000000001";
const HELPER = "00000000-0000-7000-8000-0000000000a1";
const PRESET = {
  id: "anthropic",
  label: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  format: "anthropic",
};
const EMPTY_LINK = {
  configured: false,
  keyConfigured: false,
  availability: "mock",
  baseUrl: "",
  endpointLabel: "",
  presets: [PRESET],
};
const SAVED_LINK = {
  configured: true,
  keyConfigured: true,
  availability: "live",
  baseUrl: "https://api.anthropic.com",
  endpointLabel: "api.anthropic.com",
  presets: [PRESET],
};
const PROBE_OK = { schema: "momo.provider_link_test.v0", ok: true, source: "database", mode: "external-hermes", endpointLabel: "api.anthropic.com", checkedAtMs: 1 };
const SECRET = "sk-ant-onboarding-secret-000000000000";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  calls.log = [];
  for (const fn of [fetchLink, putLink, testLink, putDefaultAi, patchRoles, setSwitch, fetchBag, rename]) fn.mockReset();
  fetchLink.mockResolvedValue(EMPTY_LINK);
  putLink.mockResolvedValue(SAVED_LINK);
  testLink.mockResolvedValue(PROBE_OK);
  putDefaultAi.mockImplementation(async () => {
    calls.log.push("default_ai");
    return {};
  });
  patchRoles.mockImplementation(async (_ws: string, change: unknown) => {
    calls.log.push(`roles:${JSON.stringify(change)}`);
    return {};
  });
  setSwitch.mockImplementation(async () => {
    calls.log.push("enable");
    return { team_ai_fast_path: true, team_ai_agent_member_id: HELPER };
  });
  rename.mockImplementation(async (_ws: string, member: string, name: string) => {
    calls.log.push(`rename:${member}:${name}`);
    return { id: member, displayName: name };
  });
  fetchBag.mockResolvedValue({
    team_ai_fast_path: true,
    team_ai_agent_member_id: HELPER,
    team_ai_alias_status: { oort: "registered", 오르트: "registered", claude: "registered", 비서봇: "registered" },
  });
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root?.render(
      createElement(QueryClientProvider, {
        client,
        children: createElement(LocaleProvider, { locale: korean, children: node }),
      })
    );
  });
  return host;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string) {
  const node = q(testId);
  expect(node, testId).not.toBeNull();
  await act(async () => {
    (node as HTMLElement).click();
  });
  await settle();
}

function stage(props: Partial<Parameters<typeof TeamAiStage>[0]> = {}) {
  const onSkip = vi.fn();
  const onComplete = vi.fn();
  mount(createElement(TeamAiStage, { workspaceId: WS, onSkip, onComplete, ...props }));
  return { onSkip, onComplete };
}

function view(): string | null | undefined {
  return q("onboarding-team-ai")?.getAttribute("data-view");
}

function writesSoFar(): number {
  return [putLink, testLink, putDefaultAi, patchRoles, setSwitch, rename].reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

describe("키가 없으면 「나중에」로 넘어가고 도우미는 꺼진 채다", () => {
  it("운영자가 키를 아직 안 넣었다: 키 폼과 「나중에」, 누르면 쓰기 0회로 넘어간다", async () => {
    const { onSkip } = stage();
    await settle();
    expect(view()).toBe("key");
    expect(q("onboarding-team-ai-key-input")).not.toBeNull();
    expect(q("onboarding-team-ai-key-save")).not.toBeNull();
    expect(q("onboarding-team-ai-key-cancel")).toBeNull();
    expect(q("onboarding-team-ai-title")?.textContent).toBe("팀 AI 키를 넣어 볼까요?");
    expect(q("onboarding-team-ai-skip")?.textContent).toBe("나중에");
    await click("onboarding-team-ai-skip");
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(writesSoFar()).toBe(0);
    expect(calls.log).toEqual([]);
  });

  it("운영자가 아니면(403) 키 칸 대신 한 줄과 계속이다. 쓰기는 없다", async () => {
    fetchLink.mockRejectedValue(new ApiError(403, "platform:read scope required"));
    const { onSkip } = stage();
    await settle();
    expect(view()).toBe("not-operator");
    expect(q("onboarding-team-ai-key-input")).toBeNull();
    expect(q("onboarding-team-ai-title")?.textContent).toBe("팀 AI 키는 서버 운영자가 넣어요.");
    await click("onboarding-team-ai-continue-skip");
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(writesSoFar()).toBe(0);
  });
});

describe("키 넣기와 연결 확인", () => {
  it("저장한 키의 연결 확인이 실패하면 사유를 말하고 도우미를 켜지 않는다. 키 값은 화면에 남지 않는다", async () => {
    testLink.mockResolvedValue({ ...PROBE_OK, ok: false, reason: "provider_auth_failed" });
    stage();
    await settle();
    const input = q("onboarding-team-ai-key-input") as HTMLInputElement;
    input.value = SECRET;
    await click("onboarding-team-ai-key-save");
    expect(putLink).toHaveBeenCalledTimes(1);
    expect(putLink.mock.calls[0]?.[0]).toMatchObject({ baseUrl: "https://api.anthropic.com", bearer: SECRET });
    expect(testLink).toHaveBeenCalledTimes(1);
    expect(view()).toBe("key");
    expect(q("onboarding-team-ai-title")?.textContent).toBe("키를 확인하지 못했어요.");
    expect(document.body.textContent).toContain("provider가 키를 거절했어요.");
    expect(document.body.textContent).not.toContain(SECRET);
    expect((q("onboarding-team-ai-key-input") as HTMLInputElement).value).toBe("");
    expect(q("onboarding-team-ai-setup")).toBeNull();
    expect(setSwitch).not.toHaveBeenCalled();
    expect(putDefaultAi).not.toHaveBeenCalled();
  });

  it("이미 키가 있는 서버는 열자마자 확인하고, 통과하면 이름·역할 단계로 간다", async () => {
    fetchLink.mockResolvedValue(SAVED_LINK);
    stage();
    await settle();
    expect(testLink).toHaveBeenCalledTimes(1);
    expect(putLink).not.toHaveBeenCalled();
    expect(view()).toBe("setup");
    expect(q("onboarding-team-ai-setup")).not.toBeNull();
  });
});

describe("이름과 역할 고르기", () => {
  async function toSetup() {
    fetchLink.mockResolvedValue(SAVED_LINK);
    const handlers = stage();
    await settle();
    expect(view()).toBe("setup");
    return handlers;
  }

  it("이름 기본값은 「oort 도우미」이고, 일곱 묶음이 모두 켜져 있고 chat_read는 잠겨 있다. 고지 줄이 선다", async () => {
    await toSetup();
    expect((q("onboarding-team-ai-name") as HTMLInputElement).value).toBe("oort 도우미");
    const ids = ["chat_read", "workspace_admin", "invite_access", "long_research", "files", "memory", "code"];
    for (const id of ids) {
      const toggle = q(`onboarding-team-ai-role-${id}`) as HTMLButtonElement;
      expect(toggle, id).not.toBeNull();
      expect(toggle.getAttribute("aria-checked"), id).toBe("true");
      expect(toggle.disabled, id).toBe(id === "chat_read");
    }
    expect(q("onboarding-team-ai-notice")?.textContent).toBe(
      "파일과 기억을 켜면 도우미가 읽은 첨부 파일과 찾은 팀 기억의 내용이 팀 AI 공급자(팀 키를 발급한 AI 회사)에게 전달돼요."
    );
    await click("onboarding-team-ai-role-memory");
    expect(q("onboarding-team-ai-notice")?.textContent).toContain("파일을 켜면 도우미가 읽은 첨부 파일");
    await click("onboarding-team-ai-role-files");
    expect(q("onboarding-team-ai-notice")).toBeNull();
    expect(writesSoFar()).toBe(1);
  });

  it("끈 묶음과 새 이름은 켜는 순서대로 한 번씩 쓰이고, 결과 줄이 새 부름 이름을 보인다", async () => {
    const { onComplete } = await toSetup();
    await click("onboarding-team-ai-role-files");
    await click("onboarding-team-ai-role-code");
    const name = q("onboarding-team-ai-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "비서봇");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("onboarding-team-ai-enable");
    expect(calls.log).toEqual([
      "default_ai",
      `roles:${JSON.stringify({ files: false, code: false })}`,
      "enable",
      `rename:${HELPER}:비서봇`,
    ]);
    expect(putDefaultAi).toHaveBeenCalledWith("teamAgent", { linkPosition: 0, modelId: null });
    expect(view()).toBe("done");
    expect(q("onboarding-team-ai-aliases")?.textContent).toBe("부르는 이름: @oort · @오르트 · @claude · @비서봇");
    expect(q("onboarding-team-ai-rename-failed")).toBeNull();
    await click("onboarding-team-ai-continue");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("이름이 겹쳐 거절돼도 켜기는 끝난 채이고, 이유와 다음 행동을 말한다", async () => {
    rename.mockRejectedValue(new ApiError(409, "display name is already in use"));
    await toSetup();
    const name = q("onboarding-team-ai-name") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "김하늘");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("onboarding-team-ai-enable");
    expect(view()).toBe("done");
    expect(setSwitch).toHaveBeenCalledTimes(1);
    const banner = q("onboarding-team-ai-rename-failed")?.textContent ?? "";
    expect(banner).toContain("다른 멤버가 쓰고 있거나 비슷해 보이는 이름이에요.");
    expect(banner).toContain("설정 › AI에서 다시 바꿔 보세요.");
  });

  it("역할 저장이 실패하면 도우미를 켜지 않고, 다시 누르면 끝난 단계는 건너뛴다", async () => {
    patchRoles.mockRejectedValueOnce(new ApiError(503, "down"));
    await toSetup();
    await click("onboarding-team-ai-role-memory");
    await click("onboarding-team-ai-enable");
    expect(view()).toBe("setup");
    expect(q("onboarding-team-ai-error")?.textContent).toContain("할 일을 바꾸지 못했어요.");
    expect(setSwitch).not.toHaveBeenCalled();
    expect(q("onboarding-team-ai-title")?.textContent).toBe("도우미를 켜지 못했어요.");
    await click("onboarding-team-ai-enable");
    expect(view()).toBe("done");
    expect(putDefaultAi).toHaveBeenCalledTimes(1);
    expect(patchRoles).toHaveBeenCalledTimes(2);
    expect(setSwitch).toHaveBeenCalledTimes(1);
  });
});

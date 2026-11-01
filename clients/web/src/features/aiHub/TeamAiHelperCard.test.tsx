// @vitest-environment jsdom
// #4945 (ADR-0201 증보 v3 B3·B10): 설정 › AI의 「도우미」 카드. 관리자가 이름과 역할을 바꾼다.
// 이름을 바꾸면 멘션 별칭이 함께 바뀌는 것은 서버가 하고, 화면은 그 결과를 보인다.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TeamAiHelperCard } from "./TeamAiHelperCard";

const fetchBag = vi.hoisted(() => vi.fn());
const rename = vi.hoisted(() => vi.fn());
const patchRoles = vi.hoisted(() => vi.fn());
const roster = vi.hoisted(() => ({ rows: [] as RosterMember[] }));

vi.mock("@momo/core/features/settings/teamAiSwitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiSwitch")>();
  return { ...actual, fetchWorkspaceSettingsBag: (...args: unknown[]) => fetchBag(...args) as Promise<unknown> };
});
vi.mock("@momo/core/features/settings/teamAiRoles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiRoles")>();
  return { ...actual, patchTeamAiRoles: (...args: unknown[]) => patchRoles(...args) as Promise<unknown> };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    renameAgent: (...args: unknown[]) => rename(...args) as Promise<unknown>,
    fetchRoster: () => Promise.resolve(roster.rows),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const HELPER = "00000000-0000-7000-8000-0000000000a1";
const DEFAULT_ALIASES = { oort: "registered", 오르트: "registered", claude: "registered" };

function bag(over: Record<string, unknown> = {}) {
  return {
    team_ai_fast_path: true,
    team_ai_agent_member_id: HELPER,
    team_ai_alias_status: DEFAULT_ALIASES,
    ...over,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  for (const fn of [fetchBag, rename, patchRoles]) fn.mockReset();
  roster.rows = [
    {
      id: HELPER,
      workspaceId: WS,
      kind: "agent",
      status: "active",
      handle: "oort-helper",
      displayName: "oort 도우미",
    } as RosterMember,
  ];
  fetchBag.mockResolvedValue(bag());
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root?.render(
      createElement(QueryClientProvider, {
        client,
        children: createElement(LocaleProvider, {
          locale: korean,
          children: createElement(TeamAiHelperCard, { workspaceId: WS }),
        }),
      })
    );
  });
  await settle();
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

async function typeName(value: string) {
  const input = q("team-ai-helper-name") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ROLE_IDS = ["chat_read", "workspace_admin", "invite_access", "long_research", "files", "memory", "code"];

describe("카드는 확인된 뒤에만 선다", () => {
  it("관리자가 켠 도우미에게 선다: 이름이 제목이고 일곱 묶음이 켜져 있으며 파일·기억 옆에 고지가 늘 보인다", async () => {
    await mount();
    expect(q("team-ai-helper-title")?.textContent).toBe("oort 도우미");
    for (const id of ROLE_IDS) {
      expect(q(`team-ai-helper-role-${id}`)?.getAttribute("aria-checked"), id).toBe("true");
    }
    expect((q("team-ai-helper-role-chat_read") as HTMLButtonElement).disabled).toBe(true);
    expect(q("team-ai-helper-role-notice-files")?.textContent).toContain("첨부 파일의 내용이 팀 AI 공급자");
    expect(q("team-ai-helper-role-notice-memory")?.textContent).toContain("팀 기억의 내용이 팀 AI 공급자");
    expect(q("team-ai-helper-role-notice-code")).toBeNull();
    expect(q("team-ai-helper-aliases")?.textContent).toBe("부르는 이름: @oort · @오르트 · @claude");
  });

  it("구성원(가방 403)과 꺼진 도우미에게는 아무것도 그리지 않는다", async () => {
    fetchBag.mockRejectedValue(new ApiError(403, "forbidden"));
    await mount();
    expect(q("team-ai-helper")).toBeNull();
    if (root) act(() => root?.unmount());
    host?.remove();
    fetchBag.mockResolvedValue(bag({ team_ai_fast_path: false }));
    await mount();
    expect(q("team-ai-helper")).toBeNull();
  });
});

describe("이름 바꾸기: 별칭이 따라가는 결과를 보인다", () => {
  it("새 이름을 저장하면 한 번 부르고, 가방을 다시 읽어 새 부름 이름 줄을 보인다", async () => {
    rename.mockImplementation(async (_ws: string, member: string, name: string) => {
      // 서버가 이름과 별칭을 같은 트랜잭션에서 저장한 뒤의 사실: 다시 읽으면 새 이름과 새 별칭이 온다.
      roster.rows = roster.rows.map((row) => ({ ...row, displayName: name }));
      fetchBag.mockResolvedValue(
        bag({ team_ai_alias_status: { ...DEFAULT_ALIASES, 비서봇: "registered" } })
      );
      return { id: member, displayName: name };
    });
    await mount();
    expect(q("team-ai-helper-name-save")?.getAttribute("aria-disabled")).toBe("true");
    await typeName("  비서봇 ");
    expect(q("team-ai-helper-name-save")?.getAttribute("aria-disabled")).toBeNull();
    await click("team-ai-helper-name-save");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(WS, HELPER, "비서봇");
    expect(q("team-ai-helper-name-saved")?.textContent).toBe("이름을 바꿨어요.");
    expect(q("team-ai-helper-aliases")?.textContent).toBe("부르는 이름: @oort · @오르트 · @claude · @비서봇");
    expect(q("team-ai-helper-title")?.textContent).toBe("비서봇");
  });

  it("이름이 겹치면 거절 이유를 말하고 저장됐다고 하지 않는다", async () => {
    rename.mockRejectedValue(new ApiError(409, "display name is already in use"));
    await mount();
    await typeName("김하늘");
    await click("team-ai-helper-name-save");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(q("team-ai-helper-name-error")?.textContent).toBe(
      "다른 멤버가 쓰고 있거나 비슷해 보이는 이름이에요. 다른 이름으로 적어 주세요."
    );
    expect(q("team-ai-helper-name")?.getAttribute("aria-invalid")).toBe("true");
    expect(q("team-ai-helper-name-saved")).toBeNull();
    expect(q("team-ai-helper-title")?.textContent).toBe("oort 도우미");
  });
});

describe("역할 켜고 끄기: 누르는 즉시 그 묶음 하나만 저장한다", () => {
  it("파일을 끄면 {files:false} 한 칸만 보내고, 팀 기억이 꺼져 있어 기억을 못 켜면 이유를 말하고 되돌린다", async () => {
    patchRoles.mockImplementation(async () => {
      fetchBag.mockResolvedValue(bag({ team_ai_roles: { files: false } }));
      return bag({ team_ai_roles: { files: false } });
    });
    await mount();
    await click("team-ai-helper-role-files");
    expect(patchRoles).toHaveBeenCalledTimes(1);
    expect(patchRoles.mock.calls[0]).toEqual([WS, { files: false }]);
    expect(q("team-ai-helper-role-files")?.getAttribute("aria-checked")).toBe("false");
    expect(q("team-ai-helper-role-memory")?.getAttribute("aria-checked")).toBe("true");

    fetchBag.mockResolvedValue(bag({ team_ai_roles: { memory: false } }));
    patchRoles.mockRejectedValue(new ApiError(409, "team memory is off", "team_memory_off"));
    if (root) act(() => root?.unmount());
    host?.remove();
    await mount();
    expect(q("team-ai-helper-role-memory")?.getAttribute("aria-checked")).toBe("false");
    await click("team-ai-helper-role-memory");
    expect(patchRoles).toHaveBeenLastCalledWith(WS, { memory: true });
    expect(q("team-ai-helper-roles-error")?.textContent).toBe("팀 기억이 꺼져 있어요. 설정 › 기억에서 먼저 켜 주세요.");
    expect(q("team-ai-helper-role-memory")?.getAttribute("aria-checked")).toBe("false");
  });
});

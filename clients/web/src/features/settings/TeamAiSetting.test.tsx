// @vitest-environment jsdom
// ADR-0201 D8 (#3836): 「oort 도우미」 스위치는 확인된 서버·운영자에게만 선다.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { TeamAiSetting } from "./TeamAiSetting";

const roster = vi.hoisted(() => ({ rows: [] as RosterMember[] }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: () => Promise.resolve(roster.rows) };
});

const fetchBag = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());
const setSwitch = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/teamAiSwitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiSwitch")>();
  return {
    ...actual,
    fetchWorkspaceSettingsBag: (...args: unknown[]) => fetchBag(...args) as Promise<unknown>,
    probeTeamAiSwitch: (...args: unknown[]) => probe(...args) as Promise<unknown>,
    setTeamAiSwitch: (...args: unknown[]) => setSwitch(...args) as Promise<unknown>,
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  fetchBag.mockReset();
  probe.mockReset();
  setSwitch.mockReset();
  roster.rows = [];
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function flush() {
  // 쿼리 두 단(가방 → 물음)이 정착할 때까지 매크로태스크를 몇 번 돈다.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(offline = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TeamAiSetting, { workspaceId: WS, offline })
      )
    );
  });
  await flush();
  return host;
}

const card = (view: HTMLElement) =>
  view.querySelector('[data-testid="workspace-team-ai-card"]');
const toggle = (view: HTMLElement) =>
  view.querySelector<HTMLButtonElement>('[data-testid="workspace-team-ai"]');

describe("oort 도우미 스위치", () => {
  it("가방에 키가 있으면 묻지 않고 그 값을 보여 준다", async () => {
    fetchBag.mockResolvedValue({ team_ai_fast_path: false });
    const view = await mount();
    expect(card(view)).not.toBeNull();
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("false");
    expect(probe).not.toHaveBeenCalled();
  });

  it("제목과 설명은 도우미 멤버의 표시 이름을 따라가고, 멤버가 없으면 기본 이름이다 (#4945, B10-7)", async () => {
    fetchBag.mockResolvedValue({ team_ai_fast_path: false });
    const before = await mount();
    expect(card(before)?.textContent).toContain("oort 도우미");
    act(() => root?.unmount());
    root = null;
    roster.rows = [
      {
        id: "00000000-0000-7000-8000-0000000000a1",
        workspaceId: WS,
        kind: "agent",
        status: "active",
        handle: "oort-helper",
        displayName: "비서봇",
      } as RosterMember,
    ];
    fetchBag.mockResolvedValue({
      team_ai_fast_path: false,
      team_ai_agent_member_id: "00000000-0000-7000-8000-0000000000a1",
    });
    const view = await mount();
    const text = card(view)?.textContent ?? "";
    expect(text).toContain("비서봇");
    expect(text).toContain("켜면 「비서봇」 에이전트가 생기고");
    expect(text).not.toContain("oort 도우미");
  });

  it("키가 없고 서버가 안다고 답하면 꺼진 스위치가 선다", async () => {
    fetchBag.mockResolvedValue({});
    probe.mockResolvedValue("ready");
    const view = await mount();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("false");
  });

  it("스위치를 모르는 서버에서는 아무 것도 그리지 않는다", async () => {
    fetchBag.mockResolvedValue({});
    probe.mockResolvedValue("absent");
    const view = await mount();
    expect(card(view)).toBeNull();
    expect(view.textContent).toBe("");
  });

  it("확인하지 못하면 그리지 않는다", async () => {
    fetchBag.mockResolvedValue({});
    probe.mockResolvedValue("unknown");
    const view = await mount();
    expect(card(view)).toBeNull();
  });

  it("운영자가 아니면(가방 403) 묻지도 그리지도 않는다", async () => {
    fetchBag.mockRejectedValue(new ApiError(403, "forbidden"));
    const view = await mount();
    expect(card(view)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("켜면 true 를 저장하고, 이름이 겹치면 고칠 방법을 말한다", async () => {
    fetchBag.mockResolvedValue({ team_ai_fast_path: false });
    setSwitch.mockRejectedValueOnce(new ApiError(409, "taken", "team_ai_unavailable"));
    const view = await mount();
    await act(async () => {
      toggle(view)?.click();
    });
    await flush();
    expect(setSwitch).toHaveBeenCalledWith(WS, true);
    expect(
      view.querySelector('[data-testid="workspace-team-ai-save-error"]')?.textContent
    ).toContain("oort-helper");
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("false");

    setSwitch.mockResolvedValueOnce({ team_ai_fast_path: true, team_ai_agent_member_id: "m" });
    await act(async () => {
      toggle(view)?.click();
    });
    await flush();
    expect(toggle(view)?.getAttribute("aria-checked")).toBe("true");
  });

  it("오프라인이면 눌러도 저장하지 않는다", async () => {
    fetchBag.mockResolvedValue({ team_ai_fast_path: false });
    const view = await mount(true);
    await act(async () => {
      toggle(view)?.click();
    });
    expect(setSwitch).not.toHaveBeenCalled();
  });
});

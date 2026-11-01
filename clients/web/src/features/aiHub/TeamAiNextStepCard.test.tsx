// @vitest-environment jsdom
// ADR-0201 증보 v2 H8 (#3893): 키 저장 뒤 「팀 AI(oort 도우미) 켜기」 다음 단계 카드.
// H13-A20: 비 운영자에게 안 보이고, 켜기 409는 이유 문장으로, 성공하면 작성창에 이름이 채워진다.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@momo/core/lib/api";
import { TeamAiNextStepCard } from "./TeamAiNextStepCard";

const fetchLink = vi.hoisted(() => vi.fn());
const fetchDefaultAi = vi.hoisted(() => vi.fn());
const fetchBag = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());
const setSwitch = vi.hoisted(() => vi.fn());
const seed = vi.hoisted(() => vi.fn());
const roster = vi.hoisted(() => ({ rows: [] as RosterMember[] }));
const rooms = vi.hoisted(() => ({ rows: [] as Channel[] }));

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchProviderLink: () => fetchLink() as Promise<unknown> };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, fetchProviderDefaultAi: () => fetchDefaultAi() as Promise<unknown> };
});
vi.mock("@momo/core/features/settings/teamAiSwitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiSwitch")>();
  return {
    ...actual,
    fetchWorkspaceSettingsBag: (...args: unknown[]) => fetchBag(...args) as Promise<unknown>,
    probeTeamAiSwitch: (...args: unknown[]) => probe(...args) as Promise<unknown>,
    setTeamAiSwitch: (...args: unknown[]) => setSwitch(...args) as Promise<unknown>,
  };
});
vi.mock("@/features/chat/draftStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/draftStore")>();
  return { ...actual, seedComposerText: (...args: unknown[]) => seed(...args) as boolean };
});
vi.mock("@/features/workspace/useWorkspace", async () => {
  const { makeDirectory } = await import("@momo/core/features/workspace/directory");
  return {
    useDirectory: () => ({ data: roster.rows, isPending: false, directory: makeDirectory(roster.rows) }),
    useChannels: () => ({
      data: rooms.rows,
      groups: { channels: rooms.rows.filter((c) => c.kind !== "dm"), dms: [] },
    }),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const HELPER = "00000000-0000-7000-8000-0000000000a1";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let path = "/";

const savedLink = { configured: true, keyConfigured: true, availability: "live", baseUrl: "https://api.anthropic.com" };
const resolved = { linkPosition: 0, endpointLabel: "api.anthropic.com", linkResolved: true, modelId: null };

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const fn of [fetchLink, fetchDefaultAi, fetchBag, probe, setSwitch, seed]) fn.mockReset();
  fetchLink.mockResolvedValue(savedLink);
  fetchDefaultAi.mockResolvedValue({ teamAgent: resolved, summary: null });
  fetchBag.mockResolvedValue({ team_ai_fast_path: false });
  seed.mockReturnValue(true);
  roster.rows = [];
  rooms.rows = [
    { id: "c-general", workspaceId: WS, kind: "public", name: "일반", muted: false },
    { id: "c-mkt", workspaceId: WS, kind: "public", name: "마케팅", muted: false },
  ];
  path = "/";
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function Where() {
  path = useLocation().pathname;
  return null;
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
        createElement(
          MemoryRouter,
          null,
          createElement(Where),
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "*",
              element: createElement(TeamAiNextStepCard, { workspaceId: WS, offline }),
            })
          )
        )
      )
    );
  });
  await flush();
  return host;
}

const q = (view: HTMLElement, id: string) => view.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.click();
  });
  await flush();
}

describe("팀 AI 다음 단계 카드", () => {
  it("비 운영자(키 403)에게는 아무 것도 그리지 않는다", async () => {
    fetchLink.mockRejectedValue(new ApiError(403, "operator only", "forbidden"));
    const view = await mount();
    expect(q(view, "team-ai-next-step")).toBeNull();
    expect(fetchBag).not.toHaveBeenCalled();
  });

  it("옛 서버(스위치를 모름)·키 없음·이미 켜짐이면 서지 않는다", async () => {
    fetchBag.mockResolvedValue({});
    probe.mockResolvedValue("absent");
    expect(q(await mount(), "team-ai-next-step")).toBeNull();
    act(() => root?.unmount());
    root = null;

    fetchBag.mockResolvedValue({ team_ai_fast_path: false });
    fetchLink.mockResolvedValue({ ...savedLink, configured: false });
    expect(q(await mount(), "team-ai-next-step")).toBeNull();
    act(() => root?.unmount());
    root = null;

    fetchLink.mockResolvedValue(savedLink);
    fetchBag.mockResolvedValue({ team_ai_fast_path: true, team_ai_agent_member_id: HELPER });
    expect(q(await mount(), "team-ai-next-step")).toBeNull();
  });

  it("문구는 도우미 멤버의 표시 이름을 따라간다: 이름을 바꿨으면 「oort 도우미」를 글자로 쓰지 않는다 (#4945, B10-7)", async () => {
    roster.rows = [
      { id: HELPER, workspaceId: WS, kind: "agent", status: "active", handle: "oort-helper", displayName: "비서봇" } as RosterMember,
    ];
    fetchBag.mockResolvedValue({ team_ai_fast_path: false, team_ai_agent_member_id: HELPER });
    const view = await mount();
    const card = q(view, "team-ai-next-step");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("다음 단계: 팀 AI(비서봇) 켜기");
    expect(card?.textContent).toContain("채팅에서 비서봇을 불러");
    expect(q(view, "team-ai-next-step-enable")?.textContent).toBe("비서봇 켜기");
    expect(card?.textContent).not.toContain("oort 도우미");
  });

  it("기본 AI 줄이 안 풀렸으면 켜기는 잠기고 이유를 말한다", async () => {
    fetchDefaultAi.mockResolvedValue({ teamAgent: null, summary: null });
    const view = await mount();
    expect(q(view, "team-ai-next-step-1")?.dataset.done).toBe("no");
    const enable = q(view, "team-ai-next-step-enable");
    expect(enable?.getAttribute("aria-disabled")).toBe("true");
    expect(enable?.getAttribute("aria-describedby")).toBeTruthy();
    expect(view.textContent).toContain("1단계를 마치면 켤 수 있어요.");
    await click(enable);
    expect(setSwitch).not.toHaveBeenCalled();
  });

  it("409 는 이름이 겹친 이유 문장으로 말한다", async () => {
    setSwitch.mockRejectedValue(new ApiError(409, "taken", "team_ai_unavailable"));
    const view = await mount();
    await click(q(view, "team-ai-next-step-enable"));
    expect(setSwitch).toHaveBeenCalledWith(WS, true);
    expect(q(view, "team-ai-next-step-error")?.textContent).toContain(
      "「oort-helper」 이름을 다른 에이전트가 쓰고 있어요."
    );
  });

  it("켜면 별칭 상태를 보이고, 고른 채널을 열며 작성창에 @oort 를 채운다(보내지 않는다)", async () => {
    setSwitch.mockResolvedValue({
      team_ai_fast_path: true,
      team_ai_agent_member_id: HELPER,
      team_ai_alias_status: { oort: "registered", 오르트: "registered", claude: "taken" },
    });
    roster.rows = [
      {
        id: "m-claude",
        workspaceId: WS,
        kind: "agent",
        status: "active",
        displayName: "클로드 코드",
        handle: "claude",
        channelCount: 0,
        channelIds: [],
        capabilities: [],
        createdAtMs: 0,
        updatedAtMs: 0,
      },
    ];
    const view = await mount();
    await click(q(view, "team-ai-next-step-enable"));
    expect(q(view, "team-ai-next-step")?.dataset.state).toBe("enabled");
    expect(document.activeElement).toBe(q(view, "team-ai-next-step-enabled"));
    expect(q(view, "team-ai-next-step-aliases")?.textContent).toBe("부르는 이름: @oort · @오르트");
    expect(q(view, "team-ai-next-step-alias-notice")?.textContent).toBe(
      "@claude는 이미 클로드 코드가 쓰고 있어서 연결하지 않았어요."
    );

    const select = view.querySelector<HTMLButtonElement>('[data-testid="team-ai-next-step-channel"]');
    expect(select?.getAttribute("role")).toBe("combobox");
    // 라벨이 칸과 목록의 이름이 된다.
    expect(select?.getAttribute("aria-labelledby")).toBe(`${select?.id}-label`);
    await act(async () => {
      select?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-labelledby")).toBe(`${select?.id}-label`);
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="option"][data-value="c-mkt"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const tryButton = q(view, "team-ai-next-step-try");
    expect(tryButton?.textContent).toBe("#마케팅에서 @oort 불러 보기");
    await click(tryButton);
    expect(seed).toHaveBeenCalledWith(WS, "c-mkt", "@oort ");
    expect(path).toBe("/c/c-mkt");
  });

  it("별칭 상태가 없는 서버(S1 이전)에서는 도우미 핸들을 채운다", async () => {
    setSwitch.mockResolvedValue({ team_ai_fast_path: true, team_ai_agent_member_id: HELPER });
    const view = await mount();
    await click(q(view, "team-ai-next-step-enable"));
    expect(q(view, "team-ai-next-step-aliases")).toBeNull();
    await click(q(view, "team-ai-next-step-try"));
    expect(seed).toHaveBeenCalledWith(WS, "c-general", "@oort-helper ");
  });

  it("오프라인이면 켜기를 잠그고 이유를 말한다", async () => {
    const view = await mount(true);
    const enable = q(view, "team-ai-next-step-enable");
    expect(enable?.getAttribute("aria-disabled")).toBe("true");
    expect(view.textContent).toContain("연결이 끊겨 지금은 켤 수 없어요.");
    await click(enable);
    expect(setSwitch).not.toHaveBeenCalled();
  });

  it("잠김과 오프라인이 겹쳐도 켜기 버튼의 설명은 화면에 있는 문장만 가리킨다", async () => {
    fetchDefaultAi.mockResolvedValue({ teamAgent: null, summary: null });
    const view = await mount(true);
    const ids = (q(view, "team-ai-next-step-enable")?.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  });
});

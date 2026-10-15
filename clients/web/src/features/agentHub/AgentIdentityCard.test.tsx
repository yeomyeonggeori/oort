// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import * as api from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";
import { AgentIdentityCard } from "./AgentIdentityCard";
import { canEditAgentIdentity, renameErrorCopy } from "./identityCardModel";

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, renameAgent: vi.fn() };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000301";

function agent(extra: Partial<RosterMember> = {}): RosterMember {
  return {
    id: AGENT, workspaceId: WS, kind: "agent", status: "active", displayName: "그록", handle: "grok",
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
  };
}

const session: SessionContextValue = {
  session: {
    accessToken: "a", refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
};

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.mocked(api.renameAgent).mockReset();
});

function mount(member: RosterMember, canEdit: boolean, offline = false): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(rosterQueryKey(WS), [member]);
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
          { value: session },
          createElement(AgentIdentityCard, { agent: member, canEdit, offline })
        )
      )
    );
  });
  return client;
}
const q = (id: string) => document.querySelector(`[data-testid='${id}']`) as HTMLElement | null;

describe("canEditAgentIdentity", () => {
  it("owner/admin 또는 그 에이전트의 소유자만, 사람만", () => {
    const a = { ownerHumanId: ME.toUpperCase() };
    expect(canEditAgentIdentity({ id: ME, kind: "human", role: "member" }, a)).toBe(true);
    expect(canEditAgentIdentity({ id: "x", kind: "human", role: "admin" }, a)).toBe(true);
    expect(canEditAgentIdentity({ id: "x", kind: "human", role: "owner" }, {})).toBe(true);
    expect(canEditAgentIdentity({ id: "x", kind: "human", role: "member" }, a)).toBe(false);
    expect(canEditAgentIdentity({ id: "x", kind: "human", role: "guest" }, {})).toBe(false);
    expect(canEditAgentIdentity({ id: ME, kind: "agent", role: "owner" }, a)).toBe(false);
  });
});

describe("renameErrorCopy", () => {
  it("서버 상태를 해요체 한 문장으로 바꾼다", () => {
    expect(renameErrorCopy(new ApiError(409, "display name is already in use"))).toMatch(/다른 이름으로 적어 주세요\.$/);
    expect(renameErrorCopy(new ApiError(403, "forbidden"))).toMatch(/소유자나 관리자만/);
    expect(renameErrorCopy(new ApiError(400, "displayName is required"))).toMatch(/100자/);
    expect(renameErrorCopy(new Error("boom"))).toMatch(/해 주세요\.$/);
  });
});

describe("AgentIdentityCard", () => {
  it("소유자·admin이 아니면 읽기 전용이다: 이름 바꾸기도 준비 중 안내도 없다", () => {
    mount(agent({ tagline: "리뷰를 도와요" }), false);
    expect(q("agent-identity-name")?.textContent).toBe("그록");
    expect(q("agent-identity-tagline")?.textContent).toBe("리뷰를 도와요");
    expect(q("agent-identity-edit")).toBeNull();
    expect(q("agent-identity-readonly-note")).toBeNull();
    expect(q("member-avatar")?.getAttribute("data-avatar-kind")).toBe("agent");
    expect(q("member-avatar")?.getAttribute("data-avatar-size")).toBe("lg");
  });

  it("비어 있는 소개·상태는 이유를 말하고, 만료된 상태 문구는 숨긴다", () => {
    mount(agent({ statusText: "휴가 중", statusExpiresAtMs: 1 }), false);
    expect(q("agent-identity-tagline")?.textContent).toBe("아직 소개가 없어요.");
    expect(q("agent-identity-status")?.textContent).toBe("설정된 상태 문구가 없어요.");
  });

  it("살아 있는 상태 문구는 만료 시각과 함께 보인다", () => {
    mount(agent({ statusText: "배포 중", statusExpiresAtMs: Date.now() + 3_600_000 }), false);
    expect(q("agent-identity-status")?.textContent).toContain("배포 중");
    expect(q("agent-identity-status")?.textContent).toContain("까지");
  });

  it("편집자가 앞뒤 공백을 걷은 이름으로 저장하면 renameAgent가 불리고 명부 이름이 바뀐다", async () => {
    vi.mocked(api.renameAgent).mockResolvedValue({
      id: AGENT, workspaceId: WS, kind: "agent", displayName: "그록 봇", handle: "grok",
    });
    const client = mount(agent(), true);
    act(() => fireEvent.click(q("agent-identity-edit") as HTMLElement));
    const input = q("agent-identity-name-input") as HTMLInputElement;
    expect((q("agent-identity-save") as HTMLButtonElement).disabled).toBe(true);
    act(() => fireEvent.change(input, { target: { value: "  그록 봇  " } }));
    act(() => fireEvent.click(q("agent-identity-save") as HTMLElement));
    await waitFor(() => expect(api.renameAgent).toHaveBeenCalledWith(WS, AGENT, "그록 봇"));
    await waitFor(() =>
      expect(client.getQueryData<RosterMember[]>(rosterQueryKey(WS))?.[0]?.displayName).toBe("그록 봇")
    );
    await waitFor(() => expect(q("agent-identity-name-input")).toBeNull());
  });

  it("이름이 겹치면(409) 해요체 문장을 보이고 입력을 닫지 않는다", async () => {
    vi.mocked(api.renameAgent).mockRejectedValue(new ApiError(409, "display name is already in use"));
    mount(agent(), true);
    act(() => fireEvent.click(q("agent-identity-edit") as HTMLElement));
    act(() => fireEvent.change(q("agent-identity-name-input") as HTMLElement, { target: { value: "김인턴" } }));
    act(() => fireEvent.click(q("agent-identity-save") as HTMLElement));
    await waitFor(() => expect(q("agent-identity-error")?.textContent).toMatch(/다른 이름으로 적어 주세요\./));
    expect(q("agent-identity-name-input")).not.toBeNull();
  });

  it("오프라인이면 이름 바꾸기가 잠긴다", () => {
    mount(agent(), true, true);
    expect((q("agent-identity-edit") as HTMLButtonElement).disabled).toBe(true);
  });
});

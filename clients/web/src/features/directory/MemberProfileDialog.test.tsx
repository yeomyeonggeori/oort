// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type MembershipRole, type RosterMember } from "@momo/core/lib/api";
import type { RoleLabels } from "@momo/core/features/directory/model";
import { DEFAULT_ROLE_LABELS } from "@momo/core/features/directory/model";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import { MemberProfileProvider } from "./MemberProfileDialog";
import { useOpenMemberProfile } from "./memberProfileContext";

const WS = "00000000-0000-7000-8000-000000000001";
const OWNER_ID = "00000000-0000-7000-8000-000000000101";
const ADMIN_ID = "00000000-0000-7000-8000-0000000005d1";
const MEMBER_ID = "00000000-0000-7000-8000-0000000005d2";
const AGENT_ID = "00000000-0000-7000-8000-000000000102";

const changeWorkspaceMemberRole = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    changeWorkspaceMemberRole: (
      workspaceId: string,
      memberId: string,
      role: MembershipRole
    ) => changeWorkspaceMemberRole(workspaceId, memberId, role) as Promise<unknown>,
    fetchRoster: (workspaceId: string) =>
      fetchRoster(workspaceId) as Promise<RosterMember[]>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  changeWorkspaceMemberRole.mockReset();
  fetchRoster.mockReset();
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

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

function rosterMember(
  over: Partial<RosterMember> & { id: string; role?: MembershipRole }
): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const OWNER = rosterMember({
  id: OWNER_ID,
  displayName: "데모 사용자",
  handle: "demo",
  role: "owner",
});
const ADMIN = rosterMember({
  id: ADMIN_ID,
  displayName: "곽성재",
  handle: "seongjae",
  role: "admin",
});
const INTERN = rosterMember({
  id: MEMBER_ID,
  displayName: "김인턴",
  handle: "intern-kim",
  role: "member",
});
const AGENT = rosterMember({
  id: AGENT_ID,
  displayName: "김인턴",
  handle: "kim-intern",
  kind: "agent",
  role: "member",
  ownerHumanId: OWNER_ID,
});

const ROSTER = [OWNER, ADMIN, INTERN, AGENT];

function sessionValue(
  viewer: RosterMember,
  connStatus: SessionContextValue["connStatus"] = "connected"
): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: viewer.id,
        workspaceId: WS,
        kind: viewer.kind,
        displayName: viewer.displayName,
        handle: viewer.handle,
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus,
    logout: () => undefined,
  };
}

function workspace(labels: RoleLabels): WorkspaceIdentity {
  return {
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: 0,
    roleLabels: labels,
  };
}

function OpenOnMount({ memberId }: { memberId: string }) {
  const open = useOpenMemberProfile();
  useEffect(() => {
    open(memberId);
  }, [memberId, open]);
  return null;
}

function mountProfile(options: {
  viewer: RosterMember;
  targetId: string;
  labels?: RoleLabels;
  roster?: RosterMember[];
  connStatus?: SessionContextValue["connStatus"];
}): { host: HTMLElement; client: QueryClient } {
  const roster = options.roster ?? ROSTER;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(workspaceIdentityKey(WS), workspace(options.labels ?? {}));
  client.setQueryData(["roster", WS], roster);
  fetchRoster.mockResolvedValue(roster);

  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue(options.viewer, options.connStatus) },
      createElement(
        MemoryRouter,
        null,
        createElement(
          OpenAgentProfileContext.Provider,
          { value: () => undefined },
          createElement(
            MemberProfileProvider,
            null,
            createElement(OpenOnMount, { memberId: options.targetId })
          )
        )
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return { host, client };
}

async function waitForDialog(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const dialog = document.querySelector(
      '[data-testid="member-profile-dialog"]'
    );
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  });
}

function roleSelect(): HTMLSelectElement | null {
  return document.querySelector(
    '[data-testid="member-profile-role"]'
  ) as HTMLSelectElement | null;
}

function applyButton(): HTMLButtonElement | null {
  return document.querySelector(
    '[data-testid="member-profile-role-apply"]'
  ) as HTMLButtonElement | null;
}

async function selectRole(role: MembershipRole) {
  const select = roleSelect();
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = role;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function applyRole() {
  const apply = applyButton();
  expect(apply).not.toBeNull();
  await act(async () => {
    apply!.click();
  });
}

describe("멤버 프로필 역할 변경", () => {
  it("비운영자 viewer는 컨트롤을 숨기고 읽기 전용 Fact를 유지한다", async () => {
    mountProfile({ viewer: INTERN, targetId: ADMIN_ID });
    const dialog = await waitForDialog();
    expect(roleSelect()).toBeNull();
    expect(applyButton()).toBeNull();
    expect(dialog.textContent).toContain("관리자");
  });

  it("guest viewer도 컨트롤을 숨긴다", async () => {
    const guest = rosterMember({
      id: "00000000-0000-7000-8000-0000000005d9",
      displayName: "방문",
      handle: "guest",
      role: "guest",
    });
    mountProfile({
      viewer: guest,
      targetId: MEMBER_ID,
      roster: [...ROSTER, guest],
    });
    await waitForDialog();
    expect(roleSelect()).toBeNull();
    expect(applyButton()).toBeNull();
  });

  it("self 프로필에서는 운영자여도 컨트롤을 숨긴다", async () => {
    mountProfile({ viewer: OWNER, targetId: OWNER_ID });
    const dialog = await waitForDialog();
    expect(roleSelect()).toBeNull();
    expect(applyButton()).toBeNull();
    expect(dialog.textContent).toContain("소유자");
  });

  it("operator viewer는 셀렉트와 적용을 노출하고 PATCH를 한 번 보낸다", async () => {
    changeWorkspaceMemberRole.mockResolvedValue({
      memberId: MEMBER_ID,
      scope: "workspace",
      role: "admin",
    });
    fetchRoster.mockResolvedValue(
      ROSTER.map((row) =>
        row.id === MEMBER_ID ? { ...row, role: "admin" as const } : row
      )
    );
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    expect(roleSelect()).not.toBeNull();
    expect(applyButton()).not.toBeNull();

    await selectRole("admin");
    await applyRole();

    await vi.waitFor(() => {
      expect(changeWorkspaceMemberRole).toHaveBeenCalledTimes(1);
    });
    expect(changeWorkspaceMemberRole).toHaveBeenCalledWith(
      WS,
      MEMBER_ID,
      "admin"
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["roster", WS] });
    invalidate.mockRestore();
  });

  it("서버 403은 배너 문장으로 도달하고 역할은 이전 값을 유지한다", async () => {
    changeWorkspaceMemberRole.mockRejectedValue(
      new ApiError(403, "cannot manage an equal or higher role")
    );
    const { client } = mountProfile({ viewer: ADMIN, targetId: OWNER_ID });
    await waitForDialog();
    await selectRole("member");
    await applyRole();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="member-profile-role-error"]')
          ?.textContent
      ).toContain("같거나 높은 역할");
    });
    const after = (
      client.getQueryData(["roster", WS]) as RosterMember[]
    ).find((row) => row.id === OWNER_ID);
    expect(after?.role).toBe("owner");
    expect(fetchRoster).not.toHaveBeenCalled();
  });

  it("서버 409 LastOwner는 배너 문장으로 도달하고 역할은 이전 값을 유지한다", async () => {
    changeWorkspaceMemberRole.mockRejectedValue(
      new ApiError(409, "workspace must retain at least one owner")
    );
    const { client } = mountProfile({ viewer: OWNER, targetId: ADMIN_ID });
    await waitForDialog();
    const before = (
      client.getQueryData(["roster", WS]) as RosterMember[]
    ).find((row) => row.id === ADMIN_ID);
    expect(before?.role).toBe("admin");

    await selectRole("member");
    await applyRole();

    const banner = await vi.waitFor(() => {
      const node = document.querySelector(
        '[data-testid="member-profile-role-error"]'
      );
      expect(node?.textContent).toContain("마지막 소유자");
      return node as HTMLElement;
    });
    expect(banner.textContent).toContain("다시 시도");
    const after = (
      client.getQueryData(["roster", WS]) as RosterMember[]
    ).find((row) => row.id === ADMIN_ID);
    expect(after?.role).toBe("admin");
    expect(fetchRoster).not.toHaveBeenCalled();
  });

  it("role_labels 오버라이드가 있으면 셀렉트 라벨에 반영한다", async () => {
    mountProfile({
      viewer: OWNER,
      targetId: MEMBER_ID,
      labels: {
        owner: "마스터",
        admin: "리드",
        member: "동료",
        guest: "방문",
      },
    });
    await waitForDialog();
    const select = roleSelect();
    expect(select).not.toBeNull();
    const labels = [...select!.options].map((option) => option.textContent);
    expect(labels).toEqual(["마스터", "리드", "동료", "방문"]);
    expect(labels).not.toEqual([
      DEFAULT_ROLE_LABELS.owner,
      DEFAULT_ROLE_LABELS.admin,
      DEFAULT_ROLE_LABELS.member,
      DEFAULT_ROLE_LABELS.guest,
    ]);
  });

  it("에이전트 프로필에는 컨트롤이 없다", async () => {
    mountProfile({ viewer: OWNER, targetId: AGENT_ID });
    const dialog = await waitForDialog();
    expect(roleSelect()).toBeNull();
    expect(applyButton()).toBeNull();
    expect(dialog.textContent).not.toContain("역할 적용");
  });

  it("busy 중에는 잠그지 않고 적용 후에도 초점이 버튼에 남는다", async () => {
    let resolvePatch: (value: unknown) => void = () => undefined;
    changeWorkspaceMemberRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        })
    );
    fetchRoster.mockResolvedValue(
      ROSTER.map((row) =>
        row.id === MEMBER_ID ? { ...row, role: "admin" as const } : row
      )
    );
    mountProfile({ viewer: OWNER, targetId: MEMBER_ID });
    await waitForDialog();
    await selectRole("admin");

    const apply = applyButton();
    expect(apply).not.toBeNull();
    apply!.focus();
    expect(document.activeElement).toBe(apply);

    await applyRole();
    await vi.waitFor(() => {
      expect(applyButton()?.getAttribute("aria-busy")).toBe("true");
    });
    expect(roleSelect()?.disabled).toBe(false);
    expect(applyButton()?.disabled).toBe(false);
    expect(roleSelect()?.getAttribute("aria-busy")).toBe("true");
    expect(applyButton()?.textContent).toBe("역할 적용 중");
    expect(document.activeElement).toBe(applyButton());

    await act(async () => {
      resolvePatch({
        memberId: MEMBER_ID,
        scope: "workspace",
        role: "admin",
      });
    });
    await vi.waitFor(() => {
      expect(applyButton()?.getAttribute("aria-busy")).toBeNull();
    });
    expect(document.activeElement).toBe(applyButton());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("오프라인이면 컨트롤을 잠그고 기존 배너 사유를 가리킨다", async () => {
    mountProfile({
      viewer: OWNER,
      targetId: MEMBER_ID,
      connStatus: "disconnected",
    });
    await waitForDialog();
    expect(document.querySelector('[data-testid="member-profile-offline"]')).not.toBeNull();
    expect(roleSelect()?.disabled).toBe(true);
    expect(applyButton()?.disabled).toBe(true);
    expect(roleSelect()?.getAttribute("aria-describedby")).toBe(
      "member-profile-offline-reason"
    );
    expect(applyButton()?.getAttribute("aria-describedby")).toBe(
      "member-profile-offline-reason"
    );
  });
});

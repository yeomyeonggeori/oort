// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@momo/core/lib/api";

const fetchWorkspace = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args) };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: (...args: unknown[]) => fetchRoster(...args) };
});

import {
  acceptSeedWorkspace,
  clearOwnerOnboardingPending,
  markOwnerOnboardingPending,
  readOwnerOnboardingStage,
  resetOwnerOnboardingLoadState,
} from "./ownerOnboardingStore";
import { isSeedWorkspaceUntouched, useSeedWorkspaceRejudge } from "./seedWorkspace";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

function member(over: Partial<Member> = {}): Member {
  return { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "demo", ...over };
}

function Probe({ who }: { who: Member }) {
  useSeedWorkspaceRejudge(who);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(who: Member): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe, { who }));
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchWorkspace.mockReset();
  fetchRoster.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  clearOwnerOnboardingPending();
});

describe("시드 이름 재판정 (#3696)", () => {
  it("순수 판정: 소유자 · @demo · 시드 이름이 모두 그대로여야 한다", () => {
    const base = { workspaceName: "momo Demo Workspace", memberHandle: "demo", role: "owner" };
    expect(isSeedWorkspaceUntouched(base)).toBe(true);
    expect(isSeedWorkspaceUntouched({ ...base, workspaceName: "새벽팀" })).toBe(false);
    expect(isSeedWorkspaceUntouched({ ...base, memberHandle: "seongjae" })).toBe(false);
    expect(isSeedWorkspaceUntouched({ ...base, role: "member" })).toBe(false);
    expect(isSeedWorkspaceUntouched({ ...base, role: undefined })).toBe(false);
  });

  it("저장소가 비어 있어도 서버 값이 시드면 S1을 다시 띄운다", async () => {
    fetchWorkspace.mockResolvedValue({ name: "momo Demo Workspace" });
    fetchRoster.mockResolvedValue([{ id: ME, role: "owner" }]);
    expect(readOwnerOnboardingStage()).toBeNull();
    await mount(member());
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
  });

  it("이름을 이미 정했으면 건드리지 않는다", async () => {
    fetchWorkspace.mockResolvedValue({ name: "새벽팀" });
    fetchRoster.mockResolvedValue([{ id: ME, role: "owner" }]);
    await mount(member());
    expect(readOwnerOnboardingStage()).toBeNull();
  });

  it("일반 멤버에게는 띄우지 않는다", async () => {
    fetchWorkspace.mockResolvedValue({ name: "momo Demo Workspace" });
    fetchRoster.mockResolvedValue([{ id: ME, role: "member" }]);
    await mount(member());
    expect(readOwnerOnboardingStage()).toBeNull();
  });

  it("핸들이 @demo가 아니면 서버에 묻지도 않는다", async () => {
    await mount(member({ handle: "seongjae" }));
    expect(fetchWorkspace).not.toHaveBeenCalled();
    expect(fetchRoster).not.toHaveBeenCalled();
  });

  it("서버에 닿지 않으면 조용히 넘어간다", async () => {
    fetchWorkspace.mockRejectedValue(new Error("offline"));
    fetchRoster.mockRejectedValue(new Error("offline"));
    await mount(member());
    expect(readOwnerOnboardingStage()).toBeNull();
  });

  it("다른 기기에서 이미 정했으면 이전 실행의 영속 표지를 걷는다 (#3714)", async () => {
    markOwnerOnboardingPending();
    resetOwnerOnboardingLoadState(); // 앱을 껐다 켠 것과 같다.
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    fetchWorkspace.mockResolvedValue({ name: "새벽팀" });
    await mount(member({ handle: "seongjae" }));
    expect(fetchWorkspace).toHaveBeenCalled();
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(readOwnerOnboardingStage()).toBeNull();
  });

  it("이번 실행의 claim이 막 찍은 표지는 서버 이름이 시드가 아니어도 걷지 않는다", async () => {
    markOwnerOnboardingPending();
    fetchWorkspace.mockResolvedValue({ name: "새벽팀" });
    await mount(member({ handle: "seongjae" }));
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
  });

  it("서버도 아직 시드면 이전 실행의 표지를 그대로 둔다", async () => {
    markOwnerOnboardingPending();
    resetOwnerOnboardingLoadState();
    fetchWorkspace.mockResolvedValue({ name: "momo Demo Workspace" });
    fetchRoster.mockResolvedValue([{ id: ME, role: "owner" }]);
    await mount(member({ handle: "seongjae" }));
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
  });

  it("「이대로 쓸게요」를 누른 계정·서버에는 시드 이름이어도 다시 띄우지 않는다", async () => {
    acceptSeedWorkspace();
    fetchWorkspace.mockResolvedValue({ name: "momo Demo Workspace" });
    fetchRoster.mockResolvedValue([{ id: ME, role: "owner" }]);
    await mount(member());
    expect(readOwnerOnboardingStage()).toBeNull();
  });
});

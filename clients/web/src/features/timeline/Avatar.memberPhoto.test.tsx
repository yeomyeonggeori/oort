// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { resetMemberAvatarsForTest } from "@/features/sidebar/useMemberAvatar";
import { PresenceBadge } from "@/features/sidebar/PresenceControl";
import { Avatar } from "./MessageRow";

const fetchMemberAvatar = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchMemberAvatar: (u: string) => fetchMemberAvatar(u) };
});

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const PATH = "/v1/workspaces/w/members/u/avatar/content?v=m1";
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  resetMemberAvatarsForTest();
  fetchMemberAvatar.mockReset().mockResolvedValue(new Blob(["x"], { type: "image/png" }));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function member(avatarUrl?: string): RosterMember {
  return {
    id: "u",
    workspaceId: "w",
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "k",
    ...(avatarUrl ? { avatarUrl } : {}),
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

async function mount(...members: RosterMember[]): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement("div", null, ...members.map((m, i) => createElement(Avatar, { key: i, member: m }))));
  });
  // FileReader 는 비동기다.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  return host;
}

describe("Avatar — 업로드된 멤버 사진", () => {
  it("content 경로는 인가 fetch 로 받아 data: URL 로 그린다(직접 src 로 싣지 않는다)", async () => {
    const h = await mount(member(PATH));
    expect(fetchMemberAvatar).toHaveBeenCalledWith(PATH);
    const img = h.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^data:/);
    expect(img?.getAttribute("src")).not.toContain("/v1/");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("같은 v 의 아바타가 여러 행에 있어도 한 번만 받는다", async () => {
    const h = await mount(member(PATH), member(PATH), member(PATH));
    expect(h.querySelectorAll("img")).toHaveLength(3);
    expect(fetchMemberAvatar).toHaveBeenCalledTimes(1);
  });

  it("받기에 실패하면 이니셜로 남는다(깨진 이미지 없음)", async () => {
    fetchMemberAvatar.mockRejectedValue(new Error("404"));
    const h = await mount(member(PATH));
    expect(h.querySelector("img")).toBeNull();
    expect(h.textContent).toBe("곽");
  });

  it("사진이 없으면 받지 않고 이니셜", async () => {
    const h = await mount(member());
    expect(fetchMemberAvatar).not.toHaveBeenCalled();
    expect(h.textContent).toBe("곽");
  });

  it("옛 avatarUrl(같은 오리진 data:)은 referrerpolicy=no-referrer 로 직접 그린다", async () => {
    const legacy = "data:image/png;base64,AAAA";
    const h = await mount(member(legacy));
    const img = h.querySelector("img");
    expect(img?.getAttribute("src")).toBe(legacy);
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(fetchMemberAvatar).not.toHaveBeenCalled();
  });

  it("다른 오리진 옛 주소는 CSP 가 막으므로 이니셜", async () => {
    const h = await mount(member("https://cdn.example/a.png"));
    expect(h.querySelector("img")).toBeNull();
  });

  it("사이드바 프로필 배지도 같은 길로 내 사진을 그린다", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(PresenceBadge, { selfName: "곽성재", effective: "online", avatarUrl: PATH }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const img = host.querySelector('[data-testid="presence-avatar-image"]');
    expect(img?.getAttribute("src")).toMatch(/^data:/);
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

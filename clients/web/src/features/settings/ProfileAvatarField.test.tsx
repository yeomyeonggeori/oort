// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { ProfileAvatarField } from "./ProfileAvatarField";

const upload = vi.hoisted(() => vi.fn());
const removeMyAvatar = vi.hoisted(() => vi.fn());
vi.mock("./uploadMyAvatar", () => ({ uploadMyAvatar: (...a: unknown[]) => upload(...a) }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, removeMyAvatar: (...a: unknown[]) => removeMyAvatar(...a), fetchMemberAvatar: async () => new Blob(["x"]) };
});

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  upload.mockReset().mockResolvedValue({
    id: "m",
    memberId: "u",
    status: "ready",
    avatarUrl: "/v1/workspaces/w/members/u/avatar/content?v=m",
  });
  removeMyAvatar.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function me(avatarUrl?: string): RosterMember {
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

async function mount(member: RosterMember, offline = false): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProfileAvatarField, { workspaceId: "w", me: member, offline })
      )
    );
  });
  return host;
}

async function pick(h: HTMLElement, file: File) {
  const input = h.querySelector<HTMLInputElement>('[data-testid="profile-avatar-input"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

const png = () => new File([new Uint8Array(8)], "a.png", { type: "image/png" });
const err = (h: HTMLElement) => h.querySelector('[data-testid="profile-avatar-error"]')?.textContent;

describe("ProfileAvatarField", () => {
  it("png 를 고르면 올리고 로스터를 다시 받게 한다", async () => {
    const h = await mount(me());
    const spy = vi.spyOn(client, "invalidateQueries");
    await pick(h, png());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["roster", "w"] });
    expect(err(h)).toBeUndefined();
  });

  it("허용 밖 형식·5MiB 초과는 서버를 부르지 않고 해요체 오류", async () => {
    const h = await mount(me());
    await pick(h, new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));
    expect(err(h)).toMatch(/PNG, JPG, GIF, WebP/);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "b.png", { type: "image/png" });
    await pick(h, big);
    expect(err(h)).toBe("사진은 5MB까지 올릴 수 있어요.");
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    [413, /너무 커요/],
    [422, /4096px/],
    [409, /다시 골라/],
    [429, /너무 자주/],
  ])("서버 %i 는 구분된 문구로", async (status, re) => {
    upload.mockRejectedValue(new ApiError(status, "x"));
    const h = await mount(me());
    await pick(h, png());
    expect(err(h)).toMatch(re);
  });

  it("사진이 있을 때만 지우기가 보이고, 지우면 API 를 부르고 로스터를 다시 받는다", async () => {
    const none = await mount(me());
    expect(none.querySelector('[data-testid="profile-avatar-remove"]')).toBeNull();
    act(() => root?.unmount());
    root = null;
    none.remove();

    const h = await mount(me("/v1/workspaces/w/members/u/avatar/content?v=m"));
    const spy = vi.spyOn(client, "invalidateQueries");
    const button = h.querySelector<HTMLButtonElement>('[data-testid="profile-avatar-remove"]')!;
    await act(async () => {
      button.click();
    });
    expect(removeMyAvatar).toHaveBeenCalledWith("w");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["roster", "w"] });
  });

  it("지우기 실패는 오류를 보인다", async () => {
    removeMyAvatar.mockRejectedValue(new ApiError(500, "x"));
    const h = await mount(me("/v1/workspaces/w/members/u/avatar/content?v=m"));
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="profile-avatar-remove"]')!.click();
    });
    expect(err(h)).toMatch(/지우지 못했어요/);
  });

  it("오프라인이면 파일 창도 지우기도 열지 않는다", async () => {
    const h = await mount(me("/v1/workspaces/w/members/u/avatar/content?v=m"), true);
    await act(async () => {
      h.querySelector<HTMLButtonElement>('[data-testid="profile-avatar-remove"]')!.click();
    });
    expect(removeMyAvatar).not.toHaveBeenCalled();
    await pick(h, png());
    expect(upload).not.toHaveBeenCalled();
  });
});

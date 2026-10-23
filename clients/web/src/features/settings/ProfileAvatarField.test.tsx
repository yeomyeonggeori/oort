// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { AVATAR_ENTRY_COPY } from "@momo/core/features/workspace/avatarEditorCopy";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ProfileAvatarField } from "./ProfileAvatarField";

// 히어로의 아바타 필드 (#4261): 한 단추가 편집기를 연다. 편집기 본체의 시험(사진·이모지·코메토·되돌리기)은
// `avatarEditor/AvatarEditorDialog.test.tsx` 에 있고, 여기는 **여는 자리**의 약속만 못 박는다: 연다, 닫으면 초점이
// 돌아온다, 오프라인이면 안 연다, 끝난 뒤의 한 줄, 열 때마다 새 초안.

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const upload = vi.hoisted(() => vi.fn());
const removeMyAvatar = vi.hoisted(() => vi.fn());
vi.mock("./uploadMyAvatar", () => ({ uploadMyAvatar: (...a: unknown[]) => upload(...a) }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    removeMyAvatar: (...a: unknown[]) => removeMyAvatar(...a),
    fetchMemberAvatar: async () => new Blob(["x"]),
  };
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
    memberId: MEMBER_ID,
    status: "ready",
    avatarUrl: `/v1/workspaces/${WS}/members/${MEMBER_ID}/avatar/content?v=m`,
  });
  removeMyAvatar.mockReset().mockResolvedValue(undefined);
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
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function me(avatarUrl?: string): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyun",
    ...(avatarUrl ? { avatarUrl } : {}),
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const session: SessionContextValue = {
  session: {
    accessToken: "access",
    refreshToken: "refresh",
    member: { id: MEMBER_ID, workspaceId: WS, kind: "human", displayName: "이도현", handle: "dohyun" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

function mount(options: { member?: RosterMember; offline?: boolean; onBusyChange?: (busy: boolean) => void } = {}): HTMLElement {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        SessionProvider,
        { value: session, children: undefined },
        createElement(
          QueryClientProvider,
          { client },
          createElement(ProfileAvatarField, {
            workspaceId: WS,
            me: options.member ?? me(),
            offline: options.offline ?? false,
            onBusyChange: options.onBusyChange,
          })
        )
      )
    );
  });
  return host;
}

const node = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const entry = () => node("profile-avatar-change") as HTMLButtonElement;

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function openEditor() {
  await act(async () => {
    entry().click();
  });
  await vi.waitFor(() => expect(node("avatar-editor-dialog")).not.toBeNull());
  await settle();
}

async function pickPhoto() {
  const input = node("profile-avatar-input") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [new File([new Uint8Array(8)], "a.png", { type: "image/png" })],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

describe("ProfileAvatarField: 여는 자리", () => {
  it("한 단추가 전부다: 「아바타 바꾸기」 단추와 안내 한 줄만 있고, 편집기는 누르기 전에는 서 있지 않다", () => {
    mount();
    expect(entry().textContent).toBe(AVATAR_ENTRY_COPY.open);
    expect(entry().getAttribute("aria-label")).toBe(AVATAR_ENTRY_COPY.open);
    expect(entry().getAttribute("aria-haspopup")).toBe("dialog");
    expect(node("profile-avatar-field")?.textContent).toContain(AVATAR_ENTRY_COPY.hint);
    expect(node("avatar-editor-dialog")).toBeNull();
    // 옛 표면(사진 올리기·지우기 단추 둘, 파일 입력)은 이 자리에 없다: 편집기 안으로 옮겨 갔다.
    expect(node("profile-avatar-remove")).toBeNull();
    expect(node("profile-avatar-input")).toBeNull();
  });

  it("누르면 편집기(지연 청크)가 열리고, 닫으면 초점이 이 단추로 돌아온다", async () => {
    mount();
    await openEditor();
    expect(node("avatar-editor-dialog")?.getAttribute("role")).toBe("dialog");
    await act(async () => {
      node("avatar-editor-cancel")!.click();
    });
    await vi.waitFor(() => expect(node("avatar-editor-dialog")).toBeNull());
    // Radix 는 초점을 언마운트 뒤 한 틱 늦게 돌려준다.
    await vi.waitFor(() => expect(document.activeElement).toBe(entry()));
  });

  it("열 때마다 새 초안이다: 앞에서 고른 사진이 다음 번에 남아 있지 않다", async () => {
    mount();
    await openEditor();
    await pickPhoto();
    expect(node("avatar-editor-preview")?.getAttribute("data-source")).toBe("draft");
    await act(async () => {
      node("avatar-editor-cancel")!.click();
    });
    await vi.waitFor(() => expect(node("avatar-editor-dialog")).toBeNull());
    await openEditor();
    expect(node("avatar-editor-preview")?.getAttribute("data-source")).toBe("current");
    expect(upload).not.toHaveBeenCalled();
  });

  it("오프라인이면 편집기를 열지 않고 이유 문장(profile-offline-reason)에 연결된다", async () => {
    mount({ offline: true });
    expect(entry().getAttribute("aria-disabled")).toBe("true");
    expect(entry().getAttribute("aria-describedby")).toContain("profile-offline-reason");
    await act(async () => {
      entry().click();
    });
    await settle();
    expect(node("avatar-editor-dialog")).toBeNull();
  });

  it("끝난 뒤의 한 줄은 polite 상태 줄이 말하고, 다시 열면 지운다", async () => {
    mount();
    expect(node("profile-avatar-status")?.getAttribute("aria-live")).toBe("polite");
    await openEditor();
    await pickPhoto();
    await act(async () => {
      node("avatar-editor-save")!.click();
    });
    await vi.waitFor(() => expect(node("avatar-editor-dialog")).toBeNull());
    expect(node("profile-avatar-status")?.textContent).toBe("프로필 사진을 올렸어요.");
    await act(async () => {
      entry().click();
    });
    expect(node("profile-avatar-status")?.textContent).toBe("");
  });

  it("편집기가 올리는 동안 바쁨을 알려 히어로가 카메라 손잡이를 같이 잠글 수 있다", async () => {
    let finish: () => void = () => undefined;
    upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: "m", memberId: MEMBER_ID, status: "ready", avatarUrl: "/v1/avatar?v=m" });
        })
    );
    const onBusyChange = vi.fn();
    mount({ onBusyChange });
    await openEditor();
    await pickPhoto();
    await act(async () => {
      node("avatar-editor-save")!.click();
    });
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      finish();
    });
    await settle();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("아바타가 있는 사람의 편집기에는 되돌리기가 서고, 없는 사람에게는 없다", async () => {
    mount({ member: me(`/v1/workspaces/${WS}/members/${MEMBER_ID}/avatar/content?v=m`) });
    await openEditor();
    expect(node("avatar-editor-reset")).not.toBeNull();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AVATAR_ENTRY_COPY } from "@momo/core/features/workspace/avatarEditorCopy";
import { ProfileAvatarField } from "./ProfileAvatarField";

// 편집기 청크를 받지 못하는 경우(오프라인으로 끊긴 배포, 캐시가 낡은 탭): 단추는 말하고, 다시 누르면 다시 받아 본다.
// 끊긴 `import()` 는 브라우저 모듈 맵에 실패로 남지만, 번들러가 청크 URL 에 해시를 붙여 새로 고치면 풀린다 - 이 필드가
// 실패의 기억을 지워서 다음 누름이 새 시도가 되는 것까지가 이 시험의 약속이다.

const attempts = vi.hoisted(() => ({ count: 0 }));
vi.mock("./avatarEditor/AvatarEditorDialog", () => {
  attempts.count += 1;
  throw new Error("Failed to fetch dynamically imported module");
});

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("ProfileAvatarField: 편집기 청크를 못 받을 때", () => {
  it("단추가 한 줄로 말하고(상태 줄은 비운다), 단추는 다시 눌린다", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ProfileAvatarField, { workspaceId: "w", me: null, offline: false })
        )
      );
    });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="profile-avatar-change"]')!;
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('[data-testid="profile-avatar-error"]')?.textContent).toBe(AVATAR_ENTRY_COPY.loadFailed);
    expect(host.querySelector('[data-testid="profile-avatar-status"]')?.textContent).toBe("");
    expect(button.getAttribute("aria-busy")).toBeNull();
    const first = attempts.count;
    expect(first).toBeGreaterThanOrEqual(1);
    // 실패는 기억되지 않는다: 다시 누르면 다시 받아 본다.
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(attempts.count).toBeGreaterThan(first);
    expect(host.querySelector('[data-testid="profile-avatar-error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="avatar-editor-dialog"]')).toBeNull();
  });
});

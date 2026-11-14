// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession, markAuthExpired } from "@/lib/session";
import {
  clearSessionNotices,
  getBootUnreachableNotice,
  getServerSwitchSignedOutNotice,
  getSessionExpiredNotice,
  markBootUnreachableNotice,
  markServerSwitchSignedOutNotice,
  markSessionExpiredNotice,
} from "@/lib/sessionNotice";
import { SessionNotice } from "@/app/SessionNotice";
import { useRestoredSession, type SessionLifecycle } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

// #5221: 로그인 만료와 콜드 스타트의 서버 안 닿음을 로그인 화면이 말한다. 웹·데스크탑은 둘 다 말없이 로그인 화면으로 갔다.
//   - 만료: 세션을 비우면 `authExpired`도 같이 꺼지므로 사실은 **비우기 전에** 남아야 한다(세션 훅이 남기는지를 잰다).
//   - 문장은 사전의 해요체 문장이고 상태 코드·서버 원문이 없다.

const restore = vi.hoisted(() => ({ restoreSession: vi.fn() }));

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  logout: vi.fn(async () => undefined),
  restoreSession: restore.restoreSession,
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let lifecycle: SessionLifecycle | null = null;
let ko: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocaleForTest();
});
beforeEach(() => {
  clearSessionNotices();
  restore.restoreSession.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  lifecycle = null;
  clearSession();
  clearSessionNotices();
});

function Probe() {
  lifecycle = useRestoredSession();
  return null;
}

async function mountNode(node: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
}

const LOGIN = {
  accessToken: "access",
  refreshToken: "refresh",
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  member: {
    id: "00000000-0000-7000-8000-0000000001ff",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  },
} as unknown as LoginResponse;

function notice(onRetryRestore = vi.fn()) {
  return createElement(LocaleProvider, { locale: ko, children: createElement(SessionNotice, { onRetryRestore }) });
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("세션 훅: 만료는 비우기 전에 남는다", () => {
  // 지키는 것: 로그인 만료가 서면 세션은 비워지지만(`authExpired`도 꺼진다) 로그인 화면이 말할 사실은 남는다.
  it("로그인 만료가 서면 세션이 비워지고 만료 안내가 남는다. 다시 로그인하면 걷힌다", async () => {
    await mountNode(createElement(Probe));
    await act(async () => {
      lifecycle?.signIn(LOGIN);
    });
    expect(getSessionExpiredNotice()).toBe(false);
    await act(async () => {
      markAuthExpired();
    });
    expect(lifecycle?.status).toBe("anonymous");
    expect(getSessionExpiredNotice()).toBe(true);
    await act(async () => {
      lifecycle?.signIn(LOGIN);
    });
    expect(getSessionExpiredNotice()).toBe(false);
  });

  // 지키는 것: 직접 나간 사람에게는 만료 안내가 서지 않는다.
  it("직접 로그아웃하면 안내가 서지 않고 남아 있던 안내도 걷힌다", async () => {
    await mountNode(createElement(Probe));
    markBootUnreachableNotice();
    await act(async () => {
      lifecycle?.signIn(LOGIN);
    });
    expect(getBootUnreachableNotice()).toBe(false);
    markSessionExpiredNotice();
    await act(async () => {
      lifecycle?.signOut();
    });
    expect(getSessionExpiredNotice()).toBe(false);
    expect(getBootUnreachableNotice()).toBe(false);
  });
});

describe("세션 훅: 콜드 스타트 복원이 끝나지 못하면 말한다", () => {
  // 지키는 것: 응답이 없어 복원하지 못했고 저장된 로그인은 그대로일 때만 「서버에 닿지 못했어요」다.
  it("복원이 응답 없이 끝나면(저장된 로그인은 남는다) 안내가 서고, 죽은 토큰이라 지워졌거나 복원되면 서지 않는다", async () => {
    // 1) 응답 없음: 자격은 남는다.
    applyLogin(LOGIN);
    restore.restoreSession.mockResolvedValue(null);
    await mountNode(createElement(Probe));
    expect(lifecycle?.status).toBe("anonymous");
    expect(getBootUnreachableNotice()).toBe(true);
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    clearSession();
    clearSessionNotices();

    // 2) 죽은 토큰: 복원이 자격을 지우고 null 을 준다. 말할 것이 없다(로그인 폼이 정직한 다음 걸음이다).
    applyLogin(LOGIN);
    restore.restoreSession.mockImplementation(async () => {
      clearSession();
      return null;
    });
    await mountNode(createElement(Probe));
    expect(getBootUnreachableNotice()).toBe(false);
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    clearSession();

    // 3) 복원됨.
    applyLogin(LOGIN);
    restore.restoreSession.mockResolvedValue(LOGIN);
    await mountNode(createElement(Probe));
    expect(lifecycle?.status).toBe("signed-in");
    expect(getBootUnreachableNotice()).toBe(false);
  });

  // 지키는 것: 서버가 느려 시간 예산(2.5초)이 지났을 때도 말하고, 늦게 닿으면 안내가 걷히고 로그인된다.
  it("느려서 시간 예산이 지나면 안내가 서고, 늦게 복원되면 걷히고 로그인된다", async () => {
    vi.useFakeTimers();
    try {
      applyLogin(LOGIN);
      let landLate: (value: LoginResponse) => void = () => undefined;
      restore.restoreSession.mockReturnValue(new Promise<LoginResponse>((resolve) => (landLate = resolve)));
      await mountNode(createElement(Probe));
      expect(lifecycle?.status).toBe("restoring");
      expect(getBootUnreachableNotice()).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(2_600);
      });
      expect(lifecycle?.status).toBe("anonymous");
      expect(getBootUnreachableNotice()).toBe(true);
      await act(async () => landLate(LOGIN));
      expect(lifecycle?.status).toBe("signed-in");
      expect(getBootUnreachableNotice()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionNotice: 로그인 화면 위의 한 줄", () => {
  it("안내가 없으면 아무것도 그리지 않는다", async () => {
    await mountNode(notice());
    expect(q("session-expired-notice")).toBeNull();
    expect(q("boot-unreachable-notice")).toBeNull();
  });

  // 지키는 것: 만료 문장(해요체)과 단추 없음.
  it("만료되면 해요체 문장 하나가 서고 단추는 없다", async () => {
    markSessionExpiredNotice();
    await mountNode(notice());
    const banner = q("session-expired-notice");
    expect(banner?.textContent).toBe("로그인이 만료됐어요. 다시 로그인해 주세요.");
    expect(banner?.querySelector("button")).toBeNull();
    expect(banner?.textContent).not.toMatch(/\d{3}/);
  });

  // 지키는 것: 서버가 안 닿는 콜드 스타트는 저장된 로그인이 그대로임을 말하고 다시 시도가 있다. 누르면 한 번만 불린다.
  it("콜드 스타트에 서버가 안 닿으면 저장된 로그인이 그대로임을 말하고, 다시 시도는 도는 동안 한 번만 불린다", async () => {
    markBootUnreachableNotice();
    let finish: () => void = () => undefined;
    const onRetryRestore = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await mountNode(notice(onRetryRestore));
    const banner = q("boot-unreachable-notice");
    expect(banner?.textContent).toContain("서버에 닿지 못했어요. 저장된 로그인은 그대로 있고, 연결되면 이어서 시도해요.");
    const button = banner?.querySelector("button");
    expect(button?.textContent).toBe("다시 시도");
    await act(async () => {
      button?.click();
      button?.click();
    });
    expect(onRetryRestore).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  // 지키는 것: 둘이 겹치면 만료가 이긴다(세션이 이미 끝났다).
  it("둘이 겹치면 만료 안내만 선다", async () => {
    markSessionExpiredNotice();
    markBootUnreachableNotice();
    await mountNode(notice());
    expect(q("session-expired-notice")).not.toBeNull();
    expect(q("boot-unreachable-notice")).toBeNull();
  });

  // 지키는 것(#5816): 서버를 바꿔 앞 서버의 로그인을 끝냈으면 어느 서버의 로그인이 끝났는지 말하고(호스트만), 단추는 없다.
  // 「저장된 로그인은 그대로」는 걷히고, 뒤에 서는 만료·서버 안 닿음 안내보다 이 문장이 이긴다.
  it("서버를 바꿔 앞 서버의 로그인을 끝냈으면 그 서버 이름과 함께 말하고, 다른 두 안내보다 앞선다", async () => {
    markBootUnreachableNotice();
    markServerSwitchSignedOutNotice("https://old.oort.test/momo");
    expect(getBootUnreachableNotice()).toBe(false);
    markSessionExpiredNotice();
    markBootUnreachableNotice();
    await mountNode(notice());
    const banner = q("server-switch-signed-out-notice");
    expect(banner?.textContent).toBe(
      "다른 서버로 바꿔서 앞 서버(old.oort.test)의 로그인은 끝났어요. 돌아가려면 다시 로그인해 주세요."
    );
    expect(banner?.querySelector("button")).toBeNull();
    expect(q("session-expired-notice")).toBeNull();
    expect(q("boot-unreachable-notice")).toBeNull();
  });

  // 지키는 것(#5816): 그 사실은 아무것도 남지 않은 복원이 끝나도 남고, 다시 로그인하면 걷힌다.
  it("서버를 바꿔 끝낸 사실은 빈 복원 뒤에도 남고 다시 로그인하면 걷힌다", async () => {
    markServerSwitchSignedOutNotice("https://old.oort.test");
    clearSessionNotices({ keepServerSwitch: true });
    expect(getServerSwitchSignedOutNotice()).toBe("https://old.oort.test");
    await mountNode(createElement(Probe));
    await act(async () => {
      lifecycle?.signIn(LOGIN);
    });
    expect(getServerSwitchSignedOutNotice()).toBeNull();
  });
});

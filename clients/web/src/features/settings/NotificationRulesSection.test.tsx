// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import { ApiError } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { NotificationRulesSection } from "./NotificationRulesSection";
import { reloadDesktopNotificationKindsForTest } from "@/features/notifications/preference";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

// 시험 시계는 로컬 시계 생성자로 만든다(2026-10-16 금요일 21:07). 기한 문구는 이 기기의 달력으로
// 읽히므로 에폭 상수를 박지 않는다.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const NOW = at(16, 21, 7);

const fetchNotificationRules = vi.hoisted(() => vi.fn());
const putNotificationRules = vi.hoisted(() => vi.fn());
const patchNotificationRules = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@momo/core/features/settings/notificationRules")
    >();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) =>
      fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
    putNotificationRules: (workspaceId: string, rules: NotificationRules) =>
      putNotificationRules(workspaceId, rules) as Promise<NotificationRules>,
    patchNotificationRules: (workspaceId: string, patch: Partial<NotificationRules>) =>
      patchNotificationRules(workspaceId, patch) as Promise<NotificationRules>,
  };
});

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => false,
}));

vi.mock("@/features/notifications/permission", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notifications/permission")>();
  return {
    ...actual,
    readDesktopNotificationPermission: () => Promise.resolve("unsupported"),
    requestDesktopNotificationPermission: () => Promise.resolve("unsupported"),
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

/**
 * The server as #3012 made it: one stored rule per member. PUT replaces it
 * whole; PATCH merges the named fields into what is stored when it lands.
 */
let stored: NotificationRules = { dnd: false, mentionOverridesMute: false };

beforeEach(() => {
  fetchNotificationRules.mockReset();
  putNotificationRules.mockReset();
  patchNotificationRules.mockReset();
  stored = { dnd: false, mentionOverridesMute: false };
  fetchNotificationRules.mockImplementation(async () => ({ ...stored }));
  putNotificationRules.mockImplementation(
    async (_workspaceId: string, rules: NotificationRules) => {
      stored = { dnd: rules.dnd, mentionOverridesMute: rules.mentionOverridesMute };
      return { ...stored };
    }
  );
  patchNotificationRules.mockImplementation(
    async (_workspaceId: string, patch: Partial<NotificationRules>) => {
      stored = { ...stored, ...patch };
      return { ...stored };
    }
  );
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
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
  reloadDesktopNotificationKindsForTest(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** `Date.now()` 만 고정한다. 타이머는 진짜라 Radix·React 스케줄이 그대로 돈다. */
function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
}

const q = <T extends HTMLElement>(testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as T | null;

function chooseUntil(value: string) {
  const select = q<HTMLSelectElement>("pause-until-select")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(testId: string) {
  await act(async () => {
    q(testId)!.click();
  });
}

/**
 * 확인을 누른다. `vi.waitFor` 는 가짜 시계 아래에서 한 번 돌 때마다 시계를 50ms 씩 밀어서,
 * 기다린 만큼 「30분」의 끝 시각도 밀린다. 누르기 직전에 시계를 NOW 로 되돌려 기대값이
 * 정확히 NOW 에서 센 값이 되게 한다.
 */
async function confirmAtNow() {
  vi.setSystemTime(NOW);
  await click("pause-until-confirm");
}

/** 스위치를 눌러 기한 다이얼로그를 열고, 한 선택을 골라 확인한다. */
async function pauseWith(choice: string) {
  await click("notification-rules-dnd");
  await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
  chooseUntil(choice);
  await confirmAtNow();
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function mountSection(offline = false): Promise<HTMLElement> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(NotificationRulesSection, { offline })
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

describe("NotificationRulesSection DND regression", () => {
  // ADR-0204 D2 (#2899): 일시 중지는 기한을 고르고 나서야 켜진다. 예전에는 스위치 한 번이
  // `{dnd: true}` 를 곧바로 보냈고, 그 기한 없는 켜짐이 15일 동안 풀리지 않았다.
  it("스위치를 켜려 하면 쓰지 않고 기한 다이얼로그를 연다", async () => {
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="notification-rules-dnd"]')
      ).not.toBeNull();
    });
    expect(fetchNotificationRules).toHaveBeenCalledWith(WS);

    await click("notification-rules-dnd");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());

    expect(patchNotificationRules).not.toHaveBeenCalled();
    expect(putNotificationRules).not.toHaveBeenCalled();
    expect(q("notification-rules-dnd")!.getAttribute("aria-checked")).toBe("false");
    expect(q("pause-until-dialog")!.textContent).toContain("알림을 언제까지 멈출까요?");
  });

  it("기한을 고르고 확인하면 {dnd, dndUntilMs} 만 PATCH 로 보내고 스위치가 켜진다 (#3042)", async () => {
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });

    await pauseWith("1h");

    await vi.waitFor(() => {
      expect(patchNotificationRules).toHaveBeenCalledTimes(1);
    });
    expect(patchNotificationRules).toHaveBeenCalledWith(WS, {
      dnd: true,
      dndUntilMs: NOW + 60 * 60_000,
    });
    expect(putNotificationRules).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(q("notification-rules-dnd")!.getAttribute("aria-checked")).toBe("true");
    });
    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
    // 스위치 아래 한 줄이 기한을 말하고, 단추는 「기한 바꾸기」다.
    const until = q("notification-rules-until")!;
    expect(until.textContent).toContain("오후 10:07까지");
    expect(until.textContent).toContain("이 워크스페이스의 알림을 받지 않아요.");
    expect(q("notification-rules-until-edit")!.textContent).toBe("기한 바꾸기");
  });

  it("끄는 쪽은 기한 없이 {dnd:false} 한 필드다", async () => {
    stored = { dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30) };
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    expect(q("notification-rules-dnd")!.getAttribute("aria-checked")).toBe("true");

    await click("notification-rules-dnd");

    await vi.waitFor(() => expect(patchNotificationRules).toHaveBeenCalledTimes(1));
    expect(patchNotificationRules).toHaveBeenCalledWith(WS, { dnd: false });
    expect(q("pause-until-dialog")).toBeNull();
    await vi.waitFor(() => expect(q("notification-rules-until")).toBeNull());
  });

  // 클릭이 단추에 포커스를 주지 않는 WebKit(데스크탑 셸)에서도 닫힌 뒤 돌아갈 곳이 있어야 한다.
  // 부르는 쪽이 `opener` 로 그 단추를 직접 넘기므로, jsdom 에서도 `click()` 이 포커스를 주지
  // 않는데 포커스가 돌아온다는 것이 그 계약의 증거다.
  it("키보드: 취소하면 다이얼로그가 닫히고 초점이 부른 단추로 돌아온다", async () => {
    stored = { dnd: false, mentionOverridesMute: false };
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });

    await click("notification-rules-dnd");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
    await click("pause-until-cancel");
    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("notification-rules-dnd")));
    expect(patchNotificationRules).not.toHaveBeenCalled();
  });

  it("키보드: 「기한 바꾸기」에서 연 다이얼로그는 닫히면 그 단추로 돌아온다", async () => {
    stored = { dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30) };
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-until-edit"]')).not.toBeNull();
    });

    await click("notification-rules-until-edit");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
    await click("pause-until-cancel");
    await vi.waitFor(() => expect(q("pause-until-dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("notification-rules-until-edit")));
  });

  it("꺼져 있으면 기한 줄이 없다", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    expect(q("notification-rules-until")).toBeNull();
  });

  it("기한이 있는 행은 기한과 「기한 바꾸기」를 보이고, 누르면 지금 기한을 말하는 다이얼로그가 열린다", async () => {
    stored = { dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30) };
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-until"]')).not.toBeNull();
    });
    expect(q("notification-rules-until")!.textContent).toContain("오후 9:30까지");
    const edit = q<HTMLButtonElement>("notification-rules-until-edit")!;
    expect(edit.textContent).toBe("기한 바꾸기");
    expect(edit.className).toContain("tap-target");

    await click("notification-rules-until-edit");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
    expect(q("pause-until-current")!.textContent).toBe("지금은 오후 9:30까지예요.");

    chooseUntil("2h");
    await confirmAtNow();
    await vi.waitFor(() => expect(patchNotificationRules).toHaveBeenCalledTimes(1));
    expect(patchNotificationRules).toHaveBeenCalledWith(WS, {
      dnd: true,
      dndUntilMs: NOW + 120 * 60_000,
    });
    await vi.waitFor(() => {
      expect(q("notification-rules-until")!.textContent).toContain("오후 11:07까지");
    });
  });

  it("기한 없는 행은 「기한 없음 · 기한 정하기」 단추로 보이고, 눌러 기한을 걸 수 있다", async () => {
    stored = { dnd: true, mentionOverridesMute: false };
    freezeClock();
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-until"]')).not.toBeNull();
    });
    const until = q("notification-rules-until")!;
    expect(until.textContent).toContain("이 워크스페이스의 알림을 받지 않아요.");
    expect(until.textContent).not.toMatch(/오전|오후/);
    const edit = q<HTMLButtonElement>("notification-rules-until-edit")!;
    expect(edit.tagName).toBe("BUTTON");
    expect(edit.textContent).toBe("기한 없음 · 기한 정하기");

    await click("notification-rules-until-edit");
    await vi.waitFor(() => expect(q("pause-until-dialog")).not.toBeNull());
    expect(q("pause-until-current")!.textContent).toBe("지금은 기한이 없어요.");

    chooseUntil("30m");
    await confirmAtNow();
    await vi.waitFor(() => expect(patchNotificationRules).toHaveBeenCalledTimes(1));
    expect(patchNotificationRules).toHaveBeenCalledWith(WS, {
      dnd: true,
      dndUntilMs: NOW + 30 * 60_000,
    });
    await vi.waitFor(() => {
      expect(q("notification-rules-until-edit")!.textContent).toBe("기한 바꾸기");
    });
  });

  it("서버 답을 기다리는 동안에도 고른 기한이 줄에 먼저 보인다", async () => {
    freezeClock();
    patchNotificationRules.mockImplementation(() => new Promise(() => undefined));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });

    await pauseWith("2h");

    await vi.waitFor(() => {
      expect(q("notification-rules-until")!.textContent).toContain("오후 11:07까지");
    });
    expect(q("notification-rules-dnd")!.getAttribute("aria-checked")).toBe("true");
  });

  it("기한을 거는 쓰기가 실패하면 다이얼로그가 이유를 말하고 스위치는 꺼진 채다", async () => {
    freezeClock();
    patchNotificationRules.mockRejectedValue(new ApiError(500, "boom"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });

    await pauseWith("1h");

    await vi.waitFor(() => expect(q("pause-until-error")).not.toBeNull());
    expect(q("pause-until-error")!.textContent).toContain("알림 일시 중지를 걸지 못했어요.");
    // 카드 위 배너는 모달 뒤에 가려 있으니 같은 말을 두 곳에서 하지 않는다.
    expect(q("notification-rules-save-error")).toBeNull();
    expect(q("pause-until-dialog")).not.toBeNull();
    expect(q("notification-rules-dnd")!.getAttribute("aria-checked")).toBe("false");
    expect(q("notification-rules-until")).toBeNull();
  });

  // #3042 race regression. This panel read the rule, then the phone changed the
  // OTHER switch. A toggle here must not write the stale read back over it.
  // Before the fix the save was a whole-object PUT of this panel's snapshot and
  // the phone's change was erased.
  it("keeps a switch another device changed after this panel read the rule", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    // Another device: the phone turns the pause on while this panel shows it off.
    stored = { ...stored, dnd: true };

    const mention = host.querySelector(
      '[data-testid="notification-rules-mention"]'
    ) as HTMLButtonElement;
    expect(mention.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      mention.click();
    });
    await vi.waitFor(() => {
      expect(stored.mentionOverridesMute).toBe(true);
    });
    // The phone's pause survived this panel's write…
    expect(stored).toEqual({ dnd: true, mentionOverridesMute: true });
    // …and the panel now shows the server's answer, not its stale snapshot.
    const dnd = host.querySelector('[data-testid="notification-rules-dnd"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(dnd.getAttribute("aria-checked")).toBe("true"));
  });

  it("names the server-vs-device split in copy", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="notification-rules"]')
      ).not.toBeNull();
    });
    expect(host.textContent).toContain(
      "알림 일시 중지와 멘션 예외는 서버에 하나만 있어요."
    );
    expect(host.textContent).toContain(
      "OS 알림을 종류별로 끄는 선택은 이 기기에만 저장돼요."
    );
    expect(host.textContent).not.toContain("하나만 있는 규칙이에요");
    const mention = host.querySelector(
      '[data-testid="desktop-notification-kind-mention"]'
    ) as HTMLButtonElement;
    expect(mention.getAttribute("role")).toBe("switch");
    expect(mention.disabled).toBe(true);
    const reason = host.querySelector(
      '[data-testid="desktop-notifications-unsupported"]'
    );
    expect(mention.getAttribute("aria-describedby")).toContain(reason!.id);
  });

  // 403은 서버 운영자 권한이 아니라 「활성 사람 멤버만」이다(notification_rules.rs). 운영자 안내문을
  // 붙이지 않고, 다시 시도해도 실패가 보장된 단추도 없다.
  it("403이면 사람 멤버만 정할 수 있다고 말하고 다시 시도 단추를 두지 않는다", async () => {
    fetchNotificationRules.mockRejectedValue(new ApiError(403, "active human membership required"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-error"]')).not.toBeNull();
    });
    const error = host.querySelector('[data-testid="notification-rules-error"]')!;
    expect(error.textContent).toContain("사람 멤버만 알림 규칙을 정할 수 있어요.");
    expect(error.querySelector("button")).toBeNull();
    expect(host.querySelector('[data-testid="operator-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="notification-rules-dnd"]')).toBeNull();
  });

  it("다른 실패는 다시 불러오기 단추를 주고 누르면 다시 묻는다", async () => {
    fetchNotificationRules.mockRejectedValueOnce(new ApiError(500, "boom"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-error"] button')).not.toBeNull();
    });
    await act(async () => {
      (host.querySelector('[data-testid="notification-rules-error"] button') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    expect(fetchNotificationRules).toHaveBeenCalledTimes(2);
  });

  it("오프라인이면 켜진 일시 중지의 기한 단추도 잠긴다", async () => {
    stored = { dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30) };
    freezeClock();
    const host = await mountSection(true);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-until-edit"]')).not.toBeNull();
    });
    expect(q<HTMLButtonElement>("notification-rules-until-edit")!.disabled).toBe(true);
  });

  it("오프라인이면 두 스위치가 잠기고 이유 문장을 가리킨다", async () => {
    const host = await mountSection(true);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    const reason = host.querySelector('[data-testid="notification-rules-offline"]')!;
    for (const id of ["notification-rules-dnd", "notification-rules-mention"]) {
      const sw = host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
      expect(sw.disabled).toBe(true);
      expect(sw.getAttribute("aria-describedby")).toContain(reason.id);
    }
    await act(async () => {
      (host.querySelector('[data-testid="notification-rules-dnd"]') as HTMLButtonElement).click();
    });
    expect(patchNotificationRules).not.toHaveBeenCalled();
  });

  it("기한 없이 쓰는 저장이 실패하면 스위치를 되돌리고 카드에서 이유를 보인다", async () => {
    patchNotificationRules.mockRejectedValue(new ApiError(500, "boom"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-mention"]')).not.toBeNull();
    });
    const mention = () =>
      host.querySelector('[data-testid="notification-rules-mention"]') as HTMLButtonElement;
    await act(async () => {
      mention().click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-save-error"]')).not.toBeNull();
    });
    expect(mention().getAttribute("aria-checked")).toBe("false");
  });

  it("켜진 일시 중지를 끄는 저장이 실패하면 스위치를 되돌린다", async () => {
    stored = { dnd: true, mentionOverridesMute: false, dndUntilMs: at(16, 21, 30) };
    freezeClock();
    patchNotificationRules.mockRejectedValue(new ApiError(500, "boom"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    await click("notification-rules-dnd");
    await vi.waitFor(() => {
      expect(q("notification-rules-save-error")).not.toBeNull();
    });
    expect(q("notification-rules-dnd")!.getAttribute("aria-checked")).toBe("true");
    // 되돌린 켜짐에는 기한 줄도 함께 돌아와 있다.
    expect(q("notification-rules-until")!.textContent).toContain("오후 9:30까지");
  });
});

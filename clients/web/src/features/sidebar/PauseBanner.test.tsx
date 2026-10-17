// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresenceWrite, RosterMember } from "@momo/core/lib/api";
import type {
  NotificationRules,
  NotificationRulesPatch,
} from "@momo/core/features/settings/notificationRules";
import { PauseBanner } from "./PauseBanner";

// =============================================================================
// #3923 — 알림 일시 중지가 **보인다**: 사이드바 내 이름 아래의 한 줄 (ADR-0204 D3).
//
// 이 파일이 지는 것(폰 `pauseBanner.test.tsx` 와 같은 계약):
//   1. 일시 중지가 진행 중이면 「알림 일시 중지 중 · 오후 9:30까지」 + 「다시 켜기」, 기한 없는 행은
//      「기한 없음」. 묶음의 이름은 문장 전체(단추로 곧바로 Tab 해 와도 무엇을 켜는지 읽힌다).
//   2. 「다시 켜기」는 `PATCH {dnd:false}` **하나**만 보낸다 — 방해 금지 상태는 건드리지 않는다.
//      「풀기」는 `PUT presence {status:'auto'}` 하나다. 둘 다 켜져 있으면 일시 중지 줄이 먼저다.
//   3. **만료는 서버가 말한다.** 기한이 지나도 줄은 스스로 내려가지 않고 서버에 다시 묻는다. 서버가
//      꺼졌다고 답하면 사라지고, 아직 켜져 있다고 답하면(시계 차이) 남는다. 창이 다시 보이거나
//      포커스를 받으면 다시 읽는다.
//   4. 규칙을 한 번도 못 읽었으면 줄을 세우지 않는다.
//
// 서버 계약은 모듈 경계에서 가짜로 둔다(`ProfileCard.test.tsx` 와 같은 방식): 규칙 읽기·쓰기와 상태
// 쓰기만 가짜이고 줄·쓰기 훅은 진짜다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const fetchNotificationRules = vi.hoisted(() => vi.fn());
const patchNotificationRules = vi.hoisted(() => vi.fn());
const setPresenceStatus = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    setPresenceStatus: (workspaceId: string, write: PresenceWrite) =>
      setPresenceStatus(workspaceId, write) as Promise<unknown>,
  };
});

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) =>
      fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
    patchNotificationRules: (workspaceId: string, patch: NotificationRulesPatch) =>
      patchNotificationRules(workspaceId, patch) as Promise<NotificationRules>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let client: QueryClient;

const at = (day: number, hour: number, minute = 0, month = 10) =>
  new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();
/** 2026-10-16 은 금요일이다. */
const FRI_2107 = at(16, 21, 7);

const rules = (over: Partial<NotificationRules> = {}): NotificationRules => ({
  dnd: false,
  mentionOverridesMute: false,
  ...over,
});

function rosterMember(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    presenceStatus: "auto",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // 시계만 가짜다: 기한 계산이 고정된 지금을 읽고, 분 틱은 시험이 손으로 넘긴다. 타이머·약속은 진짜다.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(FRI_2107);
  fetchNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue(rules());
  patchNotificationRules.mockReset();
  patchNotificationRules.mockImplementation(async () => rules());
  setPresenceStatus.mockReset();
  setPresenceStatus.mockResolvedValue({ status: "auto" });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  });
}

async function mount(selfMember: RosterMember | undefined = rosterMember()) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const render = (member: RosterMember | undefined) =>
    act(async () => {
      mountedRoot?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(PauseBanner, {
            workspaceId: WS,
            selfMemberId: ME,
            selfMember: member,
          })
        )
      );
      await Promise.resolve();
    });
  await render(selfMember);
  await flush();
  return { host, rerender: render };
}

const banner = () =>
  document.querySelector('[data-testid="pause-banner"]') as HTMLElement | null;
/** 줄의 제목과 (있으면) 기한 — 화면에서는 두 줄로 쌓이고 문장 전체는 묶음의 이름이다. */
const titleText = () => document.querySelector('[data-testid="pause-banner-title"]')?.textContent;
const detailText = () => document.querySelector('[data-testid="pause-banner-detail"]')?.textContent;
const lineText = () =>
  [titleText(), detailText()].filter((part) => part !== undefined).join(" · ");
const button = () =>
  document.querySelector('[data-testid="pause-banner-line"] button') as HTMLButtonElement;
const failure = () => document.querySelector('[data-testid="pause-banner-failure"]');
const press = async (node: HTMLElement) => {
  await act(async () => {
    node.click();
    await Promise.resolve();
  });
  await flush();
};

describe("사이드바 내 이름 아래의 멈춤 줄 (ADR-0204 D3)", () => {
  it("일시 중지가 진행 중이면 끝나는 때와 「다시 켜기」를 한 줄로 말하고, 묶음의 이름은 문장 전체다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 21, 30) }));
    await mount();
    expect(banner()).not.toBeNull();
    expect(lineText()).toBe("알림 일시 중지 중 · 오후 9:30까지");
    expect(titleText()).toBe("알림 일시 중지 중");
    expect(detailText()).toBe("오후 9:30까지");
    expect(button().textContent).toBe("다시 켜기");
    expect(banner()?.getAttribute("role")).toBe("group");
    expect(banner()?.getAttribute("aria-label")).toBe(
      "알림 일시 중지 중 · 오후 9:30까지 · 다시 켜기"
    );
    expect(banner()?.getAttribute("data-kind")).toBe("paused");
  });

  it("기한 없는 행(옛 판이 만든 것)은 「기한 없음」으로 말한다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true }));
    await mount();
    expect(lineText()).toBe("알림 일시 중지 중 · 기한 없음");
    expect(banner()?.getAttribute("aria-label")).toBe(
      "알림 일시 중지 중 · 기한 없음 · 다시 켜기"
    );
  });

  it("일시 중지도 방해 금지도 아니면 줄이 없다", async () => {
    await mount();
    expect(fetchNotificationRules).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });

  it("규칙을 한 번도 못 읽었으면, 상태가 방해 금지여도 줄을 세우지 않는다", async () => {
    fetchNotificationRules.mockRejectedValue(new Error("down"));
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(17, 9) }));
    expect(fetchNotificationRules).toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("일시 중지는 꺼졌는데 상태가 아직 방해 금지이면 「상태는 아직 방해 금지예요 · 풀기」", async () => {
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(17, 9) }));
    expect(lineText()).toBe("상태는 아직 방해 금지예요");
    expect(titleText()).toBe("상태는 아직 방해 금지예요");
    expect(detailText()).toBeUndefined();
    expect(button().textContent).toBe("풀기");
    expect(banner()?.getAttribute("aria-label")).toBe("상태는 아직 방해 금지예요 · 풀기");
    expect(banner()?.getAttribute("data-kind")).toBe("dnd");
  });

  it("둘 다 켜져 있으면 일시 중지 줄이 먼저다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(16, 22, 0) }));
    expect(banner()?.getAttribute("data-kind")).toBe("paused");
    expect(lineText()).toBe("알림 일시 중지 중 · 오후 10:00까지");
  });
});

describe("「다시 켜기」와 「풀기」 — 쓰기 모양", () => {
  it("「다시 켜기」는 PATCH {dnd:false} 하나만 보내고 상태 쓰기는 하지 않는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    await mount();
    await press(button());

    expect(patchNotificationRules).toHaveBeenCalledTimes(1);
    expect(patchNotificationRules).toHaveBeenCalledWith(WS, { dnd: false });
    expect(Object.keys(patchNotificationRules.mock.calls[0][1] as object)).toEqual(["dnd"]);
    expect(setPresenceStatus).not.toHaveBeenCalled();
    // 방해 금지에 묶여 있지 않았으니 일시 중지만 꺼지면 줄이 없다.
    expect(banner()).toBeNull();
  });

  it("방해 금지에 묶여 있었다면 일시 중지만 끈 뒤 「상태는 아직 방해 금지예요」 줄이 선다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(16, 22, 0) }));
    expect(banner()?.getAttribute("data-kind")).toBe("paused");
    await press(button());

    expect(patchNotificationRules).toHaveBeenCalledWith(WS, { dnd: false });
    expect(setPresenceStatus).not.toHaveBeenCalled();
    expect(banner()?.getAttribute("data-kind")).toBe("dnd");
    expect(lineText()).toBe("상태는 아직 방해 금지예요");
    expect(button().textContent).toBe("풀기");
  });

  it("「풀기」는 setPresenceStatus {status:auto} 하나만 보내고, 규칙은 쓰지 않는다", async () => {
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(17, 9) }));
    await press(button());

    expect(setPresenceStatus).toHaveBeenCalledTimes(1);
    expect(setPresenceStatus).toHaveBeenCalledWith(WS, { status: "auto" });
    expect(Object.keys(setPresenceStatus.mock.calls[0][1] as object)).toEqual(["status"]);
    expect(patchNotificationRules).not.toHaveBeenCalled();
    // 방해 금지를 풀면 서버가 규칙도 바꿀 수 있어 규칙을 다시 읽는다(읽기뿐이다).
    expect(fetchNotificationRules.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("쓰기가 실패하면 줄이 그대로 서서 이유를 말하고, 다시 눌러 성공하면 걷힌다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    patchNotificationRules.mockRejectedValueOnce(new Error("500"));
    await mount();
    await press(button());

    expect(failure()?.textContent).toContain("알림 설정을 바꾸지 못했어요. 다시 시도하세요.");
    expect(lineText()).toBe("알림 일시 중지 중 · 오후 10:00까지");
    expect(banner()?.getAttribute("data-kind")).toBe("paused");

    await press(button());
    expect(banner()).toBeNull();
  });

  it("「풀기」가 실패해도 줄이 서서 이유를 말한다", async () => {
    setPresenceStatus.mockRejectedValue(new Error("500"));
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(17, 9) }));
    await press(button());
    expect(failure()?.textContent).toContain("상태를 바꾸지 못했습니다. 다시 시도하세요.");
    expect(button().textContent).toBe("풀기");
  });

  it("실패 문장은 그 줄에만 붙는다 — 줄이 사라졌다 다시 서면 옛 실패가 남지 않는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    patchNotificationRules.mockRejectedValueOnce(new Error("500"));
    await mount();
    await press(button());
    expect(failure()).not.toBeNull();

    // 서버가 멈춤을 끝냈다(다른 기기) → 창이 포커스를 받으며 다시 읽는다 → 줄이 사라진다.
    fetchNotificationRules.mockResolvedValue(rules());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await flush();
    expect(banner()).toBeNull();

    // 다시 멈췄다 → 줄이 다시 서도 옛 실패는 없다.
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 23, 0) }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await flush();
    expect(lineText()).toBe("알림 일시 중지 중 · 오후 11:00까지");
    expect(failure()).toBeNull();
  });
});

describe("만료는 서버가 말한다 — 스스로 내려가지 않고 다시 묻는다", () => {
  it("기한이 지난 줄은 서버에 다시 묻고, 답이 오기 전에는 서 있다가 서버가 꺼졌다고 답하면 사라진다", async () => {
    // 첫 답: 기한이 이미 지난 채 켜져 있다. 두 번째 답은 꺼짐이지만 약속이 풀릴 때까지 오지 않는다 —
    // 그 사이 줄은 **스스로 내려가지 않아야** 한다.
    fetchNotificationRules.mockResolvedValueOnce(rules({ dnd: true, dndUntilMs: at(16, 21, 0) }));
    let release: (value: NotificationRules) => void = () => undefined;
    fetchNotificationRules.mockImplementationOnce(
      () => new Promise<NotificationRules>((resolve) => (release = resolve))
    );
    await mount();

    // 탭도 포커스도 없이 기한이 지났다는 이유만으로 두 번째 읽기가 나간다.
    expect(fetchNotificationRules).toHaveBeenCalledTimes(2);
    // 서버 답이 오기 전: 줄은 그대로다.
    expect(banner()).not.toBeNull();
    expect(lineText()).toBe("알림 일시 중지 중 · 오후 9:00까지");

    await act(async () => {
      release(rules());
      await Promise.resolve();
    });
    await flush();
    expect(banner()).toBeNull();
  });

  it("서버가 아직 켜져 있다고 답하면(시계 차이) 줄이 남는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 21, 0) }));
    await mount();
    expect(fetchNotificationRules).toHaveBeenCalledTimes(2);
    await flush(30);
    // 서버가 두 번 다 켜져 있다고 답했다. 기한이 지났다는 이유로 줄을 내리지 않는다.
    expect(banner()).not.toBeNull();
    expect(lineText()).toBe("알림 일시 중지 중 · 오후 9:00까지");
  });

  it("서버가 아직 켜져 있다고 답하는 동안은 분 틱마다 다시 묻는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 21, 0) }));
    await mount();
    const before = fetchNotificationRules.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await flush();
    expect(fetchNotificationRules.mock.calls.length).toBe(before + 1);
  });

  it("방해 금지 줄도 방해 금지의 기한이 지나면 규칙과 명부를 다시 묻는다", async () => {
    const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await mount(rosterMember({ presenceStatus: "dnd", dndUntilMs: at(16, 21, 0) }));
    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["roster", WS]));
    expect(keys).toContain(JSON.stringify(["settings", "notification-rules", WS]));
    spy.mockRestore();
  });

  it("기한이 아직 오지 않았으면 다시 묻지 않는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    await mount();
    await flush(30);
    expect(fetchNotificationRules).toHaveBeenCalledTimes(1);
  });

  it("기한 없는 행은 만료가 없으니 다시 묻지 않는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true }));
    await mount();
    await flush(30);
    expect(fetchNotificationRules).toHaveBeenCalledTimes(1);
  });
});

describe("다시 읽는 때 — 창이 다시 보일 때, 포커스를 받을 때", () => {
  it("창이 포커스를 받으면 규칙과 명부를 다시 읽는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await mount();
    const before = fetchNotificationRules.mock.calls.length;
    spy.mockClear();
    // 그 사이 다른 기기가 멈춤을 풀었다.
    fetchNotificationRules.mockResolvedValue(rules());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await flush();
    expect(fetchNotificationRules.mock.calls.length).toBe(before + 1);
    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["roster", WS]));
    expect(banner()).toBeNull();
    spy.mockRestore();
  });

  it("탭이 다시 보이게 되면 다시 읽고, 가려지는 전환에는 읽지 않는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true, dndUntilMs: at(16, 22, 0) }));
    await mount();
    const before = fetchNotificationRules.mock.calls.length;
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await flush();
    expect(fetchNotificationRules.mock.calls.length).toBe(before);

    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await flush();
    expect(fetchNotificationRules.mock.calls.length).toBe(before + 1);
    visibility.mockRestore();
  });
});

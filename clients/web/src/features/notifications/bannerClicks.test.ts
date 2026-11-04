import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #5059: 배너 장부와 데스크탑 배너 보내기. 셸 다리(`@/lib/tauri`)만 가짜이고 장부·분기는 진짜다.

const tauri = vi.hoisted(() => ({
  notificationClickSupported: vi.fn(),
  showClickableNotification: vi.fn(),
  showNotification: vi.fn(),
}));
vi.mock("@/lib/tauri", () => tauri);

import {
  SHOWN_BANNER_CAP,
  claimBanner,
  clearBanners,
  forgetBanner,
  recordBanner,
  resetBannerClicksForTest,
  setPlainBannerHandler,
  showDesktopBanner,
  type BannerArm,
} from "./bannerClicks";

const ROUTE = "/c/00000000-0000-7000-8000-00000000020a?msg=019f96a4";

beforeEach(() => {
  resetBannerClicksForTest();
  tauri.notificationClickSupported.mockReset();
  tauri.showClickableNotification.mockReset();
  tauri.showNotification.mockReset();
  tauri.showNotification.mockResolvedValue(true);
});
afterEach(() => resetBannerClicksForTest());

describe("장부: 앱이 만든 배너의 목적지만 돌려준다", () => {
  it("적은 id 와 목적지가 함께 오면 그 목적지를 돌려주고, 한 번 쓴 줄은 지운다", () => {
    const id = recordBanner(ROUTE);
    expect(claimBanner({ id, target: ROUTE })).toBe(ROUTE);
    // 같은 클릭이 다시 와도 두 번 가지 않는다.
    expect(claimBanner({ id, target: ROUTE })).toBeNull();
  });

  it("장부에 없는 id 는 목적지가 그럴듯해도 버린다 — 페이로드를 라우트로 쓰지 않는다", () => {
    recordBanner(ROUTE);
    expect(claimBanner({ id: "n-unknown-1", target: ROUTE })).toBeNull();
    expect(claimBanner({ id: "n-unknown-1", target: "/inbox?filter=mentions" })).toBeNull();
  });

  it("id 는 아는데 목적지가 다르면 버리고, 줄은 남겨 진짜 클릭이 뒤따를 수 있게 한다", () => {
    const id = recordBanner(ROUTE);
    expect(claimBanner({ id, target: "/c/other" })).toBeNull();
    expect(claimBanner({ id, target: ROUTE })).toBe(ROUTE);
  });

  it("IPC 를 넘어온 값의 모양이 틀리면 버린다", () => {
    const id = recordBanner(ROUTE);
    for (const bad of [null, undefined, "n-1", 7, [], {}, { id }, { target: ROUTE }, { id: 1, target: ROUTE }, { id, target: 1 }]) {
      expect(claimBanner(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(claimBanner({ id, target: ROUTE })).toBe(ROUTE);
  });

  it("배너마다 다른 id 가 나가고, 셸이 받아들이는 모양(영숫자·-·_, 64바이트 이하)이다", () => {
    const ids = Array.from({ length: 5 }, () => recordBanner(ROUTE));
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  // 확인하는 `claimBanner` 가 줄을 지우므로, 상한 시험은 먼저 다 적은 뒤 한 번씩만 읽는다.
  it("정확히 상한까지는 아무것도 밀려나지 않는다", () => {
    const ids = Array.from({ length: SHOWN_BANNER_CAP }, (_, i) => recordBanner(`/c/${i}`));
    expect(claimBanner({ id: ids[0], target: "/c/0" })).toBe("/c/0");
  });

  it("상한을 하나 넘으면 가장 오래된 줄 하나만 밀려난다", () => {
    const ids = Array.from({ length: SHOWN_BANNER_CAP + 1 }, (_, i) => recordBanner(`/c/${i}`));
    expect(claimBanner({ id: ids[0], target: "/c/0" })).toBeNull();
    expect(claimBanner({ id: ids[1], target: "/c/1" })).toBe("/c/1");
    const last = SHOWN_BANNER_CAP;
    expect(claimBanner({ id: ids[last], target: `/c/${last}` })).toBe(`/c/${last}`);
  });

  it("지우면(로그아웃) 모든 줄이 사라진다. 한 줄만 잊을 수도 있다", () => {
    const a = recordBanner("/c/a");
    const b = recordBanner("/c/b");
    forgetBanner(a);
    expect(claimBanner({ id: a, target: "/c/a" })).toBeNull();
    clearBanners();
    expect(claimBanner({ id: b, target: "/c/b" })).toBeNull();
  });
});

describe("showDesktopBanner", () => {
  const arms: BannerArm[] = [{ channelId: "00000000-0000-7000-8000-00000000020a" }];

  it("셸이 클릭을 알려 주고 갈 곳이 있으면 클릭 가능한 길로 보내고, 일반 배너는 보내지 않는다", async () => {
    tauri.notificationClickSupported.mockResolvedValue(true);
    tauri.showClickableNotification.mockResolvedValue("clickable");
    const plain = vi.fn();
    setPlainBannerHandler(plain);

    expect(await showDesktopBanner("제목", "본문", { route: ROUTE, arms })).toBe(true);

    expect(tauri.showNotification).not.toHaveBeenCalled();
    expect(tauri.showClickableNotification).toHaveBeenCalledTimes(1);
    const [title, body, click] = tauri.showClickableNotification.mock.calls[0] as [string, string, { id: string; target: string }];
    expect([title, body, click.target]).toEqual(["제목", "본문", ROUTE]);
    // 클릭이 오면 그 id 가 이 목적지로 읽힌다. 어림은 무장하지 않는다.
    expect(claimBanner(click)).toBe(ROUTE);
    expect(plain).not.toHaveBeenCalled();
  });

  it("id 는 셸에 보내기 전에 장부에 있다 — 응답보다 클릭이 먼저 와도 읽힌다", async () => {
    tauri.notificationClickSupported.mockResolvedValue(true);
    let claimedDuringShow: string | null = null;
    tauri.showClickableNotification.mockImplementation(async (_t: string, _b: string, click: { id: string; target: string }) => {
      claimedDuringShow = claimBanner(click);
      return "clickable";
    });
    await showDesktopBanner("제목", undefined, { route: ROUTE });
    expect(claimedDuringShow).toBe(ROUTE);
  });

  it("셸이 클릭을 못 알린다고 하면 예전 그대로 일반 배너로 보낸다(장부도 어림 처리기도 쓰지 않는다)", async () => {
    tauri.notificationClickSupported.mockResolvedValue(false);
    const plain = vi.fn();
    setPlainBannerHandler(plain);

    expect(await showDesktopBanner("제목", "본문", { route: ROUTE, arms })).toBe(true);

    expect(tauri.showNotification).toHaveBeenCalledWith("제목", "본문");
    expect(tauri.showClickableNotification).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
  });

  // 칸 알림(`paneAttention`)이 `offer` 에 넘기는 항목은 `{ kind, title, body, label }` 뿐이고 `route` 가 없다
  // (`paneAttention.ts` 의 `notify` 인자 타입). 그래서 그 배너는 지금도 눌러도 가는 곳이 없고, 이번 변경이 그것을 바꾸지 않는다.
  it("갈 곳이 없는 배너(칸 알림 등)는 셸이 클릭을 알려 주는 곳에서도 일반 배너다", async () => {
    tauri.notificationClickSupported.mockResolvedValue(true);
    await showDesktopBanner("제목", "본문", {});
    expect(tauri.showNotification).toHaveBeenCalledWith("제목", "본문");
    expect(tauri.showClickableNotification).not.toHaveBeenCalled();
  });

  it("셸이 「떴지만 클릭은 못 알린다」(한도 초과)고 하면 그 배너의 재료로 어림을 무장하고, 장부 줄은 지운다", async () => {
    tauri.notificationClickSupported.mockResolvedValue(true);
    tauri.showClickableNotification.mockResolvedValue("plain");
    const plain = vi.fn();
    setPlainBannerHandler(plain);
    let sent: { id: string; target: string } | null = null;
    tauri.showClickableNotification.mockImplementation(async (_t: string, _b: string, click: { id: string; target: string }) => {
      sent = click;
      return "plain";
    });

    expect(await showDesktopBanner("제목", "본문", { route: ROUTE, arms })).toBe(true);

    expect(plain).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledWith(arms);
    expect(claimBanner(sent)).toBeNull();
  });

  it("거절(권한 없음)이면 뜬 배너가 없으니 거짓이고, 어림도 무장하지 않는다", async () => {
    tauri.notificationClickSupported.mockResolvedValue(true);
    tauri.showClickableNotification.mockResolvedValue("refused");
    const plain = vi.fn();
    setPlainBannerHandler(plain);
    expect(await showDesktopBanner("제목", "본문", { route: ROUTE, arms })).toBe(false);
    expect(plain).not.toHaveBeenCalled();
  });

  it("어림 처리기가 없어도(화면이 내려갔다) 일반 배너 응답을 던지지 않고 받는다", async () => {
    tauri.notificationClickSupported.mockResolvedValue(true);
    tauri.showClickableNotification.mockResolvedValue("plain");
    setPlainBannerHandler(null);
    await expect(showDesktopBanner("제목", "본문", { route: ROUTE, arms })).resolves.toBe(true);
  });
});

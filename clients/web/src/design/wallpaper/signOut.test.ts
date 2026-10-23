import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// 로그아웃의 삭제 한 줄 (AP-4 #4191, ADR-0189 증보 3 D4 「로그아웃 시 삭제」).
//
// `lib/session.ts`의 `clearSession`이 부르는 `forgetWallpaperOnSignOut`은 (1) 저장소의 사진을 지우고 (2) 스토어가 듣는
// 구독자에게 알리며 (3) 어떤 실패도 로그아웃을 막지 않는다. (1)이 진짜 IndexedDB에서 일어나는지는 진짜 브라우저 시험
// (`photo.browser.test.ts`)이 재고, 여기서는 호출·구독·실패 격리를 노드에서 잰다.
// =============================================================================

const photos = vi.hoisted(() => ({
  clear: vi.fn<() => Promise<void>>(),
  available: true,
}));

vi.mock("./idb", () => ({
  defaultPhotoStore: () => {
    if (!photos.available) throw new Error("indexedDB unavailable");
    return { clear: photos.clear, read: vi.fn(), write: vi.fn() };
  },
}));

import { forgetWallpaperOnSignOut, onWallpaperSignOut } from "./signOut";

beforeEach(() => {
  photos.clear.mockReset();
  photos.clear.mockResolvedValue(undefined);
  photos.available = true;
});

describe("forgetWallpaperOnSignOut", () => {
  it("저장소의 사진을 한 번 지우고 구독자에게 한 번 알린다", () => {
    const heard = vi.fn();
    const off = onWallpaperSignOut(heard);
    forgetWallpaperOnSignOut();
    off();
    expect(photos.clear).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("해제한 구독자에게는 알리지 않는다 (그래도 사진은 지운다)", () => {
    const heard = vi.fn();
    onWallpaperSignOut(heard)();
    forgetWallpaperOnSignOut();
    expect(heard).not.toHaveBeenCalled();
    expect(photos.clear).toHaveBeenCalledTimes(1);
  });

  it("지우기가 거절돼도 던지지 않고 구독자는 알림을 받는다 (지우는 일이 로그아웃을 막지 않는다)", async () => {
    photos.clear.mockRejectedValue(new Error("quota"));
    const heard = vi.fn();
    const off = onWallpaperSignOut(heard);
    expect(() => forgetWallpaperOnSignOut()).not.toThrow();
    off();
    expect(heard).toHaveBeenCalledTimes(1);
    // 거절은 흡수된다: 처리되지 않은 거절이 남지 않는다.
    await Promise.resolve();
  });

  it("저장소를 얻지 못하는 환경(IndexedDB 없음)에서도 던지지 않고 구독자는 알림을 받는다", () => {
    photos.available = false;
    const heard = vi.fn();
    const off = onWallpaperSignOut(heard);
    expect(() => forgetWallpaperOnSignOut()).not.toThrow();
    off();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("구독자 하나가 던져도 다른 구독자와 사진 삭제는 그대로 간다", () => {
    const bad = vi.fn(() => {
      throw new Error("listener");
    });
    const good = vi.fn();
    const offBad = onWallpaperSignOut(bad);
    const offGood = onWallpaperSignOut(good);
    expect(() => forgetWallpaperOnSignOut()).not.toThrow();
    offBad();
    offGood();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(photos.clear).toHaveBeenCalledTimes(1);
  });
});

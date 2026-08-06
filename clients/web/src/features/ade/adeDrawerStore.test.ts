import { beforeEach, describe, expect, it } from "vitest";
import {
  adeDrawerSnapshot,
  closeAdeDrawer,
  openAdeDrawer,
  resetAdeDrawer,
  subscribeAdeDrawer,
  takeAdeDrawerOpener,
} from "./adeDrawerStore";

// 스토어의 계약은 세 줄이다: 열림 상태 하나, **한 번만** 가져가는 opener, 그리고
// 값이 안 바뀌면 아무도 안 깨우기.
//
// 두 번째가 중요한 이유는 캐럿 복구가 그것에 달려 있어서다 — 서랍이 두 번째로
// 마운트할 때 지난번 opener 를 다시 집으면 캐럿은 이미 사라진 버튼으로 간다.
// 세 번째가 중요한 이유는 이 불리언의 구독자가 AppShell 이라서다: 같은 값으로도
// 알리면 이미 열린 서랍을 다시 누르는 클릭이 셸 전체를 한 번 더 렌더한다.

describe("adeDrawerStore", () => {
  beforeEach(() => {
    resetAdeDrawer();
    takeAdeDrawerOpener();
  });

  it("기본은 닫힘", () => {
    expect(adeDrawerSnapshot()).toBe(false);
  });

  it("열고 닫는다", () => {
    openAdeDrawer(null);
    expect(adeDrawerSnapshot()).toBe(true);
    closeAdeDrawer();
    expect(adeDrawerSnapshot()).toBe(false);
  });

  it("opener 는 한 번만 나온다", () => {
    const opener = { isConnected: true, focus: () => {} };
    openAdeDrawer(opener);
    expect(takeAdeDrawerOpener()).toBe(opener);
    expect(takeAdeDrawerOpener()).toBeNull();
  });

  it("초기화하면 남아 있던 opener 도 버린다 — 열지 않은 서랍의 캐럿 주소는 없다", () => {
    openAdeDrawer({ isConnected: true, focus: () => {} });
    resetAdeDrawer();
    expect(takeAdeDrawerOpener()).toBeNull();
  });

  it("값이 안 바뀌면 아무도 안 깨운다", () => {
    let ticks = 0;
    const unsubscribe = subscribeAdeDrawer(() => {
      ticks += 1;
    });
    openAdeDrawer(null);
    openAdeDrawer(null);
    expect(ticks).toBe(1);
    closeAdeDrawer();
    closeAdeDrawer();
    expect(ticks).toBe(2);
    unsubscribe();
    openAdeDrawer(null);
    expect(ticks).toBe(2);
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeIsClaimed,
  escapeLayerDepth,
  overlayOwnsEscape,
  pushEscapeLayer,
  removeEscapeLayer,
  resetEscapeLayers,
  runTopEscapeLayer,
} from "./escapeLayer";

// 이 스택이 지키는 것은 한 줄이다: **한 번의 Esc 는 한 층만 닫는다.**
//
// 리뷰가 잡은 판(ADE 2단계 H1 ①)은 작업 패널 위에 관제 서랍이 열려 있는 상태였다.
// 둘 다 window 캡처 단계에 자기 리스너를 달고 `stopPropagation` 을 불렀는데, 그
// 호출은 같은 노드의 다른 리스너를 막지 못하므로 Esc 한 번에 둘이 함께 닫혔다.
// 아래 테스트는 그 상황을 층 순서로 재현한다 — 브라우저 없이 잴 수 있는 것이
// 정확히 이 순서이기 때문이다.

describe("escape layer stack", () => {
  beforeEach(() => {
    resetEscapeLayers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Esc 한 번은 맨 위 층 하나만 닫는다", () => {
    const panel = vi.fn();
    const drawer = vi.fn();
    pushEscapeLayer({ handle: panel });
    pushEscapeLayer({ handle: drawer });

    expect(runTopEscapeLayer(false)).toBe(true);
    expect(drawer).toHaveBeenCalledOnce();
    expect(panel).not.toHaveBeenCalled();
  });

  it("위 층이 닫히면 다음 Esc 가 아래 층을 닫는다", () => {
    const panel = vi.fn();
    const drawer = { handle: vi.fn() };
    pushEscapeLayer({ handle: panel });
    pushEscapeLayer(drawer);

    runTopEscapeLayer(false);
    removeEscapeLayer(drawer);
    expect(runTopEscapeLayer(false)).toBe(true);
    expect(panel).toHaveBeenCalledOnce();
  });

  it("층이 없으면 Esc 를 가로채지 않는다 (설정 라우트의 뒤로 가기가 살아 있다)", () => {
    expect(runTopEscapeLayer(false)).toBe(false);
  });

  it("다이얼로그·메뉴가 열려 있으면 어느 층도 받지 않는다", () => {
    const drawer = vi.fn();
    pushEscapeLayer({ handle: drawer });
    expect(runTopEscapeLayer(true)).toBe(false);
    expect(drawer).not.toHaveBeenCalled();
  });

  it("닫힌 층은 스택에서 빠진다 (남으면 그것이 가장 위가 된다)", () => {
    const layer = { handle: vi.fn() };
    pushEscapeLayer(layer);
    expect(escapeLayerDepth()).toBe(1);
    removeEscapeLayer(layer);
    expect(escapeLayerDepth()).toBe(0);
    expect(runTopEscapeLayer(false)).toBe(false);
  });

  // #1205 R2 신규 H — 삼키는 층. 웹훅 발급 카드가 떠 있는 동안의 Esc 는 아무
  // 일도 하지 않아야 하는데, 그 "아무 일도"가 성립하려면 누군가 소유해야 한다.
  it("삼키는 층은 Esc 를 받고 아무것도 하지 않는다 (밑으로도 안 넘긴다)", () => {
    const route = vi.fn();
    pushEscapeLayer({ handle: route });
    // 카드가 그 위를 덮는다: 아무것도 하지 않는 층.
    pushEscapeLayer({ handle: () => {} });

    // 소비됐다(true) — 그래서 라우트의 리스너까지 가지 않는다.
    expect(runTopEscapeLayer(false)).toBe(true);
    expect(route).not.toHaveBeenCalled();
  });

  describe("escapeIsClaimed — 층을 열지 않는 표면이 묻는 술어", () => {
    it("층이 서 있으면 Esc 는 이미 임자가 있다", () => {
      expect(escapeIsClaimed()).toBe(false);
      const layer = { handle: vi.fn() };
      pushEscapeLayer(layer);
      expect(escapeIsClaimed()).toBe(true);
      removeEscapeLayer(layer);
      expect(escapeIsClaimed()).toBe(false);
    });

    it("마운트된 role=menu 셀렉터를 실제로 조회한다 (N-5 · D4 Presence)", () => {
      const seen: string[] = [];
      vi.stubGlobal("document", {
        querySelector: (sel: string) => {
          seen.push(sel);
          return sel === '[role="menu"]' ? {} : null;
        },
      });
      expect(escapeLayerDepth()).toBe(0);
      expect(escapeIsClaimed()).toBe(true);
      expect(seen).toContain('[role="menu"]');
      vi.unstubAllGlobals();
    });

    it("Presence exit (data-state=closed dialog) still owns Escape", () => {
      // Measured node count, not "a class is present". Requiring
      // data-state=open here is the D4 bug: Radix already flipped to closed
      // before the same Escape reaches the layer underneath.
      const host = document.createElement("div");
      document.body.append(host);
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("data-state", "closed");
      host.append(dialog);

      expect(host.querySelectorAll('[role="dialog"]').length).toBe(1);
      expect(host.querySelectorAll('[role="dialog"][data-state="open"]').length).toBe(
        0
      );
      expect(overlayOwnsEscape(host)).toBe(true);
      expect(escapeIsClaimed()).toBe(true);

      dialog.remove();
      expect(host.querySelectorAll('[role="dialog"]').length).toBe(0);
      expect(overlayOwnsEscape(host)).toBe(false);
      host.remove();
    });
  });
});

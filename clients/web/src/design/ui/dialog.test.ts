import { describe, expect, it, vi } from "vitest";
import { restoreDialogOpenerFocus, type DialogFocusTarget } from "./dialog";

describe("dialog focus restoration", () => {
  it("returns a closed programmatic dialog to its opener", () => {
    const focus = vi.fn();
    const opener: DialogFocusTarget = { isConnected: true, focus };
    expect(restoreDialogOpenerFocus(opener)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("opener 선택 규칙 (4R H-2)", () => {
  // WebKit은 마우스 클릭으로 <button>에 포커스를 주지 않는다. 그래서 첫 렌더의
  // document.activeElement 추정은 <body>가 되고 돌려줄 자리가 사라진다 —
  // 데스크톱 셸이 WKWebView이므로 배포 대상의 절반이 그쪽이다. 호출부가 실제
  // 엘리먼트를 아는 경우 그것이 추정을 이겨야 한다.
  function chosen(explicit: DialogFocusTarget | null, estimated: DialogFocusTarget | null) {
    return explicit ?? estimated;
  }

  it("명시 opener가 activeElement 추정을 이긴다", () => {
    const explicitFocus = vi.fn();
    const estimatedFocus = vi.fn();
    const explicit: DialogFocusTarget = { isConnected: true, focus: explicitFocus };
    const estimated: DialogFocusTarget = { isConnected: true, focus: estimatedFocus };

    expect(restoreDialogOpenerFocus(chosen(explicit, estimated))).toBe(true);
    expect(explicitFocus).toHaveBeenCalledOnce();
    expect(estimatedFocus).not.toHaveBeenCalled();
  });

  it("명시 opener가 없으면 추정으로 폴백한다", () => {
    const estimatedFocus = vi.fn();
    const estimated: DialogFocusTarget = { isConnected: true, focus: estimatedFocus };
    expect(restoreDialogOpenerFocus(chosen(null, estimated))).toBe(true);
    expect(estimatedFocus).toHaveBeenCalledOnce();
  });

  it("사라진 opener에는 포커스를 주지 않는다", () => {
    const focus = vi.fn();
    expect(restoreDialogOpenerFocus({ isConnected: false, focus })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});

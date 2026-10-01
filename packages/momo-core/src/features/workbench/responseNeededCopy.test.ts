import { describe, expect, it } from "vitest";
import { SESSION_FILTER_LABEL, SESSION_LIST_EMPTY, SESSION_STATUS_LABEL } from "./sessionList";
import { TERMINAL_APP_BINDINGS } from "./keymap";

// #3279: 사용자에게 보이는 「나를 기다림」은 「응답 필요」다. 식별자(waiting)와 와이어 값은 그대로.
describe("「응답 필요」 표시 문구", () => {
  it("필터·상태 라벨·빈 문구·단축키 표", () => {
    expect(SESSION_FILTER_LABEL.waiting).toBe("응답 필요");
    expect(SESSION_STATUS_LABEL.waiting).toBe("응답 필요");
    expect(SESSION_LIST_EMPTY.waiting).toBe("응답이 필요한 세션이 없습니다.");
    expect(TERMINAL_APP_BINDINGS.find((b) => b.id === "next-waiting")?.description).toBe("다음 「응답 필요」로");
  });

  it("식별자는 그대로다", () => {
    expect(Object.keys(SESSION_STATUS_LABEL)).toContain("waiting");
    expect(Object.keys(SESSION_FILTER_LABEL)).toContain("waiting");
  });

  it("옛 문구가 어디에도 남지 않는다", () => {
    const all = [
      ...Object.values(SESSION_FILTER_LABEL),
      ...Object.values(SESSION_STATUS_LABEL),
      ...Object.values(SESSION_LIST_EMPTY),
      ...TERMINAL_APP_BINDINGS.map((b) => b.description),
    ].join("\n");
    expect(all).not.toContain("나를 기다");
  });
});

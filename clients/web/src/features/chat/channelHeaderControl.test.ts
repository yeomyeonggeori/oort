import { describe, expect, it } from "vitest";
import { channelHeaderControlClass } from "./channelHeaderControl";

/**
 * 클래스 문자열을 토큰 목록으로 쪼갠다. `toContain("border-line")`은 `border-line-strong`의 앞부분에도 참이라
 * 「연한 선」과 「3:1 선」을 가르지 못한다. 토큰 단위로 비교해야 두 이름이 서로를 가리지 않는다.
 */
const tokens = (className: string) => className.split(/\s+/).filter(Boolean);

describe("channelHeaderControlClass", () => {
  it("draws the mockup .a-ibtn: 34px, radius 10, one faint 1px line (#4591)", () => {
    const className = channelHeaderControlClass();
    const t = tokens(className);
    expect(t).toContain("size-icon-button");
    expect(t).toContain("rounded-md");
    // owner 2026-10-26(Buzz 캡처): 단추마다 아주 연한 선. ADR-0189 D6의 「테두리 없음」을 머리 단추에 한해 바꾼 것이다.
    expect(t).toContain("border");
    expect(t).toContain("border-line");
    // 3:1 선(`--line-strong`)은 텍스트 입력 그릇의 것이다. 쉼 상태의 머리 단추는 연한 선이다.
    expect(t).not.toContain("border-line-strong");
    expect(t).toContain("focus-visible:focus-ring");
  });

  it("gives high-contrast users the 3:1 line back", () => {
    expect(tokens(channelHeaderControlClass())).toContain("contrast-more:border-line-strong");
  });

  it("states are tokens: hover fill, pressed fill, open fill, focus ring, press scale", () => {
    const t = tokens(channelHeaderControlClass());
    expect(t).toContain("hover:bg-surface-hover");
    expect(t).toContain("active:bg-surface-pressed");
    expect(t).toContain("data-[state=open]:bg-surface-hover");
    expect(t).toContain("data-[state=open]:text-ink");
    expect(t).toContain("focus-visible:focus-ring");
    expect(t).toContain("press");
    // 상태 색을 날것으로 쓰지 않는다: 면은 전부 `bg-surface-*` 토큰이다.
    expect(t.filter((c) => /^(hover:|active:)?bg-/.test(c) && !/surface-(hover|pressed)$/.test(c))).toEqual([]);
  });

  it("widens for a count without leaving the control height", () => {
    const className = channelHeaderControlClass({ wide: true });
    expect(className).toContain("h-icon-button");
    expect(className).not.toContain("size-icon-button");
    expect(className).toContain("px-2");
    // 숫자가 붙어도 같은 선·같은 반경이다.
    expect(tokens(className)).toContain("border-line");
    expect(tokens(className)).toContain("rounded-md");
  });

  it("keeps a pressed terminal on accent-soft with a transparent line, not a second outline", () => {
    const t = tokens(channelHeaderControlClass({ pressed: true }));
    expect(t).toContain("bg-accent-soft");
    expect(t).toContain("text-signal-text");
    // 신호 면이 구분을 맡는다. 1px 자리는 그대로(`border`)라 켜고 꺼도 단추 크기가 변하지 않는다.
    expect(t).toContain("border");
    expect(t).toContain("border-transparent");
    expect(t).not.toContain("border-line");
    expect(t).not.toContain("border-line-strong");
  });
});

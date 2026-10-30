// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MAKE_PLAYS, MOTION_PRESETS, type MotionPresetId } from "@momo/core/features/expressions/make";
import { ExpressionMakePreview } from "./ExpressionMakePreview";

// 미리보기 CSS 는 jsdom 이 적용하지 않는다. 그래서 두 가지를 따로 잰다.
//   1. expressions.css 의 숫자를 파일에서 읽어 코어의 G3.3 표와 대조한다(길이, 총 4회, 움직임의 값).
//   2. 컴포넌트가 재생, 멈춤, 다시 재생, 동작 줄이기에서 어떤 상태 속성을 다는지 잰다.

// jsdom 환경의 URL 은 node 의 것이 아니라서 문자열 import.meta.url 을 경로로 바꾼다.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "expressions.css"), "utf8");
const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

/** 중괄호가 없는 선언 블록의 (선택자, 본문) 쌍. @keyframes 는 따로 읽는다. */
const rules = Array.from(css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)).map((match) => ({ selector: match[1].trim(), body: match[2] }));
function keyframes(name: string): { stops: number[]; body: string }[] {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, `${name} 키프레임이 있어야 해요`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}" && --depth === 0) { end = index; break; }
  }
  const inner = css.slice(css.indexOf("{", start) + 1, end);
  return Array.from(inner.matchAll(/([0-9.,%\s]+)\{([^{}]*)\}/g)).map((match) => ({ stops: match[1].split(",").map((stop) => parseFloat(stop)), body: match[2] }));
}
const animatedRules = (id: MotionPresetId) => rules.filter((rule) => rule.selector.includes(`[data-motion="${id}"]`) && rule.selector.includes('[data-animated="true"]'));
const declared = (body: string, property: string) => new RegExp(`${property}:\\s*([^;]+);`).exec(body)?.[1].trim();

describe("미리보기 CSS 와 G3.3 표", () => {
  it("한 번 재생 시간이 프레임 수 x 지연이에요", () => {
    for (const preset of MOTION_PRESETS) {
      const found = new RegExp(`--make-play-${preset.id}:\\s*(\\d+)ms`).exec(css);
      expect(Number(found?.[1])).toBe(preset.frames * preset.delayMs);
    }
    expect(MOTION_PRESETS.map((preset) => preset.playMs)).toEqual([640, 640, 600, 1000]);
  });
  it("프리셋마다 총 4회 재생하고 그 길이 변수를 써요", () => {
    expect(MAKE_PLAYS).toBe(4);
    for (const preset of MOTION_PRESETS) {
      const found = animatedRules(preset.id).filter((rule) => declared(rule.body, "animation-duration") !== undefined);
      expect(found.length, preset.id).toBeGreaterThan(0);
      for (const rule of found) {
        expect(declared(rule.body, "animation-iteration-count")).toBe(String(MAKE_PLAYS));
        expect(declared(rule.body, "animation-duration")).toBe(`var(--make-play-${preset.id})`);
      }
    }
  });
  it("멈춘 뒤에는 처음 모습으로 돌아가요: 끝 상태를 붙잡지 않아요", () => {
    for (const rule of rules.filter((entry) => entry.selector.includes("expression-make"))) {
      expect(declared(rule.body, "animation-fill-mode")).toBeUndefined();
    }
  });
  it("통통은 세로 -10% x |sin|, 바닥에서 가로 1.06 세로 0.94 눌림이에요", () => {
    const frames = keyframes("expression-make-bounce");
    expect(frames.map((frame) => frame.stops[0])).toEqual([0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100]);
    for (const frame of frames) {
      const lift = Number(/translateY\((-?[0-9.]+)%?\)/.exec(frame.body)?.[1] ?? "x");
      expect(lift).toBeCloseTo(-10 * Math.abs(Math.sin(Math.PI * frame.stops[0] / 100)), 1);
    }
    expect([frames[0].body, frames[8].body].every((body) => body.includes("scale(1.06, 0.94)"))).toBe(true);
    expect(frames.slice(1, 8).every((frame) => frame.body.includes("scale(1, 1)"))).toBe(true);
  });
  it("흔들흔들은 8도, 두근두근은 1.12배로 한 번 재생에 두 번이에요", () => {
    const wobble = keyframes("expression-make-wobble");
    expect(wobble.map((frame) => [frame.stops, /rotate\(([-0-9.]+)deg\)/.exec(frame.body)?.[1]])).toEqual([[[0, 50, 100], "0"], [[25], "8"], [[75], "-8"]]);
    const pulse = keyframes("expression-make-pulse");
    expect(pulse.map((frame) => [frame.stops, /scale\(([0-9.]+)\)/.exec(frame.body)?.[1]])).toEqual([[[0, 50, 100], "1"], [[25, 75], "1.12"]]);
  });
  it("반짝은 별 네 개가 한 번 재생의 네 구간에 하나씩만 켜져요", () => {
    for (let star = 0; star < 4; star++) {
      const frames = keyframes(`expression-make-star-${star}`);
      const lit = frames.filter((frame) => declared(frame.body, "opacity") === "1").flatMap((frame) => frame.stops);
      expect(lit).toEqual([star * 25]);
      // 켜진 구간은 다음 구간 시작에서 꺼진다(마지막 별은 끝까지가 아니라 100%에서).
      const next = frames.find((frame) => frame.stops.includes((star + 1) * 25));
      expect(declared(next?.body ?? "", "opacity")).toBe("0");
      const wiring = rules.find((rule) => rule.selector.includes('[data-motion="sparkle"]') && rule.selector.includes(`[data-star="${star}"]`));
      expect(declared(wiring?.body ?? "", "animation-name")).toBe(`expression-make-star-${star}`);
    }
    const base = animatedRules("sparkle").find((rule) => declared(rule.body, "animation-timing-function") !== undefined);
    expect(declared(base?.body ?? "", "animation-timing-function")).toBe("step-end");
  });
  it("동작 줄이기에서는 애니메이션을 끄는 규칙이 있어요", () => {
    const media = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\n\})/.exec(css)?.[1] ?? "";
    expect(media).toContain(".expression-make-picture");
    expect(media).toContain(".expression-make-star");
    expect(media).toMatch(/animation:\s*none/);
  });
  it("시간 값은 모션 사다리 밖이라 허용 표시가 같은 줄에 있어요", () => {
    const lines = source.split("\n").filter((line) => /\d+ms/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("/*"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !line.includes("design-preflight-allow"))).toEqual([]);
  });
});

describe("미리보기 컴포넌트", () => {
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  afterEach(cleanup);
  const SRC = "data:image/png;base64,VEhVTUI=";
  const state = (view: ReturnType<typeof render>) => view.getByTestId("preview").getAttribute("data-state");

  it("재생하다가 끝나면 멈추고, 키가 바뀌면 처음부터 다시 재생해요", () => {
    const view = render(<ExpressionMakePreview motion="bounce" src={SRC} playKey="a" reduce={false} testId="preview" />);
    expect(state(view)).toBe("playing");
    expect(view.getByTestId("preview").getAttribute("data-animated")).toBe("true");
    fireEvent.animationEnd(view.getByTestId("preview").querySelector(".expression-make-picture")!);
    expect(state(view)).toBe("stopped");
    view.rerender(<ExpressionMakePreview motion="bounce" src={SRC} playKey="b" reduce={false} testId="preview" />);
    expect(state(view)).toBe("playing");
  });
  it("동작 줄이기, 움직임 없이, 사진 없음은 정지 그림이에요", () => {
    for (const props of [{ motion: "bounce" as const, src: SRC, reduce: true }, { motion: "still" as const, src: SRC, reduce: false }, { motion: "wobble" as const, src: null, reduce: false }]) {
      const view = render(<ExpressionMakePreview {...props} playKey="a" testId="preview" />);
      expect([state(view), view.getByTestId("preview").getAttribute("data-animated")]).toEqual(["still", "false"]);
      expect(view.container.querySelectorAll("img").length).toBe(props.src === null ? 0 : 1);
      view.unmount();
    }
  });
  it("반짝에만 별 네 개가 서고 동작 줄이기면 서지 않아요", () => {
    const sparkle = render(<ExpressionMakePreview motion="sparkle" src={SRC} playKey="a" reduce={false} testId="preview" />);
    expect(sparkle.container.querySelectorAll(".expression-make-star")).toHaveLength(4);
    sparkle.unmount();
    for (const props of [{ motion: "sparkle" as const, reduce: true }, { motion: "bounce" as const, reduce: false }]) {
      const view = render(<ExpressionMakePreview {...props} src={SRC} playKey="a" testId="preview" />);
      expect(view.container.querySelectorAll(".expression-make-star")).toHaveLength(0);
      view.unmount();
    }
  });
  it("장식이라 보조기술에 숨기고 스타일 속성을 쓰지 않아요", () => {
    const view = render(<ExpressionMakePreview motion="pulse" src={SRC} playKey="a" reduce={false} testId="preview" />);
    expect(view.getByTestId("preview").getAttribute("aria-hidden")).toBe("true");
    expect(view.container.querySelectorAll("[style]")).toHaveLength(0);
  });
});

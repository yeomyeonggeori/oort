import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StatusDotTone } from "@momo/core/features/presence/statusDot";
import { STATUS_DOT_FILL_CLASS } from "./statusDot";

// =============================================================================
// 상태 점의 색 역할 (#3964 → #5786): 한 색 체계가 여러 자리에서 어긋나지 않는가.
//
// 상태 점은 두 모양으로 선다 — 글자가 곁에 있는 칩의 점(이 모듈의 `STATUS_DOT_FILL_CLASS`)과 아바타 모서리의 점(한 부품
// `AvatarStatus` + `tokens.css` 의 `avatar-status` 규칙, #5786). 예전에는 아바타 점이 세 파일에 클래스로 따로 적혀
// 있어(`DmAvatar`·`HumanPresence`·`PresenceControl`) 이 시험이 소스 글자로 셋을 이었다. 이제 아바타 점의 색은 CSS 한
// 곳에 있으므로 그 규칙과 칩의 색 역할이 같은 상태 토큰인지 잰다.
// =============================================================================

const TONES: readonly StatusDotTone[] = ["ok", "warn", "danger", "muted"];
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const avatarStatus = (() => {
  const start = css.indexOf("@utility avatar-status {");
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
})();

function dotRule(tone: StatusDotTone): string {
  const at = avatarStatus.indexOf(`[data-avatar-status-dot][data-tone="${tone}"] {`);
  expect(at, tone).toBeGreaterThan(-1);
  return avatarStatus.slice(at, avatarStatus.indexOf("}", at));
}

describe("상태 점 색 역할 (#3964, #5786)", () => {
  it("칩의 점과 아바타 점은 살아 있는 톤에서 같은 상태 토큰이다(아바타 초록만 띠 위에서 점 전용 값으로 섞인다)", () => {
    expect(dotRule("ok")).toContain("background-color: var(--status-ok, var(--ok));");
    expect(dotRule("warn")).toContain("background-color: var(--warn);");
    expect(dotRule("danger")).toContain("background-color: var(--danger);");
    // 칩 쪽 같은 역할.
    expect(STATUS_DOT_FILL_CLASS.ok).toBe("bg-ok");
    expect(STATUS_DOT_FILL_CLASS.warn).toBe("bg-warn");
    expect(STATUS_DOT_FILL_CLASS.danger).toBe("bg-danger");
  });

  it("Buzz식(소유자 결정 2026-10-17): 칩의 꺼짐 점은 낱말이 곁에 있어 채운 회색, 아바타의 꺼짐은 채움 없는 고리", () => {
    expect(STATUS_DOT_FILL_CLASS.muted).toBe("bg-ink-muted");
    expect(dotRule("muted")).not.toContain("background");
    expect(dotRule("muted")).toContain("border: var(--status-gap) solid var(--ink-muted);");
  });

  it("아바타 점에는 면색 테가 없다 — 테가 아니라 도려낸 틈이 점을 떼어 놓는다", () => {
    for (const tone of TONES) {
      expect(dotRule(tone), tone).not.toMatch(/--surface|border-surface/);
    }
    expect(avatarStatus).toMatch(/&\[data-status-cut\] > \[data-avatar-status-face\] \{[\s\S]*?mask-image: radial-gradient\(/);
  });

  it("색은 상태 토큰과 중립 토큰뿐이다: 하드코딩 색이 없다", () => {
    const all = Object.values(STATUS_DOT_FILL_CLASS).join(" ");
    expect(all).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|\[[^\]]+\]/i);
    for (const word of all.split(" ")) {
      expect(word).toMatch(/^bg-(ok|warn|danger|ink-muted)$/);
    }
    expect(avatarStatus).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});

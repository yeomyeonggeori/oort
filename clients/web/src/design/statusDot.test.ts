import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StatusDotTone } from "@momo/core/features/presence/statusDot";
import { STATUS_DOT_BADGE_CLASS, STATUS_DOT_FILL_CLASS } from "./statusDot";

// =============================================================================
// 상태 점의 클래스 (#3964): 한 색 체계가 여러 자리에서 어긋나지 않는가.
//
// 상태 점은 세 자리에 선다 — 사이드바 DM 행의 아바타 모서리(`DmAvatar`), 멤버 목록·헤더의 생존 칩(글자가
// 곁에 있다), 프로필 카드의 내 존재 배지(`PresenceBadge`). 앞의 둘은 이 모듈의 두 맵을 읽고, 셋째는
// `PresenceControl.tsx` 안의 함수를 읽는다. 셋째 파일은 같은 시기에 다른 이슈(#2899)가 만지는 자리라 이
// PR 이 열지 않았다 — 그래서 **값이 어긋나면 여기서 붉다**(소스 글자로 잇는 다리 검사, `presenceIndicators.
// test.ts` 와 같은 방법).
// =============================================================================

const TONES: readonly StatusDotTone[] = ["ok", "warn", "danger", "idle", "muted"];
/** 프로필 카드 존재 배지(`PresenceControl.effectiveBadgeClass`)가 아는 톤: online·away·dnd·offline. `idle` 은 에이전트에만 있다. */
const PRESENCE_TONES: readonly StatusDotTone[] = ["ok", "warn", "danger", "muted"];

const presenceControl = readFileSync(
  new URL("../features/sidebar/PresenceControl.tsx", import.meta.url),
  "utf8"
);

describe("상태 점 클래스 (#3964)", () => {
  it("아바타 모서리 점은 프로필 카드의 존재 배지와 같은 값이다(채움 + 면색 고리, 꺼짐은 속 빈 고리)", () => {
    // `PresenceControl.effectiveBadgeClass` 의 네 줄: online=ok · away=warn · dnd=danger · offline=muted.
    // 같은 파일의 `optionDotClass`(메뉴 옆 점: `bg-ok` 만)와 섞이지 않게 그 함수 몸통만 읽는다.
    const badgeFn = /function effectiveBadgeClass[\s\S]*?\n\}\n/.exec(presenceControl)?.[0] ?? "";
    expect(badgeFn).toContain("case \"online\"");
    for (const tone of PRESENCE_TONES) {
      expect(badgeFn, tone).toContain(`return "${STATUS_DOT_BADGE_CLASS[tone]}";`);
    }
  });

  it("글자가 곁에 있는 점(칩)과 아바타 점은 살아 있는 톤에서 같은 배경 색 역할이다", () => {
    // ok·warn·danger 는 두 맵이 같은 `bg-*` 를 쓴다. 칩의 초록이 아바타의 초록과 다른 토큰이 되면 한 상태에
    // 두 색이 생긴다.
    for (const tone of ["ok", "warn", "danger"] as const) {
      expect(STATUS_DOT_BADGE_CLASS[tone].split(" ")).toContain(
        STATUS_DOT_FILL_CLASS[tone]
      );
    }
  });

  it("모양이 말한다: 채운 회색(idle: 살아 있음)과 속 빈 고리(muted: 아님)는 다른 점이다 — 칩은 둘 다 채운 회색이다", () => {
    // 칩은 neutral 셋을 한 색(채운 회색)으로 그린다: 곁의 낱말이 가른다.
    expect(STATUS_DOT_FILL_CLASS.muted).toBe("bg-ink-muted");
    expect(STATUS_DOT_FILL_CLASS.idle).toBe("bg-ink-muted");
    // 낱말이 없는 아바타 점은 모양으로 가른다(design-review #3964 H1).
    expect(STATUS_DOT_BADGE_CLASS.idle.split(" ")).toEqual(["bg-ink-muted", "border-surface"]);
    expect(STATUS_DOT_BADGE_CLASS.muted.split(" ")).toEqual(["bg-surface", "border-line-strong"]);
    expect(STATUS_DOT_BADGE_CLASS.idle).not.toBe(STATUS_DOT_BADGE_CLASS.muted);
    // 채운 회색(`bg-ink-muted`)은 `idle` 뿐이다 - 속 빈 고리가 채운 회색으로 돌아가면 「꺼짐」이 「있음」으로 읽힌다.
    for (const tone of TONES) {
      expect(STATUS_DOT_BADGE_CLASS[tone].includes("bg-ink-muted")).toBe(tone === "idle");
    }
  });

  it("살아 있는 톤은 면색 고리(border-surface)를 두른다: 점이 아바타에서 떨어져 보인다", () => {
    for (const tone of ["ok", "warn", "danger", "idle"] as const) {
      expect(STATUS_DOT_BADGE_CLASS[tone]).toContain("border-surface");
    }
  });

  it("색은 상태 토큰(ok·warn·danger)과 중립 토큰뿐이다: 하드코딩 색이 없다", () => {
    const all = [
      ...Object.values(STATUS_DOT_FILL_CLASS),
      ...Object.values(STATUS_DOT_BADGE_CLASS),
    ].join(" ");
    expect(all).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|\[[^\]]+\]/i);
    for (const word of all.split(" ")) {
      expect(word).toMatch(
        /^(bg-(ok|warn|danger|ink-muted|surface)|border-(surface|line-strong))$/
      );
    }
  });
});

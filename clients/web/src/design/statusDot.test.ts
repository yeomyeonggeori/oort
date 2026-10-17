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

const TONES: readonly StatusDotTone[] = ["ok", "warn", "danger", "muted"];

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
    for (const tone of TONES) {
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

  it("Buzz식(소유자 결정 2026-10-17): 살아 있음은 채운 초록, 꺼짐은 속 빈 회색 고리 — 칩의 꺼짐 점은 낱말이 곁에 있어 채운 회색이다", () => {
    // 칩은 글자가 곁에 있다: 꺼짐도 채운 회색 점 + 낱말.
    expect(STATUS_DOT_FILL_CLASS.muted).toBe("bg-ink-muted");
    // 글자가 없는 아바타 점은 모양으로 가른다(design-review #3964 H1): 살아 있음 = 채운 초록, 꺼짐 = 속 빈 고리.
    expect(STATUS_DOT_BADGE_CLASS.ok.split(" ")).toEqual(["bg-ok", "border-surface"]);
    expect(STATUS_DOT_BADGE_CLASS.muted.split(" ")).toEqual(["bg-surface", "border-line-strong"]);
    // 채운 회색(`bg-ink-muted`)은 아바타 점 어디에도 없다 - 속 빈 고리가 채운 회색으로 돌아가면 「꺼짐」이 「있음」으로 읽힌다.
    for (const tone of TONES) {
      expect(STATUS_DOT_BADGE_CLASS[tone]).not.toContain("bg-ink-muted");
    }
  });

  it("살아 있는 톤은 면색 고리(border-surface)를 두른다: 점이 아바타에서 떨어져 보인다", () => {
    for (const tone of ["ok", "warn", "danger"] as const) {
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

import { describe, expect, it } from "vitest";
import { contrast } from "../../design/color";
import { catalogEntries, deriveCatalogMode } from "../../design/deriveCatalog";
import { THEMES, type ThemeId, type ThemeModeTokens } from "../../design/themes";
import { AVATAR_SIZE } from "../workspace/avatar";
import {
  STATUS_BADGE_MIN_GAP,
  STATUS_BADGE_RATIO,
  WEB_STATUS_BADGE_FACES,
  statusBadgeGeometry,
} from "./statusBadge";
import { effectivePresenceTone } from "./statusDot";

// 아바타 상태 점의 크기 표 (#5786). 이 표가 PR 본문·디자인 시스템 문서의 표다. 웹 CSS 값은
// `clients/web/src/features/presence/avatarStatus.geometry.test.ts` 가 이 함수와 대조하고, 폰은 이 함수를 그대로 부른다.

describe("상태 점 크기 — 아바타 한 변 하나에서", () => {
  it("세 웹 크기와 폰 크기의 표", () => {
    expect(WEB_STATUS_BADGE_FACES.map(statusBadgeGeometry)).toEqual([
      { face: 24, dot: 10, gap: 2 },
      { face: 32, dot: 12, gap: 2 },
      { face: 112, dot: 42, gap: 7 },
    ]);
    // 폰: 홈 DM 줄·대화 머리 28, 새 메시지 시트 32(`AVATAR_SIZE`).
    expect(statusBadgeGeometry(28)).toEqual({ face: 28, dot: 10, gap: 2 });
    expect(statusBadgeGeometry(AVATAR_SIZE)).toEqual({ face: 32, dot: 12, gap: 2 });
  });

  it("점 지름은 아바타의 약 38%(±4%p)이고 짝수다 — 중심이 정수 px 에 앉는다", () => {
    for (const face of [20, 24, 28, 32, 40, 56, 80, 112]) {
      const { dot } = statusBadgeGeometry(face);
      expect(dot % 2, `${face}`).toBe(0);
      expect(Math.abs(dot / face - STATUS_BADGE_RATIO), `${face}: ${dot}`).toBeLessThanOrEqual(0.04);
    }
  });

  it("틈은 2 아래로 내려가지 않고, 큰 얼굴에서는 점과 함께 자란다", () => {
    expect(statusBadgeGeometry(24).gap).toBe(STATUS_BADGE_MIN_GAP);
    expect(statusBadgeGeometry(32).gap).toBe(STATUS_BADGE_MIN_GAP);
    const hero = statusBadgeGeometry(112);
    expect(hero.gap).toBeGreaterThan(STATUS_BADGE_MIN_GAP);
    // 틈/점 비율이 작은 얼굴과 같은 자리(1/6 근처)에 머문다.
    expect(Math.abs(hero.gap / hero.dot - 1 / 6)).toBeLessThan(0.02);
  });

  it("점은 아바타 상자 안에 들어간다(도려낸 원이 상자 모서리를 넘는 것은 괜찮다 — 점 자신은 넘지 않는다)", () => {
    for (const face of WEB_STATUS_BADGE_FACES) {
      const { dot } = statusBadgeGeometry(face);
      expect(dot).toBeLessThan(face / 2);
    }
  });
});

describe("실효 상태 → 점 톤 (내 프로필 줄의 배지)", () => {
  it("온라인 = ok · 자리 비움 = warn · 방해 금지 = danger · 오프라인 = muted", () => {
    expect(effectivePresenceTone("online")).toBe("ok");
    expect(effectivePresenceTone("away")).toBe("warn");
    expect(effectivePresenceTone("dnd")).toBe("danger");
    expect(effectivePresenceTone("offline")).toBe("muted");
  });
});

describe("폰 얼굴 점의 대비 — 면색 틈 위의 표식 (#5786, #4725 M2)", () => {
  // 폰은 면색 고리(틈)를 쓰므로 표식이 맞닿는 것은 `surface` 다. 꺼짐 고리의 선은 `textFaint`(= line-strong).
  const marks = (t: ThemeModeTokens) => ({
    ok: t.color.ok,
    warn: t.color.warn,
    danger: t.color.danger,
    muted: t.color["line-strong"],
  });
  const modes = ["light", "dark"] as const;
  const all: [string, ThemeModeTokens][] = [
    ...(Object.keys(THEMES) as ThemeId[]).flatMap((id) => modes.map((m) => [`${id} ${m}`, THEMES[id][m]] as [string, ThemeModeTokens])),
    ...catalogEntries().flatMap((entry) =>
      modes.flatMap((m) => {
        const derived = deriveCatalogMode(entry.id, m);
        return derived ? [[`catalog:${entry.id} ${m}`, derived.tokens] as [string, ThemeModeTokens]] : [];
      })
    ),
  ];

  it("첫 파티·카탈로그 테마 × 밝게/어둡게: 네 표식 모두 surface 와 3:1 이상", () => {
    expect(all.length).toBeGreaterThan(Object.keys(THEMES).length * 2);
    const failures = all.flatMap(([label, t]) =>
      Object.entries(marks(t)).flatMap(([tone, color]) => {
        const r = contrast(color, t.color.surface);
        return r < 3 ? [`${label} ${tone} ${r.toFixed(2)}`] : [];
      })
    );
    expect(failures).toEqual([]);
  });
});

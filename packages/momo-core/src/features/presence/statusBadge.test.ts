import { describe, expect, it } from "vitest";
import { contrast } from "../../design/color";
import { blend } from "../../design/scrim";
import { catalogEntries, deriveCatalogMode } from "../../design/deriveCatalog";
import { THEMES, type ThemeId, type ThemeModeTokens } from "../../design/themes";
import { AVATAR_SIZE } from "../workspace/avatar";
import {
  STATUS_BADGE_MAX_DOT,
  STATUS_BADGE_MIN_GAP,
  STATUS_BADGE_RATIO,
  STATUS_BADGE_SMALL_FACE,
  STATUS_BADGE_SMALL_RATIO,
  WEB_STATUS_BADGE_FACES,
  statusBadgeGeometry,
  statusBadgeShape,
} from "./statusBadge";
import { effectivePresenceTone, type StatusDotTone } from "./statusDot";

// 아바타 상태 점의 크기 표 (#5786). 이 표가 PR 본문·디자인 시스템 문서의 표다. 웹 CSS 값은
// `clients/web/src/features/presence/avatarStatus.geometry.test.ts` 가 이 함수와 대조하고, 폰은 이 함수를 그대로 부른다.

describe("상태 점 크기 — 아바타 한 변 하나에서", () => {
  it("세 웹 크기와 폰 크기의 표(수리 1회차: 24 → 점 8 · 이니셜 1px, 112 → 점 28 · 틈 4)", () => {
    expect(WEB_STATUS_BADGE_FACES.map(statusBadgeGeometry)).toEqual([
      { face: 24, dot: 8, gap: 2, glyphShift: 1 },
      { face: 32, dot: 12, gap: 2, glyphShift: 0 },
      { face: 112, dot: 28, gap: 4, glyphShift: 0 },
    ]);
    // 폰: 홈 DM 줄·대화 머리 28, 새 메시지 시트 32(`AVATAR_SIZE`) — 이 칸 전과 같다.
    expect(statusBadgeGeometry(28)).toEqual({ face: 28, dot: 10, gap: 2, glyphShift: 0 });
    expect(statusBadgeGeometry(AVATAR_SIZE)).toEqual({ face: 32, dot: 12, gap: 2, glyphShift: 0 });
  });

  it("PR 본문·디자인 문서의 표: 24 · 32 · 40 · 56 · 112", () => {
    const table = [24, 32, 40, 56, 112].map((face) => {
      const { dot, gap } = statusBadgeGeometry(face);
      return [face, dot, gap];
    });
    expect(table).toEqual([
      [24, 8, 2],
      [32, 12, 2],
      [40, 16, 2],
      [56, 22, 3],
      [112, 28, 4],
    ]);
  });

  it("점은 짝수(중심이 정수 px)이고, 작은 얼굴은 1/3 · 보통 얼굴은 38% 근처 · 큰 얼굴은 상한 28 이다", () => {
    for (const face of [16, 20, 24, 28, 32, 40, 56, 64, 80, 112, 160]) {
      const { dot } = statusBadgeGeometry(face);
      expect(dot % 2, `${face}`).toBe(0);
      expect(dot, `${face}`).toBeLessThanOrEqual(STATUS_BADGE_MAX_DOT);
      if (face <= STATUS_BADGE_SMALL_FACE) {
        expect(Math.abs(dot / face - STATUS_BADGE_SMALL_RATIO), `${face}: ${dot}`).toBeLessThanOrEqual(0.05);
      } else if (face * STATUS_BADGE_RATIO <= STATUS_BADGE_MAX_DOT) {
        expect(Math.abs(dot / face - STATUS_BADGE_RATIO), `${face}: ${dot}`).toBeLessThanOrEqual(0.03);
      } else {
        expect(dot, `${face}`).toBe(STATUS_BADGE_MAX_DOT);
      }
    }
  });

  it("작은 얼굴의 구멍(점 + 틈×2)은 아바타 폭의 절반 아래다 — 이니셜 받침을 먹지 않는 자리(r1 B1: 58%)", () => {
    for (const face of [20, 24]) {
      const { dot, gap } = statusBadgeGeometry(face);
      expect((dot + 2 * gap) / face, `${face}`).toBeLessThanOrEqual(0.5);
    }
  });

  it("틈은 2 아래로 내려가지 않고, 큰 얼굴에서는 점의 1/7 로 자란다", () => {
    for (const face of [24, 28, 32, 40]) expect(statusBadgeGeometry(face).gap).toBe(STATUS_BADGE_MIN_GAP);
    expect(statusBadgeGeometry(112).gap).toBe(4);
  });

  it("이니셜을 옮기는 것은 작은 얼굴뿐이다", () => {
    for (const face of [16, 20, 24]) expect(statusBadgeGeometry(face).glyphShift, `${face}`).toBe(1);
    for (const face of [28, 32, 112]) expect(statusBadgeGeometry(face).glyphShift, `${face}`).toBe(0);
  });

  it("점은 아바타 상자 안에 들어간다(도려낸 원이 상자 모서리를 넘는 것은 괜찮다 — 점 자신은 넘지 않는다)", () => {
    for (const face of WEB_STATUS_BADGE_FACES) {
      const { dot } = statusBadgeGeometry(face);
      expect(dot).toBeLessThan(face / 2);
    }
  });
});

describe("상태 점 모양 — 톤이 아니라 뜻 (r1 H2)", () => {
  const TONES: readonly StatusDotTone[] = ["ok", "warn", "danger", "muted"];

  it("사람: 온라인 채운 원 · 자리 비움 초승달 · 방해 금지 가로 줄 · 오프라인 속 빈 고리", () => {
    expect(TONES.map((tone) => statusBadgeShape(tone, "human"))).toEqual(["fill", "moon", "bar", "ring"]);
  });

  it("에이전트: 경고는 채운 원(이 칸 전 그대로) · 꺼짐은 속 빈 고리 — 사람의 자리 비움과 같은 그림이 아니다", () => {
    expect(statusBadgeShape("ok", "agent")).toBe("fill");
    expect(statusBadgeShape("warn", "agent")).toBe("fill");
    expect(statusBadgeShape("muted", "agent")).toBe("ring");
    expect(statusBadgeShape("warn", "agent")).not.toBe(statusBadgeShape("warn", "human"));
  });

  it("사람의 네 상태는 모양이 모두 다르다", () => {
    expect(new Set(TONES.map((tone) => statusBadgeShape(tone, "human"))).size).toBe(4);
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

describe("폰 얼굴 점의 대비 — 얼굴이 서는 바탕 위의 표식 (#5786 r1 M3, #4725 M2)", () => {
  // 폰은 고리(틈)를 얼굴이 서는 바탕 색으로 칠한다(`FaceStatusDot` 의 `ground`). 그래서 표식이 맞닿는 것은 그 바탕이다:
  //   대화 머리 알약 · 새 메시지 카드 = surface
  //   홈 줄 = 바닥 그라데이션의 세 정지점(고리 색은 가운데 정지점이지만 줄은 위·아래 끝에도 선다) · 눌린 줄 = surface-pressed ·
  //   고른 줄 = 바닥 위 유리 합성(`homeRowGround`)
  // 꺼짐 고리의 선은 `textMuted`(= ink-muted)다 — `textFaint`(= line-strong)는 밝게 눌린 줄 위에서 2.7~3.0:1 이었다.
  const marks = (t: ThemeModeTokens) => ({
    ok: t.color.ok,
    warn: t.color.warn,
    danger: t.color.danger,
    muted: t.color["ink-muted"],
  });
  const rgba = (value: string) => {
    const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
    const hex = `#${parts.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    return { hex, alpha: parts[3] ?? 1 };
  };
  const grounds = (t: ThemeModeTokens): Record<string, string> => {
    const glass = rgba(t.glass);
    return {
      surface: t.color.surface,
      "canvas-top": t.canvas[0],
      "canvas-mid": t.canvas[1],
      "canvas-bottom": t.canvas[2],
      "surface-pressed": t.derived["surface-pressed"],
      "glass-on-canvas": blend(glass.hex, t.canvas[1], glass.alpha),
    };
  };
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

  it("첫 파티·카탈로그 테마 × 밝게/어둡게 × 바탕 여섯: 네 표식 모두 3:1 이상", () => {
    expect(all.length).toBeGreaterThan(Object.keys(THEMES).length * 2);
    const failures = all.flatMap(([label, t]) =>
      Object.entries(grounds(t)).flatMap(([ground, bg]) =>
        Object.entries(marks(t)).flatMap(([tone, color]) => {
          const r = contrast(color, bg);
          return r < 3 ? [`${label} ${ground} ${tone} ${r.toFixed(2)}`] : [];
        })
      )
    );
    expect(failures).toEqual([]);
  });

  it("고리 색(바닥 가운데 정지점)과 위·아래 끝의 차이는 1.06:1 이하다 — 그라데이션 위 줄에서 고리가 테로 서지 않는다", () => {
    for (const [label, t] of all) {
      expect(contrast(t.canvas[0], t.canvas[1]), `${label} 위`).toBeLessThanOrEqual(1.06);
      expect(contrast(t.canvas[2], t.canvas[1]), `${label} 아래`).toBeLessThanOrEqual(1.06);
    }
  });
});

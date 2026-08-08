import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DIVIDER_TONE,
  DIVIDER_TONE_SPEC,
  type DividerTone,
} from "@momo/core/features/timeline/divider";
import {
  CONTRAST_ROLE_TOKEN,
  DIVIDER_TONE_CLASS,
  DIVIDER_TONE_TOKEN,
} from "./dividerTone";

// =============================================================================
// 안읽음 경계의 색이 **우연이 아니라 계약**인가 (design-review U4-4 D-2)
//
// 리뷰가 실측한 상태: 웹은 `--accent`, 폰은 `warn`, 폰의 `accent`는 파랑. 두 값이
// 지금 비슷한 호박색이라 화면에서는 통일되어 보였지만 그것을 지키는 것이 없었다.
//
// 이 테스트가 지키는 것은 「호박색이다」가 아니라 **역할이다**: 코어가 정한 명세
// (`DIVIDER_TONE_SPEC`)를 이 팔레트의 실제 값에 대고 잰다. U4-4R W-2가 남긴
// 교훈이 그 방식의 이유다 — 그때의 가드는 이 레포가 쓰지 않는 표를 보고 있어서
// 초록이었다. 그래서 여기서는 `tokens.css`를 직접 읽는다.
// =============================================================================

const css = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);

/** 토큰 한 줄의 light-dark() 두 값을 [light, dark] 로. */
function tokenValues(name: string): [string, string] {
  const match = css.match(
    new RegExp(
      `${name}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})\\s*,\\s*(#[0-9a-f]{6})\\s*\\)`,
      "i"
    )
  );
  if (match === null) {
    throw new Error(
      `${name}이 tokens.css에 light-dark() 한 쌍으로 없다. 토큰을 옮겼다면 이 ` +
        "다리(dividerTone.ts)도 함께 옮길 것: 갈라지는 순간이 정확히 D-2다"
    );
  }
  return [match[1].toLowerCase(), match[2].toLowerCase()];
}

const SCHEMES = ["라이트", "다크"] as const;

describe("코어의 역할표를 이 팔레트가 전부 답한다", () => {
  it("모든 톤에 토큰과 클래스가 있다", () => {
    for (const tone of Object.values(DIVIDER_TONE) as DividerTone[]) {
      expect(DIVIDER_TONE_TOKEN[tone], `${tone} 토큰`).toBeTruthy();
      expect(DIVIDER_TONE_CLASS[tone], `${tone} 클래스`).toBeTruthy();
    }
  });

  it("명세가 든 대조 역할도 전부 답한다", () => {
    for (const role of DIVIDER_TONE_SPEC.boundary.mustDifferFrom) {
      // `quiet`은 톤 표가 답하고, 나머지는 대조 역할 표가 답한다. 어느 쪽도
      // 답하지 못하는 이름이 명세에 들어오면 그 조건은 재지 않은 채 지나간다.
      const answered =
        role in DIVIDER_TONE_TOKEN || role in CONTRAST_ROLE_TOKEN;
      expect(answered, `명세의 "${role}"을 이 팔레트가 답하지 못한다`).toBe(true);
    }
  });
});

describe("경계를 그리는 색은 무엇이 아닌가", () => {
  /**
   * 계약의 심장. 「경계가 무슨 색인가」는 팔레트마다 다르게 답해도 되지만, 이
   * 셋과 같아지면 그것은 더 이상 경계가 아니다 — 배경 표지이거나, 누군가의
   * 정체이거나, 사고다.
   */
  it("조용한 표지·에이전트 정체·위험과 두 스킴 모두에서 다르다", () => {
    const boundary = tokenValues(DIVIDER_TONE_TOKEN.boundary);
    for (const role of DIVIDER_TONE_SPEC.boundary.mustDifferFrom) {
      const other = tokenValues(
        DIVIDER_TONE_TOKEN[role as DividerTone] ?? CONTRAST_ROLE_TOKEN[role]
      );
      for (const [index, scheme] of SCHEMES.entries()) {
        expect(
          boundary[index],
          `${scheme}에서 안읽음 경계가 "${role}"과 같은 값이다`
        ).not.toBe(other[index]);
      }
    }
  });

  /**
   * 한 경계는 한 색이다. 라벨과 rule이 다른 토큰을 쓰면 그 줄은 두 가지를 말하고,
   * 어느 쪽이 경계인지 눈이 매번 다시 정한다.
   */
  it("경계는 라벨과 rule을 같은 토큰으로 칠한다", () => {
    expect(DIVIDER_TONE_SPEC.boundary.paintsRule).toBe(true);
    const { label, rule } = DIVIDER_TONE_CLASS.boundary;
    expect(label).toContain("text-accent");
    expect(rule).toContain("bg-accent");
  });

  /**
   * 색만으로 앞으로 나오게 하면 색각 이상이 있는 사람에게 이 줄은 그냥 회색 줄
   * 이다. 경계는 색과 굵기 둘로 나른다.
   */
  it("경계는 색 말고 굵기로도 앞에 선다", () => {
    expect(DIVIDER_TONE_CLASS.boundary.label).toContain("font-medium");
    expect(DIVIDER_TONE_CLASS.quiet.label).not.toContain("font-medium");
  });

  it("조용한 표지의 rule은 물들지 않는다", () => {
    expect(DIVIDER_TONE_SPEC.quiet.paintsRule).toBe(false);
    expect(DIVIDER_TONE_CLASS.quiet.rule).toContain("bg-line");
    expect(DIVIDER_TONE_CLASS.quiet.rule).not.toContain("accent");
  });
});

describe("어느 구분선이 경계인가", () => {
  it("안읽음 하나뿐이다: 날짜와 복구는 조용한 표지다", () => {
    expect(DIVIDER_TONE.unread).toBe("boundary");
    expect(DIVIDER_TONE.day).toBe("quiet");
    expect(DIVIDER_TONE.recovery).toBe("quiet");
  });
});

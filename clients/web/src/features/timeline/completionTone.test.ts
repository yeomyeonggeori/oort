import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_CHECK_TONE,
  COMPLETION_OUTCOME_TONE,
  type CompletionCheckOutcome,
  type CompletionTone,
} from "@momo/core/features/timeline/completionReportCard";
import {
  COMPLETION_TONE_CLASS,
  COMPLETION_TONE_SOFT_CLASS,
  COMPLETION_TONE_SOFT_TOKEN,
  COMPLETION_TONE_TOKEN,
} from "./completionTone";

// =============================================================================
// 완료 리포트 게이트 톤의 옷이 **우연이 아니라 계약**인가 (UXC-A · design-review Medium).
//
// `approvalNoteTone.test.ts` 의 짝이다. 그 파일이 승인 노트 세 톤에 대해 하는 일을
// 이 파일이 게이트 결과 네 톤에 대해 한다: 코어가 정한 역할(`COMPLETION_CHECK_TONE`)
// 을 이 팔레트의 실제 값(`tokens.css`)에 대고 잰다. 지키는 것은 「초록이다」가
// 아니라 **역할**이다 — 실패는 침묵과, 대기와, 통과와 **서로 다른 값**이어야 하고,
// 그 다름이 없으면 카드가 애써 갈라 둔 네 사실이 화면에서 한 색으로 합쳐진다.
//
// `tokens.css` 를 직접 읽는 이유는 design-system README §5.3 의 그 사각지대다:
// 문자열 존재만 재는 가드는 `skip: "text-danger"` 같은 한 글자 오타를 통과시키고,
// 그 오타는 사람이 다시 스크린샷을 뜰 때만 잡힌다.
// =============================================================================

const css = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");
const agentCard = readFileSync(new URL("./AgentCard.tsx", import.meta.url), "utf8");
const statusChip = readFileSync(new URL("./StatusChip.tsx", import.meta.url), "utf8");

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
      `${name} 이 tokens.css 에 light-dark() 한 쌍으로 없다. 토큰을 옮겼다면 이 ` +
        "다리(completionTone.ts)도 함께 옮길 것"
    );
  }
  return [match[1].toLowerCase(), match[2].toLowerCase()];
}

const SCHEMES = ["라이트", "다크"] as const;
const TONES: readonly CompletionTone[] = ["ok", "danger", "warn", "muted"];
const OUTCOMES: readonly CompletionCheckOutcome[] = [
  "pass",
  "fail",
  "skip",
  "pending",
  "unknown",
];

describe("코어의 역할표를 이 팔레트가 전부 답한다", () => {
  it("모든 톤에 토큰과 클래스가 있다", () => {
    for (const tone of TONES) {
      expect(COMPLETION_TONE_TOKEN[tone], `${tone} 토큰`).toBeTruthy();
      expect(COMPLETION_TONE_CLASS[tone], `${tone} 클래스`).toBeTruthy();
    }
  });

  it("클래스가 실제로 그 토큰을 든다", () => {
    // 표 둘이 갈라지면 값 대조는 초록인데 화면은 다른 색이 된다
    // (approvalNoteTone.test.ts 의 같은 단정).
    for (const tone of TONES) {
      const utility = `text-${COMPLETION_TONE_TOKEN[tone].slice(2)}`;
      expect(COMPLETION_TONE_CLASS[tone], `${tone} 클래스가 자기 토큰을 안 든다`).toBe(
        utility
      );
    }
  });

  it("네 토큰이 tokens.css 에 light-dark() 한 쌍으로 있다", () => {
    for (const tone of TONES) {
      expect(() => tokenValues(COMPLETION_TONE_TOKEN[tone])).not.toThrow();
    }
  });
});

describe("그릇 쪽 다리도 같은 계약을 진다 (#1516)", () => {
  it("모든 톤에 그릇 토큰과 그릇 클래스가 있다", () => {
    for (const tone of TONES) {
      expect(COMPLETION_TONE_SOFT_TOKEN[tone], `${tone} 그릇 토큰`).toBeTruthy();
      expect(COMPLETION_TONE_SOFT_CLASS[tone], `${tone} 그릇 클래스`).toBeTruthy();
    }
  });

  it("그릇 클래스가 실제로 그 그릇 토큰을 든다", () => {
    for (const tone of TONES) {
      const utility = `bg-${COMPLETION_TONE_SOFT_TOKEN[tone].slice(2)}`;
      expect(
        COMPLETION_TONE_SOFT_CLASS[tone],
        `${tone} 그릇 클래스가 자기 토큰을 안 든다`
      ).toBe(utility);
    }
  });

  it("네 그릇 토큰이 tokens.css 에 light-dark() 한 쌍으로 있다", () => {
    for (const tone of TONES) {
      expect(() => tokenValues(COMPLETION_TONE_SOFT_TOKEN[tone])).not.toThrow();
    }
  });

  it("그릇은 잉크에서 파생되지 않는다 — muted 한 칸이 그 규칙을 깬다", () => {
    // 「`--X` 에 `-soft` 를 붙인다」로 지으면 muted 칸이 `--ink-muted-soft` 라는 없는
    // 토큰을 부르고, 그 실패는 컴파일이 아니라 화면에서 **그릇 없는 칩**이 된다.
    // 그래서 두 표가 따로 적히고, 이 단정이 그 이유를 값으로 붙들어 둔다.
    expect(COMPLETION_TONE_TOKEN.muted).toBe("--ink-muted");
    expect(COMPLETION_TONE_SOFT_TOKEN.muted).toBe("--muted-soft");
    expect(
      `${COMPLETION_TONE_TOKEN.muted}-soft`,
      "그릇 이름이 잉크 이름에서 파생 가능해 보이면 다음 사람이 표를 하나로 합친다"
    ).not.toBe(COMPLETION_TONE_SOFT_TOKEN.muted);
  });

  it("톤이 있는 세 그릇은 서로 다른 값이다 — 통과와 실패가 같은 그릇에 서지 않는다", () => {
    for (const [index, scheme] of SCHEMES.entries()) {
      const seen = new Map<string, CompletionTone>();
      for (const tone of TONES) {
        const value = tokenValues(COMPLETION_TONE_SOFT_TOKEN[tone])[index];
        const clash = seen.get(value);
        expect(
          clash,
          `${scheme}에서 ${tone} 과 ${clash} 의 그릇이 같은 값(${value})이다`
        ).toBeUndefined();
        seen.set(value, tone);
      }
    }
  });
});

describe("네 결과가 서로 다른 색이다 — 침묵은 실패가 아니다 (ADR-0132)", () => {
  it("실패·침묵·대기·통과의 토큰 값이 두 스킴 모두에서 서로 다르다", () => {
    // 계약의 심장. 「실패가 무슨 색인가」는 팔레트가 답하지만, 그 값이 침묵(skip)이나
    // 대기(pending)나 통과(pass)와 같아지면 카드가 갈라 둔 네 사실이 다시 합쳐진다.
    for (const [index, scheme] of SCHEMES.entries()) {
      const seen = new Map<string, CompletionTone>();
      for (const tone of TONES) {
        const value = tokenValues(COMPLETION_TONE_TOKEN[tone])[index];
        const clash = seen.get(value);
        expect(
          clash,
          `${scheme}에서 ${tone} 과 ${clash} 가 같은 값(${value})이다`
        ).toBeUndefined();
        seen.set(value, tone);
      }
    }
  });
});

describe("코어의 결과 -> 역할 배정이 정직 규율을 지킨다", () => {
  it("통과·실패만 자기 색이고, 침묵·대기는 danger 가 아니다", () => {
    expect(COMPLETION_CHECK_TONE.pass).toBe("ok");
    expect(COMPLETION_CHECK_TONE.fail).toBe("danger");
    // 안 돌린 게이트(skip)와 아직 안 끝난 게이트(pending)를 붉게 칠하지 않는다.
    expect(COMPLETION_CHECK_TONE.skip).not.toBe("danger");
    expect(COMPLETION_CHECK_TONE.pending).not.toBe("danger");
  });

  it("머리 칩은 실패가 있어도 danger 가 아니라 warn(사람을 부르는 색)이다", () => {
    // 리포트를 낸 턴은 성공했다 — 붉은색은 표 안의 그 셀 하나에만 있다.
    expect(COMPLETION_OUTCOME_TONE.clean).toBe("ok");
    expect(COMPLETION_OUTCOME_TONE.attention).toBe("warn");
    expect(COMPLETION_OUTCOME_TONE.attention).not.toBe("danger");
  });

  it("역할표가 어휘를 하나도 빠뜨리지 않는다", () => {
    // 답하지 못하는 결과가 어휘에 들어오면 그 셀은 색 없이 지나간다.
    for (const outcome of OUTCOMES) {
      expect(COMPLETION_TONE_TOKEN[COMPLETION_CHECK_TONE[outcome]]).toBeTruthy();
    }
  });
});

describe("카드가 다리를 우회하지 않는다", () => {
  it("AgentCard 가 톤 클래스를 인라인으로 다시 적지 않는다", () => {
    // 화면이 다리를 우회해 자기 클래스를 적기 시작하면 위 단정 전부가 조용히
    // 무의미해진다(approvalNoteTone.test.ts 의 「카드가 표를 우회하지 않는다」).
    expect(agentCard).toContain('from "./completionTone"');
    expect(agentCard).toContain("COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE[");
  });

  it("머리 칩도 코어의 역할표를 지난다 — 인라인 색 리터럴이 아니다 (L1)", () => {
    // 게이트 셀과 같은 다리로 칠한다: `attention: text-danger` 같은 한 글자 오타가
    // 위 tokens 락에 걸리도록 칩 색도 COMPLETION_OUTCOME_TONE 를 경유한다.
    expect(statusChip).toContain(
      "COMPLETION_TONE_CLASS[COMPLETION_OUTCOME_TONE["
    );
    // 완료 칩만의 인라인 색 표(`COMPLETION_CHIP_CLASS`)가 사라졌다 — 다른 칩
    // 어휘(TurnChip·ApprovalChip)의 리터럴은 저마다의 자리라 건드리지 않는다.
    expect(statusChip).not.toContain("COMPLETION_CHIP_CLASS");
  });
});

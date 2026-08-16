import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOGIN_HANDOFF_DEPLOYMENT_COPY,
  LOGIN_HANDOFF_ELSEWHERE_COPY,
  LOGIN_HANDOFF_IN_CONTROL_COPY,
  LOGIN_HANDOFF_IN_CONTROL_LEAD,
  LOGIN_HANDOFF_OFFLINE_COPY,
  LOGIN_HANDOFF_OUTCOME_DETAIL,
  LOGIN_HANDOFF_STOPPED_COPY,
  LOGIN_HANDOFF_WAITING_COPY,
} from "@momo/core/features/timeline/loginHandoffCard";

// =============================================================================
// 로그인 핸드오프 카드의 **웹 사본 대조** (LIVE-4 design-review M1·H1·L1).
//
// 리뷰가 실측한 것: `stopped` 문장이 웹과 폰에 각각 인라인 리터럴로 적혀 있었고,
// 그래서 코어가 명시적으로 허용한 갈래(`stopped` + `control != null`)에서 두
// 화면이 **같은 거짓말을 두 번** 했다. 한 곳을 고쳐도 다른 곳은 그대로다.
//
// 이 파일이 지키는 것은 「문장이 예쁘다」가 아니라 **이 클라가 자기 문장을 다시
// 갖지 않는다**이다. 폰 쪽 짝은
// `clients/mobile/__tests__/loginHandoffCard.test.tsx`, 값과 조건의 모양은
// `packages/momo-core/src/features/timeline/loginHandoffCard.test.ts` 가 잰다.
//
// 렌더 트리가 아니라 **소스**를 읽는다. 이 클라에는 렌더 테스트 하네스가 없고
// (testing-library 가 의존성에 없다), 여기서 지켜야 하는 것은 「이 상태에서 무엇이
// 보이는가」가 아니라 「어떤 코드가 존재하지 않는가」다 — 부재는 밖에서 관측되지
// 않고, 나타났을 때 빨개지는 것이 유일한 방법이다
// (`features/work/displayStream.test.ts` 머리말의 같은 논증).
// =============================================================================

const AGENT_CARD_SRC = readFileSync(
  fileURLToPath(new URL("./AgentCard.tsx", import.meta.url)),
  "utf8"
);

/** 주석을 걷어낸 코드. 이 레포는 반례를 주석에 그대로 인용한다. */
const CODE_ONLY = AGENT_CARD_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  ""
);

describe("웹이 핸드오프 문장을 다시 쓰지 않는다 (M1)", () => {
  it("코어가 가진 문장은 하나도 인라인으로 적혀 있지 않다", () => {
    for (const sentence of [
      LOGIN_HANDOFF_DEPLOYMENT_COPY,
      LOGIN_HANDOFF_ELSEWHERE_COPY,
      LOGIN_HANDOFF_IN_CONTROL_COPY,
      LOGIN_HANDOFF_IN_CONTROL_LEAD,
      LOGIN_HANDOFF_OFFLINE_COPY,
      LOGIN_HANDOFF_WAITING_COPY,
      ...Object.values(LOGIN_HANDOFF_STOPPED_COPY),
      ...Object.values(LOGIN_HANDOFF_OUTCOME_DETAIL),
    ]) {
      expect(CODE_ONLY).not.toContain(sentence);
    }
  });

  it("멈춘 카드의 문장은 코어 헬퍼가 답한다 — 조건도 함께", () => {
    // 조건이 이 파일에 있으면 폰이 그 조건을 다시 적어야 하고, 그때부터 둘은
    // 각자 늙는다. H2 가 고친 갈래가 정확히 그것이다.
    expect(CODE_ONLY).toContain("loginHandoffStoppedCopy(card)");
  });
});

describe("핸드오프 카드의 컨트롤은 프리미티브다 (H1)", () => {
  it("이 파일에 수제 <button> 이 없다", () => {
    // 「작업 세션 열기」가 `border border-line` 로 손수 그려져 있었다. 그 토큰은
    // **나누는** 선이고(tokens.css:33-34) surface 위 1.32/1.43:1 이라 WCAG
    // 1.4.11 의 3:1 을 못 넘는다. `design/ui/button.tsx` 의 `outline` 이 같은
    // 모양으로 `--line-strong`(3.59/3.56:1)을 들고 있고, `controlBorders.test.ts`
    // 가 그 프리미티브만 지키고 있었다 — 기능 파일의 수제 컨트롤은 그 시험의
    // 사각지대다. 이 파일에서는 컨트롤을 손으로 그리지 않는다.
    expect(CODE_ONLY).not.toMatch(/<button\b/);
  });

  it("컨트롤을 그릴 때 드는 것은 Button 프리미티브다", () => {
    expect(CODE_ONLY).toContain('from "@/design/ui/button"');
    expect(CODE_ONLY).toMatch(/<Button\b/);
  });
});

/** 핸드오프 카드가 사는 함수 하나. 이 파일의 다른 카드는 이 규칙의 대상이 아니다. */
const HANDOFF_BODY = CODE_ONLY.slice(
  CODE_ONLY.indexOf("function LoginHandoffBody("),
  CODE_ONLY.indexOf("function ToolBody(")
);

describe("빈 띠를 그리지 않는다 (L1)", () => {
  it("함수를 실제로 잘라 냈다", () => {
    // 슬라이스가 빈 문자열이면 아래 단정은 아무것도 지키지 않는다.
    expect(HANDOFF_BODY).toContain("LOGIN_HANDOFF_DEPLOYMENT_COPY");
    expect(HANDOFF_BODY).toContain("note={");
  });

  it("note 슬롯의 래퍼가 무조건 렌더가 아니다", () => {
    // 안의 두 조각이 모두 조건부인데 래퍼만 무조건이면, settled 이고 sessionId 가
    // 없는 카드에서 `border-t` 와 `py-2` 만 남아 빈 띠가 선다. 래퍼 자체가 조건을
    // 져야 한다.
    //
    // 렌더가 아니라 소스로 재는 이유는 이 파일 머리말과 같다. 재는 방법은
    // 「슬롯이 벌거벗은 엘리먼트로 시작하지 않는다」이다 — 무조건 래퍼는 언제나
    // 그 모양이고, 가드가 붙는 순간 그 모양이 아니게 된다.
    expect(HANDOFF_BODY).not.toMatch(/note=\{\s*</);
  });
});

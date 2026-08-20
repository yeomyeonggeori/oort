import { describe, expect, it } from "vitest";
import {
  COMPLETION_CHECK_TONE,
  COMPLETION_OUTCOME_TONE,
} from "../timeline/completionReportCard";
import { ROW_STATE_CLASS, SESSION_STATUS_CLASS } from "./workSessionFormat";
import { workSessionStatus, type WorkSessionStatusKey } from "./workSessionModel";

// =============================================================================
// 수명주기 칩의 역할표 (#1491).
//
// 이 파일이 지키는 것은 「종료됨이 무슨 색인가」가 아니라 **어떤 사실이 색을 벌
// 수 있는가**다. 세션 행에는 이제 두 칩이 선다: 원장이 이 세션을 무엇이라 부르는가
// (수명주기)와 이 세션이 스스로 보고한 게이트 결과(검증, #1441). 뒤쪽만이 측정을
// 나르므로 초록도 뒤쪽만 진다 — 앞쪽의 초록은 「멈췄다」는, 그 행에서 가장 정보가
// 없는 사실 위에 얹힌 두 번째 초록이었고, 그러면 읽는 사람이 둘 중 어느 초록이
// 무엇을 뜻하는지 매번 되짚어야 한다.
//
// 그래서 단정은 「done 이 muted 다」 한 줄이 아니다. 그 한 줄은 다음 사람이 색을
// 되돌릴 때 근거 없이 뒤집힌다. 대신 규칙 자체를 잰다: 수명주기 어휘 **전체**에
// 초록이 없고, 검증 어휘에는 있으며, 단계 행 표와 같은 답을 낸다.
// =============================================================================

const KEYS: readonly WorkSessionStatusKey[] = [
  "running",
  "idle",
  "unavailable",
  "orphaned",
  "done",
  "unknown",
];

/** 클래스 문자열에서 잉크 유틸리티 한 개. 배경(`bg-`)은 이 질문의 대상이 아니다. */
function ink(className: string): string {
  const found = className.split(/\s+/).filter((c) => c.startsWith("text-"));
  expect(found, `잉크가 하나가 아니다: ${className}`).toHaveLength(1);
  return found[0];
}

describe("수명주기 칩에는 초록이 없다 (#1491)", () => {
  it("종료됨이 muted 로 선다 — 「끝났다」는 낱말이 이미 말한다", () => {
    expect(ink(SESSION_STATUS_CLASS.done)).toBe("text-ink-muted");
  });

  it("done 하나가 아니라 표 **전체**에 초록이 없다", () => {
    // 한 칸만 재면 다음 사람이 `idle: text-ok` 로 같은 결함을 다시 짓는다 —
    // 「완료 · 대기 중」도 끝난 일을 말하는 낱말이고, 그쪽이 더 그럴듯하다.
    for (const key of KEYS) {
      expect(SESSION_STATUS_CLASS[key], key).not.toContain("text-ok");
    }
  });

  it("초록은 측정을 나르는 칩이 진다 — 검증 어휘에는 그대로 있다", () => {
    // 이 대조가 이 결정의 전부다. 초록을 없앤 것이 아니라 **정보가 있는 자리로**
    // 옮긴 것이고, 검증 쪽이 초록을 잃으면 이 티켓의 근거도 함께 사라진다.
    expect(COMPLETION_CHECK_TONE.pass).toBe("ok");
    expect(COMPLETION_OUTCOME_TONE.clean).toBe("ok");
  });
});

describe("색을 버는 사실은 사람을 기다리는 것뿐이다", () => {
  it("강조를 드는 상태는 호스트 연결 끊김 하나다", () => {
    const accented = KEYS.filter((key) =>
      SESSION_STATUS_CLASS[key].includes("text-accent")
    );
    expect(accented).toEqual(["orphaned"]);
  });

  it("도는 세션만 warn 을 든다 — 지금 무언가가 벌어지고 있다는 유일한 상태", () => {
    const warned = KEYS.filter((key) =>
      SESSION_STATUS_CLASS[key].includes("text-warn")
    );
    expect(warned).toEqual(["running"]);
  });

  it("나머지 넷은 전부 같은 muted 다 — 끝난 방식이 색을 가르지 않는다", () => {
    for (const key of ["idle", "unavailable", "done", "unknown"] as const) {
      expect(SESSION_STATUS_CLASS[key], key).toBe("bg-muted-soft text-ink-muted");
    }
  });
});

// =============================================================================
// 그릇은 하나이고, 그것은 상호작용 상태의 것이 아니다 (#1515 / #1514 H-2).
//
// 위 절이 「어떤 사실이 색을 벌 수 있는가」를 잉크에서 물었다면, 이 절은 같은 물음을
// **그릇**에서 묻는다. 답은 「아무 사실도 못 번다」이다: 원장의 칩은 이 세션을 무엇
// 이라 부르는지를 말할 뿐 아무것도 재지 않으므로, 여섯 칸의 그릇이 전부 같다. 색을
// 버는 것은 측정이고, 측정을 나르는 칩은 옆에 따로 선다(검증 칩 #1441).
//
// 그리고 그 그릇은 `--surface-hover` 일 수 없다. 그 토큰은 행이 주목받았다는
// **상태**의 이름이라(hover · 펼침), 정적인 그릇으로 빌려 쓰면 상태가 켜진 동안
// 그릇이 꺼진다 — 읽고 있는 행에서만 사라지는 그릇이었다(실측 대비 1.00).
//
// 여기서 재는 것은 클래스 문자열의 모양이고, 그 문자열이 가리키는 **값**이 실제로
// 행 바탕과 다른지는 웹의 `tokens.contrast.test.ts` 와
// `sessionVerificationTone.test.ts` 가 tokens.css 를 파싱해 잰다. 코어는 두 클라가
// 공유하는 역할표만 지므로 여기서 팔레트를 읽지 않는다.
// =============================================================================

/** 클래스 문자열에서 배경 유틸리티 한 개. */
function fill(className: string): string {
  const found = className.split(/\s+/).filter((c) => c.startsWith("bg-"));
  expect(found, `그릇이 하나가 아니다: ${className}`).toHaveLength(1);
  return found[0];
}

describe("칩의 그릇 (#1515)", () => {
  it("수명주기 여섯 칸이 전부 같은 그릇을 쓴다 — 그릇은 사실을 나르지 않는다", () => {
    for (const key of KEYS) {
      expect(fill(SESSION_STATUS_CLASS[key]), key).toBe("bg-muted-soft");
    }
  });

  it("단계 행 표도 같은 그릇이다 — 한 파일에 규칙이 둘일 수 없다", () => {
    // 이 표에는 H-2 가 없었다(미리보기 패널 위에 서므로 행의 주목 상태와 부딪히지
    // 않는다). 그래도 함께 옮긴 이유는 바로 위 표와 다른 답을 내면 다음 사람이 둘
    // 중 어느 쪽이 규칙인지 고르게 되기 때문이다.
    for (const [key, value] of Object.entries(ROW_STATE_CLASS)) {
      expect(fill(value), key).toBe("bg-muted-soft");
    }
  });

  it("어느 칸도 상호작용 상태를 그리는 토큰을 그릇으로 쓰지 않는다", () => {
    // 값이 아니라 **이름**을 막는다. `--surface-hover` 는 가리킨 행이고
    // `--accent-soft` 는 선택된 행이다(사이드바·관제 줄). 둘 중 무엇이든 칩의
    // 그릇으로 돌아오면 그 상태가 켜진 행에서 칩이 사라진다.
    for (const table of [SESSION_STATUS_CLASS, ROW_STATE_CLASS]) {
      for (const [key, value] of Object.entries(table)) {
        expect(value, `${key}: 가리킨 행의 바탕을 그릇으로 쓴다`).not.toContain(
          "bg-surface-hover"
        );
        expect(value, `${key}: 선택된 행의 바탕을 그릇으로 쓴다`).not.toContain(
          "bg-accent-soft"
        );
      }
    }
  });
});

describe("한 파일 안의 두 표가 같은 답을 낸다", () => {
  it("세션의 종료됨과 단계 행의 완료가 같은 잉크다", () => {
    // 「a wall of green is not a reading aid」는 아래 표의 독스트링이 이미 적어
    // 둔 규율이고, 같은 화면의 두 표가 그 물음에 다르게 답하면 규칙이 둘이 된다.
    expect(ink(SESSION_STATUS_CLASS.done)).toBe(ink(ROW_STATE_CLASS.done));
  });
});

describe("표가 원장이 실제로 내는 상태를 전부 덮는다", () => {
  it("`workSessionStatus` 가 내는 모든 키에 칸이 있다", () => {
    // 타입은 표의 칸을 강제하지만 **모델이 그 키를 실제로 내는지**는 말하지 않는다.
    // 빈 문자열이 섞이면 칩이 색 없이 서고, 그건 타입이 잡지 못한다.
    for (const status of ["running", "idle", "orphaned", "ended", "wat"]) {
      const key = workSessionStatus({ status, exitCode: undefined }).key;
      expect(SESSION_STATUS_CLASS[key], key).toBeTruthy();
    }
  });
});

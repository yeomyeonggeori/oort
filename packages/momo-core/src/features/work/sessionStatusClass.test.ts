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
      expect(SESSION_STATUS_CLASS[key], key).toBe("bg-surface-hover text-ink-muted");
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

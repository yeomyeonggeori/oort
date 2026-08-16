import { describe, expect, it } from "vitest";
import { elapsedLabel } from "../agents/workingSignal";
import { formatElapsed } from "../timeline/completionReportCard";
import {
  SESSION_WORKED_SUFFIX,
  sessionElapsedReadout,
} from "./workSessionFormat";

// =============================================================================
// 세션 경과의 세 갈래 (UXC-C / 커서 웹 ADE 벤치마크 §3-C).
//
// 같은 숫자가 세 가지 다른 말을 한다: 도는 시계, 끝난 일의 성과, 그리고 **아무 말도
// 안 함**. 세 번째가 이 계약의 심장이다 — 시작을 관측하지 못했을 때 「0s」를 그리면
// 화면은 우리가 눈치챈 순간을 세션이 시작한 순간이라고 말한다.
// =============================================================================

const START = 1_700_000_000_000;

describe("끝난 세션: 경과가 시계가 아니라 성과의 단위다", () => {
  it("끝난 시각이 관측된 세션은 「N분 N초 동안 작업」으로 선다", () => {
    const readout = sessionElapsedReadout(
      { startedAtMs: START, endedAtMs: START + 1_468_000 },
      START + 9_999_999
    );
    expect(readout).not.toBeNull();
    expect(readout?.kind).toBe("worked");
    expect(readout?.label).toBe(`24분 28초 ${SESSION_WORKED_SUFFIX}`);
    // 라벨이 이미 「실행 시간」인 자리(세션 정보)는 격 없이 숫자만 쓴다.
    expect(readout?.value).toBe("24분 28초");
  });

  it("`nowMs` 가 흘러도 값이 변하지 않는다 — 끝난 일은 더 자라지 않는다", () => {
    const at = (nowMs: number) =>
      sessionElapsedReadout({ startedAtMs: START, endedAtMs: START + 90_000 }, nowMs)
        ?.label;
    expect(at(START + 90_000)).toBe(at(START + 86_400_000));
  });

  it("자릿폭 고정을 걸지 않는다 — 한글 음절이 벌어진다", () => {
    // 코어 `formatElapsed` 독스트링의 그 규율. 부르는 쪽이 `data-numeric` 을 걸지
    // 말지를 이 플래그로 정하므로, 여기서 뒤집히면 화면이 조용히 벌어진다.
    const readout = sessionElapsedReadout(
      { startedAtMs: START, endedAtMs: START + 61_000 },
      START
    );
    expect(readout?.numeric).toBe(false);
  });

  it("성과 서술은 코어 `formatElapsed` 를 감싼 것이지 새 포맷이 아니다", () => {
    // 세 번째 계보를 만들지 않는다는 계약(핸드오프 패킷 §5). 포맷 로직이 복제되면
    // 카드의 「작업 시간」과 세션의 경과가 언젠가 다른 낱말을 쓰게 된다.
    for (const ms of [0, 999, 12_000, 61_000, 1_468_000, 3_723_000]) {
      const readout = sessionElapsedReadout(
        { startedAtMs: START, endedAtMs: START + ms },
        START
      );
      expect(readout?.value, `${ms}ms`).toBe(formatElapsed(ms));
    }
  });
});

describe("도는 세션: 시계는 시계로 남는다", () => {
  it("끝난 시각이 없으면 살아 있는 시계다", () => {
    const readout = sessionElapsedReadout(
      { startedAtMs: START },
      START + 192_000
    );
    expect(readout?.kind).toBe("clock");
    expect(readout?.label).toBe(elapsedLabel(START, START + 192_000));
    expect(readout?.label).toBe("3m 12s");
  });

  it("시계에는 자릿폭 고정을 건다 — 초가 째깍여도 옆이 밀리지 않게", () => {
    const readout = sessionElapsedReadout({ startedAtMs: START }, START + 5_000);
    expect(readout?.numeric).toBe(true);
  });

  it("`endedAtMs: null` 도 「끝을 모른다」이지 「끝났다」가 아니다", () => {
    const readout = sessionElapsedReadout(
      { startedAtMs: START, endedAtMs: null },
      START + 42_000
    );
    expect(readout?.kind).toBe("clock");
  });
});

describe("시작이 관측되지 않았으면 시계를 짓지 않는다", () => {
  it("시작 시각이 없으면 그릴 것이 없다", () => {
    expect(sessionElapsedReadout({}, START)).toBeNull();
    expect(sessionElapsedReadout({ startedAtMs: null }, START)).toBeNull();
  });

  it("수가 아닌 시작 시각도 마찬가지다 — 「0s」로 떨어지지 않는다", () => {
    expect(sessionElapsedReadout({ startedAtMs: Number.NaN }, START)).toBeNull();
    expect(
      sessionElapsedReadout({ startedAtMs: Number.POSITIVE_INFINITY }, START)
    ).toBeNull();
  });

  it("끝이 시작보다 앞선 봉투는 지어낸 숫자 대신 아무것도 그리지 않는다", () => {
    // 시각이 어긋난 호스트. 「12초」를 지어내는 대신 침묵한다.
    expect(
      sessionElapsedReadout(
        { startedAtMs: START, endedAtMs: START - 60_000 },
        START
      )
    ).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SESSION_ELAPSED_META_LABEL,
  sessionElapsedReadout,
} from "@momo/core/features/work/workSessionFormat";
import { WORKED_ELAPSED_LABEL } from "@momo/core/features/timeline/completionReportCard";

// =============================================================================
// 세션 경과가 화면에서 세 갈래를 지키는가 (UXC-C).
//
// 규칙 자체는 코어가 지고 그쪽 스위트가 잰다(`workSessionFormat.test.ts`). 여기서
// 재는 것은 **그 규칙이 화면까지 오는가**다: 두 표면이 같은 함수를 부르는지, 끝난
// 세션의 한글 섞인 낱말에 자릿폭 고정을 걸지 않는지, 시작이 관측되지 않은 세션에서
// 그 자리가 사라지는지.
//
// 소스를 읽어서 재는 이유는 이 세 가지가 전부 **없음**에 관한 단정이기 때문이다.
// 렌더링되지 않은 노드는 스냅샷에도 없고, 「없어야 할 것이 없다」는 그 자리를
// 소유한 코드에 대고 물을 때만 red 가 된다.
// =============================================================================

const panel = readFileSync(new URL("./WorkPanel.tsx", import.meta.url), "utf8");
const detail = readFileSync(
  new URL("./WorkSessionDetail.tsx", import.meta.url),
  "utf8"
);
const SURFACES = [
  ["WorkPanel", panel],
  ["WorkSessionDetail", detail],
] as const;

const START = 1_700_000_000_000;

describe("세 갈래가 화면까지 온다", () => {
  it("두 표면이 코어의 한 판정을 부른다 — 시계 함수를 직접 부르지 않는다", () => {
    for (const [name, source] of SURFACES) {
      expect(source, name).toContain("sessionElapsedReadout(session, nowMs)");
      // `elapsedLabel(startedAtMs, endedAtMs ?? nowMs)` 로 돌아가면 끝난 세션이
      // 다시 시계가 되고, 두 표면이 서로 다른 격으로 같은 세션을 말하게 된다.
      expect(source, name).not.toContain("elapsedLabel(session.startedAtMs");
    }
  });

  it("시작이 관측되지 않은 세션에는 그 자리가 아예 없다", () => {
    expect(sessionElapsedReadout({}, START)).toBeNull();
    for (const [name, source] of SURFACES) {
      expect(source, name).toContain("elapsed !== null &&");
    }
  });

  it("상세에서는 두 갈래가 **서로 다른 줄**에 산다 (design-review H-1)", () => {
    // 시계는 sticky 머리에 남는다(계속 바뀌고 생존 신호가 칠한다). 성과 서술은
    // 아래 「스스로 보고한 것」 줄로 내려간다 — 셋을 한 줄에 세우면 320px 판에서
    // 제목이 목록 행보다 좁아졌고, 세션 식별이 유일한 임무인 줄이 목록보다 적게
    // 말하게 됐다. 픽셀 비교는 `capture-session-chips.mjs` 가 매 실행마다 한다.
    expect(detail).toContain('elapsed.kind === "clock"');
    expect(detail).toContain('elapsed.kind === "worked"');
    const headEnd = detail.indexOf('data-testid="work-detail-status"');
    expect(headEnd).toBeGreaterThan(0);
    expect(
      detail.indexOf('elapsed.kind === "clock"'),
      "시계가 sticky 머리 밖으로 나갔다"
    ).toBeLessThan(headEnd);
    expect(
      detail.indexOf('elapsed.kind === "worked"'),
      "성과 서술이 아직 sticky 머리 안에 있다"
    ).toBeGreaterThan(headEnd);
  });

  it("검증 칩도 머리를 떠나 성과 서술과 같은 줄에 선다 (H-1)", () => {
    // 경계는 「원장이 말하는 것」(상태 칩·시계)과 「세션이 스스로 보고한 것」이다.
    const headEnd = detail.indexOf('data-testid="work-detail-status"');
    expect(
      detail.indexOf("<SessionVerificationChip"),
      "검증 칩이 아직 sticky 머리 안에 있다"
    ).toBeGreaterThan(headEnd);
    expect(detail).toContain('data-testid="work-detail-report"');
  });

  it("자릿폭 고정은 시계에만 걸린다 — 한글 음절이 벌어지지 않게", () => {
    const worked = sessionElapsedReadout(
      { startedAtMs: START, endedAtMs: START + 1_468_000 },
      START
    );
    const clock = sessionElapsedReadout({ startedAtMs: START }, START + 61_000);
    expect(worked?.numeric).toBe(false);
    expect(clock?.numeric).toBe(true);
    for (const [name, source] of SURFACES) {
      // 조건 없는 `data-numeric` / `font-mono` 가 남아 있으면 위 플래그가
      // 화면에 도달하지 못한다.
      expect(source, name).toContain('elapsed.numeric ? { "data-numeric": true }');
      expect(source, name).toContain('elapsed.numeric && "font-mono"');
    }
  });

  it("세션 정보의 라벨은 코어가 준다 — 카드와 같은 낱말 (#1468)", () => {
    // 그 자리는 라벨:값 쌍이라 위 조각과 형태가 다르지만 어근은 같아야 한다.
    // 「실행 시간」이 이 파일에 남아 있으면 한 화면의 한 숫자가 두 어근으로 불린다.
    expect(detail).toContain("SESSION_ELAPSED_META_LABEL[elapsed.kind]");
    expect(detail).not.toContain("실행 시간");
    expect(SESSION_ELAPSED_META_LABEL.worked).toBe(WORKED_ELAPSED_LABEL);
  });

  it("그 라벨의 갈림은 화면이 다시 판정하지 않는다 (#1468)", () => {
    // `session.endedAtMs === undefined` 로 되돌아가면 코어가 시계라고 부르는
    // 세션(`endedAtMs: null`)에 「작업 시간」 라벨이 붙는다. 판정은 한 곳이다.
    expect(detail).not.toContain("session.endedAtMs === undefined");
  });

  it("경과 자리의 testid 는 그대로다 — 기존 게이트가 계속 이 자리를 짚는다", () => {
    expect(panel).toContain('data-testid="work-session-elapsed"');
    expect(detail).toContain('data-testid="work-detail-elapsed"');
    // 어느 갈래인지도 실린다: 게이트가 「무엇이 그려졌나」가 아니라 **무엇이
    // 성립하나**를 물을 수 있게(세션 행 `data-verb` 와 같은 규율).
    for (const [name, source] of SURFACES) {
      expect(source, name).toContain("data-kind={elapsed.kind}");
    }
  });
});

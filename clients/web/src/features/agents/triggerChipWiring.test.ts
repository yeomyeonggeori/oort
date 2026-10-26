import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// #4619 B·D·E 배선. 타임라인(`Timeline`)은 가상 목록이라 jsdom에서 그려 볼 수 없다. 그래서 **연결**을 소스로 잰다
// (`approvalWaitWiring.test`와 같은 방법): 규칙과 마크업은 각자의 시험이 재고, 여기서는 호출·마운트 한 줄이 지워지면
// 규칙은 멀쩡한데 화면에는 칩이 없는 일을 붙든다.
// =============================================================================

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("트리거 칩·예외 줄 배선 (#4619)", () => {
  it("타임라인은 끝난 run의 답을 한 번 색인해 행에 넘긴다", () => {
    const timeline = source("../timeline/Timeline.tsx");
    expect(timeline).toContain("runAnswerMap(channelRuns, messages)");
    expect(timeline).toContain("runAnswers={runAnswers}");
    // 나(내가 보낸 메시지)에게만 run을 넘기는 규칙은 그대로다.
    expect(timeline).toContain("uuidEq(message.authorMemberId, myMemberIdForFold)");
  });

  it("메시지 행은 머리 줄(MESSAGE_HEAD_CLASS)의 시각 뒤에 칩을, 꼬리 줄 요약 옆에 작업 중 칩을, 아래에 예외 줄을 세운다", () => {
    const row = source("../timeline/MessageRow.tsx");
    const headStart = row.indexOf("<div className={MESSAGE_HEAD_CLASS}>");
    const headEnd = row.indexOf("{/* 본문 **위**", headStart);
    expect(headStart).toBeGreaterThan(0);
    expect(headEnd).toBeGreaterThan(headStart);
    const head = row.slice(headStart, headEnd);
    // 칩은 머리 줄 안에서 시각 **뒤**다(시각 옆).
    expect(head.indexOf('data-testid="row-time"')).toBeGreaterThan(0);
    expect(head.indexOf("<MessageTriggerChip")).toBeGreaterThan(head.indexOf('data-testid="row-time"'));
    // 칩이 답으로 가는 길(onJumpToMessage)과 답 지도(runAnswers)를 받는다.
    expect(head).toMatch(/<MessageTriggerChip[\s\S]*?runAnswers[\s\S]*?onJump: onJumpToMessage[\s\S]*?\/>/);
    // 스레드 요약 줄의 칩은 답글(rollup)이 있을 때만이다.
    expect(row).toMatch(/\{rollup && runStatus !== undefined && runStatus\.length > 0 && \(\s*<ThreadWorkChip/);
    expect(row).toContain("<MessageRunStatus");
  });

  it("옛 문장 행의 자리(MessageRunStatus)는 예외 줄만 그리고, 평소의 진행은 core `runStatusLine`을 더 부르지 않는다", () => {
    const status = source("./MessageRunStatus.tsx");
    expect(status).toContain("runException(");
    expect(status).not.toContain("runStatusLine(");
    expect(status).not.toContain("keepsRunReceipt(");
    expect(status).toContain("useRerenderAt(");
  });
});

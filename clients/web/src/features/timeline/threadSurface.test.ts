import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  new URL("./ThreadPanel.tsx", import.meta.url),
  "utf8"
);
const chatShellSource = readFileSync(
  new URL("../chat/ChatShell.tsx", import.meta.url),
  "utf8"
);
const useTimelineSource = readFileSync(
  new URL("./useTimeline.ts", import.meta.url),
  "utf8"
);
const captureSource = readFileSync(
  new URL("../../../scripts/capture-screens.mjs", import.meta.url),
  "utf8"
);

describe("스레드 표면 계약 (#1753)", () => {
  it("루트와 답글은 선이 아니라 여백으로 분리한다", () => {
    expect(panelSource).not.toContain(
      '<div className="mx-4 my-2 h-px bg-line" />'
    );
    expect(panelSource).toContain('data-testid="thread-replies"');
    // 띠의 값은 이름 붙은 상수다. 이유와 실제 엔진의 측정은 spacing.ts와 threadSurface.browser.test.ts에 있다(#4878):
    // 손으로 `pt-*`를 다시 적으면 그 측정을 건너뛰게 된다.
    expect(panelSource).toContain(
      '<div className={THREAD_REPLIES_LEAD_CLASS} data-testid="thread-replies">'
    );
    expect(panelSource).not.toMatch(/data-testid="thread-replies"[^>]*className="pt-/);
  });

  it("읽음 신호의 응답이 타임라인 상태의 루트로 올라간다 (#4878)", () => {
    // 「새 답글 M」 칩은 **타임라인 상태의 루트**가 그린다(ChatShell의 `thread` 스냅샷이 아니다). 패널은 신호를 보내고
    // 응답을 호스트로 넘길 뿐이라, 호스트가 그것을 상태에 반영하지 않으면 칩은 영영 안 사라진다.
    expect(chatShellSource).toContain("onThreadRead={timeline.applyThreadRead}");
    expect(useTimelineSource).toContain("applyThreadReadState(s, rootId, read)");
    expect(panelSource).toContain("readTarget.current.onThreadRead?.(rootId, state)");
  });

  it("루트 툴바가 판정할 자체 스크롤 경계를 이름 붙인다", () => {
    expect(panelSource).toContain('data-message-scroll-container=""');
  });

  it("캡처 레인이 스레드 루트 hover의 안쪽 배치와 글자 교차를 잰다", () => {
    const guard = captureSource.match(
      /async function assertThreadRootHoverToolbar[\s\S]*?^}/m
    );
    expect(guard).not.toBeNull();
    expect(guard?.[0]).toContain("스레드 루트 호버");
    expect(guard?.[0]).toContain("글자 교차 0");
    expect(captureSource).toContain(
      "await assertThreadRootHoverToolbar(login, scheme)"
    );
  });
});

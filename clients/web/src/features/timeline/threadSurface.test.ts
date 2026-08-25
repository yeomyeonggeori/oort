import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  new URL("./ThreadPanel.tsx", import.meta.url),
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
    expect(panelSource).toContain('className="pt-8"');
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

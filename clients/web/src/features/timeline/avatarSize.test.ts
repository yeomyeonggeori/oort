import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AVATAR_SHAPE,
  AVATAR_SIZE,
} from "@momo/core/features/workspace/avatar";

// =============================================================================
// 코어의 아바타 숫자가 화면의 클래스와 갈라지지 않는가 (진단 H-11)
//
// `spacing.test.ts` 와 같은 다리 검사다. 코어는 32라는 숫자를 갖고 웹은 `size-8`
// 이라는 클래스를 갖는데, 그 둘을 잇는 것은 사람의 기억뿐이다. U4-4R W-1 이
// 실측한 값이 정확히 그 기억이 틀렸을 때의 비용이었다: 클래스는 있었고 CSS 규칙은
// 없었으며, 화면은 0px 이었다.
//
// 그래서 여기서는 **컴파일된 스케일**을 읽는다. `tokens.css` 의 `--spacing-8` 이
// 코어의 32와 같은지, 그리고 행이 실제로 그 단계를 쓰는지.
// =============================================================================

const tokensCss = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const messageRow = readFileSync(
  new URL("./MessageRow.tsx", import.meta.url),
  "utf8"
);
const pendingRow = readFileSync(
  new URL("./PendingRow.tsx", import.meta.url),
  "utf8"
);

function spacingStep(step: string): number {
  const match = tokensCss.match(
    new RegExp(`--spacing-${step}:\\s*(\\d+(?:\\.\\d+)?)px`)
  );
  if (match === null) {
    throw new Error(
      `tokens.css 에 --spacing-${step} 이 없다. 이 레포의 스케일은 고정이라 ` +
        "표에 없는 단계는 클래스 이름만 있고 CSS 규칙이 없다 (U4-4R W-1)"
    );
  }
  return Number(match[1]);
}

describe("아바타 크기 다리", () => {
  it("코어의 AVATAR_SIZE 가 이 레포의 컴파일되는 한 단계다", () => {
    expect(spacingStep("8")).toBe(AVATAR_SIZE);
  });

  it("행과 대기행이 그 단계를 쓴다: 아바타와 거터가 같은 폭이다", () => {
    expect(messageRow).toContain("flex size-8 items-center");
    // 거터가 아바타보다 좁으면 이니셜이 잘리고, 넓으면 본문이 이유 없이 밀린다.
    expect(messageRow).toContain('className="relative w-8 shrink-0"');
    expect(pendingRow).toContain('className="w-8 shrink-0"');
  });

  it("24px 로 되돌아가지 않는다: 그 크기에서는 아바타로 읽히지 않았다", () => {
    expect(AVATAR_SIZE).toBeGreaterThan(spacingStep("6"));
    expect(messageRow).not.toContain("size-6 items-center justify-center");
  });
});

describe("정체는 색 말고 모양으로도 선다", () => {
  it("사람은 원, 에이전트는 둥근 사각", () => {
    expect(AVATAR_SHAPE.human).toBe("round");
    expect(AVATAR_SHAPE.agent).toBe("rounded-square");
    expect(messageRow).toContain('identity.kind === "agent" ? "rounded-sm" : "rounded-full"');
  });

  it("모르는 작성자는 정체 색을 쓰지 않는다", () => {
    // `--agent` 도 `--accent` 도 아닌 중립 배경. 모양은 빌려도 색은 빌리지 않는다.
    expect(messageRow).toContain(
      'identity.kind === "unknown" && "bg-surface-hover text-ink-muted"'
    );
  });
});

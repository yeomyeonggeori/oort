import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #3444: 420폭에서 두 에이전트를 부르면 요약의 실행 위치 조각(`shrink-0`)이 요약 칸 밖으로 밀려
// 「이번만 바꾸기」 위에 겹쳐 그려졌다. 레이아웃은 jsdom 이 재지 못하므로 결함의 원인인 클래스 계약을 고정하고,
// 실제 겹침은 `scripts/capture-ai-mention.mjs` 의 assertRowClean 이 브라우저에서 잰다.
const source = readFileSync(resolve(__dirname, "MentionRoutingBar.tsx"), "utf8");

describe("MentionRoutingBar 접힌 줄의 폭 계약 (#3444)", () => {
  it("요약의 실행 위치 조각은 요약 칸 안에서 줄어든다(칸 밖으로 밀리지 않는다)", () => {
    expect(source).toContain('cn("max-w-full shrink-0 truncate", hideTierWhenNarrow && "max-sm:hidden")');
  });

  it("여럿을 부른 줄의 라벨은 모자라면 줄어들고, 좁은 폭에서는 「이번 메시지」를 접는다", () => {
    expect(source).toContain('className="min-w-0 max-w-pane-sm truncate text-agent"');
    expect(source).toContain("max-sm:hidden");
    // 기본(상속) 요약의 모델·강도 토막은 접지만, 오류·확인 중 말과 오버라이드 값은 접지 않는다.
    expect(source.match(/hideModelEffortWhenNarrow=\{showTier && !override\}/g)).toHaveLength(2);
    expect(source).toContain("hideTierWhenNarrow={override}");
  });
});

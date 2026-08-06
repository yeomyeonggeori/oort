import { describe, expect, it } from "vitest";
import { COMPOSER_OFFLINE_COPY } from "./composerCopy";
import { APPROVAL_OFFLINE_COPY } from "../timeline/approvalNote";

// =============================================================================
// U4-6 리뷰 H-1 — 두 클라가 같은 상황에서 같은 말을 하는가.
//
// 값이 여기 있는 것만으로는 갈라짐이 안 막힌다. 막히는 것은 **클라가 이 값을
// 소비할 때**이고, 그래서 이 파일은 문장의 모양만 지키고 소비는 각 클라의
// 스위트가 소스로 지킨다(웹 `features/chat/composerCopy.test.ts` · 폰
// `__tests__/composerDraftOffline.test.tsx`).
// =============================================================================

describe("컴포저 오프라인 문장", () => {
  it("이 앱의 오프라인 문장 모양을 지킨다 — 지금 못 하는 것 → 다시 연결되면 여기서", () => {
    // 이 모양이 곧 웹 문장을 기각한 근거다: "쓰던 글은 그대로 남습니다."로
    // 끝나면 언제·어디서 다시 보낼 수 있는지가 없다. 같은 상황에서 승인 카드는
    // 그것을 말해 주는데 컴포저만 안 말하면, 두 줄은 같은 앱의 말이 아니다.
    for (const copy of [COMPOSER_OFFLINE_COPY, APPROVAL_OFFLINE_COPY]) {
      expect(copy).toMatch(/^연결이 끊겨 지금은 .+? 수 없습니다\./);
      expect(copy).toMatch(/다시 연결되면 여기서 .+ 수 있습니다\.$/);
    }
  });

  it("초안이 어떻게 되는지까지 말한다 — 컴포저에만 있는 절이다", () => {
    // 승인에는 없는 조각이다. 승인은 내가 쓰던 것이 없고, 컴포저에는 있다.
    expect(COMPOSER_OFFLINE_COPY).toContain("쓰던 글은 그대로");
  });

  it("em-dash 를 쓰지 않는다 — 이 제품의 사용자 문장에서 금지 글자다", () => {
    expect(COMPOSER_OFFLINE_COPY).not.toMatch(/[—–]/);
  });

  // 「색도 자리도 모른다」는 여기서 단정하지 않는다 — 소스를 읽으려면 `node:fs`
  // 와 `import.meta` 가 필요하고, 그 둘은 이 패키지에서 금지다(`purity.mjs`:
  // 코어는 웹과 React Native 양쪽에서 컴파일되어야 한다). 코어가 화면을 모르는
  // 것은 그 게이트 자체가 지키고 있고, 이 파일이 지킬 것은 문장의 모양이다.
});

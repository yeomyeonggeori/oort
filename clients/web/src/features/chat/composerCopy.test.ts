import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPOSER_OFFLINE_COPY } from "./Composer";
import { COMPOSER_OFFLINE_COPY as CORE_COPY } from "@momo/core/features/chat/composerCopy";

// =============================================================================
// U4-6 리뷰 H-1 — 컴포저의 오프라인 문장은 **두 클라가 같은 것**이다.
//
// 리뷰가 실측한 것: 같은 주에 랜딩한 두 배치가 각자 `COMPOSER_OFFLINE_COPY` 라는
// 같은 이름을 짓고 다른 문장을 넣었다. 이 파일이 지키는 것은 「문장이 예쁘다」가
// 아니라 **이 클라가 자기 문장을 다시 갖지 않는다**이다.
//
// 폰 쪽 짝은 `clients/mobile/__tests__/composerDraftOffline.test.tsx` 이고, 값의
// 모양은 `packages/momo-core/src/features/chat/composerCopy.test.ts` 가 잰다.
// =============================================================================

const COMPOSER_SRC = readFileSync(
  fileURLToPath(new URL("./Composer.tsx", import.meta.url)),
  "utf8"
);

/** 주석을 걷어낸 코드. 문장이 **주석에** 인용되는 것은 갈라짐이 아니다. */
const CODE_ONLY = COMPOSER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  ""
);

describe("컴포저 오프라인 문장이 한 벌이다 (H-1)", () => {
  it("이 파일이 내보내는 것이 코어의 값 그대로다", () => {
    expect(COMPOSER_OFFLINE_COPY).toBe(CORE_COPY);
  });

  it("문장을 손으로 적은 자리가 없다 — 이름만 든다", () => {
    expect(CODE_ONLY).not.toContain("연결이 끊겨 지금은 보낼 수 없습니다");
    // 앞 판의 문장. 되돌아오면 여기서 빨강이다.
    expect(CODE_ONLY).not.toContain("쓰던 글은 그대로 남습니다");
    expect(CODE_ONLY).toContain(
      'from "@momo/core/features/chat/composerCopy"'
    );
  });

  it("게이트도 조각을 손으로 적지 않는다 — 코어를 읽는다", () => {
    // 게이트가 문장 조각을 들고 있으면, 문장이 고쳐지는 날 게이트가 그 수리를
    // 막는다. 실제로 이 리뷰에서 그럴 뻔했다.
    const gate = readFileSync(
      fileURLToPath(new URL("../../../gates/gate-composer.mjs", import.meta.url)),
      "utf8"
    );
    expect(gate).toContain("features/chat/composerCopy.ts");
    const gateCode = gate
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(gateCode).not.toContain("쓰던 글은 그대로 남습니다");
  });
});

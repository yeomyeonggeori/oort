import { describe, expect, it } from "vitest";
import {
  COMPOSER_KEYS_HINT,
  COMPOSER_OFFLINE_COPY,
  HINT_SEPARATOR,
  MENTION_AFFORDANCE,
  MESSAGE_EDITOR_KEYS_HINT,
  THREAD_COMPOSER_PLACEHOLDER,
  composerFieldLabel,
  composerPlaceholder,
} from "./composerCopy";
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

// =============================================================================
// #1384 CRUN-3 — 빈 컴포저의 광고와 키보드 힌트의 표기법.
//
// 여기서 재는 것은 낱말의 취향이 아니라 **모양**이다: 광고가 상자를 넘지 않는가,
// 힌트가 한 문법·한 이음쇠로 적혀 있는가, 없는 어포던스를 광고하지 않는가.
// =============================================================================

/**
 * 문자열이 차지할 폭의 어림(px), 글자 크기는 호출자가 준다.
 *
 * 정밀한 자가 아니다 — 정밀한 자는 브라우저에만 있고 코어는 브라우저를 모른다
 * (`purity.mjs`). Chromium 실측과 대조하면 이 어림은 **10% 안쪽으로 크게** 나온다
 * (채택된 문장: 어림 205px · 실측 189.3px). 크게 나오는 쪽이라 이 자는 안전한
 * 방향으로 틀린다: 여기서 초록이면 화면에서도 들어간다.
 *
 * 지키는 것은 「이 문장이 정확히 몇 px인가」가 아니라 **「누군가 이 광고를 한
 * 마디 더 늘리면 상자를 넘는다」**이다.
 */
function estimateWidthPx(text: string, fontPx: number): number {
  let em = 0;
  for (const char of text) {
    if (char === " ") em += 0.28;
    else if (char.charCodeAt(0) < 128) em += 0.55;
    else em += 1;
  }
  return em * fontPx;
}

/**
 * 이 문장이 들어가야 하는 상자 둘. **한 문장을 두 클라가 함께 쓰므로 예산도
 * 둘이다** — 웹에만 맞추면 폰에서 잘린다(#1384 리뷰 M-2).
 *
 * 각 뺄셈은 `composerCopy.ts` 의 머리말에 산술 그대로 적혀 있다. 폰이 더 넓은데
 * 더 빡빡한 이유는 글자가 두 단 크기 때문이다: 폰 본문 16pt 는 iOS 입력창이
 * 줌을 멈추는 크기이고(`clients/mobile/src/design/tokens.ts`) 웹 본문은 14px 다.
 */
const BUDGETS = [
  { surface: "웹", fontPx: 14, boxPx: 236 },
  { surface: "폰", fontPx: 16, boxPx: 260 },
] as const;

describe("빈 컴포저의 광고 (#1384)", () => {
  it("어디로 가는지와 @가 무엇인지를 함께 말한다", () => {
    const placeholder = composerPlaceholder("일반", "place");
    // 앞절 — 오배송을 막는 자리. 방 이름이 그대로 들어온다.
    expect(placeholder.startsWith("일반에 ")).toBe(true);
    // 뒷절 — 이 앱의 발주 동사. 이것이 없던 것이 이 티켓의 진단이다.
    expect(placeholder).toContain(MENTION_AFFORDANCE);
    expect(MENTION_AFFORDANCE.startsWith("@")).toBe(true);
  });

  it("사람에게 보내는 방에서는 에가 아니라 에게다", () => {
    // DM 의 label 은 방 이름이 아니라 상대의 displayName 이다
    // (`workspace/directory.ts`). 앞 판은 그것을 모른 채 「에」를 붙였다.
    expect(composerPlaceholder("hermes", "person")).toBe(
      `hermes에게 메시지 보내기, ${MENTION_AFFORDANCE}`
    );
    expect(composerFieldLabel("hermes", "person")).toBe("hermes에게 보낼 메시지");
    // 라틴 이름이든 한글 이름이든 같다 — 이 조사는 받침이 아니라 **누가 받는가**로
    // 갈리고, 그래서 `lib/koreanParticle` 의 다른 짝들과 달리 낱말이 못 정한다.
    expect(composerPlaceholder("김인턴", "person")).toContain("김인턴에게 ");
    // 로스터가 아직 안 온 DM 은 label 이 사람 이름이 아니다. 그때는 에가 맞다.
    expect(composerPlaceholder("다이렉트 메시지", "place")).toContain(
      "다이렉트 메시지에 "
    );
  });

  it("두 클라의 상자를 **둘 다** 넘지 않는다 — 한 문장이 두 화면에 선다", () => {
    // textarea 는 rows=1 이고 빈 값의 scrollHeight 는 플레이스홀더를 세지 않는다.
    // 즉 넘친 둘째 줄은 접히는 것이 아니라 **잘린다**(디자인 시스템 §5.3 7위:
    // 의존형태소 절단, 기계가 안 잡는 축). 폰의 multiline TextInput 도 같다.
    for (const { surface, fontPx, boxPx } of BUDGETS) {
      const adopted = composerPlaceholder("일반", "place");
      expect(
        estimateWidthPx(adopted, fontPx),
        `${surface}: 채택된 문장이 상자를 넘는다`
      ).toBeLessThan(boxPx);
      // 그리고 이것이 왜 「@로 에이전트 부르기」가 아닌지의 근거다: 목적어를
      // 실으면 **두 화면 다** 넘친다(실측 웹 241.5 · 폰 275.0). 이 줄이 붉어지면
      // 그때는 광고를 힌트 줄로 옮기는 결정이지, 플레이스홀더를 늘리는 결정이
      // 아니다.
      expect(
        estimateWidthPx("일반에 메시지 보내기, @로 에이전트 부르기", fontPx),
        `${surface}: 목적어를 실은 안이 이제 들어간다면 그 결정을 다시 해야 한다`
      ).toBeGreaterThan(boxPx);
    }
  });

  it("필드 이름은 사용법을 읽어 주지 않는다", () => {
    const label = composerFieldLabel("일반", "place");
    expect(label).toBe("일반에 보낼 메시지");
    // 이름은 「이 상자가 무엇인가」다. 여기에 @ 광고까지 넣으면 화면을 보지 않는
    // 사람에게 필드 이름이 문장 둘로 읽힌다.
    expect(label).not.toContain("@");
  });

  it("스레드 문장은 두 클라가 **함께** 하는 일만 말한다", () => {
    // 앞 판의 이 자리는 「스레드에는 멘션이 없다(두 클라 모두)」라고 적고 있었고
    // 그것은 거짓이었다(#1384 리뷰 H-1): 폰 `conversation/ThreadPanel.tsx` 는
    // 채널 컴포저를 그대로 세우고 `directory` 를 넘기므로 폰 스레드에서 @ 는
    // 목록을 연다. 웹 `timeline/ThreadComposer.tsx` 에는 그 길이 없다.
    //
    // 그 비대칭은 동작이라 이 티켓이 고치지 않는다(패리티 goal 의 자리). 대신
    // 공유 문장은 **웹도 하는 일**까지만 광고한다 — 절반의 화면에서 거짓이 되는
    // 문장을 두 클라가 함께 렌더할 수는 없다.
    expect(THREAD_COMPOSER_PLACEHOLDER).not.toContain("@");
  });

  it("em-dash 를 쓰지 않는다", () => {
    for (const copy of [
      composerPlaceholder("일반", "place"),
      composerPlaceholder("hermes", "person"),
      composerFieldLabel("일반", "place"),
      THREAD_COMPOSER_PLACEHOLDER,
      MENTION_AFFORDANCE,
    ]) {
      expect(copy).not.toMatch(/[—–]/);
    }
  });
});

describe("키보드 힌트의 표기법 한 벌 (#1384)", () => {
  const LINES = [COMPOSER_KEYS_HINT, MESSAGE_EDITOR_KEYS_HINT];

  /** 키에 새겨진 대로 적는다. 새 단축키는 이 티켓이 만들지 않는다. */
  const KEYS = ["Enter", "Shift+Enter", "Esc"];

  it("이음쇠는 하나다 — 가운뎃점이고 쉼표가 아니다", () => {
    expect(HINT_SEPARATOR).toBe(" · ");
    for (const line of LINES) {
      // 앞 판의 컴포저 힌트는 쉼표로 이어져 있었고 수정 힌트는 가운뎃점이었다.
      // 같은 종류의 정보에 두 이음쇠를 쓰는 것이 이 티켓이 닫은 것이다.
      expect(line).not.toContain(",");
      expect(line.split(HINT_SEPARATOR).length).toBeGreaterThan(1);
    }
  });

  it("문법은 하나다 — <키>로 <동사>", () => {
    for (const line of LINES) {
      for (const piece of line.split(HINT_SEPARATOR)) {
        // 앞 판의 수정 힌트는 「Enter 저장」이었다: 조사가 없으면 키와 동사가
        // 나란히 선 두 낱말이라, 읽는 사람이 둘의 관계를 스스로 지어야 한다.
        const match = /^(\S+)로 (\S.*)$/.exec(piece);
        expect(match, `${piece} 가 <키>로 <동사> 모양이 아니다`).not.toBeNull();
        expect(KEYS).toContain(match?.[1]);
      }
    }
  });

  it("컴포저와 수정 입력창이 같은 키를 같은 말로 부른다", () => {
    // 줄바꿈은 두 상자에서 같은 키이고 같은 일을 한다. 한쪽만 다른 말로 적히면
    // 손가락이 옮겨 앉을 때마다 읽어야 한다.
    expect(COMPOSER_KEYS_HINT).toContain("Shift+Enter로 줄바꿈");
    expect(MESSAGE_EDITOR_KEYS_HINT).toContain("Shift+Enter로 줄바꿈");
    // Esc 는 수정 입력창에만 있다: 컴포저의 Esc 는 멘션 목록과 인용을 닫는 키라
    // 「취소」가 아니다(`composerKeys.ts`).
    expect(COMPOSER_KEYS_HINT).not.toContain("Esc");
    expect(MESSAGE_EDITOR_KEYS_HINT).toContain("Esc로 취소");
  });

  it("em-dash 를 쓰지 않는다", () => {
    for (const line of LINES) expect(line).not.toMatch(/[—–]/);
  });
});

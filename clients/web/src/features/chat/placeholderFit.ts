import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import {
  composerPlaceholderClauses,
  fitComposerPlaceholder,
} from "@momo/core/features/chat/composerCopy";
import type { RecipientKind } from "@momo/core/lib/koreanParticle";

// =============================================================================
// 이 클라의 **자** (#1422).
//
// 규칙은 코어에 있다: 플레이스홀더가 상자를 넘으면 절을 통째로 버리고 절 안에서는
// 자르지 않는다(`@momo/core/features/chat/composerCopy` 의
// `fitComposerPlaceholder`). 코어가 못 갖는 것은 자다 — 브라우저도 폰도 모르는
// 패키지라 "이 문자열이 이 상자에 드는가"에 답할 수 없다. 그래서 그 답만 여기서
// 만들고, 무엇을 버릴지는 계속 코어가 정한다.
//
// ## 왜 CSS 로 못 하나
//
// `::placeholder` 는 문자열 하나다. #1418 이 그 위에 `max-block-size: 1lh` 를
// 걸어 둘째 줄의 **반노출**을 닫았지만, 접힘 자체는 줄상자가 정하므로 잘리는
// 자리가 절 한가운데였다("release-2026-08에 메시지 보내기, @로"). 절을 CSS 의
// 단위로 만들려면 절마다 요소가 있어야 하고, 그러려면 네이티브 플레이스홀더를
// 오버레이로 갈아야 한다 — 접근성 이름과 두 클라의 대칭을 그 대가로 낸다.
// 문자열을 고르는 쪽이 싸고, 고르려면 재야 한다.
//
// ## 무엇으로 재나 — 게이트가 쓰는 그 자
//
// `gate-work-panel.mjs` 는 이미 같은 질문에 답하고 있었다: textarea 의 계산된
// 글자꼴을 복사한 프로브에 문장을 넣고 재는 것. 여기도 같은 프로브다(속성 목록도
// 그 게이트와 같다). canvas `measureText` 를 안 쓰는 이유는 `letter-spacing`·
// `text-transform` 같은 축이 canvas 의 font 축약형에 안 실려서, 토큰이 자간을
// 건드리는 날 자와 화면이 조용히 갈라지기 때문이다.
//
// 프로브의 **옷**은 이 파일이 안 짓는다. 자리·가시성·줄바꿈은 지어낸 값이고,
// 지어낸 값이 컴포넌트 안에 있으면 방언 §1 이 금지하는 인라인 스타일이다 —
// `tokens.css` 의 `text-probe` 가 그 다섯을 들고, 여기 남는 것은 계산된 글자꼴의
// 사본뿐이다(그건 스타일시트가 미리 알 수 없다).
//
// 다시 재는 계기는 `ResizeObserver` 다. 상자는 창 크기만으로 정해지지 않는다 —
// 스레드 패널과 작업 세션 pane 이 채팅 열과 같은 행을 나눠 갖고(#1413·#1418·
// #1421), 그 둘은 창을 건드리지 않고 열린다. 폭이 바뀌는 사건을 열거하는 대신
// 폭 자체를 관찰한다.
//
// 그 대가는 **한 프레임**이다. 폭을 바꾸는 것은 이 컴포넌트의 렌더가 아니라
// 형제(pane)의 렌더라, 관찰자의 콜백은 레이아웃 뒤에 오고 React 의 커밋은 그
// 다음이다 — pane 이 열리는 그 프레임에는 아직 옛 문장이 서 있다. 빈 상자의
// 안내 문구 한 프레임이고, 이것을 없애려면 형제의 레이아웃을 이 컴포넌트가 미리
// 알아야 하므로(=폭 규칙의 사본을 여기 두므로) 사지 않는다. 게이트도 이 사실을
// 알고 기다린다(`gate-work-panel.mjs` 의 `settlePlaceholder`).
//
// **이 계기가 안 잡는 축 하나** (#1422 수리 회전 M1, 실측). 폭이 아니라 **글자**가
// 커지는 사건(루트 `font-size` · 브라우저 기본 글자 크기)에는 이 관찰자가 안
// 깬다: 이 상자의 높이는 `useAutoGrow` 가 인라인 px 로 못 박고 그 훅은 `value` 가
// 바뀔 때만 다시 도므로, 글자가 커져도 상자의 두 변이 **하나도** 안 움직인다
// (게이트 실측: 높이 39px 불변, 30초 대기 타임아웃). 그래서 아래 recompute 가
// 닫은 것은 「자가 늙는 것」이지 「계기가 없는 것」이 아니다 — 늙지 않은 자의
// 답이 화면에 나오는 순간은 글자가 커진 **뒤에 폭이 움직일 때**다(창 크기 변경 ·
// pane 개폐). 계기 자체를 늘리는 것은 관찰 대상에 글자 축을 더하는 결정이라
// 여기서 하지 않는다. 그 순서 전체를 게이트의 `probe-ruler` 레인이 잰다.
//
// ## 이 훅이 **안** 하는 것
//
// 사람이 친 글은 건드리지 않는다. 그쪽은 상자가 자라서 받는다(`useAutoGrow`).
// 여기서 재는 문자열은 언제나 코어가 만든 절들이고, 이 파일은 절을 짓지도
// 이어 붙이지도 않는다 — 이음쇠까지 코어의 값이라 `fitComposerPlaceholder` 에
// "다 든다"고 답해 주는 것이 문장 전체를 얻는 방법이다.
// =============================================================================

/**
 * 프로브가 textarea 와 같은 글자를 그리게 하는 속성들.
 *
 * `gate-work-panel.mjs` 의 목록과 같다. 폭에 영향을 주면서 상속으로 따라오지
 * 않는 것만 있고, `fontStyle` 이 끼어 있는 이유는 한글에서 0픽셀인 그 축이
 * 라틴 방 이름에서는 폭을 바꾸기 때문이다.
 */
const PROBE_PROPERTIES = [
  "fontFamily",
  "fontSize",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "letterSpacing",
  "textTransform",
  "wordSpacing",
] as const;

function pxOf(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 이 상자에 드는 만큼만 남긴 플레이스홀더.
 *
 * 재기 전(첫 렌더·`ResizeObserver` 가 없는 환경)에는 문장 전체를 낸다. 그것이
 * 안전한 방향인 이유는 마지막 방어선이 이미 서 있어서다: 넘치면 웹은
 * `composer-placeholder` 의 `1lh` 클램프가 반노출 없이 한 줄로 묶는다. 반대로
 * 「일단 짧게」로 시작하면 드는 폭에서도 광고가 한 프레임 사라졌다 돌아온다.
 */
export function useFittedComposerPlaceholder(
  ref: RefObject<HTMLTextAreaElement | null>,
  channelLabel: string,
  recipient: RecipientKind
): string {
  const clauses = useMemo(
    () => composerPlaceholderClauses(channelLabel, recipient),
    [channelLabel, recipient]
  );
  // 절을 다 실은 문장. 이음쇠를 손으로 적지 않으려고 코어의 규칙에 "다 든다"고
  // 답한다 — 이 파일이 `", "` 를 들면 그것이 두 번째 사본이다.
  const full = useMemo(() => fitComposerPlaceholder(clauses, () => true), [clauses]);

  // 잰 값은 **무엇을 재서 나왔는지**와 함께 든다. 방을 옮긴 직후의 한 프레임에
  // 옛 방의 문장이 서지 않게 하는 것이 `key` 의 일이다.
  const [measured, setMeasured] = useState<{ key: string; value: string } | null>(
    null
  );

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === "undefined") return;

    const probe = document.createElement("span");
    // 자리·가시성·줄바꿈은 **지어낸 값**이라 스타일시트가 든다(`text-probe`,
    // 방언 §1). 여기 남는 것은 지어낼 수 없는 것뿐이다 — 계산된 글자꼴의 사본.
    probe.className = "text-probe";
    document.body.appendChild(probe);

    const recompute = () => {
      // `clientWidth` 는 테두리와 스크롤바를 뺀 값이라 패딩만 더 빼면 글이 놓이는
      // 폭이다. 지금 계산된 패딩을 매번 다시 읽는 이유: 아이콘 버튼이 600px 아래
      // 에서 `tap-target` 으로 자라듯 이 상자의 패딩도 티어를 탄다.
      const current = window.getComputedStyle(node);
      // 글자꼴도 **매번** 다시 옮긴다. 앞 판은 이 복사를 효과 몸통에서 한 번만
      // 했고, 그러면 자는 `[ref, clauses, full]` 이 바뀔 때만 갱신된다 — 그런데
      // 자를 움직이는 축은 그 셋에 없다: 루트 `font-size`(rem) · 브라우저 기본
      // 글자 크기 · 글꼴 폴백이 늦게 풀리는 것 · 테마가 바꾸는 자간.
      //
      // 그 축이 움직인 **뒤에** 폭이 움직이면(창 크기 변경 · pane 개폐) 이 함수는
      // 새 상자에 옛 글자의 답을 낸다. 틀리는 방향이 하필 낙관이다: 작아진 옛
      // 글자로 "든다"고 답해, 버려야 할 절을 상자에 남긴다 — #1422 가 지운 바로
      // 그 렌더다. 게이트가 그 순서를 실측한다(`probe-ruler` 레인: 1280 에서
      // 글자를 키우고 980 으로 좁히면, 옛 판은 광고를 290px 상자에 339px 로
      // 남겨 둔다). 아홉 번의 속성 쓰기라 비용은 실측 잡음 안이다.
      for (const property of PROBE_PROPERTIES) probe.style[property] = current[property];
      const available =
        node.clientWidth - pxOf(current.paddingLeft) - pxOf(current.paddingRight);
      const value = fitComposerPlaceholder(clauses, (candidate) => {
        probe.textContent = candidate;
        return probe.getBoundingClientRect().width <= available;
      });
      // 같은 답이면 상태를 건드리지 않는다. `ResizeObserver` 는 폭이 아니라
      // **상자**의 변화에 반응하므로(높이만 바뀌는 `useAutoGrow` 도 그 하나다)
      // 답이 같은 호출이 흔하고, 그때마다 새 객체를 넣으면 렌더가 딸려 온다.
      setMeasured((previous) =>
        previous !== null && previous.key === full && previous.value === value
          ? previous
          : { key: full, value }
      );
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(node);
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, [ref, clauses, full]);

  return measured !== null && measured.key === full ? measured.value : full;
}

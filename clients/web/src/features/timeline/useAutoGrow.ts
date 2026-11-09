import { useLayoutEffect, useRef, type RefObject } from "react";

// =============================================================================
// 쓰는 만큼 자라는 입력창 (B11 R2 M4).
//
// 1라운드의 수정 입력창은 `rows={2}` 고정, 스레드 컴포저는 `rows={1}` 고정이라
// 세 줄짜리 한국어 메시지를 고치는 일이 두 줄 창구를 스크롤하는 일이 됐다.
// 메인 컴포저는 이미 자란다(Composer.tsx).
//
// 다만 메인 컴포저처럼 `\n`을 세지는 않는다. 줄바꿈을 세는 방식은 **접힌 줄**을
// 못 본다 — 한국어 메시지는 줄바꿈 없이 한 문단으로 오고 창 폭에서 세 줄로
// 접히는 쪽이 흔하다. 그래서 여기서는 실제로 차지한 높이(`scrollHeight`)를
// 재고, 최소·최대 줄수 사이로 자른다. 최대를 넘으면 그때부터 스크롤한다.
//
// ## 재는 것은 거울이다. 살아 있는 입력창은 접지 않는다 (#5567)
//
// 앞 판은 키마다 살아 있는 입력창을 `height: auto`로 접었다가 `scrollHeight`를 읽고(강제 레이아웃) 높이를 되돌렸다.
// 줄었다가 돌아오는 일이 한 작업 안이라 화면에는 안 보이지만, **그 강제 레이아웃은 진짜 레이아웃**이다: 두세 줄
// 초안에서 입력창이 한 줄로 접힌 순간 대화 목록의 스크롤러가 그만큼 커지고, WebKit(데스크탑 앱의 WKWebView)은 그
// 자리에서 목록의 `scrollTop`을 커진 창의 끝으로 깎는다. 높이를 되돌려도 깎인 값은 돌아오지 않는다. 그래서 키마다
// 목록이 (줄 수 − 1) × 한 줄(24.4px)만큼 입력창 뒤로 내려앉았다가, 줄이 늘 때 바닥 붙이기(Timeline.tsx DS2-6)가 다시
// 끌어올렸다 — owner 11-09 데스크탑 DM 「타이핑 중 화면 떨림」 보고. Chromium은 같은 조작에서 scrollTop이 변하지 않아(실측)
// 브라우저에서는 안 보였다. 실측(gates/gate-typing-jitter.mjs, 1280×800, 3줄 초안, 바닥 gap 0): WebKit은 접고-읽고-되돌린
// 같은 작업 안에서 `scrollTop` 2887→2838, 두 프레임 뒤에도 gap 50. Chromium 2645→2645.
//
// 그래서 높이를 **거울**에서 잰다: 같은 부모 안의 보이지 않는 textarea(같은 클래스·같은 폭·같은 글)다. 거울은
// 절대 위치·높이 0이라 아무 상자의 크기도 바꾸지 않고, 살아 있는 입력창의 높이는 마지막 값으로 한 번만 쓰인다.
// 같은 부모에 두는 이유는 글꼴·변수·컨테이너 질의를 입력창과 똑같이 물려받게 하기 위해서다.
// =============================================================================

/** owner 10-30 #4790: 데스크탑 일반·스레드 입력창의 공통 상한. */
export const COMPOSER_MAX_ROWS = 5;

/** 거울 표지. 시험·캡처가 「사람이 쓰는 입력창」을 셀 때 이것을 뺀다. */
export const AUTO_GROW_MIRROR_ATTR = "data-autogrow-mirror";

export interface AutoGrowOptions {
  minRows: number;
  maxRows: number;
}

function pxOf(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 재기 전용 거울. 화면·보조기술·초점·포인터 어디에도 서지 않는다.
 *
 * 높이 0 + `overflow: hidden`이어도 textarea의 `scrollHeight`는 내용 높이(패딩 포함)를 답한다. 높이를 `auto`로
 * 두지 않는 이유는 거울의 정적 자리(부모의 끝)에서 내용만큼 솟은 상자가 조상의 스크롤 범위를 넓히지 않게 하기 위해서다.
 * 폰 폭의 `tap-target` 최소 높이(44)는 클래스가 같으므로 거울에도 그대로 걸리고, 그래서 앞 판(접어서 재기)과 같은
 * 값을 읽는다.
 */
function createMirror(node: HTMLTextAreaElement): HTMLTextAreaElement {
  const mirror = node.ownerDocument.createElement(node.tagName) as HTMLTextAreaElement;
  mirror.setAttribute(AUTO_GROW_MIRROR_ATTR, "");
  mirror.tabIndex = -1;
  mirror.readOnly = true;
  mirror.inert = true;
  return mirror;
}

/** 거울의 자리: 흐름 밖·안 보임·누를 수 없음·높이 0. 폭은 재기마다 입력창에서 붙인다. `visibility: hidden`이 보조기술에서도 뺀다. */
const MIRROR_CSS = "position:absolute;visibility:hidden;pointer-events:none;height:0;overflow:hidden;";

/**
 * `value`가 바뀔 때마다 textarea의 높이를 내용에 맞춘다.
 *
 * `useLayoutEffect`인 것은 의도다: 페인트 뒤에 높이를 고치면 새 줄이 생기는
 * 순간마다 입력창이 한 프레임 깜빡인다.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { minRows, maxRows }: AutoGrowOptions
): void {
  const mirrorRef = useRef<HTMLTextAreaElement | null>(null);

  // 거울은 이 훅이 만든 것이라 이 훅이 걷는다. 입력창이 사라지면(스레드를 닫거나 수정을 마침) 함께 사라진다.
  useLayoutEffect(
    () => () => {
      mirrorRef.current?.remove();
      mirrorRef.current = null;
    },
    []
  );

  useLayoutEffect(() => {
    const node = ref.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const mirror = mirrorRef.current ?? createMirror(node);
    mirrorRef.current = mirror;
    if (mirror.parentElement !== parent) parent.appendChild(mirror);

    const styles = window.getComputedStyle(node);
    // `line-height: normal`은 숫자로 답하지 않는다. 그때는 글자 크기의 1.5배로
    // 친다 — 이 앱의 본문 행간과 같은 값이다.
    const fontSize = pxOf(styles.fontSize, 16);
    const line = pxOf(styles.lineHeight, fontSize * 1.5);
    const border = pxOf(styles.borderTopWidth, 0) + pxOf(styles.borderBottomWidth, 0);
    const frame = pxOf(styles.paddingTop, 0) + pxOf(styles.paddingBottom, 0) + border;

    // 거울을 입력창과 같은 상자로 맞춘다: 같은 클래스(글꼴·행간·패딩·줄바꿈 규칙), 같은 바깥 폭, 같은 글.
    // 폭은 살아 있는 입력창에서 읽는다 — 그 읽기도 레이아웃을 부르지만, 이때 입력창은 마지막으로 그려진 높이 그대로라
    // 다른 상자의 크기가 바뀌지 않는다.
    mirror.className = node.className;
    mirror.style.cssText = `${MIRROR_CSS}width:${node.getBoundingClientRect().width}px;`;
    mirror.value = node.value;

    const min = line * minRows + frame;
    const max = line * maxRows + frame;
    // scrollHeight는 패딩을 포함하고 테두리는 제외한다. border-box 높이와
    // 비교할 때 테두리를 더해야 마지막 줄이 테두리 두께만큼 잘리지 않는다.
    const wanted = mirror.scrollHeight + border;
    node.style.height = `${Math.round(Math.min(max, Math.max(min, wanted)))}px`;
    node.style.overflowY = wanted > max ? "auto" : "hidden";
  }, [ref, value, minRows, maxRows]);
}

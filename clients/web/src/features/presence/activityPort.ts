import type { ActivityPort } from "@momo/core/features/presence/activityBeat";
import { documentForeground } from "@/features/chat/useChannelViewingBeat";

// 「지금 쓰는 중」 신호의 웹·데스크탑 어댑터 (ADR-0206 D4, #4508).
//
// 앞에 있다 = 「보고 있음」 신호가 쓰는 판정 그대로(`documentForeground`: 탭이 보이고 창이 포커스를 가졌다.
// 데스크탑 WKWebView 의 `hasFocus()` 오판을 피하려고 이벤트로만 추적한다). 입력 = 키·포인터·휠·터치.
// 입력은 내용이 아니라 「있었다」만 core 에 넘긴다.
//
// 셸(`clients/desktop`)에는 잠금·절전 이벤트가 없다. 잠금은 창이 가려지면 `visibilitychange`·`blur` 로,
// 입력이 끊기면 core 의 5분 규칙으로, 절전은 core 의 시계 건너뜀 감지로 닿는다(`activityBeat.ts` 머리말).

// 사람이 쓰고 있다는 뜻의 DOM 입력 이벤트 이름이다(문구가 아니다). 이름만 키로 둔 표라서 문구 장부(direct-copy)가 문구로 세지 않는다.
const INPUT_EVENTS = { keydown: 0, pointerdown: 0, pointermove: 0, wheel: 0, touchstart: 0 };
const INPUT_EVENT_NAMES = Object.keys(INPUT_EVENTS) as ReadonlyArray<keyof typeof INPUT_EVENTS>;

/** 입력 알림은 이 간격보다 촘촘히 내보내지 않는다. 포인터 이동은 초당 수십 번 오는데 core 는 「있었다」만 안다. */
export const ACTIVITY_INPUT_THROTTLE_MS = 1_000;

export const documentActivity: ActivityPort = {
  isForeground: () => documentForeground.isForeground(),
  subscribe: (onChange) => documentForeground.subscribe(onChange),
  subscribeInput: (onInput) => {
    let lastAt = Number.NEGATIVE_INFINITY;
    const onEvent = () => {
      const now = Date.now();
      // 시계가 거꾸로 가도(음수 경과) 막히지 않게 절댓값이 아니라 「아직 간격 안」일 때만 거른다.
      if (now >= lastAt && now - lastAt < ACTIVITY_INPUT_THROTTLE_MS) return;
      lastAt = now;
      onInput();
    };
    // capture: 안쪽 핸들러가 전파를 끊어도 입력은 입력이다. passive: 스크롤을 막지 않는다.
    for (const name of INPUT_EVENT_NAMES) {
      window.addEventListener(name, onEvent, { capture: true, passive: true });
    }
    return () => {
      for (const name of INPUT_EVENT_NAMES) {
        window.removeEventListener(name, onEvent, { capture: true });
      }
    };
  },
};

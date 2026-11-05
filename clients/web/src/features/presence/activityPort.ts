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
// 값은 「자리가 바뀌어야 입력으로 센다」: 브라우저는 스크롤·레이아웃이 바뀌면 멈춰 있는 포인터 자리에 가짜 이동을 쏜다(스트리밍 답이
// 목록을 밀 때 등). 사람이 없는 창을 쓰는 중으로 읽지 않으려고 포인터 이동은 좌표가 바뀐 것만 센다. 나머지는 모두 사람의 손이다.
const INPUT_EVENTS = {
  keydown: false,
  pointerdown: false,
  pointermove: true,
  wheel: false,
  touchstart: false,
};
type InputEventName = keyof typeof INPUT_EVENTS;
const INPUT_EVENT_NAMES = Object.keys(INPUT_EVENTS) as ReadonlyArray<InputEventName>;

/** 입력 알림은 이 간격보다 촘촘히 내보내지 않는다. 포인터 이동은 초당 수십 번 오는데 core 는 「있었다」만 안다. */
export const ACTIVITY_INPUT_THROTTLE_MS = 1_000;

export const documentActivity: ActivityPort = {
  isForeground: () => documentForeground.isForeground(),
  subscribe: (onChange) => documentForeground.subscribe(onChange),
  subscribeInput: (onInput) => {
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastX = Number.NaN;
    let lastY = Number.NaN;
    /** 이 포인터 이벤트가 지난번과 다른 자리인가. 좌표를 못 읽으면(마우스 이벤트가 아니면) 판단할 수 없으니 입력으로 센다. */
    const movedSinceLast = (event: Event): boolean => {
      const { screenX, screenY } = event as Partial<MouseEvent>;
      if (screenX === undefined || screenY === undefined) return true;
      const moved = screenX !== lastX || screenY !== lastY;
      lastX = screenX;
      lastY = screenY;
      return moved;
    };
    const onEvent = (event: Event) => {
      if (INPUT_EVENTS[event.type as InputEventName] && !movedSinceLast(event)) return;
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

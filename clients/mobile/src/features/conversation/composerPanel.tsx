import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {Keyboard, LayoutAnimation, type EmitterSubscription} from 'react-native';
import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {WORD} from '../../lib/techWords';

// =============================================================================
// 키보드 자리의 창 (#5452, owner 2026-11-07 「별도 바텀시트 대신 키보드 영역을 활용」).
//
// ☺ 를 누르면 키보드가 내려가고 **그 자리 그 높이**에 이모티콘 창이 선다(카카오톡처럼). 이 파일은 그 상태(`closed` · `open` · `handoff`)와 창이 설 내용을 쥐는 자리이고,
// 레이아웃 산수는 `ConversationLayout` 이 진다(패널의 바닥·목록·도크가 한 열이라서).
//
// ## 왜 이 구조인가 - 키보드가 오가는 동안 입력창이 1pt 도 안 움직이려면
//
// 입력창을 올리는 것은 네이티브 `KeyboardPane` 이다. 키보드가 있으면 `키보드 높이 - bottomInset` 만큼 **네이티브가 변환(transform)** 으로 올리고, 키보드가 내려가면 같은
// 만큼 내려 보낸다(JS 가 끼지 않는다). 창이 JS 레이아웃으로 그 자리를 채우려고 하면 두 움직임이 서로 다른 시계라 한 프레임이라도 어긋난다. 그래서 둘을 **한 커밋**에 맞바꾼다:
//
//   · 열 때(키보드 → 창): 한 렌더에서 ① `bottomInset` 을 창 높이로 올려 네이티브 리프트를 0 으로 눕히고(prop 이 바뀌면 네이티브는 **애니메이션 없이** 곧바로 적용한다)
//     ② 같은 만큼의 빈 칸을 도크 밑에 깔아 도크를 레이아웃으로 올린다. 도크의 자리는 변환 → 레이아웃으로 바뀌었을 뿐 같다. 그다음에 키보드를 내린다 - 네이티브는
//     `bottomInset` 이 커서 리프트가 0 인 채라 아무 데도 안 움직이고, 창은 키보드가 비켜 주는 대로 드러난다.
//   · 닫을 때(창 → 키보드): 키보드가 올라오는 동안 창은 그대로 두고(리프트 0 유지) 키보드가 **다 올라온 뒤**(`keyboardDidShow`) 한 렌더에서 반대로 맞바꾼다.
//
// 이 파일의 `handoff` 가 뒤쪽이다. 끝내 키보드가 오지 않는 기기(하드웨어 키보드)는 상한 시간 뒤에 창만 거둔다.
// =============================================================================

export type PanelPhase = 'closed' | 'open' | 'handoff';

export interface ComposerPanelApi {
  phase: PanelPhase;
  /** ☺: 창을 키보드 자리에 세운다. `height` 는 그 자리의 높이(보통 키보드 높이). */
  open: (height: number) => void;
  /** 키보드가 돌아온다(입력창을 눌렀다/키보드 단추): 키보드가 창을 덮은 뒤에 창이 걷힌다. */
  handoff: () => void;
  /** 키보드 없이 창만 거둔다(목록을 눌렀다). */
  close: () => void;
  /** 창 안에 그릴 것. 창이 닫혀 있으면 아무것도 그리지 않는다. */
  setContent: (node: React.ReactNode) => void;
}

export const ComposerPanelContext = createContext<ComposerPanelApi | null>(null);

/** 입력창이 창을 쥐는 자리. 대화 레이아웃 밖(시험·하네스 일부)에서는 null 이다. */
export function useComposerPanel(): ComposerPanelApi | null {
  return useContext(ComposerPanelContext);
}

/** 키보드가 안 오는 기기(하드웨어 키보드)에서 창을 붙들고 있지 않는 상한(ms). iOS 키보드는 0.25초 안에 온다. */
export const HANDOFF_MAX_MS = 900;

/** 키보드 없이 창이 서고 걷힐 때의 움직임: 키보드와 같은 곡선으로 입력창·목록·창이 한꺼번에 미끄러진다. */
const SLIDE = {
  duration: 250,
  create: {type: LayoutAnimation.Types.keyboard, property: LayoutAnimation.Properties.opacity},
  update: {type: LayoutAnimation.Types.keyboard},
  delete: {type: LayoutAnimation.Types.keyboard, property: LayoutAnimation.Properties.opacity},
} as const;

export interface PanelState {
  phase: PanelPhase;
  /** 창이 서는 자리의 높이(pt). 닫혀 있으면 0. */
  height: number;
}

const CLOSED: PanelState = {phase: WORD.closed, height: 0};

/**
 * 창의 상태. `ConversationLayout` 이 한 번 부르고, 값(`state`·`content`)으로 레이아웃을 짜고 `api` 를 컨텍스트로 내린다.
 * 키보드 이벤트를 **창이 handoff 중일 때만** 듣는다 - 쉬는 레이아웃은 키보드 이벤트에서 아무 일도 하지 않는다(`conversationLayout.test`).
 */
export function useComposerPanelState(): {
  state: PanelState;
  content: React.ReactNode;
  api: ComposerPanelApi;
} {
  const [state, setState] = useState<PanelState>(CLOSED);
  const [content, setContent] = useState<React.ReactNode>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const reduceMotion = useReduceMotionRef();
  const subscription = useRef<EmitterSubscription | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopWaiting = useCallback(() => {
    subscription.current?.remove();
    subscription.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stopWaiting, [stopWaiting]);

  const leave = useCallback(
    (animated: boolean) => {
      stopWaiting();
      if (stateRef.current.phase === WORD.closed) return;
      // 키보드가 창을 덮은 채라면 움직일 것이 없다(맞바꿈은 한 커밋). 키보드가 없을 때만 미끄러진다.
      if (animated && !reduceMotion.current) LayoutAnimation.configureNext(SLIDE);
      setState(CLOSED);
      setContent(null);
    },
    [reduceMotion, stopWaiting],
  );

  const open = useCallback(
    (height: number) => {
      stopWaiting();
      if (stateRef.current.phase === WORD.open) return;
      // 키보드가 올라와 있으면 맞바꿈(움직이지 않는다), 아니면 창이 미끄러져 올라온다.
      if (stateRef.current.phase === WORD.closed && !Keyboard.isVisible() && !reduceMotion.current) {
        LayoutAnimation.configureNext(SLIDE);
      }
      setState(current => ({phase: WORD.open, height: current.phase === WORD.handoff ? current.height : height}));
    },
    [reduceMotion, stopWaiting],
  );

  const handoff = useCallback(() => {
    if (stateRef.current.phase !== WORD.open) return;
    setState(current => ({...current, phase: WORD.handoff}));
    stopWaiting();
    subscription.current = Keyboard.addListener(WORD.keyboardDidShow, () => leave(false));
    timer.current = setTimeout(() => leave(false), HANDOFF_MAX_MS);
  }, [leave, stopWaiting]);

  const close = useCallback(() => leave(!Keyboard.isVisible()), [leave]);

  const api = useMemo<ComposerPanelApi>(
    () => ({phase: state.phase, open, handoff, close, setContent}),
    [state.phase, open, handoff, close],
  );
  return {state, content, api};
}

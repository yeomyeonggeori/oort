import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSession } from "@/app/session";
import { getAuthExpired, subscribeSession } from "@/lib/session";
import type { ConnectionEvent } from "@momo/core/features/connection/model";
import {
  deviceEvent,
  eventAction,
  initialConnectionState,
  isRecovered,
  nextWakeAt,
  reduceConnection,
  restEvent,
  resumeEvent,
  sessionEvent,
  socketEvent,
  tickAction,
} from "@momo/core/features/connection/screenState";
import { startRestProbe, wantsRestProbe } from "@momo/core/features/connection/restProbe";
import { RESUME_AFTER_HIDDEN_MS } from "@momo/core/features/connection/thresholds";
import { subscribeRestOutcome } from "@momo/core/lib/http";
import { readBrowserOnline, useBrowserOffline } from "./browserOffline";
import { ConnectionContext, type ConnectionContextValue } from "./connectionContext";

// =============================================================================
// 연결 상태 모델을 돌리는 공급자 (#5220, #5201 S-B).
//
// 코어 모델(#5219)의 입력 넷을 여기서 모은다: 기기 온라인(`useBrowserOffline`), 소켓(셸이 이미 #786 매핑을
// 거쳐 `connStatus`로 내리는 값), REST 결과(`subscribeRestOutcome`, 앱 전체에서 한 번), 만료. 앱에 **하나**만
// 서고(셸과 첫 실행 세션이 각자 한 벌), 화면은 `useConnection()`(connectionContext.ts)으로 같은 모습을 읽는다.
// 쓰기 게이트는 `useOffline()`이, 사이드바 카드·위쪽 띠는 `view`가 읽는다.
//
// 저절로 다시 확인(#5407): 「서버에 닿지 못했어요」·「연결에 문제가 있어요」는 REST 실패가 쌓여 선 띠라 응답 한 건이 와야 걷혔다. 창이 **보이는 동안** 이 띠가
// 서 있으면 코어 `restProbe`가 늘려 가는 간격(2·4·8·16·30초)으로 가벼운 확인 요청을 보낸다. 결과는 위 REST 구독으로 들어와 서버가 답하면 띠가 걷히고 확인도
// 멈춘다. 숨은 창에서는 보내지 않는다. 폰과 같은 코어 규칙이다.
// =============================================================================

// 창이 보이는가(저절로 다시 확인은 보이는 동안만 보낸다). 포커스는 보지 않는다: 보이는 창의 띠가 걷히지 않으면 안 되고(옆 창을 쓰는 중에도 이 창은 보인다),
// 데스크탑 웹뷰의 `document.hasFocus()`는 창이 앞인데도 거짓일 수 있다(`useChannelViewingBeat`의 같은 이유). `useSyncExternalStore`가 구독 함수의 동일성이 바뀌면
// 다시 구독하므로 모듈에 하나씩 둔다.
const subscribeVisible = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};
const readVisible = () => document.visibilityState !== "hidden";
const assumeVisible = () => true;

/**
 * 모델을 돌리는 공급자. `SessionProvider` **안에** 서고 앱에 하나다(셸, 첫 실행 세션). 하는 일은 사건을
 * 모아 `at`을 찍어 리듀서에 넣는 것과, 시간으로 판정이 바뀌는 시각(`nextWakeAt`)에 한 번 깨우는 것뿐이다.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const { connStatus, realtime } = useSession();
  const [state, dispatch] = useReducer(reduceConnection, undefined, () =>
    initialConnectionState(Date.now(), readBrowserOnline())
  );

  // 사건에는 일어난 순간의 시각을 한 번 찍어 넣는다(리듀서는 시계를 읽지 않는다).
  const emit = useCallback((make: (at: number) => ConnectionEvent) => {
    const at = Date.now();
    dispatch(eventAction(at, make(at)));
  }, []);

  // 소켓. 셸이 `createRealtime`의 상태를 #786 매핑(한 번 붙은 뒤의 connecting은 disconnected)으로 내린다.
  useEffect(() => {
    emit((at) => socketEvent(at, connStatus));
  }, [connStatus, emit]);

  // 기기. 웹은 「모른다(null)」가 없다. `online`·`offline` 이벤트는 `useBrowserOffline`이 한 곳에서 듣는다.
  const browserOffline = useBrowserOffline();
  useEffect(() => {
    emit((at) => deviceEvent(at, !browserOffline));
  }, [browserOffline, emit]);

  // REST 결과 전부(서버에 닿았나). 요청이 어떻게 끝나든 요청 쪽은 이 구독을 모른다.
  useEffect(() => subscribeRestOutcome((outcome) => emit(() => restEvent(outcome))), [emit]);

  // 만료. 웹은 만료가 서면 곧바로 로그인 화면으로 가므로 이 값은 게이트의 정합용이다.
  const expired = useSyncExternalStore(subscribeSession, getAuthExpired, getAuthExpired);
  useEffect(() => {
    emit(() => sessionEvent(expired));
  }, [expired, emit]);

  // 시간만으로 바뀌는 판정(quiet → connecting → down, 복구 표시 끝). 일찍 깨면 남은 만큼 다시 잔다.
  const wake = nextWakeAt(state);
  useEffect(() => {
    if (wake === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const remaining = wake - Date.now();
      if (remaining > 0) {
        timer = setTimeout(arm, remaining);
        return;
      }
      dispatch(tickAction(Date.now()));
    };
    arm();
    return () => clearTimeout(timer);
  }, [wake]);

  // 저절로 다시 확인: REST 실패에서 온 띠가 보이는 창에 서 있는 동안만 켜 두고, 띠가 걷히거나 창이 숨으면 거둔다. 켜진 채 상태만 바뀌는 렌더에서는 시계를
  // 다시 시작하지 않는다(`probing`이 바뀔 때만 효과가 돈다).
  const visible = useSyncExternalStore(subscribeVisible, readVisible, assumeVisible);
  const probing = wantsRestProbe(state.view, visible);
  useEffect(() => (probing ? startRestProbe() : undefined), [probing]);

  const reconnectNow = useCallback(() => {
    emit((at) => resumeEvent(at));
    realtime?.reconnect();
  }, [emit, realtime]);

  // 창이 오래 숨었다 돌아오면 소켓을 새로 연다. 절전·최소화 동안 죽은 소켓은 핑 시간 초과까지 「연결됨」으로
  // 보일 수 있다(감사 문서 §2.1). 자리 비움은 숨김과 포커스 잃음 중 먼저 오는 것에서 시작하고, 돌아옴은 보임과
  // 포커스 중 먼저 오는 것에서 끝난다. 세 이벤트가 같은 판정(`지금 자리에 없나`)을 다시 읽는다. 현재 상태가
  // 무엇이든 연다: 멀쩡해 보이는 소켓이 바로 그 대상이다.
  useEffect(() => {
    const away = () => document.visibilityState === "hidden" || !document.hasFocus();
    let awaySince: number | null = away() ? Date.now() : null;
    const sync = () => {
      if (away()) {
        awaySince ??= Date.now();
        return;
      }
      const since = awaySince;
      awaySince = null;
      if (since === null || Date.now() - since < RESUME_AFTER_HIDDEN_MS) return;
      reconnectNow();
    };
    const names = ["visibilitychange", "blur", "focus"];
    for (const name of names) window.addEventListener(name, sync);
    return () => {
      for (const name of names) window.removeEventListener(name, sync);
    };
  }, [reconnectNow]);

  const value = useMemo<ConnectionContextValue>(
    () => ({ view: state.view, recovered: isRecovered(state), reconnectNow }),
    [state, reconnectNow]
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

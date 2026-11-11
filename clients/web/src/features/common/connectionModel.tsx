import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
import {
  connectionDiagTransitions,
  restFailureDiagKind,
  socketDiagKind,
} from "@momo/core/features/connection/diagnosticLog";
import { verdictOnLateWake, verdictOnReturn } from "@momo/core/features/connection/resume";
import { subscribeRestOutcome } from "@momo/core/lib/http";
import { documentForeground } from "@/features/chat/useChannelViewingBeat";
import { readBrowserOnline, useBrowserOffline } from "./browserOffline";
import { ConnectionContext, type ConnectionContextValue } from "./connectionContext";
import { recordConnectionDiag, startConnectionDiagWatch } from "./connectionDiag";
import { subscribeLateWake } from "./wakeWatch";

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

// 진단 기록(#5587): 판정에 들어가는 사실이 바뀐 순간을 시각과 종류만으로 이 기기 안에 남긴다(`connectionDiag.ts`, 데스크탑만). 기기·REST 선언·
// 보내기 막힘은 상태 비교로, 소켓은 소켓이 알릴 때, REST 실패는 결과가 올 때(분류 낱말만, 주소 없이), 창은 이벤트로, 늦게 깬 타이머는 앱에 하나인 시계로.
// 리듀서 안에서 남기지 않는다(StrictMode가 순수 리듀서를 두 번 부른다).

// 창이 숨었는가(저절로 다시 확인은 보이는 동안만 보낸다). 포커스는 보지 않는다: 보이는 창의 띠가 걷히지 않으면 안 되고(옆 창을 쓰는 중에도 이 창은 보인다),
// 데스크탑 웹뷰의 `document.hasFocus()`는 창이 앞인데도 거짓일 수 있다(`useChannelViewingBeat`의 같은 이유). 창 숨김 이벤트는 아래 자리 비움 효과가 이미 듣는다.
const pageHidden = () => document.visibilityState === "hidden";

/** 창 초점 이벤트가 남기는 종류(#5587). 보임·숨김은 `visibilitychange` 때 그 순간의 `pageHidden()`으로 가른다. */
const WINDOW_DIAG = { focus: "window.focus", blur: "window.blur" } as const;

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
    recordConnectionDiag(socketDiagKind(connStatus));
  }, [connStatus, emit]);

  // 기기. 웹은 「모른다(null)」가 없다. `online`·`offline` 이벤트는 `useBrowserOffline`이 한 곳에서 듣는다.
  const browserOffline = useBrowserOffline();
  useEffect(() => {
    emit((at) => deviceEvent(at, !browserOffline));
  }, [browserOffline, emit]);

  // REST 결과 전부(서버에 닿았나). 요청이 어떻게 끝나든 요청 쪽은 이 구독을 모른다. 닿지 못한 것만 분류 낱말로 기록에 남는다.
  useEffect(
    () =>
      subscribeRestOutcome((outcome) => {
        emit(() => restEvent(outcome));
        const failure = restFailureDiagKind(outcome);
        if (failure !== null) recordConnectionDiag(failure, outcome.at);
      }),
    [emit]
  );

  // 만료. 웹은 만료가 서면 곧바로 로그인 화면으로 가므로 이 값은 게이트의 정합용이다.
  const expired = useSyncExternalStore(subscribeSession, getAuthExpired, getAuthExpired);
  useEffect(() => {
    emit(() => sessionEvent(expired));
  }, [expired, emit]);

  // 기기·REST 선언·보내기 막힘의 전이. 바로 앞 상태와 견준다(처음 그린 상태는 견줄 앞이 없어 남기지 않는다).
  const recorded = useRef(state);
  useEffect(() => {
    const prev = recorded.current;
    recorded.current = state;
    if (prev === state) return;
    for (const kind of connectionDiagTransitions(prev, state)) recordConnectionDiag(kind);
  }, [state]);

  // 늦게 깬 타이머를 재는 시계: 앱에 하나만 선다(두 번째 공급자는 이미 선 시계를 쓴다). 앱이 사는 동안 돈다.
  useEffect(() => {
    startConnectionDiagWatch();
  }, []);

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
  const [hidden, setHidden] = useState(pageHidden);
  const probing = wantsRestProbe(state.view, !hidden);
  useEffect(() => (probing ? startRestProbe() : undefined), [probing]);

  const reconnectNow = useCallback(() => {
    emit((at) => resumeEvent(at));
    realtime?.reconnect();
  }, [emit, realtime]);

  // 창 사건은 진단 기록과 「숨었나」(저절로 다시 확인의 조건)에만 쓴다. 다시 열지는 아래 효과가 정한다.
  useEffect(() => {
    setHidden(pageHidden());
    const sync = (event: Event) => {
      recordConnectionDiag(
        WINDOW_DIAG[event.type as keyof typeof WINDOW_DIAG] ?? (pageHidden() ? "window.hidden" : "window.visible")
      );
      setHidden(pageHidden());
    };
    const names = ["visibilitychange", "blur", "focus"];
    for (const name of names) window.addEventListener(name, sync);
    return () => {
      for (const name of names) window.removeEventListener(name, sync);
    };
  }, []);

  // 돌아온 순간·깨어난 순간에 소켓을 다시 열지(#5220 → #5660, 판정은 코어 `resume.ts`).
  //  - 자리 비움은 숨김과 초점 잃음 중 먼저 오는 것에서 시작하고, 돌아옴은 둘 다 돌아온 순간이다. 「앞에 있나」는 「보고 있음」 신호와 같은 어댑터
  //    (`documentForeground`)가 답한다: 데스크탑 웹뷰의 `document.hasFocus()`는 창이 앞인데도 거짓일 수 있어서, 그것을 읽던 예전 판정은 돌아온 순간을
  //    놓칠 수 있었다.
  //  - 돌아온 순간: 다시 붙기를 기다리는 중이면 기다리지 않고 지금 연다. 30초 넘게 비웠고 그동안 서버의 말을 듣지 못한 소켓(잠든 사이 죽은 소켓)도
  //    연다. 뒤에서도 핑을 들은 소켓은 건드리지 않는다: 이미 다 받았고, 끊었다 다시 여는 것은 눈앞에서 연결을 흔들 뿐이다.
  //  - 깨어난 순간: 앱을 앞에 둔 채 맥이 잠들었다 깨면 창 사건이 없다. 늦게 깬 시계(`wakeWatch.ts`)가 그 사실이고, 멈춘 동안 아무것도 듣지 못했으면
  //    핑 마감(최대 35초)을 기다리지 않고 연다.
  //  다시 열면 레일마다 놓친 것을 메운다(타임라인은 복구·`?after`, 읽음 투영은 `ReadStateLiveSync`).
  const connStatusRef = useRef(connStatus);
  connStatusRef.current = connStatus;
  useEffect(() => {
    const facts = () => {
      const heardAt = realtime?.lastHeardAt?.() ?? null;
      return {
        // 처음 붙는 중(`connecting`)은 기다리는 소켓이 아니다: 손대지 않는다. 한 번 붙은 뒤의 끊김만 `disconnected`다(#786 매핑).
        socketConnected: connStatusRef.current !== "disconnected",
        heardAgoMs: heardAt === null ? null : Date.now() - heardAt,
      };
    };
    let awaySince: number | null = documentForeground.isForeground() ? null : Date.now();
    const stopForeground = documentForeground.subscribe((foreground) => {
      if (!foreground) {
        awaySince ??= Date.now();
        return;
      }
      const since = awaySince;
      awaySince = null;
      if (since === null) return;
      if (verdictOnReturn({ awayMs: Date.now() - since, ...facts() }) === "reconnect") reconnectNow();
    });
    const stopWake = subscribeLateWake((_kind, _at, lateMs) => {
      if (verdictOnLateWake({ lateMs, ...facts() }) === "reconnect") reconnectNow();
    });
    return () => {
      stopForeground();
      stopWake();
    };
  }, [reconnectNow, realtime]);

  const value = useMemo<ConnectionContextValue>(
    () => ({ view: state.view, recovered: isRecovered(state), reconnectNow }),
    [state, reconnectNow]
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

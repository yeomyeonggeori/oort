import { fetchWithDeadline } from "../../lib/http";
import { apiBase } from "../../runtime/host";
import type { ConnectionView } from "./model";
import { REST_PROBE_PATH } from "./restSignal";
import {
  REST_PROBE_FIRST_DELAY_MS,
  REST_PROBE_MAX_DELAY_MS,
  REST_PROBE_TIMEOUT_MS,
} from "./thresholds";

// =============================================================================
// 저절로 다시 확인한다 — REST 실패에서 온 띠가 서 있는 동안 (#5407, #5403 후속).
//
// 「서버에 닿지 못했어요」·「연결에 문제가 있어요」(알 수 없음)는 REST 실패가 쌓여서 선 띠(`restSignal.ts`)라서, 서버가 돌아와도 **응답 한 건이 와야**
// 걷혔다. 사람이 보내기 같은 요청을 하기 전까지는 두드릴 길이 없었다(「채팅해야 사라진다」). 이 파일은 그 길을 낸다:
//
//   - 띠가 **앞에서** 서 있는 동안만, 늘려 가는 간격(2 · 4 · 8 · 16 · 30초, 상한 30초)으로 가벼운 확인 요청을 보낸다. 뒤에 있을 때는 보내지 않는다.
//   - 확인 요청은 서버가 이미 공개해 둔 살아 있음 확인(`GET /healthz`, 인증 없음, DB 왕복 한 번)이다. 새 서버 API가 아니고, 로그인 갱신(`authedRequest`)을
//     끌어들이지 않는다.
//   - 결과를 따로 해석하지 않는다. 확인 요청도 다른 요청과 같은 길(`fetchWithDeadline` → `subscribeRestOutcome` → 모델)로 보고되고, 서버가 답하면
//     (어떤 응답이든) 그 한 건이 쌓인 실패를 푼다. 풀린 뒤의 「다시 연결됐어요」 2초는 모델의 규칙(`screenState.ts`)이다.
//   - 단, 확인 요청의 **실패**는 실패 기억에 쌓지 않는다(`restSignal.ts`): 확인은 이미 선 판정을 다시 묻는 것이지 새 증거가 아니다. 쌓으면 「알 수 없음」이
//     확인 한 번으로 보내기를 막는 「서버에 닿지 못함」으로 올라간다.
//
// 순수한 것(`wantsRestProbe`·`restProbeDelayMs`)과 시계를 쥔 것(`startRestProbe`)을 나눴다. 시계·요청은 인자로 받아 시험이 가짜를 물린다. 폰·웹 공급자는
// 「지금 확인이 필요한가」(`wantsRestProbe`)가 거짓에서 참이 될 때 시작하고 거짓이 될 때 멈춘다 - 두 공급자가 같은 규칙을 읽는다.
// =============================================================================

/**
 * 지금 확인 요청이 필요한가: REST 실패에서 온 띠(서버에 닿지 못함 · 알 수 없음)가 서 있고 **사람이 앞에서 보고 있을 때**.
 *
 * `foreground`는 호출자가 건넨다 - 앞뒤를 아는 방식이 폰(앱 상태)과 웹(창 보임)이 달라서이고, 웹의 연결 상태 모델은 앞뒤를 모른다. 기기 오프라인은 REST 실패에서 온
 * 띠가 아니라서(기기가 돌아오면 소켓이 이어 준다) 확인하지 않고, 로그인 만료는 로그인 화면이 말한다.
 */
export function wantsRestProbe(view: ConnectionView, foreground: boolean): boolean {
  return foreground && view.phase === "down" && (view.cause === "serverUnreachable" || view.cause === "unknown");
}

/** `attempt`번째(0부터) 확인을 보내기 전의 기다림: 2 · 4 · 8 · 16초, 그 뒤는 상한 30초. */
export function restProbeDelayMs(attempt: number): number {
  return Math.min(REST_PROBE_FIRST_DELAY_MS * 2 ** Math.max(0, attempt), REST_PROBE_MAX_DELAY_MS);
}

/**
 * 확인 요청 한 건. 인증 없는 `GET /healthz`다. `fetchWithDeadline`이 결과를 모델에 보고하므로(요청이 어떻게 끝나든) 여기서 돌려주는 값은 쓰지 않는다. 닿지
 * 못하면 `NetworkError`로 거절된다.
 */
export function sendRestProbe(): Promise<unknown> {
  return fetchWithDeadline(`${apiBase()}${REST_PROBE_PATH}`, { method: "GET", cache: "no-store" }, REST_PROBE_TIMEOUT_MS);
}

export interface RestProbeDeps {
  /** 확인 요청 한 건을 보낸다. 끝나면(성공이든 실패든) 이어서 다음 확인을 건다. */
  readonly send: () => Promise<unknown>;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

const DEFAULT_DEPS: RestProbeDeps = {
  send: sendRestProbe,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 확인을 시작한다. 돌려주는 함수가 멈춤이다(타이머를 거두고, 날아가 있는 요청이 끝나도 이어서 걸지 않는다).
 *
 * - 첫 확인은 시작한 지 2초 뒤, 그 뒤는 **앞 확인이 끝난 때**부터 4 · 8 · 16 · 30 · 30…초 뒤다. 한 번에 하나만 날아가 있다(요청 마감이 간격보다 길어도 겹치지 않는다).
 * - 확인 요청이 실패해도(던져도) 다음 확인은 이어진다. 멈추는 것은 호출자가 띠가 걷히거나 뒤로 갔다고 알릴 때뿐이다.
 * - 같은 띠가 다시 서면 새로 시작해서 2초부터다(호출자가 멈췄다 다시 시작한다).
 */
export function startRestProbe(deps: RestProbeDeps = DEFAULT_DEPS): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: unknown = null;
  let inFlight = false;

  function schedule(): void {
    if (stopped || inFlight || timer !== null) return;
    timer = deps.setTimer(fire, restProbeDelayMs(attempt));
  }

  function settle(): void {
    inFlight = false;
    schedule();
  }

  function fire(): void {
    timer = null;
    if (stopped) return;
    attempt += 1;
    inFlight = true;
    let sent: Promise<unknown>;
    try {
      sent = Promise.resolve(deps.send());
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(settle, settle);
  }

  schedule();
  return () => {
    stopped = true;
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };
}

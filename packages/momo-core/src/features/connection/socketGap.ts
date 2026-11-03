import type { RealtimeStatus } from "../../lib/realtimeEvents";
import { CONNECTING_BAND_DELAY_MS, HEALED_MS } from "./thresholds";

// =============================================================================
// 소켓 「틈」의 시계 — 언제 시작했고 언제 풀렸나 (#5219, 감사 문서 §4 원칙 2).
//
// 소켓이 `connected`가 아닌 동안이 틈이다. 이 파일은 틈이 **언제 시작했는지**만 기억한다. 몇 초가 흘렀는지는
// 읽는 쪽이 `now`를 건네 계산한다(시계는 인자, 타이머 없음). 규칙은 웹 띠(`HEALED_MS`)와 폰 표시 계층
// (`resume`, 끝난 소켓)이 각자 갖던 것을 한 벌로 모은 것이다.
//
//   - 첫 핸드셰이크도 틈이다(콜드 스타트). `openingSocketGap`.
//   - 틈의 시계는 재시도·`connecting`↔`disconnected` 전환으로 다시 시작하지 않는다.
//   - 다시 붙어도 `HEALED_MS` 동안 **붙어 있어야** 틈이 풀린다. 그 안에 또 끊기면 처음 시작한 때가 이어져
//     깜빡이는 소켓이 문턱을 넘는다. 풀림은 읽을 때 계산한다(`settleGap`).
//   - 앱 복귀·망 복귀·손으로 누른 「지금 다시 연결」(`resume`)은 시계를 새로 시작한다. 절전·백그라운드로
//     보낸 시간은 복구에 쓴 시간이 아니다. 단, 이미 말하고 있던 띠는 침묵으로 돌아가지 않고 곧바로
//     「연결 중」으로 이어진다(누른 단추가 눈에 보이게 무언가 해야 한다). 이때 10초는 새로 센다.
//   - 끝난 소켓(`ended`: 서버가 「다시 연결하지 마라」 했다, #4895)은 기다릴 틈이 없다. 바로 끊김이다.
//
// `status`는 웹이 #786 매핑(`createRealtime`: 한 번 붙은 뒤의 `connecting`은 `disconnected`로 보고)을 거친
// 값이어도 된다. 틈은 「연결이 아님」 전체이고, `connecting`과 `disconnected`를 가르지 않는다. 끝남은
// 상태값이 아니라 `ended` 표지로만 알린다.
// =============================================================================

/** 아직 풀리지 않은 틈 하나. */
export interface OpenGap {
  /** 틈이 시작된 때(epoch ms). 10초 시계가 여기서 간다. */
  readonly since: number;
  /** 이 시각 전까지 화면은 침묵한다. 보통 `since + CONNECTING_BAND_DELAY_MS`. */
  readonly quietUntil: number;
  /** 틈 안에서 소켓이 `connected`가 된 때. `HEALED_MS`를 채우면 틈이 풀린다. 붙어 있지 않으면 null. */
  readonly connectedAt: number | null;
}

export interface SocketGap {
  /** 소켓이 마지막으로 알린 상태. */
  readonly status: RealtimeStatus;
  /** 아직 풀리지 않은 틈. 없으면 null. */
  readonly open: OpenGap | null;
  /** 소켓이 끝났고 아무도 다시 열지 않는다. */
  readonly ended: boolean;
}

export type SocketEvent =
  /** 소켓이 상태를 알렸다. `ended`는 「이 소켓은 다시 열리지 않는다」일 때만. */
  | { kind: "status"; at: number; status: RealtimeStatus; ended?: boolean }
  /** 앱 복귀·망 복귀·손으로 누른 다시 연결. 소켓을 다시 여는 쪽이 알린다. */
  | { kind: "resume"; at: number };

function silentFor(since: number): OpenGap {
  return { since, quietUntil: since + CONNECTING_BAND_DELAY_MS, connectedAt: null };
}

/** 앱이 처음 뜰 때의 틈: 첫 핸드셰이크도 틈이다. */
export function openingSocketGap(at: number): SocketGap {
  return { status: "connecting", open: silentFor(at), ended: false };
}

/** `HEALED_MS` 넘게 붙어 있었다면 틈은 이미 풀린 것으로 본다. 읽을 때마다 부른다. */
export function settleGap(gap: SocketGap, now: number): SocketGap {
  const open = gap.open;
  if (open === null || open.connectedAt === null) return gap;
  return now - open.connectedAt >= HEALED_MS ? { ...gap, open: null } : gap;
}

export function foldSocketEvent(gap: SocketGap, event: SocketEvent): SocketGap {
  const settled = settleGap(gap, event.at);

  if (event.kind === "resume") {
    // 말하고 있던 띠는 계속 말한다: 침묵이던 틈(첫 1초 안)이나 틈이 없던 소켓만 침묵으로 새로 시작한다.
    const bandUp =
      settled.status !== "connected" &&
      settled.open !== null &&
      (settled.ended || event.at >= settled.open.quietUntil);
    return {
      status: "connecting",
      open: bandUp ? { since: event.at, quietUntil: event.at, connectedAt: null } : silentFor(event.at),
      ended: false,
    };
  }

  if (event.status === "connected") {
    return {
      status: "connected",
      open: settled.open === null ? null : { ...settled.open, connectedAt: settled.open.connectedAt ?? event.at },
      ended: false,
    };
  }

  return {
    status: event.status,
    open: settled.open === null ? silentFor(event.at) : { ...settled.open, connectedAt: null },
    // 끝난 소켓은 `connecting` 같은 늦은 알림으로 되살아나지 않는다. `connected`나 `resume`만 되살린다.
    ended: event.ended === true || settled.ended,
  };
}

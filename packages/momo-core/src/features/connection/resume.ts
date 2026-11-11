import { LATE_WAKE_MS } from "../../lib/http";
import { RESUME_AFTER_HIDDEN_MS, RESUME_KICK_SETTLE_MS, SOCKET_HEARD_RECENTLY_MS } from "./thresholds";

// =============================================================================
// 돌아온 순간·깨어난 순간에 실시간 소켓을 다시 열지 정하는 판정 (#5660).
//
// owner 2026-11-11: 데스크탑이 뒤에 있다가 앞으로 오면 「그제야 다시 연결되며 내용이 맞춰진다」. 그 순간에 할 일은 둘 중 하나다.
//
//   - 소켓이 살아 있다 → 아무것도 하지 않는다. 뒤에 있는 동안 온 글은 이미 화면에 들어와 있다. 끊고 다시 여는 것은 사람 눈앞에서
//     연결 표시(내 접속 점·작업 줄의 「실시간」)를 흔들고 모든 레일을 다시 읽게 할 뿐이다.
//   - 소켓이 죽었다(또는 다시 붙기를 미루며 기다리는 중이다) → 기다리지 않고 지금 다시 연다. 다시 붙으면 레일마다 놓친 것을 메운다
//     (타임라인은 센트리퓨고 복구 또는 REST `?after`, 표시는 읽음 투영 다시 읽기).
//
// 「살아 있다」를 무엇으로 아나: **자리를 비운 동안에도 서버의 말을 들었는가**(`heardAgoMs`). 웹뷰가 멈췄거나 맥이 잠들었으면 그동안 아무것도
// 듣지 못했고, 뒤에서도 돌았으면 25초마다 핑을 들었다. 상태 값(`connected`)만으로는 모른다: 잠든 사이 죽은 소켓은 핑 마감까지 「연결됨」이다.
//
// 순수 함수다(시계·소켓 없음). 웹 공급자(`connectionModel.tsx`)가 사건마다 부른다.
// =============================================================================

export type ResumeVerdict = "keep" | "reconnect";

/** 방금(`RESUME_KICK_SETTLE_MS` 안) 이 판정으로 다시 열었다: 그 시도가 붙는 중일 수 있으니 끊지 않는다. */
function justKicked(kickedAgoMs: number | null | undefined): boolean {
  return kickedAgoMs !== null && kickedAgoMs !== undefined && kickedAgoMs < RESUME_KICK_SETTLE_MS;
}

export interface ReturnFacts {
  /** 자리를 비운 시간(숨김 또는 초점 잃음이 시작된 뒤로). */
  readonly awayMs: number;
  /** 소켓이 지금 붙어 있다고 말하나. */
  readonly socketConnected: boolean;
  /** 소켓이 서버에게서 마지막으로 무언가 들은 지 얼마나 됐나. 들은 적이 없거나 모르면 null. */
  readonly heardAgoMs: number | null;
  /** 이 판정(돌아옴·깨어남)으로 마지막에 다시 연 지 얼마나 됐나. 연 적이 없으면 null(생략 가능). */
  readonly kickedAgoMs?: number | null;
}

/** 사람이 앞으로 돌아온 순간. */
export function verdictOnReturn(facts: ReturnFacts): ResumeVerdict {
  if (justKicked(facts.kickedAgoMs)) return "keep";
  // 다시 붙기를 미루며 기다리는 중이다(백오프는 20초까지 간다): 돌아온 사람을 그 남은 시간 동안 기다리게 하지 않는다.
  if (!facts.socketConnected) return "reconnect";
  // 짧은 자리 비움은 소켓이 스스로 알아챈다(#5220의 규칙 그대로).
  if (facts.awayMs < RESUME_AFTER_HIDDEN_MS) return "keep";
  // 뒤에 있는 동안에도 서버의 말을 들었다: 살아 있는 소켓이다.
  if (facts.heardAgoMs !== null && facts.heardAgoMs < SOCKET_HEARD_RECENTLY_MS) return "keep";
  return "reconnect";
}

export interface LateWakeFacts {
  /** 시계가 예정보다 늦게 깬 정도(그동안 이 페이지가 돌지 않았다: 맥 잠자기, 웹뷰 멈춤). */
  readonly lateMs: number;
  readonly socketConnected: boolean;
  readonly heardAgoMs: number | null;
  readonly kickedAgoMs?: number | null;
}

/**
 * 시계가 늦게 깬 순간(창 사건이 없을 수 있다: 앱을 앞에 둔 채 맥이 잠들었다 깸). 멈춘 동안 아무것도 듣지 못했으면 그 소켓은 잠든 사이에
 * 죽었을 수 있다. 핑 마감(최대 35초)을 기다리지 않고 지금 다시 연다. 멈춘 뒤에 무언가 들었으면(`heardAgoMs < lateMs`) 소켓은 그 멈춤을
 * 지나 살아 있다: 숨은 브라우저 탭의 타이머가 늦게 깨는 것(1분 단위로 묶인다)도 여기서 걸러진다 — 그동안에도 핑은 들린다.
 */
export function verdictOnLateWake(facts: LateWakeFacts): ResumeVerdict {
  if (!(facts.lateMs >= LATE_WAKE_MS)) return "keep";
  if (justKicked(facts.kickedAgoMs)) return "keep";
  if (!facts.socketConnected) return "reconnect";
  if (facts.heardAgoMs !== null && facts.heardAgoMs < facts.lateMs) return "keep";
  return "reconnect";
}

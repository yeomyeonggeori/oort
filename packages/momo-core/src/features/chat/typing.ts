import { uuidEq } from "../../lib/api";

// =============================================================================
// 「작성 중」 — 두 클라이언트가 공유하는 정본 (ADR-0149, goal B3 W2/M2).
//
// ## 어휘가 이 파일의 첫 번째 계약이다
//
// **사람은 작성 중, 에이전트는 작업 중.** 서버가 두 곳에 그 문장을 적어 뒀고
// (`momo-ephemeral/src/signal.rs`, `routes/ephemeral.rs`), 이유는 ADR-0101이
// 거부한 봇 래핑이다: 에이전트가 일하는 중이라는 사실은 `agent_run`으로 **영속**
// 하고, 그것을 사람의 어포던스로 분장하면 에이전트를 1급 멤버로 올린 결정 자체가
// 무의미해진다. 그래서 이 파일의 문구에는 「작업」이라는 글자가 없고, 그 사실을
// 테스트가 못박는다(typing.test.ts).
//
// ## 서버가 상태를 안 들고 있다 (가드 4) — 그 비용을 여기서 낸다
//
// 서버에는 「지금 누가 작성 중인가」가 없다. 신호 하나하나가 자기 `expires_at`을
// 들고 오고, 잊는 일은 **구독자의 몫**이다. 그래서 이 파일에는 두 기계가 있다:
//
//   * **송신** [`nextTypingAction`] — 타이머가 **없다**. 키를 누를 때마다 「지금
//     발행할 때인가」를 묻는 순수 함수이고, 그래서 흐림(blur)·백그라운드·언마운트에
//     정리할 것이 하나도 없다. 입력이 멈추면 발행도 멈추고, 소멸은 TTL이 한다
//     (「정지」 신호는 계약에 없다).
//   * **수신** [`pruneTypingSignals`] / [`liveTypists`] — 받은 신호를 만료 시각으로
//     스스로 버린다. 서버에 「아직 치고 있나」를 묻는 길은 없고, 있어야 할 이유도 없다.
//
// ## 숫자의 출처
//
// | 값 | 어디서 오나 |
// |---|---|
// | 만료 | **신호 자신** (`payload.expires_at`). 설정이 필요 없는 유일한 축이다 |
// | 재발행 간격 | **grant 응답** (`republishIntervalMs`). 서버가 정하고 클라가 읽는다 |
// | 뭉치는 임계 | grant 응답 (`aggregateThreshold`), 없으면 아래 미러 |
//
// 읽는 사람은 grant를 받을 이유가 없다(grant는 **발행** 자격이다). 그래서 임계만
// 미러가 필요하고, grant가 있으면 언제나 grant 값이 이긴다.
// =============================================================================

/**
 * 서버의 `TYPING_AGGREGATE_THRESHOLD` 미러. **grant 값이 있으면 그것이 이긴다.**
 *
 * 한 번도 타이핑하지 않은 사람은 grant가 없고, 그래도 남의 작성 중은 그려야 하므로
 * 이 값이 필요하다. 서버와 갈릴 수 있는 유일한 숫자이며 갈려도 무해하다: 3명에서
 * 뭉치는 대신 4명에서 뭉치는 화면은 틀린 말을 하지 않는다.
 */
export const TYPING_AGGREGATE_THRESHOLD_FALLBACK = 3;

/**
 * grant가 만료 직전일 때 미리 새로 받는 여유.
 *
 * 재발행 간격(3s)의 두 배보다 커야 한다: 그보다 작으면 만료 직전에 발행한 요청이
 * 서버에 도착하는 사이에 grant가 죽어 403을 받고, 그 403은 지금 치고 있는 사람의
 * 표시가 한 번 끊기는 것으로 보인다.
 *
 * **상한이지 고정값이 아니다.** 아래 [`renewMargin`]이 grant의 실제 수명 절반으로
 * 한 번 더 깎는다 — 이 값을 그냥 빼면 수명이 이보다 짧은 grant를 주는 서버에서
 * 클라가 「아직 못 쓴다」와 「새로 받는다」 사이를 영원히 돌고 **한 번도 발행하지
 * 않는다.** 실측으로 잡았다: `gate-typing`의 GRANT red seam이 TTL을 1초로 줄였을 때
 * 7초를 치는 동안 발행이 0건이었다.
 */
export const TYPING_GRANT_RENEW_MARGIN_MS = 10_000;

// ---------------------------------------------------------------------------
// 송신 — 타이머 없는 케이던스
// ---------------------------------------------------------------------------

/** `POST …/typing/grant`가 돌려준 것. 값은 전부 서버가 정한다. */
export interface TypingGrant {
  token: string;
  /** 구독할 Centrifugo 채널. 메시지 레일과 **다른** 채널이다(가드 1). */
  channel: string;
  expiresAtMs: number;
  signalTtlMs: number;
  republishIntervalMs: number;
  aggregateThreshold: number;
}

export interface TypingSendState {
  /** 손에 든 발행 자격, 또는 null. */
  grant: TypingGrant | null;
  /**
   * 그 자격을 언제 받았나. 수명(만료 - 발급)을 알아야 여유를 그 절반으로 깎을 수
   * 있고, 그 깎기가 짧은 TTL 서버에서 클라가 갇히지 않게 하는 유일한 장치다.
   */
  grantIssuedAtMs: number | null;
  lastPublishAtMs: number | null;
  /** 429를 받았다. 이 시각까지는 아무것도 보내지 않는다(가드 5는 서버의 것이다). */
  backoffUntilMs: number | null;
  /**
   * 서버가 503으로 「이 인스턴스는 휘발 신호를 하지 않는다」고 답했다.
   *
   * 다시 묻지 않는다. dto의 문장이 그 뜻이다: 라우트는 있고 인스턴스에 Centrifugo
   * 발행 자격이 없는 것이므로, 클라가 알 수 있는 것은 「그만 물어라」뿐이다.
   */
  disabled: boolean;
}

export function emptyTypingSendState(): TypingSendState {
  return {
    grant: null,
    grantIssuedAtMs: null,
    lastPublishAtMs: null,
    backoffUntilMs: null,
    disabled: false,
  };
}

/** 지금 무엇을 할 것인가. `wait`가 압도적으로 흔한 답이고, 그것이 정상이다. */
export type TypingSendAction =
  | { kind: "wait" }
  | { kind: "grant" }
  | { kind: "publish"; grant: string };

/**
 * 이 자격에 대해 「미리 갱신」을 시작할 여유.
 *
 * 상한은 [`TYPING_GRANT_RENEW_MARGIN_MS`]이고, 그 아래로는 **수명의 절반**이다.
 * 두 번째 항이 없으면 수명이 여유보다 짧은 grant는 태어나자마자 「갱신해야 함」이
 * 되고, 클라는 발행 한 번 없이 grant만 계속 받는다.
 */
export function renewMargin(
  grant: TypingGrant,
  issuedAtMs: number | null
): number {
  if (issuedAtMs === null) return TYPING_GRANT_RENEW_MARGIN_MS;
  const lifetime = grant.expiresAtMs - issuedAtMs;
  if (lifetime <= 0) return 0;
  return Math.min(TYPING_GRANT_RENEW_MARGIN_MS, Math.floor(lifetime / 2));
}

function grantUsable(state: TypingSendState, nowMs: number): boolean {
  if (state.grant === null) return false;
  return (
    state.grant.expiresAtMs - renewMargin(state.grant, state.grantIssuedAtMs) >
    nowMs
  );
}

/**
 * 사람이 방금 한 글자 쳤다. 무엇을 해야 하나.
 *
 * **여기 타이머가 없는 것이 설계의 요점이다.** 3초 인터벌을 돌리면 흐림·탭 전환·
 * 라우트 이동·언마운트마다 그것을 끄는 코드가 필요하고, 그 중 하나를 잊으면 컴포저를
 * 떠난 사람이 계속 작성 중으로 남는다 — 「입력이 멈추면 송신도 멈춘다」를 코드가
 * 아니라 **구조**로 지킨다. 키를 누르지 않으면 이 함수가 불리지 않고, 불리지 않으면
 * 아무것도 나가지 않는다.
 */
export function nextTypingAction(
  state: TypingSendState,
  nowMs: number
): TypingSendAction {
  if (state.disabled) return { kind: "wait" };
  if (state.backoffUntilMs !== null && nowMs < state.backoffUntilMs) {
    return { kind: "wait" };
  }
  if (!grantUsable(state, nowMs)) return { kind: "grant" };
  const grant = state.grant as TypingGrant;
  if (state.lastPublishAtMs === null) return { kind: "publish", grant: grant.token };
  // 첫 타에 즉시 한 번 나가고 그 뒤로는 서버가 말한 간격이다. 「멈춘 뒤 다시
  // 시작」도 같은 규칙을 탄다: 간격을 넘겼으면 그것은 새 버스트의 첫 타다.
  if (nowMs - state.lastPublishAtMs >= grant.republishIntervalMs) {
    return { kind: "publish", grant: grant.token };
  }
  return { kind: "wait" };
}

export function withTypingGrant(
  state: TypingSendState,
  grant: TypingGrant,
  issuedAtMs: number
): TypingSendState {
  return { ...state, grant, grantIssuedAtMs: issuedAtMs, backoffUntilMs: null };
}

export function withTypingPublished(
  state: TypingSendState,
  atMs: number
): TypingSendState {
  return { ...state, lastPublishAtMs: atMs, backoffUntilMs: null };
}

/**
 * 서버가 거절했다. 상태가 어떻게 되나.
 *
 * 네 갈래를 구분하는 이유는 각각 **다음 행동이 다르기** 때문이다:
 * 403은 자격이 죽은 것이라 다시 받으면 되고, 429는 기다려야 하고, 503은 영구히
 * 그만 묻는 것이고, 502는 브로커가 흔들린 것이라 다음 타가 곧 재시도다.
 */
export function withTypingRefusal(
  state: TypingSendState,
  status: number,
  options: { nowMs: number; retryAfterMs?: number } = { nowMs: 0 }
): TypingSendState {
  if (status === 503) {
    return { ...state, disabled: true, grant: null, grantIssuedAtMs: null };
  }
  if (status === 403) return { ...state, grant: null, grantIssuedAtMs: null };
  if (status === 429) {
    // Retry-After가 없으면 재발행 간격만큼 쉰다. 0으로 두면 다음 타에 또 맞는다.
    const wait =
      options.retryAfterMs ?? state.grant?.republishIntervalMs ?? 3_000;
    return { ...state, backoffUntilMs: options.nowMs + wait };
  }
  // 502(브로커 불가) 및 그 밖의 5xx: 상태를 바꾸지 않는다. 다음 키가 재시도이고,
  // 그것이 서버가 202가 아니라 502를 준 이유다.
  return state;
}

/** grant 응답에서 이 클라가 지켜야 할 값만 뽑는다. */
export function typingGrantFrom(wire: {
  grant: string;
  channel: string;
  expiresAtMs: number;
  signalTtlMs: number;
  republishIntervalMs: number;
  aggregateThreshold: number;
}): TypingGrant {
  return {
    token: wire.grant,
    channel: wire.channel,
    expiresAtMs: wire.expiresAtMs,
    signalTtlMs: wire.signalTtlMs,
    republishIntervalMs: wire.republishIntervalMs,
    aggregateThreshold: wire.aggregateThreshold,
  };
}

// ---------------------------------------------------------------------------
// 수신 — 스스로 잊는 명부
// ---------------------------------------------------------------------------

/**
 * 한 사람이 한 채널에서 `expiresAtMs`까지 작성 중이다.
 *
 * **시각이 두 개인 것이 H-1의 수리다.** 처음에는 `sentAtMs` 하나로 「언제부터 치고
 * 있나」와 「가장 최근 발행이 언제인가」를 겸하려 했는데, 그 둘은 재발행이 일어나는
 * 순간 갈라진다: 재발행마다 `sentAtMs`가 갱신되므로 그 값으로 정렬하면 순서가
 * **가장 최근에 발행한 사람 순**이 된다. 두 사람이 3초 케이던스로 위상차를 두고
 * 치면 이름 순서가 1.5초마다 뒤집힌다 (design-review PR 1059 H-1, 코어 시뮬레이션으로
 * 재현 확인).
 *
 * 그 줄은 사라질 때가 아니라 **살아 있는 동안** 흔들리고, 12px 회색 한 줄이 1.5초마다
 * 자기 텍스트를 다시 쓰면 「새 사람이 들어왔나」로 읽혀 눈이 되돌아온다 — 주변시로
 * 흘려보내야 할 신호가 정반대로 작동한다.
 */
export interface TypingSignal {
  channelId: string;
  memberId: string;
  /**
   * 이 사람이 **이번 버스트에서 처음** 치기 시작한 시각. 재발행이 갱신하지 않는다.
   * 이름 순서의 유일한 근거다.
   *
   * 만료로 명부에서 빠진 뒤 다시 치면 새 엔트리이므로 새 시작 시각을 받는다 — 「잠깐
   * 멈췄다 다시 시작」은 실제로 새 버스트이므로 그게 맞다.
   */
  startedAtMs: number;
  /** 가장 최근 발행 시각. 진단용이며 **정렬에 쓰지 않는다**. */
  sentAtMs: number;
  expiresAtMs: number;
}

function sameTypist(a: TypingSignal, b: TypingSignal): boolean {
  return uuidEq(a.channelId, b.channelId) && uuidEq(a.memberId, b.memberId);
}

/**
 * 새 신호를 명부에 넣는다. 같은 (채널, 사람)은 **하나뿐**이고, 만료가 더 늦은 쪽이
 * 이긴다.
 *
 * 늦은 쪽이 이기는 것이 load-bearing이다: 재발행이 순서를 바꿔 도착하면(휘발
 * 네임스페이스는 순서를 보장하지 않는다 — seq가 없다) 늦게 도착한 **오래된** 신호가
 * 살아 있는 표시를 과거로 되돌린다.
 */
export function mergeTypingSignal(
  list: TypingSignal[],
  signal: TypingSignal
): TypingSignal[] {
  const index = list.findIndex((entry) => sameTypist(entry, signal));
  if (index < 0) return [...list, signal];
  const existing = list[index];
  if (existing.expiresAtMs >= signal.expiresAtMs) return list;
  const next = [...list];
  // **시작 시각은 살아남는다** (H-1). 엔트리를 통째로 갈아 끼우면 재발행이 시작
  // 시각을 덮어쓰고, 그 값으로 정렬하는 이름 순서가 1.5초마다 뒤집힌다. 갱신되는
  // 것은 만료와 최근 발행 시각뿐이다.
  next[index] = { ...signal, startedAtMs: existing.startedAtMs };
  return next;
}

/**
 * 만료된 것을 버린다 (가드 4). 참조가 바뀌지 않으면 같은 배열을 돌려준다 — 이
 * 함수는 1Hz로 돌므로, 버릴 것이 없을 때 새 배열을 만들면 그것만으로 화면이 초당
 * 한 번 다시 그려진다.
 */
export function pruneTypingSignals(
  list: TypingSignal[],
  nowMs: number
): TypingSignal[] {
  const live = list.filter((signal) => signal.expiresAtMs > nowMs);
  return live.length === list.length ? list : live;
}

export interface LiveTypistOptions {
  channelId: string;
  nowMs: number;
  /** 나. 자기 자신은 절대 그리지 않는다. */
  myMemberId?: string;
  /**
   * 이 멤버를 「작성 중」으로 그려도 되나. 웹/폰이 명부(roster)로 답한다.
   *
   * **에이전트를 여기서 떨군다.** 서버가 발행을 403으로 막지만(`require_human`),
   * 그것은 서버의 방어이고 이것은 화면의 방어다: 어떤 경로로든 에이전트 id를 실은
   * 신호가 도착하면 그것을 그리는 순간 「사람은 작성 중, 에이전트는 작업 중」이
   * 화면에서 깨진다. 판정을 못 하는 멤버(명부에 아직 없는 id)도 그리지 않는다 —
   * 이름 없는 「누군가 작성 중」은 나르는 정보가 0이다.
   */
  isEligible: (memberId: string) => boolean;
}

/** 지금 이 채널에서 작성 중인 사람들의 id, 도착한 순서대로. */
export function liveTypists(
  list: TypingSignal[],
  options: LiveTypistOptions
): string[] {
  return list
    .filter(
      (signal) =>
        uuidEq(signal.channelId, options.channelId) &&
        signal.expiresAtMs > options.nowMs &&
        !uuidEq(signal.memberId, options.myMemberId) &&
        options.isEligible(signal.memberId)
    )
    // 시작 시각으로 정렬한다 — 재발행이 갱신하지 않는 유일한 시각이다(H-1).
    // 동시에 시작한 두 사람은 member id로 갈라, 프레임 도착 순서에 따라 순서가
    // 달라지지 않게 한다(같은 tick에 두 신호가 오면 배열 순서는 우연이다).
    .sort(
      (a, b) =>
        a.startedAtMs - b.startedAtMs || (a.memberId < b.memberId ? -1 : 1)
    )
    .map((signal) => signal.memberId);
}

// ---------------------------------------------------------------------------
// 문구 — 「작업」이라는 글자가 없는 자리
// ---------------------------------------------------------------------------

/** 이름을 몇 개까지 늘어놓나. 임계가 3이면 최대 2개가 이름으로 남는다. */
function nameLimit(threshold: number): number {
  return Math.max(1, threshold - 1);
}

/**
 * 컴포저 하단의 한 줄 (입력창 **아래**, 작업 중 줄 바로 위). 1차 독스트링은 이것을
 * 「컴포저 위」라고 적었는데 렌더는 아래였다 — 문서와 화면이 다른 배치를 말하고
 * 있었다 (design-review PR 1059 M-4).
 *
 * 아무도 치고 있지 않으면 null이다. 다만 **자리는 화면이 예약한다**: 문장이 없다는
 * 것과 그 자리가 없다는 것은 다르고, 후자는 남의 키 입력이 내 캐럿을 밀어 올리는
 * 것을 뜻한다 (H-2, `TypingLine.tsx`).
 *
 * 뭉치는 규칙은 서버가 정한 임계를 그대로 탄다. 서버는 절대 뭉치지 않는다(상태가
 * 없으므로 몇 명인지 모른다). 사람마다 신호 하나를 발행하고, 세는 것은 여기다.
 */
export function typingSentence(
  names: string[],
  threshold: number = TYPING_AGGREGATE_THRESHOLD_FALLBACK
): string | null {
  if (names.length === 0) return null;
  const limit = nameLimit(threshold);
  if (names.length > limit) return `${names.length}명이 작성 중…`;
  return `${names.slice(0, limit).join(", ")}님이 작성 중…`;
}

/**
 * 문장을 **조각**으로. 이름과 나머지를 화면에서 다르게 칠할 수 있게 한다
 * (design-review PR 1059 M-1).
 *
 * 1차에서는 문장 전체가 한 문자열이었고, 그래서 「이름 색」이라는 대조축을 문서로만
 * 주장하고 마크업에는 두지 않았다. 그 축이 없으면 **작업 중 줄이 없을 때** — 즉
 * 에이전트 턴이 없는 대부분의 시각 — 사람 줄이 가진 단서는 「작성」과 「작업」을 가르는
 * 한 음절과 「님」뿐이 된다. 나란히 두는 배치만으로는 학습이 일어나지 않는다.
 *
 * 집계 문구(「3명이 작성 중…」)에는 이름이 없으므로 조각도 없다 — 그 문장은 통째로
 * 부수적 정보이고, 강조할 이름이 애초에 없다.
 */
export type TypingSegment =
  | { kind: "name"; text: string }
  | { kind: "plain"; text: string };

export function typingSegments(
  names: string[],
  threshold: number = TYPING_AGGREGATE_THRESHOLD_FALLBACK
): TypingSegment[] {
  if (names.length === 0) return [];
  const limit = nameLimit(threshold);
  if (names.length > limit) {
    return [{ kind: "plain", text: `${names.length}명이 작성 중…` }];
  }
  const kept = names.slice(0, limit);
  const segments: TypingSegment[] = [];
  kept.forEach((name, index) => {
    if (index > 0) segments.push({ kind: "plain", text: ", " });
    segments.push({ kind: "name", text: name });
  });
  segments.push({ kind: "plain", text: "님이 작성 중…" });
  return segments;
}

/**
 * 보조기술이 읽을 이름. 문장과 같은 값이지만 말줄임표가 없다 — 스크린리더는 「…」을
 * 「점점점」으로 읽거나 통째로 삼키고, 둘 다 이 줄이 하려는 말이 아니다.
 */
export function typingLabel(
  names: string[],
  threshold: number = TYPING_AGGREGATE_THRESHOLD_FALLBACK
): string | null {
  const sentence = typingSentence(names, threshold);
  return sentence === null ? null : sentence.replace("…", "");
}

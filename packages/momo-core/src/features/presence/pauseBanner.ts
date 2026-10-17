import type { PresenceStatus } from "../../lib/api";
import { pauseUntilStateLabel } from "./pauseUntil";

// =============================================================================
// 멈춤이 보인다 (ADR-0204 D3, #3923).
//
// 성재 계정은 방해 금지를 고른 뒤 15일 동안 기한 없는 알림 일시 중지 상태였는데 어디에도
// 보이지 않았다(폰 프로필 시트와 웹 설정 › 알림 안에만 있었다). 이 파일은 그 사실을 화면에서
// 한 줄로 말하는 순수 함수와 낱말이다. 폰 인박스 맨 위와 웹 사이드바의 내 이름 아래가 같은
// 판정·같은 문장을 쓰도록 코어에 둔다(`presence/pauseUntil.ts` 가 낱말을 코어에 두는 이유와 같다).
// 모든 함수는 `nowMs` 를 받는다 — 지금 시각을 안에서 읽지 않으니 시험이 시계를 고정한다.
//
// ## 줄은 최대 하나다
//
//   * 알림 일시 중지가 켜져 있으면 「알림 일시 중지 중 · 오후 9:30까지 · 다시 켜기」. 기한 없는
//     행(옛 판이 만든 것)은 「기한 없음」이다. 방해 금지에 묶여 둘 다 켜져 있어도 이 줄이다 —
//     알림이 멈춘 것이 먼저 말할 사실이다.
//   * 일시 중지는 꺼졌는데 선언 상태가 아직 방해 금지이면 「상태는 아직 방해 금지예요 · 풀기」.
//     다른 사람에게는 여전히 방해 금지로 보인다는 사실이다(ADR-0204 D2 마지막 줄).
//   * 둘 다 아니면 줄이 없다.
//
// ## 읽지 못한 것은 말하지 않는다
//
// 알림 규칙을 한 번도 읽지 못했으면(`rulesReady` 거짓) 어느 줄도 세우지 않는다. 일시 중지가
// 켜져 있는지 모르는 채로 방해 금지 줄만 세우면, 둘이 묶여 있는 흔한 경우에 틀린 줄이 먼저 뜬다.
//
// ## 만료는 서버가 말한다
//
// 기한이 지났는지를 이 파일이 판정해 줄을 내리지 않는다. 클라이언트 시계로 풀면 서버와 어긋난
// 채로 「멈춰 있지 않다」고 말하게 된다(서버는 푸시 판정 시점에 기한을 비교한다). 기한이 지난 줄은
// 그대로 남고, `pauseBannerElapsed` 가 「서버에 다시 물을 때」만 알려 준다. 줄이 사라지는 것은
// 서버의 새 답이 도착했을 때다.
// =============================================================================

/** 어느 줄이 서는가. */
export type PauseBannerKind = "paused" | "dnd";

/** 줄의 제목 — 알림 일시 중지가 켜져 있을 때. */
export const PAUSE_BANNER_PAUSED_TITLE = "알림 일시 중지 중";
/** 알림 일시 중지만 끄는 단추. 방해 금지 상태는 건드리지 않는다. */
export const PAUSE_BANNER_RESUME_ACTION = "다시 켜기";
/** 줄의 제목 — 일시 중지는 꺼졌지만 선언 상태가 아직 방해 금지일 때. */
export const PAUSE_BANNER_DND_TITLE = "상태는 아직 방해 금지예요";
/** 선언 상태를 풀어(`auto`) 방해 금지를 끄는 단추. */
export const PAUSE_BANNER_DND_ACTION = "풀기";

const SEPARATOR = " · ";

export interface PauseBannerInput {
  /** 알림 규칙을 서버에서 한 번이라도 읽었는가. 못 읽었으면 어느 줄도 세우지 않는다. */
  rulesReady: boolean;
  /** 알림 일시 중지(서버 `notification_rule.dnd`, 만료는 서버가 반영한 유효 값)가 켜져 있는가. */
  paused: boolean;
  /** 진행 중인 알림 일시 중지의 기한(에폭 ms). 켜져 있는데 비어 있으면 기한 없는 행이다. */
  untilMs?: number;
  /** 내 선언 상태. 명부를 아직 못 읽었으면 `undefined`. */
  declared?: PresenceStatus;
  /** 선언 상태가 방해 금지일 때의 기한(명부의 `dndUntilMs`). */
  declaredUntilMs?: number;
}

export interface PauseBanner {
  kind: PauseBannerKind;
  /** 「알림 일시 중지 중」 또는 「상태는 아직 방해 금지예요」. */
  title: string;
  /** 일시 중지 줄만 가진다 — 「오후 9:30까지」 또는 「기한 없음」. */
  detail?: string;
  /** 단추 이름 — 「다시 켜기」 또는 「풀기」. */
  action: string;
  /** 화면 낭독용 한 문장 — 「알림 일시 중지 중 · 오후 9:30까지 · 다시 켜기」. */
  label: string;
  /** 이 줄이 기대는 기한. 지나면 서버에 다시 물을 때다(`pauseBannerElapsed`). */
  untilMs?: number;
}

/**
 * 지금 세울 줄. 서지 않으면 `null`.
 *
 * 일시 중지가 먼저다: 방해 금지에 묶여 둘 다 켜져 있으면 알림이 멈춘 줄을 말한다.
 */
export function pauseBanner(
  input: PauseBannerInput,
  nowMs: number
): PauseBanner | null {
  if (!input.rulesReady) return null;
  if (input.paused) {
    const detail = pauseUntilStateLabel(input.untilMs, nowMs);
    return {
      kind: "paused",
      title: PAUSE_BANNER_PAUSED_TITLE,
      detail,
      action: PAUSE_BANNER_RESUME_ACTION,
      label: [PAUSE_BANNER_PAUSED_TITLE, detail, PAUSE_BANNER_RESUME_ACTION].join(
        SEPARATOR
      ),
      untilMs: input.untilMs,
    };
  }
  if (input.declared === "dnd") {
    return {
      kind: "dnd",
      title: PAUSE_BANNER_DND_TITLE,
      action: PAUSE_BANNER_DND_ACTION,
      label: [PAUSE_BANNER_DND_TITLE, PAUSE_BANNER_DND_ACTION].join(SEPARATOR),
      untilMs: input.declaredUntilMs,
    };
  }
  return null;
}

/**
 * 줄이 기대는 기한이 지났는가 — **서버에 다시 물을 때**다. 줄을 내리는 판정이 아니다: 줄은
 * 서버의 새 답이 도착해 `pauseBanner` 가 `null` 을 낼 때 사라진다.
 */
export function pauseBannerElapsed(
  banner: PauseBanner | null,
  nowMs: number
): boolean {
  return banner?.untilMs !== undefined && banner.untilMs <= nowMs;
}

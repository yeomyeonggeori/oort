import { elapsedLabel } from "../agents/workingSignal";
import {
  ELAPSED_SUB_SECOND,
  WORKED_ELAPSED_LABEL,
  formatElapsed,
} from "../timeline/completionReportCard";
import type { WorkRowState, WorkSessionStatusKey } from "./workSessionModel";

// =============================================================================
// Presentation constants for the 작업 세션 panel: one token color per state,
// text first, no pulse (design-taste-web §8). Kept beside the model rather than
// inside a component so the list and the detail cannot drift into two colors
// for one fact, and kept in a .ts so nothing here is a fast-refresh boundary.
// =============================================================================

/**
 * Session ledger state. 호스트 연결 끊김 wears the accent because it is the one
 * state waiting on a PERSON (resume it, or let it go), the same way the timeline
 * card paints 승인 대기. Every other state stays neutral — including 종료됨.
 *
 * 종료됨 wore --ok until #1491, on the reasoning that a lifecycle which ended
 * cleanly deserved the clean colour. Two things retired that. First, since
 * #1441 a VERIFICATION chip stands on the same row, and its green is the one a
 * gate table earned (「통과 12」): beside it a lifecycle green says only that the
 * session stopped, which is the least informative thing the row reports, so the
 * reader now has to work out which of two greens meant something. Second, this
 * file already settled the same question one table down — 완료 steps are muted
 * because a wall of green is not a reading aid — and a ledger that answers it
 * differently from its own rows is two rules, not one. So the green that
 * survives on this surface is the one that reports a measurement, and the
 * lifecycle says what it is in words.
 *
 * ## 그릇은 하나이고, 그것은 톤이 없다 (#1515 / design-review #1514 H-2)
 *
 * 앞 판의 바탕은 `--surface-hover` 였는데 그 토큰은 **행이 주목받았다**는 상태의
 * 이름이다(목록 행의 hover 와 펼침이 같은 값을 쓴다). 그래서 사람이 가리키고 있는
 * 행에서 칩 바탕과 행 바탕이 한 픽셀도 다르지 않았고(대비 1.00) 그릇이 사라졌다 —
 * 읽히는 순간에만 사라지는 그릇이다. 상태는 켜졌다 꺼지고 그릇은 늘 거기 있어야
 * 하므로 둘은 한 값을 나눠 가질 수 없다. 이제 그릇은 자기 토큰(`--muted-soft`)을
 * 갖고, `--surface-hover` 는 상호작용 상태 전용으로 돌아간다.
 *
 * 그릇이 **여섯 칸 전부 같은 값**인 것은 이 표의 결정이다. 원장의 칩은 이 세션을
 * 무엇이라 부르는지를 말할 뿐 아무것도 재지 않으므로, 그릇에 색을 얹을 근거가
 * 없다 — 색을 버는 것은 측정이고, 측정을 나르는 칩은 옆에 따로 선다(검증 칩,
 * #1441). 그래서 톤은 잉크에만 남는다: 도는 세션의 warn, 사람을 기다리는 세션의
 * accent, 나머지의 muted. `orphaned` 가 `--accent-soft` 를 그릇으로 쓰던 것도 함께
 * 거둔다 — 그 그릇은 이 레포에서 「선택된 행」의 채움이라(사이드바·관제 줄), 칩
 * 하나가 선택 문법을 빌려 입고 있었다.
 *
 * 두 칩이 그릇으로 갈린다는 계약은 그대로다(#1463 리뷰 H1·M1): 원장의 칩은 톤 없는
 * 그릇, 자기 보고의 칩은 자기 톤의 그릇. 그 대조는
 * `clients/web/src/features/work/sessionVerificationTone.test.ts` 가 tokens.css
 * 실측으로 잰다.
 */
export const SESSION_STATUS_CLASS: Readonly<Record<WorkSessionStatusKey, string>> = {
  running: "bg-muted-soft text-warn",
  idle: "bg-muted-soft text-ink-muted",
  unavailable: "bg-muted-soft text-ink-muted",
  orphaned: "bg-muted-soft text-accent",
  done: "bg-muted-soft text-ink-muted",
  unknown: "bg-muted-soft text-ink-muted",
};

/**
 * Step state. 완료 stays muted: a wall of green is not a reading aid.
 *
 * 그릇은 위 표와 같은 값이다(#1515). 이 칩이 서는 자리는 미리보기 패널
 * (`--surface-raised`)이라 `--surface-hover` 를 그릇으로 써도 행의 주목 상태와
 * 부딪히지는 않았다 — 즉 여기엔 H-2 가 없었다. 그래도 함께 옮기는 이유는 규칙이
 * 파일 하나에 둘일 수 없기 때문이다: 「상호작용 상태 토큰은 정적인 그릇이 될 수
 * 없다」를 팔레트에 적어 놓고 바로 아래 표가 그것을 어기면, 다음 사람은 두 표 중
 * 어느 쪽이 규칙인지 고르게 된다. 이 파일은 이미 그 물음에 답해 두었다 —
 * 「한 파일 안의 두 표가 같은 답을 낸다」(`sessionStatusClass.test.ts`).
 */
export const ROW_STATE_CLASS: Readonly<Record<WorkRowState, string>> = {
  running: "bg-muted-soft text-warn",
  pending: "bg-muted-soft text-accent",
  done: "bg-muted-soft text-ink-muted",
  error: "bg-muted-soft text-danger",
};

/** Wall clock for a row, HH:MM. Numbers carry data-numeric at the call site. */
export function clockLabel(atMs: number): string {
  const at = new Date(atMs);
  return `${String(at.getHours()).padStart(2, "0")}:${String(
    at.getMinutes()
  ).padStart(2, "0")}`;
}

/** Wall clock with seconds, for the panel's "마지막 갱신" line. */
export function freshnessLabel(atMs: number): string {
  const at = new Date(atMs);
  return `${clockLabel(atMs)}:${String(at.getSeconds()).padStart(2, "0")}`;
}

/**
 * How long the stream has actually been silent, in words.
 *
 * The survival signal turns on at SLOW_STEP_MS, and the copy used to state that
 * THRESHOLD ("10초 넘게 새 신호가 없습니다") no matter how long the silence had
 * really run: a five minute gap read as ten seconds, which is the threshold
 * masquerading as an observation. The number a reader needs in order to decide
 * whether to wait or to intervene is the elapsed one, so that is the number
 * every surface says.
 */
export function silenceLabel(sinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

// ---- 경과: 시계인가, 성과인가 (UXC-C / 커서 웹 ADE 벤치마크 §3-C) ------------
//
// 같은 숫자가 두 가지 다른 말을 한다. 아직 도는 세션에서 경과는 **시계**다 —
// 사람이 기다릴지 말지를 그 눈금으로 정한다. 끝난 세션에서 같은 숫자는 시계가
// 아니라 **성과의 단위**다: 24분이 스크롤로 흘러가 버린 것이 아니라 24분어치의
// 일이 남았다는 서술이고, 완료 리포트 카드가 「작업 시간 24분 28초」로 이미 그렇게
// 말한다(#1440). 이 함수는 그 문법을 세션 표면으로 옮긴다.
//
// **계보를 새로 만들지 않는다.** 두 갈래가 이미 있고 각자 자기 일을 계속한다:
//
//   * 도는 시계 = `workingSignal.elapsedLabel` ("3m 12s"). 초를 0으로 채우고
//     자릿폭을 고정할 수 있어, 1초마다 다시 그려도 옆 글자가 밀리지 않는다.
//   * 끝난 성과 = `completionReportCard.formatElapsed` ("24분 28초"). 큰 두 단위만
//     말해 스톱워치 눈금이 아니라 사람의 낱말이 된다. 숫자와 한글이 섞이므로
//     자릿폭 고정을 걸지 않는다(그 함수 독스트링 — 걸면 음절 사이가 벌어진다).
//     `numeric` 이 그 사실을 부르는 쪽에 넘긴다.
//
// 그리고 **시작이 관측되지 않았으면 아무것도 그리지 않는다**(`null`).
// `workingSignal` 머리말의 그 규율 그대로다: 「0s」는 우리가 눈치챈 순간이지
// 에이전트가 시작한 순간이 아니고, 아무도 행동할 수 없는 숫자는 없는 것보다 나쁘다.
// 시각이 어긋난 봉투(끝이 시작보다 앞선다)도 같은 자리로 떨어진다 — `formatElapsed`
// 가 음수에 빈 문자열을 내고, 이 함수는 빈 낱말을 그리지 않는다.

/** 경과 한 칸이 그리는 전부. `null` 이면 그릴 것이 없다(시계를 짓지 않는다). */
export interface SessionElapsedReadout {
  /** 아직 도는 시계인가(`clock`), 끝난 일의 성과 서술인가(`worked`). */
  kind: "clock" | "worked";
  /** 라벨 없이 홀로 서는 자리에 설, 격까지 붙은 낱말 전체. */
  label: string;
  /** 라벨이 이 값을 이미 이름 붙인 자리(메타 목록)에 설, 격을 뺀 시간. */
  value: string;
  /** 자릿폭 고정(`data-numeric`/`font-mono`)을 걸어도 되는가. */
  numeric: boolean;
}

// ---- 같은 측정, 세 낱말 (#1468) ---------------------------------------------
//
// 한 화면에서 이 숫자가 세 번 선다: 상세 「스스로 보고한 것」 줄의 홀로 선 조각,
// 세션 정보 dl 의 라벨:값 쌍, 그리고 완료 리포트 카드의 같은 모양 쌍. **형태는
// 자리가 정하고 어근은 하나**라는 것이 결정이다.
//
//   · 라벨 없이 홀로 서는 조각은 자기가 무엇인지 스스로 말해야 하므로 술어다 —
//     「24분 28초 동안 작업」. 이 형태를 라벨 자리로 옮기면 「작업 시간 24분 28초
//     동안 작업」이 되므로 형태 통일은 오답이고, 유지가 답이다.
//   · 라벨:값 쌍인 두 자리는 같은 측정을 말하므로 낱말도 하나다 —
//     `WORKED_ELAPSED_LABEL`(「작업 시간」). 세션 정보가 쓰던 「실행 시간」은
//     형태가 아니라 **어근**이 달랐고, 그 값은 위 조각과 이 함수 한 번의 결과
//     (`.label`/`.value`)라 두 어근이 한 숫자를 두 측정처럼 보이게 했다.
//
// 도는 시계에는 「경과」가 남는다. 아직 총량이 아니기 때문이고, 그 갈림은 아래
// `kind` 가 이미 지고 있다 — 화면이 자기 삼항으로 다시 판정하면 코어가 시계라고
// 부르는 세션에 「작업 시간」 라벨이 붙는 날이 온다.

/**
 * 끝난 세션의 경과에 붙는 격. 「24분 28초」가 눈금이 아니라 산출로 읽히게 하는
 * 낱말이고, 카피는 여기 한 곳에만 있다.
 */
export const SESSION_WORKED_SUFFIX = "동안 작업";

/**
 * 같은 격, 조사 없이. 「동안」은 기간 명사만 받는데 `ELAPSED_SUB_SECOND` 는 기간이
 * 아니라 비교 표현이라 「1초 미만 동안 작업」은 문장이 되지 못한다. 값을 바꾸는
 * 대신(그 값은 카드도 함께 쓴다) 이 한 자리에서 조사를 떨어뜨린다 — 라벨 자리는
 * 「작업 시간 1초 미만」으로 이미 문법이 서 있어 손댈 것이 없다.
 *
 * 조사를 화면 밖에서 정하는 것은 이 레포의 기존 판단이다(`lib/koreanParticle` —
 * 「Hermes이(가)」는 번역이 아니라 기계가 읽는 사람 앞에서 결정을 미룬 것이다).
 */
export const SESSION_WORKED_BARE_SUFFIX = "작업";

/**
 * 라벨:값 쌍인 자리(세션 정보 dl)가 이 경과를 부르는 이름. 갈림의 근거는 화면의
 * 삼항이 아니라 `SessionElapsedReadout.kind` 다 — 위에 선 조각이 시계인지 성과인지와
 * **같은 판정**이 라벨을 고른다.
 */
export const SESSION_ELAPSED_META_LABEL: Readonly<
  Record<SessionElapsedReadout["kind"], string>
> = {
  clock: "경과",
  worked: WORKED_ELAPSED_LABEL,
};

/**
 * 이 세션의 경과를 무엇으로 말할 것인가 (UXC-C).
 *
 * 갈림의 기준은 세션 상태가 아니라 **끝난 시각이 관측됐는가**다. 상태로 가르면
 * 서버가 아직 `running` 이라 부르는 고아 세션이 끝난 격으로 서고, 반대로 끝났다고
 * 표시된 세션이 끝난 시각 없이 「몇 분 동안 작업」이라는 지어낸 숫자를 얻는다.
 * 원장이 끝을 적어 둔 세션만 성과로 말한다 — 세션 정보의 「경과/작업 시간」 라벨도
 * 이제 이 `kind` 하나로 갈린다(`SESSION_ELAPSED_META_LABEL`).
 */
export function sessionElapsedReadout(
  session: { startedAtMs?: number | null; endedAtMs?: number | null },
  nowMs: number
): SessionElapsedReadout | null {
  const startedAtMs = session.startedAtMs;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) {
    return null;
  }
  const endedAtMs = session.endedAtMs;
  if (typeof endedAtMs === "number" && Number.isFinite(endedAtMs)) {
    const value = formatElapsed(endedAtMs - startedAtMs);
    if (value === "") return null;
    const suffix =
      value === ELAPSED_SUB_SECOND
        ? SESSION_WORKED_BARE_SUFFIX
        : SESSION_WORKED_SUFFIX;
    return {
      kind: "worked",
      label: `${value} ${suffix}`,
      value,
      numeric: false,
    };
  }
  const clock = elapsedLabel(startedAtMs, nowMs);
  return { kind: "clock", label: clock, value: clock, numeric: true };
}

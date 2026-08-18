import type { Message } from "../../lib/api";
import {
  COMPLETION_CHECK_SEVERITY,
  completionCheckCounts,
  completionReportCard,
  type CompletionCheckOutcome,
  type CompletionOutcome,
  type CompletionReportCard,
} from "../timeline/completionReportCard";

// =============================================================================
// 세션의 검증 상태 (UXC-C / 커서 웹 ADE 벤치마크 §3-C)
//
// 「이 세션은 검증됐는가」를 세션 표면이 한 칸으로 말할 수 있게 하는 판정이다.
// 새 어휘도 새 원장도 아니다 — 완료 리포트 카드가 이미 게이트 결과를 네 낱말과
// 네 톤으로 갈라 뒀고(`completionReportCard`), 여기서는 그 표를 **한 세션 단위로**
// 접기만 한다.
//
// ## 데이터 원천: 그 세션의 스레드에 실제로 남은 리포트
//
// 세션은 채널 카드 하나(`rootMessageId`)를 갖고 그 **스레드가 세션의 원장**이다 —
// 진행 내역이 거기 쌓이고, 발췌 공유도 거기로 쓴다. 그러므로 그 스레드에 남은
// `completion_report` 메시지는 링크를 지어내지 않고도 이 세션의 것임이 증명된다.
// 세션에서 에이전트 run 으로 가는 서버 경로는 없으므로(`WorkSessionDetail` 머리말)
// 채널 본문에 남은 리포트를 이 세션의 것이라 주장하지 않는다. 그런 리포트가 이
// 표면에 서야 한다면 그것은 새 read-model 이고, 표시 규칙이 아니라 별도 티켓이다.
//
// ## 그 스레드를 **어느 방향으로** 읽는가 (#1463)
//
// 위 문단은 어느 행이 이 세션의 것인지를 정하고, 이 문단은 그 행에 **닿는 법**을
// 정한다. 두 문제가 앞 판(#1441)에 남아 있었다:
//
//   1. 목록 행은 스레드를 읽지 않는다. 세션마다 `/replies` 를 한 통씩 더 여는 것은
//      행 수만큼 늘어나는 왕복이다.
//   2. `/replies` 는 **오래된 쪽부터**만 페이지된다(`thread_replies_sql` 은
//      `seq > $3 ORDER BY seq ASC`, 내림차순이 없다). 그래서 창(5×200)이 절단하는
//      것은 정확히 **가장 최근 리포트**이고, 리포트가 가장 필요한 초장기 세션에서
//      칩이 영구히 부재였다(grok freeze H2).
//
// 둘 다 방향의 문제였고, 방향을 바꿀 수 있는 읽기가 이미 서버에 있다: **채널
// 히스토리**(`GET …/channels/{ch}/messages`)는 기본이 최신부터(DESC)이고, 서버는
// 스레드 답글을 거기서 걸러내지 않는다(`list_channel_page` 에 `root_id IS NULL`
// 술어가 없다 — 클라 쪽 같은 진술: `clients/mobile/.../useTimeline.ts` 머리말).
// 그러므로 완료 리포트는 그 페이지에 실려 오고, 실린 행의 `rootId` 가 그것이 어느
// 세션의 것인지를 위 문단과 **똑같은 근거로** 증명한다. 새 스키마도 새 서버 투영도
// 필요 없다.
//
// 이 방향에서는 절단이 안전하다. 최신부터 읽으므로 예산이 잘라내는 것은 가장
// **오래된** 쪽이고, 어떤 스레드에 대해 처음 만난 리포트가 곧 그 스레드의 최신
// 리포트다 — 10,000행짜리 세션에서도 첫 페이지에서 도달한다. 아래
// `threadCompletionReports` 가 그 접기이고, 순서에 기대지 않도록 `seq` 로 직접
// 비교한다(부르는 쪽의 페이지 순서가 계약이 되면 안 된다).
//
// ## 없는 것을 이야기로 승격하지 않는다 (ADR-0132)
//
// 네 자리에서 **판정이 없다**(`null`)를 낸다. 「미검증」이라는 낱말은 어디에도
// 만들지 않는다 — 리포트가 없는 것은 검증에 실패한 것이 아니라 이 세션이 아직
// 아무 말도 하지 않은 것이다:
//
//   1. 스레드에 리포트가 하나도 없다.
//   2. 리포트는 있으나 게이트 표가 비었다. `completionOutcome([])` 은 「완료」이고,
//      그 낱말을 게이트 한 칸 없는 리포트 위에 세우면 화면이 하지 않은 검증을
//      통과라고 말한다.
//   3. 부르는 쪽이 스레드를 **다 읽지 못했다**(절단). 그때 없는 것은 정확히 가장
//      최근 리포트라, 접힌 판정은 지난 이야기다.
//   4. 리포트의 **게이트 표 자체가 상한에 잘렸다**(`card.omitted`). 아래
//      `latestSessionVerification` 머리말이 왜인지 적는다 — 3번과 같은 규율이
//      한 층 안쪽에서 한 번 더 필요하다.
// =============================================================================

/** 세션 스레드에서 발견된 완료 리포트 하나. */
export interface SessionCompletionReport {
  card: CompletionReportCard;
  /** 채널 seq — 어느 리포트가 최신인가의 정본(`message.seq`). */
  seq: number;
  /** 서버 시각. seq 가 같을 때만 쓰이는 보조 순서. */
  atMs: number;
}

/**
 * 이 스레드 답글이 완료 리포트인가. 파싱은 코어 계약을 **그대로** 부르고
 * (`completionReportCard`) 여기서는 순서에 쓸 두 숫자만 얹는다.
 *
 * 지워진 메시지는 리포트가 아니다: 거둬들인 보고가 계속 세션의 상태를 주장하면,
 * 화면은 사람이 이미 취소한 말을 대신 하고 있게 된다.
 */
export function sessionCompletionReport(
  message: Message
): SessionCompletionReport | null {
  if (message.state === "deleted") return null;
  const card = completionReportCard(message.props);
  if (card === null) return null;
  return { card, seq: message.seq, atMs: message.hlcTs };
}

/**
 * 어느 리포트가 더 최신인가. 정본은 `message.seq`(채널 안에서 빈틈없이 증가)이고,
 * 서버 시각은 seq 가 같을 때만 쓰이는 보조 순서다.
 *
 * 함수로 빼 둔 이유는 이 비교가 이제 **두 자리**에서 필요하기 때문이다: 한 스레드를
 * 통째로 읽은 목록에서 최신 하나를 고를 때(`latestSessionVerification`)와, 채널
 * 히스토리에서 스레드별로 접을 때(`threadCompletionReports`). 두 사본이 갈라지면
 * 같은 두 리포트를 두고 표면마다 다른 답이 나온다.
 */
function isNewerReport(
  candidate: SessionCompletionReport,
  held: SessionCompletionReport
): boolean {
  if (candidate.seq !== held.seq) return candidate.seq > held.seq;
  return candidate.atMs > held.atMs;
}

/**
 * 채널 히스토리에서 건져낸, **어느 세션 스레드의 것인지 아는** 완료 리포트.
 *
 * `rootId` 는 소문자로 접혀 있다: UUID 는 와이어를 섞인 대소문자로 건너오므로
 * (`lib/api` 머리말) 지도의 키가 대소문자에 걸리면 같은 스레드가 둘로 갈라진다.
 */
export interface ThreadCompletionReport extends SessionCompletionReport {
  rootId: string;
}

/**
 * 채널 히스토리 한 뭉치에서 **스레드별 최신 완료 리포트**를 건져낸다 (#1463).
 *
 * 머리말 「그 스레드를 어느 방향으로 읽는가」가 이 함수의 전부다. 부르는 쪽이
 * 최신부터 읽어 오지만 이 접기는 그 순서에 기대지 않는다 — `seq` 로 직접 비교하므로
 * 페이지를 어떤 순서로 이어 붙여도 답이 같다.
 *
 * `rootId` 가 없는 행(채널 본문)은 **버린다**. 세션에서 run 으로 가는 서버 경로가
 * 없으므로 채널 본문의 리포트를 어느 세션의 것이라 주장할 수 없다는 머리말 규율
 * 그대로다 — 방향을 바꾼 것이지 소속 규칙을 넓힌 것이 아니다.
 */
export function threadCompletionReports(
  messages: readonly Message[]
): ThreadCompletionReport[] {
  const newest = new Map<string, ThreadCompletionReport>();
  for (const message of messages) {
    const rootId = message.rootId;
    if (rootId === undefined) continue;
    const report = sessionCompletionReport(message);
    if (report === null) continue;
    const key = rootId.toLowerCase();
    const held = newest.get(key);
    if (held === undefined || isNewerReport(report, held)) {
      newest.set(key, { ...report, rootId: key });
    }
  }
  return [...newest.values()];
}

/**
 * 이 세션(`WorkSession.rootMessageId`)의 리포트, 또는 없음.
 *
 * 목록도 미리보기도 상세도 같은 한 줄을 지나게 하려고 함수로 있다. 없음은
 * 「이 스캔이 닿은 범위에 리포트가 없었다」이지 「검증되지 않았다」가 아니다.
 */
export function reportForRoot(
  reports: readonly ThreadCompletionReport[] | undefined,
  rootMessageId: string
): ThreadCompletionReport | null {
  if (reports === undefined) return null;
  const key = rootMessageId.toLowerCase();
  return reports.find((report) => report.rootId === key) ?? null;
}

/** 세션 한 칸이 말하는 검증 상태. */
export interface SessionVerification {
  /** 카드 머리와 같은 판정 — 실패가 하나라도 있는가(`completionOutcome`). */
  outcome: CompletionOutcome;
  /** 결과별 게이트 수. 코어 집계 그대로(`completionCheckCounts`). */
  counts: Readonly<Record<CompletionCheckOutcome, number>>;
  /** 칩이 말할 한 칸: 표에서 **가장 나쁜** 결과. */
  lead: CompletionCheckOutcome;
  /** 그 결과의 게이트 수. */
  leadCount: number;
  /** 이 판정을 실은 리포트의 서버 시각. */
  atMs: number;
}

/**
 * 어휘 전체를 심각한 순으로. 순회 순서를 고정해 두는 이유는 `Object.keys` 가
 * 계약이 아니기 때문이다 — 순서가 우연이면 접기의 답도 우연이 된다.
 */
const COMPLETION_CHECK_ORDER: readonly CompletionCheckOutcome[] = [
  "fail",
  "unknown",
  "pending",
  "pass",
  "skip",
];

/**
 * 이 세션이 지금 말하는 검증 상태. 여러 리포트가 남았으면 **가장 최근 것**이다
 * (세션은 여러 번 끝날 수 있고, 두 번째 리포트는 첫 번째를 갱신한다).
 *
 * 부르는 쪽은 이제 두 원천을 **한 배열로 합쳐** 넣는다 (#1463): 채널 히스토리
 * 스캔이 이 스레드에 대해 찾은 리포트와, 절단 없이 통째로 읽힌 스레드 페이지의
 * 리포트들. 합치기가 성립하는 이유는 둘 다 각자의 조건에서 **자기 원천의 최신**임이
 * 보장되기 때문이다 — 스캔은 최신부터 읽으므로 처음 만난 것이 최신이고, 절단되지
 * 않은 스레드 읽기는 그 스레드 전부를 봤다. 최신 둘 중 더 최신인 것은 최신이다.
 * 절단된 스레드 페이지는 **넣지 않는다**(그때 없는 것이 정확히 가장 최근 리포트라,
 * 넣으면 지난 이야기가 최신 행세를 한다).
 *
 * 접는 방향은 카드의 그것과 같다: 한 칸만 그릴 수 있으면 **가장 나쁜 칸**을
 * 그린다(`COMPLETION_CHECK_SEVERITY` — 웹 표의 겹친 셀이 실패를 앞에 세우는 그
 * 순위 그대로). 실패는 어떤 접기로도 사라지지 않는다는 것이 그 순위의 계약이고,
 * 한 칸으로 접을 때야말로 그 계약이 필요하다.
 *
 * **잘린 표에서는 접지 않는다**(리뷰어 C G-M1). 코어 파서는 상한(M3)에 걸린
 * 게이트를 잘라 `gates` 에 담고 개수만 `omitted` 에 남기는데, 카드 머리의 판정은
 * **자르기 전 전체**로 재기 때문에 그 둘은 서로 다른 표를 본다. 그것이 카드에서는
 * 안전하다 — 표가 「그 밖에 N개 더」라고 말하고 머리 칩은 여전히 「확인 필요」다.
 * 그런데 그 표를 한 칸으로 접으면 잘린 꼬리의 실패가 화면에서 사라진다: 한 표면에
 * 통과 40 + 실패 1이면 41번째 칸이 잘려 나가고, 칩은 「통과 40」(ok)이 된다.
 * 카드가 막아 둔 거짓말을 접기가 다시 여는 것이다. 접을 수 없는 표에서는 침묵이
 * 옳다 — 스레드를 다 읽지 못했을 때 판정하지 않는 것과 같은 규율이 한 층 안쪽에서
 * 한 번 더 필요할 뿐이다.
 */
export function latestSessionVerification(
  reports: readonly SessionCompletionReport[]
): SessionVerification | null {
  let newest: SessionCompletionReport | null = null;
  for (const report of reports) {
    if (newest === null || isNewerReport(report, newest)) newest = report;
  }
  if (newest === null) return null;
  const omitted = newest.card.omitted;
  // 잘린 표는 접지 않는다 (G-M1). `actions` 는 「한 일」 불릿이라 게이트 표와
  // 무관하므로 보지 않는다.
  if (omitted.gates > 0 || omitted.checks > 0) return null;
  const counts = completionCheckCounts(newest.card.gates);
  let lead: CompletionCheckOutcome | null = null;
  for (const outcome of COMPLETION_CHECK_ORDER) {
    if (counts[outcome] === 0) continue;
    if (
      lead === null ||
      COMPLETION_CHECK_SEVERITY[outcome] < COMPLETION_CHECK_SEVERITY[lead]
    ) {
      lead = outcome;
    }
  }
  // 게이트 표가 빈 리포트는 검증에 대해 아무 말도 하지 않았다(머리말 2).
  if (lead === null) return null;
  return {
    outcome: newest.card.outcome,
    counts,
    lead,
    leadCount: counts[lead],
    atMs: newest.atMs,
  };
}


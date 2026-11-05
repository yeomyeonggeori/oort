// =============================================================================
// 불러온 범위 밖(더 오래된 쪽)의 메시지로 가는 점프 — 그 자리까지 거슬러 읽는 계획 (#5383)
//
// 점프 문(`ConversationScreen.requestJump` → `Timeline` 의 `jumpTarget`)은 목적지가 이 목록에
// 없으면 「더 위쪽에 있습니다」 고지만 세우고 멈췄다. 검색 결과·고정·인용·기억 근거는 대부분
// 오래된 글이라, 그 한 줄이 실제 사용에서 가장 흔한 결말이었다. 이제 화면이 그 자리까지 목록의
// `before` 쪽 넘김을 **이어서 읽고**(`useTimeline.seekOlder`) 도착하면 같은 문으로 다시 쏜다.
// 이 파일은 그 읽기의 **수치와 판정**만 든다 — 순수 함수라 화면 없이 잴 수 있다.
//
// ## 왜 거리를 먼저 재는가
//
// 채널의 `seq` 는 연속이고, `GET …/messages?before=` 는 `seq` 가 그보다 작은 줄을 **빠짐없이**
// 최근 순으로 준다(스레드 답글·묘비 포함: `channel_page_sql` 에 `root_id`·`deleted_at` 필터가
// 없다). 그래서 「든 가장 오래된 seq − 목적지 seq」가 읽어야 할 줄 수의 **상한**이고, 몇 쪽이 필요한지
// 한 건도 읽기 전에 안다. 상한을 넘을 거리면 읽지 않고 곧장 지금의 고지로 물러난다 — 끝내 못 닿을
// 읽기에 사람을 세워 두지도, 이미 쓴 데이터를 버리지도 않는다.
//
// ## 상한 값과 이유
//
//   쪽 크기 200  = 서버가 받아 주는 최대(`HISTORY_LIMIT_MAX`, `clamp_history_limit`). 손으로 위로 올릴
//                  때의 50(`useTimeline.PAGE_LIMIT`)보다 크게 잡아 왕복을 줄인다 — 읽는 동안 사람은
//                  기다리는 쪽이고, 화면에는 한 번에 합쳐지므로 쪽이 커도 목록이 자라는 모습을 보지 않는다.
//   최대 10쪽    = 2,000줄. 활발한 채널의 며칠~몇 주, 보통 팀 채널의 몇 달이다. 그보다 멀면 직렬
//                  왕복이 10번을 넘고(느린 망에서 수 초~수십 초) 휴대폰이 들 줄 수도 한 번에 자란다.
//                  「수천 건 뒤」의 오래된 글은 이 길로 닿지 않는다 — 서버의 seq 주변 읽기(`around`)가
//                  필요하다. 그것은 공개 API 변경이라 이 이슈 밖이다(별도 이슈, ADR 필요).
//   맥락 20줄    = 마지막 쪽이 목적지 **위로** 더 가져오는 줄. 목적지를 화면 가운데에 놓으려면 그 위에도
//                  줄이 있어야 한다(`Timeline` 의 착지는 가운데 정렬). 없으면 목적지가 목록 맨 위에 붙어
//                  가운데로 못 간다.
//
// ## 합친 직후의 먼 점프는 목록이 앉을 시간을 준다 (시뮬레이터 실측, #5383)
//
// 읽은 쪽을 합친 **같은 커밋**에서 점프를 다시 걸면, 목록이 아직 안 잰 위쪽 줄 수천 개를 받은 채 `scrollToIndex` 를 부르게 된다.
// 하네스(`measure/jumpSeek.tsx`, 진짜 `Timeline`·iPhone 17 Pro 시뮬레이터, 머리 30줄 위 N줄에 목적지)에서 잰 것:
//
//     N = 28줄(한 쪽)·300줄·800줄  같은 커밋이어도 목적지가 화면 가운데 근처에 앉았다.
//     N = 1,800줄                  같은 커밋: **앉지 못하고** 목적지에서 1,500줄 넘게 떨어진 곳에서 멈췄다(6.5초 뒤에도 그대로).
//                                  합친 뒤 150ms: 목적지가 화면 위 삼분의 일에 앉았다(가운데 아님). 500ms: 가운데.
//
// 점프의 이동(`Timeline.travelToIndex`)은 1.5초 안에 끝나거나 거둬지는데(`JUMP_TRAVEL_MAX_MS`), 많은 줄을 받은 직후에는 그 시간의
// 일부를 목록이 새 줄을 받아 앉는 데 쓴다. 그래서 합친 줄이 많을수록 점프를 **다른 커밋에서, 그만큼 늦게** 건다. 아래 값은 위 실측의
// 보수적 보간이다: 300줄까지는 기다리지 않고(실측 통과), 그 위로는 줄 3개마다 1ms, 상한 500ms(1,800줄 통과 값). **실기기는 더 느릴 수
// 있다** - 이 값은 시뮬레이터 실측이고 기기에서는 검증 줄이 먼 거리(1,000줄 이상)를 한 번 더 확인해야 한다.
// =============================================================================

/** 한 쪽에 요청하는 줄 수의 상한 — 서버의 최대(200)다. */
export const SEEK_PAGE_LIMIT = 200;

/** 한 번의 이동에서 읽는 쪽 수의 상한. 값과 이유는 위 머리말. */
export const SEEK_MAX_PAGES = 10;

/** 이 거리(줄 수)를 넘으면 읽지 않고 고지로 물러난다. */
export const SEEK_MAX_ROWS = SEEK_PAGE_LIMIT * SEEK_MAX_PAGES;

/** 마지막 쪽이 목적지 위로 더 가져오는 줄 수 — 착지가 가운데 정렬이라 위에도 줄이 있어야 한다. */
export const SEEK_CONTEXT_ROWS = 20;

/** 이 줄 수까지는 합친 직후 곧바로 점프를 다시 건다(같은 커밋 · 실측 통과: 28·300·800줄). */
export const SEEK_SETTLE_FREE_ROWS = 300;

/** 합친 줄이 많아 기다릴 때의 상한(ms) - 1,800줄에서 목적지가 가운데에 앉은 값(실측). */
export const SEEK_SETTLE_MAX_MS = 500;

/**
 * 읽은 쪽을 합친 뒤 점프를 다시 걸기 전에 목록이 새 줄을 받아 앉도록 기다리는 시간(ms). 합친 줄 수는 읽기 전의 거리(`든 가장 오래된
 * seq − 목적지 seq`)와 같다. 근거와 한계는 위 머리말.
 */
export function seekSettleMs(rows: number): number {
  if (rows <= SEEK_SETTLE_FREE_ROWS) return 0;
  return Math.min(
    SEEK_SETTLE_MAX_MS,
    Math.round((rows - SEEK_SETTLE_FREE_ROWS) / 3),
  );
}

/**
 * 읽기 계획. `Read` 만 실제로 읽는다.
 *
 * 문자열이 아니라 숫자 상수 객체인 이유: 사용자 문구가 아닌 상태 이름을 문자열 리터럴로 두면 직접 문구
 * 장부(`direct-copy`)가 문구로 센다. 값이 문구가 아니라는 사실을 형으로 말하는 쪽이 장부를 건드리지 않는다.
 */
export const SeekPlan = {
  /** 목적지가 든 범위 위에 있고, 상한 안이다 — 읽는다. */
  Read: 0,
  /** 목적지가 든 범위 위에 있지만 상한을 넘는다 — 읽지 않고 고지로 간다. */
  TooFar: 1,
  /** 읽을 이유가 없다(순서값을 모르거나, 이미 든 범위 안이거나, 더 오래된 줄이 없다). */
  None: 2,
} as const;
export type SeekPlan = (typeof SeekPlan)[keyof typeof SeekPlan];

/**
 * 이 점프를 위로 읽어서 풀 수 있는가.
 *
 * 기준은 `Timeline` 이 아니라 **훅이 든 가장 오래된 seq**(`state.oldestSeq`)다. 목록(`items`)은 스레드
 * 답글 같은 줄을 걸러서 그린 것이라 그 최솟값은 훅이 든 범위와 다를 수 있다.
 */
export function planSeek({
  heldOldestSeq,
  targetSeq,
  reachedStart,
}: {
  heldOldestSeq: number | null;
  targetSeq: number | null;
  reachedStart: boolean;
}): SeekPlan {
  if (targetSeq === null || heldOldestSeq === null || reachedStart) return SeekPlan.None;
  const rows = heldOldestSeq - targetSeq;
  if (rows <= 0) return SeekPlan.None;
  return rows > SEEK_MAX_ROWS ? SeekPlan.TooFar : SeekPlan.Read;
}

/**
 * 다음 쪽에 요청할 줄 수. 남은 거리에 맥락을 더하되 서버 최대를 넘지 않는다 — 가까운 목적지에
 * 200줄을 받아 오지 않는다.
 *
 * @param cursor 지금까지 읽은 가장 오래된 seq(다음 요청의 `before`).
 * @param untilSeq 닿아야 하는 seq.
 */
export function seekPageLimit(cursor: number, untilSeq: number): number {
  return Math.min(
    SEEK_PAGE_LIMIT,
    Math.max(1, cursor - untilSeq + SEEK_CONTEXT_ROWS),
  );
}

/** `useTimeline.seekOlder` 가 끝난 모양. 숫자 상수 객체인 이유는 `SeekPlan` 과 같다. */
export const SeekOutcome = {
  /** 읽은 범위가 목적지 seq 에 닿았다 — 합쳤고, 다시 쏘면 된다. */
  Arrived: 0,
  /** 채널의 처음까지 읽었다(목적지 seq 에 닿지 못했다) — 읽은 만큼 합쳤다. */
  Start: 1,
  /** 쪽 상한에 닿았다 — 합치지 않았다(화면은 읽기 전 그대로다). */
  Capped: 2,
  /** 읽다가 실패했다 — 합치지 않았다. 다시 시도할 수 있다. */
  Failed: 3,
  /** 사람이 접었거나 방이 바뀌었다 — 합치지 않았다. */
  Cancelled: 4,
} as const;
export type SeekOutcome = (typeof SeekOutcome)[keyof typeof SeekOutcome];

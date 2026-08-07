// =============================================================================
// 타임라인 구분선의 **판정** — 두 클라이언트가 공유하는 정본 (U4-c · chat-ui-audit M-2).
//
// ## 왜 이 파일이 생겼나
//
// U1 진단 M-2: *「날짜 구분선 스타일이 클라마다 다르다 — 웹=좌측 라벨+우측 rule,
// 폰=중앙 라벨+양쪽 rule. 같은 제품인데 폰과 웹이 다른 얼굴을 한다.」*
//
// 두 클라가 각자 `new Date()`를 열어 각자 문자열을 짓고 각자 정렬을 고르는 한, 그
// 차이는 **고쳐도 다시 벌어진다.** 한쪽만 손대는 다음 goal이 반드시 오기 때문이다.
// 그래서 고치는 자리를 화면이 아니라 여기로 옮긴다: 어휘·경계 규칙·간격·라벨이 서는
// 쪽을 이 파일이 정하고, 웹과 폰은 **그리기만** 한다.
//
// 이것은 `chat/typing.ts`가 「작성 중」에 대해 한 것과 같은 구조다. 그 파일이 증명한
// 것이 하나 더 있다: 문장을 통짜 문자열로 넘기면 화면이 그 안의 **숫자를 따로 칠할
// 수 없다.** 그래서 여기서도 라벨은 [`DividerSegment`] 배열로 나간다.
//
// ## 숫자와 산문을 가르는 것이 이 파일의 두 번째 일
//
// 웹의 현행 `DayDivider`는 `data-numeric`(= `tabular-nums`)을 **라벨 전체**에 건다:
//
//     <span data-numeric>2026년 8월 5일</span>
//
// 그 표지는 숫자의 자릿폭을 고정하려고 있는 것인데, 한글 음절까지 함께 잡아 늘린다 —
// 같은 레포가 이미 실측으로 적어 둔 결함이다(`workstreams/model.ts`의 `RunClock`
// 독스트링: *"prose set in the mono stack renders with visibly stretched gaps between
// syllables (「7월  29일」, measured)"*). 그 파일은 그래서 **날짜와 시각을 갈라서**
// 돌려주고, 부르는 쪽이 시각에만 표지를 붙인다.
//
// 같은 결함이 구분선 셋에 전부 있다(`새 메시지 3개, 여기까지 읽음`·`재연결됨, seq
// 3까지 복구`도 통째로 `data-numeric`이다). 여기서는 그 판정을 조각으로 내보내
// 화면이 **숫자에만** 표지를 붙이게 한다.
//
// ## 이 파일이 정하지 않는 것
//
// 색·글꼴 크기·토큰 이름은 각 클라의 것이다. 이 파일이 넘기는 것은 「어느 쪽에
// 서는가」·「얼마나 띄우는가」·「무슨 낱말인가」·「어디가 숫자인가」 넷뿐이고, 그
// 넷이 M-2가 말한 「다른 얼굴」의 전부다.
// =============================================================================

/**
 * 라벨 한 조각. `figure`에만 자릿폭 고정을 건다.
 *
 * 「3개」의 `3`은 figure이고 `개`는 prose다 — 조사와 단위는 한글이라, 같은 표지를
 * 함께 받으면 음절 사이가 벌어진다.
 */
export type DividerSegment =
  | { kind: "figure"; text: string }
  | { kind: "prose"; text: string };

/**
 * 라벨이 서는 쪽. **두 클라의 통일값이고, 값은 `leading`이다** (M-2).
 *
 * 가운데 정렬(폰의 현행)을 기각한 이유는 취향이 아니라 두 가지다:
 *
 *   1. **웹은 이미 셋 다 좌측이다** — 날짜·안읽음·복구 구분선이 한 가족으로 서 있고,
 *      폰만 날짜 하나를 가운데 두고 있었다. 통일 비용이 한쪽으로 훨씬 싸다.
 *   2. **가운데 라벨은 글자 수에 따라 좌우로 움직인다.** 이 줄의 문구는 「오늘」(두
 *      글자)에서 「2025년 12월 31일」(열두 글자)까지 변하는데, 가운데 정렬이면 그
 *      길이 차가 그대로 가로 이동이 된다. 스크롤로 훑을 때 구분선은 **같은 자리에
 *      반복해서 나타나는 표지**여야 눈이 그것을 배경으로 처리한다 — 매번 다른
 *      x에 서면 매번 읽게 된다. 좌측 정렬은 메시지 행의 왼쪽 세로선과도 맞는다.
 *
 * (rule은 라벨 반대편에 한 줄로 남는다. 양쪽 rule은 라벨을 가운데 고정할 때만
 * 의미가 있으므로 위 결정과 함께 사라진다.)
 */
export const DIVIDER_LABEL_SIDE = "leading" as const;

// -----------------------------------------------------------------------------
// 색 계약 (design-review U4-4 D-2)
// -----------------------------------------------------------------------------
//
// 리뷰가 실측한 것: 웹의 안읽음 구분선은 `--accent`(호박 `#a54c08`/`#f0a850`),
// 폰은 `color.warn`(`#d9a441`)이었고 폰의 `accent`는 파랑(`#3b6fd4`)이었다. 두 값이
// 지금 비슷한 호박색이라 **화면에서는 통일되어 보이지만 계약이 아니다.** 어느 한쪽
// 팔레트를 손대는 날 안읽음 경계가 조용히 갈라지고, 이 파일이 「색은 각 클라의
// 것」이라고 명시적으로 물러나 있었으므로 아무도 그것을 잡지 못한다.
//
// **그렇다고 여기에 hex를 적는 것이 답은 아니다.** 두 클라의 팔레트는 서로 다른
// 표면 위에 서 있고(웹은 라이트/다크 두 벌, 폰은 다크 단일), 같은 hex가 두 배경에서
// 같은 뜻을 갖지 않는다. 그래서 여기 올라오는 것은 **값이 아니라 역할**이다:
// 「이 줄은 무엇을 하는 색인가」를 코어가 정하고, 「그 역할을 어느 토큰이 지는가」는
// 클라가 한 자리에 적어 두며, 그 자리가 역할을 실제로 만족하는지는 클라의 계약
// 테스트가 잰다.
//
// U4-4R W-2가 남긴 교훈이 이 설계의 절반이다: 가드는 **실표를 봐야 한다.** 그래서
// 아래 규칙은 산문이 아니라 열거값이고, 웹 쪽 계약 테스트는 `tokens.css`를 직접
// 파싱해 대조한다(`clients/web/src/features/timeline/dividerTone.test.ts`).

/**
 * 구분선이 입는 **역할**. 값이 아니라 역할이다.
 *
 * - `quiet` — 훑는 눈이 배경으로 처리해야 하는 표지. 날짜와 복구가 그렇다: 둘 다
 *   「여기서 무언가 바뀌었다」를 말하지만, 그 사실이 읽기를 멈출 값어치는 없다.
 * - `boundary` — **경계를 그리는 색**. 안읽음 하나뿐이다. 이 줄은 훑다가 멈출 자리를
 *   가리키므로 주변 글보다 앞으로 나와야 하고, 라벨과 rule이 같은 색이어야 한다 —
 *   한 경계는 한 색이다.
 */
export type DividerTone = "quiet" | "boundary";

/** 구분선 세 종류가 각각 지는 역할. 두 클라가 이 표를 그대로 소비한다. */
export const DIVIDER_TONE = {
  day: "quiet",
  unread: "boundary",
  recovery: "quiet",
} as const satisfies Record<"day" | "unread" | "recovery", DividerTone>;

/**
 * 역할의 명세 — 클라의 계약 테스트가 하나씩 재는 항목.
 *
 * `mustDifferFrom`이 이 계약의 심장이다. 「경계를 그리는 색」이 무엇인지는 팔레트마다
 * 다르게 답할 수 있지만, **무엇이 아니어야 하는가**는 두 클라에 공통이다:
 *
 *   - `quiet`와 달라야 한다 — 경계가 배경 표지와 같은 색이면 그것은 경계가 아니다.
 *   - 에이전트 정체(`agent`)와 달라야 한다 — 안읽음은 누구의 정체도 아니다. 이
 *     조건이 없으면 폰처럼 `accent`가 「여기를 보라」를 맡지 않는 팔레트에서 경계가
 *     에이전트 색을 빌려 쓰는 일이 조용히 일어난다.
 *   - 위험(`danger`)과 달라야 한다 — 안 읽은 것은 사고가 아니다.
 *
 * 세 조건은 전부 **같은 스킴 안에서** 잰다. 스킴이 둘인 클라(웹)는 두 번 잰다.
 */
export interface DividerToneSpec {
  /** 이 톤이 답하는 질문. */
  meaning: string;
  /** 라벨과 rule을 **같은** 색으로 칠하는가. */
  paintsRule: boolean;
  /** 이 역할이 절대 같아서는 안 되는 다른 역할들. */
  mustDifferFrom: readonly string[];
}

export const DIVIDER_TONE_SPEC = {
  quiet: {
    meaning: "훑는 눈이 배경으로 처리하는 표지",
    paintsRule: false,
    mustDifferFrom: [],
  },
  boundary: {
    meaning: "여기서부터 아직 읽지 않았다 — 경계를 그리는 색",
    paintsRule: true,
    mustDifferFrom: ["quiet", "agent", "danger"],
  },
} as const satisfies Record<DividerTone, DividerToneSpec>;

/**
 * 구분선의 세로 여백과 rule 두께. 단위는 두 클라가 공유하는 밀도 독립 단위다
 * (CSS px = RN pt).
 *
 * 날짜 구분선이 안읽음/복구보다 위아래로 더 여는 이유는 그것이 **가장 큰 경계**이기
 * 때문이다. 안읽음과 복구는 같은 날 안에서 일어나는 일이라 날짜만큼의 휴지를 요구하지
 * 않고, 셋이 같은 여백을 쓰면 위계가 사라진다(U4-c의 「그룹 내 분절」과 같은 축).
 */
export const DIVIDER_SPACE = {
  /** 날짜 구분선 — 하루가 바뀌는 자리. */
  day: { blockStart: 12, blockEnd: 12 },
  /** 안읽음·복구 — 같은 날 안의 표지. */
  marker: { blockStart: 8, blockEnd: 8 },
  /** 라벨과 rule 사이. */
  labelGap: 12,
  ruleThickness: 1,
} as const;

/**
 * 행과 행 **사이의 간격**. 한쪽 패딩이 아니라 두 행 사이에 실제로 남는 거리다 —
 * 웹은 위아래 패딩의 합으로, 폰은 marginTop으로 같은 값을 만든다.
 *
 * 값이 둘인 것이 요점이다 (H-7 「그룹 안에서 메시지 경계가 보이지 않는다」). 진단은
 * 연속 행의 간격이 8px뿐이고 그 행에는 아바타도 시각도 없다고 실측했다 — 한 사람이
 * 연달아 쓴 다섯 메시지가 한 문단으로 뭉친다. 그렇다고 묶음 안을 묶음 사이만큼
 * 벌리면 묶음이라는 개념 자체가 사라지므로, **둘의 비**를 지키면서 안쪽을 넓힌다.
 *
 * 그리고 간격만으로는 H-7이 닫히지 않는다 — 나머지 절반은 연속 행의 거터에 hover
 * 시각을 주는 일이고(H-3), 그 둘이 같은 goal에 있는 이유가 이것이다.
 */
export const ROW_SPACE = { withinGroup: 12, betweenGroups: 18 } as const;

function startOfLocalDay(atMs: number): number {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 두 시각 사이의 **로컬 달력 일수** 차이. 시간 차가 아니라 자정을 몇 번 넘었는지다.
 *
 * 이 구분이 load-bearing이다: 23:59와 00:01은 2분 떨어져 있지만 **어제와 오늘**이고,
 * 08:00과 22:00은 14시간 떨어져 있지만 같은 날이다. 밀리초를 86,400,000으로 나누는
 * 구현은 두 경우를 다 틀리고, 서머타임이 있는 지역에서는 한 번 더 틀린다.
 */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  const from = startOfLocalDay(fromMs);
  const to = startOfLocalDay(toMs);
  // 자정 기준끼리 빼고 나서 반올림한다 — DST 전환일은 23시간 또는 25시간이라
  // 나눗셈이 0.958이나 1.042를 내놓는다.
  return Math.round((to - from) / 86_400_000);
}

/**
 * 날짜 구분선의 라벨.
 *
 * ## 오늘/어제만 낱말이 되는 이유
 *
 * 「그저께」·「3일 전」까지 낱말로 밀지 않는다. 그 셋을 세는 일은 읽는 사람에게
 * 산수를 시키는 것이고(오늘이 며칠인지 알아야 그저께가 며칠인지 안다), 정작 스크롤을
 * 거슬러 올라간 사람이 알고 싶은 것은 **그 날이 며칠이었나**다. 오늘과 어제만 예외인
 * 이유는 그 둘은 산수 없이 아는 날이기 때문이다.
 *
 * ## 해는 필요할 때만
 *
 * 같은 해면 「8월 5일」, 다른 해면 「2025년 12월 31일」. `runClockLabel`이 같은 규칙을
 * 이미 쓰고 있고(`workstreams/model.ts`), 같은 사실을 두 표면이 다르게 부르지 않는
 * 편이 낫다.
 *
 * 요일은 넣지 않았다. 구분선은 훑는 표지이지 읽는 문장이 아니고, 「8월 5일 화요일」은
 * 훑을 때 길이만 늘린다 — 요일이 필요한 판단(회의가 무슨 요일이었나)은 이 줄이 아니라
 * 메시지 본문이 답할 일이다.
 */
export function dayDividerSegments(
  atMs: number,
  nowMs: number
): DividerSegment[] {
  const days = calendarDaysBetween(atMs, nowMs);
  if (days === 0) return [{ kind: "prose", text: "오늘" }];
  if (days === 1) return [{ kind: "prose", text: "어제" }];

  const at = new Date(atMs);
  const now = new Date(nowMs);
  const segments: DividerSegment[] = [];
  if (at.getFullYear() !== now.getFullYear()) {
    segments.push({ kind: "figure", text: `${at.getFullYear()}` });
    segments.push({ kind: "prose", text: "년 " });
  }
  segments.push({ kind: "figure", text: `${at.getMonth() + 1}` });
  segments.push({ kind: "prose", text: "월 " });
  segments.push({ kind: "figure", text: `${at.getDate()}` });
  segments.push({ kind: "prose", text: "일" });
  return segments;
}

/**
 * 해까지 적은 날짜 한 줄. **상대 표기가 섞이지 않는다.**
 *
 * 낭독되는 라벨의 재료이고(아래 `dayDividerLabel`), 눈으로 읽는 상대 표기가 귀에
 * 남기지 못하는 것을 채운다. 여기 따로 서 있는 이유는 이것을 필요로 하는 자리가
 * 구분선 말고 또 있기 때문이다 — 고정 목록의 항목 라벨(`pins.ts`의
 * `pinStampLabel`)이 같은 문장을 짓는다. 두 파일이 각자 `getFullYear()`를 열면
 * 「2026년 8월 5일」과 「2026. 8. 5.」가 한 앱에서 함께 산다.
 */
export function absoluteDayLabel(atMs: number): string {
  const at = new Date(atMs);
  return `${at.getFullYear()}년 ${at.getMonth() + 1}월 ${at.getDate()}일`;
}

/**
 * 보조기술이 읽을 날짜. **언제나 절대 날짜를 함께 말한다.**
 *
 * 「오늘」은 눈으로 훑을 때는 가장 값싼 낱말이지만, 낭독으로 들으면 어느 날인지
 * 알려주지 않는다 — 화면을 되돌아볼 수 없는 사람에게 상대 표현만 남기는 것은 정보를
 * 빼는 것이다. 보이는 글자와 읽히는 글자가 일부러 다른 자리이고, `chat/typing.ts`의
 * `typingLabel`이 같은 판단을 한다.
 */
export function dayDividerLabel(atMs: number, nowMs: number): string {
  const absolute = absoluteDayLabel(atMs);
  const days = calendarDaysBetween(atMs, nowMs);
  if (days === 0) return `${absolute}, 오늘`;
  if (days === 1) return `${absolute}, 어제`;
  return absolute;
}

/** 안읽음 경계. 수는 서버의 진실이고(P7) 여기서 세지 않는다. */
export function unreadDividerSegments(count: number): DividerSegment[] {
  return [
    { kind: "prose", text: "새 메시지 " },
    { kind: "figure", text: `${count}` },
    { kind: "prose", text: "개, 여기까지 읽음" },
  ];
}

/**
 * 어느 레일이 틈을 메웠는가.
 *
 * `replay`는 전송 레인이 끊긴 구간을 그대로 다시 흘려 준 것이고, `backfill`은
 * 클라이언트가 REST로 되읽은 것이다. 둘은 **같은 자리를 메우지만 같은 강도가
 * 아니다** — 그래서 화면이 그 차이를 말한다.
 */
export type RecoverySource = "replay" | "backfill";

/**
 * 재연결 표지.
 *
 * ## 「seq N까지」가 사라진 이유 (design-review U4-4 C-1)
 *
 * 앞 판의 문장은 `재연결됨, seq 4821까지 복구`였고, 폰은 그 숫자에 자릿폭 고정까지
 * 걸어 **강조**했다. SKILL §4가 이름 대어 금지하는 것이 정확히 그것이다: *"Internal
 * vocabulary (… run IDs, seq numbers) never appears as user-facing copy outside
 * developer/diagnostic surfaces."* 이 문구는 두 클라 모두에 이전부터 있었지만, 이
 * 모듈이 생기면서 **공용 정본으로 승격**돼 「의도된 문구」라고 주장하게 됐다.
 *
 * 숫자를 지키자는 쪽의 근거는 정확성이었다 — 시계 오차가 섞인 「5초 전부터」 대신
 * 서버가 발급한 값을 그대로 말한다(R-1 §3). 그 근거는 여전히 옳지만, 그것이 정당화
 * 하는 것은 **표지가 서는 자리**이지 문장 속의 숫자가 아니다. 이 표지는 자기가
 * 확인한 것들 **아래**에 앵커된다(`buildTimelineItems`: marker는 `seq` 이하의 가장
 * 새 메시지 뒤에 붙는다). 즉 「어디까지」의 답은 이미 **이 줄의 위치**가 하고 있고,
 * 4821이라는 숫자는 읽는 사람이 대조할 대상이 화면에 하나도 없다 — 어느 행도 자기
 * seq를 그리지 않는다. 숫자를 지운 문장이 덜 정확한 것이 아니라, 숫자가 애초에
 * 아무것도 더 말하지 않고 있었다.
 *
 * 그래서 문장은 **바로 옆 표지와 같은 문법**으로 간다:
 *
 *     새 메시지 3개, 여기까지 읽음      ← 안읽음
 *     재연결됨, 여기까지 복구            ← 복구
 *
 * 「복구」는 남긴다. 그 낱말이 지는 정직성은 「끊겼던 구간이 있었고 그것을 메웠다」
 * 이고, 그 사실을 지우면 표지 자체가 할 말을 잃는다. 걷어내는 것은 `seq` 하나다.
 *
 * `seq`는 여전히 **진단 채널**로 나간다(웹의 `data-seq` 속성). SKILL §4가 여는
 * 예외가 그 자리이고, 화면의 글자가 아니라 검사 도구의 값이다.
 *
 * ## `source`가 인자인 이유 (design-review U4-4 D-1)
 *
 * 이 모듈이 생긴 커밋에서 폰은 `source === 'backfill'`일 때 `' (다시 읽음)'`을
 * **자기 파일에서** 이어 붙였고, 웹은 같은 사실을 `data-source` 속성으로만 내보내
 * 화면에는 한 글자도 없었다. 즉 모듈을 만든 그 커밋이 어휘 판정 하나를 로컬에
 * 남겼고, 두 클라는 복구 구분선에서 **다른 문장**을 말하고 있었다.
 *
 * 어휘 판정이 인자 하나만큼 밖에 있으면 그 판정은 클라마다 갈라진다 — 이 파일
 * 머리말이 적은 실패 양식 그대로다. 그래서 `source`를 **필수 인자**로 올린다:
 * 선택 인자로 두면 한쪽이 안 넘기는 날 그 클라만 조용히 짧은 문장을 말하고,
 * 그것이 바로 그때 고치고 있던 상태다. 필수이므로 컴파일러가 두 호출부를 센다.
 *
 * @param _seq 더 이상 문장에 들어가지 않는다. 인자로 **남는** 이유는 이 배치의
 *   전속 경계다: 폰 호출부(`clients/mobile/.../MessageRow.tsx`)는 같은 사이클에
 *   다른 워커가 들고 있는 파일이라, 여기서 인자를 걷어내면 그 클라가 컴파일되지
 *   않는 채로 남는다. 두 클라가 같은 문장을 말하는 것이 이 수리의 목적이고, 그
 *   목적은 인자 하나를 지금 지우지 않아도 달성된다. 자리 정리는 폰이 이 문장을
 *   소비한 뒤의 일이다.
 */
export function recoveryDividerSegments(
  _seq: number,
  source: RecoverySource
): DividerSegment[] {
  const segments: DividerSegment[] = [
    { kind: "prose", text: "재연결됨, 여기까지 복구" },
  ];
  // 되읽은 구간은 「이미 본 것이 다시 온다」는 사실을 말해야 한다. 레일이 그대로
  // 흘려 준 구간(`replay`)에는 할 말이 없으므로 아무것도 붙이지 않는다.
  if (source === "backfill") {
    segments.push({ kind: "prose", text: " (다시 읽음)" });
  }
  return segments;
}

/**
 * 복구 표지를 **낭독으로** 들을 때의 문장.
 *
 * 보이는 글자와 읽히는 글자가 일부러 다른 두 번째 자리다(`dayDividerLabel`이 첫
 * 번째). 이유는 같은 종류다: 화면의 「여기까지」는 **이 줄이 서 있는 자리**가 답을
 * 마저 하기 때문에 성립하는 말인데, 낭독으로 듣는 사람에게 「여기」는 가리킬 곳이
 * 없다. 그래서 소리 쪽은 그 자리를 말로 되돌려 준다 — 「이 줄 위까지」.
 *
 * `seq`는 여기서도 나가지 않는다. 눈으로 못 쓰는 숫자가 귀로 쓸 수 있게 되지는
 * 않는다.
 */
export function recoveryDividerLabel(source: RecoverySource): string {
  const base = "연결이 다시 이어졌습니다. 이 줄 위까지 복구했습니다.";
  return source === "backfill"
    ? `${base} 이미 본 메시지가 다시 올 수 있습니다.`
    : base;
}

/** 조각을 이어 붙인 글자. 라벨 문자열이 필요한 자리(테스트·낭독)를 위한 것. */
export function dividerText(segments: readonly DividerSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

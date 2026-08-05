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
 * 저자 묶음 **안에서** 행과 행 사이. 헤더가 붙은 행과 이어지는 행이 같은 간격으로
 * 쌓이면 묶음의 시작이 보이지 않는다 (U4-c 「그룹 내 분절」).
 *
 * 값이 둘인 것이 요점이다: 이어지는 행은 붙이고(2), 새 묶음은 띄운다(10). 하나로는
 * 「같은 사람이 이어 말하는 중」과 「다른 사람이 말하기 시작했다」가 화면에서 같은
 * 모양이 된다.
 */
export const ROW_SPACE = { withinGroup: 2, betweenGroups: 10 } as const;

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
 * 보조기술이 읽을 날짜. **언제나 절대 날짜를 함께 말한다.**
 *
 * 「오늘」은 눈으로 훑을 때는 가장 값싼 낱말이지만, 낭독으로 들으면 어느 날인지
 * 알려주지 않는다 — 화면을 되돌아볼 수 없는 사람에게 상대 표현만 남기는 것은 정보를
 * 빼는 것이다. 보이는 글자와 읽히는 글자가 일부러 다른 자리이고, `chat/typing.ts`의
 * `typingLabel`이 같은 판단을 한다.
 */
export function dayDividerLabel(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const absolute = `${at.getFullYear()}년 ${at.getMonth() + 1}월 ${at.getDate()}일`;
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
 * 재연결 표지.
 *
 * `seq`는 서버가 발급한 값이라 정확하다 — 시계 오차가 섞인 「5초 전부터」 대신 어디까지
 * 복구됐는지를 그대로 말한다 (R-1 §3).
 */
export function recoveryDividerSegments(seq: number): DividerSegment[] {
  return [
    { kind: "prose", text: "재연결됨, seq " },
    { kind: "figure", text: `${seq}` },
    { kind: "prose", text: "까지 복구" },
  ];
}

/** 조각을 이어 붙인 글자. 라벨 문자열이 필요한 자리(테스트·낭독)를 위한 것. */
export function dividerText(segments: readonly DividerSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

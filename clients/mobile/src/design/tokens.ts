// =============================================================================
// The v0 shell's visual constants.
//
// These are not a new palette. They are the values `ConnectScreen` already shipped
// with in goal RN-C2, lifted out of that one file so the four screens this batch
// adds cannot each invent a slightly different grey. Nothing here is a guess about
// what the product should look like — that conversation belongs with 성재 and the
// design-taste skills, neither of which has an RN dialect yet.
//
// Two values below are NOT taste, they are constraints, and they are the reason
// this file exists rather than a handful of inline hex strings:
//
//   TOUCH_TARGET   44. The iOS HIG minimum, and the number every row, tab and
//                  button in this batch is measured against. A 32px row looks
//                  right in a screenshot and is missed by a thumb.
//   SAFE_GUTTER    the horizontal padding every screen shares, so that nothing
//                  in this app can produce a horizontal scroll — a list whose
//                  rows are 16px inset on one side and 24px on the other is how
//                  that starts.
// =============================================================================

/** iOS HIG minimum tappable edge, in points. Not negotiable per-screen. */
export const TOUCH_TARGET = 44;

/** Shared horizontal inset. One number, so no two surfaces disagree. */
export const SAFE_GUTTER = 16;

/**
 * 콘텐츠 상자 한 변을 `TOUCH_TARGET` 으로 채우는 `hitSlop` 값 (감사 M-14).
 *
 * ## 왜 함수인가 — 6·6·4·4 가 어떻게 29pt 가 되었나
 *
 * 이 앱의 누를 것들은 두 규율 중 하나를 따르고 있었다. 큰 것은 `minHeight:
 * TOUCH_TARGET` 을 깔고 앉고(시트·버튼), 작은 것은 「높이를 올리면 줄이 두꺼워
 * 진다」는 이유로 `hitSlop` 으로 44 를 만든다(반응 칩·코드 복사). 후자가 옳은
 * 거래인데, 슬롭 숫자를 **손으로 적어 놓아서** 그 산수를 아무도 다시 확인하지
 * 않았다: `↳ 답글`(12pt 한 줄 ≈ 17pt)에 위아래 6 을 얹으면 29pt 다. 44 가 아니다.
 * 감사가 넷을 셌다 — 답글 표식 29 · 스레드 롤업 29 · 행 오류 닫기 33 · 반응 칩은
 * 세로만 44 이고 가로 미보증.
 *
 * 그래서 슬롭은 이제 **콘텐츠 크기에서 도출된다.** 호출부는 자기 상자의 변 길이를
 * 말하고 44 는 이 함수가 진다. 산수가 한 자리에 있으면 `TOUCH_TARGET` 이 바뀌어도
 * 같이 움직이고, 무엇보다 **테스트가 셀 수 있다** —
 * `__tests__/conversationHygiene.test.tsx` 가 실제 렌더 트리에서 슬롭을 읽어
 * 상자와 더한다.
 *
 * 올림인 이유: 17 은 홀수라 (44−17)/2 = 13.5 다. 반으로 나눈 실수를 그대로 쓰면
 * 두 변의 합이 44 에 1pt 못 미치는 반올림이 어디선가 일어난다. 넘치는 쪽으로 1pt
 * 트는 비용은 0 이고, 모자라는 쪽의 비용은 손가락이 옆 메시지를 누르는 것이다.
 */
export function slopTo(size: number): number {
  return Math.max(0, Math.ceil((TOUCH_TARGET - size) / 2));
}

export const color = {
  /** App background. */
  bg: '#0f1115',
  /** Raised surface: cards, rows, the tab bar. */
  surface: '#171a20',
  /** A pressed surface, one step up rather than a new hue. */
  surfacePressed: '#1e222a',
  /** Hairlines and field borders. */
  border: '#2a2f38',
  /** Primary body text. */
  text: '#f2f3f5',
  /** Secondary text: labels, timestamps, the second line of a row. */
  textMuted: '#9aa0a8',
  /** Third-rank text: hints under a settled state. */
  textFaint: '#6b7280',
  /** The one accent. Selection, links, the primary button. */
  accent: '#3b6fd4',
  accentPressed: '#325ab3',
  accentText: '#6fa8dc',
  /**
   * accent 의 가장 부드러운 단. 내 반응 칩의 채움이 이 값이다 (감사 M-13).
   *
   * `surface`(중성 고도)와 뜻이 다르다: 이것은 **내가 참여했다**는 표시라 색을
   * 가진다. 배경 대비 1.18:1 로, `okSurface`(1.17) · `dangerSurface`(1.16) 와
   * 같은 계단에 선다.
   */
  accentSurface: '#1a2740',
  /**
   * 같은 파랑의 한 단 위. 검색 일치처럼 **찾아져야** 하는 강조에만 쓴다.
   *
   * 두 단을 두는 이유: `accentSurface` 는 이미 서 있는 칩을 물들이는 값이라
   * 조용해야 하고, 검색 일치는 사람이 눈으로 스캔해 찾아내야 하는 값이라
   * 조용하면 실패한다(`surface` 위 1.42:1 대 1.18:1). 웹의 `--line`/
   * `--line-strong` 과 같은 종류의 쌍이다.
   */
  accentSurfaceStrong: '#2a3550',
  /** accent 채움 위에 얹는 글자. */
  onAccent: '#ffffff',
  /** Agent identity. Agents are members, and the product names them apart. */
  agent: '#b58bd6',
  /** 에이전트 태그의 채움 — `agent` 의 가장 부드러운 단. */
  agentSurface: '#2a2136',
  /** Something needs a person: unread counts, pending approvals. */
  warn: '#d9a441',
  /**
   * 앰버의 가장 부드러운 단. 상태 칩(대기)의 채움이자 **인용 점프 착지 틴트**다
   * (#1076 — 색 선택 근거는 `MessageRow.tsx` 의 `rowLanded` 주석).
   */
  warnSurface: '#241d0f',
  warnBorder: '#4a3a1c',
  /** 앰버 채움 위에 얹는 글자 — 멘션 배지의 숫자. */
  onWarn: '#1b1405',
  /** A refusal or a failure. Never used for "not provided yet". */
  danger: '#e0777d',
  dangerSurface: '#2a1c1f',
  dangerBorder: '#5a2f35',
  /**
   * danger 상자 **안**의 글자 — `danger` 보다 한 단 밝다.
   *
   * 상자 밖의 표식(「전송 실패」 한 낱말)과 상자 안의 문장(실패 사유 한 줄)은
   * 읽히는 시간이 다르다. 후자는 `dangerSurface` 위에서 6.62:1 이고 전자의
   * 값(`danger`, 5.53:1)보다 위다.
   */
  dangerText: '#f0b4b8',
  /** A settled success. */
  ok: '#93d3a8',
  okSurface: '#16241c',
  okBorder: '#2c4a38',
  /**
   * 스크림 — 시트 뒤를 덮는 층.
   *
   * 색이 아니라 **방향**이다: 뒤를 어둡게 해서 앞의 시트가 앞으로 나오게 한다.
   * `bg` 를 알파와 함께 쓰지 않는 이유는 라이트 모드에서 그 값이 밝아지면
   * 스크림이 배경을 오히려 밝혀 시트가 뒤로 물러나기 때문이다.
   */
  scrim: '#000000aa',
  /** 그림자. 스킴과 무관하게 아래 방향이라 팔레트를 따라가지 않는다. */
  shadow: '#000000',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  pill: 999,
} as const;

/**
 * Type scale. Body is 16 because that is the size iOS stops zooming text fields
 * at, and a login form that zooms on focus is the first thing a person meets.
 */
export const font = {
  title: 26,
  heading: 18,
  body: 16,
  label: 13,
  meta: 12,
} as const;

/**
 * 줄 높이 스케일 (u44 리뷰 M-2).
 *
 * ## 왜 이름이 필요했나
 *
 * `font` 는 처음부터 있었지만 **줄 높이는 없었다.** 그래서 대화 표면에는
 * 17·18·19·22 가 손으로 적힌 채 흩어져 있었고, 리뷰가 그중 하나를 잡아냈다 —
 * 행 시각의 `lineHeight: 22` 가 「이 배치가 추가한 유일한 스케일 밖 숫자」이고
 * 같은 파일의 다른 보조 텍스트는 17/18 을 쓴다는 지적이다. 값 하나를 고치는
 * 것으로는 다음번에 같은 일이 다시 일어난다.
 *
 * ## 이 세 값이 하는 일은 정렬이다
 *
 * RN(iOS)은 `lineHeight` 가 붙은 `Text` 의 글자를 그 줄 상자 **가운데**에 놓는다.
 * 그래서 두 조각이 한 줄로 읽히려면 둘이 **선언된 같은 줄 상자**를 같은 y 에서
 * 시작해야 한다 — 폰에는 컨테이너를 건너뛰는 baseline 정렬이 없으므로(웹의
 * `align-items: baseline` 에 해당하는 것이 절대 배치된 형제에는 닿지 않는다),
 * 「같은 상자, 같은 원점」이 실제로 쓸 수 있는 가장 강한 규율이다. 행 시각이
 * 작성자 줄과 어긋났던 것이 정확히 이것을 안 지켰기 때문이고, 이제 두 쪽이 같은
 * 이름을 든다(`MessageRow` 의 `rowTime` 주석에 실측이 있다).
 *
 * 값은 발명이 아니라 **이 표면이 이미 쓰던 것**이다: 묘비가 18, 카드 주석과 코드가
 * 17, 본문 문단과 목록이 22.
 */
export const line = {
  /**
   * **행의 머리줄** — 작성자 이름(13)과 행 시각(12)이 *한 줄로 읽혀야* 하는 자리.
   *
   * 이 값이 따로 있는 이유는 실측이다(iPhone 17 Pro, px/3, `u44-group.png`).
   * 두 조각을 같은 줄에 세우는 것은 **선언된 같은 상자를 공유하는 것**이지 그
   * 상자의 크기가 아니었다: 14·15·16·17·18 을 다 세워 봐도 어긋남은 언제나 같은
   * 값(광학 중심 +0.33pt)이고, 바뀌는 것은 **그룹 머리의 높이뿐**이었다
   * (본문 상단 300·303·306·308·311px). 선언하지 않으면 어긋남이 +2.67pt 로
   * 돌아온다 — 그것이 리뷰가 「2~3pt 아래」로 잰 값이다.
   *
   * 그래서 값은 「가장 싼 것」으로 고른다. 15 는 13pt 글자의 자연 줄 상자 바로
   * 위라 잘리지 않으면서, 그룹 머리에 **2pt** 만 더한다. `label`(18)을 그대로
   * 쓰면 같은 정렬을 얻고 4.67pt 를 낸다 — 이 제품이 세로를 두고 이미 여러 번
   * 치른 거래(절대 배치된 시각·32pt 칩·24pt 코드 복사)를 생각하면 그쪽이 비싸다.
   */
  head: 15,
  /** `font.meta`(12) 한 줄. 카드 주석·행 오류·코드·누를 것의 라벨. */
  meta: 17,
  /** `font.label`(13) 한 줄 **문장**. 묘비. */
  label: 18,
  /** `font.body`(16) 한 줄. 본문 문단·목록·「작업 중」. */
  body: 22,
} as const;

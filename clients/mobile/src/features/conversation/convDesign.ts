// =============================================================================
// 대화 화면의 치수 — 시안 A `#a-conv` 값 그대로 (DS2-4 #2716, ADR-0189 D1).
//
// 값마다 시안 CSS 원문을 옆에 적는다. owner 피드백 표(2026-09-26, Buzz 대조)가
// 말하는 자리는 그 값이 이기고, 그 표가 말하지 않는 자리는 시안 값이다. 실측
// 근거(Buzz 1206px = 393pt)는 PR 본문의 사양 표에 있다.
//
// 한 객체에 모으는 이유는 DS2-3 홈(`SidebarScreen`의 `HOME`)과 같다: 스타일시트에
// 숫자를 흩으면 `designSystem.test.ts`의 스윕이 그것을 「격자 밖 리터럴」로 세고,
// 무엇보다 다음 사람이 「이 12 는 어디서 왔나」를 한 자리에서 읽지 못한다.
// =============================================================================

/** owner 10-30 #4790: 일반·스레드·작업 대화의 폰 입력 상한. */
export const PHONE_COMPOSER_MAX_ROWS = 4;

export const CONV = {
  // ---- 머리 (`.a-hd`) -------------------------------------------------------
  /** `.a-cbtn{width:42px;height:42px;border-radius:50%}` — 뒤로·⋮ 원. */
  circle: 42,
  /** `.a-hd{padding:0 14px}`. */
  headPadX: 14,
  /** `.a-hd{height:62px}` — 머리 띠의 줄 높이(안전 영역 아래). */
  headHeight: 62,
  /** `.a-hd{gap:10px}`. */
  headGap: 10,
  titleTracking: -0.26,
  /** `.a-hd .ttl b svg.ic.s16` — 제목 앞 `#`. */
  titleGlyph: 16,
  /** `.a-stack .av{width:28px}` — DM 머리의 상대 얼굴. */
  titleFace: 28,
  /**
   * 머리 가운데 알약(이름 + 보조 글, #4319)의 안쪽 좌우 여백과 칸 사이 간격. 높이는 원(`circle` 42)과 같은 최소 높이라 머리 줄(`headHeight` 62)이
   * 움직이지 않는다 — 알약은 줄 안에서 원과 같은 키로 선다.
   */
  headPillPadX: 12,
  headPillGap: 8,

  // ---- 날짜 알약 (`.a-day`) -------------------------------------------------
  /** `.a-day span{padding:3px 11px}`. */
  dayPadY: 3,
  dayPadX: 11,
  /** `.a-day{margin:2px 0 12px}`. */
  dayGapBelow: 12,
  /** 떠 있는 알약이 머리 밑에서 떨어진 거리. 시안 `.a-msgs{top:120px}` − 머리 끝 116 ≈ 4 + 알약 위 여백 4. */
  dayFloatTop: 8,

  // ---- 메시지 (`.a-m`) ------------------------------------------------------
  /** owner 표 「아바타 40」(Buzz 실측 ≈41). 시안 `.a-m .av` 는 36 — 표가 이긴다. */
  avatar: 40,
  /** `.a-m{gap:10px}`. */
  avatarGap: 10,
  /** `.a-m{margin-bottom:16px}` — 작성자가 바뀌는 자리의 틈. */
  groupGap: 16,
  whoLine: 20,
  whoTracking: -0.15,
  /** `.a-m .who{gap:7px}` — 이름과 시각 사이. */
  whoGap: 7,
  /** `.a-m p{font-size:16px;line-height:1.45}` → 23. */
  bodyLine: 23,
  /** `.a-m p{margin-top:2px}`. */
  bodyGapAbove: 2,

  // ---- 말풍선 (#4300, owner 2026-10-24 — Buzz 식) ---------------------------------
  // 색·글자색은 코어 외양 토큰(`bubble.ts` `bubbleFor`)이 정하고, 여기는 **모양** 기본값이다.
  // 한 줄 높이 = 23 + 2 × 8 = 39 → 반경 18 은 한 줄에서 거의 알약, 여러 줄에서는 둥근 상자다.
  /** 말풍선 좌우 안쪽 여백. */
  bubblePadX: 12,
  /** 말풍선 위아래 안쪽 여백. */
  bubblePadY: 8,
  /** 말풍선 기본 반경 — 행 강조 면(`ROW_FACE.radius`)과 **따로** 읽는다(#4307). */
  bubbleRadius: 18,

  // ---- 멘션 (`.a-mention`) --------------------------------------------------
  /** `.a-mention{border-radius:6px;padding:0 4px}`. */
  mentionRadius: 6,

  // ---- 파일 카드 (`.a-file`) ------------------------------------------------
  /** `.a-file{border-radius:16px;padding:10px 12px;gap:11px;max-width:250px}`. */
  fileRadius: 16,
  filePadY: 10,
  filePadX: 12,
  fileGap: 11,
  fileMaxWidth: 250,
  /** `.a-file .tile{width:38px;height:38px;border-radius:11px}`. */
  fileTile: 38,
  fileTileRadius: 11,

  // ---- 반응 (`.a-react`) ----------------------------------------------------
  reactPadX: 9,
  reactGap: 6,

  // ---- 에이전트 카드 (`.a-card`) --------------------------------------------
  /** `.a-card{border-radius:20px;padding:14px;border:1.5px solid transparent}`. */
  cardRadius: 20,
  cardPad: 14,
  cardBorder: 1.5,
  cardSumLine: 22,
  /** `.a-steps{margin:12px 0;gap:9px;padding:11px 12px;border-radius:14px}`. */
  stepsGapY: 12,
  stepsGap: 9,
  stepsPadY: 11,
  stepsPadX: 12,
  stepsRadius: 14,
  stepMark: 20,
  /** `.a-pill{height:38px;border-radius:19px;padding:0 15px;font-size:14px;font-weight:700}`, `.a-acts{gap:8px}`. */
  pillHeight: 38,
  pillPadX: 15,
  pillGap: 8,

  // ---- 컴포저 (`.a-comp`) — 알약 하나, 두 원이 끝 반원과 동심 (#4179) --------
  //
  // 기준은 성재가 고른 Buzz 캡처(IMG_4319, 1206×2622 = 402pt @3x)를 **픽셀로 잰** 값이다
  // (PR 본문 「실측」 표):
  //
  //   알약  폭 963px = 321pt · 높이 160px = 53.3pt · 화면 가장자리에서 121~122px = 40.3~40.7pt
  //   두 원 지름 108px = 36pt — + 와 보내기가 **같다**(옛 34·38)
  //   원 ↔ 알약 가장자리 26~27px = 8.7~9pt — 좌·우·위·아래가 **같다**(옛 좌우 4 · 위아래 7~9)
  //   원 ↔ 글 시작 28~29px = 9~9.7pt
  //
  // 핵심은 값이 아니라 **관계**다: 알약 반경 = 원 반경 + 사방 여백. 그래서 알약 끝 반원과
  // 원이 한 중심을 쓴다(동심) — 한 줄일 때는 양 끝이, 글이 여러 줄로 자라 원이 아래에 남을
  // 때는 아래 두 모서리가. 값 셋(원·여백·반경)을 **따로 적는** 것은 일부러다: 반경을
  // 계산으로 묶으면 여백 하나만 바꿔도 시험이 못 빨개진다. 관계는
  // `__tests__/composerPill.test.tsx` 가 잰다.
  /** + · ↑ 원의 지름. 두 원이 같다. */
  composerCircle: 36,
  /**
   * 보내기 **왼쪽** 표현 단추의 칸(#4942, owner 10-31) — 두 원과 같은 지름이고 글리프만 선다(채운 원은 보내기 하나다).
   * 접힌 알약에서는 글 칸이 이만큼 더 비운다(`COMPOSER_CHROME_X`).
   */
  composerExpression: 36,
  /** 원 ↔ 알약 가장자리, 사방 같다(좌·우·위·아래). */
  composerGap: 9,
  /** 알약 반경 = 원 반경 18 + 사방 여백 9. 한 줄 높이는 2 × 27 = 54(Buzz 53.3). */
  composerRadius: 27,
  /**
   * 원 ↔ 글 시작, 그리고 글 ↔ 입력창 위·아래 — 입력창 안쪽 여백(8)과 테두리(1)의 합이다.
   * `Composer` 의 `INPUT_PAD_X + INPUT_BORDER` 와 같아야 하고 시험이 그것을 묶는다.
   */
  composerTextInset: 9,
  /** owner 10-30 #4790: 입력 알약과 도크 형제 줄의 공통 바깥 여백. */
  composerDockInset: 8,
  /**
   * 작업 대화 독(안내 줄·「끼어들기」 칩·알약)의 좌우 여백. 옛 알약의 바깥 여백(12)과 같은 값이지만
   * **다른 축이다** — 대화 컴포저의 `composerDockInset`(바깥 여백)이 움직여도 이 독은
   * 안 움직인다.
   */
  workDockInset: 12,

  // ---- 목록 ↔ 알약 (#4264) --------------------------------------------------
  //
  // 이 셋은 **한 줄의 산수**다: 마지막 행 아래에서 알약 위까지 = 목록 꼬리 + 도크 위의 「작성 중」 줄이
  // 흐름에서 먹는 높이 + 컴포저가 자기 위에 비워 두는 여백. 옛 값은 8 + 20 + 8 = 36이었고 — 세 조각이 각자 다른
  // 때 다른 이유로 정해졌고 합은 아무도 안 정했다(성재 실기 2026-10-23, 글자 아래 → 알약 위 ≈ 45pt: 36 + 마지막
  // 행의 안쪽 여백·줄 상자 7.7). 이슈가 의심한 「키보드가 올라왔는데 안전 영역 34가 목록 아래에 남음」은 아니었다 —
  // 올라간 동안 패널은 `insets.bottom - bottomInset`(= `KEYBOARD_GAP` 4)만 지고 목록은 도크 바로 위에 선다.
  /**
   * 마지막 행 **상자** 아래 → 알약 위, 쉬는 상태(대화 화면). 키보드가 열렸든 닫혔든 같다 — 조각들이
   * 키보드를 모르고, 올라가는 것은 네이티브 판 통째다(`ConversationLayout`).
   *
   * 출처 — Buzz 소스: 목록의 `padding.bottom` 은 **측정한 도크 높이**이고 최신 항목 아래에 `Grid.xs`(16)만 더한다
   * (`mobile/lib/features/channels/channel_detail_page/message_list.dart` 의
   * `padding: EdgeInsets.only(bottom: index == 0 ? Grid.xs : 0)`). Buzz 캡처(402pt @3x,
   * `buzz-phone-composer-typing-1023.png`) 실측: 입력 중 마지막 말풍선 아래 끝 → 알약 위 끝 61px = 20.3pt.
   *
   * **재는 자가 둘이다.** Buzz 의 20.3 은 말풍선(채워진 상자) 아래 끝에서 잰 값이고, oort 의 행은 상자 없는 글줄이라
   * 글자 아래 끝에서 알약까지는 이 값에 **글자 아래 여백 7.7**(행 안쪽 여백 3 + 줄 상자 여백)이 더해진다: 20 → 약
   * 27.7pt. Buzz 의 글자 아래 끝 → 알약 위 끝은 33.3pt 이다(말풍선 안 아래 여백 13 + 20.3). 글자끼리의 거리를
   * 맞추려면 이 값을 24 까지 올리면 된다 — 값은 여기 하나이고 시험·계측이 이 값을 따라간다.
   *
   * **Buzz 의 닫힘 35pt 는 따라가지 않는다.** 그 15는 컴팩트 알약이 내려앉는 연출 변환(`dock.dart` 의
   * `compactVerticalOffset = Grid.twelve + Grid.quarter` = 14)이지 레이아웃이 아니다 — 도크 높이가 바뀌지 않는다.
   * 키보드 유무로 갈리는 간격은 JS 가 키보드 신호로 레이아웃을 다시 계산하거나 네이티브 판이 변환을 더해야 하는데,
   * 앞은 RN-P3 가 지운 JS 경로이고(`conversationLayout.test.tsx` 「키보드 이벤트는 …아무 일도 일으키지 않는다」)
   * 뒤는 네이티브 모듈 변경이다. 그래서 열림·닫힘이 같은 값이다.
   */
  listPillGap: 20,
  /**
   * 대화 화면의 목록 꼬리 높이(`Timeline` 의 `tailGap`). 도크 맨 위의 「작성 중」 예약 줄이 그 자리를 지킨다 —
   * 꼬리까지 두면 같은 공기를 두 번 센다. `Timeline` 의 기본 꼬리(8, `space.sm`)는 스레드 패널과 계측 표면의 값이고
   * 그대로다(스레드는 도크에 「작성 중」 줄이 없어서 꼬리 8 + 컴포저 위 8 = 16 이 유일한 간격이다).
   */
  conversationTail: 0,
  /**
   * 컴포저가 자기 위에 늘 비워 두는 여백(`Composer` 의 `root.paddingTop` 과 `DOCK_CHROME` 의 한 항, 시트가 앉는 자리).
   * `space.sm` 과 같은 값이지만 **이 이름으로 한 번만** 적는다 — 시트 예산 산수와 「작성 중」 줄의 예약이 같은 수를 읽는다.
   */
  composerTopAir: 8,
} as const;

/**
 * 알약 안에서 글 칸이 **아닌** 가로 — 양쪽의 (원 + 원 ↔ 알약 가장자리 + 원 ↔ 글) + 보내기 왼쪽 표현 단추의 칸.
 * 144 = 2 × (9 + 36 + 9) + 36. 두 원과 표현 단추가 있는 대화 컴포저의 값이다(옛 108 은 표현 단추가 도구 줄에 있던 때의
 * 값이다, #4942). 작업 대화 알약은 이 거리를 안 쓴다 — 바깥 여백이 위 안내 줄과 맞아야 해서 독의 12 그대로다.
 */
export const COMPOSER_CHROME_X =
  2 * (CONV.composerGap + CONV.composerCircle + CONV.composerTextInset) +
  CONV.composerExpression;

/** #4790: 창 폭·글자 크기와 무관하게 도크 전체가 같은 8pt 선에 선다. */
export function composerFloat(_windowWidth: number, _fontScale: number): number {
  return CONV.composerDockInset;
}

/** 그 거리에서 글 칸의 폭 — PR 의 「실측 폭」 표와 시험이 같은 식을 읽는다. */
export function composerTextColumn(windowWidth: number, fontScale: number): number {
  return windowWidth - 2 * composerFloat(windowWidth, fontScale) - COMPOSER_CHROME_X;
}

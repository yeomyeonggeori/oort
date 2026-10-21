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
  /** 원 ↔ 알약 가장자리, 사방 같다(좌·우·위·아래). */
  composerGap: 9,
  /** 알약 반경 = 원 반경 18 + 사방 여백 9. 한 줄 높이는 2 × 27 = 54(Buzz 53.3). */
  composerRadius: 27,
  /**
   * 원 ↔ 글 시작, 그리고 글 ↔ 입력창 위·아래 — 입력창 안쪽 여백(8)과 테두리(1)의 합이다.
   * `Composer` 의 `INPUT_PAD_X + INPUT_BORDER` 와 같아야 하고 시험이 그것을 묶는다.
   */
  composerTextInset: 9,
  /** 알약이 화면 가장자리에서 뜬 거리 — 글 칸이 넉넉할 때. Buzz 40.3~40.7pt. */
  composerFloatMax: 40,
  /** 글 칸이 모자라면 줄어드는 바닥 — 옛 값(`.a-comp{left:12px;right:12px}`). */
  composerFloatMin: 12,
  /**
   * 글 칸의 바닥(글자 배수 1 에서, pt) — 이 아래로 좁아지면 띄운 거리를 줄인다.
   *
   * **값의 출처는 안내 문장이다.** 빈 알약의 플레이스홀더 「{이름}에게 메시지 보내기, @로
   * 부르기」는 이 앱에서 `@` 를 알리는 유일한 자리이고(`Composer` 의 `placeholderTextColor`
   * 주석), 글 칸이 그보다 좁으면 문장이 접혀 **빈 알약이 두 줄로 자란다**(접혀도 문장은 안 잘린다
   * — `composerDraftOffline.test.tsx` 의 「기본 글자 크기에서는 아무것도 안 변한다」). 한 줄에
   * 드는 폭은 코어 `composerCopy.ts` 가 16pt 로 잰 표가 든다: 「일반에 …」 215.5 ·
   * 「김인턴에게 …」 243.2 · 「hermes에게 …」 **256.0** — 이 PR 이 같은 자로 잰 「grok에게 …」
   * 232.3. 가장 긴 기본 에이전트 문장(hermes) + 여유 2 = 258 — 옛 알약의 글 칸은 390pt 에서
   * 268 이라 이 문장들이 전부 한 줄이었다. Buzz 는 안내 문장이 짧아(「Message...」) 글 칸
   * 213pt 로 한 줄이지만, 이 앱의 문장은 그 폭에 안 든다.
   *
   * 결과: 402pt 에서 18 · 393pt 에서 13 · 375pt(SE)에서 바닥 12 · 440pt(Pro Max)에서 37.
   * **이 수 하나가 Buzz 여백(40)과 한 줄 안내 문장 사이의 거래다** — 낮추면 여백이 Buzz 에
   * 가까워지는 대신 긴 이름의 DM 에서 빈 알약이 두 줄이 된다(PR 본문 「여백 거래」 캡처).
   */
  composerTextMin: 258,
} as const;

/**
 * 알약 안에서 글 칸이 **아닌** 가로 — 양쪽의 (원 + 원 ↔ 알약 가장자리 + 원 ↔ 글).
 * 108 = 2 × (9 + 36 + 9). 두 원이 있는 대화 컴포저의 값이다(작업 대화 알약은 이 거리를 안
 * 쓴다 — 바깥 여백이 위 안내 줄과 맞아야 해서 독의 12 그대로다).
 */
export const COMPOSER_CHROME_X =
  2 * (CONV.composerGap + CONV.composerCircle + CONV.composerTextInset);

/**
 * 알약이 화면 가장자리에서 뜬 거리 (#4179).
 *
 * Buzz 만큼(`composerFloatMax` 40) 띄우되, 글 칸이 `composerTextMin × 글자 배수` 아래로
 * 내려가려 하면 그만큼 줄여 바닥(`composerFloatMin`, 옛 값 12)까지 내려간다. 글 칸 =
 * 창 폭 − 2 × 거리 − `COMPOSER_CHROME_X`. 거리는 **내림**이라 줄어든 자리에서도 글 칸이 바닥을
 * 지킨다(올림이면 1pt 모자란다).
 *
 * 글자 배수를 곱하는 이유는 접근성 큰 글자다: 같은 pt 폭이 담는 글자 수가 배수만큼 준다 —
 * 배수가 커지면 거리가 먼저 바닥으로 내려가 글 칸을 지킨다.
 */
export function composerFloat(windowWidth: number, fontScale: number): number {
  const spare = Math.floor(
    (windowWidth - COMPOSER_CHROME_X - CONV.composerTextMin * fontScale) / 2,
  );
  return Math.min(CONV.composerFloatMax, Math.max(CONV.composerFloatMin, spare));
}

/** 그 거리에서 글 칸의 폭 — PR 의 「실측 폭」 표와 시험이 같은 식을 읽는다. */
export function composerTextColumn(windowWidth: number, fontScale: number): number {
  return windowWidth - 2 * composerFloat(windowWidth, fontScale) - COMPOSER_CHROME_X;
}

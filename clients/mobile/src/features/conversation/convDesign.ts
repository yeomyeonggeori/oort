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
  /** `.a-hd .ttl b{font-size:17px;font-weight:700;letter-spacing:-.015em}`. */
  titleSize: 17,
  titleTracking: -0.26,
  /** `.a-hd .ttl span{font-size:12.5px}`. */
  subtitleSize: 12.5,
  /** `.a-hd .ttl b svg.ic.s16` — 제목 앞 `#`. */
  titleGlyph: 16,
  /** `.a-stack .av{width:28px}` — DM 머리의 상대 얼굴. */
  titleFace: 28,

  // ---- 날짜 알약 (`.a-day`) -------------------------------------------------
  /** `.a-day span{font-size:12px;font-weight:600}`. */
  dayText: 12,
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
  /** `.a-m .who{font-size:15px;font-weight:700;letter-spacing:-.01em;line-height:1.3}`. */
  whoSize: 15,
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
  /** `.a-file b{font-size:14px}`. */
  fileName: 14,

  // ---- 반응 (`.a-react`) ----------------------------------------------------
  /** `.a-react span{font-size:12.5px;padding:3px 9px}`, `.a-react{gap:6px;margin-top:8px}`. */
  reactText: 12.5,
  reactPadX: 9,
  reactGap: 6,

  // ---- 에이전트 카드 (`.a-card`) --------------------------------------------
  /** `.a-card{border-radius:20px;padding:14px;border:1.5px solid transparent}`. */
  cardRadius: 20,
  cardPad: 14,
  cardBorder: 1.5,
  /** `.a-card .sum{font-size:15px;line-height:1.5}`. */
  cardSum: 15,
  cardSumLine: 22,
  /** `.a-steps{margin:12px 0;gap:9px;padding:11px 12px;border-radius:14px}`. */
  stepsGapY: 12,
  stepsGap: 9,
  stepsPadY: 11,
  stepsPadX: 12,
  stepsRadius: 14,
  /** `.a-step{gap:9px;font-size:13.5px}`, `.a-step .st{width:20px;height:20px}`. */
  stepText: 13.5,
  stepMark: 20,
  /** `.a-pill{height:38px;border-radius:19px;padding:0 15px;font-size:14px;font-weight:700}`, `.a-acts{gap:8px}`. */
  pillHeight: 38,
  pillPadX: 15,
  pillText: 14,
  pillGap: 8,

  // ---- 컴포저 (`.a-comp`) ---------------------------------------------------
  /** `.a-comp{left:12px;right:12px}`. */
  composerInset: 12,
  /** `.a-comp{border-radius:26px}` — `ds2Radius.composer` 와 같다. */
  composerRadius: 26,
  /**
   * 알약 안 여백. 시안 `.a-comp{padding:12px 12px 10px 16px}` 는 두 줄(글 + 도구)
   * 판이다. owner 표의 한 줄 알약에서는 입력창(엄지 바닥 44) 둘레 4 로 높이 52
   * (Buzz 실측 ≈51).
   */
  composerPad: 4,
  /** `.tools button{width:34px;height:34px}` — 안쪽 왼쪽 + 원. */
  composerTool: 34,
  /** `.a-send{width:38px;height:38px}` — 잉크 ↑ 원. */
  composerSend: 38,
} as const;

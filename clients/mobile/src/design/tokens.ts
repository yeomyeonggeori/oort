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
 * 첨부 picker 시트 grabber의 시각 너비.
 *
 * 지금 값은 `TOUCH_TARGET`과 우연히 같지만 이 막대는 누르는 컨트롤이 아니다. 터치
 * 최소값을 조정하는 날 grabber까지 따라 움직이지 않도록, 시트의 측정값으로 따로
 * 이름 붙인다 (#1703). 시트 radius·가족 문법 통일은 이 이름의 범위가 아니다.
 */
export const ATTACHMENT_SHEET_GRABBER_WIDTH = 44;

/**
 * 컴포저 첨부 트레이가 차지할 수 있는 최대 높이.
 *
 * 웹의 같은 첨부 트레이 측정 `--spacing-tray-max`와 240으로 짝을 이룬다. 행 수를
 * `TOUCH_TARGET`에서 곱해 얻은 값이 아니라, 컴포저가 대화를 먹지 않게 제한하고
 * 초과분을 스크롤로 알리는 두 표면의 공용 상한이다 (#1703).
 */
export const ATTACHMENT_TRAY_MAX_HEIGHT = 240;

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

// =============================================================================
// 팔레트 — 두 스킴, 하나의 역할표 (U2).
//
// 이 파일이 처음 쓰였을 때 색은 **한 벌**이었고(다크 고정), 그래서 역할의 설명과
// 값이 같은 자리에 있었다. 스킴이 둘이 되면 그 둘은 갈라져야 한다: 「`surface` 는
// 카드·행·탭바가 서는 한 단 위」는 두 스킴에서 같은 문장이고, `#201f24` 는 그중 한
// 스킴의 답일 뿐이다. 그래서 **뜻은 `Palette` 인터페이스에**, 값은 두 상수에 있다.
//
// 두 벌을 두는 대신 웹처럼 `light-dark()` 한 줄로 쓸 수 없느냐 — 없다. RN 의 스타일
// 값은 문자열이고, 그 문자열을 스킴에 따라 고르는 일을 하는 CSS 엔진이 없다. 그
// 고르는 일을 하는 것이 `design/theme.tsx` 이고, 이 파일은 고를 것 두 벌을 댄다.
//
// ## 두 스킴 다 발명이 아니라 **번역**이다
//
// 여명(Dawn) 팔레트의 정본은 웹 `clients/web/src/design/tokens.css` 이고, 거기에는
// 이미 두 스킴이 다 적혀 있다. 그래서 아래 값들은 여기서 새로 고른 것이 아니라 그
// 파일의 두 항을 **역할로 대응시켜** 옮긴 것이다. 열여덟 역할이 짝을 갖는다:
//
//   bg ← --surface                  surface ← --surface-raised
//   surfacePressed ← --surface-hover  border ← --line        text ← --ink
//   textMuted ← --ink-muted           textFaint ← --line-strong
//   accent ← --accent                 accentSurface ← --accent-soft
//   onAccent ← --on-accent            agent ← --agent        agentSurface ← --agent-soft
//   warn ← --warn                     danger ← --danger      ok ← --ok
//   dangerFill ← --danger-fill        onDangerFill ← --on-danger-fill
//   scrim ← --scrim
//
// 열여섯이었다 (#1210 D2). 파괴 채움 둘은 웹에만 있었고, 그래서 폰의 파괴 버튼은
// 잴 채움이 없어 **테두리 토큰**을 바탕으로 쓰고 있었다 — 그 값과 결과는
// `Palette.dangerFill` 주석에 있다.
//
// **두 항 다 바이트로 같다.** 라이트가 먼저 왔고(U2), 다크의 accent 가족이 뒤따랐고
// (#1155), 나머지 다크 역할이 #1164 에서 같은 길로 왔다. 그 전까지 다크는 이 앱이
// RN-C2 에서 입고 나온 v0 회색·보라·민트를 들고 있었고, 그래서 스킴을 바꾸면 색이
// **계열째** 갈아탔다 — 에이전트가 라이트에서는 새벽 남색(#4a6785)이고 다크에서는
// 네온 보라(#b58bd6)였다. 웹에서는 그 일이 일어날 수 없다: 두 스킴을 `light-dark()`
// 한 줄에 적으므로 두 항이 갈라질 자리가 없다. 이 파일은 그 한 줄이 없는 대신
// `__tests__/paletteContrast.test.ts` 가 저 파일을 **읽어서** 두 항을 맞춘다.
//
// 웹에 짝이 없는 역할(`accentPressed`, `accentText`, `accentSurfaceStrong`,
// `*Surface`/`*Border` 의 상태 3가족, `dangerText`, `onWarn`, `shadow`)은 **그 스킴이
// 그 역할에 대해 지키던 관계를 값으로 푼 답**이다. 관계가 원본이고 값은 그 관계의
// 답이라서, 전부 `paletteContrast.test.ts` 가 두 스킴에서 같은 자로 잰다.
//
// ## 방향이 뒤집히는 역할이 셋 있다
//
//   surfacePressed  다크에서는 한 단 **밝고**, 라이트에서는 한 단 **어둡다**.
//                   뜻은 둘 다 「눌린 표면」이고, 그것은 배경에서 멀어지는 것이다.
//                   두 값 다 웹 `--surface-hover` 이므로 방향도 웹이 정한 것이다.
//   accentText      다크에서는 accent 보다 **밝은** 단(#fcba6e), 라이트에서는
//                   **어두운** 단(#8f4207). 뜻은 「배경 위에서 읽히는 accent」다.
//                   두 스킴 모두 accent 의 색상각 위에 있고, 배경에서 멀어지는 쪽으로
//                   같은 크기의 걸음을 간다 — 방향만 스킴이 정한다.
//   dangerText      상자 안의 문장. 다크에서 danger 보다 밝고, 라이트에서 어둡다.
//
//   `on*` 둘은 방향이 아니라 **값**이 뒤집힌다. 채움의 밝기가 스킴마다 반대이기
//   때문이다: 다크의 앰버 채움(warn #d4a72c · accent #f0a850)은 밝아서 어두운 글자를
//   받고(#191405 · #17161a), 라이트의 채움(#8a5c00 · #a54c08)은 어두워서 종이색
//   글자(#fffefb)를 받는다. `onAccent` 가 이 목록에 든 것은 #1155 부터다 — 그전엔
//   다크의 accent 가 파랑이라 채움이 양쪽 다 어두웠다.
// =============================================================================

/**
 * 이 앱이 아는 색 역할의 전부. 두 팔레트가 **같은 키를 전부** 갖는다는 사실을
 * 타입이 진다 — 한쪽에만 있는 색은 컴파일되지 않는다.
 */
export interface Palette {
  /** App background. */
  bg: string;
  /** Raised surface: cards, rows, the tab bar. 언제나 `bg` 보다 한 단 위다. */
  surface: string;
  /** A pressed surface, one step away from `surface` rather than a new hue. */
  surfacePressed: string;
  /** Hairlines and field borders. 배경 위에서 3:1 **아래** — 선이지 컨트롤이 아니다. */
  border: string;
  /** Primary body text. */
  text: string;
  /** Secondary text: labels, timestamps, the second line of a row. */
  textMuted: string;
  /**
   * Third-rank text: hints under a settled state, 그리고 인용의 규정선.
   *
   * 본문 AA(4.5)를 노리지 않는다 — 노리면 `textMuted` 와 같은 값이 된다. 대신
   * 웹이 컨트롤 테두리에 요구하는 **3:1** 을 지킨다(`--line-strong` 과 같은 자리).
   */
  textFaint: string;
  /** The one accent. Selection, links, the primary button. */
  accent: string;
  /** 눌린 accent 채움. */
  accentPressed: string;
  /** 배경 위에 **글자·글리프로** 서는 accent. 채움이 아니라 잉크다. */
  accentText: string;
  /**
   * accent 의 가장 부드러운 단. 내 반응 칩의 채움이 이 값이다 (감사 M-13).
   *
   * `surface`(중성 고도)와 뜻이 다르다: 이것은 **내가 참여했다**는 표시라 색을
   * 가진다. 칩이 서는 자리인 `surface` 위에서 다크 1.12:1 · 라이트 1.21:1.
   */
  accentSurface: string;
  /**
   * 같은 계열의 한 단 위. 검색 일치처럼 **찾아져야** 하는 강조에만 쓴다.
   *
   * 두 단을 두는 이유: `accentSurface` 는 이미 서 있는 칩을 물들이는 값이라
   * 조용해야 하고, 검색 일치는 사람이 눈으로 스캔해 찾아내야 하는 값이라
   * 조용하면 실패한다(`surface` 위 다크 1.36:1 대 1.12:1 · 라이트 1.41:1 대
   * 1.21:1). 웹의 `--line`/`--line-strong` 과 같은 종류의 쌍이다.
   */
  accentSurfaceStrong: string;
  /** accent 채움 위에 얹는 글자. */
  onAccent: string;
  /** Agent identity. Agents are members, and the product names them apart. */
  agent: string;
  /** 에이전트 태그의 채움 — `agent` 의 가장 부드러운 단. */
  agentSurface: string;
  /**
   * Something needs a person: unread counts, pending approvals.
   *
   * `accent` 와 같은 앰버 대역에 산다. 두 뜻(「여기를 보라」/「내가 한 것」)이 색으로
   * 얼마나 갈라지는지는 **웹이 정한다** — 두 값 다 웹 항이므로. 실측 색상각 차:
   * 다크 18.08° · 라이트 25.92°. 다크가 좁은 것은 웹 팔레트 자신의 성질이고
   * (`--warn` #d4a72c 대 `--accent` #f0a850), #1164 이전 폰 다크가 10.87° 로 그보다
   * 더 좁았던 것은 폰만의 결함이었다 (#1155 리뷰 N1).
   */
  warn: string;
  /**
   * 앰버의 가장 부드러운 단. 상태 칩(대기)의 채움이자 **인용 점프 착지 틴트**다
   * (#1076 — 색 선택 근거는 `MessageRow.tsx` 의 `rowLanded` 주석).
   */
  warnSurface: string;
  /** `warnSurface` 채움의 테두리. */
  warnBorder: string;
  /** 앰버 **채움** 위에 얹는 글자 — 멘션 배지의 숫자. */
  onWarn: string;
  /** A refusal or a failure. Never used for "not provided yet". */
  danger: string;
  dangerSurface: string;
  dangerBorder: string;
  /**
   * danger 상자 **안**의 글자 — `danger` 에서 배경 반대쪽으로 한 단 간 값.
   *
   * 상자 밖의 표식(「전송 실패」 한 낱말)과 상자 안의 문장(실패 사유 한 줄)은
   * 읽히는 시간이 다르다. 후자는 `dangerSurface` 위에서 다크 9.88:1 · 라이트
   * 7.59:1 이고 전자의 값(5.93 · 5.56)보다 위다 — 둘 다 AA 를 지나되 한 단 갈라 둔다.
   */
  dangerText: string;
  /**
   * 파괴 액션의 **채움** — 웹 `--danger-fill` (#1210 D2).
   *
   * `danger` 는 위험을 **말하는** 톤이고(글자·칩·점), 이것은 위험을 **실행하는**
   * 버튼의 바탕이다. 두 이름이 나뉜 것은 취향이 아니라 산술의 결과다: 웹이
   * `--danger-fill` 주석에 적어 둔 대로 전경 톤은 `warn` 보다 채도가 높아야 하고
   * 채움은 주 액션 `accent` 보다 낮아야 하는데, 다크에서 그 두 구간의 교집합이
   * 공집합이다.
   *
   * 이 역할이 폰에 없어서 무슨 일이 있었나 (감사 2026-08-09 §B-4 ②): 「거부 확정」
   * 과 「중단」 버튼이 쓸 채움이 없으니 **테두리 토큰**(`dangerBorder`)을 바탕으로
   * 썼다. 그 결과 다크에서 되돌릴 수 없는 거부 버튼이 카드 표면(`surface`) 위
   * 1.64:1 이고 그 옆의 승인 버튼(`accent`)이 8.12:1 이었다 — 파괴 쪽이 화면에서
   * 5배 조용했다(같은 두 값을 `bg` 위에서 재면 1.80 대 8.94다). 웹은
   * 같은 문제를 이 토큰의 신설로 닫았고(MOMO-642 R1 H-2), 폰의 동기화 가드는 그
   * 두 토큰을 **명시적으로 제외**한 채 통과하고 있었다. 가드가 자기 구멍을
   * 문서화하고 지나간 자리다.
   *
   * 값은 발명이 아니다 — 웹 `--danger-fill` 의 두 항 그대로이고,
   * `paletteContrast.test.ts` 가 그 파일을 읽어 바이트로 대조한다.
   */
  dangerFill: string;
  /** 파괴 채움 위에 얹는 글자 — 웹 `--on-danger-fill`. */
  onDangerFill: string;
  /** A settled success. */
  ok: string;
  okSurface: string;
  okBorder: string;
  /**
   * 스크림 — 시트 뒤를 덮는 층.
   *
   * 색이 아니라 **방향**이다: 어느 스킴에서든 뒤를 어둡게 해서 앞의 시트가 앞으로
   * 나오게 한다. 그래서 라이트에서도 밝아지지 않는다 — 잉크를 알파와 함께 쓰고
   * (`text` 계열), `bg` 를 빌려 쓰지 않는다. `bg` 에 알파를 걸면 라이트에서
   * 스크림이 배경을 **밝혀** 시트가 뒤로 물러난다. 웹의 `--scrim` 이 같은 이유로
   * 자기 토큰을 갖는다.
   *
   * 알파가 스킴마다 다른 것도 웹과 같다: 밝은 종이를 24%(`3d`) 로 눌러 얻는 분리를
   * 이미 어두운 밤하늘에서 얻으려면 훨씬 짙어야 한다(62%, `9e`). 두 값 다 웹
   * `--scrim` 을 `#rrggbbaa` 로 옮긴 것이다 — RN 은 `rgb(… / …)` 를 모른다.
   *
   * 지켜야 하는 것은 비율이 아니라 **부호**이고, `paletteContrast.test.ts` 가 두
   * 스킴에서 그것을 합성해 잰다: 스크림은 모든 표면을 어둡게 하고, 스크림 걸린
   * 어떤 표면보다 시트(`surface`)가 밝다.
   */
  scrim: string;
  /** 그림자. 스킴과 무관하게 아래 방향이라 팔레트를 따라가지 않는다. */
  shadow: string;
}

/**
 * 여명(Dawn)의 밤. 웹 `tokens.css` 의 **다크 항**을 역할로 옮긴 것이다.
 *
 * ## 이 팔레트가 세 번에 걸쳐 온 길
 *
 * 이 앱이 RN-C2 에서 입고 나온 v0 은 다크 한 벌이었고, 값은 그 화면들이 그때 쓰던
 * 회색·보라·민트였다. U2 가 라이트를 웹의 라이트 항으로 열여섯 역할 정렬했을 때
 * (#1153) 다크는 손대지 않았고, #1155 가 accent 가족 여섯만 옮겼다. 남은 나머지가
 * 여기서 온다 (#1164).
 *
 * 남겨 두면 무슨 일이 일어나는지는 이미 실측됐다. 스킴을 바꾸면 **색이 계열째
 * 갈아탄다**: 에이전트가 라이트에서는 새벽 남색(`--agent` #4a6785 · OKLCH 색상각
 * 249.90°)이고 다크에서는 네온 보라(#b58bd6 · 309.32°)였다 — **같은 역할의 두 스킴이
 * 59.42° 벌어져 있었다.** 그것은 한 아이덴티티의 두 스킴이 아니라 두 아이덴티티다
 * (정렬 뒤 1.06° — #7fa0c4 250.96°). 웹 정본이 그 색을 두고 적어 둔 규율이
 * *"never neon AI purple"* 이다.
 *
 * 이 각을 잴 때 **무엇과 무엇을 재는지**를 위처럼 값과 함께 적는다. 초판이 여기에
 * 159° 를 적었고 그것은 다른 쌍의 값이었다 — 라이트의 `agent` 와 라이트의 `accent`
 * 사이(159.32°). 스킴 **간** 같은 역할을 재야 할 자리에 스킴 **안** 두 역할의 각이
 * 앉은 것이고, 두 항을 hex 로 함께 적어 두면 다음 사람이 그 자리에서 다시 계산해
 * 볼 수 있다 (#1186 리뷰 M1).
 *
 * 그리고 그것이 **위계까지** 흔들었다. 웹이 위험 순서의 자로 세운 것은 대비가 아니라
 * 채도이고(`--danger` 주석), 옛 다크는 danger C 0.1305 · warn C 0.1295 로 그 순서가
 * 1.008 배 차이의 우연이었다. 웹 다크 항은 같은 자리에서 0.1661 · 0.1407 (1.18배)다.
 *
 * ## 짝 있는 열여섯은 바이트로 같다
 *
 * 파일 머리 주석의 대응표 그대로다. 기대값을 이 파일에 적어 두지 않고
 * `paletteContrast.test.ts` 가 웹 `tokens.css` 를 **읽어서** 맞춘다.
 *
 * ## 짝 없는 열은 관계에서 푼다 (발명 금지)
 *
 * accent 파생 셋은 #1155 가 푼 그대로이고 값도 그대로다 — 부모(`accent`)가 안
 * 움직였기 때문이다:
 *   accentPressed  accent 의 색상각 위, L −0.0887 (라이트가 같은 역할에 쓴 걸음)
 *   accentText     같은 색상각, L +0.0502 · 채도 ×0.9 (라이트의 같은 비)
 *   accentSurfaceStrong  accentSurface 에서 L +0.0577 · 채도 ×1.3
 *
 * 상태 3가족(warn·danger·ok)의 채움·테두리·잉크 여덟은 부모가 움직였으므로 따라간다.
 * **바뀐 것은 색상각뿐이다**: 각 값은 자기 앵커에 대해 쓰던 걸음(L 차)과 채도를 그대로
 * 들고, 자기 tone 이 정렬되며 돈 각도만큼(`warn` +7.21° · `danger` +10.42° ·
 * `ok` −10.10°) 같이 돈다. tone 대비 오프셋은 정렬 전후로 같다.
 *
 *   앵커가 `bg` 인 것 — 채움과 테두리는 **배경을 물들이는** 값이라 배경에서 잰다.
 *   그래서 `bg` 가 웹 값으로 L +0.0258 밝아진 만큼 여섯도 함께 밝아졌고, 배경 위
 *   세기(대비비)는 정렬 전과 같다. 이 규율을 안 지키면 착지 틴트(#1076)가 고도 한 단
 *   보다 어두워진다 — 물듦이 카드보다 조용해지는 것이라 뜻이 뒤집힌다.
 *
 *   앵커가 자기 tone 인 것 — `onWarn`(채움 위의 글자)과 `dangerText`(상자 안의 문장)
 *   는 배경이 아니라 그 tone 에 매여 있다. tone 의 L 이 움직인 만큼 따라간다.
 */
export const darkPalette: Palette = {
  bg: '#17161a',
  surface: '#201f24',
  surfacePressed: '#26252c',
  border: '#34323b',
  text: '#ececf1',
  textMuted: '#9b98a3',
  textFaint: '#6f6e73',
  // accent 가족 — 파랑이었다 (#1155). 라이트가 웹의 라이트 항을 값 단위로 옮긴
  // 뒤에도(U2) 다크만 선존재 파랑(#3b6fd4)을 들고 있었고, 그래서 같은 앱이 스킴을
  // 바꾸면 「내 것」의 색이 계열째 갈아탔다. 웹은 한 줄로 두 스킴을 적으므로
  // (`light-dark(#a54c08, #f0a850)`) 그 곳에서는 일어날 수 없는 일이다.
  //
  // 웹에 짝이 있는 셋은 **바이트로 같다** — 라이트가 이미 그렇게 정렬됐다:
  //   accent ← --accent(#f0a850) · accentSurface ← --accent-soft(#33261a)
  //   onAccent ← --on-accent(#17161a)
  // 짝이 없는 셋은 위 주석의 걸음이고, `paletteContrast.test.ts` 가 두 스킴에서 잰다.
  accent: '#f0a850',
  accentPressed: '#d28c30',
  accentText: '#fcba6e',
  accentSurface: '#33261a',
  accentSurfaceStrong: '#453323',
  // 종이의 흰색이었다 (U2). 그때 두 스킴의 accent 채움은 **둘 다 어두웠고**
  // (다크 파랑 #3b6fd4 · 라이트 #a54c08) 그래서 그 위의 글자도 둘 다 종이색이었다.
  // 호박으로 정렬하면서 다크의 채움만 밝아졌으므로(#f0a850, bg 위 8.94:1) 그 위의
  // 글자는 반대쪽으로 뒤집힌다 — 웹의 `--on-accent` 가 다크에서 `#17161a` 인 것과
  // 같은 이유이고, 값도 그것이다. 채움 위 8.94:1 · 눌린 채움 위 6.46:1.
  onAccent: '#17161a',
  // 네온 보라(#b58bd6 · 309.32°)였다 (#1164). 라이트의 `--agent`(#4a6785 · 249.90°)
  // 와 색상각이 **59.42°** 벌어져 있었으므로 스킴 전환이 에이전트를 **다른 인물**로
  // 만들었다. 이 값(#7fa0c4)은 250.96° 라 라이트와 1.06° 다.
  agent: '#7fa0c4',
  agentSurface: '#1e2836',
  warn: '#d4a72c',
  warnSurface: '#292415',
  warnBorder: '#4e4222',
  onWarn: '#191405',
  danger: '#ff796b',
  dangerSurface: '#312223',
  dangerBorder: '#623635',
  dangerText: '#fec2bd',
  // 파괴 채움 (#1210 D2). 웹 `--danger-fill` 다크 항 그대로다. 이 자리에 값이 없어서
  // 「거부 확정」이 `dangerBorder`(#623635, 카드 위 1.64:1)를 바탕으로 쓰고 있었다 —
  // 그 옆의 「승인 확정」은 같은 카드 위 8.12:1 이다. 이 값은 카드 위 5.83:1 ·
  // bg 위 6.42:1 이고 채도는 accent 아래다(0.1130 대 0.1336): 파괴가 보이되 주
  // 액션을 이기지 않는다.
  dangerFill: '#dc817e',
  onDangerFill: '#17161a',
  ok: '#57ab5a',
  okSurface: '#1e2a20',
  okBorder: '#38503a',
  scrim: '#09080b9e',
  shadow: '#000000',
};

/**
 * 여명(Dawn)의 낮. 웹 `tokens.css` 의 라이트 항을 역할로 옮긴 것이고, 웹에 짝이
 * 없는 역할은 다크가 지키던 관계를 라이트에서 다시 푼 답이다 (파일 머리 주석).
 *
 * 순백(#ffffff)도 순흑(#000000)도 쓰지 않는다 — 종이의 흰색은 `#fffefb` 다.
 * 웹 팔레트가 처음부터 갖고 있던 규율이고, 폰이 그것을 어기면 두 클라가 같은
 * 스킴에서 다른 흰색을 낸다.
 */
export const lightPalette: Palette = {
  bg: '#f7f6f3',
  surface: '#fffefb',
  surfacePressed: '#e7e3db',
  border: '#e4e0d8',
  text: '#24211c',
  textMuted: '#6a655f',
  textFaint: '#84817d',
  accent: '#a54c08',
  accentPressed: '#7f3a06',
  accentText: '#8f4207',
  accentSurface: '#f4e7d6',
  accentSurfaceStrong: '#eed5b0',
  onAccent: '#fffefb',
  agent: '#4a6785',
  agentSurface: '#e6ebf2',
  warn: '#8a5c00',
  warnSurface: '#f7ecd2',
  warnBorder: '#d9bd7e',
  onWarn: '#fffefb',
  danger: '#b3261e',
  dangerSurface: '#fae9e7',
  dangerBorder: '#e2b0ab',
  dangerText: '#8f1d16',
  // 웹 `--danger-fill` 라이트 항 (#1210 D2). 카드 위 7.52:1 · bg 위 7.02:1.
  dangerFill: '#8c393d',
  onDangerFill: '#fffefb',
  ok: '#187533',
  okSurface: '#e3f1e6',
  okBorder: '#a9d2b3',
  scrim: '#24211c3d',
  shadow: '#000000',
};

/**
 * 다크 스킴의 **낱값**.
 *
 * 앱 코드는 이것을 읽지 않는다 — 화면에 그리는 색은 `useStyles(buildStyles)` 가
 * 그때의 스킴에서 고른다(`design/theme.tsx`). 이 별칭이 남아 있는 자리는 렌더
 * 밖에서 값 자체를 물어야 하는 곳뿐이다: 대비를 재는 테스트, 그리고 두 스킴을
 * 나란히 세우는 하네스.
 *
 * `src/` 안에서 이것을 다시 import 하면 그 화면만 스킴을 안 따라가게 된다.
 * 그래서 규칙은 취향이 아니라 기계다 — `__tests__/themeSwitch.test.tsx` 가
 * `src/` 전수를 훑어 이 이름의 import 를 0 으로 단정한다.
 */
export const color: Palette = darkPalette;

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
  /**
   * SAS 4자리처럼 두 화면 사이에서 비교하는 숫자 — 표면을 지배해야 한다.
   * One clear step above `title` (26). Not paired with web `--text-display`
   * (20px): that role is a page heading, this one is a number to match aloud.
   */
  display: 32,
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

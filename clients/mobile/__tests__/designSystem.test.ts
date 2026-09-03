import fs from 'node:fs';
import path from 'node:path';

import {
  ATTACHMENT_TRAY_MAX_HEIGHT,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
} from '../src/design/tokens';

// =============================================================================
// 오르트 구름 — 비색(非色) 축의 웹 정본 대조 (#1211 D2·D3)
//
// `paletteContrast.test.ts` 가 **색**에 대해 하는 일을 나머지 축에 한다: 웹
// `tokens.css` 를 읽어서 폰의 스케일이 그 정본과 어긋나지 않았는지 묻는다.
// 기대값을 여기 베껴 적으면 웹이 움직인 날 폰만 조용히 뒤처지므로, 출처는 언제나
// 그 파일이다 — 색 대조가 세 번(#1153·#1155·#1164)에 걸쳐 세운 규율 그대로다.
//
// ## 왜 이 파일이 필요했나 — 색 말고는 아무 축도 대조되지 않았다
//
// 감사(2026-08-09)의 실측: 색 정본은 정말로 한 방향으로 흐르는데(`PAIRS` 15쌍이
// 바이트로 대조된다), 그 표는 **전부 색이다.** 나머지 축은 이미 갈라져 있었고
// 아무것도 그것을 세지 않았다 — 간격에 32 가 없고, 반경 `md` 가 웹 10 · 폰 8 이고,
// 타입 스케일은 역할이 겹치는 짝이 하나뿐이다.
//
// ## 이 파일이 세 가지를 가른다
//
//   **짝(PAIRED)**      웹에 같은 뜻의 값이 있다 → **바이트로** 같아야 한다.
//   **분기(DIVERGENT)** 이름은 짝인데 값이 다르다 → 목록에 이유와 함께 **열거**하고,
//                       그 목록이 자라면 빨개진다. 그리고 분기의 크기에 상한을 둔다.
//   **홀로(UNPAIRED)**  한쪽에만 있는 역할 → 열거하고, 폰 쪽 값은 **관계로** 푼다
//                       (#1163·#1186 이 accent 파생과 상태 3가족에 쓴 방식).
//
// 세 목록이 전부 **계산된 집합과 대조**된다는 것이 요점이다. 색 대조의 주석이
// *"웹에만 있고 폰에 짝이 없는 토큰은 여기 없다: … --danger-fill"* 이라고 정직하게
// 적어 두었지만, 그 문장은 산문이라 구멍이 자라도 아무 일이 없었다. 여기서는 구멍이
// **세어지고**, 하나 더 생기면 이 파일이 빨갛다.
// =============================================================================

const WEB_TOKENS_CSS = fs.readFileSync(
  path.join(__dirname, '../../web/src/design/tokens.css'),
  'utf8',
);

/** `--spacing-<name>: <n>px;` 전부. 소비자가 읽는 표는 언제나 이 파일이다. */
function webSpacing(): Record<string, number> {
  const steps: Record<string, number> = {};
  for (const found of WEB_TOKENS_CSS.matchAll(
    /^\s*--spacing-([a-z0-9-]+):\s*(-?[\d.]+)px;/gm,
  )) {
    steps[found[1]] = Number(found[2]);
  }
  return steps;
}

/** `--<name>: <n>px;` 한 값. 셸 기하(`--tap-target` 등)를 읽는 경로다. */
function webPx(name: string): number {
  const found = new RegExp(`--${name}:\\s*(-?[\\d.]+)px;`).exec(WEB_TOKENS_CSS);
  if (!found) throw new Error(`--${name} 를 웹 tokens.css 에서 못 찾았다`);
  return Number(found[1]);
}

function webRadius(): Record<string, number> {
  const steps: Record<string, number> = {};
  for (const found of WEB_TOKENS_CSS.matchAll(
    /^\s*--radius-([a-z]+):\s*([\d.]+)px;/gm,
  )) {
    steps[found[1]] = Number(found[2]);
  }
  return steps;
}

/** `--text-<role>: <n>rem;` 을 px 로. 웹의 루트 글자는 브라우저 기본 16px 이다. */
function webText(): Record<string, number> {
  const roles: Record<string, number> = {};
  for (const found of WEB_TOKENS_CSS.matchAll(
    /^\s*--text-([a-z][a-z0-9-]*?):\s*([\d.]+)rem;/gm,
  )) {
    if (found[1].endsWith('--line-height')) continue;
    roles[found[1]] = Number(found[2]) * 16;
  }
  return roles;
}

const WEB_SPACING = webSpacing();
const WEB_RADIUS = webRadius();
const WEB_TEXT = webText();

/** 리듬 단계(숫자 이름 + `0`·`px`). 낱말 이름은 격자 밖 **측정값**이라 다른 축이다. */
const isRhythm = (name: string) => /^(?:0|px|\d+)$/.test(name);
const WEB_RHYTHM = Object.fromEntries(
  Object.entries(WEB_SPACING).filter(([name]) => isRhythm(name)),
);

describe('읽기 경로가 조용히 실패하지 않는다', () => {
  it('없는 이름을 물으면 터진다', () => {
    // `paletteContrast.test.ts:374` 와 같은 자리의 같은 이유. 웹이 변수를 개명하거나
    // 서식을 바꾸면 아래 표들은 **없는 값과 같다**로 통과할 수 없어야 한다.
    expect(() => webPx('spacing-that-does-not-exist')).toThrow(
      /웹 tokens.css 에서 못 찾았다/,
    );
  });

  it('세 축이 전부 읽혔다', () => {
    expect(Object.keys(WEB_RHYTHM).length).toBeGreaterThan(0);
    expect(Object.keys(WEB_RADIUS).length).toBeGreaterThan(0);
    expect(Object.keys(WEB_TEXT).length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// 간격 — 폰의 다섯 단계는 전부 웹 리듬 스케일의 단계다
// -----------------------------------------------------------------------------

describe('간격 축이 웹 정본과 같은 표 위에 있다', () => {
  /** 폰 `space` ← 웹 `--spacing-*`. 뜻이 아니라 **값**이 같아야 하는 자리다. */
  const SPACE_PAIRS: ReadonlyArray<readonly [keyof typeof space, string]> = [
    ['xs', '1'],
    ['sm', '2'],
    ['md', '3'],
    ['lg', '4'],
    ['xl', '6'],
  ];

  it.each(SPACE_PAIRS)('space.%s 가 웹 --spacing-%s 와 같다', (key, step) => {
    expect([key, space[key]]).toEqual([key, WEB_RHYTHM[step]]);
  });

  it('SAFE_GUTTER 가 스케일 위의 값이다', () => {
    // 「모든 화면이 나눠 쓰는 가로 인셋」은 발명이 아니라 리듬 단계 하나여야 한다.
    // 이 값이 격자를 벗어나면 앱의 모든 화면이 함께 격자를 벗어난다.
    expect(Object.values(WEB_RHYTHM)).toContain(SAFE_GUTTER);
    expect(SAFE_GUTTER).toBe(space.lg);
  });

  it('TOUCH_TARGET 이 웹 --tap-target 과 같다', () => {
    // 감사가 이 축을 「부분 일치」로 분류했다: 44 는 두 클라가 같은 값을 들고 있고
    // (웹 `--tap-target`, 폰 `TOUCH_TARGET`), 24(`--touch-target`)는 폰에 짝이 없다.
    // 앞의 절반은 여기서 대조되고, 뒤의 절반은 아래 목록에 열거된다.
    expect(TOUCH_TARGET).toBe(webPx('tap-target'));
  });

  it('첨부 트레이 상한이 웹 --spacing-tray-max 와 같다', () => {
    // 같은 컴포저 역할의 같은 측정이다. 어느 한쪽이 움직이면 다른 쪽도 의식적으로
    // 받거나 분기 근거를 남겨야 하므로 정본 값을 직접 읽어 대조한다 (#1703).
    expect(ATTACHMENT_TRAY_MAX_HEIGHT).toBe(webPx('spacing-tray-max'));
  });

  it('짝 없는 웹 단계가 정확히 셋이고, 그것이 자라면 여기가 빨갛다', () => {
    // 각각의 이유:
    //   0    RN 은 「없음」을 `0` 으로 쓴다. 이름을 줄 값이 아니다.
    //   px   1px 헤어라인은 CSS 의 물건이다. RN 의 선은 `StyleSheet.hairlineWidth`
    //        이거나 `borderWidth: 1` 이고, 둘 다 간격 스케일의 단계가 아니다.
    //   8    32px. 폰의 어느 표면도 아직 그만큼 열지 않는다 — 390pt 폭에서 32 인셋은
    //        본문을 326pt 로 만든다. 필요해지면 그때 `space.xxl` 을 **신설**하는 것이
    //        옳고, 없는 것을 미리 만드는 것이 아니다.
    //
    // 이 단정이 지키는 것은 값이 아니라 **정직함**이다: 웹이 단계를 하나 더하면
    // 폰은 그것을 받거나 왜 안 받는지 여기 적어야 한다. 지금까지 그런 자리가 없었다.
    const paired = new Set(SPACE_PAIRS.map(([, step]) => step));
    const unpaired = Object.keys(WEB_RHYTHM)
      .filter(step => !paired.has(step))
      .sort();
    expect(unpaired).toEqual(['0', '8', 'px']);
  });

  it('폰 스케일이 커지는 순서로 다섯 단이고, 전부 4의 배수다', () => {
    // 웹에 짝이 있으므로 이 성질은 사실 웹에서 물려받은 것이다. 그래도 여기서 재는
    // 이유는 폰이 단계를 **더할** 때 그 단계도 같은 격자 위에 있어야 하기 때문이다.
    const values = Object.values(space);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect([value, value % 4]).toEqual([value, 0]);
  });
});

// -----------------------------------------------------------------------------
// 반경 — 한 단계는 짝이고, 한 단계는 근거 없이 갈라져 있다
// -----------------------------------------------------------------------------

describe('반경 축', () => {
  it('sm 이 웹 --radius-sm 과 같다 — 버튼·칩·입력의 모서리', () => {
    expect(radius.sm).toBe(WEB_RADIUS.sm);
  });

  it('이름이 겹치면서 값이 다른 단계가 **md 하나뿐**이다', () => {
    // 감사가 이 분기를 「근거 없는 분기」로 분류했다: 반경과 타입 스케일은 대개
    // "플랫폼이 다르니 다르다"로 방어되는데(폰 본문 16pt 는 iOS 입력창 줌 문턱이라는
    // 근거가 `tokens.ts` 에 적혀 있다), md 10 대 8 에는 그런 근거가 어디에도 없다.
    //
    // 값을 맞추는 것은 **결정**이고 이 티켓의 자리가 아니다(그건 성재와 두 클라의
    // 카드가 나란히 선 화면을 함께 봐야 하는 일이다). 여기서 하는 일은 그 분기를
    // 산문에서 꺼내 **세는 것**이다: 지금은 하나이고, 둘이 되면 빨갛다.
    const shared = Object.keys(radius).filter(key => key in WEB_RADIUS);
    const divergent = shared.filter(
      key =>
        radius[key as keyof typeof radius] !==
        WEB_RADIUS[key as keyof typeof WEB_RADIUS],
    );
    expect(divergent).toEqual(['md']);
  });

  it('그 분기가 리듬 한 단보다 작다 — 두 클라의 카드가 다른 종류로 읽히지 않는다', () => {
    // 상한의 출처도 정본이다: 이 레포의 가장 작은 리듬 단계(4px)다. 그보다 벌어지면
    // 그것은 「같은 카드의 두 판본」이 아니라 서로 다른 모서리 문법이다. 실측 차 2px.
    const smallestStep = Math.min(
      ...Object.entries(WEB_RHYTHM)
        .filter(([name]) => name !== 'px' && name !== '0')
        .map(([, px]) => px),
    );
    expect(Math.abs(WEB_RADIUS.md - radius.md)).toBeLessThan(smallestStep);
  });

  it('짝 없는 단계가 양쪽에 하나씩이고, 둘 다 이유가 있다', () => {
    //   웹 lg(14)  다이얼로그·시트의 모서리. 폰의 시트는 RN 화면 전환이 그리므로
    //              이 앱에 「다이얼로그 상자」라는 자리가 아직 없다.
    //   폰 pill(999)  칩·배지의 완전 둥근 모서리. 웹은 같은 자리를 `rounded-sm` 로
    //              그린다 — 즉 이것은 폰이 **더 가진** 어휘이고, 웹으로 옮길지는
    //              결정이지 정렬이 아니다.
    const webOnly = Object.keys(WEB_RADIUS)
      .filter(key => !(key in radius))
      .sort();
    const phoneOnly = Object.keys(radius)
      .filter(key => !(key in WEB_RADIUS))
      .sort();
    expect([webOnly, phoneOnly]).toEqual([['lg'], ['pill']]);
  });

  it('폰 세 단계가 커지는 순서다', () => {
    expect(radius.sm).toBeLessThan(radius.md);
    expect(radius.md).toBeLessThan(radius.pill);
  });
});

// -----------------------------------------------------------------------------
// 타이포 — 짝이 하나뿐이고, 나머지는 관계로 푼다
// -----------------------------------------------------------------------------

describe('타이포 축', () => {
  /**
   * 역할 이름과 값이 **둘 다** 맞는 유일한 짝.
   *
   * 웹 `--text-title`(16px)과 폰 `font.body`(16)도 값이 같지만 그것은 우연이다 —
   * 한쪽은 표면 제목이고 한쪽은 본문이라 뜻이 다르고, 폰의 16 은 iOS 입력창이 줌을
   * 멈추는 크기에서 왔다(`tokens.ts` 의 `font` 주석). 우연을 짝으로 적으면 웹이 제목
   * 크기를 바꾸는 날 폰 본문이 함께 끌려간다.
   */
  const TYPE_PAIRS: ReadonlyArray<readonly [keyof typeof font, string]> = [
    ['meta', 'meta'],
  ];

  it.each(TYPE_PAIRS)('font.%s 가 웹 --text-%s 와 같다', (key, role) => {
    expect([key, font[key]]).toEqual([key, WEB_TEXT[role]]);
  });

  it('짝이 없는 역할이 양쪽에서 전부 열거돼 있다', () => {
    // 이 축은 「짝이 거의 없다」가 정답인 축이다. 웹은 rem 으로 브라우저 줌을 타고
    // 폰은 pt 로 iOS 동적 타입을 타며, 줄 높이의 뜻 자체가 다르다(웹은 무단위 비율,
    // RN 은 절대 포인트 수). 그래서 여기서 재는 것은 값의 일치가 아니라 **표가
    // 닫혀 있다는 것**이다: 어느 쪽에 롤이 하나 생기면 그것이 짝인지 아닌지를
    // 누군가 여기에 적어야 한다.
    const pairedPhone = new Set<string>(TYPE_PAIRS.map(([key]) => key));
    const pairedWeb = new Set<string>(TYPE_PAIRS.map(([, role]) => role));
    expect(Object.keys(font).filter(key => !pairedPhone.has(key)).sort()).toEqual(
      ['body', 'display', 'heading', 'label', 'title'],
    );
    expect(
      Object.keys(WEB_TEXT)
        .filter(role => !pairedWeb.has(role))
        .sort(),
    ).toEqual(['body', 'display', 'timestamp', 'title']);
  });

  it('폰 본문이 iOS 입력창 줌 문턱 위에 있다', () => {
    // `tokens.ts` 가 이 값의 이유를 적어 두었다: *"Body is 16 because that is the
    // size iOS stops zooming text fields at, and a login form that zooms on focus
    // is the first thing a person meets."* 산문으로만 있던 그 문턱을 여기서 잰다 —
    // 웹의 본문(14px)에 「맞추는」 정렬이 이 값을 15 로 내리면 로그인 폼이 줌한다.
    expect(font.body).toBeGreaterThanOrEqual(16);
  });

  it('크기 여섯 단이 겹치지 않고 내려간다', () => {
    const ranks = [
      font.display,
      font.title,
      font.heading,
      font.body,
      font.label,
      font.meta,
    ];
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]).toBeLessThan(ranks[index - 1]);
    }
  });

  /**
   * 줄 높이 ← 그 값이 실제로 담는 글자 크기. 대응은 `line` 의 각 독스트링 그대로다.
   *
   * 웹에 짝이 없는 축이라 **관계로** 푼다(#1163 이 accent 파생에, #1186 이 상태
   * 3가족에 쓴 그 방식): 줄 상자는 자기가 담는 글자보다 크다. 이것을 어기면 글자가
   * 위아래로 잘린다 — RN 은 `lineHeight` 가 절대 포인트 수라 CSS 처럼 「비율이라
   * 알아서 커지는」 안전망이 없다.
   */
  const LINE_FOR: ReadonlyArray<readonly [keyof typeof line, keyof typeof font]> =
    [
      ['head', 'label'],
      ['meta', 'meta'],
      ['label', 'label'],
      ['body', 'body'],
    ];

  it.each(LINE_FOR)('line.%s 가 font.%s 보다 크다', (lineKey, fontKey) => {
    expect(line[lineKey]).toBeGreaterThan(font[fontKey]);
  });

  it('머리줄 상자가 묘비 상자보다 얇다 — 같은 13pt 의 두 값이 뒤집히지 않는다', () => {
    // 둘 다 `font.label`(13)을 담는데 뜻이 다르다: `head` 는 그룹 머리에 **2pt만**
    // 더하려고 고른 가장 싼 상자이고(`line.head` 독스트링의 실측), `label` 은 한 줄
    // 문장이 편하게 앉는 상자다. 뒤집히면 `head` 를 고른 이유가 사라진다.
    expect(line.head).toBeLessThan(line.label);
  });

  it('줄 상자 네 단이 겹치지 않고 올라간다', () => {
    const ranks = [line.head, line.meta, line.label, line.body];
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]).toBeGreaterThan(ranks[index - 1]);
    }
  });
});

// =============================================================================
// 폰 전수 스윕 — 스케일이 있다는 것과 그것이 쓰인다는 것은 다른 문장이다
//
// 웹은 이 일을 CSS 가 한다: `--spacing: initial` 이 동적 배수를 꺼서 `py-1.5` 같은
// 격자 밖 클래스가 **아예 컴파일되지 않는다.** RN 에는 그런 층이 없다 — `marginTop:
// 13` 은 언제나 컴파일되고 화면에 그대로 나간다. 그래서 폰에서 「격자 밖은 안 된다」를
// 말하는 유일한 방법이 소스를 읽는 것이다.
//
// 지금까지 그 일을 하던 것은 `conversationVisual.test.tsx:229-241` 하나였고, 그것은
// **파일 두 개**(`Quote.tsx`·`MessageBody.tsx`)만 봤다. 나머지 여든 몇 파일은
// 무검사였다.
//
// ## 아래 목록들은 허용목록이 아니라 **잔량**이다
//
// 이 구별이 중요하다. 감사가 `MOBILE_TAP_TARGETS`(손으로 유지되는 12개 목록)를
// 비판한 이유는 그것이 **무엇을 재는지**를 정하기 때문이다 — 목록 밖은 측정되지
// 않는다. 아래 목록은 반대다: 재는 것은 `src/` **전수**이고, 목록은 그 전수가 오늘
// 세어 낸 수다. 새 파일은 0 이고, 기존 파일도 늘어나면 빨갛다. 줄어드는 것은 언제나
// 통과한다 — 가드가 수리를 벌하면 안 된다.
// =============================================================================

const SRC_DIR = path.resolve(__dirname, '../src');
const TOKENS_FILE = path.join('design', 'tokens.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 주석을 벗긴 소스. 이 저장소의 주석은 옛 값과 반례를 그대로 인용한다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '');
}

/**
 * `src/` 전수에서 정규식이 걸린 자리를 파일별로 센다. `tokens.ts` 는 스케일 자신이라
 * 언제나 제외된다.
 */
function sweep(pattern: RegExp, keep: (match: RegExpMatchArray) => boolean) {
  const counts: Record<string, number> = {};
  const samples: Record<string, string[]> = {};
  for (const file of sourceFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    if (relative === TOKENS_FILE) continue;
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const found of code.matchAll(new RegExp(pattern.source, 'g'))) {
      if (!keep(found)) continue;
      counts[relative] = (counts[relative] ?? 0) + 1;
      (samples[relative] ??= []).push(found[0].trim());
    }
  }
  return {counts, samples};
}

/**
 * 잔량 대조. 두 방향을 함께 본다 —
 *
 *   **넘침**  목록 밖 파일은 0, 목록 안 파일은 적힌 수 **이하**. 줄어드는 것은
 *             언제나 통과한다: 가드가 수리를 벌하면 안 된다.
 *   **낡음**  이제 위반이 없는 파일이 목록에 남아 있으면 빨갛다. 그러지 않으면 이
 *             목록은 「닫힌 자리를 아직 열려 있다고 말하는 문서」가 되고, 그것이
 *             감사가 여러 번 잡은 실패 양식(주석이 코드를 거짓말한다)이다.
 *
 * 둘째 방향이 여기서 안전한 이유: 이 목록들이 세는 위반은 전부 `clients/mobile/src`
 * 안에 있고, 그것을 닫는 변경은 이 파일을 함께 여는 변경이다. 한 줄 지우는 것이
 * 수리의 일부이지 벌이 아니다. (웹 쪽 `WEAK_CONTROL_BORDERS` 에는 이 방향을 두지
 * **않았다** — 그 하나를 닫는 것은 형제 티켓 #1210 이고, 머지 순서를 이 파일이
 * 정할 수 없기 때문이다.)
 */
function expectWithinRemaining(
  found: ReturnType<typeof sweep>,
  remaining: Readonly<Record<string, number>>,
) {
  const over: string[] = [];
  for (const [file, count] of Object.entries(found.counts)) {
    const allowed = remaining[file] ?? 0;
    if (count > allowed) {
      over.push(`${file}: ${count} > ${allowed} (${found.samples[file].join(' · ')})`);
    }
  }
  expect(over).toEqual([]);

  // jest 의 `expect` 는 두 번째 인자를 받지 않으므로(vitest 와 다르다) 실패했을 때
  // 무엇을 하라는 말인지는 **값 안에** 넣는다. 목록만 찍히면 다음 사람은 그것이
  // 「더해라」인지 「지워라」인지 모른다.
  const stale = Object.keys(remaining).filter(file => !(file in found.counts));
  expect(stale.length === 0 ? [] : ['잔량 목록이 낡았다 — 지워라', ...stale]).toEqual(
    [],
  );
}

describe('간격 스윕 — 격자 밖 여백이 늘지 않는다', () => {
  const SPACE_PROPS = [
    'gap',
    'rowGap',
    'columnGap',
    'margin',
    'marginTop',
    'marginBottom',
    'marginLeft',
    'marginRight',
    'marginHorizontal',
    'marginVertical',
    'padding',
    'paddingTop',
    'paddingBottom',
    'paddingLeft',
    'paddingRight',
    'paddingHorizontal',
    'paddingVertical',
  ].join('|');

  /**
   * 오늘의 잔량. 두 가족이다 —
   *
   *   **2 (반 단)**  칩·배지·태그의 세로 여백. 4 를 주면 32pt 칩이 40pt 가 되어
   *                  행 높이가 바뀐다(`MessageRow` 의 `Chips` 주석이 그 거래를 적는다).
   *   **1·3·5·6**    태그·배지의 광학 보정. `agentTag` 의 5/1 과 `badge` 의 6/2 가
   *                  그것이고, 둘 다 글자 상자에 맞춘 값이지 리듬이 아니다.
   *
   * 이 값들을 스케일로 끌어올릴지(반 단 `space.xxs = 2` 를 신설할지)는 결정이다.
   * 여기서 하는 일은 그 결정이 내려질 때까지 **수가 늘지 않게** 잡아 두는 것이다.
   */
  const REMAINING: Readonly<Record<string, number>> = {
    'design/atoms.tsx': 3,
    'features/ade/AdeControlPanel.tsx': 1,
    'features/agents/turnSurfaces.tsx': 2,
    'features/conversation/MessageActionSheet.tsx': 1,
    'features/conversation/MessageRow.tsx': 8,
    'screens/AgentDetailScreen.tsx': 1,
    'screens/AgentsScreen.tsx': 2,
    'screens/SidebarScreen.tsx': 1,
  };

  it('스케일 밖 간격 리터럴이 잔량 안에 있다', () => {
    const scale = new Set<number>([0, ...Object.values(space)]);
    expectWithinRemaining(
      sweep(
        new RegExp(`\\b(?:${SPACE_PROPS}):\\s*(-?\\d+)\\b`),
        found => !scale.has(Number(found[1])),
      ),
      REMAINING,
    );
  });
});

describe('타이포 스윕 — 스케일 밖 글자와 줄 상자가 늘지 않는다', () => {
  /**
   * 오늘의 잔량 (`fontSize`).
   *
   *   `atoms.tsx` 30 · `MessageActionSheet.tsx` 24  빈 상태의 큰 글리프.
   *   `MessageRow.tsx` 10·11  아바타 이니셜과 오버플로 표식 — 글자가 아니라 도형에
   *                           가까운 자리다.
   */
  const FONT_REMAINING: Readonly<Record<string, number>> = {
    'design/atoms.tsx': 1,
    'features/conversation/MessageActionSheet.tsx': 1,
    'features/conversation/MessageRow.tsx': 2,
  };

  /**
   * 오늘의 잔량 (`lineHeight`). `line` 이 생긴 것이 u44 이고, 그 배치는 대화 표면만
   * 옮겼다 — 목록의 화면들(`ConnectScreen`·`InboxScreen`·`SearchScreen` 등)은 아직
   * 자기 숫자를 든다. 감사가 「같은 규칙을 두 표면이 다른 강도로 지킨다」고 부른 자리다.
   */
  const LINE_REMAINING: Readonly<Record<string, number>> = {
    'design/atoms.tsx': 3,
    'features/conversation/MessageActionSheet.tsx': 2,
    'features/conversation/MessageEditorSheet.tsx': 2,
    'features/conversation/MessageRow.tsx': 1,
    'features/conversation/TypingBar.tsx': 1,
    'screens/AgentDetailScreen.tsx': 2,
    'screens/ConnectScreen.tsx': 1,
    'screens/InboxScreen.tsx': 1,
    'screens/SearchScreen.tsx': 1,
  };

  it('스케일 밖 fontSize 가 잔량 안에 있다', () => {
    const scale = new Set<number>(Object.values(font));
    expectWithinRemaining(
      sweep(/\bfontSize:\s*(\d+)/, found => !scale.has(Number(found[1]))),
      FONT_REMAINING,
    );
  });

  it('스케일 밖 lineHeight 가 잔량 안에 있다', () => {
    const scale = new Set<number>(Object.values(line));
    expectWithinRemaining(
      sweep(/\blineHeight:\s*(\d+)/, found => !scale.has(Number(found[1]))),
      LINE_REMAINING,
    );
  });
});

describe('반경 스윕 — 모서리는 세 이름에서만 나온다', () => {
  /**
   * 오늘의 잔량. 하나뿐이고 이유가 있다: `MessageBody.tsx` 의 목록 불릿은 4x4 점이라
   * `borderRadius: 2` 가 「반경 스케일의 한 단」이 아니라 **변의 절반**이다. 원을
   * 그리는 산수이지 모서리 문법이 아니다.
   */
  const REMAINING: Readonly<Record<string, number>> = {
    'features/conversation/MessageBody.tsx': 1,
  };

  it('스케일 밖 borderRadius 가 잔량 안에 있다', () => {
    const scale = new Set<number>(Object.values(radius));
    expectWithinRemaining(
      sweep(/\bborderRadius:\s*(\d+)/, found => !scale.has(Number(found[1]))),
      REMAINING,
    );
  });
});

describe('그림자 스윕 — 색은 팔레트에서만 나온다', () => {
  // 그림자는 이 시스템에서 유일하게 두 클라를 가로질러 대조할 수 없는 축이다: 웹은
  // 한 문자열(`box-shadow`)로 쓰고 RN 은 iOS 전용 `shadow*` · Android 전용
  // `elevation` · New Architecture 전용 `boxShadow` 세 API 로 나뉜다. 웹
  // `tokens.css` 에 그림자 토큰이 없는 것도 그래서다 — 웹은 Tailwind 기본 두 단
  // (`shadow-sm`·`shadow-lg`)을 쓰고, 그 어휘의 상한은 웹 쪽
  // `design/designSystem.test.ts` 가 잰다.
  //
  // 그러니 여기서 지킬 수 있는 것은 하나다: 그림자의 **색**은 팔레트의 역할이고,
  // 그 역할은 두 스킴이 같은 값을 드는 유일한 자리다(`shadow` — 그림자는 색이 아니라
  // 아래 방향이라 스킴을 따라가지 않는다). 그것이 손으로 적힌 순간 스킴 전환이
  // 그림자만 데리고 가지 않는다.
  it('shadowColor 는 언제나 토큰이다', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const relative = path.relative(SRC_DIR, file);
      if (relative === TOKENS_FILE) continue;
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      for (const found of code.matchAll(/\bshadowColor:\s*([^,\n}]+)/g)) {
        if (!/\bcolor\.\w+|\bpalette\.\w+|\btheme\b/.test(found[1])) {
          offenders.push(`${relative}: ${found[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('터치 타깃 — 44 는 손으로 적는 값이 아니라 도출되는 값이다', () => {
  /**
   * `hitSlop` 에 숫자를 직접 적은 자리의 잔량.
   *
   * `slopTo()` 가 있는 이유가 감사 M-14 다: 슬롭을 손으로 적으면 그 산수를 아무도 다시
   * 확인하지 않는다 — 12pt 한 줄(≈17pt)에 위아래 6 을 얹으면 29pt 이고 44 가 아니다.
   * 리뷰가 그렇게 넷을 셌다(답글 표식 29 · 스레드 롤업 29 · 행 오류 닫기 33 · 반응 칩
   * 가로 미보증). `MessageRow.tsx` 는 그 뒤로 `slopTo(CHIP_SIZE)`·`slopTo(line.meta)`
   * 로 도출하고, 그래서 이 목록에 없다.
   *
   * 목록의 다섯은 아직 손으로 적는다. 감사 §B-4 ③ 의 문장 그대로 **규칙이 아니라
   * 작성자 기억에 맡겨져 있는** 자리이고, 여기서 하는 일은 그 수를 세어 두는 것이다.
   */
  const REMAINING: Readonly<Record<string, number>> = {
    'design/atoms.tsx': 1,
    'features/agents/StopTurnControl.tsx': 1,
    'features/conversation/LongPressHint.tsx': 1,
    'features/conversation/MessageBody.tsx': 1,
    'features/conversation/Quote.tsx': 1,
  };

  it('손으로 적은 hitSlop 이 잔량 안에 있다', () => {
    expectWithinRemaining(sweep(/hitSlop=\{[^}]*\d[^}]*\}/, () => true), REMAINING);
  });

  it('도출식을 쓰는 자리는 이 스윕에 걸리지 않는다', () => {
    // 이 단정이 없으면 위 스윕이 「hitSlop 을 아예 쓰지 마라」로 읽힌다. 재는 것은
    // 숫자이지 속성이 아니고, `hitSlop={CHIP_HIT_SLOP}` 은 옳은 모양이다.
    const {counts} = sweep(/hitSlop=\{[^}]*\d[^}]*\}/, () => true);
    expect(counts['features/conversation/MessageRow.tsx']).toBeUndefined();
  });
});

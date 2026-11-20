import fs from 'node:fs';
import path from 'node:path';

import * as tokens from '../src/design/tokens';

// =============================================================================
// 공용 부품 밖 잔량 — 폰 화면이 공용 모양 바깥에서 새로 자라지 않는다 (#6018)
//
// `designSystem.test.ts` 의 스윕은 **리터럴 숫자**만 본다. 여섯 길은 그 눈을 비켜 간다:
// 손으로 그린 누를 것, 손으로 그린 입력, 이름을 한 번 거친 간격·반경(`CONV.gutter`),
// 눌림 흐림 숫자, 옛 반경 두 단. 여기서는 `src/` 전수를 훑어 그 여섯을 **폴더별**로
// 세고, 폴더마다 오늘의 수를 천장으로 둔다.
//
// - 천장 표는 이 파일 안 상수다(폰 `designSystem.test.ts` 의 잔량 표와 같은 관례 — 폰
//   시험은 JSON 을 따로 두지 않는다). 폴더 단위라 한 줄을 고치는 수리가 표를 건드리지
//   않아도 된다.
// - 표에 없는 폴더(새 폴더)는 0 이다. 넘치면 빨갛고, 줄어드는 것은 언제나 통과한다.
//   「0 이 된 줄이 남아 있으면 빨강」은 걸지 않는다 — 폴더 수리가 이 표 때문에 막히지
//   않게.
// - 「화면 상수」에서 빼는 이름은 손으로 적은 목록이 아니라 `design/tokens.ts` 가 실제로
//   내보내는 이름과, 그 파일이 코어에서 가져온 이름이다. 토큰이 더해지면 저절로 빠진다.
//   소문자로 시작하는 값(안전 영역·계산식·지역 변수)과 `Math` 같은 전역은 세지 않는다.
// =============================================================================

const SRC_DIR = path.resolve(__dirname, '../src');
const TOKENS_FILE = path.join('design', 'tokens.ts');
const SHEET_FORM_FILE = path.join('shell', 'sheetForm.tsx');

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
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

/** 천장의 단위: `features/<이름>` 은 두 칸, 나머지는 첫 폴더, `src` 바로 아래는 `(root)`. */
function folderOf(relative: string): string {
  const parts = relative.split(path.sep);
  if (parts.length === 1) return '(root)';
  return parts[0] === 'features' ? parts.slice(0, 2).join('/') : parts[0];
}

/** `import {a, b as c} from '@momo/core...'` 으로 이 파일이 들여온 이름. */
function coreNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const found of code.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@momo\/core[^']*'/g,
  )) {
    for (const piece of found[1].split(',')) {
      const local = piece.trim().split(/\s+as\s+/).pop();
      if (local) names.add(local);
    }
  }
  return names;
}

/** 시험이 읽는 토큰 이름은 모듈의 실제 export 다 — 손으로 옮겨 적은 목록이 아니다. */
const TOKEN_EXPORTS = new Set<string>(Object.keys(tokens));

/** 화면 상수 = 대문자 이름이면서 토큰 파일에서도 코어에서도 오지 않은 것. */
function isScreenConstant(name: string, core: ReadonlySet<string>): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && !TOKEN_EXPORTS.has(name) && !core.has(name);
}

type Counts = Record<string, number>;

interface Residue {
  counts: Counts;
  samples: Record<string, string[]>;
  total: number;
  filesRead: number;
}

/** `src/` 전수에서 `pick` 이 돌려준 자리를 폴더별로 센다. `tokens.ts` 는 스케일 자신이라 제외. */
function measure(
  pick: (code: string, relative: string, core: ReadonlySet<string>) => string[],
): Residue {
  const counts: Counts = {};
  const samples: Record<string, string[]> = {};
  let total = 0;
  let filesRead = 0;
  for (const file of sourceFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    if (relative === TOKENS_FILE) continue;
    filesRead += 1;
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const hit of pick(code, relative, coreNames(code))) {
      const folder = folderOf(relative);
      counts[folder] = (counts[folder] ?? 0) + 1;
      (samples[folder] ??= []).push(`${relative}: ${hit.trim()}`);
      total += 1;
    }
  }
  return {counts, samples, total, filesRead};
}

function expectUnderCeiling(found: Residue, ceiling: Readonly<Counts>) {
  const over: string[] = [];
  for (const [folder, count] of Object.entries(found.counts)) {
    const allowed = ceiling[folder] ?? 0;
    if (count > allowed) {
      over.push(`${folder}: ${count} > ${allowed} (${found.samples[folder].join(' · ')})`);
    }
  }
  expect(over).toEqual([]);
}

const inDesign = (relative: string) => relative.startsWith(`design${path.sep}`);

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
  'marginStart',
  'marginEnd',
  'padding',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingHorizontal',
  'paddingVertical',
  'paddingStart',
  'paddingEnd',
].join('|');
const RADIUS_PROPS = 'border(?:Top|Bottom)?(?:Left|Right|Start|End)?Radius';

/** `prop: NAME...` 에서 값이 화면 상수로 시작하는 자리. */
function screenConstantValues(code: string, props: string, core: ReadonlySet<string>) {
  const hits: string[] = [];
  for (const found of code.matchAll(
    new RegExp(`\\b(?:${props}):\\s*-?([A-Z][A-Z0-9_]*)\\b[^,}\\n]*`, 'g'),
  )) {
    if (isScreenConstant(found[1], core)) hits.push(found[0]);
  }
  return hits;
}

const PRESSABLE_CEILING: Readonly<Counts> = {
  'features/ade': 3,
  'features/agents': 9,
  'features/aiConnect': 3,
  'features/appUpdate': 1,
  'features/attachments': 24,
  'features/connection': 1,
  'features/conversation': 65,
  'features/decisionStage': 6,
  'features/directory': 2,
  'features/emoji': 6,
  'features/expressions': 22,
  'features/inbox': 3,
  'features/memory': 10,
  'features/onboarding': 4,
  'features/profile': 12,
  'features/search': 11,
  'features/work': 9,
  'i18n': 1,
  'screens': 24,
  'shell': 4,
};

const TEXT_INPUT_CEILING: Readonly<Counts> = {
  'features/conversation': 7,
  'features/emoji': 1,
  'features/expressions': 3,
  'features/profile': 1,
  'features/work': 3,
  'screens': 7,
};

const SPACE_CONSTANT_CEILING: Readonly<Counts> = {
  'features/attachments': 18,
  'features/conversation': 73,
  'features/expressions': 4,
  'features/onboarding': 22,
  'features/profile': 1,
  'features/work': 6,
  'screens': 48,
  'shell': 7,
};

const RADIUS_CONSTANT_CEILING: Readonly<Counts> = {
  'design': 3,
  'features/agents': 2,
  'features/attachments': 6,
  'features/conversation': 31,
  'features/directory': 1,
  'features/expressions': 2,
  'features/onboarding': 11,
  'features/work': 2,
  'screens': 16,
  'shell': 6,
};

const OPACITY_CEILING: Readonly<Counts> = {
  'design': 9,
  'features/agents': 1,
  'features/aiConnect': 2,
  'features/appUpdate': 1,
  'features/attachments': 4,
  'features/conversation': 20,
  'features/decisionStage': 1,
  'features/directory': 1,
  'features/emoji': 1,
  'features/expressions': 8,
  'features/inbox': 3,
  'features/memory': 4,
  'features/onboarding': 2,
  'features/profile': 6,
  'features/work': 7,
  'screens': 4,
  'shell': 3,
};

const OLD_RADIUS_CEILING: Readonly<Counts> = {
  'design': 10,
  'features/ade': 1,
  'features/agents': 3,
  'features/aiConnect': 2,
  'features/attachments': 16,
  'features/connection': 1,
  'features/conversation': 17,
  'features/decisionStage': 2,
  'features/deviceKey': 1,
  'features/directory': 1,
  'features/emoji': 2,
  'features/expressions': 3,
  'features/inbox': 2,
  'features/memory': 6,
  'features/profile': 3,
  'features/search': 1,
  'screens': 20,
};

describe('공용 부품 밖 잔량 — 폰', () => {
  it('손으로 그린 <Pressable 이 design/ 밖에서 늘지 않는다', () => {
    expectUnderCeiling(
      measure((code, relative) => (inDesign(relative) ? [] : code.match(/<Pressable\b/g) ?? [])),
      PRESSABLE_CEILING,
    );
  });

  it('손으로 그린 <TextInput 이 design/ · shell/sheetForm.tsx 밖에서 늘지 않는다', () => {
    expectUnderCeiling(
      measure((code, relative) =>
        inDesign(relative) || relative === SHEET_FORM_FILE ? [] : code.match(/<TextInput\b/g) ?? [],
      ),
      TEXT_INPUT_CEILING,
    );
  });

  it('간격 속성의 값이 화면 상수인 자리가 늘지 않는다', () => {
    expectUnderCeiling(
      measure((code, _relative, core) => screenConstantValues(code, SPACE_PROPS, core)),
      SPACE_CONSTANT_CEILING,
    );
  });

  it('반경 값이 화면 상수인 자리가 늘지 않는다', () => {
    expectUnderCeiling(
      measure((code, _relative, core) => screenConstantValues(code, RADIUS_PROPS, core)),
      RADIUS_CONSTANT_CEILING,
    );
  });

  it('눌림 흐림 숫자(opacity: 0.x)가 늘지 않는다', () => {
    expectUnderCeiling(
      measure(code => code.match(/\bopacity:\s*0?\.\d+/g) ?? []),
      OPACITY_CEILING,
    );
  });

  it('옛 반경 radius.sm · radius.md 가 늘지 않는다', () => {
    expectUnderCeiling(
      measure(code => code.match(/\bradius\.(?:sm|md)\b/g) ?? []),
      OLD_RADIUS_CEILING,
    );
  });
});

describe('화면 상수의 정의는 토큰 파일의 export 에서 읽힌다', () => {
  const none: ReadonlySet<string> = new Set();

  it('토큰이 내보내는 이름은 화면 상수가 아니다', () => {
    // SAFE_GUTTER · SHEET 가 손으로 적은 예외가 아니라 모듈의 실제 export 라는 것.
    for (const name of ['SAFE_GUTTER', 'SHEET', 'TOUCH_TARGET']) {
      expect([name, name in tokens]).toEqual([name, true]);
      expect([name, isScreenConstant(name, none)]).toEqual([name, false]);
    }
  });

  it('토큰 파일에 없는 대문자 이름은 화면 상수다', () => {
    expect(isScreenConstant('CONV', none)).toBe(true);
    expect(isScreenConstant('NOT_A_TOKEN_EXPORT', none)).toBe(true);
  });

  it('코어에서 가져온 이름과 소문자·전역은 세지 않는다', () => {
    expect(isScreenConstant('CORE_SCALE', new Set(['CORE_SCALE']))).toBe(false);
    expect(isScreenConstant('insets', none)).toBe(false);
    expect(isScreenConstant('Math', none)).toBe(false);
  });

  it('값 읽기 경로가 비어 있지 않다 — 빈 export 위에서 초록이 되지 않는다', () => {
    expect(TOKEN_EXPORTS.size).toBeGreaterThan(10);
    expect(measure(() => []).filesRead).toBeGreaterThan(100);
  });
});

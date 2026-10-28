import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// 바텀시트 끌어내려 닫기 전수 점검 (#4612). 본문 끌기는 「스크롤이 맨 위일 때만」 시트가 가져가는데(`sheetModel.claimsSheetDrag`),
// 그 「맨 위인가」는 **본문의 세로 스크롤이 스스로 시트에 알려야** 안다(`usePageSheetScroll`). 알리지 않는 날 `ScrollView`·`FlatList` 를
// 시트 안에 두면 본문 끌기는 조용히 꺼진다(fail-closed — 머리만 끌린다) — 사용자가 「어느 시트는 본문을 끌어도 안 내려간다」고 느끼는
// 바로 그 회귀다. 시트를 한 번 손으로 옮긴 것이 아니라 소스를 훑어 **계속** 센다.
//
// 이것은 소스 문자열 점검이다. 알림이 실제로 시트에 닿는지(맨 위일 때만 가져가고 중간이면 안 가져감)는 시트별 시험이 잰다 —
// `fixtures/sheetContract.tsx` 의 `describeCloseContract` 여덟 번째 시험(본문 끌기)과 `sheetDrag.test.tsx`.
// 여기가 잡는 것은 「시트 파일에 알리지 않는 세로 스크롤이 들어왔다」뿐이다.
// =============================================================================

const SRC = path.join(__dirname, '../src');

function sources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
const read = (file: string) => fs.readFileSync(file, 'utf8');
/** 주석을 뗀 소스 — 주석 속의 `<FlatList` 를 코드로 세지 않는다. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (file: string) => stripComments(read(file));

/**
 * 세로 스크롤이 될 수 있는 날 컴포넌트의 여는 태그. `<` 앞이 식별자 글자나 점이면 JSX 가 아니라 제네릭이다
 * (`useRef<ScrollView>(null)`, `FlatList<Row>` 의 형 인자) — 태그로 세지 않는다.
 */
const RAW_SCROLL = /(?<![\w.])<(ScrollView|FlatList|SectionList|FlashList|VirtualizedList)\b/g;

/** `text` 의 `start`(`<` 의 자리)에서 여는 태그가 끝나는 곳까지. 중괄호 안의 `=>` 를 태그의 끝으로 읽지 않는다. */
function openingTag(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0 && text[i - 1] !== '=') return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/**
 * 주석을 뗀 소스 `text` 안에서 **시트에 자기를 알리지 않는 세로 스크롤**의 이름들. 알린다는 것은 같은 파일에서
 * `const x = usePageSheetScrollProps(...)` 로 받은 `x` 를 그 스크롤의 여는 태그에 `{...x}` 로 펼친 것이다. 가로 스크롤(`horizontal`)은
 * 시트의 세로 끌기와 겨루지 않으니 뺀다.
 */
function unwiredScrolls(text: string): string[] {
  const hookVars = [...text.matchAll(/const\s+(\w+)\s*=\s*usePageSheetScrollProps\(/g)].map(m => m[1]);
  const offenders: string[] = [];
  for (const match of text.matchAll(RAW_SCROLL)) {
    const tag = openingTag(text, match.index ?? 0);
    if (/\bhorizontal\b/.test(tag)) continue;
    if (hookVars.some(name => tag.includes(`{...${name}}`))) continue;
    offenders.push(match[1]);
  }
  return offenders;
}

describe('점검 도구가 실제로 잡는다 (실패할 수 있는 가드)', () => {
  it('알리지 않는 날 스크롤은 잡고, 알리는 것·가로 스크롤은 잡지 않는다', () => {
    expect(unwiredScrolls('<FlatList data={a} />')).toEqual(['FlatList']);
    expect(unwiredScrolls('<ScrollView bounces={false}>')).toEqual(['ScrollView']);
    expect(unwiredScrolls('<SectionList onScroll={() => {}} />')).toEqual(['SectionList']); // 제 onScroll 은 시트에 알린 게 아니다
    expect(unwiredScrolls('const s = usePageSheetScrollProps();\n<FlatList {...s} data={a} />')).toEqual([]);
    expect(unwiredScrolls('const s = usePageSheetScrollProps();\n<FlatList data={a} />')).toEqual(['FlatList']); // 받아 놓고 안 펼침
    expect(unwiredScrolls('<ScrollView horizontal showsHorizontalScrollIndicator={false}>')).toEqual([]);
    expect(unwiredScrolls('const s = usePageSheetScrollProps();\n<FlatList onEndReached={() => load()} {...s} />')).toEqual([]);
  });

  it('제네릭의 형 인자(`useRef<ScrollView>`)는 태그가 아니다', () => {
    expect(unwiredScrolls('const ref = useRef<ScrollView>(null);\nconst list = useRef<FlatList<Row>>(null);')).toEqual([]);
  });

  it('여는 태그의 끝을 중괄호 안의 화살표 함수에서 읽지 않는다', () => {
    const text = 'const s = usePageSheetScrollProps();\n<FlatList renderItem={({item}) => <Row item={item} />} {...s} />';
    expect(unwiredScrolls(text)).toEqual([]);
  });
});

describe('시트 안의 세로 스크롤은 모두 시트에 자기를 알린다 (#4612)', () => {
  /** `<PageSheet` 를 세우는 소스 — 시트의 몸이 거기 있다(몸을 다른 파일에서 가져오는 시트는 시트별 계약 시험이 잰다). */
  const sheetFiles = sources().filter(file => /<PageSheet\b/.test(code(file)));

  it('시트 파일이 열일곱 개 넘게 있다(점검이 빈 목록을 훑고 통과하지 않는다) — 다른 사람 프로필 시트(#4319)가 열여섯째, 대화 머리 ⋮ 시트(#4319)가 열일곱째다', () => {
    expect(sheetFiles.length).toBeGreaterThanOrEqual(17);
    // 끌기 영역이 없던 자체 Modal 시트가 이 점검 안으로 들어왔다 — 빠지면 그 시트의 본문 스크롤이 시트에 자기를 알리는지 아무도 세지 않는다.
    expect(sheetFiles.map(rel)).toContain('features/directory/MemberProfileSheet.tsx');
    // 시스템 액션 시트(`ActionSheetIOS`)이던 대화 머리 ⋮ 가 공용 시트가 됐다 — 이 시트도 같은 점검 안에 있다.
    expect(sheetFiles.map(rel)).toContain('features/conversation/ConversationMenuSheet.tsx');
  });

  it('시트 파일의 세로 스크롤은 `SheetScroll` 이거나 `usePageSheetScrollProps` 를 펼친 것뿐이다', () => {
    const offenders = sheetFiles.flatMap(file => unwiredScrolls(code(file)).map(name => `${rel(file)}: <${name}`));
    expect(offenders).toEqual([]);
  });

  it('`SheetScroll` 자신이 그 알림을 펼친다 — 이것이 끊기면 `SheetScroll` 을 쓰는 모든 시트의 본문 끌기가 한꺼번에 꺼진다', () => {
    expect(unwiredScrolls(code(path.join(SRC, 'design/sheetParts.tsx')))).toEqual([]);
    expect(code(path.join(SRC, 'design/sheetParts.tsx'))).toMatch(/usePageSheetScrollProps\(/);
  });
});

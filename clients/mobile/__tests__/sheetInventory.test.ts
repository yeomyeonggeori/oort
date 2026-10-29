// sheetInventory — 바텀시트 점검 (소스 목록)
// 합친 원본: sheetInventory4458.test.ts, sheetDragInventory4612.test.ts
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import fs from 'node:fs';
import path from 'node:path';

// ---- 아래 묶음들이 함께 쓰는 고정값·도구 (원래 파일마다 글자 그대로 같게 선언돼 있던 것)
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
/**
 * 주석을 뗀 소스 — **식별자**를 셀 때 쓴다. 옛 이름을 설명하는 주석(「옛 `GroupSection` 은…」)은 되돌아온 것이 아니다.
 * 글자 「닫기」 점검은 JSX 글자가 대상이라 원문을 그대로 본다.
 */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (file: string) => stripComments(read(file));

// =============================================================================
// 합친 시험: 원래 sheetInventory4458.test.ts (#4458)
// =============================================================================
describe('sheetInventory (#4458)', () => {
  // =============================================================================
  // 폰의 바텀시트 전수 점검 (#4458). 「닫기」 글자 단추 0건과 「모든 시트가 공용 머리·부품을 쓴다」를
  // 한 번 손으로 센 것이 아니라 소스를 훑어 **계속** 센다 — 새 시트가 옛 모양으로 들어오면 여기서 붉어진다.
  //
  // 이것은 소스 문자열 점검이라 렌더가 맞는지는 시트별 시험(각 시험 파일의 「공용 부품」·`describeCloseContract`)이
  // 잰다. 여기가 잡는 것은 「옛 모양이 다시 들어왔다」뿐이다.
  // =============================================================================

  const exists = (name: string) => fs.existsSync(path.join(SRC, name));

  /**
   * 시트가 아니거나 다른 이슈가 옮기는 자리 — 이유가 없는 면제는 없다. (프로필 시트 둘은 면제에서 나갔다: 내 프로필은 #4457 이
   * 설정 페이지로 대체해 파일째 지웠고, 다른 사람 프로필은 #4319 가 `PageSheet` 로 옮겨 글자 「닫기」 가 없다. 없는 파일의 면제가
   * 남으면 그 이름으로 파일이 되살아났을 때 조용히 통과한다.)
   */
  const TEXT_CLOSE_EXEMPT: Record<string, string> = {
    'features/conversation/MessageRow.tsx':
      '행 안의 오류 「닫기」 — 시트가 아니고, 이 파일은 형제 이슈가 만진다',
  };

  /** 보이는 글자 「닫기」 단추의 소스 모양. 접근성 이름(`accessibilityLabel="닫기"`·`closeLabel=`)은 남는다. */
  const TEXT_CLOSE = [
    /^\s*닫기\s*$/m, // JSX 여러 줄 글자
    />\s*닫기\s*</, // 태그 사이 글자
    /\blabel="닫기"/, // OutlineButton·SheetRow 의 label
    /\blabel:\s*'닫기'/,
    /[=]\s*'닫기'/, // 낱말 상수
    /TEAM_BOARD_COPY\.drawerClose/, // 웹 서랍과 공용인 맨 「닫기」 문구
  ];

  describe('「닫기」 글자 단추 0건 (#4458)', () => {
    it('면제 목록 밖의 어느 소스에도 보이는 글자 「닫기」 단추가 없다', () => {
      const offenders: string[] = [];
      for (const file of sources()) {
        const name = rel(file);
        if (name in TEXT_CLOSE_EXEMPT) continue;
        const text = read(file);
        for (const pattern of TEXT_CLOSE) {
          if (pattern.test(text)) offenders.push(`${name}: ${pattern}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('면제는 이유가 있는 하나뿐이고 지금 있는 파일이다 — 이유 없는 면제를 슬쩍 더하거나 지워진 파일의 면제를 두면 붉어진다', () => {
      expect(Object.keys(TEXT_CLOSE_EXEMPT).sort()).toEqual([
        'features/conversation/MessageRow.tsx',
      ]);
      for (const reason of Object.values(TEXT_CLOSE_EXEMPT)) expect(reason.length).toBeGreaterThan(8);
      for (const name of Object.keys(TEXT_CLOSE_EXEMPT)) expect([name, exists(name)]).toEqual([name, true]);
    });

    it('점검의 정규식이 옛 모양을 실제로 잡는다 (사보타주 없이도 단정이 붉어질 수 있다는 증거)', () => {
      const oldShapes = [
        '<Text style={styles.navButtonLabel}>\n  닫기\n</Text>',
        '<Text>닫기</Text>',
        '<OutlineButton label="닫기" onPress={onClose} />',
        "export const RECEIPT_CLOSE = '닫기';",
        '{TEAM_BOARD_COPY.drawerClose}',
      ];
      for (const shape of oldShapes) {
        expect([shape, TEXT_CLOSE.some(pattern => pattern.test(shape))]).toEqual([shape, true]);
      }
      // 접근성 이름은 글자 단추가 아니다 — 남아야 한다.
      for (const kept of [
        'accessibilityLabel="닫기"',
        'closeLabel="메시지 액션 닫기"',
        'scrimLabel="새 채널 닫기"',
        "const MISSED_DISMISS_A11Y = '안 읽은 동안 요약 닫기';",
      ]) {
        expect([kept, TEXT_CLOSE.some(pattern => pattern.test(kept))]).toEqual([kept, false]);
      }
    });
  });

  describe('식별자 점검의 주석 떼기', () => {
    it('주석 속의 옛 이름은 세지 않고 코드 속의 것은 센다', () => {
      const stripped = stripComments(
        "// 옛 `GroupSection` 은 이제 없다\n/* GroupRow */\nconst url = 'https://x.test'; // SheetRow\nimport {GroupRow} from './a';\n",
      );
      expect(stripped).toMatch(/\bGroupRow\b/); // import 줄
      expect(stripped).not.toMatch(/GroupSection/);
      expect(stripped).not.toMatch(/SheetRow/);
      expect(stripped).toMatch(/https:\/\/x\.test/); // 문자열 안의 // 는 남는다
    });
  });

  describe('모든 바텀시트는 공용 그릇과 머리를 쓴다 (#4458)', () => {
    /** `*Sheet.tsx` 중 바텀시트가 아닌 것 / 다른 이슈가 옮기는 것. */
    const NOT_PAGE_SHEET: Record<string, string> = {
      'features/deviceLink/QrScannerSheet.tsx': '전체 화면 카메라 모달 — 바텀시트가 아니다',
    };

    const sheetFiles = sources().filter(
      file => /Sheet\.tsx$/.test(file) && path.basename(file) !== 'PageSheet.tsx',
    );

    it('시트 파일이 열 개 넘게 있다(점검이 빈 목록을 훑고 통과하지 않는다)', () => {
      expect(sheetFiles.length).toBeGreaterThanOrEqual(12);
    });

    it('`*Sheet.tsx` 는 `PageSheet` + `SheetHeader` 를 쓴다 — 면제는 이유가 있는 하나뿐이고 지금 있는 파일이다(다른 사람 프로필 시트는 이제 면제가 아니다)', () => {
      for (const name of Object.keys(NOT_PAGE_SHEET)) expect([name, exists(name)]).toEqual([name, true]);
      const offenders: string[] = [];
      for (const file of sheetFiles) {
        const name = rel(file);
        if (name in NOT_PAGE_SHEET) continue;
        const text = read(file);
        if (!/<PageSheet\b/.test(text)) offenders.push(`${name}: <PageSheet 가 없다`);
        if (!/<SheetHeader\b/.test(text)) offenders.push(`${name}: <SheetHeader 가 없다`);
      }
      expect(offenders).toEqual([]);
    });

    it('업데이트 시트(배너 파일 안)도 같은 그릇·머리다', () => {
      const text = read(path.join(SRC, 'features/appUpdate/AppUpdateBanner.tsx'));
      expect(text).toMatch(/<PageSheet\b/);
      expect(text).toMatch(/<SheetHeader\b/);
    });

    it('`<Modal` 은 그릇(PageSheet)과 시트가 아닌 넷에만 있다', () => {
      const allowed = new Set([
        'design/PageSheet.tsx',
        'features/deviceLink/QrScannerSheet.tsx', // 전체 화면 카메라
        'features/attachments/AttachMenu.tsx', // 앵커 팝오버 — 시트가 아니다
        'features/attachments/AttachmentViewer.tsx', // 전체 화면 사진 뷰어
        'features/directory/AvatarViewer.tsx', // 전체 화면 프로필 사진 뷰어(#4319) — 첨부 뷰어의 형제, 시트가 아니다
      ]);
      const offenders = sources()
        .filter(file => /<Modal\b/.test(read(file)))
        .map(rel)
        .filter(name => !allowed.has(name));
      expect(offenders).toEqual([]);
    });

    it('옛 머리·옛 줄(SheetTitleRow·SheetRow)은 어디에도 없다', () => {
      const offenders = sources()
        .filter(file => /\b(SheetTitleRow|SheetRow)\b/.test(code(file)))
        .map(rel);
      expect(offenders).toEqual([]);
    });

    it('옛 묶음(GroupSection·GroupRow)은 정의 하나와 같은 이름의 로컬 함수 하나에만 남는다 — 시트·설정 어디에도 되돌아오지 않는다', () => {
      // #4457 이 설정 영역(본 페이지·안쪽 장)을 새 묶음 카드로 모두 옮겼으니 프로덕션 사용처는 없다. 남은 둘은:
      //   - `design/atoms.tsx`: 옛 부품의 **정의**. 시험들이 「옛 카드가 없다」를 재려고 컴포넌트 타입을 import 한다.
      //   - `design/ThemeControl.tsx`: atoms 의 것이 아니라 같은 이름의 **로컬** 함수(머리글 + 내용, `GroupLabel`·`GroupCard`).
      // 허용 목록이 옛 설정 파일(ProfileSheet·StatusPage·AvatarPage…)을 더 들고 있으면 그 파일에 옛 묶음이 되돌아와도 이 시험이
      // 붉어지지 않는다 — 그래서 **지금 있는 둘만** 적는다.
      const remaining = new Set([
        'design/atoms.tsx',
        'design/ThemeControl.tsx',
      ]);
      const offenders = sources()
        .filter(file => /\b(GroupSection|GroupRow)\b/.test(code(file)))
        .map(rel)
        .filter(name => !remaining.has(name));
      expect(offenders).toEqual([]);
      // 이 이슈가 옮긴 시트는 새 부품만 쓴다.
      for (const name of [
        'shell/AiSheet.tsx',
        'shell/NewChannelSheet.tsx',
        'shell/AskMacSheet.tsx',
        'shell/DelegateWorkSheet.tsx',
      ]) {
        expect(exists(name)).toBe(true);
        expect(code(path.join(SRC, name))).not.toMatch(/\b(GroupSection|GroupRow|OutlineButton|NoticeBlock)\b/);
      }
    });
  });
});

// =============================================================================
// 합친 시험: 원래 sheetDragInventory4612.test.ts (#4612)
// =============================================================================
describe('sheetDragInventory (#4612)', () => {
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
});

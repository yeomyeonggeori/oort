import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// 폰의 바텀시트 전수 점검 (#4458). 「닫기」 글자 단추 0건과 「모든 시트가 공용 머리·부품을 쓴다」를
// 한 번 손으로 센 것이 아니라 소스를 훑어 **계속** 센다 — 새 시트가 옛 모양으로 들어오면 여기서 붉어진다.
//
// 이것은 소스 문자열 점검이라 렌더가 맞는지는 시트별 시험(각 시험 파일의 「공용 부품」·`describeCloseContract`)이
// 잰다. 여기가 잡는 것은 「옛 모양이 다시 들어왔다」뿐이다.
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
/**
 * 주석을 뗀 소스 — **식별자**를 셀 때 쓴다. 옛 이름을 설명하는 주석(「옛 `GroupSection` 은…」)은 되돌아온 것이 아니다.
 * 글자 「닫기」 점검은 JSX 글자가 대상이라 원문을 그대로 본다.
 */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (file: string) => stripComments(read(file));
const exists = (name: string) => fs.existsSync(path.join(SRC, name));

/**
 * 시트가 아니거나 다른 이슈가 옮기는 자리 — 이유가 없는 면제는 없다. (프로필 시트는 #4457 이 설정 페이지로 대체해 파일째
 * 지웠다 — 면제도 같이 지웠다. 없는 파일의 면제가 남으면 그 이름으로 파일이 되살아났을 때 조용히 통과한다.)
 */
const TEXT_CLOSE_EXEMPT: Record<string, string> = {
  'features/directory/MemberProfileSheet.tsx': '#4319(다른 사람 프로필)',
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

  it('면제는 이유가 있는 둘뿐이고 둘 다 지금 있는 파일이다 — 이유 없는 면제를 슬쩍 더하거나 지워진 파일의 면제를 두면 붉어진다', () => {
    expect(Object.keys(TEXT_CLOSE_EXEMPT).sort()).toEqual([
      'features/conversation/MessageRow.tsx',
      'features/directory/MemberProfileSheet.tsx',
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
    'features/directory/MemberProfileSheet.tsx': '#4319',
  };

  const sheetFiles = sources().filter(
    file => /Sheet\.tsx$/.test(file) && path.basename(file) !== 'PageSheet.tsx',
  );

  it('시트 파일이 열 개 넘게 있다(점검이 빈 목록을 훑고 통과하지 않는다)', () => {
    expect(sheetFiles.length).toBeGreaterThanOrEqual(12);
  });

  it('`*Sheet.tsx` 는 `PageSheet` + `SheetHeader` 를 쓴다 — 면제는 이유가 있는 둘뿐이고 지금 있는 파일이다', () => {
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
      'features/directory/MemberProfileSheet.tsx', // #4319
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

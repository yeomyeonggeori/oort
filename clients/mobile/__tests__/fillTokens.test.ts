import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';

// =============================================================================
// 테두리 토큰은 채움이 아니다 (#1210 D2).
//
// ## 왜 이 스위트가 생겼나
//
// 폰에는 파괴 액션의 **채움** 토큰이 없었다. 웹은 MOMO-642 R1 H-2 에서
// `--danger-fill` 을 신설해 그 자리를 닫았고, 폰의 동기화 가드는 그 토큰을 명시적
// 으로 제외한 채 통과했다(`paletteContrast.test.ts` 의 옛 주석). 잴 것이 없으면
// 아무 단정도 설 수 없고, 그 빈자리를 컴포넌트가 **가장 가까운 이름**으로 메웠다:
//
//   ApprovalDecision.tsx  buttonReject:  {backgroundColor: color.dangerBorder}
//   StopTurnControl.tsx   buttonCommit:  {backgroundColor: color.dangerBorder}
//
// 결과가 감사(2026-08-09 §B-4 ②)의 실측이다 — 다크에서 되돌릴 수 없는 「거부 확정」
// 이 카드(`surface`) 위 1.64:1, 그 옆의 「승인 확정」이 8.12:1. 팔레트 산술 가드는
// 그 내내 전부 초록이었다.
//
// ## 이 스위트가 지는 것
//
// 값이 아니라 **역할**이다. `paletteContrast.test.ts` 가 `dangerFill` 의 숫자를
// 지고(3:1·채도 순서·계열), 이 파일은 그 토큰이 실제로 쓰이는지 — 더 정확히는
// 테두리로 이름 붙은 토큰이 다시 바탕으로 새지 않는지 — 를 진다. 두 단정이 같이
// 있어야 화면의 사실이 된다.
//
// 규칙을 `danger` 에만 걸지 않는 이유: 같은 실수가 `warnBorder`·`okBorder` 에서도
// 똑같이 가능하고(셋 다 tone 위에서 같은 걸음으로 파생됐다), 그때 잡아 줄 것이
// 지금 여기 말고는 없다.
// =============================================================================

const SRC = join(__dirname, '..', 'src');

/** `backgroundColor: color.<something>Border` — 테두리 토큰이 바탕으로 샌 자리. */
const BORDER_AS_FILL = /backgroundColor:\s*(?:color|palette|theme)\.(\w*Border)\b/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

describe('#1210 D2 — 채움 토큰', () => {
  it('src/ 전수에서 테두리 토큰을 backgroundColor 로 쓰지 않는다', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.trimStart().startsWith('//')) return;
          if (BORDER_AS_FILL.test(line)) {
            offenders.push(`${relative(SRC, file)}:${index + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('initialArmed 는 하네스 전용이다 — src/ 안에 호출자가 없다', () => {
    // 확정 단계를 사진 찍을 수 있게 하려고 연 문이다(`measure/surfaces.tsx` 의
    // `destructive-confirm`). 앱이 이 prop 을 넘기면 `armedAtMs` 가 0 인 채로 확인
    // 단계가 시작되어 `CONFIRM_GUARD_MS` 더블탭 가드를 지나친 화면이 되고, 그것은
    // 되돌릴 수 없는 행동 앞의 마찰을 지우는 일이다. 규칙을 주석에만 두면 다음
    // 사람이 그 주석을 읽지 않는다.
    // 선언하는 두 파일만 이 이름을 안다. 세는 것은 **넘기는** 자리다.
    const OWNERS = [
      'features/inbox/ApprovalDecision.tsx',
      'features/agents/StopTurnControl.tsx',
    ];
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (OWNERS.includes(rel)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\binitialArmed\b/.test(line)) {
            offenders.push(`${rel}:${index + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);

    // 그리고 두 소유자가 실제로 그 이름을 갖고 있는지도 잰다 — 이름이 사라지면
    // 위 반복문은 아무것도 세지 않으면서 초록이 된다.
    for (const owner of OWNERS) {
      expect([owner, readFileSync(join(SRC, owner), 'utf8').includes('initialArmed')]).toEqual([
        owner,
        true,
      ]);
    }
  });

  it('파괴 확정 버튼 둘이 실제로 dangerFill 을 든다', () => {
    // 위 단정은 「없음」을 잰다. 이것은 「있음」을 잰다 — 누가 채움을 통째로 지워서
    // 초록을 얻는 길을 닫는다. 두 자리는 감사가 이름을 댄 바로 그 둘이다.
    const DESTRUCTIVE = [
      'features/inbox/ApprovalDecision.tsx',
      'features/agents/StopTurnControl.tsx',
    ];
    for (const file of DESTRUCTIVE) {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect([file, source.includes('backgroundColor: color.dangerFill')]).toEqual([
        file,
        true,
      ]);
      // 그리고 그 채움 위의 글자는 그 채움에 매인 잉크다. `onAccent` 를 얹으면
      // 다크에서 어두운 잉크가 어두운 바탕에 앉는다(옛 값 1.80:1).
      expect([file, source.includes('color.onDangerFill')]).toEqual([file, true]);
    }
  });
});

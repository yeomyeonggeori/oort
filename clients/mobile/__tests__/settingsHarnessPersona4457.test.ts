import fs from 'fs';
import path from 'path';

import {SETTINGS_PERSONA, settingsPersona} from '../measure/settingsOverlay';

// =============================================================================
// #4457 — 설정 표면의 캡처에는 **가상 인물**만 선다.
//
// 이 표면들의 캡처는 PR 증거로 레포에 남고 레포는 공개다(2026-10-23 규칙: 시험 fixture·계측 표면·캡처에 실명 금지).
// 하네스의 기존 `SELF` 페르소나는 실명이라, 설정 표면은 `SETTINGS_ME`·`settingsDirectory` 로 가상 인물(이도현)을 쓴다.
// 이 파일은 (1) 가상 인물 도구가 내 행만 바꾸고 (2) 설정 표면의 JSX 가 실명 페르소나(`HARNESS_MEMBER`)나 바로 만든 명부
// (`makeDirectory(`)를 다시 싣지 않는다는 것을 소스에서 잰다 — 후자가 없으면 새 표면을 더하는 사람이 옛 상수를 복사해 온다.
// =============================================================================

const SURFACES = fs.readFileSync(path.resolve(__dirname, '../measure/surfaces.tsx'), 'utf8');

/** `<Tag …/>` JSX 블록(자식 없는 태그)을 속성 값의 중괄호 깊이를 세어 잘라 온다. */
function blocksOf(tag: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = SURFACES.indexOf(`<${tag}`, from);
    if (start < 0) return out;
    let depth = 0;
    let end = -1;
    for (let i = start; i < SURFACES.length; i += 1) {
      const c = SURFACES[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (depth === 0 && c === '/' && SURFACES[i + 1] === '>') {
        end = i;
        break;
      }
    }
    out.push(SURFACES.slice(start, end));
    from = end;
  }
}

describe('가상 인물 도구', () => {
  it('내 행의 이름·핸들만 바꾸고 나머지 행은 그대로다', () => {
    const roster = [
      {id: 'me', displayName: '실제 이름', handle: 'real', role: 'owner'},
      {id: 'other', displayName: '다른 사람', handle: 'other', role: 'member'},
    ];
    const out = settingsPersona(roster, 'me');
    expect(out[0]).toEqual({...roster[0], ...SETTINGS_PERSONA});
    expect(out[1]).toBe(roster[1]);
    expect(SETTINGS_PERSONA).toEqual({displayName: '이도현', handle: 'dohyun'});
  });
});

describe('설정 표면은 실명 페르소나를 싣지 않는다', () => {
  const blocks = [...blocksOf('SettingsOverlay'), ...blocksOf('SettingsContent')];

  it('블록을 실제로 찾았다 — 못 찾으면 아래 단정이 헛돈다', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(10);
  });

  it('모든 설정 표면이 member={SETTINGS_ME}·directory={settingsDirectory(…)} 를 쓴다', () => {
    // `workspaceId={HARNESS_MEMBER.workspaceId}` 는 인물이 아니라 작업공간 id 라 정당하다 — 인물을 싣는 두 형태만 막는다.
    const offenders = blocks.filter(
      block =>
        !block.includes('member={SETTINGS_ME}') ||
        !block.includes('directory={settingsDirectory(') ||
        block.includes('member={HARNESS_MEMBER}') ||
        block.includes('makeDirectory('),
    );
    expect(offenders.map(block => block.slice(0, 80))).toEqual([]);
  });
});

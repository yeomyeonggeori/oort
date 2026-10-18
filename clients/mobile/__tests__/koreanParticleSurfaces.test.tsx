import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import {readdirSync, readFileSync, statSync} from 'fs';
import {join, relative, resolve} from 'path';
import React from 'react';

import {Composer} from '../src/features/conversation/Composer';

// =============================================================================
// 조사는 고른다, 병기하지 않는다 (goal RN-B4c / #1027)
//
// 성재 실측: *"루나은(는) 현재 일시정지되어 있습니다"*.
//
// 「루나은(는)」은 번역문이 아니라 **기계가 사람 앞에서 결정을 미루는 것**이다.
// 마지막 음절 하나로 전부 결정되는 규칙이고, 그 규칙은 이 레포에 이미 있다 —
// `@momo/core/lib/koreanParticle`(mac 에서 이식, core 호출처 7곳). 그러니 #1027 은
// 유틸 신설이 아니라 **전수 적용**의 문제였다.
//
// 이 파일은 둘을 잰다:
//
//   1. 그 규칙이 실제 화면에서 옳은 글자를 낸다 — 컴포저의 DM 힌트가 유일한
//      모바일 위반 지점이었다(아래 전수 스캔이 그 「유일함」을 계속 지킨다).
//   2. **전수 스캔.** `clients/mobile/src` 어디에도 병기형(`이(가)`)이 없고,
//      보간 바로 뒤에 조사를 손으로 붙인 자리도 없다. 문구는 한 군데서 한 번
//      틀리는 것이 아니라, 다음 화면에서 같은 모양으로 다시 틀린다 — 그래서
//      단정을 한 문장이 아니라 **소스 전체**에 건다.
//
// 서버가 쓰는 줄은 이 스캔이 닿지 못한다. paused 시스템 라인의 본문은
// `server-rust/crates/momo-agent/src/mention.rs:703`(`paused_mention_body`) 과
// `server/Sources/MomoServer/Routes/MessageRoutes.swift:1604` 가 만들어 메시지
// body 로 저장하므로, 클라이언트가 고칠 수 있는 글자가 아니다 — PR 이탈에 적었다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

function mountComposer(agent: RosterMember) {
  return render(
    <Composer recipient="place"
      directory={makeDirectory([
        member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
        agent,
      ])}
      channelLabel={agent.displayName}
      dmAgent={agent}
      onSend={() => {}}
    />,
  );
}

afterEach(cleanup);

describe('에이전트 DM 입력창 위에는 「멘션 없이 바로 말하면 …」 안내가 없다 (#4016)', () => {
  // 성재 3047: 정상일 때마다 서는 안내는 뺀다. 이름의 조사(루나가·김인턴이·Hermes가)를 고르던 규칙은
  // 이제 답하지 **않는** 경우의 문장(`dmComposerHint` 의 경고 상태)에서만 쓰이고, 그 문장은 서버 상태를
  // 받는 `useDmDeliveryHint` 의 몫이다. 여기서는 세 종류의 이름 모두에서 안내가 사라졌음을 못 박는다.
  it.each([
    ['루나', 'luna', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'],
    ['김인턴', 'kim-intern', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'],
    ['Hermes', 'hermes', 'dddddddd-1111-4111-8111-dddddddddddd'],
  ])('%s 이름이어도 안내 문장이 없다', (displayName, handle, id) => {
    mountComposer(member({id, kind: 'agent', displayName, handle}));
    expect(screen.queryByText(/멘션 없이 바로 말하면/)).toBeNull();
  });
});

// -----------------------------------------------------------------------------

const SRC = resolve(__dirname, '../src');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** 줄 앞의 `//`·`*` 주석은 스캔에서 뺀다 — 규칙을 설명하는 글에 규칙을 걸 수 없다. */
function codeLines(text: string): {line: number; text: string}[] {
  return text
    .split('\n')
    .map((text_, index) => ({line: index + 1, text: text_}))
    .filter(({text: t}) => !/^\s*(\/\/|\*|\/\*)/.test(t));
}

describe('모바일 소스 어디에도 미룬 조사가 없다', () => {
  const files = sourceFiles(SRC);

  it('병기형(이(가)·은(는)·을(를)·과(와))을 쓰지 않는다', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const {line, text} of codeLines(readFileSync(file, 'utf8'))) {
        if (/(이\(가\)|가\(이\)|은\(는\)|는\(은\)|을\(를\)|를\(을\)|과\(와\)|와\(과\))/.test(text)) {
          offenders.push(`${relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('보간 바로 뒤에 조사를 손으로 붙이지 않는다', () => {
    // 병기보다 조용한 판이다. `${name}이` 는 화면에서 절반은 맞으므로, 틀린
    // 절반을 보는 사람만 그것을 본다. 고르는 자리는 `attachParticle` 하나뿐이다.
    const offenders: string[] = [];
    for (const file of files) {
      for (const {line, text} of codeLines(readFileSync(file, 'utf8'))) {
        if (/\}(이|가|은|는|을|를|와|과|로|으로|에게)[\s.,)'"`]/.test(text)) {
          offenders.push(`${relative(SRC, file)}:${line} — ${text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('#2891 DM 힌트는 서버의 전달 상태를 따른다', () => {
  const agent = member({
    id: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
    kind: 'agent',
    displayName: 'Claude Code',
    handle: 'claude-code',
  });
  const directory = makeDirectory([
    member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
    agent,
  ]);

  it('서버가 준 문장을 그대로 쓰고 「바로 말하면」을 약속하지 않는다', () => {
    render(
      <Composer
        recipient="place"
        directory={directory}
        channelLabel={agent.displayName}
        dmAgent={agent}
        dmHint="곽성재님이 이 대화를 열어야 Claude Code가 답합니다."
        onSend={() => {}}
      />,
    );
    expect(
      screen.getByText('곽성재님이 이 대화를 열어야 Claude Code가 답합니다.'),
    ).toBeTruthy();
    expect(screen.queryByText(/바로 말하면/)).toBeNull();
  });

  it('답을 기다리는 동안(null)은 아무 문장도 없다', () => {
    render(
      <Composer
        recipient="place"
        directory={directory}
        channelLabel={agent.displayName}
        dmAgent={agent}
        dmHint={null}
        onSend={() => {}}
      />,
    );
    expect(screen.queryByText(/답합니다/)).toBeNull();
  });
});

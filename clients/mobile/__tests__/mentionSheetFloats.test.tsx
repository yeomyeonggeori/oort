import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// #3661 — @멘션 제안이 뜰 때 대화창이 위아래로 요동치지 않는다.
//
// 시트가 도크의 **흐름 안**에 있으면 열고 닫을 때, 그리고 글자를 칠 때 후보 수가 바뀔 때마다
// 도크 높이가 바뀌고, 따라가는 목록의 보이는 창이 그만큼 줄고 늘어 `Timeline.onLayout` 이
// 바닥으로 다시 붙는다(시뮬레이터 실측: 시트 한 번에 목록 649→478pt, 도크 60→231pt, 닫으면 되돌림).
// 수리는 시트를 흐름 밖으로 띄우는 것이다 — 도크의 높이가 후보 수와 무관해야 하므로, 이 파일은
// 「시트가 도크 높이에 기여하지 않는다」를 단정한다. 레이아웃 엔진이 없는 jest 에서 그것을
// 말하는 유일한 정직한 방법은 시트의 위치 지정이다: 흐름 밖(absolute)이고, 도크 윗면에 붙는다.
// 실제 레이아웃 이벤트 횟수(전 2 → 후 0)는 `measure/surfaces.tsx` 의 `mention-sheet-live` 로
// 시뮬레이터에서 쟀다(PR 본문).
// =============================================================================

const member = (over: Partial<RosterMember> & {handle: string}): RosterMember =>
  ({
    id: `id-${over.handle}`,
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: over.displayName ?? over.handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  }) as unknown as RosterMember;

const MEMBERS = [
  member({handle: 'seongjae', displayName: '곽성재'}),
  member({handle: 'dayeon', displayName: '박다연'}),
  member({handle: 'yeomyeong', displayName: '김여명'}),
  member({handle: 'seeun', displayName: '박세은'}),
];

const flat = (node: {props: {style?: unknown}}) =>
  StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  __setNonSecretStore({
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => void store.set(k, String(v)),
    remove: (k: string) => store.delete(k),
  } as never);
});
afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

function open(text: string) {
  render(
    <Composer
      recipient="place"
      channelLabel="배포"
      directory={makeDirectory(MEMBERS)}
      onSend={() => {}}
    />,
  );
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
}

describe('멘션·슬래시 시트는 도크 높이에 기여하지 않는다 (#3661)', () => {
  it('멘션 시트는 흐름 밖에서 도크 윗면에 붙는다', () => {
    open('@');
    const sheet = flat(screen.getByTestId('mention-list'));
    expect(sheet.position).toBe('absolute');
    expect(sheet.bottom).toBe('100%');
    // 목록을 덮고 서므로 아래 글이 비치면 안 된다.
    expect(sheet.backgroundColor).toBeTruthy();
  });

  it('후보 수가 바뀌어도(좁혀 가며 쳐도) 같은 위치 지정이다', () => {
    open('@');
    const before = flat(screen.getByTestId('mention-list'));
    fireEvent.changeText(screen.getByTestId('composer-input'), '@박');
    const after = flat(screen.getByTestId('mention-list'));
    expect(after.position).toBe('absolute');
    expect({position: after.position, bottom: after.bottom}).toEqual({
      position: before.position,
      bottom: before.bottom,
    });
  });
});

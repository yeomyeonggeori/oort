import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {Composer} from '../src/features/conversation/Composer';
import {
  channelDraftKey,
  readDraft,
  saveDraft,
  seedDraft,
  threadDraftKey,
} from '../src/features/conversation/drafts';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// #5171. 승인 카드의 「다시 요청」은 입력창에 초안을 **넣을 뿐 보내지 않는다**(웹 `seedComposerText` 와 같은 규칙). 폰 입력창은
// 첫 렌더와 `draftKey` 가 바뀔 때만 저장소를 읽으므로, 이미 마운트된 입력창에 닿는 길(`subscribeDraftSeed`)이 따로 있다. 이 시험은
// 그 길이 **진짜 `Composer`** 에 닿는지를 잰다: 빈 입력창에만 들어가고, 쓰던 글은 덮지 않으며, 카드가 선 화면의 입력창(채널 ·
// 스레드)에만 들어간다.
// =============================================================================

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

beforeEach(() => {
  __setNonSecretStore(memoryStore());
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

const EMPTY = makeDirectory([] as RosterMember[]);
const CHANNEL = channelDraftKey('ch-ops');
const THREAD = threadDraftKey('root-1');
const DRAFT = '@kim-intern 아까 올린 승인 요청이 만료됐어요. 다시 제안해 주세요. ';

function composer(draftKey: string | undefined, onSend: (body: string) => void = () => {}) {
  return render(
    <Composer recipient="place" channelLabel="운영" directory={EMPTY} draftKey={draftKey} onSend={onSend} />,
  );
}
const input = () => screen.getByTestId('composer-input');
/** 마운트된 입력창의 상태를 바꾸는 호출이라 `act` 안에서 부른다(카드의 눌림이 하는 일과 같다). */
function seed(key: string, text: string): boolean {
  let accepted = false;
  act(() => {
    accepted = seedDraft(key, text);
  });
  return accepted;
}

describe('밖에서 심은 글이 마운트된 입력창에 닿는다 (#5171)', () => {
  it('빈 입력창에는 그 자리에서 글이 서고, 저장되며, 보내기는 사람이 누른다', () => {
    const onSend = jest.fn();
    composer(CHANNEL, onSend);
    expect(input().props.value).toBe('');

    expect(seed(CHANNEL, DRAFT)).toBe(true);
    expect(input().props.value).toBe(DRAFT);
    expect(readDraft(CHANNEL)).toBe(DRAFT);
    // 넣었을 뿐 보내지 않았다: 사람이 보내기를 눌러야 나간다.
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith(DRAFT.trim());
  });

  it('쓰던 글이 있으면 덮지 않고 거절한다 — 입력창의 글도 저장된 글도 그대로다', () => {
    composer(CHANNEL);
    fireEvent.changeText(input(), '금요일 배포 건');

    expect(seed(CHANNEL, DRAFT)).toBe(false);
    expect(input().props.value).toBe('금요일 배포 건');
    expect(readDraft(CHANNEL)).toBe('금요일 배포 건');
  });

  it('입력창이 키 모양을 든 글을 쥐고 있어 저장소에는 없어도, 마운트된 입력창의 글이 사실이라 덮지 않는다', () => {
    composer(CHANNEL);
    fireEvent.changeText(input(), 'sk-ant-api03-Zx9Qw7Er5Ty3Ui1Op0As8Df6Gh4Jk2Lz');
    expect(readDraft(CHANNEL)).toBe(''); // 저장소는 키 모양이 든 글을 적지 않는다
    expect(seed(CHANNEL, DRAFT)).toBe(false);
    expect(input().props.value).toMatch(/^sk-ant-/);
  });

  it('카드가 선 화면의 입력창에만 들어간다: 스레드 입력창에 심은 글이 채널 입력창으로 새지 않는다', () => {
    composer(CHANNEL);
    expect(seed(THREAD, DRAFT)).toBe(true); // 스레드 입력창은 마운트돼 있지 않다 — 저장만 된다
    expect(input().props.value).toBe('');
    expect(readDraft(CHANNEL)).toBe('');
    expect(readDraft(THREAD)).toBe(DRAFT);
  });

  it('입력창이 꺼져 있으면 저장하고, 다음에 열 때 그 자리에 있다 — 쓰던 글이 저장돼 있으면 거절한다', () => {
    expect(seed(THREAD, DRAFT)).toBe(true);
    composer(THREAD);
    expect(input().props.value).toBe(DRAFT);
    cleanup();

    saveDraft(CHANNEL, '쓰다 만 글');
    expect(seed(CHANNEL, DRAFT)).toBe(false);
    expect(readDraft(CHANNEL)).toBe('쓰다 만 글');
  });

  it('빈 글은 심지 않고, 입력창이 사라진 뒤의 심기는 듣는 이가 없다', () => {
    const view = composer(CHANNEL);
    expect(seed(CHANNEL, '   ')).toBe(false);
    expect(input().props.value).toBe('');
    view.unmount();
    // 언마운트된 입력창의 구독은 끊긴다: 심기는 저장만 하고 아무도 부르지 않는다.
    expect(seed(CHANNEL, DRAFT)).toBe(true);
    expect(readDraft(CHANNEL)).toBe(DRAFT);
  });
});

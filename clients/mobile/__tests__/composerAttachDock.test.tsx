import * as api from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import {TOUCH_TARGET} from '../src/design/tokens';
import {
  addPickedFiles,
  attachmentSurfaceKey,
  resetAttachmentDraftsForTest,
} from '../src/features/attachments/draftStore';
import {Composer} from '../src/features/conversation/Composer';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 입력창 첨부 (#5325, owner 11-05 폰 캡처 둘)
//
//   ① 자판이 올라온 채 + 가 안 눌린다. 원인(시뮬레이터 실측): 펼침(= 자판이 올라온 상태)에서만 서는 도구 줄(`composer-tools`)이 알약 폭 전체이고, 알약 바닥에 절대 배치된
//      + 원(`composer-attach`)보다 **뒤**에 그려져 그 위를 덮었다 — 그 줄이 + 위의 터치를 삼켰다. 보내기·표현 단추는 도구 줄 뒤에 있어 멀쩡했다.
//      Maestro `tapOn id: composer-attach` 는 COMPLETED 인데 메뉴(`attachment-pick-camera`)가 안 열렸고, 도구 줄에 `pointerEvents="box-none"` 한 줄로 열렸다.
//   ② 고른 사진의 미리보기가 입력창 **밖**(알약 위)에 섰다 → 알약 안, 글 줄 위의 작은 썸네일 줄로.
//   ③ 미리보기의 ✕ 가 너무 컸다(28pt 면) → 작은 원(보이는 크기를 줄이고 눌리는 면은 hitSlop 으로 44pt).
//
// jest 는 화면을 그리지도 터치를 맞히지도 않는다. 아래 단정은 렌더 결과(속성·트리 포함 관계·스타일 값)를 읽고, **실제로 눌리는가**는 Maestro 흐름
// (`maestro/5325-attach-in-pill.yaml`)이 잰다. 사보타주 표는 PR 본문.
// =============================================================================

const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;

const TARGET = {workspaceId: 'ws-1', channelId: 'channel-1'};

function mount() {
  return render(
    <Composer
      recipient="place"
      channelLabel="general"
      directory={makeDirectory([])}
      attachmentTarget={TARGET}
      onSend={jest.fn()}
    />,
  );
}

const input = () => screen.getByTestId('composer-input');
const createUpload = jest.spyOn(api, 'createAttachmentUpload');

/** 사진 초안 `count` 장을 심는다. 올리기는 끝나지 않는다(`uploading`) — 실패하면 칩이 썸네일 아닌 파일 칩이 되므로 썸네일 상태를 고정하려는 것이다. */
function pickPhotos(count: number): void {
  // 초안 저장소는 외부 스토어다 — 갱신이 렌더로 흘러 들어오게 `act` 안에서 심는다(밖이면 다음 `act` 까지 화면이 안 바뀐다).
  act(() => {
    addPickedFiles(
      attachmentSurfaceKey(TARGET),
      TARGET,
      Array.from({length: count}, (_, index) => ({
        uri: `file:///photos/photo-${index + 1}.jpg`,
        name: `photo-${index + 1}.jpg`,
        mime: 'image/jpeg',
        sizeBytes: 4096,
        sizeKnown: true,
      })),
    );
  });
}

/** 렌더 트리(JSON)에서 `testID` 노드를 찾는다. */
type Json = {props?: {testID?: string}; children?: Array<Json | string> | null};
function find(node: Json | string | null | undefined, id: string): Json | null {
  if (node === null || node === undefined || typeof node === 'string') return null;
  if (node.props?.testID === id) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit !== null) return hit;
  }
  return null;
}
/** 알약의 **직계 줄**(`bar`·미리보기·답글 머리말…) 가운데 `id` 를 품은 줄의 순서. 같은 부모 안의 위아래를 말한다. */
function rowIndex(parent: Json, id: string): number {
  return (parent.children ?? []).findIndex(child => find(child, id) !== null);
}
/** `testID` 노드와 `otherId` 노드를 함께 품은 가장 깊은 조상(알약 안의 줄들을 직접 거느린 노드)을 찾는다. */
function lowestCommonParent(root: Json, a: string, b: string): Json | null {
  for (const child of root.children ?? []) {
    if (typeof child === 'string') continue;
    if (find(child, a) !== null && find(child, b) !== null) {
      return lowestCommonParent(child, a, b) ?? child;
    }
  }
  return find(root, a) !== null && find(root, b) !== null ? root : null;
}

beforeEach(() => {
  installAppClock();
  resetAttachmentDraftsForTest();
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(false));
  // 유리 면의 「투명도 줄이기」 읽기는 마운트 뒤 비동기로 상태를 올린다(`design/glass.tsx`) — 이 시험의 관심사가 아니라 답이 안 오게 둔다(act 밖 경고를 막는다).
  jest
    .spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled')
    .mockImplementation(() => new Promise<boolean>(() => undefined));
  createUpload.mockReset();
  // 올리기는 끝나지 않는다 — 초안이 `uploading` 에 서 있고 썸네일이 보인다.
  createUpload.mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  cleanup();
  resetAttachmentDraftsForTest();
  jest.useRealTimers();
});

describe('자판이 올라온 채 + (#5325 ①)', () => {
  it('펼침(포커스)의 도구 줄은 터치를 삼키지 않는다 — 「@」 자식만 받는다(`box-none`)', () => {
    mount();
    // 접힘에는 도구 줄이 없다(대조): + 위를 덮을 것이 아예 없다.
    expect(screen.queryByTestId('composer-tools')).toBeNull();
    fireEvent(input(), 'focus');
    const tools = screen.getByTestId('composer-tools');
    // `pointerEvents` 가 `box-none` 이 아니면 이 줄이 + 원의 터치를 가로챈다.
    expect(tools.props.pointerEvents).toBe('box-none');
    // 그 줄 안의 「@」 는 여전히 눌린다(자식은 터치를 받는다).
    expect(screen.getByTestId('composer-tool-mention')).toBeTruthy();
    // + 원은 같은 알약 안에 있고 접힘·펼침 모두 눌릴 수 있다(`disabled` 아님).
    expect(flat(screen.getByTestId('composer-attach').props.style).position).toBe('absolute');
    expect(screen.getByTestId('composer-attach').props.accessibilityState).toMatchObject({disabled: false});
  });
});

describe('미리보기는 입력창(알약) 안, 글 줄 위 (#5325 ②)', () => {
  it('고른 사진의 썸네일이 알약 안에 서고, 글 줄(`composer-bar`)보다 위다', () => {
    mount();
    pickPhotos(1);
    const pill = within(screen.getByTestId('composer-pill'));
    // 알약 **안**: 옛 판은 알약 밖(위 도크 줄)이라 이 질의가 비었다.
    expect(pill.getByTestId('attachment-tray')).toBeTruthy();
    expect(pill.getByTestId('attachment-draft-thumb')).toBeTruthy();
    // 글 줄 **위**: 알약이 거느린 줄들 가운데 미리보기가 입력 줄(`bar`)보다 앞이다.
    const root = screen.toJSON() as Json;
    const rows = lowestCommonParent(root, 'attachment-tray', 'composer-bar');
    expect(rows).not.toBeNull();
    expect(rowIndex(rows as Json, 'attachment-tray')).toBeLessThan(rowIndex(rows as Json, 'composer-bar'));
  });

  it('입력창을 눌러 자판이 올라와도(펼침) 같은 자리에 그대로 있다', () => {
    mount();
    pickPhotos(1);
    fireEvent(input(), 'focus');
    expect(screen.getByTestId('composer-tools')).toBeTruthy();
    const pill = within(screen.getByTestId('composer-pill'));
    expect(pill.getByTestId('attachment-draft-thumb')).toBeTruthy();
  });

  it('여러 장이면 가로 한 줄이다 — 줄바꿈 없이 밀어서 넘기고, 자판이 올라온 채로도 ✕ 가 첫 탭에 눌리도록 `always` 다', () => {
    mount();
    pickPhotos(3);
    const list = screen.getByTestId('attachment-tray-list');
    expect(list.props.horizontal).toBe(true);
    expect(list.props.keyboardShouldPersistTaps).toBe('always');
    expect(flat(list.props.contentContainerStyle).flexWrap).toBeUndefined();
    expect(within(screen.getByTestId('composer-pill')).getAllByTestId('attachment-draft')).toHaveLength(3);
  });

  it('✕ 로 지우면 그 사진만 사라지고, 마지막이면 미리보기 줄 자체가 걷힌다(지우기 동작은 그대로)', () => {
    mount();
    pickPhotos(2);
    const pill = within(screen.getByTestId('composer-pill'));
    fireEvent.press(pill.getAllByTestId('attachment-draft-remove')[0]);
    expect(pill.getAllByTestId('attachment-draft')).toHaveLength(1);
    fireEvent.press(pill.getByTestId('attachment-draft-remove'));
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);
  });
});

describe('썸네일 모서리의 ✕ 는 작은 원, 누르는 면은 44 (#5325 ③)', () => {
  it('보이는 원은 옛 28pt 보다 작고(원), hitSlop 을 더하면 가로·세로 모두 TOUCH_TARGET 이다', () => {
    mount();
    pickPhotos(1);
    const remove = screen.getByTestId('attachment-draft-remove');
    const face = flat(remove.props.style);
    // 옛 면: `space.xl + space.xs` = 28. 이보다 작아야 owner 의 「너무 크다」가 풀린다.
    expect(Number(face.width)).toBeLessThan(28);
    expect(Number(face.height)).toBeLessThan(28);
    expect(face.width).toBe(face.height);
    expect(face.borderRadius).toBeGreaterThanOrEqual(Number(face.width) / 2);
    // 썸네일 **모서리**: 오른쪽 위에 얹힌다.
    expect(face.position).toBe('absolute');
    expect(face.top).toBeDefined();
    expect(face.right).toBeDefined();
    // 누르는 면 = 원 + 양쪽 hitSlop. 숫자·변별 객체 둘 다 읽는다.
    const slop = remove.props.hitSlop as number | {top: number; bottom: number; left: number; right: number};
    const side = (edge: 'top' | 'bottom' | 'left' | 'right') =>
      typeof slop === 'number' ? slop : slop[edge];
    expect(Number(face.width) + side('left') + side('right')).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(Number(face.height) + side('top') + side('bottom')).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });
});

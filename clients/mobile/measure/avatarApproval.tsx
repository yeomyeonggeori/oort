import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useState, useEffect} from 'react';
import {ScrollView} from 'react-native';
import {Screen} from '../src/design/atoms';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {setServerBase} from '../src/storage/serverBase';

// =============================================================================
// `member.avatar.set` 승인 카드 캡처 표면 (#4394). 진짜 MessageRow 가 서고, 사진은
// `measure/avatar-stub.mjs` 가 승인 id 로 갈라 답한다(배송되는 내려받기 코드가 그대로 돈다).
//
//   node measure/avatar-stub.mjs &
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure AVATAR-APPROVAL-<READY|LOADING|UNAVAILABLE>
//   (라이트: LIGHT-AVATAR-APPROVAL-<...>)
//
//   ready        사진이 보인다(본인)
//   loading      서버가 응답을 붙들고 있다 — 사진 자리는 비고 안내 한 줄
//   unavailable  서버가 404 — 「이 사진은 요청한 본인만 볼 수 있어요.」
//
// 이름은 가상 인물이다. 세션(워크스페이스)은 하네스의 `SessionProvider` 가 준다.
// =============================================================================

const STUB_BASE = 'http://127.0.0.1:18994';
const WS = '00000000-0000-7000-8000-0000000000a9';
const AGENT = '00000000-0000-7000-8000-0000000000a2';
const SELF = '00000000-0000-7000-8000-0000000000a1';
const SHA = 'ab'.repeat(32);
const NOW = Date.now();

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: AGENT, kind: 'agent', displayName: '달무리봇', handle: 'dalmuri'}),
]);

const APPROVAL_IDS: Record<string, string> = {
  ready: 'ap-ready',
  loading: 'ap-slow',
  unavailable: 'ap-gone',
};

function card(approvalId: string): Message {
  return {
    id: '00000000-0000-7000-8000-0000000ba101',
    channelId: 'avatar-approval-capture',
    seq: 11,
    hlcTs: 11,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'approval_request',
    body: '승인 요청: 내 프로필 사진 바꾸기',
    state: 'sent',
    createdAtMs: NOW - 5 * 60_000,
    props: {
      approval_id: approvalId,
      action_type: 'workspace_action',
      status: 'pending',
      title: '내 프로필 사진 바꾸기',
      summary:
        '에이전트가 제안했어요. 승인하면 사진 주인 본인 권한으로 카드에 보이는 이미지로 내 프로필 사진을 바꿔요.',
      action: {
        id: 'member.avatar.set',
        rows: [
          {label: '대상', value: '이도현 (@dohyun)'},
          {label: '프로필 사진', value: '없음 → 카드에 보이는 새 이미지'},
          {label: '사진 출처', value: '내가 이 대화에 보낸 첨부'},
        ],
        required_role: 'requesting_member',
        preview: {
          kind: 'avatar_image',
          imageId: '11111111-1111-4111-8111-111111111111',
          sha256: SHA,
          mime: 'image/png',
          width: 512,
          height: 384,
          sizeBytes: 48213,
          origin: 'attachment',
        },
      },
    },
  } as unknown as Message;
}

export function AvatarApprovalSurface({which}: {which: string}): React.JSX.Element {
  // 첫 렌더 전에 한 번: 카드가 마운트 직후 미리보기를 받기 시작한다.
  useState(() => {
    setServerBase(STUB_BASE);
    return null;
  });
  useEffect(() => () => setServerBase(null), []);
  const approvalId = APPROVAL_IDS[which] ?? APPROVAL_IDS.ready;
  const gates = new Map([
    [approvalId, {approvalId, reversible: false, expiresAtMs: NOW + 50 * 60_000}],
  ]);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{paddingVertical: 24}}>
        <MessageRow
          message={card(approvalId)}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={NOW}
          approvalGates={gates}
        />
      </ScrollView>
    </Screen>
  );
}

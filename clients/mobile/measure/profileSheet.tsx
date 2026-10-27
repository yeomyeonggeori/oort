import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import React from 'react';

import {AvatarViewer} from '../src/features/directory/AvatarViewer';
import {MemberProfileSheet} from '../src/features/directory/MemberProfileSheet';
import {Backdrop} from './sheetKit';

// =============================================================================
// 다른 사람 프로필 시트의 캡처 표면 (#4319). 배송되는 `MemberProfileSheet` 에 고정 데이터를 건넨다(상태 점은 부모가 core 로 판정해
// 넘기는 값이라 여기서는 판정된 값을 그대로 준다).
//
//   -momoMeasure PROFILESHEET-<이름>   (라이트: LIGHT-PROFILESHEET-<이름>)
//
//   photo        사진이 있는 사람 — 큰 얼굴(눌리면 크게 보기)·상태 칩(자리 비움)·한 줄 상태(만료 안 됨)·메시지/멘션 복사 타일
//   initial      사진이 없는 사람 — 이니셜 얼굴(단추가 아니다)·칩 없음·한 줄 상태 없음
//   email        이니셜 + **이메일 자리**(값을 준 호스트의 모양 — 지금 대화 화면은 주지 않는다)
//   agent        에이전트 — 둥근 사각 얼굴·생존 칩·세 타일(에이전트 정보)·관리자 줄
//   self         나 — DM 타일 자리에 「설정 열기」
//   unavailable  초대됨 멤버 — 칩이 낱말을 말하고 DM 타일 대신 까닭 두 줄
//   offline      오프라인 — DM 타일 대신 까닭 두 줄
//   viewer       프로필 사진 크게 보기(`AvatarViewer`) — 시트가 아니라 전체 화면
//
// 사진은 **합성 그라데이션**(64×64 PNG, `data:` 주소)이다 — 실제 사람 사진이 아니고, 서버·내려받기 없이 `Avatar` 가 이미지로 싣는다.
// 그래서 이 캡처는 업로드 사진의 베어러 내려받기 길(`memberAvatarImage.ts`)은 지나지 않는다.
// 모든 이름은 가상 인물이다(이도현·박서연·최민수·정하윤, 회사 「달무리 스튜디오」).
// =============================================================================

/** 합성 그라데이션 PNG(64×64) — 실제 사진이 아니다. */
const PHOTO_DATA = [
  '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',
].join('');
export const PHOTO = `data:image/png;base64,${PHOTO_DATA}`;

const NOW = Date.UTC(2026, 9, 27, 3, 0);
const WS = '00000000-0000-7000-8000-000000004a00';

function person(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    role: 'member',
    channelCount: 2,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const SELF_ID = '00000000-0000-7000-8000-000000004a01';
const SELF = person({
  id: SELF_ID,
  displayName: '이도현',
  handle: 'dohyun',
  role: 'owner',
  statusEmoji: '🍚',
  statusText: '점심 먹는 중',
});
const SEOYEON = person({
  id: '00000000-0000-7000-8000-000000004a02',
  displayName: '박서연',
  handle: 'seoyeon',
  avatarUrl: PHOTO,
  presenceStatus: 'away',
  statusEmoji: '📅',
  statusText: '회의 중',
  statusExpiresAtMs: NOW + 60 * 60_000,
});
const MINSU = person({
  id: '00000000-0000-7000-8000-000000004a03',
  displayName: '최민수',
  handle: 'minsu',
});
const HAYUN_INVITED = person({
  id: '00000000-0000-7000-8000-000000004a04',
  displayName: '정하윤',
  handle: 'hayun',
  status: 'invited',
});
const HELPER = person({
  id: '00000000-0000-7000-8000-000000004a05',
  kind: 'agent',
  displayName: '달무리 도우미',
  handle: 'dalmuri-helper',
  ownerHumanId: SELF_ID,
});

const DIRECTORY = makeDirectory([SELF, SEOYEON, MINSU, HAYUN_INVITED, HELPER]);

const noop = () => {};

function Sheet({
  member,
  online = true,
  status = null,
  email,
  onOpenAgent,
  onOpenSettings,
}: {
  member: RosterMember;
  online?: boolean;
  status?: React.ComponentProps<typeof MemberProfileSheet>['status'];
  email?: string;
  onOpenAgent?: () => void;
  onOpenSettings?: () => void;
}): React.JSX.Element {
  return (
    <Backdrop>
      <MemberProfileSheet
        member={member}
        directory={DIRECTORY}
        selfMemberId={SELF_ID}
        online={online}
        dmPending={false}
        dmError={null}
        status={status}
        nowMs={NOW}
        email={email}
        onClose={noop}
        onOpenDm={noop}
        onOpenAgent={onOpenAgent}
        onOpenSettings={onOpenSettings}
        onEnlargeAvatar={noop}
      />
    </Backdrop>
  );
}

export function ProfileSheetSurface({which}: {which: string}): React.JSX.Element {
  switch (which) {
    case 'initial':
      return <Sheet member={MINSU} />;
    case 'email':
      return <Sheet member={MINSU} email="minsu@dalmuri.example" />;
    case 'agent':
      return (
        <Sheet
          member={HELPER}
          status={{tone: 'ok', label: '응답함 3분 전'}}
          onOpenAgent={noop}
        />
      );
    case 'self':
      return <Sheet member={SELF} onOpenSettings={noop} />;
    case 'unavailable':
      return <Sheet member={HAYUN_INVITED} />;
    case 'offline':
      return <Sheet member={MINSU} online={false} />;
    case 'viewer':
      return (
        <Backdrop>
          <AvatarViewer uri={PHOTO} label="박서연 프로필 사진" onClose={noop} />
        </Backdrop>
      );
    default:
      return <Sheet member={SEOYEON} status={{tone: 'warn', label: '자리 비움'}} />;
  }
}

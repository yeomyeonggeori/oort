import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useState} from 'react';
import {Text} from 'react-native';
import {Screen} from '../src/design/atoms';
import {usePalette} from '../src/design/theme';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {Timeline} from '../src/features/conversation/Timeline';
import {EdgeSwipeBack} from '../src/nav/EdgeSwipeBack';
import {setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 사진 뷰어 캡처 표면 (#4293). 진짜 머리·타임라인·컴포저가 선 대화에 사진 메시지가 있고, 뷰어를
// 여는 것은 Maestro 의 **실제 탭**이다(`maestro/104-photo-viewer-capture.yaml`). 서버·레일만 없다.
//
//   node measure/photo-stub.mjs &            # 첨부 바이트를 대신 답한다(단색 PNG, 요청 때 생성)
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure PHOTO-VIEWER-<WHICH> \
//     -RCT_jsLocation 127.0.0.1:$PORT
//   (라이트: LIGHT-PHOTO-VIEWER-<WHICH>)
//
//   solo   사진 한 장짜리 메시지 — 뷰어는 한 쪽이다.
//   multi  사진 세 장짜리 메시지 — 격자에서 가운데 장을 누르면 「2 / 3」으로 열린다.
//
// 사진은 스텁이 만든 **단색 PNG** 라서 사진 속 사람·글자가 없다. 이름은 가상 인물(이도현·박서연,
// 회사 「달무리 스튜디오」)이다 — 공개 저장소의 캡처에 실제 팀원·대화를 쓰지 않는다.
//
// 내려받기는 배송되는 코드(`content.ts`)가 그대로 한다. 이 표면이 하는 일은 서버 주소를 스텁으로
// 가리키는 것 하나다. 주소는 MMKV 에 남으므로 표면이 내려갈 때 지운다.
// =============================================================================

const STUB_BASE = 'http://127.0.0.1:18993';

const WS = '00000000-0000-7000-8000-0000000000b0';
const SELF = '00000000-0000-7000-8000-0000000000b1';
const PEER = '00000000-0000-7000-8000-0000000000b2';
const CHANNEL = 'photo-viewer-capture';

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
  member({id: PEER, displayName: '박서연', handle: 'seoyeon'}),
]);

const NOW = Date.now();
// 대화 화면과 같다: 머리 띠가 안전 영역 윗부분을 직접 덮는다(`ConversationScreen` 의 `screen.paddingTop: 0`).
const NO_TOP = {paddingTop: 0} as const;

function photo(id: string) {
  return {id, name: '현장.png', mime: 'image/png', sizeBytes: 48_000};
}

function message(
  seq: number,
  author: string,
  body: string,
  attachments?: ReturnType<typeof photo>[],
): Message {
  return {
    id: `00000000-0000-7000-8000-00000000b${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - (10 - seq) * 60_000,
    ...(attachments ? {attachments} : {}),
  } as Message;
}

const TEXT = [
  message(1, PEER, '달무리 스튜디오 오픈 준비 사진이에요.'),
  message(2, SELF, '벌써 다 됐어요? 보여 주세요.'),
];

const SOLO: Message[] = [
  ...TEXT,
  message(3, PEER, '입구 쪽이에요.', [photo('photo-solo')]),
];

const MULTI: Message[] = [
  ...TEXT,
  message(3, PEER, '내부는 이렇게 됐어요.', [
    photo('photo-a'),
    photo('photo-b'),
    photo('photo-c'),
  ]),
];

const FILL = {flex: 1} as const;
const WENT_BACK_TEXT = {padding: 24} as const;

/** 가장자리 쓸기로 대화가 닫힌 뒤의 자리. 앱에서는 이 자리에 이전 화면이 선다. */
function WentBack(): React.JSX.Element {
  const palette = usePalette();
  return (
    <Screen>
      <Text style={[WENT_BACK_TEXT, {color: palette.text}]} testID="harness-went-back">
        뒤로 갔어요 (하네스: 대화 화면이 닫혔다)
      </Text>
    </Screen>
  );
}

export function PhotoViewerSurface({which}: {which: string}): React.JSX.Element {
  // 첫 렌더 전에 한 번: 사진 타일은 마운트 직후 내려받기를 시작한다.
  useState(() => {
    setServerBase(STUB_BASE);
    return null;
  });
  useEffect(() => () => setServerBase(null), []);
  const [wentBack, setWentBack] = useState(false);
  if (wentBack) return <WentBack />;
  // 앱의 셸처럼 대화를 가장자리 뒤로가기로 감싼다 — 뷰어를 연 채 좌측 가장자리에서 쓸어도 그대로
  // 뒤로 가는지(`maestro/106-photo-viewer-edge-swipe-capture.yaml`)가 이 감싸기로 보인다.
  return (
    <EdgeSwipeBack onBack={() => setWentBack(true)} style={FILL}>
      <Screen style={NO_TOP}>
        <ConversationHeader
          title="박서연"
          kind="dm"
          peerId={PEER}
          peerStatusTone="ok"
          directory={DIRECTORY}
          onBack={() => {}}
          onOpenMenu={() => {}}
          // 가운데 알약은 단추다(#4319) — 정보 페이지로 가는 문이 있는 실제 대화 화면과 같은 모양으로 찍는다(머리 높이 불변이 이 하네스의 전제다).
          onOpenInfo={() => {}}
          railStatus="connected"
        />
        <ConversationLayout
          list={
            <Timeline
              messages={which === 'multi' ? MULTI : SOLO}
              directory={DIRECTORY}
              status="ready"
              channelKind="dm"
              myMemberId={SELF}
              nowMs={NOW}
            />
          }
          composer={
            <Composer
              recipient="person"
              channelLabel="박서연"
              directory={DIRECTORY}
              draftKey="measure:photo-viewer"
              onSend={() => {}}
            />
          }
        />
      </Screen>
    </EdgeSwipeBack>
  );
}

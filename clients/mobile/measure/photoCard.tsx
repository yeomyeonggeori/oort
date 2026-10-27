import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Screen} from '../src/design/atoms';
import {usePalette} from '../src/design/theme';
import {ds2Radius, font, line} from '../src/design/tokens';
import {PhotoGridCard} from '../src/features/attachments/PhotoGridCard';
import {PhotoMorphFrame} from '../src/features/attachments/PhotoMorphFrame';
import {PHOTO_CARD, photoCardSize} from '../src/features/attachments/photoCardDesign';
import {
  PhotoResolveError,
  type PhotoLibraryPorts,
  type PhotoPage,
} from '../src/features/attachments/photoLibrary';
import {nativePhotoPorts} from '../src/features/attachments/photosNative';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 사진 카드 캡처 표면 (#4181). 실제 머리·타임라인·컴포저 위에 **실제 카드**를 Buzz 의 자리(왼쪽
// 10 · 아래 = 안전 영역 + 11)에 띄운다. 서버·레일만 없다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure PHOTO-CARD-<WHICH>
//   (라이트: LIGHT-PHOTO-CARD-<WHICH>)
//
//   real            진짜 PhotoKit 포트. 상태는 시뮬레이터의 사진 권한이 정한다 —
//                   `xcrun simctl privacy <udid> reset photos app.momo.ios` (미결정),
//                   `… revoke photos …` (거부), `… grant photos …` (전체 허용).
//   real-selected   real 에 보관함 첫 세 장을 고른 상태.
//   limited         **포트 주입**: 보관함은 진짜(전체 허용)이고 권한 읽기만 `limited` 로 바꾼다.
//                   시뮬레이터에서 일부 허용을 만들 수 없다(`simctl privacy` 는 허용·거부·초기화뿐).
//   morph-<p>       변신 틀을 진행 p(0~100 퍼센트)에 못 박는다. 메뉴 층은 첨부 메뉴와 같은 크기
//                   (216×204)의 대역이다 — 진짜 메뉴와의 합성은 `ATTACH-MENU` 표면 + Maestro 영상이 보인다.
//
// 상태 표면(design-review M6) — **포트 주입**이다. 보관함은 진짜(전체 허용)이고 아래만 바꾼다:
//   loading         첫 쪽 읽기가 끝나지 않는다(스켈레톤)            empty / empty-limited  사진 0장
//   error           첫 쪽 읽기가 던진다(「다시 불러오기」)            attaching  변환이 끝나지 않는다(알약 스피너 + 진행 문장)
//   cloud           iCloud 에서 내려받는 중에 멈춘다                 attach-failed / cloud-failed  변환이 던진다(알약을 눌러야 보인다)
//   capped          상한 1장, 첫 장이 골라져 있다 — 둘째를 누르면 상한 안내    full  트레이가 가득(상한 0) — 아무 사진이나 누르면 안내
//   (attaching·cloud·attach-failed·cloud-failed 는 첫 세 장이 골라져 있고, **알약을 진짜로 눌러야** 상태가 선다 — Maestro 의 탭.)
//
// 뒤에 말풍선이 넉넉해야 흐림·겹침이 보인다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000f0';
const SELF = '00000000-0000-7000-8000-0000000000f1';
const GROK = '00000000-0000-7000-8000-0000000000f2';
const CHANNEL = 'photo-card-capture';

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
  member({id: SELF, displayName: 'lee', handle: 'lee'}),
  member({id: GROK, kind: 'agent', displayName: '김인턴', handle: 'intern'}),
]);

const NOW = Date.now();
const NO_TOP = {paddingTop: 0} as const;

function message(seq: number, author: string, body: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000000e${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - (12 - seq) * 60_000,
  } as Message;
}

const MESSAGES = [
  message(
    1,
    GROK,
    '금주 이후 일정\n- 10월 16~18일: 등록된 일정 없음.\n\n업무\n- 마감·진행·지연 업무 없음(지난주~2주 뒤 조회, 등록 0건).\n\n다음 일정은 오후 2시예요. 휴가 중이라 일정과 겹치니, 참석 여부만 확인해 보시면 좋겠어요.',
  ),
  message(2, SELF, '13시 외부 출근'),
  message(3, GROK, '확인했어요. 오후 일정은 그대로 둘게요.'),
  message(4, SELF, '18시 퇴근'),
  message(5, GROK, '알겠어요. 내일 아침 일정도 정리해 둘까요?'),
  message(6, SELF, '응, 부탁해요'),
];

const TARGET = {workspaceId: WS, channelId: CHANNEL};

const NOOP = () => {};

const PENDING = new Promise<never>(() => undefined);
const EMPTY_PAGE: PhotoPage = {assets: [], endCursor: null, hasNextPage: false};

/** 장면마다 진짜 포트에서 바꾸는 것만 바꾼다. */
function portsFor(which: string): PhotoLibraryPorts {
  const granted = async () => 'granted' as const;
  switch (which) {
    case 'limited':
      return {...nativePhotoPorts, getPermission: async () => 'limited'};
    case 'loading':
      return {...nativePhotoPorts, getPermission: granted, listPhotos: () => PENDING};
    case 'empty':
      return {...nativePhotoPorts, getPermission: granted, listPhotos: async () => EMPTY_PAGE};
    case 'empty-limited':
      return {
        ...nativePhotoPorts,
        getPermission: async () => 'limited',
        listPhotos: async () => EMPTY_PAGE,
      };
    case 'error':
      return {
        ...nativePhotoPorts,
        getPermission: granted,
        listPhotos: () => Promise.reject(new Error('capture: 보관함 읽기 실패')),
      };
    case 'attaching':
      return {...nativePhotoPorts, resolvePhoto: () => PENDING};
    case 'cloud':
      return {
        ...nativePhotoPorts,
        resolvePhoto: (_asset, hooks) => {
          hooks.onDownloading();
          return PENDING;
        },
      };
    case 'attach-failed':
      return {
        ...nativePhotoPorts,
        resolvePhoto: () => Promise.reject(new Error('capture: 변환 실패')),
      };
    case 'cloud-failed':
      return {
        ...nativePhotoPorts,
        resolvePhoto: () => Promise.reject(new PhotoResolveError('cloud')),
      };
    default:
      return nativePhotoPorts;
  }
}

/** 처음부터 골라 두는 사진 수(보관함 맨 앞에서). */
function preselectCount(which: string): number {
  switch (which) {
    case 'real-selected':
    case 'attaching':
    case 'cloud':
    case 'attach-failed':
    case 'cloud-failed':
      return 3;
    case 'capped':
      return 1;
    default:
      return 0;
  }
}

/** 카드가 받는 상한. 상한 장면만 20 이 아니다. */
function roomFor(which: string): number {
  if (which === 'capped') return 1;
  if (which === 'full') return 0;
  return 20;
}

/** 첨부 메뉴(#4180)와 같은 크기의 대역 — 합성 중간 프레임에서 메뉴 층이 어디서 어떻게 접히는지 보이면 된다. */
const MENU_SIZE = {width: 216, height: 204};
const MENU_RADIUS = ds2Radius.composer;

function StandInMenu(): React.JSX.Element {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.menu,
        {backgroundColor: palette.primary, borderRadius: MENU_RADIUS},
      ]}
      testID="photo-card-standin-menu">
      {['카메라', '사진', '파일'].map(label => (
        <Text key={label} style={[styles.menuRow, {color: palette.onPrimary}]}>
          {label}
        </Text>
      ))}
    </View>
  );
}

export function PhotoCardSurface({which}: {which: string}): React.JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const size = photoCardSize(win);
  const [firstThree, setFirstThree] = useState<string[] | null>(null);

  const wantsSelection = preselectCount(which) > 0;
  useEffect(() => {
    if (!wantsSelection) return;
    let alive = true;
    nativePhotoPorts.listPhotos(null, preselectCount(which)).then(
      page => {
        if (alive) setFirstThree(page.assets.map(asset => asset.id));
      },
      () => {
        if (alive) setFirstThree([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [wantsSelection, which]);

  const morph = /^morph-(\d{1,3})$/.exec(which);
  const progress = morph === null ? null : Math.min(Math.max(Number(morph[1]) / 100, 0), 1);

  const card = (
    <PhotoGridCard
      ports={portsFor(which)}
      active
      size={size}
      room={roomFor(which)}
      onBack={NOOP}
      onAttach={NOOP}
      onDone={NOOP}
      onOpenSystemPicker={NOOP}
      initialSelected={firstThree ?? undefined}
      testID="photo-card"
    />
  );

  // 선택을 심는 표면은 보관함 첫 세 장 id 를 받은 뒤에 세운다(처음 선택은 마운트 때만 읽는다).
  const ready = !wantsSelection || firstThree !== null;

  return (
    <View style={styles.root}>
      <Screen style={NO_TOP}>
        <ConversationHeader
          title="김인턴"
          kind="dm"
          peerId={GROK}
          peerStatusTone="ok"
          directory={DIRECTORY}
          onBack={NOOP}
          onOpenMenu={NOOP}
          // 가운데 알약은 단추다(#4319) — 정보 페이지로 가는 문이 있는 실제 대화 화면과 같은 모양으로 찍는다(머리 높이 불변이 이 하네스의 전제다).
          onOpenInfo={NOOP}
          railStatus="connected"
        />
        <ConversationLayout
          list={
            <Timeline
              messages={MESSAGES}
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
              channelLabel="김인턴"
              directory={DIRECTORY}
              draftKey="measure:photo-card"
              attachmentTarget={TARGET}
              onSend={NOOP}
            />
          }
        />
      </Screen>
      {ready ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.float,
            {left: PHOTO_CARD.inset, bottom: insets.bottom + 11},
          ]}>
          {progress === null ? (
            card
          ) : (
            <PhotoMorphFrame
              target="card"
              pinnedProgress={progress}
              menuSize={MENU_SIZE}
              menuRadius={MENU_RADIUS}
              cardSize={size}
              cardRadius={PHOTO_CARD.radius}
              bodyColor={palette.surface}
              menu={<StandInMenu />}
              card={card}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  // 카드는 바닥·왼쪽에 닻이 있다 — 변신 틀이 위·오른쪽으로 자란다(Buzz IMG_4321).
  float: {position: 'absolute'},
  menu: {
    width: MENU_SIZE.width,
    height: MENU_SIZE.height,
    paddingVertical: 12,
    paddingHorizontal: 28,
    justifyContent: 'space-between',
  },
  menuRow: {
    fontSize: font.title,
    lineHeight: line.body,
  },
});

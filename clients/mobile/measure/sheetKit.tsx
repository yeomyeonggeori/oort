import type {DeviceKey} from '@momo/core/features/auth/deviceKeys';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Message, ReadState, RosterMember} from '@momo/core/lib/api';
import {QUICK_REACTIONS, type ReactionChip} from '@momo/core/features/timeline/reactions';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React, {useEffect, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ATTACH_MENU_ICONS, HOME_ICONS, MENU_ICONS, SHEET_ICONS, SHELL_ICONS} from '../src/design/icons';
import {PageSheet} from '../src/design/PageSheet';
import {PageHeader, SheetHeader} from '../src/design/SheetChrome';
import {
  ActionTile,
  ActionTileRow,
  GroupCard,
  GroupLabel,
  InputPill,
  ListRow,
  RowEmoji,
  RowIcon,
  SheetScroll,
  TileIcon,
} from '../src/design/sheetParts';
import {usePalette, useStyles} from '../src/design/theme';
import {ds2Radius, font, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../src/design/tokens';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import type {DeviceKeyView} from '../src/deviceKey/enrollment';
import {LinkSheetBody} from '../src/features/deviceKey/DeviceKeyLinkSheet';
import {
  DEVICE_KEY_LOCAL_QUERY_KEY,
  DEVICE_KEYS_QUERY_KEY,
  type DeviceKeyState,
} from '../src/features/deviceKey/useDeviceKey';
import {
  channelRowActionItems,
  NOTHING_COPIED,
  type ChannelRowTarget,
} from '../src/features/sidebar/channelRowActions';
import {ChannelActionSheet} from '../src/features/sidebar/ChannelActionSheet';
import {workspaceKeys} from '../src/features/workspace/queries';
import {useSession} from '../src/session/useSession';
import {NewMessageSheet} from '../src/shell/NewMessageSheet';
import {SettingsOverlay} from './settingsOverlay';

// =============================================================================
// 공용 시트·페이지 부품 전시 + 이전한 시트 (#4318 2단계 캡처).
//
//   -momoMeasure SHEETKIT-PAGE · LIGHT-SHEETKIT-PAGE …
//
//   page            **앞 칸 없는 쪽**(설정 페이지의 문법): 페이지 머리(왼쪽 X) · 큰 행동 타일 · 묶음 카드(값/셰브론/펼침/
//                   복사/토글/보조 줄/위험) · 입력 알약 — 이름 + 오른쪽 한 요소뿐이고 앞 칸이 한 카드에도 없다
//   page-lead       **앞 칸 있는 쪽**: 같은 부품인데 **모든 카드**가 앞 칸을 든다 — 고른 상태는 이모지(데이터),
//                   이동·연결 행은 선 글리프(기능). 한 표면 안에서는 이 둘을 섞지 않는다(글자 열이 카드 사이로 점프한다)
//   headers         시트 머리 ✓ 비활성/활성 · 확정 없음 · 페이지 머리 오른쪽 자리
//   status          중간 단 시트 + 입력 알약 + ✓ 비활성(입력 전). autoFocus 라 소프트 키보드가 올라온다 —
//                   시트가 키보드 위에 앉고 입력 칸이 가려지지 않는지 본다
//   status-ready    같은 시트, 입력 뒤(✓ 활성)
//   message[-delete]       메시지 행동 시트(배송되는 것) · 삭제 확인 단계
//   channel[-leave|-dm]    대화 행 시트(배송되는 것) · 나가기 확인 · DM 행
//   newdm[-empty]          새 DM 시트(배송되는 것, 씨앗을 뿌린 명부)
//
// 모든 이름은 가상 인물이다(이도현·박서연·최민수·정하윤, 회사 「달무리 스튜디오」). 시트는 `Modal` 이라
// 한 프레임에 하나만 선다 - 표면 하나가 시트 하나다.
// =============================================================================

const noop = () => {};

const WORKSPACE_NOTE = '달무리 스튜디오';

export function Backdrop({children}: {children?: React.ReactNode}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.backdrop}>
      <View style={[styles.backdropBody, {paddingTop: insets.top + space.md}]}>
        <Text style={styles.backdropTitle}>{WORKSPACE_NOTE}</Text>
        {['디자인', '배포', '일반', '점심'].map(label => (
          <View key={label} style={styles.backdropRow}>
            <Text style={styles.backdropRowText}># {label}</Text>
          </View>
        ))}
      </View>
      {children}
    </View>
  );
}

// ---- 페이지: 모든 부품 -----------------------------------------------------

/**
 * 한 페이지는 **앞 칸 문법을 하나만 쓴다** — 모든 카드가 앞 칸을 들거나(`lead`) 한 카드도 안 든다. 섞으면 글자 열이
 * 카드 사이에서 38pt 점프한다(design-review #4318 r1 이 시트에서, r3 M1 이 이 전시에서 잰 값). 이모지는 **데이터**
 * (고른 상태)에만 쓰고, 기능을 말하는 앞 칸은 22pt 로 구운 선 글리프다(18pt 로 구운 `user`·`bot` 은 22 칸에서 확대돼
 * 흐려진다).
 */
function PageKit({lead}: {lead: boolean}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const [push, setPush] = useState(true);
  const [quiet, setQuiet] = useState(false);
  return (
    <View style={styles.page}>
      <View style={{paddingTop: insets.top}}>
        <PageHeader title="설정" closeLabel="설정 닫기" onClose={noop} />
      </View>
      <ScrollView
        contentContainerStyle={[styles.pageBody, {paddingBottom: insets.bottom + space.xl}]}
        testID="sheetkit-page-scroll">
        <ActionTileRow>
          <ActionTile
            icon={<TileIcon source={HOME_ICONS.dms} />}
            label="메시지"
            onPress={noop}
          />
          <ActionTile
            icon={<TileIcon source={SHEET_ICONS.copy} />}
            label="복사"
            onPress={noop}
          />
        </ActionTileRow>

        {lead ? (
          <>
            {/* 앞 칸 있는 쪽 — 한 카드는 이모지(고른 상태 = 데이터)이거나 선 글리프(기능)이거나 둘 중 하나다. */}
            <GroupCard label="상태" inset="icon">
              <ListRow
                leading={<RowEmoji emoji="📅" />}
                title="회의 중"
                value="오후 3시까지"
                accessory="chevron"
                onPress={noop}
              />
              <ListRow leading={<RowEmoji emoji="🍚" />} title="점심 먹는 중" onPress={noop} />
            </GroupCard>

            <GroupCard label="연결" inset="icon">
              <ListRow
                leading={<RowIcon source={MENU_ICONS.agent} />}
                title="도우미"
                detail="달무리 도우미와 대화해요"
                accessory="chevron"
                onPress={noop}
              />
              <ListRow
                leading={<RowIcon source={HOME_ICONS.hash} />}
                title="기본 채널"
                value="# 디자인"
                accessory="expand"
                onPress={noop}
              />
              <ListRow
                leading={<RowIcon source={MENU_ICONS.work} />}
                title="작업 기록"
                accessory="chevron"
                onPress={noop}
              />
            </GroupCard>

            <GroupCard label="첨부" inset="icon">
              <ListRow
                leading={<RowIcon source={ATTACH_MENU_ICONS.photo} />}
                title="사진 보관함"
                accessory="chevron"
                onPress={noop}
              />
              <ListRow
                leading={<RowIcon source={ATTACH_MENU_ICONS.camera} />}
                title="카메라"
                accessory="chevron"
                onPress={noop}
              />
              <ListRow
                leading={<RowIcon source={ATTACH_MENU_ICONS.file} />}
                title="파일"
                detail="기기에 있는 파일을 골라요"
                accessory="chevron"
                onPress={noop}
              />
            </GroupCard>
          </>
        ) : (
          <>
            {/* 앞 칸 없는 쪽 — 설정 페이지의 문법(Buzz 설정 페이지): 이름 + 오른쪽 한 요소. */}
            <GroupCard label="계정">
              <ListRow title="상태" value="회의 중" accessory="chevron" onPress={noop} />
              <ListRow
                title="알림 시간대"
                value="오전 9시 – 오후 6시"
                accessory="expand"
                onPress={noop}
              />
              <ListRow
                title="언어"
                detail="앱이 쓰는 말을 바꿔요"
                value="한국어"
                accessory="chevron"
                onPress={noop}
              />
            </GroupCard>

            <GroupCard label="연결">
              <ListRow
                title="도우미"
                detail="달무리 도우미와 대화해요"
                accessory="chevron"
                onPress={noop}
              />
              <ListRow title="기본 채널" value="# 디자인" accessory="expand" onPress={noop} />
              <ListRow title="작업 기록" accessory="chevron" onPress={noop} />
            </GroupCard>

            <GroupCard label="알림">
              <ListRow
                title="푸시 알림"
                accessory="toggle"
                toggle={{value: push, onValueChange: setPush}}
              />
              <ListRow
                title="방해 금지"
                detail="정해 둔 시간에는 알림을 받지 않아요"
                accessory="toggle"
                toggle={{value: quiet, onValueChange: setQuiet}}
              />
              <ListRow title="초대 링크" value="oort.app/i/dalmuri" accessory="copy" onPress={noop} />
            </GroupCard>
          </>
        )}

        {/* 입력 알약은 채움이 없다 — 바탕 위에 직접 놓는다(카드 안에 넣지 않는다). */}
        <View style={styles.pillGroup}>
          <GroupLabel>찾기</GroupLabel>
          <InputPill
            icon={SHELL_ICONS.search}
            accessibilityLabel="이름이나 핸들로 찾기"
            placeholder="이름이나 @핸들"
          />
        </View>

        {/* 위험 행도 앞 칸이 필요한 쪽(lead)에는 두지 않는다 — 우리 글리프 세트에 맞는 선이 없다. */}
        {lead ? null : (
          <GroupCard>
            <ListRow title="로그아웃" tone="danger" onPress={noop} />
          </GroupCard>
        )}
      </ScrollView>
    </View>
  );
}

// ---- 머리 전시: 시트 바탕 위에서 원이 떠 보이는가 -------------------------------

function HeadersKit(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sheetFloor, {paddingTop: insets.top + space.md}]}>
      <View style={styles.labelBox}>
        <GroupLabel>시트 머리 — 확정 ✓ 비활성(입력 전)</GroupLabel>
      </View>
      <SheetHeader
        title="상태 설정"
        closeLabel="상태 설정 닫기"
        onClose={noop}
        confirm={{label: '상태 저장', onPress: noop, disabled: true}}
      />
      <View style={styles.labelBox}>
        <GroupLabel>시트 머리 — 확정 ✓ 활성</GroupLabel>
      </View>
      <SheetHeader
        title="상태 설정"
        closeLabel="상태 설정 닫기"
        onClose={noop}
        confirm={{label: '상태 저장', onPress: noop}}
      />
      <View style={styles.labelBox}>
        <GroupLabel>시트 머리 — 확정 없음(오른쪽 X 만)</GroupLabel>
      </View>
      <SheetHeader title="메시지 액션" closeLabel="메시지 액션 닫기" onClose={noop} />
      <View style={styles.labelBox}>
        <GroupLabel>페이지 머리 — 왼쪽 X · 오른쪽 자리</GroupLabel>
      </View>
      <PageHeader
        title="설정"
        closeLabel="설정 닫기"
        onClose={noop}
        trailing={<Text style={styles.trailing}>편집</Text>}
      />
    </View>
  );
}

// ---- 중간 단 + 입력: 키보드가 올라와도 가려지지 않는다 --------------------------

function StatusSheet({ready}: {ready: boolean}): React.JSX.Element {
  const [text, setText] = useState(ready ? '집중하는 중' : '');
  return (
    <Backdrop>
      <PageSheet height="medium" onClose={noop} accessibilityLabel="상태 설정" testID="sheetkit-status-sheet">
        <SheetHeader
          title="상태 설정"
          closeLabel="상태 설정 닫기"
          confirm={{label: '상태 저장', onPress: noop, disabled: text.trim() === ''}}
        />
        <SheetScroll>
          <InputPill
            icon={MENU_ICONS.work}
            accessibilityLabel="상태 한 줄"
            placeholder="무엇을 하고 있나요?"
            value={text}
            onChangeText={setText}
            autoFocus
            testID="sheetkit-status-input"
          />
          <GroupCard label="추천" inset="icon">
            <ListRow leading={<RowEmoji emoji="📅" />} title="회의 중" onPress={noop} />
            <ListRow leading={<RowEmoji emoji="🍚" />} title="점심 먹는 중" onPress={noop} />
            <ListRow leading={<RowEmoji emoji="🏠" />} title="재택 근무" onPress={noop} />
          </GroupCard>
        </SheetScroll>
      </PageSheet>
    </Backdrop>
  );
}

// ---- 이전한 시트: 고정 데이터 -------------------------------------------------

const MESSAGE = {
  id: '00000000-0000-7000-8000-0000000043a1',
  channelId: '00000000-0000-7000-8000-0000000043c1',
  seq: 42,
  hlcTs: 42,
  hlcCount: 0,
  authorMemberId: '00000000-0000-7000-8000-0000000043b1',
  type: 'text',
  body: '금요일 배포는 오전 10시에 시작해요. 롤백 절차는 문서에 적어 뒀어요.',
  state: 'sent',
  createdAtMs: Date.UTC(2026, 9, 25, 1, 30),
} as unknown as Message;

const CHIPS = [{emoji: QUICK_REACTIONS[0], count: 2, mine: true}] as unknown as ReactionChip[];

const AVAILABILITY = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
  edit: true,
  delete: true,
} as never;

function MessageSheetSurface({confirmDelete}: {confirmDelete: boolean}): React.JSX.Element {
  return (
    <Backdrop>
      <MessageActionSheet
        message={MESSAGE}
        chips={CHIPS}
        availability={AVAILABILITY}
        authorLabel="이도현"
        startInDeleteConfirm={confirmDelete}
        onClose={noop}
        onToggleReaction={noop}
        onReply={noop}
        onQuote={noop}
        onCopy={noop}
        onPin={noop}
        onEdit={noop}
        onDelete={noop}
      />
    </Backdrop>
  );
}

/**
 * 살아 있는 메시지 행동 시트 — 누르면 **진짜로** 닫히고 행동이 기록된다. 실제 손가락 탭(maestro 110)이 「X 누름 →
 * 닫힘」과 「행동 누름 → 슬라이드가 끝난 뒤 onClose → 행동이 한 번」을 런타임에서 확인한다(jest 의 `fireEvent`
 * 는 히트 테스트를 건너뛴다). 기록은 시트가 걷힌 뒤에도 뒤 화면에 남는다.
 */
function MessageLiveSurface(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const note = (name: string) => () => setLog(previous => [...previous, name]);
  return (
    <Backdrop>
      <View style={styles.liveLog}>
        <Text style={styles.liveLogText} testID="sheetkit-live-log">
          {`기록: ${log.length === 0 ? '없음' : log.join(',')}`}
        </Text>
      </View>
      {open ? (
        <MessageActionSheet
          message={MESSAGE}
          chips={CHIPS}
          availability={AVAILABILITY}
          authorLabel="이도현"
          onClose={() => {
            setOpen(false);
            note('close')();
          }}
          onToggleReaction={note('react')}
          onReply={note('reply')}
          onQuote={note('quote')}
          onCopy={note('copy')}
          onPin={note('pin')}
          onEdit={note('edit')}
          onDelete={note('delete')}
        />
      ) : null}
    </Backdrop>
  );
}

/**
 * 대화 입력창이 **키보드를 든 채** 길게 눌러 연 메시지 행동 시트를 흉내 낸다. 입력창 대역(`TextInput autoFocus`)이
 * 키보드를 올리고 1.5초 뒤에 시트가 열린다. **관찰된 사실: iOS 는 Modal 을 띄울 때 키보드를 접는다** — 시트가 서면
 * 키보드가 없다(그래서 시트는 평소처럼 바닥에 선다). 시트가 서기 전의 키보드를 건드리지 않는 `keyboardWasUp` 은
 * 접히지 않고 남는 드문 경우의 안전망이다.
 */
function MessageKeyboardSurface(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Backdrop>
      <View style={styles.composerStandIn}>
        <TextInput
          autoFocus
          accessibilityLabel="메시지 보내기"
          placeholder="메시지 보내기"
          placeholderTextColor={palette.textMuted}
          style={styles.composerStandInInput}
        />
      </View>
      {open ? (
        <MessageActionSheet
          message={MESSAGE}
          chips={CHIPS}
          availability={AVAILABILITY}
          authorLabel="이도현"
          onClose={noop}
          onToggleReaction={noop}
          onReply={noop}
          onQuote={noop}
          onCopy={noop}
          onPin={noop}
          onEdit={noop}
          onDelete={noop}
        />
      ) : null}
    </Backdrop>
  );
}

const UNREAD: ReadState = {
  channelId: 'ch-design',
  lastReadSeq: 3,
  latestSeq: 9,
  unreadCount: 6,
  mentionCount: 0,
  markedUnreadBeforeSeq: null,
} as ReadState;

const CAUGHT_UP: ReadState = {
  channelId: 'dm-seoyeon',
  lastReadSeq: 9,
  latestSeq: 9,
  unreadCount: 0,
  mentionCount: 0,
  markedUnreadBeforeSeq: null,
} as ReadState;

// 관리자라서 「채널 나가기」(위험 행)까지 선다 - `canLeaveChannel` 은 소유자·관리자만 낸다.
const CHANNEL_TARGET: ChannelRowTarget = {
  channel: {id: 'ch-design', kind: 'public', topic: ''},
  title: '디자인',
  muted: false,
  selfRole: 'admin',
  readState: UNREAD,
};

const DM_TARGET: ChannelRowTarget = {
  channel: {id: 'dm-seoyeon', kind: 'dm', topic: ''},
  title: '박서연',
  muted: false,
  selfRole: 'member',
  readState: CAUGHT_UP,
  closeOffered: true,
};

function ChannelSheetSurface({
  target,
  confirmingLeave,
}: {
  target: ChannelRowTarget;
  confirmingLeave: boolean;
}): React.JSX.Element {
  return (
    <Backdrop>
      <ChannelActionSheet
        target={target}
        items={channelRowActionItems(target, NOTHING_COPIED)}
        confirmingLeave={confirmingLeave}
        isPending={() => false}
        error={null}
        leave={{pending: false, error: null}}
        onRun={noop}
        onConfirmLeave={noop}
        onCancelLeave={noop}
        onClose={noop}
      />
    </Backdrop>
  );
}

function roster(workspaceId: string, selfId: string, people: boolean): RosterMember[] {
  const base = {
    workspaceId,
    status: 'active' as const,
    channelCount: 2,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const self: RosterMember = {
    ...base,
    id: selfId,
    kind: 'human',
    displayName: '이도현',
    handle: 'dohyun',
    role: 'owner',
  };
  if (!people) return [self];
  return [
    self,
    {...base, id: '00000000-0000-7000-8000-0000000043d1', kind: 'human', displayName: '박서연', handle: 'seoyeon', role: 'member'},
    {...base, id: '00000000-0000-7000-8000-0000000043d2', kind: 'human', displayName: '최민수', handle: 'minsu', role: 'member'},
    {...base, id: '00000000-0000-7000-8000-0000000043d3', kind: 'human', displayName: '정하윤', handle: 'hayun', role: 'member'},
    {
      ...base,
      id: '00000000-0000-7000-8000-0000000043d4',
      kind: 'agent',
      displayName: '달무리 도우미',
      handle: 'dalmuri-helper',
      ownerHumanId: selfId,
    },
  ];
}

function NewDmSurface({people}: {people: boolean}): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const client = useMemo(() => {
    const seeded = new QueryClient({
      defaultOptions: {queries: {staleTime: Infinity, gcTime: Infinity, retry: false}},
    });
    seeded.setQueryData(workspaceKeys.roster(workspaceId), roster(workspaceId, member.id, people));
    return seeded;
  }, [workspaceId, member.id, people]);
  return (
    <QueryClientProvider client={client}>
      <Backdrop>
        <NewMessageSheet onOpenConversation={noop} onClose={noop} />
      </Backdrop>
    </QueryClientProvider>
  );
}

const DEVICE_FINGERPRINT = '5BAF F89D E7DE 5C1D 7B61';

function deviceRow(workspaceId: string, memberId: string, state: DeviceKey['state']): DeviceKey {
  return {
    id: '00000000-0000-7000-8000-0000000043e1',
    workspaceId,
    memberId,
    alg: 'p256',
    publicKey: DEVICE_PUBLIC_KEY,
    platform: 'ios',
    label: 'iPhone 16 Pro',
    state,
    canInstruct: false,
    current: true,
    lineageLive: true,
    createdAtMs: 1_700_000_000_000,
  };
}

/** 지시 기기 연결 시트의 세 상태 — 승인 기다림 · 승인됨 · 등록 실패. 배송되는 `LinkSheetBody` 에 상태를 건넨다. */
function deviceState(
  workspaceId: string,
  memberId: string,
  which: 'pending' | 'approved' | 'unregistered',
): DeviceKeyState {
  const view: DeviceKeyView =
    which === 'pending'
      ? {
          kind: 'pending',
          fingerprint: DEVICE_FINGERPRINT,
          row: deviceRow(workspaceId, memberId, 'unendorsed'),
          biometryOff: false,
        }
      : which === 'approved'
        ? {
            kind: 'approved',
            fingerprint: DEVICE_FINGERPRINT,
            row: deviceRow(workspaceId, memberId, 'endorsed'),
            biometryOff: false,
          }
        : {kind: 'unregistered', fingerprint: null};
  return {
    view,
    enroll: noop,
    replace: noop,
    refresh: noop,
    busy: false,
    failure:
      which === 'unregistered'
        ? '지시 기기로 등록하지 못했습니다. 연결을 확인하고 다시 시도하세요.'
        : null,
  };
}

function DeviceKeySheetSurface({
  which,
}: {
  which: 'pending' | 'approved' | 'unregistered';
}): React.JSX.Element {
  const {workspaceId, member} = useSession();
  return (
    <Backdrop>
      <PageSheet onClose={noop} accessibilityLabel="지시 기기">
        <LinkSheetBody state={deviceState(workspaceId, member.id, which)} onClose={noop} />
      </PageSheet>
    </Backdrop>
  );
}

const DEVICE_PUBLIC_KEY = 'A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW';

/**
 * 설정 페이지의 「지시 기기」 안쪽 장(#4457 — 옛 프로필 시트의 같은 장을 대체했다). `DeviceKeyPanel` 은 두 호스트
 * (이 장과 `DeviceKeyLinkSheet`)가 같은 `GroupCard` 로 선다. 가상 인물로 세운다.
 */
function ProfileDeviceSurface(): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const me = useMemo(
    () => ({...member, displayName: '이도현', handle: 'dohyun'}),
    [member],
  );
  const people = useMemo(
    () => roster(workspaceId, member.id, true),
    [workspaceId, member.id],
  );
  const client = useMemo(() => {
    const seeded = new QueryClient({
      defaultOptions: {queries: {staleTime: Infinity, gcTime: Infinity, retry: false}},
    });
    const row = deviceRow(workspaceId, member.id, 'unendorsed');
    seeded.setQueryData(DEVICE_KEY_LOCAL_QUERY_KEY, {
      status: 'ready',
      publicKey: DEVICE_PUBLIC_KEY,
    });
    seeded.setQueryData(DEVICE_KEYS_QUERY_KEY(workspaceId), [row]);
    seeded.setQueryData(workspaceKeys.roster(workspaceId), people);
    return seeded;
  }, [workspaceId, member.id, people]);
  return (
    <QueryClientProvider client={client}>
      <SettingsOverlay
        workspaceId={workspaceId}
        member={me}
        directory={makeDirectory(people)}
        connected
        onSignOut={noop}
        onClose={noop}
        initialPage="deviceKey"
      />
    </QueryClientProvider>
  );
}

export function SheetKitSurface({which}: {which: string}): React.JSX.Element {
  switch (which) {
    case 'page-lead':
      return <PageKit lead />;
    case 'headers':
      return <HeadersKit />;
    case 'status':
      return <StatusSheet ready={false} />;
    case 'status-ready':
      return <StatusSheet ready />;
    case 'message':
      return <MessageSheetSurface confirmDelete={false} />;
    case 'message-delete':
      return <MessageSheetSurface confirmDelete />;
    case 'message-live':
      return <MessageLiveSurface />;
    case 'message-keyboard':
      return <MessageKeyboardSurface />;
    case 'channel':
      return <ChannelSheetSurface target={CHANNEL_TARGET} confirmingLeave={false} />;
    case 'channel-leave':
      return <ChannelSheetSurface target={CHANNEL_TARGET} confirmingLeave />;
    case 'channel-dm':
      return <ChannelSheetSurface target={DM_TARGET} confirmingLeave={false} />;
    case 'devicekey-pending':
      return <DeviceKeySheetSurface which="pending" />;
    case 'devicekey-approved':
      return <DeviceKeySheetSurface which="approved" />;
    case 'devicekey-unregistered':
      return <DeviceKeySheetSurface which="unregistered" />;
    case 'profile-device':
      return <ProfileDeviceSurface />;
    case 'newdm':
      return <NewDmSurface people />;
    case 'newdm-empty':
      return <NewDmSurface people={false} />;
    default:
      return <PageKit lead={false} />;
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    backdrop: {flex: 1, backgroundColor: color.bg},
    backdropBody: {paddingHorizontal: SAFE_GUTTER, gap: space.md},
    backdropTitle: {fontSize: font.title, fontWeight: '700', color: color.text},
    backdropRow: {
      paddingVertical: space.md,
      borderRadius: ds2Radius.card,
      paddingHorizontal: space.lg,
      backgroundColor: color.surface,
    },
    backdropRowText: {fontSize: font.body, color: color.text},
    page: {flex: 1, backgroundColor: color.bg},
    pageBody: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.md, gap: space.lg},
    // 시트 바탕(`sheet`) 위에 서는 머리 — 페이지 바탕(`bg`)이 아니라 시트 위에서 원이 떠 보여야 한다.
    sheetFloor: {flex: 1, backgroundColor: color.sheet, gap: space.sm},
    pillGroup: {gap: space.sm},
    composerStandIn: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: '45%',
      paddingHorizontal: SAFE_GUTTER,
    },
    composerStandInInput: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.lg,
      borderRadius: ds2Radius.card,
      backgroundColor: color.surface,
      fontSize: font.body,
      color: color.text,
    },
    labelBox: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.md},
    liveLog: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: space.xl * 4,
      paddingHorizontal: SAFE_GUTTER,
    },
    liveLogText: {fontSize: font.title, color: color.text},
    trailing: {fontSize: font.body, color: color.textMuted},
  });

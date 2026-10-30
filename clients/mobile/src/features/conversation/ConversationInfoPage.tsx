import type {
  ChannelActionItem,
  ChannelActionKey,
} from '@momo/core/features/channels/actionModel';
import {channelActionClusterTitle} from '@momo/core/features/channels/actionModel';
import {
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  channelLeaveConfirmBody,
} from '@momo/core/features/channels/model';
import {roleLabel, type RoleLabels} from '@momo/core/features/directory/model';
import type {StatusDot as PeerStatus} from '@momo/core/features/presence/statusDot';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import type {Channel, RosterMember} from '@momo/core/lib/api';
import React, {useState} from 'react';
import {Image, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {AVATAR_INITIAL_MAX_SCALE, Screen, Sentence} from '../../design/atoms';
import {HOME_ICON_SIZE, HOME_ICONS} from '../../design/icons';
import {PageHeader} from '../../design/SheetChrome';
import {ConfirmStep, GroupCard, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {EdgeSwipeBack, useLayerClose} from '../../nav/EdgeSwipeBack';
import {
  BigFace,
  HeroMeta,
  memberChip,
  memberCustomStatus,
  ProfileHero,
  StatusChips,
  type ProfilePhoto,
} from '../directory/profileHero';
import {PROFILE_FACE, useFaceRing} from '../profile/ProfileFace';
import {avatarInitialMetrics} from './Avatar';
import {CONVERSATION_INFO_LABEL} from './conversationMenu';

// =============================================================================
// 대화·채널 정보 페이지 (#4319, owner 10-27 — 머리 가운데 이름·상태 알약이 여는 곳).
//
// 시트가 아니라 **페이지**다(`phone-sheets.md` §1): 이름·상태·알림·복사·나가기가 한 화면에 모이고, 되돌아올 곳(대화)이 있다. 대화 화면 안의 **안쪽
// 장**이라 머리는 ‹ 뒤로(「대화로 돌아가기」)이고, 오른쪽에서 밀려 들어와(`enter="push"`) 왼쪽 가장자리 밀기·‹·VoiceOver 두 손가락 문지르기가 한 겹만
// 벗긴다(대화는 밑에 남는다 — 안쪽 `EdgeSwipeBack` 이 바깥을 무장 해제한다). 고정 목록(`PinListPanel`)처럼 대화 화면의 지역 상태로 서고, 층은 JSX 순서다.
//
//   DM       큰 얼굴(사진이 있으면 눌러 크게 보기) · 이름 · 「@핸들 · 역할」 · 상태 칩 · 한 줄 상태
//            [에이전트: 「○○님이 관리」 · 에이전트 정보 ›] → 알림 → 복사(이름·링크·ID) → 대화 닫기
//   채널     큰 `#` 얼굴(비공개는 자물쇠 배지) · 이름 · 「6명 · 김인턴 참여 중」 · 주제
//            알림 → 복사 → 채널 나가기(확인 단계)
//
// ## 항목은 이 파일이 정하지 않는다
//
// 알림·복사·닫기·나가기는 부르는 쪽이 코어 표(`conversationInfoActionItems`)의 답을 그대로 넘기고 여기는 **그리기만** 한다 — 낱말·차례·위험색·진행 낱말·
// 복사 영수증(「복사됨」)·내밀지 말지(`canLeaveChannel`·`dmCloseOffered`)가 모두 코어의 것이다. 실행도 사이드바 행 시트·⋮ 시트와 같은 훅이다.
// 이 페이지는 훅의 **둘째 인스턴스**를 읽는다(화면이 든다): 훅은 시트 쪽 이름(`active`)을 쥐는데, 정보 페이지의 복사 영수증·알림 실패·나가기 확인이 ⋮ 시트를
// 띄우면 안 된다. 그래서 `active` 를 그리는 데 안 쓰고 `copied`·`error`·`isPending`·`confirmingLeave`·`leave` 만 읽는다.
//
// **별표·섹션 이동은 없다**: 폰에 그 손이 없어서(`channelRowActions.ts` 의 「죽은 항목 금지」, `canStar: false`·`sectionCount: 0`) 코어 표가 입력으로 이미 막는다.
// 멤버 목록도 이 페이지의 것이 아니다(후속).
//
// ## 카드는 모두 앞 칸이 없다 (`phone-sheets.md` §4)
//
// 한 표면의 카드는 모두 앞 아이콘을 갖거나 모두 갖지 않는다. 알림·닫기·나가기에 맞는 글리프(`bell-off`·`log-out`)가 아직 없고 그 여덟은 후속 아이콘
// 이슈에서 **한 번에** 구워진다 — 알림만 타일로 세우면 홀로 선 타일이 되고, 토글 행은 왕복 중 진행을 보일 자리가 없다. 그래서 ⋮ 시트와 같은 행이다.
// =============================================================================

/** 보조기술이 이 페이지의 얼굴(`#` 표지)에 주는 이름. 눈으로 보는 표지라 낭독은 이름·부제가 말하고, 비공개만 낱말을 더한다. */
const PRIVATE_FACE_LABEL = '비공개 채널';

export interface ConversationInfoPageProps {
  dmAgents?: RosterMember[];
  onRemoveDmAgent?: (id: string) => Promise<void>;
  kind: Channel['kind'];
  /** 대화의 이름 — DM 은 상대 이름, 채널은 `#` 없는 이름. */
  title: string;
  directory: Directory;
  /** 코어 표의 복사·알림·닫기·나가기(`conversationInfoActionItems`). */
  items: readonly ChannelActionItem[];
  confirmingLeave: boolean;
  isPending: (key: ChannelActionKey) => boolean;
  /** 알림·복사·닫기가 서버에서 거절됐을 때 그 자리에서 하는 말(토스트가 아니다). */
  error: string | null;
  leave: {pending: boolean; error: string | null};
  onRun: (key: ChannelActionKey) => void;
  onConfirmLeave: () => void;
  onCancelLeave: () => void;
  /** 한 겹 벗긴다 — ‹·가장자리 밀기·두 손가락 문지르기가 모두 이 길을 지난다(들어온 길의 반대로 나간 뒤 한 번). */
  onClose: () => void;
  /** DM 상대. 얼굴·핸들·상태 칩이 이 사람의 것이다. 모르면(명부가 아직 안 왔다) 얼굴이 비어 있다. */
  peer?: RosterMember | null;
  /** DM 상대의 상태 점(머리의 점과 같은 코어 판정 — 화면이 한 번 하고 둘이 나눠 쓴다). */
  status?: PeerStatus | null;
  /** 한 줄 상태의 만료를 가르는 시각. */
  nowMs: number;
  roleLabels?: RoleLabels;
  /** 채널의 한 줄 부제(`conversationSubtitle` — 「6명 · 김인턴 참여 중」). */
  subtitle?: string;
  /** 채널의 주제(코어 `normalizeChannelTopic` 을 지난 것). 비어 있으면 줄이 없다. */
  topic?: string;
  /** 「에이전트 정보」 문. 에이전트 DM 에서만 준다 — 주지 않으면 행이 서지 않는다. */
  onOpenAgent?: () => void;
  /** 큰 얼굴을 눌렀을 때 사진을 크게 보여 달라는 요청. 뷰어는 이 페이지가 아니라 대화 화면이 연다(층은 JSX 순서). 사진이 없는 얼굴은 눌리지 않는다. */
  onEnlargeAvatar?: (photo: ProfilePhoto) => void;
}

export function ConversationInfoPage({
  onClose,
  ...rest
}: ConversationInfoPageProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    // 스레드 패널·고정 목록과 같은 층·같은 제스처. 대화의 엣지 스와이프 래퍼와 부모-자식으로 겹치고 안쪽이 이긴다는 판정은 `EdgeSwipeBack` 이 스스로 한다.
    <EdgeSwipeBack
      accessibilityViewIsModal
      style={styles.overlay}
      onBack={onClose}
      // 스택의 push 처럼 오른쪽에서 밀려 들어오고, ‹ 는 오른쪽으로 물러난다(동작 줄이기면 즉시).
      enter="push"
      testID="conversation-info-pane">
      <InfoBody onClose={onClose} {...rest} />
    </EdgeSwipeBack>
  );
}

function InfoBody({
  dmAgents = [],
  onRemoveDmAgent,
  kind,
  title,
  directory,
  items,
  confirmingLeave,
  isPending,
  error,
  leave,
  onRun,
  onConfirmLeave,
  onCancelLeave,
  onClose,
  peer = null,
  status = null,
  nowMs,
  roleLabels,
  subtitle,
  topic,
  onOpenAgent,
  onEnlargeAvatar,
}: ConversationInfoPageProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  // ‹ · VoiceOver escape 는 같은 길로 한 겹만 벗긴다: 들어온 길의 반대로 물러난 뒤 `onClose`(층 밖에서는 곧바로 `onClose`).
  const closeLayer = useLayerClose();
  const goBack = closeLayer ?? onClose;
  const [dmPending, setDmPending] = useState<string | null>(null);
  const [dmError, setDmError] = useState<string | null>(null);
  const removeAgent = async (id: string) => {
    if (!onRemoveDmAgent) return;
    setDmPending(id); setDmError(null);
    try { await onRemoveDmAgent(id); }
    catch { setDmError('에이전트를 내보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.'); }
    finally { setDmPending(null); }
  };
  const isDm = kind === 'dm';
  const pageTitle = isDm ? CONVERSATION_INFO_LABEL.dm : CONVERSATION_INFO_LABEL.channel;

  const item = (key: ChannelActionKey) => items.find(candidate => candidate.key === key);
  const mute = item('mute');
  const leaving = item('close-dm') ?? item('leave');
  const copies = (['copy-name', 'copy-link', 'copy-id'] as const)
    .map(item)
    .filter((found): found is ChannelActionItem => found !== undefined);

  const row = (found: ChannelActionItem, accessory: 'none' | 'copy' = 'none') => {
    const busy = isPending(found.key);
    return (
      <ListRow
        key={found.key}
        title={busy && found.busyLabel ? found.busyLabel : found.label}
        tone={found.tone === 'danger' ? 'danger' : 'default'}
        accessory={accessory}
        busy={busy}
        // 페이지에는 닫는 길이 없다(`closesSheet` 가 없다) — 행동이 끝나도 이 페이지는 그대로 서 있고, 진행·영수증·실패를 이 자리에서 말한다.
        onPress={() => onRun(found.key)}
        testID={`conversation-info-${found.testKey}`}
      />
    );
  };

  const isAgent = peer?.kind === 'agent';
  const owner = peer?.ownerHumanId ? memberFor(directory, peer.ownerHumanId) : null;
  const kindWord = peer ? (isAgent ? '에이전트' : roleLabel(peer, roleLabels)) : null;

  return (
    // VoiceOver 의 두 손가락 문지르기는 한 겹만 벗긴다 — 대화(밑의 층)까지 올라가지 않는다.
    <View style={styles.root} onAccessibilityEscape={goBack} testID="conversation-info-page">
      <Screen>
        <PageHeader
          title={pageTitle}
          // 이 페이지는 대화 위에 쌓인 안쪽 장이라 X 가 아니라 ‹ 이다(`phone-sheets.md` §3). 이름은 어디로 가는지 말한다.
          back={{label: '대화로 돌아가기', onPress: goBack, testID: 'conversation-info-back'}}
          titleTestID="conversation-info-title"
          testID="conversation-info-header"
        />
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}
          testID="conversation-info-scroll">
          {isDm ? (
            <ProfileHero
              face={
                peer ? (
                  <BigFace
                    member={peer}
                    directory={directory}
                    isAgent={isAgent}
                    onEnlarge={onEnlargeAvatar}
                    testID="conversation-info-face"
                  />
                ) : (
                  <ChannelFace kind={kind} testID="conversation-info-face" />
                )
              }
              name={title}
              nameTestID="conversation-info-name"
              meta={
                peer ? (
                  <HeroMeta>
                    <Text testID="conversation-info-handle">{`@${peer.handle}`}</Text>
                    {kindWord ? (
                      <>
                        <Text>{' · '}</Text>
                        <Text testID="conversation-info-role">{kindWord}</Text>
                      </>
                    ) : null}
                  </HeroMeta>
                ) : null
              }
              chips={
                peer ? (
                  <StatusChips
                    chip={memberChip(peer, status)}
                    custom={memberCustomStatus(peer, nowMs)}
                    ids={{
                      chip: 'conversation-info-status',
                      dot: 'conversation-info-status-dot',
                      custom: 'conversation-info-status-text',
                    }}
                  />
                ) : null
              }
            />
          ) : (
            <ProfileHero
              face={<ChannelFace kind={kind} testID="conversation-info-face" />}
              name={title}
              nameTestID="conversation-info-name"
              meta={
                <>
                  {subtitle ? (
                    <HeroMeta numberOfLines={2} testID="conversation-info-subtitle">
                      {subtitle}
                    </HeroMeta>
                  ) : null}
                  {topic ? (
                    <Sentence style={styles.topic} testID="conversation-info-topic">
                      {topic}
                    </Sentence>
                  ) : null}
                </>
              }
            />
          )}

          {confirmingLeave ? (
            <ConfirmStep
              testID="conversation-info-leave-confirm"
              headline={CHANNEL_LEAVE_CONFIRM_TITLE}
              detail={channelLeaveConfirmBody(title)}
              error={leave.error}
              errorTestID="conversation-info-leave-error"
              confirmLabel={CHANNEL_LEAVE_LABEL}
              pendingLabel="나가는 중…"
              pending={leave.pending}
              onCancel={onCancelLeave}
              onConfirm={onConfirmLeave}
              cancelTestID="conversation-info-leave-cancel"
              confirmTestID="conversation-info-leave-confirm-button"
            />
          ) : (
            <>
              {error !== null ? (
                <Sentence
                  accessibilityRole="alert"
                  style={styles.error}
                  testID="conversation-info-error">
                  {error}
                </Sentence>
              ) : null}
              {isAgent ? (
                <GroupCard testID="conversation-info-agent">
                  <ListRow
                    title={owner ? `${owner.displayName}님이 관리` : '관리자 정보 없음'}
                    testID="conversation-info-owner"
                  />
                  {onOpenAgent !== undefined ? (
                    <ListRow
                      title="에이전트 정보"
                      accessory="chevron"
                      accessibilityHint="에이전트 상세 화면을 엽니다."
                      onPress={onOpenAgent}
                      testID="conversation-info-agent-open"
                    />
                  ) : null}
                </GroupCard>
              ) : null}
              {dmAgents.length > 0 && onRemoveDmAgent ? <GroupCard label="에이전트 · 이후 대화를 봐요" testID="conversation-info-dm-agents">
                {dmAgents.map(agent => <ListRow key={agent.id} title={dmPending === agent.id ? '내보내는 중이에요' : `${agent.displayName} (@${agent.handle}) 내보내기`} tone="danger" busy={dmPending === agent.id} disabled={dmPending !== null} onPress={() => { void removeAgent(agent.id); }} testID="dm-agent-remove" />)}
                {dmError !== null ? <Sentence style={styles.error} testID="dm-agent-remove-error">{dmError}</Sentence> : null}
              </GroupCard> : null}
              {mute !== undefined ? <GroupCard>{row(mute)}</GroupCard> : null}
              {copies.length > 0 ? (
                <GroupCard label={channelActionClusterTitle('copy')} testID="conversation-info-copy">
                  {copies.map(found => row(found, 'copy'))}
                </GroupCard>
              ) : null}
              {leaving !== undefined ? <GroupCard>{row(leaving)}</GroupCard> : null}
            </>
          )}
        </ScrollView>
      </Screen>
    </View>
  );
}

/**
 * 채널의 큰 얼굴 — 사람·에이전트의 큰 얼굴(`BigFace`)과 같은 크기·같은 링의 원 안에 `#`. 글자라 어느 크기에서도 선명하다(22pt 로 구운 `#` 글리프를
 * 키우면 흐려진다 — `phone-sheets.md` §4). 비공개는 22pt 자물쇠가 배지로 앉는다(원래 크기 그대로라 선명하다).
 */
function ChannelFace({
  kind,
  testID,
}: {
  kind: Channel['kind'];
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const ring = useFaceRing();
  const isPrivate = kind === 'private';
  return (
    <View
      accessible={isPrivate}
      accessibilityLabel={isPrivate ? PRIVATE_FACE_LABEL : undefined}
      style={[styles.channelFace, ring]}
      testID={testID}>
      {kind === 'dm' ? null : (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          // 이니셜과 같은 처지다 — 상자에 갇힌 표지라 큰 글씨에서도 원 안에 머문다(`Avatar` 의 이니셜이 같은 상한을 쓴다).
          maxFontSizeMultiplier={AVATAR_INITIAL_MAX_SCALE}
          style={[styles.channelHash, avatarInitialMetrics(PROFILE_FACE)]}>
          #
        </Text>
      )}
      {isPrivate ? (
        <View style={styles.lockBadge}>
          <Image
            accessibilityElementsHidden
            source={HOME_ICONS.lock}
            style={styles.lock}
            testID="conversation-info-lock"
          />
        </View>
      ) : null}
    </View>
  );
}

const LOCK_BADGE = 40;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    // 대화 화면 전체(안전 영역까지)를 덮는 한 겹. 불투명해야 밑의 대화가 비치지 않는다.
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: color.bg,
    },
    // 설정 페이지 본문과 같은 거터·카드 사이 간격(16). 라벨·카드 사이 8 은 부품(`GroupCard`)이 쥔다.
    content: {
      paddingTop: space.md,
      paddingHorizontal: SAFE_GUTTER,
      gap: space.lg,
    },
    error: {fontSize: font.label, color: color.danger, lineHeight: line.label},
    topic: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      textAlign: 'center',
    },
    channelFace: {
      width: PROFILE_FACE,
      height: PROFILE_FACE,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surface,
    },
    // 112 원 안의 `#` — 크기는 이니셜이 큰 얼굴에서 크는 비율 그대로(`avatarInitialMetrics`, 위 JSX 가 얹는다).
    channelHash: {fontWeight: '700', color: color.textMuted},
    // 자물쇠 배지: 얼굴 오른쪽 아래에 걸친다(`StatusDot` 이 아바타 모서리에 앉는 것과 같은 자리).
    lockBadge: {
      position: 'absolute',
      right: -space.xs,
      bottom: -space.xs,
      width: LOCK_BADGE,
      height: LOCK_BADGE,
      borderRadius: LOCK_BADGE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    lock: {width: HOME_ICON_SIZE.lock, height: HOME_ICON_SIZE.lock, tintColor: color.text},
  });

import {
  dmAvailability,
  openDmErrorMessage,
  roleLabel,
  type RoleLabels,
} from '@momo/core/features/directory/model';
import type {StatusDot as PeerStatus} from '@momo/core/features/presence/statusDot';
import type {RosterMember} from '@momo/core/lib/api';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Image,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {FailureBanner, Sentence} from '../../design/atoms';
import {HOME_ICON_SIZE, HOME_ICONS, MENU_ICONS, SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {
  ActionTile,
  ActionTileRow,
  GroupCard,
  ListRow,
  SheetScroll,
  TileIcon,
} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, space, type Palette} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {COPY_RECEIPT_MS, copyText} from '../conversation/copy';
import {
  BigFace,
  HeroMeta,
  memberChip,
  memberCustomStatus,
  ProfileHero,
  StatusChips,
  type ProfilePhoto,
} from './profileHero';
import {tilesFitInRow} from './profileTiles';

// =============================================================================
// 다른 사람 프로필 시트 (#4319, owner 10-24·25·27 — 「우리꺼는 너무 구려」).
//
// 옛 시트는 자체 `Modal` 에 글자 「닫기」·「구분·상태·역할」 키-값 줄·테두리 상자 안내문이었다. 이제 공용 시트 부품(#4318)이다 —
// `PageSheet`(오른쪽 위 원형 X · 손잡이·머리·본문 끌어내리기) + `SheetHeader` + `SheetScroll`. 구성은 Buzz 의 프로필 시트와 같다:
// **가운데 큰 얼굴 · 이름 · 상태 칩 · 한 줄 상태 → 큰 행동 타일 → 그 사람의 정보 카드**.
//
// 사람/에이전트가 같은 `member` 라는 제품 계약을 한 시트에서 그대로 보여 준다. 사람은 이 시트가 종착점이고, 에이전트는 기존
// AgentDetailScreen 으로 더 들어가는 문(「에이전트 정보」)을 얻는다. 설정·관리 액션은 ADR-0137 D5 밖이므로 만들지 않는다.
//
// ## 옛 키-값 줄의 정보는 어디로 갔나 (기능 손실 0)
//
//   구분(사람/에이전트)  얼굴의 모양(원/둥근 사각)과 이름 아래 한 줄 「@핸들 · 에이전트」. 얼굴은 보조기술에서 숨으므로 낱말이 읽힌다.
//   상태                 상태 칩. 활성이 아니면(초대됨·정지됨·삭제됨) 칩이 그 낱말을 말한다 — 그래서 DM 이 막히는 까닭이 보인다.
//                        활성이면 core 의 상태 점(`dmPeerStatusDot`, DM 머리와 같은 판정)이고, 말할 것이 없으면 칩이 없다.
//   역할                 이름 아래 한 줄 「@핸들 · 멤버」(에이전트는 역할이 없다 — core `roleLabel`).
//   관리(에이전트)       정보 카드의 「○○님이 관리」(없으면 「관리자 정보 없음」).
//
// ## 행동 타일 — 어느 것이 시트를 내리는가
//
//   메시지 보내기   **내리지 않는다.** 왕복(DM 열기)의 진행·실패를 이 시트가 보인다(`profile-dm-error` + 다시 시도). `closesSheet`
//                   로 보내면 시트가 먼저 걷혀 실패가 말할 곳이 없다(`phone-sheets.md` §2 「보내지 않는 행동」). 성공하면 부모가
//                   대화를 열며 시트를 걷는다.
//   멘션 복사       내리지 않는다. 「복사됨」 영수증이 같은 자리에 선다.
//   에이전트 정보   `closesSheet` — 다른 화면으로 가는 문이다(시트 → 페이지, §1 규칙 2).
//   설정 열기       `closesSheet` — 자기 자신을 열었을 때 DM 타일 자리에 선다(옛 「내 프로필입니다…」 상자 자리).
//
// 이메일은 **자리만** 있다(`email`). 명부(`RosterMember`)에 이메일이 없어 지금 화면은 값을 넘기지 않는다 — 값이 오는 날(엔진 필드 +
// 공개 범위 결정)이 되면 이 카드에 한 줄이 선다.
// =============================================================================

export type {ProfilePhoto};

/** 멘션 복사가 안 됐을 때 같은 자리에서 하는 말 — 토스트가 아니다. */
const COPY_FAILURE = '복사하지 못했어요. 다시 눌러 보세요.';

const TILE_LABELS = {
  dm: '메시지 보내기',
  mention: '멘션 복사',
  copied: '복사됨',
  agent: '에이전트 정보',
  settings: '설정 열기',
} as const;

export function MemberProfileSheet({
  member,
  directory,
  selfMemberId,
  online,
  dmPending,
  dmError,
  status = null,
  nowMs,
  email,
  roleLabels,
  onClose,
  onOpenDm,
  onOpenAgent,
  onOpenSettings,
  onEnlargeAvatar,
}: {
  member: RosterMember;
  directory: Directory;
  selfMemberId: string;
  online: boolean;
  dmPending: boolean;
  dmError: unknown | null;
  /**
   * 상태 점 — 부모가 core `dmPeerStatusDot` 로 판정해 넘긴다(DM 머리·홈 DM 줄과 같은 판정이고, 에이전트는 서버의 생존 읽기를 부모가
   * 든다). 모르면 `null` — 칩이 없다. 활성이 아닌 멤버는 이 값보다 멤버십 낱말(「초대됨」)이 먼저 말한다.
   */
  status?: PeerStatus | null;
  /** 한 줄 상태의 만료를 가르는 시각(`visibleCustomStatus`). */
  nowMs: number;
  /**
   * 그 사람의 이메일. **자리만** 있다 — 명부에 값이 없어 지금은 아무도 넘기지 않는다. 주면 정보 카드에 「이메일」 한 줄이 선다.
   */
  email?: string;
  roleLabels?: RoleLabels;
  onClose: () => void;
  onOpenDm: () => void;
  onOpenAgent?: () => void;
  /** 자기 자신의 프로필에서 「설정 열기」 타일이 부른다(시트를 내린 뒤 한 번). 없으면 그 타일이 없다. */
  onOpenSettings?: () => void;
  /**
   * 큰 얼굴을 눌렀을 때(시트를 내린 뒤 한 번) 사진을 크게 보여 달라는 요청. 사진이 있는 얼굴만 눌린다 — 이니셜 얼굴은 단추가 아니다.
   * 뷰어는 시트가 아니라 부른 화면이 연다(Modal 위에 Modal 을 쌓지 않는다, `phone-sheets.md` §1 규칙 2).
   */
  onEnlargeAvatar?: (photo: ProfilePhoto) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {width, fontScale} = useWindowDimensions();
  const availability = dmAvailability(member, selfMemberId);
  const isSelf = availability.kind === 'self';
  const isAgent = member.kind === 'agent';
  const canOpenDm = availability.kind === 'ready' && online;
  const owner = member.ownerHumanId ? memberFor(directory, member.ownerHumanId) : null;
  const emailText = email?.trim() ? email.trim() : null;

  // ---- 상태 칩 · 한 줄 상태 · 이름 아래 한 줄 ---------------------------------
  const chip = memberChip(member, status);
  const custom = memberCustomStatus(member, nowMs);
  const kindWord = isAgent ? '에이전트' : roleLabel(member, roleLabels);

  // ---- 멘션 복사 영수증 -------------------------------------------------------
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const mounted = useRef(true);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (receiptTimer.current !== null) clearTimeout(receiptTimer.current);
    };
  }, []);
  const copyMention = useCallback(() => {
    void copyText(`@${member.handle}`).then(ok => {
      if (!mounted.current) return;
      if (receiptTimer.current !== null) clearTimeout(receiptTimer.current);
      setCopy(ok ? 'done' : 'failed');
      if (ok) haptics.success();
      AccessibilityInfo.announceForAccessibility(ok ? TILE_LABELS.copied : COPY_FAILURE);
      receiptTimer.current = setTimeout(() => {
        if (mounted.current) setCopy('idle');
      }, COPY_RECEIPT_MS);
    });
  }, [member.handle]);

  // ---- 타일: 어느 것이 서는가 ---------------------------------------------------
  // 자리 하나가 「이 사람에게 하는 말」이다 — 남에게는 메시지, 나에게는 설정. 열 수 없으면(비활성·오프라인) 죽은 단추 대신 아래 까닭 문장이 선다.
  const showSettings = isSelf && onOpenSettings !== undefined;
  const showDm = canOpenDm;
  const showAgent = isAgent && onOpenAgent !== undefined;
  // 한 줄에 라벨이 다 들어가는가는 가장 긴 상태(영수증 「복사됨」은 더 짧다)로 정한다 — 영수증이 서고 걷힐 때 줄이 바뀌지 않게.
  const labels = [
    ...(showSettings ? [TILE_LABELS.settings] : []),
    ...(showDm ? [TILE_LABELS.dm] : []),
    TILE_LABELS.mention,
    ...(showAgent ? [TILE_LABELS.agent] : []),
  ];
  const stacked = !tilesFitInRow(labels, width, fontScale);

  const tiles = (
    <>
      {showSettings ? (
        <ActionTile
          icon={<UserGlyph />}
          label={TILE_LABELS.settings}
          onPress={onOpenSettings}
          closesSheet
          testID="profile-open-settings"
        />
      ) : null}
      {showDm ? (
        <ActionTile
          icon={<TileIcon source={MENU_ICONS.dm} />}
          label={TILE_LABELS.dm}
          onPress={onOpenDm}
          busy={dmPending}
          testID="profile-open-dm"
        />
      ) : null}
      <ActionTile
        icon={<TileIcon source={copy === 'done' ? SHEET_ICONS.check : SHEET_ICONS.copy} />}
        label={copy === 'done' ? TILE_LABELS.copied : TILE_LABELS.mention}
        onPress={copyMention}
        testID="profile-copy-mention"
      />
      {showAgent ? (
        <ActionTile
          icon={<TileIcon source={MENU_ICONS.agent} />}
          label={TILE_LABELS.agent}
          onPress={onOpenAgent}
          closesSheet
          testID="profile-open-agent"
        />
      ) : null}
    </>
  );

  // ---- DM 을 못 여는 까닭 (옛 문장 그대로) ---------------------------------------
  const reason: {headline: string; detail: string} | null = canOpenDm
    ? null
    : isSelf
      ? showSettings
        ? null // 설정 타일이 그 자리를 이어받는다 — 옛 「내 프로필입니다…」 상자는 없다.
        : {
            headline: '내 프로필입니다.',
            detail: '자기 자신과는 다이렉트 메시지를 열 수 없습니다.',
          }
      : availability.kind === 'inactive'
        ? {
            headline: `이 멤버는 ${availability.label} 상태입니다.`,
            detail: '활성 멤버가 되면 다이렉트 메시지를 열 수 있습니다.',
          }
        : {
            headline: '오프라인에서는 대화를 열 수 없습니다.',
            detail: '연결이 돌아오면 다시 시도하세요.',
          };

  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={`${member.displayName} 프로필`}
      scrimLabel="프로필 닫기"
      scrimTestID="member-profile-backdrop"
      testID="member-profile-sheet">
      <SheetHeader title="프로필" closeLabel="프로필 닫기" closeTestID="member-profile-close" />
      <SheetScroll testID="member-profile-scroll">
        <ProfileHero
          face={
            <BigFace
              member={member}
              directory={directory}
              isAgent={isAgent}
              onEnlarge={onEnlargeAvatar}
            />
          }
          name={member.displayName}
          nameTestID="profile-name"
          meta={
            <HeroMeta>
              <Text testID="profile-handle">{`@${member.handle}`}</Text>
              {kindWord ? (
                <>
                  <Text>{' · '}</Text>
                  <Text testID="profile-role">{kindWord}</Text>
                </>
              ) : null}
            </HeroMeta>
          }
          chips={
            <StatusChips
              chip={chip}
              custom={custom}
              ids={{chip: 'profile-status', dot: 'profile-status-dot', custom: 'profile-status-text'}}
            />
          }
        />

        {stacked ? <View style={styles.tileStack}>{tiles}</View> : <ActionTileRow>{tiles}</ActionTileRow>}

        {reason !== null ? (
          <View style={styles.reason} testID="profile-dm-unavailable">
            <Sentence style={styles.reasonHeadline}>{reason.headline}</Sentence>
            <Sentence style={styles.reasonDetail}>{reason.detail}</Sentence>
          </View>
        ) : null}

        {copy === 'failed' ? (
          <Sentence accessibilityRole="alert" style={styles.copyError} testID="profile-copy-error">
            {COPY_FAILURE}
          </Sentence>
        ) : null}

        {dmError !== null ? (
          <FailureBanner
            message={openDmErrorMessage(dmError, member.displayName)}
            onRetry={canOpenDm && !dmPending ? onOpenDm : undefined}
            testID="profile-dm-error"
          />
        ) : null}

        {emailText !== null || isAgent ? (
          <GroupCard testID="profile-details">
            {emailText !== null ? (
              <ListRow title="이메일" value={emailText} testID="profile-email" />
            ) : null}
            {isAgent ? (
              <ListRow
                title={owner ? `${owner.displayName}님이 관리` : '관리자 정보 없음'}
                testID="profile-owner"
              />
            ) : null}
          </GroupCard>
        ) : null}
      </SheetScroll>
    </PageSheet>
  );
}

/**
 * 설정 타일의 앞 글리프. 우리 아이콘 세트에는 톱니가 없고(새 에셋은 이 이슈가 만들지 않는다) 「내 계정」은 사람 윤곽이 가장 가깝다.
 * 그 글리프(`HOME_ICONS.user`)는 18pt 로 구워져 22 칸으로 키우면 흐려지므로(`phone-sheets.md` §4) 제 크기로 그리고, 이웃 타일과 라벨 줄이
 * 어긋나지 않게 22 칸 안에 가운데 앉힌다.
 */
function UserGlyph(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.glyphSlot}>
      <Image source={HOME_ICONS.user} style={styles.userGlyph} accessibilityElementsHidden />
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    tileStack: {gap: space.sm},
    glyphSlot: {
      width: SHEET_ICON_SIZE.copy,
      height: SHEET_ICON_SIZE.copy,
      alignItems: 'center',
      justifyContent: 'center',
    },
    userGlyph: {
      width: HOME_ICON_SIZE.user,
      height: HOME_ICON_SIZE.user,
      tintColor: color.text,
    },
    // 까닭은 상자가 아니라 타일 아래의 조용한 두 줄이다 — 옛 시트의 테두리 안내 상자가 「구리다」의 한 조각이었다.
    reason: {alignItems: 'center', gap: space.xs},
    reasonHeadline: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.textMuted,
      textAlign: 'center',
    },
    reasonDetail: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      textAlign: 'center',
    },
    copyError: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.dangerText,
      textAlign: 'center',
    },
  });

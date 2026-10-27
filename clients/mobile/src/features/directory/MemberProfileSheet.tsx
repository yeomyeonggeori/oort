import {
  dmAvailability,
  openDmErrorMessage,
  roleLabel,
  statusLabel,
  type RoleLabels,
} from '@momo/core/features/directory/model';
import {
  customStatusAccessibleText,
  visibleCustomStatus,
} from '@momo/core/features/presence/customStatus';
import type {
  StatusDot as PeerStatus,
  StatusDotTone,
} from '@momo/core/features/presence/statusDot';
import type {RosterMember} from '@momo/core/lib/api';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {FailureBanner, Sentence} from '../../design/atoms';
import {HOME_ICON_SIZE, HOME_ICONS, MENU_ICONS, SHEET_ICON_SIZE, SHEET_ICONS} from '../../design/icons';
import {PageSheet, usePageSheetAction} from '../../design/PageSheet';
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
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {Avatar, useAvatarSource} from '../conversation/Avatar';
import {COPY_RECEIPT_MS, copyText} from '../conversation/copy';
import {StatusDot} from '../presence/StatusDot';
import {
  PROFILE_FACE,
  PROFILE_FACE_SQUARE_RADIUS,
  PROFILE_FACE_SQUARE_RING_RADIUS,
  useFaceRing,
} from '../profile/ProfileFace';
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

/** 크게 볼 사진 — 호출한 쪽(대화 화면)이 시트를 내린 뒤 `AvatarViewer` 로 연다. */
export interface ProfilePhoto {
  uri: string;
  label: string;
}

/** 얼굴을 눌러 크게 보는 단추의 이름(사진이 있을 때만 단추다)과 뷰어가 읽는 사진의 이름. */
const enlargeName = (name: string) => `${name} 프로필 사진 크게 보기`;
const photoName = (name: string) => `${name} 프로필 사진`;

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
  const membershipWord = statusLabel(member);
  const chip: {label: string; tone: StatusDotTone | null} | null =
    membershipWord !== null
      ? {label: membershipWord, tone: null}
      : status !== null
        ? {label: status.label, tone: status.tone}
        : null;
  const custom = visibleCustomStatus(member, nowMs);
  const customLine = custom ? [custom.emoji, custom.text].filter(Boolean).join(' ') : null;
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
        <View style={styles.hero}>
          <Face
            member={member}
            directory={directory}
            isAgent={isAgent}
            onEnlarge={onEnlargeAvatar}
          />
          <View style={styles.heroText}>
            <Sentence style={styles.name} numberOfLines={2} testID="profile-name">
              {member.displayName}
            </Sentence>
            <Text style={styles.meta} numberOfLines={1}>
              <Text testID="profile-handle">{`@${member.handle}`}</Text>
              {kindWord ? (
                <>
                  <Text>{' · '}</Text>
                  <Text testID="profile-role">{kindWord}</Text>
                </>
              ) : null}
            </Text>
          </View>
          {chip !== null || customLine !== null ? (
            <View style={styles.pills}>
              {chip !== null ? (
                <View
                  accessible
                  accessibilityLabel={`상태: ${chip.label}`}
                  style={styles.chip}
                  testID="profile-status">
                  {chip.tone !== null ? (
                    <StatusDot tone={chip.tone} testID="profile-status-dot" />
                  ) : null}
                  {/* 낱말을 자르지 않는다 — 「조용함 · 마지막 응답 5분 전」 같은 긴 판정이 큰 글씨·좁은 폭에서 한 줄이 못 되면 알약 안에서 접힌다. */}
                  <Sentence style={styles.chipLabel}>{chip.label}</Sentence>
                </View>
              ) : null}
              {customLine !== null ? (
                <View style={[styles.chip, styles.customPill]}>
                  <Sentence
                    accessibilityLabel={customStatusAccessibleText(member, nowMs) ?? undefined}
                    style={styles.customText}
                    testID="profile-status-text">
                    {customLine}
                  </Sentence>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

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
 * 큰 얼굴. 사진이 **있을 때만** 단추다 — 눌리는지는 `Avatar` 가 그리는 것과 같은 판정(`useAvatarSource`)에서 나온다. 이니셜·「모른다」
 * 표지의 얼굴은 눌러도 아무 일도 없고 단추 역할도 없다(눌리는 척하는 얼굴이 가장 나쁘다).
 *
 * 누르면 시트를 내린 뒤(`usePageSheetAction`) 부른 쪽이 사진을 연다. 사람은 원, 에이전트는 둥근 사각이고(ADR-0189, `Avatar` 가 가른다)
 * 둘 다 설정 페이지의 큰 얼굴과 같은 크기·같은 링이다(`ProfileFace`).
 */
function Face({
  member,
  directory,
  isAgent,
  onEnlarge,
}: {
  member: RosterMember;
  directory: Directory;
  isAgent: boolean;
  onEnlarge?: (photo: ProfilePhoto) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const faceRing = useFaceRing();
  const afterClose = usePageSheetAction();
  const {source} = useAvatarSource(directory, member.id);
  const ring = [faceRing, isAgent && styles.ringSquare];
  const face = (
    <Avatar
      directory={directory}
      memberId={member.id}
      size={PROFILE_FACE}
      squareRadius={isAgent ? PROFILE_FACE_SQUARE_RADIUS : undefined}
    />
  );
  if (source === null || onEnlarge === undefined) {
    return (
      <View style={ring} testID="profile-face">
        {face}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={enlargeName(member.displayName)}
      onPress={() => afterClose(() => onEnlarge({uri: source, label: photoName(member.displayName)}))}
      style={({pressed}) => [ring, pressed && styles.facePressed]}
      testID="profile-face">
      {face}
    </Pressable>
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
    // 설정 페이지의 히어로(`SettingsPage` `hero`)와 같은 문법 — 큰 얼굴 · 이름 · 알약 한 줄.
    hero: {alignItems: 'center', gap: space.md, paddingTop: space.sm},
    heroText: {alignItems: 'center', gap: space.xs, alignSelf: 'stretch'},
    name: {
      fontSize: font.title,
      fontWeight: '700',
      color: color.text,
      textAlign: 'center',
    },
    meta: {fontSize: font.label, color: color.textMuted, textAlign: 'center'},
    ringSquare: {borderRadius: PROFILE_FACE_SQUARE_RING_RADIUS},
    facePressed: {opacity: 0.7},
    pills: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: space.sm,
    },
    // 테두리가 없다 — 작은 테두리 알약은 이 팔레트에서 **컨트롤** 문법이고, 이 알약은 누를 수 없다(`SettingsPage` 알약과 같은 이유).
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      backgroundColor: color.surface,
      maxWidth: '100%',
    },
    chipLabel: {flexShrink: 1, fontSize: font.label, fontWeight: '600', color: color.text},
    customPill: {boxShadow: color.elevationRest, flexShrink: 1},
    customText: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.textMuted,
      textAlign: 'center',
    },
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

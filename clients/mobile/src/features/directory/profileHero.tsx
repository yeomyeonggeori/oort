import {statusLabel} from '@momo/core/features/directory/model';
import {
  customStatusAccessibleText,
  visibleCustomStatus,
} from '@momo/core/features/presence/customStatus';
import type {
  StatusDot as PeerStatus,
  StatusDotTone,
} from '@momo/core/features/presence/statusDot';
import type {RosterMember} from '@momo/core/lib/api';
import type {Directory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {usePageSheetAction} from '../../design/PageSheet';
import {useStyles} from '../../design/theme';
import {font, radius, space, type Palette} from '../../design/tokens';
import {Avatar, useAvatarSource} from '../conversation/Avatar';
import {StatusDot} from '../presence/StatusDot';
import {
  PROFILE_FACE,
  PROFILE_FACE_SQUARE_RADIUS,
  PROFILE_FACE_SQUARE_RING_RADIUS,
  useFaceRing,
} from '../profile/ProfileFace';

// =============================================================================
// 큰 얼굴 · 이름 · 상태 칩 — 다른 사람 프로필 시트와 대화 정보 페이지가 **같이 쓰는** 히어로 (#4319).
//
// 처음엔 프로필 시트 안에 비공개로 있었다. 대화 정보 페이지(DM)가 같은 얼굴·같은 칩을 그려야 해서 꺼냈다 — 두 표면이 같은 사람을 다르게
// 그리면 「프로필에서는 응답함, 정보에서는 조용함」 같은 어긋남이 생긴다(칩의 판정은 부르는 쪽이 코어로 한 번 한다).
//
// 얼굴은 시트 후손일 수도 페이지일 수도 있다: `usePageSheetAction()` 은 시트 밖에서는 바로 부른다(`PageSheet`). 시트에서는 시트가 먼저 내려간
// 뒤에 부르고, 페이지에서는 그 자리에서 부른다 — 어느 쪽이든 뷰어는 **부른 화면**이 연다(Modal 위에 Modal 을 쌓지 않는다).
// =============================================================================

/** 크게 볼 사진 — 호출한 쪽(대화 화면)이 `AvatarViewer` 로 연다. */
export interface ProfilePhoto {
  uri: string;
  label: string;
}

/** 얼굴을 눌러 크게 보는 단추의 이름(사진이 있을 때만 단추다)과 뷰어가 읽는 사진의 이름. */
export const enlargeName = (name: string) => `${name} 프로필 사진 크게 보기`;
export const photoName = (name: string) => `${name} 프로필 사진`;

/** 칩이 말하는 것: 멤버십 낱말(초대됨·정지됨·삭제됨)이 먼저, 활성이면 코어의 상태 점, 말할 것이 없으면 `null`. */
export interface ProfileChip {
  label: string;
  tone: StatusDotTone | null;
}

export function memberChip(
  member: RosterMember,
  status: PeerStatus | null,
): ProfileChip | null {
  const membershipWord = statusLabel(member);
  if (membershipWord !== null) return {label: membershipWord, tone: null};
  return status !== null ? {label: status.label, tone: status.tone} : null;
}

/** 한 줄 상태(이모지 + 글) — 만료됐으면 `null`. `accessible` 은 만료까지 읽는 낭독 문장이다. */
export function memberCustomStatus(
  member: RosterMember,
  nowMs: number,
): {line: string; accessible: string | undefined} | null {
  const custom = visibleCustomStatus(member, nowMs);
  if (!custom) return null;
  return {
    line: [custom.emoji, custom.text].filter(Boolean).join(' '),
    accessible: customStatusAccessibleText(member, nowMs) ?? undefined,
  };
}

/**
 * 큰 얼굴. 사진이 **있을 때만** 단추다 — 눌리는지는 `Avatar` 가 그리는 것과 같은 판정(`useAvatarSource`)에서 나온다. 이니셜·「모른다」
 * 표지의 얼굴은 눌러도 아무 일도 없고 단추 역할도 없다(눌리는 척하는 얼굴이 가장 나쁘다).
 *
 * 사람은 원, 에이전트는 둥근 사각이고(ADR-0189, `Avatar` 가 가른다) 둘 다 설정 페이지의 큰 얼굴과 같은 크기·같은 링이다(`ProfileFace`).
 */
export function BigFace({
  member,
  directory,
  isAgent,
  onEnlarge,
  testID = 'profile-face',
}: {
  member: RosterMember;
  directory: Directory;
  isAgent: boolean;
  onEnlarge?: (photo: ProfilePhoto) => void;
  testID?: string;
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
      <View style={ring} testID={testID}>
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
      testID={testID}>
      {face}
    </Pressable>
  );
}

/** 칩의 testID 셋 — 프로필 시트와 정보 페이지가 각자 이름을 갖는다(한 화면에 둘이 서도 겹치지 않게). */
export interface StatusChipIds {
  chip: string;
  dot: string;
  custom: string;
}

/** 상태 칩과 한 줄 상태. 둘 다 없으면 아무것도 그리지 않는다. */
export function StatusChips({
  chip,
  custom,
  ids,
}: {
  chip: ProfileChip | null;
  custom: {line: string; accessible: string | undefined} | null;
  ids: StatusChipIds;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (chip === null && custom === null) return null;
  return (
    <View style={styles.pills}>
      {chip !== null ? (
        <View
          accessible
          accessibilityLabel={`상태: ${chip.label}`}
          style={styles.chip}
          testID={ids.chip}>
          {chip.tone !== null ? <StatusDot tone={chip.tone} testID={ids.dot} /> : null}
          {/* 낱말을 자르지 않는다 — 「조용함 · 마지막 응답 5분 전」 같은 긴 판정이 큰 글씨·좁은 폭에서 한 줄이 못 되면 알약 안에서 접힌다. */}
          <Sentence style={styles.chipLabel}>{chip.label}</Sentence>
        </View>
      ) : null}
      {custom !== null ? (
        <View style={[styles.chip, styles.customPill]}>
          <Sentence
            accessibilityLabel={custom.accessible}
            style={styles.customText}
            testID={ids.custom}>
            {custom.line}
          </Sentence>
        </View>
      ) : null}
    </View>
  );
}

/** 이름 아래 한 줄(「@핸들 · 멤버」·「6명 · 김인턴 참여 중」). 안에 `Text` 를 이어 붙일 수 있다. */
export function HeroMeta({
  children,
  numberOfLines = 1,
  testID,
}: {
  children: React.ReactNode;
  /** 한 줄이 기본이다. 문장(채널의 부제)은 두 줄까지 — 줄바꿈은 어절 단위다. */
  numberOfLines?: number;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Text
      lineBreakStrategyIOS="hangul-word"
      style={styles.meta}
      numberOfLines={numberOfLines}
      testID={testID}>
      {children}
    </Text>
  );
}

/**
 * 히어로의 틀 — 설정 페이지의 히어로(`SettingsPage` `hero`)와 같은 문법: 큰 얼굴 · 이름 · (이름 아래 줄들) · 알약 한 줄.
 * 얼굴·이름 아래 줄·알약은 부르는 쪽이 넘긴다(사람은 프로필 얼굴, 채널은 `#` 얼굴).
 */
export function ProfileHero({
  face,
  name,
  nameTestID,
  meta,
  chips,
}: {
  face: React.ReactNode;
  name: string;
  nameTestID: string;
  meta?: React.ReactNode;
  chips?: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.hero}>
      {face}
      <View style={styles.heroText}>
        <Sentence style={styles.name} numberOfLines={2} testID={nameTestID}>
          {name}
        </Sentence>
        {meta}
      </View>
      {chips}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
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
  });

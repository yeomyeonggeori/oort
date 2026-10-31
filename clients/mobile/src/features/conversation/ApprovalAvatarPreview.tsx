import {
  AVATAR_PREVIEW_ALT,
  AVATAR_PREVIEW_CAPTION,
  approvalAvatarPreviewPath,
  profileAvatarHeadline,
} from '@momo/core/features/approvals/avatarPreview';
import type { AgentApprovalCard } from '@momo/core/features/timeline/agentCardModel';
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { font, line, radius, space, type Palette } from '../../design/tokens';
import { OutlineButton, Sentence } from '../../design/atoms';
import { useStyles } from '../../design/theme';
import { useSession } from '../../session/useSession';
import {
  loadMemberAvatar,
  memberAvatarCacheKey,
  peekMemberAvatar,
  useMemberAvatarUri,
} from './memberAvatarImage';

// =============================================================================
// `member.avatar.set` 승인 카드의 머리: 한 문장 + 제안된 사진 (#4394, ADR-0186 증보 v4)
//
// 미리보기 주소는 웹과 같은 코어 `avatarPreview`가 정한다.
// 사진은 서버가 다시 인코딩한 것이고, 베어러가 있어야 읽혀서 멤버 아바타와 같은 파일
// 캐시 길(`memberAvatarImage`)로 받는다 — RN `Image` 는 헤더를 못 싣는다.
//
// 서버의 404는 권한·만료·네트워크와 구별하지 않는다. 실패 이유를 추측하지 않고
// 사진을 표시할 수 없다고 말한다. 실제 Image 표시 전에는 승인만 잠그고 거부는 남긴다.
// =============================================================================

/** 사진 원의 지름. 아바타(32)와 프로필 시트의 큰 얼굴 사이, 결정할 만큼 알아보이는 크기. */
const PREVIEW_SIZE = 80;

type Loaded = { path: string; attempt: number; uri: string | null };

export function ApprovalAvatarPreview({
  card,
  agentName,
  onReadyChange,
}: {
  card: AgentApprovalCard;
  agentName: string | null;
  onReadyChange?: (ready: boolean) => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const { workspaceId } = useSession();
  const action = card.action;
  const path = approvalAvatarPreviewPath(
    workspaceId,
    card.approvalId,
    action?.preview ?? null,
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [displayed, setDisplayed] = useState<{key: string; ready: boolean} | null>(null);
  const imageKey = `${path}:${attempt}`;
  const previous = useMemberAvatarUri(
    action?.preview?.previousAvatarUrl ?? null,
  );

  useEffect(() => {
    if (path === null) return undefined;
    let alive = true;
    void loadMemberAvatar(path, attempt > 0).then(uri => {
      if (alive) setLoaded({ path, attempt, uri });
    });
    return () => {
      alive = false;
    };
  }, [path, attempt]);

  const headline = profileAvatarHeadline(action?.id, agentName);

  // 받아 둔 파일은 첫 프레임부터 이미지다. 결과는 어느 주소의 것인지 함께 들고 있어서,
  // 주소가 바뀐 첫 렌더에 앞 카드의 사진을 그리지 않는다.
  const uri =
    path === null
      ? null
      : (attempt === 0 ? peekMemberAvatar(memberAvatarCacheKey(path)) : null) ??
        (loaded?.path === path && loaded.attempt === attempt ? loaded.uri : null);
  const unavailable =
    path === null ||
    (loaded?.path === path && loaded.attempt === attempt && loaded.uri === null && uri === null) ||
    (displayed?.key === imageKey && !displayed.ready);
  const ready = uri !== null && !unavailable && displayed?.key === imageKey && displayed.ready;
  useEffect(() => {
    onReadyChange?.(ready);
  }, [onReadyChange, ready]);
  if (headline === null) return null;

  return (
    <View style={styles.box} testID="approval-avatar-preview">
      <Sentence style={styles.headline} testID="approval-avatar-headline">
        {headline}
      </Sentence>
      <View style={styles.row}>
        <View style={styles.column}>
          <Sentence style={styles.caption}>바꾸기 전</Sentence>
          <View style={styles.frame}>
            {previous !== null ? (
              <Image
                source={{ uri: previous }}
                style={styles.image}
                accessibilityLabel="바꾸기 전 프로필 사진"
              />
            ) : (
              <Sentence style={styles.caption}>
                {action?.preview?.previousAvatarUrl
                  ? '사진을 불러와요'
                  : '사진 없음'}
              </Sentence>
            )}
          </View>
        </View>
        <View style={styles.column}>
          <Sentence style={styles.caption}>바꾼 뒤</Sentence>
          <View
            style={styles.frame}
            testID="approval-avatar-frame"
            accessibilityElementsHidden={uri === null || unavailable}
          >
            {uri !== null && !unavailable ? (
              <Image
                key={imageKey}
                source={{ uri }}
                style={styles.image}
                accessibilityLabel={
                  action?.id === 'agent.profile.update'
                    ? '에이전트의 프로필 사진으로 제안된 사진'
                    : AVATAR_PREVIEW_ALT
                }
                onLoad={() => setDisplayed({key: imageKey, ready: true})}
                onError={() => setDisplayed({key: imageKey, ready: false})}
                testID="approval-avatar-image"
              />
            ) : null}
          </View>
        </View>
      </View>
      <Sentence
        accessibilityLiveRegion={unavailable ? 'polite' : undefined}
        style={styles.caption}
        testID="approval-avatar-caption">
        {unavailable
          ? '사진을 불러오지 못했어요. 사진을 확인한 뒤 승인할 수 있어요.'
          : !ready
          ? '사진을 확인한 뒤 승인할 수 있어요.'
          : action?.id === 'agent.profile.update'
          ? '승인하면 에이전트의 프로필 사진이 이 사진으로 바뀌어요.'
          : AVATAR_PREVIEW_CAPTION}
      </Sentence>
      {unavailable ? (
        <OutlineButton
          label="다시 불러오기"
          onPress={() => {
            onReadyChange?.(false);
            setAttempt(value => value + 1);
          }}
          testID="approval-avatar-retry"
        />
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    box: { gap: space.sm, paddingTop: space.sm },
    headline: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.text,
    },
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      gap: space.md,
    },
    column: { gap: space.xs },
    frame: {
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      borderRadius: radius.pill,
      overflow: 'hidden',
      // 사진이 없는 자리(받는 중·본인 아님)도 다크 바탕에서 보이도록 1px 선을 둔다(리뷰 M2).
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surfacePressed,
      justifyContent: 'center',
      alignItems: 'center',
    },
    image: { width: PREVIEW_SIZE, height: PREVIEW_SIZE },
    caption: {
      fontSize: font.meta,
      lineHeight: line.label,
      color: color.textMuted,
    },
  });

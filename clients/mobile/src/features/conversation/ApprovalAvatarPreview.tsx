import {
  AVATAR_PREVIEW_ALT,
  AVATAR_PREVIEW_CAPTION,
  AVATAR_PREVIEW_UNAVAILABLE,
  approvalAvatarPreviewPath,
  memberAvatarSetHeadline,
} from '@momo/core/features/approvals/avatarPreview';
import type {AgentApprovalCard} from '@momo/core/features/timeline/agentCardModel';
import React, {useEffect, useState} from 'react';
import {Image, StyleSheet, View} from 'react-native';
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {useSession} from '../../session/useSession';
import {loadMemberAvatar, memberAvatarCacheKey, peekMemberAvatar} from './memberAvatarImage';

// =============================================================================
// `member.avatar.set` 승인 카드의 머리: 한 문장 + 제안된 사진 (#4394, ADR-0186 증보 v4)
//
// 웹 `AvatarPreviewBlock` 과 같은 문장·같은 주소·같은 실패 문장이다(코어 `avatarPreview`).
// 사진은 서버가 다시 인코딩한 것이고, 베어러가 있어야 읽혀서 멤버 아바타와 같은 파일
// 캐시 길(`memberAvatarImage`)로 받는다 — RN `Image` 는 헤더를 못 싣는다.
//
// 사진 주인이 아닌 사람에게는 서버가 404 를 주고 버튼도 403 이다. 이 컴포넌트는 누가
// 주인인지 추측하지 않고, 못 읽은 자리를 한 줄로 말한다.
// =============================================================================

/** 사진 원의 지름. 아바타(32)와 프로필 시트의 큰 얼굴 사이, 결정할 만큼 알아보이는 크기. */
const PREVIEW_SIZE = 80;

type Loaded = {path: string; uri: string | null};

export function ApprovalAvatarPreview({
  card,
  agentName,
}: {
  card: AgentApprovalCard;
  agentName: string | null;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const {workspaceId} = useSession();
  const action = card.action;
  const path = approvalAvatarPreviewPath(workspaceId, card.approvalId, action?.preview ?? null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (path === null) return undefined;
    let alive = true;
    void loadMemberAvatar(path).then(uri => {
      if (alive) setLoaded({path, uri});
    });
    return () => {
      alive = false;
    };
  }, [path]);

  const headline = memberAvatarSetHeadline(action?.id, agentName);
  if (headline === null) return null;

  // 받아 둔 파일은 첫 프레임부터 이미지다. 결과는 어느 주소의 것인지 함께 들고 있어서,
  // 주소가 바뀐 첫 렌더에 앞 카드의 사진을 그리지 않는다.
  const uri =
    path === null
      ? null
      : (peekMemberAvatar(memberAvatarCacheKey(path)) ??
        (loaded?.path === path ? loaded.uri : null));
  const unavailable = path === null || (loaded?.path === path && loaded.uri === null && uri === null);

  return (
    <View style={styles.box} testID="approval-avatar-preview">
      <Sentence style={styles.headline} testID="approval-avatar-headline">
        {headline}
      </Sentence>
      <View style={styles.row}>
        <View
          style={styles.frame}
          testID="approval-avatar-frame"
          accessibilityElementsHidden={uri === null}>
          {uri !== null ? (
            <Image
              source={{uri}}
              style={styles.image}
              accessibilityLabel={AVATAR_PREVIEW_ALT}
              testID="approval-avatar-image"
            />
          ) : null}
        </View>
        <Sentence style={styles.caption} testID="approval-avatar-caption">
          {unavailable ? AVATAR_PREVIEW_UNAVAILABLE : AVATAR_PREVIEW_CAPTION}
        </Sentence>
      </View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    box: {gap: space.sm, paddingTop: space.sm},
    headline: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.text,
    },
    row: {flexDirection: 'row', alignItems: 'center', gap: space.md},
    frame: {
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      borderRadius: radius.pill,
      overflow: 'hidden',
      // 사진이 없는 자리(받는 중·본인 아님)도 다크 바탕에서 보이도록 1px 선을 둔다(리뷰 M2).
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surfacePressed,
    },
    image: {width: PREVIEW_SIZE, height: PREVIEW_SIZE},
    caption: {flex: 1, fontSize: font.meta, lineHeight: line.label, color: color.textMuted},
  });

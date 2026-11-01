import {AVATAR_SHAPE} from '@momo/core/features/workspace/avatar';
import type {Directory} from '@momo/core/features/workspace/directory';
import {
  THREAD_FACE_OVERLAP,
  THREAD_FACE_RING,
  THREAD_FACE_SIZE,
  threadSummary,
  threadSummaryCopy,
  type ThreadSummary,
  type ThreadSummaryCopy,
} from '@momo/core/features/timeline/threadSummary';
import type {ThreadRollup} from '@momo/core/lib/api';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {Avatar, useAvatarSource} from './Avatar';

// =============================================================================
// 메시지 아래 스레드 요약 줄 — 폰 (#4878, owner 10-31, Buzz식).
//
//   [겹친 얼굴 ≤3]  답글 N개  [새 답글 M]
//
// 무엇을 보일지(얼굴 상한·칩 조건·문구)는 코어 `threadSummary`가 정하고, 웹·데스크탑이 같은 값을 받는다. 이 파일은
// 그리기만 한다. 줄 전체를 누르는 `Pressable`(스레드 열기, 긴 눌림 소비, 요청 카드의 다른 목적지)은 `MessageRow`가
// 갖고 이 파일은 그 안쪽 내용이다 — 행은 접근성 원소 하나(`accessible`)라 이 줄의 낭독은 행 라벨의 꼬리 조각
// (`copy.spoken`)와 누르는 라벨(`copy.open`)로 나간다.
//
// 얼굴은 행 아바타와 **같은 `Avatar`**다: 에이전트는 둥근 사각, 명부에서 못 푸는 id는 「모른다」 표지. 한 변 22 · 겹침 6 ·
// 바탕색 링 2는 코어의 규격 숫자다(`THREAD_FACE_*`). 링은 RN에 박스 그림자 고리가 없어서(안드로이드) 바탕색 래퍼 상자가
// 맡는다: 래퍼는 얼굴보다 링 두께만큼 사방으로 크고 모양(원/둥근 사각)을 따른다.
// 「마지막 답글 X 전」은 owner가 뺐다(10-31 23:49).
// =============================================================================

export interface ThreadSummaryView {
  summary: ThreadSummary;
  copy: ThreadSummaryCopy;
}

/** 롤업 → 요약 값과 문구. 롤업이 없으면 `null`. 훅이라 조건 없이 부른다. */
export function useThreadSummaryView(rollup: ThreadRollup | null): ThreadSummaryView | null {
  const formatMessage = useFormatMessage();
  if (rollup === null) return null;
  const summary = threadSummary(rollup);
  return {summary, copy: threadSummaryCopy(summary, formatMessage)};
}

/** 래퍼 한 변 = 얼굴 + 사방 링. */
const FACE_BOX = THREAD_FACE_SIZE.phone + 2 * THREAD_FACE_RING;
/** 에이전트 둥근 사각의 반경: 한 변의 1/4 (큰 얼굴과 같은 비율, `Avatar.squareRadius`). */
const FACE_SQUARE_RADIUS = Math.round(THREAD_FACE_SIZE.phone / 4);

function ThreadFace({
  directory,
  memberId,
  overlapped,
}: {
  directory: Directory;
  memberId: string;
  overlapped: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {identity} = useAvatarSource(directory, memberId);
  // 사람의 모양(원)과 같으면 원, 아니면(에이전트) 둥근 사각이다 — 코어의 모양 표(`AVATAR_SHAPE`)가 답한다.
  const round = AVATAR_SHAPE[identity.kind] === AVATAR_SHAPE.human;
  return (
    <View
      style={[styles.faceRing, round ? styles.faceRingRound : styles.faceRingSquare, overlapped && styles.faceOverlap]}
      testID="thread-face">
      <Avatar
        directory={directory}
        memberId={memberId}
        size={THREAD_FACE_SIZE.phone}
        squareRadius={FACE_SQUARE_RADIUS}
      />
    </View>
  );
}

export function ThreadSummaryContent({
  view,
  directory,
  suffix,
}: {
  view: ThreadSummaryView;
  directory: Directory;
  /** 「답글 N개」 뒤에 붙는 글(요청 카드 행의 진행 문장). 시간 문구가 아니다. */
  suffix?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {summary, copy} = view;
  return (
    <View style={styles.line}>
      {summary.faces.length > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.faces}
          testID="thread-faces">
          {summary.faces.map((id, index) => (
            <ThreadFace key={id.toLowerCase()} directory={directory} memberId={id} overlapped={index > 0} />
          ))}
        </View>
      ) : null}
      <Text
        numberOfLines={1}
        style={[styles.count, summary.hasUnread ? styles.countUnread : styles.countRead]}
        testID="thread-count">
        {suffix === undefined ? copy.count : `${copy.count}${suffix}`}
      </Text>
      {copy.unreadChip !== null ? (
        <View style={styles.chip} testID="thread-unread-chip">
          <Text style={styles.chipText}>{copy.unreadChip}</Text>
        </View>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    line: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    // 첫 얼굴의 링이 왼쪽으로 새는 만큼 당겨, 얼굴의 왼쪽 가장자리가 본문 줄의 왼쪽과 같은 x에 선다.
    faces: {flexDirection: 'row', alignItems: 'center', marginLeft: -THREAD_FACE_RING},
    faceRing: {
      width: FACE_BOX,
      height: FACE_BOX,
      padding: THREAD_FACE_RING,
      // 링의 색은 대화 바닥이다(행은 `Screen` 바닥 위에 선다).
      backgroundColor: color.bg,
    },
    faceRingRound: {borderRadius: FACE_BOX / 2},
    faceRingSquare: {borderRadius: FACE_SQUARE_RADIUS + THREAD_FACE_RING},
    // 얼굴끼리 6 겹친다: 래퍼는 사방 링만큼 크므로 링 두 겹(양쪽)을 더해 당긴다.
    faceOverlap: {marginLeft: -(THREAD_FACE_OVERLAP + 2 * THREAD_FACE_RING)},
    count: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600', flexShrink: 1},
    countRead: {color: color.text},
    // 안 읽은 답글이 있으면 글이 신호색이다(호박은 신호에만).
    countUnread: {color: color.accentText},
    chip: {backgroundColor: color.accent, borderRadius: radius.pill, paddingHorizontal: space.sm},
    chipText: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600', color: color.onAccent},
  });

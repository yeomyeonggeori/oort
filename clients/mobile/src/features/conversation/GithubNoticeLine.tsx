import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  githubNoticeFor,
  githubNoticeLabel,
  type GithubNotice,
} from '@momo/core/features/github/model';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {openLink} from './MessageBody';

// =============================================================================
// GitHub 알림 메시지의 아랫줄 — 폰 (ADR-0205 D4·D10, #3955). 웹의 `GithubNoticeStrip` 과 같은
// 코어 판정(`githubNoticeFor`)이다: 작성자 id가 서버가 적은 `github_author_member_id` 와 다르면 줄이 서지 않는다.
//
// 본문은 서버가 쓴 문장 그대로다. 이 줄은 「GitHub 알림」 칩과 소식, 열 곳만 덧붙인다.
// 행은 접근성 원소 하나라(`MessageRow` 의 `accessible` 뿌리) 줄의 글은 행의 낭독 라벨로
// (`githubNoticeLabel`) 읽히고, 열기는 로터 행동(`GITHUB_NOTICE_ACTION_NAME`)으로 닿는다.
// 손가락은 줄의 링크를 누른다. 여는 문은 본문 링크와 같은 `openLink`(코어 `safeHref` 재확인).
// =============================================================================

export const GITHUB_NOTICE_ACTION_NAME = 'momoGithubOpen';
export const GITHUB_NOTICE_OPEN_LABEL = 'GitHub에서 열기';

export {githubNoticeFor, githubNoticeLabel};

export function GithubNoticeLine({notice}: {notice: GithubNotice}): React.JSX.Element {
  const styles = useStyles(build);
  const what =
    notice.actionLabel === null ? notice.eventLabel : `${notice.eventLabel} ${notice.actionLabel}`;
  const url = notice.url;
  return (
    <View style={styles.wrap} testID="github-notice">
      <View style={styles.chip}>
        <Text style={styles.chipLabel} numberOfLines={1}>
          GitHub 알림
        </Text>
      </View>
      <Text style={styles.meta} testID="github-notice-what">
        {what}
      </Text>
      {url !== null ? (
        <Pressable
          onPress={() => openLink(url)}
          hitSlop={space.sm}
          accessibilityRole="link"
          testID="github-notice-open"
          style={({pressed}) => [styles.open, pressed && styles.pressed]}>
          <Text style={styles.link}>{GITHUB_NOTICE_OPEN_LABEL}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {
      marginTop: space.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.sm,
    },
    chip: {
      flexShrink: 1,
      maxWidth: '100%',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
      backgroundColor: color.surfaceMuted,
    },
    chipLabel: {
      fontSize: font.caption,
      lineHeight: line.caption,
      fontWeight: '600',
      color: color.textMuted,
    },
    meta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    open: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    link: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.accentText,
      textDecorationLine: 'underline',
    },
    pressed: {opacity: 0.6},
  });
}

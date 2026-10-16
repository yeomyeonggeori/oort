import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  TEAM_AI_SOURCES_LABEL,
  type TeamAiReplyMeta as Meta,
} from '@momo/core/features/timeline/teamAiReply';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {openLink} from './MessageBody';

// =============================================================================
// 도우미 답 아래의 꼬리 — 폰 (ADR-0201 증보 v2 H4·H5·H9-I9, #3893).
//
// 판정과 문구는 웹과 같은 코어(`teamAiReply.ts`)다. 렌더만 폰 고유다.
//
// 행은 접근성 원소 하나라(`MessageRow` 의 `accessible` 뿌리) 이 꼬리의 글과 출처 링크에
// VoiceOver 가 따로 닿지 않는다. 그래서 글은 `teamAiReplySpoken` 으로 행의 낭독 라벨에
// 붙고, 출처는 행이 로터 행동(`TEAM_AI_CITATION_ACTION_PREFIX`)으로 연다. 손가락은 이
// 꼬리의 링크를 직접 누른다. 여는 문은 본문 링크와 같은 `openLink`(코어 `safeHref` 재확인).
// =============================================================================

/** 로터 행동 이름의 앞머리. 순서로 짓는다(주소를 행동 이름에 싣지 않는다). */
export const TEAM_AI_CITATION_ACTION_PREFIX = 'momoCitation:';

export function TeamAiReplyMeta({meta}: {meta: Meta}): React.JSX.Element {
  const styles = useStyles(build);
  return (
    <View style={styles.wrap} testID="team-ai-reply-meta">
      {meta.toolsLine !== null || meta.modelChip !== null ? (
        <View style={styles.topLine}>
          {meta.toolsLine !== null ? (
            <Sentence style={styles.meta} testID="team-ai-tools-line">
              {meta.toolsLine}
            </Sentence>
          ) : null}
          {meta.modelChip !== null ? (
            <View style={styles.chip} testID="team-ai-model-chip">
              <Text style={styles.chipLabel} numberOfLines={1}>
                {meta.modelChip}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {meta.citations.length > 0 ? (
        <View style={styles.sources} testID="team-ai-citations">
          <Text style={styles.meta}>{TEAM_AI_SOURCES_LABEL}</Text>
          {meta.citations.map((item, index) => (
            <Pressable
              key={item.url}
              onPress={() => openLink(item.url)}
              hitSlop={space.sm}
              testID="team-ai-citation"
              style={({pressed}) => [styles.source, pressed && styles.pressed]}>
              <Text style={styles.sourceIndex}>{index + 1}</Text>
              <Text style={styles.sourceTitle} numberOfLines={1}>
                {item.title}
              </Text>
              {item.title !== item.host ? (
                <Text style={styles.sourceHost} numberOfLines={1}>
                  {item.host}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** 행의 낭독 라벨 뒤에 붙일 꼬리 문장. 보인 것과 같은 사실을 같은 순서로(접은 줄은 펴서). */
export function teamAiReplySpoken(meta: Meta | null): string[] {
  if (meta === null) return [];
  const parts: string[] = [];
  if (meta.toolsSpoken !== null) parts.push(meta.toolsSpoken);
  if (meta.modelChip !== null) parts.push(meta.modelChip);
  if (meta.citations.length > 0) {
    parts.push(`${TEAM_AI_SOURCES_LABEL} ${meta.citations.length}개`);
  }
  return parts;
}

/** 로터에 세울 출처 열기 행동들. */
export function teamAiCitationActions(
  meta: Meta | null,
): {name: string; label: string}[] {
  if (meta === null) return [];
  return meta.citations.map((item, index) => ({
    name: `${TEAM_AI_CITATION_ACTION_PREFIX}${index}`,
    label: `${TEAM_AI_SOURCES_LABEL} ${index + 1} 열기, ${item.title}`,
  }));
}

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {marginTop: space.xs, gap: space.xs},
    topLine: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.sm,
    },
    meta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    chip: {
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
    sources: {gap: space.xs},
    source: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
    },
    sourceIndex: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    sourceTitle: {
      flexShrink: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.accentText,
      textDecorationLine: 'underline',
    },
    sourceHost: {
      flexShrink: 0,
      maxWidth: '40%',
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    pressed: {opacity: 0.6},
  });
}

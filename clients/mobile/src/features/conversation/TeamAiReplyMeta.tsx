import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {AppNotice} from '@momo/core/features/timeline/appNotice';
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
      {meta.appsLine !== null ? (
        <View style={styles.apps} testID="apps-used-tail">
          <Sentence style={styles.meta} testID="apps-used-line">
            {meta.appsLine}
          </Sentence>
          {meta.exposureLine !== null ? (
            <Sentence style={styles.meta} testID="apps-exposure-line">
              {meta.personalNote !== null
                ? `${meta.exposureLine} · ${meta.personalNote}`
                : meta.exposureLine}
            </Sentence>
          ) : null}
        </View>
      ) : null}
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
  if (meta.appsSpoken !== null) parts.push(meta.appsSpoken);
  if (meta.exposureLine !== null) parts.push(meta.exposureLine);
  if (meta.personalNote !== null) parts.push(meta.personalNote);
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

// ---- 막힘 문장 (plugins-v2-plan 2.5절, #3950) ----------------------------------------
//
// 한 문장과 행동 하나. 행이 접근성 원소 하나라 행동은 로터(`momoAppNotice`)로도 닿는다.
// 진행 중 안내는 흐린 글씨, 막힘은 본문색이다. 경고색·아이콘으로 소리치지 않는다.

/** 로터 행동 이름. */
export const APP_NOTICE_ACTION_NAME = 'momoAppNotice';

/** 폰의 행동은 모두 「웹에서 열기」 하나다. 열 곳을 모르면(`canAct` 거짓) 행동을 세우지 않는다. */
export function AppNoticeLine({
  notice,
  onAction,
}: {
  notice: AppNotice;
  onAction: (() => void) | null;
}): React.JSX.Element {
  const styles = useStyles(build);
  return (
    <View style={styles.notice} testID="app-notice">
      <Sentence
        style={notice.progress ? styles.meta : styles.noticeText}
        testID="app-notice-sentence">
        {notice.sentence}
      </Sentence>
      {notice.action !== null && onAction !== null ? (
        <Pressable
          onPress={onAction}
          hitSlop={space.sm}
          accessibilityRole="link"
          testID="app-notice-action"
          style={({pressed}) => [styles.noticeAction, pressed && styles.pressed]}>
          <Text style={styles.sourceTitle}>{notice.action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 행의 낭독에 붙일 막힘 문장. */
export function appNoticeSpoken(notice: AppNotice | null): string[] {
  return notice === null ? [] : [notice.sentence];
}

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {marginTop: space.xs, gap: space.xs},
    apps: {gap: 0},
    notice: {marginTop: space.xs, gap: space.xs},
    noticeText: {fontSize: font.meta, lineHeight: line.meta, color: color.text},
    noticeAction: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    topLine: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.sm,
    },
    meta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    // 큰 글자에서 칩이 행 밖으로 넘치지 않게: 줄어들 수 있고 행 폭을 넘지 않는다.
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

import React, {useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {useQuery} from '@tanstack/react-query';
import {fetchProviderLink} from '@momo/core/features/settings/api';
import {
  COMMAND_SUGGEST_PHONE_FOOT,
  COMMAND_SUGGEST_PHONE_MINE,
  COMMAND_SUGGEST_TEAM_CLOSE,
  COMMAND_SUGGEST_TEAM_OPEN,
  commandSuggestHead,
  commandSuggestOneLine,
  commandSuggestViewer,
  type CommandSuggestCard,
} from '@momo/core/features/timeline/commandSuggest';
import {font, line, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {
  AI_CONNECT_ICON_SIZE,
  AI_CONNECT_ICONS,
  HOME_ICONS,
} from '../../design/icons';
import {AiConnectTeamSection, TEAM_QUERY_KEY} from '../aiConnect/AiConnectCard';
import {CONV} from './convDesign';

// =============================================================================
// 에이전트가 제안한 AI 연결 카드 — 폰 (#2948 GC-7, ADR-0186 증보 G4, 시안 폰 ③).
//
// 폰은 **읽기 + (운영자면) 팀 연결 확인**만 한다(Q5). 구독 로그인과 키 입력은
// 맥에서 한다(#2816 결재). 그래서 대상 본인의 카드에도 로그인·키 칸이 없다.
//
// 판정은 웹과 같다: 보는 사람 분기는 코어 `commandSuggestViewer`, 팀 줄 알약은
// 코어 `linkPill`, 운영자 판정은 기존 provider_link 응답(200 운영자, 403 아님).
// 렌더만 폰 고유다(RN은 웹 부품을 쓸 수 없다). 쿼리 키는 웹과 글자까지 같다.
//
// props에서 상태를 읽지 않는다(G3): 이 파일에는 props를 읽는 코드가 없고, 모델은
// 코어가 준 의도(`focus`·대상·에이전트 이름)뿐이다.
//
// 「내 계정」 절은 A 레인 host 보고(#2781·#2782) 전이라 상태 줄 없이 「맥에서」
// 한 줄이다(brief §3.6). 「팀 연결」 절은 GC-4(#2945) 폰 로컬 카드의
// `AiConnectTeamSection` 한 벌을 그대로 쓴다 — 팀 줄의 요청·알약·확인·결과 판정이
// 폰에 두 벌 있지 않게(#2945 에서 합침).
// =============================================================================

const OPERATOR_STALE_MS = 60_000;

export function AiConnectSuggestion({
  card,
  viewerMemberId,
  offline,
}: {
  card: CommandSuggestCard;
  viewerMemberId: string | undefined;
  offline: boolean;
}): React.JSX.Element {
  const isTarget =
    commandSuggestViewer(card, viewerMemberId, false) === 'target';
  const operatorQuery = useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: fetchProviderLink,
    retry: false,
    staleTime: OPERATOR_STALE_MS,
    // 403(비운영자)은 데이터 없이 남는다. 목록이 행을 다시 세울 때마다 다시 묻지 않는다(웹과 같다).
    retryOnMount: false,
    enabled: card.shape === 'ok' && !isTarget,
  });
  const viewer = commandSuggestViewer(
    card,
    viewerMemberId,
    operatorQuery.isSuccess,
  );
  if (viewer === 'target') {
    return <SuggestedCard card={card} offline={offline} />;
  }
  return (
    <SuggestionLine
      card={card}
      operator={viewer === 'operator'}
      offline={offline}
    />
  );
}

function SuggestionLine({
  card,
  operator,
  offline,
}: {
  card: CommandSuggestCard;
  operator: boolean;
  offline: boolean;
}): React.JSX.Element {
  const styles = useStyles(build);
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View
      style={styles.wrap}
      testID={operator ? 'ai-suggest-operator' : 'ai-suggest-other'}>
      <View style={styles.oneline} testID="ai-suggest-line">
        <Image
          source={AI_CONNECT_ICONS.plug}
          style={[styles.icon, {tintColor: palette.icon}]}
          accessibilityIgnoresInvertColors
        />
        <Text style={styles.onelineText} lineBreakStrategyIOS="hangul-word">
          {commandSuggestOneLine(card)}
        </Text>
        {operator ? (
          <Pressable
            onPress={() => setOpen(value => !value)}
            accessibilityRole="button"
            accessibilityState={{expanded: open}}
            hitSlop={slopTo(line.meta)}
            testID="ai-suggest-team-open"
            style={({pressed}) => [pressed && styles.pressed]}>
            <Text style={styles.onelineLink}>
              {open ? COMMAND_SUGGEST_TEAM_CLOSE : COMMAND_SUGGEST_TEAM_OPEN}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {operator && open ? (
        <View style={styles.card} testID="ai-suggest-team-panel">
          <AiConnectTeamSection
            offline={offline}
            idPrefix="ai-suggest"
            sectionStyle={styles.section}
            headStyle={styles.sectionHead}
          />
        </View>
      ) : null}
    </View>
  );
}

function SuggestedCard({
  card,
  offline,
}: {
  card: CommandSuggestCard;
  offline: boolean;
}): React.JSX.Element {
  const styles = useStyles(build);
  const palette = usePalette();
  const focus = card.focus;
  const showMine =
    focus === null || focus === 'mine' || focus === 'claude' || focus === 'codex';
  const showTeam = focus === null || focus === 'team';
  const initial = [...card.agentName.trim()][0]?.toUpperCase() ?? '';
  return (
    <View style={[styles.wrap, styles.card]} testID="ai-suggest-target">
      <View style={styles.head}>
        <View style={styles.agentMark}>
          <Text style={styles.agentMarkText}>{initial}</Text>
        </View>
        {/* 글자 배수 상한은 두지 않는다(#2988, R6 M2 판단): 이 머리는 대화 목록 안에서
            함께 스크롤하는 정보 글이라 자판 위 높이 예산(로컬 카드 머리의 1.3)이 걸리지
            않는다. 큰 글씨에서는 두 줄로 접히되 낱말 경계에서 접는다(「제안했어/요」 방지). */}
        <Text
          style={styles.headText}
          numberOfLines={2}
          lineBreakStrategyIOS="hangul-word"
          accessibilityRole="header">
          {commandSuggestHead(card)}
        </Text>
      </View>
      {showMine ? (
        <View style={styles.section} testID="ai-suggest-mine">
          <Text style={styles.sectionHead}>내 계정 · 맥</Text>
          <View style={styles.note}>
            <Image
              source={AI_CONNECT_ICONS.laptop}
              style={[styles.icon, styles.noteIcon, {tintColor: palette.icon}]}
              accessibilityIgnoresInvertColors
            />
            <Sentence style={styles.noteText}>{COMMAND_SUGGEST_PHONE_MINE}</Sentence>
          </View>
        </View>
      ) : null}
      {showTeam ? (
        <AiConnectTeamSection
          offline={offline}
          idPrefix="ai-suggest"
          sectionStyle={styles.section}
          headStyle={styles.sectionHead}
        />
      ) : null}
      {showTeam ? (
        <View style={styles.foot}>
          <Image
            source={HOME_ICONS.lock}
            style={[styles.footIcon, {tintColor: palette.icon}]}
            accessibilityIgnoresInvertColors
          />
          <Text style={styles.footText} lineBreakStrategyIOS="hangul-word">
            {COMMAND_SUGGEST_PHONE_FOOT}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 이 카드의 치수 — 시안 `claudedocs/chat-genui-connect/mockups.html` ③·폰 값 그대로.
 * 값마다 시안 CSS 원문을 옆에 적는다(`convDesign.ts`의 `CONV`와 같은 규율: 스타일시트에
 * 숫자를 흩지 않고 한 자리에서 출처를 읽게 한다).
 */
const AI_SUGGEST = {
  /** 폰 `.ag{width:20px;height:20px;font-size:10px;border-radius:28%}`. */
  agentMark: 20,
  agentMarkText: 10,
  agentMarkRadius: 5.6,
  /** `.chd{padding:10px 14px}`. */
  headPadY: 10,
  /** `.csec{padding:6px 14px 4px}` · `.csh{padding:6px 0 4px}`. */
  sectionPadTop: 6,
  /** `.pnote .ic{margin-top:1px}`. */
  noteIconNudge: 1,
  /** `.oneline{padding:7px 10px;border-radius:10px}`. */
  onelinePadY: 7,
  onelinePadX: 10,
  onelineRadius: 10,
  /** `.csh .lock .ic{width:12px}` — 발의 자물쇠. */
  footIcon: 12,
} as const;

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {marginTop: space.sm},
    /** 시안 `.ccard`(실선, 반경 20, surface). 제안 카드는 점선 로컬 카드가 아니다. */
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      borderRadius: CONV.cardRadius,
      backgroundColor: color.surface,
      overflow: 'hidden',
      boxShadow: color.elevationRest,
    },
    /** 시안 `.chd{padding:10px 14px;border-bottom}`. */
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: AI_SUGGEST.headPadY,
      paddingHorizontal: CONV.cardPad,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    agentMark: {
      width: AI_SUGGEST.agentMark,
      height: AI_SUGGEST.agentMark,
      borderRadius: AI_SUGGEST.agentMarkRadius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.agentSurface,
    },
    agentMarkText: {fontSize: AI_SUGGEST.agentMarkText, fontWeight: '700', color: color.agent},
    /** 시안 `.chd .by{font-size:12.5px;color:var(--agent);font-weight:600}`. */
    headText: {flexShrink: 1, fontSize: font.meta, fontWeight: '600', color: color.agent},
    /** 시안 `.csec{padding:6px 14px 4px}`. */
    section: {paddingHorizontal: CONV.cardPad, paddingTop: AI_SUGGEST.sectionPadTop, paddingBottom: space.xs},
    /** 시안 `.csh{font-size:12px;font-weight:700;color:var(--ink2);padding:6px 0 4px}`. */
    sectionHead: {
      fontSize: font.meta,
      fontWeight: '700',
      color: color.textMuted,
      paddingTop: AI_SUGGEST.sectionPadTop,
      paddingBottom: space.xs,
    },
    /** 시안 `.pnote{gap:8px;padding:8px 0 4px;font-size:12px}`. */
    note: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingTop: space.sm, paddingBottom: space.xs},
    noteIcon: {marginTop: AI_SUGGEST.noteIconNudge},
    noteText: {flexShrink: 1, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    icon: {width: AI_CONNECT_ICON_SIZE, height: AI_CONNECT_ICON_SIZE},
    pressed: {opacity: 0.6},
    /** 시안 `.cft`: 카드 발, 자물쇠 + 한 줄. */
    foot: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
      paddingHorizontal: CONV.cardPad,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      backgroundColor: color.sheet,
    },
    footIcon: {width: AI_SUGGEST.footIcon, height: AI_SUGGEST.footIcon},
    footText: {flexShrink: 1, fontSize: font.meta, color: color.textMuted},
    /** 시안 `.oneline{gap:8px;padding:7px 10px;border-radius:10px;background:var(--sheet);font-size:12.5px}`. */
    oneline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: AI_SUGGEST.onelinePadY,
      paddingHorizontal: AI_SUGGEST.onelinePadX,
      borderRadius: AI_SUGGEST.onelineRadius,
      backgroundColor: color.sheet,
      minHeight: TOUCH_TARGET - space.md,
    },
    onelineText: {flex: 1, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    /** 시안 `.oneline a{color:var(--agent);font-weight:600}`. */
    onelineLink: {fontSize: font.meta, fontWeight: '600', color: color.agent},
  });
}

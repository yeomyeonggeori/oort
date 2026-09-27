import React, {useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  fetchProviderLink,
  testProviderLink,
  type ProviderLinkTest,
} from '@momo/core/features/settings/api';
import {
  isLegacyTeamLink,
  linkPill,
  type AiPillView,
} from '@momo/core/features/settings/aiLinkPill';
import {
  errorMessage,
  isOperatorDenied,
  maskedBearer,
} from '@momo/core/features/settings/model';
import {teamCheckReason} from '@momo/core/features/settings/teamKeyForm';
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
import {font, line, radius, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {usePalette, useStyles} from '../../design/theme';
import {
  AI_CONNECT_ICON_SIZE,
  AI_CONNECT_ICONS,
  HOME_ICONS,
} from '../../design/icons';
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
// 한 줄이다(brief §3.6). GC-4(#2945) 폰 로컬 카드가 이 팀 줄 부품을 이어 쓴다.
// =============================================================================

/** 웹 `TEAM_QUERY_KEY`와 같은 글자. */
const TEAM_QUERY_KEY = ['settings', 'provider-link'] as const;
const OPERATOR_STALE_MS = 60_000;
const TEAM_DENIED_LINE = '팀 키는 운영자만 바꾸고 확인할 수 있어요.';
const TEAM_EMPTY_SUB = '아직 없어요. 키는 맥·웹에서 넣어요';

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
        <Text style={styles.onelineText}>{commandSuggestOneLine(card)}</Text>
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
          <TeamSection offline={offline} />
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
        <Text
          style={styles.headText}
          numberOfLines={2}
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
            <Text style={styles.noteText}>{COMMAND_SUGGEST_PHONE_MINE}</Text>
          </View>
        </View>
      ) : null}
      {showTeam ? <TeamSection offline={offline} /> : null}
      {showTeam ? (
        <View style={styles.foot}>
          <Image
            source={HOME_ICONS.lock}
            style={[styles.footIcon, {tintColor: palette.icon}]}
            accessibilityIgnoresInvertColors
          />
          <Text style={styles.footText}>{COMMAND_SUGGEST_PHONE_FOOT}</Text>
        </View>
      ) : null}
    </View>
  );
}

function savedDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function since(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`;
}

/**
 * 팀 연결 한 줄. 알약은 코어 `linkPill`(설정·웹 카드와 같은 판정), 운영자면
 * 「연결 확인」(기존 test 라우트) 하나. 키 넣기·바꾸기는 폰에 없다(Q5).
 */
function TeamSection({offline}: {offline: boolean}): React.JSX.Element {
  const styles = useStyles(build);
  const query = useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: fetchProviderLink,
    retry: false,
  });
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const check = useMutation({
    mutationFn: testProviderLink,
    networkMode: 'always',
    onSuccess: setProbe,
  });
  const link = query.data;
  const operator = query.isSuccess;
  const denied = query.isError && isOperatorDenied(query.error);

  let body: React.ReactNode;
  if (query.isPending) {
    body = <Text style={styles.noteText}>불러오고 있어요</Text>;
  } else if (denied) {
    body = (
      <Text style={styles.noteText} testID="ai-suggest-team-denied">
        {TEAM_DENIED_LINE}
      </Text>
    );
  } else if (query.isError || !link) {
    body = (
      <View style={styles.rowActions}>
        <Text style={[styles.noteText, styles.bad]} accessibilityRole="alert">
          {`팀 연결을 불러오지 못했어요. ${errorMessage(query.error)}`}
        </Text>
        <SecondaryButton
          label="다시 불러오기"
          onPress={() => void query.refetch()}
          testID="ai-suggest-team-retry"
        />
      </View>
    );
  } else {
    const hasRow =
      link.configured || (link.keyConfigured && link.availability !== 'mock');
    const legacy = isLegacyTeamLink(link);
    const pill = linkPill({link, offline, probe, checking: check.isPending});
    const tail = link.configured
      ? `${maskedBearer(link.bearerLast4)}${
          probe
            ? ` · 마지막 확인 ${since(probe.checkedAtMs, Date.now())}`
            : link.updatedAtMs
              ? ` · ${savedDate(link.updatedAtMs)} 저장`
              : ''
        }`
      : hasRow
        ? '서버 환경값'
        : TEAM_EMPTY_SUB;
    let result: {tone: 'ok' | 'bad'; text: string} | null = null;
    if (!offline && check.isError) {
      result = {tone: 'bad', text: errorMessage(check.error)};
    } else if (!offline && probe && !check.isPending) {
      result = probe.ok
        ? {tone: 'ok', text: '응답을 확인했어요 · 방금'}
        : {tone: 'bad', text: teamCheckReason(probe.reason)};
    }
    body = (
      <View style={styles.row} testID="ai-suggest-team">
        <View style={styles.rowTop}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>
              {hasRow ? [...link.endpointLabel][0]?.toUpperCase() ?? '?' : '?'}
            </Text>
          </View>
          <View style={styles.rowName}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {hasRow
                  ? link.configured
                    ? `${link.endpointLabel} · 팀 기본`
                    : link.endpointLabel
                  : '팀 API 키'}
              </Text>
              <View style={styles.src}>
                <Text style={styles.srcText}>{legacy ? '내부용' : 'API 키'}</Text>
              </View>
            </View>
            <Text
              style={[styles.rowSub, link.configured && styles.mono]}
              numberOfLines={hasRow ? 1 : 2}>
              {tail}
            </Text>
          </View>
          <Pill view={pill} testID="ai-suggest-team-pill" />
        </View>
        {operator && hasRow && !legacy ? (
          <View style={styles.rowActions}>
            <SecondaryButton
              label={check.isPending ? '확인 중' : '연결 확인'}
              disabled={offline || check.isPending}
              onPress={() => check.mutate()}
              testID="ai-suggest-team-check"
            />
          </View>
        ) : null}
        {result ? (
          <Text
            style={[styles.noteText, result.tone === 'ok' ? styles.ok : styles.bad]}
            accessibilityLiveRegion="polite"
            testID="ai-suggest-team-result">
            {result.text}
          </Text>
        ) : null}
        {offline && operator ? (
          <Text style={styles.noteText}>
            연결이 끊겨 지금은 팀 연결을 확인할 수 없어요.
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.section} testID="ai-suggest-team-section">
      <Text style={styles.sectionHead}>팀 연결 · 이 서버</Text>
      {body}
    </View>
  );
}

function Pill({view, testID}: {view: AiPillView; testID: string}): React.JSX.Element {
  const styles = useStyles(build);
  const tone = view.tone === 'bad' ? 'danger' : view.tone;
  return (
    <View style={[styles.pill, styles[`pill_${tone}`]]} testID={testID}>
      <Text style={[styles.pillText, styles[`pillText_${tone}`]]}>{view.text}</Text>
    </View>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(build);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{disabled, busy: label === '확인 중'}}
      hitSlop={slopTo(AI_SUGGEST.buttonHeight)}
      testID={testID}
      style={({pressed}) => [
        styles.button,
        disabled && styles.buttonLocked,
        pressed && !disabled && styles.pressed,
      ]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/**
 * 이 카드의 치수 — 시안 `claudedocs/chat-genui-connect/mockups.html` ③·폰 값 그대로.
 * 값마다 시안 CSS 원문을 옆에 적는다(`convDesign.ts`의 `CONV`와 같은 규율: 스타일시트에
 * 숫자를 흩지 않고 한 자리에서 출처를 읽게 한다).
 */
const AI_SUGGEST = {
  /** `.btn{height:30px}`. 눌리는 면은 `slopTo`가 44까지 넓힌다. */
  buttonHeight: 30,
  /** `.lg{width:30px;height:30px;border-radius:9px}`. */
  logo: 30,
  logoRadius: 9,
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
  /** `.row{gap:10px}`. */
  lineGap: 10,
  /** `.nm b{gap:6px}`. */
  titleGap: 6,
  /** `.nm b{font-size:13.5px}`. */
  titleSize: 13.5,
  /** `.nm .mono{font-size:11.5px}`. */
  monoSize: 11.5,
  /** `.src{font:600 10.5px/1;padding:3px 6px;border-radius:5px}`. */
  srcSize: 10.5,
  srcPadX: 6,
  srcPadY: 3,
  srcRadius: 5,
  /** `.pill{font:600 11px/1;padding:5px 8px}`. */
  pillSize: 11,
  pillPadY: 5,
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
    ok: {color: color.ok},
    bad: {color: color.danger},
    /** 시안 `.row{padding:8px 0}`. */
    row: {paddingVertical: space.sm, gap: space.xs},
    rowTop: {flexDirection: 'row', alignItems: 'center', gap: AI_SUGGEST.lineGap},
    logo: {
      width: AI_SUGGEST.logo,
      height: AI_SUGGEST.logo,
      borderRadius: AI_SUGGEST.logoRadius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    logoText: {fontSize: font.meta, fontWeight: '800', color: color.text},
    rowName: {flex: 1, minWidth: 0},
    rowTitleLine: {flexDirection: 'row', alignItems: 'center', gap: AI_SUGGEST.titleGap},
    rowTitle: {flexShrink: 1, fontSize: AI_SUGGEST.titleSize, fontWeight: '600', color: color.text},
    rowSub: {fontSize: font.meta, color: color.textMuted},
    mono: {fontFamily: 'Menlo', fontSize: AI_SUGGEST.monoSize},
    src: {
      paddingHorizontal: AI_SUGGEST.srcPadX,
      paddingVertical: AI_SUGGEST.srcPadY,
      borderRadius: AI_SUGGEST.srcRadius,
      backgroundColor: color.surfaceMuted,
    },
    srcText: {fontSize: AI_SUGGEST.srcSize, fontWeight: '600', color: color.textMuted},
    rowActions: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, paddingLeft: AI_SUGGEST.logo + AI_SUGGEST.lineGap},
    /** 시안 `.pill{font:600 11px/1;padding:5px 8px;border-radius:999px}`. */
    pill: {paddingHorizontal: space.sm, paddingVertical: AI_SUGGEST.pillPadY, borderRadius: radius.pill},
    pill_ok: {backgroundColor: color.okSurface},
    pill_warn: {backgroundColor: color.warnSurface},
    pill_danger: {backgroundColor: color.dangerSurface},
    pill_mute: {backgroundColor: color.surfaceMuted},
    pill_run: {backgroundColor: color.agentSurface},
    pillText: {fontSize: AI_SUGGEST.pillSize, fontWeight: '600'},
    pillText_ok: {color: color.ok},
    pillText_warn: {color: color.warn},
    pillText_danger: {color: color.danger},
    pillText_mute: {color: color.textMuted},
    pillText_run: {color: color.agent},
    /** 시안 `.btn.sec{height:30px;padding:0 12px;border-radius:999px;border}`. */
    button: {
      height: AI_SUGGEST.buttonHeight,
      paddingHorizontal: space.md,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonLocked: {opacity: 0.5},
    buttonText: {fontSize: font.meta, fontWeight: '600', color: color.text},
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

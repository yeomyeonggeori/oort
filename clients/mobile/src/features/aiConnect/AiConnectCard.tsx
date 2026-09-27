import type {AiConnectLine} from '@momo/core/features/commands/registry';
import {
  fetchProviderLink,
  testProviderLink,
  type ProviderLink,
  type ProviderLinkTest,
} from '@momo/core/features/settings/api';
import {
  isLegacyTeamLink,
  linkPill,
  type AiPillTone,
  type AiPillView,
} from '@momo/core/features/settings/aiLinkPill';
import {
  errorMessage,
  isOperatorDenied,
  maskedBearer,
} from '@momo/core/features/settings/model';
import {teamCheckReason} from '@momo/core/features/settings/teamKeyForm';
import {useMutation, useQuery} from '@tanstack/react-query';
import React, {useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {Sentence} from '../../design/atoms';
import {CARD_ICONS} from '../../design/icons/cardIcons';
import {HOME_ICONS, SHELL_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {
  ds2Radius,
  ds2Type,
  font,
  line as lineHeight,
  radius,
  slopTo,
  space,
  type Palette,
} from '../../design/tokens';

// =============================================================================
// 폰의 AI 연결 카드 (#2945 GC-4, brief §3.6, 시안 mockups.html 「폰」 판).
//
// `/연결`이 지금 보고 있는 채널의 입력창 위에 여는 「나에게만」 카드다. 웹 카드
// (#2944)와 같은 **판정**을 쓰고 렌더는 폰 고유다(RN은 웹 부품을 쓸 수 없다):
//
//   · 팀 연결 줄의 알약은 코어 `linkPill`(#2941)이 정한다. 이 파일에 알약 판정을
//     새로 두지 않는다 — `__tests__/aiConnectCard.test.tsx`의 import 그래프 시험이
//     지킨다.
//   · 팀 연결은 설정·웹 카드와 **같은 쿼리 키**(`["settings","provider-link"]`)와
//     같은 코어 요청(`fetchProviderLink`·`testProviderLink`)을 쓴다.
//
// 폰이 하지 않는 것(Q5, #2816 결재):
//   · 구독 로그인 — 맥의 공식 CLI에서만 한다. 폰에는 호스트가 보고한 구독 상태가
//     아직 없다(#2781·#2782 뒤). 그래서 「내 계정」 절은 한 줄이다.
//   · 팀 키 입력 — 폰은 키를 받지 않는다. 운영자에게는 「연결 확인」(test 라우트)만
//     있다. 입력 칸이 없으므로 이 파일에 비밀값이 머무는 자리가 없다.
//
// 모양은 셋으로 나뉜다. 제안 카드(GC-7 #2948)가 같은 몸을 다른 머리로 쓰게 하려는
// 것이다:
//   · `AiConnectCardShell` — 테두리·머리 자리·높이 상한(로컬은 점선, 제안은 실선)
//   · `AiConnectCardBody` — 두 절과 발(판정과 행동 전부)
//   · `AiConnectCard` — 로컬 카드 = 셸 + 「AI 연결 · 나에게만 · ×」 머리 + 몸
// =============================================================================

/** 설정·웹 카드와 같은 쿼리 키. 같은 캐시를 나눈다. */
export const TEAM_QUERY_KEY = ['settings', 'provider-link'] as const;

/**
 * 폰 카드의 문장. 웹 카드(`clients/web/src/features/chat/AiConnectCard.tsx`)에도
 * 같은 뜻의 상수가 있지만 클라이언트끼리 import 할 수 없다
 * (`__tests__/projectShape.test.ts`). 코어로 옮기는 일은 후속으로 남긴다.
 */
export const AI_CONNECT_CARD_COPY = {
  title: 'AI 연결',
  onlyMe: '나에게만',
  close: 'AI 연결 카드 닫기',
  mineHead: '내 계정 · 맥',
  /**
   * 시안은 「이 폰에서는 상태만 봐요」다. 호스트가 보고한 구독 상태(#2781·#2782)가
   * 아직 폰에 오지 않으므로, 보여 주지 않는 상태를 약속하지 않는다(brief §3.6
   * 「그 전에는 절 자체를 『맥에서 확인』 한 줄로」).
   */
  mineLine: '구독 로그인과 상태 확인은 맥에서 해요.',
  teamHead: '팀 연결 · 이 서버',
  teamLoading: '팀 연결을 불러오는 중이에요.',
  teamDenied: '팀 키는 운영자만 바꾸고 확인할 수 있어요.',
  teamLoadFailed: '팀 연결을 불러오지 못했어요.',
  teamReload: '다시 불러오기',
  teamEmptyName: '팀 API 키',
  teamEmptySub: '아직 없어요. 팀 에이전트가 대답하려면 키가 필요해요',
  teamEnvSub: '서버 환경값',
  source: 'API 키',
  legacySource: '내부용',
  check: '연결 확인',
  checking: '확인 중',
  checkedOk: '응답을 확인했어요',
  /** 확인 실패 뒤: 폰에는 「키 바꾸기」가 없으므로 어디서 바꾸는지를 말한다. */
  changeOnMac: '키는 맥·웹에서 바꿀 수 있어요.',
  offline: '연결이 끊겨 지금은 팀 연결을 확인할 수 없어요.',
  lastReceived: '마지막으로 받은 값',
  foot: '키 입력은 맥·웹에서 해요',
} as const;

type ResultTone = 'ok' | 'bad';

interface RowResult {
  tone: ResultTone;
  text: string;
}

/** 결과 줄의 때: 1분 안이면 「방금」(brief §6), 아니면 「15:42」. */
function since(ms: number, now: number = Date.now()): string {
  if (now - ms < 60_000) return '방금';
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function markFor(label: string): string {
  const first = label.trim().charAt(0);
  return first === '' ? '?' : first.toUpperCase();
}

// ---- 셸 ----------------------------------------------------------------------

/**
 * 카드의 그릇. 머리는 부르는 쪽이 넣는다.
 *
 * - `local`: 점선 테두리(시안 `.ccard.local`) — 메시지가 아니라 이 화면의 도구 창.
 * - `suggest`: 실선 — 에이전트 메시지 안에 붙는 제안 카드(GC-7).
 *
 * 몸은 창 높이의 절반 안에서 스크롤한다. 큰 글씨에서 카드가 대화를 다 덮지 않게.
 */
export function AiConnectCardShell({
  variant,
  header,
  children,
  testID,
}: {
  variant: 'local' | 'suggest';
  header: React.ReactNode;
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {height} = useWindowDimensions();
  return (
    <View
      style={[styles.card, variant === 'local' && styles.cardLocal]}
      testID={testID}>
      {header}
      <ScrollView
        style={{maxHeight: Math.round(height * 0.45)}}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator>
        {children}
      </ScrollView>
    </View>
  );
}

// ---- 로컬 카드 -----------------------------------------------------------------

export function AiConnectCard({
  line,
  offline,
  onClose,
}: {
  line: AiConnectLine | null;
  offline: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const header = (
    <View style={styles.head}>
      <Image
        source={CARD_ICONS.plug}
        style={[styles.icon16, {tintColor: palette.icon}]}
        accessibilityIgnoresInvertColors
      />
      <Text style={styles.headTitle} accessibilityRole="header">
        {AI_CONNECT_CARD_COPY.title}
      </Text>
      <View style={styles.onlyChip} testID="ai-connect-card-only-me">
        <Image
          source={CARD_ICONS.eye}
          style={[styles.icon13, {tintColor: palette.textMuted}]}
          accessibilityIgnoresInvertColors
        />
        <Text style={styles.onlyText} numberOfLines={1}>
          {AI_CONNECT_CARD_COPY.onlyMe}
        </Text>
      </View>
      <View style={styles.flex} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={AI_CONNECT_CARD_COPY.close}
        onPress={onClose}
        hitSlop={slopTo(CLOSE_BOX)}
        style={({pressed}) => [styles.close, pressed && styles.pressed]}
        testID="ai-connect-card-close">
        <Image
          source={SHELL_ICONS.x}
          style={[styles.icon16, {tintColor: palette.textMuted}]}
          accessibilityIgnoresInvertColors
        />
      </Pressable>
    </View>
  );
  return (
    <View style={styles.wrap}>
      <AiConnectCardShell
        variant="local"
        header={header}
        testID="ai-connect-card">
        <AiConnectCardBody line={line} offline={offline} />
      </AiConnectCardShell>
    </View>
  );
}

// ---- 몸 ------------------------------------------------------------------------

/**
 * 두 절과 발. `line`은 `/연결 claude`·`/연결 팀키`가 싣는 의도다 — 웹과 같은
 * 규칙으로 그 절만 보인다(`null`이면 둘 다).
 */
export function AiConnectCardBody({
  line,
  offline,
}: {
  line: AiConnectLine | null;
  offline: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const showMine = line === null || line === 'claude' || line === 'codex';
  const showTeam = line === null || line === 'team';
  return (
    <View testID="ai-connect-card-body">
      {showMine ? (
        <View style={styles.section} testID="ai-connect-card-mine">
          <Text style={styles.sectionHead} accessibilityRole="header">
            {AI_CONNECT_CARD_COPY.mineHead}
          </Text>
          <View style={styles.note}>
            <View style={styles.noteIconBox}>
              <Image
                source={CARD_ICONS.laptop}
                style={[styles.icon14, {tintColor: palette.icon}]}
                accessibilityIgnoresInvertColors
              />
            </View>
            <Sentence style={styles.noteText}>
              {AI_CONNECT_CARD_COPY.mineLine}
            </Sentence>
          </View>
        </View>
      ) : null}
      {showTeam ? <TeamSection offline={offline} /> : null}
      <View style={styles.foot}>
        <Image
          source={HOME_ICONS.lock}
          style={[styles.icon13, {tintColor: palette.icon}]}
          accessibilityIgnoresInvertColors
        />
        <Sentence style={styles.footText}>{AI_CONNECT_CARD_COPY.foot}</Sentence>
      </View>
    </View>
  );
}

function TeamSection({offline}: {offline: boolean}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const query = useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: fetchProviderLink,
    retry: false,
  });
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const check = useMutation({
    mutationFn: testProviderLink,
    onSuccess: setProbe,
  });

  const link = query.data;
  // 이 GET은 운영자 라우트다(F9). 읽혔으면 운영자이고, 403이면 아니다.
  const operator = query.isSuccess;
  const denied = query.isError && isOperatorDenied(query.error);

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <View style={styles.inline} testID="ai-connect-card-team-loading">
        <ActivityIndicator size="small" />
        <Sentence style={styles.noteText}>
          {AI_CONNECT_CARD_COPY.teamLoading}
        </Sentence>
      </View>
    );
  } else if (denied) {
    body = <DeniedLine />;
  } else if (query.isError) {
    body = (
      <View style={styles.errorBox} testID="ai-connect-card-team-error">
        <Sentence style={styles.errorText} accessibilityRole="alert">
          {`${AI_CONNECT_CARD_COPY.teamLoadFailed} ${errorMessage(query.error)}`}
        </Sentence>
        <SecondaryButton
          label={AI_CONNECT_CARD_COPY.teamReload}
          onPress={() => void query.refetch()}
          testID="ai-connect-card-team-reload"
        />
      </View>
    );
  } else if (link) {
    body = (
      <TeamRow
        link={link}
        offline={offline}
        operator={operator}
        probe={probe}
        checking={check.isPending}
        checkError={check.isError ? check.error : null}
        onCheck={() => check.mutate()}
      />
    );
  } else {
    body = null;
  }

  return (
    <View style={styles.section} testID="ai-connect-card-team-section">
      <Text style={styles.sectionHead} accessibilityRole="header">
        {AI_CONNECT_CARD_COPY.teamHead}
      </Text>
      {body}
      {offline && operator ? (
        <Sentence style={styles.offlineNote} testID="ai-connect-card-offline">
          {AI_CONNECT_CARD_COPY.offline}
        </Sentence>
      ) : null}
    </View>
  );
}

function DeniedLine(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <View style={styles.note} testID="ai-connect-card-team-denied">
      <View style={styles.noteIconBox}>
        <Image
          source={HOME_ICONS.lock}
          style={[styles.icon13, {tintColor: palette.icon}]}
          accessibilityIgnoresInvertColors
        />
      </View>
      <Sentence style={styles.deniedText}>
        {AI_CONNECT_CARD_COPY.teamDenied}
      </Sentence>
    </View>
  );
}

function TeamRow({
  link,
  offline,
  operator,
  probe,
  checking,
  checkError,
  onCheck,
}: {
  link: ProviderLink;
  offline: boolean;
  operator: boolean;
  probe: ProviderLinkTest | null;
  checking: boolean;
  checkError: unknown;
  onCheck: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const legacy = isLegacyTeamLink(link);
  const hasRow =
    link.configured || (link.keyConfigured && link.availability !== 'mock');
  const pill = linkPill({link, offline, probe, checking});

  let result: RowResult | null = null;
  if (!offline && checkError !== null && !checking) {
    result = {tone: 'bad', text: errorMessage(checkError)};
  } else if (!offline && probe && !checking) {
    result = probe.ok
      ? {
          tone: 'ok',
          text: `${AI_CONNECT_CARD_COPY.checkedOk} · ${since(probe.checkedAtMs)}`,
        }
      : {
          tone: 'bad',
          text: `${teamCheckReason(probe.reason)} ${AI_CONNECT_CARD_COPY.changeOnMac}`,
        };
  }

  const name = hasRow
    ? link.configured
      ? `${link.endpointLabel} · 팀 기본`
      : link.endpointLabel
    : AI_CONNECT_CARD_COPY.teamEmptyName;
  let sub: string;
  if (!hasRow) sub = AI_CONNECT_CARD_COPY.teamEmptySub;
  else if (!link.configured) sub = AI_CONNECT_CARD_COPY.teamEnvSub;
  else {
    const tail = offline
      ? ` · ${AI_CONNECT_CARD_COPY.lastReceived}`
      : link.updatedAtMs
        ? ` · ${shortDate(link.updatedAtMs)} 저장`
        : '';
    sub = `${maskedBearer(link.bearerLast4)}${tail}`;
  }
  const mono = hasRow && link.configured;

  // 폰의 행동은 「연결 확인」 하나다(Q5). 키가 없거나 확인이 실패해도 「키 넣기」·
  // 「키 바꾸기」를 세우지 않는다 — 폰은 키를 받지 않는다.
  const canCheck = operator && hasRow && !legacy;
  const locked = offline || checking;

  return (
    <View style={styles.row} testID="ai-connect-card-team">
      <View style={styles.rowMain}>
        <View style={styles.mark}>
          <Text style={styles.markText}>{hasRow ? markFor(link.endpointLabel) : '?'}</Text>
        </View>
        <View style={styles.rowText}>
          <View style={styles.nameLine}>
            <Text style={styles.name} numberOfLines={2}>
              {name}
            </Text>
            <View style={styles.source}>
              <Text style={styles.sourceText} numberOfLines={1}>
                {legacy ? AI_CONNECT_CARD_COPY.legacySource : AI_CONNECT_CARD_COPY.source}
              </Text>
            </View>
          </View>
          <Text
            style={[styles.sub, mono && styles.subMono]}
            numberOfLines={hasRow ? 1 : 3}
            testID="ai-connect-card-team-sub">
            {sub}
          </Text>
        </View>
        <Pill view={pill} />
      </View>
      {canCheck ? (
        <View style={styles.rowAction}>
          <SecondaryButton
            label={checking ? AI_CONNECT_CARD_COPY.checking : AI_CONNECT_CARD_COPY.check}
            icon={checking ? null : CARD_ICONS.refresh}
            busy={checking}
            disabled={locked}
            onPress={onCheck}
            testID="ai-connect-card-team-check"
          />
        </View>
      ) : null}
      {result ? (
        <Sentence
          style={[
            styles.result,
            {color: result.tone === 'ok' ? palette.ok : palette.danger},
          ]}
          accessibilityLiveRegion="polite"
          testID="ai-connect-card-team-result">
          {result.text}
        </Sentence>
      ) : null}
    </View>
  );
}

// ---- 부품 ----------------------------------------------------------------------

const PILL_LABEL = '상태';

export function Pill({view}: {view: AiPillView}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const tone = pillColors(palette, view.tone);
  return (
    <View
      style={[styles.pill, {backgroundColor: tone.bg}]}
      accessible
      accessibilityLabel={`${PILL_LABEL} ${view.text}`}
      testID="ai-connect-card-pill">
      {view.tone === 'run' ? (
        <ActivityIndicator size="small" color={tone.fg} style={styles.pillSpin} />
      ) : (
        <View style={[styles.pillDot, {backgroundColor: tone.fg}]} />
      )}
      <Text style={[styles.pillText, {color: tone.fg}]} numberOfLines={1}>
        {view.text}
      </Text>
    </View>
  );
}

function pillColors(palette: Palette, tone: AiPillTone): {bg: string; fg: string} {
  switch (tone) {
    case 'ok':
      return {bg: palette.okSurface, fg: palette.ok};
    case 'warn':
      return {bg: palette.warnSurface, fg: palette.warn};
    case 'bad':
      return {bg: palette.dangerSurface, fg: palette.danger};
    case 'run':
      return {bg: palette.agentSurface, fg: palette.agent};
    case 'mute':
      return {bg: palette.surfaceMuted, fg: palette.textMuted};
  }
}

function SecondaryButton({
  label,
  icon = null,
  busy = false,
  disabled = false,
  onPress,
  testID,
}: {
  label: string;
  icon?: React.ComponentProps<typeof Image>['source'] | null;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled, busy}}
      onPress={disabled ? undefined : onPress}
      hitSlop={slopTo(BUTTON_HEIGHT)}
      style={({pressed}) => [
        styles.button,
        disabled && styles.buttonLocked,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}>
      {icon ? (
        <Image
          source={icon}
          style={[styles.icon14, {tintColor: palette.text}]}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <Text style={styles.buttonText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---- 스타일 --------------------------------------------------------------------

/** 시안 `.btn` 높이. 44pt 는 슬롭이 채운다(`slopTo`). */
const BUTTON_HEIGHT = 30;
/** 닫기 글리프 상자. */
const CLOSE_BOX = 24;
/** 알약 앞 점(시안 `.pill i{width:6px}`). */
const PILL_DOT = 6;
/** 줄 머리의 로고 칸(시안 `.pbody .row{grid-template-columns:28px …}`). */
const MARK_SIZE = 28;

function buildStyles(color: Palette) {
  // 값은 시안 CSS에서 가져오되 폰 스케일(`space`·`font`·`line`·`radius`)에 맞춘다 —
  // `__tests__/designSystem.test.ts`의 전수 스윕이 스케일 밖 리터럴을 막는다. 어긋난
  // 자리(10→8, 14→12 등)는 PR 「시안과의 차이」 표에 있다.
  return StyleSheet.create({
    // 시안 `.pcomp{left:12px;right:12px}` — 입력창과 같은 가장자리에 선다.
    wrap: {paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm},
    card: {
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: color.border,
      borderRadius: ds2Radius.card,
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
      overflow: 'hidden',
    },
    cardLocal: {borderStyle: 'dashed', borderColor: color.textFaint},
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
      paddingHorizontal: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    headTitle: {fontSize: ds2Type.subhead, fontWeight: '700', color: color.text},
    onlyChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surfaceMuted,
      flexShrink: 1,
    },
    onlyText: {
      fontSize: ds2Type.caption,
      lineHeight: lineHeight.head,
      fontWeight: '600',
      color: color.textMuted,
    },
    flex: {flex: 1},
    close: {
      width: CLOSE_BOX,
      height: CLOSE_BOX,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.pill,
    },
    pressed: {opacity: 0.6},
    section: {paddingTop: space.xs, paddingBottom: space.xs, paddingHorizontal: space.md},
    sectionHead: {
      fontSize: ds2Type.caption,
      fontWeight: '700',
      color: color.textMuted,
      paddingTop: space.sm,
      paddingBottom: space.xs,
    },
    note: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingTop: space.xs, paddingBottom: space.xs},
    // 글리프를 첫 줄 상자 가운데에 세운다(줄이 둘이어도 첫 줄 옆에 남는다).
    noteIconBox: {height: lineHeight.meta, justifyContent: 'center'},
    noteText: {flex: 1, fontSize: ds2Type.caption, lineHeight: lineHeight.meta, color: color.textMuted},
    deniedText: {flex: 1, fontSize: ds2Type.subhead, lineHeight: lineHeight.label, color: color.text},
    inline: {flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm},
    errorBox: {gap: space.sm, paddingVertical: space.sm, alignItems: 'flex-start'},
    errorText: {fontSize: ds2Type.caption, lineHeight: lineHeight.meta, color: color.dangerText},
    offlineNote: {fontSize: ds2Type.caption, lineHeight: lineHeight.meta, color: color.textMuted, paddingBottom: space.sm},
    row: {paddingVertical: space.sm, gap: space.sm},
    rowMain: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    mark: {
      width: MARK_SIZE,
      height: MARK_SIZE,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    markText: {fontSize: ds2Type.caption, fontWeight: '800', color: color.text},
    rowText: {flex: 1, minWidth: 0},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap'},
    name: {
      fontSize: ds2Type.subhead,
      lineHeight: lineHeight.label,
      fontWeight: '600',
      color: color.text,
      flexShrink: 1,
    },
    source: {
      paddingHorizontal: space.xs,
      borderRadius: radius.sm,
      backgroundColor: color.surfaceMuted,
    },
    sourceText: {
      fontSize: ds2Type.badge,
      lineHeight: lineHeight.head,
      fontWeight: '600',
      color: color.textMuted,
    },
    sub: {fontSize: ds2Type.caption, lineHeight: lineHeight.meta, color: color.textMuted},
    subMono: {fontFamily: 'Menlo', fontSize: font.meta},
    // 시안 `.pbody .row .btn{grid-column:2/-1}` — 버튼과 결과 줄은 이름 칸 아래에서 시작한다.
    rowAction: {paddingLeft: MARK_SIZE + space.sm, flexDirection: 'row'},
    result: {paddingLeft: MARK_SIZE + space.sm, fontSize: ds2Type.caption, lineHeight: lineHeight.meta},
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      flexShrink: 0,
    },
    pillDot: {width: PILL_DOT, height: PILL_DOT, borderRadius: radius.pill},
    pillSpin: {width: PILL_DOT, height: PILL_DOT, transform: [{scale: 0.6}]},
    pillText: {fontSize: font.meta, lineHeight: lineHeight.head, fontWeight: '600'},
    button: {
      height: BUTTON_HEIGHT,
      paddingHorizontal: space.md,
      borderRadius: ds2Radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: color.border,
      backgroundColor: color.surface,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
    },
    buttonLocked: {opacity: 0.5},
    buttonText: {fontSize: font.label, fontWeight: '600', color: color.text},
    foot: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
      paddingHorizontal: space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      backgroundColor: color.sheet,
    },
    footText: {flex: 1, fontSize: ds2Type.caption, lineHeight: lineHeight.meta, color: color.textMuted},
    icon13: {width: 13, height: 13},
    icon14: {width: 14, height: 14},
    icon16: {width: 16, height: 16},
  });
}

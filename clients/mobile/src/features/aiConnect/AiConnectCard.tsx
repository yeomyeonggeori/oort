import {
  AI_HUB_ACCOUNTS_COPY,
  AI_HUB_COPY,
  HARNESS_LABEL,
  mySubscriptionAgents,
  subscriptionAgentStatus,
  subscriptionAgentText,
  type AiHarness,
} from '@momo/core/features/ai/aiHubModel';
import {agentMembers} from '@momo/core/features/agents/hubModel';
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
import {teamCheckResult} from '@momo/core/features/settings/teamKeyForm';
import {useMutation, useQuery} from '@tanstack/react-query';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {useHostedConnections} from '../hostedAgents/queries';
import {useDirectory} from '../workspace/queries';
import {useKeyboardShown} from '../../lib/useKeyboardShown';
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
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';

// =============================================================================
// 폰의 AI 계정 카드 (#2945 GC-4, brief §3.6, 시안 mockups.html 「폰」 판).
//
// `/연결`이 지금 보고 있는 채널의 입력창 위에 여는 「나에게만」 카드다. 웹 카드
// (#2944)와 같은 **판정**을 쓰고 렌더는 폰 고유다(RN은 웹 부품을 쓸 수 없다):
//
//   · 팀 AI 키 줄의 알약은 코어 `linkPill`(#2941)이 정한다. 이 파일에 알약 판정을
//     새로 두지 않는다 — `__tests__/aiConnectCard.test.tsx`의 import 그래프 시험이
//     지킨다.
//   · 팀 AI 키는 설정·웹 카드와 **같은 쿼리 키**(`["settings","provider-link"]`)와
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
//   · `AiConnectCard` — 로컬 카드 = 셸 + 「AI 계정 · 나에게만 · ×」 머리 + 몸
//   · `AiConnectTeamSection` — 「팀 AI 키 · 이 서버」 절. 제안 카드(GC-7,
//     `conversation/AiConnectSuggestion.tsx`)도 이 절을 그대로 쓴다 — 팀 줄의
//     요청·알약·확인·결과 판정이 폰에 한 벌만 있게(#2945 에서 GC-7 과 합침).
// =============================================================================

/** 설정·웹 카드와 같은 쿼리 키. 같은 캐시를 나눈다. */
export const TEAM_QUERY_KEY = ['settings', 'provider-link'] as const;

/**
 * 폰 카드의 문장. 웹 카드(`clients/web/src/features/chat/AiConnectCard.tsx`)에도
 * 같은 뜻의 상수가 있지만 클라이언트끼리 import 할 수 없다
 * (`__tests__/projectShape.test.ts`). 코어로 옮기는 일은 후속으로 남긴다.
 */
export const AI_CONNECT_CARD_COPY = {
  title: 'AI 계정',
  onlyMe: '나에게만',
  close: 'AI 계정 카드 닫기',
  mineHead: '내 계정 · 맥',
  /**
   * 시안은 「이 폰에서는 상태만 봐요」다. 호스트가 보고한 구독 상태(#2781·#2782)가
   * 아직 폰에 오지 않으므로, 보여 주지 않는 상태를 약속하지 않는다(brief §3.6
   * 「그 전에는 절 자체를 『맥에서 확인』 한 줄로」).
   */
  mineLine: AI_HUB_COPY.phoneAccountsNotice,
  teamHead: '팀 AI 키 · 이 서버',
  teamLoading: '팀 AI 키를 불러오는 중이에요.',
  teamDenied: '팀 키는 운영자만 바꾸고 확인할 수 있어요.',
  teamLoadFailed: '팀 AI 키를 불러오지 못했어요.',
  teamReload: '다시 불러오기',
  teamEmptyName: '팀 AI 키',
  teamEmptySub: '아직 없어요. 팀 에이전트가 대답하려면 키가 필요해요',
  teamEnvSub: '서버 환경값',
  teamDefault: '팀 AI 키',
  /** 자판이 올라와 몸을 접었을 때 머리에 붙는 말(design-review #2945 H1). */
  folded: '자판을 내리고 카드 펼치기',
  source: 'API 키',
  legacySource: '내부용',
  check: '연결 확인',
  checking: '확인 중',
  checkedOk: '응답을 확인했어요',
  /** 확인 실패 뒤: 폰에는 「키 바꾸기」가 없으므로 어디서 바꾸는지를 말한다. */
  changeOnMac: '키는 맥·웹에서 바꿀 수 있어요.',
  offline: '연결이 끊겨 지금은 팀 AI 키를 확인할 수 없어요.',
  lastReceived: '마지막으로 받은 값',
  foot: '키 입력은 맥·웹에서 해요',
} as const;

/**
 * 폰 슬래시 목록에 세울 줄인가 (design-review #2945 M1).
 *
 * `/연결 claude`·`/연결 codex`는 웹에서 그 구독 줄만 펼치지만, 폰의 「내 계정」 절은
 * 한 줄(맥에서)뿐이라 두 줄이 같은 카드를 열면서 「Claude 구독 줄만 펼쳐」를
 * 약속한다. 목록에서만 뺀다 — 직접 친 `/연결 claude`는 여전히 명령이다.
 */
export function isPhoneSlashRow(row: {args: {line?: AiConnectLine}}): boolean {
  return row.args.line !== 'claude' && row.args.line !== 'codex';
}

type ResultTone = 'ok' | 'bad' | 'mute';

interface RowResult {
  tone: ResultTone;
  text: string;
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function markFor(label: string): string {
  const first = label.trim().charAt(0);
  return first === '' ? '?' : first.toUpperCase();
}

/** 글자 배수를 따라 자라는 글리프·상자 크기 (design-review #2945 H2). */
function useScaled(cap: number = GLYPH_SCALE_CAP): (size: number) => number {
  const {fontScale} = useWindowDimensions();
  const scale = Math.min(Math.max(fontScale, 1), cap);
  return (size: number) => Math.round(size * scale);
}

// ---- 셸 ----------------------------------------------------------------------

/**
 * 몸 스크롤의 끝을 보이게 하는 손잡이(#2988). 큰 글씨에서는 「연결 확인」 결과 줄이
 * 몸 창 아래에 서서, 누른 사람이 결과를 보려면 직접 끌어 올려야 했다. 결과 줄이
 * 자리를 잡으면(`onLayout`) 셸이 몸을 끝까지 내린다 — 결과 줄 뒤에는 발 한 줄뿐이다.
 * 몸이 창보다 짧으면(기본 글씨) 움직일 것이 없다. 셸 밖(제안 카드)에서는 `null`.
 */
const CardScrollRevealContext = createContext<(() => void) | null>(null);

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
  const scrollRef = useRef<ScrollView>(null);
  const revealEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({animated: true});
  }, []);
  // 자판이 올라오면 몸을 접고 머리만 남긴다 (design-review #2945 H1). iOS 의 창
  // 높이는 자판에 줄지 않으므로 높이 상한만으로는 375×667 에서 대화가 0pt 가 되고,
  // 큰 글씨에서는 머리(닫기)가 화면 밖으로 밀린다. 머리는 언제나 한 줄이다.
  const keyboardUp = useKeyboardShown(true);
  // 창 몫은 **카드 전체**의 것이다(design-review #2945 R4-H2): 큰 글씨에서 머리가
  // 두 줄이 되면 몸의 상한에서 그만큼 뺀다. 그러지 않으면 375 큰 글씨에서 카드 +
  // 입력창이 한 화면을 넘어 보내기가 밀려 나간다. 몸은 최소 두 줄 칸은 지킨다.
  const [headerHeight, setHeaderHeight] = useState(0);
  const bodyMax = Math.max(
    TOUCH_TARGET * 2,
    Math.round(height * CARD_BODY_WINDOW_SHARE) - headerHeight,
  );
  return (
    <View
      style={[styles.card, variant === 'local' && styles.cardLocal]}
      testID={testID}>
      <View
        onLayout={event => setHeaderHeight(Math.round(event.nativeEvent.layout.height))}>
        {header}
      </View>
      {keyboardUp ? (
        // 누를 수 있어야 한다(design-review #2945 R2-M1): 큰 글씨에서는 대화 목록이
        // 0pt 라 끌어서 자판을 내릴 자리가 없고, 여러 줄 입력창의 리턴은 줄바꿈이다.
        <Pressable
          accessibilityRole="button"
          onPress={() => Keyboard.dismiss()}
          style={({pressed}) => [styles.foldedRow, pressed && styles.pressed]}
          testID="ai-connect-card-folded">
          <Text style={styles.folded} maxFontSizeMultiplier={FOLDED_MAX_SCALE}>
            {AI_CONNECT_CARD_COPY.folded}
          </Text>
        </Pressable>
      ) : null}
      {/* 접혀도 몸은 **내리지 않고 숨긴다**: 내리면 「연결 확인」 결과(절의 상태)가
          자판을 한 번 올렸다 내리는 것만으로 사라지고, 팀 AI 키를 다시 불러온다. */}
      <ScrollView
        ref={scrollRef}
        style={[
          {maxHeight: bodyMax},
          keyboardUp && styles.hidden,
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        testID="ai-connect-card-scroll">
        <CardScrollRevealContext.Provider value={revealEnd}>
          {children}
        </CardScrollRevealContext.Provider>
      </ScrollView>
    </View>
  );
}

// ---- 로컬 카드 -----------------------------------------------------------------

export function AiConnectCard({
  line,
  offline,
  onClose,
  foldForKey = false,
  mine,
}: {
  line: AiConnectLine | null;
  offline: boolean;
  onClose: () => void;
  /** 내가 만든 구독으로 쓰는 에이전트를 읽을 워크스페이스와 나(AIH-4). 없으면 맥 안내 한 줄만. */
  mine?: MineAgentsScope;
  /**
   * 입력창의 키 붙여넣기 안내가 서 있다(design-review #2945 R3-B1). 그동안 카드를
   * **통째로 숨긴다**(내리지 않는다 — 절의 상태를 지킨다). 큰 글씨 SE 에서는 접힌
   * 카드 머리만으로도 안내 + 세 줄 입력창과 합쳐 한 화면을 넘어, 입력창이나 안내의
   * 첫 문장이 밀려 나간다. 안내는 입력창을 다시 누르면 거둬지고 카드가 돌아온다.
   */
  foldForKey?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 머리는 화면 막대처럼 글자 배수 상한을 둔다(design-review #2945 R5-H1): 큰 글씨
  // SE 에서 제목과 표지가 두 줄로 접히면, 자판이 오른 접힘 상태(머리 + 접힌 줄)가
  // 판 위로 넘쳐 머리·닫기가 잘린다. 상한 안에서는 한 줄로 선다.
  const scaled = useScaled(HEAD_MAX_SCALE);
  const glyph = (size: number) => ({width: scaled(size), height: scaled(size)});
  const header = (
    <View style={styles.head}>
      <Image
        source={CARD_ICONS.plug}
        style={[glyph(16), {tintColor: palette.icon}]}
        accessibilityIgnoresInvertColors
      />
      {/* 제목과 표지는 한 묶음이고 **접힌다**(design-review #2945 R2-H1): 큰 글씨에서
          「나에게만」이 잘리면 이 카드의 사생활 표지가 사라진다. 닫기는 제 칸에 남는다. */}
      <View style={styles.headTitles}>
        <Text
          style={styles.headTitle}
          accessibilityRole="header"
          maxFontSizeMultiplier={HEAD_MAX_SCALE}>
          {AI_CONNECT_CARD_COPY.title}
        </Text>
        <View style={styles.onlyChip} testID="ai-connect-card-only-me">
          <Image
            source={CARD_ICONS.eye}
            style={[glyph(13), {tintColor: palette.textMuted}]}
            accessibilityIgnoresInvertColors
          />
          <Text style={styles.onlyText} maxFontSizeMultiplier={HEAD_MAX_SCALE}>
            {AI_CONNECT_CARD_COPY.onlyMe}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={AI_CONNECT_CARD_COPY.close}
        onPress={onClose}
        hitSlop={slopTo(scaled(CLOSE_BOX))}
        style={({pressed}) => [
          styles.close,
          {width: scaled(CLOSE_BOX), height: scaled(CLOSE_BOX)},
          pressed && styles.pressed,
        ]}
        testID="ai-connect-card-close">
        <Image
          source={SHELL_ICONS.x}
          style={[glyph(16), {tintColor: palette.textMuted}]}
          accessibilityIgnoresInvertColors
        />
      </Pressable>
    </View>
  );
  return (
    <View
      style={[styles.wrap, foldForKey && styles.hidden]}
      testID="ai-connect-card-wrap">
      <AiConnectCardShell
        variant="local"
        header={header}
        testID="ai-connect-card">
        <AiConnectCardBody line={line} offline={offline} mine={mine} />
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
  mine,
}: {
  line: AiConnectLine | null;
  offline: boolean;
  mine?: MineAgentsScope;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const scaled = useScaled();
  const glyph = (size: number) => ({width: scaled(size), height: scaled(size)});
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
            <View style={[styles.noteIconBox, {height: scaled(lineHeight.meta)}]}>
              <Image
                source={CARD_ICONS.laptop}
                style={[glyph(14), {tintColor: palette.icon}]}
                accessibilityIgnoresInvertColors
              />
            </View>
            <Sentence style={styles.noteText}>
              {AI_CONNECT_CARD_COPY.mineLine}
            </Sentence>
          </View>
          {mine ? <AiConnectMineAgents scope={mine} /> : null}
        </View>
      ) : null}
      {showTeam ? <AiConnectTeamSection offline={offline} /> : null}
      <View style={styles.foot}>
        <Image
          source={HOME_ICONS.lock}
          style={[glyph(13), {tintColor: palette.icon}]}
          accessibilityIgnoresInvertColors
        />
        <Sentence style={styles.footText}>{AI_CONNECT_CARD_COPY.foot}</Sentence>
      </View>
    </View>
  );
}

export interface MineAgentsScope {
  workspaceId: string;
  /** 보는 사람의 사람 멤버 id. */
  memberId: string;
}

const MINE_HARNESSES: readonly AiHarness[] = ['claude_code', 'codex'];

/**
 * 내가 만든 구독으로 쓰는 에이전트의 서버 상태(읽기 전용, AIH-4 #3399). 웹 「내 AI 계정」과 같은
 * 코어 문장이다: Claude는 보수 모드(#3397) 동안 「문의 중」이고 부를 수 있다고 하지 않는다.
 * 못 읽으면 없다고 하지 않고 줄을 만들지 않는다.
 */
export function AiConnectMineAgents({scope}: {scope: MineAgentsScope}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const directory = useDirectory(scope.workspaceId);
  const hosted = useHostedConnections(scope.workspaceId);
  if (directory.isPending || hosted.isPending || directory.isError || hosted.isError) {
    return null;
  }
  const agents = mySubscriptionAgents(
    agentMembers(directory.directory.members),
    hosted.data,
    scope.memberId,
  );
  return (
    <View testID="ai-connect-card-mine-agents">
      <Text style={styles.sectionHead} accessibilityRole="header">
        {AI_HUB_ACCOUNTS_COPY.phone.myAgentsHead}
      </Text>
      {MINE_HARNESSES.map(harness => {
        const agent = agents.find(a => a.harness === harness) ?? null;
        const status = subscriptionAgentStatus(harness, agent !== null);
        const head = [
          HARNESS_LABEL[harness],
          subscriptionAgentText(agent?.name),
          status.chip?.text,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <View key={harness} style={styles.note} testID={`ai-connect-card-mine-${harness}`}>
            <Sentence style={styles.noteText}>
              {status.detail ? `${head}. ${status.detail}` : head}
            </Sentence>
          </View>
        );
      })}
    </View>
  );
}

/**
 * 「팀 AI 키 · 이 서버」 절 — 로컬 카드와 제안 카드(GC-7)가 함께 쓰는 한 벌.
 * `idPrefix`는 시험·캡처가 찾는 이름의 앞머리다(`<prefix>-team`, `<prefix>-team-pill` …).
 */
export function AiConnectTeamSection({
  offline,
  idPrefix = 'ai-connect-card',
  sectionStyle,
  headStyle,
}: {
  offline: boolean;
  idPrefix?: string;
  /**
   * 절의 여백은 **담는 카드가 정한다**(design-review #2945 R3-H1): 제안 카드는
   * 제 머리·내 계정 절과 같은 14pt 가장자리(`CONV.cardPad`)를 쓰고, 로컬 카드는
   * 12pt 다. 절이 제 여백을 고집하면 한 카드 안에서 두 가장자리가 생긴다.
   */
  sectionStyle?: StyleProp<ViewStyle>;
  headStyle?: StyleProp<TextStyle>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const query = useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: fetchProviderLink,
    retry: false,
  });
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const check = useMutation({
    mutationFn: testProviderLink,
    // 오프라인 잠금은 버튼이 한다. react-query 의 온라인 판정에 맡기면 누른 뒤
    // 조용히 멈춘 채 남을 수 있다(GC-7 과 같은 선택).
    networkMode: 'always',
    onSuccess: setProbe,
  });

  const link = query.data;
  // 이 GET은 운영자 라우트다(F9). 읽혔으면 운영자이고, 403이면 아니다.
  const operator = query.isSuccess;
  const denied = query.isError && isOperatorDenied(query.error);

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <View style={styles.inline} testID={`${idPrefix}-team-loading`}>
        <ActivityIndicator size="small" />
        <Sentence style={styles.noteText}>
          {AI_CONNECT_CARD_COPY.teamLoading}
        </Sentence>
      </View>
    );
  } else if (denied) {
    body = <DeniedLine testID={`${idPrefix}-team-denied`} />;
  } else if (query.isError) {
    body = (
      <View style={styles.errorBox} testID={`${idPrefix}-team-error`}>
        <Sentence style={styles.errorText} accessibilityRole="alert">
          {`${AI_CONNECT_CARD_COPY.teamLoadFailed} ${errorMessage(query.error)}`}
        </Sentence>
        <SecondaryButton
          label={AI_CONNECT_CARD_COPY.teamReload}
          onPress={() => void query.refetch()}
          testID={`${idPrefix}-team-reload`}
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
        idPrefix={idPrefix}
      />
    );
  } else {
    body = null;
  }

  return (
    <View style={sectionStyle ?? styles.section} testID={`${idPrefix}-team-section`}>
      <Text style={headStyle ?? styles.sectionHead} accessibilityRole="header">
        {AI_CONNECT_CARD_COPY.teamHead}
      </Text>
      {body}
      {offline && operator ? (
        <Sentence style={styles.offlineNote} testID={`${idPrefix}-offline`}>
          {AI_CONNECT_CARD_COPY.offline}
        </Sentence>
      ) : null}
    </View>
  );
}

function DeniedLine({testID}: {testID: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const scaled = useScaled();
  const glyph = (size: number) => ({width: scaled(size), height: scaled(size)});
  return (
    <View style={styles.note} testID={testID}>
      <View style={[styles.noteIconBox, {height: scaled(lineHeight.meta)}]}>
        <Image
          source={HOME_ICONS.lock}
          style={[glyph(13), {tintColor: palette.icon}]}
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
  idPrefix,
}: {
  link: ProviderLink;
  offline: boolean;
  operator: boolean;
  probe: ProviderLinkTest | null;
  checking: boolean;
  checkError: unknown;
  onCheck: () => void;
  idPrefix: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const scaled = useScaled(MARK_SCALE_CAP);
  const {fontScale} = useWindowDimensions();
  const stackPill = fontScale >= STACK_PILL_SCALE;
  const legacy = isLegacyTeamLink(link);
  const hasRow =
    link.configured || (link.keyConfigured && link.availability !== 'mock');
  const pill = linkPill({link, offline, probe, checking});
  const revealEnd = useContext(CardScrollRevealContext);

  let result: RowResult | null = null;
  if (!offline && checkError !== null && !checking) {
    result = {tone: 'bad', text: errorMessage(checkError)};
  } else if (!offline && probe && !checking) {
    // 문장은 코어 `teamCheckResult` — 웹 설정 곁판과 같은 판정·같은 때 표기
    // (design-review #2945 R4-M1). 폰은 키를 받지 않으므로 실패에만 「맥·웹에서」.
    const core = teamCheckResult({probe, justSaved: false, nowMs: Date.now()});
    result = {
      tone: core.tone,
      text:
        core.tone === 'bad'
          ? `${core.text} ${AI_CONNECT_CARD_COPY.changeOnMac}`
          : core.text,
    };
  }
  // iOS 에는 live region 이 없다(R4-H1): 결과가 설 때 소리로 알린다.
  const resultText = result?.text ?? null;
  useEffect(() => {
    if (resultText !== null) AccessibilityInfo.announceForAccessibility(resultText);
  }, [resultText]);

  const name = hasRow
    ? link.configured
      ? `${link.endpointLabel} · ${AI_CONNECT_CARD_COPY.teamDefault}`
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
    <View style={styles.row} testID={`${idPrefix}-team`}>
      <View style={styles.rowMain}>
        <View
          style={[styles.mark, {width: scaled(MARK_SIZE), height: scaled(MARK_SIZE)}]}>
          <Text style={styles.markText}>{hasRow ? markFor(link.endpointLabel) : '?'}</Text>
        </View>
        <View style={styles.rowText}>
          <View style={styles.nameLine}>
            <Sentence style={styles.name} numberOfLines={2}>
              {name}
            </Sentence>
            <View style={styles.source}>
              <Text style={styles.sourceText} numberOfLines={1}>
                {legacy ? AI_CONNECT_CARD_COPY.legacySource : AI_CONNECT_CARD_COPY.source}
              </Text>
            </View>
          </View>
          <Text
            style={[styles.sub, mono && styles.subMono]}
            // 한글은 낱말 경계에서만 접는다(#2988): 「11월 12일 저/장」처럼 낱말 가운데서
            // 줄이 바뀌지 않게. `Sentence`와 같은 전략이다.
            lineBreakStrategyIOS="hangul-word"
            // 두 줄까지 — 좁은 제안 카드(375)에서는 기본 글씨에서도 「11월 12일
            // 저장」이 한 줄에 들지 않는다(R4-B1). 들면 한 줄 그대로다.
            numberOfLines={hasRow ? 2 : 3}
            testID={`${idPrefix}-team-sub`}>
            {sub}
          </Text>
          {stackPill ? (
            <View style={styles.stackedPill}>
              <Pill view={pill} testID={`${idPrefix}-team-pill`} />
            </View>
          ) : null}
        </View>
        {stackPill ? null : <Pill view={pill} testID={`${idPrefix}-team-pill`} />}
      </View>
      {canCheck ? (
        <View style={[styles.rowAction, {paddingLeft: scaled(MARK_SIZE) + space.sm}]}>
          <SecondaryButton
            label={checking ? AI_CONNECT_CARD_COPY.checking : AI_CONNECT_CARD_COPY.check}
            icon={checking ? null : CARD_ICONS.refresh}
            busy={checking}
            disabled={locked}
            onPress={onCheck}
            testID={`${idPrefix}-team-check`}
          />
        </View>
      ) : null}
      {result ? (
        <Sentence
          // 문장이 바뀌면 새로 서서 `onLayout`이 다시 온다(같은 높이의 다른 결과도 보인다).
          key={result.text}
          onLayout={revealEnd ?? undefined}
          style={[
            styles.result,
            {
              paddingLeft: scaled(MARK_SIZE) + space.sm,
              color:
                result.tone === 'ok'
                  ? palette.ok
                  : result.tone === 'mute'
                    ? palette.textMuted
                    : palette.danger,
            },
          ]}
          accessibilityLiveRegion="polite"
          testID={`${idPrefix}-team-result`}>
          {result.text}
        </Sentence>
      ) : null}
    </View>
  );
}

// ---- 부품 ----------------------------------------------------------------------

const PILL_LABEL = '상태';

export function Pill({
  view,
  testID,
}: {
  view: AiPillView;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const tone = pillColors(palette, view.tone);
  return (
    <View
      style={[styles.pill, {backgroundColor: tone.bg}]}
      accessible
      accessibilityLabel={`${PILL_LABEL} ${view.text}`}
      testID={testID}>
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
      // 상자 안 글자는 `dangerText`(paletteContrast 의 `dangerText on dangerSurface`).
      return {bg: palette.dangerSurface, fg: palette.dangerText};
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
  const scaled = useScaled();
  const glyph = (size: number) => ({width: scaled(size), height: scaled(size)});
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled, busy}}
      onPress={disabled ? undefined : onPress}
      hitSlop={slopTo(scaled(BUTTON_HEIGHT))}
      style={({pressed}) => [
        styles.button,
        disabled && styles.buttonLocked,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}>
      {icon ? (
        <Image
          source={icon}
          style={[glyph(14), {tintColor: palette.text}]}
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
/**
 * 카드(머리 + 몸)가 창에서 가져갈 수 있는 몫(자판이 내려가 있을 때만 몸이 선다).
 * 나머지는 화면 머리·입력창·대화의 것이다. 375×667 큰 글씨(AXL)에서 머리 두 줄
 * (~116pt) + 몸 + 입력창(자리 글자 두 줄 ~140pt) + 화면 머리가 한 화면에 들고, 몸
 * 창은 버튼과 결과 줄을 함께 담을 만큼(~250pt) 남는 값. 기본 글씨에서는 예전 상한
 * (몸만 0.45)과 거의 같다.
 */
const CARD_BODY_WINDOW_SHARE = 0.55;
/** 글리프가 글자를 따라 커지는 상한. 아이콘이 글자보다 커지지 않게. */
const GLYPH_SCALE_CAP = 2;
/**
 * 로고 칸은 글리프보다 덜 자란다(R2-H1): 이름 칸이 라틴 낱말 하나(「Anthropic」)를
 * 온전히 담을 폭을 남긴다.
 */
const MARK_SCALE_CAP = 1.3;
/** 이 배수부터 알약이 이름 아래로 내려간다 — 한 줄에 셋을 세우면 이름이 부서진다. */
const STACK_PILL_SCALE = 1.5;
/**
 * 머리·접힌 줄의 글자 배수 상한(R5-H1). 375 폭에서 「플러그 · AI 계정 · 나에게만 ·
 * 닫기」가 한 줄에 드는 값. 화면 막대의 `BAR_CONTROL_MAX_SCALE`(1.6)과 같은 규율이고,
 * 이 카드는 입력창 위에 자판과 함께 서므로 더 낮다.
 */
const HEAD_MAX_SCALE = 1.3;
/**
 * 접힌 줄(「자판을 내리고 카드 펼치기」)의 글자 배수 상한 (#2988, R6 M1 판단).
 * 머리의 1.3 은 **한 줄에 넷**(플러그·제목·표지·닫기)을 세우려는 값이다. 접힌 줄은
 * 제 줄에 혼자 서므로 그 이유가 없다: 375 폭에서 `ds2Type.caption × 1.6`이면 열세 자
 * 남짓(~270pt)이 가장자리 안(327pt)에 한 줄로 들고, 줄 높이(`line.meta × 1.6` +
 * 여백)는 엄지 바닥 44 와 거의 같아(+1pt) 자판 위 높이 예산(R5-H1)을 바꾸지 않는다.
 * 그래서 화면 막대의 조작 글자와 같은 1.6(`BAR_CONTROL_MAX_SCALE`)으로 올린다.
 */
const FOLDED_MAX_SCALE = BAR_CONTROL_MAX_SCALE;
/** 닫기 글리프 상자. */
const CLOSE_BOX = 24;
/** 알약 앞 점(시안 `.pill i{width:6px}`). */
const PILL_DOT = 6;
/** 알약 안 도는 표시의 상자. */
const PILL_SPIN = 12;
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
    headTitles: {
      flex: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.sm,
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
    },
    onlyText: {
      fontSize: ds2Type.caption,
      lineHeight: lineHeight.head,
      fontWeight: '600',
      color: color.textMuted,
    },
    flex: {flex: 1},
    close: {
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
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    markText: {fontSize: ds2Type.caption, fontWeight: '800', color: color.text},
    rowText: {flex: 1, minWidth: 0},
    stackedPill: {flexDirection: 'row', paddingTop: space.xs},
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
    rowAction: {flexDirection: 'row'},
    result: {fontSize: ds2Type.caption, lineHeight: lineHeight.meta},
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
    // `small` 인디케이터(≈20pt)를 0.6배로 그린 12pt 가 상자와 같다 — 상자가 그리는
    // 크기보다 작으면 옆 글자를 덮는다(design-review #2945 M6).
    pillSpin: {width: PILL_SPIN, height: PILL_SPIN, transform: [{scale: 0.6}]},
    pillText: {fontSize: font.meta, lineHeight: lineHeight.head, fontWeight: '600'},
    // 높이가 아니라 **바닥**이다(design-review #2945 H2): 큰 글씨에서 라벨이 자란다.
    button: {
      minHeight: BUTTON_HEIGHT,
      paddingVertical: space.xs,
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
    hidden: {display: 'none'},
    foldedRow: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingVertical: space.sm,
      paddingHorizontal: space.md,
    },
    folded: {
      fontWeight: '600',
      fontSize: ds2Type.caption,
      lineHeight: lineHeight.meta,
      color: color.text,
    },
  });
}

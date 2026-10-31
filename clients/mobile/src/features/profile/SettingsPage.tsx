import {AgentMonthlyReport} from '../agents/AgentUsage';
import {AGENT_USAGE_COPY} from '@momo/core/features/settings/agentUsage';
import {
  declaredStatusLabel,
  effectivePresenceLabel,
  PRESENCE_DND_HINT,
  PRESENCE_MENU_LABEL,
  PRESENCE_OPTIONS,
  PRESENCE_WRITE_FAILED,
} from '@momo/core/features/presence/model';
import {
  PAUSE_ACTIVE_NOTE,
  PAUSE_UNTIL_CHANGE_ACTION,
  PAUSE_UNTIL_NONE_ACTION_LABEL,
  pauseUntilLabel,
} from '@momo/core/features/presence/pauseUntil';
import {
  NOTIFICATION_PAUSE_DESCRIPTION,
  NOTIFICATION_PAUSE_LABEL,
  NOTIFICATION_PAUSE_LOAD_FAILED,
  NOTIFICATION_PAUSE_SAVE_FAILED,
  PUSH_WORK_COMPLETE_DESCRIPTION,
  PUSH_WORK_COMPLETE_LABEL,
} from '@momo/core/features/settings/notificationRules';
import {
  CUSTOM_STATUS_MENU_LABEL,
  statusExpiryShortLabel,
  visibleCustomStatus,
} from '@momo/core/features/presence/customStatus';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {
  effectivePresence,
  type EffectivePresence,
  type Member,
  type PresenceStatus,
} from '@momo/core/lib/api';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Screen, Sentence, STACK_PILL_SCALE} from '../../design/atoms';
import {PageHeader} from '../../design/SheetChrome';
import {ChoiceRow, GroupCard, ListRow} from '../../design/sheetParts';
import {ThemeControl} from '../../design/ThemeControl';
import {themeSummary, useStyles, useTheme} from '../../design/theme';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {HAPTIC_MODES, setHapticMode, useHapticMode} from '../../lib/haptics';
import {useNow} from '../../lib/useNow';
import {EdgeSwipeBack, useLayerClose} from '../../nav/EdgeSwipeBack';
import {
  PUSH_PREVIEW_DETAIL,
  PUSH_PREVIEW_LABEL,
  PUSH_SHOW_SENDER_DETAIL,
  PUSH_SHOW_SENDER_LABEL,
  setPushPreview,
  setPushShowSender,
  usePushPreview,
  usePushShowSender,
} from '../../push/presentation';
import {
  PUSH_SWITCH_LABEL,
  PUSH_SWITCH_OFF_FAILED,
  pushSwitchDetail,
  usePushSwitch,
} from '../../push/usePushSwitch';
import {getServerBase} from '../../storage/serverBase';
import {Avatar} from '../conversation/Avatar';
import {PROFILE_FACE, useFaceRing} from './ProfileFace';
import {formatRealtimeDiagnostics} from '../../realtime/diagnostics';
import {COPY_RECEIPT_MS, copyText} from '../conversation/copy';
import {currentAppVersionLabel} from './appVersion';
import {
  AppUpdateBanner,
  AppUpdateSheet,
} from '../appUpdate/AppUpdateBanner';
import {useAppUpdateOffer} from '../appUpdate/useAppUpdateOffer';
import {
  usePauseNotifications,
  usePushKinds,
  useRecheckWhenElapsed,
  useSetPresence,
} from './selfStatus';
import {AvatarPage} from './AvatarPage';
import {PauseUntilPage} from './PauseUntilPage';
import {StatusSheet} from './StatusSheet';
import {ActionRow, SettingsNote, SettingsSection, SwitchRow} from './settingsRows';
import {DEVICE_KEY_TITLE, deviceKeyCopy} from '../deviceKey/copy';
import {DeviceKeyPanel} from '../deviceKey/DeviceKeyPanel';
import {useDeviceKey} from '../deviceKey/useDeviceKey';
import {MemoryPauseSection} from '../memory/MemoryPauseSection';
import {
  DEV_TOOLS_ROW_HINT,
  DEV_TOOLS_TITLE,
  DevToolsPage,
  devToolsCountLabel,
} from './DevToolsPage';
import {useDevToolsEntry} from './devTools';
import {LanguageSettingRow, LanguageSettingsPage} from '../../i18n/LanguageSettings';

// =============================================================================
// 「설정」 페이지 — 홈 머리의 내 얼굴이 여는 전체 화면 (#4457, owner 2026-10-25; 옛 `ProfileSheet` 의 자리).
//
// owner(2026-10-25, Buzz 설정 화면과 우리 프로필 시트를 나란히 보내며): 「버즈 기준으로 홈의 우측 위
// 프로필을 누르면 저런식으로 보여. 우리랑 배치랑 디자인 그리고 닫기 텍스트 대신에 저런 x버튼… 페이지나
// 드로어와 바텀시트의 적재적소 활용이 저런 느낌이야. 우리꺼는 너무 구려」.
//
// ## 페이지이지 시트가 아니다 — 전환 방식은 스택
//
// `docs/design-system/phone-sheets.md` §1 의 표가 정한다: 여러 묶음의 설정은 **페이지**이고, 페이지는
// 화면 스택에 쌓여 가장자리 밀기로 닫히며(`EdgeSwipeBack`), 머리 **오른쪽 위**에 원형 X 가 선다(#4691 — 닫기 X 는
// 시트와 같은 자리다. 안쪽 장의 ‹ 뒤로는 왼쪽). §5 분류표도
// 「내 프로필·설정 → 페이지(설정 페이지)」다. 그래서 이 화면은 셸의 한 층(`nav.settings`)이고 `Modal` 이
// 아니다. 모달 페이지로 지으면 ① 왼쪽 가장자리 밀기가 없고 ② 그 위의 「상태 설정」 시트와 새 버전 시트가
// **Modal 위의 Modal**이 된다(§1 규칙 2: Modal 위에 화면을 쌓지 않는다). 층은 그 둘을 한 번에 푼다.
//
// 이 안의 장(테마·지시 기기·명령줄·AI 도구·프로필 사진·알림 일시 중지 기한·방해 금지 기한)은 설정 페이지 **위에 한 겹
// 더** 쌓이고, 그 머리의 **‹ 뒤로**(첫 장의 X 와 다르다: X 는 설정 전체를 닫고 ‹ 는 한 겹만 벗긴다)와
// 왼쪽 가장자리 밀기는 **한 겹만** 벗긴다(설정 페이지는 남는다 — 안쪽 `EdgeSwipeBack` 이 바깥을 무장 해제한다). 시트가 하던 「장 바꾸기」(`page` 상태로 한 화면을 갈아
// 끼움)와 다른 점: 설정 페이지는 마운트된 채 밑에 남아 스크롤 자리와 읽던 값이 그대로다.
//
// ## 무엇이 어디에 서는가 (Buzz 문법, 우리 항목)
//
//   얼굴        큰 원형 아바타(→ 프로필 사진 장) · 이름 · @핸들 · 상태 알약
//   [새 버전]   배너(있을 때만)
//   ① 상태 설정 ›              → 바텀시트 「상태 설정」 (짧은 편집 = 시트)
//   ② 내 상태 라디오 3줄       온라인 · 자리 비움 · 방해 금지(→ 기한 장). 한 번에 고르는 3택이라 같은 자리에서
//   ③ 프로필 › 사진 바꾸기      Buzz 「Edit photo ›」 자리
//   ④ 알림 토글들               푸시 · 일시 중지(→ 기한 장) · 작업 끝남 · 항상 오는 알림
//   ⑤ 기억                      내 일시정지
//   ⑥ 보기 › 테마               → 테마 장
//   ⑦ 연결                      서버(보조 줄) · 지시 기기 ›(→ 지시 기기 장) · 명령줄·AI 도구 ›(→ 목록·지우기 장, 쓸 수
//                               있는 사람에게만 선다: `devTools.ts` `useDevToolsEntry`)
//   ⑧ 계정                      로그아웃 — **마지막, 위험 행**
//   바닥        버전 줄(길게 누르면 연결 기록 복사)
//
// 순서의 근거: Buzz 는 「상태 → 프로필 → 알림 → 연결」이고, 매일 만지는 것(상태·알림)이 위, 한 번 고르면
// 끝나는 것(테마·연결)이 아래, 되돌릴 수 없는 것(로그아웃)이 맨 끝이다. 우리 항목이 더 많아 Buzz 의 넷
// 사이에 「기억」과 「보기」를 끼웠을 뿐 순서의 문법은 그대로다. 「표시 이름 ›」·「프로필 설명 ›」은 폰에
// 지금 없는 기능이라(코어 `changeMyDisplayName` 은 있다) 빈 약속 행으로 그리지 않는다.
//
// ## 상태는 모르는 것을 말하지 않는다
//
// 상태 알약은 웹 `ProfileCard` 와 같은 식으로 코어가 답한다: `effectivePresence(선언, 연결됨)`. 선언이
// 자리 비움·방해 금지면 그것이 답이고, 아니면 이 앱의 실시간 연결이 답이다. 명부가 아직 안 왔으면 알약도,
// 선언 상태 줄도, 상태 설정 행도 그리지 않는다 — 선언을 모르는 채 「온라인」을 말하면 방해 금지를 걸어 둔
// 사람에게 거짓을 보여 준다.
//
// ## 상태와 알림을 여기서 바로 바꾼다 (#2848)
//
// 방해 금지와 알림 일시 중지는 서버에서 다른 필드지만 묶여 있다(ADR-0124 증보 2 「묶어」, owner 결재
// 2026-09-27): 방해 금지(선언 상태)를 고르면 서버가 같은 트랜잭션에서 알림 일시 중지도 같은 기한으로 켜고,
// 풀면 켜기 전 값으로 돌린다. 쓰기는 `selfStatus.ts` 가 서버의 기존 두 계약으로만 한다. 두 스위치는
// **기한을 고르고서야 켜진다**(ADR-0204 D2, #2899): 「직접 끌 때까지」는 없다.
//
// ## 연결된 기기·지시 기기 (#3026)
//
// 폰은 기기 연결의 **받는 쪽**이라 연결된 기기 목록이 없다 — 없는 항목을 자리만 그려 두지 않는다.
// **이 폰 자신**이 지시 기기인가는 「연결」 카드의 한 줄이 상태로 말하고, 누르면 그 장이 지문과 다음
// 행동을 보인다(`features/deviceKey/DeviceKeyPanel`).
// =============================================================================

/** 설정 페이지 위에 한 겹 더 쌓이는 장. `main` 은 설정 페이지 자신이다. */
export type SettingsSubPage =
  | 'language'
  | 'usage'
  | 'theme'
  | 'deviceKey'
  | 'devTools'
  | 'avatar'
  | 'pauseUntil'
  | 'dndUntil';
export type SettingsPageName = 'main' | SettingsSubPage;

/** 안쪽 장의 첫 요소 위 여백 — 설정 첫 장·시트와 같은 `space.md`. 스타일(`subContent`)과 기한 장의 펼침 셈(`revealAt`)이 함께 읽는다. */
const SUB_PAGE_TOP = space.md;

const SUB_PAGE_TITLE: Record<Exclude<SettingsSubPage, 'language'>, string> = {
  usage: AGENT_USAGE_COPY.report,
  theme: '테마',
  deviceKey: DEVICE_KEY_TITLE,
  devTools: DEV_TOOLS_TITLE,
  avatar: '프로필 사진',
  pauseUntil: NOTIFICATION_PAUSE_LABEL,
  dndUntil: declaredStatusLabel('dnd'),
};

export function SettingsPage({
  workspaceId,
  member,
  directory,
  connected,
  onSignOut,
  onClose,
  initialPage = 'main',
}: {
  workspaceId: string;
  member: Member;
  directory: Directory;
  /** 실시간 연결이 지금 붙어 있는가. 상태 알약의 `auto` 가 이것으로 풀린다. */
  connected: boolean;
  onSignOut: () => void;
  /** 페이지를 떠난다(머리의 원형 X). 안쪽 장의 ‹ 뒤로는 이것이 아니라 설정으로 돌아간다. */
  onClose: () => void;
  /** 처음 열 장. 앱은 늘 `main` 이고, 측정 하네스가 안쪽 장을 찍을 때 쓴다. */
  initialPage?: SettingsPageName;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<SettingsPageName>(initialPage);
  const [statusOpen, setStatusOpen] = useState(false);
  const backToMain = useCallback(() => setPage('main'), []);

  const scrollRef = useRef<ScrollView>(null);
  const revealEnd = useCallback(
    () => scrollRef.current?.scrollToEnd({animated: true}),
    [],
  );

  // 페이지가 열려 있는 동안(어느 장이든) 알고 있는 기한이 지나면 서버에 다시 묻는다. 서버는 만료에
  // 이벤트를 보내지 않아서, 가만두면 지난 시각을 「…까지」로 말하는 방해 금지 줄이 남는다(design-review
  // H3). 화면을 스스로 풀지 않는다 — 서버의 새 답이 온 뒤에 그린다.
  const pagePause = usePauseNotifications(workspaceId);
  const self = memberFor(directory, member.id) ?? undefined;
  const knownDeadlines = [self?.dndUntilMs, pagePause.untilMs].filter(
    (at): at is number => at !== undefined,
  );
  useRecheckWhenElapsed(
    workspaceId,
    knownDeadlines.length > 0 ? Math.min(...knownDeadlines) : undefined,
  );

  return (
    <View style={styles.root} onAccessibilityEscape={onClose} testID="settings-page">
      <Screen>
        <PageHeader
          title="설정"
          closeLabel="설정 닫기"
          onClose={onClose}
          closeTestID="settings-close"
          titleTestID="settings-title"
          testID="settings-header"
        />
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            styles.content,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}
          testID="settings-scroll">
          <SettingsContent
            workspaceId={workspaceId}
            member={member}
            directory={directory}
            connected={connected}
            onOpenUsage={() => setPage('usage')}
            onOpenTheme={() => setPage('theme')}
            onOpenLanguage={() => setPage('language')}
            onOpenStatus={() => setStatusOpen(true)}
            onOpenDeviceKey={() => setPage('deviceKey')}
            onOpenDevTools={() => setPage('devTools')}
            onOpenPauseUntil={() => setPage('pauseUntil')}
            onOpenDndUntil={() => setPage('dndUntil')}
            onOpenAvatar={() => setPage('avatar')}
            onSignOut={onSignOut}
            onRevealEnd={revealEnd}
            covered={page !== 'main' || statusOpen}
          />
        </ScrollView>
      </Screen>

      {page !== 'main' ? (
        <EdgeSwipeBack
          accessibilityViewIsModal
          style={styles.subPane}
          onBack={backToMain}
          // 스택의 push 처럼 오른쪽에서 밀려 들어오고, ‹ 는 오른쪽으로 물러난다(동작 줄이기면 즉시).
          enter="push"
          testID="settings-sub-pane">
          {page === 'language' ? (
            <LanguageSettingsPage onBack={backToMain} />
          ) : (
            <SubPage
              page={page}
              workspaceId={workspaceId}
              member={member}
              directory={directory}
              onBack={backToMain}
            />
          )}
        </EdgeSwipeBack>
      ) : null}

      {statusOpen ? (
        <StatusSheet
          workspaceId={workspaceId}
          selfId={member.id}
          self={self}
          onClose={() => setStatusOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** 안쪽 장 하나: 머리(‹ 뒤로 → 설정으로) + 자기 스크롤. */
function SubPage({
  page,
  workspaceId,
  member,
  directory,
  onBack,
}: {
  page: Exclude<SettingsSubPage, 'language'>;
  workspaceId: string;
  member: Member;
  directory: Directory;
  onBack: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  // 장의 윗변에서 잰 `y` 에 장 앞의 위쪽 여백(`SUB_PAGE_TOP`)을 더하고, 보이려는 요소가 윗변에서 12 아래에 서도록 한 번 뺀다.
  const revealAt = useCallback(
    (y: number) =>
      scrollRef.current?.scrollTo({y: y + SUB_PAGE_TOP - space.md, animated: true}),
    [],
  );
  // 긴 목록 장의 확인 단계가 서면 맨 위로 올린다: 목록 중간까지 내려 본 사람의 확인 카드가 화면 밖에 서지 않게.
  const scrollToTop = useCallback(
    () => scrollRef.current?.scrollTo({y: 0, animated: false}),
    [],
  );
  const title = SUB_PAGE_TITLE[page];
  // ‹ · VoiceOver escape · 「기한/사진을 고른 뒤 돌아가기」는 모두 같은 길로 한 겹만 벗긴다: 들어온 길의 반대로
  // 물러난 뒤 `onBack`(층 밖에서는 곧바로 `onBack`).
  const closeLayer = useLayerClose();
  const goBack = closeLayer ?? onBack;
  return (
    // VoiceOver 의 두 손가락 문지르기는 한 겹만 벗긴다 — 설정 페이지의 것(위쪽 뿌리)까지 올라가지 않는다.
    <View style={styles.root} onAccessibilityEscape={goBack} testID="settings-sub-page">
      <Screen>
        <PageHeader
          title={title}
          // 안쪽 장의 머리는 ‹ 뒤로다(X 가 아니다) — X 는 「설정 전체를 닫는다」이고 ‹ 는 「한 겹만 벗기고 설정으로
          // 돌아간다」(iOS 관례, planner 결정). 이름은 어디로 가는지 말한다.
          back={{
            label: '설정으로 돌아가기',
            onPress: goBack,
            testID: 'settings-back',
          }}
          titleTestID="settings-sub-title"
          testID="settings-sub-header"
        />
        <ScrollView
          ref={scrollRef}
          // 상태 글을 쓰다가 프리셋·지우기를 누르면 첫 탭이 키보드만 닫고 버려졌다(#2848 리뷰 M-3).
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.subContent,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}
          testID="settings-sub-scroll">
          {page === 'usage' ? (
            <AgentMonthlyReport workspaceId={workspaceId} />
          ) : page === 'theme' ? (
            <ThemePage />
          ) : page === 'deviceKey' ? (
            <DeviceKeyPage workspaceId={workspaceId} />
          ) : page === 'devTools' ? (
            <DevToolsPage workspaceId={workspaceId} selfId={member.id} onTop={scrollToTop} />
          ) : page === 'avatar' ? (
            <AvatarPage
              workspaceId={workspaceId}
              selfId={member.id}
              directory={directory}
              onDone={goBack}
            />
          ) : (
            <PauseUntilPage
              kind={page === 'dndUntil' ? 'dnd' : 'pause'}
              workspaceId={workspaceId}
              selfId={member.id}
              self={memberFor(directory, member.id) ?? undefined}
              onDone={goBack}
              onReveal={revealAt}
            />
          )}
        </ScrollView>
      </Screen>
    </View>
  );
}

function ThemePage(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.themePage}>
      <ThemeControl />
      <Sentence style={styles.caption}>
        이 기기에서만 적용됩니다. 데스크탑과 웹의 테마는 따로 고릅니다.
      </Sentence>
    </View>
  );
}

function DeviceKeyPage({workspaceId}: {workspaceId: string}): React.JSX.Element {
  // 이 장을 연 사람에게만 스스로 다시 연결한다(#3103) — Face ID 창이 뜬다.
  const state = useDeviceKey(workspaceId, {autoReconnect: true});
  return <DeviceKeyPanel state={state} />;
}

/**
 * 설정 페이지의 내용(스크롤 안쪽). 캡처 하네스가 알림 묶음까지 끌어올려 찍는다(시뮬레이터는 스크롤할 수
 * 없다). 앱은 `SettingsPage` 안에서만 쓴다.
 */
export function SettingsContent({
  workspaceId,
  member,
  directory,
  connected,
  onOpenTheme,
  onOpenLanguage,
  onOpenStatus,
  onOpenDeviceKey,
  onOpenDevTools,
  onOpenUsage,
  onOpenPauseUntil,
  onOpenDndUntil,
  onOpenAvatar,
  onSignOut,
  onRevealEnd,
  covered = false,
}: {
  workspaceId: string;
  member: Member;
  directory: Directory;
  connected: boolean;
  onOpenTheme: () => void;
  onOpenLanguage?: () => void;
  /** 「상태 설정」 바텀시트를 연다. */
  onOpenStatus: () => void;
  onOpenDeviceKey: () => void;
  /**
   * 「명령줄·AI 도구」 장(내 연결 목록·지우기)을 연다. 없으면 행이 서지 않고 아무것도 읽지 않는다(캡처 하네스가 이
   * 컴포넌트를 직접 부른다).
   */
  onOpenDevTools?: () => void;
  onOpenUsage?: () => void;
  /** 알림 일시 중지를 켜거나 기한을 바꾸는 장(`PauseUntilPage kind="pause"`). */
  onOpenPauseUntil: () => void;
  /** 방해 금지를 켜거나 기한을 바꾸는 장(`PauseUntilPage kind="dnd"`). */
  onOpenDndUntil: () => void;
  /** 프로필 사진 장을 연다(#4384). 없으면 얼굴은 눌리지 않고 「사진 바꾸기」 행도 서지 않는다(캡처 하네스). */
  onOpenAvatar?: () => void;
  onSignOut: () => void;
  /** 확인 블록이 열리면 페이지를 끝까지 내린다 — 두 버튼이 접힌 곳 아래에 서지 않게. */
  onRevealEnd: () => void;
  /**
   * 안쪽 장이나 「상태 설정」 시트가 이 페이지 위에 덮여 있는가. 덮이면 **열려 있던 로그아웃 확인을 접는다** — 이 페이지는
   * 덮여도 마운트된 채 남지만(스크롤 자리·읽던 값을 지키려고) 옛 시트는 장을 갈아 끼워 확인이 저절로 닫혔다. 돌아왔을 때
   * 열려 있던 「로그아웃할까요?」가 눌러 달라는 듯 서 있지 않게 한다(보안 검수 F2).
   */
  covered?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const faceRing = useFaceRing();
  const {choice, themeId} = useTheme();
  const push = usePushSwitch(workspaceId, member.id);
  // 알림이 어떻게 보이는가 (#4316, ADR-0204 증보 5): 이 폰의 선택 둘. 서버 값이 아니라 기기에 있어서
  // 읽는 중·못 읽음이 없고, 켜 두는 것이 처음 상태다.
  const hapticMode = useHapticMode();
  const previewOn = usePushPreview();
  const showSenderOn = usePushShowSender();
  const setPresence = useSetPresence(workspaceId, member.id);
  const pause = usePauseNotifications(workspaceId);
  const kinds = usePushKinds(workspaceId);
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (covered) setConfirming(false);
  }, [covered]);
  // 큰 글씨(`STACK_PILL_SCALE` 부터)에서는 반폭 단추 둘이 「로그아/웃」 으로 어절 가운데서 끊긴다 — 위아래로 쌓아 한 줄 전체를 쓴다
  // (AX5 캡처가 잡았다: design-review r2 의 증거 공백). `ListRow` 의 값 쌓기와 같은 문턱이다.
  const {fontScale} = useWindowDimensions();
  const stackConfirm = fontScale >= STACK_PILL_SCALE;
  const [diagCopied, setDiagCopied] = useState(false);
  // 새 버전 배너(#3905): 새 판이 있는 동안 상시 선다.
  const updateOffer = useAppUpdateOffer();
  const [updateSheetOpen, setUpdateSheetOpen] = useState(false);

  // 설정 › 정보의 명시적인 복사 경로 (#4783). 기존 버전 줄의 길게 누르기도 유지한다.
  const copyDiagnostics = useCallback(() => {
    const text = `${currentAppVersionLabel()}\n${formatRealtimeDiagnostics()}`;
    void copyText(text).then(ok => {
      if (ok) setDiagCopied(true);
    });
  }, []);
  useEffect(() => {
    if (!diagCopied) return;
    const id = setTimeout(() => setDiagCopied(false), COPY_RECEIPT_MS);
    return () => clearTimeout(id);
  }, [diagCopied]);

  // 375pt 기본 크기에서 확인 블록의 두 버튼이 화면 아래로 나갔다(#2702 캡처) — 「로그아웃」을 누른
  // 사람에게 다음 단계가 보이지 않으면 버튼이 안 먹은 것으로 읽힌다. 블록이 그려진 **뒤에** 내린다.
  useEffect(() => {
    if (confirming) onRevealEnd();
  }, [confirming, onRevealEnd]);

  const self = memberFor(directory, member.id);
  // 명부가 아직 안 왔으면 알약을 그리지 않는다 — 선언을 모르는 채 「온라인」을 말하면 방해 금지를
  // 걸어 둔 사람에게 거짓을 보여 준다.
  const presence: EffectivePresence | null = self
    ? effectivePresence(self.presenceStatus, connected)
    : null;
  const custom = self ? visibleCustomStatus(self, now) : null;
  const customLine = custom
    ? [custom.emoji, custom.text].filter(Boolean).join(' ')
    : null;
  // 시안 `.a-status .fx` — 「집중 모드 · 18:00까지」. 만료가 있을 때만 붙인다.
  const customPill =
    customLine && self?.statusExpiresAtMs !== undefined
      ? `${customLine} · ${statusExpiryShortLabel(self.statusExpiresAtMs, now)}`
      : customLine;
  const declared: PresenceStatus | null = self
    ? setPresence.isPending && setPresence.variables
      ? setPresence.variables.status
      : (self.presenceStatus ?? 'auto')
    : null;
  const pauseLocked = !pause.ready || pause.pending;
  const pauseDetail = pause.loadFailed
    ? NOTIFICATION_PAUSE_LOAD_FAILED
    : !pause.ready
      ? '알림 설정을 확인하는 중입니다.'
      : pause.paused
        ? PAUSE_ACTIVE_NOTE
        : NOTIFICATION_PAUSE_DESCRIPTION;
  const pushDetail = pushSwitchDetail(push);
  // 켜진 스위치는 한 번에 끄고, 꺼진 스위치는 기한을 고르는 장으로 간다(ADR-0204 D2).
  const togglePause = () => {
    if (pauseLocked) return;
    if (pause.paused) pause.resume();
    else onOpenPauseUntil();
  };
  const choosePresence = (status: PresenceStatus) => {
    if (setPresence.isPending) return;
    // 방해 금지도 기한을 고르고서야 켜진다. 이미 방해 금지여도 같은 장이 열려 기한을 바꾼다.
    if (status === 'dnd') {
      onOpenDndUntil();
      return;
    }
    if (status === declared) return;
    setPresence.mutate({status});
  };
  const server = getServerBase();
  // 줄의 값만 읽는다 — 승인을 기다리며 목록을 되읽는 일은 그 장이 열렸을 때만 한다.
  const deviceKey = deviceKeyCopy(useDeviceKey(workspaceId, {poll: false}).view);
  const themeValue = themeSummary(themeId, choice);
  // 만들 수 있거나 이미 만든 연결이 있는 사람에게만 행이 선다(`useDevToolsEntry`). 정책이 오기 전에는 서지 않는다.
  const devTools = useDevToolsEntry(workspaceId, member.id, onOpenDevTools !== undefined);

  return (
    <>
      <View style={styles.hero}>
        {/* 큰 얼굴과 「프로필」 카드의 「사진 바꾸기」 행이 같은 장을 연다(#4384). 얼굴만 누르게 두면
            바꿀 수 있다는 것을 아는 사람만 바꾼다 — owner 가 「수단이 없다」고 했다. */}
        <Pressable
          // 낭독은 아래 「사진 바꾸기」 행이 맡는다 — 같은 단추를 두 번 읽지 않게 얼굴은 눈으로 누르는 길이다.
          accessible={onOpenAvatar === undefined}
          accessibilityRole="button"
          accessibilityLabel={onOpenAvatar === undefined ? '프로필 사진(흐림)' : undefined}
          importantForAccessibility={onOpenAvatar === undefined ? 'auto' : 'no-hide-descendants'}
          accessibilityElementsHidden={onOpenAvatar !== undefined}
          disabled={onOpenAvatar === undefined}
          onPress={onOpenAvatar}
          style={({pressed}) => [faceRing, pressed && styles.pressed]}
          testID="self-profile-avatar">
          <Avatar directory={directory} memberId={member.id} size={PROFILE_FACE} />
        </Pressable>
        <View style={styles.heroText}>
          {/* 두 줄까지 허용한 자리라 줄바꿈도 어절 단위다(`Sentence` = `hangul-word`) — 띄어쓰기가 있는 긴 이름이 어절
              가운데서 끊기지 않는다(r3 L1). */}
          <Sentence
            accessibilityRole="header"
            style={styles.name}
            numberOfLines={2}
            testID="self-profile-name">
            {member.displayName}
          </Sentence>
          <Text style={styles.handle} numberOfLines={1} testID="self-profile-handle">
            @{member.handle}
          </Text>
        </View>
        {presence || customPill ? (
          <View style={styles.pills}>
            {presence ? (
              <View
                accessible
                accessibilityLabel={`내 상태: ${effectivePresenceLabel(presence)}`}
                style={[styles.pill, pillTone(styles, presence)]}
                testID="self-profile-presence">
                <View style={[styles.pillDot, dotTone(styles, presence)]} />
                <Text style={[styles.pillLabel, pillLabelTone(styles, presence)]}>
                  {effectivePresenceLabel(presence)}
                </Text>
              </View>
            ) : null}
            {customPill ? (
              <View style={[styles.pill, styles.pillCustom]}>
                <Sentence style={styles.customStatus} testID="self-profile-custom-status">
                  {customPill}
                </Sentence>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {updateOffer ? (
        <AppUpdateBanner
          offer={updateOffer}
          onPress={() => setUpdateSheetOpen(true)}
          // 페이지의 스크롤이 이미 가로 여백을 준다 — 배너가 한 번 더 들이지 않는다.
          flush
          testID="profile-update-banner"
        />
      ) : null}
      {updateSheetOpen && updateOffer ? (
        <AppUpdateSheet offer={updateOffer} onClose={() => setUpdateSheetOpen(false)} />
      ) : null}

      {/* ① 상태 설정 — 짧은 편집이라 시트가 연다. */}
      {self ? (
        <GroupCard testID="settings-status-card">
          <ListRow
            title={CUSTOM_STATUS_MENU_LABEL}
            value={customLine ?? '없음'}
            accessory="chevron"
            onPress={onOpenStatus}
            accessibilityLabel={`${CUSTOM_STATUS_MENU_LABEL}, ${customLine ?? '없음'}`}
            accessibilityHint="이모지와 짧은 글, 사라질 때를 고릅니다."
            testID="profile-status-row"
          />
        </GroupCard>
      ) : null}

      {/* ② 내 상태 — 한 번에 고르는 3택이라 같은 자리에서 고른다. 앞 칸(상태 점)이 없다: 설정 페이지는 앞 칸 없는 쪽이고
          (`phone-sheets.md` §4), 점이 있으면 이 카드만 글자 열이 38pt 안으로 들어가 이웃 카드와 어긋난다(design-review
          r1 H1). 상태의 색은 머리의 알약이 말하고, 고른 줄은 강조색·굵게·✓ 세 신호가 말한다. */}
      {declared ? (
        <SettingsSection>
          <View accessibilityRole="radiogroup" accessibilityLabel={PRESENCE_MENU_LABEL}>
            <GroupCard label={PRESENCE_MENU_LABEL} testID="settings-presence-card">
              {PRESENCE_OPTIONS.map(status => {
                const selected = status === declared;
                const label = declaredStatusLabel(status);
                return (
                  <ChoiceRow
                    key={status}
                    title={label}
                    detail={status === 'dnd' ? PRESENCE_DND_HINT : undefined}
                    selected={selected}
                    disabled={setPresence.isPending && !selected}
                    onPress={() => choosePresence(status)}
                    accessibilityLabel={label}
                    accessibilityHint={
                      status === 'dnd'
                        ? `${PRESENCE_DND_HINT} 누르면 기한을 골라요.`
                        : undefined
                    }
                    testID={`presence-option-${status}`}
                    checkTestID={`presence-${status}-check`}
                  />
                );
              })}
              {/* 방해 금지가 켜져 있으면 끝나는 때와 그것을 바꾸는 길을 줄로 둔다(알림 일시 중지와 같은
                  문법). 기한 없는 행(옛 판이 만든 것)은 「기한 없음 · 기한 정하기」다(ADR-0204 D2). */}
              {declared === 'dnd' ? (
                <ListRow
                  title={
                    self?.dndUntilMs === undefined
                      ? PAUSE_UNTIL_NONE_ACTION_LABEL
                      : `${pauseUntilLabel(self.dndUntilMs, now)} · ${PAUSE_UNTIL_CHANGE_ACTION}`
                  }
                  accessory="chevron"
                  onPress={onOpenDndUntil}
                  accessibilityHint="방해 금지를 켜 두는 기한을 고르는 화면을 열어요."
                  testID="profile-dnd-until-row"
                />
              ) : null}
            </GroupCard>
          </View>
          {setPresence.isError ? (
            <SettingsNote tone="danger" testID="presence-failure">
              {PRESENCE_WRITE_FAILED}
            </SettingsNote>
          ) : null}
        </SettingsSection>
      ) : null}

      {/* ③ 프로필 — Buzz 「Edit photo ›」. */}
      {onOpenAvatar || onOpenLanguage ? (
        <GroupCard label="프로필" testID="settings-profile-card">
          {onOpenAvatar ? (
            <ListRow
              title="사진 바꾸기"
              accessory="chevron"
              onPress={onOpenAvatar}
              accessibilityLabel="프로필 사진 바꾸기"
              testID="self-profile-avatar-change"
            />
          ) : null}
          {onOpenLanguage ? <LanguageSettingRow onPress={onOpenLanguage} /> : null}
        </GroupCard>
      ) : null}

      {/* ④ 알림. */}
      <SettingsSection>
        <GroupCard label="알림" testID="settings-notify-card">
          {/* 이 폰의 스위치 (#3924, ADR-0204 D1). 켬 = OS 허용 + 사람이 끄지 않음. 끄면 이 기기의 서버
              등록만 지워지고(데스크탑·다른 기기는 그대로), 다시 켜기 전에는 앱을 다시 켜도 등록하지
              않는다. OS 가 막았으면 누르는 것이 허용 창(묻지 않음)·iOS 설정(거부)을 연다 — 두 길 다
              스위치가 대신 서므로 따로 줄을 두지 않는다. */}
          <SwitchRow
            title={PUSH_SWITCH_LABEL}
            detail={pushDetail}
            checked={push.on}
            a11yDisabled={push.busy || push.permission === 'checking'}
            onPress={push.toggle}
            accessibilityHint={pushDetail}
            control={
              push.permission === 'checking'
                ? // 권한을 아직 읽지 못했으면 「꺼짐」을 그리지 않는다 — 허용한 사람에게 거짓이다.
                  {kind: 'loading', testID: 'profile-push-loading'}
                : {
                    kind: 'switch',
                    value: push.on,
                    onValueChange: () => push.toggle(),
                    disabled: push.busy,
                    testID: 'profile-push-switch',
                  }
            }
            testID="profile-push-row"
          />
          <View accessibilityRole="radiogroup" accessibilityLabel="햅틱" testID="settings-haptics">
            {HAPTIC_MODES.map(option => (
              <ChoiceRow
                key={option.value}
                title={`햅틱: ${option.label}`}
                selected={hapticMode === option.value}
                onPress={() => setHapticMode(option.value)}
                testID={`haptics-${option.value}`}
              />
            ))}
          </View>
          {/* 알림이 어떻게 보이는가 (#4316, ADR-0204 증보 5). 이 폰의 선택이라 서버를 부르지 않고, 확장은
              MMKV 를 읽지 못해서 바꿀 때 App Group 으로도 쓴다(`push/presentation.ts`). 「보낸 사람 표시」를
              끄면 건넨 사진·채널 이름과 시스템에 기부한 기록이 함께 지워진다. */}
          <SwitchRow
            title={PUSH_PREVIEW_LABEL}
            detail={PUSH_PREVIEW_DETAIL}
            checked={previewOn}
            onPress={() => setPushPreview(!previewOn)}
            accessibilityHint={PUSH_PREVIEW_DETAIL}
            control={{
              kind: 'switch',
              value: previewOn,
              onValueChange: setPushPreview,
              testID: 'profile-preview-switch',
            }}
            testID="profile-preview-row"
          />
          <SwitchRow
            title={PUSH_SHOW_SENDER_LABEL}
            detail={PUSH_SHOW_SENDER_DETAIL}
            checked={showSenderOn}
            onPress={() => setPushShowSender(!showSenderOn)}
            accessibilityHint={PUSH_SHOW_SENDER_DETAIL}
            control={{
              kind: 'switch',
              value: showSenderOn,
              onValueChange: setPushShowSender,
              testID: 'profile-show-sender-switch',
            }}
            testID="profile-show-sender-row"
          />
          <SwitchRow
            title={NOTIFICATION_PAUSE_LABEL}
            detail={pauseDetail}
            checked={pause.paused}
            // 줄 전체를 흐리지 않는다 — 읽기 실패 문장까지 흐려지면 「읽지 말라」가 된다(#2848 리뷰
            // M-1). 잠김은 스위치 자신과 접근성 상태가 말한다.
            a11yDisabled={pauseLocked}
            onPress={togglePause}
            // 꺼진 스위치는 누르면 켜지는 대신 기한 장이 열린다 — 방해 금지 줄의 힌트와 같은 말로 알린다.
            accessibilityHint={
              pause.ready && !pause.paused ? '누르면 알림을 멈출 기한을 골라요.' : pauseDetail
            }
            control={
              pause.ready
                ? {
                    kind: 'switch',
                    value: pause.paused,
                    onValueChange: togglePause,
                    disabled: pauseLocked,
                    testID: 'profile-pause-switch',
                  }
                : pause.loadFailed
                  ? {kind: 'none'}
                  : // 서버 값을 모르는 동안 「꺼짐」을 그리지 않는다 — 켜 둔 사람에게 거짓이다.
                    {kind: 'loading', testID: 'profile-pause-loading'}
            }
            testID="profile-pause-row"
          />
          {/* 켜져 있으면 끝나는 때와 그것을 바꾸는 길을 따로 줄로 둔다 — 위 줄은 스위치라 누르면
              꺼지므로 같은 줄에 「기한 바꾸기」를 얹지 않는다. 기한 없는 행(옛 판이 만든 것)은 「기한
              없음 · 기한 정하기」다(ADR-0204 D2). */}
          {pause.ready && pause.paused ? (
            <ListRow
              title={
                pause.untilMs === undefined
                  ? PAUSE_UNTIL_NONE_ACTION_LABEL
                  : `${pauseUntilLabel(pause.untilMs, now)} · ${PAUSE_UNTIL_CHANGE_ACTION}`
              }
              accessory="chevron"
              onPress={onOpenPauseUntil}
              accessibilityHint="알림을 멈추는 기한을 고르는 화면을 열어요."
              testID="profile-pause-until-row"
            />
          ) : null}
          {/* 읽기 실패의 복구 길: 옛 판의 `tone="accent"` 를 지킨다 — 기본색 행이면 눌리지 않는 정보 행(「서버」·「항상 오는
              알림」)과 같은 모양이라 눌러야 하는 줄이 안 보인다(design-review #4457 r3 M1). */}
          {pause.loadFailed ? (
            <ActionRow
              title="다시 불러오기"
              tone="accent"
              onPress={pause.retryLoad}
              testID="profile-pause-retry"
            />
          ) : null}
          {/* 종류별 스위치 (#3342, ADR-0120 부록 A). 서버가 이 경로를 모르면(아직 배포 전) 줄 자체를
              세우지 않는다 — 켜도 아무 일 없는 스위치는 약속이다. */}
          {kinds.absent ? null : (
            <SwitchRow
              title={PUSH_WORK_COMPLETE_LABEL}
              detail={
                kinds.loadFailed
                  ? NOTIFICATION_PAUSE_LOAD_FAILED
                  : kinds.ready
                    ? PUSH_WORK_COMPLETE_DESCRIPTION
                    : '알림 설정을 확인하는 중입니다.'
              }
              checked={kinds.workComplete}
              a11yDisabled={!kinds.ready || kinds.pending}
              onPress={() => kinds.setWorkComplete(!kinds.workComplete)}
              accessibilityHint={PUSH_WORK_COMPLETE_DESCRIPTION}
              control={
                kinds.ready
                  ? {
                      kind: 'switch',
                      value: kinds.workComplete,
                      onValueChange: next => kinds.setWorkComplete(next),
                      disabled: kinds.pending,
                      testID: 'profile-work-complete-switch',
                    }
                  : kinds.loadFailed
                    ? {kind: 'none'}
                    : {kind: 'loading', testID: 'profile-work-complete-loading'}
              }
              testID="profile-work-complete-row"
            />
          )}
          {kinds.loadFailed ? (
            <ActionRow
              title="다시 불러오기"
              tone="accent"
              onPress={kinds.retryLoad}
              testID="profile-work-complete-retry"
            />
          ) : null}
          {kinds.absent ? null : (
            <ListRow
              title="항상 오는 알림"
              detail="승인 요청, 나를 부른 멘션, 다이렉트 메시지는 종류별로 끌 수 없습니다. 한꺼번에 멈추려면 알림 일시 중지를 쓰세요."
              testID="profile-always-row"
            />
          )}
        </GroupCard>
        <SettingsNote testID="settings-haptics-note">끔은 앱이 더하는 햅틱을 꺼요. 시스템 컨트롤의 햅틱은 기기 설정을 따라요.</SettingsNote>
        {push.failed ? (
          <SettingsNote tone="danger" testID="push-failure">
            {PUSH_SWITCH_OFF_FAILED}
          </SettingsNote>
        ) : null}
        {pause.failed ? (
          <SettingsNote tone="danger" testID="pause-failure">
            {NOTIFICATION_PAUSE_SAVE_FAILED}
          </SettingsNote>
        ) : null}
        {kinds.failed ? (
          <SettingsNote tone="danger" testID="work-complete-failure">
            {NOTIFICATION_PAUSE_SAVE_FAILED}
          </SettingsNote>
        ) : null}
      </SettingsSection>

      {/* ⑤ 기억 — 내 일시정지 하나. */}
      <MemoryPauseSection workspaceId={workspaceId} />

      {/* ⑥ 보기 — 한 번 고르면 끝나는 것. */}
      <GroupCard label="보기" testID="settings-view-card">
        <ListRow
          title="테마"
          value={themeValue}
          accessory="chevron"
          onPress={onOpenTheme}
          accessibilityLabel={`테마, ${themeValue}`}
          accessibilityHint="화면 모드, 테마, 강조색을 고릅니다."
          testID="profile-theme-row"
        />
      </GroupCard>

      {/* ⑦ 연결. */}
      <GroupCard label="연결" testID="settings-connect-card">
        <ListRow
          title="서버"
          detail={server ?? '이 기기에 저장된 서버 주소가 없습니다.'}
          testID="profile-server-row"
        />
        <ListRow
          title={DEVICE_KEY_TITLE}
          value={deviceKey.badge}
          accessory="chevron"
          onPress={onOpenDeviceKey}
          accessibilityLabel={`${DEVICE_KEY_TITLE}, ${deviceKey.badge}`}
          accessibilityHint="이 폰이 에이전트에게 지시할 수 있는지와 지문을 봅니다."
          testID="profile-device-key-row"
        />
        {devTools.visible && onOpenDevTools ? (
          <ListRow
            title={DEV_TOOLS_TITLE}
            value={devTools.count ? devToolsCountLabel(devTools.count) : undefined}
            accessory="chevron"
            onPress={onOpenDevTools}
            accessibilityHint={DEV_TOOLS_ROW_HINT}
            testID="profile-dev-tools-row"
          />
        ) : null}
      </GroupCard>

      {onOpenUsage && (memberFor(directory, member.id)?.role === 'owner' || memberFor(directory, member.id)?.role === 'admin') ? (
        <GroupCard label="관리자 설정">
          <ListRow title={AGENT_USAGE_COPY.report} accessory="chevron" onPress={onOpenUsage} testID="settings-agent-usage" />
        </GroupCard>
      ) : null}

      {/* ⑧ 계정 — 마지막, 위험 행. 확인을 한 번 거친다. */}
      <GroupCard label="계정" testID="settings-account-card">
        {confirming ? (
          <View style={styles.confirm} testID="sign-out-confirm-block">
            {/* 웹 `ProfileCard` 의 확인 대화상자와 같은 두 문장이다 (리뷰 M5). */}
            <View style={styles.confirmCopy}>
              <Sentence style={styles.confirmTitle}>로그아웃할까요?</Sentence>
              <Sentence style={styles.confirmText}>
                로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다.
              </Sentence>
            </View>
            <View
              style={[styles.confirmActions, stackConfirm && styles.confirmActionsStacked]}
              testID="sign-out-confirm-actions">
              <Pressable
                accessibilityRole="button"
                onPress={() => setConfirming(false)}
                style={({pressed}) => [
                  styles.confirmButton,
                  stackConfirm && styles.confirmButtonStacked,
                  pressed && styles.pressed,
                ]}
                testID="sign-out-cancel">
                <Text style={styles.confirmCancelLabel}>취소</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={onSignOut}
                style={({pressed}) => [
                  styles.confirmButton,
                  stackConfirm && styles.confirmButtonStacked,
                  styles.confirmDanger,
                  pressed && styles.confirmDangerPressed,
                ]}
                testID="sign-out-confirm">
                <Text style={styles.confirmDangerLabel}>로그아웃</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <ListRow
            title="로그아웃"
            tone="danger"
            onPress={() => setConfirming(true)}
            testID="sign-out"
          />
        )}
      </GroupCard>

      <GroupCard label="정보" testID="settings-about-card">
        <ListRow
          title={diagCopied ? '연결 기록 복사됨' : '연결 기록 복사'}
          onPress={copyDiagnostics}
          testID="settings-copy-connection-log"
        />
      </GroupCard>

      <Text
        style={styles.version}
        testID="profile-version"
        onLongPress={copyDiagnostics}
        accessibilityHint="길게 누르면 연결 기록을 복사합니다.">
        {diagCopied ? '연결 기록 복사됨' : currentAppVersionLabel()}
      </Text>
    </>
  );
}

type Styles = ReturnType<typeof buildStyles>;

function pillTone(styles: Styles, presence: EffectivePresence) {
  switch (presence) {
    case 'online':
      return styles.pillOk;
    case 'away':
      return styles.pillWarn;
    case 'dnd':
      return styles.pillDanger;
    case 'offline':
      return styles.pillMuted;
  }
}

function pillLabelTone(styles: Styles, presence: EffectivePresence) {
  switch (presence) {
    case 'online':
      return styles.pillLabelOk;
    case 'away':
      return styles.pillLabelWarn;
    case 'dnd':
      return styles.pillLabelDanger;
    case 'offline':
      return styles.pillLabelMuted;
  }
}

function dotTone(styles: Styles, presence: EffectivePresence) {
  switch (presence) {
    case 'online':
      return styles.dotOk;
    case 'away':
      return styles.dotWarn;
    case 'dnd':
      return styles.dotDanger;
    case 'offline':
      return styles.dotMuted;
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    pressed: {backgroundColor: color.surfacePressed},
    // 카드 사이 간격 16, 라벨·카드 사이 8 은 부품(`GroupCard`)이 쥔다 — 이 페이지는 카드 사이만 정한다.
    content: {
      paddingTop: space.md,
      paddingHorizontal: SAFE_GUTTER,
      gap: space.lg,
    },
    // 첫 요소 위 여백이 설정 첫 장(`content`)·시트(`SHEET.bodyTop`)와 같은 12 다 — 옛 시트의 24 가 남아 안쪽 장만 머리에서 더
    // 떨어져 보였다(design-review r1 L2). `PauseUntilPage` 의 `onReveal` 셈은 이 값(`SUB_PAGE_TOP`)을 읽는다. 한 장이 한
    // 자식이라 자식 사이 간격은 없다.
    subContent: {paddingTop: SUB_PAGE_TOP},
    // 설정 페이지 전체(안전 영역까지)를 덮는 한 겹. 불투명해야 밑의 설정이 비치지 않는다.
    subPane: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: color.bg,
    },
    // 머리 원 아래·알약 아래에 숨을 둔다 — 히어로가 카드 목록과 한 덩어리로 읽히지 않게(design-review r1 L1: Buzz 는
    // 머리 아래 ≈41pt, 알약 아래 ≈31pt). 카드 사이 간격(16)과 같으면 얼굴 영역이 첫 카드의 일부처럼 보인다.
    hero: {
      alignItems: 'center',
      gap: space.md,
      paddingTop: space.lg,
      paddingBottom: space.md,
    },
    heroText: {alignItems: 'center', gap: space.xs},
    name: {
      fontSize: font.title,
      fontWeight: '700',
      color: color.text,
      textAlign: 'center',
    },
    handle: {fontSize: font.label, color: color.textMuted},
    // 시안 `.a-status{display:flex;gap:6px}` — 두 알약이 한 줄에, 넘치면 접힌다. 6 은 폰 간격 격자 밖이라
    // 가장 가까운 `space.sm`(8)에 붙인다.
    pills: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: space.sm,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
    },
    // 테두리가 없다 (리뷰 M2) — 작은 테두리 알약은 이 팔레트에서 **컨트롤** 문법이고(디자인 시스템
    // §2.2), 이 알약은 누를 수 없다. 채움만으로 상태를 말한다.
    pillOk: {backgroundColor: color.okSurface},
    pillWarn: {backgroundColor: color.warnSurface},
    pillDanger: {backgroundColor: color.dangerSurface},
    pillMuted: {backgroundColor: color.surface},
    // 시안 `.a-status .fx{background:surface;color:ink2;box-shadow:sh1}`.
    pillCustom: {
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
      flexShrink: 1,
    },
    pillDot: {width: space.sm, height: space.sm, borderRadius: radius.pill},
    dotOk: {backgroundColor: color.ok},
    dotWarn: {backgroundColor: color.warn},
    dotDanger: {backgroundColor: color.danger},
    dotMuted: {backgroundColor: color.textFaint},
    pillLabel: {fontSize: font.label, fontWeight: '600'},
    pillLabelOk: {color: color.ok},
    pillLabelWarn: {color: color.warn},
    pillLabelDanger: {color: color.dangerText},
    pillLabelMuted: {color: color.textMuted},
    customStatus: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.textMuted,
      textAlign: 'center',
    },
    themePage: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    caption: {
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: line.label,
      paddingHorizontal: space.xs,
    },
    // 로그아웃 확인 — 공용 `ConfirmStep`(`sheetParts.tsx`)과 같은 문법이다: 머리말 body/700 · 설명 label + `line.label` · 단추
    // 반경 `radius.md` · 단추 글자 label/600(위험은 700) · 머리말과 설명 사이 `space.sm`. **다른 것은 둘이고 일부러다**:
    // ① 위험 단추는 채움(`dangerFill`)이다 — 이 페이지에서 되돌릴 수 없는 유일한 행동이라 위계가 채움 > 윤곽이다
    // (`phone-sheets.md` §3.1). ② 취소의 윤곽은 3:1 `textFaint` 다(카드 위 `border` 는 비텍스트 대비를 못 넘는다).
    // `ConfirmStep` 을 이 둘로 올리는 일은 다음 확인 단계를 옮기는 이슈(#4458)에서 한다(design-review #4457 r1 M2, PR 「발견」).
    confirm: {padding: space.lg, gap: space.md},
    confirmCopy: {gap: space.sm},
    confirmTitle: {fontSize: font.body, color: color.text, fontWeight: '700'},
    confirmText: {
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: line.label,
    },
    confirmActions: {flexDirection: 'row', gap: space.sm},
    // 쌓인 배치: 단추가 한 줄 전체를 쓴다(`flex: 1` 은 세로 방향에서 높이를 0 으로 눌러 버린다). 큰 글씨의 한 줄이 단추 가장자리에
    // 닿지 않게 위아래로 숨을 둔다(나란한 배치는 `minHeight` 44 가 숨을 준다 — 글씨가 작아서다).
    confirmActionsStacked: {flexDirection: 'column'},
    confirmButtonStacked: {flex: 0, paddingVertical: space.sm},
    confirmButton: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      // 채움도 강조도 없는 버튼이라 테두리가 「여기가 버튼이다」의 전부다 — 3:1 을 넘는 `textFaint`(웹
      // `--line-strong` 자리)를 쓴다 (#1155 · 리뷰 M-1 의 규칙).
      borderColor: color.textFaint,
    },
    confirmCancelLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
    // 파괴 확인은 채움으로 선다 — 이 페이지에서 되돌릴 수 없는 유일한 행동이다.
    confirmDanger: {
      backgroundColor: color.dangerFill,
      borderColor: color.dangerFill,
    },
    confirmDangerPressed: {opacity: 0.85},
    confirmDangerLabel: {
      fontSize: font.label,
      color: color.onDangerFill,
      fontWeight: '700',
    },
    // `textMuted` — `textFaint` 는 선 토큰이라 글자로는 AA 아래다 (리뷰 M3). 버그 신고에 옮겨 적히는 줄이다.
    version: {
      fontSize: font.meta,
      color: color.textMuted,
      textAlign: 'center',
    },
  });

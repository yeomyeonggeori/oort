import type {Message, MessageSearchHit, RosterMember} from '@momo/core/lib/api';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {SearchPhase} from '@momo/core/features/search/searchModel';
import React from 'react';
import {
  LogBox,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import {SessionProvider} from '../src/session/useSession';
import {
  agentRunLedgerFromWire,
  type AgentRunLedgerEvent,
  type AgentRunProgress,
} from '@momo/core/lib/api';
import {RunLedgerSheet} from '../src/features/agents/RunLedgerSheet';
import {ApiError} from '@momo/core/lib/api';
import type {ProviderLink} from '@momo/core/features/settings/api';
import {AiConnectCard, TEAM_QUERY_KEY} from '../src/features/aiConnect/AiConnectCard';
import {quoteDraftFor, type QuoteBlock as QuoteBlockModel} from '@momo/core/features/timeline/quote';
import {typingSegments} from '@momo/core/features/chat/typing';
import {
  Composer,
  composerColumnBudget,
  composerMaxHeight,
  COMPOSER_MAX_ROWS,
  INPUT_CHROME,
  INPUT_CHROME_X,
  mentionAnnotationLines,
  mentionRowHeight,
  placeholderRoom,
  PLACEHOLDER_MAX_LINES,
  withLatinWordBreaks,
} from '../src/features/conversation/Composer';
import {CONV, composerTextColumn} from '../src/features/conversation/convDesign';
import {saveDraft} from '../src/features/conversation/drafts';
import {CLAUDE_SUBSCRIPTION_AGENT_PAUSED} from '@momo/core/features/ai/aiHubModel';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {PinListPanel} from '../src/features/conversation/PinListPanel';
import {TypingBar} from '../src/features/conversation/TypingBar';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {
  DayDivider,
  MessageRow,
  PendingRow,
  RecoveryDivider,
  rowPressedBackground,
  UnreadDivider,
  WorkingRow,
} from '../src/features/conversation/MessageRow';
import {MissedDigestCardView} from '../src/features/memory/MissedDigestCard';
import {MemoryDigestSheet} from '../src/features/memory/MemoryDigestSheet';
import {MemoryPauseSection} from '../src/features/memory/MemoryPauseSection';
import {MemoryProposalCardView} from '../src/features/memory/MemoryProposalCard';
import type {ProposalView} from '../src/features/memory/model';
import {memoryKeys} from '../src/features/memory/queries';
import {
  receiptSheetModel,
  type MissedCardState,
} from '../src/features/memory/model';
import {
  RECEIPT_SHEET_TITLE,
  receiptSheetSummary,
} from '../src/features/memory/copy';
import type {
  MemoryDigest,
  MemoryProposal,
  MemoryReceipt,
  MemorySettings,
} from '@momo/core/features/memory/model';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {SpawnHostChoice} from '../src/features/inbox/SpawnHostChoice';
import {ApprovalDecision} from '../src/features/inbox/ApprovalDecision';
import {StopTurnControl} from '../src/features/agents/StopTurnControl';
import {AdeControlPanel} from '../src/features/ade/AdeControlPanel';
import {AdeSummaryLine} from '../src/features/ade/AdeSummaryLine';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {signalFromProgress} from '@momo/core/features/agents/runPhase';
import {markAgentWorking, resetAgentWorking} from '../src/features/agents/workingSignal';
import type {ChannelRail} from '../src/realtime/channelRail';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {
  Timeline,
  type PillState,
  type TimelineGeometry,
} from '../src/features/conversation/Timeline';
import {Screen, ScreenHeader} from '../src/design/atoms';
import {
  PermissionCard,
  SignedWorkControlsView,
  type SignedWorkActions,
  type SignedWorkInitial,
} from '../src/features/work/SignedWorkControls';
import {
  rejectWithInstructionLine,
  type PendingPermission,
} from '@momo/core/features/workbench/agentPane';
import {
  permissionPreviewGate,
  type PermissionPreviewGate,
} from '@momo/core/features/workbench/permissionPreviewGate';
import {
  permissionPreviewSha256,
  type PermissionPreview,
} from '@momo/core/features/workbench/permissionPreview';
import {ThemeControl} from '../src/design/ThemeControl';
import {parseExecutionPlan} from '@momo/core/lib/executionPlan';
import {
  NotificationPrimer,
  type PrimerKinds,
} from '../src/features/onboarding/NotificationPrimer';
import {noteConnectRoute} from '../src/features/onboarding/phoneFlow';
import {measureMode} from './root';
import {Shell} from '../src/shell/AppShell';
import {SheetDragSurface} from './sheetDrag';
import {SheetKitSurface} from './sheetKit';
import {ProfileSheetSurface} from './profileSheet';
import {ConversationMenuSurface} from './conversationMenu';
import {ConversationHeaderSurface} from './conversationHeader';
import {ConversationInfoPageSurface} from './conversationInfoPage';
import {
  DelegateWorkSheet,
  type DelegatePreview,
  type DelegatePrefill,
} from '../src/shell/DelegateWorkSheet';
import {AiSheet} from '../src/shell/AiSheet';
import {AskMacSheet, type AskMacPreview} from '../src/shell/AskMacSheet';
import NetInfo from '@react-native-community/netinfo';
import {File as FsFile, Paths} from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import {bootSpawnPort} from '../src/boot/spawnPort';
import {workRunFailure} from '@momo/core/features/agents/workRunRequest';
import {INITIAL_NAV, navReducer} from '../src/nav/state';
import {seedMemberAvatar} from '../src/features/conversation/memberAvatarImage';
import {SettingsContent} from '../src/features/profile/SettingsPage';
import {SettingsOverlay, SETTINGS_PERSONA, settingsPersona} from './settingsOverlay';
import {__setPermissionReader} from '../src/push/permissionStatus';
import {clearPushOptOut, setPushOptedOut} from '../src/push/pushOptOut';
import {pushDeviceId} from '../src/push/registration';
import {AppUpdateSheet} from '../src/features/appUpdate/AppUpdateBanner';
import {RELEASE_NOTES} from '@momo/core/features/releaseNotes/notes';
import {ReleaseNotesSheet} from '../src/features/releaseNotes/ReleaseNotesSheet';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {seedIosFeedCacheForCapture} from '../src/features/appUpdate/feed';
import {PageSheet} from '../src/design/PageSheet';
import {LinkSheetBody} from '../src/features/deviceKey/DeviceKeyLinkSheet';
import {
  DEVICE_KEY_LOCAL_QUERY_KEY,
  DEVICE_KEYS_QUERY_KEY,
  useDeviceKey,
  type DeviceKeyState,
} from '../src/features/deviceKey/useDeviceKey';
import type {DeviceKeyView} from '../src/deviceKey/enrollment';
import type {DeviceKey} from '@momo/core/features/auth/deviceKeys';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {NoticeBlock} from '../src/design/atoms';
import {ResultRow, SearchBody} from '../src/screens/SearchScreen';
import SidebarScreen, {
  SearchEntryAction,
  SearchFallthrough,
} from '../src/screens/SidebarScreen';
import {
  composedUnreadCount,
  unreadDividerCursorSeq,
} from '@momo/core/features/readState/model';
import {markAt3Cursor10} from '@momo/core/features/readState/proof';
import type {MessageSearch} from '../src/features/search/useMessageSearch';
import {
  font,
  // `line` 이라는 이름은 이 파일에서 이미 「초안 한 줄」로 쓰이고 있다
  // (`composer-offline`). 토큰 쪽에 다른 이름을 주는 것이 그 자리를 건드리는 것
  // 보다 싸다.
  line as lineBox,
  SAFE_GUTTER,
  space,
  type Palette,
} from '../src/design/tokens';
import {
  composerPlaceholder,
  composerPlaceholderClauses,
} from '@momo/core/features/chat/composerCopy';
import {FixedScheme, useStyles, type ColorScheme} from '../src/design/theme';
import {PullProbe} from './pullProbe';
import {PullHold} from './pullHold';
import {PullRefreshSurface} from './pullRefresh';
import {DmConversationSurface} from './dmConversation';
import {BubbleSurface} from './bubbleConv';
import {BubbleClipSurface} from './bubbleClip';
import {DockGapSurface} from './dockGap';
import {TapDismissSurface} from './tapDismiss';
import {JumpLatestSurface} from './jumpLatest';
import {ThreadPanelSurface} from './threadPanel';
import {ComposerNewlineSurface} from './composerNewline';
import {SteadySurface, seedSteady} from './steady';
import {ActivityRowsSurface} from './activityRows';
import {UncollectedSurface, isUncollectedSurface, seedUncollected} from './uncollected';
import {AppsSurface} from './apps';
import {AppsTailSurface} from './appsTail';
import {OortLoaderSurface} from './oortLoader';
import {PhotoCardSurface} from './photoCard';
import {AttachMenuSurface} from './attachMenu';
import {AvatarApprovalSurface} from './avatarApproval';
import {PinApprovalSurface} from './pinApproval';
import {ThemeLiveSurface} from './themeLive';
import {PhotoViewerSurface} from './photoViewer';

import TeamBoardScreen from '../src/screens/TeamBoardScreen';
import WorkJobsScreen from '../src/screens/WorkJobsScreen';
import {TeamBoardDetailSheet} from '../src/features/work/teamBoard/TeamBoardDetailSheet';
import WorkSessionDetailScreen from '../src/screens/WorkSessionDetailScreen';
import {buildConversation} from '../src/features/work/conversation';
import {
  composerGate,
  ModeSwitch,
  WorkConversationView,
} from '../src/features/work/WorkConversation';
import type {WorkSessionEvent} from '@momo/core/features/work/workSessionModel';
import {SessionRow} from '../src/screens/AgentDetailScreen';
import {WorkStatusBadge} from '../src/features/work/WorkSessionParts';
import {
  workSessionContinuityStatus,
  workSessionStatus,
  type WorkSessionStatus,
} from '@momo/core/features/work/workSessionModel';
import type {
  SharedWorkSession,
  WorkHost,
  WorkSession,
} from '@momo/core/lib/api';

// =============================================================================
// goal RN-C5 의 표면들을 사진 찍을 수 있게 세워 두는 하네스. **앱 코드가 아니다.**
//
// 이 배치가 더한 화면 대부분은 살아 있는 서버에서 저절로 나타나지 않는다. 시트는
// 길게 눌러야 나오고, 삭제 확인은 그 시트 안에서 한 번 더 눌러야 나오고, 검색의
// 네 상태 중 셋은 결과가 있을 때는 영영 보이지 않는다. 그리고 시뮬레이터는
// 스크립트로 누를 수 없다(스파이크 #837: RN 요소가 접근성 트리에 없고 좌표 클릭도
// 닿지 않는다). 그대로 두면 리뷰가 가장 봐야 할 화면들이 리뷰되지 않는다.
//
// 그래서 여기서는 **실제 컴포넌트**에 각 상태를 직접 건네준다. 목업을 그리지
// 않는다 — `measure/states.tsx` 가 `Timeline` 에 대해 이미 쓰는 방법이고, 찍힌
// 것이 곧 배송되는 것이어야 사진이 증거가 된다.
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure SHEET
//   … DELETE · EDITOR · SEARCH-IDLE · SEARCH-EMPTY · SEARCH-ERROR · SEARCH-RESULTS
//
// ## U4-2 가 더한 것 (design-review N-8)
//
// 그 리뷰의 **시각 위상이 통째로 SKIPPED** 였고, 직접적 원인이 이것이었다:
// M1~M4 가 더한 네 표면 중 **하나도** 이 하네스에 서지 않았다. 그래서 대비·기하
// 지적이 전부 「코드에서 도출한 값」으로만 남았고, 리뷰어가 스스로 적었다 —
// *"픽셀을 봤다고 주장하는 지적은 이 보고서에 없다."*
//
// 아래 여섯 케이스가 그 공백을 닫는다. 다음 리뷰는 계산이 아니라 사진을 본다:
//
//   QUOTE-READY · QUOTE-DELETED · QUOTE-UNRESOLVED   인용 3상태
//   TYPING-ONE · TYPING-MANY                          작성 중 (1인·집계)
//   MARKDOWN                                          코드·리스트·인라인 코드
//
// ## U4-5M 이 더한 것 (#1097)
//
//   PENDING-GUTTER   낙관적 메아리의 좌우 여백 (감사 M-12) — 확정 행과 **나란히**
//   DELETED-FOLD     연달아 지워진 메시지의 접기 (감사 M-1) — 접히지 않는 경우 포함
//   LANDED           인용 점프 착지 틴트 (#1076) — 물든 행과 이웃을 한 장에
//
// 셋 다 **비교 대상을 같은 화면에 둔다.** 위생 결함은 혼자 찍으면 안 보이기
// 때문이다: 「여백이 0 이다」는 여백을 가진 행 옆에서만 보이고, 「접혔다」는 접히지
// 않은 묘비 옆에서만, 「물들었다」는 안 물든 이웃 옆에서만 보인다.
//
// ## U4-6M 이 더한 것 (#1103)
//
//   AVATAR            폰 아바타 신설 (감사 H-11) — 사람 · **연속 행** · 에이전트 ·
//                     명부에 없는 작성자를 한 묶음처럼
//   APPROVAL-NOTES    승인 카드 세 문장의 격 (리뷰 M-3) — 영수증 · 차단 · 안내.
//                     **오프라인 상태는 U4-4 리뷰가 미캡처로 남긴 자리다**
//                     (「증거가 상수 하나뿐이라 시각 판정은 확인 필요」).
//   COMPOSER-OFFLINE  보낼 수 있을 때 ↔ 지금은 못 보낼 때 (감사 H-10)
//
// ## AX-7 (#2513) · U4-g (#1084) 가 더한 것 — 행동 승인의 한 흐름, 네 순간
//
//   ACTION-APPROVAL       결정 전: 부록 A 의 행 셋·사유·결정 권한 + 승인/거부
//   ACTION-ROLE-REQUIRED  403 role_required 뒤: 무장 해제 + 조용한 안내. 결정을
//                         실제로 보내야 서는 상태라 Maestro 가 누른다
//                         (`maestro/92-action-role-required-capture.yaml`)
//   ACTION-LINK-ONCE      승인 직후: 영수증 + 1회 링크(리드·값·복사) + 결과 카드
//   ACTION-AFTER-REFRESH  다시 열었을 때: 승인됨 카드 + 결과 카드, 링크 없음(D4)
//
// 캡처는 `captures/action2513-*-{dark,light}.png` 다.
//
// ## ADE 1단계가 더한 것 (이슈 1114)
//
//   SPAWN-LOCKED      잠긴 픽커 ↔ 살아 있는 픽커 (리뷰 B1) — 무장하면 픽커가
//                     잠기는데, 그것이 **보이는지**는 살아 있는 판 옆에서만
//                     사진으로 확인된다. 시뮬레이터가 탭을 못 받아 카드를
//                     통과시킬 수 없으므로 컨트롤을 직접 두 번 세운다.
//   SPAWN-PICKER      승인 카드의 호스트 선택기 (ADR-0125 D6-A) — 자격 둘 ·
//                     오프라인 하나 · T3 예약 하나를 한 장에, 그리고 그 옆에
//                     **고를 것이 하나도 없는** 카드. 같은 규율의 네 번째 적용이다:
//                     「자격 없는 줄이 사유와 함께 선다」는 자격 있는 줄 옆에서만,
//                     「승인이 꺼졌다」는 켜진 승인 옆에서만 사진에서 확인된다.
//
// ## U2 가 더한 것 — 표면이 아니라 **축** 하나
//
//   THEME             스킴 세 칸과, 그 선택을 받는 진짜 타임라인 행. 컨트롤만
//                     찍으면 이 배치가 한 일의 절반만 남는다 — 논점은 「고른
//                     스킴이 화면 끝까지 가는가」이고, 위는 종이인데 아래 행만
//                     밤하늘인 사진이 곧 그 실패다.
//
// 그리고 이 배치부터 **모든 표면이 두 번 찍힐 수 있다.** 이름 앞에 `light-` 를
// 붙이면 같은 장이 라이트로 나온다(`measure/root.ts` 가 그 접두사를 스킴으로
// 읽는다). 인자를 하나 더 늘리지 않은 이유는 표면 목록이 계속 자라기 때문이고,
// 스킴을 **못 박는** 이유는 시뮬레이터의 시스템 설정을 따라가면 같은 명령이 기기
// 상태에 따라 다른 색을 찍기 때문이다 — 그 사진은 증거가 아니라 일화가 된다.
//
//     xcrun simctl launch booted app.momo.ios --args -momoMeasure LIGHT-THEME
//
// 같은 규율의 세 번째 적용이다. 「왼쪽 칸이 같다」는 연속 행이 함께 있어야,
// 「영수증이 격상됐다」는 안내 문장이 함께 있어야, 「버튼이 꺼졌다」는 켜진 버튼이
// 함께 있어야 사진에서 확인된다.
//
// ## 라이트 판이 **무엇을** 찍어야 하는가 (U2 리뷰 M-2)
//
// 첫 판의 라이트 캡처 다섯 장은 전부 같은 것을 졌다 — 「고른 스킴이 화면 끝까지
// 가는가」(테마·행·시트·승인 안내·ADE 관제). 그것은 이 배치의 **큰** 주장이고, 그
// 주장이 참이어도 남는 질문이 있다: 라이트에서만 **얇아지는** 것이 있는가. 다섯 장
// 중 그 질문을 지는 장이 하나도 없었다.
//
// 그래서 두 장을 더한다. 둘 다 이미 있는 표면이라 코드가 아니라 명령이 늘어난다:
//
//   LIGHT-QUOTE-READY   인용 규정선 — 폭 2pt 짜리 중성 회색 선 하나
//   LIGHT-MARKDOWN      코드 상자 — **눌리지 않은 평시**의 고도
//
// 각각의 결정이 얇은 것 **하나에** 걸려 있어서 고른 것이다. 다크에서는 밤하늘 위의
// 밝은 것이라 둘 다 저절로 눈에 띄고, 라이트에서는 종이 위의 밝은 것이라 같은
// 관계가 성립한다는 보장이 없다. 찍힌 픽셀에서 잰 값 (pt = px/3):
//
//   규정선    #84817d(textFaint) on #f7f6f3(bg) = 3.587:1 — 컨트롤 테두리 바닥 위
//   코드 상자 채움 #fffefb(surface) = 1.072:1 · 테두리 #dcd8d0(border) = 1.315:1
//
// 코드 상자의 두 숫자가 이 장의 값어치다: 라이트에서 그 상자를 상자로 만드는 것은
// 고도 띠가 **아니라 테두리**다(1.072 대 1.315). 그리고 행이 눌리면 띠는 1.000:1 이
// 된다 — `rowPressedBackground` 가 `surface` 라 채움이 같아지기 때문이고, 그것이
// `row-pressed` 표면이 다크에서 이미 보여 준 것이다(U4-3 M-2). 즉 평시의 상자도
// 이미 테두리 하나로 서 있고, 눌린 동안에는 그것이 전부다.
//
// 시트류는 `Modal` 이라 화면을 덮으므로 한 번에 하나씩 띄운다.
//
// ## 캡처는 코드와 **같은 커밋**에서 갱신한다 (design-review E-1)
//
// U4-4 는 이 규율 없이 랜딩했고, 그래서 `captures/u44-row.png` 가 두 커밋 낡은
// 채 남았다 — 그 사이에 행 지오메트리가 바뀌었는데 사진은 옛 코드의 **겹쳐 인쇄된
// 글자**를 담고 있었다. 결과는 리뷰어가 저장소만 읽어서는 그것이 고쳐진 것인지
// 남아 있는 것인지 판별할 수 없었고, 실제로 판별하지 못해 지적 하나를
// 「확인 필요」로 쪼개야 했다. **낡은 캡처는 증거가 아니라 잘못된 증언이다.**
//
// 그래서 규칙은 둘 중 하나다: 이 파일이나 그 표면이 그리는 컴포넌트를 고치는
// 커밋은 해당 캡처를 함께 갱신하거나, 그 캡처를 지운다. 명령은 이렇다 —
// 앱을 이 체크아웃에서 빌드·설치한 뒤(`npm run build:sim`),
//
//   xcrun simctl launch booted app.momo.ios --args \
//     -momoMeasure ROW-LEAD -RCT_jsLocation "127.0.0.1:$METRO_PORT"
//   xcrun simctl io booted screenshot --type=png measure/captures/u44-row-lead.png
//
// 기기는 **iPhone 17 Pro**(1206×2622, 3x)이고 읽을 때 **pt = px/3** 이다.
// Metro 가 다른 워크트리를 서빙하고 있으면 사진은 이 체크아웃의 것이 아니다 —
// `scripts/measure.sh` 가 그 함정과 확인 방법(`/status` 의 project-root 헤더)을
// 이미 적어 두었고, 캡처도 같은 확인을 지나야 한다.
// =============================================================================

// =============================================================================
// LogBox 는 이 모듈에서만 꺼진다 (이슈 1137).
//
// `index.js` 는 표면 모드일 때만 이 파일을 `require` 하므로, 이 줄은 사진을 찍는
// 실행에서만 돈다 — 개발자가 앱을 띄우는 보통의 실행에는 닿지 않는다.
//
// 끄는 이유는 **사진 위의 배너가 질문을 만들기 때문**이고(`measure/states.tsx` 가
// VirtualizedList 경고에 대해 같은 말을 한다), 지금 뜨는 그 경고는 이 배치의 것이
// 아니다. 실측으로 문장을 확인했다(`metro --client-logs`):
//
//   WARN  The global process.env.EXPO_OS is not defined. This should be inlined
//         by babel-preset-expo during transformation.
//
// babel 변환 설정에 대한 말이고 이 저장소의 화면 코드와 무관하다. 같은 트리를
// jest 로 렌더하면 `console.warn`·`console.error` 가 0건이다.
// =============================================================================
LogBox.ignoreAllLogs(true);

// 스트레스 로스터(core)의 사람들은 처음부터 가상 인물이다(#4632): 홈 화면 오른쪽 위 아바타의 한 글자와 대화 작성자 줄이 이 로스터에서 온다.
// 예전에는 첫 두 사람이 실제 팀원 이름이라 이 하네스가 순서로 덮었다(#4458). 그 우회는 걷었다. 재유입은 design_preflight_names 가 막는다.
const ROSTER = makeStressRoster();
const DIRECTORY = makeDirectory(ROSTER);
const SELF = (ROSTER.find(m => m.kind === 'human') ?? ROSTER[0]).id;
// 인용의 **원본 저자**. 자기 말을 자기가 인용하는 화면은 이 기능이 실제로 쓰이는
// 모양이 아니다 (design-review N-7).
/** 승인을 요청하는 쪽은 에이전트다 — 에이전트는 멤버다(ADR-0004). */
const AGENT = (ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0]).id;
const OTHER = (
  ROSTER.find(m => m.kind === 'human' && m.id !== SELF) ?? ROSTER[1] ?? ROSTER[0]
).id;
const NOW = 1_700_000_000_000;
/** 하네스 세션의 워크스페이스. 원장 씨앗의 키가 같은 값을 읽는다(#3824). */
const HARNESS_WS = 'measure-ws';

const MESSAGE: Message = {
  id: '00000000-0000-7000-8000-0000000000a1',
  channelId: 'ch',
  seq: 42,
  hlcTs: 42,
  hlcCount: 0,
  authorMemberId: SELF,
  type: 'text',
  body: '금요일 배포는 오전 10시에 시작합니다. 롤백 절차는 문서에 적어 뒀어요.',
  state: 'sent',
  createdAtMs: NOW,
  thread: {reply_count: 3, last_reply_seq: 51, last_reply_at: NOW + 600_000},
};

/** M-2 가 말하는 충돌은 **코드 상자를 든 행**에서만 보인다. */
const CODE_BODY = [
  '재시작 절차는 아래와 같습니다',
  '',
  '```sh',
  'systemctl restart momo-relay',
  '```',
].join('\n');

/**
 * 고정 목록의 씨앗 (이슈 #1112). 셋인 이유: 작성자가 갈리고(이름 줄), 본문 길이가
 * 갈리고(한 줄·잘린 줄), 빈 본문이 하나 있어야 「내용 없는 메시지」가 사진에 선다.
 *
 * **고정 시각도 셋이 다르다** (#1146 N1): 오늘 · 어제 · 해를 넘긴 것. 도장이
 * 정렬 근거(`pinnedAtMs`)를 그리는지, 그리고 **해가 다를 때만 연도가 붙는지**는
 * 셋이 한 장에 있어야 사진에서 확인된다 — 「2022년 …」 한 줄만 찍으면 그것이
 * 규칙인지 사고인지 알 수 없다.
 */
const PINS = {
  '00000000-0000-7000-8000-0000000000a1': {
    messageId: '00000000-0000-7000-8000-0000000000a1',
    channelId: 'ch',
    seq: 42,
    authorMemberId: SELF,
    type: 'text',
    state: 'sent',
    body: '금요일 배포는 오전 10시에 시작합니다. 롤백 절차는 문서에 적어 뒀어요.',
    createdAtMs: NOW,
    pinnedBy: SELF,
    pinnedAtMs: NOW + 300_000,
  },
  '00000000-0000-7000-8000-0000000000a2': {
    messageId: '00000000-0000-7000-8000-0000000000a2',
    channelId: 'ch',
    seq: 44,
    authorMemberId: OTHER,
    type: 'text',
    state: 'sent',
    body: '온콜 교대는 매주 화요일 10시.',
    createdAtMs: NOW + 60_000,
    pinnedBy: SELF,
    pinnedAtMs: NOW - 86_400_000,
  },
  '00000000-0000-7000-8000-0000000000a3': {
    messageId: '00000000-0000-7000-8000-0000000000a3',
    channelId: 'ch',
    seq: 46,
    authorMemberId: OTHER,
    type: 'artifact',
    state: 'sent',
    body: null,
    createdAtMs: NOW + 120_000,
    pinnedBy: OTHER,
    pinnedAtMs: NOW - 400 * 86_400_000,
  },
};

const CHIPS = [
  {emoji: '👍', count: 3, mine: true},
  {emoji: '🎉', count: 1, mine: false},
];

const AVAILABILITY = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
  edit: true,
  delete: true,
};

const HITS: MessageSearchHit[] = [
  {
    channelId: 'ch-1',
    messageId: 'm-1',
    seq: 41,
    authorMemberId: SELF,
    createdAtMs: NOW,
    snippet:
      '어제 이야기한 대로 금요일 배포는 오전 10시에 시작합니다. 롤백 절차는 문서에 적어 뒀고, 확인 부탁드립니다.',
    matchOffset: 16,
  },
  {
    channelId: 'ch-2',
    messageId: 'm-2',
    seq: 12,
    authorMemberId: SELF,
    createdAtMs: NOW - 86_400_000,
    snippet: '배포 전에 스테이징에서 한 번 더 돌려 보죠.',
    matchOffset: 0,
  },
];

function search(phase: SearchPhase, hits: MessageSearchHit[] = []): MessageSearch {
  return {
    query: '배포',
    setQuery: () => {},
    phase,
    settledQuery: '배포',
    hits,
    hasMore: false,
    loadingMore: false,
    loadMore: () => {},
    retry: () => {},
  };
}


// =============================================================================
// ADE 관제 픽스처 (이슈 1137).
//
// **목업이 아니다.** 앱이 실제로 읽는 두 자리에 앱이 실제로 쓰는 모양으로 넣는다:
// 세션 원장·호스트 등록기·명부·채널은 `react-query` 캐시의 **그 키**에(`agentKeys`
// ·`workspaceKeys` 와 글자 단위로 같다), 열린 턴은 `AgentWorkingRail` 이 쓰는 그
// 스토어 함수(`markAgentWorking`)로. 그래서 사진에 찍히는 것은 배송되는 컴포넌트가
// 배송되는 경로로 읽은 값이다 — `composer-offline` 이 `saveDraft` 로 초안을 심는
// 것과 같은 방법이다.
//
// 픽스처가 고른 여섯 장은 세 상태와 세 생존성 등급을 한 장에 세우기 위한 것이다:
//
//   대기   `orphaned` 세션 · 랩탑 위 호스트   -> 「이 기기에서만」
//   대기   `orphaned` 세션 · **없는 호스트**  -> 「실행 위치 확인 필요」 (warn)
//   실행   `running`  세션 · 클라우드 호스트  -> 「기기를 꺼도 계속됩니다」
//   유휴   `idle`     세션                    -> 목록에는 있고 계수에는 없다
//   대기   승인을 기다리는 턴                 -> 호스트가 없으므로 배지도 없다
//   실행   흐르고 있는 턴                     -> 같음
//
// 둘째 줄은 이 판이 처음 랜딩할 때 **빠져 있었다** — 위 문장은 세 등급을 약속하는데
// 씨앗은 두 개만 만들었다(`app`·`cloud` 둘 다 등록기에 있으므로 `unknown` 이 나올
// 길이 없었다). 그래서 셋 중 **유일하게 경고인** 등급이 사진에 한 번도 서지 못했고,
// 리뷰어는 저장소만 읽어서 그 문장이 읽히는지 판별할 수 없었다(design-review M-1).
// 「경고가 읽히는가」는 안심시키는 배지 옆에서만 사진으로 확인된다 — 이 파일이 잠긴
// 픽커·꺼진 승인에 대해 이미 적어 둔 그 규율이다.
// =============================================================================

/** 하네스 세션의 워크스페이스. 아래 캐시 키가 전부 이 값을 쓴다. */
const ADE_WS = 'measure-ws';

/**
 * 두 번째 에이전트. 스트레스 명부에는 에이전트가 하나뿐인데, 이 장이 보여야 하는
 * 것 중 하나가 **두 방에서 동시에 도는 두 턴**이다 — 요약 줄이 워크스페이스 전역
 * 이라는 사실은 서로 다른 방의 항목이 한 줄로 세어질 때만 사진에 나타난다.
 */
const ADE_AGENT_2 = '00000000-0000-7000-8000-00000000ade2';

const ADE_ROSTER = [
  ...ROSTER,
  {
    ...(ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0]),
    id: ADE_AGENT_2,
    displayName: 'codex',
    handle: 'codex',
  },
];

/** 두 번째 에이전트까지 아는 명부. 화면들이 이름을 여기서 얻는다. */
const ADE_DIRECTORY = makeDirectory(ADE_ROSTER);

const ADE_CHANNELS = [
  {id: 'ch-deploy', workspaceId: ADE_WS, kind: 'public', name: '배포', muted: false},
  {id: 'ch-build', workspaceId: ADE_WS, kind: 'public', name: '빌드', muted: false},
] as const;

const ADE_HOSTS = [
  {
    id: 'host-mac',
    workspaceId: ADE_WS,
    scope: 'member',
    ownerMemberId: SELF,
    type: 'app',
    displayName: '도현 맥북',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
  {
    id: 'host-cloud',
    workspaceId: ADE_WS,
    scope: 'workspace',
    ownerMemberId: SELF,
    type: 'cloud',
    displayName: 'oort Cloud',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
] as const;

function adeSession(over: Record<string, unknown>) {
  return {
    workspaceId: ADE_WS,
    channelId: 'ch-deploy',
    memberId: AGENT,
    hostId: 'host-cloud',
    rootMessageId: 'm-root',
    tool: 'codex',
    label: '작업',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW - 900_000,
    ...over,
  };
}

const ADE_SESSIONS = [
  adeSession({
    id: 's-orphaned',
    channelId: 'ch-build',
    hostId: 'host-mac',
    tool: 'claude',
    label: '야간 회귀 스위트',
    status: 'orphaned',
    startedAtMs: NOW - 5_400_000,
  }),
  /**
   * 등록기에 **없는** 호스트를 가리키는 세션 — 「실행 위치 확인 필요」의 유일한
   * 씨앗이다(`sessionDurability` 는 호스트를 못 찾으면 `unknown` 을 답한다).
   *
   * 지어낸 상황이 아니다. 호스트 등록기는 워크스페이스가 지금 아는 기계의 목록이고
   * 세션 원장은 **있었던 일**의 기록이라, 기계가 등록에서 빠진 뒤에도 그 기계에서
   * 돌던 세션 행은 남는다. 그 카드에 대해 화면이 할 수 있는 정직한 말은 「지속된다」
   * 도 「이 기기에서만」 도 아니고 「모른다」 하나뿐이다.
   *
   * `orphaned` 를 고른 것도 그래서다: 호스트가 사라진 것과 세션이 고아가 된 것은
   * 같은 사건의 두 얼굴이라 이 조합이 가장 흔하다. 그리고 그 덕에 이 카드는 사진
   * 에서 **대기 칩(앰버)과 warn 배지(앰버)가 한 카드 안에 겹치는** 유일한 장이
   * 된다 — 리뷰가 눈으로 확인하라고 한 그 겹침이다.
   *
   * 시작 시각은 `s-orphaned`(5,400초)와 `run-approval`(240초) 사이에 둔다. 정렬이
   * 대기 -> 오래된 것 먼저이므로 이 카드는 **둘째 장**에 서고, 바로 위의 muted 배지
   * 와 나란히 찍힌다 — 경고가 안심시키는 말 옆에 있어야 확인된다는 그 규율이다.
   */
  adeSession({
    id: 's-host-gone',
    hostId: 'host-retired',
    tool: 'claude',
    label: '스테이징 마이그레이션',
    status: 'orphaned',
    startedAtMs: NOW - 3_000_000,
  }),
  adeSession({
    id: 's-running',
    label: '릴레이 재시작 절차 정리',
    startedAtMs: NOW - 1_920_000,
  }),
  adeSession({
    id: 's-idle',
    hostId: 'host-mac',
    label: '로그 훑기',
    status: 'idle',
    startedAtMs: NOW - 7_200_000,
  }),
];

/** 열린 턴 둘. 승인 대기가 하나, 흐르는 것이 하나. */
const ADE_TURNS: AgentWorkingSignal[] = [
  {
    memberId: AGENT,
    channelId: 'ch-deploy',
    state: 'awaiting_approval',
    source: 'status',
    runId: 'run-approval',
    startedAtMs: NOW - 240_000,
    headlines: [],
    lastActivityAtMs: NOW,
  },
  {
    memberId: ADE_AGENT_2,
    channelId: 'ch-build',
    state: 'working',
    source: 'run',
    runId: 'run-live',
    startedAtMs: NOW - 95_000,
    headlines: ['테스트 스위트를 돌리는 중'],
    lastActivityAtMs: NOW,
  },
];

/**
 * 대화가 비어 보이지 않을 만큼의 줄. 이 장의 주인공은 위아래 두 스택이지만, 빈
 * 타임라인은 리뷰어에게 「목록이 안 그려졌다」로 읽힌다.
 */
const ADE_TIMELINE: Message[] = [
  {
    ...MESSAGE,
    id: '00000000-0000-7000-8000-0000000000b1',
    seq: 40,
    authorMemberId: OTHER,
    body: '릴레이 재시작 절차 문서 링크 좀 올려 주세요.',
    createdAtMs: NOW - 1_200_000,
    thread: undefined,
  },
  {
    ...MESSAGE,
    id: '00000000-0000-7000-8000-0000000000b2',
    seq: 41,
    authorMemberId: AGENT,
    body: '문서를 열었습니다. 재시작 전 확인 항목이 셋입니다.',
    createdAtMs: NOW - 900_000,
    thread: undefined,
  },
  MESSAGE,
];

// ---- #1964 — 안읽음 마크를 소비하는 두 장의 씨앗 ------------------------------
//
// 코어 레드 프루프(`features/readState/proof.ts`)의 한 점 그대로다: 마크 3 · 커서
// 10 · head 10. 그래서 대화는 열 줄이고, 마크 자리는 셋째 줄 위다. 문장은 한
// 팀의 금요일 배포 대화 — 「테스트 메시지 1」이 아니다.
const MARK_UNREAD_LINES: readonly [string, string][] = [
  [OTHER, '스테이징 배포 끝났습니다. 확인 부탁드려요.'],
  [SELF, '확인했습니다. 로그인 흐름 정상이에요.'],
  [AGENT, '릴리스 노트 초안을 올렸습니다. 검토가 필요한 항목은 둘입니다.'],
  [OTHER, '결제 모듈 변경분은 제가 볼게요.'],
  [AGENT, '마이그레이션 0187 은 롤백 스크립트와 함께 들어갑니다.'],
  [OTHER, 'QA 체크리스트 12개 중 10개 끝났어요.'],
  [AGENT, '남은 두 개는 iOS 푸시 수신 확인입니다.'],
  [OTHER, '푸시는 오후에 실기기로 보겠습니다.'],
  [AGENT, '금요일 배포 창은 오전 10시로 잡혀 있습니다.'],
  [OTHER, '좋아요, 그때 뵙겠습니다.'],
];

const MARK_UNREAD_TIMELINE: Message[] = MARK_UNREAD_LINES.map(
  ([author, body], i) => ({
    id: `00000000-0000-7000-8000-00000019640${i}`,
    channelId: 'ch-deploy',
    seq: i + 1,
    hlcTs: i + 1,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW + i * 60_000,
  }),
);

/** 하네스에는 소켓이 없다. 「연결됨」은 이 값 하나로 만들어진다. */
const CONNECTED_RAIL = {
  rail: null,
  status: 'connected' as const,
  subscriptionsWanted: true,
};

/**
 * 두 표면이 읽는 자리를 채운다.
 *
 * **렌더 중에 부르지 않는다.** `markAgentWorking` 은 구독자를 동기적으로 깨우고,
 * 그 구독자 중 하나가 지금 그려지고 있는 `AdeSummaryLine` 이다 — React 는 그것을
 * "Cannot update a component while rendering a different component" 으로 잡고
 * LogBox 가 사진 위에 배너를 얹는다(실측: 첫 캡처에 그렇게 찍혔다). 모듈 몸통은
 * 어떤 렌더보다 먼저 도므로 그 자리가 옳다.
 *
 * 시계는 `Date.now()` 로 흐르므로 경과 숫자는 픽스처의 `startedAtMs` 가 아니라
 * **찍는 순간**을 기준으로 커진다. `NOW` 를 그대로 쓰면 2023년에서 지금까지의
 * 시간이 인쇄되므로, 시작 시각을 현재에서 거꾸로 잡는다.
 */
function seedAdeControl(): void {
  const nowMs = Date.now();
  const shift = nowMs - NOW;
  resetAgentWorking();
  harnessClient.setQueryData(['roster', ADE_WS], ADE_ROSTER);
  harnessClient.setQueryData(['channels', ADE_WS], ADE_CHANNELS);
  harnessClient.setQueryData(['work-hosts', ADE_WS], ADE_HOSTS);
  harnessClient.setQueryData(
    ['work-sessions', ADE_WS],
    ADE_SESSIONS.map(session => ({
      ...session,
      startedAtMs: session.startedAtMs + shift,
    })),
  );
  for (const turn of ADE_TURNS) {
    markAgentWorking({
      ...turn,
      ...(turn.startedAtMs === undefined
        ? {}
        : {startedAtMs: turn.startedAtMs + shift}),
      lastActivityAtMs: nowMs,
    });
  }
}


/**
 * 폰 계측이 훑는 방 이름 셋 (#1422). 코어 스위트(`composerCopy.test.ts`)의
 * `LABELS` 와 같은 이름들이라 두 자가 같은 문장을 잰다.
 */
const PLACEHOLDER_LABELS = ['일반', 'release-2026-08', '프로덕트-디자인'];

/**
 * 계측이 **배송되는 입력창**을 직접 잴 수 있게 건네받는 자리 — 방 이름마다 하나 (#4179).
 * 모듈 상수인 이유는 `GROWTH_INPUT_REF` 와 같다: 표면 함수는 렌더마다 다시 도는 평범한 함수라
 * `useRef` 를 못 부르고, 이 표면은 한 번에 하나만 뜬다.
 */
const PLACEHOLDER_INPUT_REFS: Record<
  string,
  React.MutableRefObject<TextInput | null>
> = Object.fromEntries(PLACEHOLDER_LABELS.map(label => [label, {current: null}]));

/**
 * 390pt 화면에서 알약의 글 칸 — 문서로 든 폭 (#4179).
 *
 * 시뮬레이터를 그 폭으로 만들 수는 없다 — 부팅되는 기기의 논리 폭은 기기가 정한다. 그래서 두 번
 * 잰다: **이 기기의 실제 입력창**과 **390pt 화면의 글 칸**. 앞의 것은 지금 이 화면의 진실이고 뒤의
 * 것은 우리가 지키기로 한 좁은 화면의 진실이다. 하나만 재면 넓은 기기에서 나온 초록이 예산을 잰
 * 척한다. 옛 값 260pt 는 알약 이전 바(좌우 16 · 「보내기」 글자 버튼)의 글 칸이었고, 지금은 알약의
 * 글 칸(`composerTextColumn`)에서 도출한다 — 값을 손으로 적으면 이 계측이 배송되지 않는 칸을 잰다.
 */
const PLACEHOLDER_BUDGET_PT = composerTextColumn(390, 1);

/**
 * 이 화면에서 안내 문장이 **몇 줄로 서 있고 한 줄 예산을 지키는가** (#1422 → #4179).
 *
 * 폭도 줄 수도 **추정하지 않고 배송되는 입력창에서 읽는다.** 옛 판은 컴포저의 알약 이전 바(좌우 16
 * 거터와 글자 「보내기」 버튼)를 한 번 더 세워 폭을 쟀고, 그 폭은 알약의 글 칸이 아니었다 — 계측이
 * 배송되지 않는 칸을 재면 사진의 「몇 줄」이 화면의 진실이 아니다. 이제:
 *
 *   · 폭 — 실제 입력창을 `measure()` 로 읽고 입력창 자신의 안쪽 여백·테두리(`INPUT_CHROME_X`)를 뺀다.
 *   · 줄 수 — 같은 글자 스타일·같은 줄바꿈 전략의 `<Text>` 가 **그 폭에서** 문장 전체와 머리 절을
 *     각각 몇 줄로 쓰는지 `onTextLayout` 이 답한다(컴포저 안의 프로브와 같은 일).
 *   · 서 있는 줄 수 — 실제 입력창의 높이에서 크롬을 빼고 줄 상자로 나눈다. 플레이스홀더는 RN 이
 *     줄 수를 알려 주지 않는 유일한 글이라 **상자의 높이가 그 답**이다.
 *
 * 판정은 사진에 적힌다: 문장이 한 줄이면 서 있는 줄이 1 이어야 하고, 한 줄이 아니고 머리 절이 한 줄이면
 * 뒷절이 빠져 1 이어야 하고, 머리 절도 한 줄을 넘으면 버릴 절이 없어 서 있는 줄이 머리의 줄 수여야
 * 한다. 예산을 2줄로 되돌리면 두 번째 경우가 ✗ 로 찍힌다(시험은 `composerDraftOffline.test.tsx`).
 */
function PlaceholderProbe(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {fontScale, height: windowHeight} = useWindowDimensions();
  const [boxes, setBoxes] = React.useState<
    Record<string, {width: number; height: number}>
  >({});
  const [lines, setLines] = React.useState<Record<string, number>>({});
  const rowPt = lineBox.body * fontScale;
  const room = placeholderRoom(fontScale);
  // 상자는 자라다가 상한(`composerMaxHeight`, #1443)에서 멈춘다 — 큰 글자에서 머리 절이 그보다 길면
  // 상자 높이는 줄 수가 아니라 상한을 말한다. 그 띠는 이 규칙의 일이 아니라 기존 한계라 따로 적는다.
  const cap = composerMaxHeight(fontScale, windowHeight);
  const capRows = (cap - INPUT_CHROME) / rowPt;

  // 실제 입력창의 상자를 읽는다. 레이아웃·프로브 왕복이 끝난 뒤(1.5초)에 한 번 — 찍는 쪽은 그보다
  // 오래 기다린다(`scripts/measure.sh` 의 sleep).
  React.useEffect(() => {
    const timer = setTimeout(() => {
      for (const label of PLACEHOLDER_LABELS) {
        PLACEHOLDER_INPUT_REFS[label]?.current?.measure(
          (_x, _y, width, height) =>
            setBoxes(previous => ({...previous, [label]: {width, height}})),
        );
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  const widthOf = (label: string) =>
    boxes[label] === undefined ? 0 : boxes[label].width - INPUT_CHROME_X;
  const slots = [
    ...PLACEHOLDER_LABELS.map(label => ({
      key: `이 기기/${label}`,
      label,
      width: widthOf(label),
    })),
    ...PLACEHOLDER_LABELS.map(label => ({
      key: `390pt/${label}`,
      label,
      width: PLACEHOLDER_BUDGET_PT,
    })),
  ];
  const count = (slot: string, suffix = '') => lines[`${slot}${suffix}`];
  const show = (value: number | undefined) => (value === undefined ? '…' : `${value}`);

  return (
    <View style={styles.probe}>
      {slots
        .filter(slot => slot.width > 0)
        .flatMap(slot =>
          // 두 문장을 나란히 잰다: **절을 다 실은 것**과 **머리 절만**. 판정이 그 둘 사이에서 나므로
          // 하나만 재면 사진은 결과를 들고 그 결과가 나온 이유를 안 든다.
          [
            {suffix: '', text: composerPlaceholder(slot.label, 'place')},
            {
              suffix: '/머리',
              text: composerPlaceholderClauses(slot.label, 'place')[0].text,
            },
          ].map(({suffix, text}) => (
            <View
              key={`${slot.key}${suffix}`}
              style={[styles.probeMeasure, {width: slot.width}]}>
              <Text
                style={styles.probeText}
                lineBreakStrategyIOS="hangul-word"
                onTextLayout={event => {
                  const n = event.nativeEvent.lines.length;
                  setLines(previous =>
                    previous[`${slot.key}${suffix}`] === n
                      ? previous
                      : {...previous, [`${slot.key}${suffix}`]: n},
                  );
                }}>
                {withLatinWordBreaks(text)}
              </Text>
            </View>
          )),
        )}
      {PLACEHOLDER_LABELS.map(label => {
        const box = boxes[label];
        const slot = `이 기기/${label}`;
        const full = count(slot);
        const head = count(slot, '/머리');
        // 서 있는 줄 수 = (입력창 높이 − 크롬) ÷ 줄 상자. 한 줄 입력창은 최소 높이(44)가 이긴다.
        const shown =
          box === undefined
            ? undefined
            : Math.max(1, Math.round((box.height - INPUT_CHROME) / rowPt));
        let verdict = '…';
        if (
          box !== undefined &&
          shown !== undefined &&
          full !== undefined &&
          head !== undefined
        ) {
          const expected =
            full <= PLACEHOLDER_MAX_LINES
              ? 1
              : head <= PLACEHOLDER_MAX_LINES
                ? 1
                : head;
          const clipped = box.height >= cap - 0.5;
          if (clipped && expected > capRows) {
            verdict = `△ 머리 절 ${head}줄이 상자 상한 ${capRows.toFixed(1)}줄을 넘어 잘림 — 버릴 절은 이미 없음(#1443 기존 한계)`;
          } else {
            verdict =
              shown === expected
                ? full <= PLACEHOLDER_MAX_LINES
                  ? '✓ 문장 전체 한 줄'
                  : head <= PLACEHOLDER_MAX_LINES
                    ? '✓ 뒷절 빠짐 · 한 줄'
                    : `✓ 머리 절이 ${head}줄 — 버릴 절 없음`
                : `✗ 예산 위반 (기대 ${expected}줄)`;
          }
        }
        return (
          <Text key={label} allowFontScaling={false} style={styles.probeRead}>
            {`${label}: 입력창 ${box === undefined ? '…' : `${box.width.toFixed(0)}×${box.height.toFixed(1)}pt`}` +
              ` · 글 칸 ${Math.round(widthOf(label))}pt · 문장 ${show(full)}줄 · 머리 ${show(head)}줄` +
              ` · 서 있는 안내 ${show(shown)}줄 → ${verdict}`}
          </Text>
        );
      })}
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`390pt 화면의 글 칸 ${Math.round(PLACEHOLDER_BUDGET_PT)}pt · ` +
          PLACEHOLDER_LABELS.map(
            label =>
              `${label} ${show(count(`390pt/${label}`))}줄(머리 ${show(count(`390pt/${label}`, '/머리'))}줄)`,
          ).join(' · ')}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`안내 줄 예산 ${PLACEHOLDER_MAX_LINES}줄 — 글자 배수 ${fontScale.toFixed(3)} · 줄 상자 ` +
          `${rowPt.toFixed(1)}pt · 문턱 ${room.toFixed(1)}pt = ${(room / rowPt).toFixed(1)}줄 (#4179)`}
      </Text>
    </View>
  );
}

// ---- #1480: 시트의 상한이 도크를 열 안에 두는가 -----------------------------

/**
 * 시트가 **상한에 실제로 닿는** 로스터 (#1480).
 *
 * 기본 `DIRECTORY` 는 셋이라 어떤 상한에서도 다 든다 — 그 사진은 상한을 안 잰다.
 * `matchMembers` 의 목록 상한(`MENTION_LIMIT`)까지 채워야 「몇 개를 보여 주는가」가
 * 화면에서 갈리고, before/after 가 다른 그림이 된다. 이름은 이 제품이 쓰는 모양
 * (한글 이름 + 라틴 핸들)을 지킨다 — 라틴만 든 목록은 행 높이를 다르게 잰다.
 *
 * ## 첫 줄이 **긴 이름**인 이유 (design-review 회전 1 H2)
 *
 * 첫 판의 픽스처는 이도현·박서연·김인턴·동료1~9 로 **전부 짧았고**, 그래서
 * 사진은 행이 폭에서 어떻게 지는지를 한 번도 안 보여 줬다. 그 자리에 실제로 결함이
 * 있었다: 행의 세 조각 중 양보할 수 있는 것이 `mentionHandle` 하나뿐이라, 긴 한글
 * 이름 + 행 끝의 「에이전트」 표지 조합에서 행은 **잘리는 대신 넘쳤고** 넘쳐서
 * 사라지는 것은 표지 쪽이었다(Yoga 의 `flexShrink` 기본값은 0). 짧은 이름만 든
 * 픽스처는 그 결함 위에서도 초록이다.
 *
 * 그래서 첫 줄이 이 로스터에서 가장 긴 이름을 든다 — 그리고 에이전트다(표지가
 * 서는 행이 아니면 그 조합 자체가 안 생긴다). 세 캡처 크기(기본 · a11y-large ·
 * AX-XXL)에서 이 행이 어디서 잘리는지가 사진에 남고, 결함이 실제로 보이는 것은
 * 가장 큰 크기다: `dock1480-mention-sheet-axxl-before-dark.png` 의 첫 줄은
 * 핸들이 「@」 한 글자로 끊긴 채 화면 오른쪽 끝에서 잘리고 「에이전트」가 아예
 * 없다.
 *
 * ## 그 사진이 회전 1 의 after 에서도 안 닫혔다 (회전 2 H)
 *
 * 회전 1 은 넘침을 잡았지만 핸들에 `flex: 1` 을 남겼고, `flex: 1` 은
 * `flexBasis: 0` 이라 핸들은 압력이 오기 전부터 자기 폭이 없는 조각이다 — 그래서
 * `-ax-*`(2.143)의 첫 행에서 핸들은 맨 「@」 한 글자였고 `-axxl-*`(3.143)에는
 * 아예 없었다. **before 의 결함 문장이 after 의 사진에 그대로 서 있었다.**
 *
 * 회전 2 는 양보 순서를 형제 셋과 같은 문법으로 다시 세운다(이름·핸들 둘 다
 * `flexShrink: 1`, 그 둘을 `flex: 1` 짜리 묶음에). 그러니 **이 로스터가 재는
 * 것도 달라졌다**: 이제 사진이 답해야 하는 물음은 「표지가 남아 있는가」가 아니라
 * **「세 조각이 각자 앞을 남기는가」**이고, 두 접근성 크기의 첫 행이 그 답이다.
 *
 *   2.143   「프로덕트…」  「@product-…」  「에이전트」
 *   3.143   「프로…」      「@pro…」       「에이전트」
 */
const MENTION_LONG_NAME = {
  ...(ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0]),
  id: 'mention-long-name',
  displayName: '프로덕트디자인 김인턴',
  handle: 'product-design-intern',
};

const MENTION_DIRECTORY = makeDirectory([
  MENTION_LONG_NAME,
  ...ROSTER,
  ...Array.from({length: 9}, (_, i) => ({
    ...ROSTER[0],
    id: `mention-filler-${i}`,
    displayName: `동료${i + 1}`,
    handle: `mate${i + 1}`,
  })),
]);

// ---- AIH-9b (#3440): AI 보조 줄이 든 시트와 입력창 위 한 줄 -------------------

/**
 * 여섯 가지 후보가 한 시트에 선다: 팀 키 · 내 구독 · 남의 구독(잠김, 맥 꺼짐) · 개인 키(잠김) ·
 * 문의 중(내 구독이지만 쉬는 중) · 내 구독 맥 꺼짐. 문장은 전부 코어가 만든다 — 이 파일은 필드만
 * 심고, 사진에 찍히는 글자가 코어 문장 그대로다.
 *
 * 보는 사람은 `SELF`(로스터의 첫 사람)다. 소유자 필드(`ownerHumanId`)가 `SELF` 이면 「내 것」이다.
 */
const AI_BASE = {
  ...(ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0]),
  kind: 'agent' as const,
  status: 'active' as const,
};
const AI_OWNER = {id: OTHER, displayName: '박서연'};
const AI_MEMBERS: RosterMember[] = [
  {
    ...AI_BASE,
    id: 'ai-team',
    displayName: '김인턴',
    handle: 'hermes',
    brain: 'team_key',
    callableBy: 'everyone',
  },
  {
    ...AI_BASE,
    id: 'ai-mine',
    displayName: '내 Claude',
    handle: 'my-claude',
    brain: 'subscription',
    callableBy: 'owner_only',
    ownerHumanId: SELF,
    owner: {id: SELF, displayName: '이도현'},
    hostOnline: true,
  },
  {
    ...AI_BASE,
    id: 'ai-other-sub',
    displayName: '서연의 Claude Code',
    handle: 'seoyeon-claude',
    brain: 'subscription',
    callableBy: 'owner_only',
    ownerHumanId: AI_OWNER.id,
    owner: AI_OWNER,
    hostOnline: false,
  },
  {
    ...AI_BASE,
    id: 'ai-other-key',
    displayName: '서연 키',
    handle: 'seoyeon-key',
    brain: 'personal_key',
    callableBy: 'owner_only',
    ownerHumanId: AI_OWNER.id,
    owner: AI_OWNER,
  },
  {
    ...AI_BASE,
    id: 'ai-paused',
    displayName: '쉬는 Claude',
    handle: 'paused-claude',
    brain: 'subscription',
    callableBy: 'owner_only',
    ownerHumanId: SELF,
    owner: {id: SELF, displayName: '이도현'},
    hostOnline: true,
    brainUnavailableReason: CLAUDE_SUBSCRIPTION_AGENT_PAUSED,
  },
  {
    ...AI_BASE,
    id: 'ai-mine-off',
    displayName: '맥 꺼진 Claude',
    handle: 'mac-off-claude',
    brain: 'subscription',
    callableBy: 'owner_only',
    ownerHumanId: SELF,
    owner: {id: SELF, displayName: '이도현'},
    hostOnline: false,
  },
] as RosterMember[];
const AI_DIRECTORY = makeDirectory([
  ...AI_MEMBERS,
  ...ROSTER.filter(m => m.kind === 'human').slice(0, 2),
]);

/**
 * 시트가 열렸을 때 **도크가 대화 열 안에 있는가**, 그리고 **얼마나 여유로** (#1480).
 *
 * 산수는 배송되는 함수들(`mentionSheetMaxHeight` · `composerColumnBudget`)을 그대로
 * 부른다 — 사본을 두면 사진이 배송되지 않는 식을 증명한다. 행 수까지 적는 이유는
 * 이 티켓의 결정이 높이가 아니라 **「후보를 몇 개 보여 주는가」**라서다.
 *
 * ## 참/거짓만으로는 모자랐다 (design-review 회전 1 M2)
 *
 * 첫 판은 불변식의 판정만 찍었고, 그래서 사진은 「참」이라고 말하면서 **그 참이
 * 얼마짜리인지**를 안 들었다. 이 파일이 지키는 규율이 정확히 그것을 금한다 —
 * 주장을 사진이 반증할 수 있어야 한다(`GrowthProbe` 의 「크롬은 재고 나서 적는다」
 * 절이 같은 결함을 한 번 고쳤다).
 *
 * 그래서 여유(열 − 도크)와 **본문 한 줄**을 나란히 적는다. 둘을 같이 놓으면 이
 * 불변식이 자기 이름값을 하는지가 사진에서 읽힌다: 오늘의 답은 「시트가 열린
 * 동안에는 어느 크기에서도 본문 한 줄이 안 남는다」이고, 그것이 이 배치가 이름을
 * 준 띠다. 불변식이 실제로 지키는 것은 「대화가 한 줄 남는다」가 아니라 **「도크가
 * 열 밖으로 안 나간다」**이며, 「대화가 남는다」는 시트가 **쉬는** 상태의 약속이다
 * (그때 목록 몫은 `budget.list` — 874pt 기본 크기에서 212.9pt = 본문 9.7줄).
 */
function MentionSheetProbe({
  annotated = false,
}: {
  /** 후보에 AI 보조 줄이 든 시트(AIH-9b) — 두 줄 행의 산식으로 잰다. */
  annotated?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {fontScale, height: windowHeight} = useWindowDimensions();
  const budget = composerColumnBudget(fontScale, windowHeight, annotated);
  const row = mentionRowHeight(fontScale, annotated);
  const dock = budget.mentions + budget.composer + budget.dockChrome;
  const slack = budget.column - dock;
  const bodyRow = lineBox.body * fontScale;

  return (
    <View style={styles.probe}>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`글자 배수 ${fontScale.toFixed(3)} · 창 ${Math.round(windowHeight)}pt · 후보 행 ${row.toFixed(1)}pt${annotated ? ` (보조 줄 ${mentionAnnotationLines(fontScale)}줄 행 — 사람 행 ${mentionRowHeight(fontScale).toFixed(1)}pt)` : ''}`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`시트 ${budget.mentions.toFixed(1)}pt = ${(budget.mentions / row).toFixed(1)}행 (옛 고정값 180pt = ${(180 / row).toFixed(1)}행)`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`도크 ${dock.toFixed(1)}pt = 시트 ${budget.mentions.toFixed(1)} + 입력창 ${budget.composer.toFixed(1)} + 바 여백 ${budget.dockChrome.toFixed(1)}`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`대화 열 ${budget.column.toFixed(1)}pt — 도크 ≤ 열 ${dock <= budget.column ? '참' : '거짓'} · 옛 값이었다면 ${(180 + budget.composer + budget.dockChrome).toFixed(1)}pt (${180 + budget.composer + budget.dockChrome <= budget.column ? '참' : '거짓'})`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`여유 ${slack.toFixed(1)}pt · 본문 한 줄 ${bodyRow.toFixed(1)}pt — 시트가 열린 동안 타임라인에 한 줄 ${slack >= bodyRow ? '든다' : '안 든다'} · 시트가 쉬면 목록 몫 ${budget.list.toFixed(1)}pt = ${(budget.list / bodyRow).toFixed(1)}줄`}
      </Text>
    </View>
  );
}

// ---- #1443 (#1422 이월): 상한이 글자 크기를 따라가는가 -----------------------

/** 성장 계측이 쓰는 방 이름. 라틴 토큰이 든 이름이라 두 축을 한 장에 담는다. */
const GROWTH_LABEL = 'release-2026-08';

/** 다섯 줄짜리 **사람이 친 글**. 상한이 걸리는 자리를 사진이 보여 준다. */
const GROWTH_DRAFT =
  '금요일 배포 건입니다.\n릴레이를 먼저 재시작하고\n그다음 워커를 올립니다.\n로그는 이 방에 남기고\n확인되면 알려 주세요.';

/**
 * 계측이 실제 상자를 잴 수 있게 입력창을 건네받는 자리. 모듈 상수인 이유는
 * 표면 함수가 렌더마다 다시 도는 평범한 함수라 여기서 `useRef` 를 못 부르기
 * 때문이고, 이 표면은 한 번에 하나만 뜬다.
 */
const GROWTH_INPUT_REF: React.MutableRefObject<TextInput | null> = {
  current: null,
};

/**
 * 이 화면에서 상한이 **몇 pt 이고 몇 줄인가**, 그리고 그때 **목록에 무엇이
 * 남는가** (#1443 · 리뷰어 C M-1).
 *
 * 산수는 배송되는 그 함수들(`composerMaxHeight` · `composerColumnBudget`)을
 * 부른다 — 계측이 자기 사본을 들면 사본이 거짓말한다(디자인 시스템 §5.5). 실제
 * 상자 높이는 `measure()` 로 따로 읽어, 식이 화면에서 지켜지는지를 사진 안에서
 * 대조한다.
 *
 * ## 크롬은 **재고 나서** 적는다 (리뷰어 C M-1)
 *
 * 첫 판의 계측 줄은 상한만 적었고, 그래서 「목록에 267pt 가 남는다」는 주석의
 * 주장을 사진이 반증할 수 없었다 — 그 267 에는 목록이 못 쓰는 띠 둘(세이프 에리어
 * 위쪽·헤더)이 들어 있었다. 이제 그 둘을 **이 기기에서 실제로 재서** 적는다:
 * 세이프 에리어는 `useSafeAreaInsets()` 로, 헤더는 **배송되는 `ScreenHeader` 를
 * 세워** `onLayout` 으로. 모델(`CONVERSATION_CHROME_WINDOW_SHARE`)이 실측보다
 * 작아지는 순간이 오면 이 줄이 사진에서 그것을 말한다.
 *
 * 헤더 표본은 절대 배치에 `opacity: 0` 이다. 재는 것이 목적이고 사진에 두 번째
 * 헤더가 서면 이 표면의 세로 예산이 바뀌어 정작 재려던 상자가 화면 밖으로 나간다.
 *
 * 아래 줄 텍스트는 라틴 축의 계기다: 배송되는 변환(`withLatinWordBreaks`)을
 * 통과한 문장이 **어디서** 끊기는지를 `onTextLayout` 이 돌려주는 그대로 적는다.
 * 줄바꿈 기회를 뜻하는 U+200B 는 폭이 0 이라 사진에 안 보이므로 `·` 로 바꿔 적는다.
 */
function GrowthProbe({
  inputRef,
}: {
  inputRef: React.MutableRefObject<TextInput | null>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {fontScale, height: windowHeight} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [boxHeight, setBoxHeight] = React.useState(0);
  const [headerHeight, setHeaderHeight] = React.useState(0);
  const [inputWidth, setInputWidth] = React.useState(0);
  const [broken, setBroken] = React.useState('…');
  const cap = composerMaxHeight(fontScale, windowHeight);
  const budget = composerColumnBudget(fontScale, windowHeight);
  const row = lineBox.body * fontScale;
  // 글 칸의 폭은 **배송되는 입력창**에서 읽는다 (#4179). 옛 판은 알약 이전 바를 복제해서 쟀고 그
  // 폭은 알약의 글 칸이 아니었다.
  const content = inputWidth === 0 ? 0 : inputWidth - INPUT_CHROME_X;
  const measuredChrome = insets.top + headerHeight;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.measure((_x, _y, width, height) => {
        setBoxHeight(height);
        setInputWidth(width);
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [inputRef]);

  return (
    <View style={styles.probe}>
      <View
        style={styles.probeHeaderSpecimen}
        pointerEvents="none"
        onLayout={event => setHeaderHeight(event.nativeEvent.layout.height)}>
        <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-chrome-title" />
      </View>
      {content > 0 ? (
        <View style={[styles.probeMeasure, {width: content}]}>
          <Text
            style={styles.probeText}
            lineBreakStrategyIOS="hangul-word"
            onTextLayout={event => {
              const lines = event.nativeEvent.lines
                .map(item => item.text.replace(/​/g, '·'))
                .join(' | ');
              setBroken(previous => (previous === lines ? previous : lines));
            }}>
            {withLatinWordBreaks(composerPlaceholder(GROWTH_LABEL, 'place'))}
          </Text>
        </View>
      ) : null}
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`글자 배수 ${fontScale.toFixed(3)} · 창 ${Math.round(windowHeight)}pt · 줄 상자 ${row.toFixed(1)}pt`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`크롬 실측 ${measuredChrome.toFixed(1)}pt (세이프 ${insets.top.toFixed(1)} + 헤더 ${headerHeight.toFixed(1)}) = 창의 ${((measuredChrome / windowHeight) * 100).toFixed(1)}% · 식이 잡은 몫 ${budget.chrome.toFixed(1)}pt`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`대화 열 ${budget.column.toFixed(1)}pt = 목록 ${budget.list.toFixed(1)} + 입력창 ${budget.composer.toFixed(1)} — 목록 ≥ 입력창 ${budget.list >= budget.composer ? '참' : '거짓'}`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`상한 ${cap.toFixed(1)}pt = ${((cap - space.sm * 2 - 2) / row).toFixed(1)}줄 · ${COMPOSER_MAX_ROWS}줄이면 ${(COMPOSER_MAX_ROWS * row + INPUT_CHROME).toFixed(1)}pt · 실제 상자 ${boxHeight.toFixed(1)}pt`}
      </Text>
      <Text allowFontScaling={false} style={styles.probeRead}>
        {`글폭 ${Math.round(content)}pt 에서 끊기는 자리 — ${broken}`}
      </Text>
    </View>
  );
}

/** #2945 — 카드 위의 대화 한 줄(시안의 질문). */
const AI_CONNECT_ASK: Message = {
  ...MESSAGE,
  id: '00000000-0000-7000-8000-0000000029a5',
  body: '팀 에이전트가 대답을 안 하는데, 연결 상태 어디서 봐요?',
  thread: undefined,
};

/** #2945 — 운영자가 넣은 팀 키 하나(시안 「Anthropic · 팀 기본」). */
const AI_CONNECT_LINK: ProviderLink = {
  schema: 'momo.provider_link.v0',
  configured: true,
  source: 'database',
  mode: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  endpointLabel: 'Anthropic',
  bearerConfigured: true,
  bearerLast4: '7c1e',
  availability: 'external',
  keyConfigured: true,
  updatedAtMs: Date.UTC(2026, 10, 12),
  diagnostics: [],
};

// ---- #3166 MEM-M1: 놓친 대화 요약 카드 · 「기억 n개 참고」 칩 · 일시정지 -----------------
//
//   MEMORY-CARD-READY    안 읽은 동안 요약(3줄 + 근거 + 더 보기)
//   MEMORY-CARD-STATES   로딩 · 오류 · 요약 전 · 요약할 게 없음 · 꺼짐 (한 장에)
//   MEMORY-CHIP          에이전트 답 밑의 「기억 n개 참고」 칩(영수증은 캐시 씨앗)
//   MEMORY-SHEET         칩 시트 — 보류 개수가 있을 때
//   MEMORY-SHEET-PLAIN   칩 시트 — 보류 없음, 목록이 실린 수보다 짧을 때
//   MEMORY-PAUSE         프로필 시트의 「기억」 묶음(개인 일시정지)
//
// 서버 값은 만들어 낸 것이다(runtime-unverified): 실제 요약 데이터와 실기기는 없다.
const MEMORY_WS = 'measure-ws';
const MEMORY_CH = '00000000-0000-7000-8000-0000000000c1';
const MEMORY_RUN = '00000000-0000-7000-8000-0000000000d1';
function memoryDigest(id: string, from: number, body: string, evidence: number[]): MemoryDigest {
  return {
    id,
    channelId: MEMORY_CH,
    level: 'window',
    fromSeq: from,
    toSeq: from + 9,
    body,
    sourceCount: 10,
    createdAtMs: NOW - 3_600_000,
    evidence: evidence.map(seq => ({
      messageId: `00000000-0000-7000-8000-00000000${seq.toString().padStart(4, '0')}`,
      channelId: MEMORY_CH,
      seq,
    })),
  };
}
const MEMORY_DIGESTS: MemoryDigest[] = [
  memoryDigest('d1', 11, '- 배포 일정이 금요일 오후로 정해졌어요.\n- 롤백 절차는 지난주 문서 그대로 가기로 했어요.', [14, 18]),
  memoryDigest('d2', 21, '- 김인턴이 스테이징 점검 결과를 공유했고, 결제 화면 오류 한 건이 남았어요.', [24]),
];
const MEMORY_READY: MissedCardState = {kind: 'ready', digests: MEMORY_DIGESTS, partial: false};
const MEMORY_RECEIPT: MemoryReceipt = {
  runId: MEMORY_RUN,
  channelId: MEMORY_CH,
  servedCount: 3,
  digestIds: ['d1', 'd2'],
  digests: MEMORY_DIGESTS,
  withheldCount: 1,
  budgetChars: 6000,
  usedChars: 1800,
  createdAtMs: NOW,
};
const MEMORY_SETTINGS: MemorySettings = {
  workspace: {enabled: true, paused: false, resetEpoch: 0},
  channels: [],
  me: {paused: false},
};
const MEMORY_PROPOSAL_MSG_A = '00000000-0000-7000-8000-0000000000f1';
const MEMORY_PROPOSAL_MSG_B = '00000000-0000-7000-8000-0000000000f2';
const MEMORY_PROPOSAL: MemoryProposal = {
  id: '00000000-0000-7000-8000-000000000601',
  channelId: MEMORY_CH,
  runId: MEMORY_RUN,
  agentMemberId: AGENT,
  requesterMemberId: OTHER,
  kind: 'decision',
  status: 'pending',
  text: '배포는 매주 금요일 오후에 하고, 롤백은 지난주 문서 절차를 따라요.',
  evidenceMessageIds: [MEMORY_PROPOSAL_MSG_A, MEMORY_PROPOSAL_MSG_B],
  evidence: [
    {messageId: MEMORY_PROPOSAL_MSG_A, seq: 28, authorMemberId: OTHER},
    {messageId: MEMORY_PROPOSAL_MSG_B, seq: 29, authorMemberId: SELF},
  ],
  callerIsRequester: false,
  createdAtMs: NOW,
  // 카드는 실제 시계로 기한을 잰다(harness NOW는 과거다).
  expiresAtMs: Date.now() + 86_400_000,
};
function seedMemoryProposal(proposal: MemoryProposal): void {
  harnessClient.setQueryData(
    memoryKeys.proposals(MEMORY_WS, MEMORY_CH, MEMORY_RUN),
    [proposal],
  );
  harnessClient.setQueryData(
    memoryKeys.evidenceText(MEMORY_WS, MEMORY_CH, MEMORY_PROPOSAL_MSG_A),
    '이번 주부터 배포는 금요일 오후로 가요. 월요일 배포는 이제 안 해요.',
  );
  harnessClient.setQueryData(
    memoryKeys.evidenceText(MEMORY_WS, MEMORY_CH, MEMORY_PROPOSAL_MSG_B),
    '좋아요. 롤백은 지난주에 정리한 문서 그대로 갈게요.',
  );
}
const MEMORY_TURN: Message = {
  id: '00000000-0000-7000-8000-0000000000e1',
  channelId: MEMORY_CH,
  seq: 31,
  hlcTs: 31,
  hlcCount: 0,
  authorMemberId: AGENT,
  type: 'text',
  body: '배포는 금요일 오후로 잡혀 있고, 롤백 절차는 지난주 문서를 그대로 따르면 돼요.',
  state: 'sent',
  createdAtMs: NOW,
  props: {schema: 'momo.agent_gateway.timeline.v0', run_id: MEMORY_RUN},
};

function Frame({label, children}: {label: string; children: React.ReactNode}) {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * `Frame` 인데 바닥이 **실제 대화 화면의 바닥**이다 (#3921, design-review M1).
 *
 * `Frame` 은 `color.bg` 를 깐다. 대화 목록의 바닥은 다크에서 그 값이 맞지만 라이트에서는
 * `surface` 다(`ConversationScreen` 의 `screen`: 위 25% 에서 `canvasTop` 이 `surface` 로
 * 건너가는 그라디언트, 그 아래는 평평한 `surface`). 같은 틴트를 다른 바닥 위에서 찍으면
 * 사진도, 사진에서 잰 대비 숫자도 거짓이 된다 — 라이트 `warnSurface`(#FFF0DB)의 세기는
 * `bg` 위에서 1.04:1, 실제 지면 `surface` 위에서 1.11:1 이고 **방향도 다르다**.
 *
 * 배경식은 `ConversationScreen` 의 `screen` 과 **같은 식**을 옮겼다 — 한쪽을 고치면 이
 * 틀도 따라가야 사진이 거짓이 되지 않는다. 가운데 정렬은 점프가 행을 놓는 자리다
 * (`travelToIndex(index, 0.5, …)`: 목록 화면 가운데 → 그라디언트 아래, 평평한 바닥 위).
 */
function ConversationFloor({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.conversationFloor}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.conversationFloorMid}>{children}</View>
    </View>
  );
}


// ---- GC-7 (#2948): 에이전트가 제안한 AI 연결 카드 --------------------------------
//
//   AI-SUGGEST         대상 본인(운영자): 제안 머리 · 「맥에서」 한 줄 · 팀 줄 + 연결 확인
//   AI-SUGGEST-OTHERS  같은 제안을 운영자(한 줄 + 「팀 연결 보기」)와 그 밖의 멤버
//                      (한 줄만, 누를 것 0)가 보는 모습
//
// 팀 연결은 하네스 캐시에 씨앗으로 넣는다(운영자 = 200). 그 밖의 멤버는 씨앗이 없는
// 따로 된 캐시라 운영자 판정이 서지 않는다 — 한 줄만 남는다.
const AI_SUGGEST_LINK = {
  schema: 'momo.provider_link.v0',
  configured: true,
  source: 'database',
  mode: 'external-hermes',
  baseUrl: 'https://api.anthropic.com/v1',
  endpointLabel: 'Anthropic',
  bearerConfigured: true,
  bearerLast4: '7c1e',
  availability: 'live',
  keyConfigured: true,
  updatedAtMs: NOW - 3 * 86_400_000,
  diagnostics: [],
  presets: [],
};

function aiSuggestMessage(): Message {
  return {
    ...MESSAGE,
    id: '00000000-0000-7000-8000-0000000000c7',
    authorMemberId: AGENT,
    thread: undefined,
    body: '구독 로그인은 맥에서 해야 해요. 카드를 맥에서 열어 주세요.',
    props: {
      'momo.command_suggest': {
        v: 1,
        command_id: 'ai.connect',
        args: {},
        for_member_id: SELF,
        label: 'AI 연결',
      },
    },
  } as Message;
}

function settingsOpenMessage(section: string, label = '알림 설정 열기'): Message {
  return {
    ...MESSAGE,
    id: '00000000-0000-7000-8000-0000000000c8',
    authorMemberId: AGENT,
    thread: undefined,
    body: '알림은 설정에서 바꿀 수 있어요. 아래 카드로 열어 보세요.',
    props: {
      'momo.command_suggest': {
        v: 1,
        command_id: 'settings.open',
        args: {section},
        for_member_id: SELF,
        label,
      },
    },
  } as Message;
}

function aiSuggestActions(me: string) {
  return {
    myMemberId: me,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
  };
}

const aiSuggestOutsider = new QueryClient({
  defaultOptions: {queries: {retry: false, gcTime: 0}},
});

// ---- AX-7 (#2513) 픽스처: ADR-0186 부록 A·B 그대로 ----------------------------

/** 부록 A. 제안한 에이전트는 로스터의 에이전트이고, 요약은 서버가 그 이름으로 짓는다. */
const ACTION_APPROVAL_MESSAGE = {
  ...MESSAGE,
  id: '00000000-0000-7000-8000-0000000000b7',
  type: 'approval_request',
  body: 'Approve invite.create',
  authorMemberId: AGENT,
  // `MESSAGE` 는 답글 3개를 든다. 승인 카드에 스레드 롤업이 서면 사진이 이 배치가
  // 만든 적 없는 줄을 찍는다.
  thread: undefined,
  props: {
    approval_id: 'ap-1',
    action_type: 'workspace_action',
    status: 'pending',
    title: '팀원 초대 링크 만들기',
    summary:
      '김인턴이 제안했습니다. 승인하면 관리자 권한으로 초대 링크를 만듭니다.',
    action: {
      id: 'invite.create',
      rows: [
        {label: '역할', value: 'member'},
        {label: '사용 횟수', value: '1회'},
        {label: '만료', value: '7일'},
      ],
      rationale: '새 팀원 온보딩 요청',
      required_role: 'admin',
    },
  },
} as unknown as Message & {props: Record<string, unknown>};

/** 부록 B. `next` 는 정오표 뒤의 서버 값이다. 코드·URL 필드는 없다. */
const ACTION_RESULT_MESSAGE = {
  ...MESSAGE,
  id: '00000000-0000-7000-8000-0000000000b8',
  seq: 43,
  type: 'tool_result',
  body: '초대 링크를 만들었습니다.',
  authorMemberId: AGENT,
  thread: undefined,
  props: {
    'momo.action_result': {
      v: 1,
      action_id: 'invite.create',
      status: 'executed',
      approval_id: 'ap-1',
      decided_by: SELF,
      ref: {type: 'invite', id: '00000000-0000-7000-8000-0000000000f1'},
      rows: [
        {label: '역할', value: 'member'},
        {label: '만료', value: '2026-09-29'},
      ],
      secret_shown_once: true,
      next: {
        label: '설정 › 멤버와 초대에서 보기',
        href: '/settings?section=members',
      },
    },
  },
} as unknown as Message;

/** 원장이 「지금도 대기」라고 말하는 승인 — 컨트롤이 서는 조건(`approvalGate.ts`). */
const ACTION_GATES = new Map([
  ['ap-1', {approvalId: 'ap-1', reversible: false, expiresAtMs: null}],
]);

/**
 * 결정 POST 하나에만 서버처럼 답하는 가짜 (하네스 전용 · #2513).
 *
 * 403 뒤의 모습은 결정이 **실제로 나가야** 나온다 — `ApprovalDecision` 의 상태는
 * prop 으로 세울 수 없고, 세울 수 있게 만드는 것은 배송 컴포넌트에 하네스용 문을
 * 하나 더 내는 일이다. 대신 네트워크 끝에서 답한다. 결정 말고는 원래 `fetch` 로
 * 흘려보낸다(하네스의 쿼리는 꺼져 있어 실제로는 아무것도 안 나간다).
 */
function DecisionStub({
  status,
  body,
  children,
}: {
  status: number;
  body: unknown;
  children: React.ReactNode;
}): React.JSX.Element {
  React.useState(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/decision')) {
        return {
          status,
          ok: status >= 200 && status < 300,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      }
      return original(input, init);
    }) as typeof fetch;
    return null;
  });
  return <>{children}</>;
}

function Row({
  pinned = false,
  edited = false,
}: {pinned?: boolean; edited?: boolean} = {}) {
  return (
    <MessageRow
      // 이슈 #1149 M2 — 「수정됨」을 켤 수 있어야 한다. 아래 `pin-mark` 프레임의
      // 주석은 처음부터 「같은 줄에 나란히 설 때만 보인다」고 말했는데, 정작 씨앗
      // 메시지가 `sent` 라 그 프레임에 「수정됨」이 한 번도 서지 않았다. 주장만
      // 있고 사진이 없던 자리다.
      message={edited ? {...MESSAGE, state: 'edited'} : MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={CHIPS}
      // 이슈 #1146 M3. 기본값이 `false` 인 것은 이 하네스의 다른 표면 전부가
      // 고정과 무관하기 때문이다 — 그 사진들은 이 인자로 한 픽셀도 바뀌지 않는다.
      pinned={pinned}
      nowMs={NOW + 900_000}
      actions={{
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        onOpenThread: () => {},
        onTogglePin: async () => {},
      }}
    />
  );
}

/**
 * ADR-0155 — 자라다 만 답 한 줄.
 *
 * 본문은 **문장 중간에서 끊긴다**. 완성된 문장으로 찍으면 이 배치가 무엇을 고쳤는지
 * 사진에서 사라진다: 논점은 「반쪽 답이 완결된 답의 옷을 입지 않는가」이고, 그
 * 대비는 본문이 실제로 끊겨 있을 때만 눈에 온다.
 */
function StoppedRow({
  marker,
  runEnded = false,
}: {
  marker: Record<string, unknown>;
  runEnded?: boolean;
}) {
  return (
    <MessageRow
      message={{
        ...MESSAGE,
        id: `stop-${String(marker.rev)}-${String(marker.outcome ?? 'none')}`,
        body: '배포 로그를 보면 첫 번째 원인은',
        props: {'momo.stream': marker},
      }}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={NOW + 900_000}
      runEnded={runEnded}
    />
  );
}

/**
 * #1892 — 두 점프 필이 **함께** 선 순간, 그리고 각각을 누른 뒤의 착지.
 *
 * 이 장은 저 혼자 한 자리까지 간다: 진입 수렴이 바닥에 앉힌 뒤(최대 4초 — 여유를
 * 두고 3초) 목록 가운데로 옮기고, 거기서 남의 말 두 통을 더 받는다. 그러면 위
 * 필은 방을 연 순간의 수(28 — 구분선과 같은 수)를, 아래 필은 떠난 뒤 붙은
 * 수(2)를 말한다. 같은 낱말이 두 다른 모집단을 세는 것이 한 장에서 읽힌다 —
 * 그것이 「동결 N」이다.
 *
 * 누르는 것은 이 파일이 아니라 Maestro 가 한다(`maestro/91-jump-pills-capture.yaml`).
 * 누른 뒤의 착지를 찍으려면 정말로 눌러야 한다: 이 장이 스스로 스크롤해서
 * 「착지」를 흉내 내면, 사진은 필이 아니라 흉내를 찍는다.
 *
 * 문장은 한 팀의 배포 스레드다. 줄 길이가 들쭉날쭉한 것은 일부러다 — 한 줄짜리
 * 행만으로는 `scrollToIndex` 가 측정 안 된 행을 겨누는 회복 경로가 안 불린다.
 */
const JUMP_PILL_LINES = [
  '배포 체크리스트 공유합니다. 각자 담당 항목 확인 부탁드려요.',
  '인증 서버 설정은 제가 봤습니다.',
  '스테이징 데이터베이스 마이그레이션 0186 끝났습니다. 롤백 스크립트도 같이 올렸어요.',
  '좋아요.',
  'CDN 캐시 무효화는 배포 직후 한 번 더 돌리겠습니다.',
  '결제 모듈 회귀 테스트 312건 전부 통과했습니다. 느린 테스트 두 건은 따로 표시해 두었어요.',
  '확인했습니다.',
  '모바일 빌드는 오늘 저녁에 올라갑니다.',
] as const;

/** 고정된 동일성 — 판독 줄이 다시 그려질 때 컴포저까지 다시 그리지 않게. */
const NOOP = () => {};

const JUMP_PILL_COUNT = 40;
/** 떠난 뒤 도착하는 두 줄. 다른 줄과 겹치지 않는 본문 — 착지를 글자로 확인한다. */
const JUMP_PILL_ARRIVALS = [
  '롤백 리허설 끝났습니다. 이상 없어요.',
  '배포 창 10시 확정으로 공지 올렸습니다.',
] as const;
/** 커서. 구분선은 이 다음 줄 위에 선다. */
const JUMP_PILL_CURSOR = 12;

function jumpPillMessage(seq: number): Message {
  const line = JUMP_PILL_LINES[seq % JUMP_PILL_LINES.length];
  return {
    ...MESSAGE,
    id: `00000000-0000-7000-8000-${String(1892_000 + seq).padStart(12, '0')}`,
    seq,
    hlcTs: seq,
    authorMemberId: seq % 3 === 0 ? SELF : seq % 3 === 1 ? OTHER : AGENT,
    body: seq % 5 === 0 ? `${line}\n${JUMP_PILL_LINES[(seq + 3) % JUMP_PILL_LINES.length]}` : line,
    createdAtMs: NOW + seq * 60_000,
    thread: undefined,
  };
}

const JUMP_PILL_HISTORY: Message[] = Array.from(
  {length: JUMP_PILL_COUNT},
  (_, i) => jumpPillMessage(i + 1),
);

function JumpPillsStage(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const listRef = React.useRef<unknown>(null);
  const metricsRef = React.useRef<TimelineGeometry | null>(null);
  const pillsRef = React.useRef<PillState | null>(null);
  const [messages, setMessages] = React.useState<Message[]>(JUMP_PILL_HISTORY);
  const [geometryLine, setGeometryLine] = React.useState('기하 측정 중…');
  const [traceLine, setTraceLine] = React.useState('');
  React.useEffect(() => {
    const move = setTimeout(() => {
      const geometry = metricsRef.current;
      if (geometry === null || geometry.contentHeight <= 0) return;
      (
        listRef.current as {
          scrollToOffset?: (options: {offset: number; animated: boolean}) => void;
        } | null
      )?.scrollToOffset?.({
        offset: Math.max(
          0,
          geometry.contentHeight * 0.55 - geometry.viewportHeight / 2,
        ),
        animated: false,
      });
    }, 3000);
    // 남의 말 두 통. 내 말이었다면 아래 필은 세지 않는다(웹 M-3 과 같은 판정).
    // 본문이 다른 줄과 겹치지 않는 것은 일부러다: Maestro 가 「아래 필을 누른 뒤
    // 이 두 줄이 화면에 있는가」를 **글자로** 기다린다 — 착지의 증거가 좌표가
    // 아니라 도착한 줄 자체다.
    const arrive = setTimeout(() => {
      setMessages(current => [
        ...current,
        {
          ...jumpPillMessage(JUMP_PILL_COUNT + 1),
          authorMemberId: OTHER,
          body: JUMP_PILL_ARRIVALS[0],
        },
        {
          ...jumpPillMessage(JUMP_PILL_COUNT + 2),
          authorMemberId: AGENT,
          body: JUMP_PILL_ARRIVALS[1],
        },
      ]);
    }, 3800);
    // 목록이 스스로 보고한 기하를 사진 위에 적는다. 「착지했다」는 그림만으로는
    // 반쯤만 증명된다 — 끝까지 남은 거리가 숫자로 함께 찍혀야 한다. 둘째 줄은
    // 오프셋이 바뀐 순간들의 기록이다(이전 변화로부터의 ms → 오프셋/콘텐츠). 한
    // 장의 사진이 「어디에 섰나」뿐 아니라 「어떻게 거기 갔나」도 말한다.
    //
    // 표본은 40ms 마다 **ref 에만** 쌓고, 화면에 옮기는 것은 250ms 마다다. 표본마다
    // 상태를 바꾸면 이 장이 초당 스물다섯 번 다시 그려지고, 그 JS 부하가 재려는
    // 스크롤 자체를 늦춘다(첫 판이 그랬다 — 진입 수렴이 끝을 162pt 앞두고 멈췄다).
    let last: number | null = null;
    let lastAt = 0;
    const changes: string[] = [];
    let line = '';
    const sample = setInterval(() => {
      const geometry = metricsRef.current;
      if (geometry === null) return;
      const offset = Math.round(geometry.offsetY);
      const content = Math.round(geometry.contentHeight);
      const left = content - (offset + Math.round(geometry.viewportHeight));
      line = `오프셋 ${offset} · 콘텐츠 ${content} · 창 ${Math.round(
        geometry.viewportHeight,
      )} · 끝까지 ${left}`;
      if (offset !== last) {
        const now = Date.now();
        changes.push(`+${last === null ? 0 : now - lastAt}→${offset}/${content}`);
        if (changes.length > 7) changes.shift();
        last = offset;
        lastAt = now;
      }
    }, 40);
    const readout = setInterval(() => {
      const pills = pillsRef.current;
      const verdict =
        pills === null
          ? ''
          : ` · 구분선 ${pills.relation ?? '미보고'} · 래치 ${
              pills.latched ? pills.latchNote ?? '예' : '아니오'
            } · 앉음 ${pills.settled ? '예' : '아니오'}`;
      const next = line === '' ? '' : line + verdict;
      setGeometryLine(current => (current === next || next === '' ? current : next));
      const trace = changes.join(' ');
      setTraceLine(current => (current === trace ? current : trace));
    }, 250);
    return () => {
      clearTimeout(move);
      clearTimeout(arrive);
      clearInterval(sample);
      clearInterval(readout);
    };
  }, []);
  return (
    <Screen>
      <Text style={styles.label}>
        위 = 연 순간의 안읽음(동결 28) · 아래 = 떠난 뒤 붙은 남의 말 (#1892)
      </Text>
      <Text style={styles.label} testID="jump-pills-geometry">
        {geometryLine}
      </Text>
      <Text style={styles.label} numberOfLines={2}>
        {traceLine}
      </Text>
      <ScreenHeader title="배포" onBack={NOOP} titleTestID="measure-title" />
      <ConversationLayout
        list={
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            channelKind="public"
            myMemberId={SELF}
            nowMs={NOW + 3_000_000}
            lastReadSeq={JUMP_PILL_CURSOR}
            unreadCount={JUMP_PILL_COUNT - JUMP_PILL_CURSOR}
            jumpPills
            pillsRef={pillsRef}
            metricsRef={metricsRef}
            listRef={listRef as never}
          />
        }
        composer={
          <Composer
            recipient="place"
            channelLabel="배포"
            directory={DIRECTORY}
            draftKey="measure:jump-pills"
            onSend={NOOP}
          />
        }
      />
    </Screen>
  );
}

// =============================================================================
// #1892 R1 — 방을 **옮긴 뒤**의 두 필, 그리고 다른 방으로의 착지
// (design-review 2594 H-1 · M-1 · M-4).
//
// 앱의 순서를 그대로 재연한다. 대화 화면은 방을 옮길 때 목록을 언마운트하지 않고
// (`channelId` 만 바뀐다), `useTimeline` 은 **효과에서** 비운다. 그래서 목록이 보는
// 것은 늘 세 렌더다:
//
//   switch   새 방 id + 앞 방의 행
//   loading  새 방 id + 빈 메시지
//   b        새 방의 첫 페이지
//
// 새 방에서는 에이전트가 일하고 있어 「작업 중」 자리가 셋 내내 목록을 붙잡는다 —
// 리뷰가 짚은, 목록이 한 번도 비지 않는 판이다.
//
// 앞 방은 짧다. 바닥에 앉은 자리에서 구분선이 보여 래치가 걸린다(판독 줄 「래치
// seen@…」). 그 래치가 새 방으로 넘어오면 새 방의 「안읽음으로」가 서지 않는다 —
// 사진이 그것을 잰다. 누르는 것과 키보드를 올리는 것은 Maestro 가 한다
// (`maestro/93-jump-pills-rooms-capture.yaml`, 착지는 `94-`).
//
// `land` 가 `middle` 이면 새 방의 첫 페이지와 **같은 렌더에서** 그 방 가운데 줄로
// 가는 점프를 건다(ADE 「대화로」). 새 목록의 첫 레이아웃 보고보다 점프가 먼저 오는
// 순서다 — 첫 판에서는 늦게 온 그 보고가 진입 수렴을 태워 목록을 바닥으로 끌었다
// (R1 M-1).
//
// `end` 면 같은 자리에서 **가장 새 메시지**로 간다 — #2584 이후 가장 흔한 알림 탭
// 착지다(design-review 2594 R2 H-A). 목표는 끝에 clamp 되고, R2 는 거기서 「최신
// 메시지로 이동」을 세운 채 따라가기를 끈 채로 두었다. 착지하고 9초 뒤 남의 말이 한
// 통 붙는다 — 목록이 그것을 따라가야 한다(`maestro/95-`).
// =============================================================================

type RoomPhase = 'a' | 'switch' | 'loading' | 'b';

const ROOM_A_COUNT = 6;
/** 앞 방의 커서. 안읽음 두 줄 — 바닥에 앉으면 구분선이 창 안이다. */
const ROOM_A_CURSOR = 4;
/** 새 방의 커서와 수 — 바닥에 앉으면 구분선은 창 위쪽 밖이다. */
const ROOM_B_CURSOR = JUMP_PILL_CURSOR;
/** 다른 방 착지의 목적지. 다른 줄과 겹치지 않는 본문 — 착지를 글자로 확인한다. */
const ROOM_B_LANDING_SEQ = 24;
const ROOM_B_LANDING_BODY = '롤백 리허설 일정은 목요일 오후로 잡았습니다.';

function roomMessage(room: 'a' | 'b', seq: number): Message {
  const base = jumpPillMessage(seq);
  return {
    ...base,
    id: `00000000-0000-7000-8${room === 'a' ? 'a' : 'b'}00-${String(
      1892_000 + seq,
    ).padStart(12, '0')}`,
    channelId: room === 'a' ? 'room-a' : 'room-b',
    body:
      room === 'b' && seq === ROOM_B_LANDING_SEQ ? ROOM_B_LANDING_BODY : base.body,
  };
}

const ROOM_A_HISTORY: Message[] = Array.from({length: ROOM_A_COUNT}, (_, i) =>
  roomMessage('a', i + 1),
);
const ROOM_B_HISTORY: Message[] = Array.from({length: JUMP_PILL_COUNT}, (_, i) =>
  roomMessage('b', i + 1),
);
/** 새 방에서 일하는 에이전트 — 이 자리가 목록을 붙잡는다. 동일성 고정. */
const ROOM_B_WORKING = [{memberId: AGENT}] as const;
const ROOM_B_LANDING = {
  messageId: ROOM_B_HISTORY[ROOM_B_LANDING_SEQ - 1].id,
  seq: ROOM_B_LANDING_SEQ,
  token: 1,
};

/** 끝 근처 착지(R2 H-A)의 목적지 — 가장 새 메시지. 본문으로 착지를 확인한다. */
const ROOM_B_NEWEST_BODY = '오늘 배포 마무리 공지 올렸습니다.';
/** 착지 뒤 도착하는 남의 말. 목록이 따라가는지 본문으로 확인한다. */
const ROOM_B_ARRIVAL_BODY = '방금 배포 창 닫혔습니다. 모두 수고하셨어요.';
const ROOM_B_END_HISTORY: Message[] = ROOM_B_HISTORY.map(message =>
  message.seq === JUMP_PILL_COUNT ? {...message, body: ROOM_B_NEWEST_BODY} : message,
);
const ROOM_B_ARRIVAL: Message = {
  ...roomMessage('b', JUMP_PILL_COUNT + 1),
  authorMemberId: OTHER,
  body: ROOM_B_ARRIVAL_BODY,
};
const ROOM_B_WITH_ARRIVAL: Message[] = [...ROOM_B_END_HISTORY, ROOM_B_ARRIVAL];
const ROOM_B_LANDING_END = {
  messageId: ROOM_B_END_HISTORY[JUMP_PILL_COUNT - 1].id,
  seq: JUMP_PILL_COUNT,
  token: 1,
};

function JumpPillsRoomsStage({
  land,
}: {
  land: 'none' | 'middle' | 'end';
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const listRef = React.useRef<unknown>(null);
  const metricsRef = React.useRef<TimelineGeometry | null>(null);
  const pillsRef = React.useRef<PillState | null>(null);
  const [phase, setPhase] = React.useState<RoomPhase>('a');
  const [arrived, setArrived] = React.useState(false);
  const [readout, setReadout] = React.useState('기하 측정 중…');
  const [trace, setTrace] = React.useState('');
  React.useEffect(() => {
    if (land !== 'end') return undefined;
    // 새 방의 첫 페이지(9초)와 착지 뒤, 흐름이 착지를 한 장 찍을 시간을 둔다. Maestro
    // 드라이버가 뜨는 데만 몇 초가 들어서, 12초로는 착지 사진에 이미 이 줄이 찍혔다.
    const arrive = setTimeout(() => setArrived(true), 18000);
    return () => clearTimeout(arrive);
  }, [land]);
  React.useEffect(() => {
    // 앞 방에서 진입 수렴이 앉고(최대 4초) 래치가 걸릴 시간, 그리고 Maestro 가
    // 드라이버를 띄워 앞 방을 한 장 찍을 시간을 둔다(3초로는 흐름이 첫 판독을 하기
    // 전에 방이 바뀌었다).
    const toSwitch = setTimeout(() => setPhase('switch'), 8000);
    const toLoading = setTimeout(() => setPhase('loading'), 8300);
    const toB = setTimeout(() => setPhase('b'), 9000);
    // 오프셋이 바뀐 순간들(`JumpPillsStage` 와 같은 기록): 새 방에서 목록이 **어떻게**
    // 거기 갔는지. 표본은 40ms 마다 ref 에만 쌓고, 화면에는 250ms 마다 옮긴다 —
    // 표본마다 상태를 바꾸면 재려는 스크롤을 늦춘다.
    let last: number | null = null;
    let lastAt = 0;
    const changes: string[] = [];
    const sample = setInterval(() => {
      const geometry = metricsRef.current;
      if (geometry === null) return;
      const offset = Math.round(geometry.offsetY);
      if (offset === last) return;
      const now = Date.now();
      changes.push(
        `+${last === null ? 0 : now - lastAt}→${offset}/${Math.round(
          geometry.contentHeight,
        )}`,
      );
      if (changes.length > 9) changes.shift();
      last = offset;
      lastAt = now;
    }, 40);
    const tick = setInterval(() => {
      const geometry = metricsRef.current;
      const pills = pillsRef.current;
      if (geometry === null || pills === null) return;
      const left = Math.round(
        geometry.contentHeight - (geometry.offsetY + geometry.viewportHeight),
      );
      const next = `끝까지 ${left} · 구분선 ${pills.relation ?? '미보고'} · 래치 ${
        pills.latched ? pills.latchNote ?? '예' : '아니오'
      } · 앉음 ${pills.settled ? '예' : '아니오'}`;
      setReadout(current => (current === next ? current : next));
      const joined = changes.join(' ');
      setTrace(current => (current === joined ? current : joined));
    }, 250);
    return () => {
      clearTimeout(toSwitch);
      clearTimeout(toLoading);
      clearTimeout(toB);
      clearInterval(sample);
      clearInterval(tick);
    };
  }, []);
  const inB = phase !== 'a';
  const roomB =
    land === 'end'
      ? arrived
        ? ROOM_B_WITH_ARRIVAL
        : ROOM_B_END_HISTORY
      : ROOM_B_HISTORY;
  const messages =
    phase === 'a' || phase === 'switch'
      ? ROOM_A_HISTORY
      : phase === 'loading'
        ? []
        : roomB;
  const landing =
    phase !== 'b'
      ? undefined
      : land === 'middle'
        ? ROOM_B_LANDING
        : land === 'end'
          ? ROOM_B_LANDING_END
          : undefined;
  return (
    <Screen>
      <Text style={styles.label} testID="jump-pills-rooms-phase">
        {`방 ${inB ? 'B' : 'A'} · 단계 ${phase}${
          land === 'middle'
            ? ' · 다른 방 착지'
            : land === 'end'
              ? ' · 끝 근처 착지'
              : ''
        } (#1892 R1)`}
      </Text>
      <Text style={styles.label} testID="jump-pills-rooms-readout">
        {readout}
      </Text>
      <Text style={styles.label} numberOfLines={2}>
        {trace}
      </Text>
      <ScreenHeader
        title={inB ? '배포' : '디자인'}
        onBack={NOOP}
        titleTestID="measure-title"
      />
      <ConversationLayout
        list={
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status={phase === 'loading' ? 'loading' : 'ready'}
            channelId={inB ? 'room-b' : 'room-a'}
            channelKind="public"
            myMemberId={SELF}
            nowMs={NOW + 3_000_000}
            lastReadSeq={inB ? ROOM_B_CURSOR : ROOM_A_CURSOR}
            unreadCount={
              inB
                ? JUMP_PILL_COUNT - ROOM_B_CURSOR
                : ROOM_A_COUNT - ROOM_A_CURSOR
            }
            working={inB ? ROOM_B_WORKING : undefined}
            jumpTarget={landing}
            jumpPills
            pillsRef={pillsRef}
            metricsRef={metricsRef}
            listRef={listRef as never}
          />
        }
        composer={
          <Composer
            recipient="place"
            channelLabel={inB ? '배포' : '디자인'}
            directory={DIRECTORY}
            draftKey="measure:jump-pills-rooms"
            onSend={NOOP}
          />
        }
      />
    </Screen>
  );
}

// #4937: 하네스에는 언어 provider 가 없어서 사전을 읽는 새 화면은 영어 문장으로 선다. 소식 판은 언어를 정해 세워 앱 화면과
// 같은 말로 그린다(`-en` 판은 영어 UI). 공장은 모듈 값이다: 렌더마다 새 공장이면 provider 가 사전을 다시 읽는다.
const releaseNotesKo = () =>
  createMobileLocaleController({
    port: {
      readPreference: () => 'ko-KR',
      writePreference: () => {},
      readDevice: () => ({languages: ['ko-KR'], timeZone: 'Asia/Seoul'}),
    },
  });
const releaseNotesEn = () =>
  createMobileLocaleController({
    port: {
      readPreference: () => 'en-US',
      writePreference: () => {},
      readDevice: () => ({languages: ['en-US'], timeZone: 'Asia/Seoul'}),
    },
  });

export function Surface({name}: {name: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 이슈 #1112 — 고정 여부만 다른 두 시트. 낱말이 상태를 따라 뒤집히는 것을 한
  // 프레임 안에서 비교하려고 인자를 받는다.
  const pinSheet = (pinned: boolean) => (
    <MessageActionSheet
      message={MESSAGE}
      chips={CHIPS}
      availability={AVAILABILITY}
      pinned={pinned}
      authorLabel="이도현"
      onClose={() => {}}
      onToggleReaction={() => {}}
      onReply={() => {}}
      onQuote={() => {}}
      onCopy={() => {}}
      onPin={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />
  );
  const sheet = (confirm: boolean) => (
    <MessageActionSheet
      message={MESSAGE}
      chips={CHIPS}
      availability={AVAILABILITY}
      authorLabel="이도현"
      startInDeleteConfirm={confirm}
      onClose={() => {}}
      onToggleReaction={() => {}}
      onReply={() => {}}
      // 이 둘이 빠져 있었다. `onQuote`/`onCopy` 가 없으면 시트가 그 줄을 아예
      // 안 그리므로(`availability.quote && onQuote`), 사진 속 시트는 **배송되는
      // 시트보다 두 줄 짧았다** — 큰 접근성 글자에서 넘침을 보려던 M-7 증거가
      // 하필 넘치지 않는 시트를 찍고 있었다. AX5 캡처가 이 결함을 드러냈다.
      onQuote={() => {}}
      onCopy={() => {}}
      // 이슈 #1112. 같은 함정을 되풀이하지 않으려고 함께 넘긴다 — `onPin` 이
      // 없으면 시트가 그 줄을 안 그리고, 사진 속 시트가 또 배송본보다 짧아진다.
      onPin={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />
  );

  // ---- U4-2 (N-8): 이번 배치가 만든 표면들 ----------------------------------
  //
  // 인용 블록은 **행 안에** 세운다. 따로 띄우면 이 배치가 고친 것(H-2 — 인용이
  // 행 위에서 어떤 무게로 앉는가)이 사진에 안 나온다.
  const quoted = (block: QuoteBlockModel) => (
    <MessageRow
      message={MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={CHIPS}
      nowMs={NOW}
      quote={block}
    />
  );

  // #3962: 당겨서 새로고침. 계측(`pull-probe`·`pull-hold-*`)과 캡처 표면(`pull-refresh*`).
  if (name === 'pull-probe') return <PullProbe />;
  if (name.startsWith('pull-hold-')) return <PullHold which={name.slice('pull-hold-'.length)} />;
  if (name.startsWith('pull-refresh')) {
    return <PullRefreshSurface which={name.slice('pull-refresh'.length).replace(/^-/, '')} />;
  }
  if (name.startsWith('device-key-')) {
    return <DeviceKeySurface which={name.slice('device-key-'.length)} />;
  }
  // #4318: 공용 시트·페이지 부품 전시 + 이전한 시트(`measure/sheetKit.tsx`, 고정 데이터·가상 인물).
  if (name === 'sheetkit' || name.startsWith('sheetkit-')) {
    return <SheetKitSurface which={name.slice('sheetkit'.length).replace(/^-/, '')} />;
  }
  // #4319: 다른 사람 프로필 시트(`measure/profileSheet.tsx`, 배송되는 시트 + 고정 데이터·합성 사진, 가상 인물).
  if (name === 'profilesheet' || name.startsWith('profilesheet-')) {
    return <ProfileSheetSurface which={name.slice('profilesheet'.length).replace(/^-/, '')} />;
  }
  // #4319: 대화 머리 ⋮ 시트(`measure/conversationMenu.tsx`, 배송되는 시트 + 고정 데이터, 가상 인물).
  if (name === 'convmenu' || name.startsWith('convmenu-')) {
    return <ConversationMenuSurface which={name.slice('convmenu'.length).replace(/^-/, '')} />;
  }
  // #4319: 대화 머리 가운데 이름·상태 알약(`measure/conversationHeader.tsx`, 배송되는 머리 + 고정 데이터, 가상 인물).
  if (name === 'convheader' || name.startsWith('convheader-')) {
    return <ConversationHeaderSurface which={name.slice('convheader'.length).replace(/^-/, '')} />;
  }
  // #4319: 대화·채널 정보 페이지(`measure/conversationInfoPage.tsx`, 배송되는 페이지 + 고정 데이터·합성 사진, 가상 인물).
  if (name === 'infopage' || name.startsWith('infopage-')) {
    return <ConversationInfoPageSurface which={name.slice('infopage'.length).replace(/^-/, '')} />;
  }
  // #4612: 시트 끌어내려 닫기 계측(`measure/sheetDrag.tsx`, 배송되는 시트 + 결정 2 probe, 가상 인물).
  if (name === 'sheetdrag' || name.startsWith('sheetdrag-')) {
    return <SheetDragSurface which={name.slice('sheetdrag'.length).replace(/^-/, '')} />;
  }
  // #3951: 폰 「앱」 읽기 화면(목록·상세·네 상태).
  if (name.startsWith('apps-') && !name.startsWith('apps-tail')) {
    return <AppsSurface which={name.slice('apps-'.length)} />;
  }
  // #3950: 「쓴 앱」 꼬리·막힘 문장(실제 MessageRow).
  if (name.startsWith('apps-tail')) {
    return <AppsTailSurface which={name.slice('apps-tail'.length).replace(/^-/, '')} />;
  }
  // #4300: 말풍선 대화 + 눌림·착지 강조 면(실제 MessageRow).
  // #4894: 말풍선 글 잘림 — 여러 폭의 칸에 실제 MessageRow 를 세우고 네이티브가 낸 틀을 숫자로 적는다(`bubbleClip.tsx`).
  if (name.startsWith('bubble-clip')) {
    return <BubbleClipSurface which={name.slice('bubble-clip'.length).replace(/^-/, '')} />;
  }
  if (name.startsWith('bubble-')) return <BubbleSurface which={name.slice('bubble-'.length)} />;
  // #4016: DM 대화 화면(실제 머리·레이아웃·타임라인·컴포저).
  if (name.startsWith('dm-conversation')) {
    return <DmConversationSurface which={name.slice('dm-conversation'.length).replace(/^-/, '')} />;
  }
  // #4613: 활동 줄 높이 표 — 글자(N초째·생존 판정 라벨·앞에 m건)별 줄 수. 초가 바뀔 때 줄 수가 뒤집히는 글자가 있는가.
  if (name === 'activity-rows' || name === 'activity-rows-wide') return <ActivityRowsSurface wide={name === 'activity-rows-wide'} />;
  // #4292: 실시간 이벤트(재연결·복구·상대 메시지)를 재생하며 맨 아래 메시지의 창 좌표를 매 프레임 잰다.
  if (name.startsWith('dm-steady')) {
    return <SteadySurface which={name.slice('dm-steady'.length).replace(/^-/, '')} />;
  }
  // #4264: 마지막 행 아래 → 알약 위 간격. 대화 화면의 도크 스택 그대로 + 레이아웃 값 계측.
  if (name === 'gap' || name.startsWith('gap-')) {
    return <DockGapSurface which={name.slice('gap'.length).replace(/^-/, '')} />;
  }
  // #4614: 대화 목록을 눌러 자판·입력창을 내린다. 대화 화면 그대로(행이 눌리는 `actions` 포함) + 터치·자판 기록.
  if (name === 'tap' || name.startsWith('tap-')) {
    return <TapDismissSurface which={name.slice('tap'.length).replace(/^-/, '')} />;
  }
  // #4689: 멀리 올라간 채 아래 알약 「최신으로」를 누르면 마지막 메시지가 보이기까지 얼마나 걸리고 몇 번에 나눠 내려가는가. 진짜 대화 화면 + 스크롤 기록(`measure/jumpLatest.tsx`).
  if (name === 'jump-latest' || name.startsWith('jump-latest-') || name.startsWith('jump-latest+')) {
    return <JumpLatestSurface which={name.slice('jump-latest'.length).replace(/^[-+]/, '')} />;
  }
  // #4690: 스레드 패널(답글 0개·2개). 배송되는 `ThreadPanel` 그대로 + 고정 데이터·가상 인물.
  if (name === 'thread' || name.startsWith('thread-')) {
    return <ThreadPanelSurface which={name.slice('thread'.length).replace(/^-/, '')} />;
  }
  // #4321: 「가 ⏎ 나」를 보내면 줄바꿈이 어느 단계에서 사라지는가. 배송되는 컴포저 + 맨 입력창 + 모의 API.
  if (name === 'composer-newline' || name.startsWith('composer-newline-')) {
    return <ComposerNewlineSurface which={name.slice('composer-newline'.length).replace(/^-/, '')} />;
  }
  // #4181: 사진 카드(첨부 메뉴가 변신해 도착하는 최근 사진 그리드). 실제 카드·진짜 PhotoKit 포트.
  if (name.startsWith('photo-card')) {
    return <PhotoCardSurface which={name.slice('photo-card'.length).replace(/^-/, '')} />;
  }
  // #3961: 오르트 로더. 연결 띠·첫 로딩은 실제 컴포넌트(`measure/oortLoader.tsx`).
  if (name.startsWith('oort-loader')) {
    return <OortLoaderSurface which={name.slice('oort-loader'.length).replace(/^-/, '')} />;
  }
  if (name.startsWith('signed-work-')) {
    return <SignedWorkSurface which={name.slice('signed-work-'.length)} />;
  }
  // N3 (#3595): 작업 상세의 「대화」 모드. 배송되는 말풍선·입력창을 고정 데이터로 세운다.
  if (name.startsWith('work-chat')) {
    return <WorkChatSurface which={name.slice('work-chat'.length).replace(/^-/, '')} />;
  }
  // #3925: 첫 실행 알림 단계(M3). 배송되는 화면에 상태별 값을 건넨다.
  if (name.startsWith('notify-primer')) {
    return (
      <NotifyPrimerSurface which={name.slice('notify-primer'.length).replace(/^-/, '')} />
    );
  }

  // #4180: 첨부 메뉴(+ 원에서 펼쳐지는 카드). 실제 머리·타임라인·컴포저, 여는 것은 Maestro 의 실제 탭.
  if (name.startsWith('attach-menu')) {
    return <AttachMenuSurface which={name.slice('attach-menu'.length).replace(/^-/, '')} />;
  }

  // #4293: 사진 뷰어(안전 영역·아래로 쓸어 닫기). 실제 대화에 사진 메시지, 여는 것은 Maestro 의 실제 탭.
  if (name.startsWith('photo-viewer')) {
    return <PhotoViewerSurface which={name.slice('photo-viewer'.length).replace(/^-/, '')} />;
  }

  // #4394: member.avatar.set 승인 카드(제안된 사진·본인만 볼 수 있다는 줄). 사진은 avatar-stub.mjs 가 답한다.
  if (name.startsWith('avatar-approval')) {
    return <AvatarApprovalSurface which={name.slice('avatar-approval'.length).replace(/^-/, '')} />;
  }

  // #4705: 먼저 제안한 고정 카드(꼬리표 · 에이전트가 쓴 글 · 전문 보기)와 만료 스윕 줄.
  if (name.startsWith('pin-approval')) {
    return <PinApprovalSurface which={name.slice('pin-approval'.length).replace(/^-/, '')} />;
  }

  // #4526: 화면 모드의 기본·저장·시스템 추종. 안쪽에 진짜 ThemeProvider 를 세운다(바깥 FixedScheme 을 이긴다).
  if (name === 'theme-live') return <ThemeLiveSurface />;

  // #4285: 아무도 가져가지 않은 요청 — 홈 「작업 중」 카드와 대화 아래 활동 줄(「아직 받지 않았어요」·「취소」).
  if (isUncollectedSurface(name)) {
    return <UncollectedSurface name={name} />;
  }

  switch (name) {
    // #3824: 보낸 메시지 아래 상태 줄과 폰의 작업 기록 시트.
    case 'run-status':
      return <RunStatusSurface />;
    case 'run-ledger':
      return <RunLedgerSurface />;
    // #4020: 영수증은 사람이 알아야 하는 상태에만 서고, 컴포저 위가 「답하는 중」을 말한다.
    case 'responding':
      return <RespondingSurface />;
    case 'quote-ready': {
      const draft = quoteDraftFor({
        ...MESSAGE,
        id: 'orig-1',
        seq: 4,
        // 원본은 **타인**이 썼다 (N-7). `MESSAGE` 를 그대로 펼치면 저자가
        // `SELF` 라 행 저자와 인용 저자가 같은 이름으로 찍힌다.
        authorMemberId: OTHER,
        body: '릴레이가 pool exhausted 로 멈췄습니다. 재시작이 필요합니다.',
      });
      return (
        <Frame label="인용 · 정상 — 중성 규정선, 배경 없음 (H-2)">
          {draft ? quoted(draft.block) : <View />}
        </Frame>
      );
    }
    case 'quote-deleted':
      return (
        <Frame label="인용 · 삭제된 원본 — 사본을 남기지 않는다">
          {/* 인용 원본의 저자는 **타인**이다 (design-review N-7). 첫 판은
              `SELF` 였고, 그래서 사진에서 행 저자와 인용 저자가 둘 다 같은
              이름으로 나왔다 — 자기 말을 자기가 인용하는 화면은 이 기능이
              실제로 쓰이는 모양이 아니고, 「누가 한 말인가」가 보이지 않아
              인용 머리줄이 무슨 일을 하는지도 안 보인다. */}
          {quoted({
            kind: 'deleted',
            targetId: 'orig-1',
            targetSeq: 4,
            authorMemberId: OTHER,
          })}
        </Frame>
      );
    case 'quote-unresolved':
      return (
        <Frame label="인용 · 아직 못 푼 원본 — 삭제라고 부르지 않는다">
          {quoted({kind: 'unresolved', targetId: 'orig-1', targetSeq: null})}
        </Frame>
      );
    // ---- U4-3 (#1079): 최종 리뷰가 지목한 잔여 위상 --------------------------
    case 'typing-empty':
      return (
        <Frame label="작성 중 · 아무도 안 침 — 자리는 그대로 (H-3)">
          {/* `typing-one` 과 **나란히 놓고 보라**는 것이 이 사진의 용도다.
              H-3 이 주장하는 것은 「줄이 뜨고 질 때 컴포저가 안 움직인다」이고,
              그 주장은 두 장의 높이가 같을 때만 참이다. 한 장으로는 증명이
              안 되므로 두 장이 한 쌍이다. */}
          <TypingBar segments={[]} />
        </Frame>
      );
    case 'jump-missed':
      return (
        <Frame label="점프 실패 — 실패가 아니라 사실 진술이다 (H-5 · #1193 · #1196)">
          {/* 두 이유를 **함께** 세운다. 이 고지의 설계 논점이 「어디 있는지
              모르면 모른다고 말한다」인데, 한 장만 찍으면 그 대비가 안 보인다.
              문장은 화면이 쓰는 것과 **같은 상수**에서 온다.

              세 번째 줄이 #1193 리뷰 M3 이다: 같은 기계를 ADE 카드의 「대화로」도
              타는데, 그 사람은 인용을 누른 적이 없다. 주어가 갈렸다는 사실은
              **두 문장을 나란히 놓아야** 보이고, 사진이 없으면 그 갈래는 코드에만
              있는 주장으로 남는다.

              넷째·다섯째가 #1196 이다. 고정과 검색 진입이 여태 인용의 낱말을
              빌려 쓰고 있었고(고정) 화면 안에 따로 적혀 있었다(검색). 이제 넷이
              한 기계·한 상자를 쓰므로, **다섯 문장이 한 장에 나란히** 서는 이
              사진이 「주어만 갈리고 나머지는 같다」의 증거가 된다.

              그리고 이 사진은 N-b 의 증거이기도 하다: 가장 긴 제목(세션)이 마지막
              한 음절만 남기고 끊기던 것을 `hangul-word` 로 고쳤고, 그 결과는
              픽셀에만 있다. */}
          <View style={styles.noticeStack}>
            <NoticeBlock
              headline={jumpMissedNotice('older').headline}
              detail={jumpMissedNotice('older').detail}
              onDismiss={() => {}}
              testID="jump-missed"
            />
            <NoticeBlock
              headline={jumpMissedNotice('unknown').headline}
              detail={jumpMissedNotice('unknown').detail}
              onDismiss={() => {}}
              testID="jump-missed-unknown"
            />
            <NoticeBlock
              headline={jumpMissedNotice('unknown', 'session').headline}
              detail={jumpMissedNotice('unknown', 'session').detail}
              onDismiss={() => {}}
              testID="jump-missed-session"
            />
            <NoticeBlock
              headline={jumpMissedNotice('older', 'pin').headline}
              detail={jumpMissedNotice('older', 'pin').detail}
              onDismiss={() => {}}
              testID="jump-missed-pin"
            />
            <NoticeBlock
              headline={jumpMissedNotice('older', 'search').headline}
              detail={jumpMissedNotice('older', 'search').detail}
              onDismiss={() => {}}
              testID="jump-missed-search"
            />
            {/* 여섯째가 #2569 다 — 알림 본문 탭. 순서값이 없으므로 세션처럼
                언제나 「모르는」 갈래이고, 주어는 자기 것이다. */}
            <NoticeBlock
              headline={jumpMissedNotice('unknown', 'notification').headline}
              detail={jumpMissedNotice('unknown', 'notification').detail}
              onDismiss={() => {}}
              testID="jump-missed-notification"
            />
          </View>
        </Frame>
      );
    case 'row-pressed':
      return (
        <Frame label="행 눌림 — 코드 상자의 고도가 사라진다 (M-2, 1.000:1)">
          {/* 시뮬레이터는 손가락을 대고 있을 수 없다. 그래서 눌린 채움을
              **같은 심볼**(`rowPressedBackground`)로 깔고 진짜 행을 그 위에
              세운다 — 색을 베껴 적었다면 이 사진은 증거가 아니다.

              아래 두 행은 코드 상자를 든 같은 본문이고, 위는 평상시·아래는
              눌린 동안이다. M-2 의 주장은 「눌리면 상자의 채움과 행의 채움이
              같은 `surface` 가 되어 상자가 사라진다」이므로, **아래 사진에서
              상자가 안 보이는 것이 곧 확인**이다. */}
          <View style={styles.pressPair}>
            <MessageBody body={CODE_BODY} />
          </View>
          <View style={[styles.pressPair, styles.pressed]}>
            <MessageBody body={CODE_BODY} />
          </View>
        </Frame>
      );
    case 'typing-one':
      return (
        <Frame label="작성 중 · 1인 — 컴포저 위 한 줄">
          <TypingBar segments={typingSegments(['김민수'])} />
        </Frame>
      );
    case 'typing-many':
      return (
        <Frame label="작성 중 · 집계 — 임계를 넘으면 수를 말한다">
          <TypingBar
            segments={typingSegments(['김민수', '이하늘', '박도윤'])}
          />
        </Frame>
      );
    case 'markdown':
      return (
        <Frame label="본문 렌더 — 코드 상자·불릿·순서 목록·인라인 코드 (H-4·M-4)">
          <MessageBody
            body={[
              '**결론**: 재시작이 필요합니다',
              '',
              '- `outbox_drain_worker` 가 멈췄다',
              '- 재시작 뒤 `seq` 는 이어진다',
              '',
              // 순서 목록이 하네스에 없어서 M-4 의 마커 칸이 **한 번도 안
              // 찍혔다**. 9→10 경계를 넘겨 두는 이유는 그 자리에서만 보이는
              // 것이 있기 때문이다: 마커 폭이 한 자리에서 두 자리로 늘 때
              // 본문 시작점이 따라 밀리는지.
              '9. 릴레이를 멈춘다',
              '10. `seq` 가 이어지는지 확인한다',
              '',
              '```sh',
              'systemctl restart momo-relay',
              '```',
              '',
              '자세한 것은 [배포 문서](https://momo.example/deploy) 참고.',
            ].join('\n')}
          />
        </Frame>
      );
    case 'markdown-pending':
      return (
        <Frame label="본문 렌더 · 보내는 중 — 코드까지 함께 흐려진다 (H-4)">
          <MessageBody
            body={['보내는 중입니다', '', '```sh', 'echo hi', '```'].join('\n')}
            muted
          />
        </Frame>
      );
    case 'sheet':
      return (
        <Frame label="길게 누르기 시트 — 반응·답글·인용·복사·고정·고치기·지우기·닫기">
          <Row />
          {sheet(false)}
        </Frame>
      );
    // ---- 이슈 #1112: 고정 -----------------------------------------------
    //
    // 시트는 `Modal` 이라 한 프레임에 둘을 세울 수 없다(전면을 덮는다). 그래서
    // 낱말의 뒤집힘은 **두 장**으로 본다: 위의 `sheet` 가 「고정하기」를 그리고
    // (그 시트는 `pinned` 없이 선다), 이 판이 「고정 해제하기」를 그린다. 두 장의
    // 나머지 줄이 글자 하나까지 같아야 뒤집힌 것이 그 한 줄뿐임이 보인다.
    case 'pin-sheet':
      return (
        <Frame label="고정 — 이미 고정된 행의 시트. 그 한 줄만 `sheet` 판과 다르다 (이슈 #1112)">
          <Row />
          {pinSheet(true)}
        </Frame>
      );
    // 행에 남는 흔적 (#1146 M3 · #1149 M2). **두 행을 한 장에** 두는 것이 이
    // 하네스의 규율이다: 「표지가 섰다」는 표지가 없는 행 옆에서만 보인다.
    //
    // 그리고 위 행은 **수정된 행이다** (#1149 M2). #1146 은 「위계를 침범하지
    // 않았다 = 「수정됨」과 같은 줄에 나란히 선다」를 이 프레임의 요점으로 적어
    // 놓고, 씨앗 메시지를 `sent` 로 두어 그 둘이 함께 선 사진을 **한 장도 남기지
    // 않았다.** 「같은 격·같은 흐린 글자」도 「순서는 수정됨 다음」도 나란히 놓인
    // 프레임에서만 확인되는 주장이고, 확인되지 않는 주장은 다음 배치가 조용히
    // 뒤집을 수 있다.
    case 'pin-mark':
      return (
        <Frame label="고정 흔적 — 수정+고정된 행 ↔ 아무 표지 없는 행. 꼬리 한 줄, 같은 흐린 글자 (#1146 M3 · #1149 M2)">
          <Row pinned edited />
          <Row />
        </Frame>
      );
    case 'pin-list':
      return (
        <PinListPanel
          pins={PINS}
          status="ready"
          directory={DIRECTORY}
          // 고정된 시각으로 도장이 찍히므로 「지금」이 필요하다. 상수인 이유는
          // 사진이 재현돼야 하기 때문이다 — `Date.now()` 로 두면 어제 찍은 것과
          // 오늘 찍은 것이 다른 글자를 담고, 그 차이가 회귀인지 달력인지 알 수 없다.
          nowMs={NOW}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
      );
    case 'pin-list-empty':
      // 빈 목록은 채워진 것 **옆에서만** 읽힌다: 「이 화면이 아직 아무 말도 못 한
      // 것」과 「할 말이 없다고 말하는 것」이 사진에서 갈리는 자리다.
      return (
        <PinListPanel
          pins={{}}
          status="ready"
          directory={DIRECTORY}
          nowMs={NOW}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
      );
    // 셋째 판 (#1146 M2). 「없다」와 「모른다」는 **나란히 놓아야** 갈린다: 위의
    // 빈 판과 이 판이 한 리뷰에서 함께 읽히지 않으면, 1차가 오프라인에서 하던
    // 거짓말이 고쳐졌는지 사진으로 확인할 길이 없다. 가진 항목을 함께 세우는
    // 것도 그래서다 — 실패한 목록이 반쪽이라는 사실과 그 반쪽은 둘 다 참이고,
    // 화면은 둘 다 말해야 한다.
    case 'pin-list-failed':
      return (
        <PinListPanel
          pins={PINS}
          status="failed"
          directory={DIRECTORY}
          nowMs={NOW}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
      );
    case 'delete':
      return (
        <Frame label="삭제 확인 — 무엇이 남는지 누르기 전에 말한다">
          <Row />
          {sheet(true)}
        </Frame>
      );
    case 'editor':
      return (
        <Frame label="고치기 — 입력은 동기, 버튼은 44px">
          <Row />
          <MessageEditorSheet
            initialBody={MESSAGE.body ?? ''}
            error={null}
            onCancel={() => {}}
            onSave={() => {}}
          />
        </Frame>
      );
    case 'editor-error':
      return (
        <Frame label="고치기 실패 — 사유가 편집기 안에 남는다">
          <Row />
          <MessageEditorSheet
            initialBody={MESSAGE.body ?? ''}
            error="내가 보낸 메시지만 고칠 수 있습니다."
            onCancel={() => {}}
            onSave={() => {}}
          />
        </Frame>
      );
    // ---- U4-4 M1 (#1084): 승인 카드가 막다른 길이 아니게 됐다 -----------------
    case 'approval-card': {
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000000b1',
        type: 'approval_request',
        body: '툴 호출 승인',
        authorMemberId: AGENT,
        props: {
          approval_id: 'ap-1',
          title: 'github.search_issues 실행 허가',
          approval_status: 'pending',
        },
      } as unknown as Message;
      const gates = new Map([
        [
          'ap-1',
          {approvalId: 'ap-1', reversible: false, expiresAtMs: null},
        ],
      ]);
      return (
        <Frame label="승인 카드 — 결정 가능 / 불가 / 결정 뒤 (감사 H-1)">
          {/* 세 상태를 한 장에 세운다. 이 goal 의 논점이 「언제 컨트롤이 서는가」
              이므로 한 상태만 찍으면 그 논점이 사진에 안 나온다. */}
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates}
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalReceipts={
              new Map([['ap-1', {note: '승인을 기록했어요.', status: 'approved'}]])
            }
          />
        </Frame>
      );
    }
    // ---- U4-4 M2 (#1083): 시간과 경계 ----------------------------------------
    case 'group': {
      // 한 사람이 연달아 쓴 그룹. 이 goal 의 논점 둘이 여기서만 보인다:
      // 연속 행에 시각이 있는가(H-3), 그리고 메시지 사이 경계가 읽히는가(H-7).
      const at = (min: number, sec = 0) =>
        NOW - (14 - min) * 60_000 - sec * 1000;
      const lines = [
        ['릴레이가 pool exhausted 로 멈췄습니다.', 0],
        ['재시작하면 seq 는 이어집니다.', 1],
        ['배포 문서에 롤백 절차도 적어 뒀어요.', 4],
      ] as const;
      return (
        <Frame label="같은 저자 그룹 — 연속 행의 시각과 경계 (감사 H-3·H-7)">
          {lines.map(([body, min], i) => (
            <MessageRow
              key={i}
              message={{
                ...MESSAGE,
                id: `grp-${i}`,
                seq: 40 + i,
                body,
                createdAtMs: at(min as number),
                thread: undefined,
              } as unknown as Message}
              startsGroup={i === 0}
              directory={DIRECTORY}
              chips={i === 0 ? CHIPS : []}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    // ---- #3386: 연속 메시지 묶음을 Buzz 처럼 ----------------------------------
    //
    // owner 스크린샷(IMG_4193 oort 채널 / IMG_4192 Buzz DM)과 같은 상황이다.
    // `buzz-channel`: 같은 저자의 짧은 연속 발화 셋(머리 하나, 시각 칸 없음).
    // `buzz-dm`: 두 사람의 DM — 반응이 달린 연속 발화·긴 문단·저자 교대.
    // `buzz-sheet`: 연속 행을 길게 눌렀을 때 시트 머리에 그 메시지의 시각이 선다.
    // ---- #4065: 이름 옆 「에이전트」 배지 제거 ----------------------------------
    //
    // 에이전트의 머리 행·이어지는 행·「작업 중」 자리를 한 장에 세운다. 이름 줄은
    // 한 줄(이름 · 핸들 · 책임자 · 시각)이고 둘째 낱말 「에이전트」가 없다. 낭독 쪽은
    // jest(`timelineRender`)가 라벨로 잰다.
    case 'agent-name-line': {
      const at = (min: number) => NOW - (14 - min) * 60_000;
      const rows: Array<{who: string; body: string; min: number; head: boolean}> = [
        {who: SELF, head: true, min: 0, body: '이번 주 일정 정리해 줘'},
        {who: AGENT, head: true, min: 1, body: '이번 주는 화요일 오전 10시 팀 회의, 목요일 오후 3시 고객 통화가 있어요.'},
        {who: AGENT, head: false, min: 2, body: '금요일은 비어 있어요. 필요하면 회고 시간을 잡아 둘까요?'},
        {who: SELF, head: true, min: 3, body: '응, 금요일 오후로 잡아 줘'},
      ];
      return (
        <Frame label="에이전트 이름 줄 — 「에이전트」 배지 없음 (#4065)">
          {rows.map((r, i) => (
            <MessageRow
              key={i}
              message={{
                ...MESSAGE,
                id: `agent-name-${i}`,
                seq: 80 + i,
                authorMemberId: r.who,
                body: r.body,
                createdAtMs: at(r.min),
                thread: undefined,
              } as unknown as Message}
              startsGroup={r.head}
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
            />
          ))}
          <WorkingRow memberId={AGENT} directory={DIRECTORY} />
        </Frame>
      );
    }
    case 'buzz-channel': {
      const at = (min: number) => NOW - (14 - min) * 60_000;
      const lines = ['ㅎㅇ', '@claude-code ㅎㅇ', 'ㅎㅇㅎㅇ'];
      return (
        <Frame label="# agent-lab — 같은 저자 연속 발화: 머리 하나, 이후는 문단 (#3386)">
          {lines.map((body, i) => (
            <MessageRow
              key={i}
              message={{
                ...MESSAGE,
                id: `buzz-ch-${i}`,
                seq: 60 + i,
                body,
                createdAtMs: at(i),
                thread: undefined,
              } as unknown as Message}
              startsGroup={i === 0}
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    case 'buzz-dm': {
      const at = (min: number) => NOW - (14 - min) * 60_000;
      const ok = [{emoji: '✅', count: 1, mine: true}];
      const rows: Array<{who: string; body: string; min: number; head: boolean; chips: typeof ok}> = [
        {who: OTHER, head: true, min: 0, chips: [], body: '여명님 정본부장과 명함 교환하셨을까요 ? 연락처가 없어서 요청드렸는데, 아직 연락이 없으십니다. 곧 연휴라서 금일 미팅 일정은 잡아놓으면 좋을 거 같아서 금일 연락 취하고 진행 상황 및 중간 보고 드리려 합니다.'},
        {who: SELF, head: true, min: 1, chips: [], body: '네 연락처 저한테'},
        {who: SELF, head: false, min: 2, chips: ok, body: '있고 오이사님 3일날 미국 출발해서 정신이 없으실거에요'},
        {who: SELF, head: false, min: 3, chips: ok, body: '6일 오후 3시 본사 확정이에요'},
        {who: OTHER, head: true, min: 4, chips: [], body: '넵 확인했습니다 !\n이전에 미국에 계실 때 소통관련해서 말씀해주신게, 저는 이사님 제외의 담당자 분과 소통을 말씀하신 줄 알았는데\n단톡으로 계속 소통을 진행하면 되는 걸까요 ?'},
        {who: SELF, head: true, min: 5, chips: ok, body: '네네'},
      ];
      return (
        <Frame label="DM — 반응·긴 문단·저자 교대. 연속 행에 시각 칸 없음 (#3386)">
          {rows.map((r, i) => (
            <MessageRow
              key={i}
              message={{
                ...MESSAGE,
                id: `buzz-dm-${i}`,
                seq: 70 + i,
                authorMemberId: r.who,
                body: r.body,
                createdAtMs: at(r.min),
                thread: undefined,
              } as unknown as Message}
              startsGroup={r.head}
              directory={DIRECTORY}
              chips={r.chips}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    case 'buzz-sheet':
      return (
        <Frame label="연속 행을 길게 누름 — 시트 머리에 그 메시지의 시각 (#3386)">
          <MessageRow
            message={{...MESSAGE, id: 'buzz-sh-0', seq: 80, body: 'ㅎㅇ', createdAtMs: NOW - 120_000, thread: undefined} as unknown as Message}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <MessageRow
            message={{...MESSAGE, id: 'buzz-sh-1', seq: 81, body: '@claude-code ㅎㅇ', createdAtMs: NOW - 60_000, thread: undefined} as unknown as Message}
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <MessageActionSheet
            message={{...MESSAGE, id: 'buzz-sh-1', seq: 81, body: '@claude-code ㅎㅇ', createdAtMs: NOW - 60_000, thread: undefined} as unknown as Message}
            chips={[]}
            availability={AVAILABILITY}
            authorLabel="이도현"
            onClose={() => {}}
            onToggleReaction={() => {}}
            onReply={() => {}}
            onQuote={() => {}}
            onCopy={() => {}}
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </Frame>
      );
    case 'dividers':
      return (
        <Frame label="구분선 — 오늘/어제/절대 · 좌측 라벨 (감사 H-4·M-2)">
          {/* 넷을 나란히 세우는 이유: 이 goal 의 논점이 「같은 가족으로
              보이는가」이고, 한 장에 모아야 여백 위계(날짜 > 표지)와 라벨
              정렬이 한눈에 보인다. */}
          <DayDivider atMs={NOW} nowMs={NOW} />
          <DayDivider atMs={NOW - 26 * 3_600_000} nowMs={NOW} />
          <DayDivider atMs={NOW - 40 * 24 * 3_600_000} nowMs={NOW} />
          <UnreadDivider count={12} />
          <RecoveryDivider seq={4821} source="backfill" />
        </Frame>
      );
    // #1892 — 안읽음·최신 점프 필. 누르는 것은 `maestro/91-jump-pills-capture.yaml`.
    case 'jump-pills':
      return <JumpPillsStage />;
    // #1892 R1 — 방을 옮긴 뒤의 필(H-1)·키보드(M-4), 그리고 다른 방 착지(M-1).
    // 흐름은 `maestro/93-`(방 옮기기·키보드)과 `94-`(다른 방 착지).
    case 'jump-pills-rooms':
      return <JumpPillsRoomsStage land="none" />;
    case 'jump-pills-land':
      return <JumpPillsRoomsStage land="middle" />;
    // R2 H-A — 가장 새 메시지로의 다른 방 착지와 그 뒤의 따라가기. `maestro/95-`.
    case 'jump-pills-land-end':
      return <JumpPillsRoomsStage land="end" />;
    case 'row':
      return (
        <Frame label="행 — 반응 칩과 스레드 앵커는 항상 보이는 진입점">
          <Row />
        </Frame>
      );
    // ---- ADR-0155 (#1160): 멈춘 답의 꼬리 ------------------------------------
    //
    // 세 판을 **한 장에** 세운다. 논점이 「이 낱말이 예쁜가」가 아니라 「끊긴 답이
    // 완결된 답과 구별되는가, 그러면서도 강조가 되지는 않는가」이기 때문이다 —
    // 그 주장은 세 행이 나란히 설 때만 사진에서 확인된다. 위에서부터: 잘 끝난 답
    // (아무 말 없음) · 사람이 멈춘 답(「중단됨」) · 닫는 PATCH 가 못 닿아 열린 채
    // 남은 답(「응답이 끊김」).
    //
    // 세 번째가 특히 사진에 있어야 하는 판이다. 그것은 서버가 아무 도장도 못 찍은
    // 경우이고, 화면이 스스로 알아본 것이라 코드만 읽어서는 무엇이 그려지는지
    // 아무도 확인할 수 없다.
    case 'stream-stop':
      return (
        <Frame label="멈춘 답 — 완결 · 중단됨 · 응답이 끊김 (ADR-0155)">
          <StoppedRow marker={{rev: 17, streaming: false}} />
          <StoppedRow
            marker={{rev: 6, streaming: false, outcome: 'cancelled'}}
          />
          <StoppedRow marker={{rev: 9, streaming: true}} runEnded />
        </Frame>
      );
    // ---- U2: 스킴을 고르는 세 칸, 그리고 그 옆의 진짜 행 ----------------------
    //
    // 컨트롤만 찍으면 이 배치가 한 일의 **절반**만 사진에 남는다. 논점은 「세 칸이
    // 예쁜가」가 아니라 「고른 스킴이 화면 끝까지 가는가」이고, 그 주장은 컨트롤과
    // 타임라인 행이 **같은 장에** 있을 때만 사진에서 확인된다 — 라이트 판에서 위는
    // 종이인데 아래 행만 밤하늘이면 그것이 곧 이 배치의 실패다.
    //
    // `light-theme` 로 띄우면 같은 장이 라이트로 나온다(`measure/root.ts`).
    case 'theme':
      return (
        <Frame label="테마 — 세 칸과, 그 선택을 받는 행 (U2)">
          <ThemeControl />
          <Row />
        </Frame>
      );
    // ---- U4-4R M-1 (#1092): 행의 첫 줄이 시각 칸을 진다 -----------------------
    //
    // 이 goal 이 고친 구멍은 **연속 행의 첫 흐름 자식이 본문이 아닐 때** 시각
    // 칸이 무예약이라는 것이었다. U4-4 의 픽스처는 그 경우를 한 번도 세우지
    // 않았다 — `approval-card` 는 승인 카드 셋 전부에 `startsGroup` 을 건다.
    // 즉 **연달아 온 승인 카드**(타임라인이 승인 카드를 둘 이상 보여 주는 가장
    // 흔한 경로)는 촬영된 적이 없었고, 겹침은 정확히 거기서 일어난다.
    //
    // 한 장에 네 가지 첫 자식을 세운다: 승인 카드(머리) → 승인 카드(연속) →
    // 인용(연속) → 묘비(연속). 논점이 「자식 종류가 늘어도 같은 여백 밑으로
    // 들어오는가」이므로 한 종류만 찍으면 그 논점이 사진에 안 나온다.
    case 'row-lead': {
      // 시각이 **칸**이라는 주장은 값이 서로 다를 때만 사진에서 확인된다 — 넷이
      // 같은 시각이면 오른쪽 정렬인지 우연인지 구분이 안 된다.
      const leadAt = (min: number) => NOW - (14 - min) * 60_000;
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000000c1',
        type: 'approval_request',
        body: '툴 호출 승인',
        authorMemberId: AGENT,
        thread: undefined,
        createdAtMs: leadAt(0),
        props: {
          approval_id: 'ap-2',
          title: 'github.search_issues 실행 허가',
          approval_status: 'pending',
        },
      } as unknown as Message;
      const leadQuote = quoteDraftFor({
        ...MESSAGE,
        id: 'orig-lead',
        seq: 7,
        authorMemberId: OTHER,
        body: '릴레이 로그는 어디서 봅니까',
      } as unknown as Message);
      return (
        <Frame label="행의 첫 줄이 시각 칸을 진다 — 연속 승인 카드·인용·묘비 (리뷰 M-1)">
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          {/* 이 행이 이 표면의 이유다: 첫 흐름 자식이 **카드**이고, 카드는
              불투명한 배경과 오른쪽 위 상태 칩을 함께 든다. 예약이 없으면
              시각이 카드 밑으로 사라지거나 「승인 대기」 칩과 겹친다. */}
          <MessageRow
            message={
              {
                ...approvalMessage,
                id: 'ap-row-2',
                seq: 43,
                createdAtMs: leadAt(2),
              } as Message
            }
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          {leadQuote ? (
            <MessageRow
              message={
                {
                  ...MESSAGE,
                  id: 'q-row',
                  seq: 44,
                  thread: undefined,
                  body: '이 로그는 릴레이 컨테이너 안에 있습니다.',
                  createdAtMs: leadAt(5),
                } as Message
              }
              startsGroup={false}
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
              quote={leadQuote.block}
            />
          ) : null}
          <MessageRow
            message={
              {
                ...MESSAGE,
                id: 'del-row',
                seq: 45,
                state: 'deleted',
                thread: undefined,
                createdAtMs: leadAt(11),
              } as unknown as Message
            }
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    }
    // ---- U4-5M (#1097): 폰 위생 · 착지 틴트 · 기준선 ------------------------
    //
    // 셋 다 **한 장에 한 논점**이다. 위생 결함은 옆에 비교 대상이 없으면 사진에서
    // 안 보인다 — 「좌우 여백이 0 이다」는 여백을 가진 행이 같은 화면에 있어야
    // 보이고, 「접혔다」는 접히기 전이 몇 줄이었는지를 알아야 보인다.
    case 'pending-gutter': {
      // 감사 M-12 / #1093 관찰: 낙관적 메아리만 화면 가장자리에 붙어 있었다.
      // 확정 행 → 메아리 → 실패한 메아리 순으로 세운다. 셋의 본문 왼쪽 끝이
      // 한 줄에 서는지가 이 사진의 전부다.
      const echo = (
        clientMsgId: string,
        status: 'sending' | 'failed',
        body: string,
      ) => ({
        clientMsgId,
        channelId: 'ch',
        authorMemberId: SELF,
        body,
        status,
        createdAtMs: NOW,
      });
      return (
        <Frame label="낙관적 메아리도 같은 여백을 진다 (감사 M-12)">
          <MessageRow
            message={
              {
                ...MESSAGE,
                id: 'confirmed',
                seq: 60,
                thread: undefined,
                body: '확정된 행 — 이 왼쪽 끝이 기준이다.',
              } as Message
            }
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <PendingRow
            pending={
              echo('c-1', 'sending', '보내는 중인 메아리 — 예전엔 여기가 튀어나왔다.') as never
            }
            startsGroup={false}
            directory={DIRECTORY}
          />
          <PendingRow
            pending={echo('c-2', 'failed', '실패한 메아리.') as never}
            startsGroup={false}
            directory={DIRECTORY}
            onResend={() => {}}
          />
        </Frame>
      );
    }
    case 'deleted-fold': {
      // 감사 M-1: 캡처 `m-09` 에서 「삭제된 메시지」가 줄마다 쌓였다. 접힌 뒤와
      // **접히지 않는 경우**를 같은 화면에 둔다 — 규칙이 「전부 접는다」가 아니라
      // 「잃을 것이 없을 때만 접는다」이므로, 접히지 않은 묘비가 없는 사진은 그
      // 규칙을 안 보여 준다.
      const tomb = (id: string, seq: number, over: Partial<Message> = {}) =>
        ({
          ...MESSAGE,
          id,
          seq,
          state: 'deleted',
          body: '',
          thread: undefined,
          createdAtMs: NOW - (60 - seq) * 60_000,
          ...over,
        }) as unknown as Message;
      return (
        <Frame label="연달아 지워진 메시지는 한 줄로 접힌다 (감사 M-1)">
          <MessageRow
            message={tomb('d-1', 51)}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            deletedRepeat={4}
            nowMs={NOW}
          />
          {/* 답글이 달린 묘비는 접히지 않는다 — 「답글 3개」는 방으로 가는 문이다. */}
          <MessageRow
            message={tomb('d-5', 55, {
              thread: {
                reply_count: 3,
                last_reply_seq: 58,
                last_reply_at: NOW,
              },
            } as Partial<Message>)}
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={{
              myMemberId: SELF,
              onToggleReaction: async () => {},
              onEdit: async () => {},
              onDelete: async () => {},
              onOpenThread: () => {},
            }}
          />
          {/* 반응이 달린 묘비도 접히지 않는다. */}
          <MessageRow
            message={tomb('d-6', 56)}
            startsGroup={false}
            directory={DIRECTORY}
            chips={CHIPS}
            nowMs={NOW}
          />
          <MessageRow
            message={
              {
                ...MESSAGE,
                id: 'alive',
                seq: 57,
                thread: undefined,
                body: '살아 있는 행은 그대로다.',
                createdAtMs: NOW,
              } as Message
            }
            startsGroup={false}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    }
    case 'landed': {
      // #1076: 「방금 여기로 왔다」. 물든 행 하나와 물들지 않은 이웃들이 함께
      // 있어야 이 값이 **띠가 아니라 물듦**이라는 주장이 사진에서 확인된다
      // (바닥 대비 1.10~1.29:1 — 경고색 10% 이하의 면이고 테두리가 없다. 계산은 `MessageRow` 의 `rowLanded` 주석과
      // `__tests__/messageBubble.test.tsx` 에 있다, #4949).
      const at = (min: number) => NOW - (14 - min) * 60_000;
      const rows = [
        ['앞 줄 — 물들지 않는다.', 0, false],
        ['인용이 가리킨 원본. 여기로 왔다.', 3, true],
        ['뒷 줄 — 물들지 않는다.', 6, false],
      ] as const;
      return (
        <Frame label="인용 점프 착지 — 「방금 여기로 왔다」 (#1076)">
          {rows.map(([body, min, landed], i) => (
            <MessageRow
              key={i}
              message={
                {
                  ...MESSAGE,
                  id: `land-${i}`,
                  seq: 70 + i,
                  body,
                  thread: undefined,
                  createdAtMs: at(min),
                } as Message
              }
              startsGroup={i === 0}
              directory={DIRECTORY}
              chips={[]}
              landed={landed}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    // ---- #3921: 알림 도착 강조는 승인이 결정되면 물러난다 ---------------------
    //
    // 한 쌍이다. 같은 세 줄(앞 줄 · 승인 카드 · 뒷 줄)에서 가운데 줄만 다르다.
    //   arrival  도착 직후 — 「승인 대기」 칩과 승인·거부 컨트롤, 그리고 앰버 틴트(`landed`).
    //   decided  결정 뒤   — 「승인됨」 칩과 영수증, 틴트 없음.
    // 성재가 본 모순은 「승인됨」 옆에서 앰버가 남은 것이었다. 두 번째 사진에서 그 모순이
    // 사라졌는지가 논점이라 두 장을 같은 배치로 찍는다. 물러나는 **시간**(이동이 끝난 뒤
    // 1.5초, 불투명도 240ms)은 사진에 나오지 않는다 — `__tests__/landedHighlight.test.tsx`
    // 가 가짜 시계로 잰다. 여기 `landed` 는 목록이 건네는 값을 그대로 건넨 것이다.
    //
    // 바닥은 `ConversationFloor` — 실제 대화 화면의 바닥이다. 틴트는 바닥 위의 **상대적인**
    // 세기라(라이트 `warnSurface` 대 `surface` 1.11:1) 바닥이 다르면 사진이 다른 말을 한다.
    case 'landed3921-arrival':
    case 'landed3921-decided': {
      const decided = name === 'landed3921-decided';
      const at = (min: number) => NOW - (14 - min) * 60_000;
      const plain = (id: string, seq: number, body: string, min: number) =>
        ({
          ...MESSAGE,
          id,
          seq,
          body,
          authorMemberId: AGENT,
          createdAtMs: at(min),
          thread: undefined,
        }) as Message;
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000003b1',
        seq: 81,
        type: 'approval_request',
        body: '툴 호출 승인',
        authorMemberId: AGENT,
        createdAtMs: at(3),
        thread: undefined,
        props: {
          approval_id: 'ap-3921',
          title: 'github.search_issues 실행 허가',
          approval_status: 'pending',
        },
      } as unknown as Message;
      const gates = new Map([
        ['ap-3921', {approvalId: 'ap-3921', reversible: false, expiresAtMs: null}],
      ]);
      const receipts = new Map([
        ['ap-3921', {note: '승인을 기록했어요.', status: 'approved' as const}],
      ]);
      return (
        <ConversationFloor
          label={
            decided
              ? '결정 뒤 — 「승인됨」 · 틴트 없음 (#3921)'
              : '도착 직후 — 「승인 대기」 · 앰버 틴트 (#3921)'
          }>
          <MessageRow
            message={plain('l3921-a', 80, '배포 전에 깃허브 이슈를 먼저 찾아볼게요.', 0)}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            landed={!decided}
            approvalGates={decided ? undefined : gates}
            approvalReceipts={decided ? receipts : undefined}
          />
          <MessageRow
            message={plain('l3921-c', 82, '승인되면 바로 이어서 찾아볼게요.', 6)}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </ConversationFloor>
      );
    }
    // ---- U4-6M (#1103): 아바타 · 문장의 격 · 컴포저 -------------------------
    //
    // 셋 다 **비교 대상을 같은 화면에** 둔다. U4-5M 이 세운 규율 그대로다:
    // 위생과 위계 결함은 혼자 찍으면 안 보인다 — 「모르는 작성자에게 글자가
    // 없다」는 글자가 있는 아바타 옆에서만, 「영수증이 격상됐다」는 안내 문장
    // 옆에서만, 「지금은 못 보낸다」는 보낼 수 있는 컴포저 옆에서만 보인다.
    case 'avatar': {
      // 넷을 한 묶음처럼 세운다: 사람(머리) → 같은 저자의 연속 행 → 에이전트 →
      // 명부에 없는 작성자. 논점이 「왼쪽 칸이 모든 행에서 같은가」이므로 연속
      // 행이 반드시 함께 있어야 하고, 「모를 때 글자를 안 그린다」는 uuid
      // 작성자가 함께 있어야 보인다.
      const ghost = '0199dddd-1111-4111-8111-999999999999';
      const rows: Array<[string, string, boolean]> = [
        [SELF, '금요일 배포는 오전 10시에 시작합니다.', true],
        [SELF, '롤백 절차는 문서에 적어 뒀어요.', false],
        [AGENT, '릴레이 로그를 확인했습니다. pool exhausted 가 두 번 있었습니다.', true],
        [ghost, '이 작성자는 명부에 없습니다.', true],
      ];
      return (
        <Frame label="아바타 — 사람 · 연속 행 · 에이전트 · 모르는 작성자 (감사 H-11)">
          {rows.map(([author, body, head], i) => (
            <MessageRow
              key={i}
              message={
                {
                  ...MESSAGE,
                  id: `av-${i}`,
                  seq: 60 + i,
                  authorMemberId: author,
                  body,
                  thread: undefined,
                } as unknown as Message
              }
              startsGroup={head}
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
            />
          ))}
        </Frame>
      );
    }
    case 'approval-notes': {
      // M-3 이 실측한 것: 세 문장이 전부 같은 옷이고, 카드에서 가장 값어치 있는
      // 영수증이 가장 조용한 차림이었다. 한 장에 셋을 세워야 격이 갈렸는지가
      // 사진에서 확인된다 — 하나만 찍으면 그것이 어떤 격인지 알 수 없다.
      const approvalMessage = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000000b2',
        type: 'approval_request',
        body: '툴 호출 승인',
        authorMemberId: AGENT,
        props: {
          approval_id: 'ap-1',
          title: 'github.search_issues 실행 허가',
          approval_status: 'pending',
        },
      } as unknown as Message;
      const gates = new Map([
        ['ap-1', {approvalId: 'ap-1', reversible: false, expiresAtMs: null}],
      ]);
      return (
        <Frame label="승인 카드 세 문장의 격 — 영수증 / 차단 / 안내 (리뷰 M-3)">
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates}
            approvalReceipts={
              new Map([['ap-1', {note: '승인을 기록했어요.', status: 'approved'}]])
            }
          />
          {/* 오프라인은 U4-4 리뷰가 **미캡처**로 남긴 자리다 — 「증거가 상수
              하나뿐이라 시각 판정은 확인 필요로 남긴다」. 이 장이 그것을 닫는다. */}
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gates}
            approvalOffline
          />
          <MessageRow
            message={approvalMessage}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    }
    // ---- AX-7 (#2513) + U4-g (#1084): 행동 승인 · 403 · 1회 링크 · 영속 카드 ----
    //
    // 네 장이 한 흐름의 네 순간이다: 결정 전 → 결정할 수 없다는 답 → 결정 직후
    // (링크가 이 화면에 한 번) → 다시 열었을 때(링크 없이 영속 카드만). 픽스처는
    // ADR-0186 부록 A·B 그대로이고, 값(부록 C `secretOnce`)은 **영수증 표**로만
    // 건넨다 — 대화 화면이 결정 응답에서 받아 드는 바로 그 자리다.
    // ---- ADR-0201 (#3836): 도우미 승인 카드 + 넘기는 줄 ------------------------
    case 'team-ai': {
      const agents = ROSTER.filter(m => m.kind === 'agent');
      const helper = agents[0] ?? ROSTER[0];
      const grok = agents[1] ?? agents[0] ?? ROSTER[0];
      const requester = ROSTER.find(m => m.id === OTHER) ?? ROSTER[0];
      const card = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000036b1',
        type: 'approval_request',
        body: '에이전트 프로필 바꾸기',
        authorMemberId: helper.id,
        thread: undefined,
        props: {
          approval_id: 'ap-team-ai',
          action_type: 'workspace_action',
          status: 'pending',
          title: '에이전트 프로필 바꾸기',
          action: {
            id: 'agent.profile.update',
            rows: [
              {label: '에이전트', value: grok.displayName},
              {label: '소개', value: '주간 리포트 담당'},
            ],
            rationale: `${requester.displayName} 님이 소개를 주간 리포트 담당으로 바꿔 달라고 했어요.`,
            required_role: 'admin',
          },
          proposed_via: {
            kind: 'team_ai',
            requester_id: requester.id,
            requester_name: requester.displayName,
          },
        },
      } as unknown as Message;
      const handOff = {
        ...MESSAGE,
        id: '00000000-0000-7000-8000-0000000036b2',
        authorMemberId: helper.id,
        thread: undefined,
        body: '이건 제가 바로 처리하기엔 큰 일이에요. 다른 에이전트에게 맡길 수 있어요.',
        props: {
          source: 'team_ai_fallback',
          kind: 'team_ai.delegate.v1',
          reason: 'out_of_scope',
          agent_member_id: helper.id,
          notice_for_member_id: SELF,
          delegate: {
            source_message_id: null,
            candidates: [
              {
                member_id: grok.id,
                handle: grok.handle,
                display_name: grok.displayName,
                client_msg_id: '0e5fa1d0-c0de-5201-9d00-7e4a11a12023',
              },
            ],
          },
        },
      } as unknown as Message;
      return (
        <Frame label="도우미 제안 카드 · 넘기는 줄 (ADR-0201 #3836)">
          <MessageRow
            message={card}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={
              new Map([
                ['ap-team-ai', {approvalId: 'ap-team-ai', reversible: true, expiresAtMs: null}],
              ])
            }
          />
          <MessageRow
            message={handOff}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={{...aiSuggestActions(SELF), workspaceId: 'ws-capture'}}
          />
        </Frame>
      );
    }
    case 'ai-suggest':
      harnessClient.setQueryData(['settings', 'provider-link'], AI_SUGGEST_LINK);
      return (
        <Frame label="에이전트 제안 연결 카드 — 대상 본인 · 운영자 (#2948 GC-7)">
          <MessageRow
            message={aiSuggestMessage()}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={aiSuggestActions(SELF)}
          />
        </Frame>
      );
    case 'settings-open-suggest':
      return (
        <Frame label="에이전트 제안 설정 열기 카드 — 대상 본인 (U-S6 #3940)">
          <MessageRow
            message={settingsOpenMessage('notifications')}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={aiSuggestActions(SELF)}
          />
        </Frame>
      );
    case 'settings-open-suggest-others':
      return (
        <Frame label="같은 제안 — 그 밖의 멤버(위) · 모르는 section(아래) (U-S6 #3940)">
          <MessageRow
            message={settingsOpenMessage('notifications')}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={aiSuggestActions(OTHER)}
          />
          <MessageRow
            message={settingsOpenMessage('no-such-section')}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={aiSuggestActions(SELF)}
          />
        </Frame>
      );
    case 'ai-suggest-others':
      harnessClient.setQueryData(['settings', 'provider-link'], AI_SUGGEST_LINK);
      return (
        <Frame label="같은 제안 — 운영자(위) · 그 밖의 멤버(아래) (#2948 GC-7)">
          <MessageRow
            message={aiSuggestMessage()}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={aiSuggestActions(OTHER)}
          />
          <QueryClientProvider client={aiSuggestOutsider}>
            <MessageRow
              message={aiSuggestMessage()}
              startsGroup
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
              actions={aiSuggestActions(OTHER)}
            />
          </QueryClientProvider>
        </Frame>
      );
    case 'action-approval':
      return (
        <Frame label="행동 승인 카드 — 대기 (ADR-0186 부록 A · #2513)">
          <MessageRow
            message={ACTION_APPROVAL_MESSAGE}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={ACTION_GATES}
            approvalsProvided
          />
        </Frame>
      );
    case 'action-role-required':
      // 403 뒤의 모습은 결정을 **실제로 보내야** 나온다. 시뮬레이터에서 누르는 것은
      // Maestro 레인(`maestro/92-action-role-required-capture.yaml`)이 하고, 이 장은
      // 그 결정 POST 에 서버처럼 403 영수증(`status: role_required`)으로 답한다.
      // 코어 `decideApproval` · 폰 `ApprovalDecision` 은 전부 진짜다.
      return (
        <DecisionStub status={403} body={{approval_id: 'ap-1', status: 'role_required'}}>
          <Frame label="행동 승인 카드 — 403 role_required 뒤 (무장 해제 · ADR-0186 §5)">
            <MessageRow
              message={ACTION_APPROVAL_MESSAGE}
              startsGroup
              directory={DIRECTORY}
              chips={[]}
              nowMs={NOW}
              approvalGates={ACTION_GATES}
              approvalsProvided
            />
          </Frame>
        </DecisionStub>
      );
    case 'action-link-once':
      return (
        <Frame label="승인 직후 — 링크 1회 표시 + 결과 카드 (D4 · 부록 B)">
          <MessageRow
            message={ACTION_APPROVAL_MESSAGE}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW + 60_000}
            approvalReceipts={
              new Map([
                [
                  'ap-1',
                  {
                    note: '승인을 기록했어요.',
                    status: 'approved',
                    secretOnce: {
                      kind: 'invite_link',
                      value: 'https://oort.example.com/join?code=Ab3-_xQ7mK2vR9pL',
                      expiresAtMs: NOW + 7 * 86_400_000,
                    },
                  },
                ],
              ])
            }
            approvalsProvided
          />
          <MessageRow
            message={ACTION_RESULT_MESSAGE}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW + 61_000}
          />
        </Frame>
      );
    case 'action-after-refresh':
      // 다시 열면 영수증 표가 없다 — 서버가 패치한 카드(승인됨)와 결과 카드만
      // 남고, 링크 값은 어디에도 없다. 결과 카드의 「1회 표시됐습니다」가 그
      // 사실을 사람에게 말하는 유일한 자리다.
      return (
        <Frame label="다시 열었을 때 — 영속 카드만, 링크 없음 (D4)">
          <MessageRow
            message={{
              ...ACTION_APPROVAL_MESSAGE,
              props: {
                ...ACTION_APPROVAL_MESSAGE.props,
                approval_status: 'approved',
                decided_by: SELF,
                decided_at_ms: NOW + 60_000,
              },
            }}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW + 3_600_000}
            approvalsProvided
          />
          <MessageRow
            message={ACTION_RESULT_MESSAGE}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW + 3_600_000}
          />
        </Frame>
      );
    // ---- 이슈 1114 (ADE 1단계): 승인 카드 호스트 선택기 --------------------
    case 'spawn-picker': {
      // 스폰 승인은 「해도 되나」와 **「어디서 하나」** 를 함께 묻는다. 이 장이
      // 보여야 하는 것은 라디오가 있다는 사실이 아니라 **자격 없는 줄이 사유와
      // 함께 서 있다**는 것이고, 그것은 자격 있는 줄 옆에서만 보인다 — 네 줄을
      // 한 장에 세우는 이유다(이 파일이 여백·접기·틴트에서 세 번 쓴 규율 그대로).
      //
      // 오른쪽 카드는 **고를 것이 하나도 없을 때**다. 승인 버튼이 실제로 꺼지고
      // 그 위에 이유가 서는 것이 이 배치의 fail-closed 문이며, 꺼진 버튼은 켜진
      // 버튼 옆에서만 꺼진 것으로 읽힌다.
      const host = (
        id: string,
        display_name: string,
        tier: string,
        host_type: string,
        selectable: boolean,
        unavailable_reason: string | null,
      ) => ({
        host_id: id,
        display_name,
        host_type,
        tier,
        scope: tier === 'remote' || tier === 'cloud' ? 'workspace' : 'member',
        online: unavailable_reason !== 'offline',
        selectable,
        unavailable_reason,
      });
      const candidates = [
        host('h-1', '도현 맥북', 'local', 'app', true, null),
        host('h-2', '팀 VPS (서울)', 'remote', 'workd', true, null),
        host('h-3', '작업실 아이맥', 'local', 'app', false, 'offline'),
        host('h-4', 'oort Cloud', 'cloud', 'cloud', false, 't3_disabled'),
      ];
      const execution = (rows: typeof candidates, defaultHostId: string | null) => ({
        kind: 'work_session_spawn',
        tool: 'codex',
        label: '릴레이 재시작 절차 정리',
        requested_host_id: null,
        default_host_id: defaultHostId,
        host_candidates: rows,
      });
      const spawnMessage = (id: string, exec: unknown) =>
        ({
          ...MESSAGE,
          id,
          type: 'approval_request',
          body: '작업 세션 시작 승인',
          authorMemberId: AGENT,
          props: {
            approval_id: id,
            title: 'codex 작업 세션 시작 허가',
            approval_status: 'pending',
            execution: exec,
          },
        }) as unknown as Message;
      const gate = (id: string) =>
        new Map([[id, {approvalId: id, reversible: false, expiresAtMs: null}]]);
      return (
        <Frame label="스폰 승인 호스트 선택기 — 후보 넷 / 고를 것이 없을 때 (이슈 1114)">
          <MessageRow
            message={spawnMessage('ap-spawn', execution(candidates, 'h-1'))}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gate('ap-spawn')}
          />
          <MessageRow
            message={spawnMessage(
              'ap-spawn-blocked',
              execution(
                candidates.filter(row => !row.selectable),
                null,
              ),
            )}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            approvalGates={gate('ap-spawn-blocked')}
          />
        </Frame>
      );
    }
    case 'spawn-locked': {
      // **잠긴 판 ↔ 살아 있는 판**, 한 장에 (design-review B1).
      //
      // 무장하면 픽커가 잠긴다. 그것이 보이는지는 살아 있는 픽커 **옆에서만**
      // 사진으로 확인된다 — 이 파일이 여백·접기·틴트에서 세 번 쓴 그 규율이다.
      // 시뮬레이터는 탭을 받지 못해 카드를 통과시켜 무장 상태를 만들 수 없으므로,
      // 카드가 쓰는 그 컴포넌트를 직접 두 번 세운다(shipping 소스 그대로).
      const host = (
        id: string,
        display_name: string,
        tier: string,
        host_type: string,
        selectable: boolean,
        unavailable_reason: string | null,
      ) => ({
        host_id: id,
        display_name,
        host_type,
        tier,
        scope: tier === 'remote' || tier === 'cloud' ? 'workspace' : 'member',
        online: unavailable_reason !== 'offline',
        selectable,
        unavailable_reason,
      });
      const rows = [
        host('h-1', '도현 맥북', 'local', 'app', true, null),
        host('h-2', '팀 VPS (서울)', 'remote', 'workd', true, null),
        host('h-3', '작업실 아이맥', 'local', 'app', false, 'offline'),
      ];
      const parsed = parseExecutionPlan({
        execution: {
          kind: 'work_session_spawn',
          tool: 'codex',
          label: '릴레이 재시작 절차 정리',
          requested_host_id: null,
          default_host_id: 'h-2',
          host_candidates: rows,
        },
      });
      if (parsed === null) {
        return (
          <Frame label="스폰 픽커">
            <Text style={styles.lockedLabel}>픽스처가 픽커로 읽히지 않는다</Text>
          </Frame>
        );
      }
      return (
        <Frame label="스폰 픽커 — 고를 수 있을 때 / 무장 뒤 잠겼을 때 (리뷰 B1)">
          <View style={styles.lockedFrame}>
            <Text style={styles.lockedLabel}>고를 수 있다 (무장 전)</Text>
            <SpawnHostChoice
              plan={parsed}
              pickedHostId="h-2"
              onPick={() => {}}
              locked={false}
              testIDPrefix="measure-live"
            />
          </View>
          <View style={styles.lockedFrame}>
            <Text style={styles.lockedLabel}>
              잠겼다 (무장 뒤) — 고른 것은 남고, 누를 수 있다는 신호는 빠진다
            </Text>
            <SpawnHostChoice
              plan={parsed}
              pickedHostId="h-2"
              onPick={() => {}}
              locked
              testIDPrefix="measure-locked"
            />
          </View>
        </Frame>
      );
    }
    // ---- #2945 GC-4: 폰 `/연결` 카드 — 읽기 + 운영자 연결 확인 -----------------
    //
    // 시안 `mockups.html` 「폰」 판의 세 장: `/연` 목록 · 로컬 카드(운영자) · 그리고
    // 시안에 없는 비운영자 한 줄. 카드는 **배송되는 컴포넌트 그대로**이고, 팀 연결은
    // 설정과 같은 쿼리 키에 씨앗을 뿌린다(하네스 클라이언트는 네트워크로 안 나간다).
    case 'ai-connect-slash': {
      saveDraft('measure:ai-connect-slash', '/연');
      return (
        <Frame label="폰 /연 — 명령 목록 (#2945)">
          <View style={styles.aiConnectFill}>
            <MessageRow
              message={AI_CONNECT_ASK}
              startsGroup
              directory={DIRECTORY}
              chips={CHIPS}
              nowMs={NOW}
            />
          </View>
          <Composer
            recipient="place"
            channelLabel="에이전트-실험"
            directory={DIRECTORY}
            draftKey="measure:ai-connect-slash"
            onSend={() => {}}
            onSlashCommand={() => {}}
          />
        </Frame>
      );
    }
    case 'ai-connect-card':
    case 'ai-connect-card-mine':
    case 'ai-connect-card-denied': {
      if (name === 'ai-connect-card-mine') {
        // AIH-4 (#3399): 내 구독 에이전트의 서버 상태. 하네스는 데이터를 받지 않으므로
        // 명부와 호스티드 연결 목록에 씨앗을 뿌린다(쿼리 키는 앱 것 그대로).
        harnessClient.setQueryData(TEAM_QUERY_KEY, AI_CONNECT_LINK);
        harnessClient.setQueryData(['roster', AIH4_WS], AIH4_ROSTER);
        harnessClient.setQueryData(
          ['hosted-agents', 'connections', AIH4_WS],
          AIH4_CONNECTIONS,
        );
      } else if (name === 'ai-connect-card') {
        harnessClient.setQueryData(TEAM_QUERY_KEY, AI_CONNECT_LINK);
      } else {
        harnessClient
          .getQueryCache()
          .build(harnessClient, {queryKey: [...TEAM_QUERY_KEY]})
          .setState({
            status: 'error',
            error: new ApiError(403, 'forbidden'),
            fetchStatus: 'idle',
          });
      }
      return (
        <Frame
          label={
            name === 'ai-connect-card'
              ? '폰 로컬 카드 — 운영자 (#2945)'
              : name === 'ai-connect-card-mine'
                ? '폰 로컬 카드 — 내 에이전트 (#3399)'
                : '폰 로컬 카드 — 비운영자 (#2945)'
          }>
          {/* 앱과 같은 `ConversationLayout` — 자판이 오르면 카드와 입력창이 함께
              들린다(자판 위 접힘 캡처, maestro 92). */}
          <ConversationLayout
            list={
              <View style={styles.aiConnectFill}>
                <MessageRow
                  message={AI_CONNECT_ASK}
                  startsGroup
                  directory={DIRECTORY}
                  chips={CHIPS}
                  nowMs={NOW}
                />
              </View>
            }
            composer={
              <AiConnectCardWithComposer
                mine={
                  name === 'ai-connect-card-mine'
                    ? {workspaceId: AIH4_WS, memberId: AIH4_ME}
                    : undefined
                }
              />
            }
          />
        </Frame>
      );
    }
    case 'memory-card-ready':
      return (
        <Frame label="안 읽은 동안 — 요약 (#3166)">
          <MissedDigestCardView
            state={MEMORY_READY}
            onDismiss={() => {}}
            onMore={() => {}}
            onOpenEvidence={() => {}}
          />
          <MessageRow
            message={{...MESSAGE, seq: 25, body: '스테이징 점검 결과 공유드려요.'}}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
          />
        </Frame>
      );
    case 'memory-card-states': {
      const stateFrames: [string, MissedCardState][] = [
        ['로딩', {kind: 'loading'}],
        ['오류', {kind: 'error'}],
        ['아직 요약 전', {kind: 'notSummarized'}],
        ['요약할 게 없음', {kind: 'empty'}],
        ['꺼짐 (내 일시정지)', {kind: 'off', cause: 'me'}],
        ['일부만 요약됨', {kind: 'ready', digests: MEMORY_DIGESTS.slice(0, 1), partial: true}],
      ];
      return (
        <Frame label="안 읽은 동안 — 상태 여섯 (#3166)">
          <ScrollView>
            {stateFrames.map(([label, state]) => (
              <View key={label}>
                <Text style={styles.label}>{label}</Text>
                <MissedDigestCardView
                  state={state}
                  onDismiss={() => {}}
                  onRetry={() => {}}
                  onMore={() => {}}
                  onOpenEvidence={() => {}}
                />
              </View>
            ))}
          </ScrollView>
        </Frame>
      );
    }
    case 'memory-chip': {
      harnessClient.setQueryData(memoryKeys.receipt(MEMORY_WS, MEMORY_RUN), MEMORY_RECEIPT);
      return (
        <Frame label="기억 n개 참고 — 에이전트 답 (#3166)">
          <MessageRow
            message={MEMORY_TURN}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={{
              myMemberId: SELF,
              onToggleReaction: async () => {},
              onEdit: async () => {},
              onDelete: async () => {},
              workspaceId: MEMORY_WS,
              onOpenMemoryEvidence: () => {},
            }}
          />
        </Frame>
      );
    }
    case 'memory-proposal':
    case 'memory-proposal-self': {
      seedMemoryProposal(
        name === 'memory-proposal-self'
          ? {...MEMORY_PROPOSAL, requesterMemberId: SELF, callerIsRequester: true}
          : MEMORY_PROPOSAL,
      );
      return (
        <Frame
          label={
            name === 'memory-proposal-self'
              ? '기억해 둘게요 — 내 질문에서 나온 제안 (#3171)'
              : '기억해 둘게요 — 에이전트 답 아래 (#3171)'
          }>
          <MessageRow
            message={MEMORY_TURN}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW}
            actions={{
              myMemberId: SELF,
              onToggleReaction: async () => {},
              onEdit: async () => {},
              onDelete: async () => {},
              workspaceId: MEMORY_WS,
              onOpenMemoryEvidence: () => {},
            }}
          />
        </Frame>
      );
    }
    case 'memory-proposal-states':
    case 'memory-proposal-decided': {
      seedMemoryProposal(MEMORY_PROPOSAL);
      const decided: MemoryProposal = {...MEMORY_PROPOSAL, evidence: [], evidenceMessageIds: []};
      const frames: [string, ProposalView, boolean][] =
        name === 'memory-proposal-states'
          ? [
              ['게스트 — 읽기 전용', {kind: 'readOnly', cause: 'guest'}, false],
              ['처리 중', {kind: 'pending', selfWarning: false, failed: false}, true],
              ['처리 실패', {kind: 'pending', selfWarning: false, failed: true}, false],
            ]
          : [
              ['기억함', {kind: 'accepted'}, false],
              ['기억하지 않음', {kind: 'rejected'}, false],
              ['다른 곳에서 정해짐(409)', {kind: 'stale', cause: 'closed'}, false],
              ['기한 지남', {kind: 'stale', cause: 'expired'}, false],
            ];
      return (
        <Frame label={name === 'memory-proposal-states' ? '기억해 둘게요 — 읽기 전용·처리 중·실패 (#3171)' : '기억해 둘게요 — 결정된 넷 (#3171)'}>
          <ScrollView>
            {frames.map(([label, view, busy]) => (
              <View key={label}>
                <Text style={styles.label}>{label}</Text>
                <MemoryProposalCardView
                  proposal={view.kind === 'pending' || view.kind === 'readOnly' ? MEMORY_PROPOSAL : decided}
                  workspaceId={MEMORY_WS}
                  directory={DIRECTORY}
                  view={view}
                  busy={busy}
                  onAccept={() => {}}
                  onReject={() => {}}
                  onOpenEvidence={() => {}}
                />
              </View>
            ))}
          </ScrollView>
        </Frame>
      );
    }
    case 'memory-sheet':
    case 'memory-sheet-plain': {
      const receipt: MemoryReceipt =
        name === 'memory-sheet'
          ? MEMORY_RECEIPT
          : {...MEMORY_RECEIPT, servedCount: 3, withheldCount: undefined};
      const model = receiptSheetModel(receipt);
      return (
        <Frame label={name === 'memory-sheet' ? '칩 시트 — 보류 있음 (#3166)' : '칩 시트 — 목록이 더 짧음 (#3166)'}>
          <MemoryDigestSheet
            title={RECEIPT_SHEET_TITLE}
            summary={receiptSheetSummary(model.count)}
            digests={model.digests}
            withheld={model.withheld}
            listShorter={model.listShorter}
            onClose={() => {}}
            onOpenEvidence={() => {}}
          />
        </Frame>
      );
    }
    case 'memory-pause': {
      harnessClient.setQueryData(memoryKeys.settings(MEMORY_WS), MEMORY_SETTINGS);
      return (
        <Frame label="설정 페이지 — 기억 (#3166 → #4457)">
          <ScrollView contentContainerStyle={styles.settingsBody}>
            <MemoryPauseSection workspaceId={MEMORY_WS} />
          </ScrollView>
        </Frame>
      );
    }
    case 'composer-offline': {
      // **글을 미리 넣어 둔다 — 배송되는 경로로.** 빈 컴포저 둘을 나란히 두면 두
      // 버튼이 똑같이 꺼져 있고(위는 「보낼 것이 없다」, 아래는 「지금 못 보낸다」),
      // 그 사진은 이 배치가 고친 것을 하나도 보여 주지 않는다. 초안을 심으면
      // 위 버튼이 켜지고 아래만 꺼진 채로 남아 대조가 생긴다.
      //
      // 그리고 심는 방법이 곧 두 번째 증거다: `saveDraft` → `draftKey` 는 앱이
      // 실제로 쓰는 그 경로이고, 아래 상자에 글이 남아 있는 것이 오프라인 문장
      // 「쓰던 글은 그대로 있고」가 참이라는 그림이다.
      const line = '릴레이 재시작 절차를 문서에 적어 뒀습니다.';
      saveDraft('measure:composer-online', line);
      saveDraft('measure:composer-offline', line);
      return (
        <Frame label="컴포저 — 보낼 수 있을 때 / 지금은 못 보낼 때 (감사 H-10)">
          <Composer recipient="place"
            channelLabel="배포"
            directory={DIRECTORY}
            draftKey="measure:composer-online"
            onSend={() => {}}
          />
          <View style={styles.gap} />
          <Composer recipient="place"
            channelLabel="배포"
            directory={DIRECTORY}
            draftKey="measure:composer-offline"
            offline
            onSend={() => {}}
          />
        </Frame>
      );
    }
    // ---- #1422 (폰 계측): 빈 컴포저의 문장이 이 화면에서 몇 줄인가 -----------
    case 'composer-placeholder': {
      // 웹은 이 질문에 이미 답이 있다(`gate-work-panel.mjs` 가 실렌더로 잰다).
      // 폰에는 대응물이 없었고, 예산은 웹보다 빡빡하다 — 상자는 260pt(알약 이전 바의 값) 로 더 넓은데
      // 글자가 16pt 라 두 단 크다(`composerCopy.ts` 의 산술).
      //
      // 그래서 **배송되는 `Composer` 를 그대로** 세 번 세운다. 이름은 코어 스위트가
      // 훑는 그 셋이다: 예산 안에 드는 이름 · 게이트 픽스처의 이름 · 이 레포가
      // 「이미 넘친다」고 적어 둔 이름. 위에 붙은 계측 줄이 같은 문장을 입력창의
      // 폭에서 재서 줄 수를 적는다 — 사진과 숫자가 같은 화면에 있어야 사진이
      // 「몇 줄인지 보인다」는 주장을 대신 해 주지 않는다.
      return (
        <Frame label="컴포저 플레이스홀더 — 절 단위 생략의 폰 예산 (#1422)">
          <PlaceholderProbe />
          {PLACEHOLDER_LABELS.map(label => (
            <View key={label}>
              <Composer
                recipient="place"
                channelLabel={label}
                directory={DIRECTORY}
                draftKey={`measure:composer-placeholder:${label}`}
                // + 원이 서야 입력창이 대화 화면과 **같은 칸**이다(대상이 없으면 Composer 는 + 를 안
                // 그리고 입력창이 그만큼 넓어져 계측이 배송되지 않는 폭을 잰다).
                attachmentTarget={{workspaceId: 'measure-ws', channelId: label}}
                inputRef={PLACEHOLDER_INPUT_REFS[label]}
                onSend={() => {}}
              />
              <View style={styles.gap} />
            </View>
          ))}
        </Frame>
      );
    }
    // ---- #1443 (#1422 이월): 성장 상한이 글자 크기를 따라가는가 -------------
    case 'composer-growth': {
      // **두 상자를 나란히.** 위는 사람이 친 다섯 줄, 아래는 빈 상자다. 이 한
      // 장이 답해야 하는 것이 그 둘이기 때문이다 — #1422 가 남긴 사진은 빈
      // 상자뿐이라 「플레이스홀더가 긴 탓 아니냐」는 질문에 답하지 못했고, 정작
      // 아픈 쪽은 사람이 친 글이다.
      //
      // 방 이름은 라틴 토큰이 든 것으로 고른다: 같은 사진이 라틴 낱말이 어디서
      // 끊기는지도 함께 든다(#1422 가 「release-2」로 잘려 남긴 두 번째 축).
      saveDraft('measure:composer-growth:typed', GROWTH_DRAFT);
      return (
        <Frame label="컴포저 성장 상한 — 동적 타입 (#1443)">
          <GrowthProbe inputRef={GROWTH_INPUT_REF} />
          <Composer
            recipient="place"
            channelLabel={GROWTH_LABEL}
            directory={DIRECTORY}
            draftKey="measure:composer-growth:typed"
            inputRef={GROWTH_INPUT_REF}
            onSend={() => {}}
          />
          <View style={styles.gap} />
          <Composer
            recipient="place"
            channelLabel={GROWTH_LABEL}
            directory={DIRECTORY}
            draftKey="measure:composer-growth:empty"
            onSend={() => {}}
          />
        </Frame>
      );
    }
    // ---- #1480: 시트가 열린 동안 대화가 남는가 ------------------------------
    case 'mention-sheet': {
      // **시트는 진짜로 열려야 한다.** 이 표면의 주장이 「도크가 열을 안 넘는다」
      // 이므로, 시트를 흉내 낸 사본을 세우면 사진은 그 사본의 기하를 잰다.
      //
      // 여는 것도 **사람이 하는 그대로**다: 시트를 여는 것은 `@` 한 글자이고, 그
      // 글자는 `maestro/90-mention-sheet-capture.yaml` 이 시뮬레이터에 실제로
      // 친다(초안으로 심어 두는 길은 실측으로 기각했다 — `focus()` 도
      // `setSelection` 도 iOS 에서 `onSelectionChange` 를 안 내보내므로 컴포저의
      // 캐럿이 0 에 머물고, 화면에는 캐럿이 `@` 뒤에 보이는데 목록은 안 열린다.
      // 그 자리는 컴포저의 캐럿 초기값 문제이고 이 티켓의 것이 아니다).
      return (
        <Frame label="멘션 시트 — 열린 동안 대화가 남는가 (#1480)">
          <MentionSheetProbe />
          <Composer
            recipient="place"
            channelLabel="배포"
            directory={MENTION_DIRECTORY}
            onSend={() => {}}
          />
        </Frame>
      );
    }
    // ---- AIH-9b (#3440): AI 보조 줄이 든 시트 ------------------------------
    case 'mention-sheet-ai': {
      // 시트를 여는 것은 `maestro/96-mention-sheet-ai-capture.yaml` 이 치는 `@` 한 글자다
      // (위 `mention-sheet` 와 같은 까닭). 로스터의 첫 여섯이 서로 다른 여섯 가지 에이전트다.
      return (
        <Frame label="멘션 시트 — AI 보조 줄·칩·잠금 (AIH-9b)">
          <MentionSheetProbe annotated />
          <Composer
            recipient="place"
            channelLabel="배포"
            directory={AI_DIRECTORY}
            viewerHumanId={SELF}
            onSend={() => {}}
          />
        </Frame>
      );
    }
    case 'composer-agent-notice': {
      // 글에 못 부르는 에이전트가 있는 두 입력창: 남의 구독(위) · 쉬는 중(아래). 초안은 배송되는
      // 경로(`saveDraft` → `draftKey`)로 심는다 — 한 줄은 캐럿이 아니라 글을 읽는다.
      saveDraft('measure:agent-notice-other', '@seoyeon-claude 이번 배포 확인해 줘');
      saveDraft('measure:agent-notice-paused', '@paused-claude 어제 건 이어서 봐 줘');
      return (
        <Frame label="입력창 위 한 줄 — 못 부르는 · 쉬는 에이전트 (AIH-9b)">
          <Composer
            recipient="place"
            channelLabel="배포"
            directory={AI_DIRECTORY}
            viewerHumanId={SELF}
            draftKey="measure:agent-notice-other"
            onSend={() => {}}
          />
          <View style={styles.gap} />
          <Composer
            recipient="place"
            channelLabel="배포"
            directory={AI_DIRECTORY}
            viewerHumanId={SELF}
            draftKey="measure:agent-notice-paused"
            onSend={() => {}}
          />
        </Frame>
      );
    }
    // ---- 이슈 1137 (ADE 3단계, 폰): 요약 한 줄 · 관제 목록 ------------------
    case 'ade-summary': {
      // **두 스택을 한 장에.** 이 배치가 고른 자리가 옳은지는 위(헤더 아래)와
      // 아래(컴포저 액세서리 스택)가 같은 사진에 있어야만 확인된다 — 이 파일이
      // 여백·접기·틴트·잠긴 픽커에서 네 번 쓴 그 규율이다. 위의 한 줄은
      // 워크스페이스 전역 집계이고 아래 줄들은 이 채널의 것이며, 둘이 같은 낱말로
      // 다른 모집단을 세는지가 여기서 눈으로 갈린다.
      //
      // 컴포지션은 `ConversationLayout` 그대로다. 그 파일이 자기가 이름을 가진
      // 이유를 적어 두었다 — "Naming the composition means `measure/` renders the
      // tree that ships."
      // 액세서리 스택에는 **이 채널의 턴만** 간다. 그것이 그 스택의 계약이고
      // (`agentTurnsInChannel` 로 좁힌다), 위의 한 줄이 좁히지 않는다는 사실이
      // 바로 이 대조에서 읽힌다: 아래는 한 줄, 위는 두 방의 넷.
      const channelTurns = ADE_TURNS.filter(
        turn => turn.channelId === 'ch-deploy',
      );
      return (
        <Screen>
          <Text style={styles.label}>
            ADE 요약 줄 — 헤더 아래 (워크스페이스 전역) ↕ 컴포저 액세서리 스택 (이 채널)
          </Text>
          <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-title" />
          <AdeSummaryLine onPress={() => {}} />
          <ConversationLayout
            list={
              <Timeline
                messages={ADE_TIMELINE}
                directory={ADE_DIRECTORY}
                status="ready"
                channelKind="public"
                myMemberId={SELF}
                nowMs={NOW + 900_000}
                // 대화 화면과 같은 꼬리(#4264) — 이 표면의 도크는 작업 중 줄 + 작성 중 줄이라 꼬리 기본 8 이면 제품보다 8 느슨하게 찍힌다.
                tailGap={CONV.conversationTail}
              />
            }
            composer={
              <>
                <AgentActivityBar
                  turns={channelTurns}
                  directory={ADE_DIRECTORY}
                  nowMs={Date.now()}
                  live
                />
                <TypingBar segments={typingSegments(['박서연'])} />
                <Composer recipient="place"
                  channelLabel="배포"
                  directory={ADE_DIRECTORY}
                  draftKey="measure:ade-summary"
                  onSend={() => {}}
                />
              </>
            }
          />
        </Screen>
      );
    }
    // ---- #3661: 긴 기록이 있는 방에서 `@` 를 치면 대화가 흔들리는가 --------------
    case 'mention-sheet-live': {
      // 시트·도크·목록이 **한 트리**에 있어야 흔들림이 보인다: 시트가 열리면 도크가 자라고,
      // 따라가는 목록의 보이는 창이 줄어든다. 목록은 한 화면을 넘는 기록을 든다.
      return (
        <Screen>
          <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-title" />
          <ConversationLayout
            list={
              <Timeline
                messages={JUMP_PILL_HISTORY}
                directory={AI_DIRECTORY}
                status="ready"
                channelKind="public"
                myMemberId={SELF}
                nowMs={NOW + 3_600_000}
              />
            }
            composer={
              <Composer
                recipient="place"
                channelLabel="배포"
                directory={AI_DIRECTORY}
                viewerHumanId={SELF}
                draftKey="measure:mention-sheet-live"
                onSend={() => {}}
              />
            }
          />
        </Screen>
      );
    }
    case 'ade-summary-empty': {
      // **줄이 없는 판.** 「살아 있는 작업이 없으면 줄 자체가 없다」는 코어의 판정
      // 이고(`adeSummarySegments`), 그것이 참인지는 줄이 **있는** 사진 옆에서만
      // 확인된다 — 빈 띠를 남겼는지, 남겼다면 컴포저가 그만큼 밀렸는지가 두 장을
      // 겹쳐 보면 바로 나온다. 이 파일이 여백·접기·틴트·잠긴 픽커에서 네 번 쓴
      // 그 규율의 다섯 번째 적용이다.
      //
      // 이 표면만 씨앗을 안 받는다(파일 맨 아래 `seedAdeControl` 호출 참조).
      return (
        <Screen>
          <Text style={styles.label}>
            ADE 요약 줄 — 살아 있는 작업이 없을 때 (줄도, 빈 띠도 없다)
          </Text>
          <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-title" />
          <AdeSummaryLine onPress={() => {}} />
          <ConversationLayout
            list={
              <Timeline
                messages={ADE_TIMELINE}
                directory={ADE_DIRECTORY}
                status="ready"
                channelKind="public"
                myMemberId={SELF}
                nowMs={NOW + 900_000}
              />
            }
            composer={
              <Composer recipient="place"
                channelLabel="배포"
                directory={ADE_DIRECTORY}
                draftKey="measure:ade-summary-empty"
                onSend={() => {}}
              />
            }
          />
        </Screen>
      );
    }
    case 'ade-panel': {
      // 관제 목록. 카드 다섯 장이 **세 상태와 세 생존성 등급**을 한 장에 세운다:
      // 대기(호스트 연결 끊김 · 이 기기에서만) · 실행 중(기기를 꺼도 계속됩니다)
      // · 유휴 · 그리고 호스트가 없는 턴 둘(배지 자체가 없다).
      //
      // 「해당 없음」과 「모른다」가 다른 사실이라는 코어의 판정은 턴 카드에
      // 배지가 **없다**는 것으로만 사진에 나타난다 — 세션 카드 옆에서만 보인다.
      //
      // **사진은 첫 폴링 창 안에서 찍는다.** 이 화면의 세션 질의는 20초 간격을
      // 요구하고(`ADE_SESSION_POLL_MS`), 하네스에는 답할 서버가 없어서 그 첫 tick
      // 이 질의를 오류로 만든다 — 그러면 씨앗으로 채운 카드들 위에 「불러오지
      // 못했습니다」 배너가 함께 서고, 그 사진은 두 가지를 동시에 주장하게 된다
      // (실측: 25초에 찍은 첫 판이 정확히 그렇게 나왔다). 실패 배너 자체는 별도
      // 단정이 지킨다(`__tests__/adeControlSurface.test.tsx`).
      return (
        <RealtimeContext.Provider value={CONNECTED_RAIL}>
          <AdeControlPanel
            onClose={() => {}}
            onOpenChannel={() => {}}
            onOpenAnchor={() => {}}
          />
        </RealtimeContext.Provider>
      );
    }
    // ---- #2864: 「작업」 = 팀 보드 한 열 판 + 읽기 전용 시트 ------------------
    //   team-board · team-board-mine · team-board-detail · team-board-detail-agent
    //   team-board-detail-nopr · team-board-empty · team-board-empty-mine
    case 'team-board':
    case 'team-board-mine':
    case 'team-board-empty':
    case 'team-board-empty-mine':
    case 'team-board-error':
      return (
        <TeamBoardScreen
          active
          initialFilter={
            name === 'team-board-mine' || name === 'team-board-empty-mine'
              ? 'mine'
              : 'all'
          }
          onOpenConversation={() => {}}
          onBack={() => {}}
        />
      );
    // ---- #3842 (ADR-0202 U1): 결과 중심 「작업」 한 화면 + 시트 -------------------
    //   work-jobs · work-jobs-team · work-jobs-detail · work-jobs-approval · work-jobs-empty
    case 'work-jobs':
    case 'work-jobs-team':
    case 'work-jobs-empty':
      return (
        <WorkJobsScreen
          active
          initialFilter={name === 'work-jobs-team' ? 'team' : 'mine'}
          onOpenConversation={() => {}}
          onBack={() => {}}
        />
      );
    case 'work-jobs-detail':
    case 'work-jobs-approval':
      return (
        <>
          <WorkJobsScreen
            active
            initialFilter="mine"
            onOpenConversation={() => {}}
            onBack={() => {}}
          />
          <TeamBoardDetailSheet
            item={name === 'work-jobs-approval' ? WORK_JOBS_ROWS[0] : WORK_JOBS_ROWS[2]}
            nowMs={Date.now()}
            onClose={() => {}}
            onOpenChannel={() => {}}
          />
        </>
      );
    case 'team-board-detail':
    case 'team-board-detail-agent':
    case 'team-board-detail-nopr': {
      const item =
        name === 'team-board-detail-agent'
          ? TEAM_BOARD_AGENT_ROW
          : name === 'team-board-detail-nopr'
            ? TEAM_BOARD_ROWS[3]
            : TEAM_BOARD_ROWS[0];
      return (
        <>
          <TeamBoardScreen
            active
            onOpenConversation={() => {}}
            onBack={() => {}}
          />
          <TeamBoardDetailSheet
            item={item}
            nowMs={Date.now()}
            onClose={() => {}}
            onOpenChannel={() => {}}
            onOpenAgentSession={
              name === 'team-board-detail-agent' ? () => {} : undefined
            }
          />
        </>
      );
    }
    case 'work-detail':
      return (
        <WorkSessionDetailScreen
          active
          sessionId="measure-work-t1"
          onBack={() => {}}
          onOpenConversation={() => {}}
        />
      );
    // N2 (#3594): 돌고 있는 작업에 답 조각이 이어 붙는 모습. 하네스에는 소켓이 없어 가짜
    // 레일이 프레임을 ~1.5초 뒤 두 조각, ~6초 뒤 한 조각 흘린다(실제 구독 경로를 그대로 탄다).
    case 'work-detail-streaming':
      return <WorkStreamingSurface />;
    // N4 (#3596): 돌고 있는 작업의 「멈추기」 - 평소 / 확인 단계 / 멈춤. 위쪽을 끌어내려 찍는다.
    case 'work-detail-stop':
    case 'work-detail-stop-confirm':
    case 'work-detail-stopped':
      return (
        <WorkSessionDetailScreen
          active
          sessionId="measure-work-t1"
          onBack={() => {}}
          onOpenConversation={() => {}}
          stopInitial={
            name === 'work-detail-stop-confirm'
              ? {stage: 'confirm'}
              : name === 'work-detail-stopped'
                ? {stage: 'stopped'}
                : undefined
          }
        />
      );
    // 같은 작업이 끝난 모습: 조각들이 영속돼 한 줄로 합쳐지고 「작성 중」이 사라진다.
    case 'work-detail-done':
      return (
        <View style={{flex: 1, overflow: 'hidden'}}>
          <View style={{flex: 1, marginTop: -940, height: 3000}}>
            <WorkSessionDetailScreen
              active
              sessionId="measure-work-t1"
              onBack={() => {}}
              onOpenConversation={() => {}}
            />
          </View>
        </View>
      );
    // #3152: 같은 화면을 진행 내역까지 끌어올려 찍는다(시뮬레이터는 스크롤할 수 없다).
    case 'work-detail-events':
      return (
        <View style={{flex: 1, overflow: 'hidden'}}>
          <View style={{flex: 1, marginTop: -880, height: 3000}}>
            <WorkSessionDetailScreen
              active
              sessionId="measure-work-t1"
              onBack={() => {}}
              onOpenConversation={() => {}}
            />
          </View>
        </View>
      );
    // 이슈 #1146 N4 — 「메시지 검색」으로 가는 두 문을 한 장에.
    //
    // 이름은 이제 셋(도착한 화면의 제목과 이 두 문)이 코어의 표면 판정표 한 줄
    // 에서 함께 받는다. 그러니 사진이 증명할 것은 낱말이 무엇인가가 아니라 **그
    // 낱말이 이 폭에 들어가는가**다: 헤더 액션은 제목 옆 오른쪽 끝에 앉고, 넘김
    // 줄은 스스로 폭을 갖는 알약이라 둘 다 글자 수가 늘면 가장 먼저 깨진다.
    case 'search-entry':
      return (
        <Frame label="메시지 검색으로 가는 두 문 · 눈과 귀가 같은 이름">
          <ScreenHeader
            title="대화"
            right={<SearchEntryAction onPress={() => {}} />}
          />
          <SearchFallthrough query="배포" onPress={() => {}} />
        </Frame>
      );
    case 'search-idle':
      return (
        <Frame label="검색 · 입력 전">
          <SearchBody search={search('idle')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-searching':
      return (
        <Frame label="검색 · 찾는 중">
          <SearchBody search={search('searching')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-empty':
      return (
        <Frame label="검색 · 결과 없음 — 범위를 함께 말한다">
          <SearchBody search={search('empty')} renderItem={() => <View />} />
        </Frame>
      );
    case 'search-error':
      return (
        <Frame label="검색 · 오류 — 다시 시도가 있다">
          <SearchBody search={search('error')} renderItem={() => <View />} />
        </Frame>
      );
    // ---- #1210 D2: 되돌릴 수 없는 확정 버튼 ----------------------------------
    //
    // 이 제품에서 **파괴 채움이 실제로 그려지는 유일한 화면**이고, 그동안 한 번도
    // 촬영된 적이 없었다. 이유는 픽스처의 게으름이 아니라 도달 불가였다: 확정
    // 버튼은 사람이 한 번 탭해야 나타나고 시뮬레이터는 스크립트로 누를 수 없다
    // (스파이크 #837 — 이 파일 머리말이 하네스가 존재하는 이유로 적어 둔 그 사실).
    // 그래서 「거부가 승인보다 다크에서 5배 조용하다」(감사 2026-08-09 §B-4 ②)는
    // 코드에는 있고 사진에는 없었다. `initialArmed` 가 그 도달 불가를 닫는다.
    //
    // 세 줄을 한 장에 세운다. 논점이 **위계**라서 한 줄만 찍으면 사진에 안 나온다:
    //   ① 승인 확정 — 주 액션 채움(`accent`)
    //   ② 거부 확정 — 파괴 채움(`dangerFill`). 이 goal 이 고친 자리다.
    //   ③ 턴 중단 확정 — 같은 파괴 채움을 쓰는 두 번째 컨트롤
    // 라이트 판은 `-momoMeasure LIGHT-DESTRUCTIVE-CONFIRM`.
    case 'destructive-confirm':
      return (
        <Frame label="확정 단계 — 승인 · 거부 · 중단 (#1210 D2)">
          {/* 가로 인셋은 하네스가 준다. 앱에서 이 컨트롤은 언제나 `SAFE_GUTTER`
              가 걸린 행·카드 안에 앉으므로, 인셋 없이 찍으면 버튼이 화면 가장
              자리에 붙어 실제로 배송되는 폭이 아닌 것이 사진에 남는다. */}
          <View style={styles.noticeStack}>
            <ApprovalDecision
              approvalId="ap-1"
              onSettled={() => {}}
              testIDPrefix="measure-approve"
            />
            <StopTurnControl
              runId="run-1"
              agentName="김인턴"
              initialArmed
              onOutcome={() => {}}
              testIDPrefix="measure-stop"
            />
          </View>
        </Frame>
      );
    case 'search-results':
      return (
        <Frame label="검색 · 결과">
          <SearchResults />
        </Frame>
      );
    // ---- #1503: 에이전트 상세의 세션 행과 수명주기 칩 한 벌 ------------------
    //
    // 이 장이 답해야 하는 물음은 색표가 아니라 **행이 읽히는가**다. 그 자리는
    // #1503 이전에 오른쪽 끝의 작은 글자였고(실행 중만 초록), 이제 다른 두 표면과
    // 같은 알약이다 — 제목이 한 줄을 채울 때 알약이 제목을 밀어내지 않는지, 그리고
    // 「호스트 연결 끊김」처럼 긴 낱말이 390pt 에서 어떻게 서는지가 사진의 몫이다.
    //
    // 아래 칩 한 벌은 코어 역할표 여섯 칸을 나란히 세운다. 이 화면이 내는 상태는
    // 다섯이고(`workSessionStatus` 는 `unavailable` 을 내지 않는다) 나머지 한 칸은
    // 세션 목록 쪽에서만 서므로, 그 칸이 강조를 벗은 것을 보이려면 표를 통째로
    // 세우는 수밖에 없다.
    case 'agent-sessions':
      return (
        <Frame label="에이전트 상세 · 세션 행 (#1503)">
          {AGENT_DETAIL_SESSIONS.map(session => (
            <SessionRow
              key={session.id}
              session={session}
              hosts={AGENT_DETAIL_HOSTS}
            />
          ))}
          <Text style={styles.label}>수명주기 칩 여섯 — 코어 역할표 그대로</Text>
          <View style={styles.statusStrip}>
            {AGENT_DETAIL_STATUS.map(status => (
              <WorkStatusBadge key={status.key} status={status} />
            ))}
          </View>
        </Frame>
      );
    // ---- #1964: 데스크탑의 「여기부터 안 읽음」을 폰이 소비한다 --------------
    //
    // 두 장이 한 쌍이다. 사이드바는 **세 행을 나란히** 세운다 — 마크만 있는 방
    // (서버 `unread_count` 0), 평범하게 안 읽은 방, 다 읽은 방. 「마크한 방도 안 읽음
    // 으로 보인다」는 주장은 다 읽은 방 옆에서만 사진으로 읽힌다. 구분선 장은 같은
    // 레드 프루프(마크 3 · 커서 10 · head 10)를 `ConversationScreen` 이 얼리는 그
    // 두 함수로 풀어 배송되는 `Timeline` 에 건넨다.
    // ---- DS2-2 (#2714): 폰 셸 — 시안 A #a-home 과 나란히 놓을 판 ------------
    //
    // 셸을 **그대로** 세운다(`Shell`). 탭·시트가 열린 판은 시작값으로 고른다 —
    // 시뮬레이터는 누를 수 없으므로(하네스 머리 주석). 캡션을 달지 않는다: 시안과
    // 나란히 놓는 사진이라 화면 위에 글자가 한 줄이라도 더 서면 대조가 흐려진다.
    case 'shell-home':
    case 'shell-home-idle':
    case 'shell-home-approval':
    case 'shell-home-loading':
    case 'shell-home-empty':
    case 'shell-home-error':
      // DS2-3 (#2715): 홈 — 작업 중 카드(살아 있는 레일), 빈 카드 자리, 승인 대기,
      // 그리고 목록의 세 상태. 씨앗은 `seedShell` 이 표면 이름으로 고른다.
      return (
        <RealtimeContext.Provider value={CONNECTED_RAIL}>
          <Shell />
        </RealtimeContext.Provider>
      );
    // 레일이 끊긴 홈: 카드가 색을 벗고 이유를 말한다.
    case 'shell-home-offline':
      return <Shell />;
    // #3342: 탭 배지 — 홈 점(안 읽음) + 인박스 알약(결정 대기 승인 2 + 안 읽은 멘션 2 = 4).
    case 'shell-badges':
      return (
        <RealtimeContext.Provider value={CONNECTED_RAIL}>
          <Shell />
        </RealtimeContext.Provider>
      );
    // 같은 수가 인박스 필터 칩에서 두 몫(결정 대기 2 · 멘션 2)으로 보인다.
    case 'shell-inbox-badges':
      return <Shell initialNav={{...INITIAL_NAV, tab: 'inbox'}} />;
    // #3992: 실제 셸·실제 화면에서 **당김이 실패**하는 판(캐시된 목록이 있는 홈·인박스). 씨앗은 평소 판과 같고,
    // 요청은 처음 12초 동안 끝나지 않다가(씨앗이 첫 그림에서 오류로 바뀌지 않게) 그 뒤부터는 곧바로 전송 오류로 끝난다.
    // 12초 뒤에 당긴다: 실패 안내가 목록 위에 서서 시간이 지나도 사라지지 않는다.
    case 'shell-home-pullfail':
      return (
        <RealtimeContext.Provider value={CONNECTED_RAIL}>
          <Shell />
        </RealtimeContext.Provider>
      );
    case 'shell-inbox-pullfail':
      return <Shell initialNav={{...INITIAL_NAV, tab: 'inbox'}} />;
    // 「작업 끝남」 푸시를 눌렀을 때 도착하는 곳: 실제 항법 reducer 가 지은 상태 그대로다
    // (홈 탭 위에 작업 목록, 그 위에 세션). 푸시 자체는 시뮬레이터에 보낼 수 없어 도착
    // 화면만 찍는다.
    case 'shell-work-from-push':
      return (
        <Shell
          initialNav={navReducer(INITIAL_NAV, {
            type: 'openWorkSessionFromNotification',
            workSession: {sessionId: 'measure-work-t1'},
          })}
        />
      );
    case 'shell-inbox':
      return <Shell initialNav={{...INITIAL_NAV, tab: 'inbox'}} />;
    // #3923: 인박스 맨 위의 멈춤 줄. 진짜 셸의 진짜 인박스이고 서버는 씨앗이다(`seedPause`).
    // `pause` 는 방해 금지에 묶여 일시 중지가 켜진 흔한 모양(기한 있음), `pause-open` 은 기한 없는
    // 옛 행(성재 계정의 15일), `pause-dnd` 는 일시 중지는 꺼졌는데 상태만 방해 금지인 모양이다.
    // `pause-date` 는 기한이 사흘 뒤 아침이라 「10월 20일(화) 오전 9:00까지」처럼 날짜가 붙는 가장 긴 모양
    // (design-review M3), `pause-failure` 는 쓰기가 늦게 실패하는 서버(`seedPause`)다.
    case 'shell-inbox-pause':
    case 'shell-inbox-pause-open':
    case 'shell-inbox-pause-dnd':
    case 'shell-inbox-pause-offline':
    case 'shell-inbox-pause-date':
    case 'shell-inbox-pause-failure':
      return <Shell initialNav={{...INITIAL_NAV, tab: 'inbox'}} />;
    case 'shell-search':
      return <Shell initialNav={{...INITIAL_NAV, tab: 'search'}} />;
    // DS2-2b (#2750): + 메뉴와 그 뒤의 두 시트. 배치 비교안 (a)(알약 안 네 번째
    // 칸)는 비교 캡처 뒤 걷었다 — PR #2750 「배치 비교」.
    case 'shell-plus-menu':
      return <Shell initialCreate="menu" />;
    case 'shell-new-dm':
      return <Shell initialCreate="dm" />;
    case 'shell-new-channel':
      return <Shell initialCreate="channel" />;
    // 검수 R1 B1: 층이 열리면 크롬이 그 **밑**에 있어야 한다. 대화 층을 연 판.
    case 'shell-conversation':
      return (
        <Shell
          initialNav={{
            ...INITIAL_NAV,
            conversation: {channelId: 'ch-agent-lab', title: '#agent-lab'},
          }}
        />
      );
    // #3588 N8: 「작업 맡기기」 시트의 네 판. 시트는 셸 위에 뜬다(실제 앱과 같은 층).
    case 'shell-delegate-a':
    case 'shell-delegate-b':
    case 'shell-delegate-error':
    case 'shell-delegate-empty':
      return (
        <View style={styles.fill}>
          <Shell />
          <DelegateWorkSheet
            prefill={delegatePrefill(name)}
            preview={delegatePreview(name)}
            boardAvailable
            onClose={() => {}}
            onSubmitted={() => {}}
          />
        </View>
      );
    // #3597 T6b: 「내 맥에 보내기」 시트의 판. 보내기 포트는 하네스에서 가짜다(Face ID 없음).
    case 'shell-ask-on':
    case 'shell-ask-work':
    case 'shell-ask-off':
    case 'shell-ask-signing':
    case 'shell-ask-waiting':
    case 'shell-ask-first':
      return (
        <View style={styles.fill}>
          <Shell />
          <AskMacSheet
            onClose={() => {}}
            onUseAgent={() => {}}
            onOpenSession={() => {}}
            onOpenWorkList={() => {}}
            waitTimeoutMs={3_600_000}
            preview={askPreview(name)}
          />
        </View>
      );
    // #3598 N10: + 메뉴의 「AI」 시트. off = 지금 사용자가 보는 모습(내 맥으로 보내는 길이 아직
    // 안 꽂혀 에이전트 구획만), on = 승격 뒤 모습(내 도구 · 개인 에이전트 + 맥 켜짐 칩),
    // mac-off = 같은 판에서 맥이 꺼진 칩. 게이트는 시트의 `gateOpen` 으로 강제한다.
    case 'shell-ai-off':
    case 'shell-ai-on':
    case 'shell-ai-mac-off':
      return (
        <View style={styles.fill}>
          <Shell />
          <AiSheet
            onClose={() => {}}
            onDelegate={() => {}}
            onOpenAgentList={() => {}}
            onAskMac={() => {}}
            onOpenApps={() => {}}
            gateOpen={name !== 'shell-ai-off'}
          />
        </View>
      );
    // #3638: 부팅이 꽂는 **진짜** 포트(`bootSpawnPort`)로 게이트가 열린 AI 시트. `gateOpen`을
    // 강제하지 않는다 — 내 도구·개인 에이전트 구획이 포트의 `wired`만으로 선다.
    case 'shell-ai-wired':
      return (
        <View style={styles.fill}>
          <Shell />
          <AiSheet
            onClose={() => {}}
            onDelegate={() => {}}
            onOpenAgentList={() => {}}
            onAskMac={() => {}}
            onOpenApps={() => {}}
          />
        </View>
      );
    // #3638: 폰 컴포저의 `@<내 개인 에이전트>` 호출. 진짜 셸·진짜 컴포저·진짜 포트이고, 서버만
    // 하네스의 가짜 `fetch`다(`seedCall`). Maestro가 채널을 열고 글을 쳐서 보낸다.
    case 'shell-call-key':
    case 'shell-call-flag-off':
      return (
        <RealtimeContext.Provider value={CONNECTED_RAIL}>
          <Shell />
        </RealtimeContext.Provider>
      );
    // #3905: 새 버전 배너가 선 진짜 홈(피드는 하네스가 캐시에 꽂는다. 시뮬레이터 빌드 번호 1 < 3036).
    case 'shell-update-home':
      return (
        <View style={styles.fill}>
          <Shell />
        </View>
      );
    // #3905: 프로필 시트의 「내 상태」 위 배너.
    case 'shell-update-profile':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(SHELL_ROSTER)}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
          />
        </View>
      );
    // #3905: 배너를 누르면 열리는 시트. TestFlight 판과 스토어 판.
    case 'shell-update-sheet':
    case 'shell-update-sheet-store':
      return (
        <View style={styles.fill}>
          <Shell />
          <AppUpdateSheet
            offer={{
              version: '0.1.29',
              latestBuild: 3036,
              currentBuild: 3035,
              testflight: name === 'shell-update-sheet',
            }}
            onClose={() => {}}
          />
        </View>
      );
    // #4937: 업데이트 뒤 처음 열 때 올라오는 「업데이트 소식」 시트(실제 v0.1.41 소식). 시뮬레이터 빌드 번호는 1 이라 앱이 스스로는
    // 이 시트를 올리지 않는다(어느 소식도 붙지 않는다): 이 판이 시트를 직접 세운다. 「자세히 보기」는 `-page` 판이 보인다.
    case 'shell-release-notes-sheet':
    case 'shell-release-notes-sheet-en':
      return (
        <MobileLocaleProvider
          createController={name === 'shell-release-notes-sheet' ? releaseNotesKo : releaseNotesEn}>
          <View style={styles.fill}>
            <Shell />
            <ReleaseNotesSheet
              note={RELEASE_NOTES[0]}
              onClose={() => {}}
              onOpenDetails={() => {}}
            />
          </View>
        </MobileLocaleProvider>
      );
    // #4937: 설정의 「업데이트 소식」 장(버전 목록). 버전을 누르면 내용 장이 밀려 들어온다(`release-notes-row-0.1.41`).
    case 'shell-release-notes-page':
    case 'shell-release-notes-page-en':
      return (
        <MobileLocaleProvider
          createController={name === 'shell-release-notes-page' ? releaseNotesKo : releaseNotesEn}>
          <View style={styles.fill}>
            <Shell />
            <SettingsOverlay
              initialPage="releaseNotes"
              workspaceId={HARNESS_MEMBER.workspaceId}
              member={SETTINGS_ME}
              directory={settingsDirectory(SHELL_ROSTER)}
              connected
              onSignOut={() => {}}
              onClose={() => {}}
            />
          </View>
        </MobileLocaleProvider>
      );
    // #4384: 프로필 사진 장. 진짜 셸 위의 진짜 프로필 시트가 사진 장으로 열린다(`initialPage="avatar"`).
    // `-photo` 는 내 사진이 있는 사람(지우기 줄이 선다), `-offline` 은 연결이 끊긴 때(세 줄 잠김),
    // `-denied` 는 사진 접근이 꺼진 때(고르기를 누르면 문장 + 「설정 열기」 — Maestro 가 누른다).
    // 시뮬레이터에는 카메라가 없어 「사진 찍기」 줄은 서지 않는다(의도).
    case 'shell-avatar-sheet':
    case 'shell-avatar-sheet-photo':
    case 'shell-avatar-sheet-offline':
    case 'shell-avatar-sheet-denied':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            initialPage="avatar"
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(
              name === 'shell-avatar-sheet-photo'
                ? SHELL_ROSTER.map(member =>
                    member.id === SELF
                      ? {
                          ...member,
                          avatarUrl: `/v1/workspaces/${ADE_WS}/members/${SELF}/avatar/content?v=media-1`,
                        }
                      : member,
                  )
                : SHELL_ROSTER,
            )}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
          />
        </View>
      );
    // #4663: 설정 › 「명령줄·AI 도구」 장(목록·지우기). 진짜 셸 위의 진짜 설정 페이지가 이 장으로 열린다(`initialPage="devTools"`).
    //   (기본)    소유자: 연결 넷(카드 · 한 번도 안 쓴 카드 · 로그인 세션 · 직접 정한 범위) + 「컴퓨터에서 만든다」·관리자 안내
    //   -member   만들 수 없는 멤버: 같은 목록 + 「관리자가 켜 줘야 해요」
    //   -empty · -loading · -error · -offline   나머지 상태. 지우기 확인은 눌러야 서므로 `maestro/119-dev-tools-capture.yaml`.
    //   -entry    설정 본 페이지의 「연결」 카드(아래로 끝까지): 「명령줄·AI 도구 ›」 행이 선 모습.
    case 'shell-dev-tools':
    case 'shell-dev-tools-member':
    case 'shell-dev-tools-empty':
    case 'shell-dev-tools-loading':
    case 'shell-dev-tools-error':
    case 'shell-dev-tools-offline':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            initialPage="devTools"
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(SHELL_ROSTER)}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
          />
        </View>
      );
    case 'shell-dev-tools-entry':
      return <SettingsBottomSurface devTools />;
    // #4457: 테마 안쪽 장. 진짜 셸 위의 설정 페이지가 테마 장으로 열린다(`initialPage="theme"`) — 화면 모드·테마·강조색·배경
    // 네 묶음이 한 장에 선다(스크롤은 `shell-settings-theme-*` 가 아니라 Maestro 가 한다).
    case 'shell-settings-theme':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            initialPage="theme"
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(SHELL_ROSTER)}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
          />
        </View>
      );
    case 'shell-profile-sheet':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(SHELL_ROSTER)}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
          />
        </View>
      );
    // #4457: 설정 페이지의 **끝** — 계정 카드(로그아웃 위험 행)와 버전 줄. 고정 오프셋 대신 스크롤을 끝까지 내려
    // 어떤 기기·글자 크기에서도 같은 장면(맨 아래)이 서게 한다. 로그아웃의 확인 블록은 눌러야 서므로
    // `maestro/113-settings-sheet-capture.yaml` 이 `sign-out` 을 눌러 찍는다(여기 `onSignOut` 은 아무것도 지우지 않는다).
    case 'shell-profile-bottom':
      return <SettingsBottomSurface />;
    // #4457: 보이는 상태 글이 있는 사람의 설정 페이지(상태 알약 옆 글 + 「상태 설정」 행의 값). 「상태 설정」 시트가 이
    // 사람의 저장된 만료를 「지금대로」로, 「상태 지우기」 행을 서게 한다(Maestro 가 행을 눌러 시트를 연다).
    // `-long`: 80자 글(코어 상한)과 **다른 날** 만료 — 설정 행의 값과 상태 시트 기간 행의 값(「지금대로 · 10월 27일 16:11까지」)이
    // 한 줄 말줄임으로 잘리지 않고 두 줄까지 읽히는지(design-review r1 M5).
    case 'shell-profile-status':
    case 'shell-profile-status-long':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(
              SHELL_ROSTER.map(member =>
                member.id === SELF
                  ? name === 'shell-profile-status-long'
                    ? {
                        ...member,
                        statusEmoji: '🏠',
                        statusText:
                          '달무리 스튜디오 온보딩 자료를 정리하는 중이라 답이 조금 늦어요. 급하면 전화 주세요. 월요일부터는 평소처럼 바로 볼게요. 이번 주도 고생 많았',
                        statusExpiresAtMs: Date.now() + 30 * 60 * 60 * 1000,
                      }
                    : {
                        ...member,
                        statusEmoji: '🚌',
                        statusText: '출근 중',
                        statusExpiresAtMs: Date.now() + 3 * 60 * 60 * 1000,
                      }
                  : member,
              ),
            )}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
          />
        </View>
      );
    // #3342: 프로필의 「알림」 묶음 — 푸시 종류 스위치. 시트를 알림 묶음이 보이도록 끌어올려 찍는다.
    // #4316: 묶음에 두 줄(「메시지 미리보기」「보낸 사람 표시」)이 늘어 카드가 그만큼 길어졌다 — 맨 위 「푸시 알림」 줄이
    // 상태 막대 밑으로 잘리지 않게 끌어올림을 560 에서 500 으로 줄였다.
    case 'shell-profile-notify':
      return (
        <Screen>
          <View style={{flex: 1, overflow: 'hidden'}}>
            <View style={{marginTop: -500, height: 3000}}>
              <View style={styles.settingsBody}>
                <SettingsContent
                  workspaceId={HARNESS_MEMBER.workspaceId}
                  member={SETTINGS_ME}
                  directory={settingsDirectory(SHELL_ROSTER)}
                  connected
                  onOpenTheme={() => {}}
                  onOpenStatus={() => {}}
                  onOpenDeviceKey={() => {}}
                  onOpenPauseUntil={() => {}}
                  onOpenDndUntil={() => {}}
                  onSignOut={() => {}}
                  onRevealEnd={() => {}}
                />
              </View>
            </View>
          </View>
        </Screen>
      );
    // #2899: 알림 일시 중지·방해 금지의 기한. 진짜 셸 위의 진짜 프로필 시트이고 서버는 씨앗이다
    // (`seedPause`). `status`는 방해 금지 줄 오른쪽의 끝나는 때, `notify`는 일시 중지 줄과 그
    // 아래 기한 줄, `notify-open`은 옛 판이 만든 기한 없는 행(「기한 없음 · 기한 정하기」)이다.
    // `until*` 은 시트 안의 기한 장이다 — 「직접 고르기」는 Maestro(99-pause-until-capture)가 연다.
    case 'shell-pause-status':
    case 'shell-pause-notify':
    case 'shell-pause-notify-open':
    case 'shell-pause-until':
    case 'shell-pause-until-open':
    case 'shell-pause-until-dnd':
    case 'shell-pause-until-offline':
      return (
        <View style={styles.fill}>
          <Shell />
          <SettingsOverlay
            workspaceId={HARNESS_MEMBER.workspaceId}
            member={SETTINGS_ME}
            directory={settingsDirectory(pauseRoster(name))}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
            initialPage={
              name === 'shell-pause-until-dnd'
                ? 'dndUntil'
                : name.startsWith('shell-pause-until')
                  ? 'pauseUntil'
                  : 'main'
            }
          />
        </View>
      );
    // #3924: 프로필 「알림」 묶음의 첫 줄 — 이 폰의 푸시 스위치. 기본 세 상태(켬 · 끔 · OS 거부)에 아래 몇 가지를 더한다.
    // 시트를 알림 묶음이 머리에 오도록 끌어올려 찍는다. iOS 의 답과 「껐다」는 기억은
    // `seedPush` 가 정한다 — 스위치·설명·잠김은 배송되는 `usePushSwitch` 가 그 값에서 그린다.
    // `-ax` 두 판은 접근성 글자 크기(`simctl ui content_size accessibility-extra-extra-large`)용이다:
    // 위쪽 줄들이 함께 커져 알림 묶음이 더 아래로 밀리므로 끌어올림이 다르다.
    // `-undetermined` 는 iOS 가 아직 묻지 않은 폰, `-checking` 은 iOS 의 답이 아직 오지 않은 「읽는
    // 중」이다. `-busy`·`-failed` 는 **눌러야만** 서는 상태라 정지 사진이 아니라
    // `maestro/99-push-switch-capture.yaml` 이 진짜로 눌러 찍는다(서버 자리만 `seedPush` 의 가짜가 진다).
    // `shell-profile-load-failed`(#4457 r3 M1): 알림 규칙·종류별 스위치·기억 설정을 **읽지 못한** 설정 페이지 — 「다시 불러오기」 세
    // 행이 선다(강조색 글자여야 눌리는 줄로 읽힌다). 서버가 500 으로 답하는 가짜 `fetch`(`seedLoadFailed`).
    case 'shell-profile-load-failed':
    case 'shell-profile-push-on':
    case 'shell-profile-push-off':
    case 'shell-profile-push-denied':
    case 'shell-profile-push-off-ax':
    case 'shell-profile-push-denied-ax':
    case 'shell-profile-push-undetermined':
    case 'shell-profile-push-checking':
    case 'shell-profile-push-busy':
    case 'shell-profile-push-failed':
    case 'shell-profile-push-failed-ax':
      return (
        <Screen>
          <ScrollView
            // 고정 오프셋에서 시작하되 **스크롤은 살아 있다**: 접근성 최대 글씨에서는 알림 카드가 1000pt 넘게 커져 실패 문장이 접힘선
            // 한참 아래에 선다 — 99번 흐름이 `scrollUntilVisible` 로 내려가야 닿는다(옛 판은 위를 잘라 둔 정지 상자라 스크롤이 없었다).
            contentOffset={{
              x: 0,
              y: name.endsWith('-ax') ? PUSH_CAPTURE_SCROLL_AX : PUSH_CAPTURE_SCROLL,
            }}
            showsVerticalScrollIndicator={false}
            bounces={false}
            style={styles.fill}>
            <View style={styles.settingsBody}>
              <SettingsContent
                workspaceId={HARNESS_MEMBER.workspaceId}
                member={SETTINGS_ME}
                directory={settingsDirectory(SHELL_ROSTER)}
                connected
                onOpenTheme={() => {}}
                onOpenStatus={() => {}}
                onOpenDeviceKey={() => {}}
                onOpenPauseUntil={() => {}}
                onOpenDndUntil={() => {}}
                onSignOut={() => {}}
                onRevealEnd={() => {}}
              />
            </View>
          </ScrollView>
        </Screen>
      );
    case 'mark-unread-sidebar':
      // 캡션은 **아래**에 단다. 이 화면은 자기 `Screen` 이 안전 영역 위쪽을
      // 이미 먹으므로, 위에 달면 상태 막대 밑으로 들어가거나 인셋이 두 번 쌓인다.
      return (
        <View style={styles.fill}>
          <SidebarScreen
            openChannelId={null}
            onOpenConversation={() => {}}
            onOpenSearch={() => {}}
          />
          <Text style={[styles.label, styles.captionBottom]}>
            #배포 = 데스크탑에서 seq 3 부터 안 읽음 (서버 unread_count 0 → 합성 8) ·
            #빌드 = 커서 뒤 3개 · #일반 = 다 읽음 (#1964)
          </Text>
        </View>
      );
    // #3964: DM 줄의 상태 점. 사이드바를 **그대로** 세운다(`SidebarScreen`): 사람은 스스로 정한 자리 비움·
    // 방해 금지와 서버가 명부에 실은 접속 여부(#4692), 에이전트는 서버의 생존 판정이 아바타 모서리의 점이 된다. 캡션을 달지 않는다 — 색을 글자가
    // 설명해 주는 사진은 점이 스스로 말하는지를 증명하지 못한다. `-member` 판은 같은 줄을 일반 멤버가 본
    // 모양이다(경고가 속 빈 고리로 내려간다).
    case 'dm-status-dots':
    case 'dm-status-dots-member':
    case 'dm-status-dots-states':
    case 'dm-status-dots-states-member':
    // #4252·#4367: 「닫은 대화」와 「나간 멤버와의 대화」. 사이드바를 **그대로** 세운다. 서버가 닫기를 싣는 투영 위에서, 내가 닫은 DM
    // 하나·나간 멤버 DM 넷(안 읽음 없음 둘 · 안 읽은 사람 메시지 하나 · 기계 메시지뿐인 안 읽음 하나)과 명부에 있는 DM(꺼진 에이전트
    // 꺼진 개인 에이전트 포함)이 한 목록에 선다. 숨은 DM 은 `maestro/102-gone-dm-capture.yaml` 이 DM 섹션 ⋯ 의 「닫은 대화」로 열고,
    // `maestro/104-dm-close-capture.yaml` 이 행을 길게 눌러 「대화 닫기」를 찍는다. 수리 전 코드로 띄우면 닫은 DM 이 목록에 그대로 선다.
    case 'gone-dm-home':
      return (
        <View style={styles.fill}>
          <SidebarScreen
            openChannelId={null}
            onOpenConversation={() => {}}
            onOpenSearch={() => {}}
          />
        </View>
      );
    case 'mark-unread-divider': {
      const read = markAt3Cursor10({channelId: 'ch-deploy'});
      return (
        <Screen>
          <Text style={styles.label}>
            구분선 = 마크 자리(seq 3 위) · 수 = 합성 8 (서버 unread_count 0) (#1964)
          </Text>
          <ScreenHeader title="배포" onBack={() => {}} titleTestID="measure-title" />
          <ConversationLayout
            list={
              <Timeline
                messages={MARK_UNREAD_TIMELINE}
                directory={DIRECTORY}
                status="ready"
                channelKind="public"
                myMemberId={SELF}
                nowMs={NOW + 900_000}
                lastReadSeq={unreadDividerCursorSeq(read)}
                unreadCount={composedUnreadCount(read)}
              />
            }
            composer={
              <Composer
                recipient="place"
                channelLabel="배포"
                directory={DIRECTORY}
                draftKey="measure:mark-unread-divider"
                onSend={() => {}}
              />
            }
          />
        </Screen>
      );
    }
    default:
      return (
        <Frame label={`알 수 없는 표면: ${name}`}>
          <Text style={styles.label}>
            sheet · delete · editor · editor-error · row · row-lead ·
            approval-card · approval-notes · avatar · composer-offline ·
            composer-placeholder · composer-growth ·
            group · dividers · ade-summary · ade-summary-empty · ade-panel ·
            team-board · work-detail · agent-sessions ·
            destructive-confirm · search-entry · search-idle ·
            search-searching · search-empty · search-error · search-results ·
            mark-unread-sidebar · mark-unread-divider ·
            landed3921-arrival · landed3921-decided ·
            dm-status-dots[-member|-states|-states-member] · gone-dm-home
          </Text>
        </Frame>
      );
  }
}

// ---- #3026 지시 기기 ------------------------------------------------------------
//
// 시뮬레이터에는 Secure Enclave 가 없어 살아 있는 앱은 「쓸 수 없음」 하나만 그린다
// (`device-key-live` 가 그 판이다 — 실제 네이티브 모듈을 읽는다). 나머지 상태는
// 배송되는 `LinkSheetBody`·`DeviceKeyPanel` 에 그 상태를 건네 찍는다.
//
//   -momoMeasure DEVICE-KEY-PENDING · LIGHT-DEVICE-KEY-PENDING · …
//   (pending approved revoked invalidated biometryoff unregistered unsupported
//    servererror registering reconnect reconnecting live profile
//    replace-blocked-old replace-blocked-refused; `<이름>@<y>` = y pt 스크롤)

const DK_KEY = 'A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW';
const DK_FINGERPRINT = '5BAF F89D E7DE 5C1D 7B61';
const DK_ROW: DeviceKey = {
  id: '00000000-0000-7000-8000-00000000d002',
  workspaceId: 'measure-ws',
  memberId: SELF,
  alg: 'p256',
  publicKey: DK_KEY,
  platform: 'ios',
  label: 'iPhone 17 Pro',
  state: 'unendorsed',
  canInstruct: false,
  current: true,
  lineageLive: true,
  createdAtMs: NOW,
};

function dkView(which: string): DeviceKeyView {
  switch (which) {
    case 'approved':
      return {kind: 'approved', fingerprint: DK_FINGERPRINT, row: {...DK_ROW, state: 'endorsed'}, biometryOff: false};
    case 'approved-faceid-off':
      return {kind: 'approved', fingerprint: DK_FINGERPRINT, row: {...DK_ROW, state: 'endorsed'}, biometryOff: true};
    case 'revoked':
      return {kind: 'revoked', fingerprint: DK_FINGERPRINT, row: {...DK_ROW, state: 'revoked'}, biometryOff: false};
    case 'invalidated':
      return {kind: 'invalidated'};
    case 'biometryoff':
      return {kind: 'biometryOff'};
    case 'unregistered':
    case 'registering':
      return {kind: 'unregistered', fingerprint: null};
    case 'unsupported':
      return {kind: 'unsupported'};
    case 'servererror':
      return {kind: 'serverError', fingerprint: DK_FINGERPRINT};
    // #3129: 주소 로그인 폰 · 맥이 아닌 곳의 QR — 「QR 연결 필요」.
    case 'unlinked':
      return {kind: 'unlinked', reason: 'address', fingerprint: null};
    case 'unlinked-notmac':
      return {kind: 'unlinked', reason: 'notFromMac', fingerprint: DK_FINGERPRINT};
    // #3145: the old key still holds the place / the server said 409.
    case 'replace-blocked-old':
      return {kind: 'replaceBlocked', reason: 'oldKey', fingerprint: DK_FINGERPRINT};
    case 'replace-blocked-refused':
      return {kind: 'replaceBlocked', reason: 'registerRefused', fingerprint: null};
    // #3103: live and approved, its sign-in ended — 「다시 연결 필요」.
    case 'reconnect':
    case 'reconnecting':
      return {
        kind: 'reconnect',
        fingerprint: DK_FINGERPRINT,
        row: {...DK_ROW, state: 'endorsed', current: false, lineageLive: false},
        biometryOff: false,
      };
    default:
      return {kind: 'pending', fingerprint: DK_FINGERPRINT, row: DK_ROW, biometryOff: false};
  }
}

function dkState(which: string): DeviceKeyState {
  return {
    view: dkView(which),
    enroll: () => {},
    replace: () => {},
    refresh: () => {},
    busy: which === 'registering' || which === 'reconnecting',
    failure:
      which === 'unregistered'
        ? '지시 기기로 등록하지 못했습니다. 연결을 확인하고 다시 시도하세요.'
        : which === 'reconnect'
          ? 'Face ID를 취소해 다시 연결하지 않았습니다.'
          : null,
  };
}

/** 살아 있는 훅 — 이 시뮬레이터의 네이티브 모듈을 실제로 읽는다. */
function LiveDeviceKeySheet(): React.JSX.Element {
  const state = useDeviceKey(HARNESS_MEMBER.workspaceId, {poll: false});
  return <LinkSheetBody state={state} onClose={() => {}} />;
}

const liveDeviceKeyClient = new QueryClient({
  defaultOptions: {queries: {retry: false, gcTime: 0}},
});

// ---- #3028 R2-E8: 작업 상세의 서명 권한 카드·지시 칸 ------------------------------
//
// 배송되는 `SignedWorkControlsView`에 상태를 건넨다(시뮬레이터는 탭할 수 없다).
// 행동은 흉내다 — Face ID·서버 왕복은 이 사진에 없다(runtime-unverified).
const SW_PERMISSION: PendingPermission = {
  requestEventId: 'ev-1',
  atMs: Date.now() - 60_000,
  tool: {kind: 'edit', headline: '파일을 고쳐도 될까요?'},
  preview: {
    text: 'onboarding/copy.ts\n− 워크스페이스를 만듭니다\n+ 워크스페이스를 만들어요',
    truncated: false,
    omitted: 0,
    masked: 0,
    neutralized: 0,
  },
  previewSha256: null,
  allow: {kind: 'allow_once', optionId: 'once'},
  reject: {kind: 'reject_once', optionId: 'no'},
  hiddenOptions: 0,
};
// #3128: the host's preview as the owner read returns it (the card shows it
// verbatim and opens the allow only when its hash is the request's).
const SW_HOST_PREVIEW: PermissionPreview = {
  schema: 'momo.work_permission.preview.v1',
  kind: 'edit',
  title: 'Edit onboarding/copy.ts',
  locations: '/Users/me/oort/clients/web/src/onboarding/copy.ts:42',
  input:
    '{"new_string":"워크스페이스를 만들어요","old_string":"워크스페이스를 만듭니다","path":"onboarding/copy.ts"}',
  truncated: false,
};
function swGate(which: string): PermissionPreviewGate {
  const read = (preview: unknown) => ({
    status: 'ok' as const,
    data: {
      permissionRequest: {id: 'r', sessionId: 's', requestEventId: 'ev-1', status: 'pending' as const},
      options: [],
      preview,
    },
  });
  const hostHash = permissionPreviewSha256(SW_HOST_PREVIEW);
  if (which === 'preview-loading') return {state: 'loading'};
  if (which === 'preview-mismatch') {
    return permissionPreviewGate(hostHash, read({...SW_HOST_PREVIEW, kind: 'read', title: 'Read README.md'}));
  }
  if (which === 'preview-missing') return permissionPreviewGate(null, read(null));
  if (which === 'preview-unavailable') return permissionPreviewGate(hostHash, {status: 'error'});
  if (which === 'long-preview') {
    const long: PermissionPreview = {
      ...SW_HOST_PREVIEW,
      locations: Array.from({length: 14}, (_, i) => `/Users/me/oort/clients/web/src/onboarding/step${i + 1}.ts`).join('\n'),
      truncated: true,
    };
    return permissionPreviewGate(permissionPreviewSha256(long), read(long));
  }
  return permissionPreviewGate(hostHash, read(SW_HOST_PREVIEW));
}
const SW_ACTIONS: SignedWorkActions = {
  allow: async () => undefined,
  reject: async () => undefined,
  rejectWithInstruction: async () => ({state: 'rejected', instruction: {state: 'sent'}}),
  instruct: async () => ({state: 'sent'}),
};

function SignedWorkSurface({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const blocked = which === 'blocked';
  const initial: SignedWorkInitial | undefined =
    which === 'reject-note'
      ? {asking: true, rejectNote: '그 파일 말고 테스트만 고쳐 줘'}
      : which === 'not-delivered' || which === 'box-not-delivered'
        ? {
            text: '이어서 lint까지 돌려 줘',
            note: {failed: true, text: '전달 안 됨 · Face ID를 취소해서 보내지 않았어요.'},
          }
        : which === 'partial'
          ? {
              outcome: {
                tone: 'partial',
                text: rejectWithInstructionLine(
                  false,
                  '호스트가 90초 넘게 응답하지 않아 보내지 않았어요. 호스트가 켜져 있는지 확인한 뒤 다시 보내 주세요.',
                ),
              },
              text: '그 파일 말고 테스트만 고쳐 줘',
            }
          : which === 'session-sent'
            ? {
                outcome: {
                  tone: 'sent',
                  text: '이 세션 동안 허락을 보냈어요. 이 세션에서 같은 요청은 다시 묻지 않아요.',
                },
              }
            : undefined;
  return (
    <View style={styles.fill}>
      <Screen>
        <ScreenHeader title="온보딩 1단계 문구 다듬기" subtitle="실행 중" onBack={() => {}} backLabel="작업 목록으로" />
        <ScrollView>
          <SignedWorkControlsView
            permission={
              which === 'no-request' || which === 'box-not-delivered'
                ? null
                : SW_PERMISSION
            }
            preview={swGate(which)}
            ended={false}
            online
            block={blocked ? '이 폰은 아직 지시 기기가 아니에요. 프로필 › 지시 기기에서 등록하고 맥의 승인을 받아 주세요.' : null}
            actions={blocked ? null : SW_ACTIONS}
            fallbackReject={blocked ? async () => undefined : null}
            initial={initial}
          />
        </ScrollView>
      </Screen>
    </View>
  );
}

// ---- N3 (#3595) 작업 상세 「대화」 모드 -------------------------------------------
const WC_SELF = 'wc-self';
const WC_SESSION = 'wc-session';
function wcEvent(
  id: string,
  seq: number,
  type: WorkSessionEvent['type'],
  payload: Record<string, unknown> = {},
): WorkSessionEvent {
  return {
    eventId: id,
    type,
    sessionId: WC_SESSION,
    atMs: NOW + seq * 20_000,
    seq,
    payload: {work_session_id: WC_SESSION, ...payload},
  };
}
function WorkChatSurface({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const done = which === 'done';
  const keyboard = which === 'keyboard';
  const asking = which === 'permission';
  const off = which === 'off';
  // #4179: 알약 상태 — 한 줄(typed) · 여러 줄(multi). 키보드는 올리지 않고 글만 심는다.
  const draft =
    which === 'typed'
      ? '마지막에 린트도 돌려 줘'
      : which === 'multi'
        ? '1) 린트 먼저 돌려 주고\n2) 그다음 테스트를 돌려 줘\n3) 끝나면 여기에 알려 줘'
        : keyboard
          ? '마지막에 린트도 돌려 줘'
          : undefined;
  const events: WorkSessionEvent[] = [
    wcEvent('e1', 1, 'agent.status', {terminal_event: 'created'}),
    wcEvent('p1', 3, 'agent.partial', {
      text_delta:
        '네, onboarding/copy.ts의 1단계 문구부터 살펴볼게요. 해요체로 통일하려면 세 곳을 고쳐야 해요.',
    }),
    wcEvent('t1', 4, 'agent.status', {tool_call_name: 'read_file'}),
    wcEvent('p2', 7, 'agent.partial', {
      text_delta: '알겠어요. 테스트 문구는 그대로 두고 화면 문구 세 곳만 바꿀게요.',
    }),
    ...(asking
      ? [wcEvent('a1', 8, 'approval.requested', {action: 'edit', action_type: 'edit'})]
      : []),
    ...(done
      ? [
          wcEvent('p3', 9, 'agent.partial', {
            text_delta: '세 곳 모두 바꿨어요. 테스트는 건드리지 않았고 린트도 통과했어요.',
          }),
          wcEvent('e2', 10, 'agent.status', {terminal_event: 'ended'}),
        ]
      : []),
  ];
  const replies = [
    {
      id: 'r1',
      authorMemberId: WC_SELF,
      text: '온보딩 1단계 문구에서 「만듭니다」를 「만들어요」로 바꿔 줘',
      atMs: NOW + 2 * 20_000,
      seq: 2,
      mode: 'queue' as const,
    },
    {
      id: 'r2',
      authorMemberId: WC_SELF,
      text: '지금 바로 시작하고, 테스트 문구는 건드리지 마',
      atMs: NOW + 6 * 20_000,
      seq: 6,
      mode: 'interrupt' as const,
    },
  ];
  const items = buildConversation({
    events,
    session: {status: done ? 'ended' : 'running'},
    truncated: false,
    replies,
    selfMemberId: WC_SELF,
    pending: [],
    permissionRequestId: asking ? 'a1' : null,
  });
  const gate = done
    ? composerGate({owner: true, ended: true, flag: 'required', block: null, online: true, hasActions: true})
    : off
      ? composerGate({owner: true, ended: false, flag: 'off', block: null, online: true, hasActions: false})
      : composerGate({owner: true, ended: false, flag: 'required', block: null, online: true, hasActions: true});
  return (
    <View style={styles.fill}>
      <Screen>
        <ScreenHeader
          title="온보딩 1단계 문구 다듬기"
          subtitle={done ? '종료됨' : '실행 중'}
          onBack={() => {}}
          backLabel="작업 목록으로"
        />
        <ModeSwitch mode="chat" onChange={() => {}} />
        <WorkConversationView
          items={items}
          agentName="Claude Code"
          nameOf={() => '팀원'}
          gate={gate}
          onSend={async () => ({ok: true})}
          renderPermission={() => (
            <PermissionCard
              permission={SW_PERMISSION}
              preview={swGate('ready')}
              online
              block={null}
              actions={SW_ACTIONS}
              fallbackReject={null}
              lapsed={false}
              onUndelivered={() => {}}
            />
          )}
          initialText={draft}
          autoFocus={keyboard}
        />
      </Screen>
    </View>
  );
}

function DeviceKeySurface({which: rawWhich}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // #3154 M1: `replace-blocked-old@900` 은 시트를 900pt 스크롤한 자리를 찍는다
  // (AX-XXL 에서 지문이 접힌 아래에 있어 한 장으로는 끝까지 보이지 않는다).
  const [which, scroll] = rawWhich.split('@');
  const initialScrollY = scroll ? Number(scroll) : undefined;
  if (which === 'profile') {
    // 프로필 시트의 「연결 › 지시 기기」 줄. 줄은 씨앗을 뿌린 두 질의를 읽는다.
    harnessClient.setQueryData(DEVICE_KEY_LOCAL_QUERY_KEY, {status: 'ready', publicKey: DK_KEY});
    harnessClient.setQueryData(DEVICE_KEYS_QUERY_KEY(HARNESS_MEMBER.workspaceId), [DK_ROW]);
    return (
      <View style={styles.fill}>
        <Shell />
        <SettingsOverlay
          workspaceId={HARNESS_MEMBER.workspaceId}
          member={SETTINGS_ME}
          directory={settingsDirectory(SHELL_ROSTER)}
          connected
          onSignOut={() => {}}
          onClose={() => {}}
        />
      </View>
    );
  }
  if (which === 'profile-page-unlinked') {
    // #3129: 실제 프로필 안쪽 장 — 주소 로그인으로 등록된 승인 불가 키.
    harnessClient.setQueryData(DEVICE_KEY_LOCAL_QUERY_KEY, {status: 'ready', publicKey: DK_KEY});
    harnessClient.setQueryData(DEVICE_KEYS_QUERY_KEY(HARNESS_MEMBER.workspaceId), [
      {...DK_ROW, linkedSession: false, linkedFromMac: false},
    ]);
    return (
      <View style={styles.fill}>
        <Shell />
        <SettingsOverlay
          workspaceId={HARNESS_MEMBER.workspaceId}
          member={SETTINGS_ME}
          directory={settingsDirectory(SHELL_ROSTER)}
          connected
          onSignOut={() => {}}
          onClose={() => {}}
          initialPage="deviceKey"
        />
      </View>
    );
  }
  if (which === 'profile-page' || which === 'profile-page-faceid-off') {
    // 실제 설정 페이지의 안쪽 장 — 머리의 ‹ 뒤로까지 배송되는 그대로(#4457).
    harnessClient.setQueryData(DEVICE_KEY_LOCAL_QUERY_KEY, {
      status: which === 'profile-page' ? 'ready' : 'biometryUnavailable',
      publicKey: DK_KEY,
    });
    harnessClient.setQueryData(DEVICE_KEYS_QUERY_KEY(HARNESS_MEMBER.workspaceId), [
      which === 'profile-page' ? DK_ROW : {...DK_ROW, state: 'endorsed', canInstruct: true},
    ]);
    return (
      <View style={styles.fill}>
        <Shell />
        <SettingsOverlay
          workspaceId={HARNESS_MEMBER.workspaceId}
          member={SETTINGS_ME}
          directory={settingsDirectory(SHELL_ROSTER)}
          connected
          onSignOut={() => {}}
          onClose={() => {}}
          initialPage="deviceKey"
        />
      </View>
    );
  }
  return (
    <View style={styles.fill}>
      <Shell />
      <PageSheet onClose={() => {}} accessibilityLabel="지시 기기">
        {which === 'live' ? (
          <QueryClientProvider client={liveDeviceKeyClient}>
            <LiveDeviceKeySheet />
          </QueryClientProvider>
        ) : (
          <LinkSheetBody state={dkState(which)} onClose={() => {}} initialScrollY={initialScrollY} />
        )}
      </PageSheet>
    </View>
  );
}

/** The results phase draws the shipping row, handed fixture hits. */
function SearchResults(): React.JSX.Element {
  return (
    <SearchBody
      search={search('results', HITS)}
      renderItem={({item}) => (
        <ResultRow
          hit={item}
          query="배포"
          channelTitle={item.channelId === 'ch-1' ? '#배포' : '#일반'}
          authorName="이도현"
          onPress={() => {}}
        />
      )}
    />
  );
}

// =============================================================================
// 이 하네스에는 세션이 없었다 — 그리고 그것이 결합 하나를 드러냈다
//
// U4-4 M1 이 승인 카드에 컨트롤을 세우자 `approval-card` 사진이 **빨간 에러
// 화면**으로 찍혔다: `useSession() was called outside SessionProvider`.
//
// 원인은 하네스의 버그가 아니라 **진짜 결합**이다. `ApprovalDecision` 은
// `workspaceId` 를 세션에서 읽는다(결정을 어느 워크스페이스에 보내는지는 화면이
// 아니라 세션이 안다). 그래서 「행에 게이트를 건네면 그 표면에는 세션이 있어야
// 한다」가 이 배치가 만든 새 계약이고, 하네스는 그 계약을 처음 어긴 호출자였다.
//
// 읽기 전용 표면(하네스·검색 미리보기)이 게이트를 **안** 건네면 세션 없이도
// 그대로 선다 — `actions?` prop 이 이미 쓰는 규율과 같다. 그 사실은 단정으로
// 잠갔다(`approvalCard.test.tsx`).
//
// 여기서는 사진을 찍어야 하므로 세션을 세운다. 가짜 멤버 하나면 되고, 그
// 멤버는 이미 로스터가 만들고 있다 — 목업을 그리는 것이 아니라 **배송되는
// 컴포넌트가 요구하는 문맥을 그대로 주는 것**이다.
// =============================================================================

/**
 * 하네스용 세션. 결정은 전송되지 않는다(사진은 무장 전 상태를 찍는다).
 *
 * 이름과 핸들은 로스터의 그 멤버에서 온다. 핸들이 빠져 있으면 사이드바 발치의
 * 계정 줄이 「@」 한 글자로 찍혀, 증거 사진이 빈 핸들 결함처럼 보였다
 * (design-review 2593 R1 N-1).
 */
const HARNESS_SELF = ROSTER.find(member => member.id === SELF);
const HARNESS_MEMBER = {
  id: SELF,
  workspaceId: HARNESS_WS,
  kind: 'human',
  displayName: HARNESS_SELF?.displayName ?? '이도현',
  handle: HARNESS_SELF?.handle ?? 'dohyun',
} as Member;
/** 설정 표면의 나(가상 인물, `settingsOverlay.tsx`) — 캡처가 레포에 남는다. */
const SETTINGS_ME = {...HARNESS_MEMBER, ...SETTINGS_PERSONA} as Member;
const settingsDirectory = (roster: typeof SHELL_ROSTER) =>
  makeDirectory(settingsPersona(roster, SELF));

export default function SurfacesHarness({
  name,
  scheme,
}: {
  name: string;
  scheme: ColorScheme;
}): React.JSX.Element {
  // 스킴을 **못 박아** 그린다 (U2). `ThemeProvider` 를 쓰면 이 기기에 저장된
  // 사람의 선택이 사진에 새어 들어오고, 시스템 추종에 맡기면 시뮬레이터 설정이
  // 새어 들어온다. 사진은 인자가 말한 것만 찍는다.
  return (
    <FixedScheme
      scheme={scheme}
      bubble={name.startsWith('bubble-row') || name.startsWith('bubble-arrive-row') || name.startsWith('bubble-clip-row') ? {layout: 'row'} : undefined}>
      <SafeAreaProvider>
        <QueryClientProvider client={harnessClient}>
          <SessionProvider member={HARNESS_MEMBER}>
            <Surface name={name} />
          </SessionProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </FixedScheme>
  );
}

const AIH4_WS = '00000000-0000-7000-8000-0000000000a1';
const AIH4_ME = '00000000-0000-7000-8000-0000000000a2';
const AIH4_ROSTER = [
  {id: AIH4_ME, workspaceId: AIH4_WS, kind: 'human', status: 'active', displayName: '이도현', handle: 'dohyun', role: 'owner', channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0},
  {id: '00000000-0000-7000-8000-0000000000a3', workspaceId: AIH4_WS, kind: 'agent', status: 'active', displayName: '도현-claude', handle: 'dohyun-claude', channelCount: 1, channelIds: [], capabilities: [], ownerHumanId: AIH4_ME, createdAtMs: 0, updatedAtMs: 0},
];
const AIH4_CONNECTIONS = [
  {id: 'c1', agentMemberId: '00000000-0000-7000-8000-0000000000a3', status: 'active', authMode: 'bearer', audience: 'oort', approvedChannelIds: [], approvedScopes: [], createdAtMs: 1, updatedAtMs: 1, invocationScope: 'owner_only', subscriptionHarness: 'claude_code'},
];

/** 네트워크로 나가지 않는다. 하네스는 사진을 찍지 데이터를 받지 않는다. */
/**
 * 대화 화면과 같은 배선: 입력창의 키 붙여넣기 안내가 서면 카드가 접힌다
 * (design-review #2945 R3-B1). 스위치 안에서는 훅을 쓸 수 없어 따로 둔다.
 */
function AiConnectCardWithComposer({
  mine,
}: {
  mine?: {workspaceId: string; memberId: string};
}): React.JSX.Element {
  const [keyBlocked, setKeyBlocked] = React.useState(false);
  return (
    <>
      <AiConnectCard
        line={null}
        mine={mine}
        offline={false}
        onClose={() => {}}
        foldForKey={keyBlocked}
      />
      <Composer
        recipient="place"
        channelLabel="에이전트-실험"
        directory={DIRECTORY}
        draftKey="measure:ai-connect-card"
        onSend={() => {}}
        onSlashCommand={() => {}}
        onKeyBlockedChange={setKeyBlocked}
      />
    </>
  );
}

// ---- #3824: 메시지 아래 상태 줄 · 작업 기록 시트 -----------------------------------
//
//   RUN-STATUS  내가 보낸 메시지 세 줄: 깨우는 신호 보냄(대기) · 작업 중 · 완료(걸린 시간)
//   RUN-LEDGER  폰 작업 기록 시트: 걸린 시간, 접힌 깨우는 신호(· 2번), 이 앱이 모르는
//               원장 종류 한 줄
//
// 시각은 `Date.now()` 기준이다. 표면이 지금 시계로 「12분째」를 세므로 고정 `NOW` 를
// 쓰면 사진이 수십 년째라고 말한다. 원장은 하네스 캐시에 씨앗으로 넣는다(같은 키).
const RUN_IDS = {
  woken: '0199aa11-2222-7000-8000-0000000003a1',
  working: '0199aa11-2222-7000-8000-0000000003a2',
  done: '0199aa11-2222-7000-8000-0000000003a3',
} as const;

function runFixture(
  id: string,
  triggerMessageId: string,
  over: Partial<AgentRunProgress>,
): AgentRunProgress {
  const t = Date.now();
  return {
    id,
    channelId: 'ch-measure',
    agentMemberId: AGENT,
    triggerMessageId,
    triggerSummary: '채널 하나 만들어 줄래요? 이름은 grokbot-lab으로요.',
    status: 'queued',
    phase: 'queued',
    leaseState: 'none',
    stepCount: 0,
    ahead: [],
    createdAtMs: t - 4_000,
    updatedAtMs: t - 4_000,
    ...over,
  };
}

function seedRunLedger(runId: string, events: AgentRunLedgerEvent[]): void {
  harnessClient.setQueryData(['agent-run-events', HARNESS_WS, runId], {runId, events});
}

function RunStatusSurface(): React.JSX.Element {
  const t = Date.now();
  const sent = (id: string, body: string, at: number): Message => ({
    ...MESSAGE,
    id,
    authorMemberId: SELF,
    body,
    createdAtMs: at,
  });
  // #4020: 평소의 진행·완료는 줄이 없다(아래 둘째·셋째 글). 깨우는 신호가 닿지 않은
  // 대기와 실패만 글 아래에 선다.
  const woken = runFixture(RUN_IDS.woken, 'm-run-1', {});
  seedRunLedger(RUN_IDS.woken, [
    {ordinal: 1, kind: 'queued', createdAtMs: t - 4_000},
    {ordinal: 2, kind: 'doorbell_rung', code: 'urgent_failed', createdAtMs: t - 3_500},
  ]);
  const working = runFixture(RUN_IDS.working, 'm-run-2', {
    phase: 'running',
    status: 'running',
    leaseState: 'live',
    createdAtMs: t - 12 * 60_000 - 20_000,
    claimedAtMs: t - 12 * 60_000 - 8_000,
    startedAtMs: t - 12 * 60_000,
    lastEventAtMs: t - 65_000,
  });
  seedRunLedger(RUN_IDS.working, [
    {ordinal: 1, kind: 'queued', createdAtMs: t - 12 * 60_000 - 20_000},
    {ordinal: 2, kind: 'doorbell_rung', code: 'leading_ok', createdAtMs: t - 12 * 60_000 - 19_000},
  ]);
  const failed = runFixture(RUN_IDS.done, 'm-run-3', {
    phase: 'failed',
    status: 'failed',
    createdAtMs: t - 40 * 60_000,
    claimedAtMs: t - 40 * 60_000 + 12_000,
    startedAtMs: t - 40 * 60_000 + 14_000,
    finishedAtMs: t - 40 * 60_000 + 192_000,
  });
  return (
    <Frame label="보낸 메시지 아래: 실패·막힘만 줄이 선다 (#3824·#4020)">
      <MessageRow
        message={sent('m-run-3', '@grokbot 어제 회의 요약해 줄래요?', t - 40 * 60_000)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
        runStatus={[failed]}
      />
      <MessageRow
        message={sent('m-run-2', '@grokbot 릴리스 노트 초안 써 줄래요? (진행 중: 줄 없음)', t - 12 * 60_000 - 20_000)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
        runStatus={[working]}
      />
      <MessageRow
        message={sent('m-run-1', '@grokbot 채널 하나 만들어 줄래요? 이름은 grokbot-lab으로요.', t - 4_000)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
        runStatus={[woken]}
      />
    </Frame>
  );
}

/**
 * #4020: 에이전트가 가져가 쓰는 동안 컴포저 위가 「답하는 중」 + 얼굴 + 점을 말하고,
 * 끝난 run의 영수증은 글 아래에 없다. 실패한 run만 남는다. 동작 줄이기에서는 점이 멈춘다
 * (시뮬레이터 설정으로 찍는다).
 */
function RespondingSurface(): React.JSX.Element {
  const t = Date.now();
  const mine = (id: string, body: string, at: number): Message => ({
    ...MESSAGE,
    id,
    authorMemberId: SELF,
    thread: undefined,
    body,
    createdAtMs: at,
  });
  const failed = runFixture(RUN_IDS.done, 'm-resp-1', {
    phase: 'failed',
    status: 'failed',
    createdAtMs: t - 9 * 60_000,
    claimedAtMs: t - 9 * 60_000 + 5_000,
    startedAtMs: t - 9 * 60_000 + 6_000,
    finishedAtMs: t - 8 * 60_000,
  });
  const answered = runFixture(RUN_IDS.woken, 'm-resp-2', {
    phase: 'succeeded',
    status: 'succeeded',
    createdAtMs: t - 6 * 60_000,
    claimedAtMs: t - 6 * 60_000 + 3_000,
    startedAtMs: t - 6 * 60_000 + 4_000,
    finishedAtMs: t - 5 * 60_000,
  });
  const running = runFixture(RUN_IDS.working, 'm-resp-3', {
    phase: 'running',
    status: 'running',
    leaseState: 'live',
    createdAtMs: t - 20_000,
    claimedAtMs: t - 15_000,
    startedAtMs: t - 14_000,
    lastEventAtMs: t - 3_000,
  });
  const turn = signalFromProgress(running);
  return (
    <ConversationFloor label="답하는 중 (#4020)">
      <MessageRow
        message={mine('m-resp-1', '어제 올린 보고서 요약 부탁해요', t - 9 * 60_000)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
        runStatus={[failed]}
      />
      <MessageRow
        message={mine('m-resp-2', 'ㅎㅇ', t - 6 * 60_000)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
        runStatus={[answered]}
      />
      <MessageRow
        message={{
          ...MESSAGE,
          id: 'm-resp-reply',
          authorMemberId: AGENT,
          thread: undefined,
          body: '안녕하세요! 필요한 일 있으면 편하게 말씀해 주세요.',
          createdAtMs: t - 5 * 60_000,
        }}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
      />
      <MessageRow
        message={mine('m-resp-3', '이번 주 일정 정리해 줘', t - 20_000)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={t}
        runStatus={[running]}
      />
      <AgentActivityBar
        turns={turn === null ? [] : [turn]}
        directory={DIRECTORY}
        nowMs={t}
        live
      />
    </ConversationFloor>
  );
}

function RunLedgerSurface(): React.JSX.Element {
  const t = Date.now();
  const at = t - 12 * 60_000 - 20_000;
  const run = runFixture(RUN_IDS.working, 'm-run-2', {
    phase: 'running',
    status: 'running',
    leaseState: 'live',
    createdAtMs: at,
    claimedAtMs: at + 12_000,
    startedAtMs: at + 20_000,
    lastEventAtMs: t - 65_000,
    latestStage: 'grokbot-lab 이름 점검',
    stepCount: 1,
  });
  seedRunLedger(
    RUN_IDS.working,
    agentRunLedgerFromWire({
      runId: RUN_IDS.working,
      events: [
        {ordinal: 1, kind: 'queued', createdAtMs: at},
        {ordinal: 2, kind: 'doorbell_rung', code: 'leading_ok', createdAtMs: at + 1_000},
        {ordinal: 3, kind: 'doorbell_rung', code: 'trailing_ok', createdAtMs: at + 6_000},
        {ordinal: 4, kind: 'tool_call', code: 'ok', createdAtMs: at + 7_000},
        {ordinal: 5, kind: 'claimed', createdAtMs: at + 12_000},
        {ordinal: 6, kind: 'started', createdAtMs: at + 20_000},
        {ordinal: 7, kind: 'stage', stage: 'grokbot-lab 이름 점검', createdAtMs: t - 65_000},
      ],
    }).events,
  );
  return <RunLedgerSheet progress={run} directory={DIRECTORY} onClose={() => {}} />;
}

const harnessClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      enabled: false,
      gcTime: 0,
      // 씨앗을 뿌린 질의가 마운트하자마자 네트워크로 나가지 않게 (이슈 1137).
      // `enabled: false` 는 훅이 명시적으로 `true` 를 넘기면 뒤집히므로, 신선도
      // 쪽에서도 한 번 더 막는다 — 하네스는 사진을 찍지 데이터를 받지 않는다.
      staleTime: Infinity,
    },
  },
});

// ---- #1503: 에이전트 상세의 세션 행 ------------------------------------------
//
// 위 `WORK_CONSOLE_*` 씨앗을 재사용하지 않는 이유는 형태다: 저것들은
// `setQueryData` 로 들어가는 값이라 타입이 없고(`Record<string, unknown>` 스프레드),
// `SessionRow` 는 `WorkSession`/`WorkHost` 를 **타입으로** 받는다. 사진이 배송되는
// 컴포넌트를 찍으려면 그 컴포넌트가 요구하는 모양을 그대로 주는 편이 낫다.
//
// 한 호스트는 데스크톱(T1)이고 하나는 클라우드(T3)다 — 행의 아래 두 줄(등급 문장과
// 「지금 이거 꺼도 되나」)이 상태에 따라 갈리는 것을 같은 장에서 보기 위해서다.
const AGENT_DETAIL_HOSTS: WorkHost[] = [
  {
    id: 'host-mac',
    workspaceId: ADE_WS,
    scope: 'member',
    ownerMemberId: SELF,
    type: 'app',
    displayName: '도현 맥북',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
  {
    id: 'host-cloud',
    workspaceId: ADE_WS,
    scope: 'workspace',
    ownerMemberId: SELF,
    type: 'cloud',
    displayName: 'oort Cloud',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
];

function agentDetailSession(over: Partial<WorkSession> & {id: string}): WorkSession {
  return {
    workspaceId: ADE_WS,
    channelId: 'ch-deploy',
    memberId: AGENT,
    hostId: 'host-cloud',
    rootMessageId: 'm-root',
    tool: 'codex',
    label: '작업',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW - 900_000,
    ...over,
  };
}

/**
 * 이 화면이 실제로 낼 수 있는 갈래들. 제목 하나는 알약을 밀어낼 만큼 길다.
 *
 * 둘째 행이 **도는 클라우드 세션**인 것은 리뷰가 지목한 자리다(M-1): 첫 행은 알약도
 * 앰버(실행 중)고 아래 문장도 앰버(「그 컴퓨터를 끄거나…」 — `atRisk`)라 한 카드에
 * 앰버가 둘이고, 둘째 행은 알약만 앰버이고 문장은 중립이다. 두 장이 나란히 서야
 * 「어느 앰버가 무엇을 벌었는가」를 사람이 볼 수 있다.
 */
const AGENT_DETAIL_SESSIONS: WorkSession[] = [
  agentDetailSession({
    id: 'measure-agent-running',
    hostId: 'host-mac',
    tool: 'codex-app-server',
    label: '릴레이 재시작과 장애 복구 절차를 배포 전에 끝까지 검증하는 작업',
  }),
  agentDetailSession({
    id: 'measure-agent-running-cloud',
    label: '야간 배치',
    tool: 'claude',
    startedAtMs: NOW - 1_200_000,
  }),
  agentDetailSession({
    id: 'measure-agent-idle',
    label: '셀프호스트 회귀 테스트',
    tool: 'prime',
    status: 'idle',
    startedAtMs: NOW - 1_800_000,
  }),
  agentDetailSession({
    id: 'measure-agent-orphaned',
    hostId: 'host-mac',
    label: '호스트가 사라진 마이그레이션',
    tool: 'claude',
    status: 'orphaned',
    startedAtMs: NOW - 2_700_000,
  }),
  agentDetailSession({
    id: 'measure-agent-ended',
    label: '클라우드 배포 점검',
    tool: 'hermes',
    status: 'ended',
    startedAtMs: NOW - 3_600_000,
    endedAtMs: NOW - 3_000_000,
  }),
];

/**
 * 코어 역할표의 여섯 칸을 낱말과 함께. **낱말을 하나도 손으로 적지 않는다** — 여섯
 * 칸 전부가 코어 함수의 반환값이다. `unavailable` 은 `workSessionStatus` 가 내지
 * 않는 키라 원장이 그것을 만드는 조건(도는 세션 + 신호 없는 호스트)을 그대로 세워
 * `workSessionContinuityStatus` 에게 묻는다. 사본을 두면 코어가 낱말을 고친 날
 * 이 사진만 옛말을 하고, 그때 초록이 아니라 **캡션이** 거짓말을 한다.
 */
const AGENT_DETAIL_STATUS: WorkSessionStatus[] = [
  workSessionStatus({status: 'running', exitCode: undefined}),
  workSessionStatus({status: 'idle', exitCode: undefined}),
  workSessionContinuityStatus(
    agentDetailSession({id: 'measure-agent-silent', hostId: 'host-silent'}),
    [{...AGENT_DETAIL_HOSTS[1], id: 'host-silent', online: false}],
  ),
  workSessionStatus({status: 'orphaned', exitCode: undefined}),
  workSessionStatus({status: 'ended', exitCode: undefined}),
  workSessionStatus({status: 'wat', exitCode: undefined}),
];

const WORK_CONSOLE_HOSTS = [
  ...ADE_HOSTS,
  {
    id: 'host-workd',
    workspaceId: ADE_WS,
    scope: 'workspace',
    ownerMemberId: SELF,
    type: 'workd',
    displayName: '서울 셀프호스트 · 장시간 회귀 검증 전용 실행기',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
] as const;

const WORK_CONSOLE_SESSIONS = [
  adeSession({
    id: 'measure-work-t1',
    hostId: 'host-mac',
    rootMessageId: 'measure-work-root',
    label: '릴레이 재시작과 장애 복구 절차를 실제 배포 전에 끝까지 검증하는 작업',
    tool: 'codex-app-server',
    startedAtMs: NOW - 900_000,
  }),
  adeSession({
    id: 'measure-work-t2',
    hostId: 'host-workd',
    label: '셀프호스트 회귀 테스트',
    tool: 'prime',
    status: 'idle',
    startedAtMs: NOW - 1_800_000,
  }),
  adeSession({
    id: 'measure-work-unknown',
    hostId: 'retired-host',
    label: '호스트가 사라진 마이그레이션',
    tool: 'claude',
    status: 'orphaned',
    startedAtMs: NOW - 2_700_000,
  }),
  adeSession({
    id: 'measure-work-t3',
    hostId: 'host-cloud',
    label: '클라우드 배포 점검',
    tool: 'hermes',
    status: 'ended',
    startedAtMs: NOW - 3_600_000,
    endedAtMs: NOW - 3_000_000,
  }),
];

/** Seed the exact query keys the shipping Work Console reads, without a socket. */
/**
 * #3964 사이드바 상태 점 장의 씨앗. 에이전트의 생존 판정은 서버가 답하는 것이라 하네스는 같은 질의 키
 * (`['agent-liveness', ws, id]`)에 답을 **미리 꽂는다** — 화면은 배송되는 `useAgentLiveness` 가 읽는 그대로다.
 * 판정을 `null` 로 꽂으면 「라벨 없음(404)」, 꽂지 않으면 「아직 모름」이다.
 *
 *   김인턴   응답함            → 채운 초록           헤르메스  살아 있음·대기 → 채운 초록(Buzz식: 살아 있음)
 *   코비     꺼짐             → 속 빈 고리           워처      일이 기다림    → 주황(owner 에게만)
 *   레거시봇  판정 없음+호스트 연결 → 초록            조용봇    판정 없음+안 닿음 → 점 없음(DM 없는 에이전트 줄)
 *   이도현   접속 중(`online`)  → 채운 초록           박서연    접속 없음       → 속 빈 회색 고리 (#4692)
 *   한지우   서버가 말하지 않음  → 점 없음(모름)       최민수    자리 비움(+접속 중) → 주황(선언이 먼저)
 *   정하윤   방해 금지(+접속 중) → 빨강
 *
 * `-states` 판은 에이전트 판정 **여덟 상태**를 한 화면에 세운다(응답함·살아 있음·조용함·꺼짐·일이 기다림·안 가져감·
 * 응답 없음·거절됨). 채널은 하나만 둔다(줄이 화면에 다 들어오게).
 */
function seedDmStatusDots(surface: string): void {
  // 서버가 없는 하네스: 질의가 다시 나가도 끝나지 않는 약속으로 둔다(실패하면 세션 만료로 읽혀 캐시가 지워진다).
  void globalThis.fetch;
  void globalThis.Headers;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  resetAgentWorking();
  // 하네스 클라이언트는 `gcTime: 0` 이라 관찰자 없는 씨앗은 곧바로 치워진다. 목록은 일부 줄을 **나중 배치**에 그리므로
  // (`SectionList` 창) 그 줄의 생존 질의는 마운트하기 전에 씨앗이 사라져 점이 서지 못한다. 이 화면의 생존 씨앗만 붙든다.
  harnessClient.setQueryDefaults(['agent-liveness', ADE_WS], {gcTime: Infinity});
  harnessClient.setQueryData(['settings', 'workspace', ADE_WS], {
    id: ADE_WS,
    slug: 'yeomyeong',
    name: '여명거리',
    updatedAtMs: 0,
  });
  const humanTemplate = ROSTER.find(m => m.kind === 'human') ?? ROSTER[0];
  const agentTemplate = ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0];
  const person = (n: string, displayName: string, handle: string, extra: Record<string, unknown> = {}) => ({
    ...humanTemplate,
    id: `00000000-0000-7000-8000-0000000d0${n}`,
    workspaceId: ADE_WS,
    displayName,
    handle,
    ...extra,
  });
  const agent = (n: string, displayName: string, handle: string, extra: Record<string, unknown> = {}) => ({
    ...agentTemplate,
    id: `00000000-0000-7000-8000-0000000d0${n}`,
    workspaceId: ADE_WS,
    displayName,
    handle,
    ...extra,
  });
  const viewer = {
    ...humanTemplate,
    workspaceId: ADE_WS,
    role: surface.endsWith('-member') ? 'member' : 'owner',
  };
  const stateAgents = {
    intern: agent('21', '김인턴', 'intern', {hostOnline: true}),
    hermes: agent('22', '헤르메스', 'hermes', {hostOnline: true}),
    dawn: agent('27', '새벽봇', 'dawn'),
    coby: agent('23', '코비', 'coby', {hostOnline: true}),
    watcher: agent('24', '워처', 'watcher'),
    woken: agent('28', '깨움봇', 'woken'),
    stuck: agent('29', '먹통봇', 'stuck'),
    refused: agent('2a', '막힘봇', 'refused'),
  };
  const peers = {
    // #4692: 서버가 명부에 싣는 접속 여부(`online`). 선언 상태가 먼저이고, 말하지 않은 사람(한지우)은 점이 없다.
    dohyun: person('11', '이도현', 'dohyun', {online: true}),
    seoyeon: person('14', '박서연', 'seoyeon', {online: false}),
    jiwoo: person('15', '한지우', 'jiwoo'),
    minsu: person('12', '최민수', 'minsu', {presenceStatus: 'away', online: true}),
    hayun: person('13', '정하윤', 'hayun', {presenceStatus: 'dnd', online: true}),
    intern: agent('21', '김인턴', 'intern', {hostOnline: true}),
    hermes: agent('22', '헤르메스', 'hermes', {hostOnline: true}),
    coby: agent('23', '코비', 'coby', {hostOnline: true}),
    watcher: agent('24', '워처', 'watcher'),
    legacy: agent('25', '레거시봇', 'legacy', {hostOnline: true}),
    quiet: agent('26', '조용봇', 'quiet', {hostOnline: false}),
  };
  if (surface.startsWith('dm-status-dots-states')) {
    harnessClient.setQueryData(['roster', ADE_WS], [viewer, ...Object.values(stateAgents)]);
    const stateOf: Array<[keyof typeof stateAgents, string]> = [
      ['intern', 'responsive'],
      ['hermes', 'alive_idle'],
      ['dawn', 'quiet'],
      ['coby', 'inactive'],
      ['watcher', 'work_waiting'],
      ['woken', 'woken_not_collected'],
      ['stuck', 'unresponsive'],
      ['refused', 'error'],
    ];
    for (const [key, state] of stateOf) {
      harnessClient.setQueryData(['agent-liveness', ADE_WS, stateAgents[key].id.toLowerCase()], {
        agentMemberId: stateAgents[key].id,
        state,
      });
    }
    harnessClient.setQueryData(['channels', ADE_WS], [
      {id: 'ch-general', workspaceId: ADE_WS, kind: 'public' as const, name: '일반', muted: false},
      ...stateOf.map(([key]) => ({
        id: `dm-${key}`,
        workspaceId: ADE_WS,
        kind: 'dm' as const,
        muted: false,
        memberIds: [viewer.id, stateAgents[key].id],
      })),
    ]);
    harnessClient.setQueryData(['read-state', ADE_WS], []);
    return;
  }
  harnessClient.setQueryData(['roster', ADE_WS], [viewer, ...Object.values(peers)]);
  const liveness = (id: string, state: string | null) =>
    harnessClient.setQueryData(
      ['agent-liveness', ADE_WS, id.toLowerCase()],
      state === null ? null : {agentMemberId: id, state},
    );
  liveness(peers.intern.id, 'responsive');
  liveness(peers.hermes.id, 'alive_idle');
  liveness(peers.coby.id, 'inactive');
  liveness(peers.watcher.id, 'work_waiting');
  liveness(peers.legacy.id, null);
  liveness(peers.quiet.id, null);
  const channel = (id: string, name: string) => ({id, workspaceId: ADE_WS, kind: 'public' as const, name, muted: false});
  const dm = (key: string, peer: {id: string}) => ({
    id: `dm-${key}`,
    workspaceId: ADE_WS,
    kind: 'dm' as const,
    muted: false,
    memberIds: [viewer.id, peer.id],
  });
  harnessClient.setQueryData(['channels', ADE_WS], [
    channel('ch-general', '일반'),
    channel('ch-deploy', '배포'),
    dm('intern', peers.intern),
    dm('hermes', peers.hermes),
    dm('coby', peers.coby),
    dm('watcher', peers.watcher),
    dm('legacy', peers.legacy),
    dm('dohyun', peers.dohyun),
    dm('seoyeon', peers.seoyeon),
    dm('jiwoo', peers.jiwoo),
    dm('minsu', peers.minsu),
    dm('hayun', peers.hayun),
  ]);
  // 다 읽은 줄들: 안 읽음 배지가 점 옆에 서면 점이 읽히는지를 흐린다.
  harnessClient.setQueryData(['read-state', ADE_WS], []);
}

/**
 * #4252·#4367 사이드바 「닫은 대화」·「나간 멤버와의 대화」 장의 씨앗. 서버가 없는 하네스라 화면이 읽는 질의 키(`roster`·`channels`·
 * `read-state`·`agent-liveness`)에 답을 **미리 꽂는다** - 화면은 배송되는 `SidebarScreen` 그대로다. 읽음 투영은 서버가 닫기를 싣는
 * 형상(`latestReadableSeq`·`closedAtSeq` 가 모든 행에 있다)이라 보임 판정이 코어 `dmVisibility` 한 함수로 돈다.
 *
 *   이도현   안 읽음 2                    박서연   다 읽음(닫기를 내민다)
 *   꺼진 개인 에이전트(명부에 **있다** - 숨지 않는 쪽)       grok   응답함
 *   최민수   내가 닫은 DM(closedAtSeq = 읽을 seq) - 목록에 없고 「닫은 대화」 시트에 「내가 닫았어요」로 선다
 *   나간 멤버 ×4  명부에 없는 상대. 둘은 다 읽음(숨는다), 하나는 안 읽은 사람 메시지 1(보인다), 하나는 안 읽음 4 가 전부 기계
 *                 메시지(작업 상태·시스템 줄)라 서버가 읽을 seq 를 읽은 자리에 둔다(숨는다, 이슈 AC 「안 읽은 사람 메시지」)
 *
 * 닫기·다시 열기(`PUT`·`DELETE …/closure`)는 204 로 답한다: 나머지 요청은 끝나지 않는 약속이라 투영은 씨앗 그대로 남고, 닫은 기기가
 * 쓰는 캐시 반영(`applyClosureToReadStates`)만 화면을 바꾼다.
 */
function seedGoneDmHome(): void {
  // 서버가 없는 하네스: 질의가 다시 나가도 끝나지 않는 약속으로 둔다(실패하면 세션 만료로 읽혀 캐시가 지워진다).
  void globalThis.fetch;
  void globalThis.Headers;
  globalThis.fetch = ((url: string) =>
    /\/channels\/[^/]+\/closure$/.test(String(url))
      ? Promise.resolve(new Response(null, {status: 204}))
      : new Promise<Response>(() => {})) as typeof fetch;
  resetAgentWorking();
  harnessClient.setQueryDefaults(['agent-liveness', ADE_WS], {gcTime: Infinity});
  harnessClient.setQueryData(['settings', 'workspace', ADE_WS], {
    id: ADE_WS,
    slug: 'yeomyeong',
    name: '여명거리',
    updatedAtMs: 0,
  });
  const humanTemplate = ROSTER.find(m => m.kind === 'human') ?? ROSTER[0];
  const agentTemplate = ROSTER.find(m => m.kind === 'agent') ?? ROSTER[0];
  const id = (n: string) => `00000000-0000-7000-8000-00000000e0${n}`;
  const person = (n: string, displayName: string, handle: string) => ({
    ...humanTemplate,
    id: id(n),
    workspaceId: ADE_WS,
    displayName,
    handle,
  });
  const agent = (n: string, displayName: string, handle: string, extra: Record<string, unknown> = {}) => ({
    ...agentTemplate,
    id: id(n),
    workspaceId: ADE_WS,
    displayName,
    handle,
    ...extra,
  });
  const viewer = {...humanTemplate, workspaceId: ADE_WS, role: 'owner'};
  const dohyun = person('11', '이도현', 'dohyun');
  const seoyeon = person('12', '박서연', 'seoyeon');
  const minsu = person('13', '최민수', 'minsu');
  const claude = agent('14', '달무리 Claude', 'dalmuri-claude', {hostOnline: false});
  const grok = agent('15', 'grok', 'grok', {hostOnline: true});
  harnessClient.setQueryData(['roster', ADE_WS], [viewer, dohyun, seoyeon, minsu, claude, grok]);
  harnessClient.setQueryData(['agent-liveness', ADE_WS, claude.id.toLowerCase()], {
    agentMemberId: claude.id,
    state: 'inactive',
  });
  harnessClient.setQueryData(['agent-liveness', ADE_WS, grok.id.toLowerCase()], {
    agentMemberId: grok.id,
    state: 'responsive',
  });
  const dm = (key: string, peerId: string) => ({
    id: `dm-${key}`,
    workspaceId: ADE_WS,
    kind: 'dm' as const,
    muted: false,
    memberIds: [viewer.id, peerId],
  });
  harnessClient.setQueryData(['channels', ADE_WS], [
    {id: 'ch-general', workspaceId: ADE_WS, kind: 'public' as const, name: '일반', muted: false},
    dm('dohyun', dohyun.id),
    dm('seoyeon', seoyeon.id),
    dm('minsu', minsu.id),
    dm('claude', claude.id),
    dm('grok', grok.id),
    // 명부에 없는 상대(나감·정지·꺼 둔 개인 에이전트).
    dm('gone-a', id('98')),
    dm('gone-unread', id('97')),
    dm('gone-b', id('99')),
    dm('gone-machine', id('96')),
  ]);
  const read = (
    channelId: string,
    lastReadSeq: number,
    latestSeq: number,
    closedAtSeq: number | null = null,
    latestReadableSeq: number = latestSeq,
  ) => ({
    channelId,
    lastReadSeq,
    latestSeq,
    unreadCount: latestSeq - lastReadSeq,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    latestReadableSeq,
    closedAtSeq,
  });
  harnessClient.setQueryData(['read-state', ADE_WS], [
    read('ch-general', 20, 20),
    read('dm-dohyun', 10, 12),
    read('dm-seoyeon', 5, 5),
    // 내가 닫았다: 닫을 때 seq 가 읽을 seq 와 같다(7번).
    read('dm-minsu', 8, 8, 8),
    read('dm-claude', 9, 9),
    read('dm-grok', 4, 4),
    read('dm-gone-a', 6, 6),
    read('dm-gone-unread', 3, 4),
    read('dm-gone-b', 3, 3),
    // 안 읽음 4 는 전부 기계 메시지: 서버가 읽을 seq 를 읽은 자리(2)에 둔다.
    read('dm-gone-machine', 2, 6, null, 2),
  ]);
}

/**
 * #1964 사이드바 장의 씨앗. 세 방, 세 가지 읽음 상태 — 마크만 있는 방은 서버가 준
 * 그대로 `unreadCount: 0` 이다. 그 0 이 배지로 새면 이 장은 「다 읽음」 두 줄과
 * 「안 읽음」 한 줄이 된다.
 */
function seedMarkUnread(): void {
  harnessClient.setQueryData(['roster', ADE_WS], ADE_ROSTER);
  harnessClient.setQueryData(['channels', ADE_WS], [
    {id: 'ch-deploy', workspaceId: ADE_WS, kind: 'public', name: '배포', muted: false},
    {id: 'ch-build', workspaceId: ADE_WS, kind: 'public', name: '빌드', muted: false},
    {id: 'ch-general', workspaceId: ADE_WS, kind: 'public', name: '일반', muted: false},
  ]);
  const marked = markAt3Cursor10({channelId: 'ch-deploy'});
  harnessClient.setQueryData(['read-state', ADE_WS], [
    marked,
    {
      ...marked,
      channelId: 'ch-build',
      lastReadSeq: 7,
      unreadCount: 3,
      mentionCount: 1,
      markedUnreadBeforeSeq: null,
    },
    {
      ...marked,
      channelId: 'ch-general',
      lastReadSeq: 20,
      latestSeq: 20,
      markedUnreadBeforeSeq: null,
    },
  ]);
}

// ---- DS2-2 (#2714): 셸 판의 씨앗 ---------------------------------------------
//
// 시안 A 홈의 목록을 흉내 낸다(채널 다섯, 에이전트 하나, 사람 둘). 인박스 점은 멘션
// 합(2)이다. 홈 내용의 모양은 DS2-3(#2715)의 몫이라 여기서는 지금의 사이드바가
// 그린다 — 이 판이 보여 주려는 것은 바닥·탭바·FAB·페이지 시트다.
/** 시안 A `#a-home` 의 DM 섹션 사람들 — 김여명 · 박세은 · 이동하. */
const SHELL_HUMANS = [
  {id: '00000000-0000-7000-8000-0000000a0e01', displayName: '김여명', handle: 'yeomyeong'},
  {id: '00000000-0000-7000-8000-0000000a0e02', displayName: '박세은', handle: 'seeun'},
  {id: '00000000-0000-7000-8000-0000000a0e03', displayName: '이동하', handle: 'dongha'},
];

const SHELL_ROSTER = [
  ...ROSTER.map(member => ({...member, workspaceId: ADE_WS})),
  ...SHELL_HUMANS.map(human => ({
    ...(ROSTER.find(m => m.kind === 'human') ?? ROSTER[0]),
    ...human,
    workspaceId: ADE_WS,
  })),
];

// ---- #3588 N8: 작업 맡기기 시트의 판 -------------------------------------------
// 에이전트 셋: 그록봇(호스티드, 승인 채널 둘), 김인턴(쉬는 중), Hermes(호스티드 아님).
const DELEGATE_TEMPLATE = SHELL_ROSTER.find(member => member.kind === 'agent') ?? SHELL_ROSTER[0];
const DELEGATE_GROK = 'measure-agent-grokbot';
const DELEGATE_AGENTS = [
  {
    ...DELEGATE_TEMPLATE,
    id: DELEGATE_GROK,
    displayName: '그록봇',
    handle: 'grokbot',
    channelIds: ['ch-agent-lab', 'ch-release', 'ch-general'],
    paused: false,
  },
  {
    ...DELEGATE_TEMPLATE,
    id: 'measure-agent-intern',
    displayName: '김인턴',
    handle: 'kim-intern',
    channelIds: ['ch-agent-lab'],
    paused: true,
  },
  {
    ...DELEGATE_TEMPLATE,
    id: 'measure-agent-hermes',
    displayName: 'Hermes',
    handle: 'hermes',
    channelIds: ['ch-general'],
    paused: false,
  },
];

function delegatePrefill(name: string): DelegatePrefill {
  if (name === 'shell-delegate-a') return {};
  return {agentMemberId: DELEGATE_GROK};
}

function delegatePreview(name: string): DelegatePreview {
  const pick = {agentMemberId: DELEGATE_GROK, channelId: 'ch-agent-lab'};
  const draft = {
    title: '로그인 버그 고치기',
    brief: '재현 순서는 이슈 #812에 있어요. 원인을 찾고 고친 PR을 올려 주세요.',
  };
  if (name === 'shell-delegate-a') return {pick};
  if (name === 'shell-delegate-b') return {step: 'B', pick, draft};
  if (name === 'shell-delegate-error') {
    return {
      step: 'B',
      pick,
      draft,
      refusal: {
        failure: workRunFailure(
          new ApiError(
            409,
            'this channel is not approved for the hosted agent',
            'hosted_channel_not_approved',
          ),
        ),
        agentId: DELEGATE_GROK,
        channelId: 'ch-agent-lab',
      },
    };
  }
  return {};
}

function askPreview(name: string): AskMacPreview {
  const base: AskMacPreview = {
    channelId: 'ch-agent-lab',
    prompt: '이 에러 메시지가 무슨 뜻인지 알려 줘. TypeError: undefined is not a function',
    signing: 'ready',
  };
  if (name === 'shell-ask-work') {
    return {
      ...base,
      mode: 'work',
      harness: 'codex',
      folderId: 'fld-oort-app',
      prompt: '로그인 버그를 찾아서 고치고 PR을 올려 줘.',
    };
  }
  if (name === 'shell-ask-first') {
    return {signing: 'ready', prompt: '이 에러가 무슨 뜻이야?'};
  }
  if (name === 'shell-ask-signing') return {...base, signing: 'flag_off'};
  if (name === 'shell-ask-waiting') return {...base, waiting: true};
  return base;
}

function seedAsk(surface: string): void {
  const online = surface !== 'shell-ask-off';
  harnessClient.setQueryData(['work-hosts', ADE_WS], [
    {
      id: 'measure-mac',
      workspaceId: ADE_WS,
      scope: 'member',
      ownerMemberId: SELF,
      type: 'workd',
      displayName: '달무리의 MacBook Pro',
      capabilities: {},
      createdAtMs: 0,
      lastSeenAtMs: Date.now(),
      online,
      folders: [
        {id: 'fld-question', displayName: '질문용 폴더', kind: 'question'},
        {id: 'fld-oort-app', displayName: 'oort-app', kind: 'project'},
        {id: 'fld-oort-docs', displayName: 'oort-docs', kind: 'project'},
      ],
      defaultFolderId: 'fld-question',
    },
  ]);
  harnessClient.setQueryData(['work-sessions', ADE_WS], []);
}

function seedAi(surface: string): void {
  // 개인 에이전트는 off 판에도 로스터에 있다 — 게이트가 닫혀 있으면 안 보인다는 것이 그 판의 요점이다.
  harnessClient.setQueryData(['roster', ADE_WS], [
    ...SHELL_ROSTER.filter(member => member.kind !== 'agent'),
    {
      ...(SHELL_ROSTER.find(member => member.kind === 'agent') ?? SHELL_ROSTER[0]),
      id: 'measure-personal-claude',
      displayName: '내 Claude Code',
      handle: 'my-claude',
      personalAgent: {
        label: '내 Claude Code',
        ownerId: SELF,
        ownerDisplayName: '이도현',
        harness: 'claude',
        enabled: true,
        mentionable: true,
      },
    },
  ]);
  harnessClient.setQueryData(['work-hosts', ADE_WS], [
    {
      id: 'measure-mac',
      workspaceId: ADE_WS,
      scope: 'member',
      ownerMemberId: SELF,
      type: 'workd',
      displayName: '달무리의 MacBook Pro',
      capabilities: {},
      createdAtMs: 0,
      lastSeenAtMs: Date.now(),
      online: surface !== 'shell-ai-mac-off',
      folders: [],
      defaultFolderId: null,
    },
  ]);
}

// #3924: 푸시 스위치 판들. 시뮬레이터에는 알림 권한을 허용·거부로 고정하는 길이 없어
// (`simctl privacy` 에 notifications 가 없다) iOS 의 답을 하네스가 정한다. 「껐다」는 기억은
// 진짜 저장소에 적는다 — 하네스의 멤버 id 로 적히므로 이 기기에 로그인한 진짜 멤버의 스위치에는
// 닿지 않는다(`pushOptOut.ts`). 켬·거부 판은 그 기억을 지워 두고 시작한다.
/** `shell-profile-notify` 와 같은 끌어올림: 알림 묶음 머리가 화면 위쪽에 오게. */
/** #4457: 설정 페이지 내용을 진짜 스크롤뷰에 얹고 끝까지 내려 선다(`shell-profile-bottom`). */
function SettingsBottomSurface({devTools = false}: {devTools?: boolean}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const scroll = React.useRef<ScrollView>(null);
  return (
    <Screen>
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => scroll.current?.scrollToEnd({animated: false})}
        // 실제 페이지(`SettingsPage`)와 같은 바닥 여백 — 버전 줄이 홈 인디케이터에 겹치지 않는다.
        contentContainerStyle={[
          styles.settingsBody,
          {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
        ]}
        testID="settings-scroll">
        <SettingsContent
          workspaceId={HARNESS_MEMBER.workspaceId}
          member={SETTINGS_ME}
          directory={settingsDirectory(SHELL_ROSTER)}
          connected
          onOpenTheme={() => {}}
          onOpenReleaseNotes={() => {}}
          onOpenStatus={() => {}}
          onOpenDeviceKey={() => {}}
          onOpenDevTools={devTools ? () => {} : undefined}
          onOpenPauseUntil={() => {}}
          onOpenDndUntil={() => {}}
          onOpenAvatar={() => {}}
          onSignOut={() => {}}
          onRevealEnd={() => scroll.current?.scrollToEnd({animated: true})}
        />
      </ScrollView>
    </Screen>
  );
}

/**
 * 「알림」 묶음의 첫 줄(푸시 스위치)이 화면 위쪽(상태 막대 아래)에 오도록 설정 내용을 끌어올리는 만큼(pt).
 * 기준은 99번 흐름이 누르는 자리다: 줄 `profile-push-row` 의 윗변이 y≈83 이라야 스위치 탭 지점(84%,13%)이 스위치 안에 든다.
 *
 * #4457 이 설정 본 페이지의 구성(얼굴 → 상태 설정 → 내 상태 → 프로필 → 알림)을 바꿔 다시 쟀다(design-review r1 수리 뒤 한 번 더 —
 * 얼굴 96→112 와 「내 상태」의 앞 칸 제거로 기본 글자 크기는 44pt 아래로, AX5 는 글이 덜 접혀 41pt 위로 옮겨 483→527·1295→1254) — iPhone 16 Pro(402×874pt),
 * `maestro hierarchy` 의 `profile-push-row` bounds(윗변이 83 으로 선다; 높이는 상태 문구 줄 수에 따라 다르다): 기본 글자
 * 크기 `shell-profile-push-off` [16,83][385,170], 접근성 최대(AX5, `accessibility-extra-extra-extra-large`)
 * `shell-profile-push-off-ax` [16,83][385,515]. AX 에서는 위쪽 줄들이 함께 커져 알림 묶음이 더 아래로 밀리므로
 * 끌어올림이 다르다. AX 판의 스위치는 줄 가운데에 서므로 흐름은 줄을 누른다(`TAP=row`).
 */
const PUSH_CAPTURE_SCROLL = 527;
const PUSH_CAPTURE_SCROLL_AX = 1254;

/**
 * #4457 r3 M1: 읽기가 실패한 설정 페이지. 푸시 스위치는 켬(허용)으로 세우고, 그 밖의 모든 요청에 서버가 500 으로 답한다 —
 * 세션 만료(401)가 아니라서 캐시가 지워지지 않고, 알림 규칙·종류별 스위치·기억 설정이 각자 「읽지 못함」으로 서서 복구 길
 * (「다시 불러오기」)이 보인다. 세 질의는 재시도를 한 번 거친 뒤 실패로 서므로 캡처는 충분히 기다린다.
 */
function seedLoadFailed(): void {
  seedPush('shell-profile-push-on');
  // 기본 씨앗(`seedShell`)은 알림 규칙·종류별 스위치를 「읽은 것」으로 채워 둔다 — 이 표면은 그 둘을 비워 실제로 다시 읽게 하고(500),
  // 그래서 세 질의가 모두 「읽지 못함」으로 선다.
  // 하네스 클라이언트는 질의를 꺼 두고(`enabled: false`) 씨앗만 읽는다 — 이 두 질의만 켜서 진짜로 500 을 맞게 한다.
  for (const key of [
    ['settings', 'notification-rules'],
    ['settings', 'push-kinds'],
  ]) {
    harnessClient.removeQueries({queryKey: key});
    harnessClient.setQueryDefaults(key, {enabled: true});
  }
  globalThis.fetch = (async () =>
    ({
      status: 500,
      ok: false,
      text: async () => JSON.stringify({error: {message: 'x'}}),
    }) as unknown as Response) as typeof fetch;
}

function seedPush(surface: string): void {
  const denied = surface.startsWith('shell-profile-push-denied');
  // iOS 가 아직 묻지 않은 폰: 허용도 거부도 아니고 다시 물을 수 있다.
  const undetermined = surface === 'shell-profile-push-undetermined';
  // 「읽는 중」: iOS 의 답이 영영 오지 않는다 — 스위치 자리의 스피너가 그대로 선다.
  const reading = surface === 'shell-profile-push-checking';
  __setPermissionReader(
    reading
      ? () => new Promise<{granted: boolean; canAskAgain: boolean}>(() => {})
      : async () => ({
          granted: !denied && !undetermined,
          canAskAgain: !denied,
        }),
  );
  if (surface.startsWith('shell-profile-push-off')) {
    setPushOptedOut(HARNESS_MEMBER.id, true);
  } else {
    clearPushOptOut();
  }
  // 눌러야만 서는 두 상태: 켜진 스위치를 사람이 끄면 이 기기를 지우는 DELETE 가 나간다. 그 요청이
  // 나가려면 이 폰이 서버에 등록된 적이 있어야 하므로 기기 id 를 하나 세운다(`pushDeviceId` 는 없으면
  // 만든다). 서버 자리만 이 가짜다: `busy` 는 답이 영영 오지 않고(요청 중 잠김), `failed` 는 500 으로
  // 거절한다(꺼졌다고 말하지 못하고 되돌려져 실패 문장이 선다). 그 밖의 요청은 `seedShell` 처럼 끝나지
  // 않는다. DELETE 가 몇 번 나갔는지는 로그로 남긴다 — 한 번의 탭이 한 번의 요청이어야 한다.
  if (
    surface === 'shell-profile-push-busy' ||
    surface.startsWith('shell-profile-push-failed')
  ) {
    pushDeviceId();
    const refuse = surface.startsWith('shell-profile-push-failed');
    let deletes = 0;
    globalThis.fetch = (async (
      input: unknown,
      init?: {method?: string; signal?: AbortSignal},
    ) => {
      const url = String(input);
      if (init?.method === 'DELETE' && url.includes('/devices/')) {
        deletes += 1;
        console.log(`[measure-push] DELETE /devices/{id} #${deletes}`);
        if (!refuse) {
          // 답이 오지 않는 서버. 진짜 `fetch` 처럼 중단 신호가 오면 거절로 끝난다 — 코어의 15초 기한
          // (`fetchWithDeadline`)이 그 신호로 걸리므로, 기한이 지나면 `unreachable` 로 끝나 이 상태가
          // 실패 문장으로 바뀐다(`maestro/99-push-switch-capture.yaml` 의 `EXPECT=timeout` 이 그것을 본다).
          const startedAt = Date.now();
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              console.log(
                `[measure-push] DELETE aborted by the client deadline after ${Date.now() - startedAt} ms`,
              );
              reject(new Error('aborted'));
            });
          });
        }
        return {
          status: 500,
          ok: false,
          text: async () => JSON.stringify({error: {code: 'internal'}}),
        } as unknown as Response;
      }
      return new Promise<Response>(() => {});
    }) as typeof fetch;
  }
}

// #3638: 컴포저 호출 판의 서버. 호출 흐름(대상 판정 → 맥 읽기 → 서명 키 확인 → 메시지 전송)은
// 진짜이고, 서버만 이 가짜다. 시뮬레이터에는 Secure Enclave가 없어 키 저장소가 `unsupported`
// 로 답하므로 「서명 키가 필요해요」가 **실제로** 뜬다. `flag-off` 판은 서버가 서명 요구를 꺼
// 둔 모습이라 Face ID 전에 「이 서버는 아직…」이 뜬다.
function seedCall(surface: string): void {
  // 시뮬레이터의 NetInfo는 바깥 도달성 검사에 실패해 오프라인으로 읽힌다(컴포저가 잠긴다).
  // 하네스에서만 검사 대상을 이 기기가 늘 닿는 곳(Metro)으로 돌린다.
  NetInfo.configure({
    reachabilityUrl: `http://${String(Settings.get('RCT_jsLocation') ?? '127.0.0.1:8081')}/status`,
    reachabilityTest: async () => true,
    reachabilityShouldRun: () => true,
  });
  seedAi('shell-call-on');
  bootSpawnPort();
  const hosts = [
    {
      id: 'measure-mac',
      workspaceId: ADE_WS,
      scope: 'member',
      ownerMemberId: SELF,
      type: 'workd',
      displayName: '달무리의 MacBook Pro',
      capabilities: {},
      createdAtMs: 0,
      lastSeenAtMs: Date.now(),
      online: true,
      folders: [{id: 'fld-question', displayName: '질문용 폴더', kind: 'question'}],
      defaultFolderId: 'fld-question',
    },
  ];
  const json = (body: unknown): Response =>
    ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  globalThis.fetch = (async (
    input: unknown,
    init?: {method?: string; body?: string},
  ) => {
    const url = String(input);
    // NetInfo의 도달성 검사도 이 fetch를 지난다 — 닿는다고 답한다.
    if (url.endsWith('/status')) return json({});
    if (url.includes('/work-hosts')) return json({workHosts: hosts});
    if (url.includes('/work-sessions')) return json({workSessions: []});
    if (url.includes('/signing-context')) {
      return json({
        instanceId: 'measure-instance',
        serverTimeMs: Date.now(),
        maxLifetimeMs: 600_000,
        maxClockSkewMs: 300_000,
        humanControlSignatureRequired: surface !== 'shell-call-flag-off',
        hostRegisterSignatureRequired: false,
      });
    }
    if (url.endsWith('/messages') && init?.method === 'POST') {
      const sent = JSON.parse(init.body ?? '{}') as {body?: string};
      return json({
        id: '00000000-0000-7000-8000-00000000c001',
        workspaceId: ADE_WS,
        channelId: 'ch-general',
        seq: 1,
        hlcTs: 1,
        hlcCount: 0,
        authorMemberId: SELF,
        type: 'text',
        body: sent.body ?? '',
        createdAtMs: Date.now(),
      });
    }
    if (url.includes('/messages')) return json({messages: []});
    return new Promise<Response>(() => {});
  }) as typeof fetch;
}

function seedDelegate(surface: string): void {
  harnessClient.setQueryData(['roster', ADE_WS], [
    ...SHELL_ROSTER.filter(member => member.kind !== 'agent'),
    ...DELEGATE_AGENTS,
  ]);
  const connection = (approved: string[]) => ({
    id: 'measure-hosted-connection',
    agentMemberId: DELEGATE_GROK,
    status: 'active' as const,
    authMode: 'static_bearer',
    audience: '/v1/mcp/agent-port',
    approvedChannelIds: approved,
    approvedScopes: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  });
  // 빈 판(승인 채널 0개)만 승인 목록이 비어 있다.
  harnessClient.setQueryData(
    ['hosted-agents', 'connections', ADE_WS],
    [connection(surface === 'shell-delegate-empty' ? [] : ['ch-agent-lab', 'ch-release'])],
  );
}

// ---- #2899: 알림 일시 중지·방해 금지의 기한 ------------------------------------
// 끝나는 때는 지금 + 3시간 — 사진마다 「오후 N:MM까지」가 다르지만 모양이 증거다.
const PAUSE_UNTIL_AHEAD_MS = 3 * 60 * 60_000;

/** 내 선언 상태가 방해 금지인 표면들. 나머지는 로스터를 그대로 둔다. */
const PAUSE_DND_SURFACES = new Set([
  'shell-pause-status',
  'shell-pause-until-dnd',
  'shell-inbox-pause',
  'shell-inbox-pause-open',
  'shell-inbox-pause-dnd',
  'shell-inbox-pause-offline',
  'shell-inbox-pause-date',
  'shell-inbox-pause-failure',
]);

/**
 * 이 표면의 끝나는 때. 날짜 판은 사흘 뒤 오전 9시라 어제·오늘·내일 이름이 아니라 날짜가 붙는 가장 긴 문장이
 * 된다(「10월 20일(화) 오전 9:00까지」). 나머지는 지금 + 3시간.
 */
function pauseUntilFor(surface: string): number {
  if (surface !== 'shell-inbox-pause-date') return Date.now() + PAUSE_UNTIL_AHEAD_MS;
  const day = new Date();
  day.setDate(day.getDate() + 3);
  day.setHours(9, 0, 0, 0);
  return day.getTime();
}

/** 알림 일시 중지·방해 금지 씨앗이 필요한 표면(프로필 시트 판 `shell-pause-*`, 인박스 줄 판 `shell-inbox-pause*`). */
function isPauseSurface(name: string): boolean {
  return name.startsWith('shell-pause-') || name.startsWith('shell-inbox-pause');
}

/** 이 표면에서 내 로스터 행. 방해 금지 표면만 선언 상태와 기한을 갖는다. */
function pauseRoster(surface: string): typeof SHELL_ROSTER {
  if (!PAUSE_DND_SURFACES.has(surface)) return SHELL_ROSTER;
  const until = pauseUntilFor(surface);
  return SHELL_ROSTER.map(member =>
    member.id === SELF
      ? {...member, presenceStatus: 'dnd' as const, dndUntilMs: until}
      : member,
  ) as typeof SHELL_ROSTER;
}

/**
 * 하네스 클라이언트는 `gcTime: 0` 이라 관찰자가 붙기 전에 뿌린 씨앗이 다음 틱에 치워질 수 있다.
 * 짐이 큰 기계에서는 그 타이머가 첫 렌더보다 먼저 돌아 일시 중지 줄이 읽는 중(스피너)으로 찍혔다.
 * 이 표면들은 씨앗이 **보여야** 하므로 `seedShell` 이 질의를 만들기 전에 치우지 않게 한다.
 */
function keepPauseSeeds(): void {
  harnessClient.setDefaultOptions({
    queries: {...harnessClient.getDefaultOptions().queries, gcTime: Infinity},
  });
}

/**
 * 이 판의 `useOnline` 이 읽는 연결 신호를 못 박는다(design-review H2). 시뮬레이터의 NetInfo 는 시작 직후
 * 도달성 검사가 끝나기 전에 「끊김」으로 읽히기도 해서(`seedCall` 도 같은 이유로 손을 댄다) 기한 장이 잠겼다
 * 풀리며 줄이 한 칸 내려앉고, 그 사이에 누른 좌표가 다른 줄을 눌렀다(캡처가 흔들렸다). 구독자에게 처음부터
 * 정해진 값만 알린다 — 화면은 진짜다.
 */
function forceNetwork(online: boolean): void {
  const forced = {
    isConnected: online,
    isInternetReachable: online,
    type: online ? 'wifi' : 'none',
    details: null,
  };
  (
    NetInfo as unknown as {
      addEventListener: (listener: (state: typeof forced) => void) => () => void;
    }
  ).addEventListener = listener => {
    listener(forced);
    return () => {};
  };
}

/** `seedShell` 이 깐 규칙(꺼짐)을 이 표면의 모양으로 덮는다. */
function seedPause(surface: string): void {
  forceNetwork(
    surface !== 'shell-pause-until-offline' && surface !== 'shell-inbox-pause-offline',
  );
  const until = pauseUntilFor(surface);
  const rules =
    surface === 'shell-pause-status' ||
    surface === 'shell-pause-notify' ||
    surface === 'shell-inbox-pause' ||
    surface === 'shell-inbox-pause-offline' ||
    surface === 'shell-inbox-pause-date' ||
    surface === 'shell-inbox-pause-failure'
      ? {dnd: true, mentionOverridesMute: false, dndUntilMs: until}
      : surface === 'shell-pause-notify-open' ||
          surface === 'shell-pause-until-open' ||
          surface === 'shell-inbox-pause-open'
        ? {dnd: true, mentionOverridesMute: false}
        : null;
  if (rules) harnessClient.setQueryData(['settings', 'notification-rules', ADE_WS], rules);
  // 인박스 줄은 명부의 내 행(선언 상태)도 읽는다 — 프로필 시트 표면은 로스터를 직접 받지만 이쪽은
  // 질의 캐시에서 읽는다.
  if (surface.startsWith('shell-inbox-pause')) {
    harnessClient.setQueryData(['roster', ADE_WS], pauseRoster(surface));
  }
  // 쓰기가 **늦게** 실패하는 서버(design-review H1): 누르면 낙관 칠하기로 줄이 먼저 사라졌다가, 0.6초 뒤
  // 서버가 500 을 답해 줄이 이유와 함께 돌아온다. 읽기는 끝나지 않는 약속으로 둔다(`seedShell` 과 같은
  // 이유: 읽기 실패가 세션 만료로 읽혀 캐시가 지워진다).
  if (surface === 'shell-inbox-pause-failure') {
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Promise<Response>(() => {});
      return new Promise<Response>(resolve =>
        setTimeout(
          () =>
            resolve({
              status: 500,
              ok: false,
              text: async () => JSON.stringify({error: {message: 'x'}}),
            } as unknown as Response),
          600,
        ),
      );
    }) as typeof fetch;
  }
}

/**
 * #4384: 프로필 사진 장의 씨앗. 연결 신호를 못 박고(`-offline` 만 끊김), `-denied` 는 사진 접근이 꺼진
 * 기기를 만든다 — 고르기가 실패하고 권한 상태가 「거부」로 읽힌다. 시스템 편집기는 시뮬레이터에서
 * 사람이 닫아야 하므로 이 표면은 그것을 띄우지 않는다.
 */
const SEED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAW+ElEQVR4nA3XAYuiCqPG8T5YEARBEARBEARBEATd23s6p7PtutU41TjlOOo4aqZmao46TjVONW61brWe6vVWREREn+eer/DAH36PxwtsfcD/+QE3APw3CGxCwDoMrCLAP1HAiQG/48AyASySwDwF/EoDdgb4mQVmOWCaByYF4AcAWCXgEwTGVWAEAcMG8IEAJga8E8CAAvoM0OOANwEwJOBVAXQN0AxA7QMvJqCMgK4FyFNAsgFxAXQcQFgDbRfgdwDn8Rb/z1d0/cX/BoqbYHEdKq7CxX8iRSda/B0rLuPFRaI4TxZ/pYp2uvgzU5xli9NccZIv/igULaD4WSqOweKoWhxCxY9G0USK71hxQBT7VLHHFN+4oiEUX6WirhQ1ragaxZd+UTGL3VFRtorStCjaxc6iKDjF9rrIu0VuV2Q93rLrK//XX94EyutgeRUq/xMuO5Hy72h5GSsv4uV5ovwrWbZT5Z/p8ixTnmbLk1z5R75sFcqfQHlcKo/A8rBa/oDKZqP8jpQHWLlPlHtU+Y0pG1z5VSjrUllTyqpWfjHKSr/cNcvyqCxZZXFa7thlYVFuO2V+XebcMrsrtzxe8L8+cOMH1wFwFQT/CYFOGPwdAZdRcBED53HwVwK0k+DPFDhLg9MMOMmCP3KglQc/C+AYAEclcAiCH1XQhMD3BjhAwD4G9gjwjQINBnzlQF0ANQlUFfBFAxUD7PZB2QSlEShaYGcKCjbYXoC8A3JrkHXB1g5kPN7KxldZ+yurQOWfYMUJVX6HK8tIZRGtzGOVX/GKnaj8TFZmqco0XZlkKj+yFStX+cxXxoXKCKgMS5UPsGJWK+9QZdCo9JFKD6u8ERWDqrwyFZ2raEJFlSovSkXRKl2jIvcrklkRR5WOVRGmlbZd4RcVzqmw60rLrTC7StPjra19tZW/9k+g5gRrv0O1Zbi2iNTm0dqvWM2O134marNkbZqqTdK1H5mala195mrjfG1UqA2B2kepZoK192ptANX6jVoPqb1hNYOovVI1nalpXE0Vai9STVFqXa0mGzWpXxPNWmdUE6xae1rj7Rq3qLFOrbWuMW6tuavRHi+08kH/+CEnAP0OQssQtAhD8wj0KwrZMehnHJoloGkSmqSgH2nIykCfWWicg0Z5aFiAPgDILEHvIDSoQn0I6jWgNwQyMOiVgHQK0hhI5aAXAVIkqKtAsgZJBiT2oY4JCSOobUH8FOJsiF1ALQdi1lDThegdRHm89X98dcdf/x2oL4P1Rag+D9d/Rep2tP4zVp/F69NEfZKs/0jVrXT9M1MfZ+ujXH2Yr38U6iZQfy/VB2C9X633oPpbo24g9VesrhN1jaqrTP2FqytCvSvVZaUuaXXRqHf6dcGst0d13qpz0zpr11uLOuPUm+s67dapXZ30eGHHB//2w8sAvAjC8xD8KwzbEfhnFJ7F4GkcniTgH0nYSsGfaXicgUdZeJiDP/KwWYDfAXhQgvsg3KvCbxBsNOBXBNYxWCNglYJfGFjh4K4AyxIsKbCowR0DFvpw24T5EcxZMDuFWzbMLOCmA9NrmHJhcgc/e7zIbx+y9COLADIPIr9CiB1GfkaQWRSZxpBJHPmRQKwk8plCxmlklEGGWeQjh5h55L2ADACkX0J6IPJWRQwIeW0gOoJoGKISyAuFKAzS5RBZQCQJERWkoyGCgbT7CG8i3AhhLaQ1RRgbaS4Q2kGoNUK6yPMOITxedOlDF350HkB/BVE7hP4Mo7MIOo2ikxj6I45aCfQziY5T6CiNDjPoRxY1c+h7Hh0U0D6A9kroG4gaVfQVQvUGqiGoiqEvBKpQaJdBZQ6VBFSU0I6CChraNlC+j3Imyo7QloUyU7Rpo/QCpRyUXKPPLkrs0CePF1/48Lkf/xXA7SD+M4TPwvg0gk+i+I8YbsXxzwQ+TuKjFD5M4x8Z3Mzi7zl8kMf7BbwH4G8l3ADx1yquQ7jWwFUEf8FwhcC7FC4zuMThooB3JFxQ8LaG8wbO9XHWxFsjnLHw5hSnbZxa4KSDP69xwsWfdjju8RJzH/HLT9gB4meQmIWIaZiYRIgfUcKKEZ9xYpwgRklimCI+0oSZId6zxCBH9PNEr0C8AYRRIl5BQq8SGkSoDeIFIRSM6BKETBESQ4gc0REIQSLaCsFrBGcQbJ9omQQzIpoWQU8JyibIBfHsEMSaeHIJfEdgHi/5y0fafvJngJwFyWmInITJHxHSipKfMXIcJ0cJcpgkP1KkmSbfM+QgS/ZzZC9PvhVIAyBfS6QOklqVVCHypUEqCNnFSJkgJYoUGbLDkYJAtiWSV0hOI1mDbPVJxiSbI5K2SGpKkjb5vCAJh3xak7hLYjsS9Xhp20f/9NOzAD0N0pMQ/SNMWxH6M0qPY/QoTg8T9EeSNlP0e5oeZOh+lu7l6Lc8bRToV4DWS7QG0mqVfoFopUF3EVrGaImgRYruMLTA0W2B5iWaU2hWo1sGzfTppknTI5qyaHJKP9s0saCfHBpf05hLozv60eNlfvqYmZ+ZBphJkPkRYqww8xlhxlFmFGOGceYjwZhJ5j3FDNJMP8P0ssxbjjHyzGuB0QFGKzEqyLxUGQViug1GRhgJY0SC6VCMwDBtjuEFhpMYVmFaGsMYTLPP0CZDjRjSYp6nDGEzTwsGdxhszaAu87hjEI+XnfnYqZ+dBNgfQdYKsZ9hdhxhR1F2GGM/4qyZYN+T7CDF9tNsL8O+ZVkjx77mWb3AagCrltgXkFWqbBdi5QYrIayIsR2CFSi2zbA8x3ICy0psS2EZjW0aLN1nKZMlR+yzxRJT9slm8QWLOSy6Zh9dFtmxDx4vP/XxEz//I8BbQf4zxI/D/CjCD6P8R4w34/x7gh8k+X6K76X5twxvZPnXHK/nea3AqwD/UuIVkO9WeRnipQYvInwH4wWCb1M8z/Acx7MC35J4RuGbGk8bPNXnSZN/HvGExT9NedzmsQWPOvzjmkdc/mHHwx6vMPEJP/yCFRA+g8I4JIzCwjAifEQFMya8x4VBQugnhV5KeEsLRkZ4zQp6TtDygloQXgBBKQldUJCrggQJYkPoIIKACW1C4CmBY4R/92kJAiMJTUWgNYEyBLIvPJsCMRKeLAGfCpgtoAvh0RGQtfDgCvBOaHi84g+faPnFz4A4DoqjkDgMix8R0YyK7zFxEBf7CbGXFN9SopEWXzOinhW1nKjmxZeCqABityTKoChVRRESOw1RQMQ2JvL/9k6JLCO2OJERxKYk0opIaSJpiM99kTDFp5GIWyI2FVFbfFyIiCM+rEXYFRs7se7xypZP/vTL44A8CsrDkPwRls2I/B6VBzG5H5d7CfktKRsp+TUt6xlZy8pqTn7Jy0pB7gKyXJIlUBarcgeShYbcRmQekzlCZim5xcgMJzcFmZZkSpFJTX42ZKIvP5kyPpIxS0an8qMtIwv5wZHhtdxw5fpOvvd4lU+fMvYro4AyDCofIcUMK+8RZRBV+jGlF1feEoqRVF5Tip5WtIyiZpWXnKLklW5BkQFFKikiqHSqyr/KaDcUHlE4TGEJpUUpDKM0/81dUChJIRXlWVMIQ3nqK7ipYCMFtZTHqYLYysNCgR2lsVbqrnK/UyCPVx371JFfHQbUj6BqhtT3sDqIqP2o2oupb3HVSKivSVVPqVpaVTPqS1ZVcmo3r8oFVQJUsaR2QFWoqm1I5Rsqh6gsprYIlaHUJqPSnEoJKimpz4pKaOqToeJ9FTNVdKQ+WioyVR9sFV6oDUetr9V7V4V26p3Hq498+tCvfwR0M6i/h/RBWO9H9F5Uf4vpRlx/Teh6UtdSuprWXzK6ktW7OV3O61JBFwG9U/oXzXq7qvOQzjV0FtFbmM4QepPSaUanOJ0U9GdJJxT9SdNxQ8f6OmrqjyMdsfSHqQ7bemOh1x39fq1Drn6302serzH0GR9+wwwY70FjEDL6YaMXMd6ihhEzXuOGnjC0pKGmjJe0oWSMbtaQc4aUN8SC0QEMoWS0QYOvGhxksA2jhRgMZjQJg6YMijFIzngWDEIynhQD1wzMMNC+8WgayMh4sAx4ajRso74w7h0DWht3rlHbGVWPt/fh65n+3nugNwj2+qFeL9x7i/SMaO811tPjPS3RU5O9l1RPSfe6mZ6c7Um5npjvdQo9Aei1Sz0e7HHVHgv1Wo0eg/SaWI8mehTVI5neM9cjhN6T1MOVHqb1UKP32O8hZu9h1IOtXmPaq9u9+0UPcnp3617N7VV3vYrHOzB9g3f/YBAY9IODXmjwFh4YkcFrdKDHBlp8oCYGL8mBkhp00wM5M5CyAzE36OQHQmHQBgZ8acCBA7Y6aEEDpjFoIgMaG1DEgKQGz8yA4AZPwgCXBpgyQLXBozFA+oMHcwCPBg1rUJ8O7u0BtBjcOYPaelB1B5Xd4NbjNd995sBv9gNmL2i+hUwjbL5GTD1qajFTjZsvCVNJmt2UKadNKWOKWbOTM4W82S6YPGByJZMFzVbVZCCz2TBpxKQwkyTMZ+pfZJhPnIkLJiaZqGI+aiZimA99EzbNxsisW+b91IRs825h1hyzujYrrnm7M0GPdzjwDfv+YS8wfAsOjdDwNTzUI0MtOlRjw5f4UEkMu8mhnBpK6aGYGXayQyE3bOeHfGHIAUO2NGyBQ6Y6bEJDujGkkCGJDZ+JIUENn5ghzg0xYYhKw0dliGjDB2MI94cNc1gfDe+tITQd3tnD2mJYdYaV9fDWHYK74Y3HO+77xj3/+C0wNoLj19BYD4+1yFiNjl9iYyU+7ibGcnIspcZietzJjIXsuJ0b8/kxVxizwLhVGjPguFkd09CYaoxJZPyMjQli/ESNcWaMcWNUGD9KY0QZP2hj2Bg3+uO6Ob4fjSFrfDcd1+xxdTGuOOPb9Rh0xze7cdnjtXo+681vGQHrNWjpIUsLW2rEeolaSszqxi05YUlJS0xZnbQlZKx21uJzFpe32ILVAiymZDVBi65aFGSRDesZsQjMeiIsnLIwxkI561GwEMl6UCxYsxqGVe9b96YFjaw7y6pNraptVRbWrWOBa+vGtco7q+TxTt58E8M/eQ1M9OBEC03U8OQlMlGik25sIscnUmIiJied1ERIT9qZCZ+dcLkJm5+0ChMGmDRLExqcUNUJCU2eGxMCmTxhE5yYYNQEZSaP3AQRJg/SBFYmDW1SNyb3/QlkTu5Gk5o1qU4nFXtyu5iAzuRmPSm7k9JuUvR4Z4Zv9uqf6YGZFpypodlLeKZEZt3oTI7NpPhMTMw6yZmQmrXTMz4z47IzNjdr5WdMYdYEZnRpRoEzsjp7hmZEY/aEzHBshhEzlJo9MjOEmz0IM1iaNZRZXZvdGzOoP7szZ7XRrGrNKtPZrT0DF7MbZ1Zez0rurLibffd47VefrfttLWCrQfslZCthuxux5agtxWwxbncStpC02ymbT9tcxmazditnM3m7WbBpwKZKNgnaz1WbgOynho0jNobZKGE/Uva/p+uBs2HBbkh2XbHvNRsy7Lu+XTPt6siuWPbt1AZt+2Zhlx27tLaLrv19ZwMe71z3zTX/XA3MX4JzJTTvhudyZC5F52Js3onPhcS8nZzzqTmXnrOZeSs7Z3LzZn5OF+YUMCdL82dwTlTnT9Acb8wxZI5i80dijlDzB2YOc/OGMK9L83tlDmnzO2Ne68+r5rwymt9ac3A6v7Hn5cW85MyL6/l3dw7s5t883qXmW6r+5UtgqQSX3dBSDi+lyFKMLjuxpRBfthNLPrnkUks2vWxllkx22cwt6fySKixJYPlcWhLg8qm6xKEl1liiyPIRWyLE8oFawsyywS3rwvJeWkLK8k5b1oxltb+smMvb0RK0ljfTZdlelhbLorP8vl4C7vLbbvnV43VUn/Pid5SA0w06csiRwo4YcTpRR4g57bjDJxwu6bApp5V2mIzTzDp0zqHyDllwngGHKDlPoINXHQxy0IbziDgI5jwQDkw5Dcapc8694ECSc6c4Nc2pGk6l79yaDjhybiynPHVKtlNcON8dB1g731zn684peLyrF99K8a+6gZUcXEmhlRhedSIrIbpqx1Z8fMUlVmxy1UqtmPSqmVnR2RWVW5H51XNhRQCrp9IKB1dYdYVCq8fGCkFWD9gKJlYNalVnVvfcChJWd9Kqpqyq2qpirG77K9Bc3YxWZWtVmq6K9ur7YgU4q2/r1Vd3Vditvni8G8W36fo3cmAjBTdiaNMJb4TIph3d8LENF9+wiU0ruWFSm2Z6Q2c2VHZD5jbP+Q1R2DwBG7y0wcANWt08QhuksXlANjC2aRCbOrW5ZzYQt7kTNjVpU1U2FW1za2zA/ubG3JRHm5K1KU433+0NsNh8czZf15uCu/my2/zt8bpdnyv7XSngikG3E3KFsNuOuHzU5WIuG3dbCZdJus2US6ddKuOSWfc55xJ596ng4oCLlVwUdB+rLgK5Dw0XRtwG5tYJ955yIca949ya4FYlt6K4t5oLGu5N3y2bbmnkFi33+9QFbPfbwv3quIW1+8V1/965eY93K/u2kn8rBrad4FYIbdvhLR/ZctEtG9u24lsmsW0mt3RqS6W3ZGb7nN0Sue1TfosXthiwRUvbR3CLVLcP0BZubBvIto5t74ktRG3vmG2N21aFbUXa3ipbUNveGNtyf1syt8XR9ru1Babbb/b262JbcLZf1tu/3W1+t/3L491Lvr3o33cCeyG4b4f2fHjPRfZsdN+K7Zn4vpnY08k9ldqT6f1zZk9k90+5PZ7fY4U9CuwfS3sE3D9U9zC0bzT2dWR/j+0hYn9H7WvMvsrtK8L+VtqDyv5G25eNfam/L5r776M9YO2/Tfdf7X1hsf/i7P9e7/Pu/q/d/k+P9yD6Dh3/QQgc2sEDHzpw4QMbObSiByZ2aMYPdOJAJQ9k6vCcPhCZw1P2gOcOWP6AFg6PwAEpHR7AA1w9NKBDvXG4Rw4QdrgjDjXqUGUOFe5wKxxA6XCjHMraoWQciv3Dd/MAjA7frMPX6aFgH74sDn87h/z68Jd7+HN3yHm8x47vKPiP7cCRDx650JENH1uRIxM9NmNHOn6kEkcyeXxOHYn08SlzxLNHLHdE88fHwhEBjg+lIwweG9VjHTreN44QcrzDjjXiWKWOFeZ4yx1B4XgjHcvKsaQdi8bxe/8ImMdvo+NX61iYHr/Yx78Xx7xz/Gt9/NM95nbHPzzek+A7tf0nPnDigic2dGqFT0zk1Iye6NiJip/IxOk5eSJSp6f0Cc+csOwJzZ0e8yekcHoATnDp1ABP9erpHjpBjdMdcqphpypxqlCnW+YEcqcb4VSWTiXlVNRO340T0D99M09fR6eCdfoyPf1tn/KL01/O6c/1Keee/tid/uPxntu+M+8/c4EzGzy3QmcmfG5GznT0TMXOZPz8nDgTyfNT6oynz1jmjGbPj7kzkj8/FM4wcG6UznXwfF89Q9D5rnGuIecqdq4Q51vqDDLnG+5cFs4l6VxUzt+1M2Ccv/XPX81zYXT+Yp3/np7z9vmvxflP55xbn/9wz//ZnbMe74X3XTj/hQ1cWsELE7o0wxc6cqGiFzJ2eY5fiMTlKXnBUxcsfUEzl8fsBcldHvIXuHBpAJd66XIPXqDq5Q661BqXKnKpYJdb4gJSlxvmUuYuJeFSlC7flQugXb4Zl6/9S8G8fBld/rYu+enlL/vy5+KScy5/rC//cS/Z3eV/Pd4r57uy/msrcGWC12boSoevVORKRq/PsSsRvz4lrnjyiqWuaPr6mLki2etD7grnr43CtQ5c70tXCLzeVa816FptXCvI9Ra7gsT1hrqWmWuJuxaF63fpCijXb9r1q3Et9K9fzOvfo2veuv41vf5pX3OL6x/O9T/ra9a9/u/u+j//D8BU12JyqU86AAAAAElFTkSuQmCC';

function seedAvatarSheet(surface: string): void {
  forceNetwork(surface !== 'shell-avatar-sheet-offline');
  if (surface === 'shell-avatar-sheet-photo') {
    // 내려받을 서버가 없다 — 올린 직후와 같은 길(`seedMemberAvatar`)로 캐시를 채워 사진이 서 있게 한다.
    try {
      const file = new FsFile(Paths.cache, 'measure-avatar-seed.png');
      if (file.exists) file.delete();
      file.create();
      file.write(Uint8Array.from(atob(SEED_PNG_B64), c => c.charCodeAt(0)));
      seedMemberAvatar(`/v1/workspaces/${ADE_WS}/members/${SELF}/avatar/content?v=media-1`, file.uri);
    } catch {
      // 시드가 실패하면 이니셜이 찍힌다 — 캡처를 읽을 때 드러난다.
    }
  }
  if (surface !== 'shell-avatar-sheet-denied') return;
  const picker = ImagePicker as unknown as Record<string, unknown>;
  const override = (key: string, value: unknown) =>
    Object.defineProperty(picker, key, {value, configurable: true, writable: true});
  override('launchImageLibraryAsync', async () => {
    throw new Error('denied');
  });
  override('getMediaLibraryPermissionsAsync', async () => ({
    status: 'denied',
    granted: false,
    canAskAgain: false,
    expires: 'never',
  }));
}

// ---- #4663: 설정 › 명령줄·AI 도구 ------------------------------------------------
// 가상 인물(이도현)의 연결 넷. 서버의 `DevCredential` JSON 모양 그대로다: 카드에는 기기 이름이 없고, 로그인 세션에는 도구가
// 없고 기기 이름이 있다. 시각은 지금 기준이라 「3일 전」·「20일 뒤」가 사진마다 같다.
const DEV_TOOLS_READ = ['dev:identity', 'dev:channels:read', 'dev:messages:read', 'dev:inbox:read'];
const DEV_TOOLS_WRITE = [...DEV_TOOLS_READ, 'dev:messages:write'];

// Maestro 흐름(`119-dev-tools-capture.yaml`)이 첫 줄(`aaaaaaaa-0000-4000-8000-000000000001`)의 「지우기」를 누른다.
function devToolsRows(): Record<string, unknown>[] {
  const now = Date.now();
  const day = 86_400_000;
  const card = (n: number, over: Record<string, unknown>) => ({
    id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
    memberId: SELF,
    kind: 'card',
    channelRestricted: false,
    createdAtMs: now - 10 * day,
    ...over,
  });
  return [
    card(1, {
      name: 'Claude Code 노트북',
      tool: 'claude_code',
      scopes: DEV_TOOLS_READ,
      lastUsedAtMs: now - 3 * day,
      expiresAtMs: now + 20 * day,
    }),
    // 한 번도 안 쓴 카드: 읽기 + 보내기, 고른 채널만.
    card(2, {
      name: 'Codex 작업용',
      tool: 'codex',
      scopes: DEV_TOOLS_WRITE,
      channelRestricted: true,
      createdAtMs: now - 2 * day,
      expiresAtMs: now + 88 * day,
    }),
    // 로그인 세션: 도구가 없고 기기 이름이 있다. 만료는 살아 있는 갱신 쪽의 것이라 며칠 단위다.
    card(3, {
      kind: 'session',
      name: 'oort 로그인',
      scopes: DEV_TOOLS_WRITE,
      deviceName: '이도현의 MacBook Pro',
      createdAtMs: now - 12 * day,
      lastUsedAtMs: now - 5 * 60_000,
      expiresAtMs: now + 30 * day,
      lineageExpiresAtMs: now + 78 * day,
    }),
    // 두 프리셋 어느 쪽도 아닌 범위.
    card(4, {
      name: '배포 스크립트',
      tool: 'cli',
      scopes: ['dev:identity', 'dev:messages:read'],
      lastUsedAtMs: now - 2 * 60 * 60_000,
      expiresAtMs: now + 5 * day,
    }),
  ];
}

function seedDevTools(surface: string): void {
  // 시뮬레이터의 NetInfo 는 시작 직후 「끊김」으로 읽히기도 해서 연결 신호를 못 박는다(`-offline` 만 끊김).
  forceNetwork(surface !== 'shell-dev-tools-offline');
  const member = surface === 'shell-dev-tools-member';
  harnessClient.setQueryData(['settings', 'dev-access', 'policy', ADE_WS], {
    policy: 'admins',
    canCreate: !member,
    canManageAll: !member,
  });
  if (surface === 'shell-dev-tools-loading') return;
  if (surface === 'shell-dev-tools-error') {
    // 목록 요청만 전송 오류로 끝난다(코어가 「서버에 닿지 못했어요」로 바꾼다). 세션 만료(401)가 아니라 캐시는 그대로다.
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes('/dev-access/credentials')) {
        throw new TypeError('Network request failed');
      }
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    return;
  }
  harnessClient.setQueryData(
    ['settings', 'dev-access', 'credentials', ADE_WS],
    surface === 'shell-dev-tools-empty' ? [] : devToolsRows(),
  );
}

function seedShell(surface: string): void {
  // 셸은 명시적으로 켜진 질의(인박스·에이전트 레일)도 세운다. 서버가 없는 하네스에서
  // 그 요청이 실패하면 세션 만료로 읽혀 캐시가 통째로 지워지고(`useSession` 의
  // 로그아웃 경로), 씨앗이 사라진 빈 목록이 찍힌다. 하네스는 데이터를 받지 않으므로
  // 요청을 영영 끝나지 않는 약속으로 둔다.
  // 먼저 한 번 읽는다: Expo 의 fetch 폴리필은 첫 읽기에서 `Headers` 등을 깔고, 그 전에
  // 덮어쓰면 그 설치가 건너뛰어져 `expo/fetch` 가 부팅 중에 던진다(프로필 시트 판).
  void globalThis.fetch;
  void globalThis.Headers;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  if (surface === 'shell-home-pullfail' || surface === 'shell-inbox-pullfail') {
    // #3992: 처음 12초는 요청이 끝나지 않고(기존 하니스의 약속), 그 뒤 새 요청은 곧바로 서버 500 으로 끝난다.
    // 다만 처음 12초 안에 시작된 읽기는 영영 끝나지 않는 채로 남고 같은 주소의 새 읽기가 그것에 합쳐져서, 이 표면에서 당김은 20초
    // 상한(`MAX_WAIT_MS`)에 걸려 실패한다(상한 경로를 실제 화면으로 확인하는 판이기도 하다). 빠른 실패의 움직임은 `pull-refresh-fail`.
    const startedAt = Date.now();
    // 전송 오류가 아니라 서버가 500 으로 답한다(전송 오류는 쿼리의 재시도 백오프를 길게 탄다).
    const answer = (status: number): Response =>
      ({
        status,
        ok: status >= 200 && status < 300,
        headers: {get: () => null},
        text: async () => (status === 204 ? '' : '{"error":"measure"}'),
        json: async () => ({error: 'measure'}),
      }) as unknown as Response;
    globalThis.fetch = ((url: unknown) => {
      // NetInfo 의 도달성 확인(`generate_204`)이 500 을 받으면 앱이 「오프라인」으로 읽어 모든 재조회가 멈춘다: 이것만은 늘 답한다.
      if (String(url).includes('generate_204')) return Promise.resolve(answer(204));
      return Date.now() - startedAt < 12_000 ? new Promise<Response>(() => {}) : Promise.resolve(answer(500));
    }) as typeof fetch;
    // 재시도 없이 바로 실패로 끝나게 한다(캡처가 재시도 백오프 8초를 기다리지 않게).
    harnessClient.setDefaultOptions({queries: {retry: false}});
  }
  // ADE 판의 턴이 이 판에 새지 않게 비우고, 홈 판이 고른 것만 넣는다.
  resetAgentWorking();
  harnessClient.setQueryData(['settings', 'workspace', ADE_WS], {
    id: ADE_WS,
    slug: 'yeomyeong',
    name: '여명거리',
    updatedAtMs: 0,
  });

  // ADE 판의 씨앗(모듈 몸통에서 먼저 뿌려진다)을 지운다 — 목록의 세 상태는 빈 캐시에서
  // 시작해야 그 상태다.
  harnessClient.removeQueries({queryKey: ['channels', ADE_WS]});
  harnessClient.removeQueries({queryKey: ['roster', ADE_WS]});
  harnessClient.removeQueries({queryKey: ['read-state', ADE_WS]});

  if (surface === 'shell-home-loading') {
    // 첫 답을 기다리는 목록: 질의를 켜 두고 요청은 끝나지 않는다.
    harnessClient.setQueryDefaults(['channels', ADE_WS], {enabled: true, staleTime: 0});
    harnessClient.setQueryDefaults(['roster', ADE_WS], {enabled: true, staleTime: 0});
    return;
  }
  if (surface === 'shell-home-error') {
    // 연결 실패: 폰의 fetch 가 전송 오류로 끝난다. 코어가 그것을 자기 문장으로 바꾼다.
    globalThis.fetch = (() =>
      Promise.reject(new TypeError('Network request failed'))) as typeof fetch;
    harnessClient.setQueryDefaults(['channels', ADE_WS], {enabled: true, staleTime: 0});
    harnessClient.setQueryData(['roster', ADE_WS], SHELL_ROSTER);
    return;
  }
  if (surface === 'shell-home-empty') {
    harnessClient.setQueryData(['roster', ADE_WS], SHELL_ROSTER.slice(0, 1));
    harnessClient.setQueryData(['channels', ADE_WS], []);
    harnessClient.setQueryData(['read-state', ADE_WS], []);
    return;
  }

  harnessClient.setQueryData(['roster', ADE_WS], SHELL_ROSTER);
  // 프로필 시트의 알림 일시 중지 줄(#2848)이 읽는 규칙. 씨앗이 없으면 줄이 잠긴다.
  harnessClient.setQueryData(['settings', 'notification-rules', ADE_WS], {
    dnd: false,
    mentionOverridesMute: false,
  });
  const channel = (id: string, name: string, kind: 'public' | 'private') => ({
    id,
    workspaceId: ADE_WS,
    kind,
    name,
    muted: false,
  });
  const dm = (id: string, peer: string) => ({
    id,
    workspaceId: ADE_WS,
    kind: 'dm' as const,
    muted: false,
    memberIds: [SELF, peer],
  });
  harnessClient.setQueryData(['channels', ADE_WS], [
    channel('ch-agent-lab', 'agent-lab', 'public'),
    channel('ch-general', 'general', 'public'),
    channel('ch-design', 'design-2.0', 'private'),
    channel('ch-release', '릴리스', 'public'),
    channel('ch-oncall', '운영-온콜', 'private'),
    dm('dm-agent', AGENT),
    ...SHELL_HUMANS.map(human => dm(`dm-${human.handle}`, human.id)),
  ]);
  const read = (channelId: string, unreadCount: number, mentionCount: number) => ({
    channelId,
    lastReadSeq: 10,
    latestSeq: 10 + unreadCount,
    unreadCount,
    mentionCount,
    markedUnreadBeforeSeq: null,
  });
  harnessClient.setQueryData(['read-state', ADE_WS], [
    read('ch-agent-lab', 2, 2),
    read('ch-general', 5, 0),
    read('ch-design', 0, 0),
    read('ch-release', 0, 0),
    read('ch-oncall', 0, 0),
    read('dm-agent', 1, 0),
  ]);

  // #3342: 프로필 시트의 푸시 종류 스위치(서버 기본은 켬). 씨앗이 없으면 줄이 잠긴다.
  harnessClient.setQueryData(['settings', 'push-kinds', ADE_WS], {workComplete: true});
  if (
    surface === 'shell-badges' ||
    surface === 'shell-inbox-badges' ||
    surface === 'shell-inbox-pullfail'
  ) {
    // 결정 대기 승인 둘. 읽음 씨앗(멘션 2)과 합쳐 알약이 4가 된다.
    const pending = (id: string) => ({
      id,
      workspaceId: ADE_WS,
      runId: `run-${id}`,
      channelId: 'ch-agent-lab',
      requestedBy: AGENT,
      actionType: 'tool_call',
      status: 'pending',
      expiresAtMs: Date.now() + 600_000,
    });
    harnessClient.setQueryData(['approvals', ADE_WS, 'pending'], [
      pending('measure-approval-1'),
      pending('measure-approval-2'),
    ]);
  }
  if (surface === 'shell-work-from-push') seedWorkConsole();

  if (surface === 'shell-home-idle') return;
  // 시안의 카드: 김인턴이 #agent-lab 에서 PR 초안을 쓰는 중.
  const nowMs = Date.now();
  markAgentWorking({
    memberId: AGENT,
    channelId: 'ch-agent-lab',
    state: surface === 'shell-home-approval' ? 'awaiting_approval' : 'working',
    source: 'run',
    startedAtMs: nowMs - 95_000,
    headlines: ['푸시 중복 수정 PR 초안 작성 중'],
    // TTL(90초)은 마지막 활동에서 잰다. 찍는 동안 살아 있게 조금 앞에 둔다.
    lastActivityAtMs: nowMs + 60_000,
  });
}

// ---- #2864: 「작업」 팀 보드 한 열 판 --------------------------------------------
//
// 서버가 보는 사람(SELF = 이도현)의 채널 멤버십으로 이미 걸러 준 공유 세션이다. 로컬 공유
// 세션과 에이전트 레인(origin=host) 세션이 섞여 있고, 두 줄이 내 것이다(하나는 A 레인).
// 시각은 찍는 순간 기준으로 잡는다(「3분 전」이 사진마다 어긋나지 않게).
const TB_OTHER = '00000000-0000-7000-8000-00000000b002';
const TB_OTHER2 = '00000000-0000-7000-8000-00000000b003';
function tbRow(over: Partial<SharedWorkSession> & {sessionId: string}): SharedWorkSession {
  const now = Date.now();
  return {
    origin: 'local_pty',
    label: '작업',
    folderLabel: 'oort',
    status: 'running',
    owner: {memberId: SELF, displayName: '이도현'},
    homeChannel: {id: 'ch-deploy', name: 'workbench'},
    startedAtMs: now - 3_600_000,
    endedAtMs: null,
    sharedAtMs: now - 3_000_000,
    repo: 'oort',
    branch: 'feat/2774-xterm',
    harness: 'claude',
    state: 'running',
    stages: [],
    diff: {added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null},
    prUrl: null,
    lastActivityAt: Math.floor((now - 60_000) / 1000),
    ...over,
  };
}
const TB_MIN = (n: number) => Math.floor((Date.now() - n * 60_000) / 1000);
const TEAM_BOARD_ROWS: SharedWorkSession[] = [
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000a1',
    label: '한글 입력 이중 전송 수리',
    state: 'waiting',
    stages: ['세션 시작', '작업 중', '실행 허락 기다림'],
    diff: {added: 128, deleted: 40, files: 9, ahead: 2, behind: 0, uncommitted: 1},
    lastActivityAt: TB_MIN(3),
  }),
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000a2',
    label: '푸시 중복 수정',
    owner: {memberId: TB_OTHER, displayName: '김인턴'},
    homeChannel: {id: 'ch-build', name: 'agent-lab'},
    branch: 'fix/push-dup',
    harness: 'codex',
    state: 'running',
    stages: ['세션 시작', '작업 중'],
    diff: {added: 42, deleted: 7, files: 3, ahead: 1, behind: 0, uncommitted: 0},
    lastActivityAt: TB_MIN(1),
  }),
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000a3',
    label: '온보딩 문구 다듬기',
    origin: 'host',
    folderLabel: null,
    repo: null,
    branch: null,
    owner: {memberId: SELF, displayName: '이도현'},
    homeChannel: {id: 'ch-build', name: 'agent-lab'},
    state: 'running',
    lastActivityAt: TB_MIN(2),
  }),
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000a4',
    label: '설정 화면 접근성 점검',
    owner: {memberId: TB_OTHER2, displayName: '박디자인'},
    homeChannel: {id: 'ch-deploy', name: 'workbench'},
    repo: 'oort',
    branch: 'chore/a11y-settings',
    state: 'review',
    stages: ['세션 시작', '작업 중', '검토 요청'],
    diff: {added: 96, deleted: 31, files: 6, ahead: 3, behind: 0, uncommitted: 0},
    prUrl: null,
    lastActivityAt: TB_MIN(14),
  }),
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000a5',
    label: '릴리스 노트 초안',
    state: 'done',
    status: 'ended',
    endedAtMs: Date.now() - 1_800_000,
    stages: ['세션 시작', '작업 중', '끝남'],
    diff: {added: 54, deleted: 12, files: 2, ahead: 1, behind: 0, uncommitted: 0},
    prUrl: 'https://github.com/yeomyeonggeori/oort/pull/3290',
    lastActivityAt: TB_MIN(30),
  }),
];
const TEAM_BOARD_AGENT_ROW = TEAM_BOARD_ROWS[2];

function seedTeamBoard(surface: string): void {
  harnessClient.setQueryData(['roster', ADE_WS], ADE_ROSTER);
  harnessClient.setQueryData(['channels', ADE_WS], ADE_CHANNELS);
  // 오류 판은 씨앗이 없다: 닿지 않는 서버를 읽다 실패한 첫 읽기 그대로다.
  if (surface === 'team-board-error') return;
  const empty = surface === 'team-board-empty' || surface === 'team-board-empty-mine';
  harnessClient.setQueryData(['team-board', ADE_WS, 'list'], {
    pages: [{sessions: empty ? [] : TEAM_BOARD_ROWS, nextCursor: null}],
    pageParams: [null],
  });
}

// #3842: 「작업」 한 화면의 줄. 새 서버(`include=jobs`) 모양이다: run 줄에 trigger·phase·에이전트 보고.
const WORK_JOBS_ROWS: SharedWorkSession[] = [
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000c1',
    source: 'run',
    runId: '00000000-0000-7000-8000-0000000000c1',
    requestedBy: {memberId: SELF, displayName: '이도현'},
    origin: 'agent_run',
    label: '#launch 채널에 v0.1.26 공지 올리기',
    folderLabel: null,
    repo: null,
    branch: null,
    harness: 'hosted',
    owner: {memberId: 'measure-agent-grok', displayName: '그록봇'},
    homeChannel: {id: 'ch-build', name: 'agent-lab'},
    state: 'running',
    phase: 'awaiting_approval',
    trigger: 'mention',
    startedAtMs: Date.now() - 4 * 60_000,
    lastActivityAt: TB_MIN(1),
  }),
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000c2',
    source: 'run',
    runId: '00000000-0000-7000-8000-0000000000c2',
    requestedBy: {memberId: SELF, displayName: '이도현'},
    origin: 'agent_run',
    label: '온보딩 문구 해요체로 다듬기',
    folderLabel: null,
    repo: null,
    branch: 'feat/onboarding-copy',
    harness: 'hosted',
    owner: {memberId: 'measure-agent-grok', displayName: '그록봇'},
    homeChannel: {id: 'ch-build', name: 'agent-lab'},
    state: 'running',
    phase: 'running',
    trigger: 'work',
    stages: ['코드 읽기', '문구 고치기'],
    startedAtMs: Date.now() - 12 * 60_000,
    lastActivityAt: TB_MIN(2),
  }),
  tbRow({
    sessionId: '00000000-0000-7000-8000-0000000000c3',
    source: 'run',
    runId: '00000000-0000-7000-8000-0000000000c3',
    requestedBy: {memberId: SELF, displayName: '이도현'},
    origin: 'agent_run',
    label: '푸시 알림이 두 번 오는 문제 고치기',
    folderLabel: null,
    repo: null,
    branch: 'fix/push-dup',
    harness: 'hosted',
    owner: {memberId: 'measure-agent-grok', displayName: '그록봇'},
    homeChannel: {id: 'ch-build', name: 'agent-lab'},
    state: 'done',
    status: 'done',
    phase: 'succeeded',
    trigger: 'work',
    stages: ['원인 찾기', '고치기', 'PR 열기'],
    diff: {added: 42, deleted: 18, files: null, ahead: 2, behind: null, uncommitted: null},
    prUrl: 'https://github.com/yeomyeonggeori/oort/pull/3521',
    startedAtMs: Date.now() - 31 * 60_000,
    endedAtMs: Date.now() - 6 * 60_000,
    lastActivityAt: TB_MIN(6),
    agentReported: {
      resultKind: 'pr_opened',
      tests: {passed: 128, failed: 0, notRun: 3},
      nextAction: 'merge_ok',
      commitSha: '9f3c2a1b7e',
      toolCounts: {run: 14, edit: 6, read: 41},
    },
  }),
];
const WORK_JOBS_TEAM_ROWS: SharedWorkSession[] = [...WORK_JOBS_ROWS, TEAM_BOARD_ROWS[1], TEAM_BOARD_ROWS[3]];

function seedWorkJobs(surface: string): void {
  harnessClient.setQueryData(['roster', ADE_WS], ADE_ROSTER);
  harnessClient.setQueryData(['channels', ADE_WS], ADE_CHANNELS);
  const empty = surface === 'work-jobs-empty';
  harnessClient.setQueryData(['team-board', ADE_WS, 'jobs', 'mine'], {
    pages: [{sessions: empty ? [] : WORK_JOBS_ROWS, nextCursor: null, mode: 'jobs'}],
    pageParams: [null],
  });
  harnessClient.setQueryData(['team-board', ADE_WS, 'jobs', 'team'], {
    pages: [{sessions: empty ? [] : WORK_JOBS_TEAM_ROWS, nextCursor: null, mode: 'jobs'}],
    pageParams: [null],
  });
}

function seedWorkConsole(): void {
  const shift = Date.now() - NOW;
  harnessClient.setQueryData(['roster', ADE_WS], ADE_ROSTER);
  harnessClient.setQueryData(
    ['channels', ADE_WS],
    ADE_CHANNELS.map(channel =>
      channel.id === 'ch-deploy'
        ? {...channel, name: '배포와 장애 복구를 함께 검토하는 긴 이름의 대화'}
        : channel,
    ),
  );
  harnessClient.setQueryData(['work-hosts', ADE_WS], WORK_CONSOLE_HOSTS);
  harnessClient.setQueryData(
    ['work-sessions', ADE_WS],
    WORK_CONSOLE_SESSIONS.map(session => ({
      ...session,
      startedAtMs: session.startedAtMs + shift,
      ...(session.status === 'ended'
        ? {endedAtMs: Date.now() - 3_000_000}
        : {}),
    })),
  );
  harnessClient.setQueryData(
    ['work-session-events', ADE_WS, 'ch-deploy', 'measure-work-root'],
    {
      truncated: false,
      events: [
        {
          eventId: 'measure-event-created',
          type: 'agent.status',
          sessionId: 'measure-work-t1',
          atMs: Date.now() - 780_000,
          seq: 101,
          payload: {
            work_session_id: 'measure-work-t1',
            terminal_event: 'created',
          },
        },
        {
          // #3152: 소유자의 「이 세션 동안」 허락이 덮은 읽기 — 묻지 않고 지나간 한 줄.
          eventId: 'measure-event-auto-allowed',
          type: 'approval.auto_allowed',
          sessionId: 'measure-work-t1',
          atMs: Date.now() - 300_000,
          seq: 102,
          payload: {
            work_session_id: 'measure-work-t1',
            action: 'auto_allowed',
            status: 'approved',
            scope: 'session',
            tool_kind: 'read',
            preview_sha256: 'c'.repeat(64),
          },
        },
        {
          eventId: 'measure-event-tool',
          type: 'agent.status',
          sessionId: 'measure-work-t1',
          atMs: Date.now() - 120_000,
          seq: 103,
          payload: {
            work_session_id: 'measure-work-t1',
            tool_call_name: 'read_file',
            detail:
              '배포 구성과 롤백 순서를 확인하고, 장애가 반복될 때 담당자가 따라야 할 복구 단계를 긴 설명으로 검증했습니다.',
            plan: [
              {
                content: '배포 구성과 셀프호스트 환경 변수의 정합성을 끝까지 확인',
                status: 'completed',
              },
              {
                content: '좁은 화면에서도 읽을 수 있는 장시간 회귀 테스트 실행',
                status: 'in_progress',
              },
              {content: '결과 정리', status: 'pending'},
            ],
          },
        },
      ],
    },
  );
}

/** N2 (#3594): t1 의 답 조각. 영속된 것(`done`)과 라이브로 올 것을 같은 문장에서 자른다. */
const STREAM_SENTENCES = [
  '배포 구성을 확인했습니다. 롤백 순서는 문서와 일치합니다. ',
  '장애가 반복되면 먼저 릴레이를 재시작하고, 그래도 같으면 ',
  '담당자에게 알린 뒤 이전 버전으로 되돌리는 순서로 진행하면 됩니다.',
];

function streamEvent(index: number, text: string, atMs: number) {
  return {
    eventId: `measure-event-partial-${index}`,
    type: 'agent.partial' as const,
    sessionId: 'measure-work-t1',
    atMs,
    seq: 110 + index,
    payload: {
      work_session_id: 'measure-work-t1',
      event_id: `measure-event-partial-${index}`,
      text_delta: text,
    },
  };
}

function seedWorkStream(done: boolean): void {
  const sessionsKey = ['work-sessions', ADE_WS];
  const eventsKey = [
    'work-session-events',
    ADE_WS,
    'ch-deploy',
    'measure-work-root',
  ];
  const events = harnessClient.getQueryData(eventsKey) as
    | {events: unknown[]; truncated: boolean}
    | undefined;
  const base = (events?.events ?? []) as unknown[];
  // 라이브 판은 첫 문장만 이미 읽혀 있고 나머지는 프레임으로 온다.
  const persisted = done ? STREAM_SENTENCES : STREAM_SENTENCES.slice(0, 1);
  harnessClient.setQueryData(eventsKey, {
    truncated: false,
    events: [
      ...base,
      ...persisted.map((text, index) =>
        streamEvent(index, text, Date.now() - 60_000 + index * 2_000),
      ),
    ],
  });
  if (done) {
    const sessions = harnessClient.getQueryData(sessionsKey) as
      | Record<string, unknown>[]
      | undefined;
    harnessClient.setQueryData(
      sessionsKey,
      (sessions ?? []).map(session =>
        session.id === 'measure-work-t1'
          ? {...session, status: 'ended', endedAtMs: Date.now() - 20_000}
          : session,
      ),
    );
  }
}

function WorkStreamingSurface(): React.JSX.Element {
  const handlers = React.useRef<Pick<
    Parameters<ChannelRail['subscribeWorkSession']>[2],
    'onAcpEvent'
  > | null>(null);
  const value = React.useMemo(
    () => ({
      ...CONNECTED_RAIL,
      rail: {
        subscribeWorkSession: (_ws: string, _channel: string, h: never) => {
          handlers.current = h;
          return () => {
            handlers.current = null;
          };
        },
      } as never,
    }),
    [],
  );
  React.useEffect(() => {
    const frame = (index: number, text: string) => ({
      type: 'agent.partial' as const,
      v: 1,
      ts: Date.now(),
      seq: 110 + index,
      payload: {
        event_id: `measure-event-partial-${index}`,
        work_session_id: 'measure-work-t1',
        run_id: 'measure-run',
        channel_id: 'ch-deploy',
        message_id: `measure-event-partial-${index}`,
        root_message_id: 'measure-work-root',
        text_delta: text,
      },
    });
    const send = (index: number) => () =>
      handlers.current?.onAcpEvent(frame(index, STREAM_SENTENCES[index]));
    const timers = [
      setTimeout(send(1), 1_500),
      setTimeout(send(2), 6_000),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <RealtimeContext.Provider value={value}>
      <View style={{flex: 1, overflow: 'hidden'}}>
        <View style={{flex: 1, marginTop: -940, height: 3000}}>
          <WorkSessionDetailScreen
            active
            sessionId="measure-work-t1"
            onBack={() => {}}
            onOpenConversation={() => {}}
          />
        </View>
      </View>
    </RealtimeContext.Provider>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
    lockedFrame: {paddingHorizontal: 16, paddingTop: 8},
    // 하네스 자신의 라벨. 제품이 아니라 **사진의 캡션**이라 토큰을 든다: 라이트
    // 판에서 어두운 회색 글자가 종이 위에 그대로 서야 캡션이 읽힌다.
    lockedLabel: {fontSize: 12, color: color.textMuted, paddingBottom: 4},
    root: {flex: 1, backgroundColor: color.bg, paddingTop: 56},
    /**
     * `ConversationFloor` — `ConversationScreen` 의 `screen` 과 같은 배경식 (#3921).
     * 이미지 바닥이면 `bg` 한 장, 아니면 위 25% 에서 `canvasTop` 이 (라이트 `surface` ·
     * 다크 `bg`) 로 건너가고 그 아래는 평평하다.
     */
    conversationFloor: {
      flex: 1,
      paddingTop: 56,
      ...(color.backdrop === 'image'
        ? {backgroundColor: color.bg}
        : {
            experimental_backgroundImage: `linear-gradient(180deg, ${color.canvasTop} 0%, ${
              color.mode === 'light' ? color.surface : color.bg
            } 25%)`,
          }),
    },
    /** 틀 안에서 행들을 화면 가운데에 놓는다 — 점프가 행을 놓는 자리. */
    conversationFloorMid: {flex: 1, justifyContent: 'center'},
    /** 제 `Screen` 을 든 화면을 통째로 세울 때 (#1964). */
    fill: {flex: 1, backgroundColor: color.bg},
    // #4457: `SettingsContent` 는 스크롤 안쪽이라 가로 여백과 카드 사이 간격을 페이지의 스크롤이 준다 — 하네스가 대신 준다.
    settingsBody: {paddingHorizontal: SAFE_GUTTER, gap: space.lg},
    /** 그런 화면 아래의 캡션 — 홈 인디케이터를 비켜 선다. */
    captionBottom: {paddingTop: 8, paddingBottom: 34},
    label: {
      color: color.textFaint,
      fontSize: 11,
      fontWeight: '600',
      paddingHorizontal: 12,
    },
    noticeStack: {padding: 16, gap: 12},
    /** #2945 — 카드 위 대화 자리. 카드와 컴포저를 바닥으로 민다. */
    aiConnectFill: {flex: 1, justifyContent: 'flex-end', paddingBottom: 8},
    /** #1503 — 수명주기 칩 여섯을 한 줄에 세운다(390pt 에서는 두 줄로 접힌다). */
    statusStrip: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.xs,
    },
    pressPair: {paddingHorizontal: 16, paddingVertical: 8},
    // 화면이 누를 때 실제로 까는 값 — **같은 심볼**이다 (M-2).
    pressed: {backgroundColor: rowPressedBackground(color)},
    /** 두 컴포저 사이. 붙여 두면 위아래 테두리가 한 줄로 읽힌다. */
    gap: {height: 24},
    // ---- #1422 폰 계측 (#4179: 알약 이전 바 복제 — `probeBar`·`probeSlot`·`probeSend` — 는
    // 걷었다. 폭은 배송되는 입력창을 `measure()` 로 읽는다) -------------------------------
    probe: {paddingBottom: 8},
    /** 재기만 하는 상자. 화면에 그리면 사진이 계측기의 사진이 된다. */
    probeMeasure: {position: 'absolute', opacity: 0},
    /**
     * 헤더 표본. 절대 배치 + `opacity: 0` 이고, 좌우를 0 에 물려 **폭을 진짜로**
     * 받는다 — 헤더 높이는 제목이 몇 줄로 감기느냐에 달렸고 그것은 폭의 함수다.
     */
    probeHeaderSpecimen: {position: 'absolute', left: 0, right: 0, opacity: 0},
    /** 입력창의 글자 스타일 그대로 — 그래야 재는 것이 같은 글이다. */
    probeText: {fontSize: font.body, lineHeight: lineBox.body},
    probeRead: {
      fontSize: font.meta,
      color: color.textMuted,
      paddingHorizontal: 12,
      paddingBottom: 4,
    },
  });

// ---- #3925 첫 실행 알림 단계 (ADR-0204 D4) --------------------------------------
//
// 배송되는 `NotificationPrimer`에 상태를 건넨다. 게이트가 아니라 화면이다: 게이트는 푸시
// 프로바이더의 답을 읽는데 하네스는 그 답을 심을 수 없다. 스위치는 눌러 볼 수 있다.
//
//   NOTIFY-PRIMER               첫 화면(작업 끝남 켬). `LIGHT-` 접두사로 라이트
//   NOTIFY-PRIMER-OFF           스위치를 끈 상태: 작업 끝남 예시가 한 단 물러난다
//   NOTIFY-PRIMER-LOADING       서버 값을 읽는 중: 스위치 대신 표시기
//   NOTIFY-PRIMER-FAILED        쓰기 실패 문장(스위치는 되돌아와 있다)
//   NOTIFY-PRIMER-LOAD-FAILED   읽기 실패 문장
//   NOTIFY-PRIMER-ABSENT        이 경로를 모르는 서버: 작업 끝남 줄이 없다
//   NOTIFY-PRIMER-DENIED        iOS 창을 거부한 뒤 안내
function NotifyPrimerSurface({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 앱에서는 연결 화면이 적어 두는 한 칸이다: QR 경로의 세 번째 점.
  noteConnectRoute('qr');
  const [on, setOn] = React.useState(which !== 'off');
  const kinds: PrimerKinds = {
    absent: which === 'absent',
    ready: which !== 'loading' && which !== 'load-failed',
    workComplete: on,
    loadFailed: which === 'load-failed',
    pending: false,
    failed: which === 'failed',
    setWorkComplete: next => setOn(next),
  };
  return (
    <View style={styles.fill}>
      {which === 'denied' ? (
        <NotificationPrimer mode="declined" onDone={() => {}} />
      ) : (
        <NotificationPrimer
          mode="ask"
          busy={false}
          onContinue={() => {}}
          kinds={kinds}
        />
      )}
    </View>
  );
}

// 위 독스트링의 이유로 렌더 밖에서 한 번. **파일 맨 아래**인 것은 `harnessClient`
// 가 `const` 라 그 선언보다 먼저 부르면 TDZ 로 터지기 때문이고(실측: 첫 시도가
// "Cannot read property 'setQueryData' of undefined" 로 찍혔다), 다른 표면들은 이
// 스토어도 이 키들도 읽지 않으므로 값이 앉아 있어도 자기 사진에 나타나지 않는다.
//
// `ade-summary-empty` 만 빼는 이유는 그 장이 보여야 하는 것이 **아무것도 없을 때**
// 이기 때문이다. 스토어도 캐시도 모듈 상태라 표면마다 다른 값을 줄 방법은 「어느
// 표면으로 띄웠는가」를 렌더보다 먼저 읽는 것 하나뿐이고, 그 답은 루트가 이미
// 파싱하는 그 실행 인자에 있다.
const LAUNCHED = measureMode();
if (
  !(
    LAUNCHED !== null &&
    LAUNCHED.kind === 'surface' &&
    LAUNCHED.name === 'ade-summary-empty'
  )
) {
  seedAdeControl();
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  (LAUNCHED.name === 'work-detail' ||
    LAUNCHED.name === 'work-detail-events' ||
    LAUNCHED.name === 'work-detail-streaming' ||
    LAUNCHED.name === 'work-detail-stop' ||
    LAUNCHED.name === 'work-detail-stop-confirm' ||
    LAUNCHED.name === 'work-detail-stopped' ||
    LAUNCHED.name === 'work-detail-done')
) {
  seedWorkConsole();
  if (LAUNCHED.name === 'work-detail-stopped') seedWorkStream(true);
  // N4: 「멈추기」는 내 세션에만 있다. 이 표면들은 t1 을 하네스의 나(HARNESS_MEMBER)의 작업으로 둔다.
  if (LAUNCHED.name.startsWith('work-detail-stop')) {
    const sessions = harnessClient.getQueryData(['work-sessions', ADE_WS]) as
      | Record<string, unknown>[]
      | undefined;
    harnessClient.setQueryData(
      ['work-sessions', ADE_WS],
      (sessions ?? []).map(session =>
        session.id === 'measure-work-t1'
          ? {...session, memberId: HARNESS_MEMBER.id}
          : session,
      ),
    );
  }
  if (LAUNCHED.name === 'work-detail-streaming') seedWorkStream(false);
  if (LAUNCHED.name === 'work-detail-done') seedWorkStream(true);
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name.startsWith('team-board')
) {
  seedTeamBoard(LAUNCHED.name);
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name.startsWith('work-jobs')
) {
  seedWorkJobs(LAUNCHED.name);
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name === 'mark-unread-sidebar'
) {
  seedMarkUnread();
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name.startsWith('dm-status-dots')
) {
  seedDmStatusDots(LAUNCHED.name);
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name === 'gone-dm-home'
) {
  seedGoneDmHome();
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name.startsWith('dm-steady')
) {
  seedSteady();
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  isUncollectedSurface(LAUNCHED.name)
) {
  seedUncollected(harnessClient, LAUNCHED.name);
}
if (
  LAUNCHED !== null &&
  LAUNCHED.kind === 'surface' &&
  LAUNCHED.name.startsWith('shell-')
) {
  if (isPauseSurface(LAUNCHED.name) || LAUNCHED.name.startsWith('shell-dev-tools')) keepPauseSeeds();
  seedShell(LAUNCHED.name);
  if (LAUNCHED.name.startsWith('shell-avatar-')) seedAvatarSheet(LAUNCHED.name);
  if (LAUNCHED.name.startsWith('shell-dev-tools')) seedDevTools(LAUNCHED.name);
  if (LAUNCHED.name.startsWith('shell-delegate-')) seedDelegate(LAUNCHED.name);
  if (LAUNCHED.name.startsWith('shell-ask-')) seedAsk(LAUNCHED.name);
  if (LAUNCHED.name.startsWith('shell-ai-')) seedAi(LAUNCHED.name);
  if (LAUNCHED.name === 'shell-ai-wired') bootSpawnPort();
  if (LAUNCHED.name.startsWith('shell-update-')) {
    seedIosFeedCacheForCapture({latestBuild: 3036, version: '0.1.29', testflight: true});
  }
  if (LAUNCHED.name.startsWith('shell-call-')) seedCall(LAUNCHED.name);
  if (isPauseSurface(LAUNCHED.name)) seedPause(LAUNCHED.name);
  if (LAUNCHED.name.startsWith('shell-profile-push-')) seedPush(LAUNCHED.name);
  if (LAUNCHED.name === 'shell-profile-load-failed') seedLoadFailed();
}

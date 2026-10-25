// =============================================================================
// Where the app is, as a value.
//
// ## Why this is still not `@react-navigation/native` (re-examined, goal RN-A1)
//
// This file used to say the trade "belongs to whoever adds the fourth screen".
// That batch is this one: 「에이전트」 is a third tab and the agent detail is a
// second push. So the question was actually asked rather than inherited, and the
// answer did not change:
//
//   * The cost is unchanged and it is a native one. react-navigation needs
//     `react-native-screens` and `react-native-gesture-handler` — two native
//     modules, another `pod install`, two more New-Architecture interop surfaces,
//     and two more things that can break the NSE-carrying Xcode project this
//     repo already guards mechanically (`__tests__/projectShape.test.ts`).
//     ADR-0137 D1 made dependency additions an ADR matter, so adding them is not
//     an implementation detail a batch may decide on its own.
//   * The benefit is still nothing this app can spend. What a navigator sells is
//     a per-tab stack, deep-link URL parsing and header/gesture defaults. There
//     is no per-tab stack here BY DESIGN (a conversation covers the shell, see
//     below), deep links already arrive through `src/deeplink/joinLink.ts`, and
//     the back gesture is `EdgeSwipeBack`, which this batch reuses unchanged.
//   * The reducer grew by one tab and one nullable field. If the growth had
//     been a shape — a real stack, or two tabs needing independent histories —
//     that would be the signal, and the honest move then is to write the ADR
//     rather than to hand-roll a navigator. It is recorded in the PR so the next
//     batch inherits the reasoning instead of the sentence.
//
// What this file owes in exchange is that the swap stays cheap: navigation is a
// plain reducer over a plain value, every screen reads it through one hook, and
// no component anywhere holds navigation state of its own. Replacing this with a
// real navigator is a change to `NavigationProvider`, not to the screens.
//
// ## The shape, and why the conversation is not a tab
//
// A conversation covers the whole shell rather than living inside the 채널 tab.
// Two reasons, both about the person rather than the code: the tab bar would
// otherwise eat 49 points of a screen already short on room for a timeline, and
// a conversation reached FROM the 인박스 tab would have to either hijack the
// other tab's stack or open a second copy of itself. Covering the shell makes
// "어디서 왔든 뒤로 가면 왔던 곳" true by construction — `back` never changes
// `tab`, so the return is always to where the person actually was.
//
// The conversation screen itself is **the next batch's** (타임라인·컴포저). What
// this file settles is only how it is reached and left.
// =============================================================================

import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import type {NotificationLanding} from '../push/tapArrival';

/**
 * 탭은 셋이다 — 홈·인박스·검색 (ADR-0189 D1, DS2-2 #2714).
 *
 * 이 자리에는 네 탭(대화·인박스·에이전트·작업)이 있었다. 디자인 시스템 2.0의 폰
 * 구조는 떠 있는 알약 탭바에 셋을 두고, 오른쪽에 따로 떨어진 잉크 FAB을 둔다.
 * 사라진 두 탭의 목적지는 없어지지 않는다(수용기준 「기능 손실 0」):
 *
 *   에이전트  FAB 시트의 「에이전트 부르기」가 여는 층(`agentList`). ADR-0189 D1은
 *             이것을 홈 맨 위 「작업 중」 카드와 DM 섹션으로 흡수하라고 했고, 그
 *             홈은 DS2-3(#2715)이 그린다. 그때까지 문은 FAB에 있다.
 *   작업      FAB 시트의 「작업」이 여는 층(`workList`) — 팀 보드 한 열 판(#2864). 서버가 그 표면을
 *             내줄 때만 문이 선다 — 탭일 때와 같은 조건이다.
 *
 * 검색은 층에서 **탭**이 되었다. 층이던 때의 이유(「검색은 머무는 곳이 아니라
 * 가는 길」)는 이 ADR이 뒤집은 판단이다: 시안 A는 검색을 탭바의 세 자리 중 하나로
 * 두고, 결과에서 연 대화의 뒤로가기는 여전히 결과 목록(= 검색 탭)으로 온다 — 층일
 * 때 지키려던 그 성질이 탭에서는 구조로 성립한다.
 *
 * 이 목록이 그 셋을 적는 유일한 곳이다. 탭바가 이것을 돌고 `tabLabel`이 이름을
 * 붙인다.
 */
export type Tab = 'home' | 'inbox' | 'search';

export const TABS: readonly Tab[] = ['home', 'inbox', 'search'];

/** 셋 모두 언제나 보인다. 서버 표면에 따라 숨는 탭은 더 없다(작업은 FAB 시트로). */
export function visibleTabs(): readonly Tab[] {
  return TABS;
}

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  home: '홈',
  inbox: '인박스',
  search: '검색',
};

export function tabLabel(tab: Tab): string {
  return TAB_LABELS[tab];
}

/** 작업 콘솔의 문을 세울지. 탭이던 때와 같은 조건이다. */
export function workConsoleAvailable(): boolean {
  return isSurfaceProvided('workConsole');
}

/**
 * A conversation that is currently open.
 *
 * The title rides along rather than being re-derived on the conversation screen:
 * it was already resolved through `channelLabel` (which needs the roster and the
 * ambiguity index) at the moment the row was tapped, and re-deriving it there
 * would make the header flicker from "다이렉트 메시지" to a name every time the
 * roster query refetched.
 */
export interface OpenConversation {
  channelId: string;
  /** Already disambiguated by `@momo/core/features/workspace/directory`. */
  title: string;
  /**
   * The message this conversation was opened to show, when it was reached from
   * a search result. Both halves travel: the id finds the row, and the seq is
   * what lets a miss be *explained* instead of swallowed (B12 R2 High-3).
   */
  anchor?: {messageId: string; seq: number};
  /**
   * 알림 본문을 눌러 열렸을 때만 선다 — 어디에 착지할지 (#2569).
   *
   * `anchor` 와 따로 있는 이유: 알림은 식별자만 나르므로(ADR-0120) `seq` 가 없고,
   * 답글이면 채널 위에 스레드를 열어야 한다. `token` 은 탭마다 새로 서서, 같은
   * 메시지를 가리키는 두 번의 탭이 두 번 착지한다.
   */
  notification?: NotificationLanding;
}

/**
 * One agent's own screen — 상태·모델·채널·지금 하는 일.
 *
 * Carries the name for the same reason `OpenConversation` does: it was already
 * disambiguated against the roster when the row was tapped, and a header that
 * re-derives it flickers on every roster refetch. The id is what every request
 * on that screen is keyed by.
 */
export interface OpenAgent {
  memberId: string;
  displayName: string;
  handle: string;
}

/** One read-only work-session detail pushed over the 작업 tab. */
export interface OpenWorkSession {
  sessionId: string;
}

/**
 * One hosted connection, opened from the 호스티드 연결 list (goal HAP-UX3).
 *
 * Carries the title (the dedicated agent's name, disambiguated against the
 * roster at tap time) for the same reason `OpenAgent` does: a header that
 * re-derives it flickers on every roster refetch. The connectionId is what the
 * detail read is keyed by; the agentMemberId re-resolves identity if the roster
 * arrives late.
 */
export interface OpenHostedConnection {
  connectionId: string;
  agentMemberId: string;
  title: string;
}

/**
 * 호스티드 연결 관전 층 — 에이전트 탭에서 열리는 목록, 그 목록이 여는 상세.
 *
 * 한 필드에 두 겹을 담는다: 목록과 상세는 push 관계라 뒤로가기가 상세→목록→닫힘
 * 으로 한 겹씩 벗겨져야 하고, 그 관계를 `null | list | detail` 로 적으면 `back`
 * 이 그것을 그대로 읽는다. 작업 탭이 목록(탭)과 상세(층)로 나뉜 것과 같은 모양을,
 * 탭이 없는 이 표면은 한 필드 안에서 낸다.
 */
export type HostedNav =
  | null
  | {kind: 'list'}
  | {kind: 'detail'; connection: OpenHostedConnection};

/**
 * 「앱」 읽기 층 — AI 시트의 「앱」 줄이 여는 목록, 그 목록이 여는 상세 (U-4 #3951).
 *
 * 호스티드 연결과 같은 한 필드 두 겹이다: 목록과 상세는 push 관계라 뒤로가기가 상세→목록→
 * 닫힘으로 한 겹씩 벗겨진다. 이 층에는 설치·허용이 없다(폰은 읽기와 승인만, plans 2.6).
 * `name` 을 상세가 들고 오는 이유는 `OpenHostedConnection.title` 과 같다: 머리가 목록을
 * 다시 읽을 때마다 깜빡이지 않게.
 */
export type AppsNav =
  | null
  | {kind: 'list'}
  | {kind: 'detail'; pluginId: string; name: string};

export interface NavState {
  tab: Tab;
  /** Pushed over the whole shell, or null when the tabs are visible. */
  conversation: OpenConversation | null;
  /**
   * 검색 **탭**에 건넬 첫 검색어 (ADR-0189 D1로 검색이 탭이 된 뒤).
   *
   * 사이드바 필터가 이름으로 아무것도 못 찾으면, 그 낱말은 대개 누군가 **한 말**
   * 이다. 그 말을 검색 탭에 넘겨 사람이 두 번 치지 않게 한다. `seq`는 넘길 때마다
   * 오른다: 검색 화면은 자기 입력을 들고 있으므로, 같은 탭에 새 검색어를 넘기려면
   * 그 화면을 새로 세워야 하고 셸이 이 값을 키로 쓴다.
   */
  searchSeed: {initialQuery: string; seq: number} | null;
  /**
   * 에이전트 목록 — FAB 시트의 「에이전트 부르기」가 여는 층.
   *
   * 탭이던 것이 층이 되었다(ADR-0189 D1). 한 에이전트(`agent`)와 호스티드 연결
   * (`hosted`)은 이 목록 **위**에 뜨고, 뒤로가기는 그 둘을 벗긴 뒤 이 목록을 닫는다.
   */
  agentList: boolean;
  /**
   * 한 에이전트, over the tabs and UNDER a conversation: opening the DM with an
   * agent from its own screen must come BACK to that screen, not to the list two
   * steps out.
   */
  agent: OpenAgent | null;
  /** 작업(팀 보드 한 열 판) — FAB 시트가 여는 층(탭이던 것, ADR-0189 D1). */
  workList: boolean;
  /** 작업 콘솔 위, 그리고 그 상세가 여는 대화 아래. */
  workSession: OpenWorkSession | null;
  /**
   * 호스티드 연결 관전 — 에이전트 목록 위에 뜨는 목록/상세 (goal HAP-UX3).
   *
   * agent·workSession 과 **배타적**이다: 하나가 열리면 나머지는 닫힌다. 에이전트
   * 목록에서 갈라져 나오는 두 갈래(한 에이전트로 들어가기 · 호스티드 연결 목록
   * 보기)가 서로를 덮지 않게 하는 규칙이다.
   */
  hosted: HostedNav;
  /**
   * 「앱」 읽기 — AI 시트가 여는 목록/상세 (U-4 #3951). agent·workSession·hosted 와 **배타적**이다.
   * 에이전트 쪽 층이 열리면 이 층은 닫히고, 이 층이 열리면 그쪽이 닫힌다.
   */
  apps: AppsNav;
  /**
   * 「설정」 페이지 — 홈 머리의 내 얼굴이 여는 전체 화면 (#4457, owner 10-25).
   *
   * 시트였던 프로필(`ProfileSheet`)이 페이지가 된 것이다. `docs/design-system/phone-sheets.md` §1:
   * 여러 묶음의 설정은 **페이지**이고, 페이지는 화면 스택에 쌓여 가장자리 밀기로 닫힌다. 새 필드는
   * 이 하나(`boolean`)뿐이다 — 이 파일 머리 주석이 말한 「필드 하나 추가」의 범위 안이다.
   *
   * 층 중 **가장 아래**다(탭이 홈일 때만 문이 있고, 그 위에 다른 층이 서면 문이 가려진다). 그래서
   * `back` 에서는 맨 마지막에 벗겨진다. 안쪽 장(테마·지시 기기 등)은 설정 화면이 스스로 쥔다 —
   * 다른 층과 엮이지 않는 지역 상태라 여기에 싣지 않는다.
   */
  settings: boolean;
}

/** 탭 위에 아무 층도 없는 상태. 탭 전환과 알림 입구가 이것으로 시작한다. */
const NO_LAYERS = {
  conversation: null,
  agentList: false,
  agent: null,
  workList: false,
  workSession: null,
  hosted: null,
  apps: null,
  settings: false,
} as const;

export const INITIAL_NAV: NavState = {
  tab: 'home',
  searchSeed: null,
  ...NO_LAYERS,
};

export type NavAction =
  | {type: 'selectTab'; tab: Tab}
  | {type: 'openConversation'; conversation: OpenConversation}
  | {type: 'openFromNotification'; conversation: OpenConversation}
  | {type: 'openWorkSessionFromNotification'; workSession: OpenWorkSession}
  | {type: 'openSearch'; initialQuery?: string}
  | {type: 'openAgentList'}
  | {type: 'openAgent'; agent: OpenAgent}
  | {type: 'openWorkList'}
  | {type: 'openWorkSession'; workSession: OpenWorkSession}
  | {type: 'openHostedList'}
  | {type: 'openHostedConnection'; connection: OpenHostedConnection}
  | {type: 'openAppsList'}
  | {type: 'openApp'; pluginId: string; name: string}
  | {type: 'openSettings'}
  | {type: 'channelLeft'; channelId: string}
  | {type: 'back'}
  | {type: 'reset'};

function hasLayers(state: NavState): boolean {
  return (
    state.conversation !== null ||
    state.agentList ||
    state.agent !== null ||
    state.workList ||
    state.workSession !== null ||
    state.hosted !== null ||
    state.apps !== null ||
    state.settings
  );
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'selectTab':
      // Re-tapping the current tab is not a state change. Returning `state`
      // itself (rather than an equal object) keeps React from re-rendering the
      // whole shell on every stray tap.
      if (state.tab === action.tab && !hasLayers(state)) return state;
      // A tab tap also closes every layer. It cannot normally be reached while
      // one is open (the tab bar is behind it), but a deep link or a
      // notification will be able to, and landing on a tab with a conversation
      // still stacked over it would look like the tap did nothing.
      return {...state, tab: action.tab, ...NO_LAYERS};
    case 'openConversation':
      return {...state, conversation: action.conversation};
    case 'openFromNotification':
      // 알림은 **새 입구**다 (#2569). 그 순간 무엇이 열려 있었든 — 한 에이전트,
      // 작업 상세, 다른 대화 — 사람은 그곳에서 이 대화로 온 것이 아니라 잠금
      // 화면이나 배너에서 왔다. 그 층들 위에 대화를 얹으면 뒤로가기가 사람이 지나온
      // 적 없는 화면으로 떨어진다. 그래서 홈 탭 위의 대화 하나로 연다: 뒤로 한 번이면
      // 대화 목록이다.
      return {
        ...state,
        tab: 'home',
        ...NO_LAYERS,
        conversation: action.conversation,
      };
    case 'openWorkSessionFromNotification':
      // 「작업 끝남」 알림도 **새 입구**다 — 위 `openFromNotification` 과 같은 이유로 열려
      // 있던 층은 모두 걷는다. 세션 화면 **아래**에는 작업 목록(팀 보드)을 깐다: 그
      // 화면의 뒤로가기는 「작업 목록으로」라고 말하고(`WorkSessionDetailScreen`), 목록에서
      // 세션을 눌러 들어온 것과 같은 모양이어야 그 말이 참이다. 뒤로 두 번이면 홈이다.
      return {
        ...state,
        tab: 'home',
        ...NO_LAYERS,
        workList: true,
        workSession: action.workSession,
      };
    case 'openSearch':
      // 검색은 탭이다(ADR-0189 D1). 넘길 말이 있으면 씨앗을 새로 세운다 — 없으면
      // 검색 탭이 들고 있던 입력을 그대로 둔다(탭을 오가도 검색어가 남는다).
      return {
        ...state,
        tab: 'search',
        ...NO_LAYERS,
        searchSeed:
          action.initialQuery === undefined
            ? state.searchSeed
            : {
                initialQuery: action.initialQuery,
                seq: (state.searchSeed?.seq ?? 0) + 1,
              },
      };
    case 'openAgentList':
      // FAB 시트에서 연다. 에이전트 목록에서 갈라지는 층들은 새로 시작한다.
      return {
        ...state,
        agentList: true,
        agent: null,
        workList: false,
        workSession: null,
        hosted: null,
        apps: null,
      };
    case 'openAgent':
      return {
        ...state,
        // 작성자 프로필에서도 이 액션을 쓴다 (#1681). 에이전트 상세는 대화보다
        // 아래에 그려지는 기존 층이므로, 열린 대화를 함께 걷지 않으면 새 화면이
        // 뒤에 생겨 탭의 결과가 보이지 않는다.
        conversation: null,
        agent: action.agent,
        workSession: null,
        hosted: null,
        apps: null,
      };
    case 'openWorkList':
      // 열려 있던 대화도 걷는다: 「작업 맡기기」가 DM 머리에서 접수되면(#3588) 보드가 그 대화
      // 밑에 깔려 안 보인다. + 메뉴는 층이 덮은 동안 열리지 않으므로 기존 길은 그대로다.
      return {
        ...state,
        conversation: null,
        agentList: false,
        agent: null,
        workList: true,
        workSession: null,
        hosted: null,
        apps: null,
      };
    case 'openWorkSession':
      return {
        ...state,
        agent: null,
        workSession: action.workSession,
        hosted: null,
        apps: null,
      };
    case 'openHostedList':
      // The list is a sibling of 「one agent」 reached from the same list, so it
      // closes the same layers those close among themselves.
      return {
        ...state,
        agent: null,
        workSession: null,
        hosted: {kind: 'list'},
        apps: null,
      };
    case 'openHostedConnection':
      // Opened FROM the list: the list stays the layer beneath, so 뒤로 from the
      // detail returns to it rather than out to the tab.
      return {...state, hosted: {kind: 'detail', connection: action.connection}};
    case 'openAppsList':
      // AI 시트에서 연다. 시트는 층이 없는 탭 위에서만 열리지만, 그래도 에이전트 쪽 층은 새로 시작한다.
      return {...state, ...NO_LAYERS, apps: {kind: 'list'}};
    case 'openApp':
      // 목록에서 연다: 목록이 밑에 남아 뒤로가 상세만 벗긴다.
      return {
        ...state,
        apps: {kind: 'detail', pluginId: action.pluginId, name: action.name},
      };
    case 'openSettings':
      // 홈 머리의 얼굴이 연다. 다른 층을 걷지 않는다 — 문이 서 있는 곳은 층이 없는 홈 탭뿐이고,
      // 층이 이미 있으면 그 층이 문을 가린다. 같은 값이면 상태를 그대로 돌려 불필요한 렌더를 막는다.
      if (state.settings) return state;
      return {...state, settings: true};
    case 'channelLeft':
      // 열려 있는 채널을 **내가 나갔다** (#4229). 웹은 `/` 로 착지한다. 폰의 같은 자리는 그 대화 층을 걷어
      // 아래 화면(사이드바)으로 돌아가는 것이다. 다른 채널이 열려 있으면 건드리지 않는다.
      if (
        state.conversation === null ||
        state.conversation.channelId.toLowerCase() !== action.channelId.toLowerCase()
      ) {
        return state;
      }
      return {...state, conversation: null};
    case 'back':
      // One step at a time, innermost first: a conversation opened FROM a search
      // result (or from an agent's own screen) goes back to where it was opened
      // from, not past it.
      if (state.conversation !== null) return {...state, conversation: null};
      // Hosted detail peels back to its list, and only then does the list close —
      // the same one-step-at-a-time the 작업 detail gets over its list.
      if (state.hosted?.kind === 'detail') return {...state, hosted: {kind: 'list'}};
      if (state.hosted?.kind === 'list') return {...state, hosted: null};
      // 앱 상세도 같다: 목록으로 한 걸음, 그다음에 목록이 닫힌다.
      if (state.apps?.kind === 'detail') return {...state, apps: {kind: 'list'}};
      if (state.apps?.kind === 'list') return {...state, apps: null};
      if (state.agent !== null) return {...state, agent: null};
      if (state.workSession !== null) return {...state, workSession: null};
      if (state.agentList) return {...state, agentList: false};
      if (state.workList) return {...state, workList: false};
      // 설정은 가장 아래 층이다 — 위에 무엇이 얹혀 있든 그것들이 먼저 벗겨진 뒤에 닫힌다.
      if (state.settings) return {...state, settings: false};
      return state;
    case 'reset':
      // Sign-out. The next person to sign in must not land in the previous
      // person's channel.
      return INITIAL_NAV;
  }
}

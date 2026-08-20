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

/**
 * The v0 tabs.
 *
 * Four: 대화·인박스·에이전트 plus a workspace-wide 작업 console. The fourth
 * tab adds one nullable detail layer, not an independent navigation stack.
 *
 * D5 named three axes and the third one had no surface at all:
 * 대화 and 인박스 covered 대화·승인, and 관전 — what the agents are actually
 * DOING — was reachable only on the desktop. A messenger where the agent can
 * only be talked to is a chat with a bot in it, which is the shape ADR-0101
 * refused; 「에이전트」 is where that is undone (진단 2026-08-03 A안).
 *
 * This list is the only place the set is written down. `TabBar` maps over it and
 * `tabLabel` names it, so a fourth tab is one line here and nowhere else.
 */
export type Tab = 'channels' | 'inbox' | 'agents' | 'work';

export const TABS: readonly Tab[] = ['channels', 'inbox', 'agents', 'work'];

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  channels: '대화',
  inbox: '인박스',
  // 세 글자. 「에이전트」는 이 제품이 그것을 부르는 이름이고(사이드바 섹션
  // 라벨과 같다), 줄여 부르면 두 화면이 같은 것을 다르게 부르게 된다.
  agents: '에이전트',
  work: '작업',
};

export function tabLabel(tab: Tab): string {
  return TAB_LABELS[tab];
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

export interface NavState {
  tab: Tab;
  /** Pushed over the whole shell, or null when the tabs are visible. */
  conversation: OpenConversation | null;
  /**
   * 메시지 검색, over the tabs and UNDER a conversation.
   *
   * Not a tab: search is a way of REACHING a destination rather than a place to
   * be. It stays open behind the conversation it opened, so 뒤로 from a result
   * lands back on the result list — going all the way out to the channel list
   * would throw away the query they typed.
   *
   * `initialQuery` carries what was already typed. The sidebar's filter searches
   * channels and people by NAME; when that finds nothing, the words are usually
   * a thing someone SAID. Handing them over means the person types once.
   */
  search: {initialQuery: string} | null;
  /**
   * 한 에이전트, over the tabs and UNDER a conversation — the same layer as
   * search, and for the same reason: opening the DM with an agent from its own
   * screen must come BACK to that screen, not to the list two steps out.
   *
   * It is not a tab either, even though it is reached from one: 「에이전트」 is
   * the place, and this is one row of it opened up.
   */
  agent: OpenAgent | null;
  /** 작업 탭의 목록 위, 그리고 그 상세가 여는 대화 아래. */
  workSession: OpenWorkSession | null;
  /**
   * 호스티드 연결 관전 — 에이전트 탭 위에 뜨는 목록/상세 (goal HAP-UX3).
   *
   * search·agent·workSession 과 **배타적**이다: 하나가 열리면 나머지는 닫힌다.
   * 에이전트 탭에서 갈라져 나오는 두 갈래(한 에이전트로 들어가기 · 호스티드 연결
   * 목록 보기)가 서로를 덮지 않게 하는 규칙이다.
   */
  hosted: HostedNav;
}

export const INITIAL_NAV: NavState = {
  tab: 'channels',
  conversation: null,
  search: null,
  agent: null,
  workSession: null,
  hosted: null,
};

export type NavAction =
  | {type: 'selectTab'; tab: Tab}
  | {type: 'openConversation'; conversation: OpenConversation}
  | {type: 'openSearch'; initialQuery?: string}
  | {type: 'openAgent'; agent: OpenAgent}
  | {type: 'openWorkSession'; workSession: OpenWorkSession}
  | {type: 'openHostedList'}
  | {type: 'openHostedConnection'; connection: OpenHostedConnection}
  | {type: 'back'}
  | {type: 'reset'};

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'selectTab':
      // Re-tapping the current tab is not a state change. Returning `state`
      // itself (rather than an equal object) keeps React from re-rendering the
      // whole shell on every stray tap.
      if (
        state.tab === action.tab &&
        state.conversation === null &&
        state.search === null &&
        state.agent === null &&
        state.workSession === null &&
        state.hosted === null
      ) {
        return state;
      }
      // A tab tap also closes a conversation. It cannot normally be reached
      // while one is open (the tab bar is behind it), but a deep link or a
      // notification will be able to, and landing on a tab with a conversation
      // still stacked over it would look like the tap did nothing.
      return {
        tab: action.tab,
        conversation: null,
        search: null,
        agent: null,
        workSession: null,
        hosted: null,
      };
    case 'openConversation':
      return {...state, conversation: action.conversation};
    case 'openSearch':
      return {
        ...state,
        search: {initialQuery: action.initialQuery ?? ''},
        agent: null,
        workSession: null,
        hosted: null,
      };
    case 'openAgent':
      return {
        ...state,
        search: null,
        agent: action.agent,
        workSession: null,
        hosted: null,
      };
    case 'openWorkSession':
      return {
        ...state,
        search: null,
        agent: null,
        workSession: action.workSession,
        hosted: null,
      };
    case 'openHostedList':
      // The list is a sibling of 「one agent」 reached from the same tab, so it
      // closes the same three layers those close among themselves.
      return {
        ...state,
        search: null,
        agent: null,
        workSession: null,
        hosted: {kind: 'list'},
      };
    case 'openHostedConnection':
      // Opened FROM the list: the list stays the layer beneath, so 뒤로 from the
      // detail returns to it rather than out to the tab.
      return {...state, hosted: {kind: 'detail', connection: action.connection}};
    case 'back':
      // One step at a time, innermost first: a conversation opened FROM a search
      // result (or from an agent's own screen) goes back to where it was opened
      // from, not past it.
      if (state.conversation !== null) return {...state, conversation: null};
      // Hosted detail peels back to its list, and only then does the list close —
      // the same one-step-at-a-time the 작업 detail gets over its list.
      if (state.hosted?.kind === 'detail') return {...state, hosted: {kind: 'list'}};
      if (state.hosted?.kind === 'list') return {...state, hosted: null};
      if (state.search !== null) return {...state, search: null};
      if (state.agent !== null) return {...state, agent: null};
      if (state.workSession !== null) return {...state, workSession: null};
      return state;
    case 'reset':
      // Sign-out. The next person to sign in must not land in the previous
      // person's channel.
      return INITIAL_NAV;
  }
}

// =============================================================================
// Where the app is, as a value.
//
// ## Why this is 60 lines and not `@react-navigation/native`
//
// v0 has three destinations (ADR-0137 D5 draws the box: 관전·승인·대화, and
// explicitly puts 설정·디렉터리 관리·업데이트 outside it). react-navigation would
// bring `react-native-screens` and `react-native-gesture-handler` — two native
// modules, another `pod install`, and two more New-Architecture interop surfaces
// — to express "two tabs and one push". That trade is worth making when the
// destination count grows, and it is a decision with a native-dependency cost, so
// it belongs to whoever adds the fourth screen rather than to this batch.
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

/** The v0 tabs. Two, because D5 named two things: 관전(대화) and 승인(인박스). */
export type Tab = 'channels' | 'inbox';

export const TABS: readonly Tab[] = ['channels', 'inbox'];

export function tabLabel(tab: Tab): string {
  return tab === 'channels' ? '대화' : '인박스';
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

export interface NavState {
  tab: Tab;
  /** Pushed over the whole shell, or null when the tabs are visible. */
  conversation: OpenConversation | null;
  /**
   * 메시지 검색, over the tabs and UNDER a conversation.
   *
   * Not a third tab: D5 named two destinations, and search is a way of reaching
   * one of them rather than a place to be. It stays open behind the conversation
   * it opened, so 뒤로 from a result lands back on the result list — going all
   * the way out to the channel list would throw away the query they typed.
   *
   * `initialQuery` carries what was already typed. The sidebar's filter searches
   * channels and people by NAME; when that finds nothing, the words are usually
   * a thing someone SAID. Handing them over means the person types once.
   */
  search: {initialQuery: string} | null;
}

export const INITIAL_NAV: NavState = {
  tab: 'channels',
  conversation: null,
  search: null,
};

export type NavAction =
  | {type: 'selectTab'; tab: Tab}
  | {type: 'openConversation'; conversation: OpenConversation}
  | {type: 'openSearch'; initialQuery?: string}
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
        state.search === null
      ) {
        return state;
      }
      // A tab tap also closes a conversation. It cannot normally be reached
      // while one is open (the tab bar is behind it), but a deep link or a
      // notification will be able to, and landing on a tab with a conversation
      // still stacked over it would look like the tap did nothing.
      return {tab: action.tab, conversation: null, search: null};
    case 'openConversation':
      return {...state, conversation: action.conversation};
    case 'openSearch':
      return {...state, search: {initialQuery: action.initialQuery ?? ''}};
    case 'back':
      // One step at a time, innermost first: a conversation opened FROM a search
      // result goes back to the results, not past them.
      if (state.conversation !== null) return {...state, conversation: null};
      if (state.search !== null) return {...state, search: null};
      return state;
    case 'reset':
      // Sign-out. The next person to sign in must not land in the previous
      // person's channel.
      return INITIAL_NAV;
  }
}

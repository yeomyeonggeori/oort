import {
  INITIAL_NAV,
  navReducer,
  tabLabel,
  TABS,
  type NavState,
} from '../src/nav/state';

// =============================================================================
// Navigation is a reducer so that "어디서 왔든 뒤로 가면 왔던 곳" can be asserted
// rather than clicked through. Every case below is a way a hand-rolled shell
// normally goes wrong.
// =============================================================================

const OPEN = {channelId: 'CH-1', title: '#general'};

describe('the two tabs', () => {
  it('starts on 대화 with nothing pushed over it', () => {
    expect(INITIAL_NAV).toEqual({tab: 'channels', conversation: null});
  });

  it('names both tabs', () => {
    expect(TABS.map(tabLabel)).toEqual(['대화', '인박스']);
  });

  it('switches tabs', () => {
    const next = navReducer(INITIAL_NAV, {type: 'selectTab', tab: 'inbox'});
    expect(next.tab).toBe('inbox');
  });

  it('returns the SAME object when the tab did not change', () => {
    // Identity, not equality. A new object here re-renders the whole shell —
    // including two mounted lists — on every stray tap of the current tab.
    const next = navReducer(INITIAL_NAV, {type: 'selectTab', tab: 'channels'});
    expect(next).toBe(INITIAL_NAV);
  });
});

describe('a conversation covers the shell', () => {
  it('opens over whichever tab was current', () => {
    const onInbox: NavState = {tab: 'inbox', conversation: null};
    const next = navReducer(onInbox, {type: 'openConversation', conversation: OPEN});
    expect(next).toEqual({tab: 'inbox', conversation: OPEN});
  });

  it('goes back to the tab it was opened from, not to a default', () => {
    // The bug this prevents: opening a channel from 인박스 and landing on 대화
    // when you press back, having lost the list you were reading.
    const fromInbox: NavState = {tab: 'inbox', conversation: OPEN};
    expect(navReducer(fromInbox, {type: 'back'})).toEqual({
      tab: 'inbox',
      conversation: null,
    });
  });

  it('ignores back when there is nothing to go back from', () => {
    const next = navReducer(INITIAL_NAV, {type: 'back'});
    expect(next).toBe(INITIAL_NAV);
  });

  it('replaces one conversation with another rather than stacking', () => {
    const first: NavState = {tab: 'channels', conversation: OPEN};
    const second = {channelId: 'CH-2', title: '김인턴'};
    const next = navReducer(first, {type: 'openConversation', conversation: second});
    expect(next.conversation).toEqual(second);
    // One back press returns to the list, not to the previous conversation.
    expect(navReducer(next, {type: 'back'}).conversation).toBeNull();
  });

  it('closes the conversation when a tab is selected', () => {
    // Not normally reachable — the tab bar is behind the conversation — but a
    // deep link or a notification will be able to, and landing on a tab with a
    // conversation still stacked over it looks like the tap did nothing.
    const covered: NavState = {tab: 'channels', conversation: OPEN};
    expect(navReducer(covered, {type: 'selectTab', tab: 'inbox'})).toEqual({
      tab: 'inbox',
      conversation: null,
    });
  });

  it('closes the conversation even when the SAME tab is re-selected', () => {
    const covered: NavState = {tab: 'channels', conversation: OPEN};
    expect(navReducer(covered, {type: 'selectTab', tab: 'channels'})).toEqual(
      INITIAL_NAV,
    );
  });
});

describe('sign-out', () => {
  it('forgets where the previous person was', () => {
    const deep: NavState = {tab: 'inbox', conversation: OPEN};
    expect(navReducer(deep, {type: 'reset'})).toEqual(INITIAL_NAV);
  });
});

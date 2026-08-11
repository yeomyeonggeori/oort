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

describe('the four tabs', () => {
  it('starts on 대화 with nothing pushed over it', () => {
    expect(INITIAL_NAV).toEqual({
      tab: 'channels',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    });
  });

  it('names every tab, in the order the tab bar draws them', () => {
    // 「에이전트」 is spelled out rather than shortened: it is what the web
    // client calls the same destination, and two clients that name one place
    // differently have shipped a defect.
    expect(TABS.map(tabLabel)).toEqual(['대화', '인박스', '에이전트', '작업']);
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
    const onInbox: NavState = {
      tab: 'inbox',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    };
    const next = navReducer(onInbox, {type: 'openConversation', conversation: OPEN});
    expect(next).toEqual({
      tab: 'inbox',
      conversation: OPEN,
      search: null,
      agent: null,
      workSession: null,
    });
  });

  it('goes back to the tab it was opened from, not to a default', () => {
    // The bug this prevents: opening a channel from 인박스 and landing on 대화
    // when you press back, having lost the list you were reading.
    const fromInbox: NavState = {
      tab: 'inbox',
      conversation: OPEN,
      search: null,
      agent: null,
      workSession: null,
    };
    expect(navReducer(fromInbox, {type: 'back'})).toEqual({
      tab: 'inbox',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    });
  });

  it('ignores back when there is nothing to go back from', () => {
    const next = navReducer(INITIAL_NAV, {type: 'back'});
    expect(next).toBe(INITIAL_NAV);
  });

  it('replaces one conversation with another rather than stacking', () => {
    const first: NavState = {
      tab: 'channels',
      conversation: OPEN,
      search: null,
      agent: null,
      workSession: null,
    };
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
    const covered: NavState = {
      tab: 'channels',
      conversation: OPEN,
      search: null,
      agent: null,
      workSession: null,
    };
    expect(navReducer(covered, {type: 'selectTab', tab: 'inbox'})).toEqual({
      tab: 'inbox',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    });
  });

  it('closes the conversation even when the SAME tab is re-selected', () => {
    const covered: NavState = {
      tab: 'channels',
      conversation: OPEN,
      search: null,
      agent: null,
      workSession: null,
    };
    expect(navReducer(covered, {type: 'selectTab', tab: 'channels'})).toEqual(
      INITIAL_NAV,
    );
  });
});

describe('one agent, opened from the 에이전트 tab', () => {
  const AGENT = {
    memberId: 'cccccccc-1111-4111-8111-cccccccccccc',
    displayName: '김인턴',
    handle: 'kim-intern',
  };

  it('opens over the tab it was reached from', () => {
    const onAgents: NavState = {
      tab: 'agents',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    };
    expect(navReducer(onAgents, {type: 'openAgent', agent: AGENT})).toEqual({
      tab: 'agents',
      conversation: null,
      search: null,
      agent: AGENT,
      workSession: null,
    });
  });

  it('sits UNDER a conversation, so the DM comes back to the agent', () => {
    // The reason this layer exists: 대화 열기 on an agent's own screen must
    // return HERE, not to the list two steps out.
    const open: NavState = {
      tab: 'agents',
      conversation: null,
      search: null,
      agent: AGENT,
      workSession: null,
    };
    const withDm = navReducer(open, {type: 'openConversation', conversation: OPEN});
    expect(withDm.agent).toEqual(AGENT);
    const back = navReducer(withDm, {type: 'back'});
    expect(back.conversation).toBeNull();
    expect(back.agent).toEqual(AGENT);
    // A second back leaves the agent, and only then.
    expect(navReducer(back, {type: 'back'}).agent).toBeNull();
  });

  it('is closed by a tab tap, like everything else stacked over the tabs', () => {
    const open: NavState = {
      tab: 'agents',
      conversation: null,
      search: null,
      agent: AGENT,
      workSession: null,
    };
    expect(navReducer(open, {type: 'selectTab', tab: 'agents'})).toEqual({
      tab: 'agents',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    });
  });
});

describe('one work session, opened from the 작업 tab', () => {
  const WORK = {sessionId: 'SESSION-1'};

  it('keeps the detail under the origin conversation it opens', () => {
    const onWork: NavState = {
      tab: 'work',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    };
    const detail = navReducer(onWork, {
      type: 'openWorkSession',
      workSession: WORK,
    });
    expect(detail.workSession).toEqual(WORK);

    const conversation = navReducer(detail, {
      type: 'openConversation',
      conversation: OPEN,
    });
    expect(navReducer(conversation, {type: 'back'})).toEqual(detail);
    expect(navReducer(detail, {type: 'back'})).toEqual(onWork);
  });

  it('is cleared by a tab selection', () => {
    const detail: NavState = {
      tab: 'work',
      conversation: null,
      search: null,
      agent: null,
      workSession: WORK,
    };
    expect(navReducer(detail, {type: 'selectTab', tab: 'work'})).toEqual({
      tab: 'work',
      conversation: null,
      search: null,
      agent: null,
      workSession: null,
    });
  });
});

describe('sign-out', () => {
  it('forgets where the previous person was', () => {
    const deep: NavState = {
      tab: 'inbox',
      conversation: OPEN,
      search: null,
      agent: {
        memberId: 'cccccccc-1111-4111-8111-cccccccccccc',
        displayName: '김인턴',
        handle: 'kim-intern',
      },
      workSession: null,
    };
    expect(navReducer(deep, {type: 'reset'})).toEqual(INITIAL_NAV);
  });
});

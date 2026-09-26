import {
  INITIAL_NAV,
  navReducer,
  tabLabel,
  TABS,
  visibleTabs,
  type NavState,
  type OpenHostedConnection,
} from '../src/nav/state';

// =============================================================================
// Navigation is a reducer so that "어디서 왔든 뒤로 가면 왔던 곳" can be asserted
// rather than clicked through. Every case below is a way a hand-rolled shell
// normally goes wrong.
//
// DS2-2 (#2714, ADR-0189 D1): 탭이 넷(대화·인박스·에이전트·작업)에서 셋(홈·인박스·
// 검색)으로 줄었다. 에이전트와 작업은 FAB 시트가 여는 **층**이 되었고, 검색은 층에서
// 탭이 되었다. 아래 단정들은 그 옮김 뒤에도 같은 성질(한 겹씩 벗겨지는 뒤로가기,
// 탭 탭이 모든 층을 걷는다)을 잰다.
// =============================================================================

const OPEN = {channelId: 'CH-1', title: '#general'};

/** 기본값 위에 필요한 필드만 얹는다. 모양이 바뀌어도 단정이 뜻을 잃지 않게. */
function nav(over: Partial<NavState> = {}): NavState {
  return {...INITIAL_NAV, ...over};
}

describe('the three tabs (ADR-0189 D1)', () => {
  it('starts on 홈 with nothing pushed over it', () => {
    expect(INITIAL_NAV).toEqual({
      tab: 'home',
      conversation: null,
      searchSeed: null,
      agentList: false,
      agent: null,
      workList: false,
      workSession: null,
      hosted: null,
    });
  });

  it('is exactly 홈·인박스·검색 — the 에이전트 and 작업 tabs are gone', () => {
    expect(TABS).toEqual(['home', 'inbox', 'search']);
    expect(TABS.map(tabLabel)).toEqual(['홈', '인박스', '검색']);
    expect(visibleTabs()).toEqual(TABS);
    expect(TABS).not.toContain('agents');
    expect(TABS).not.toContain('work');
  });

  it('switches tabs', () => {
    const next = navReducer(INITIAL_NAV, {type: 'selectTab', tab: 'inbox'});
    expect(next.tab).toBe('inbox');
  });

  it('returns the SAME object when the tab did not change', () => {
    // Identity, not equality. A new object here re-renders the whole shell —
    // including two mounted lists — on every stray tap of the current tab.
    const next = navReducer(INITIAL_NAV, {type: 'selectTab', tab: 'home'});
    expect(next).toBe(INITIAL_NAV);
  });
});

describe('a conversation covers the shell', () => {
  it('opens over whichever tab was current', () => {
    const next = navReducer(nav({tab: 'inbox'}), {
      type: 'openConversation',
      conversation: OPEN,
    });
    expect(next).toEqual(nav({tab: 'inbox', conversation: OPEN}));
  });

  it('goes back to the tab it was opened from, not to a default', () => {
    // The bug this prevents: opening a channel from 인박스 and landing on 홈
    // when you press back, having lost the list you were reading.
    expect(
      navReducer(nav({tab: 'inbox', conversation: OPEN}), {type: 'back'}),
    ).toEqual(nav({tab: 'inbox'}));
  });

  it('ignores back when there is nothing to go back from', () => {
    expect(navReducer(INITIAL_NAV, {type: 'back'})).toBe(INITIAL_NAV);
  });

  it('replaces one conversation with another rather than stacking', () => {
    const second = {channelId: 'CH-2', title: '김인턴'};
    const next = navReducer(nav({conversation: OPEN}), {
      type: 'openConversation',
      conversation: second,
    });
    expect(next.conversation).toEqual(second);
    expect(navReducer(next, {type: 'back'}).conversation).toBeNull();
  });

  it('closes the conversation when a tab is selected', () => {
    expect(
      navReducer(nav({conversation: OPEN}), {type: 'selectTab', tab: 'inbox'}),
    ).toEqual(nav({tab: 'inbox'}));
  });

  it('closes the conversation even when the SAME tab is re-selected', () => {
    expect(
      navReducer(nav({conversation: OPEN}), {type: 'selectTab', tab: 'home'}),
    ).toEqual(INITIAL_NAV);
  });
});

describe('검색 is a tab now, and a query handed to it arrives (ADR-0189 D1)', () => {
  it('opens the search tab carrying what was typed into the sidebar filter', () => {
    const next = navReducer(INITIAL_NAV, {type: 'openSearch', initialQuery: '배포'});
    expect(next.tab).toBe('search');
    expect(next.searchSeed).toEqual({initialQuery: '배포', seq: 1});
  });

  it('a second hand-over is a NEW seed, so the search screen is rebuilt with it', () => {
    const first = navReducer(INITIAL_NAV, {type: 'openSearch', initialQuery: '배포'});
    const away = navReducer(first, {type: 'selectTab', tab: 'home'});
    const second = navReducer(away, {type: 'openSearch', initialQuery: '장애'});
    expect(second.searchSeed).toEqual({initialQuery: '장애', seq: 2});
  });

  it('opening search without words keeps whatever the tab was holding', () => {
    const seeded = navReducer(INITIAL_NAV, {type: 'openSearch', initialQuery: '배포'});
    const away = navReducer(seeded, {type: 'selectTab', tab: 'inbox'});
    expect(navReducer(away, {type: 'openSearch'}).searchSeed).toEqual(
      seeded.searchSeed,
    );
  });

  it('a result opened from search comes back to the search tab', () => {
    const onSearch = navReducer(INITIAL_NAV, {type: 'openSearch', initialQuery: '배포'});
    const reading = navReducer(onSearch, {type: 'openConversation', conversation: OPEN});
    expect(navReducer(reading, {type: 'back'})).toEqual(onSearch);
  });
});

describe('the agent list — a layer opened from the FAB sheet (was the 에이전트 tab)', () => {
  const AGENT = {
    memberId: 'cccccccc-1111-4111-8111-cccccccccccc',
    displayName: '김인턴',
    handle: 'kim-intern',
  };

  it('opens over the current tab without changing it', () => {
    const next = navReducer(nav({tab: 'inbox'}), {type: 'openAgentList'});
    expect(next).toEqual(nav({tab: 'inbox', agentList: true}));
  });

  it('one agent opens over the list and peels back to it', () => {
    const list = navReducer(INITIAL_NAV, {type: 'openAgentList'});
    const one = navReducer(list, {type: 'openAgent', agent: AGENT});
    expect(one).toEqual(nav({agentList: true, agent: AGENT}));
    expect(navReducer(one, {type: 'back'})).toEqual(list);
    expect(navReducer(list, {type: 'back'})).toEqual(INITIAL_NAV);
  });

  it('작성자 프로필에서 에이전트를 열면 뒤에 가려질 대화층을 걷는다', () => {
    const next = navReducer(nav({conversation: OPEN}), {
      type: 'openAgent',
      agent: AGENT,
    });
    expect(next.conversation).toBeNull();
    expect(next.agent).toEqual(AGENT);
  });

  it('sits UNDER a conversation, so the DM comes back to the agent', () => {
    const open = nav({agentList: true, agent: AGENT});
    const withDm = navReducer(open, {type: 'openConversation', conversation: OPEN});
    expect(withDm.agent).toEqual(AGENT);
    const back = navReducer(withDm, {type: 'back'});
    expect(back).toEqual(open);
    expect(navReducer(back, {type: 'back'}).agent).toBeNull();
  });

  it('is closed by a tab tap, like everything else stacked over the tabs', () => {
    expect(
      navReducer(nav({agentList: true, agent: AGENT}), {
        type: 'selectTab',
        tab: 'home',
      }),
    ).toEqual(INITIAL_NAV);
  });

  it('opening the work list closes the agent list — two FAB doors do not stack', () => {
    const agents = navReducer(INITIAL_NAV, {type: 'openAgentList'});
    expect(navReducer(agents, {type: 'openWorkList'})).toEqual(nav({workList: true}));
  });
});

describe('one work session, over the work list (was the 작업 tab)', () => {
  const WORK = {sessionId: 'SESSION-1'};

  it('keeps the detail under the origin conversation it opens', () => {
    const onWork = navReducer(INITIAL_NAV, {type: 'openWorkList'});
    const detail = navReducer(onWork, {type: 'openWorkSession', workSession: WORK});
    expect(detail.workSession).toEqual(WORK);

    const conversation = navReducer(detail, {
      type: 'openConversation',
      conversation: OPEN,
    });
    expect(navReducer(conversation, {type: 'back'})).toEqual(detail);
    expect(navReducer(detail, {type: 'back'})).toEqual(onWork);
    expect(navReducer(onWork, {type: 'back'})).toEqual(INITIAL_NAV);
  });

  it('is cleared by a tab selection', () => {
    expect(
      navReducer(nav({workList: true, workSession: WORK}), {
        type: 'selectTab',
        tab: 'home',
      }),
    ).toEqual(INITIAL_NAV);
  });
});

describe('호스티드 연결, opened from the agent list (goal HAP-UX3)', () => {
  const CONNECTION: OpenHostedConnection = {
    connectionId: 'dddddddd-1111-4111-8111-dddddddddddd',
    agentMemberId: 'cccccccc-1111-4111-8111-cccccccccccc',
    title: '김인턴',
  };

  const onAgents = nav({agentList: true});

  it('opens the list over the agent list', () => {
    expect(navReducer(onAgents, {type: 'openHostedList'})).toEqual({
      ...onAgents,
      hosted: {kind: 'list'},
    });
  });

  it('is exclusive with 「one agent」 — opening the list closes an open agent', () => {
    const onAgent = nav({
      agentList: true,
      agent: {
        memberId: CONNECTION.agentMemberId,
        displayName: '김인턴',
        handle: 'kim-intern',
      },
    });
    expect(navReducer(onAgent, {type: 'openHostedList'})).toEqual({
      ...onAgents,
      hosted: {kind: 'list'},
    });
  });

  it('peels the detail back to the list, then the list, then the agent list', () => {
    const list = navReducer(onAgents, {type: 'openHostedList'});
    const detail = navReducer(list, {
      type: 'openHostedConnection',
      connection: CONNECTION,
    });
    expect(detail.hosted).toEqual({kind: 'detail', connection: CONNECTION});
    const backToList = navReducer(detail, {type: 'back'});
    expect(backToList.hosted).toEqual({kind: 'list'});
    const closed = navReducer(backToList, {type: 'back'});
    expect(closed).toEqual(onAgents);
    expect(navReducer(closed, {type: 'back'})).toEqual(INITIAL_NAV);
  });

  it('is cleared by a tab selection, list or detail', () => {
    const detail = navReducer(navReducer(onAgents, {type: 'openHostedList'}), {
      type: 'openHostedConnection',
      connection: CONNECTION,
    });
    expect(navReducer(detail, {type: 'selectTab', tab: 'home'})).toEqual(
      INITIAL_NAV,
    );
  });
});

describe('sign-out', () => {
  it('forgets where the previous person was', () => {
    const deep = nav({
      tab: 'search',
      conversation: OPEN,
      searchSeed: {initialQuery: '배포', seq: 3},
      agentList: true,
      agent: {
        memberId: 'cccccccc-1111-4111-8111-cccccccccccc',
        displayName: '김인턴',
        handle: 'kim-intern',
      },
    });
    expect(navReducer(deep, {type: 'reset'})).toEqual(INITIAL_NAV);
  });
});

describe('a notification is a new way in (#2569)', () => {
  const FROM_PUSH = {
    channelId: 'CH-9',
    title: '#배포',
    notification: {messageId: 'MSG-1', threadRootId: null, token: 1},
  };

  it('opens on 홈 with every other layer taken down', () => {
    // The person came from the lock screen, not from the agent they happened to
    // have open. Stacking the conversation over that layer would make 뒤로 land
    // somewhere they never walked through.
    const deep = nav({
      tab: 'search',
      conversation: OPEN,
      searchSeed: {initialQuery: '배포', seq: 1},
      agentList: true,
      agent: {
        memberId: 'cccccccc-1111-4111-8111-cccccccccccc',
        displayName: '김인턴',
        handle: 'kim-intern',
      },
      workList: true,
      workSession: {sessionId: 'ws-1'},
      hosted: {kind: 'list'},
    });
    expect(
      navReducer(deep, {type: 'openFromNotification', conversation: FROM_PUSH}),
    ).toEqual({
      ...deep,
      tab: 'home',
      conversation: FROM_PUSH,
      agentList: false,
      agent: null,
      workList: false,
      workSession: null,
      hosted: null,
    });
  });

  it('comes back to the conversation list in one step', () => {
    const opened = navReducer(nav({tab: 'inbox'}), {
      type: 'openFromNotification',
      conversation: FROM_PUSH,
    });
    expect(navReducer(opened, {type: 'back'})).toEqual(INITIAL_NAV);
  });
});

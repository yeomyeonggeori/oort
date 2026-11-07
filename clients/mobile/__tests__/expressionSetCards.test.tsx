import {act, screen, waitFor, within} from '@testing-library/react-native';
import {Dimensions} from 'react-native';
import {
  expressionSetCard,
  type ExpressionSetApproval,
} from '@momo/core/features/expressions/set';
import {
  FIXTURE_SET_APPROVAL_ID,
  FIXTURE_SET_NORMAL,
  FIXTURE_SET_REFUSED,
  FIXTURE_SET_STREAK_CLOSED,
  fixtureSetBytesHeavy,
  fixtureSetOverLimit,
} from '@momo/core/features/expressions/setFixtures';
import {recommendExpressionKind} from '@momo/core/features/expressions/kind';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {TOUCH_TARGET} from '../src/design/tokens';
import {
  GRID_COLUMNS,
  LARGE_TEXT_SCALE,
} from '../src/features/expressions/ExpressionSetApprovalCard';
import {
  BASE,
  answer,
  checked,
  disabled,
  flat,
  installSetCardsHarness,
  mount,
  NOW,
  post,
  press,
  registerLabel,
  sentBody,
  serve,
  setMessage,
  setReduceMotion,
  tile,
  unmountAll,
} from './fixtures/setCards';

// =============================================================================
// 이모티콘 세트 S4(폰, #5463): 세트 카드가 대화 줄의 **기존 행동 승인 카드 길**(`MessageRow` → `AgentCard`) 위에 선다.
// 서버 쪽은 코어 fixture 서버가 맡는다. 폰이 정하는 규칙은 없다: 칸 선택·종류 추천·한도는 코어(`set.ts`·`kind.ts`)가 말한 값을 시험이
// 코어 함수로 다시 계산해 대조한다. 바탕(저장소·대화 줄·결정 목)은 `fixtures/setCards.tsx` 이고 계획 카드 시험(`expressionPlanCard.test.tsx`)과 같다.
// =============================================================================

installSetCardsHarness();

describe('세트 카드: 줄 위에 서는 길과 격자 (L5)', () => {
  it('세트 승인을 일반 승인·거부 단추 없이 세트 카드로 그리고, 이름 열 개를 모두 보이고, 숫자를 한 번 말한다', async () => {
    await mount(FIXTURE_SET_NORMAL);
    expect(screen.getByTestId('expression-set')).toBeTruthy();
    // 일반 행동 승인의 컨트롤은 서지 않는다: 이 카드는 칸을 고른 채로만 결정된다.
    expect(screen.queryByTestId(`card-approval-${FIXTURE_SET_APPROVAL_ID}-approve`)).toBeNull();
    expect(screen.queryByTestId(`card-approval-${FIXTURE_SET_APPROVAL_ID}-reject`)).toBeNull();
    for (const slot of FIXTURE_SET_NORMAL.slots) {
      expect(screen.getByText(slot.displayName)).toBeTruthy();
      expect(checked(slot.index)).toBe(true);
    }
    expect(screen.getByTestId('expression-set-summary').props.children).toBe('그림 10개');
    expect(registerLabel()).toBe('10개 등록');
    expect(screen.getByText('에이전트가 쓴 설명: ' + FIXTURE_SET_NORMAL.prompt)).toBeTruthy();
    expect(screen.getByTestId('expression-set-rights')).toBeTruthy();
    // 참조 그림 두 장은 썸네일 줄과 장수로 나온다.
    expect(screen.getAllByTestId(/^expression-set-reference-\d$/)).toHaveLength(2);
    expect(screen.getByText('참고한 그림 2장')).toBeTruthy();
    // 모든 칸이 정지 썸네일이다: 움직이는 그림(GIF 둘)도 `thumb` 만 받는다. 큰 그림은 한 번도 받지 않는다.
    await waitFor(() => expect(screen.getAllByTestId('expression-set-picture')).toHaveLength(10));
  });

  it('칸을 빼고 다시 넣으면 등록 개수가 따라가고, 선택이 0 이면 등록이 꺼지며 거절은 늘 된다', async () => {
    await mount(FIXTURE_SET_NORMAL);
    await press('expression-set-tile-1');
    expect(checked(1)).toBe(false);
    expect(registerLabel()).toBe('9개 등록');
    await press('expression-set-tile-1');
    expect(checked(1)).toBe(true);
    expect(registerLabel()).toBe('10개 등록');
    await press('expression-set-select-all');
    expect(FIXTURE_SET_NORMAL.slots.every(slot => !checked(slot.index))).toBe(true);
    expect(disabled('expression-set-register')).toBe(true);
    expect(disabled('expression-set-decline')).toBe(false);
    await press('expression-set-select-all');
    expect(registerLabel()).toBe('10개 등록');
    expect(disabled('expression-set-register')).toBe(false);
  });

  it('고른 칸만 한 번의 결정으로 보내고, 서버가 등록한 숫자만 결과 줄로 말한다', async () => {
    const {server, settled, request} = await mount(FIXTURE_SET_NORMAL);
    serve(server);
    await press('expression-set-tile-2');
    await press('expression-set-tile-9');
    await press('expression-set-register');
    await waitFor(() => expect(screen.getByTestId('expression-set-settled')).toBeTruthy());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(`${BASE}/approvals/${FIXTURE_SET_APPROVAL_ID}/decision`);
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(['approval_id', 'approve', 'client_decision_id', 'expressionChoices']);
    expect(body.approve).toBe(true);
    const choices = body.expressionChoices as Array<{draftId: string; kind?: string}>;
    // 뺀 둘(2·9)은 없고, 나머지 여덟이 칸 순서대로 간다. 종류는 서버가 같은 규칙으로 정할 추천이다.
    expect(choices).toHaveLength(8);
    const kept = FIXTURE_SET_NORMAL.slots.filter(slot => slot.index !== 2 && slot.index !== 9);
    expect(choices.map(choice => choice.draftId)).toEqual(
      kept.map(slot => (slot.state === 'ready' ? slot.draftId : '')),
    );
    expect(choices.map(choice => choice.kind)).toEqual(
      kept.map(slot => (slot.state === 'ready' ? recommendExpressionKind(slot.media.large) : undefined)),
    );
    expect(screen.getByTestId('expression-set-settled').props.children).toBe('8개를 팀 보관함에 저장했어요');
    // 결과가 나온 카드에는 격자도 등록 단추도 없다. 화면의 영수증 표에는 승인으로 들어갔다.
    expect(screen.queryByTestId('expression-set-grid')).toBeNull();
    expect(screen.queryByTestId('expression-set-register')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0]).toBe(FIXTURE_SET_APPROVAL_ID);
    expect((settled.mock.calls[0][1] as DecisionOutcome).status).toBe('approved');
    // 등록이 끝나면 보관함 목록을 다시 읽는다.
    await waitFor(() => expect(request.mock.calls.some(call => call[0].method === 'GET' && call[0].path === `${BASE}/expressions`)).toBe(true));
  });

  it('종류는 고른 칸 전부에 한 번 정하고, 추천이 갈리는 동안에는 아무것도 고른 것으로 말하지 않는다', async () => {
    const {server} = await mount(FIXTURE_SET_NORMAL);
    serve(server);
    // 기본 세트의 1px 코어 픽스처는 정지 emoji 8 + GIF sticker 2 로 갈린다: 어느 쪽도 체크하지 않는다.
    const recommended = new Set(
      FIXTURE_SET_NORMAL.slots.map(slot => (slot.state === 'ready' ? recommendExpressionKind(slot.media.large) : null)),
    );
    expect(recommended.size).toBeGreaterThan(1);
    expect(screen.getByTestId('expression-set-kind-emoji').props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('expression-set-kind-sticker').props.accessibilityState.checked).toBe(false);
    await press('expression-set-kind-sticker');
    expect(screen.getByTestId('expression-set-kind-sticker').props.accessibilityState.checked).toBe(true);
    await press('expression-set-register');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const choices = sentBody().expressionChoices as Array<{kind?: string}>;
    expect(choices).toHaveLength(10);
    expect(new Set(choices.map(choice => choice.kind))).toEqual(new Set(['sticker']));
  });
});

describe('회색 칸: 같은 자리, 고를 것도 다시 할 것도 없다 (L7)', () => {
  it('네 사유가 각각 한 줄로 서고 누를 수 없으며, 올리기·다시 시도가 카드 어디에도 없고, 숫자 줄이 만들지 못한 장면 수를 센다', async () => {
    await mount(FIXTURE_SET_REFUSED);
    const grays = FIXTURE_SET_REFUSED.slots.filter(slot => slot.state === 'gray');
    expect(grays).toHaveLength(5);
    const reasons = new Map(grays.map(slot => [slot.index, slot.state === 'gray' ? slot.code : '']));
    expect([...new Set(reasons.values())].sort()).toEqual(['base_missing', 'failed', 'not_made', 'refused']);
    for (const slot of grays) {
      // 같은 크기의 자리: 격자 칸으로 서고(체크 상자가 아닌 글 한 덩어리), 읽는 쪽에는 「선택할 수 없는 칸, 사유. 표시 이름」이다.
      const node = tile(slot.index);
      expect(node.props.accessibilityState.disabled).toBe(true);
      expect(node.props.accessibilityRole).toBeUndefined();
      expect(node.props.accessibilityLabel).toMatch(/^선택할 수 없는 칸, .+\. /);
      expect(node.props.accessibilityLabel).toContain(slot.displayName);
    }
    expect(screen.getAllByText('이 장면은 그림 모델이 만들 수 없다고 했어요', {exact: false}).length).toBe(2);
    expect(screen.getByTestId('expression-set-summary').props.children).toBe('그림 5개 · 만들지 못한 장면 5개');
    // 눌러도 아무 일도 없다: 체크 상자도 없고, 등록 개수는 준비된 칸 수 그대로다.
    await press('expression-set-tile-2');
    expect(screen.queryByTestId('expression-set-check-2')).toBeNull();
    expect(registerLabel()).toBe('5개 등록');
    // 올리기·다시 시도·바꿔 올리기 낱말이 이 카드 어디에도 없다.
    const text = JSON.stringify(screen.toJSON());
    for (const word of ['다시 시도', '올리기', '다시 만들', '바꿔']) expect(text).not.toContain(word);
    // 연속 거절로 닫힌 세트의 회색 칸도 같은 모양이다.
    await unmountAll();
    await mount(FIXTURE_SET_STREAK_CLOSED);
    expect(screen.getByTestId('expression-set-summary').props.children).toContain('만들지 못한 장면 7개');
  });
});

describe('읽을 수 없는 묶음과 결정이 안 나갈 때', () => {
  it('한도를 넘은 묶음은 그리지 않고 읽지 못했다고만 말하며 안 할래요만 남긴다(41칸·24MiB 초과)', async () => {
    for (const heavy of [fixtureSetOverLimit(), fixtureSetBytesHeavy()]) {
      const {server} = await mount(heavy);
      expect(screen.getByTestId('expression-set-unreadable')).toBeTruthy();
      expect(screen.queryByTestId('expression-set-grid')).toBeNull();
      expect(screen.queryByTestId('expression-set-register')).toBeNull();
      serve(server);
      await press('expression-set-decline');
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(Object.keys(sentBody()).sort()).toEqual(['approval_id', 'approve', 'client_decision_id']);
      expect(sentBody().approve).toBe(false);
      await unmountAll();
      post.mockClear();
    }
  });

  it('닫힌 이유 셋마다 한 줄로 말하고 카드는 열린 채 같은 키로 다시 누를 수 있으며, 동시에 두 번 보내지 않는다', async () => {
    await mount(FIXTURE_SET_NORMAL);
    answer(409, {status: 'expression_preview_stale'});
    await press('expression-set-register');
    await waitFor(() => expect(screen.getByTestId('expression-set-error')).toBeTruthy());
    expect(screen.getByText('그림이 바뀌었어요. 카드를 새로 불러온 뒤 다시 골라 주세요.')).toBeTruthy();
    expect(disabled('expression-set-register')).toBe(false);
    // 영수증이 아닌 답: 같은 결정을 같은 키로 다시 보낸다. 두 번째 누름은 첫 요청이 나가 있는 동안 막힌다.
    let resolve: (value: unknown) => void = () => undefined;
    post.mockImplementationOnce((() => new Promise(done => { resolve = done; })) as never);
    await press('expression-set-register');
    await press('expression-set-register');
    await press('expression-set-decline');
    expect(post).toHaveBeenCalledTimes(2);
    expect(sentBody(0).client_decision_id).toBe(sentBody(1).client_decision_id);
    expect(registerLabel()).toBe('등록 중');
    await act(async () => {
      resolve({status: 500, json: () => ({}), jsonOrNull: () => ({}), text: '{}'});
    });
    await waitFor(() => expect(screen.getByText('결정하지 못했어요. 권한과 연결을 확인하고 다시 눌러 주세요.')).toBeTruthy());
  });

  it('다른 곳에서 이미 결정됐다는 답이면 카드를 닫고, 오프라인이면 컨트롤 대신 할 말을 서고 아무것도 보내지 않는다', async () => {
    const {settled} = await mount(FIXTURE_SET_NORMAL);
    answer(409, {status: 'approved'});
    await press('expression-set-register');
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect((settled.mock.calls[0][1] as DecisionOutcome).kind).toBe('superseded');
    expect(screen.getByTestId('expression-set-settled').props.children).toBe('처리가 끝난 요청이에요');
    await unmountAll();
    post.mockClear();
    await mount(FIXTURE_SET_NORMAL, {offline: true});
    expect(screen.getByTestId('expression-set-note')).toBeTruthy();
    expect(screen.queryByTestId('expression-set-register')).not.toBeNull();
    expect(disabled('expression-set-register')).toBe(true);
    expect(disabled('expression-set-decline')).toBe(true);
    await press('expression-set-tile-0');
    expect(checked(0)).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('폰 손맛: 누름 면·큰 글씨·동작 줄이기·읽는 이름', () => {
  it('칸·단추·종류 알약이 모두 누름 면 기준 이상이고, 칸은 「표시 이름, 이름」으로 읽히며 체크 상태를 말한다', async () => {
    await mount(FIXTURE_SET_NORMAL);
    const targets = [
      ...FIXTURE_SET_NORMAL.slots.map(slot => `expression-set-tile-${slot.index}`),
      'expression-set-register',
      'expression-set-decline',
      'expression-set-select-all',
      'expression-set-kind-emoji',
      'expression-set-kind-sticker',
    ];
    for (const id of targets) {
      const style = flat(screen.getByTestId(id).props.style);
      expect(Number(style.minHeight)).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    expect(tile(0).props.accessibilityRole).toBe('checkbox');
    expect(tile(0).props.accessibilityLabel).toBe('안녕, cat_hello');
    expect(tile(0).props.accessibilityState).toEqual({checked: true, disabled: false});
    await press('expression-set-tile-0');
    expect(tile(0).props.accessibilityState.checked).toBe(false);
  });

  it('큰 글씨에서는 격자가 두 칸씩으로 줄고 보통에서는 세 칸씩이다', async () => {
    expect(GRID_COLUMNS).toEqual({normal: 3, large: 2});
    const columnsInFirstRow = () =>
      within(screen.getByTestId('expression-set-row-0')).getAllByTestId(/^expression-set-tile-\d+$/).length;
    const rowCount = () => screen.getAllByTestId(/^expression-set-row-\d+$/).length;
    const window = Dimensions.get('window');
    const scaled = (fontScale: number) =>
      act(() => {
        Dimensions.set({window: {...window, fontScale}});
      });
    await scaled(1);
    await mount(FIXTURE_SET_NORMAL);
    expect(columnsInFirstRow()).toBe(GRID_COLUMNS.normal);
    expect(rowCount()).toBe(Math.ceil(10 / GRID_COLUMNS.normal));
    await unmountAll();
    await scaled(LARGE_TEXT_SCALE + 0.2);
    await mount(FIXTURE_SET_NORMAL);
    expect(columnsInFirstRow()).toBe(GRID_COLUMNS.large);
    expect(rowCount()).toBe(Math.ceil(10 / GRID_COLUMNS.large));
    await scaled(window.fontScale);
  });

  it('칸의 그림은 동작 줄이기 켜짐·꺼짐 모두 정지 썸네일만 받고, 보내는 중의 표시기는 꺼져 있을 때만 돈다', async () => {
    const {server, request} = await mount(FIXTURE_SET_NORMAL);
    serve(server);
    await waitFor(() => expect(screen.getAllByTestId('expression-set-picture')).toHaveLength(10));
    const images = request.mock.calls.map(call => call[0].path).filter(path => path.includes('/image?'));
    expect(images).toHaveLength(10);
    // 움직이는 그림 둘(GIF)도 `size=thumb` 이다: 큰 그림·GIF 본문은 이 카드가 받지 않는다.
    expect(images.every(path => path.includes('size=thumb'))).toBe(true);
    // 동작 줄이기 켜짐(이 파일의 기본): 보내는 동안 낱말만 남고 도는 표시기는 없다.
    let resolve: (value: unknown) => void = () => undefined;
    post.mockImplementationOnce((() => new Promise(done => { resolve = done; })) as never);
    await press('expression-set-register');
    expect(registerLabel()).toBe('등록 중');
    expect(screen.queryByTestId('expression-set-spinner')).toBeNull();
    await act(async () => {
      resolve({status: 500, json: () => ({}), jsonOrNull: () => ({}), text: '{}'});
    });
    await unmountAll();
    await setReduceMotion(false);
    await mount(FIXTURE_SET_NORMAL);
    post.mockImplementationOnce((() => new Promise(done => { resolve = done; })) as never);
    await press('expression-set-register');
    expect(screen.getByTestId('expression-set-spinner')).toBeTruthy();
    await act(async () => {
      resolve({status: 500, json: () => ({}), jsonOrNull: () => ({}), text: '{}'});
    });
  });
});

describe('끝난 카드와 다른 세트', () => {
  it('거절·만료는 격자 없이 그 사실을 한 줄로 말하고, 메시지가 이미 결과를 들고 있으면 그 숫자를 말한다', async () => {
    await mount(FIXTURE_SET_NORMAL, {message: setMessage(FIXTURE_SET_NORMAL, {status: 'rejected'})});
    expect(screen.getByTestId('expression-set-settled').props.children).toBe('저장하지 않았어요');
    expect(screen.queryByTestId('expression-set-grid')).toBeNull();
    await unmountAll();
    const executed = {status: 'executed', expressionSet: {setId: FIXTURE_SET_NORMAL.setId, registered: [{id: '00000000-0000-4000-8000-000000000501', name: 'cat_hello', token: ':cat_hello:'}], skipped: []}};
    await mount(FIXTURE_SET_NORMAL, {message: setMessage(FIXTURE_SET_NORMAL, {status: 'approved', result: executed})});
    expect(screen.getByTestId('expression-set-settled').props.children).toBe('1개를 팀 보관함에 저장했어요');
    await unmountAll();
    // 기한이 지난 세트 카드는 대기로 남아 있어도 열려 있지 않다.
    const late: ExpressionSetApproval = {...FIXTURE_SET_NORMAL, expiresAtMs: NOW - 1};
    expect(expressionSetCard(late, NOW).state).toBe('expired');
    await mount(late);
    expect(screen.getByTestId('expression-set-settled').props.children).toBe('승인을 기다리다 만료됐어요');
    expect(screen.queryByTestId('expression-set-register')).toBeNull();
  });

  it('다른 워크스페이스의 묶음과 보관함이 없는 화면에서는 읽지 못했다고만 말한다', async () => {
    await mount({...FIXTURE_SET_NORMAL, workspaceId: '00000000-0000-4000-8000-0000000009ff'});
    expect(screen.getByTestId('expression-set-unreadable')).toBeTruthy();
    expect(screen.queryByTestId('expression-set-grid')).toBeNull();
    await unmountAll();
    await mount(FIXTURE_SET_NORMAL, {store: null});
    expect(screen.getByTestId('expression-set-unreadable')).toBeTruthy();
  });
});

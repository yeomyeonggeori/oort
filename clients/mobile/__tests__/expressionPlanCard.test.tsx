import {act, fireEvent, screen, waitFor, within} from '@testing-library/react-native';
import {expressionSetReferenceNotice} from '@momo/core/features/expressions/set';
import {
  FIXTURE_SET_APPROVAL_ID,
  FIXTURE_SET_ID,
  FIXTURE_SET_PLAN_CARD,
  FIXTURE_SET_PLAN_CARD_ONE,
  FIXTURE_SET_PLAN_CARD_SEEN,
  FIXTURE_SET_PLAN_CARD_WORDS,
  FIXTURE_SET_REFERENCE_IDS,
  fixtureSetPlanCard,
} from '@momo/core/features/expressions/setFixtures';
import {FIXTURE_CHANNEL_ID} from '@momo/core/features/expressions/fixtures';
import {EXPRESSION_SET_COPY} from '@momo/core/features/expressions/setCopy';
import type {DecisionOutcome} from '@momo/core/features/timeline/approvalDecision';
import {TOUCH_TARGET} from '../src/design/tokens';
import {
  WS,
  answer,
  disabled,
  downloadedUrls,
  flat,
  installSetCardsHarness,
  mount,
  NOW,
  planMessage,
  post,
  press,
  sentBody,
  setMessage,
  settle,
} from './fixtures/setCards';
import {FIXTURE_SET_NORMAL} from '@momo/core/features/expressions/setFixtures';

// =============================================================================
// 이모티콘 세트 S4(폰, #5463): 계획 카드(ADR-0218 §12 L2.5·L19). 사람이 한 번 보는 카드이고, **「이대로 만들기」 전에는 이 화면이 보내는 요청이 0** 이다.
// 계획 카드는 fake 서버에 호스트가 없어(코어 `fixtureServer` 는 세트 카드만 안다) 영수증을 손으로 쓴다 — 웹 시험과 같다. 바탕은 `fixtures/setCards.tsx`.
// =============================================================================

installSetCardsHarness();

const planOf = (card = FIXTURE_SET_PLAN_CARD) => planMessage(card);
const accepted = () =>
  answer(200, {status: 'approved', approval_id: FIXTURE_SET_APPROVAL_ID});
const text = (testID: string) => screen.getByTestId(testID).props.children as string;
const present = (testID: string) => screen.queryByTestId(testID) !== null;
const attachmentUrl = (id: string) =>
  `https://fixture.invalid/v1/workspaces/${WS}/channels/${FIXTURE_CHANNEL_ID}/attachments/${id}/content`;
const BUTTONS = [
  'expression-plan-cancel',
  'expression-plan-revise',
  'expression-plan-confirm',
];

describe('계획 카드: 만들 것과 보낼 것을 만들기 전에 보인다 (L2.5)', () => {
  it('컨셉·장면 줄 열 개·만들 그림 수·버튼 셋을 보이고, 일반 승인·거부 단추는 세우지 않는다', async () => {
    await mount(null, {message: planOf()});
    expect(present('expression-plan')).toBe(true);
    expect(present(`card-approval-${FIXTURE_SET_APPROVAL_ID}-approve`)).toBe(false);
    expect(present(`card-approval-${FIXTURE_SET_APPROVAL_ID}-reject`)).toBe(false);
    expect(text('expression-plan-concept')).toBe(FIXTURE_SET_PLAN_CARD.prompt);
    // 정지는 장면 글, GIF 는 바탕과 움직임으로 한 줄씩 열 줄이다.
    expect(screen.getAllByTestId(/^expression-plan-scene-\d+$/)).toHaveLength(10);
    expect(screen.getByText(FIXTURE_SET_PLAN_CARD.slots[0].scene as string, {exact: false})).toBeTruthy();
    expect(screen.getByText('바탕: 안녕, 움직임: 통통', {exact: false})).toBeTruthy();
    expect(text('expression-plan-pictures')).toBe('만들 그림 10장');
    for (const id of BUTTONS) {
      expect(present(id)).toBe(true);
      expect(Number(flat(screen.getByTestId(id).props.style).minHeight)).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    // 읽는 이름: 제목은 머리말이고 세 단추는 글 그대로 읽힌다.
    expect(screen.getByText('고양이 세트 계획').props.accessibilityRole).toBe('header');
    expect(screen.getByTestId('expression-plan-confirm').props.accessibilityLabel).toBe('이대로 만들기');
    expect(post).not.toHaveBeenCalled();
  });

  it('멤버의 첫 참조 세트에서만 고지 두 줄이 서고(서버가 준 noticeDue), 썸네일·장수·얼굴 없음 선언은 참조가 있으면 매번 선다', async () => {
    await mount(null, {message: planOf()});
    // 코어가 말한 고지 문장 그대로다(사전 ko 와 같은 글자).
    expect(screen.getByText(expressionSetReferenceNotice())).toBeTruthy();
    expect(EXPRESSION_SET_COPY['expressions.set.reference.notice'].ko).toBe(expressionSetReferenceNotice());
    expect(screen.getByText(EXPRESSION_SET_COPY['expressions.set.reference.kept'].ko)).toBeTruthy();
    expect(screen.getAllByTestId(/^expression-set-reference-\d$/)).toHaveLength(2);
    expect(text('expression-plan-references-line')).toBe('보낼 참조 그림 2장');
    expect(text('expression-plan-declare')).toBe(EXPRESSION_SET_COPY['expressions.set.reference.declare'].ko);
    // 그림은 대화가 쓰는 첨부 길로만 열린다: 참조마다 `…/channels/{c}/attachments/{id}/content`.
    await waitFor(() => expect(downloadedUrls().sort()).toEqual(FIXTURE_SET_REFERENCE_IDS.map(attachmentUrl).sort()));
  });

  it('이미 본 멤버의 카드는 고지 없이, 글만의 세트는 참조·선언·고지가 모두 없이, 그림이 한 장이어도 셋이 다 선다', async () => {
    const seen = await mount(null, {message: planOf(FIXTURE_SET_PLAN_CARD_SEEN)});
    expect(present('expression-plan-notice')).toBe(false);
    expect(present('expression-plan-declare')).toBe(true);
    expect(screen.getAllByTestId(/^expression-set-reference-\d$/)).toHaveLength(2);
    seen.view.unmount();
    const words = await mount(null, {message: planOf(FIXTURE_SET_PLAN_CARD_WORDS)});
    for (const id of ['expression-plan-references', 'expression-plan-declare', 'expression-plan-notice']) expect(present(id)).toBe(false);
    expect(downloadedUrls()).toHaveLength(2);
    words.view.unmount();
    await mount(null, {message: planOf(FIXTURE_SET_PLAN_CARD_ONE)});
    expect(text('expression-plan-references-line')).toBe('보낼 참조 그림 1장');
    expect(present('expression-plan-declare')).toBe(true);
    expect(present('expression-plan-notice')).toBe(true);
  });
});

describe('버튼 셋: 첫 번째 전에는 아무것도 나가지 않는다', () => {
  it('보기·고치기 열기·닫기에는 요청이 0 이고, 오프라인에서는 그림 요청도 하지 않고 단추 셋을 막는다', async () => {
    const view = await mount(null, {message: planOf()});
    await press('expression-plan-revise');
    expect(present('expression-plan-edit')).toBe(true);
    await press('expression-plan-edit-back');
    expect(present('expression-plan-edit')).toBe(false);
    expect(post).not.toHaveBeenCalled();
    view.view.unmount();
    const downloaded = downloadedUrls().length;
    await mount(null, {message: planOf(), offline: true});
    expect(BUTTONS.every(id => disabled(id))).toBe(true);
    expect(present('expression-plan-note')).toBe(true);
    // 자리는 서고(썸네일 둘) 오프라인에서는 그림을 받으러 가지 않는다.
    expect(screen.getAllByTestId(/^expression-set-reference-\d$/)).toHaveLength(2);
    expect(downloadedUrls()).toHaveLength(downloaded);
    await press('expression-plan-confirm');
    expect(post).not.toHaveBeenCalled();
  });

  it('이대로 만들기는 승인 하나(아무것도 더 싣지 않음)로 나가고 시작했다고 말하며, 취소는 거절 하나로 나가고 닫혔다고 말한다', async () => {
    const settled = jest.fn();
    await mount(null, {message: planOf(), settled});
    accepted();
    await press('expression-plan-confirm');
    await waitFor(() => expect(text('expression-plan-settled')).toBe('만들기를 시작했어요'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(`/v1/workspaces/${WS}/approvals/${FIXTURE_SET_APPROVAL_ID}/decision`);
    expect(Object.keys(sentBody()).sort()).toEqual(['approval_id', 'approve', 'client_decision_id']);
    expect(sentBody().approve).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect((settled.mock.calls[0][1] as DecisionOutcome).status).toBe('approved');
    expect(BUTTONS.some(present)).toBe(false);
  });

  it('취소는 거절 하나로 나가고, 동시에 두 번 누르면 한 번만 나가며, 실패한 뒤에는 같은 키로 다시 누를 수 있다', async () => {
    await mount(null, {message: planOf()});
    answer(409, {status: 'expression_preview_stale'});
    await press('expression-plan-confirm');
    await waitFor(() => expect(present('expression-plan-error')).toBe(true));
    expect(screen.getByText('그림이 바뀌었어요. 카드를 새로 불러온 뒤 다시 골라 주세요.')).toBeTruthy();
    expect(disabled('expression-plan-confirm')).toBe(false);
    let release: (value: unknown) => void = () => undefined;
    post.mockImplementationOnce((() => new Promise(done => { release = done; })) as never);
    await press('expression-plan-confirm');
    await press('expression-plan-confirm');
    await press('expression-plan-cancel');
    expect(post).toHaveBeenCalledTimes(2);
    // 같은 결정은 같은 키라 서버가 첫 영수증을 돌려준다.
    expect(sentBody(0).client_decision_id).toBe(sentBody(1).client_decision_id);
    await act(async () => {
      release({status: 500, json: () => ({}), jsonOrNull: () => ({}), text: '{}'});
    });
    await waitFor(() => expect(disabled('expression-plan-confirm')).toBe(false));
    answer(200, {status: 'rejected', approval_id: FIXTURE_SET_APPROVAL_ID});
    await press('expression-plan-cancel');
    await waitFor(() => expect(text('expression-plan-settled')).toBe('이 계획은 닫혔어요'));
    expect(Object.keys(sentBody(2)).sort()).toEqual(['approval_id', 'approve', 'client_decision_id']);
    expect(sentBody(2).approve).toBe(false);
  });
});

describe('장면 고치기: 새 계획이고, 그림은 빼기만 된다 (L2.5)', () => {
  it('참조마다 빼기·장면마다 한 줄·정지마다 장면 글을 주고 그림을 더하는 길은 없으며, 고친 것만 새 계획 요청으로 보낸다', async () => {
    await mount(null, {message: planOf()});
    await press('expression-plan-revise');
    expect(screen.getAllByTestId(/^expression-set-reference-remove-\d$/)).toHaveLength(2);
    expect(screen.getAllByTestId(/^expression-plan-edit-slot-\d+$/)).toHaveLength(10);
    // 정지 여덟에는 고칠 장면 글이 있고, 움직이는 GIF 둘에는 없다. 일반 승인 단추도 파일 올리기도 없다.
    expect(screen.getAllByTestId(/^expression-plan-edit-scene-\d+$/)).toHaveLength(8);
    expect(present('expression-plan-confirm')).toBe(false);
    expect(JSON.stringify(screen.toJSON())).not.toContain('올리기');
    // 첫 그림을 빼고, 정지 0(GIF 8 이 이것을 움직인다)을 빼고, 정지 1 의 장면과 정지 2 의 이름을 고친다.
    await press('expression-set-reference-remove-1');
    expect(screen.getAllByTestId(/^expression-set-reference-\d$/)).toHaveLength(1);
    await press('expression-plan-edit-include-0');
    expect(screen.getByTestId('expression-plan-edit-include-8').props.accessibilityState).toEqual({checked: false, disabled: true});
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('expression-plan-edit-scene-1'), '  새 장면 글  ');
      fireEvent.changeText(screen.getByTestId('expression-plan-edit-name-2'), '미안해요');
    });
    answer(200, {status: 'rejected', approval_id: FIXTURE_SET_APPROVAL_ID});
    await press('expression-plan-edit-submit');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = sentBody();
    expect(body.approve).toBe(false);
    expect(body.planRevision).toEqual({
      setId: FIXTURE_SET_ID,
      removeSlots: [0, 8],
      removeReferences: [FIXTURE_SET_REFERENCE_IDS[0]],
      edits: [
        {index: 1, scene: '새 장면 글'},
        {index: 2, displayName: '미안해요'},
      ],
    });
  });

  it('칸이 하나도 안 남거나 이름이 비면 요청하지 않고, 그만두면 고치기 전 그대로 돌아온다', async () => {
    await mount(null, {message: planOf()});
    await press('expression-plan-revise');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('expression-plan-edit-name-3'), '   ');
    });
    expect(disabled('expression-plan-edit-submit')).toBe(true);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('expression-plan-edit-name-3'), '좋아요');
    });
    expect(disabled('expression-plan-edit-submit')).toBe(false);
    for (let index = 0; index < 8; index += 1) await press(`expression-plan-edit-include-${index}`);
    expect(disabled('expression-plan-edit-submit')).toBe(true);
    await press('expression-plan-edit-back');
    await press('expression-plan-revise');
    expect(screen.getByTestId('expression-plan-edit-name-3').props.value).toBe('좋아요');
    expect(screen.getByTestId('expression-plan-edit-include-0').props.accessibilityState.checked).toBe(true);
    expect(screen.getAllByTestId(/^expression-set-reference-\d$/)).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('더는 묻지 않는 카드와 읽을 수 없는 계획', () => {
  it('기한이 지나면 만료를, 서버가 계획을 고쳐 썼으면 그 상태를, 다른 곳의 결정은 그 결과를 말하고 단추는 없다', async () => {
    const late = await mount(null, {message: planOf(fixtureSetPlanCard({expiresAtMs: NOW - 1}))});
    expect(text('expression-plan-settled')).toBe('승인을 기다리다 만료됐어요');
    expect(BUTTONS.some(present)).toBe(false);
    late.view.unmount();
    const confirmed = await mount(null, {message: planOf(fixtureSetPlanCard({state: 'confirmed'}))});
    expect(text('expression-plan-settled')).toBe('만들기를 시작했어요');
    confirmed.view.unmount();
    const cancelled = await mount(null, {message: planOf(fixtureSetPlanCard({state: 'cancelled'}))});
    expect(text('expression-plan-settled')).toBe('이 계획은 닫혔어요');
    cancelled.view.unmount();
    await mount(null, {message: planMessage(FIXTURE_SET_PLAN_CARD, {status: 'rejected'})});
    expect(text('expression-plan-settled')).toBe('이 계획은 닫혔어요');
  });

  it('읽을 수 없는 계획과 다른 워크스페이스의 계획은 그리지 않고, 취소만 남긴다', async () => {
    const broken = await mount(null, {message: planMessage({...FIXTURE_SET_PLAN_CARD, slots: []})});
    expect(present('expression-plan-unreadable')).toBe(true);
    expect(present('expression-plan-scenes')).toBe(false);
    expect(present('expression-plan-confirm')).toBe(false);
    answer(200, {status: 'rejected', approval_id: FIXTURE_SET_APPROVAL_ID});
    await press('expression-plan-cancel');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentBody().approve).toBe(false);
    broken.view.unmount();
    await mount(null, {message: planOf(fixtureSetPlanCard({workspaceId: '00000000-0000-4000-8000-0000000009ff'}))});
    expect(present('expression-plan-unreadable')).toBe(true);
    expect(present('expression-plan-scenes')).toBe(false);
  });
});

describe('행의 로터: 두 카드에는 일반 「승인」·「거부」를 세우지 않는다', () => {
  it('세트 카드·계획 카드의 행은 승인·거부 동작을 내놓지 않고, 같은 길의 다른 행동 승인은 그대로 낸다', async () => {
    const names = () =>
      ((screen.getByTestId('message-row').props.accessibilityActions ?? []) as Array<{name: string}>).map(action => action.name);
    const control = await mount(null, {message: setMessage(null, {action: 'invite.create'})});
    expect(names()).toEqual(expect.arrayContaining(['momoApprove']));
    control.view.unmount();
    const plan = await mount(null, {message: planOf()});
    expect(names().some(name => /Approve|Reject/.test(name))).toBe(false);
    plan.view.unmount();
    await mount(FIXTURE_SET_NORMAL);
    expect(names().some(name => /Approve|Reject/.test(name))).toBe(false);
    await settle();
    expect(within(screen.getByTestId('expression-set')).queryByText('승인')).toBeNull();
  });
});

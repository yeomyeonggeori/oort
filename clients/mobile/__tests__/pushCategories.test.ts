import * as Notifications from 'expo-notifications';

import {
  PUSH_CATEGORY_ACTIONS,
  registerPushCategories,
} from '../src/push/categories';
import {PUSH_ACTION, PUSH_CATEGORY} from '../src/push/contract';

// =============================================================================
// 카테고리마다 어떤 버튼이 달리는가 (goal RN-N1, ADR-0204 D7).
//
// iOS 는 알림이 **도착하는 때** 등록된 카테고리로 `aps.category` 를 풀어 버튼을 단다.
// 등록되지 않은 카테고리의 알림은 버튼 없이 뜬다 — 조용한 실패다. 그래서 계약에 있는
// 카테고리가 전부 등록되는지부터 잰다.
//
// 이 파일이 지키는 두 가지는 보안 쪽이다.
//   · 승인·거절 두 버튼은 Face ID/암호 뒤에서만 눌린다(`isAuthenticationRequired`).
//     옵션이 빠져도 버튼은 똑같이 동작하고, 그저 묻지 않게 된다 — 눈에 안 보이는 후퇴다.
//   · 잠금 화면이 결정하면 안 되는 승인(`momo.approval.open`)에는 승인·거절이 **없다.**
//   버튼 하나 「열어서 결정」은 인증을 거친 뒤 앱을 연다.
// =============================================================================

type Action = Notifications.NotificationAction;

function actionsOf(category: string): Action[] {
  const entry = PUSH_CATEGORY_ACTIONS.find(([id]) => id === category);
  if (!entry) throw new Error(`category ${category} is not registered`);
  return entry[1];
}

function identifiers(category: string): string[] {
  return actionsOf(category).map(action => action.identifier);
}

describe('모든 카테고리가 등록된다', () => {
  it('계약의 카테고리 여섯 개가 한 번씩, 그 밖에는 없다', () => {
    const registered = PUSH_CATEGORY_ACTIONS.map(([id]) => id);
    expect([...registered].sort()).toEqual(Object.values(PUSH_CATEGORY).sort());
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered).toHaveLength(6);
  });

  it('시스템에도 여섯 개 모두 등록한다', async () => {
    const register = jest.mocked(Notifications.setNotificationCategoryAsync);
    register.mockClear();

    await registerPushCategories();

    expect(register.mock.calls.map(([id]) => id).sort()).toEqual(
      Object.values(PUSH_CATEGORY).sort(),
    );
  });
});

describe('인라인 승인 — 잠금 화면에서 승인·거절', () => {
  it('승인과 거절 두 버튼이고, 둘 다 인증을 요구하며 앱을 열지 않는다', () => {
    const actions = actionsOf(PUSH_CATEGORY.approval);
    expect(actions.map(action => action.identifier)).toEqual([
      PUSH_ACTION.approve,
      PUSH_ACTION.reject,
    ]);
    for (const action of actions) {
      expect(action.options).toMatchObject({
        isAuthenticationRequired: true,
        opensAppToForeground: false,
      });
    }
  });
});

describe('버튼 낱말 (D2: 앱 안 승인 UI와 같은 「거부」)', () => {
  it('인라인 승인의 두 버튼은 「승인」·「거부」다 — 「거절」이 아니다', () => {
    expect(actionsOf(PUSH_CATEGORY.approval).map(action => action.buttonTitle)).toEqual(['승인', '거부']);
  });
});

describe('열어서 결정하는 승인 — 잠금 화면은 결정하지 않는다 (ADR-0204 D7)', () => {
  it('버튼은 「열어서 결정」 하나다', () => {
    const actions = actionsOf(PUSH_CATEGORY.approvalOpen);
    expect(actions).toHaveLength(1);
    expect(actions[0].identifier).toBe(PUSH_ACTION.openApproval);
    expect(actions[0].buttonTitle).toBe('열어서 결정');
  });

  it('인증을 거친 뒤 앱을 연다 — 앞으로 불러 카드를 보여 주는 것이 이 버튼의 전부다', () => {
    const [action] = actionsOf(PUSH_CATEGORY.approvalOpen);
    expect(action.options).toMatchObject({
      isAuthenticationRequired: true,
      opensAppToForeground: true,
    });
  });

  it('승인도 거절도 없다', () => {
    const ids = identifiers(PUSH_CATEGORY.approvalOpen);
    expect(ids).not.toContain(PUSH_ACTION.approve);
    expect(ids).not.toContain(PUSH_ACTION.reject);
  });
});

describe('다른 카테고리의 버튼', () => {
  it('승인·거절은 인라인 승인에만 있다', () => {
    for (const [category, actions] of PUSH_CATEGORY_ACTIONS) {
      const ids = actions.map(action => action.identifier);
      const decides =
        ids.includes(PUSH_ACTION.approve) || ids.includes(PUSH_ACTION.reject);
      expect(decides).toBe(category === PUSH_CATEGORY.approval);
    }
  });

  it('메시지와 멘션은 답장, 작업은 버튼이 없다', () => {
    expect(identifiers(PUSH_CATEGORY.message)).toEqual([PUSH_ACTION.quickReply]);
    expect(identifiers(PUSH_CATEGORY.mention)).toEqual([PUSH_ACTION.quickReply]);
    expect(actionsOf(PUSH_CATEGORY.work)).toEqual([]);
  });

  it('시스템 알림(시험 알림)은 버튼이 없다 — 답할 것도 결정할 것도 없다 (ADR-0206 D14·D15)', () => {
    expect(actionsOf(PUSH_CATEGORY.system)).toEqual([]);
  });

  it('앱을 여는 버튼은 「열어서 결정」 하나뿐이다', () => {
    const opening = PUSH_CATEGORY_ACTIONS.flatMap(([category, actions]) =>
      actions
        .filter(action => action.options?.opensAppToForeground === true)
        .map(action => `${category}:${action.identifier}`),
    );
    expect(opening).toEqual([
      `${PUSH_CATEGORY.approvalOpen}:${PUSH_ACTION.openApproval}`,
    ]);
  });
});

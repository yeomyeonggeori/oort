import {ApiError, type Member, type RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  fetchTeamAiLimitsBag,
  saveTeamAiLimits,
  type TeamAiLimitsStatus,
} from '@momo/core/features/settings/teamAiLimits';
import {catalog as ko} from '@momo/core/i18n/generated/ko-KR';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {AI_LIMITS_PAGE, TeamAiLimitsSettingsPage} from '../src/features/profile/TeamAiLimitsSettings';
import {SettingsPage} from '../src/features/profile/SettingsPage';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {createMessageCopy} from './testkit';

// =============================================================================
// #5026 (#4944의 화면 몫, ADR-0201 증보 v3 B9): 설정 › 관리자 설정 › 사용 한도 (폰).
// 웹과 같은 판단·같은 문장이다. 기본은 제한 없음, 소유자·관리자만 보고 바꾸며, 끄기는 null · 0은 보내지 않고
// 운영자 천장은 입력 상한이다.
// =============================================================================

jest.mock('@momo/core/features/settings/teamAiLimits', () => ({
  ...jest.requireActual('@momo/core/features/settings/teamAiLimits'),
  fetchTeamAiLimitsBag: jest.fn(),
  saveTeamAiLimits: jest.fn(),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HOUR = 3_600_000;
const copy = createMessageCopy({messageLocale: 'ko-KR', catalog: ko});
const fetchBag = jest.mocked(fetchTeamAiLimitsBag);
const saveLimits = jest.mocked(saveTeamAiLimits);

/** 서버 `limits_status_in_tx` 의 모양(openapi `TeamAiLimitsStatus`). 시험마다 한 조각만 바꾼다. */
function status(over: Partial<TeamAiLimitsStatus> = {}): TeamAiLimitsStatus {
  return {
    limits: {dailyTokens: null, dailySearches: null, monthlyUsd: null},
    effective: {dailyTokens: null, dailySearches: null},
    operatorCeiling: {dailyTokens: null, dailySearches: null, helperOff: false, searchOff: false},
    usage: {
      todayTokens: 124_000,
      todaySearches: 3,
      monthCostMicroUsd: 12_500_000,
      monthRuns: 40,
      monthUnpricedRuns: 0,
      monthEstimatedRuns: 0,
    },
    monthlyUsdAvailable: true,
    monthlyUsdUnavailableReason: null,
    dayResetsAtMs: Date.now() + 3 * HOUR,
    monthResetsAtMs: Date.now() + 100 * HOUR,
    ...over,
  };
}

/** 가방 + 계산된 읽기. 한도를 안 켠 가방은 `team_ai_limits` 키가 없다. */
function bagOf(s: TeamAiLimitsStatus) {
  const limits: Record<string, number> = {};
  if (s.limits.dailyTokens !== null) limits.dailyTokens = s.limits.dailyTokens;
  if (s.limits.dailySearches !== null) limits.dailySearches = s.limits.dailySearches;
  if (s.limits.monthlyUsd !== null) limits.monthlyUsd = s.limits.monthlyUsd;
  return {
    ...(Object.keys(limits).length > 0 ? {team_ai_limits: limits} : {}),
    team_ai_limits_status: s,
  };
}

const ON = status({
  limits: {dailyTokens: 500_000, dailySearches: null, monthlyUsd: 20},
  effective: {dailyTokens: 200_000, dailySearches: null},
  operatorCeiling: {dailyTokens: 200_000, dailySearches: null, helperOff: false, searchOff: false},
});

let client: QueryClient;

function mountPage() {
  client = new QueryClient({
    // 쓰기의 gcTime 기본은 5분이라 그 타이머가 시험 프로세스를 붙든다: 둘 다 0 으로 둔다.
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <TeamAiLimitsSettingsPage workspaceId={WS} onBack={() => {}} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const idOf = (field: string, part: string) => `team-ai-limit-${field}-${part}`;
const toggle = (field: string) => screen.getByTestId(idOf(field, 'toggle'));
const isOn = (field: string) => toggle(field).props.accessibilityState.checked === true;
const isDisabled = (field: string) => toggle(field).props.accessibilityState.disabled === true;
const input = (field: string) => screen.queryByTestId(idOf(field, 'input'));
const text = (testID: string) => {
  const node = screen.queryByTestId(testID);
  return node === null ? null : [node.props.children].flat().join('');
};

async function ready() {
  await screen.findByTestId('team-ai-limit-dailyTokens-card');
}

beforeEach(() => {
  fetchBag.mockReset();
  saveLimits.mockReset();
});
afterEach(async () => {
  // 쿼리 알림은 한 턴 뒤에 도착한다: act 안에서 비운 뒤 내린다(act 경고와 남는 타이머를 막는다).
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  cleanup();
  client?.clear();
});

describe('사용 한도 장: 기본은 제한 없음', () => {
  it('한도를 안 켠 기본: 세 행이 모두 꺼져 있고 입력칸이 없으며 쓴 양만 말한다', async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    mountPage();
    await ready();
    for (const field of ['dailyTokens', 'dailySearches', 'monthlyUsd']) {
      expect(isOn(field)).toBe(false);
      expect(input(field)).toBeNull();
    }
    expect(screen.getByText(copy('settings.aiLimits.description'))).toBeTruthy();
    expect(text(idOf('dailyTokens', 'detail'))).toBe(copy('settings.aiLimits.tokensToday', {used: 124_000}));
    expect(text(idOf('dailySearches', 'detail'))).toBe(copy('settings.aiLimits.searchesToday', {used: 3}));
    // 한도가 없으니 비율도 초기화 시각도 없다.
    expect(screen.queryByTestId(idOf('dailyTokens', 'headline'))).toBeNull();
    expect(screen.queryByTestId(idOf('dailyTokens', 'resets'))).toBeNull();
    expect(screen.getByText(copy('settings.aiLimits.pricingNote'))).toBeTruthy();
  });

  it('켠 한도: 값·실효 한도 기준의 사용 비율·초기화 시각·운영자 천장 안내를 보인다', async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    mountPage();
    await ready();
    expect(isOn('dailyTokens')).toBe(true);
    expect(input('dailyTokens')?.props.value).toBe('500000');
    // 62%는 관리자 값(500,000)이 아니라 천장까지 따진 실효 한도(200,000)로 잰다.
    expect(text(idOf('dailyTokens', 'headline'))).toBe(copy('settings.aiLimits.usageToday', {percent: 62}));
    expect(text(idOf('dailyTokens', 'detail'))).toBe(
      copy('settings.aiLimits.tokensOfLimit', {used: 124_000, limit: 200_000}),
    );
    expect(text(idOf('dailyTokens', 'resets'))).toMatch(/새로 시작해요$/);
    expect(screen.getByText(copy('settings.aiLimits.ceilingTokens', {limit: 200_000}))).toBeTruthy();
    expect(text(idOf('monthlyUsd', 'headline'))).toBe(copy('settings.aiLimits.usageMonth', {percent: 62}));
  });
});

describe('저장 요청의 모양', () => {
  it('켜기는 값을 적고 저장해야 서버에 가고, 그 한도 하나만 이름을 댄다', async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    mountPage();
    await ready();
    fireEvent.press(toggle('dailyTokens'));
    // 켜기만으로는 아무것도 저장하지 않는다.
    expect(saveLimits).not.toHaveBeenCalled();
    expect(input('dailyTokens')).not.toBeNull();
    saveLimits.mockResolvedValueOnce(
      bagOf(status({limits: {dailyTokens: 100_000, dailySearches: null, monthlyUsd: null}})),
    );
    fireEvent.changeText(input('dailyTokens') as never, '100,000');
    fireEvent.press(screen.getByTestId(idOf('dailyTokens', 'save')));
    await waitFor(() => expect(saveLimits).toHaveBeenCalledTimes(1));
    expect(saveLimits).toHaveBeenCalledWith(WS, {dailyTokens: 100_000});
    await waitFor(() => expect(text(idOf('dailyTokens', 'status'))).toBe(copy('settings.aiLimits.saved')));
    expect(isOn('dailyTokens')).toBe(true);
    expect(input('dailyTokens')?.props.value).toBe('100000');
    // 다른 한도는 그대로 꺼져 있다.
    expect(isOn('dailySearches')).toBe(false);
  });

  it('끄기는 0이 아니라 null 하나다', async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    saveLimits.mockResolvedValueOnce(
      bagOf({...ON, limits: {dailyTokens: null, dailySearches: null, monthlyUsd: 20}}),
    );
    mountPage();
    await ready();
    fireEvent.press(toggle('dailyTokens'));
    await waitFor(() => expect(saveLimits).toHaveBeenCalledTimes(1));
    expect(saveLimits).toHaveBeenCalledWith(WS, {dailyTokens: null});
    expect(Object.values(saveLimits.mock.calls[0][1] as Record<string, unknown>)).not.toContain(0);
    await waitFor(() => expect(isOn('dailyTokens')).toBe(false));
    expect(text(idOf('dailyTokens', 'status'))).toBe(copy('settings.aiLimits.cleared'));
  });

  it('끄는 동안에는 누른 값(꺼짐)을 보이고, 실패하면 켜진 채로 돌아와 이유를 말한다', async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    mountPage();
    await ready();
    let fail: (error: Error) => void = () => {};
    saveLimits.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.press(toggle('dailyTokens'));
    // 응답 전: 스위치는 이미 꺼져 있고 입력칸은 접혔으며 다른 행은 잠겼다. 되돌아 튀는 스위치는 고장 난 것처럼 보인다.
    await waitFor(() => expect(isOn('dailyTokens')).toBe(false));
    expect(input('dailyTokens')).toBeNull();
    expect(isDisabled('dailySearches')).toBe(true);
    await act(async () => {
      fail(new ApiError(500, 'boom'));
    });
    // 실패: 저장된 값은 그대로라 켜진 채로 돌아오고, 입력은 저장된 값이며, 이유를 말한다.
    await waitFor(() => expect(isOn('dailyTokens')).toBe(true));
    expect(input('dailyTokens')?.props.value).toBe('500000');
    expect(text(idOf('dailyTokens', 'error'))).toBe(copy('settings.aiLimits.saveFailed'));
  });

  it('0을 적으면 보내지 않고 이유를 말한다', async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    mountPage();
    await ready();
    fireEvent.press(toggle('dailyTokens'));
    fireEvent.changeText(input('dailyTokens') as never, '0');
    fireEvent.press(screen.getByTestId(idOf('dailyTokens', 'save')));
    expect(saveLimits).not.toHaveBeenCalled();
    expect(text(idOf('dailyTokens', 'error'))).toBe(copy('settings.aiLimits.errorZero'));
    // 금액도 같다: 0.0 은 0이다.
    fireEvent.press(toggle('monthlyUsd'));
    fireEvent.changeText(input('monthlyUsd') as never, '0.0');
    fireEvent.press(screen.getByTestId(idOf('monthlyUsd', 'save')));
    expect(saveLimits).not.toHaveBeenCalled();
    // 글자를 고치면 오류가 사라진다.
    fireEvent.changeText(input('dailyTokens') as never, '5');
    expect(screen.queryByTestId(idOf('dailyTokens', 'error'))).toBeNull();
  });
});

describe('운영자: 천장은 입력 상한이고, 끄면 입력을 막는다', () => {
  const CEILING = status({
    effective: {dailyTokens: 200_000, dailySearches: null},
    operatorCeiling: {dailyTokens: 200_000, dailySearches: null, helperOff: false, searchOff: false},
  });

  it('천장을 넘는 값은 보내지 않고, 천장 그대로는 보낸다', async () => {
    fetchBag.mockResolvedValue(bagOf(CEILING));
    mountPage();
    await ready();
    expect(screen.getByText(copy('settings.aiLimits.ceilingTokens', {limit: 200_000}))).toBeTruthy();
    fireEvent.press(toggle('dailyTokens'));
    fireEvent.changeText(input('dailyTokens') as never, '200001');
    fireEvent.press(screen.getByTestId(idOf('dailyTokens', 'save')));
    expect(saveLimits).not.toHaveBeenCalled();
    expect(text(idOf('dailyTokens', 'error'))).toBe(copy('settings.aiLimits.errorOverCeiling', {max: 200_000}));
    saveLimits.mockResolvedValueOnce(
      bagOf({...CEILING, limits: {dailyTokens: 200_000, dailySearches: null, monthlyUsd: null}}),
    );
    fireEvent.changeText(input('dailyTokens') as never, '200000');
    fireEvent.press(screen.getByTestId(idOf('dailyTokens', 'save')));
    await waitFor(() => expect(saveLimits).toHaveBeenCalledWith(WS, {dailyTokens: 200_000}));
  });

  it('운영자가 팀 AI를 멈췄으면 안내 한 줄이 서고 모든 스위치와 입력이 잠긴다', async () => {
    const off = status({
      limits: {dailyTokens: 100_000, dailySearches: null, monthlyUsd: null},
      effective: {dailyTokens: 0, dailySearches: null},
      operatorCeiling: {dailyTokens: null, dailySearches: null, helperOff: true, searchOff: false},
    });
    fetchBag.mockResolvedValue(bagOf(off));
    mountPage();
    await ready();
    expect(text('team-ai-limits-operator-off')).toBe(copy('settings.aiLimits.operatorOff'));
    for (const field of ['dailyTokens', 'dailySearches', 'monthlyUsd']) {
      expect(isDisabled(field)).toBe(true);
    }
    expect(input('dailyTokens')?.props.editable).toBe(false);
    fireEvent.press(toggle('dailyTokens'));
    expect(saveLimits).not.toHaveBeenCalled();
  });
});

describe('금액 한도', () => {
  it('단가를 모르는 모델이면 스위치가 잠기고 까닭을 말하며, 토큰 한도는 그대로 켤 수 있다', async () => {
    fetchBag.mockResolvedValue(
      bagOf(status({monthlyUsdAvailable: false, monthlyUsdUnavailableReason: 'model_unpriced'})),
    );
    mountPage();
    await ready();
    expect(isDisabled('monthlyUsd')).toBe(true);
    expect(screen.getByText(copy('settings.aiLimits.usdModelUnpriced'))).toBeTruthy();
    expect(isDisabled('dailyTokens')).toBe(false);
  });

  it('도우미가 아직 답한 적이 없으면 스위치가 잠기고 그렇게 말한다', async () => {
    fetchBag.mockResolvedValue(
      bagOf(status({monthlyUsdAvailable: false, monthlyUsdUnavailableReason: 'no_usage_yet'})),
    );
    mountPage();
    await ready();
    expect(isDisabled('monthlyUsd')).toBe(true);
    expect(screen.getByText(copy('settings.aiLimits.usdNoUsageYet'))).toBeTruthy();
  });

  it('추정이 섞인 금액은 「약 … 이상」이고 단가 없는 실행 수를 말한다', async () => {
    fetchBag.mockResolvedValue(
      bagOf(
        status({
          limits: {dailyTokens: null, dailySearches: null, monthlyUsd: 20},
          usage: {...status().usage, monthEstimatedRuns: 1, monthUnpricedRuns: 2},
        }),
      ),
    );
    mountPage();
    await ready();
    expect(text(idOf('monthlyUsd', 'detail'))).toMatch(/^약 .*12\.50 이상 \/ .*20\.00$/);
    expect(screen.getByText(copy('settings.aiLimits.usdUnpricedRuns', {count: 2}))).toBeTruthy();
  });

  it('켤 수 없다는 400 답은 금액 한도를 못 켠다고 말하고 다시 읽는다', async () => {
    fetchBag.mockResolvedValueOnce(bagOf(status()));
    mountPage();
    await ready();
    fireEvent.press(toggle('monthlyUsd'));
    fireEvent.changeText(input('monthlyUsd') as never, '20');
    saveLimits.mockRejectedValueOnce(new ApiError(400, 'no price', 'team_ai_usd_limit_unavailable'));
    fetchBag.mockResolvedValue(
      bagOf(status({monthlyUsdAvailable: false, monthlyUsdUnavailableReason: 'model_unpriced'})),
    );
    fireEvent.press(screen.getByTestId(idOf('monthlyUsd', 'save')));
    await waitFor(() => expect(isDisabled('monthlyUsd')).toBe(true));
    // 쓰던 초안은 접히고, 스위치는 꺼진 채 잠기며, 까닭과 실패를 말한다.
    expect(input('monthlyUsd')).toBeNull();
    expect(isOn('monthlyUsd')).toBe(false);
    expect(text(idOf('monthlyUsd', 'error'))).toBe(copy('settings.aiLimits.usdUnavailableNow'));
    expect(screen.getByText(copy('settings.aiLimits.usdModelUnpriced'))).toBeTruthy();
  });
});

describe('저장 실패·읽기 실패', () => {
  it('저장 실패는 서버 문장이 아니라 사전의 한 문장이고 입력은 남는다', async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    mountPage();
    await ready();
    fireEvent.press(toggle('dailySearches'));
    fireEvent.changeText(input('dailySearches') as never, '50');
    saveLimits.mockRejectedValueOnce(new ApiError(500, 'internal detail'));
    fireEvent.press(screen.getByTestId(idOf('dailySearches', 'save')));
    await waitFor(() => expect(text(idOf('dailySearches', 'error'))).toBe(copy('settings.aiLimits.saveFailed')));
    expect(screen.queryByText(/internal detail/)).toBeNull();
    expect(input('dailySearches')?.props.value).toBe('50');
    saveLimits.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    fireEvent.press(screen.getByTestId(idOf('dailySearches', 'save')));
    await waitFor(() => expect(text(idOf('dailySearches', 'error'))).toBe(copy('settings.aiLimits.saveForbidden')));
  });

  it('읽기에 실패하면 말하고 다시 시도 길을 둔다', async () => {
    fetchBag.mockRejectedValueOnce(new ApiError(500, 'boom'));
    mountPage();
    await screen.findByTestId('team-ai-limits-load-error');
    expect(screen.getByText(copy('settings.aiLimits.loadFailed'))).toBeTruthy();
    fetchBag.mockResolvedValueOnce(bagOf(status()));
    fireEvent.press(screen.getByRole('button', {name: copy('settings.aiLimits.retry')}));
    await ready();
  });
});

describe('이 장은 확인된 뒤에만 한도를 보인다', () => {
  it('소유자·관리자가 아니면(403) 한도 행을 하나도 그리지 않고 그렇다고 말한다', async () => {
    fetchBag.mockRejectedValue(new ApiError(403, 'forbidden'));
    mountPage();
    await screen.findByTestId('team-ai-limits-denied');
    expect(screen.getByText(copy('settings.aiLimits.notAdmin'))).toBeTruthy();
    expect(screen.queryByTestId('team-ai-limit-dailyTokens-card')).toBeNull();
    expect(screen.queryByTestId(idOf('dailyTokens', 'toggle'))).toBeNull();
  });

  it('한도 읽기를 모르는 서버(계산된 읽기 없음)에서는 한도 행을 그리지 않고 그렇다고 말한다', async () => {
    fetchBag.mockResolvedValue({team_ai_fast_path: true});
    mountPage();
    await screen.findByTestId('team-ai-limits-unsupported');
    expect(screen.queryByTestId('team-ai-limit-dailyTokens-card')).toBeNull();
  });

  it('일부 조각이 깨진 읽기는 일부만 믿고 그리지 않는다', async () => {
    const broken = bagOf(status());
    (broken.team_ai_limits_status.usage as unknown as Record<string, unknown>).todayTokens = '많이';
    fetchBag.mockResolvedValue(broken);
    mountPage();
    await screen.findByTestId('team-ai-limits-unsupported');
    expect(screen.queryByTestId('team-ai-limit-dailyTokens-card')).toBeNull();
  });
});

// 설정 페이지의 「관리자 설정」 카드: 소유자·관리자에게만 행이 선다. 그 뒤의 나머지 훅(푸시·기억·명령줄 연결)은
// 이 시험의 주제가 아니라서 모르는 요청은 404 로 답한다.
describe('설정 페이지의 「관리자 설정」 카드', () => {
  const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '이도현', handle: 'dohyun'};
  const roster = (role?: string) =>
    makeDirectory([
      {
        id: SELF_ID,
        workspaceId: WS,
        kind: 'human',
        status: 'active',
        displayName: '이도현',
        handle: 'dohyun',
        channelCount: 0,
        channelIds: [],
        capabilities: [],
        createdAtMs: 0,
        updatedAtMs: 0,
        ...(role === undefined ? {} : {role}),
      } as unknown as RosterMember,
    ]);

  // 움직임이 주제가 아니다: 층이 누르는 즉시 걷히도록 동작 줄이기를 켠 채 돈다(`settingsPage.test.tsx` 와 같다).
  let releaseMotion: (() => void) | null = null;
  beforeEach(async () => {
    releaseMotion = await pinReduceMotion(true);
    globalThis.fetch = jest.fn(async () => ({
      status: 404,
      ok: false,
      text: async () => '{}',
    })) as unknown as typeof fetch;
  });
  afterEach(() => {
    releaseMotion?.();
    releaseMotion = null;
  });

  async function mountSettings(role?: string, initialPage: 'main' | typeof AI_LIMITS_PAGE = 'main') {
    client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
    });
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SettingsPage
            workspaceId={WS}
            member={SELF}
            directory={roster(role)}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
            initialPage={initialPage}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByTestId(initialPage === 'main' ? 'settings-header' : 'settings-sub-header');
    // 설정 페이지의 훅들이 모르는 요청(404)을 받고 가라앉을 때까지 비운다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  }

  it.each(['owner', 'admin'])('%s 에게는 「사용 한도」 행이 서고, 누르면 한 겹 위에 장이 열린다', async role => {
    fetchBag.mockResolvedValue(bagOf(status()));
    await mountSettings(role);
    const row = screen.getByTestId('settings-team-ai-limits');
    expect(row.props.accessibilityHint).toBe(copy('settings.aiLimits.rowHint'));
    expect(screen.getByText(copy('settings.aiLimits.title'))).toBeTruthy();
    fireEvent.press(row);
    await screen.findByTestId('settings-team-ai-limits-page');
    await ready();
    // ‹ 는 한 겹만 벗기고 설정 페이지는 남는다.
    fireEvent.press(screen.getByTestId('settings-back'));
    await waitFor(() => expect(screen.queryByTestId('settings-team-ai-limits-page')).toBeNull());
    expect(screen.getByTestId('settings-header')).toBeTruthy();
  });

  it.each([['member'], ['guest'], [undefined]])(
    '관리자가 아닌 사람(%s)에게는 「사용 한도」 행이 없다',
    async role => {
      await mountSettings(role);
      expect(screen.queryByTestId('settings-team-ai-limits')).toBeNull();
      expect(fetchBag).not.toHaveBeenCalled();
    },
  );
});

afterAll(() => {
  // 비동기 정리가 남기지 않도록 한 번 더 비운다.
  return act(async () => {});
});

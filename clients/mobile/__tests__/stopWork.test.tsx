import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';

import {ApiError, type WorkSession} from '@momo/core/lib/api';

import {StopWorkControl} from '../src/features/work/StopWorkControl';
import {haptics} from '../src/lib/haptics';

jest.mock('../src/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    light: jest.fn(),
    medium: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

// =============================================================================
// N4 (#3596) — 폰 작업 멈추기.
//
// Sabotage targets: the button exists only for the owner of a running/idle
// session, nothing is sent before the confirmation, the request is the unsigned
// kill (no device key anywhere on this path), a refusal restores the pre-tap
// state with a retry, and the haptic fires once on the confirming tap.
// =============================================================================

const ME = '00000000-0000-7000-8000-0000000000bb';
const WS = '00000000-0000-7000-8000-000000000001';

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: '00000000-0000-7000-8000-0000000000aa',
    memberId: ME,
    status: 'running',
    ...overrides,
  } as WorkSession;
}

function mount(
  s: WorkSession,
  kill: jest.Mock,
  memberId = ME,
): ReturnType<typeof render> {
  const client = new QueryClient();
  const ui = (value: WorkSession) => (
    <QueryClientProvider client={client}>
      <StopWorkControl
        workspaceId={WS}
        memberId={memberId}
        session={value}
        kill={kill}
      />
    </QueryClientProvider>
  );
  const view = render(ui(s));
  (view as unknown as {again: (v: WorkSession) => void}).again = v =>
    view.rerender(ui(v));
  return view;
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('멈추기 버튼은 실행 중·대기 중인 내 세션에만 있다', () => {
  it.each(['running', 'idle'] as const)('%s 에는 있다', status => {
    mount(session({status}), jest.fn());
    expect(screen.getByTestId('work-stop-ask')).toBeTruthy();
  });

  it.each(['ended', 'orphaned'] as const)('%s 에는 없다', status => {
    mount(session({status}), jest.fn());
    expect(screen.queryByTestId('work-stop')).toBeNull();
  });

  it('남의 세션에는 없다', () => {
    mount(session({memberId: '00000000-0000-7000-8000-0000000000cc'}), jest.fn());
    expect(screen.queryByTestId('work-stop')).toBeNull();
  });

  it('버튼에 접근성 라벨이 있다', () => {
    mount(session(), jest.fn());
    const ask = screen.getByTestId('work-stop-ask');
    expect(ask.props.accessibilityLabel).toBe('작업 멈추기');
    expect(ask.props.accessibilityRole).toBe('button');
  });
});

describe('확인 뒤에만 보낸다', () => {
  it('첫 탭은 확인 단계만 열고 아무것도 보내지 않으며 햅틱도 없다', () => {
    const kill = jest.fn();
    mount(session(), kill);
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    expect(screen.getByTestId('work-stop-confirm')).toBeTruthy();
    expect(kill).not.toHaveBeenCalled();
    expect(haptics.warning).not.toHaveBeenCalled();
  });

  it('계속 두기는 보내지 않고 되돌아간다', () => {
    const kill = jest.fn();
    mount(session(), kill);
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    fireEvent.press(screen.getByTestId('work-stop-cancel'));
    expect(kill).not.toHaveBeenCalled();
    expect(screen.getByTestId('work-stop-ask')).toBeTruthy();
  });

  it('확인하면 서명 없는 kill을 이 세션 id 로 한 번 보내고 햅틱은 한 번이다', async () => {
    const kill = jest.fn(async () => ({
      sessionStatus: 'running',
      hostOnline: true,
      replayed: false,
    }));
    mount(session(), kill);
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-stop-confirm-button'));
    });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(WS, session().id);
    expect(haptics.warning).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('work-stop-requested')).toBeTruthy();
    // 요청이 닿은 뒤에는 다시 누를 길이 없다(멱등이지만 화면도 막는다).
    expect(screen.queryByTestId('work-stop-ask')).toBeNull();
  });
});

describe('맥 상태와 멈춤 표시', () => {
  it('꺼진 맥이면 「맥이 켜지면 멈춰요」라고 말한다', async () => {
    const kill = jest.fn(async () => ({
      sessionStatus: 'running',
      hostOnline: false,
      replayed: false,
    }));
    mount(session(), kill);
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-stop-confirm-button'));
    });
    expect(screen.getByTestId('work-stop-requested').props.children).toContain(
      '맥이 켜지면 멈춰요',
    );
  });

  it('요청 뒤 세션이 ended 로 돌아오면 「멈춤」을 보인다', async () => {
    const kill = jest.fn(async () => ({
      sessionStatus: 'running',
      hostOnline: true,
      replayed: false,
    }));
    const view = mount(session(), kill);
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-stop-confirm-button'));
    });
    expect(screen.queryByTestId('work-stop-stopped')).toBeNull();
    act(() => {
      (view as unknown as {again: (v: WorkSession) => void}).again(
        session({status: 'ended'}),
      );
    });
    expect(screen.getByTestId('work-stop-stopped')).toBeTruthy();
    expect(screen.getByText('멈춤')).toBeTruthy();
  });
});

describe('실패하면 누르기 전 상태로 돌아간다', () => {
  it('거절 코드를 해요체로 말하고 다시 누를 수 있다', async () => {
    const kill = jest
      .fn()
      .mockRejectedValueOnce(new ApiError(403, 'x', 'kill_owner_only'))
      .mockResolvedValueOnce({
        sessionStatus: 'running',
        hostOnline: true,
        replayed: false,
      });
    mount(session(), kill);
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-stop-confirm-button'));
    });
    expect(screen.getByTestId('work-stop-error').props.children).toContain(
      '시작한 사람의 맥에서만 멈출 수 있어요',
    );
    expect(screen.getByTestId('work-stop-ask')).toBeTruthy();
    expect(screen.queryByTestId('work-stop-requested')).toBeNull();
    // 다시 시도
    fireEvent.press(screen.getByTestId('work-stop-ask'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-stop-confirm-button'));
    });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('work-stop-requested')).toBeTruthy();
  });
});

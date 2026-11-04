import {ApiError, type RosterMember} from '@momo/core/lib/api';
import {TEAM_AI_NOTICE_VERSION} from '@momo/core/features/settings/teamAiRoles';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import {
  TeamAiHelperSettingRow,
  TeamAiHelperSettingsPage,
  useTeamAiHelperEntry,
} from '../src/features/profile/TeamAiHelperSettings';

// =============================================================================
// #4945 (ADR-0201 증보 v3 B3·B10) — 설정 › 도우미: 관리자가 이름과 할 수 있는 일을 바꾼다(폰).
//
// 웹 카드(`TeamAiHelperCard`)와 같은 서버 길·같은 코어 판정·같은 사전이다. 폰에는 온보딩 단계가 없고
// (ADR-0185 증보 §6), 이미 켜진 도우미를 관리한다. 설정 가방을 못 읽으면(관리자가 아님) 행이 서지 않는다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const HELPER = '33333333-3333-4333-8333-333333333333';

const mockBag = jest.fn<Promise<unknown>, []>();
const mockRename = jest.fn<Promise<unknown>, [string, string, string]>();
const mockPatch = jest.fn<Promise<unknown>, [string, unknown, unknown]>();

jest.mock('@momo/core/features/settings/teamAiSwitch', () => {
  const actual = jest.requireActual('@momo/core/features/settings/teamAiSwitch');
  return {...actual, fetchWorkspaceSettingsBag: () => mockBag()};
});
jest.mock('@momo/core/features/settings/teamAiRoles', () => {
  const actual = jest.requireActual('@momo/core/features/settings/teamAiRoles');
  return {
    ...actual,
    patchTeamAiRoles: (workspaceId: string, change: unknown, notice: unknown) =>
      mockPatch(workspaceId, change, notice),
  };
});
jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {
    ...actual,
    renameAgent: (workspaceId: string, agentId: string, name: string) =>
      mockRename(workspaceId, agentId, name),
  };
});

const HELPER_MEMBER = {
  id: HELPER,
  workspaceId: WS,
  kind: 'agent',
  status: 'active',
  handle: 'oort-helper',
  displayName: 'oort 도우미',
} as RosterMember;

let roster: RosterMember[];
const directory = () => makeDirectory(roster);

function bag(over: Record<string, unknown> = {}) {
  return {
    team_ai_fast_path: true,
    team_ai_agent_member_id: HELPER,
    team_ai_alias_status: {oort: 'registered', 오르트: 'registered', claude: 'registered'},
    ...over,
  };
}

// 설정 화면이 파일·기억을 켤 때 같은 요청에 싣는 고지 기록(#5040).
const settingsNotice = (bundle: string) => ({
  bundles: [bundle],
  noticeVersion: TEAM_AI_NOTICE_VERSION,
  via: 'settings',
});

function withClient(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: Infinity},
      mutations: {retry: false, gcTime: Infinity},
    },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function page() {
  return render(
    withClient(
      <TeamAiHelperSettingsPage workspaceId={WS} directory={directory()} onBack={() => {}} />,
    ),
  );
}

beforeEach(() => {
  roster = [HELPER_MEMBER];
  mockBag.mockReset();
  mockRename.mockReset();
  mockPatch.mockReset();
  mockBag.mockResolvedValue(bag());
});

afterEach(() => cleanup());

const ROLE_IDS = [
  'chat_read',
  'workspace_admin',
  'invite_access',
  'long_research',
  'files',
  'memory',
  'code',
];

describe('행은 확인된 뒤에만 선다', () => {
  it('관리자가 켠 도우미에게만 선다: 가방 403·꺼진 도우미·멤버 없음은 서지 않는다', async () => {
    const entry = (data: Promise<unknown>) => {
      mockBag.mockReset();
      mockBag.mockReturnValue(data);
      return renderHook(() => useTeamAiHelperEntry(WS, directory()), {
        wrapper: ({children}) => withClient(<>{children}</>),
      });
    };
    let hook = entry(Promise.resolve(bag()));
    await waitFor(() => expect(hook.result.current.visible).toBe(true));
    expect(hook.result.current.helperName).toBe('oort 도우미');
    hook.unmount();

    hook = entry(Promise.reject(new ApiError(403, 'forbidden')));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.visible).toBe(false);
    hook.unmount();

    hook = entry(Promise.resolve(bag({team_ai_fast_path: false})));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.visible).toBe(false);
    hook.unmount();

    hook = entry(Promise.resolve(bag({team_ai_agent_member_id: null})));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.visible).toBe(false);
    hook.unmount();

    render(withClient(<TeamAiHelperSettingRow helperName="비서봇" onPress={() => {}} />));
    expect(screen.getByLabelText('도우미, 비서봇')).toBeTruthy();
  });
});

describe('이름과 할 수 있는 일', () => {
  it('일곱 묶음이 모두 켜져 있고 chat_read는 잠겨 있으며, 파일·기억 옆에 고지가 보인다. 부르는 이름 줄이 서 있다', async () => {
    page();
    await screen.findByTestId('team-ai-helper-name');
    for (const id of ROLE_IDS) {
      const row = screen.getByTestId(`team-ai-helper-role-${id}`);
      expect(row.props.accessibilityState.checked).toBe(true);
      expect(row.props.accessibilityState.disabled).toBe(id === 'chat_read');
    }
    expect(screen.getByTestId('team-ai-helper-role-files-detail').props.children).toContain(
      '첨부 파일의 내용이 팀 AI 공급자',
    );
    expect(screen.getByTestId('team-ai-helper-role-memory-detail').props.children).toContain(
      '팀 기억의 내용이 팀 AI 공급자',
    );
    expect(screen.getByTestId('team-ai-helper-aliases').props.children).toBe(
      '부르는 이름: @oort · @오르트 · @claude',
    );
  });

  it('파일을 끄면 {files:false} 한 칸만 보내고 다른 묶음은 그대로다', async () => {
    mockPatch.mockImplementation(async () => {
      const next = bag({team_ai_roles: {files: false}});
      mockBag.mockResolvedValue(next);
      return next;
    });
    page();
    await screen.findByTestId('team-ai-helper-name');
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-role-files'));
    });
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch.mock.calls[0]).toEqual([WS, {files: false}, null]);
    await waitFor(() =>
      expect(screen.getByTestId('team-ai-helper-role-files').props.accessibilityState.checked).toBe(
        false,
      ),
    );
    expect(screen.getByTestId('team-ai-helper-role-memory').props.accessibilityState.checked).toBe(
      true,
    );
  });

  // #5040 (ADR-0201 증보 v3 B3): 켜는 순간이 동의다. 파일·기억을 켜면 같은 PATCH에 고지 기록이 실리고,
  // 고지 줄이 없는 묶음을 켜거나 무엇이든 끌 때는 실리지 않는다.
  it('파일·기억을 켤 때만 고지 기록을 같은 요청에 싣는다: 코드를 켜거나 기억을 끌 때는 싣지 않는다', async () => {
    mockBag.mockResolvedValue(bag({team_ai_roles: {files: false, code: false}}));
    mockPatch
      .mockResolvedValueOnce(bag({team_ai_roles: {files: true, code: false}}))
      .mockResolvedValueOnce(bag({team_ai_roles: {files: true, code: true}}))
      .mockResolvedValueOnce(bag({team_ai_roles: {files: true, code: true, memory: false}}));
    page();
    await screen.findByTestId('team-ai-helper-name');
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-role-files'));
    });
    expect(mockPatch).toHaveBeenLastCalledWith(WS, {files: true}, settingsNotice('files'));
    await waitFor(() =>
      expect(screen.getByTestId('team-ai-helper-role-files').props.accessibilityState.checked).toBe(
        true,
      ),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-role-code'));
    });
    expect(mockPatch).toHaveBeenLastCalledWith(WS, {code: true}, null);
    await waitFor(() =>
      expect(screen.getByTestId('team-ai-helper-role-code').props.accessibilityState.checked).toBe(
        true,
      ),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-role-memory'));
    });
    expect(mockPatch).toHaveBeenLastCalledWith(WS, {memory: false}, null);
    expect(mockPatch).toHaveBeenCalledTimes(3);
  });

  it('팀 기억이 꺼져 있어 기억을 못 켜면 이유를 말하고 스위치를 되돌린다', async () => {
    mockBag.mockResolvedValue(bag({team_ai_roles: {memory: false}}));
    mockPatch.mockRejectedValue(new ApiError(409, 'team memory is off', 'team_memory_off'));
    page();
    await screen.findByTestId('team-ai-helper-name');
    expect(screen.getByTestId('team-ai-helper-role-memory').props.accessibilityState.checked).toBe(
      false,
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-role-memory'));
    });
    expect(mockPatch).toHaveBeenLastCalledWith(WS, {memory: true}, settingsNotice('memory'));
    expect((await screen.findByTestId('team-ai-helper-roles-error')).props.children).toBe(
      '팀 기억이 꺼져 있어요. 설정 › 기억에서 먼저 켜 주세요.',
    );
    expect(screen.getByTestId('team-ai-helper-role-memory').props.accessibilityState.checked).toBe(
      false,
    );
  });

  it('새 이름을 저장하면 한 번 부르고 부르는 이름 줄이 새로 그려진다. 겹치면 이유를 말한다', async () => {
    mockRename.mockImplementation(async (_ws, member, name) => {
      roster = [{...HELPER_MEMBER, displayName: name}];
      mockBag.mockResolvedValue(
        bag({
          team_ai_alias_status: {
            oort: 'registered',
            오르트: 'registered',
            claude: 'registered',
            비서봇: 'registered',
          },
        }),
      );
      return {id: member, displayName: name};
    });
    page();
    const input = await screen.findByTestId('team-ai-helper-name');
    expect(screen.getByTestId('team-ai-helper-name-save').props.accessibilityState.disabled).toBe(
      true,
    );
    fireEvent.changeText(input, '  비서봇 ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-name-save'));
    });
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith(WS, HELPER, '비서봇');
    await waitFor(() =>
      expect(screen.getByTestId('team-ai-helper-aliases').props.children).toBe(
        '부르는 이름: @oort · @오르트 · @claude · @비서봇',
      ),
    );
    expect(screen.getByTestId('team-ai-helper-name-saved')).toBeTruthy();

    mockRename.mockReset();
    mockRename.mockRejectedValue(new ApiError(409, 'display name is already in use'));
    fireEvent.changeText(screen.getByTestId('team-ai-helper-name'), '김하늘');
    await act(async () => {
      fireEvent.press(screen.getByTestId('team-ai-helper-name-save'));
    });
    expect((await screen.findByTestId('team-ai-helper-name-error')).props.children).toBe(
      '다른 멤버가 쓰고 있거나 비슷해 보이는 이름이에요. 다른 이름으로 적어 주세요.',
    );
    expect(screen.queryByTestId('team-ai-helper-name-saved')).toBeNull();
  });
});

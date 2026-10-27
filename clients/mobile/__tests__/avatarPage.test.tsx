import {makeDirectory} from '@momo/core/features/workspace/directory';
import {ApiError, type RosterMember} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {AvatarPage, AVATAR_PAGE_OFFLINE} from '../src/features/profile/AvatarPage';
import type {AvatarPhotoPorts, AvatarPickOutcome} from '../src/features/profile/avatarPhoto';
import {workspaceKeys} from '../src/features/workspace/queries';

// =============================================================================
// #4384 — 프로필 사진 장: 세 줄, 있을 때만 지우기, 끝나면 roster 의 내 행만 바뀐다
//
// 서버 세 호출(세션 열기·complete·지우기)만 가짜다. 포트는 호출을 기록한다.
// =============================================================================

const mockCreate = jest.fn();
const mockComplete = jest.fn();
const mockRemove = jest.fn();
jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {
    ...actual,
    createMyAvatarUpload: (...a: unknown[]) => mockCreate(...a),
    completeMyAvatarUpload: (...a: unknown[]) => mockComplete(...a),
    removeMyAvatar: (...a: unknown[]) => mockRemove(...a),
  };
});

let mockOnline = true;
jest.mock('../src/features/inbox/useOnline', () => ({
  useOnline: () => mockOnline,
}));

const WS = 'ws-1';
const ME = 'me-1';
const OTHER = 'other-1';
const OLD_PATH = `/v1/workspaces/${WS}/members/${ME}/avatar/content?v=old`;
const OTHER_PATH = `/v1/workspaces/${WS}/members/${OTHER}/avatar/content?v=o1`;
const NEW_PATH = `/v1/workspaces/${WS}/members/${ME}/avatar/content?v=new`;

function member(id: string, name: string, avatarUrl?: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: name,
    handle: id,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...(avatarUrl ? {avatarUrl} : {}),
  } as RosterMember;
}

let queryClient: QueryClient;
let ports: AvatarPhotoPorts;
let pickOutcome: AvatarPickOutcome;
const onDone = jest.fn();

function mount(rows: RosterMember[]) {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: Infinity}},
  });
  queryClient.setQueryData(workspaceKeys.roster(WS), rows);
  // 서버 재조회는 이 시험의 관심이 아니다 — 낙관 교체가 남는지를 보려고 되읽기를 막는다.
  jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AvatarPage
          workspaceId={WS}
          selfId={ME}
          directory={makeDirectory(rows)}
          onDone={onDone}
          ports={ports}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const roster = () => queryClient.getQueryData<RosterMember[]>(workspaceKeys.roster(WS)) ?? [];
const mine = () => roster().find(row => row.id === ME);
const theirs = () => roster().find(row => row.id === OTHER);

beforeEach(() => {
  mockOnline = true;
  onDone.mockReset();
  pickOutcome = {kind: 'picked', uri: 'file:///cache/p.jpg', width: 800, height: 800};
  ports = {
    pick: jest.fn(async () => pickOutcome),
    shrink: jest.fn(async () => ({uri: 'file:///cache/s.jpg', width: 512, height: 512})),
    sizeOf: jest.fn(() => 50_000),
    put: jest.fn(async () => ({ok: true})),
    discard: jest.fn(),
    seed: jest.fn(),
    cameraAvailable: jest.fn(() => true),
  };
  mockCreate.mockReset().mockResolvedValue({id: 'media-new', status: 'pending', uploadUrl: 'https://drive.example/cap'});
  mockComplete.mockReset().mockResolvedValue({id: 'media-new', memberId: ME, status: 'ready', avatarUrl: NEW_PATH});
  mockRemove.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

const ROWS_WITH_PHOTO = () => [member(ME, '이도현', OLD_PATH), member(OTHER, '박서연', OTHER_PATH)];
const ROWS_NO_PHOTO = () => [member(ME, '이도현'), member(OTHER, '박서연', OTHER_PATH)];

describe('카메라를 못 여는 기기 (#4384 결정 4)', () => {
  it('cameraAvailable 이 false 면 「사진 찍기」 줄이 없고 고르기·지우기는 남는다', () => {
    (ports.cameraAvailable as jest.Mock).mockReturnValue(false);
    mount(ROWS_WITH_PHOTO());
    expect(screen.queryByTestId('avatar-choose-camera')).toBeNull();
    expect(screen.getByTestId('avatar-choose-library')).toBeTruthy();
    expect(screen.getByTestId('avatar-remove')).toBeTruthy();
  });
});

describe('세 줄', () => {
  it('사진이 없으면 지우기 줄이 없다(고르기·찍기만)', () => {
    mount(ROWS_NO_PHOTO());
    expect(screen.getByTestId('avatar-choose-library')).toBeTruthy();
    expect(screen.getByTestId('avatar-choose-camera')).toBeTruthy();
    expect(screen.queryByTestId('avatar-remove')).toBeNull();
  });

  it('내 사진이 있으면 지우기 줄이 선다 — 남의 사진은 셈에 들지 않는다', () => {
    mount(ROWS_WITH_PHOTO());
    expect(screen.getByTestId('avatar-remove')).toBeTruthy();
  });

  it('남의 사진만 있고 내 사진이 없으면 지우기 줄이 없다', () => {
    mount([member(ME, '이도현'), member(OTHER, '박서연', OTHER_PATH)]);
    expect(screen.queryByTestId('avatar-remove')).toBeNull();
  });

  it('파괴 행(사진 지우기)은 고르기·찍기와 다른 카드에 따로 선다 (design-review #4457 r1 L8, phone-sheets §5)', () => {
    const withPhoto = mount(ROWS_WITH_PHOTO());
    const choose = within(screen.getByTestId('avatar-card-card'));
    // 같은 카드에 섞이지 않는다 — 한 번 잘못 눌러 사진이 지워지지 않도록 위계(§3)가 카드 경계로도 선다.
    expect(choose.queryByTestId('avatar-remove')).toBeNull();
    expect(choose.getByTestId('avatar-choose-library')).toBeTruthy();
    const remove = within(screen.getByTestId('avatar-remove-card-card'));
    expect(remove.getByTestId('avatar-remove')).toBeTruthy();
    expect(remove.queryByTestId('avatar-choose-library')).toBeNull();
    // 사진이 없으면 파괴 카드 자체가 없다(빈 카드가 남지 않는다).
    withPhoto.unmount();
    mount(ROWS_NO_PHOTO());
    expect(screen.queryByTestId('avatar-remove-card')).toBeNull();
  });
});

describe('고르기 → 올리기 → roster', () => {
  it('성공하면 내 행의 avatarUrl 만 새 주소가 되고 남의 행은 그대로이며 장이 닫힌다', async () => {
    mount(ROWS_WITH_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-choose-library'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(ports.pick).toHaveBeenCalledWith('library');
    expect(mine()?.avatarUrl).toBe(NEW_PATH);
    expect(theirs()?.avatarUrl).toBe(OTHER_PATH);
    expect(mockComplete).toHaveBeenCalledWith(WS, 'media-new');
  });

  it('사진 찍기는 카메라 갈래로 고른다', async () => {
    mount(ROWS_NO_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-choose-camera'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(ports.pick).toHaveBeenCalledWith('camera');
    expect(mine()?.avatarUrl).toBe(NEW_PATH);
  });

  it('취소하면 아무것도 바뀌지 않고 알림도 없다', async () => {
    pickOutcome = {kind: 'cancelled'};
    mount(ROWS_WITH_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-choose-library'));
    await waitFor(() => expect(ports.pick).toHaveBeenCalled());
    await act(async () => {});
    expect(onDone).not.toHaveBeenCalled();
    expect(mine()?.avatarUrl).toBe(OLD_PATH);
    expect(screen.queryByTestId('avatar-page-failure')).toBeNull();
  });

  it('업로드가 실패하면 문장을 말하고 사진은 그대로이며 장이 남는다', async () => {
    mockComplete.mockRejectedValueOnce(new ApiError(422, 'x'));
    mount(ROWS_WITH_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-choose-library'));
    const failure = await screen.findByTestId('avatar-page-failure');
    expect(failure).toHaveTextContent(/이 이미지는 사용할 수 없어요/);
    expect(mine()?.avatarUrl).toBe(OLD_PATH);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByTestId('avatar-open-settings')).toBeNull();
  });

  it('용량 초과는 5MB 문장이고 서버를 부르지 않는다', async () => {
    (ports.sizeOf as jest.Mock).mockReturnValue(6 * 1024 * 1024);
    mount(ROWS_WITH_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-choose-library'));
    expect(await screen.findByTestId('avatar-page-failure')).toHaveTextContent(/5MB까지/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('권한 거부는 문장과 「설정 열기」이고, 누르면 iOS 설정을 연다', async () => {
    pickOutcome = {kind: 'denied'};
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mount(ROWS_NO_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-choose-camera'));
    expect(await screen.findByTestId('avatar-page-failure')).toHaveTextContent(/카메라 접근이 꺼져 있어요/);
    fireEvent.press(screen.getByTestId('avatar-open-settings'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('상태가 다시 그려지기 전에 들어온 두 번째 탭은 무시한다(한 프레임 안의 연타)', async () => {
    let release: (value: AvatarPickOutcome) => void = () => {};
    (ports.pick as jest.Mock).mockImplementation(() => new Promise<AvatarPickOutcome>(resolve => (release = resolve)));
    mount(ROWS_NO_PHOTO());
    const library = screen.getByTestId('avatar-choose-library');
    const camera = screen.getByTestId('avatar-choose-camera');
    // 같은 act 안: 첫 탭이 낸 `busy` 상태가 아직 줄을 잠그기 전이다.
    await act(async () => {
      fireEvent.press(library);
      fireEvent.press(library);
      fireEvent.press(camera);
    });
    expect(ports.pick).toHaveBeenCalledTimes(1);
    await act(async () => release({kind: 'cancelled'}));
  });
});

describe('사진 지우기', () => {
  it('지우면 내 행의 avatarUrl 이 없어지고 남의 행은 그대로이며 장이 닫힌다', async () => {
    mount(ROWS_WITH_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-remove'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mockRemove).toHaveBeenCalledWith(WS);
    expect(mine()).not.toHaveProperty('avatarUrl');
    expect(theirs()?.avatarUrl).toBe(OTHER_PATH);
  });

  it('지우기가 실패하면 사진을 그대로 두고 문장을 말한다', async () => {
    mockRemove.mockRejectedValueOnce(new ApiError(500, 'x'));
    mount(ROWS_WITH_PHOTO());
    fireEvent.press(screen.getByTestId('avatar-remove'));
    expect(await screen.findByTestId('avatar-page-failure')).toHaveTextContent(/지우지 못했어요/);
    expect(mine()?.avatarUrl).toBe(OLD_PATH);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('연결이 끊긴 동안', () => {
  it('이유를 말하고 세 줄을 잠근다 — 눌러도 아무것도 시작하지 않고 잠긴 것으로 읽힌다', () => {
    mockOnline = false;
    mount(ROWS_WITH_PHOTO());
    expect(screen.getByTestId('avatar-page-offline')).toHaveTextContent(AVATAR_PAGE_OFFLINE);
    fireEvent.press(screen.getByTestId('avatar-choose-library'));
    fireEvent.press(screen.getByTestId('avatar-choose-camera'));
    fireEvent.press(screen.getByTestId('avatar-remove'));
    expect(ports.pick).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    // 눌러도 아무 일이 없을 뿐 아니라 줄이 잠긴 것으로 보이고 읽힌다.
    for (const id of ['avatar-choose-library', 'avatar-choose-camera', 'avatar-remove']) {
      expect(screen.getByTestId(id).props.accessibilityState).toMatchObject({disabled: true});
    }
  });
});

import {useQueryClient} from '@tanstack/react-query';
import {render, screen} from '@testing-library/react-native';
import React from 'react';
import {Pressable, Text, TextInput, View} from 'react-native';

import {getAccessToken, keychainSettled} from '../src/storage/secureSession';
import {getServerBase} from '../src/storage/serverBase';
import {
  BASE_MS,
  BASE_URL,
  blankCopy,
  callsTo,
  control,
  controls,
  copyStringCount,
  drainRender,
  flat,
  installAppClock,
  installFetch,
  jsonResponse,
  keychainItems,
  labelled,
  makeQueryClient,
  maybeControl,
  member,
  message,
  missingKeys,
  mmkvStore,
  pressControl,
  renderWithQuery,
  resetSession,
  selfMember,
  settle,
  signIn,
  typeInto,
} from './testkit';

// =============================================================================
// 폰 시험 도구(testkit)의 자기 시험 (#4710).
//
// 도구가 거짓말을 하면 그것을 쓰는 모든 시험이 같이 거짓말을 한다 — 그래서 여기서는 도구가 하는 말
// (「이 노드는 이 이름의 버튼이다」「이 요청은 안 풀린 요청이다」「문구가 비었다」)이 **틀릴 때 빨개지는지**
// 를 본다. 화면 문구 조회는 한국어 문장이 아니라 일부러 영어 이름을 쓴다: 이 파일이 재는 것은 앱의
// 문장이 아니라 조회 도구의 동작이다.
// =============================================================================

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('fixtures', () => {
  it('member: 기본은 활동 중인 사람 하나이고, 넘긴 값이 이긴다', () => {
    const base = member({id: 'a'});
    expect(base).toMatchObject({id: 'a', kind: 'human', status: 'active', workspaceId: 'ws'});
    expect(member({id: 'b', kind: 'agent', handle: 'bot'})).toMatchObject({
      id: 'b',
      kind: 'agent',
      handle: 'bot',
    });
  });

  it('member: 부를 때마다 새 객체와 새 배열이다 (한 시험이 고친 것이 다음 시험으로 번지지 않는다)', () => {
    const first = member({id: 'a'});
    const second = member({id: 'a'});
    expect(first).not.toBe(second);
    expect(first.channelIds).not.toBe(second.channelIds);
  });

  it('message: seq 하나로 id·순서·시각이 서로 어긋나지 않게 정해지고, 넘긴 값이 이긴다', () => {
    const third = message(3);
    expect(third).toMatchObject({id: 'msg-3', seq: 3, hlcTs: 3, createdAtMs: BASE_MS + 3000});
    expect(message(3, {body: 'x', seq: 9}).body).toBe('x');
    expect(message(3, {seq: 9}).seq).toBe(9);
  });
});

describe('fetch', () => {
  it('jsonResponse: 코어의 HTTP 층이 읽는 status·ok·text() 를 가진다', async () => {
    const ok = jsonResponse(200, {a: 1});
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    expect(JSON.parse(await ok.text())).toEqual({a: 1});
    expect(jsonResponse(404, {}).ok).toBe(false);
    expect(jsonResponse(299, {}).ok).toBe(true);
    expect(jsonResponse(300, {}).ok).toBe(false);
  });

  it('installFetch: 라우트가 답한 요청만 통과하고, 모르는 요청은 던진다', async () => {
    const mock = installFetch(url => (url.includes('/ok') ? jsonResponse(200, {hit: true}) : undefined));
    const answered = await fetch(`${BASE_URL}/ok`);
    expect(JSON.parse(await answered.text())).toEqual({hit: true});
    await expect(fetch(`${BASE_URL}/other`)).rejects.toThrow(`unrouted request: ${BASE_URL}/other`);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('installFetch: URL 객체로 불러도 같은 주소로 읽고, 비동기 라우트도 기다린다', async () => {
    installFetch(async url => (url.endsWith('/slow') ? jsonResponse(200, {late: true}) : undefined));
    const answered = await fetch(new URL(`${BASE_URL}/slow`));
    expect(JSON.parse(await answered.text())).toEqual({late: true});
  });

  it('callsTo: 주소에 조각이 든 호출만 센다', async () => {
    const mock = installFetch(() => jsonResponse(200, {}));
    await fetch(`${BASE_URL}/a/1`);
    await fetch(`${BASE_URL}/a/2`);
    await fetch(`${BASE_URL}/b/1`);
    expect(callsTo(mock, '/a/')).toBe(2);
    expect(callsTo(mock, '/b/')).toBe(1);
    expect(callsTo(mock, '/c/')).toBe(0);
  });
});

describe('session', () => {
  beforeEach(() => {
    resetSession();
  });

  it('signIn: 서버 주소를 정하고 로그인한 상태로 만든다', () => {
    expect(getAccessToken()).toBeNull();
    const body = signIn(selfMember());
    expect(getAccessToken()).toBe(body.accessToken);
    expect(getServerBase()).toBe(BASE_URL);
  });

  it('resetSession: MMKV·세션·서버 주소를 빈 상태로 되돌린다', () => {
    signIn(selfMember());
    expect(mmkvStore.size).toBeGreaterThan(0);
    resetSession();
    expect(mmkvStore.size).toBe(0);
    expect(getAccessToken()).toBeNull();
    expect(getServerBase()).toBeNull();
  });

  it('mmkvStore·keychainItems: 앱이 실제로 쓰는 저장소의 살아 있는 보기다 — 토큰은 키체인에만 들어간다', async () => {
    const body = signIn(selfMember());
    await keychainSettled();
    const stored = [...keychainItems.values()].map(item => item.password);
    expect(stored).toContain(body.refreshToken);
    expect([...mmkvStore.values()].join('\n')).not.toContain(body.refreshToken);
  });
});

describe('render', () => {
  it('makeQueryClient: 재시도와 캐시 보존을 끈다 (실패가 재시도 뒤에 숨지 않고 캐시가 다음 시험으로 새지 않는다)', () => {
    const defaults = makeQueryClient().getDefaultOptions();
    expect(defaults.queries?.retry).toBe(false);
    expect(defaults.queries?.gcTime).toBe(0);
    expect(defaults.mutations?.retry).toBe(false);
  });

  it('renderWithQuery: 안쪽이 보는 클라이언트가 돌려받은 클라이언트와 같다', () => {
    let seen: unknown = null;
    function Probe(): React.JSX.Element {
      seen = useQueryClient();
      return <Text>probe</Text>;
    }
    const {client} = renderWithQuery(<Probe />);
    expect(seen).toBe(client);
  });

  it('flat: 중첩된 스타일 배열을 한 객체로 펴고, 없으면 빈 객체다', () => {
    expect(flat([{opacity: 1}, [{width: 2}], null, {opacity: 0.5}])).toEqual({opacity: 0.5, width: 2});
    expect(flat(undefined)).toEqual({});
  });

  it('settle: 가짜 시계를 정확히 그만큼 흘린다', async () => {
    installAppClock();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 20);
    await settle(10);
    expect(fired).toBe(false);
    await settle(10);
    expect(fired).toBe(true);
  });

  it('drainRender: 올려 둔 화면을 내리고 screen 을 비운다', async () => {
    render(<Text>on screen</Text>);
    expect(screen.getByText('on screen')).toBeTruthy();
    await drainRender();
    expect(() => screen.toJSON()).toThrow();
  });
});

describe('query — 역할·레이블로 찾기', () => {
  const onSave = jest.fn();
  const onName = jest.fn();

  function Form(): React.JSX.Element {
    return (
      <View>
        <Pressable accessibilityRole="button" accessibilityLabel="Save" onPress={onSave}>
          <Text>Save</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => {}}>
          <Text>Cancel</Text>
        </Pressable>
        <TextInput accessibilityLabel="Name" onChangeText={onName} />
      </View>
    );
  }

  beforeEach(() => {
    onSave.mockClear();
    onName.mockClear();
    render(<Form />);
  });

  it('control·pressControl: 이름이 맞는 버튼 하나를 찾아 누른다', () => {
    expect(control('button', 'Save')).toBe(screen.getByLabelText('Save'));
    pressControl('button', 'Save');
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('정규식 이름도 받는다', () => {
    expect(control('button', /^Can/)).toBe(screen.getByLabelText('Cancel'));
  });

  it('maybeControl·controls: 없으면 null·빈 목록, 있으면 그만큼', () => {
    expect(maybeControl('button', 'Nope')).toBeNull();
    expect(controls('button', 'Nope')).toEqual([]);
    expect(controls('button')).toHaveLength(2);
  });

  it('이름 없이 역할만 주면 둘 이상일 때 던진다 (조용히 첫 번째를 집지 않는다)', () => {
    expect(() => control('button')).toThrow();
  });

  it('labelled·typeInto: 레이블이 맞는 입력창에 글자를 넣는다', () => {
    expect(labelled('Name')).toBe(screen.getByLabelText('Name'));
    typeInto('Name', 'x');
    expect(onName).toHaveBeenCalledWith('x');
  });

  describe('레이블 자리가 비면 던진다 (문구 상수가 없어졌을 때 아무 버튼이나 집지 않게)', () => {
    it('대조: RNTL 자체는 name: undefined 를 「조건 없음」으로 읽어 모든 버튼과 맞는다', () => {
      expect(screen.getAllByRole('button', {name: undefined})).toHaveLength(2);
    });

    it.each([
      ['control', () => control('button', undefined)],
      ['maybeControl', () => maybeControl('button', undefined)],
      ['controls', () => controls('button', undefined)],
      ['pressControl', () => pressControl('button', undefined)],
      ['빈 문자열', () => control('button', '')],
      ['공백뿐인 문자열', () => control('button', '   ')],
      ['labelled', () => labelled(undefined as never)],
      ['typeInto', () => typeInto(undefined as never, 'x')],
    ])('%s', (_name, call) => {
      expect(call).toThrow(/레이블이 비었어요/);
    });
  });
});

describe('catalog — 빈 문구·키 누락', () => {
  it('blankCopy: 비었거나 공백뿐인 문구의 경로를 모두 돌려주고, 함수·숫자는 건너뛴다', () => {
    const blanks = blankCopy({
      ok: '내용',
      empty: '',
      nested: {spaces: '  ', fine: 'x', list: ['a', '', 'c']},
      fn: () => '',
      n: 0,
    });
    expect(blanks).toEqual(['empty', 'nested.spaces', 'nested.list[1]']);
  });

  it('blankCopy: 문구가 모두 차 있으면 빈 목록이다', () => {
    expect(blankCopy({a: 'x', b: {c: ['y']}})).toEqual([]);
  });

  it('copyStringCount: 문자열을 빈 것까지 센다 (빈손으로 통과하는 검사를 막는 눈금)', () => {
    expect(copyStringCount({a: 'x', b: '', c: {d: ['y', 'z']}, e: 1})).toBe(4);
    expect(copyStringCount({})).toBe(0);
  });

  it('missingKeys: 없는 키와 값이 undefined 인 키를 required 순서로 돌려준다', () => {
    expect(missingKeys({a: 'x', b: undefined}, ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(missingKeys({a: 'x'}, ['a'])).toEqual([]);
  });
});

import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Keyboard, KeyboardAvoidingView, Linking, ScrollView} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import ConnectScreen from '../src/screens/ConnectScreen';
import {__resetSessionStore} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// 키보드가 올라와도 포커스한 칸과 주 버튼이 키보드 위에 선다 (#2678)
//
// ## 잰 것 (iPhone 13 mini 375×812 · iOS 26.5 · Release, 연결 화면)
//
// 창 위 여백 50, 키보드 윗변 495(URL 키보드 317pt)·468(이메일·비밀번호 344pt — 「암호」
// 보조 막대 44pt 포함). 서버 주소를 적고 이메일 칸을 누른 자리(목록은 움직이지 않았다):
//
//     비밀번호 칸 451–494  → 키보드 윗변 468 에 걸려 26pt 가려짐. 가운데(472.5)가 키보드 위다.
//     로그인 버튼 511–555  → 통째로 가려짐(87pt).
//
// Maestro `tapOn: password-input` 은 그 가운데를 눌러 키보드의 보조 막대를 쳤고, 저장소의
// `00-login` 흐름은 비밀번호를 **이메일 칸에** 적은 채 로그인에 실패했다(값
// `capture-password`). AX 크기에서는 더하다: AX1 에서 이메일 칸이 키보드 밑(35pt)이라
// 탭이 키보드를 치고 이메일이 서버 주소 칸에 들어갔으며, AX5 에서는 포커스한 서버 칸
// 자체가 키보드 윗변에 2pt 걸렸다.
//
// `KeyboardAvoidingView` 는 이 자리에서 **맞게** 줄였다 — 목록의 가로 스크롤 막대가
// 462–465(안쪽 3pt)에 서서 목록 아랫변이 키보드 윗변 468 과 같다. 연결 화면은 앱의 뿌리
// (`App → Gate → ConnectScreen`)라 이 뷰의 부모 좌표가 곧 창 좌표다. 모자란 것은 줄어든
// 창 안에서 **포커스한 칸으로 스크롤하는 일**이었다 — 아무도 하지 않았다.
//
// ## 네이티브 이중
//
// jest 에는 레이아웃이 없다. 이중이 잰 행의 자리를 들고, 네이티브가 할 일을 대신한다.
//
//   1. 키보드 이벤트 — `keyboardWillShow`·`keyboardWillHide` 를 잰 높이로 보낸다.
//      `KeyboardAvoidingView` 는 진짜 코드가 돈다(자기 `onLayout` 프레임 50/762 기준).
//   2. 목록의 창 — KAV 가 정한 아래 여백만큼 목록의 높이를 줄여 `onLayout` 으로 알린다.
//   3. 행의 자리 — 목록 콘텐츠의 직계 행 가운데 `onLayout` 을 가진 것에 잰 frame 을 준다.
//   4. 스크롤 — 목록의 `scrollTo` 를 받아 **실제 프레임**의 끝으로 clamp 하고,
//      `onScroll` 로 알린다.
//   5. 창의 애니메이션 — KAV 는 새 여백을 키보드와 같은 시간(383ms) 동안 애니메이션한다.
//      JS 의 `onLayout` 은 첫 순간에 최종값을 말하지만 UIKit 의 프레임은 아직 옛 크기라,
//      그 사이의 `scrollTo` 는 옛 프레임으로 잘린다 — 폼이 옛 창에 다 들면 아무 일도
//      일어나지 않는다. 창이 **커지는** 쪽은 곧바로 서고, UIKit 이 오프셋을 범위 안으로
//      되돌린다(기기: 키보드가 내려가는 순간 오프셋 0).
//   6. UIKit 의 캐럿 스크롤 — 키보드가 선 뒤 포커스한 칸이 창 밖이면 UIKit 이 그 칸의
//      아랫변을 창 아랫변에 맞춘다(기기: 비밀번호 칸 424–468, 버튼 61pt 가려짐).
//      그 다음에 JS 가 `keyboardDidShow` 를 받는다.
//   7. 순서 — 애니메이션이 있는 변화(383ms)는 목록의 새 높이가 먼저, `keyboardDidShow`
//      가 나중이다. 그 자리에서 종류만 바뀌는 변화(0ms)는 거꾸로, `keyboardDidShow` 가
//      먼저 오고 새 높이가 뒤따른다(기기 탐침: 18936 did-show, 18940 높이 418).
//
// 5·6 은 첫 수리를 기기에 올려 잰 뒤에 더했다: 「다음」으로 비밀번호 칸에 가면 iOS 가
// 키보드를 내렸다 다시 올리고(`keyboardWillHide` → `keyboardWillShow`, 각 383ms), 수리의
// 첫 `scrollTo(103.7)` 는 커진 옛 프레임에 잘려 사라졌다. 판정은 **화면 좌표**로 한다:
// 행의 자리 − 오프셋 + 창 위 여백이 창 윗변과 키보드 윗변 사이에 드는가.
// =============================================================================

const SCREEN_H = 812;
const TOP_INSET = 50;
/** 키보드 높이(pt) — 서버 칸의 URL 키보드와, 「암호」 보조 막대가 붙는 이메일·비밀번호. */
const KEYBOARD = {url: 317, text: 344} as const;
/** 콘텐츠 아래 여백 — `space.xl * 2`. */
const CONTENT_PAD_BOTTOM = 48;

interface Span {
  top: number;
  bottom: number;
}

/** 한 글자 크기에서 잰 행들(콘텐츠 좌표, 서버 주소를 적어 힌트가 선 뒤). */
interface Geometry {
  rows: Record<string, Span>;
  /** 칸 안의 입력 상자 — 판정 대상. */
  inputs: Record<'server' | 'email' | 'password', Span>;
}

/** 기본 크기(large). */
const LARGE: Geometry = {
  rows: {
    title: {top: 24, bottom: 55},
    subtitle: {top: 71, bottom: 91},
    qr: {top: 107, bottom: 151},
    server: {top: 167, bottom: 254},
    hint: {top: 270, bottom: 285},
    email: {top: 301, bottom: 364},
    password: {top: 381, bottom: 444},
    action: {top: 461, bottom: 505},
    toggle: {top: 521, bottom: 565},
  },
  inputs: {
    server: {top: 190, bottom: 233},
    email: {top: 321, bottom: 364},
    password: {top: 401, bottom: 444},
  },
};

/** 기본 크기, 주소를 아직 적지 않아 힌트가 없을 때 — 힌트 아래 행이 31pt 위에 있다. */
const LARGE_EMPTY: Geometry = {
  rows: {
    title: {top: 24, bottom: 55},
    subtitle: {top: 71, bottom: 91},
    qr: {top: 107, bottom: 151},
    server: {top: 167, bottom: 254},
    email: {top: 270, bottom: 333},
    password: {top: 350, bottom: 413},
    action: {top: 430, bottom: 474},
    toggle: {top: 490, bottom: 534},
  },
  inputs: {
    server: {top: 190, bottom: 233},
    email: {top: 290, bottom: 333},
    password: {top: 370, bottom: 413},
  },
};

/** AX1 (accessibility-medium). */
const AX1: Geometry = {
  rows: {
    title: {top: 24, bottom: 79},
    subtitle: {top: 95, bottom: 131},
    qr: {top: 147, bottom: 191},
    server: {top: 207, bottom: 333},
    hint: {top: 349, bottom: 375},
    email: {top: 391, bottom: 480},
    password: {top: 497, bottom: 585},
    action: {top: 602, bottom: 655},
    toggle: {top: 671, bottom: 715},
  },
  inputs: {
    server: {top: 242, bottom: 301},
    email: {top: 421, bottom: 480},
    password: {top: 527, bottom: 585},
  },
};

/** AX5 (accessibility-extra-extra-extra-large). 힌트가 세 줄로 접힌다. */
const AX5: Geometry = {
  rows: {
    title: {top: 24, bottom: 227},
    subtitle: {top: 243, bottom: 386},
    qr: {top: 402, bottom: 460},
    server: {top: 476, bottom: 740},
    hint: {top: 756, bottom: 910},
    email: {top: 926, bottom: 1072},
    password: {top: 1089, bottom: 1235},
    action: {top: 1252, bottom: 1333},
    toggle: {top: 1349, bottom: 1405},
  },
  inputs: {
    server: {top: 539, bottom: 631},
    email: {top: 979, bottom: 1072},
    password: {top: 1142, bottom: 1235},
  },
};

/** 테스트 렌더러의 노드 — RNTL 이 돌려주는 그 모양이다. */
type Node = ReturnType<typeof screen.getByTestId>;

function isNode(child: unknown): child is Node {
  return typeof child !== 'string';
}

function firstHost(node: Node): Node {
  let cursor: Node = node;
  while (typeof cursor.type !== 'string') {
    const next = (cursor.children as unknown[]).find(isNode);
    if (next === undefined) return cursor;
    cursor = next;
  }
  return cursor;
}

/** 이 행 안에 있는 testID 로 행의 이름을 정한다. 제목·부제는 자리 순서로. */
function rowName(row: Node, index: number): string {
  const ids: [string, string][] = [
    ['server-url-input', 'server'],
    ['server-url-hint', 'hint'],
    ['email-input', 'email'],
    ['password-input', 'password'],
    ['submit-button', 'action'],
    ['mode-toggle', 'toggle'],
    ['qr-connect-button', 'qr'],
  ];
  for (const [id, name] of ids) {
    if (row.props.testID === id || row.findAll((node: Node) => node.props.testID === id).length > 0) {
      return name;
    }
  }
  return index === 0 ? 'title' : index === 1 ? 'subtitle' : `row${index}`;
}

class KeyboardDouble {
  offset = 0;
  keyboard = 0;
  /** 목록이 JS 에 알린 창 — KAV 가 정한 값, 키보드 이벤트 순간에 최종값이다. */
  jsViewport = SCREEN_H - TOP_INSET;
  /** UIKit 이 clamp 에 쓰는 실제 프레임. KAV 는 키보드와 함께 애니메이션한다(규칙 5). */
  nativeViewport = SCREEN_H - TOP_INSET;
  /** 포커스한 입력 상자 — UIKit 의 캐럿 스크롤이 본다(규칙 6). */
  private focusedInput: Span | null = null;
  private announced = new Map<string, string>();

  constructor(public geometry: Geometry) {}

  private scroll() {
    return screen.UNSAFE_getByType(ScrollView);
  }

  private kav() {
    return screen.UNSAFE_getByType(KeyboardAvoidingView);
  }

  private contentHeight(): number {
    return Math.max(...Object.values(this.geometry.rows).map(row => row.bottom)) + CONTENT_PAD_BOTTOM;
  }

  private moveTo(y: number) {
    const next = Math.min(Math.max(0, y), Math.max(0, this.contentHeight() - this.nativeViewport));
    if (next === this.offset) return;
    this.offset = next;
    this.scroll().props.onScroll?.({
      nativeEvent: {
        contentOffset: {x: 0, y: this.offset},
        contentSize: {width: 375, height: this.contentHeight()},
        layoutMeasurement: {width: 375, height: this.nativeViewport},
      },
    });
  }

  /** 마운트 뒤의 첫 레이아웃: KAV 의 프레임, 목록의 창, 행들. */
  async mount() {
    const instance = this.scroll().instance as {scrollTo: (...args: unknown[]) => void};
    jest.spyOn(instance, 'scrollTo').mockImplementation((...args: unknown[]) => {
      const target = args[0] as {y?: number} | number | undefined;
      // 규칙 4: 실제 프레임으로 clamp — 애니메이션 중이면 옛 프레임이다.
      this.moveTo(typeof target === 'object' && target !== null ? target.y ?? 0 : Number(args[1] ?? 0));
    });
    await act(async () => {
      const kav = this.kav().instance as {_onLayout: (event: unknown) => Promise<void>};
      await kav._onLayout({
        nativeEvent: {layout: {x: 0, y: TOP_INSET, width: 375, height: SCREEN_H - TOP_INSET}},
        persist: () => undefined,
      });
    });
    await this.layout(true);
  }

  /** 네이티브 레이아웃 한 번: 목록의 창과, `onLayout` 을 가진 행들. 바뀐 것만 알린다. */
  async layout(force = false) {
    await act(async () => {
      const padding = (this.kav().instance as {state: {bottom: number}}).state.bottom;
      const viewport = SCREEN_H - TOP_INSET - padding;
      if (force || viewport !== this.jsViewport) {
        this.jsViewport = viewport;
        // 규칙 5: 창이 커지는 쪽은 곧바로 서고 UIKit 이 오프셋을 범위 안으로 되돌린다
        // (기기: 키보드가 내려가는 순간 오프셋 0). 줄어드는 쪽은 키보드와 함께 간다.
        if (viewport > this.nativeViewport) {
          this.nativeViewport = viewport;
          this.moveTo(this.offset);
        }
        this.scroll().props.onLayout?.({
          nativeEvent: {layout: {x: 0, y: 0, width: 375, height: viewport}},
        });
      }
      // RCTScrollView → 콘텐츠 컨테이너(호스트 View) → 그 직계 행들.
      const scrollHost = firstHost(this.scroll());
      const content = firstHost((scrollHost.children as unknown[]).filter(isNode)[0]);
      const rows = (content.children as unknown[]).filter(isNode);
      rows.forEach((row, index) => {
        const name = rowName(row, index);
        const span = this.geometry.rows[name];
        const host = firstHost(row);
        const onLayout = host.props.onLayout as ((event: unknown) => void) | undefined;
        if (span === undefined || onLayout === undefined) return;
        const signature = `${span.top}:${span.bottom}`;
        if (!force && this.announced.get(name) === signature) return;
        this.announced.set(name, signature);
        onLayout({
          nativeEvent: {layout: {x: 16, y: span.top, width: 343, height: span.bottom - span.top}},
        });
      });
    });
  }

  focusInput(input: Span | null) {
    this.focusedInput = input;
  }

  private emit(name: string, height: number, durationMs: number) {
    (Keyboard as unknown as {_emitter: {emit: (event: string, payload: unknown) => void}})._emitter.emit(
      name,
      {
        endCoordinates: {
          height,
          screenX: 0,
          screenY: name.endsWith('Hide') ? SCREEN_H : SCREEN_H - height,
          width: 375,
        },
        duration: durationMs,
        easing: 'keyboard',
      },
    );
  }

  /**
   * 키보드가 그 자리에서 종류만 바뀐다(URL → 이메일, 0ms). 기기에서 잰 순서 그대로:
   * `keyboardWillShow` 와 `keyboardDidShow` 가 **함께** 오고, 그 **뒤에** 목록의 새 높이가
   * 온다 — 애니메이션이 없으니 실제 프레임은 곧바로 최종값이다. UIKit 의 캐럿 스크롤도
   * 그 프레임에서 곧바로 돈다.
   */
  async keyboardSwitch(height: number) {
    this.keyboard = height;
    await act(async () => {
      this.emit('keyboardWillShow', height, 0);
      this.emit('keyboardDidShow', height, 0);
    });
    const padding = (this.kav().instance as {state: {bottom: number}}).state.bottom;
    this.nativeViewport = SCREEN_H - TOP_INSET - padding;
    this.moveTo(this.offset);
    const input = this.focusedInput;
    if (input !== null && input.bottom - this.offset > this.nativeViewport) {
      this.moveTo(input.bottom - this.nativeViewport);
    }
    await this.layout();
  }

  /** 규칙 1: 키보드가 움직이기 시작한다(`will`). KAV 가 창을 정하고, 목록이 그것을 알린다. */
  async keyboardWill(kind: 'show' | 'hide', height: number, durationMs: number) {
    this.keyboard = kind === 'show' ? height : 0;
    await act(async () => {
      this.emit(kind === 'show' ? 'keyboardWillShow' : 'keyboardWillHide', height, durationMs);
    });
    await this.layout();
  }

  /**
   * 키보드가 섰다. 실제 프레임이 최종값이 되고(규칙 5), UIKit 이 포커스한 칸의 캐럿이
   * 창 밖이면 그 칸의 아랫변을 창 아랫변에 맞춘다(규칙 6 — 기기: 비밀번호 칸 424–468).
   * 그 **뒤에** JS 가 `keyboardDidShow` 를 받는다(네이티브가 먼저, JS 는 다음 틱).
   */
  async keyboardDid(durationMs: number) {
    await act(async () => {
      jest.advanceTimersByTime(durationMs);
    });
    await act(async () => {
      this.nativeViewport = this.jsViewport;
      this.moveTo(this.offset);
      const input = this.focusedInput;
      if (input !== null && input.bottom - this.offset > this.nativeViewport) {
        this.moveTo(input.bottom - this.nativeViewport);
      }
      if (this.keyboard > 0) this.emit('keyboardDidShow', this.keyboard, durationMs);
    });
  }

  /** 화면 좌표에서 그 칸이 창 윗변과 키보드 윗변 사이에 온전히 드는가 — 아니면 가려진 pt. */
  hidden(span: Span): number {
    const top = TOP_INSET + span.top - this.offset;
    const bottom = TOP_INSET + span.bottom - this.offset;
    const floor = Math.min(SCREEN_H - this.keyboard, TOP_INSET + this.nativeViewport);
    const under = Math.max(0, bottom - floor);
    const over = Math.max(0, TOP_INSET - top);
    return Math.round((under + over) * 10) / 10;
  }
}

async function focus(id: string) {
  await act(async () => {
    fireEvent(screen.getByTestId(id), 'focus');
  });
}

async function blur(id: string) {
  await act(async () => {
    fireEvent(screen.getByTestId(id), 'blur');
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetSessionStore();
  __resetServerBaseCache();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** 키보드가 오르내리는 시간 — 기기의 `keyboardWillShow` 가 실은 값(383.3ms). */
const TRAVEL_MS = 383;

/**
 * 서버 주소가 적힌 채(저장된 주소로 돌아온 사람, 힌트가 서 있다) 세 칸을 차례로 연다 —
 * 저장소의 `00-login` 과 같은 순서, 기기에서 잰 키보드 이벤트 그대로:
 *
 *   - 주소 칸 — 키보드가 올라온다(URL 키보드, 383ms).
 *   - 이메일 칸 탭 — 키보드가 그 자리에서 종류만 바뀐다(344pt, 0ms).
 *   - 키보드의 「다음」으로 비밀번호 칸 — iOS 가 키보드를 **내렸다가 다시 올린다**(보안
 *     입력은 다른 키보드다). 목록의 창이 커졌다가 다시 준다.
 */
async function walk(geometry: Geometry) {
  render(<ConnectScreen />);
  fireEvent.changeText(screen.getByTestId('server-url-input'), 'http://127.0.0.1:18586');
  const native = new KeyboardDouble(geometry);
  await native.mount();
  const {inputs, rows} = geometry;

  await focus('server-url-input');
  native.focusInput(inputs.server);
  await native.keyboardWill('show', KEYBOARD.url, TRAVEL_MS);
  await native.keyboardDid(TRAVEL_MS);
  const server = {
    field: native.hidden(inputs.server),
    next: native.hidden(inputs.email),
    action: native.hidden(rows.action),
  };

  await blur('server-url-input');
  await focus('email-input');
  native.focusInput(inputs.email);
  await native.keyboardSwitch(KEYBOARD.text);
  const email = {
    field: native.hidden(inputs.email),
    next: native.hidden(inputs.password),
    action: native.hidden(rows.action),
  };

  await native.keyboardWill('hide', KEYBOARD.text, TRAVEL_MS);
  await blur('email-input');
  await native.keyboardWill('show', KEYBOARD.text, TRAVEL_MS);
  await focus('password-input');
  native.focusInput(inputs.password);
  await native.keyboardDid(TRAVEL_MS);
  const password = {field: native.hidden(inputs.password), action: native.hidden(rows.action)};

  return {server, email, password};
}

describe('연결 화면 — 포커스한 칸과 주 버튼이 키보드 위에 선다 (#2678)', () => {
  it('375pt 기본 크기: 세 칸 모두, 칸과 다음 칸과 로그인 버튼이 키보드 위에 온전하다', async () => {
    const seen = await walk(LARGE);

    // 가려진 pt — 0 이면 창 윗변과 키보드 윗변 사이에 온전히 있다.
    expect(seen).toEqual({
      server: {field: 0, next: 0, action: 0},
      email: {field: 0, next: 0, action: 0},
      password: {field: 0, action: 0},
    });
  });

  it('AX1: 포커스한 칸은 언제나, 버튼은 칸과 함께 창에 들 때 온전하다', async () => {
    const seen = await walk(AX1);

    // 서버 칸부터 버튼까지는 창(445)보다 길다 — 칸이 먼저이고, 다음 칸(이메일)이 보인다.
    expect({
      server: {field: seen.server.field, next: seen.server.next},
      email: seen.email,
      password: seen.password,
    }).toEqual({
      server: {field: 0, next: 0},
      email: {field: 0, next: 0, action: 0},
      password: {field: 0, action: 0},
    });
  });

  it('주소를 적는 동안 힌트가 서며 아래 행이 내려가도, 로그인 버튼은 키보드 위에 남는다', async () => {
    render(<ConnectScreen />);
    const native = new KeyboardDouble(LARGE_EMPTY);
    await native.mount();
    await focus('server-url-input');
    native.focusInput(LARGE_EMPTY.inputs.server);
    await native.keyboardWill('show', KEYBOARD.url, TRAVEL_MS);
    await native.keyboardDid(TRAVEL_MS);
    const before = native.hidden(LARGE_EMPTY.rows.action);

    // 첫 글자에 힌트(「요청 주소: …」)가 서고, 그 아래 행이 31pt 내려간다. 키보드는 그대로다.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('server-url-input'), 'h');
    });
    native.geometry = LARGE;
    await native.layout();

    expect({before, after: native.hidden(LARGE.rows.action)}).toEqual({before: 0, after: 0});
  });

  it('키보드 이벤트가 없어도(하드웨어 키보드) 포커스를 옮기면 그 칸이 창에 든다 — AX5', async () => {
    render(<ConnectScreen />);
    fireEvent.changeText(screen.getByTestId('server-url-input'), 'http://127.0.0.1:18586');
    const native = new KeyboardDouble(AX5);
    await native.mount();
    // 소프트웨어 키보드가 없다 — 창은 762 그대로이고, 비밀번호 칸은 화면 아래(1142)에 있다.
    await focus('password-input');

    expect({
      field: native.hidden(AX5.inputs.password),
      action: native.hidden(AX5.rows.action),
    }).toEqual({field: 0, action: 0});
  });

  it('AX5: 포커스한 칸은 언제나 온전하고, 마지막 칸에서는 버튼도 온전하다', async () => {
    const seen = await walk(AX5);

    // 서버·이메일 칸에서 버튼까지는 창보다 길다. 포커스한 칸이 먼저다.
    expect({
      server: seen.server.field,
      email: seen.email.field,
      password: seen.password,
    }).toEqual({server: 0, email: 0, password: {field: 0, action: 0}});
  });
});

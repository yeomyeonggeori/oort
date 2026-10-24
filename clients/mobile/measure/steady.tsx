import type {Message, RosterMember} from '@momo/core/lib/api';
import type {MessageNewEvent, RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {typingSegments} from '@momo/core/features/chat/typing';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import NetInfo from '@react-native-community/netinfo';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Settings, StyleSheet, Text, TextInput, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {PinListPanel} from '../src/features/conversation/PinListPanel';
import {clearDraft} from '../src/features/conversation/drafts';
import {Timeline, type TimelineGeometry} from '../src/features/conversation/Timeline';
import {TypingBar} from '../src/features/conversation/TypingBar';
import {useTimeline} from '../src/features/conversation/useTimeline';
import type {ChannelRail} from '../src/realtime/channelRail';
import {useNow} from '../src/lib/useNow';
import {setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 「대화 목록이 제자리를 지키는가」 — 실시간 이벤트를 재생하며 맨 아래 메시지의 창 좌표를 매 프레임 잰다 (#4292).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure DM-STEADY-<SCENARIO> \
//        -RCT_jsLocation 127.0.0.1:<metro> -momoGapSink 127.0.0.1:<port>
//   (라이트: LIGHT-DM-STEADY-<SCENARIO>; `-momoGapSink` 는 `measure/gap-sink.mjs` 가 받는다 — 없으면 화면에만 적는다)
//
//   SCENARIO  all(기본)   아래 다섯을 차례로
//             idle        8초 동안 아무 일도 없다 — 대조군. 움직임이 0 이어야 한다.
//             peer        상대 메시지 3개가 2.5초 간격으로 온다 — 정직한 성장. 한 줄이 자라는 만큼만 움직인다.
//             blip        소켓이 짧게 끊겼다 곧바로 이어지고(띠 없음, 4초 유예 안) 같은 구독이 복구돼 돌아온다. 3번, 14초 간격.
//             outage      소켓이 5초 끊겨 띠가 서고, 이어진 뒤 복구에 **실패**해 꼬리를 REST 로 읽는다(읽어 온 메시지 0개). 3번, 18초 간격.
//             gap         끊긴 사이에 상대가 한 줄을 보냈다 — 이어진 뒤 REST 가 그 한 줄을 가져온다. 정직한 복구. 2번, 20초 간격.
//             own         내가 방금 보낸 두 줄이 돌아온다 — (a) 레일이 되쏘기로 (b) 끊긴 사이 서버가 가진 것을 REST 꼬리가. 복구한 것이 없으므로 표지가
//                         서지 않아야 한다(실기 사례 2026-10-24). `all` 에 들지 않는다.
//             hold        연결 띠를 세운 채 90초 머문다 — 사진용(`all` 에 들지 않는다).
//             hold-unread `hold` + 위쪽 「안 읽은 곳으로」 필이 서 있다 — 띠와 필이 같은 자리를 쓰는 쌓임 사진용.
//             panel       `hold` + 전면 덮개(고정 목록, 진짜 `PinListPanel`)가 열려 있다 — 덮개가 머리 **위**에 서는지 보는 사진용.
//                         대화 화면과 같은 구조: 머리·목록을 한 틀에 담고 덮개는 틀 뒤 형제.
//             panel-flat  `panel` 인데 머리·목록을 틀 없이 `Screen` 직속으로 둔다 — **되살린 결함**(머리 `zIndex` 가 덮개 위로 올라온다)의 사진용.
//
// **대화 화면이 세우는 순서 그대로** 세운다: 머리(연결 띠가 서는 자리) · 레이아웃(목록 / 도크) · 도크의 「작업 중」·
// 「작성 중」 줄 · 컴포저. 목록의 데이터는 **진짜 `useTimeline`** 이 만든다 — 서버와 소켓만 이 파일의 가짜다
// (`fetch` 는 메시지·반응·고정 읽기에 답하고, 레일은 이 파일이 구독 핸들러를 쥐고 직접 부른다). 그래서 표지·띠가 서는
// 규칙은 배송되는 코드의 것이고, 이 파일은 그 규칙에 **이벤트를 먹일 뿐**이다.
//
// 재는 것: 마지막 메시지 행의 **창 좌표 y** (`Timeline` 의 `anchorRef` seam) 를 매 프레임. 사람이 보는 것은 읽던 줄이
// 흔들리는가이고, 그 줄의 절대 위치는 어느 목록 구현에서나 같은 뜻이다(`measure/harness.tsx` 와 같은 판단).
// 목록 꼬리(`tailRef`)와 도크(컴포저 윗면)도 함께 잰다 — 도크는 움직이면 안 된다.
//
// 지표(스칼라, pt): range = 최대 − 최소 · travel = 프레임 사이 이동량(0.5pt 넘는 것)의 합 · maxStep = 한 프레임에
// 움직인 가장 큰 양 · moves = 0.5pt 넘게 움직인 프레임 수 · reversals = 방향이 뒤집힌 횟수.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000e0';
const SELF = '00000000-0000-7000-8000-0000000000e1';
const PEER = '00000000-0000-7000-8000-0000000000e2';
const CHANNEL = '00000000-0000-7000-8000-0000000000e3';
const NO_TOP = {paddingTop: 0} as const;
const DRAFT_KEY = 'measure:dm-steady';
const TARGET = {workspaceId: WS, channelId: CHANNEL};

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const SELF_MEMBER = member({id: SELF, displayName: '이도현', handle: 'dohyun'});
const PEER_MEMBER = member({id: PEER, displayName: '박서연', handle: 'seoyeon'});
const DIRECTORY = makeDirectory([SELF_MEMBER, PEER_MEMBER]);

// ---- 서버(가짜) ---------------------------------------------------------------

const BASE_MS = Date.now() - 3_600_000;

/** 가상의 대화: 달무리 스튜디오 일정 이야기. 실제 대화 문구를 쓰지 않는다. */
const HISTORY_BODIES = [
  '오늘 오후 회의는 세 시로 옮겼어요',
  '네, 확인했어요',
  '시안 파일은 공유 폴더에 올려 뒀어요',
  '지금 열어볼게요',
  '색 조합은 두 번째 안이 더 차분해 보여요',
  '맞아요, 저도 그쪽이 낫다고 생각해요',
  '그럼 두 번째 안으로 정리해서 보낼게요',
  '좋아요. 마감은 내일 오전까지죠?',
  '네, 오전 열 시까지예요',
  '알겠어요. 점심 전에 끝내 볼게요',
  '고마워요',
  '혹시 막히는 부분 있으면 말해 주세요',
  '아직은 괜찮아요',
  '그럼 이따 다시 이야기해요',
];

function wireMessage(seq: number, author: string, body: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000000f${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 60_000,
  } as Message;
}

/** 서버가 가진 메시지. 스크립트가 덧붙이고, REST 읽기는 여기서 답한다. */
const server: {messages: Message[]} = {messages: []};

function resetServer(): void {
  server.messages = HISTORY_BODIES.map((body, index) =>
    wireMessage(index + 1, index % 2 === 0 ? PEER : SELF, body),
  );
}
resetServer();

function json(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    headers: {get: () => null},
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/**
 * 이 파일이 쓰는 가짜 `fetch`. 호스트로 가는 길(싱크·Metro)은 진짜를 쓴다.
 *
 * **모듈 몸통에서 덮으면 안 된다.** Expo 의 winter 런타임은 `fetch` 를 지연 접근자로 **나중에** 다시 정의한다
 * (`installGlobal` → `defineLazyObjectProperty`): 그 뒤에 도착한 정의가 우리 것을 지워서 코어의 요청이 가짜를 건너뛰고
 * 진짜 네트워크로 나간다(실측: 첫 판에서 `https://oort.example` 이 DNS 오류로 끝났다). 그래서 첫 렌더에서 깔되 **설정 불가
 * 속성**으로 깔고, 그래도 덮이면 다시 깐다(`ensureFakeFetch`).
 */
let realFetch: typeof fetch | null = null;
let fakeFetch: typeof fetch | null = null;

export function ensureFakeFetch(): void {
  if (fakeFetch !== null && globalThis.fetch === fakeFetch) return;
  if (fakeFetch === null) {
    // 먼저 한 번 읽는다: Expo 의 fetch 폴리필은 첫 읽기에서 `Headers` 등을 깐다(`seedShell` 과 같다).
    void globalThis.Headers;
    realFetch = globalThis.fetch.bind(globalThis);
    fakeFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return (realFetch as typeof fetch)(input as RequestInfo, init);
      }
      if (url.includes('/messages')) {
        const after = /[?&]after=(\d+)/.exec(url);
        if (after !== null) {
          const seq = Number(after[1]);
          return json({messages: server.messages.filter(item => item.seq > seq)});
        }
        return json({messages: server.messages});
      }
      if (url.includes('/reactions')) return json({});
      if (url.includes('/pins')) return json({pins: []});
      return json({});
    }) as typeof fetch;
  }
  // 설정 불가로 못 박는다: 뒤늦게 도착하는 Expo 의 `installGlobal('fetch')` 는 설정 불가 속성을 보면 아무것도 안 하고 물러난다
  // (`installGlobal.ts`: `if (descriptor && !configurable) { console.error(...); return; }`). 덮이는 쪽이 아니라 **물러나게** 한다.
  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: fakeFetch,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  } catch {
    globalThis.fetch = fakeFetch;
  }
}

/** 서버 주소·네트워크 도달성 설정. 모듈 몸통에서 한 번(`surfaces.tsx`). */
export function seedSteady(): void {
  setServerBase('https://oort.example');
  const metro = String(Settings.get('RCT_jsLocation') ?? '127.0.0.1:8081');
  // 시뮬레이터의 NetInfo 는 바깥 도달성 검사에 실패해 오프라인으로 읽힌다(컴포저가 잠긴다) — 이 기기가 늘 닿는 곳으로 돌린다.
  NetInfo.configure({
    reachabilityUrl: `http://${metro}/status`,
    reachabilityTest: async () => true,
    reachabilityShouldRun: () => true,
  });
}

// ---- 레일(가짜) ---------------------------------------------------------------

type ChannelHandlers = Parameters<ChannelRail['subscribeChannel']>[2];

interface FakeRail {
  rail: ChannelRail;
  /** 이 구독의 `subscribed` — `recovered` 가 참이면 끊긴 구간을 레일이 되돌려 준 것이다. */
  subscribed: (ctx: {recovered: boolean; hasRecoveredPublications?: boolean}) => void;
  message: (message: Message) => void;
}

function createFakeRail(): FakeRail {
  let handlers: ChannelHandlers | null = null;
  const noop = () => () => {};
  const rail: ChannelRail = {
    subscribeChannel: (_ws, _channel, next) => {
      handlers = next;
      return () => {
        if (handlers === next) handlers = null;
      };
    },
    subscribeAgent: noop,
    subscribeTyping: noop,
    subscribeWorkSession: noop,
    subscribeWorkBoard: noop,
    subscribeRunEvents: noop,
  };
  return {
    rail,
    subscribed: ctx => handlers?.onSubscribed(ctx),
    message: message => {
      const event: MessageNewEvent = {
        type: 'message.new',
        v: 1,
        ts: Date.now(),
        seq: message.seq,
        payload: {
          id: message.id,
          channel_id: message.channelId,
          seq: message.seq,
          type: message.type,
          body: message.body ?? null,
          author_member_id: message.authorMemberId,
          hlc_ts: message.hlcTs,
          hlc_count: message.hlcCount,
          created_at_ms: message.createdAtMs,
        },
      } as unknown as MessageNewEvent;
      handlers?.onMessage(event);
    },
  };
}

// ---- 재기 ---------------------------------------------------------------------

interface Rect {
  y: number;
  h: number;
}

function rectOf(
  node: {measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void} | null,
): Promise<Rect | null> {
  return new Promise(resolve => {
    if (node === null) {
      resolve(null);
      return;
    }
    node.measureInWindow((_x, y, _w, h) => resolve({y, h}));
  });
}

interface Frame {
  /** 장면 시작으로부터의 ms. */
  t: number;
  anchor: number | null;
  tail: number | null;
  dock: number | null;
  offset: number | null;
  content: number | null;
  viewport: number | null;
}

interface Summary {
  n: number;
  min: number;
  max: number;
  range: number;
  travel: number;
  maxStep: number;
  moves: number;
  reversals: number;
  net: number;
}

const MOVE_EPSILON_PT = 0.5;

export function summarize(values: readonly (number | null)[]): Summary | null {
  const ys = values.filter((value): value is number => value !== null);
  if (ys.length < 2) return null;
  let travel = 0;
  let maxStep = 0;
  let moves = 0;
  let reversals = 0;
  let lastDirection = 0;
  for (let index = 1; index < ys.length; index += 1) {
    const delta = ys[index] - ys[index - 1];
    const size = Math.abs(delta);
    if (size <= MOVE_EPSILON_PT) continue;
    moves += 1;
    travel += size;
    maxStep = Math.max(maxStep, size);
    const direction = delta > 0 ? 1 : -1;
    if (lastDirection !== 0 && direction !== lastDirection) reversals += 1;
    lastDirection = direction;
  }
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: ys.length,
    min: round(min),
    max: round(max),
    range: round(max - min),
    travel: round(travel),
    maxStep: round(maxStep),
    moves,
    reversals,
    net: round(ys[ys.length - 1] - ys[0]),
  };
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type ScenarioName = 'idle' | 'peer' | 'blip' | 'outage' | 'gap' | 'hold' | 'own';
/** `hold` 는 연결 띠를 세운 채 90초 머문다 — 사진용이고 `all` 에 들지 않는다. */
const ALL: readonly ScenarioName[] = ['idle', 'peer', 'blip', 'outage', 'gap'];

interface Controls {
  setStatus: (status: RealtimeStatus) => void;
  fake: FakeRail;
  /** 서버에 메시지를 더하고(`deliver` 가 참이면 레일로도 보낸다). `author` 를 안 주면 상대의 말이다. */
  say: (body: string, deliver: boolean, author?: string) => Message;
  mark: (what: string) => void;
}

/** 4초 유예(`DISPLAY_GRACE_MS`) 뒤에 띠가 선다 — 앱의 `connectionDisplay` 가 하는 일을 시간표대로 옮긴 것이다. */
const GRACE_MS = 4_000;

async function runScenario(name: ScenarioName, c: Controls): Promise<void> {
  if (name === 'idle') {
    await wait(8_000);
    return;
  }
  if (name === 'hold') {
    c.setStatus('disconnected');
    c.mark('hold-banner');
    await wait(90_000);
    return;
  }
  if (name === 'peer') {
    for (let index = 0; index < 3; index += 1) {
      c.mark(`peer-message-${index + 1}`);
      c.say(`확인했어요, 이어서 정리할게요 (${index + 1})`, true);
      await wait(2_500);
    }
    await wait(1_000);
    return;
  }
  if (name === 'blip') {
    for (let index = 0; index < 3; index += 1) {
      // 소켓이 죽었다 곧 이어진다: 4초 유예 안이라 띠는 서지 않는다. 같은 구독이 복구돼 돌아온다(받은 것은 없다).
      c.mark(`blip-${index + 1}-resubscribed`);
      c.fake.subscribed({recovered: true, hasRecoveredPublications: false});
      await wait(14_000);
    }
    return;
  }
  if (name === 'outage') {
    for (let index = 0; index < 3; index += 1) {
      c.mark(`outage-${index + 1}-dropped`);
      await wait(GRACE_MS + 1_000);
      c.setStatus('disconnected');
      c.mark(`outage-${index + 1}-banner`);
      await wait(1_000);
      c.setStatus('connected');
      c.mark(`outage-${index + 1}-reconnected`);
      c.fake.subscribed({recovered: false});
      await wait(12_000);
    }
    return;
  }
  if (name === 'own') {
    for (let index = 0; index < 2; index += 1) {
      // (a) 되쏘기: 같은 구독이 복구돼 돌아오며 끊긴 사이 내가 보낸 두 줄이 실려 온다(`subscribed` 직후 같은 틱에 flush).
      c.mark(`own-${index + 1}-replay`);
      c.fake.subscribed({recovered: true, hasRecoveredPublications: true});
      c.say(`제가 보낸 말이에요 (${index + 1}-가)`, true, SELF);
      c.say(`제가 보낸 말이에요 (${index + 1}-나)`, true, SELF);
      await wait(14_000);
      // (b) 꼬리 읽기: 소켓이 끊긴 사이 서버만 아는 내 두 줄을, 이어진 뒤 REST 가 가져온다.
      c.mark(`own-${index + 1}-dropped`);
      await wait(GRACE_MS + 1_000);
      c.setStatus('disconnected');
      c.say(`제가 보낸 말이에요 (${index + 1}-다)`, false, SELF);
      c.say(`제가 보낸 말이에요 (${index + 1}-라)`, false, SELF);
      await wait(1_000);
      c.setStatus('connected');
      c.mark(`own-${index + 1}-reconnected`);
      c.fake.subscribed({recovered: false});
      await wait(14_000);
    }
    return;
  }
  // gap: 끊긴 사이 상대가 한 줄을 보냈고, 이어진 뒤 REST 가 그 한 줄을 가져온다.
  for (let index = 0; index < 2; index += 1) {
    c.mark(`gap-${index + 1}-dropped`);
    await wait(GRACE_MS + 1_000);
    c.setStatus('disconnected');
    c.say(`연결이 끊겨 있는 동안 보낸 말이에요 (${index + 1})`, false);
    await wait(1_000);
    c.setStatus('connected');
    c.mark(`gap-${index + 1}-reconnected`);
    c.fake.subscribed({recovered: false});
    await wait(14_000);
  }
}

interface Result {
  scenario: ScenarioName;
  durationMs: number;
  frames: number;
  anchor: Summary | null;
  tail: Summary | null;
  dock: Summary | null;
  content: Summary | null;
  viewport: Summary | null;
  events: {t: number; what: string}[];
}

export function SteadySurface({which}: {which: string}): React.JSX.Element {
  // `hold-unread`: 같은 `hold` 장면에 안 읽은 줄이 있는 대화(위쪽 필이 서는 대화)로 연다.
  const unread = which === 'hold-unread';
  const panelOpen = which === 'panel' || which === 'panel-flat';
  const scenarios: readonly ScenarioName[] = unread || panelOpen
    ? ['hold']
    : (ALL as readonly string[]).includes(which) || which === 'hold' || which === 'own'
      ? [which as ScenarioName]
      : ALL;
  ensureFakeFetch();
  const fake = useRef<FakeRail | null>(null);
  if (fake.current === null) fake.current = createFakeRail();
  const [status, setStatus] = useState<RealtimeStatus>('connected');
  // 대화 화면과 같은 배선: 뜬 띠의 높이를 머리가 알리고, 목록의 위쪽 필이 그 밑에 쌓인다.
  const [bannerInset, setBannerInset] = useState(0);
  const timeline = useTimeline(fake.current.rail, WS, CHANNEL, SELF);
  const anchorRef = useRef<View | null>(null);
  const tailRef = useRef<View | null>(null);
  const dockRef = useRef<View | null>(null);
  const metricsRef = useRef<TimelineGeometry | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const [report, setReport] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  // 지켜본다: 늦게 도착한 `fetch` 정의가 우리 가짜를 덮으면 다시 깐다.
  useEffect(() => {
    const id = setInterval(ensureFakeFetch, 250);
    return () => clearInterval(id);
  }, []);
  const startedRef = useRef(false);
  // 앱과 같은 박자의 시계(분 단위). 매 렌더의 `Date.now()` 를 먹이면 목록이 하네스의 렌더마다 다시 그려져 재는 대상이 달라진다.
  const nowMs = useNow();
  // 재는 행: 장면이 시작될 때의 가장 새 메시지. 장면 안에서 자라는 만큼은 그 행이 밀려 올라가는 것으로 보인다.
  const [anchorSeq, setAnchorSeq] = useState(HISTORY_BODIES.length);
  const loadOlder = timeline.loadOlder;
  const onStartReached = useCallback(() => void loadOlder(), [loadOlder]);

  useState(() => {
    clearDraft(DRAFT_KEY);
    return null;
  });

  // 첫 구독: 레일은 이 파일이 쥐고 있으므로 머리 페이지가 온 뒤에 구독이 됐다고 알린다.
  useEffect(() => {
    if (timeline.status !== 'ready') return;
    fake.current?.subscribed({recovered: false});
  }, [timeline.status]);

  useEffect(() => {
    if (timeline.status !== 'ready' || startedRef.current) return undefined;
    startedRef.current = true;
    let cancelled = false;
    const sink = Settings.get('momoGapSink');
    const lines: string[] = [];
    const nextSeq = {value: HISTORY_BODIES.length + 1};
    void (async () => {
      // 진입 수렴(목록이 끝에 앉는 데 걸리는 시간)이 끝나도록 기다린다.
      await wait(4_000);
      for (const name of scenarios) {
        if (cancelled) return;
        // 이 장면이 재는 행을 지금 가장 새 메시지로 옮기고, 표식이 붙을 때까지 기다린다.
        setAnchorSeq(server.messages[server.messages.length - 1]?.seq ?? 0);
        await wait(800);
        const frames: Frame[] = [];
        const events: {t: number; what: string}[] = [];
        const begin = Date.now();
        let sampling = true;
        const sample = () => {
          if (!sampling) return;
          const frame: Frame = {
            t: Date.now() - begin,
            anchor: null,
            tail: null,
            dock: null,
            offset: metricsRef.current?.offsetY ?? null,
            content: metricsRef.current?.contentHeight ?? null,
            viewport: metricsRef.current?.viewportHeight ?? null,
          };
          frames.push(frame);
          void rectOf(anchorRef.current).then(rect => {
            frame.anchor = rect === null ? null : rect.y + rect.h;
          });
          void rectOf(tailRef.current).then(rect => {
            frame.tail = rect === null ? null : rect.y;
          });
          void rectOf(dockRef.current).then(rect => {
            frame.dock = rect === null ? null : rect.y;
          });
          requestAnimationFrame(sample);
        };
        const controls: Controls = {
          setStatus,
          fake: fake.current as FakeRail,
          say: (body, deliver, author = PEER) => {
            const seq = nextSeq.value;
            nextSeq.value += 1;
            const message = wireMessage(seq, author, body);
            message.createdAtMs = Date.now();
            server.messages.push(message);
            if (deliver) (fake.current as FakeRail).message(message);
            return message;
          },
          mark: what => events.push({t: Date.now() - begin, what}),
        };
        requestAnimationFrame(sample);
        await runScenario(name, controls);
        sampling = false;
        await wait(200);
        const result: Result = {
          scenario: name,
          durationMs: Date.now() - begin,
          frames: frames.length,
          anchor: summarize(frames.map(frame => frame.anchor)),
          tail: summarize(frames.map(frame => frame.tail)),
          dock: summarize(frames.map(frame => frame.dock)),
          content: summarize(frames.map(frame => frame.content)),
          viewport: summarize(frames.map(frame => frame.viewport)),
          events,
        };
        console.log(`STEADY4292 ${JSON.stringify(result)}`);
        if (typeof sink === 'string' && sink !== '') {
          try {
            await fetch(`http://${sink}/steady`, {
              method: 'POST',
              body: JSON.stringify({...result, trace: frames}),
            });
          } catch {
            // 받는 쪽이 없으면 로그만 남는다. 계측이 앱을 죽이지 않는다.
          }
        }
        const a = result.anchor;
        lines.push(
          `${name.padEnd(7)} range ${a?.range ?? '-'} · travel ${a?.travel ?? '-'} · maxStep ${a?.maxStep ?? '-'} · moves ${a?.moves ?? '-'} · rev ${a?.reversals ?? '-'} · dock ${result.dock?.range ?? '-'} (${result.frames}f)`,
        );
        setReport([...lines]);
      }
      lines.push('끝');
      setReport([...lines]);
      setFinished(true);
      console.log('STEADY4292 DONE');
    })();
    return () => {
      cancelled = true;
    };
    // 한 번만 돈다: 장면표는 마운트 때의 값이고, 도중에 다시 시작하면 측정이 겹친다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.status]);

  return (
    <Screen style={NO_TOP}>
      {/* 대화 화면과 같은 구조: 머리 · 목록을 한 틀에 담아 머리의 `zIndex` 가 틀 안에서만 겨루게 한다(`panel-flat` 만 틀이 없다). */}
      <Frame flat={which === 'panel-flat'}>
      <ConversationHeader
        title="박서연"
        kind="dm"
        peerId={PEER}
        directory={DIRECTORY}
        onBack={() => {}}
        menu={[{label: '고정', run: () => {}}]}
        railStatus={status}
        onBannerInset={setBannerInset}
      />
      <ConversationLayout
        list={
          <Timeline
            messages={timeline.state.messages}
            directory={DIRECTORY}
            status={timeline.status}
            channelKind="dm"
            myMemberId={SELF}
            nowMs={nowMs}
            recoveryMarkers={timeline.recoveryMarkers}
            lastReadSeq={unread ? 1 : null}
            unreadCount={unread ? HISTORY_BODIES.length - 1 : 0}
            pending={timeline.pending}
            reactions={timeline.reactions}
            pins={timeline.pins}
            loadingOlder={timeline.loadingOlder}
            reachedStart={timeline.reachedStart}
            onStartReached={onStartReached}
            onRetry={timeline.reload}
            channelId={CHANNEL}
            jumpPills
            tailGap={CONV.conversationTail}
            topPillInset={bannerInset}
            anchorSeq={anchorSeq}
            anchorRef={anchorRef}
            tailRef={tailRef}
            metricsRef={metricsRef}
          />
        }
        composer={
          <View ref={dockRef} collapsable={false}>
            <AgentActivityBar turns={[]} directory={DIRECTORY} nowMs={nowMs} live />
            <TypingBar segments={typingSegments([])} label={null} />
            <Composer
              recipient="person"
              channelLabel="박서연"
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              attachmentTarget={TARGET}
              inputRef={inputRef}
              onSend={() => {}}
            />
          </View>
        }
      />
      </Frame>
      {panelOpen ? (
        <PinListPanel
          pins={timeline.pins}
          status={timeline.pinsStatus}
          directory={DIRECTORY}
          nowMs={nowMs}
          onJump={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[styles.reportLayer, finished ? styles.reportShown : styles.reportHidden]}>
        {report.map((line, index) => (
          <Text key={index} style={styles.reportLine}>
            {line}
          </Text>
        ))}
      </View>
    </Screen>
  );
}

/**
 * 머리 · 목록의 틀. 대화 화면과 같게 **실제 네이티브 뷰**(`collapsable={false}`)로 세워 머리의 `zIndex` 가 틀 안에서만 겨루게 한다.
 * `flat` 이면 틀 없이 자식을 `Screen` 직속으로 둔다 — 되살린 결함(머리 `zIndex` 가 전면 덮개 위로 올라온다)의 사진용이다.
 */
function Frame({flat, children}: {flat: boolean; children: React.ReactNode}): React.JSX.Element {
  return flat ? (
    <>{children}</>
  ) : (
    <View collapsable={false} style={styles.column}>
      {children}
    </View>
  );
}

// 장면이 끝나면 맨 위에 서는 결과 줄(화면 캡처용). 측정 대상 레이아웃 밖에서 손을 받지 않는다.
const styles = StyleSheet.create({
  column: {flex: 1},
  reportLayer: {position: 'absolute', left: 12, right: 12, bottom: 150},
  reportShown: {opacity: 0.92},
  reportHidden: {opacity: 0},
  reportLine: {fontSize: 11, color: '#fff', backgroundColor: '#000a', padding: 2},
});

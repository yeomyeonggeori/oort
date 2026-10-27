import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import type {ReactionMap} from '@momo/core/features/timeline/reactions';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, Dimensions, PixelRatio, Settings, StyleSheet, Text, View} from 'react-native';
import type {GestureResponderEvent} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {clearDraft} from '../src/features/conversation/drafts';
import type {MessageRowActions} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import type {PillState, ScrollLogEntry, TimelineGeometry} from '../src/features/conversation/Timeline';

// =============================================================================
// 「최신 메시지로 이동」 알약(아래 알약, `jump-latest`)을 **멀리서** 눌렀을 때의 계측 표면 (#4689).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure JUMP-LATEST[+<FLAGS>] \
//        -RCT_jsLocation 127.0.0.1:<metro> -momoGapSink 127.0.0.1:<port>
//   (라이트: LIGHT-JUMP-LATEST…; `-momoGapSink` 는 `measure/gap-sink.mjs` 가 받는다 — 없으면 로그만 남는다)
//   구동은 `measure/run-jump-latest.sh`, 누름은 `maestro/119-jump-latest.yaml`, 분석은 `measure/jump-latest-windows.mjs`.
//
//   FLAGS (`+` 로 겹친다)
//     n120 · n300 · n<행 수>   방의 메시지 수(기본 300). seq 1..N, 가변 높이(1~5줄)·네 사람·며칠 치(날짜 구분선).
//     r1 · r2 · r<횟수>        거리마다 반복할 횟수(기본 3). 한 번 실행에 시험은 (거리 수 × 횟수)번이다.
//     dnear · d3scr · dhalf · dtop   이 거리만 시험한다(여럿 가능). 없으면 네 거리 전부.
//     paged    앱처럼 **50행씩** 부른다(`useTimeline` 의 `HEAD_LIMIT`·`PAGE_LIMIT` = 50) — 처음엔 맨 끝 50행(`reachedStart=false`)이고, 위로 올라 `onStartReached` 가 불리면 120ms 뒤 앞 50행이 앞에 붙는다.
//              기본(`full`)은 N 행이 처음부터 다 있다(`reachedStart`). **멀리서 눌렀을 때 여러 홉이 나는 것은 `paged` 쪽이다**(full 은 대개 한 홉) — 실측은 #4689 계측 노트.
//     arrive   올라가 있는 동안 남의 메시지 3통이 도착한다(아직 안 잰 꼬리 행) — 그 뒤에 누른다.
//     fast     더 세게 올린다(플릭 간격 350ms·초기 속도 9000pt/s). 기본은 사람의 플릭(700ms·6000pt/s).
//
// 시험 한 번(= 새로 마운트한 목록 하나)의 순서:
//   ① 진입: 목록을 **새로** 세운다(`key`). `pillsRef.settled` 이고 콘텐츠 높이가 1초 안 변하고 끝까지 ≤2pt 일 때까지 기다린다.
//   ② 사람이 올라가듯 올린다: `scrollToOffset({animated:false})` 를 16ms 마다, 플릭(속도가 지수로 줄어드는 밀기)을 700ms 마다 더하며 목표까지.
//        가까움  끝에서 창 높이의 0.6배   ·  3화면  끝에서 창 높이의 3배
//        중간    전체의 50% 위(= seq N/2 가 창에 들어올 때까지)  ·  맨 위 근처  전체의 90% 위(= seq N/10)
//      (먼 둘은 **그 행이 창에 들어올 때까지** 올린다 — `anchorSeq`/`anchorRef`. 목록의 높이 추정이 아니라 행을 기준으로 해서 `paged` 에서도 같은 뜻이다. 행이 보이기 시작하면 관성을 버리고
//       그 행의 창 좌표를 보며 **양쪽으로** 창 윗변에서 35% 자리에 앉힌다 — 위 끝에서 옛 페이지가 연달아 붙어 행이 아래로 밀리면 사람처럼 되돌아 내려온다. `ascend` 주석.)
//   ③ 0.8초 쉰 뒤 화면 맨 위 표식(`jlat-phase`)을 `ARMED <k>` 로 켠다. 이때 `anchorSeq` 는 **마지막 seq** 다.
//   ④ Maestro 가 `jump-latest` 알약을 **진짜로** 누른다.
//   ⑤ 알약이 사라지는 렌더(`pillsRef.latest` true→false) = 누름 시각. 그 순간부터 프레임(rAF)마다: 스크롤 기하(`metricsRef`)·알약·마지막 행의 창 좌표(`anchorRef`)·꼬리 이음매의 창 좌표(`tailRef`).
//      스크롤 보고 전부(`scrollLogRef`)·`chasingTail` 전이도 함께. 끝: 끝까지 남은 거리 ≤1pt 가 1.2초 유지되거나 누른 지 6초.
//   ⑥ 기록을 싱크로 보낸다(`/jump`) → `DONE <k>`(다음 시험의 ARMED 직전까지 남는다). 다음 시험은 새 목록이라 이전 시험의 잴 수 없는 것이 이어지지 않는다.
//      올림 뒤 알약이 안 서 있거나(드묾) 진입이 안 앉으면 그 목록을 버리고 새로 세운다(기록의 `skipped`·`entry.retries`). 올림이 목표에 못 닿았으면 `ascent.ok=false` — 분석기가 중앙값에서 뺀다.
//
// **이 표면은 `Timeline.tsx` 를 건드리지 않는다** — 읽는 것은 전부 `Timeline` 이 원래 내는 측정 seam(`listRef`·`metricsRef`·`scrollLogRef`·`pillsRef`·`anchorRef`·`tailRef`)이다.
// 전부 지어낸 인물·문구다(달무리 스튜디오는 가상의 회사).
// =============================================================================

const WS = '00000000-0000-7000-8000-000000004680';
const SELF = '00000000-0000-7000-8000-000000004681';
const PEER_A = '00000000-0000-7000-8000-000000004682';
const PEER_B = '00000000-0000-7000-8000-000000004683';
const PEER_C = '00000000-0000-7000-8000-000000004684';
const CHANNEL = 'jump-latest-capture';
const DRAFT_KEY = 'measure:jump-latest';
const NO_TOP = {paddingTop: 0} as const;
const NOOP = () => {};
const MENU = [{label: '고정', run: NOOP}] as const;
const NO_PENDING: PendingMessage[] = [];
const NO_REACTIONS: ReactionMap = {};

const styles = StyleSheet.create({
  fill: {flex: 1},
  phaseBox: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 999},
  phaseText: {fontSize: 9, lineHeight: 11, color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.65)'},
});

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

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: PEER_A, displayName: '이도현', handle: 'dohyun'}),
  member({id: PEER_B, displayName: '최민수', handle: 'minsu'}),
  member({id: PEER_C, displayName: '정하윤', handle: 'hayun'}),
]);
const PEOPLE = [PEER_A, SELF, PEER_B, PEER_C] as const;
/** `arrive` 로 도착하는 세 통은 모두 남의 글이다(내 글이면 아래 알약이 세지 않는다). */
const OTHERS = [PEER_A, PEER_C, PEER_B] as const;

// ---- 방 (고정 씨앗이라 실행마다 같다) -----------------------------------------------------

/* eslint-disable no-bitwise -- 32비트 정수 해시(mulberry32)라 비트 연산이 본문이다. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable no-bitwise */

/** 한 줄에 드는 짧은 말. */
const SHORT = [
  '네 확인했어요',
  '좋아요',
  '감사합니다',
  '바로 볼게요',
  '오 괜찮네요',
  '그렇게 해요',
  '알겠어요',
  '잠깐만요',
  '넵 완료했어요',
  '수고하셨어요',
  '지금 올릴게요',
  '내일 봐요',
  '확인 부탁드려요',
] as const;
/** 한 줄이 넘는 말(폰 폭에서 한 줄 반쯤). */
const CLAUSES = [
  '오전 회의에서 나온 시안 두 가지를 비교해 봤어요',
  '달무리 스튜디오 쪽 일정은 그대로 가도 괜찮아 보여요',
  '공유 폴더에 최신 버전을 올려 뒀으니 한 번 봐 주세요',
  '견적서는 내일 오전까지 정리해서 남길게요',
  '색상 대비가 조금 약한 부분은 다시 손볼게요',
  '발표 자료 순서를 바꾸는 게 더 자연스러울 것 같아요',
  '고객 인터뷰 내용은 요약해서 따로 공유할게요',
  '이번 주 금요일까지는 문제없이 끝날 것 같아요',
  '일정이 하루 정도 밀릴 수 있어서 미리 말씀드려요',
  '담당자와 이야기해 보고 결과를 알려 드릴게요',
  '회의록은 제가 정리해서 오후에 올려 둘게요',
  '촬영 장소는 두 곳으로 좁혔고 내일 최종 결정해요',
  '예산 항목 중에서 빠진 것이 있는지 확인 부탁드려요',
  '수정 사항은 댓글로 남겨 주시면 바로 반영할게요',
  '워크숍 참석 인원은 열두 명으로 확정됐어요',
  '채용 공고 문구는 조금 더 부드럽게 바꿨어요',
  '계약서 초안은 검토를 거쳐서 다시 보낼게요',
  '다음 주 월요일 오전 열 시에 다시 모여요',
] as const;

/** 줄 수 1~5 의 분포(1줄이 가장 흔하다). */
const LINE_WEIGHTS = [30, 28, 20, 12, 10] as const;

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)];
}

function bodyOf(random: () => number): string {
  let roll = random() * 100;
  let lines = 1;
  for (let index = 0; index < LINE_WEIGHTS.length; index += 1) {
    if (roll < LINE_WEIGHTS[index]) {
      lines = index + 1;
      break;
    }
    roll -= LINE_WEIGHTS[index];
  }
  if (lines === 1) return pick(SHORT, random);
  // 절반은 글이 스스로 접히는 줄(긴 말), 절반은 사람이 엔터로 끊은 줄(짧은 말 여럿).
  if (random() < 0.5) {
    const clauses = [0, 0, 1, 2, 3, 4][lines];
    const parts: string[] = [];
    for (let index = 0; index < clauses; index += 1) parts.push(pick(CLAUSES, random));
    if (lines === 2) parts.push(pick(SHORT, random));
    return parts.join(' ');
  }
  const parts: string[] = [];
  for (let index = 0; index < lines; index += 1) parts.push(pick(SHORT, random));
  return parts.join('\n');
}

const MINUTE = 60_000;
const NOW = Date.now();

/** seq 1..total. 같은 사람이 이어 쓰는 묶음·며칠에 걸친 간격(날짜 구분선)이 섞인다. 마지막 글은 NOW 의 2분 전. */
function buildRoom(total: number): Message[] {
  const random = mulberry32(4689);
  const rows: Message[] = [];
  let author = 0;
  let sinceDay = 0;
  const gaps: number[] = [];
  for (let seq = 1; seq <= total; seq += 1) {
    const same = seq > 1 && random() < 0.4;
    if (!same) author = (author + 1 + Math.floor(random() * 3)) % PEOPLE.length;
    sinceDay += 1;
    // 묶음 안은 20~120초, 사람이 바뀌면 3~50분, 대략 35±10 행마다 밤을 넘는다(7~10시간).
    let gap = same ? (20 + random() * 100) * 1000 : (3 + random() * 47) * MINUTE;
    if (sinceDay > 25 + Math.floor(random() * 20)) {
      gap = (7 + random() * 3) * 60 * MINUTE;
      sinceDay = 0;
    }
    gaps.push(gap);
    rows.push({
      id: `00000000-0000-7000-8000-4689${seq.toString(16).padStart(8, '0')}`,
      channelId: CHANNEL,
      seq,
      hlcTs: seq,
      hlcCount: 0,
      authorMemberId: PEOPLE[author],
      type: 'text',
      body: bodyOf(random),
      state: 'sent',
      createdAtMs: 0,
    } as Message);
  }
  let at = NOW - 2 * MINUTE;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    rows[index] = {...rows[index], createdAtMs: at};
    at -= gaps[index];
  }
  return rows;
}

// ---- 표식 (화면 맨 위 한 줄) --------------------------------------------------------------
// Maestro 는 계층에 보이는 글만 읽는다. 한 줄만 다시 그려지도록 모듈 저장소로 두고, 목록·입력창은 이 줄 때문에 다시 그려지지 않는다.
let phaseText = 'PREP 0';
const phaseListeners = new Set<() => void>();
function setPhase(text: string): void {
  phaseText = text;
  phaseListeners.forEach(listener => listener());
}

function PhaseLabel(): React.JSX.Element {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump(count => count + 1);
    phaseListeners.add(listener);
    return () => {
      phaseListeners.delete(listener);
    };
  }, []);
  return (
    <View pointerEvents="none" style={styles.phaseBox}>
      <Text style={styles.phaseText} testID="jlat-phase">
        {phaseText}
      </Text>
    </View>
  );
}

// ---- 설정 ---------------------------------------------------------------------------------

type DistanceLabel = 'near' | '3scr' | 'half' | 'top';
interface DistanceSpec {
  label: DistanceLabel;
  /** `pt`: 끝에서 창 높이의 `viewports` 배만큼. `seq`: seq 가 `targetSeq` 인 행이 창에 들어올 때까지. */
  kind: 'pt' | 'seq';
  viewports?: number;
  /** 위로 올라갈 비율(전체 행 수의). */
  frac?: number;
}
const ALL_DISTANCES: DistanceSpec[] = [
  {label: 'near', kind: 'pt', viewports: 0.6},
  {label: '3scr', kind: 'pt', viewports: 3},
  {label: 'half', kind: 'seq', frac: 0.5},
  {label: 'top', kind: 'seq', frac: 0.9},
];

interface Config {
  rows: number;
  repeats: number;
  paged: boolean;
  arrive: boolean;
  fast: boolean;
  distances: DistanceSpec[];
  flags: string[];
}

const PAGE = 50;
const ARRIVALS = 3;

function parseFlags(which: string): Config {
  const flags = which.split('+').filter(flag => flag !== '');
  let rows = 300;
  let repeats = 3;
  const only = new Set<string>();
  for (const flag of flags) {
    const n = /^n(\d+)$/.exec(flag);
    if (n) rows = Math.max(PAGE, Number(n[1]));
    const r = /^r(\d+)$/.exec(flag);
    if (r) repeats = Math.max(1, Number(r[1]));
    const d = /^d(near|3scr|half|top)$/.exec(flag);
    if (d) only.add(d[1]);
  }
  return {
    rows,
    repeats,
    paged: flags.includes('paged'),
    arrive: flags.includes('arrive'),
    fast: flags.includes('fast'),
    distances: only.size === 0 ? ALL_DISTANCES : ALL_DISTANCES.filter(spec => only.has(spec.label)),
    flags,
  };
}

// ---- 재기 ---------------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Measurable = {measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void};

function rectOf(node: Measurable | null): Promise<Rect | null> {
  return new Promise(resolve => {
    if (node === null) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, w, h) => resolve({x, y, w, h}));
  });
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const round1 = (value: number) => Math.round(value * 10) / 10;

interface Frame {
  /** `Date.now()` — 스크롤 기록(`scrollLogRef`)의 `t` 와 같은 시계. */
  t: number;
  y: number | null;
  c: number | null;
  v: number | null;
  /** `pillsRef.latest` — 아래 알약이 서 있는가. */
  pill: boolean | null;
  /** 마지막 행(anchorSeq)의 창 좌표 윗변·아랫변 — 행이 마운트돼 있지 않으면 null. */
  at: number | null;
  ab: number | null;
  /** 꼬리 이음매(`tailRef`)의 창 y — 언제나 마운트돼 있다. */
  tl: number | null;
}

interface TrialTouch {
  begin: number;
  touchStart: number | null;
  touchEnd: number | null;
  x: number | null;
  y: number | null;
}

type Sink = (record: Record<string, unknown>) => Promise<void>;

function makeSink(): Sink {
  const sink = Settings.get('momoGapSink');
  return async record => {
    // 요약만 로그로 — 흔적(trace)·스크롤 기록은 싱크에만 간다.
    const {trace, scrollLog, ...summary} = record as {trace?: unknown[]; scrollLog?: unknown[]} & Record<string, unknown>;
    console.log(`JUMP4689 ${JSON.stringify({...summary, frames: trace?.length, scrolls: scrollLog?.length})}`);
    if (typeof sink !== 'string' || sink === '') return;
    try {
      await fetch(`http://${sink}/jump`, {method: 'POST', body: JSON.stringify(record)});
    } catch {
      // 받는 쪽이 없으면 로그만 남는다. 계측이 앱을 죽이지 않는다.
    }
  };
}

type ListHandle = {scrollToOffset: (options: {offset: number; animated: boolean}) => void};

// 사람의 플릭: 속도(pt/s)는 iOS 기본 감속(ms 당 0.998 배)로 줄고, `flickEvery` 마다 `v0` 가 더해진다(`vMax` 까지).
const DECAY_PER_MS = 0.998;
const HUMAN = {flickEvery: 700, v0: 6000, vMax: 9000};
const FAST = {flickEvery: 350, v0: 9000, vMax: 14000};
const ASCENT_MAX_MS = 60_000;
const REST_MS = 800;
const SETTLE_QUIET_MS = 1000;
const SETTLE_MAX_MS = 15_000;
/** 진입이 안 앉으면(드물게 — 24건 중 2건) 새 목록으로 다시 시작한다. */
const ENTRY_RETRIES = 2;
/** 알약이 안 선 시험을 버리고 다시 세우는 최대 횟수(처음 포함). */
const MAX_ATTEMPTS = 3;
const PRESS_TIMEOUT_MS = 6000;
const LAND_HOLD_MS = 1200;
const NO_PRESS_MS = 300_000;
/** 마지막 행의 아랫변이 목록 창 아래 가장자리에서 이만큼까지 벗어나도 「창 안」이다 — 끝에 앉은 행은 꼬리 이음매(높이 0)와 ±1pt 안에서 떤다(실측 0.3~0.7pt). */
const VISIBLE_TOL_PT = 2;

export function JumpLatestSurface({which}: {which: string}): React.JSX.Element {
  const config = useMemo(() => parseFlags(which), [which]);
  const room = useMemo(() => buildRoom(config.rows + ARRIVALS), [config.rows]);
  const base = useMemo(() => room.slice(0, config.rows), [room, config.rows]);
  const initialMessages = useCallback(() => (config.paged ? base.slice(-PAGE) : base), [config.paged, base]);

  const [trialKey, setTrialKey] = useState(0);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [reachedStart, setReachedStart] = useState(!config.paged);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [anchorSeq, setAnchorSeq] = useState<number | undefined>(undefined);

  const listRef = useRef<ListHandle | null>(null);
  const metricsRef = useRef<TimelineGeometry | null>(null);
  const pillsRef = useRef<PillState | null>(null);
  const scrollLogRef = useRef<ScrollLogEntry[] | null>(null);
  const anchorRef = useRef<View | null>(null);
  const tailRef = useRef<View | null>(null);
  const boxRef = useRef<View | null>(null);
  const renderedKeyRef = useRef(0);
  const trialRef = useRef<TrialTouch | null>(null);
  const oldestRef = useRef(config.paged ? config.rows - PAGE + 1 : 1);
  const loadingRef = useRef(false);
  const sinkRef = useRef<Sink | null>(null);
  if (sinkRef.current === null) sinkRef.current = makeSink();

  useState(() => {
    clearDraft(DRAFT_KEY);
    return null;
  });

  // 새 목록이 **그려진 뒤**에야 진입 판정을 읽는다(앞 목록의 `settled` 를 새 것으로 착각하지 않게).
  useEffect(() => {
    renderedKeyRef.current = trialKey;
  }, [trialKey]);

  // `paged`: 앱처럼 위로 닿으면 앞 50행을 부른다(120ms 뒤 도착).
  const onStartReached = useCallback(() => {
    if (loadingRef.current || oldestRef.current <= 1) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    const from = Math.max(1, oldestRef.current - PAGE);
    const to = oldestRef.current;
    setTimeout(() => {
      const page = base.filter(row => row.seq >= from && row.seq < to);
      oldestRef.current = from;
      loadingRef.current = false;
      setMessages(previous => [...page, ...previous]);
      setLoadingOlder(false);
      setReachedStart(from <= 1);
    }, 120);
  }, [base]);

  const actions = useRef<MessageRowActions>({
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    onOpenThread: NOOP,
    onOpenProfile: NOOP,
  }).current;

  const onTouchStart = useCallback((event: GestureResponderEvent) => {
    const trial = trialRef.current;
    if (trial === null || trial.touchStart !== null) return;
    trial.touchStart = Date.now();
    trial.x = Math.round(event.nativeEvent.pageX);
    trial.y = Math.round(event.nativeEvent.pageY);
  }, []);
  const onTouchEnd = useCallback(() => {
    const trial = trialRef.current;
    if (trial === null || trial.touchStart === null || trial.touchEnd !== null) return;
    trial.touchEnd = Date.now();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sink = sinkRef.current as Sink;
    const tuning = config.fast ? FAST : HUMAN;
    const lastSeq = config.rows + (config.arrive ? ARRIVALS : 0);

    // 읽는 쪽은 함수로 — 위에서 `null` 로 비운 뒤의 제어 흐름이 값을 `null` 로 굳히지 않게(값은 `Timeline` 이 채운다).
    const geometry = () => metricsRef.current;
    const pillsNow = () => pillsRef.current;
    const leftOf = (g: TimelineGeometry | null) => (g === null ? null : g.contentHeight - (g.offsetY + g.viewportHeight));

    /** 새 목록을 세우고, 진입(목록이 바닥에 앉음)이 끝날 때까지 기다린다. */
    async function prepare(): Promise<{settled: boolean; waitedMs: number; content: number | null; left: number | null}> {
      // 표식은 **바꾸지 않는다**: 앞 시험의 `DONE <k-1>` 이 새 목록이 앉아 `ARMED <k>` 가 될 때까지 남아야 Maestro 의 「DONE 을 기다린다」가 놓치지 않는다(첫 시험은 `PREP 0`).
      loadingRef.current = false;
      oldestRef.current = config.paged ? config.rows - PAGE + 1 : 1;
      metricsRef.current = null;
      pillsRef.current = null;
      scrollLogRef.current = null;
      trialRef.current = null;
      setAnchorSeq(undefined);
      setMessages(initialMessages());
      setReachedStart(!config.paged);
      setLoadingOlder(false);
      const next = renderedKeyRef.current + 1;
      setTrialKey(next);
      const started = Date.now();
      while (!cancelled && renderedKeyRef.current !== next) await wait(20);
      let lastContent = -1;
      let lastChangeAt = Date.now();
      while (!cancelled) {
        await wait(50);
        const g = geometry();
        const now = Date.now();
        if (g !== null && g.contentHeight > 0 && g.viewportHeight > 0) {
          if (Math.abs(g.contentHeight - lastContent) > 0.5) {
            lastContent = g.contentHeight;
            lastChangeAt = now;
          }
          const left = leftOf(g);
          if (
            pillsNow()?.settled === true &&
            now - lastChangeAt >= SETTLE_QUIET_MS &&
            left !== null &&
            Math.abs(left) <= 2
          ) {
            return {settled: true, waitedMs: now - started, content: g.contentHeight, left};
          }
        }
        if (now - started > SETTLE_MAX_MS) {
          return {settled: false, waitedMs: now - started, content: g?.contentHeight ?? null, left: leftOf(g)};
        }
      }
      return {settled: false, waitedMs: Date.now() - started, content: null, left: null};
    }

    /**
     * 사람이 올라가듯 올린다. 끝났는가(`true`)·시간 초과(`false`).
     *
     * 가까운 둘(`pt`)은 목표 오프셋까지 플릭을 이어 올린다. 먼 둘(`seq`)은 **그 행이 창에 들어올 때까지**: 행이 마운트되기 전에는 플릭을 이어 올리고(`paged` 면 위 끝에서 옛 페이지를 기다린다),
     * 행이 보이기 시작하면 관성을 버리고 **행의 창 좌표를 보며 양쪽으로 조정**한다 — 사람이 지나쳤다가 되돌아오는 것과 같다. 첫 판은 위로만 갔고, 옛 페이지가 연달아 붙는 동안 목표 행(seq N/2)을 지나쳐
     * 위 끝에 선 채 60~90초를 보냈다(2026-10-28, paged half 12건 중 2건·24건 중 3건).
     */
    async function ascend(
      spec: DistanceSpec,
      targetSeq: number | null,
    ): Promise<{ok: boolean; ms: number; steps: number; trace: number[][]}> {
      const started = Date.now();
      let v = 0;
      let lastFlick = -1e9;
      let last = started;
      let steps = 0;
      let lastNudge = 0;
      let nudgedOut = false;
      let lastTrace = 0;
      let steady = 0;
      /** 올리는 동안의 흔적 [경과 ms, 오프셋, 콘텐츠, 목표 행의 창 y(없으면 -1), 부른 가장 앞 seq] — 100ms 마다. 올림이 어디서 멈췄는지 본다. */
      const trace: number[][] = [];
      const startG = geometry();
      const startOffset = startG?.offsetY ?? 0;
      const targetOffset = spec.kind === 'pt' ? startOffset - (spec.viewports as number) * (startG?.viewportHeight ?? 0) : null;
      // 응답은 비동기라 객체에 담는다(클로저가 바꾸는 값을 제어 흐름이 `null` 로 굳히지 않게).
      const anchor: {top: number | null; last: number | null; descending: boolean} = {top: null, last: null, descending: false};
      const box = await rectOf(boxRef.current);
      if (spec.kind === 'seq' && targetSeq !== null) setAnchorSeq(targetSeq);
      const done = (ok: boolean) => ({ok, ms: Date.now() - started, steps, trace});
      while (!cancelled) {
        await wait(16);
        const now = Date.now();
        if (now - started > ASCENT_MAX_MS) return done(false);
        const g = geometry();
        if (g === null) continue;
        const dt = now - last;
        last = now;
        if (now - lastTrace >= 100) {
          lastTrace = now;
          trace.push([now - started, round1(g.offsetY), round1(g.contentHeight), anchor.top === null ? -1 : round1(anchor.top), oldestRef.current]);
        }
        if (spec.kind === 'seq' && box !== null) {
          // 행이 마운트돼 있을 때만 대답한다 — 멀리서는 null.
          void rectOf(anchorRef.current).then(rect => {
            anchor.top = rect === null ? null : rect.y;
          });
          if (anchor.top !== null) {
            anchor.last = anchor.top;
            anchor.descending = false;
            // 목표 자리: 창 윗변에서 35% 아래. 행이 거기서 ±20% 안이면 서고, 아니면 오차의 절반씩(한 틱 300pt 까지) 양쪽으로 옮긴다.
            const err = box.y + 0.35 * box.h - anchor.top;
            if (Math.abs(err) <= 0.2 * box.h) {
              steady += 1;
              if (steady >= 3) return done(true);
              continue;
            }
            steady = 0;
            v = 0;
            listRef.current?.scrollToOffset({offset: Math.max(0, g.offsetY - Math.max(-300, Math.min(300, err * 0.5))), animated: false});
            steps += 1;
            continue;
          }
          steady = 0;
          // 그 행이 이미 불러온 범위 안인데 안 보인다 — (a) 한 번 보였다가 지나쳐서 멀어졌거나, (b) 위 끝에 선 채 옛 페이지가 **연달아** 붙어 행이 아래로 밀렸다.
          // (b) 는 앱의 실제 동작이다: 맨 위(오프셋 0)에서는 머리(「대화의 시작입니다」/스피너)가 맨 앞 보이는 뷰라 `maintainVisibleContentPosition` 이 머리를 붙들고, 새 페이지는 그 밑에 끼어 창은
          // 계속 맨 위에 선다 → 목록이 위 끝에서 `onStartReached` 를 연달아 불러 방 전체가 순식간에 붙는다(실측 1.4초에 6쪽). 둘 다 사람이라면 행 쪽으로 되돌아간다:
          // 마지막으로 본 자리가 창 아래쪽이면(없으면: 위 끝에 서 있으면) 아래로 — 행이 다시 마운트될 때까지 꾸준히(오르내리며 떨지 않게 `descending` 을 쥔다).
          if (targetSeq !== null && oldestRef.current <= targetSeq) {
            const below = anchor.descending || (anchor.last !== null ? anchor.last > box.y + 0.5 * box.h : g.offsetY <= 1);
            if (below) {
              anchor.descending = true;
              listRef.current?.scrollToOffset({offset: g.offsetY + 400, animated: false});
              steps += 1;
              continue;
            }
          }
        } else if (targetOffset !== null && g.offsetY <= targetOffset + 1) {
          return done(true);
        }
        // 위 끝에 닿았는데 목표가 아직이면(`paged`: 옛 페이지를 기다린다) 사람처럼 **튕긴다**. 프로그램의 `scrollToOffset(0)` 은 이미 0 이라 스크롤 보고가 더 나가지 않고,
        // 보고가 안 나가면 목록이 `onStartReached` 를 다시 평가하지 않을 수 있다 — 손가락은 닿는 동안 보고를 계속 낸다.
        if (g.offsetY <= 1) {
          if (now - lastNudge >= 150) {
            lastNudge = now;
            nudgedOut = !nudgedOut;
            listRef.current?.scrollToOffset({offset: nudgedOut ? 8 : 0, animated: false});
            steps += 1;
          }
          continue;
        }
        if (now - lastFlick >= tuning.flickEvery) {
          v = Math.min(tuning.vMax, v + tuning.v0);
          lastFlick = now;
        }
        v *= Math.pow(DECAY_PER_MS, dt);
        let next = Math.max(0, g.offsetY - (v * dt) / 1000);
        if (targetOffset !== null) next = Math.max(next, targetOffset);
        listRef.current?.scrollToOffset({offset: next, animated: false});
        steps += 1;
      }
      return done(false);
    }

    /** ARMED 를 켜고 누름부터 착지(또는 6초)까지 프레임마다 잰다. */
    async function armAndMeasure(k: number): Promise<Record<string, unknown>> {
      const box = await rectOf(boxRef.current);
      const g0 = geometry();
      const begin = Date.now();
      const trial: TrialTouch = {begin, touchStart: null, touchEnd: null, x: null, y: null};
      trialRef.current = trial;
      scrollLogRef.current = [];
      const frames: Frame[] = [];
      const events: {t: number; what: string; [key: string]: unknown}[] = [];
      const ev = (what: string, extra?: Record<string, unknown>) => events.push({t: Date.now(), what, ...extra});
      // 프레임 콜백이 바꾸는 값들 — 객체에 담는다(제어 흐름이 초기값으로 굳히지 않게).
      const state: {
        pillSeen: boolean;
        pressAt: number | null;
        landStart: number | null;
        firstVisibleAt: number | null;
        end: 'landed' | 'timeout' | 'no-press';
      } = {pillSeen: pillsNow()?.latest === true, pressAt: null, landStart: null, firstVisibleAt: null, end: 'timeout'};
      ev('armed', {pill: pillsNow()?.latest ?? null, y: g0 === null ? null : g0.offsetY});
      setPhase(`ARMED ${k}`);
      await new Promise<void>(resolve => {
        const tick = () => {
          const now = Date.now();
          const g = geometry();
          const p = pillsNow();
          const frame: Frame = {
            t: now,
            y: g === null ? null : round1(g.offsetY),
            c: g === null ? null : round1(g.contentHeight),
            v: g === null ? null : round1(g.viewportHeight),
            pill: p === null ? null : p.latest,
            at: null,
            ab: null,
            tl: null,
          };
          frames.push(frame);
          // 누르기 전에는 가볍게(동기 읽기만) — 쌓이는 만큼만 남긴다.
          if (trial.touchStart === null && frames.length > 300) frames.splice(0, 100);
          if (!state.pillSeen && p?.latest === true) state.pillSeen = true;
          if (state.pressAt === null && state.pillSeen && p !== null && p.latest === false) {
            state.pressAt = now;
            ev('pill-gone');
            // 누른 순간부터 표식을 바꾼다 — Maestro 의 「ARMED 를 기다린다」가 지나간 시험의 표식에 걸리지 않게.
            setPhase(`RUN ${k}`);
          }
          if (trial.touchStart !== null) {
            void rectOf(anchorRef.current).then(rect => {
              if (rect === null) return;
              frame.at = round1(rect.y);
              frame.ab = round1(rect.y + rect.h);
              if (state.firstVisibleAt === null && box !== null && frame.ab <= box.y + box.h + VISIBLE_TOL_PT && frame.ab > box.y) {
                state.firstVisibleAt = frame.t;
                ev('last-visible', {ab: frame.ab});
              }
            });
            void rectOf(tailRef.current).then(rect => {
              if (rect !== null) frame.tl = round1(rect.y);
            });
          }
          const left = leftOf(g);
          if (state.pressAt !== null) {
            if (left !== null && Math.abs(left) <= 1) {
              if (state.landStart === null) {
                state.landStart = now;
                ev('land-start', {y: g?.offsetY ?? null});
              }
              if (now - state.landStart >= LAND_HOLD_MS) {
                state.end = 'landed';
                resolve();
                return;
              }
            } else if (state.landStart !== null) {
              ev('land-broken', {left});
              state.landStart = null;
            }
            if (now - state.pressAt >= PRESS_TIMEOUT_MS) {
              state.end = 'timeout';
              resolve();
              return;
            }
          } else if (now - begin >= NO_PRESS_MS) {
            state.end = 'no-press';
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await wait(80); // 마지막 프레임들의 창 좌표 응답이 도착할 시간.
      const gEnd = geometry();
      const pEnd = pillsNow();
      const cut = (trial.touchStart ?? state.pressAt ?? begin) - 400;
      const scrollLog = (scrollLogRef.current ?? []).slice();
      scrollLogRef.current = null;
      trialRef.current = null;
      return {
        beginMs: begin,
        pressAt: state.pressAt,
        touchStartAt: trial.touchStart,
        touchEndAt: trial.touchEnd,
        touchX: trial.x,
        touchY: trial.y,
        end: state.end,
        endedAt: Date.now(),
        box: box === null ? null : {top: round1(box.y), bottom: round1(box.y + box.h)},
        atArm: g0 === null ? null : {offsetY: round1(g0.offsetY), content: round1(g0.contentHeight), view: round1(g0.viewportHeight)},
        atEnd: gEnd === null ? null : {offsetY: round1(gEnd.offsetY), content: round1(gEnd.contentHeight), view: round1(gEnd.viewportHeight)},
        pillEnd: pEnd === null ? null : pEnd.latest,
        events,
        trace: frames.filter(frame => frame.t >= cut),
        scrollLog,
      };
    }

    /** 새 목록을 세우고(진입이 안 앉으면 새 목록으로 다시) 목표 거리까지 올린다. */
    async function stage(spec: DistanceSpec, targetSeq: number | null) {
      let entry = await prepare();
      let retries = 0;
      while (!entry.settled && retries < ENTRY_RETRIES && !cancelled) {
        retries += 1;
        entry = await prepare();
      }
      const ascent = await ascend(spec, targetSeq);
      return {entry: {...entry, retries}, ascent};
    }

    void (async () => {
      const trials: {spec: DistanceSpec; round: number}[] = [];
      for (let round = 1; round <= config.repeats; round += 1) {
        for (const spec of config.distances) trials.push({spec, round});
      }
      let reduceMotion: boolean | null = null;
      try {
        reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
      } catch {
        reduceMotion = null;
      }
      const win = Dimensions.get('window');
      for (let index = 0; index < trials.length && !cancelled; index += 1) {
        const k = index + 1;
        const {spec, round} = trials[index];
        const targetSeq = spec.kind === 'seq' ? Math.max(1, Math.round(config.rows * (1 - (spec.frac as number)))) : null;
        // 누를 알약이 서 있어야 시험이다. 드물게(SE paged 12건 중 1건) 올림이 끝난 뒤 쉬는 동안 목록이 혼자 맨 아래로 돌아가 알약이 안 선다 — 그 시험은 버리고 새 목록으로 다시 세운다
        // (기록의 `skipped` 에 남긴다). Maestro 는 표식 ARMED 가 켜진 뒤에야 알약을 찾으므로, 알약 없는 ARMED 를 보이면 흐름이 죽는다.
        const skipped: Record<string, unknown>[] = [];
        let staged = await stage(spec, targetSeq);
        let gAtRest = geometry();
        for (let attempt = 1; ; attempt += 1) {
          if (cancelled) return;
          if (config.arrive) {
            // 올라가 있는 동안 남의 글 3통 — 목록은 따라가지 않고(읽는 중), 꼬리에 아직 안 잰 행이 선다.
            for (let n = 0; n < ARRIVALS; n += 1) {
              const arrival = {...room[config.rows + n], authorMemberId: OTHERS[n]} as Message;
              setMessages(previous => [...previous, arrival]);
              await wait(250);
            }
          }
          // 마지막 행을 이제부터 지켜본다(`anchorSeq`) — 목표 행 표식을 거둔다.
          setAnchorSeq(lastSeq);
          await wait(REST_MS);
          gAtRest = geometry();
          if (pillsNow()?.latest === true || attempt >= MAX_ATTEMPTS || cancelled) break;
          skipped.push({
            attempt,
            reason: 'no-pill',
            y: gAtRest === null ? null : round1(gAtRest.offsetY),
            content: gAtRest === null ? null : round1(gAtRest.contentHeight),
            ascentOk: staged.ascent.ok,
            ascentMs: staged.ascent.ms,
          });
          staged = await stage(spec, targetSeq);
        }
        if (cancelled) return;
        const measured = await armAndMeasure(k);
        const distancePt = gAtRest === null ? null : round1(gAtRest.contentHeight - (gAtRest.offsetY + gAtRest.viewportHeight));
        await sink({
          scenario: 'jump-latest',
          trial: k,
          round,
          label: spec.label,
          room: config.rows,
          mode: config.paged ? 'paged' : 'full',
          arrive: config.arrive,
          flags: config.flags,
          targetSeq,
          lastSeq,
          distancePt,
          ascent: staged.ascent,
          entry: staged.entry,
          skipped,
          device: {w: win.width, h: win.height, scale: PixelRatio.get()},
          reduceMotion,
          ...measured,
        });
        setPhase(`DONE ${k}`);
      }
      // 마지막 `DONE <k>` 를 지우지 않는다 — 표식이 바로 `FINISHED` 로 바뀌면 마지막 시험의 DONE 을 기다리는 Maestro 가 놓친다.
      console.log('JUMP4689 FINISHED');
    })();
    return () => {
      cancelled = true;
    };
    // 한 번만 — 설정은 마운트 동안 바뀌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="디자인-리뷰"
        kind="public"
        directory={DIRECTORY}
        onBack={NOOP}
        menu={MENU}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <View
            ref={boxRef}
            collapsable={false}
            style={styles.fill}
            testID="jlat-list"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}>
            <Timeline
              key={trialKey}
              messages={messages}
              directory={DIRECTORY}
              status="ready"
              channelKind="public"
              channelId={CHANNEL}
              myMemberId={SELF}
              nowMs={NOW}
              actions={actions}
              pending={NO_PENDING}
              reactions={NO_REACTIONS}
              reachedStart={reachedStart}
              loadingOlder={loadingOlder}
              onStartReached={onStartReached}
              tailGap={CONV.conversationTail}
              jumpPills
              pillsRef={pillsRef}
              metricsRef={metricsRef}
              scrollLogRef={scrollLogRef}
              listRef={listRef as never}
              anchorSeq={anchorSeq}
              anchorRef={anchorRef}
              tailRef={tailRef}
            />
          </View>
        }
        composer={
          <View collapsable={false}>
            <Composer
              recipient="place"
              channelLabel="디자인-리뷰"
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              onSend={NOOP}
            />
          </View>
        }
      />
      <PhaseLabel />
    </Screen>
  );
}

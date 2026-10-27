import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import type {MessageNewEvent, RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {activityDetail, activityLines, MAX_ACTIVITY_LINES, UNKNOWN_AGENT_NAME, type AgentLivenessLookup} from '@momo/core/features/agents/turnCopy';
import {typingSegments} from '@momo/core/features/chat/typing';
import {makeDirectory, memberNameParts} from '@momo/core/features/workspace/directory';
import NetInfo from '@react-native-community/netinfo';
import React, {Profiler, useCallback, useEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback} from 'react';
import {
  Animated,
  Keyboard,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import {BAR_CONTROL_MAX_SCALE, Screen} from '../src/design/atoms';
import {usePalette} from '../src/design/theme';
import {font, space, TOUCH_TARGET} from '../src/design/tokens';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {useTickingNow} from '../src/features/agents/workingSignal';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import type {MessageRowActions} from '../src/features/conversation/MessageRow';
import {PinListPanel} from '../src/features/conversation/PinListPanel';
import {clearDraft, readDraft} from '../src/features/conversation/drafts';
import {Timeline, type PillState, type ScrollLogEntry, type TimelineGeometry} from '../src/features/conversation/Timeline';
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
//   #4331 「입력해도 대화가 출렁이지 않는가」 — **에이전트 DM** 에 「대기 1번째 N시간째 기다려요 · 중단」 활동 줄이 서 있는 도크.
//             tick        활동 줄이 선 채 「N분째」 글자가 1초마다 바뀐다(59분 50초에서 시작해 「1시간째」로 넘어간다).
//             bar         활동 줄이 3번 나타났다 사라진다.
//             live        70초 동안 재기만 한다 — 사람(Maestro)이 진짜로 치고 보낸다(`maestro/103-input-steady.yaml`): 1→2→3줄, 지우기, 2줄 보내기.
//                         초안·보냄을 표식으로 남긴다. (입력창 글을 `draftKey` 로 갈아 끼우는 판은 쓰지 않는다 — Fabric 의 `TextInput` 은 값을 갈아 끼워도
//                         높이가 한 걸음 늦게 따라와서 실제 입력의 레이아웃이 아니다.)
//             `+nobar`    활동 줄 없이(대조군). 예: `DM-STEADY-TYPE+NOBAR`.
//
//   #4455 「보낼 때 깜빡이지 않는가 · 쫀득하게 올라오는가」 — 같은 틀에서 **내가 보낸다**(`Composer` 의 `onSend` 가 부르는 같은 `onSend(body)` 길:
//             `selfSendToken` 으로 목록이 끝을 따라가고 `useTimeline.send` 가 메아리를 세운다. 입력창 글자·키보드는 거치지 않는다).
//             send20      20번 보낸다. 4번에 한 번(0·4·8·12·16번째)은 상대 말이 먼저 와서 내 글이 머리 행이 되고, 나머지 15번은 이어지는 행.
//                         7번째·15번째는 긴 글. 보낼 때마다 ~1.5초 쉰다. 프레임마다 목록 내용 높이(`content`)·스크롤 오프셋·도크 윗면·메아리
//                         개수를 남기고, 등장 애니메이션은 `Animated.timing` 을 감싸 네이티브 구동값(JS 가 transform 을 못 읽는다)을 프레임별로
//                         받는다(`anim`). 교체 때의 내용 높이 변화 · 메아리가 서 있던 프레임 수 · 등장이 처음 보이는 때를 이 기록에서 뽑는다.
//                         옵션(`+` 뒤): `d<ms>` 가짜 서버가 보내기에 답하는 데 걸리는 시간(기본 250 — 확정이 등장 도중에 오는 조건을 재려고 0·80·150·
//                         400 으로 바꾼다, design-review r1 H1) · `relay<ms>` 실시간 프레임(`message.new`)이 POST 응답보다 <ms> 먼저 온다(코어가
//                         말하는 선착 경로) · `anchor` 보낼 때마다 새 확정본 행에 앵커를 옮겨 **확정본 행이 마운트되는 때**를 프레임에 남긴다
//                         (`anchor` 칸이 null 이 아니게 되는 때 — 보류가 있으면 등장이 끝난 뒤, 없으면 확정 즉시). `rec+anchor` 는 사진 두 번만
//                         앵커를 건다(#4455 r3 H2: 사진 행의 교체 이음매를 서버 사본 행이 마운트된 때 기준으로 잰다). `rec+tail` 은 가로 사진 120ms 뒤에
//                         글을 이어 보내고, `rec+working` 은 스트림 맨 끝에 「작업 중」 자리를 세운다 — 사진 **뒤에 서 있는 행**이 서버 사본이 서는 때에
//                         새 인스턴스로 다시 서지 않는지 본다(#4455 r4 H4).
//             namefit     시계 상자가 이름 줄 끝에서 **혼자 줄바꿈**되는 폭 창을 찾는다(design-review r1 M2). 목록 폭을 한 칸씩 줄이며(`NAMEFIT_*`)
//                         머리 행 느린 전송을 하나씩 보낸다 — 이름·시각이 줄을 꼭 채우는 폭에서 시계가 이름 밑으로 내려서는가를 사진으로 본다.
//             rec         녹화용 시퀀스(`xcrun simctl io <udid> recordVideo`): 연속 3번 보내기 → 긴 글 → 사진(가로·세로) → 느린 전송(서버 응답
//                         2.6초 — 시계가 서는 장면). 사진 바이트는 `measure/photo-stub.mjs` 가 답한다(`-momoPhotoStub 127.0.0.1:<포트>`).
//
//   #4456 「포커스 먼저」 — 입력창을 **누르는 순간**(글자 0개) 넓은 편집기로 자라고, 포커스를 잃으면(글이 없을 때) 접힌다.
//             focus       140초 동안 재기만 한다 — 사람(Maestro)이 누르고·가만히 있고·치고·보내고(포커스가 남는다)·끌어 내리고·다시 누르고·
//                         글을 남긴 채 내리고·지운 채 내린다(`maestro/110-focus-steady.yaml`). 포커스·자판(`keyboardWill/Did*` 의 높이·길이)·
//                         초안·보냄을 표식으로 남기고 프레임마다 포커스 여부를 적는다. 맨 아래 행이 **입력창 높이가 바뀐 만큼만** 움직였는지
//                         (틈 = 도크 윗면 − 목록 꼬리가 변하지 않는가)는 호스트가 표식 창으로 잘라 본다(`measure/focus-windows.mjs`).
//             `focus+T<초>` 는 재는 시간을 줄인다(기본 140초; 예: `DM-STEADY-FOCUS+T130`). #4518 부터 **손이 닿는 순간**의 표식도 남긴다 —
//                         `touch-down-x<pageX>-y<pageY>` · `touch-drag-d<거리>`(끌기 문턱 10pt 를 처음 넘는 때) · `touch-up` · `touch-cancel`(입력창에 닿은
//                         터치를 도크 상자가 위로 받는다) 과 컴포저가 다시 그려진 커밋의 `render-<phase>-<ms>ms`(React `Profiler`). 흐름은
//                         `maestro/111-press-steady.yaml`(짧은 탭 · 길게 누름 · 끌기 4방향), 분석은 `focus-windows.mjs` 의 「누름→자판」 줄.
//
//   #4613 「진입·입력 초반에 진동이 반복되는가」 — **마운트 첫 프레임부터** 재는 장면. 에이전트 DM 에 들어가(진입 수렴) · 입력창을 누르고(펼침+자판) ·
//             첫 글자 1~5개를 치고 · 1분 동안 활동 줄의 「N초째」가 매초 바뀌는 채로 둔다(`maestro/112-enter-steady.yaml`).
//             enter       기본 75초. 대기 중 run 의 나이는 3초에서 시작해 매초 글자가 바뀐다.
//             `+age17h`   run 나이 17시간(글자는 고정, 1초 재렌더만 도는 대조군).   `+nobar` 활동 줄·1초 시계 없음(대조군).
//             `+label`    에이전트 서버 생존 판정(D4 「깨웠지만 아직 안 가져감」)을 `livenessFor` 로 먹인다 — 실기 대화 화면이 근거 글 맨 앞에 싣는 문구(길다).
//             `+ahead2`   근거 글 끝에 「에이전트 앞에 2건」.   `+grok` 에이전트 이름을 짧게(grok). 글자 크기는 `xcrun simctl ui <udid> content_size <단계>` 로 바꾼다(활동 줄 줄바꿈은 폭 × 글자 크기 × 문구의 곱이다).
//             `+T<초>`    재는 시간. 프레임마다 맨 아래 행 y·목록 높이·입력창 높이·도크 높이·알약·포커스를 남기고, 스크롤 보고마다 출처(손가락/목록이 낸 것)와
//             `chasingTail` 전이를 `scrollLog` 로, 햅틱 호출을 `haptics` 로(`expo-haptics` 를 이 하네스가 감싼다 — 배포 코드 무영향) 싱크에 보낸다.
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
/**
 * 보내기 장면(#4455)의 행 동작. 서버 사본이 **내 글이면 말풍선을 신호색(`mine`)으로** 그리는 근거가 `actions.myMemberId` 라서
 * (`MessageRow` `bubble`), 이것 없이는 메아리(언제나 `mine`)가 교체 때 「남의 글」 모양으로 바뀐다 — 앱에는 없는 하네스만의 색 튐이다.
 * 옛 장면(#4292·#4331)은 이 값 없이 재 왔으므로 건드리지 않는다.
 */
const SEND_ACTIONS: MessageRowActions = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};
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

// ---- 에이전트 DM (#4331) -------------------------------------------------------
// 실기 장면: 에이전트와의 DM, 마지막 줄은 내가 보낸 두 줄 메시지, 입력창 위에 에이전트 활동 줄. 대화 문구는 지어낸 것이다.
const AGENT = '00000000-0000-7000-8000-0000000000e4';
const AGENT_MEMBER = member({id: AGENT, kind: 'agent', displayName: 'hermes', handle: 'hermes'});
const AGENT_DIRECTORY = makeDirectory([SELF_MEMBER, AGENT_MEMBER]);
/** `enter+grok`: 짧은 이름(owner 의 실기 장면은 grok)의 같은 에이전트 — 활동 줄 첫 토막의 폭이 달라 줄바꿈 경계가 옮겨 간다(#4613). */
const GROK_DIRECTORY = makeDirectory([SELF_MEMBER, member({id: AGENT, kind: 'agent', displayName: 'grok', handle: 'grok'})]);
const AGENT_RUN = 'A2222222-2222-4222-8222-A22222222222';
const AGENT_HISTORY: readonly {self: boolean; body: string}[] = [
  {self: true, body: '이번 주 일정 정리해 줄래요'},
  {self: false, body: '네, 월요일부터 금요일까지 정리해서 올릴게요'},
  {self: false, body: '월 시안 검토, 화 회의, 수 배포 준비, 목 배포, 금 회고예요'},
  {self: true, body: '수요일 회의는 오후로 옮겨 주세요'},
  {self: false, body: '옮겼어요. 참석자에게도 알렸어요'},
  {self: true, body: '고마워요'},
  {self: true, body: '그리고 목요일 배포 체크리스트도 만들어 줘요'},
  {self: false, body: '체크리스트 초안이에요. 빠진 항목이 있으면 알려 주세요'},
  {self: false, body: '1) 빌드 확인 2) 마이그레이션 3) 알림 점검 4) 롤백 경로'},
  {self: true, body: '좋아요 이대로 갈게요'},
  {self: false, body: '알겠어요. 목요일 아침에 다시 알려 드릴게요'},
  {self: true, body: '다음 주 일정도 부탁해요'},
  {self: false, body: '다음 주는 휴일이 있어서 나흘이에요. 정리해 둘게요'},
  {self: true, body: '확인 부탁해요\n급하지 않아요'},
];

/** 대기 중인 run 하나. 활동 줄이 「hermes: 대기 1번째 · N째 기다려요」로 선다(`queued` 는 목록 안 자리표시를 만들지 않는다). */
function queuedTurn(ageMs: number, ahead = 0): AgentWorkingSignal {
  const now = Date.now();
  return {
    memberId: AGENT,
    channelId: CHANNEL,
    state: 'queued',
    source: 'run',
    runId: AGENT_RUN,
    headlines: [],
    lastActivityAtMs: now,
    server: {phase: 'queued', leaseState: 'none', queuePosition: 1, aheadTotal: ahead, queuedAtMs: now - ageMs},
  };
}

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

/**
 * 가짜 서버가 보내기에 답하는 데 걸리는 시간(ms). 평소 250 — 운영 서버의 지연이 아니라 #4331 이 정한 하네스 값이다(운영 POST
 * 응답 시간은 이 하네스가 모른다). `rec` 의 느린 전송이 잠깐 늘린다(#4455).
 */
let postDelayMs = 250;

export function setPostDelay(ms: number): void {
  postDelayMs = ms;
}

/**
 * 실시간 프레임이 POST 응답보다 먼저 오는 조건(#4455 H1): 값이 있으면 가짜 서버가 이 시간(ms) 뒤에 확정본을 레일로 먼저
 * 쏘고, 나머지 시간을 기다렸다가 응답한다. 코어 `model.ts` 가 「실시간 프레임이 POST 응답을 앞설 수 있다」고 적는 경로다.
 */
let relayAtMs: number | null = null;
let relayFirst: ((message: Message) => void) | null = null;

/** 사진 스텁(`photo-stub.mjs`)이 답하는 그림과 같은 id — 가로 4:3 · 세로 3:4. 사진·글자 없는 단색 그림이다. */
const PHOTOS: Readonly<Record<string, MessageAttachment>> = {
  'photo-a': {id: 'photo-a', name: '시안 가로.png', mime: 'image/png', sizeBytes: 48_000},
  'photo-solo': {id: 'photo-solo', name: '시안 세로.png', mime: 'image/png', sizeBytes: 48_000},
};

function resetServer(agentDm = false): void {
  if (agentDm) {
    // 12시간 간격 — 날짜 구분선이 여럿 서고 떠 있는 날짜 알약에 날이 있다.
    server.messages = AGENT_HISTORY.map((row, index) => {
      const message = wireMessage(index + 1, row.self ? SELF : AGENT, row.body);
      message.createdAtMs = Date.now() - (AGENT_HISTORY.length - index) * 12 * 3_600_000;
      return message;
    });
    return;
  }
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

/** `-momoPhotoStub host:port` — 있으면 서버 주소를 겸한다(`seedSteady`). */
function photoStubHost(): string | null {
  const value = Settings.get('momoPhotoStub');
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 호스트(Metro·싱크)로 가는 요청은 진짜로 보낸다. 사진 스텁이 서버 주소를 겸하면 같은 주소로 API 도 오므로
 * **첨부 바이트 길만** 진짜로 두고 나머지는 가짜가 답한다.
 */
function reachesHost(url: string): boolean {
  if (!(url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost'))) return false;
  const stub = photoStubHost();
  if (stub !== null && url.startsWith(`http://${stub}`)) return /\/attachments\/[^/]+\/content/.test(url);
  return true;
}

export function ensureFakeFetch(): void {
  if (fakeFetch !== null && globalThis.fetch === fakeFetch) return;
  if (fakeFetch === null) {
    // 먼저 한 번 읽는다: Expo 의 fetch 폴리필은 첫 읽기에서 `Headers` 등을 깐다(`seedShell` 과 같다).
    void globalThis.Headers;
    realFetch = globalThis.fetch.bind(globalThis);
    fakeFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (reachesHost(url)) {
        return (realFetch as typeof fetch)(input as RequestInfo, init);
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        // 보내기: 서버가 줄을 받아 확정본을 돌려준다(응답이 곧 실시간 프레임과 같은 확정본 — `useTimeline.post`).
        const request = JSON.parse(String(init.body ?? '{}')) as {body?: string; attachmentIds?: string[]};
        const seq = (server.messages[server.messages.length - 1]?.seq ?? 0) + 1;
        const message = wireMessage(seq, SELF, request.body ?? '');
        message.createdAtMs = Date.now();
        const files = (request.attachmentIds ?? []).flatMap(id => (PHOTOS[id] === undefined ? [] : [PHOTOS[id]]));
        if (files.length > 0) message.attachments = files;
        server.messages.push(message);
        if (relayAtMs !== null && relayFirst !== null) {
          await wait(relayAtMs);
          relayFirst(message);
          await wait(Math.max(0, postDelayMs - relayAtMs));
        } else {
          await wait(postDelayMs);
        }
        return json(message);
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
  const stub = photoStubHost();
  setServerBase(stub !== null ? `http://${stub}` : 'https://oort.example');
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

/**
 * 등장 애니메이션 한 번의 기록(#4455): `Animated.timing`(네이티브 구동, 길이 180·300)을 감싸 값이 바뀔 때마다 받은 값.
 * 네이티브 구동은 JS 가 transform 을 못 읽으므로(`measureInWindow` 는 커밋된 속성만 본다) 이 값이 유일한 프레임별 증거다.
 * `samples` 는 [만든 때부터의 ms, 값]. 수리 뒤 코드는 남은 비율 1→0(`toValue` 0), 수리 전 코드는 진행값 0→1(`toValue` 1).
 */
interface AnimTrace {
  /** 장면 시작으로부터의 ms (애니메이션을 만든 때). */
  at: number;
  toValue: number;
  duration: number;
  samples: [number, number][];
}

interface Frame {
  /** 장면 시작으로부터의 ms. */
  t: number;
  /** 메아리(아직 서버 사본이 없는 내 글) 개수. */
  pend: number;
  /** 서버 사본이 들어온 메시지 개수. */
  rows: number;
  /**
   * 「전송 중」 줄이 마운트돼 있으면 1. 수리 **전** 트리에만 박는 seam(`globalThis.__momoSendingLine` 을 줄의 마운트·언마운트가 올리고
   * 내린다 — PR 본문의 3줄 패치)이다. 수리 뒤 트리에는 그 줄이 없으므로 언제나 0 이다(그래서 이 칸 하나로는 「0 이 나왔다」가
   * 증거가 못 된다 — 영상 프레임 대조가 짝이다).
   */
  sendingLine: number;
  anchor: number | null;
  tail: number | null;
  dock: number | null;
  offset: number | null;
  content: number | null;
  viewport: number | null;
  /** 도크 높이 — 입력창·활동 줄이 자라면 이만큼 커진다. */
  dockH: number | null;
  /** 활동 줄 자리의 윗면(활동 줄이 없으면 도크 윗면과 같다). 마지막 행이 이 아래로 내려가면 줄에 가린 것이다. */
  bar: number | null;
  /** 활동 줄 자리의 높이. */
  barH: number | null;
  /** 떠 있는 날짜 알약이 서 있다. */
  day: boolean;
  /** 「최신으로」 필이 서 있다. */
  latest: boolean;
  /** 입력창이 포커스를 쥐고 있다(#4456). 입력창이 없는 장면이면 false. */
  focused: boolean;
  /** 컴포저(입력창 + 도구 줄) 자신의 높이(#4613 — `enter` 장면만; 도크 높이에서 유추하지 않고 직접 잰다). */
  comp: number | null;
  /** 목록 아래 끝(꼬리 이음매)의 창 좌표와 목록 보이는 높이는 `tail`·`viewport` 가 이미 말한다. */
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

// ---- 햅틱 호출 계수 (#4613) -----------------------------------------------------
//
// 앱의 햅틱은 `lib/haptics.ts` 가 `expo-haptics` 를 지연 `require` 해 부른다. 이 하네스는 그 모듈의 세 진입점을 감싸 호출을 센다 — 앱 코드에는 틈을
// 내지 않았다. 「진입·입력 중 0」은 **양성 대조**(첨부 버튼 한 번 → 정확히 1회)가 같은 실행에서 세어져야 증거가 된다: 감싼 것이 정말 울림을 세는가.
const hapticLog: {t: number; kind: string}[] = [];
let hapticProbeOn = false;
let hapticProbeBegin = 0;
let hapticProbeStatus = 'off';

function installHapticProbe(): string {
  if (hapticProbeOn) return 'already';
  try {
    const mod = require('expo-haptics') as Record<string, unknown>;
    for (const name of ['impactAsync', 'selectionAsync', 'notificationAsync']) {
      const original = mod[name];
      if (typeof original !== 'function') continue;
      const wrapped = (...args: unknown[]) => {
        hapticLog.push({t: Date.now() - hapticProbeBegin, kind: `${name}(${args.map(String).join(',')})`});
        return (original as (...a: unknown[]) => unknown)(...args);
      };
      try {
        Object.defineProperty(mod, name, {value: wrapped, writable: true, configurable: true, enumerable: true});
      } catch {
        mod[name] = wrapped;
      }
      if (mod[name] !== wrapped) return `patch-failed:${name}`;
    }
    hapticProbeOn = true;
    return 'ok';
  } catch (error) {
    return `no-module:${String(error)}`;
  }
}

type ScenarioName =
  | 'idle'
  | 'peer'
  | 'blip'
  | 'outage'
  | 'gap'
  | 'hold'
  | 'own'
  | 'tick'
  | 'bar'
  | 'live'
  | 'send20'
  | 'rec'
  | 'namefit'
  | 'focus'
  | 'enter';
/** #4331·#4456: 에이전트 DM 에 활동 줄이 서는 장면들. */
const INPUT_SCENES: readonly string[] = ['tick', 'bar', 'live', 'focus', 'enter'];
/** `hold` 는 연결 띠를 세운 채 90초 머문다 — 사진용이고 `all` 에 들지 않는다. */
const ALL: readonly ScenarioName[] = ['idle', 'peer', 'blip', 'outage', 'gap'];

interface Controls {
  setStatus: (status: RealtimeStatus) => void;
  fake: FakeRail;
  /** 서버에 메시지를 더하고(`deliver` 가 참이면 레일로도 보낸다). `author` 를 안 주면 상대의 말이다. */
  say: (body: string, deliver: boolean, author?: string) => Message;
  mark: (what: string) => void;
  /** 활동 줄의 run 들을 갈아 끼운다(#4331). */
  setTurns: (turns: readonly AgentWorkingSignal[]) => void;
  /** 내가 보낸다(#4455) — `Composer` 의 `onSend` 와 같은 길. 사진·파일만 보내려면 본문을 비우고 첨부를 준다. */
  send: (body: string, attachments?: MessageAttachment[]) => void;
  /**
   * 다음에 보낼 글의 seq 로 앵커를 옮긴다(`+anchor`). 그 확정본 행이 마운트돼야 `anchor` 칸이 채워진다. 옵션이 꺼져 있으면 아무것도
   * 안 하고 거짓을 돌려준다 — 참이면 앞 보내기의 앵커가 걷히도록 장면이 잠깐 쉰다.
   */
  watchNext: () => boolean;
  /** 목록 폭을 화면 폭보다 `by` pt 좁힌다(`namefit`). `null` 이면 원래대로. */
  setNarrow: (by: number | null) => void;
  /** 입력창이 지금 포커스를 쥐고 있는가(#4456). */
  isFocused: () => boolean;
  /** `focus` 장면이 재는 시간(ms). 기본 140초, 장면 이름 뒤 `+t<초>` 로 줄인다(#4518 — 되돌림 길만 보는 짧은 흐름용). */
  focusMs: number;
  /** 장면 이름의 `+` 옵션이 켜져 있는가(#4455 r4 — `rec+tail`·`rec+working`). */
  hasMod: (name: string) => boolean;
}

/** `rec+working` 의 「작업 중」 자리(상대 한 명). 모듈 상수여야 목록이 매 렌더 새 배열을 받지 않는다. */
const WORKING_PEER: readonly {memberId: string}[] = [{memberId: PEER}];

// #4455 보내기 장면의 문구. 가상의 대화다 — 실제 대화 문구·이름을 쓰지 않는다.
const PEER_LINES: readonly string[] = [
  '시안 확인했어요',
  '점심 먹고 이어서 볼게요',
  '마감 전에 한 번 더 맞춰 봐요',
  '답이 늦어도 괜찮아요',
  '수정본 올려 둘게요',
];
const SHORT_BODIES: readonly string[] = [
  '네, 확인했어요',
  '지금 정리해서 보낼게요',
  '조금만 기다려 주세요',
  '네트워크가 느린 곳이에요',
  '조금 걸릴 수 있어요',
  '파일은 공유 폴더에 있어요',
  '알겠어요, 그렇게 할게요',
  '고마워요',
  '이따 다시 확인할게요',
  '그럼 내일 아침에 봐요',
];
const LONG_BODY =
  '이번 주 일정을 정리했어요. 월요일에는 디자인 리뷰, 수요일에는 배포 리허설, 금요일에는 회고가 있어요. 리허설 전에 체크리스트를 한 번 더 돌려 보고, 막히는 곳이 있으면 스레드에 남겨 주세요.';

/** `namefit`: 목록 폭을 `FROM` 에서 `TO` 까지 `STEP` pt 씩 좁힌다. 이름(굵은 15pt 세 글자)+시각이 줄을 채우는 폭에 걸리도록 잡은 값이다. */
const NAMEFIT_FROM = Number(Settings.get('momoNamefitFrom') ?? 200);
const NAMEFIT_TO = Number(Settings.get('momoNamefitTo') ?? 260);
const NAMEFIT_STEP = Number(Settings.get('momoNamefitStep') ?? 3);

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
  if (name === 'tick') {
    // 활동 줄의 글자가 1초마다 바뀐다. 시작이 59분 50초라 10초 뒤 「1시간째」로 넘어가는 순간도 지난다.
    c.mark('tick-start');
    await wait(24_000);
    return;
  }
  if (name === 'bar') {
    for (let index = 0; index < 3; index += 1) {
      c.mark(`bar-${index + 1}-on`);
      c.setTurns([queuedTurn(17 * 3_600_000)]);
      await wait(2_500);
      c.mark(`bar-${index + 1}-off`);
      c.setTurns([]);
      await wait(2_500);
    }
    return;
  }
  if (name === 'live') {
    // 사람이 친다. 초안이 바뀔 때마다·메시지가 늘 때마다 표식을 남겨 프레임과 맞춘다.
    c.mark('live-start');
    let lastDraft = readDraft(DRAFT_KEY);
    let lastCount = server.messages.length;
    const until = Date.now() + 70_000;
    while (Date.now() < until) {
      const draft = readDraft(DRAFT_KEY);
      if (draft !== lastDraft) {
        lastDraft = draft;
        c.mark(`draft-${draft === '' ? 0 : draft.split('\n').length}-lines`);
      }
      if (server.messages.length !== lastCount) {
        lastCount = server.messages.length;
        c.mark('sent');
      }
      await wait(40);
    }
    return;
  }
  if (name === 'send20') {
    // 20번 보낸다. 4번에 한 번은 상대 말이 먼저 와서 내 글이 작성자 머리가 서는 행이 되고, 나머지는 이어지는 행이다.
    for (let index = 0; index < 20; index += 1) {
      if (index % 4 === 0) {
        c.mark(`peer-${index / 4}`);
        c.say(PEER_LINES[index / 4], true);
        // 상대 말이 내려앉을 시간 — 내 글의 등장과 겹치지 않게 한다.
        await wait(900);
      }
      const long = index === 7 || index === 15;
      // 앞 보내기의 앵커(확정본 행)가 걷히고 새 seq 의 앵커가 빈 채 서도록 잠깐 쉰다 — 그래야 `anchor` 가 채워지는 때가
      // 곧 새 확정본 행이 마운트된 때다.
      if (c.watchNext()) await wait(250);
      c.mark(`send-${index}:${index % 4 === 0 ? 'head' : 'cont'}:${long ? 'long' : 'short'}`);
      c.send(long ? LONG_BODY : SHORT_BODIES[index % SHORT_BODIES.length]);
      // 확정본(가짜 서버 250ms) · 등장(300ms) · 목록 글라이드가 모두 끝나고도 남는 시간.
      await wait(1_500);
    }
    await wait(1_000);
    return;
  }
  if (name === 'namefit') {
    // 시계 상자(폭 0)는 이름 줄의 마지막 항목이다. 이름·시각이 줄을 `whoGap` 안쪽까지 채우는 폭이면 상자가 혼자 새 줄로 넘어가
    // 시계가 이름 밑에 선다. 폭을 좁혀 가며 그 창을 지난다. 느린 전송(응답 2.6초)이라 1.5초에 시계가 서 있다.
    setPostDelay(2_600);
    for (let by = NAMEFIT_FROM; by <= NAMEFIT_TO; by += NAMEFIT_STEP) {
      c.setNarrow(by);
      await wait(400);
      c.say(PEER_LINES[0], true);
      await wait(700);
      c.mark(`namefit-${by}`);
      c.send(SHORT_BODIES[0]);
      await wait(3_300);
    }
    c.setNarrow(null);
    setPostDelay(250);
    await wait(500);
    return;
  }
  if (name === 'rec') {
    // 녹화용. 장면 사이를 충분히 쉰다 — 영상에서 장면을 가르는 일은 표식의 시각으로 한다.
    await wait(2_000);
    // (1) 연속 3번 보내기: 상대 말 뒤라 첫 줄은 머리 행, 이어 두 줄은 이어지는 행. 450ms 간격.
    c.mark('rec-1-peer');
    c.say(PEER_LINES[0], true);
    await wait(1_200);
    for (let index = 0; index < 3; index += 1) {
      c.mark(`rec-1-send-${index}`);
      c.send(SHORT_BODIES[index]);
      await wait(450);
    }
    await wait(2_500);
    // (2) 긴 글.
    c.mark('rec-2-peer');
    c.say(PEER_LINES[1], true);
    await wait(1_200);
    c.mark('rec-2-send');
    c.send(LONG_BODY);
    await wait(3_000);
    // (3) 사진 메시지: 가로 → 세로. 글 없이 사진만 보낸다(#4294).
    c.mark('rec-3-peer');
    c.say(PEER_LINES[2], true);
    await wait(1_200);
    // `+anchor` 가 켜져 있으면 사진을 보내기 직전에 앵커를 새 확정본의 seq 로 옮긴다(#4455 r3 H2 — 사진 행의 교체 이음매를
    // **서버 사본 행이 마운트된 때**를 기준으로 재려고). 꺼져 있으면 아무 일도 안 한다.
    if (c.watchNext()) await wait(250);
    c.mark('rec-3-send-landscape');
    c.send('', [PHOTOS['photo-a']]);
    // `+tail`: 사진 **뒤에 서 있는 행**을 만든다(#4455 r4 H4) — 사진 메아리가 서 있는 동안 글을 이어 보내면 글 메아리가 사진 메아리 뒤에 선다.
    // 서버 사본(사진)이 서는 때에 목록이 한 칸 늘어도 이 행이 새 인스턴스로 다시 서면 안 된다.
    if (c.hasMod('tail')) {
      await wait(120);
      c.mark('rec-3-send-tail');
      c.send(SHORT_BODIES[2]);
    }
    await wait(3_000);
    if (c.watchNext()) await wait(250);
    c.mark('rec-3-send-portrait');
    c.send('', [PHOTOS['photo-solo']]);
    await wait(3_000);
    // (4) 느린 전송: 서버가 2.6초 뒤에 답한다 — 1.5초에 시계가 서고, 답이 오면 시계만 사라진다. 머리 행과 이어지는 행 하나씩.
    setPostDelay(2_600);
    c.mark('rec-4-peer');
    c.say(PEER_LINES[3], true);
    await wait(1_200);
    c.mark('rec-4-send-head');
    c.send(SHORT_BODIES[3]);
    await wait(600);
    c.mark('rec-4-send-cont');
    c.send(SHORT_BODIES[4]);
    await wait(4_300);
    setPostDelay(250);
    await wait(1_500);
    return;
  }
  if (name === 'focus' || name === 'enter') {
    // 사람이 누르고 친다(#4456; `enter` 는 #4613 — 같은 표식에 글자 수(`chars`)를 더한다). 포커스·자판·초안·보냄이 바뀔 때마다 표식을 남겨 프레임과 맞춘다. 자판 표식에는 높이(pt)와 iOS 가
    // 준 길이(ms)를 담는다 — 알약이 자판과 같은 박자로 오르내리는지 보는 근거다.
    c.mark('focus-start');
    const keyboardEvents = ['keyboardWillShow', 'keyboardDidShow', 'keyboardWillHide', 'keyboardDidHide'] as const;
    const subscriptions = keyboardEvents.map(kind =>
      Keyboard.addListener(kind, event =>
        c.mark(`${kind}-h${Math.round(event.endCoordinates.height)}-d${Math.round(event.duration)}`),
      ),
    );
    let lastDraft = readDraft(DRAFT_KEY);
    let lastCount = server.messages.length;
    let lastFocused = c.isFocused();
    const until = Date.now() + c.focusMs;
    while (Date.now() < until) {
      const focused = c.isFocused();
      if (focused !== lastFocused) {
        lastFocused = focused;
        c.mark(focused ? 'focus' : 'blur');
      }
      const draft = readDraft(DRAFT_KEY);
      if (draft !== lastDraft) {
        lastDraft = draft;
        c.mark(`draft-${draft === '' ? 0 : draft.split('\n').length}-lines`);
        if (name === 'enter') c.mark(`chars-${draft.length}`);
      }
      if (server.messages.length !== lastCount) {
        lastCount = server.messages.length;
        c.mark('sent');
      }
      await wait(16);
    }
    for (const subscription of subscriptions) subscription.remove();
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

// ---- 등장 애니메이션 관측 (#4455) --------------------------------------------------
//
// 보낸 메시지의 등장은 네이티브 구동이라 JS 가 transform 을 읽을 수 없다. 그래서 `Animated.timing` 을 감싸 길이 180·300 인
// 네이티브 구동 애니메이션마다 값 리스너를 달고, 받은 값을 프레임별로 모은다. 감싸는 것은 이 하네스뿐이고 앱 코드에는 틈을 내지
// 않았다 — 앱이 부르는 `Animated.timing(값, 설정)` 은 그대로 돈다.
let animProbeOn = false;
let sceneBegin = 0;
const animLog: AnimTrace[] = [];

function installAnimProbe(): void {
  if (animProbeOn) return;
  animProbeOn = true;
  const original = Animated.timing;
  (Animated as unknown as {timing: typeof Animated.timing}).timing = ((
    value: Animated.Value,
    config: Animated.TimingAnimationConfig,
  ) => {
    const run = original(value, config);
    const duration = config.duration ?? 500;
    if (config.useNativeDriver === true && (duration === 180 || duration === 300)) {
      const born = Date.now();
      const trace: AnimTrace = {
        at: born - sceneBegin,
        toValue: typeof config.toValue === 'number' ? config.toValue : Number.NaN,
        duration,
        samples: [],
      };
      animLog.push(trace);
      value.addListener(({value: current}) => {
        trace.samples.push([Date.now() - born, Math.round(current * 1000) / 1000]);
      });
    }
    return run;
  }) as typeof Animated.timing;
}

interface Result {
  scenario: ScenarioName;
  /** 장면이 시작된 시각(호스트와 같은 시계의 epoch ms) — 녹화 영상(`recordVideo`)과 표식을 맞출 때 쓴다. */
  beginMs: number;
  durationMs: number;
  frames: number;
  anchor: Summary | null;
  tail: Summary | null;
  dock: Summary | null;
  content: Summary | null;
  viewport: Summary | null;
  dockH: Summary | null;
  /** 떠 있는 날짜 알약이 서 있던 프레임 수. 손가락 없는 장면이면 0 이어야 한다(#4331). */
  dayFrames: number;
  latestFrames: number;
  /** 마지막 행이 활동 줄(도크) 밑으로 가려진 가장 큰 높이(pt)와 그 프레임 수(1pt 초과). */
  hiddenMax: number;
  hiddenFrames: number;
  events: {t: number; what: string}[];
  /** 등장 애니메이션 기록(#4455) — `send20`·`rec` 에서만 채운다. */
  anim: AnimTrace[];
}

/** `namefit` 만 쓴다: 목록을 화면 폭보다 `by` pt 좁게 세운다. `by` 가 `null` 이면 아무 상자도 더하지 않는다(다른 장면의 레이아웃을 건드리지 않는다). */
function Narrow({by, children}: {by: number | null; children: React.ReactNode}): React.JSX.Element {
  const {width} = useWindowDimensions();
  if (by === null) return <>{children}</>;
  return <View style={[styles.column, {width: width - by}]}>{children}</View>;
}

export function SteadySurface({which}: {which: string}): React.JSX.Element {
  // `type+nobar` 처럼 `+` 뒤는 옵션이다(#4331).
  const [base = '', ...mods] = which.split('+');
  const agentDm = INPUT_SCENES.includes(base);
  // `hold-unread`: 같은 `hold` 장면에 안 읽은 줄이 있는 대화(위쪽 필이 서는 대화)로 연다.
  const unread = which === 'hold-unread';
  const panelOpen = which === 'panel' || which === 'panel-flat';
  // #4455 보내기 장면. `send20+d80+relay60+anchor` 처럼 옵션이 붙을 수 있다.
  const sendScene = base === 'send20' || base === 'rec' || base === 'namefit';
  const [narrowBy, setNarrowBy] = useState<number | null>(null);
  const scenarios: readonly ScenarioName[] = unread || panelOpen
    ? ['hold']
    : agentDm
      ? [base as ScenarioName]
      : (ALL as readonly string[]).includes(which) ||
          which === 'hold' ||
          which === 'own' ||
          sendScene
        ? [(sendScene ? base : which) as ScenarioName]
        : ALL;
  ensureFakeFetch();
  // #4455: 등장 애니메이션 관측은 보내기 장면에서만 건다.
  useState(() => {
    if (sendScene) installAnimProbe();
    // 옵션: 확정 지연·선착 프레임. 모듈 수준 값이라 장면이 끝나도 남으므로 매번 정한다.
    if (base === 'enter') {
      hapticLog.length = 0;
      hapticProbeStatus = installHapticProbe();
    }
    postDelayMs = 250;
    relayAtMs = null;
    for (const mod of mods) {
      const delay = /^d(\d+)$/.exec(mod);
      if (delay !== null) postDelayMs = Number(delay[1]);
      const relay = /^relay(\d+)$/.exec(mod);
      if (relay !== null) relayAtMs = Number(relay[1]);
    }
    return null;
  });
  // 에이전트 DM 은 자기 대화 기록으로 연다 — 첫 렌더 한 번, `useTimeline` 이 읽기 전.
  useState(() => {
    if (agentDm) resetServer(true);
    return null;
  });
  // `enter` 변형(#4613): `+grok` 짧은 이름 · `+ahead2` 「에이전트 앞에 2건」.
  const grok = base === 'enter' && mods.includes('grok');
  const ahead = base === 'enter' && mods.includes('ahead2') ? 2 : 0;
  const directory = agentDm ? (grok ? GROK_DIRECTORY : AGENT_DIRECTORY) : DIRECTORY;
  const peerId = agentDm ? AGENT : PEER;
  const peerName = agentDm ? (grok ? 'grok' : 'hermes') : '박서연';
  const historyLength = agentDm ? AGENT_HISTORY.length : HISTORY_BODIES.length;
  const fake = useRef<FakeRail | null>(null);
  if (fake.current === null) fake.current = createFakeRail();
  const [status, setStatus] = useState<RealtimeStatus>('connected');
  // 대화 화면과 같은 배선: 뜬 띠의 높이를 머리가 알리고, 목록의 위쪽 필이 그 밑에 쌓인다.
  const [bannerInset, setBannerInset] = useState(0);
  const timeline = useTimeline(fake.current.rail, WS, CHANNEL, SELF);
  // #4331: 활동 줄(대기 중인 run 하나)과 1초 시계 — 대화 화면이 턴이 열려 있는 동안 초당 한 번 다시 그리는 것과 같다.
  // #4613 `enter`: 새로 대기에 든 run(3초째)이라 첫 1분 동안 「N초째」가 매초 바뀐다. `+age17h` 는 글자가 고정인 대조군.
  const startAge =
    base === 'tick'
      ? 59 * 60_000 + 50_000
      : base === 'enter' && !mods.includes('age17h')
        ? 3_000
        : 17 * 3_600_000;
  // `+label`: 대화 화면이 근거 글 맨 앞에 싣는 서버 생존 판정(D4)을 하네스도 먹인다 — 안 먹이면 짧은 문구만 재서 실기보다 줄 바꿈 여유가 크다.
  const livenessFor = useMemo<AgentLivenessLookup | undefined>(
    () =>
      mods.includes('label')
        ? memberId => ({agentMemberId: memberId, state: 'woken_not_collected', lastSignalAtMs: Date.now() - 3 * 3_600_000})
        : undefined,
    // `mods` 는 마운트 때의 값이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const scrollLogRef = useRef<ScrollLogEntry[] | null>(base === 'enter' ? [] : null);
  const composerRef = useRef<View | null>(null);
  const [turns, setTurns] = useState<readonly AgentWorkingSignal[]>(() =>
    agentDm && base !== 'bar' && !mods.includes('nobar') ? [queuedTurn(startAge, ahead)] : [],
  );
  const turnNowMs = useTickingNow(turns.length > 0);
  const [selfSendToken, setSelfSendToken] = useState(0);
  const sendMessage = timeline.send;
  const onSend = useCallback(
    (body: string) => {
      setSelfSendToken(token => token + 1);
      void sendMessage(body);
    },
    [sendMessage],
  );
  // #4455: 장면이 부르는 보내기. `onSend`(컴포저)와 같은 길이고 사진·파일 첨부를 더 받는다. 장면은 한 번 만든 `Controls` 를 끝까지 쓰므로 ref 로 최신을 부른다.
  const sendWithRef = useRef<(body: string, attachments?: MessageAttachment[]) => void>(() => {});
  sendWithRef.current = (body, attachments) => {
    setSelfSendToken(token => token + 1);
    void sendMessage(body, undefined, attachments);
  };
  // 메아리·서버 사본 개수(프레임에 남긴다)와 그 변화 표식(`pending-add`·`pending-remove` = 교체 시각).
  const pendCountRef = useRef(0);
  pendCountRef.current = timeline.pending.length;
  const rowsRef = useRef(0);
  rowsRef.current = timeline.state.messages.length;
  const markRef = useRef<((what: string) => void) | null>(null);
  const seenPendingRef = useRef(0);
  const pendingNow = timeline.pending.length;
  useEffect(() => {
    if (pendingNow === seenPendingRef.current) return;
    markRef.current?.(pendingNow > seenPendingRef.current ? 'pending-add' : 'pending-remove');
    seenPendingRef.current = pendingNow;
  }, [pendingNow]);
  // #4613: 목록의 진입 상태 전이와 활동 줄 근거 글의 바뀜을 표식으로 남긴다(`enter` 만 쓴다).
  const statusNow = timeline.status;
  useEffect(() => {
    if (base === 'enter') markRef.current?.(`status-${statusNow}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusNow]);
  const barDetail =
    base === 'enter' && turns.length > 0
      ? activityDetail(
          activityLines(
            turns,
            memberId => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
            MAX_ACTIVITY_LINES,
            livenessFor,
          ).lines[0],
          turnNowMs,
        )
      : undefined;
  useEffect(() => {
    if (base === 'enter' && barDetail !== undefined) markRef.current?.(`txt:${barDetail}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barDetail]);
  const pillsRef = useRef<PillState | null>(null);
  const barRef = useRef<View | null>(null);
  const palette = usePalette();
  // 「중단」 자리: 진짜 `StopTurnControl` 은 세션을 알아야 해서, 같은 크기(손가락 바닥 44 · 가로 여백 · meta 글자)의 자리만 세운다.
  const renderStop = useCallback(
    () => (
      <View style={stopStyle.quiet}>
        {/* 진짜 `StopTurnControl`(미장착)과 같다: 대기 중 run 의 낱말 「취소」 · 라벨 글자 배율 상한(#4613 — 전에는 「중단」·상한 없음이라 큰 글씨에서 폭이 달랐다). */}
        <Text style={[stopStyle.label, {color: palette.accentText}]} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {base === 'enter' ? '취소' : '중단'}
        </Text>
      </View>
    ),
    [palette, base],
  );
  const anchorRef = useRef<View | null>(null);
  const tailRef = useRef<View | null>(null);
  const dockRef = useRef<View | null>(null);
  const metricsRef = useRef<TimelineGeometry | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  // #4518: 손이 닿고·끌려 나가고·떨어지고·빼앗기는 순간을 표식으로 남긴다. `dockRef` 상자가 입력창에 닿은 터치를 위로 받는다(날 터치 이벤트는 버블이다).
  // 앱의 `onFieldTouch*` 와 같은 이벤트라서 「닿음 → 펼침 첫 변화」 지연(누름 시작의 렌더 비용)과 「닿음 → `keyboardWillShow`」 간격을 같은 시계로 잰다.
  // (`markRef` 는 위 메아리·서버 사본 표식(#4455)과 같은 것이다 — 장면이 도는 동안 장면의 `mark` 를 가리킨다.)
  const touchRef = useRef<{x: number; y: number; dragged: boolean} | null>(null);
  const onDockTouchStart = useCallback((event: GestureResponderEvent) => {
    const {pageX, pageY} = event.nativeEvent;
    touchRef.current = {x: pageX, y: pageY, dragged: false};
    markRef.current?.(`touch-down-x${Math.round(pageX)}-y${Math.round(pageY)}`);
  }, []);
  const onDockTouchMove = useCallback((event: GestureResponderEvent) => {
    const origin = touchRef.current;
    if (origin === null || origin.dragged) return;
    const {pageX, pageY} = event.nativeEvent;
    const distance = Math.hypot(pageX - origin.x, pageY - origin.y);
    // 앱의 끌기 문턱(`PRESS_DRAG_SLOP_PT` = 10pt)을 처음 넘는 순간 한 번.
    if (distance > 10) {
      origin.dragged = true;
      markRef.current?.(`touch-drag-d${Math.round(distance)}`);
    }
  }, []);
  const onDockTouchEnd = useCallback(() => {
    touchRef.current = null;
    markRef.current?.('touch-up');
  }, []);
  const onDockTouchCancel = useCallback(() => {
    touchRef.current = null;
    markRef.current?.('touch-cancel');
  }, []);
  // 컴포저가 다시 그려질 때마다(커밋) 걸린 시간을 표식으로 남긴다(React `Profiler`): 누름 시작의 렌더 비용(#4518 D4)을 「닿음 → 그 커밋」 간격과 함께 본다.
  // 0.3ms 미만은 남기지 않는다 — 스프링이 도는 동안은 컴포저가 아니라 스타일만 바뀌어 커밋이 없다.
  const onComposerRender = useCallback<ProfilerOnRenderCallback>((_id, phase, actualDuration) => {
    if (actualDuration >= 0.3) markRef.current?.(`render-${phase}-${actualDuration.toFixed(1)}ms`);
  }, []);
  // 장면 이름 뒤 `+t<초>` 는 `focus` 장면이 재는 시간(기본 140초).
  const focusMs = (() => {
    const seconds = mods.map(mod => /^t(\d+)$/.exec(mod)).find(match => match !== null);
    return seconds ? Number(seconds[1]) * 1_000 : base === 'enter' ? 75_000 : 140_000;
  })();
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
  const [anchorSeq, setAnchorSeq] = useState(historyLength);
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
    // `enter`(#4613)는 마운트 첫 프레임부터 잰다 — 진입 수렴이 이 장면이 보려는 것이다.
    if ((base !== 'enter' && timeline.status !== 'ready') || startedRef.current) return undefined;
    startedRef.current = true;
    let cancelled = false;
    const sink = Settings.get('momoGapSink');
    const lines: string[] = [];
    void (async () => {
      // 진입 수렴(목록이 끝에 앉는 데 걸리는 시간)이 끝나도록 기다린다. (`enter` 는 그 수렴 자체를 재므로 기다리지 않는다.)
      if (base !== 'enter') await wait(4_000);
      for (const name of scenarios) {
        if (cancelled) return;
        // 이 장면이 재는 행을 지금 가장 새 메시지로 옮기고, 표식이 붙을 때까지 기다린다.
        if (name !== 'enter') {
          setAnchorSeq(server.messages[server.messages.length - 1]?.seq ?? 0);
          await wait(800);
        }
        const frames: Frame[] = [];
        const events: {t: number; what: string}[] = [];
        const begin = Date.now();
        sceneBegin = begin;
        hapticProbeBegin = begin;
        animLog.length = 0;
        let sampling = true;
        const sample = () => {
          if (!sampling) return;
          const frame: Frame = {
            t: Date.now() - begin,
            pend: pendCountRef.current,
            rows: rowsRef.current,
            sendingLine: (globalThis as {__momoSendingLine?: number}).__momoSendingLine ?? 0,
            anchor: null,
            tail: null,
            dock: null,
            offset: metricsRef.current?.offsetY ?? null,
            content: metricsRef.current?.contentHeight ?? null,
            viewport: metricsRef.current?.viewportHeight ?? null,
            dockH: null,
            bar: null,
            barH: null,
            day: pillsRef.current?.day === true,
            latest: pillsRef.current?.latest === true,
            focused: inputRef.current?.isFocused() === true,
            comp: null,
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
            frame.dockH = rect === null ? null : rect.h;
          });
          void rectOf(barRef.current).then(rect => {
            frame.bar = rect === null ? null : rect.y;
            frame.barH = rect === null ? null : rect.h;
          });
          if (composerRef.current !== null) {
            void rectOf(composerRef.current).then(rect => {
              frame.comp = rect === null ? null : rect.h;
            });
          }
          requestAnimationFrame(sample);
        };
        const controls: Controls = {
          setStatus,
          fake: fake.current as FakeRail,
          say: (body, deliver, author = peerId) => {
            const seq = (server.messages[server.messages.length - 1]?.seq ?? 0) + 1;
            const message = wireMessage(seq, author, body);
            message.createdAtMs = Date.now();
            server.messages.push(message);
            if (deliver) (fake.current as FakeRail).message(message);
            return message;
          },
          mark: what => events.push({t: Date.now() - begin, what}),
          setTurns,
          send: (body, attachments) => sendWithRef.current(body, attachments),
          setNarrow: setNarrowBy,
          watchNext: () => {
            if (!mods.includes('anchor')) return false;
            setAnchorSeq((server.messages[server.messages.length - 1]?.seq ?? 0) + 1);
            return true;
          },
          isFocused: () => inputRef.current?.isFocused() === true,
          focusMs,
          hasMod: modName => mods.includes(modName),
        };
        relayFirst = message => (fake.current as FakeRail).message(message);
        markRef.current = controls.mark;
        requestAnimationFrame(sample);
        await runScenario(name, controls);
        sampling = false;
        markRef.current = null;
        await wait(200);
        const hidden = frames.map(frame =>
          frame.anchor !== null && frame.bar !== null ? frame.anchor - frame.bar : 0,
        );
        const result: Result = {
          scenario: name,
          beginMs: begin,
          durationMs: Date.now() - begin,
          frames: frames.length,
          anchor: summarize(frames.map(frame => frame.anchor)),
          tail: summarize(frames.map(frame => frame.tail)),
          dock: summarize(frames.map(frame => frame.dock)),
          content: summarize(frames.map(frame => frame.content)),
          viewport: summarize(frames.map(frame => frame.viewport)),
          dockH: summarize(frames.map(frame => frame.dockH)),
          dayFrames: frames.filter(frame => frame.day).length,
          latestFrames: frames.filter(frame => frame.latest).length,
          hiddenMax: Math.round(Math.max(0, ...hidden) * 10) / 10,
          hiddenFrames: hidden.filter(value => value > 1).length,
          events,
          anim: animLog.map(item => ({...item, samples: item.samples.slice()})),
        };
        const extra =
          name === 'enter'
            ? {scrollLog: scrollLogRef.current ?? [], haptics: hapticLog.slice(), hapticProbe: hapticProbeStatus}
            : {};
        console.log(`STEADY4292 ${JSON.stringify(result)}`);
        if (typeof sink === 'string' && sink !== '') {
          try {
            await fetch(`http://${sink}/steady`, {
              method: 'POST',
              body: JSON.stringify({...result, trace: frames, ...extra}),
            });
          } catch {
            // 받는 쪽이 없으면 로그만 남는다. 계측이 앱을 죽이지 않는다.
          }
        }
        const a = result.anchor;
        lines.push(
          `${name.padEnd(7)} range ${a?.range ?? '-'} · travel ${a?.travel ?? '-'} · maxStep ${a?.maxStep ?? '-'} · moves ${a?.moves ?? '-'} · rev ${a?.reversals ?? '-'} · dock ${result.dock?.range ?? '-'} · pill ${result.dayFrames} · hidden ${result.hiddenMax} (${result.frames}f)`,
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
        title={peerName}
        kind="dm"
        peerId={peerId}
        directory={directory}
        onBack={() => {}}
        menu={[{label: '고정', run: () => {}}]}
        railStatus={status}
        onBannerInset={setBannerInset}
      />
      <ConversationLayout
        list={
          <Narrow by={base === 'namefit' ? narrowBy : null}>
          <Timeline
            messages={timeline.state.messages}
            directory={directory}
            status={timeline.status}
            channelKind="dm"
            myMemberId={SELF}
            nowMs={nowMs}
            recoveryMarkers={timeline.recoveryMarkers}
            lastReadSeq={unread ? 1 : null}
            unreadCount={unread ? HISTORY_BODIES.length - 1 : 0}
            pending={timeline.pending}
            // `+working`: 스트림 맨 끝에 「작업 중」 자리를 세운다(#4455 r4 H4 — 사진 뒤에 서 있는 행). 에이전트가 일하는 대화에서 사진을 보내는 경우다.
            working={mods.includes('working') ? WORKING_PEER : undefined}
            actions={sendScene ? SEND_ACTIONS : undefined}
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
            scrollLogRef={scrollLogRef}
            pillsRef={pillsRef}
            selfSendToken={selfSendToken}
          />
          </Narrow>
        }
        composer={
          <View
            ref={dockRef}
            collapsable={false}
            onTouchStart={onDockTouchStart}
            onTouchMove={onDockTouchMove}
            onTouchEnd={onDockTouchEnd}
            onTouchCancel={onDockTouchCancel}>
            <View ref={barRef} collapsable={false}>
              <AgentActivityBar
                turns={turns}
                directory={directory}
                nowMs={turnNowMs}
                live
                renderStop={renderStop}
                livenessFor={livenessFor}
              />
            </View>
            <TypingBar segments={typingSegments([])} label={null} />
            <Profiler id="composer" onRender={onComposerRender}>
              {base === 'enter' ? (
                // 입력창 자신의 높이를 직접 잰다(`comp`). 다른 장면은 래퍼 없이 같은 배치를 유지한다.
                <View ref={composerRef} collapsable={false}>
                  <Composer
                    recipient="person"
                    channelLabel={peerName}
                    directory={directory}
                    draftKey={DRAFT_KEY}
                    attachmentTarget={TARGET}
                    inputRef={inputRef}
                    onSend={onSend}
                  />
                </View>
              ) : (
                <Composer
                  recipient="person"
                  channelLabel={peerName}
                  directory={directory}
                  draftKey={DRAFT_KEY}
                  attachmentTarget={TARGET}
                  inputRef={inputRef}
                  onSend={onSend}
                />
              )}
            </Profiler>
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
const stopStyle = StyleSheet.create({
  quiet: {minHeight: TOUCH_TARGET, justifyContent: 'center', paddingHorizontal: space.sm},
  label: {fontSize: font.meta, fontWeight: '600'},
});

const styles = StyleSheet.create({
  column: {flex: 1},
  reportLayer: {position: 'absolute', left: 12, right: 12, bottom: 150},
  reportShown: {opacity: 0.92},
  reportHidden: {opacity: 0},
  reportLine: {fontSize: 11, color: '#fff', backgroundColor: '#000a', padding: 2},
});

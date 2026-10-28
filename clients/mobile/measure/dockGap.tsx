import type {Message, RosterMember} from '@momo/core/lib/api';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {THREAD_COMPOSER_PLACEHOLDER} from '@momo/core/features/chat/composerCopy';
import {typingSegments} from '@momo/core/features/chat/typing';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useRef, useState} from 'react';
import {Keyboard, Settings, TextInput, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Screen} from '../src/design/atoms';
import {TOUCH_TARGET} from '../src/design/tokens';
import {useTheme} from '../src/design/theme';
import {
  attachmentSurfaceKey,
  setPickerIssue,
} from '../src/features/attachments/draftStore';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {clearDraft, saveDraft} from '../src/features/conversation/drafts';
import {LongPressHint} from '../src/features/conversation/LongPressHint';
import {Timeline} from '../src/features/conversation/Timeline';
import {TypingBar} from '../src/features/conversation/TypingBar';

// =============================================================================
// 「마지막 행 아래 → 알약 위」 간격의 캡처·계측 표면 (#4264).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure GAP-<STATE> \
//        -momoGapSink 127.0.0.1:<port>
//   (라이트: LIGHT-GAP-<STATE>; `-momoGapSink` 는 선택이다 — 없으면 숫자를 보내지 않고 그림만 선다)
//
//   STATE   empty     빈 알약(쉬는 상태). 이 이슈가 재는 값의 정의다.
//           typed     한 줄 글 — 성재가 실기에서 본 장면(키보드 열림, 입력 중)
//           multi     여러 줄 글 — 알약이 자라도 마지막 행이 안 가려지는가
//           typing    남이 작성 중(「작성 중」 줄이 선 상태)
//           offline   도크 형제 줄: 오프라인 한 줄 (#4203)
//           hint      도크 형제 줄: DM 힌트 (#4203)
//           tray      도크 형제 줄: 첨부 트레이(권한 거부 줄) (#4203)
//           activity  「작업 중」 줄(에이전트 턴)
//           thread    스레드 패널의 구성(`ThreadPanel`): 도크에 「작성 중」 줄이 없다 — 목록 꼬리 + 컴포저뿐
//           coach     첫 1회 길게 누르기 코치마크(`LongPressHint`) — 도크 윗면에 매달려 목록 위로 뜬다
//           sheet     후보 시트 자리 표지. 시트를 **여는 것은 사람이 치는 `@` 한 글자**라 초안으로 못 심는다
//                     (`Composer` 의 캐럿 주석) — Maestro 가 실제로 친다(`maestro/102-dock-gap-sheet-capture.yaml`).
//   `+` 로 여러 상태를 겹친다: `GAP-TYPING+OFFLINE`, `GAP-COACH+TYPING`, `GAP-TYPING+SHEET`.
//   `up-` 접두   같은 상태 + 입력창에 포커스(키보드 열림). 키보드가 있는 시뮬레이터라야 한다.
//
// **대화 화면이 세우는 순서 그대로** 세운다 — 머리 · 레이아웃(목록 / 도크) · 도크 위에서부터
// 「작업 중」 줄 → 「작성 중」 줄 → 컴포저. 기존 `DM-CONVERSATION-*` 표면(#4016)은 「작성 중」 줄 없이
// 컴포저만 세워서, 화면이 실제로 내는 간격(실기 약 45pt)이 사진에 안 나왔다. 간격은 한 컴포넌트의
// 속성이 아니라 목록 꼬리 · 도크 위 줄 · 컴포저 위 여백의 **합**이라서, 합을 만드는 세 조각이 다 있어야
// 잰 값이 화면의 값이다.
//
// 그림만 믿지 않는다: 같은 장면에서 **레이아웃 값**을 `measureInWindow` 로 읽어 `-momoGapSink` 로
// 보낸다(`node measure/gap-sink.mjs <out.jsonl> <port-file> [tag-file]` 가 줄 단위 JSON 으로 적는다). `measureInWindow` 는 네이티브
// 리프트(키보드가 올린 변환)를 못 보지만, 목록 꼬리와 알약은 같은 판 안에 있어 둘의 차는 리프트와
// 무관하다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000a0';
const SELF = '00000000-0000-7000-8000-0000000000a1';
const PEER = '00000000-0000-7000-8000-0000000000a2';
const AGENT = '00000000-0000-7000-8000-0000000000a3';
const CHANNEL = 'dock-gap-capture';

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
  member({id: PEER, displayName: '이도현', handle: 'dohyun'}),
  member({id: AGENT, kind: 'agent', displayName: '김인턴', handle: 'intern'}),
]);

const NOW = Date.now();
// 대화 화면과 같다: 머리 띠가 안전 영역 윗부분을 직접 덮는다(`ConversationScreen` 의 `screen.paddingTop: 0`).
const NO_TOP = {paddingTop: 0} as const;
const DRAFT_KEY = 'measure:dock-gap';

function message(seq: number, author: string, body: string, ageSec: number): Message {
  return {
    id: `00000000-0000-7000-8000-00000000b${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - ageSec * 1000,
  } as Message;
}

// 성재 실기 캡처(2026-10-23)의 끝 장면: 같은 저자의 연속 행으로 끝난다(마지막 행은 이어지는 행).
const MESSAGES = [
  message(1, PEER, '확인했어요', 300),
  message(2, PEER, '네', 280),
  message(3, PEER, '그럼요', 260),
  message(4, PEER, '좋아요', 240),
  message(5, SELF, '공유드려요', 180),
  message(6, PEER, '감사해요', 120),
  message(7, SELF, '별말씀을요', 60),
  message(8, SELF, '민수님이 요청하시던 포트폴리오 수정본을', 40),
  message(9, SELF, '꼼꼼하게 검토하고 있습니다', 20),
];

const DRAFTS: Readonly<Record<string, string>> = {
  typed: '오늘 배포 끝나면 알려줘',
  multi: '배포 순서 정리했어요.\n1) 서버를 먼저 올리고\n2) 앱은 그다음에 올려요\n3) 끝나면 여기에 남길게요',
};

const TURN: AgentWorkingSignal = {
  memberId: AGENT,
  channelId: CHANNEL,
  state: 'working',
  source: 'run',
  runId: 'A1111111-1111-4111-8111-A11111111111',
  startedAtMs: NOW - 12_000,
  headlines: ['일정을 정리하는 중'],
  lastActivityAtMs: NOW,
};

const TARGET = {workspaceId: WS, channelId: CHANNEL};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectOf(node: {measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void} | null): Promise<Rect | null> {
  return new Promise(resolve => {
    if (node === null) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, w, h) => resolve({x, y, w, h}));
  });
}

/**
 * 알약 위 끝은 입력창 위 끝에서 알약 안쪽 위 여백을 뺀 곳이다 — `Composer` 의 `bar`/`pill` 산수
 * (원 둘레 `composerGap` − 입력창이 원 둘레에 더하는 몫 `(44 − 36) / 2`)와 같은 식이다. 알약 노드를
 * 직접 잡는 길이 없어서(`GlassSurface` 는 ref 를 안 내놓는다) 입력창에서 건너간다. 같은 값을 캡처
 * 픽셀에서도 따로 재서(`phone/gap_measure.py`) 두 길이 맞는지 본다.
 */
const PILL_TOP_ABOVE_INPUT = CONV.composerGap - (TOUCH_TARGET - CONV.composerCircle) / 2;

export function DockGapSurface({which}: {which: string}): React.JSX.Element {
  const keyboard = which.startsWith('up-');
  const state = keyboard ? which.slice('up-'.length) : which === '' ? 'empty' : which;
  // 상태는 `+` 로 겹친다. 이름 하나만 주면 예전과 같다.
  const flags = new Set(state.split('+'));
  const has = (name: string) => flags.has(name);
  const isTray = has('tray');
  const inputRef = useRef<TextInput | null>(null);
  const tailRef = useRef<View | null>(null);
  const dockRef = useRef<View | null>(null);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const {scheme} = useTheme();

  // 첫 렌더 전에 한 번: 초안은 MMKV 라 실행을 넘어 남는다. 빈 장면도 지워서 심는다.
  useState(() => {
    const draft = has('multi') ? DRAFTS.multi : has('typed') ? DRAFTS.typed : undefined;
    if (draft === undefined) clearDraft(DRAFT_KEY);
    else saveDraft(DRAFT_KEY, draft);
    return null;
  });

  useEffect(() => {
    if (!isTray) return;
    // 첨부 트레이: 컴포저가 실제 길에서 부르는 그 함수로 권한 거부 줄을 심는다(`AttachMenuSurface` 와 같다).
    setPickerIssue(attachmentSurfaceKey(TARGET), 'camera-permission-denied');
  }, [isTray]);

  useEffect(() => {
    if (!keyboard) return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 1500);
    return () => clearTimeout(timer);
  }, [keyboard]);

  // 레이아웃 값을 읽어 보낸다. 장면이 가라앉은 뒤(키보드 장면은 올라온 뒤) 두 번 — 같은 값이어야 한다.
  useEffect(() => {
    const sink = Settings.get('momoGapSink');
    if (typeof sink !== 'string' || sink === '') return undefined;
    let kbTop: number | null = null;
    const sub = Keyboard.addListener('keyboardDidShow', event => {
      kbTop = event.endCoordinates.screenY;
    });
    const read = async (round: number) => {
      const [tail, dock, input] = await Promise.all([
        rectOf(tailRef.current),
        rectOf(dockRef.current),
        rectOf(inputRef.current),
      ]);
      const pillTop = input === null ? null : input.y - PILL_TOP_ABOVE_INPUT;
      const record = {
        scene: which === '' ? 'empty' : which,
        scheme,
        round,
        keyboard,
        keyboardTop: kbTop,
        windowW: window.width,
        windowH: window.height,
        insetBottom: insets.bottom,
        tail,
        dock,
        input,
        pillTop,
        // 이 이슈의 값: 마지막 행의 아래 끝(= 목록 꼬리의 위 끝) → 알약 위 끝.
        lastRowToPill: tail === null || pillTop === null ? null : pillTop - tail.y,
        // 조각: 목록 꼬리 높이 · 도크 윗면 → 알약 위(도크 위 줄들 + 컴포저 위 여백 + 형제 줄).
        tailHeight: tail === null ? null : tail.h,
        dockTopToPill: dock === null || pillTop === null ? null : pillTop - dock.y,
      };
      console.log(`GAP4264 ${JSON.stringify(record)}`);
      try {
        await fetch(`http://${sink}/gap`, {method: 'POST', body: JSON.stringify(record)});
      } catch {
        // 받는 쪽이 없으면 로그만 남는다. 계측이 앱을 죽이지 않는다.
      }
    };
    const first = setTimeout(() => void read(1), keyboard ? 4500 : 3000);
    const second = setTimeout(() => void read(2), keyboard ? 7000 : 5500);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
      sub.remove();
    };
  }, [which, keyboard, scheme, window.width, window.height, insets.bottom]);

  const typing = has('typing') ? typingSegments(['이도현']) : typingSegments([]);
  // 스레드 패널은 도크에 「작성 중」·「작업 중」 줄을 안 세운다(`ThreadPanel`) — 같은 레이아웃에 목록과 컴포저뿐.
  const thread = has('thread');

  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="이도현"
        kind="dm"
        peerId={PEER}
        directory={DIRECTORY}
        onBack={() => {}}
        onOpenMenu={() => {}}
        // 가운데 알약은 단추다(#4319) — 정보 페이지로 가는 문이 있는 실제 대화 화면과 같은 모양으로 찍는다(머리 높이 불변이 이 하네스의 전제다).
        onOpenInfo={() => {}}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <Timeline
            messages={MESSAGES}
            directory={DIRECTORY}
            status="ready"
            channelKind="dm"
            myMemberId={SELF}
            nowMs={NOW}
            tailRef={tailRef}
            // 대화 화면과 같다(`ConversationScreen`): 목록 꼬리는 도크 맨 위 「작성 중」 예약 줄이 대신한다.
            // 스레드 패널은 기본 꼬리 그대로다.
            tailGap={thread ? undefined : CONV.conversationTail}
          />
        }
        composer={
          <View ref={dockRef} collapsable={false}>
            {thread ? null : (
              <>
                <AgentActivityBar
                  turns={has('activity') ? [TURN] : []}
                  directory={DIRECTORY}
                  nowMs={NOW}
                  live
                />
                <TypingBar
                  segments={typing}
                  label={has('typing') ? '이도현님이 작성 중' : null}
                />
              </>
            )}
            {/* 대화 화면과 같은 자리: 작성 중 줄 뒤, 컴포저 앞(`ConversationScreen`). 6초 뒤에 스스로 물러나는 타이머는
                아무것도 안 하는 핸들러로 받아서 캡처 동안 서 있게 한다. */}
            {has('coach') && !thread ? <LongPressHint visible onDismiss={() => {}} /> : null}
            <Composer
              recipient={thread ? 'place' : 'person'}
              channelLabel={thread ? '스레드' : '이도현'}
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              attachmentTarget={thread ? {...TARGET, rootId: 'root'} : TARGET}
              inputRef={inputRef}
              offline={has('offline')}
              dmHint={has('hint') ? '답장이 올 때까지 시간이 걸릴 수 있어요.' : undefined}
              // 스레드 답글 입력: `ThreadPanel` 이 같은 컴포넌트에 주는 문구.
              {...(thread
                ? {placeholder: THREAD_COMPOSER_PLACEHOLDER, sendLabel: '답글 보내기'}
                : {})}
              onSend={() => {}}
            />
          </View>
        }
      />
    </Screen>
  );
}

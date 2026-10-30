import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {PixelRatio, ScrollView, Settings, StyleSheet, Text, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {CONV} from '../src/features/conversation/convDesign';
import {
  BubbleProbeContext,
  type BubbleProbe,
  type BubbleProbeEvent,
  type ProbeFrame,
} from '../src/features/conversation/MessageBody';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {ROW_FACE} from '../src/features/conversation/rowFace';

// =============================================================================
// 말풍선 글 잘림 측정 표면 (#4894). 실제 `MessageRow` 를 여러 폭의 칸에 세우고, **네이티브가 실제로 낸 틀**을
// 숫자로 적는다 — 「글이 말풍선 밖으로 나가는가·말풍선이 본문 열 밖으로 나가는가」.
//
//   measure/run-bubble-clip.sh <udid> <태그> BUBBLE-CLIP <Metro 포트> <결과 폴더> [content_size] [appearance] [앱 인자 …]
//     (구동기가 받는 쪽 `bubble-clip-check.mjs serve` 를 띄우고, 앱을 `-momoGapSink` 로 이어, 끝나면 `check` 로 단정한다.
//      시뮬레이터를 쓰므로 `~/.cache/momo-scratch/bin/sim-locked.sh` 로 감싸 부른다)
//   앱 이름: BUBBLE-CLIP | BUBBLE-CLIP-MINE(내 글) | BUBBLE-CLIP-SEL(선택 가능 글) | BUBBLE-CLIP-ROW(줄 보기, 말풍선 없음)
//
//   (선택) -momoClipWidths 375,390,430   칸 폭(pt) 목록 — 기본은 아래 `DEFAULT_WIDTHS`
//   (선택) -momoClipSet ko|en|mix|emoji|url|odd|nl|ctx|agent|md|all|<칸 id 앞부분>   글 묶음 — 기본 all
//
// 칸 하나 = `width: W` 인 View 한 개 안에 `MessageRow` 한 개. 목록 셀이 화면 폭 W 를 가진다는 사실을 그대로 흉내 낸다
// (진짜 목록 셀은 `TimelineCell` 의 평범한 View 다). 폭 W 는 기기 폭이 아니라 **칸 폭**이라, 한 기기에서 375·390·430 을 다 잰다.
// 글자 크기(Dynamic Type)는 시뮬레이터 설정(`simctl ui <udid> content_size …`)이 정하고 앱이 뜰 때 읽힌다.
//
// 재는 것(칸 하나마다 — 키(`MessageBody` 의 `BubbleProbeEvent.key`)로 말풍선·문단을 짝짓는다):
//   colW     본문 열 폭 = W − 좌우 마진·안쪽 여백·아바타 칸  (`MessageRow` 의 `row`·`rowInner`·`rowAvatarReserve` 값)
//   bubbles  말풍선 View 의 틀(`onLayout`)
//   paras    문단마다 — 글 상자 Text 의 틀(`onLayout`)과 실제로 그린 줄들(`onTextLayout` — 최종 틀 폭으로 TextKit 이 나눈 줄)
// 단정(`bubble-clip-check.mjs` — 정본은 그 파일 머리말):
//   A  bubble.width ≤ colW                      말풍선이 본문 열을 넘지 않는다
//   B  text.width   ≤ bubble.width − 2·padX      글 상자가 말풍선 안쪽 여백 안에 든다
//   C  max(line.x+line.width) ≤ text.width       그려진 줄이 글 상자를 넘지 않는다(= 오른쪽에서 잘리지 않는다)
//   D  줄 아래끝 ≤ text.height                   마지막 줄이 글 상자 아래로 잘리지 않는다
//   G  글자가 있는 문단의 글 상자 폭 ≥ 4pt        글이 0 폭으로 접혀 안 보이지 않는다
//   H  Σ(문단 높이) + 2·padY ≤ bubble.height     말풍선이 안의 글보다 낮아 글이 말풍선 밖으로 넘치지 않는다
// 이름·문구는 가상이다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000048c0';
const ME = '00000000-0000-7000-8000-0000000048c1';
const OTHER = '00000000-0000-7000-8000-0000000048c2';
const NOW = Date.now();

function member(id: string, name: string): RosterMember {
  return {
    id, workspaceId: WS, kind: 'human', status: 'active', displayName: name, handle: name,
    channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([member(ME, '나'), member(OTHER, '이도현')]);

function msg(n: number, author: string, body: string, ctx?: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000048${String(n).padStart(4, '0')}`,
    channelId: 'ch', seq: n, hlcTs: n, hlcCount: 0, authorMemberId: author, type: 'text',
    body, state: 'sent', createdAtMs: NOW - 60_000,
    // 답글 표식은 `replyParent` 와 `rootId` 가 함께 있어야 선다.
    ...(ctx === 'reply' || ctx === 'all' ? {rootId: PARENT_ID} : {}),
  } as Message;
}

const PARENT_ID = '00000000-0000-7000-8000-000000480001';
const PARENT = {
  id: PARENT_ID, channelId: 'ch', seq: 1, hlcTs: 1, hlcCount: 0, authorMemberId: ME, type: 'text',
  body: '이번 주 일정 공유드려요', state: 'sent', createdAtMs: NOW - 120_000,
} as Message;
const CHIPS = [
  {emoji: '👍', count: 3, mine: false},
  {emoji: '🎉', count: 1, mine: true},
  {emoji: '🙌', count: 12, mine: false},
];
const QUOTE = {
  kind: 'ready', targetId: PARENT_ID, targetSeq: 1, authorMemberId: ME,
  lines: ['로그는 스레드에 정리했어요 그리고 인용도 길게 써서 한 줄을 넘기는지 본다'], truncated: false,
};
const ROLLUP = {replyCount: 4, lastReplySeq: 9, lastReplyAtMs: NOW - 120_000};

/** 본문 열 바깥으로 빠지는 가로 폭 — `MessageRow` 의 `row`(마진 2변) + `rowInner`(오른쪽 패딩 + 왼쪽 아바타 칸 예약). */
export const COLUMN_INSET =
  2 * ROW_FACE.outer + (ROW_FACE.inner + CONV.avatar + CONV.avatarGap) + ROW_FACE.inner;

const DEFAULT_WIDTHS = [375, 390, 402, 430];

/** 글에서 앞 n자씩 잘라 길이를 훑는다. 줄 나뉨이 글자 수마다 달라 반올림 경계에 걸리는 길이를 찾는다. */
function prefixes(text: string, from: number, step: number): string[] {
  const out: string[] = [];
  for (let n = from; n < text.length; n += step) out.push(text.slice(0, n).trimEnd());
  out.push(text);
  return out;
}

const KO =
  '오늘 오후 세 시에 디자인 리뷰가 있어요. 자료는 공유 폴더에 올려 두었으니 미리 한번 훑어보시고, 막히는 부분이 있으면 스레드에 남겨 주세요. 리허설은 수요일 오후로 잡을게요.';
const KO62 = KO.slice(0, 62);
const EN =
  'Please review the design doc before Wednesday and leave a comment in the thread if anything looks off to you, thanks a lot.';
const MIX =
  'PR #4894 리뷰 부탁드려요. 배포는 10/31 오전 9시 30분에 시작하고 롤백 기준은 에러율 2% 이상이에요 (v0.1.40 기준).';
const EMOJI = '좋아요 😀 그럼 내일 점심은 🍜 먹고 오후에 🎉 회고해요 👍 다들 수고했어요 🙌 푹 쉬어요 😴';
const URL_LONG = 'https://example.com/a/very/long/path/that/never/ends/and/keeps/going/forever?query=1&other=2';

type Case = {id: string; set: string; body: string; ctx?: 'quote' | 'reply' | 'chips' | 'rollup' | 'all'};
const CASES: Case[] = [
  ...prefixes(KO, 14, 3).map((body, i) => ({id: `ko-${String(i).padStart(2, '0')}-${body.length}`, set: 'ko', body})),
  ...prefixes(EN, 20, 6).map((body, i) => ({id: `en-${String(i).padStart(2, '0')}-${body.length}`, set: 'en', body})),
  ...prefixes(MIX, 20, 5).map((body, i) => ({id: `mix-${String(i).padStart(2, '0')}-${body.length}`, set: 'mix', body})),
  ...prefixes(EMOJI, 12, 4).map((body, i) => ({id: `emoji-${String(i).padStart(2, '0')}-${body.length}`, set: 'emoji', body})),
  {id: 'url-bare', set: 'url', body: URL_LONG},
  {id: 'url-in-sentence', set: 'url', body: `링크 확인해 주세요 ${URL_LONG} 감사합니다`},
  {id: 'ko-nospace', set: 'url', body: '가나다라마바사아자차카타파하'.repeat(6)},
  // 눈에는 공백인데 줄바꿈 기회가 아닌(또는 다른) 글자들 — 붙여넣은 글에서 흔하다.
  ...(
    [
      ['nbsp', KO62.replace(/ /g, '\u00a0')],
      ['nnbsp', KO62.replace(/ /g, '\u202f')],
      ['thin', KO62.replace(/ /g, '\u2009')],
      ['ideo', KO62.replace(/ /g, '\u3000')],
      ['wj', KO62.replace(/ /g, '\u2060 ')],
      ['zwsp', KO62.replace(/ /g, ' \u200b')],
      ['nfd', KO62.normalize('NFD')],
      ['crlf', KO62.replace(/\. /g, '.\r\n')],
    ] as [string, string][]
  ).map(([k, body]) => ({id: `odd-${k}`, set: 'odd', body})),
  // 줄바꿈이 든 글 — 한 줄 한 줄이 길다.
  ...(
    [
      ['plain-2', `${KO.slice(0, 44)}\n${KO.slice(44, 100)}`],
      ['plain-3', `${KO.slice(0, 40)}\n${KO.slice(40, 80)}\n${KO.slice(80, 120)}`],
      ['plain-blank', `${KO.slice(0, 44)}\n\n${KO.slice(44, 100)}`],
      ['md-2', `**공지** ${KO.slice(0, 44)}\n${KO.slice(44, 100)}`],
      ['md-blank', `**공지** ${KO.slice(0, 44)}\n\n${KO.slice(44, 100)}`],
      ['md-underscore', `file_name.txt ${KO.slice(0, 44)}\n${KO.slice(44, 100)}`],
      ['md-bracket', `[공지] ${KO.slice(0, 44)}\n${KO.slice(44, 100)}`],
      ['md-hard-trailing-space', `${KO.slice(0, 44)}  \n${KO.slice(44, 100)} `],
    ] as [string, string][]
  ).map(([k, body]) => ({id: `nl-${k}`, set: 'nl', body})),
  // 말풍선 위·아래의 곁가지(인용 블록 · 답글 표식 · 반응 칩 · 스레드 꼬리)가 있어도 말풍선 폭·글이 그대로다.
  ...(['quote', 'reply', 'chips', 'rollup', 'all'] as const).flatMap(ctx => [
    {id: `ctx-${ctx}-ko62`, set: 'ctx', body: KO.slice(0, 62), ctx},
    {id: `ctx-${ctx}-ko-list`, set: 'ctx', body: '정리해 봤어요:\n\n- 디자인 리뷰는 월요일 오후 세 시에 진행해요\n- 배포 리허설은 수요일 오전 열 시에 진행하고 막히는 곳은 스레드에 남겨 주세요', ctx},
  ]),
  // 에이전트 답처럼 문단 + 목록이 섞인 글.
  {
    id: 'agent-para-list', set: 'agent',
    body: '정리해 봤어요:\n\n- 디자인 리뷰는 월요일 오후 세 시에 진행해요\n- 배포 리허설은 수요일 오전 열 시에 진행하고 막히는 곳은 스레드에 남겨 주세요\n- 회고는 금요일 오후에 해요',
  },
  {
    id: 'agent-long-para-list', set: 'agent',
    body: '이번 주 일정은 월요일에 디자인 리뷰, 수요일에 배포 리허설, 금요일에 회고예요. 자세한 순서는 아래와 같아요:\n\n- 디자인 리뷰는 월요일 오후 세 시에 진행해요\n- 배포 리허설은 수요일 오전 열 시에 진행하고 막히는 곳은 스레드에 남겨 주세요',
  },
  {
    id: 'agent-numbered', set: 'agent',
    body: '1. 먼저 서버를 올리고 상태를 확인해요 문제가 없으면 다음으로 가요\n2. 앱은 그다음에 올려요\n3. 끝나면 여기에 결과를 남겨요',
  },
  {
    id: 'agent-bold-list', set: 'agent',
    body: '**오늘 할 일**\n- 자료 공유 폴더에 올리기 (오전까지)\n- 리허설 체크리스트 한 번 더 돌려 보기 (막히면 스레드에 남기기)',
  },
  {
    id: 'agent-list-then-para', set: 'agent',
    body: '- 첫째는 짧아요\n- 둘째는 조금 더 길어서 한 줄을 넘어가는 문장이에요 정말로 길어요\n\n마지막 문장은 목록 밖에 있고 이것도 꽤 길게 써서 두 줄을 넘어가도록 해 봅니다.',
  },
  {
    id: 'md-strong-code', set: 'md',
    body: '**굵게** 쓰고 `코드`도 섞어서 한 줄이 꽤 길어지는 문장이에요. 이어서 더 길게 써서 두 줄을 넘겨 봅니다.',
  },
  {
    id: 'md-list', set: 'md',
    body: '- 첫째 항목은 짧아요\n- 둘째 항목은 조금 더 길어서 한 줄을 넘어갈 수도 있는 문장이에요 정말로요\n- 셋째',
  },
  {
    id: 'md-mention', set: 'md',
    body: '@이도현 이번 주 일정 확인했어요. 수요일 리허설 전에 체크리스트 한 번 더 돌려 보고 알려 드릴게요.',
  },
  {
    id: 'md-link', set: 'md',
    body: '링크는 [여기](https://example.com/docs/very/long/path/name)에 있어요. 읽어 보시고 의견 남겨 주세요 부탁드립니다.',
  },
  {
    id: 'md-quote-line', set: 'md',
    body: '> 인용으로 시작해요\n\n그리고 본문은 이렇게 길게 이어져서 여러 줄로 접히는지 보려는 문장이에요 정말 길게요.',
  },
];

function sinkAddress(): string | undefined {
  const sink = Settings.get('momoGapSink');
  return typeof sink === 'string' && sink !== '' ? sink : undefined;
}

function launchList(key: string): string[] | undefined {
  const raw = Settings.get(key);
  return typeof raw === 'string' && raw !== '' ? raw.split(',').map(s => s.trim()) : undefined;
}

/** 받는 쪽이 없으면 조용히 버린다 — 계측이 앱을 죽이지 않는다. */
function post(record: Record<string, unknown>): void {
  const sink = sinkAddress();
  const line = {surface: 'bubble-clip', ...record};
  console.log(`CLIP4894 ${JSON.stringify(line)}`);
  if (sink === undefined) return;
  void fetch(`http://${sink}/probe`, {method: 'POST', body: JSON.stringify(line)}).catch(() => {});
}

/** 한 칸이 보고받은 것 — key 마다 마지막 보고가 이긴다(레이아웃이 다시 돌면 뒤 값이 진짜다). */
type Seen = {
  bubbles: Map<string, ProbeFrame>;
  texts: Map<string, ProbeFrame>;
  lines: Map<string, (ProbeFrame & {text: string})[]>;
};

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const PAGE = 16;

export function BubbleClipSurface({which}: {which: string}): React.JSX.Element {
  const mine = which.includes('mine');
  const widths = useMemo(() => (launchList('momoClipWidths') ?? DEFAULT_WIDTHS.map(String)).map(Number), []);
  const set = (launchList('momoClipSet') ?? ['all'])[0];
  const cases = useMemo(() => CASES.filter(c => set === 'all' || c.set === set || c.id.startsWith(set)), [set]);
  const cells = useMemo(
    () => cases.flatMap(c => widths.map(width => ({key: `${c.id}@${width}`, c, width}))),
    [cases, widths],
  );
  const pages = Math.ceil(cells.length / PAGE);
  const [page, setPage] = useState(0);
  const [bad, setBad] = useState(0);
  const seen = useRef(new Map<string, Seen>());
  const probes = useRef(new Map<string, BubbleProbe>());
  const badRef = useRef(0);

  const probeFor = useCallback((key: string): BubbleProbe => {
    const existing = probes.current.get(key);
    if (existing !== undefined) return existing;
    const entry: Seen = {bubbles: new Map(), texts: new Map(), lines: new Map()};
    seen.current.set(key, entry);
    const fn = (event: BubbleProbeEvent): void => {
      if (event.kind === 'bubble') entry.bubbles.set(event.key, event.frame);
      else if (event.kind === 'text') entry.texts.set(event.key, event.frame);
      else entry.lines.set(event.key, event.lines);
    };
    probes.current.set(key, fn);
    return fn;
  }, []);

  const slice = useMemo(() => cells.slice(page * PAGE, page * PAGE + PAGE), [cells, page]);

  // 한 쪽을 세우고 레이아웃 보고가 가라앉을 때까지 기다린 뒤 적고 다음 쪽으로 간다.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const cell of slice) {
        const s = seen.current.get(cell.key);
        const colW = cell.width - COLUMN_INSET;
        const bubbles = [...(s?.bubbles ?? [])].map(([key, f]) => ({key, x: round(f.x), w: round(f.width), h: round(f.height)}));
        // 문단마다: 틀(text) + 그린 줄(lines) 을 같은 key 로 짝짓는다. 어느 말풍선(key 앞자리)에 앉았는지도 적는다.
        const paraKeys = new Set([...(s?.texts.keys() ?? []), ...(s?.lines.keys() ?? [])]);
        const paras = [...paraKeys].sort().map(key => {
          const text = s?.texts.get(key) ?? null;
          const lines = s?.lines.get(key) ?? [];
          return {
            key,
            text: text && {x: round(text.x), w: round(text.width), h: round(text.height)},
            lines: {
              n: lines.length,
              chars: lines.reduce((sum, l) => sum + l.text.trim().length, 0),
              maxRight: lines.length > 0 ? round(Math.max(...lines.map(l => l.x + l.width))) : null,
              bottom: lines.length > 0 ? round(Math.max(...lines.map(l => l.y + l.height))) : null,
            },
          };
        });
        post({
          kind: 'case',
          id: cell.c.id,
          set: cell.c.set,
          who: mine ? 'mine' : 'other',
          row: which.includes('row'),
          W: cell.width,
          fontScale: round(PixelRatio.getFontScale()),
          pixelRatio: PixelRatio.get(),
          padX: CONV.bubblePadX,
          padY: CONV.bubblePadY,
          colW,
          bubbles,
          paras,
        });
        // 화면에 띄우는 위반 수는 단순 판정이다(진짜 단정은 `bubble-clip-check.mjs`).
        const squeezed = paras.some(
          p =>
            p.text === null || p.lines.n === 0 ||
            (!which.includes('row') &&
              (bubbles.length === 0 ||
                p.text.w > (bubbles.find(b => b.key === p.key.split('.')[0])?.w ?? 0) - 2 * CONV.bubblePadX + 0.5)) ||
            (p.lines.maxRight ?? 0) > p.text.w + 0.5 ||
            (p.lines.bottom ?? 0) > p.text.h + 0.5 ||
            (p.lines.chars > 0 && p.text.w < 1),
        );
        if (squeezed || paras.length === 0 || bubbles.some(b => b.w > colW + 0.5)) badRef.current += 1;
      }
      setBad(badRef.current);
      if (page + 1 < pages) setPage(page + 1);
      else post({kind: 'done', total: cells.length, bad: badRef.current, fontScale: round(PixelRatio.getFontScale())});
    }, 1400);
    return () => clearTimeout(timer);
  }, [cells.length, mine, page, pages, slice, which]);

  return (
    <Screen>
      <View style={styles.hud} pointerEvents="none" testID="clip-hud">
        <Text style={styles.hudText}>
          {`bubble-clip p${page + 1}/${pages} · 칸 ${cells.length} · 위반 ${bad} · 글자배율 ${round(PixelRatio.getFontScale())}`}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {slice.map((cell, i) => (
          <View key={cell.key} style={[styles.cell, {width: cell.width}]} testID={`clip-cell-${cell.key}`}>
            <BubbleProbeContext.Provider value={probeFor(cell.key)}>
              <MessageRow
                message={msg(page * PAGE + i + 1, mine ? ME : OTHER, cell.c.body, cell.c.ctx)}
                startsGroup
                directory={DIRECTORY}
                chips={cell.c.ctx === 'chips' || cell.c.ctx === 'all' ? CHIPS : []}
                quote={(cell.c.ctx === 'quote' || cell.c.ctx === 'all' ? QUOTE : undefined) as never}
                replyParent={cell.c.ctx === 'reply' || cell.c.ctx === 'all' ? PARENT : undefined}
                rollup={(cell.c.ctx === 'rollup' || cell.c.ctx === 'all' ? ROLLUP : undefined) as never}
                nowMs={NOW}
                // `sel`: 행이 액션을 못 가져 글이 선택 가능(`selectable`)으로 그려지는 갈래 — 보내는 중 메아리와 같은 모양.
                actions={
                  which.includes('sel')
                    ? undefined
                    : ({
                        myMemberId: ME,
                        onToggleReaction: async () => {},
                        onOpenThread: () => {},
                      } as never)
                }
              />
            </BubbleProbeContext.Provider>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hud: {position: 'absolute', top: 54, left: 8, right: 8, zIndex: 10, backgroundColor: '#000000cc', padding: 4},
  hudText: {color: '#ffffff', fontSize: 11},
  body: {paddingTop: 80, paddingBottom: 40, gap: 4},
  cell: {alignSelf: 'flex-start'},
});

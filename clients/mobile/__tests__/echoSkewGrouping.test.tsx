// #5624 — 폰도 웹과 같은 흔들림이었다: 에코(기기 시계)와 확정본(서버 시계)의 분이 다르면 같은 분 묶음(#5603)이 갈려, 이어 보낸 내 글에
// 머리가 섰다가 확정 때 접혔다. 실제 폰 훅(`useTimeline`)으로 보내고 렌더마다 목록이 그릴 묶음을 적어, 한 글의 머리/이어짐이 보내는
// 동안 한 번도 바뀌지 않는지를 잰다. 판정은 웹과 같은 코어 함수(`buildTimelineItems`·`pinSettledEchoes`·`serverClock`)다.
import {act, cleanup, renderHook} from '@testing-library/react-native';
import {sendMessage, type Message} from '@momo/core/lib/api';
import {buildTimelineItems} from '@momo/core/features/timeline/model';
import {resetServerClockForTests} from '@momo/core/features/timeline/serverClock';
import '../src/boot/polyfills';
import {useTimeline} from '../src/features/conversation/useTimeline';

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
}));

const at = (m: number, s: number, ms = 0) => new Date(2026, 10, 9, 10, m, s, ms).getTime();
let layouts: Record<string, boolean>[] = [];
let seq = 0;

function confirmed(body: string, createdAtMs: number): Message {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    channelId: 'channel', authorMemberId: 'self', seq, hlcTs: seq, hlcCount: 0,
    type: 'text', body, state: 'sent', createdAtMs,
  };
}

function useRecordedTimeline() {
  const t = useTimeline(null, 'workspace', 'channel', 'self');
  // 폰 목록(`Timeline.tsx`)이 묶음을 짓는 것과 같은 호출이다.
  const loose = t as unknown as {echoPins?: never; serverOffsetMs?: number};
  const layout: Record<string, boolean> = {};
  for (const item of buildTimelineItems(t.state.messages, {
    pending: t.pending,
    echoPins: loose.echoPins,
    serverOffsetMs: loose.serverOffsetMs,
  })) {
    if (item.kind === 'message') layout[item.message.body ?? ''] = item.startsGroup;
    if (item.kind === 'pending') layout[item.pending.body] = item.startsGroup;
  }
  layouts.push(layout);
  return t;
}

function heads(body: string): boolean[] {
  const seen: boolean[] = [];
  for (const layout of layouts) {
    if (!(body in layout)) continue;
    if (seen.length === 0 || seen[seen.length - 1] !== layout[body]) seen.push(layout[body]!);
  }
  return seen;
}

async function sendHeld(result: {current: ReturnType<typeof useTimeline>}, body: string) {
  let resolve!: (m: Message) => void;
  jest.mocked(sendMessage).mockReturnValueOnce(new Promise<Message>(r => { resolve = r; }));
  let sending!: Promise<void>;
  act(() => { sending = result.current.send(body); });
  return async (serverAtMs: number) => {
    await act(async () => {
      resolve(confirmed(body, serverAtMs));
      await sending;
    });
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(47, 5));
  resetServerClockForTests();
  jest.mocked(sendMessage).mockReset();
  layouts = [];
  seq = 0;
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('#5624 폰: 내 글의 머리/이어짐은 에코에서 확정본으로 바뀌어도 그대로다', () => {
  it.each([90, -90])('서버 시계가 %i초 어긋나도 이어 보낸 글은 이어진 줄로 서고 그대로 남는다', async skewSeconds => {
    const skew = skewSeconds * 1000;
    const {result} = renderHook(useRecordedTimeline);
    const first = await sendHeld(result, '첫 글');
    await first(Date.now() + skew);
    jest.setSystemTime(at(47, 15));
    const second = await sendHeld(result, '이어 보낸 글');
    await second(Date.now() + skew);
    expect(heads('이어 보낸 글')).toEqual([false]);
  });

  it('시계가 맞아도 보내는 동안 분이 바뀌면(10:47:59.8 → 서버 10:48:00.1) 이어진 줄이 머리로 바뀌지 않는다', async () => {
    jest.setSystemTime(at(47, 30));
    const {result} = renderHook(useRecordedTimeline);
    const first = await sendHeld(result, '47분의 글');
    await first(Date.now());
    jest.setSystemTime(at(47, 59, 800));
    const second = await sendHeld(result, '경계의 글');
    jest.setSystemTime(at(48, 0, 100));
    await second(Date.now());
    expect(heads('경계의 글')).toEqual([false]);
  });

  it('연달아 두 번 보내면(첫 응답이 둘째 에코보다 먼저, 서버 +90초) 둘째 글이 한 번도 머리가 되지 않는다', async () => {
    const {result} = renderHook(useRecordedTimeline);
    const a = await sendHeld(result, '하나');
    jest.setSystemTime(at(47, 6));
    const b = await sendHeld(result, '둘');
    await a(Date.now() + 90_000);
    jest.setSystemTime(at(47, 7));
    await b(Date.now() + 90_000);
    expect(heads('하나')).toEqual([true]);
    expect(heads('둘')).toEqual([false]);
  });
});

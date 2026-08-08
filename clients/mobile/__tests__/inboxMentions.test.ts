import type {Message} from '@momo/core/lib/api';
import {fetchMessages} from '@momo/core/lib/api';
import {
  fetchMentionsAfter,
  MENTION_MAX_PAGES,
  MENTION_PAGE_LIMIT,
} from '../src/features/inbox/mentions';

// `uuidEq` and the wire decoders stay real: `mentionsMember` runs through them,
// and mocking the whole module would quietly replace the id comparison this
// whole feature turns on.
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchMessages: jest.fn(),
}));

// =============================================================================
// The mention backfill: bounded, cursor-driven, and it never scans a body.
//
// The loop is the web client's, and the reason each exit condition is pinned
// here is that a divergence between the two clients shows up as "my phone finds
// different mentions than my laptop" — a disagreement nobody debugs because
// nobody believes it.
// =============================================================================

const WS = 'wwwwwwww-2222-4222-8222-wwwwwwwwwwww';
const CHANNEL = 'ch-general';
const SELF = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

const mockFetchMessages = fetchMessages as jest.MockedFunction<typeof fetchMessages>;

function message(seq: number, mentions: string[] = []): Message {
  return {
    id: `m-${seq}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `본문 ${seq}`,
    createdAtMs: 1_700_000_000_000 + seq,
    props: mentions.length > 0 ? {mention_member_ids: mentions} : undefined,
  };
}

function page(messages: Message[]) {
  return Promise.resolve({messages});
}

function filler(from: number, count: number): Message[] {
  return Array.from({length: count}, (_, index) => message(from + index));
}

beforeEach(() => {
  mockFetchMessages.mockReset();
});

it('asks for messages ABOVE the read cursor, ascending', async () => {
  mockFetchMessages.mockReturnValueOnce(page([message(11, [SELF])]));
  await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 1);
  expect(mockFetchMessages).toHaveBeenCalledWith(WS, CHANNEL, {
    after: 10,
    limit: MENTION_PAGE_LIMIT,
  });
});

it('keeps only the messages the SERVER recorded as mentioning this member', async () => {
  mockFetchMessages.mockReturnValueOnce(
    page([message(11), message(12, [SELF]), message(13, [OTHER])]),
  );
  const found = await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 1);
  expect(found.map(m => m.seq)).toEqual([12]);
});

it('matches ids case-insensitively, because they cross the wire in mixed case', async () => {
  mockFetchMessages.mockReturnValueOnce(page([message(11, [SELF.toUpperCase()])]));
  const found = await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 1);
  expect(found).toHaveLength(1);
});

it('never re-parses the body for an @handle', async () => {
  // Handles and display names change; the decision the server recorded at insert
  // time does not. A message that says "@seongjae" but carries no
  // `mention_member_ids` is not a mention.
  const shouty = {...message(11), body: '@seongjae 이것 좀 봐주세요'};
  mockFetchMessages.mockReturnValueOnce(page([shouty]));
  expect(await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 1)).toEqual([]);
});

describe('the loop ends', () => {
  it('on an empty page', async () => {
    mockFetchMessages.mockReturnValueOnce(page([]));
    expect(await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 3)).toEqual([]);
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);
  });

  it('once the server’s expected count is accounted for', async () => {
    mockFetchMessages.mockReturnValueOnce(
      page([...filler(11, 48), message(59, [SELF]), message(60, [SELF])]),
    );
    const found = await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 2);
    expect(found).toHaveLength(2);
    // A full page that already satisfied the count must not trigger a second one.
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);
  });

  it('on a short page, which is the end of the channel', async () => {
    mockFetchMessages.mockReturnValueOnce(page([message(11, [SELF])]));
    await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 5);
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);
  });

  it('when a page fails to advance the cursor', async () => {
    // A server answering with rows at or below `after` would otherwise make the
    // next request identical to this one, forever.
    mockFetchMessages.mockReturnValue(page([message(10), message(9)]));
    await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 5);
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);
  });

  it('at the page cap, even when the count is never satisfied', async () => {
    // One busy channel must not be able to walk an unbounded history on a phone.
    let from = 11;
    mockFetchMessages.mockImplementation(() => {
      const messages = filler(from, MENTION_PAGE_LIMIT);
      from += MENTION_PAGE_LIMIT;
      return page(messages);
    });
    const found = await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 99);
    expect(found).toEqual([]);
    expect(mockFetchMessages).toHaveBeenCalledTimes(MENTION_MAX_PAGES);
  });
});

it('walks forward across pages, carrying the cursor', async () => {
  mockFetchMessages
    .mockReturnValueOnce(page([...filler(11, 49), message(60, [SELF])]))
    .mockReturnValueOnce(page([message(61, [SELF])]));
  const found = await fetchMentionsAfter(WS, CHANNEL, 10, SELF, 2);
  expect(found.map(m => m.seq)).toEqual([60, 61]);
  expect(mockFetchMessages).toHaveBeenNthCalledWith(2, WS, CHANNEL, {
    after: 60,
    limit: MENTION_PAGE_LIMIT,
  });
});

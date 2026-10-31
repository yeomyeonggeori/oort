import type {Expression} from '@momo/core/features/expressions/types';
import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {catalog as enCatalog} from '@momo/core/i18n/generated/en-US';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';

import {replyCopyFor} from '../src/features/conversation/replyCopy';
import {
  canReplyBySwipe,
  replyRootId,
  replyTargetFor,
  replyTargetStillValid,
} from '../src/features/conversation/replyTarget';

// =============================================================================
// 답글 대상 (#4869) — 어느 스레드에 달리는가, 어떤 행이 밀리는가, 머리말이 무엇을 말하는가.
// 사용자 문구는 i18n 사전의 것이다: ko·en 두 서비스로 같은 대상의 머리말을 읽는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REPLY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이서준', handle: 'seojun'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '그건 배포 뒤에 봅시다',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

const NO_EXPRESSIONS: readonly Expression[] = [];
const WAVE = {name: 'wave', status: 'active', displayName: '손 흔들기', tags: []} as unknown as Expression;
const context = (expressions: readonly Expression[] = NO_EXPRESSIONS) => ({
  myMemberId: SELF,
  expressions,
});

const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
const en = createMessageService({messageLocale: 'en-US', catalog: enCatalog});

describe('답글 대상 루트 — 이미 스레드 답글이면 그 스레드의 루트에 단다', () => {
  it('루트 행은 자기 id, 답글 행은 자기 id 가 아니라 스레드의 루트 id 다', () => {
    const root = message();
    const reply = message({id: REPLY_ID, rootId: ROOT_ID, seq: 11, authorMemberId: SELF});
    expect(replyRootId(root)).toBe(ROOT_ID);
    expect(replyRootId(reply)).toBe(ROOT_ID);

    const onRoot = replyTargetFor(root, context());
    expect(onRoot).toMatchObject({messageId: ROOT_ID, rootId: ROOT_ID});

    // 머리말은 **민 행**(답글)을 가리키고, 보낼 `root_id` 는 그 스레드의 루트다 — 행 id 로 달면 서버가 400 으로 거절한다.
    const onReply = replyTargetFor(reply, context());
    expect(onReply).toMatchObject({
      messageId: REPLY_ID,
      rootId: ROOT_ID,
      authorMemberId: SELF,
      mine: true,
    });
    expect(onReply?.rootId).not.toBe(REPLY_ID);
  });
});

describe('밀 수 없는 행 — 시스템 줄·삭제된 메시지·승인 카드', () => {
  it.each([
    ['보통 글', true, message()],
    ['이미 스레드 답글인 행(루트로 달린다)', true, message({id: REPLY_ID, rootId: ROOT_ID})],
    ['도구 결과 카드(시트의 「답글 달기」가 이미 서 있는 행)', true, message({type: 'tool_result'})],
    ['시스템 줄', false, message({type: 'system', body: '김인턴님이 들어왔어요'})],
    ['삭제된 메시지', false, message({state: 'deleted', body: undefined, deletedAtMs: BASE_MS})],
    ['보내지 못한 메시지(서버 행이 없다)', false, message({state: 'failed'})],
    ['승인 카드', false, message({type: 'approval_request'})],
  ] as const)('%s → 밀 수 있다: %s', (_label, swipeable, row) => {
    expect(canReplyBySwipe(row)).toBe(swipeable);
    expect(replyTargetFor(row, context()) !== null).toBe(swipeable);
  });
});

describe('머리말 문구 — 사전의 문구이고 대상이 말하는 것은 서술자다', () => {
  const header = (row: Message, service = ko) => {
    const target = replyTargetFor(row, context([WAVE]));
    if (target === null) throw new Error('fixture must be swipeable');
    return replyCopyFor(service, DIRECTORY).header(target);
  };
  const excerpt = (row: Message, service = ko, expressions: readonly Expression[] = [WAVE]) => {
    const target = replyTargetFor(row, context(expressions));
    if (target === null) throw new Error('fixture must be swipeable');
    return replyCopyFor(service, DIRECTORY).excerpt(target);
  };

  it('첫 줄: 남의 글은 「○○님에게 답글」, 내 글은 「내 글에 답글」 — 영어도 같은 서술자에서 나온다', () => {
    expect(header(message())).toBe('김인턴님에게 답글');
    expect(header(message({authorMemberId: SELF}))).toBe('내 글에 답글');
    expect(header(message(), en)).toBe('Reply to 김인턴');
    expect(header(message({authorMemberId: SELF}), en)).toBe('Reply to my message');
    // 답글 행을 밀면 머리말은 그 **답글**의 작성자다(루트의 작성자가 아니다).
    expect(header(message({id: REPLY_ID, rootId: ROOT_ID, authorMemberId: SELF}))).toBe('내 글에 답글');
  });

  it('둘째 줄: 글이 있으면 원문, 없으면 「사진」·「파일」·「이모티콘」 같은 대체 글', () => {
    expect(excerpt(message({body: '첫 줄\n\n둘째 줄\n셋째 줄'}))).toBe('첫 줄 둘째 줄');
    const photo = {id: 'a1', name: 'IMG.png', mime: 'image/png', sizeBytes: 10};
    const pdf = {id: 'a2', name: '명단.pdf', mime: 'application/pdf', sizeBytes: 10};
    expect(excerpt(message({body: undefined, attachments: [photo]}))).toBe('사진');
    expect(excerpt(message({body: '', attachments: [pdf]}))).toBe('파일');
    expect(excerpt(message({body: '', attachments: [pdf, photo]}))).toBe('사진');
    expect(excerpt(message({body: ':wave:'}))).toBe('이모티콘');
    expect(excerpt(message({body: ':wave: :wave:'}))).toBe('이모티콘');
    // 카탈로그에 없는 토큰은 글자일 뿐이다(그림으로 그려지지 않으므로 이모티콘이라 부르지 않는다).
    expect(excerpt(message({body: ':wave:'}), ko, NO_EXPRESSIONS)).toBe(':wave:');
    // 글과 함께 보낸 이모티콘은 글이 있는 메시지다.
    expect(excerpt(message({body: '안녕 :wave:'}))).toBe('안녕 :wave:');
    // 글도 첨부도 없다.
    expect(excerpt(message({body: ''}))).toBe('내용 없는 메시지');
    // 영어.
    expect(excerpt(message({body: '', attachments: [photo]}), en)).toBe('Photo');
    expect(excerpt(message({body: '', attachments: [pdf]}), en)).toBe('File');
    expect(excerpt(message({body: ':wave:'}), en)).toBe('Emoticon');
    expect(excerpt(message({body: ''}), en)).toBe('No message content');
  });

  it('안내 글·취소·보내기 이름도 사전에서 온다 — 「답글 입력」', () => {
    const copy = replyCopyFor(ko, DIRECTORY);
    expect(copy.placeholder()).toBe('답글 입력');
    expect(copy.cancel()).toBe('답글 취소');
    expect(copy.send()).toBe('답글 보내기');
    expect(replyCopyFor(en, DIRECTORY).placeholder()).toBe('Write a reply');
  });
});

describe('걸어 둔 대상이 아직 유효한가 — 아니면 조용히 뗀다', () => {
  const root = message();
  const reply = message({id: REPLY_ID, rootId: ROOT_ID, seq: 11});
  const target = replyTargetFor(reply, context());
  if (target === null) throw new Error('fixture must be swipeable');
  const lookupOf = (...rows: Message[]) => (id: string) => rows.find(row => row.id === id);

  it('둘 다 살아 있거나 아직 불러오지 않았으면 유효하고, 대상이나 루트가 지워졌으면 무효다', () => {
    expect(replyTargetStillValid(target, lookupOf(root, reply))).toBe(true);
    expect(replyTargetStillValid(target, lookupOf())).toBe(true); // 창 밖은 사라진 것이 아니다
    const gone = {state: 'deleted', body: undefined} as const;
    expect(replyTargetStillValid(target, lookupOf(root, {...reply, ...gone}))).toBe(false);
    // 서버는 지워진 루트에 다는 답글을 거절한다.
    expect(replyTargetStillValid(target, lookupOf({...root, ...gone}, reply))).toBe(false);
  });
});

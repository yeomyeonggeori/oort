import { describe, expect, it } from "vitest";
import { catalog as enCatalog } from "../../i18n/generated/en-US";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageService } from "../../i18n/service";
import type { Message, RosterMember } from "../../lib/api";
import { makeDirectory } from "../workspace/directory";
import { buildTimelineItems, isChannelListEcho, type PendingMessage } from "./model";
import { replyHomeCopy } from "./replyHomeCopy";
import {
  isMainFlowRow,
  mainFlowMessages,
  messageExcerpt,
  phoneMainFlowMessages,
  replyHomeLine,
  serverSpeaksThreadHome,
} from "./threadHome";

// 이슈 #4888 — 본류에 그릴 행의 판정(웹·데스크탑·폰이 같은 함수), 옛 서버 대체(폰), 답글 줄의 모양과 문구.

const ME = "11111111-1111-4111-8111-111111111111";
const SEO = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const ROOT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function msg(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `0000000${seq}-0000-4000-8000-000000000000`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: `m${seq}`,
    state: "sent",
    createdAtMs: seq,
    ...over,
  };
}
const root = (over: Partial<Message> = {}) => msg(1, { id: ROOT, authorMemberId: SEO, body: "점심 뭐 먹을까요?", ...over });
const reply = (seq: number, over: Partial<Message> = {}) => msg(seq, { rootId: ROOT, ...over });
const SUMMARY_NEW = { reply_count: 2, last_reply_seq: 3, last_reply_at: 3, participant_ids: [ME], participant_count: 1 };
const SUMMARY_OLD = { reply_count: 2, last_reply_seq: 3, last_reply_at: 3 };

describe("isMainFlowRow — ADR-0148 결정 4 한 문장", () => {
  it("루트 없는 메시지는 본류에 선다", () => {
    expect(isMainFlowRow(msg(1))).toBe(true);
  });
  it("스레드로만 간 답글은 본류에 서지 않는다", () => {
    expect(isMainFlowRow(reply(2))).toBe(false);
    expect(isMainFlowRow(reply(2, { alsoInChannel: false }))).toBe(false);
  });
  it("대화에도 보낸 답글은 본류에 선다", () => {
    expect(isMainFlowRow(reply(2, { alsoInChannel: true }))).toBe(true);
  });
  it("true 가 아닌 값은 켜짐으로 읽지 않는다(문자열·1)", () => {
    expect(isMainFlowRow(reply(2, { alsoInChannel: "true" as unknown as boolean }))).toBe(false);
    expect(isMainFlowRow(reply(2, { alsoInChannel: 1 as unknown as boolean }))).toBe(false);
  });
  it("mainFlowMessages 는 순서를 지키며 걸러 낸다", () => {
    const rows = [root(), reply(2), reply(3, { alsoInChannel: true }), msg(4)];
    expect(mainFlowMessages(rows).map((m) => m.seq)).toEqual([1, 3, 4]);
  });
});

describe("serverSpeaksThreadHome — 서버가 이 값을 아는가(와이어에 「없다」는 신호가 없다)", () => {
  it("스레드도 켠 답글도 없으면 모른다", () => {
    expect(serverSpeaksThreadHome([msg(1), reply(2)])).toBe(false);
  });
  it("켠 답글이 하나라도 있으면 안다", () => {
    expect(serverSpeaksThreadHome([root(), reply(2, { alsoInChannel: true })])).toBe(true);
  });
  it("요약에 participant_count 가 있으면 안다(같은 커밋이 함께 들여온 값)", () => {
    expect(serverSpeaksThreadHome([root({ thread: SUMMARY_NEW }), reply(2)])).toBe(true);
  });
  it("participant_ids 만 있어도 안다(빈 배열도 값이다)", () => {
    const { participant_count: _count, ...idsOnly } = SUMMARY_NEW;
    expect(serverSpeaksThreadHome([root({ thread: { ...idsOnly, participant_ids: [] } })])).toBe(true);
  });
  it("두 키가 없는 요약은 옛 서버의 것이라 증거가 아니다", () => {
    expect(serverSpeaksThreadHome([root({ thread: SUMMARY_OLD }), reply(2)])).toBe(false);
  });
});

describe("phoneMainFlowMessages — 새 서버는 규칙대로, 옛 서버는 오늘 폰 동작", () => {
  it("옛 서버(증거 없음): 답글이 전부 남고, 같은 배열이다", () => {
    const rows = [root({ thread: SUMMARY_OLD }), reply(2), reply(3)];
    const shown = phoneMainFlowMessages(rows);
    expect(shown).toBe(rows);
    expect(shown.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
  it("새 서버(요약에 participant_count): 켠 답글만 남는다", () => {
    const rows = [root({ thread: SUMMARY_NEW }), reply(2), reply(3, { alsoInChannel: true }), msg(4)];
    expect(phoneMainFlowMessages(rows).map((m) => m.seq)).toEqual([1, 3, 4]);
  });
  it("새 서버(켠 답글이 증거): 켜지 않은 답글은 빠진다", () => {
    const rows = [root(), reply(2), reply(3, { alsoInChannel: true })];
    expect(phoneMainFlowMessages(rows).map((m) => m.seq)).toEqual([1, 3]);
  });
  it("알려진 틈: 요약도 켠 답글도 없는 창의 첫 답글은 새 서버여도 보인다(숨기는 쪽의 오류보다 낫다)", () => {
    expect(phoneMainFlowMessages([root(), reply(2)]).map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe("replyHomeLine — 「어느 스레드의 답글인가」", () => {
  const byId = (rows: Message[]) => (id: string) => rows.find((m) => m.id === id);
  it("답글이 아닌 행에는 없다", () => {
    expect(replyHomeLine(msg(2), byId([root()]))).toBeNull();
  });
  it("루트가 불러온 범위에 없으면 모른다고 말한다", () => {
    expect(replyHomeLine(reply(2), byId([]))).toEqual({ kind: "unloaded", rootId: ROOT });
  });
  it("지워진 루트는 지워졌다고 말한다(스레드는 열린다)", () => {
    const line = replyHomeLine(reply(2), byId([root({ state: "deleted", body: undefined })]));
    expect(line).toEqual({ kind: "deleted", rootId: ROOT, rootAuthorMemberId: SEO });
  });
  it("루트의 글을 한 줄 발췌로 싣는다", () => {
    expect(replyHomeLine(reply(2), byId([root()]))).toEqual({
      kind: "ready",
      rootId: ROOT,
      rootAuthorMemberId: SEO,
      excerpt: { kind: "text", text: "점심 뭐 먹을까요?" },
    });
  });
  it("글이 여러 줄이면 인용과 같은 규칙으로 자른다(두 줄까지, 한 줄로 이어 붙임)", () => {
    expect(messageExcerpt(root({ body: "첫 줄\n\n둘째 줄\n셋째 줄" }))).toEqual({ kind: "text", text: "첫 줄 둘째 줄" });
  });
  it("글이 없는 루트는 종류로 말한다(사진·파일·빈 글)", () => {
    const photo = { id: "f1", name: "a.png", mime: "image/png", sizeBytes: 1 };
    const doc = { id: "f2", name: "a.pdf", mime: "application/pdf", sizeBytes: 1 };
    expect(messageExcerpt(root({ body: "", attachments: [photo] }))).toEqual({ kind: "photo" });
    expect(messageExcerpt(root({ body: "", attachments: [doc] }))).toEqual({ kind: "file" });
    expect(messageExcerpt(root({ body: "  " }))).toEqual({ kind: "empty" });
  });
});

describe("replyHomeCopy — 문구는 사전의 것이고 웹·폰이 같은 문장을 받는다", () => {
  const members = [
    { id: ME, workspaceId: "w", kind: "human", status: "active", displayName: "이도현", handle: "d", channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
    { id: SEO, workspaceId: "w", kind: "human", status: "active", displayName: "박서연", handle: "s", channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  ] as RosterMember[];
  const directory = makeDirectory(members);
  const ko = createMessageService({ messageLocale: "ko-KR", catalog: koCatalog });
  const en = createMessageService({ messageLocale: "en-US", catalog: enCatalog });
  const ctx = (service: typeof ko) => ({ directory, myMemberId: ME, formatMessage: service.formatMessage.bind(service) });
  const ready = { kind: "ready", rootId: ROOT, rootAuthorMemberId: SEO, excerpt: { kind: "text", text: "점심 뭐 먹을까요?" } } as const;

  it("남의 글: 「○○님 스레드에 답글」 + 원문, 낭독은 한 문장", () => {
    const copy = replyHomeCopy(ready, ctx(ko));
    expect(copy.header).toBe("박서연님 스레드에 답글");
    expect(copy.excerpt).toBe("점심 뭐 먹을까요?");
    expect(copy.spoken).toBe("박서연님 스레드에 답글, 점심 뭐 먹을까요?");
    expect(copy.openLabel).toBe("이 답글이 달린 스레드 열기");
  });
  it("내 글: 이름 대신 「내 글」", () => {
    expect(replyHomeCopy({ ...ready, rootAuthorMemberId: ME }, ctx(ko)).header).toBe("내 글 스레드에 답글");
  });
  it("루트를 못 불러왔으면 이름도 원문도 지어내지 않는다", () => {
    const copy = replyHomeCopy({ kind: "unloaded", rootId: ROOT }, ctx(ko));
    expect(copy.header).toBe("스레드에 답글");
    expect(copy.excerpt).toBeNull();
    expect(copy.spoken).toBe("스레드에 답글");
  });
  it("지워진 루트는 「삭제된 메시지」", () => {
    const copy = replyHomeCopy({ kind: "deleted", rootId: ROOT, rootAuthorMemberId: SEO }, ctx(ko));
    expect(copy.excerpt).toBe("삭제된 메시지");
  });
  it("사진뿐인 루트는 「사진」(코어 답글 머리말과 같은 키)", () => {
    expect(replyHomeCopy({ ...ready, excerpt: { kind: "photo" } }, ctx(ko)).excerpt).toBe("사진");
  });
  it("영어 사전도 같은 줄을 말한다", () => {
    const copy = replyHomeCopy(ready, ctx(en));
    expect(copy.header).toBe("Replied in 박서연's thread");
    expect(copy.openLabel).toBe("Open the thread this reply is in");
  });
});

// 폰 본류는 스레드로만 간 답글을 그리지 않지만, 보내지 못해 에코로 남은 그 답글의 확정본이 나중에 도착하면 에코는 정착해야 한다.
describe("buildTimelineItems.settleAgainst — 걸러 낸 확정본도 에코를 정착시킨다", () => {
  const echo = (clientMsgId: string, body: string, over: Partial<PendingMessage> = {}): PendingMessage => ({
    clientMsgId,
    channelId: "c",
    authorMemberId: ME,
    body,
    createdAtMs: 100,
    sinceSeq: 1,
    status: "failed",
    rootId: ROOT,
    ...over,
  });
  const pendingKeys = (items: ReturnType<typeof buildTimelineItems>) =>
    items.filter((i) => i.kind === "pending").map((i) => (i.kind === "pending" ? i.pending.clientMsgId : ""));

  it("대조 목록을 주면 본류에 안 그린 확정본이 실패 에코를 지운다", () => {
    const all = [root(), reply(2, { body: "네 좋아요" })];
    const drawn = mainFlowMessages(all);
    const pending = [echo("k1", "네 좋아요")];
    // 고치기 전(옵션 없음): 그리는 목록에는 확정본이 없어 에코가 남는다 — 이미 도착한 답글이 「전송 실패」로 보인다.
    expect(pendingKeys(buildTimelineItems(drawn, { pending }))).toEqual(["k1"]);
    expect(pendingKeys(buildTimelineItems(drawn, { pending, settleAgainst: all }))).toEqual([]);
  });
  it("한 번만 대조한다: 같은 글을 두 번 보낸 에코 둘을 확정본 하나가 모두 삼키지 않는다", () => {
    const all = [root(), reply(2, { body: "네", alsoInChannel: true })];
    const pending = [echo("k1", "네", { alsoInChannel: true }), echo("k2", "네", { alsoInChannel: true })];
    expect(pendingKeys(buildTimelineItems(mainFlowMessages(all), { pending, settleAgainst: all }))).toEqual(["k2"]);
  });
});

// 대화(채널) 목록이 에코를 그리는 규칙 — 스레드 답글의 에코는 스레드의 것이고, 예외는 「대화에도 보낸」 것과 보내지 못한 것이다.
describe("isChannelListEcho", () => {
  const row = (over: Partial<PendingMessage> = {}): PendingMessage => ({
    clientMsgId: "k",
    channelId: "c",
    authorMemberId: ME,
    body: "x",
    createdAtMs: 1,
    sinceSeq: 1,
    status: "sending",
    ...over,
  });
  it("채널 글의 에코는 늘 선다", () => {
    expect(isChannelListEcho(row())).toBe(true);
    expect(isChannelListEcho(row({ status: "failed" }))).toBe(true);
  });
  it("스레드로만 가는 답글을 보내는 중에는 대화 목록에 없다(스레드의 것)", () => {
    expect(isChannelListEcho(row({ rootId: ROOT }))).toBe(false);
  });
  it("스레드 답글이 보내지 못했으면 대화 목록에 선다 — 밀어서 보낸 답글은 스레드를 열지 않는다", () => {
    expect(isChannelListEcho(row({ rootId: ROOT, status: "failed" }))).toBe(true);
  });
  it("「대화에도 보내기」 답글은 보내는 중에도 선다 — 확정되면 본류의 행이 된다", () => {
    expect(isChannelListEcho(row({ rootId: ROOT, alsoInChannel: true }))).toBe(true);
  });
});

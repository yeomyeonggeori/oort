import { describe, expect, it } from "vitest";
import { parseFailedSend, serializeFailedSend } from "../connection/failedSendRecord";
import { pickAutoResends, recordSendFailure, type SendFailureRecord } from "../connection/sendFailure";
import { NetworkError } from "../../lib/http";
import { failPending, removePending, type PendingMessage } from "../timeline/model";
import { FIXTURE_EXPRESSIONS } from "./fixtures";
import { expressionMessageModel } from "./message";
import {
  bundleCarriesOptions,
  bundleHead,
  bundleMayPost,
  bundleTail,
  failBundleTail,
  planSendBundle,
  postBundleInOrder,
  retryBundleTail,
  type BundlePoster,
  type SendBundleMessage,
} from "./sendBundle";
import type { Expression } from "./types";

// 이모티콘 + 글 한 번에 보내기 (#5453). 와이어는 큰 표현 메시지 → 글 메시지이고, 둘은 서로 다른 id를 쓰되 순서와 멱등을 묶음이 지킨다.
// 서버는 (채널, 작성자, client_msg_id)로 접는다 — 아래 가짜 서버가 그 규칙 그대로 같은 id의 둘째 요청을 새 메시지로 쓰지 않는다.

const sticker: Expression = FIXTURE_EXPRESSIONS.find((entry) => entry.kind === "sticker" && entry.status === "active") ?? FIXTURE_EXPRESSIONS[0];
let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const ME = "00000000-0000-4000-8000-0000000000aa";
const CH = "00000000-0000-4000-8000-0000000000bb";

function rowsOf(messages: readonly SendBundleMessage[]): PendingMessage[] {
  return messages.map((message) => ({
    clientMsgId: message.clientMsgId,
    channelId: CH,
    authorMemberId: ME,
    body: message.body,
    createdAtMs: 1,
    sinceSeq: null,
    status: "sending" as const,
    ...(message.after === undefined ? {} : { after: message.after }),
  }));
}
function plan(text: string, expression: Expression | null = sticker, hasAttachments = false): SendBundleMessage[] {
  const made = planSendBundle({ expression, text, hasAttachments, newId });
  if (!made.ok) throw new Error(`plan refused: ${made.reason}`);
  return made.messages;
}

describe("묶음을 짠다 — 표현 메시지 다음에 글 메시지, 서로 다른 id", () => {
  it("표현과 글이 있으면 메시지 둘: 앞은 `:이름:` 하나(큰 표현, D1 그대로), 뒤는 글이고 뒤가 앞의 id를 `after`로 단다", () => {
    const [first, second, ...rest] = plan("점심 먹으러 가요");
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ role: "expression", body: `:${sticker.name}:` });
    expect(first.after).toBeUndefined();
    expect(second).toMatchObject({ role: "text", body: "점심 먹으러 가요", after: first.clientMsgId });
    // 서버가 같은 id를 한 메시지로 접으므로 id는 반드시 달라야 한다.
    expect(first.clientMsgId).not.toBe(second.clientMsgId);
    // 표현 메시지는 정말 큰 표현으로 읽힌다: 글이 섞이지 않았다.
    expect(expressionMessageModel(first.body, [sticker]).size).toBe("large");
  });
  it("표현만 있으면 하나, 글만 있으면 하나(묶음이 아니다), 글이 비고 첨부만 있으면 빈 본문의 글 메시지가 뒤에 선다", () => {
    expect(plan("   ").map((m) => m.role)).toEqual(["expression"]);
    expect(plan("안녕", null).map((m) => m.role)).toEqual(["text"]);
    expect(plan("안녕", null)[0].after).toBeUndefined();
    const withFile = plan("", sticker, true);
    expect(withFile.map((m) => [m.role, m.body])).toEqual([["expression", `:${sticker.name}:`], ["text", ""]]);
    expect(withFile[1].after).toBe(withFile[0].clientMsgId);
  });
  it("보낼 것이 없거나 표현이 더는 쓸 수 없으면 짜지 않는다", () => {
    expect(planSendBundle({ expression: null, text: "  ", newId })).toEqual({ ok: false, reason: "empty" });
    expect(planSendBundle({ expression: { ...sticker, status: "hidden" }, text: "글", newId })).toEqual({ ok: false, reason: "expression_unavailable" });
    expect(planSendBundle({ expression: { ...sticker, status: "deleted" }, text: "", newId })).toEqual({ ok: false, reason: "expression_unavailable" });
  });
  it("id 생성기가 같은 값을 두 번 주면 만들기 전에 막는다(글이 조용히 사라지는 실패)", () => {
    expect(() => planSendBundle({ expression: sticker, text: "글", newId: () => "00000000-0000-4000-8000-0000000000ff" })).toThrow(/new id/);
  });
  it("보내기 옵션(인용·첨부·라우팅)은 마지막 메시지가 나른다 — 표현만이면 그 하나가 나른다", () => {
    const both = plan("글");
    expect(both.map((_, index) => bundleCarriesOptions(both, index))).toEqual([false, true]);
    const only = plan("");
    expect(only.map((_, index) => bundleCarriesOptions(only, index))).toEqual([true]);
  });
});

describe("앞 메시지가 대기 목록에 있는 동안은 나가지 않는다 (순서 문)", () => {
  const [a, b] = rowsOf(plan("글"));
  it("앞이 없으면 나가고, 앞이 목록에 있으면 상태와 무관하게 막힌다(보내는 중·실패 모두)", () => {
    expect(bundleMayPost(a, [a, b])).toBe(true);
    expect(bundleMayPost(b, [a, b])).toBe(false);
    expect(bundleMayPost(b, [failPending([a], a.clientMsgId)[0], b])).toBe(false);
    expect(bundleMayPost(b, [b])).toBe(true);
    expect(bundleMayPost(b, [])).toBe(true);
  });
  it("머리: 아직 확정되지 않은 가장 앞 행. 앞 행을 지우면 뒤 행이 머리다. 돌고 있는 사슬에도 멈춘다", () => {
    expect(bundleHead([a, b], b)).toBe(a);
    expect(bundleHead([a, b], a)).toBe(a);
    expect(bundleHead([b], b)).toBe(b);
    const x: PendingMessage = { ...a, clientMsgId: "x", after: "y" };
    const y: PendingMessage = { ...a, clientMsgId: "y", after: "x" };
    expect(["x", "y"]).toContain(bundleHead([x, y], x).clientMsgId);
  });
  it("뒤 행들: 저장된 차례가 거꾸로여도 닿는다", () => {
    expect(bundleTail([a, b], a.clientMsgId).map((row) => row.clientMsgId)).toEqual([a.clientMsgId, b.clientMsgId]);
    expect(bundleTail([b, a], a.clientMsgId).map((row) => row.clientMsgId)).toEqual([b.clientMsgId, a.clientMsgId]);
    expect(bundleTail([a, b], b.clientMsgId).map((row) => row.clientMsgId)).toEqual([b.clientMsgId]);
  });
  it("다시 보내기는 머리와 뒤를 함께 보내는 중으로, 머리가 실패하면 모두 실패로 돌린다", () => {
    const failed = failBundleTail([a, b], a.clientMsgId);
    expect(failed.map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(retryBundleTail(failed, a.clientMsgId).map((row) => row.status)).toEqual(["sending", "sending"]);
    // 묶음 밖의 행은 건드리지 않는다.
    const other: PendingMessage = { ...a, clientMsgId: "other", status: "failed" };
    expect(retryBundleTail([...failed, other], a.clientMsgId).find((row) => row.clientMsgId === "other")?.status).toBe("failed");
  });
});

// 가짜 서버: 같은 client_msg_id의 둘째 요청은 새 메시지를 쓰지 않는다(서버 `ON CONFLICT DO NOTHING`). 결과 대본: ok(확정) · fail(서버에 닿지 못함) ·
// lost(서버는 썼지만 응답을 놓침 — 클라이언트에는 실패다).
type Outcome = "ok" | "fail" | "lost";
function world(messages: readonly SendBundleMessage[], script: Record<number, Outcome[]> = {}) {
  let list = rowsOf(messages);
  const committed: string[] = [];
  const requests: string[] = [];
  const held: string[][] = [];
  const poster: BundlePoster = {
    list: () => list,
    post: async (row) => {
      requests.push(row.clientMsgId);
      const index = messages.findIndex((message) => message.clientMsgId === row.clientMsgId);
      const outcome = script[index]?.shift() ?? "ok";
      if (outcome !== "fail" && !committed.includes(row.clientMsgId)) committed.push(row.clientMsgId);
      if (outcome === "ok") {
        list = removePending(list, row.clientMsgId);
        return true;
      }
      list = failPending(list, row.clientMsgId);
      return false;
    },
    held: (rows, because) => {
      held.push(rows.map((row) => row.clientMsgId));
      list = failBundleTail(list, because.clientMsgId);
    },
  };
  return { poster, committed, requests, held, list: () => list, ids: messages.map((message) => message.clientMsgId) };
}

describe("보내기 순서·재시도·부분 실패", () => {
  it("정상: 앞이 확정된 뒤에 뒤가 나가고, 서버에는 이 순서로 쓰인다", async () => {
    const w = world(plan("글"));
    expect(await postBundleInOrder(w.list()[0], w.poster)).toBe(true);
    expect(w.requests).toEqual(w.ids);
    expect(w.committed).toEqual(w.ids);
    expect(w.list()).toEqual([]);
  });
  it("앞이 서버에 닿지 못하면 뒤는 요청조차 보내지 않고, 두 행이 모두 실패 모양으로 남는다(글을 잃지 않는다)", async () => {
    const w = world(plan("글"), { 0: ["fail"] });
    expect(await postBundleInOrder(w.list()[0], w.poster)).toBe(false);
    expect(w.requests).toEqual([w.ids[0]]);
    expect(w.committed).toEqual([]);
    expect(w.held).toEqual([[w.ids[1]]]);
    expect(w.list().map((row) => [row.clientMsgId, row.status])).toEqual([[w.ids[0], "failed"], [w.ids[1], "failed"]]);
  });
  it("다시 보내기: 같은 id로 앞이 나가고 이어서 뒤가 나간다 — 서버에 둘이 한 번씩, 순서대로", async () => {
    const w = world(plan("글"), { 0: ["fail", "ok"] });
    await postBundleInOrder(w.list()[0], w.poster);
    // 뒤 행에서 눌러도 머리(앞)부터다.
    const head = bundleHead(w.list(), w.list()[1]);
    expect(head.clientMsgId).toBe(w.ids[0]);
    expect(await postBundleInOrder(head, w.poster)).toBe(true);
    expect(w.requests).toEqual([w.ids[0], w.ids[0], w.ids[1]]);
    expect(w.committed).toEqual(w.ids);
    expect(w.list()).toEqual([]);
  });
  it("앞이 응답만 놓친 경우(서버는 이미 씀): 다시 보내도 앞이 두 번 쓰이지 않고 뒤가 앞지르지 못한다", async () => {
    const w = world(plan("글"), { 0: ["lost", "ok"] });
    expect(await postBundleInOrder(w.list()[0], w.poster)).toBe(false);
    expect(w.committed).toEqual([w.ids[0]]);
    expect(await postBundleInOrder(w.list()[0], w.poster)).toBe(true);
    expect(w.committed).toEqual(w.ids);
    expect(w.requests.filter((id) => id === w.ids[0])).toHaveLength(2);
    expect(w.requests.filter((id) => id === w.ids[1])).toHaveLength(1);
  });
  it("뒤만 실패하면 앞은 확정된 채이고, 뒤를 다시 보내도 앞은 다시 나가지 않는다", async () => {
    const w = world(plan("글"), { 1: ["fail", "ok"] });
    expect(await postBundleInOrder(w.list()[0], w.poster)).toBe(true);
    expect(w.list().map((row) => [row.clientMsgId, row.status])).toEqual([[w.ids[1], "failed"]]);
    expect(await postBundleInOrder(w.list()[0], w.poster)).toBe(true);
    expect(w.requests).toEqual([w.ids[0], w.ids[1], w.ids[1]]);
    expect(w.committed).toEqual(w.ids);
  });
  it("뒤 행을 곧바로 다시 보내려 해도 앞지르지 못한다 — 앞이 아직 목록에 있으면 요청이 나가지 않는다", async () => {
    const w = world(plan("글"), { 0: ["fail"] });
    await postBundleInOrder(w.list()[0], w.poster);
    const before = w.requests.length;
    expect(await postBundleInOrder(w.list()[1], w.poster)).toBe(false);
    expect(w.requests).toHaveLength(before);
    expect(w.committed).toEqual([]);
  });
  it("앞 행을 지우면(그림은 그만두고) 뒤 행은 앞이 없는 행이 되어 혼자 나간다", async () => {
    const w = world(plan("글"), { 0: ["fail"] });
    await postBundleInOrder(w.list()[0], w.poster);
    const rest = w.list().filter((row) => row.clientMsgId !== w.ids[0]);
    expect(bundleMayPost(rest[0], rest)).toBe(true);
  });
});

describe("저절로 다시 보내기와 이 기기에 남긴 실패 행이 순서를 지킨다", () => {
  const network = () => new NetworkError("unreachable", 15_000);
  const [a, b] = rowsOf(plan("글")).map((row) => ({ ...row, status: "failed" as const }));
  it("앞이 자동 재전송 상한에 닿고 뒤는 아직 남았어도 뒤가 먼저 뽑히지 않는다. 앞이 확정되면 뒤가 뽑힌다", () => {
    let exhausted: SendFailureRecord | undefined;
    for (let attempt = 0; attempt < 3; attempt++) exhausted = recordSendFailure(exhausted, network(), false, 1_000, true);
    const fresh = recordSendFailure(undefined, network(), false, 1_000, false);
    const records = new Map([[a.clientMsgId, exhausted!], [b.clientMsgId, fresh]]);
    expect(pickAutoResends([a, b], records, 2_000)).toEqual([]);
    // 앞이 확정되어 목록에서 빠지면 뒤가 뽑힌다. 이 단정이 앞의 빈 배열을 헛돌지 않게 한다.
    expect(pickAutoResends([b], records, 2_000)).toEqual([b.clientMsgId]);
  });
  it("앞이 아직 자동 대상이면 앞만 뽑히고 뒤는 같은 줄에서 기다린다", () => {
    const fresh = recordSendFailure(undefined, network(), false, 1_000, false);
    const records = new Map([[a.clientMsgId, fresh], [b.clientMsgId, fresh]]);
    expect(pickAutoResends([a, b], records, 2_000)).toEqual([a.clientMsgId]);
  });
  it("실패 행을 이 기기에 남겼다 되살려도 `after`가 따라온다. 문자열이 아니면 항목이 아니다", () => {
    const stored = parseFailedSend(serializeFailedSend(b, "offline", 5));
    expect(stored?.row.after).toBe(a.clientMsgId);
    expect(stored?.row.status).toBe("failed");
    expect(parseFailedSend(serializeFailedSend({ ...b, after: 7 as unknown as string }, null, 5))).toBeNull();
    expect(parseFailedSend(serializeFailedSend({ ...b, after: "" }, null, 5))).toBeNull();
    // 묶음이 아닌 행은 `after`가 없는 그대로다.
    expect(parseFailedSend(serializeFailedSend(a, null, 5))?.row.after).toBeUndefined();
  });
});

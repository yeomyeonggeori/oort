import { describe, expect, it } from "vitest";
import {
  createRequestBody,
  editBodyProblem,
  nextClientRequest,
  patchRequestBody,
  scheduledContentKey,
  scheduledPatch,
  type ScheduledRequestContent,
} from "./request";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const CH2 = "00000000-0000-7000-8000-000000000202";
const ROOT = "00000000-0000-7000-8000-000000000301";
const A1 = "00000000-0000-7000-8000-0000000005a1";
const A2 = "00000000-0000-7000-8000-0000000005a2";
const REQ = "00000000-0000-7000-8000-0000000006a1";
const SEND_AT = 1_800_000_000_000;

describe("create request body", () => {
  it("carries only the two required keys when there is nothing else", () => {
    expect(
      createRequestBody({ channelId: CH, sendAtMs: SEND_AT, clientRequestId: REQ })
    ).toEqual({ sendAtMs: SEND_AT, clientRequestId: REQ });
  });

  it("trims the text, and drops it when blank so an attachment-only schedule has no body key", () => {
    const base = { channelId: CH, sendAtMs: SEND_AT, clientRequestId: REQ };
    expect(createRequestBody({ ...base, body: "  자료 올려 둘게요 \n" })).toEqual({
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
      body: "자료 올려 둘게요",
    });
    expect("body" in createRequestBody({ ...base, body: "   \n " })).toBe(false);
    expect("body" in createRequestBody({ ...base, body: "" })).toBe(false);
  });

  it("includes rootId and attachmentIds only when they exist, in the order the person chose", () => {
    const body = createRequestBody({
      channelId: CH,
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
      body: "답글",
      rootId: ROOT,
      attachmentIds: [A2, A1],
    });
    expect(body).toEqual({
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
      body: "답글",
      rootId: ROOT,
      attachmentIds: [A2, A1],
    });
    const none = createRequestBody({
      channelId: CH,
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
      body: "글",
      attachmentIds: [],
    });
    expect("attachmentIds" in none).toBe(false);
    expect("rootId" in none).toBe(false);
  });

  it("never sends a key the closed server schema refuses (it is additionalProperties: false)", () => {
    const body = createRequestBody({
      channelId: CH,
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
      body: "글",
      rootId: ROOT,
      attachmentIds: [A1],
    });
    // channelId는 경로에 실리고 본문에 없다. replyToId·routing·props·type·signature는 입력 타입에 자리가 없다.
    expect(Object.keys(body).sort()).toEqual(["attachmentIds", "body", "clientRequestId", "rootId", "sendAtMs"]);
  });
});

describe("a text-only edit sends no sendAtMs (UI spec 0.6)", () => {
  const row = { body: "원래 글", sendAtMs: SEND_AT };

  it("sends only the new text when the time is untouched, and the key is absent rather than undefined", () => {
    const patch = scheduledPatch(row, { body: "고친 글", sendAtMs: SEND_AT });
    expect(patch).toEqual({ body: "고친 글" });
    const wire = patchRequestBody(patch ?? {});
    expect("sendAtMs" in JSON.parse(JSON.stringify(wire))).toBe(false);
    expect("sendAtMs" in wire).toBe(false);
  });

  it("sends no sendAtMs when the dialog has no time field at all (a sessions_ended row)", () => {
    expect(scheduledPatch(row, { body: "고친 글" })).toEqual({ body: "고친 글" });
    expect(scheduledPatch(row, { body: "고친 글", sendAtMs: null })).toEqual({ body: "고친 글" });
  });

  it("sends only the time, and no body, when only the time changed (the server moves the arming session on any body key)", () => {
    const patch = scheduledPatch(row, { body: "원래 글", sendAtMs: SEND_AT + 3_600_000 });
    expect(patch).toEqual({ sendAtMs: SEND_AT + 3_600_000 });
    expect("body" in patchRequestBody(patch ?? {})).toBe(false);
  });

  it("sends both when both changed", () => {
    expect(scheduledPatch(row, { body: "고친 글", sendAtMs: SEND_AT + 60_000 })).toEqual({
      body: "고친 글",
      sendAtMs: SEND_AT + 60_000,
    });
  });

  it("sends nothing when nothing changed, including a change that is only surrounding whitespace", () => {
    expect(scheduledPatch(row, { body: "원래 글", sendAtMs: SEND_AT })).toBeNull();
    expect(scheduledPatch(row, { body: "  원래 글\n", sendAtMs: SEND_AT })).toBeNull();
    expect(scheduledPatch(row, {})).toBeNull();
    expect(scheduledPatch({ sendAtMs: SEND_AT }, { body: "" })).toBeNull();
  });

  it("trims the text it sends", () => {
    expect(scheduledPatch(row, { body: "  고친 글 \n" })).toEqual({ body: "고친 글" });
  });

  it("serializes exactly the keys that are present", () => {
    expect(patchRequestBody({ body: "글" })).toEqual({ body: "글" });
    expect(patchRequestBody({ sendAtMs: SEND_AT })).toEqual({ sendAtMs: SEND_AT });
    expect(patchRequestBody({ body: "글", sendAtMs: SEND_AT })).toEqual({ body: "글", sendAtMs: SEND_AT });
  });

  it("refuses an emptied text only when no attachment is held (the server says 400 empty_message)", () => {
    expect(editBodyProblem({}, "   ")).toBe("empty");
    expect(editBodyProblem({ attachments: [] }, "")).toBe("empty");
    expect(editBodyProblem({}, "글")).toBeNull();
    expect(
      editBodyProblem({ attachments: [{ id: A1, name: "a.pdf", mime: "application/pdf", sizeBytes: 1 }] }, "")
    ).toBeNull();
  });
});

describe("clientRequestId is reused only for an identical request (ADR-0208 D9·D16)", () => {
  const content: ScheduledRequestContent = {
    workspaceId: WS,
    channelId: CH,
    body: "내일 회의 전에 자료 올려 둘게요",
    sendAtMs: SEND_AT,
    attachmentIds: [A1],
  };
  let counter = 0;
  const newId = (): string => `id-${(counter += 1)}`;

  it("reuses the id when the same request is retried", () => {
    counter = 0;
    const first = nextClientRequest(null, content, newId);
    const retry = nextClientRequest(first, { ...content }, newId);
    expect(retry.id).toBe(first.id);
    expect(counter).toBe(1);
  });

  it.each([
    ["body", { body: "다른 글" }],
    ["sendAtMs", { sendAtMs: SEND_AT + 60_000 }],
    ["attachmentIds (one more)", { attachmentIds: [A1, A2] }],
    ["attachmentIds (none)", { attachmentIds: [] }],
    ["attachmentIds (another file)", { attachmentIds: [A2] }],
    ["rootId", { rootId: ROOT }],
    ["channelId", { channelId: CH2 }],
  ] as const)("uses a new id when the %s changed", (_name, change) => {
    counter = 0;
    const first = nextClientRequest(null, content, newId);
    const next = nextClientRequest(first, { ...content, ...change }, newId);
    expect(next.id).not.toBe(first.id);
    expect(next.key).not.toBe(first.key);
  });

  it("treats a reordered attachment list as a different request, because the server keeps the order", () => {
    const two: ScheduledRequestContent = { ...content, attachmentIds: [A1, A2] };
    const reordered: ScheduledRequestContent = { ...content, attachmentIds: [A2, A1] };
    expect(scheduledContentKey(two)).not.toBe(scheduledContentKey(reordered));
  });

  it("ignores surrounding whitespace and UUID letter case, which the wire mixes", () => {
    counter = 0;
    const first = nextClientRequest(null, content, newId);
    const same = nextClientRequest(
      first,
      {
        ...content,
        workspaceId: WS.toUpperCase(),
        channelId: CH.toUpperCase(),
        body: `  ${content.body}\n`,
        attachmentIds: [A1.toUpperCase()],
      },
      newId
    );
    expect(same.id).toBe(first.id);
  });

  it("starts fresh after the memory is cleared (a 201 emptied the composer)", () => {
    counter = 0;
    const first = nextClientRequest(null, content, newId);
    const again = nextClientRequest(null, content, newId);
    expect(again.id).not.toBe(first.id);
  });

  it("takes the id generator from the caller instead of reading a platform global", () => {
    const memory = nextClientRequest(null, content, () => REQ);
    expect(memory.id).toBe(REQ);
  });
});

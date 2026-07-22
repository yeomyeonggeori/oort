import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationToken,
  MomoGatewayClient,
  type MomoGatewayJob,
} from "../src/momo-gateway.js";

const job: MomoGatewayJob = {
  id: 41,
  runId: "run-1",
  payload: {
    workspace_id: "workspace-1",
    channel_id: "channel-1",
    trigger_message_id: "message-1",
    prompt: "hello from momo",
  },
  createdAtMs: 1,
  leaseId: "00000000-0000-7000-8000-000000000041",
  leaseExpiresAtMs: 99,
};

test("pending -> event -> complete uses bearer and lease binding", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/pending")) return Response.json({ jobs: [job] });
    if (url.endsWith("/events")) return Response.json({ status: "accepted" });
    return Response.json({ status: "succeeded", runId: job.runId, messageId: "m-1", seq: 7 });
  };
  const client = new MomoGatewayClient({
    baseUrl: "https://momo.example",
    workspaceId: "workspace-1",
    agentMemberId: "agent-1",
    agentToken: "test-agent-token",
  }, mockFetch);

  const [claimed] = await client.pending();
  await client.running(claimed);
  const receipt = await client.complete(claimed, { status: "succeeded", body: "eve reply" });

  assert.equal(receipt.seq, 7);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer test-agent-token");
  }
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    job_id: 41,
    lease_id: job.leaseId,
    status: "succeeded",
    body: "eve reply",
  });
});

test("continuation token is scoped to momo workspace, channel, and thread", () => {
  assert.equal(
    continuationToken(job),
    "momo:workspace-1:channel-1:message-1",
  );
});

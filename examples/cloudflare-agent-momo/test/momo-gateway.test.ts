import assert from "node:assert/strict";
import test from "node:test";
import { MomoGatewayClient, type MomoGatewayJob } from "../src/momo-gateway.js";

test("fetch adapter claims and completes a gateway job", async () => {
  const job: MomoGatewayJob = {
    id: 9,
    runId: "run-cf",
    payload: { prompt: "ship it" },
    createdAtMs: 1,
    leaseId: "00000000-0000-7000-8000-000000000009",
    leaseExpiresAtMs: 99,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/pending")) return Response.json({ jobs: [job] });
    if (url.endsWith("/events")) return Response.json({ status: "accepted" });
    return Response.json({ status: "succeeded", runId: job.runId, messageId: "m-cf", seq: 11 });
  };
  const gateway = new MomoGatewayClient({
    baseUrl: "https://momo.example",
    workspaceId: "workspace-cf",
    agentMemberId: "agent-cf",
    agentToken: "cf-agent-token",
  }, mockFetch);

  const [pending] = await gateway.pending();
  await gateway.running(pending);
  const receipt = await gateway.complete(pending, "done from Workers");

  assert.equal(receipt.messageId, "m-cf");
  assert.match(calls[0].url, /gateway\/jobs\/pending/);
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    job_id: 9,
    lease_id: job.leaseId,
    status: "succeeded",
    body: "done from Workers",
  });
  assert.equal(new Headers(calls[2].init.headers).get("authorization"), "Bearer cf-agent-token");
});

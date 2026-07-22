import assert from "node:assert/strict";
import {
  continuationToken,
  MomoGatewayClient,
  promptFor,
  type MomoGatewayJob,
} from "../src/momo-gateway.js";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const humanMemberId = "00000000-0000-7000-8000-000000000101";
const agentMemberId = "00000000-0000-7000-8000-000000000103";
const channelId = "00000000-0000-7000-8000-000000000202";
const expectedBody = "MOMO-534 mock eve runtime completed the gateway job.";
const baseUrl = required("MOMO_BASE_URL").replace(/\/$/, "");

interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
}

interface CredentialResponse {
  credential: { id: string };
  token: string;
}

interface MessageResponse {
  id: string;
}

interface HistoryResponse {
  messages: Array<{ id: string; authorMemberId: string; body?: string; runId?: string }>;
}

async function api<T>(path: string, init: RequestInit = {}, bearer?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`verifier API request failed (${response.status})`);
  return await response.json() as T;
}

async function mockEveSend(job: MomoGatewayJob): Promise<string> {
  const prompt = promptFor(job);
  assert.match(prompt, /MOMO-534/);
  assert.equal(
    continuationToken(job),
    `momo:${workspaceId}:${channelId}:${job.payload.trigger_message_id}`,
  );
  return expectedBody;
}

async function main(): Promise<void> {
  let accessToken = "";
  let refreshToken = "";
  let credentialId = "";
  try {
    const login = await api<LoginResponse>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "demo@momo.local",
        password: "dev-password",
        workspace: workspaceId,
      }),
    });
    accessToken = login.accessToken;
    refreshToken = login.refreshToken ?? "";

    const credential = await api<CredentialResponse>(
      `/v1/workspaces/${workspaceId}/agents/${agentMemberId}/credentials`,
      {
        method: "POST",
        body: JSON.stringify({ label: "MOMO-534 verifier" }),
      },
      accessToken,
    );
    credentialId = credential.credential.id;

    await api<MessageResponse>(
      `/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMsgId: crypto.randomUUID(),
          type: "text",
          body: "@hermes MOMO-534 mock eve channel roundtrip",
          props: { gate: "MOMO-534", runtime: "mock-eve" },
        }),
      },
      accessToken,
    );

    const gateway = new MomoGatewayClient({
      baseUrl,
      workspaceId,
      agentMemberId,
      agentToken: credential.token,
    });
    const [job] = await gateway.pending(1);
    assert.ok(job, "momo gateway returned no pending job");
    assert.equal(String(job.payload.workspace_id).toLowerCase(), workspaceId);
    assert.equal(String(job.payload.channel_id).toLowerCase(), channelId);
    assert.equal(String(job.payload.agent_member_id).toLowerCase(), agentMemberId);

    await gateway.running(job, "mock eve send() accepted momo work");
    const body = await mockEveSend(job);
    const receipt = await gateway.complete(job, {
      status: "succeeded",
      body,
      usage: {
        model: "mock-eve",
        prompt_tokens: 1,
        completion_tokens: 1,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost_micro_usd: 0,
        was_estimated: true,
      },
    });
    assert.ok(receipt.seq > 0);

    const history = await api<HistoryResponse>(
      `/v1/workspaces/${workspaceId}/channels/${channelId}/messages?limit=50`,
      {},
      accessToken,
    );
    const final = history.messages.find((message) => message.id === receipt.messageId);
    assert.ok(final, "gateway receipt message is absent from momo history");
    assert.equal(final.authorMemberId.toLowerCase(), agentMemberId);
    assert.equal(final.body, expectedBody);

    console.log("[momo-channel] PASS pending -> mock eve send() -> momo message -> callback");
  } finally {
    if (accessToken && credentialId) {
      await api(
        `/v1/workspaces/${workspaceId}/agents/${agentMemberId}/credentials/${credentialId}/revoke`,
        { method: "POST", body: JSON.stringify({ reason: "MOMO-534 verifier cleanup" }) },
        accessToken,
      ).catch(() => undefined);
    }
    if (accessToken && refreshToken) {
      await api(
        "/v1/auth/logout",
        { method: "POST", body: JSON.stringify({ refreshToken }) },
        accessToken,
      ).catch(() => undefined);
    }
  }
}

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

await main();

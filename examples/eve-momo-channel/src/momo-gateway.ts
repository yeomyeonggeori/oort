export interface MomoGatewayConfig {
  baseUrl: string;
  workspaceId: string;
  agentMemberId: string;
  agentToken: string;
}

export interface MomoGatewayJob {
  id: number;
  runId: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
  leaseId: string;
  leaseExpiresAtMs: number;
}

export interface MomoCompletion {
  status: "succeeded" | "failed";
  body?: string;
  error?: string;
  usage?: {
    model?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
    cost_micro_usd?: number;
    was_estimated?: boolean;
  };
}

export interface MomoCompletionReceipt {
  status: string;
  runId: string;
  messageId: string;
  seq: number;
}

type FetchLike = typeof fetch;

export class MomoGatewayClient {
  constructor(
    readonly config: MomoGatewayConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!config.agentToken) throw new Error("MOMO_AGENT_TOKEN is required");
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MomoGatewayClient {
    return new MomoGatewayClient({
      baseUrl: required(env, "MOMO_BASE_URL").replace(/\/$/, ""),
      workspaceId: required(env, "MOMO_WORKSPACE_ID"),
      agentMemberId: required(env, "MOMO_AGENT_MEMBER_ID"),
      agentToken: required(env, "MOMO_AGENT_TOKEN"),
    });
  }

  async pending(limit = 1): Promise<MomoGatewayJob[]> {
    const path = `/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}`
      + `/agents/${encodeURIComponent(this.config.agentMemberId)}`
      + `/gateway/jobs/pending?limit=${Math.min(Math.max(limit, 1), 100)}`;
    const result = await this.request<{ jobs: MomoGatewayJob[] }>(path);
    return result.jobs;
  }

  async running(job: MomoGatewayJob, detail = "eve accepted the momo job"): Promise<void> {
    await this.request(
      `/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}`
        + `/agent-runs/${encodeURIComponent(job.runId)}/gateway/events`,
      {
        method: "POST",
        body: JSON.stringify({
          job_id: job.id,
          lease_id: job.leaseId,
          status: "running",
          detail,
        }),
      },
    );
  }

  async complete(job: MomoGatewayJob, completion: MomoCompletion): Promise<MomoCompletionReceipt> {
    return this.request<MomoCompletionReceipt>(
      `/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}`
        + `/agent-runs/${encodeURIComponent(job.runId)}/gateway/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          job_id: job.id,
          lease_id: job.leaseId,
          ...completion,
        }),
      },
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.config.agentToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`momo gateway request failed (${response.status})`);
    }
    return await response.json() as T;
  }
}

export function continuationToken(job: MomoGatewayJob): string {
  const workspaceId = text(job.payload.workspace_id);
  const channelId = text(job.payload.channel_id);
  const threadKey = text(job.payload.root_id) || text(job.payload.trigger_message_id) || "root";
  if (!workspaceId || !channelId) throw new Error("momo job is missing workspace_id/channel_id");
  return `momo:${workspaceId}:${channelId}:${threadKey}`;
}

export function promptFor(job: MomoGatewayJob): string {
  return text(job.payload.prompt) || text(job.payload.body) || "Continue the momo conversation.";
}

export function completedText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const value = event as Record<string, unknown>;
  return text(value.text) || text(value.content) || text(value.message);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

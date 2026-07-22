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

  async pending(limit = 1): Promise<MomoGatewayJob[]> {
    const path = `/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}`
      + `/agents/${encodeURIComponent(this.config.agentMemberId)}`
      + `/gateway/jobs/pending?limit=${Math.min(Math.max(limit, 1), 100)}`;
    const response = await this.request<{ jobs: MomoGatewayJob[] }>(path);
    return response.jobs;
  }

  async running(job: MomoGatewayJob): Promise<void> {
    await this.request(this.eventPath(job), {
      method: "POST",
      body: JSON.stringify({
        job_id: job.id,
        lease_id: job.leaseId,
        status: "running",
        detail: "Cloudflare Agent accepted the momo job",
      }),
    });
  }

  async complete(job: MomoGatewayJob, body: string): Promise<MomoCompletionReceipt> {
    return this.request<MomoCompletionReceipt>(
      `/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}`
        + `/agent-runs/${encodeURIComponent(job.runId)}/gateway/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          job_id: job.id,
          lease_id: job.leaseId,
          status: "succeeded",
          body,
        }),
      },
    );
  }

  private eventPath(job: MomoGatewayJob): string {
    return `/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}`
      + `/agent-runs/${encodeURIComponent(job.runId)}/gateway/events`;
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
    if (!response.ok) throw new Error(`momo gateway request failed (${response.status})`);
    return await response.json() as T;
  }
}

export function promptFor(job: MomoGatewayJob): string {
  const prompt = job.payload.prompt;
  return typeof prompt === "string" && prompt.trim()
    ? prompt.trim()
    : "Continue the momo conversation.";
}

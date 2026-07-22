import { Agent, routeAgentRequest } from "agents";
import {
  MomoGatewayClient,
  type MomoGatewayJob,
  promptFor,
} from "./momo-gateway.js";

export interface Env {
  MomoAgent: DurableObjectNamespace<MomoAgent>;
  MOMO_BASE_URL: string;
  MOMO_WORKSPACE_ID: string;
  MOMO_AGENT_MEMBER_ID: string;
  MOMO_AGENT_TOKEN: string;
  MOMO_CHANNEL_ROUTE_TOKEN: string;
}

interface MomoAgentState {
  lastCompletedRunId: string | null;
}

export class MomoAgent extends Agent<Env, MomoAgentState> {
  initialState: MomoAgentState = { lastCompletedRunId: null };

  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/poll")) return new Response("Not found", { status: 404 });
    const routeToken = this.env.MOMO_CHANNEL_ROUTE_TOKEN?.trim();
    if (!routeToken || request.headers.get("authorization") !== `Bearer ${routeToken}`) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
      });
    }
    const receipt = await this.pollOnce();
    return receipt
      ? Response.json({ accepted: true, ...receipt })
      : Response.json({ accepted: false });
  }

  protected async handleMomoJob(job: MomoGatewayJob): Promise<string> {
    // Replace this method with the platform agent's real model/tool loop.
    return `Cloudflare Agent received: ${promptFor(job)}`;
  }

  private gateway(): MomoGatewayClient {
    return new MomoGatewayClient({
      baseUrl: this.env.MOMO_BASE_URL.replace(/\/$/, ""),
      workspaceId: this.env.MOMO_WORKSPACE_ID,
      agentMemberId: this.env.MOMO_AGENT_MEMBER_ID,
      agentToken: this.env.MOMO_AGENT_TOKEN,
    });
  }

  private async pollOnce(): Promise<{ runId: string; messageId: string; seq: number } | null> {
    const gateway = this.gateway();
    const [job] = await gateway.pending(1);
    if (!job) return null;
    await gateway.running(job);
    const body = await this.handleMomoJob(job);
    const receipt = await gateway.complete(job, body);
    this.setState({ lastCompletedRunId: job.runId });
    return { runId: job.runId, messageId: receipt.messageId, seq: receipt.seq };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await routeAgentRequest(request, env) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

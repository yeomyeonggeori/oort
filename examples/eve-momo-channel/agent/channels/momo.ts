import { defineChannel, POST } from "eve/channels";
import {
  extractBearerToken,
  routeAuth,
  type AuthFn,
} from "eve/channels/auth";
import {
  completedText,
  continuationToken,
  MomoGatewayClient,
  type MomoGatewayJob,
  promptFor,
} from "../../src/momo-gateway.js";

interface MomoChannelState {
  job: MomoGatewayJob | null;
}

const gateway = MomoGatewayClient.fromEnv();

const pollRouteAuth: AuthFn<Request> = async (request) => {
  const presented = extractBearerToken(request.headers.get("authorization"));
  const expected = process.env.MOMO_CHANNEL_ROUTE_TOKEN?.trim();
  if (!expected || presented !== expected) return null;
  return {
    attributes: {},
    authenticator: "momo-channel",
    principalId: gateway.config.agentMemberId,
    principalType: "service",
  };
};

export default defineChannel<MomoChannelState, { state: MomoChannelState }>({
  state: { job: null },
  context(state) {
    return { state };
  },
  routes: [
    POST("/poll", async (request, { send }) => {
      const auth = await routeAuth(request, pollRouteAuth);
      if (auth instanceof Response) return auth;
      const [job] = await gateway.pending(1);
      if (!job) return Response.json({ accepted: false });

      await gateway.running(job);
      const session = await send(promptFor(job), {
        auth,
        continuationToken: continuationToken(job),
        state: { job },
      });
      return Response.json({ accepted: true, runId: job.runId, sessionId: session.id });
    }),
  ],
  events: {
    async "message.completed"(event, channel) {
      const job = channel.state.job;
      if (!job) return;
      const body = completedText(event);
      await gateway.complete(job, {
        status: body ? "succeeded" : "failed",
        ...(body ? { body } : { error: "eve completed without message text" }),
      });
      channel.state.job = null;
    },
  },
});

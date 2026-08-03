import type {Centrifuge, Subscription} from 'centrifuge';
import {
  asMessageDeletedFrame,
  asReactionFrame,
  centrifugoAgentChannelName,
  centrifugoChannelName,
  createReplayGate,
  type AgentProgressEvent,
  type MessageDeletedEvent,
  type MessageNewEvent,
  type ReactionEvent,
  type RealtimeHandle,
  type SubscribedRecoveryContext,
} from '@momo/core/lib/realtimeEvents';

// =============================================================================
// `subscribeChannel`, implemented at last.
//
// `centrifugeTransport.ts` landed in goal RN-C3 with a note saying it did not
// implement `RealtimeHandle` because there was no caller: "Writing it now would
// be writing it against no caller." The timeline is that caller, so the half of
// the interface it needs is written here — and only that half.
//
// ## Why this is a SLICE and not the whole `RealtimeHandle`
//
// The core's `RealtimeHandle` has six subscribe methods. Four of them still
// serve surfaces this client does not have: work sessions, provider-cascade
// notices and huddles. Implementing them now would repeat exactly the mistake
// the scaffold refused to make, and worse — untested subscription bookkeeping
// that looks finished is more dangerous than an absent method, because the
// batch that finally needs it will trust it.
//
// So the type below is a structural SLICE of the core interface
// (`Pick<RealtimeHandle, "subscribeChannel" | "subscribeAgent">`). It is not a
// parallel invention: each signature is checked against the core's by the
// `Pick`, so the day the other four arrive they widen this type rather than
// reconciling with it. `subscribeAgent` is the first one to arrive that way —
// goal RN-T2 added it verbatim, which is why the `Pick` grew by one name and
// nothing else about this file's shape changed.
//
// ## The refcount is not premature
//
// One Centrifugo subscription per channel name, shared, released by the last
// caller. Two callers exist the moment a conversation is open on this client:
// the timeline, and the same channel's re-subscribe after the background policy
// cycles the socket. `clients/web/src/lib/realtime.ts` learned this the hard
// way with its notification rail — the first caller to unmount unsubscribed a
// channel the other was still reading. Copying the ownership rule costs 20
// lines; rediscovering it costs a silent dead feed.
//
// ## The replay gate is on the agent rail and NOT on the message rail
//
// The web sibling gates replays on the agent, work-session and huddle rails and
// not on the message one, and this follows it exactly. Message frames are keyed
// by `seq` and `reconcileMessages` folds a replayed publication onto the row it
// already holds, so a replay is harmless — and it is not merely harmless, it is
// the point: the gap is exactly what a recovering subscription is for.
//
// A progress frame carries no `seq` and nothing folds it onto anything. It is a
// claim that an agent is working RIGHT NOW, so a replayed one is a claim about
// a turn that ended during the gap. `infra/centrifugo.json` gives the `agent`
// namespace `force_recovery: true` with 24h of history, which means asking for
// `recoverable: false` is a request the server declines — the flags below are
// documentation and `createReplayGate` is the actual defence. Measured on web
// 2026-07-25: a 25s cut replayed all 8 frames of a finished turn on resubscribe.
// =============================================================================

export type ChannelHandlers = Parameters<
  RealtimeHandle['subscribeChannel']
>[2];

export type AgentHandlers = Parameters<RealtimeHandle['subscribeAgent']>[3];

/**
 * The slice of the core's realtime port this client implements.
 *
 * Both methods are taken from `RealtimeHandle` by `Pick`, so neither signature
 * can drift from the core's contract without a type error here.
 */
export type ChannelRail = Pick<
  RealtimeHandle,
  'subscribeChannel' | 'subscribeAgent'
>;

/**
 * Wire the message rail onto an already-built Centrifuge client.
 *
 * Takes the client rather than a URL because the socket's lifecycle belongs to
 * `createRealtimeTransport` — it owns the background grace period, the network
 * -type reconnect and the token source (ADR-0137 D4). Two things opening
 * sockets would mean two sockets, and the second one would not honour any of
 * that policy.
 */
export function createChannelRail(getClient: () => Centrifuge): ChannelRail {
  const shared = new Map<string, {sub: Subscription; refs: number}>();

  function attach(
    name: string,
    options: {recoverable: boolean; positioned: boolean},
    wire: (sub: Subscription) => () => void,
  ): () => void {
    const client = getClient();
    let entry = shared.get(name);
    if (!entry) {
      // `getSubscription` first: centrifuge-js throws if a second subscription
      // is created for a name it already holds, and it can hold one this map
      // does not know about after a reconnect rebuilt them.
      const sub =
        client.getSubscription(name) ?? client.newSubscription(name, options);
      entry = {sub, refs: 0};
      shared.set(name, entry);
    }
    entry.refs += 1;
    const sub = entry.sub;
    const detach = wire(sub);
    if (sub.state !== 'subscribed') sub.subscribe();

    let released = false;
    return () => {
      // A double cleanup must not release someone else's ref. React runs effect
      // cleanups twice under StrictMode, so this is a real path, not a defence
      // against a hypothetical caller.
      if (released) return;
      released = true;
      detach();
      const current = shared.get(name);
      if (!current || current.sub !== sub) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      shared.delete(name);
      sub.unsubscribe();
      client.removeSubscription(sub);
    };
  }

  return {
    subscribeChannel(workspaceId, channelId, handlers: ChannelHandlers) {
      return attach(
        centrifugoChannelName(workspaceId, channelId),
        {recoverable: true, positioned: true},
        sub => {
          const onSubscribed = (ctx: {recovered?: boolean}) => {
            handlers.onSubscribed(ctx.recovered === true);
          };
          const onPublication = (ctx: {data?: unknown}) => {
            const event = ctx.data as MessageNewEvent | undefined;
            if (
              event &&
              (event.type === 'message.new' ||
                event.type === 'message.edited') &&
              event.payload
            ) {
              handlers.onMessage(event);
              return;
            }
            // The tombstone and reaction frames ride the same channel as the
            // message they annotate and reuse its `seq`, so they arrive here in
            // order behind it rather than on a rail of their own.
            const tombstone: MessageDeletedEvent | null = asMessageDeletedFrame(
              ctx.data,
            );
            if (tombstone) {
              handlers.onMessageDeleted?.(tombstone);
              return;
            }
            const reaction: ReactionEvent | null = asReactionFrame(ctx.data);
            if (reaction) handlers.onReaction?.(reaction);
          };
          sub.on('subscribed', onSubscribed);
          sub.on('publication', onPublication);
          return () => {
            sub.off('subscribed', onSubscribed);
            sub.off('publication', onPublication);
          };
        },
      );
    },

    subscribeAgent(workspaceId, channelId, agentMemberId, handlers: AgentHandlers) {
      // `agent:ws<WS>.<CHANNEL>.<AGENT>` — one subscription per (channel, agent)
      // pair, because that is the granularity the subscribe proxy authorises:
      // it grants the channel only when the observer AND the target agent are
      // both active members of that exact channel (`realtime.rs` ParsedChannel
      // ::Agent). A per-channel wildcard does not exist to ask for.
      return attach(
        centrifugoAgentChannelName(workspaceId, channelId, agentMemberId),
        {recoverable: false, positioned: false},
        sub => {
          const gate = createReplayGate();
          const onSubscribed = (ctx: SubscribedRecoveryContext) =>
            gate.onSubscribed(ctx);
          const onPublication = (ctx: {data?: unknown}) => {
            if (gate.isReplaying()) return;
            const event = ctx.data as AgentProgressEvent | undefined;
            if (
              event &&
              (event.type === 'agent.status' ||
                event.type === 'agent.partial') &&
              event.payload
            ) {
              handlers.onEvent(event);
            }
          };
          sub.on('subscribed', onSubscribed);
          sub.on('publication', onPublication);
          return () => {
            sub.off('subscribed', onSubscribed);
            sub.off('publication', onPublication);
          };
        },
      );
    },
  };
}

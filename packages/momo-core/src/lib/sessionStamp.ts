import { apiBase, coreSession } from "../runtime/host";

// =============================================================================
// Which session a request goes out as (#5816).
//
// A request is retried — after a 401's rotation, or as the rest of a batch —
// only as the session that started it: the same person, on the same server,
// under the same sign-in in this context. When that session has ended, the
// request fails instead of going out again with whatever is stored now.
//
// Kept apart from `./api` so a host module that only needs the stamp does not
// pull the whole request layer in (and test doubles of `./api` leave it real).
// =============================================================================

export interface SessionStamp {
  /** Bumped whenever this context adopts a sign-in or ends a session. */
  readonly epoch: number;
  /** `workspaceId:memberId` of the stored session, lowercased; null when none. */
  readonly member: string | null;
  /** The stored server. */
  readonly server: string;
}

let epoch = 0;

/** A sign-in was adopted, or a session ended, in this context. */
export function nextSessionEpoch(): void {
  epoch += 1;
}

/** The session a request sent now goes out as. */
export function sessionStamp(): SessionStamp {
  const member = coreSession().getPersistedSession()?.member;
  return {
    epoch,
    member: member ? `${member.workspaceId}:${member.id}`.toLowerCase() : null,
    server: apiBase(),
  };
}

/** The session `stamp` names is still the stored one. */
export function isCurrentSession(stamp: SessionStamp): boolean {
  const now = sessionStamp();
  return now.epoch === stamp.epoch && now.member === stamp.member && now.server === stamp.server;
}

/**
 * A session other than `stamp`'s is stored now — another person, another
 * server, or a sign-in made after it — as opposed to none at all. An answer to
 * `stamp`'s request must not spend, resend with, or declare over that one.
 */
export function anotherSessionStored(stamp: SessionStamp): boolean {
  return sessionStamp().member !== null && !isCurrentSession(stamp);
}

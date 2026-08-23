export type MemberProfileViewState =
  | "ready"
  | "loading"
  | "error"
  | "empty"
  | "offline";

/**
 * The profile card's mandatory surface states. Cached identity wins over a
 * background query failure; offline is explicit even when that cache exists.
 */
export function memberProfileViewState({
  hasMember,
  pending,
  failed,
  hasCachedRoster,
  offline,
}: {
  hasMember: boolean;
  pending: boolean;
  failed: boolean;
  hasCachedRoster: boolean;
  offline: boolean;
}): MemberProfileViewState {
  if (offline) return "offline";
  if (hasMember) return "ready";
  if (pending && !hasCachedRoster) return "loading";
  if (failed && !hasCachedRoster) return "error";
  return "empty";
}

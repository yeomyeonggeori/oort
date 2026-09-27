// =============================================================================
// 이 맥을 작업 호스트로 (ADR-0188 D2 · R1, #2778).
//
// The desktop shell carries `momo-workd` and reports what this Mac is
// (`work_host_status`). The server's registry says whether the host is online
// (90 s heartbeat window). This module turns the two into ONE state the settings
// block renders, so 「등록됐지만 오프라인」 and 「아직 없음」 can never be the same
// sentence (planner decision on #2778, design-review #2886 M-1·M-2).
//
// Pure: no shell call, no fetch. The shell bridge lives in clients/web.
// =============================================================================

import type { WorkHost } from "./api";

/** `work_host_status`, as the shell sends it (`work_host.rs` `LocalStatus`). */
export interface LocalWorkHostStatus {
  sidecar: boolean;
  registered: {
    hostId: string;
    workspaceId: string;
    ownerMemberId: string;
    serverUrl: string;
  } | null;
  running: boolean;
  heartbeat: { lastOkAtMs: number | null; failing: boolean } | null;
  adapters: { key: string; executable: string; found: boolean }[];
  workFolder: string;
  displayNameSuggestion: string;
}

export type ThisMacState =
  /** This build has no `momo-workd` (a development build without the sidecar). */
  | { kind: "no_sidecar" }
  /** Not registered. `ready`: an ACP adapter was found, so it can be. */
  | { kind: "not_registered"; ready: boolean }
  /** Registered to another workspace or server than the one open now. */
  | { kind: "elsewhere" }
  /** Registered here, but the server revoked the row (or no longer has it). */
  | { kind: "revoked" }
  /** Registered, not online. `stopped`: the app is not running it. */
  | {
      kind: "offline";
      reason: "stopped" | "not_reaching_server";
      lastSeenAtMs?: number;
    }
  | { kind: "online" };

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The one state for the block.
 *
 * `registry` is the server's list, or `undefined` while it has not answered;
 * `serverOrigin` the origin this app talks to. Online is the SERVER's word when
 * it has one (the list polls at half the heartbeat window); until then the local
 * heartbeat decides, so a fresh registration does not read as offline for 30 s.
 */
export function thisMacState(
  local: LocalWorkHostStatus,
  registry: WorkHost[] | undefined,
  workspaceId: string,
  serverOrigin: string
): ThisMacState {
  if (!local.sidecar) return { kind: "no_sidecar" };
  const registered = local.registered;
  if (!registered) {
    return {
      kind: "not_registered",
      ready: local.adapters.some((adapter) => adapter.found),
    };
  }
  if (
    !sameId(registered.workspaceId, workspaceId) ||
    !sameOrigin(registered.serverUrl, serverOrigin)
  ) {
    return { kind: "elsewhere" };
  }
  const row = registry?.find((host) => sameId(host.id, registered.hostId));
  if (registry && (!row || row.revokedAtMs)) return { kind: "revoked" };
  if (!local.running) {
    return { kind: "offline", reason: "stopped", lastSeenAtMs: row?.lastSeenAtMs };
  }
  const localOk = local.heartbeat !== null && !local.heartbeat.failing;
  const online = row ? row.online || localOk : localOk;
  if (online) return { kind: "online" };
  return {
    kind: "offline",
    reason: "not_reaching_server",
    lastSeenAtMs: row?.lastSeenAtMs ?? local.heartbeat?.lastOkAtMs ?? undefined,
  };
}

/** The shell's error codes, in words a person can act on. */
export function thisMacErrorMessage(code: string): string {
  const head = code.split(":")[0]?.trim() ?? code;
  switch (head) {
    case "no_acp_adapter":
      return "ACP 어댑터를 찾지 못했습니다. claude-agent-acp나 codex-acp를 설치한 뒤 다시 확인하세요.";
    case "already_registered":
      return "이 맥은 이미 호스트로 등록돼 있습니다. 목록을 다시 불러오세요.";
    case "not_signed_in":
      return "로그인이 만료되었습니다. 다시 로그인한 뒤 등록하세요.";
    case "server_url_invalid":
      return "이 서버 주소로는 호스트를 등록할 수 없습니다. https 주소인지 확인하세요.";
    case "display_name_invalid":
      return "호스트 이름은 1자 이상 80자 이하로 적어 주세요.";
    case "sidecar_missing":
      return "이 빌드에는 작업 호스트 프로그램이 들어 있지 않습니다.";
    case "timeout":
      return "등록이 90초 안에 끝나지 않았습니다. 네트워크를 확인하고 다시 시도하세요.";
    case "register_failed":
      return "서버가 등록을 받지 않았습니다. 네트워크와 로그인 상태를 확인하고 다시 시도하세요.";
    case "forget_failed":
      return "이 맥의 등록 정보를 지우지 못했습니다. 앱을 다시 연 뒤 시도하세요.";
    case "unsupported_platform":
      return "작업 호스트는 macOS 앱에서만 켤 수 있습니다.";
    default:
      return "작업 호스트를 바꾸지 못했습니다. 잠시 뒤 다시 시도하세요.";
  }
}

// ---- owner notices (ADR-0188 D2: 「등록 사실을 소유자의 모든 기기에 알린다」) ----

/** The owner's user-limited channel; the realtime token's `sub` is this id. */
export function workHostNoticeChannelName(memberId: string): string {
  return `user:work-host#${memberId.toUpperCase()}`;
}

export interface WorkHostNotice {
  type: "work_host.registered" | "work_host.revoked";
  hostId: string;
  workspaceId: string;
  displayName: string;
  actorMemberId: string;
}

/** A publication on that channel, or `null` for anything else. */
export function asWorkHostNotice(data: unknown): WorkHostNotice | null {
  if (!data || typeof data !== "object") return null;
  const frame = data as { type?: unknown; payload?: Record<string, unknown> };
  if (frame.type !== "work_host.registered" && frame.type !== "work_host.revoked") {
    return null;
  }
  const p = frame.payload;
  if (!p || typeof p !== "object") return null;
  const text = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : null);
  const hostId = text("host_id");
  const workspaceId = text("workspace_id");
  const displayName = text("display_name");
  const actorMemberId = text("actor_member_id");
  if (!hostId || !workspaceId || displayName === null || !actorMemberId) return null;
  return { type: frame.type, hostId, workspaceId, displayName, actorMemberId };
}

/** The OS notification for a notice. */
export function workHostNoticeText(
  notice: WorkHostNotice,
  selfMemberId: string
): { title: string; body: string } {
  const byMe = sameId(notice.actorMemberId, selfMemberId);
  if (notice.type === "work_host.registered") {
    return {
      title: "작업 호스트가 등록되었습니다",
      body: `${notice.displayName}. 직접 등록하지 않았다면 설정의 코드 실행 호스트에서 해지하세요.`,
    };
  }
  return {
    title: "작업 호스트 등록이 해지되었습니다",
    body: byMe
      ? `${notice.displayName}. 이 호스트로는 더 이상 작업이 가지 않습니다.`
      : `${notice.displayName}. 관리자가 해지했습니다. 이 호스트로는 더 이상 작업이 가지 않습니다.`,
  };
}

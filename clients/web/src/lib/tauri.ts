// =============================================================================
// Desktop shell bridge (ADR-0133 P2, MOMO-603).
//
// The SAME bundle runs in a browser tab and inside the Tauri shell, so every
// native capability has to be optional at runtime, not at build time. This file
// is the only place in `clients/web` that knows that: everywhere else calls a
// plain async function and gets a browser-shaped answer (nothing found, no
// permission, no keychain) when there is no shell underneath.
//
// The Rust half lives in `clients/desktop/src-tauri/src/{deeplink,discovery,
// notification,keychain,session_refresh,updater,detect,harness_status,opener,
// pdf_viewer,pty,git_read,work_host,device_key}.rs` and the
// command/event contract is documented in `clients/desktop/README.md`. Keep
// the three in sync — a renamed command fails at runtime, not at compile time.
//
// `@tauri-apps/api` is imported DYNAMICALLY on purpose. Vite splits it into its
// own chunk that a browser tab never requests, so the desktop bridge costs the
// web build nothing but a few bytes of guard code.
// =============================================================================

import { IS_TAURI } from "./env";
import type { HostedAgentProbe as HostedAgentProbeWire } from "@momo/core/features/hostedAgents/detect";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";
import type {
  HarnessProfileRef,
  ProfileRemoveOutcome,
} from "@momo/core/features/settings/harnessProfiles";
import type {
  GitReadCommand,
  GitReadResult,
} from "@momo/core/features/workbench/gitRead";

/** True when the native commands below can actually do something. */
export function isDesktop(): boolean {
  return IS_TAURI;
}

/** Event names emitted by the shell. Mirrors the Rust `*_EVENT` constants. */
export const DESKTOP_EVENT = {
  /** One accepted `momo://join` link. */
  deepLink: "momo:deep-link",
  /** The full current set of discovered servers. */
  discovery: "momo:discovery",
  /** Bytes downloaded so far while an update installs. */
  updateProgress: "momo:update-progress",
} as const;

// ---- module plumbing --------------------------------------------------------

type CoreModule = typeof import("@tauri-apps/api/core");
type EventModule = typeof import("@tauri-apps/api/event");

let corePromise: Promise<CoreModule> | null = null;
let eventPromise: Promise<EventModule> | null = null;

function core(): Promise<CoreModule> {
  corePromise ??= import("@tauri-apps/api/core");
  return corePromise;
}

function events(): Promise<EventModule> {
  eventPromise ??= import("@tauri-apps/api/event");
  return eventPromise;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await core();
  return call<T>(command, args);
}

/** No-op unsubscribe, so callers can treat browser and desktop identically. */
const noop = () => {};

/**
 * Subscribe to a shell event. Resolves to the unsubscribe function; in a browser
 * it resolves immediately to a no-op, so `useEffect` cleanup stays uniform.
 */
async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!IS_TAURI) return noop;
  const { listen: subscribe } = await events();
  const unlisten = await subscribe<T>(event, ({ payload }) => handler(payload));
  return unlisten;
}

// ---- deep links -------------------------------------------------------------

/**
 * A `momo://join` link the OS handed to the shell.
 *
 * Contract: `docs/onboarding-deeplink.md`. `server` and `code` arrive
 * percent-decoded and trimmed; either may be empty (a link carrying only one of
 * them still saves typing), never both. `server` is NOT validated as a base URL
 * by the shell — the join surface re-validates it, exactly as the macOS client
 * does, so that rule keeps a single owner.
 */
export interface DeepLinkJoin {
  /** The raw link. Carries the invite code — do not log it. */
  url: string;
  server: string;
  code: string;
}

/** Listen for links that arrive while the app is running. */
export function onDeepLink(handler: (link: DeepLinkJoin) => void): Promise<() => void> {
  return listen<DeepLinkJoin>(DESKTOP_EVENT.deepLink, handler);
}

/**
 * Drain links that arrived before this webview could listen, and tell the shell
 * it is now listening.
 *
 * Clicking an invite link with the app closed launches it, and macOS delivers
 * the URL long before React mounts. The shell buffers those; this call is the
 * handshake that releases them. Call it ONCE, right after `onDeepLink` resolves
 * — earlier and the buffer is released to nobody, twice and the second call
 * returns nothing.
 */
export async function takePendingDeepLinks(): Promise<DeepLinkJoin[]> {
  if (!IS_TAURI) return [];
  return invoke<DeepLinkJoin[]>("deep_link_take_pending");
}

// ---- LAN server discovery ---------------------------------------------------

/**
 * A server advertised on the LAN as `_momo._tcp`. The advertisement carries the
 * machine's `.local` name (TXT `base`) and its LAN address (TXT `ipv4`); the
 * shell has already chosen the one this runtime can dial (MOMO-609).
 */
export interface DiscoveredServer {
  /** The address to dial, exactly as advertised — this is what gets prefilled. */
  baseUrl: string;
  /** Short label naming the machine, e.g. `MacBook-Pro-2.local:28000`. */
  displayHost: string;
  /** Bonjour instance name, e.g. `momo`. */
  instanceName: string;
}

export interface DiscoveryPayload {
  servers: DiscoveredServer[];
  /** False on the last event of a scan. */
  scanning: boolean;
}

/** Listen for discovery results. The shell emits the FULL set every time. */
export function onDiscovery(handler: (payload: DiscoveryPayload) => void): Promise<() => void> {
  return listen<DiscoveryPayload>(DESKTOP_EVENT.discovery, handler);
}

/**
 * Start a scan. Results arrive through `onDiscovery`, so subscribe first.
 *
 * Never rejects: no responder, no permission and nothing on the network are the
 * same outcome to the person looking at the screen — an empty list — and
 * discovery is an offer, not a step. The cause is logged for the console.
 */
export async function startDiscovery(timeoutMs?: number): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke<void>("discovery_start", { timeoutMs });
  } catch (error) {
    console.warn("[momo] server discovery unavailable", error);
  }
}

/** Stop a scan early. Idempotent. */
export async function stopDiscovery(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke<void>("discovery_stop");
  } catch {
    /* nothing to stop */
  }
}

// ---- external links ---------------------------------------------------------

/**
 * Open an https link in the OS browser. Returns false when it did not open.
 *
 * `target="_blank"` is enough in a browser tab and does NOTHING in this shell:
 * wry leaves WKWebView's new-window request unimplemented, so an anchor that
 * works in Chrome is a dead control in the desktop build. Callers therefore ask
 * here first and only fall back to the anchor's own behaviour in a browser.
 *
 * A refusal is a return value, not an exception: the Rust side re-validates the
 * address and the caller has an inline failure state either way, so there is
 * nothing for a throw to add.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    await invoke<void>("open_external_url", { url });
    return true;
  } catch (error) {
    console.warn("[momo] external link did not open", error);
    return false;
  }
}

// ---- PDF attachments (#2701) ------------------------------------------------

/**
 * Open PDF bytes in the OS default viewer. Throws when the shell refused or the
 * viewer did not launch; a browser tab has no such path and throws too.
 *
 * The bytes go as a RAW invoke body (no JSON number array for a 100 MB file),
 * and the display name rides a percent-encoded header because a raw body has
 * nowhere else to carry it. The Rust side (`pdf_viewer.rs`) re-checks the
 * `%PDF-` header and derives its own `.pdf` file name from this one.
 */
export async function openPdfInDesktopViewer(
  bytes: Uint8Array,
  name: string
): Promise<void> {
  if (!IS_TAURI) throw new Error("desktop viewer unavailable");
  const { invoke: call } = await core();
  await call<void>("open_pdf_attachment", bytes, {
    headers: { "x-oort-file-name": encodeURIComponent(name) },
  });
}

// ---- local hosted-agent detection (T-5) ------------------------------------

/**
 * One allowlisted detector, observed. Product copy lives in momo-core, not here.
 *
 * A browser tab always sees `[]`. A failed native probe is the same as "nothing
 * found": the invite surface stays silent rather than drawing an error about
 * a missing optional app.
 */
export type HostedAgentProbe = HostedAgentProbeWire;

/** Passive signatures only. Never scans ports. Empty when not in the shell. */
export async function detectHostedAgents(): Promise<HostedAgentProbe[]> {
  if (!IS_TAURI) return [];
  try {
    return await invoke<HostedAgentProbe[]>("detect_hosted_agents");
  } catch {
    return [];
  }
}

// ---- local harness detection (#2813) ---------------------------------------

/**
 * `claude`·`codex` on this Mac and what each CLI says about its login, as
 * three values (ADR-0190 D3-a). The shell runs only `claude auth status` and
 * `codex login status`, reads the exit code only, and takes no arguments from
 * here. A browser tab and a failed call both read as "not installed".
 */
export async function detectLocalHarnesses(): Promise<LocalHarnessProbe[]> {
  // Loaded on call, like `@tauri-apps/api`, so the boot chunk does not grow.
  const { normalizeLocalHarnessProbes } = await import(
    "@momo/core/features/hostedAgents/detect"
  );
  if (!IS_TAURI) return normalizeLocalHarnessProbes([]);
  try {
    return normalizeLocalHarnessProbes(
      await invoke<unknown>("detect_local_harnesses")
    );
  } catch {
    return normalizeLocalHarnessProbes([]);
  }
}

// ---- account profiles (#2878, ADR-0191 D1, ADR-0190 D3-f) ---------------------

/**
 * oort 프로필 폴더. 웹뷰는 하네스 id와 라벨만 넘기고, 폴더는 셸이 정하고 검사한다
 * (`harness_profile.rs`). 브라우저 탭에는 프로필이 없다: 목록은 빈 배열, 나머지는
 * 거부한다.
 */
export async function harnessProfileList(): Promise<HarnessProfileRef[]> {
  const { normalizeProfileList } = await import("@momo/core/features/settings/harnessProfiles");
  if (!IS_TAURI) return [];
  try {
    return normalizeProfileList(await invoke<unknown>("harness_profile_list"));
  } catch {
    return [];
  }
}

/** 새 빈 프로필 폴더. 같은 라벨이 있으면 셸이 거부한다(「already exists」). */
export async function harnessProfileCreate(profile: HarnessProfileRef): Promise<void> {
  if (!IS_TAURI) throw new Error("not_desktop");
  await invoke<void>("harness_profile_create", { profile });
}

/** 그 프로필 폴더로 돌린 D3-a 상태 명령. 실패하면 「모름」. */
export async function harnessProfileStatus(profile: HarnessProfileRef): Promise<LocalHarnessProbe> {
  const unknown: LocalHarnessProbe = { id: profile.harness, installed: false, auth: "unknown" };
  if (!IS_TAURI) return unknown;
  try {
    const { normalizeLocalHarnessProbes } = await import(
      "@momo/core/features/hostedAgents/detect"
    );
    const raw = await invoke<unknown>("harness_profile_status", { profile });
    return normalizeLocalHarnessProbes([raw]).find((row) => row.id === profile.harness) ?? unknown;
  } catch {
    return unknown;
  }
}

/**
 * 폴더 삭제. 셸이 상태 명령을 다시 돌려 「로그인 안 됨」일 때만 지운다. 거부(경로
 * 검사 실패)는 reject, 지우지 않은 결말은 `still_signed_in`·`unknown`.
 */
export async function harnessProfileRemove(profile: HarnessProfileRef): Promise<ProfileRemoveOutcome> {
  if (!IS_TAURI) throw new Error("not_desktop");
  const { normalizeRemoveOutcome } = await import("@momo/core/features/settings/harnessProfiles");
  return normalizeRemoveOutcome(await invoke<unknown>("harness_profile_remove", { profile }));
}

// ---- local terminal lane (#2772 shell, #2774 panes) ---------------------------

/**
 * What a pane asks the shell to run. Never a path or an argv: `shell` is the
 * login shell, `harness` one id the shell resolves on this Mac (ADR-0190 D1·D3),
 * `login` one row of the shell's sign-in list (ADR-0190 D3-f, #2816) — only the
 * sign-in dialog builds it, never the dock.
 */
export type PtyProgram =
  | { kind: "shell" }
  | {
      kind: "harness";
      id: "claude" | "codex" | "grok";
      /**
       * 프로필 라벨(#3010, ADR-0191 D1): 기본 AI 표의 「로컬 터미널 새 세션」 선택.
       * 없으면 이 맥의 기본 위치. 셸이 폴더를 정하고, 폴더가 없으면 거부한다.
       */
      profile?: string;
    }
  | {
      kind: "login";
      id: "claude" | "codex";
      method: "browser" | "device";
      /** 프로필 라벨(#2878). 없으면 이 맥의 기본 위치. 셸이 폴더를 정한다. */
      profile?: string;
    }
  /** 공식 CLI 로그아웃(ADR-0190 D3-f A2·A5). 늘 oort 프로필이다. */
  | { kind: "logout"; id: "claude" | "codex"; profile: string };

export interface PtyExit {
  id: number;
  code: number | null;
  signal: string | null;
}

export interface PtySpawnRequest {
  program: PtyProgram;
  cols: number;
  rows: number;
}

/**
 * The five `pty_*` commands, desktop only (README 「pty_spawn」 줄). Output
 * arrives raw on `onOutput` and must be acknowledged with `ack` (batched, see
 * `@momo/core/features/workbench/ptyFlow`). A browser tab has no PTY: every
 * method rejects there, and the dock that calls them is never mounted.
 */
export const desktopPty = {
  async spawn(
    request: PtySpawnRequest,
    onOutput: (bytes: ArrayBuffer) => void,
    onExit: (exit: PtyExit) => void,
    /**
     * A harness hook's status signal for this session (#2776,
     * `pane_signal.rs`): one of `PaneSignal` in `@momo/core` workbench
     * `paneStatus`. Unknown values arrive as-is; the caller filters them.
     * Never derived from output.
     */
    onSignal: (signal: unknown) => void = () => undefined
  ): Promise<number> {
    if (!IS_TAURI) throw new Error("local terminal unavailable");
    const { invoke: call, Channel } = await core();
    const output = new Channel<ArrayBuffer>();
    output.onmessage = onOutput;
    const exit = new Channel<PtyExit>();
    exit.onmessage = onExit;
    const signal = new Channel<unknown>();
    signal.onmessage = onSignal;
    return call<number>("pty_spawn", { request, onOutput: output, onExit: exit, onSignal: signal });
  },

  /**
   * One raw body of at most 1 MiB. Calls reach the child in the order they
   * were made, so a caller does not await one before the next. Rejects with a
   * message starting `busy` when the child is not reading its input.
   */
  async write(id: number, bytes: Uint8Array): Promise<void> {
    if (!IS_TAURI) throw new Error("local terminal unavailable");
    const { invoke: call } = await core();
    await call<void>("pty_write", bytes, { headers: { "x-oort-pty-id": String(id) } });
  },

  async resize(id: number, cols: number, rows: number): Promise<void> {
    if (!IS_TAURI) throw new Error("local terminal unavailable");
    await invoke<void>("pty_resize", { id, cols, rows });
  },

  async kill(id: number): Promise<void> {
    if (!IS_TAURI) throw new Error("local terminal unavailable");
    await invoke<void>("pty_kill", { id });
  },

  async ack(id: number, bytes: number): Promise<void> {
    if (!IS_TAURI) throw new Error("local terminal unavailable");
    await invoke<void>("pty_ack", { id, bytes });
  },
};

// ---- local git reads (#2855) --------------------------------------------------

/**
 * One of the eight fixed git reads (ADR-0190 D3-c) in the folder pane
 * `paneId` (a `desktopPty.spawn` id) was opened in. The page names a command
 * number and a pane only; the shell parses stdout and returns fields — never
 * a commit subject, file contents, a remote URL or a full path. Nothing goes
 * to the server. A browser tab, a closed pane or a failed call read as
 * `unknown`.
 */
export async function readWorkbenchGit(
  command: GitReadCommand,
  paneId: number
): Promise<GitReadResult> {
  const { normalizeGitReadResult, GIT_READ_UNKNOWN } = await import(
    "@momo/core/features/workbench/gitRead"
  );
  if (!IS_TAURI) return GIT_READ_UNKNOWN;
  try {
    return normalizeGitReadResult(
      await invoke<unknown>("workbench_git_read", { request: { command, paneId } })
    );
  } catch {
    return GIT_READ_UNKNOWN;
  }
}

// ---- this Mac as a work host (#2778, ADR-0188 D2) -----------------------------

/**
 * The five `work_host_*` commands (`clients/desktop/src-tauri/src/work_host.rs`).
 * Every call rejects with the shell's error code (a short snake_case string,
 * `thisMacErrorMessage` turns it into a sentence); in a browser tab each one
 * rejects with `unsupported_platform`, and `status` resolves `null`.
 *
 * `register` hands the owner's access token to the shell, which passes it to
 * `momo-workd register` in that child's environment only.
 */
export const desktopWorkHost = {
  async status(): Promise<LocalWorkHostStatus | null> {
    if (!IS_TAURI) return null;
    return invoke<LocalWorkHostStatus>("work_host_status");
  },
  async register(request: {
    serverUrl: string;
    workspaceId: string;
    displayName: string;
    accessToken: string;
  }): Promise<LocalWorkHostStatus> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke<LocalWorkHostStatus>("work_host_register", { request });
  },
  async start(): Promise<LocalWorkHostStatus> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke<LocalWorkHostStatus>("work_host_start");
  },
  async stop(): Promise<LocalWorkHostStatus> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke<LocalWorkHostStatus>("work_host_stop");
  },
  async forget(): Promise<LocalWorkHostStatus> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke<LocalWorkHostStatus>("work_host_forget");
  },
};

// ---- this Mac's device key (#3025, ADR-0146 개정 R2 D-3·D-6·D-7) -------------

/** `device_key_status` (`clients/desktop/src-tauri/src/device_key/mod.rs`). */
export interface DesktopDeviceKeyStatus {
  support:
    | "ready"
    | "absent"
    | "unsupported"
    | "unsigned_build"
    | "entitlement_missing"
    | "error";
  detail: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  root: { keyId: string; memberId: string; publicKey: string } | null;
  reuseWindowSeconds: number;
  host: DesktopHostPin | null;
}

/** `device_key::HostPin` — this Mac's workd, as it says it. */
export interface DesktopHostPin {
  running: boolean;
  /** The host is this workspace's and this bound root's member's. */
  matches: boolean;
  pinnedRootKeyId: string | null;
  /**
   * R2 on this host (#3117): `enforced` refuses unsigned instructions,
   * `server_only` is the half state (the server requires signatures, this host
   * does not yet — no root pinned), `off` neither. Absent from a shell before
   * #3117.
   */
  signatureEnforcement?: "enforced" | "server_only" | "off";
  /** The host is this workspace's, with or without a bound root (#3129). */
  workspaceMatches?: boolean;
  /** What the server last told the host; null before its first answer. */
  serverRequiresSignatures?: boolean | null;
  /** Why the host enforces. */
  signaturesRequiredBy?: "config" | "server" | "unreadable" | null;
}

/** `device_key_sign_control`'s request (`payload::ControlRequest`). A spawn
 * with `sessionId` is a resume: the successor id the owner signs (v2). */
export interface DesktopControlRequest {
  workspaceId: string;
  instanceId: string;
  hostId: string;
  sessionId?: string | null;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  content:
    | { kind: "input"; mode: "queue" | "interrupt"; text: string }
    | {
        kind: "spawn";
        agentMemberId: string;
        folderId: string;
        /** v2 (#3028): the harness and the session channel are signed. */
        tool: string;
        channelId: string;
        firstPrompt: string;
      }
    | {
        kind: "permission";
        requestEventId: string;
        optionId: string;
        optionKind: string;
        scope: "once" | "session";
        /** #3128 (control v3): the host's preview as the card rendered it.
         * The shell re-hashes it, refuses a cut one and shows it in its dialog. */
        preview: unknown;
        /** The page's hash of it; must equal the shell's own. */
        previewSha256: string;
      }
    | { kind: "bundle_manifest"; manifest: unknown }
    | { kind: "host_register"; hostPublicKeyB64: string; hostId: string; label: string };
}

/** What happened on the local workd socket. */
export type DesktopHostDelivery =
  | { state: "delivered" }
  | { state: "notRunning" }
  | { state: "otherHost" }
  | { state: "refused"; reason: string };

/**
 * The eight `device_key_*` commands. The webview never passes bytes to sign:
 * each call names the statement's fields and the shell builds, shows (native
 * dialog) and signs it. Rejections are the shell's short codes
 * (`device_key_declined`, `device_key_cancelled`, `device_key_unsigned_build`…).
 */
export const desktopDeviceKey = {
  async status(workspaceId?: string): Promise<DesktopDeviceKeyStatus | null> {
    if (!IS_TAURI) return null;
    return invoke<DesktopDeviceKeyStatus>("device_key_status", {
      request: workspaceId ? { workspaceId } : null,
    });
  },
  async create(): Promise<DesktopDeviceKeyStatus> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke<DesktopDeviceKeyStatus>("device_key_create");
  },
  async bindRoot(request: {
    workspaceId: string;
    memberId: string;
    keyId: string;
    publicKey: string;
  }): Promise<{ status: DesktopDeviceKeyStatus; host: DesktopHostDelivery }> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke("device_key_bind_root", { request });
  },
  /** `momo.human.control.v2` (#3028: the reply box and resume) and, for an
   * allow, `momo.human.control.v3` over the checked preview (#3128). */
  async signControl(request: DesktopControlRequest): Promise<{
    deviceKeyId: string;
    devicePublicKey: string;
    signature: string;
    payloadSha256: string;
  }> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke("device_key_sign_control", { request });
  },
  async signEndorse(request: {
    workspaceId: string;
    targetKeyId: string;
    targetAlg: "p256";
    targetPublicKey: string;
    label: string;
  }): Promise<{ targetKeyId: string; rootKeyId: string; signature: string }> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke("device_key_sign_endorse", { request });
  },
  /**
   * `device_revoke.v2`. Names the key by id only: the shell signs the public
   * key it recorded when it endorsed that id, never one from this page (#3028,
   * E7 인계 ③). An id this Mac never endorsed → `device_key_not_endorsed_here`.
   */
  async signRevoke(request: {
    workspaceId: string;
    targetKeyId: string;
    targetLabel: string;
  }): Promise<{
    rootKeyId: string;
    targetKeyId: string;
    revokedAtMs: number;
    signature: string;
    host: DesktopHostDelivery;
  }> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke("device_key_sign_revoke", { request });
  },
  /** Re-send a letter this shell signed (it keeps them; nothing else is sent). */
  async deliverRevocation(request: {
    workspaceId: string;
    targetKeyId: string;
  }): Promise<DesktopHostDelivery> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke<DesktopHostDelivery>("device_key_deliver_revocation", { request });
  },
  /**
   * `device_rebind.v1` (#3103, ADR-0146 D-7 증보 #3097): this Mac's key, left
   * live on a sign-in that ended without revoking it, signs its own move onto
   * `sessionId` (`signing-context`). The shell puts its enclave's public key in
   * the letter and shows it natively; this page posts the result as `rebind`.
   */
  async signRebind(request: {
    workspaceId: string;
    memberId: string;
    keyId: string;
    sessionId: string;
  }): Promise<{ keyId: string; publicKey: string; signedAtMs: number; signature: string }> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke("device_key_sign_rebind", { request });
  },
  /**
   * Lower this Mac's workd signature latch (#3129; `reset_signature_requirement`,
   * #3117). The shell asks in its native dialog first — this page cannot
   * lower it quietly; a "no" is `device_key_declined`. `required` is what the
   * host says right after (its own config can keep it on). A server that still
   * requires signatures latches it again on the next poll: read the status
   * again, never assume it is off.
   */
  async resetSignatureRequirement(workspaceId: string): Promise<{ required: boolean }> {
    if (!IS_TAURI) throw "unsupported_platform";
    return invoke("device_key_reset_signature_requirement", { request: { workspaceId } });
  },
};

// ---- OS terminal (#2814) ------------------------------------------------------

/**
 * Bring Terminal.app forward (ADR-0193 D2 Phase 1). Takes no arguments: the
 * page copies the command to the clipboard itself, and the shell runs no CLI
 * for the person. Resolves false in a browser tab or when the launch failed,
 * so the caller can say "copy it and open the terminal yourself".
 */
export async function openTerminalApp(): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    await invoke<void>("open_terminal_app");
    return true;
  } catch {
    return false;
  }
}

// ---- native notifications ---------------------------------------------------

/** Same vocabulary as the browser Notification API, minus the prompt variants. */
export type DesktopNotificationPermission = "granted" | "denied" | "default";

/** Current permission, without prompting. */
export async function notificationPermission(): Promise<DesktopNotificationPermission> {
  if (!IS_TAURI) return "denied";
  try {
    return await invoke<DesktopNotificationPermission>("notification_permission");
  } catch {
    return "denied";
  }
}

let permissionPromise: Promise<DesktopNotificationPermission> | null = null;

/**
 * Ensure permission, asking at most once per app run.
 *
 * The prompt is deliberately not fired at boot: an OS permission dialog before
 * someone has any reason to want notifications is the fastest way to get a
 * permanent "no". Call this at the moment a notification is first worth showing.
 */
export async function ensureNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!IS_TAURI) return "denied";
  permissionPromise ??= (async () => {
    const current = await notificationPermission();
    if (current !== "default") return current;
    return requestNotificationPermission();
  })();
  return permissionPromise;
}

/**
 * Ask the OS now. Settings uses this for the 「알림 켜기」 control; the fire
 * path still goes through `ensureNotificationPermission` so a first banner can
 * prompt when nobody opened settings.
 *
 * The result replaces the per-run cache, so a grant from settings is what
 * `showNotification` sees on the next event.
 */
export async function requestNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!IS_TAURI) return "denied";
  let next: DesktopNotificationPermission;
  try {
    next = await invoke<DesktopNotificationPermission>(
      "notification_request_permission"
    );
  } catch {
    next = "denied";
  }
  permissionPromise = Promise.resolve(next);
  return next;
}

/**
 * Show one native notification. Returns false when it was not shown — in a
 * browser, or because permission is not granted. A refused notification is a
 * normal state, so it is a return value rather than a thrown error.
 */
export async function showNotification(title: string, body?: string): Promise<boolean> {
  if (!IS_TAURI) return false;
  if ((await ensureNotificationPermission()) !== "granted") return false;
  try {
    return await invoke<boolean>("notification_show", { title, body });
  } catch (error) {
    console.warn("[momo] native notification failed", error);
    return false;
  }
}

// ---- OS credential store ----------------------------------------------------

/**
 * The refresh token at rest, in the OS keychain instead of localStorage.
 *
 * Consumed by `./session.ts`, which is the only caller that should exist: the
 * point of moving the token out of web storage is that fewer places can reach
 * it, and a second caller would undo that.
 *
 * Reads and writes can block on an OS prompt, so every method is async and none
 * of them throws — a keychain that will not answer degrades the session to web
 * storage rather than blocking sign-in (see `session.ts`).
 */
export const desktopKeychain = {
  /** True when this platform has a credential store this build can use. */
  async available(): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      return await invoke<boolean>("keychain_available");
    } catch {
      return false;
    }
  },

  /**
   * A handle for the stored refresh token (`shell:` + 32 hex of its SHA-256),
   * or null when there is no session to resume (#3106). The token itself
   * never comes back from the shell: the shell rotates it
   * (`desktopSession.refreshAttempt`), so the webview only needs to tell one
   * stored token from another.
   */
  async handle(): Promise<string | null> {
    if (!IS_TAURI) return null;
    try {
      return await invoke<string | null>("keychain_refresh_token_handle");
    } catch (error) {
      console.warn("[momo] keychain read failed", error);
      return null;
    }
  },

  /**
   * Store (replacing) the refresh token, pinned to the server `origin` it
   * belongs to — the shell presents it nowhere else (#3106). Returns false
   * if it did not land.
   */
  async store(token: string, origin?: string): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      await invoke<void>("keychain_store_refresh_token", { token, origin: origin || null });
      return true;
    } catch (error) {
      console.warn("[momo] keychain write failed", error);
      return false;
    }
  },

  /** Delete the stored refresh token. Succeeds when there was nothing to delete. */
  async clear(): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      await invoke<void>("keychain_clear_refresh_token");
      return true;
    } catch (error) {
      console.warn("[momo] keychain clear failed", error);
      return false;
    }
  },
};

/**
 * Tells the shell a refresh rotation is open (#3098), so closing the window
 * waits — bounded, in Rust — until the rotated token is in the keychain
 * instead of destroying the webview with the response or the write in flight.
 * `begin` answers whether the shell took it; only then is `end` owed.
 */
export const desktopRotationHold = {
  async begin(): Promise<boolean> {
    if (!IS_TAURI) return false;
    try {
      await invoke<void>("session_rotation_begin");
      return true;
    } catch {
      return false;
    }
  },

  async end(): Promise<void> {
    if (!IS_TAURI) return;
    try {
      await invoke<void>("session_rotation_end");
    } catch {
      // The shell's cap (CLOSE_WAIT_CAP) bounds a hold nobody released.
    }
  },
};

/** The shell's `AttemptAnswer` (session_refresh/mod.rs). */
export interface DesktopRefreshAnswer {
  status: number;
  code?: string;
  date?: string;
  accessToken?: string;
  /** A handle, never the token. */
  refreshToken?: string;
  proved: boolean;
}

/**
 * The refresh rotation, carried by the shell (#3106, ADR-0146 D-7 증보 #3079):
 * it reads the token it keeps, signs `momo.human.refresh_proof.v1` with this
 * Mac's refresh key, POSTs, stores the successor, and answers with the access
 * token and a handle. `refreshAttempt` rejects when nothing answered (the core
 * reads that as `unreachable` and keeps the session).
 */
export const desktopSession = {
  async refreshAttempt(request: {
    apiBase: string;
    workspaceId: string;
    memberId: string;
    skewMs: number;
  }): Promise<DesktopRefreshAnswer> {
    return invoke<DesktopRefreshAnswer>("session_refresh_attempt", { request });
  },

  /** Logout's server half, with the token only the shell holds. */
  async revoke(request: {
    apiBase: string;
    accessToken: string;
    workspaceId: string;
    memberId: string;
  }): Promise<boolean> {
    return invoke<boolean>("session_revoke", { request });
  },
};

// ---- self-update ------------------------------------------------------------

/** The build this shell is running, e.g. `0.1.0-next.1`. Null in a browser. */
export async function appVersion(): Promise<string | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<string>("app_version");
  } catch {
    return null;
  }
}

/** A newer build announced by the update manifest. */
export interface AvailableUpdate {
  /** The version on offer. */
  version: string;
  /** The version running now, so the offer can be shown as a transition. */
  currentVersion: string;
  /** Release notes from the manifest. May be absent. */
  notes: string | null;
  /** The manifest's publish timestamp (RFC 3339), verbatim. May be absent. */
  publishedAt: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** Null when the server sent no Content-Length. */
  total: number | null;
}

/**
 * Self-update, in three separate acts (ADR-0133 P2, MOMO-606).
 *
 * Unlike the rest of this file, `check` and `install` REJECT on failure instead
 * of degrading quietly. "I could not reach the update server" and "you are on
 * the latest build" must never look the same to a tester, or a stalled release
 * channel stays invisible until someone reports a bug that was fixed a week
 * ago. `relaunch` is the exception and by nature: it never returns.
 */
export const desktopUpdater = {
  /** Ask the manifest. Resolves to null when this build is current. */
  async check(): Promise<AvailableUpdate | null> {
    if (!IS_TAURI) return null;
    return invoke<AvailableUpdate | null>("updater_check");
  },

  /**
   * Download, verify (minisign) and swap the app bundle on disk. Does NOT
   * restart: on macOS the running process keeps executing the old image until
   * it exits, so when to restart is the person's call, not ours.
   */
  async install(): Promise<void> {
    if (!IS_TAURI) return;
    return invoke<void>("updater_install");
  },

  /** Restart into the installed build. Never resolves. */
  async relaunch(): Promise<void> {
    if (!IS_TAURI) return;
    return invoke<void>("updater_relaunch");
  },

  /** Download progress while `install` runs. */
  onProgress(handler: (progress: UpdateProgress) => void): Promise<() => void> {
    return listen<UpdateProgress>(DESKTOP_EVENT.updateProgress, handler);
  },
};

// =============================================================================
// The desktop app's signer and the signed work paths (#3028 R2-E8; ADR-0146
// 개정 2026-09-28 D-3 · D-5b · D-8 · D-11).
//
// The desktop shell holds the Secure Enclave key; this page names a
// statement's fields and the shell builds, shows (native dialog) and signs it
// (`device_key_sign_control`: control v2, and v3 for an allow — #3128, the
// shell re-hashes the preview the card showed and shows it in its dialog). Everything after the signature is
// the shared core flow (`@momo/core/features/auth/signedControl`), which the
// phone uses with its own signer.
//
// A browser tab never signs (D-4): these paths are for the desktop shell only,
// and only when the server says signatures are required. Otherwise every
// surface keeps today's behaviour (D-11).
// =============================================================================

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchHumanControlSignatureRequired,
  fetchSigningContext,
  type SigningContext,
} from "@momo/core/features/auth/deviceKeys";
import {
  agentMemberIdFromEvents,
  ALLOW_NEEDS_PREVIEW_LINE,
  RESUME_AGENT_UNKNOWN_LINE,
  signedResume,
  SignerRefusal,
  type ControlToSign,
  type HumanControlSigner,
} from "@momo/core/features/auth/signedControl";
import {
  permissionPreviewGate,
  type PermissionPreviewGate,
} from "@momo/core/features/workbench/permissionPreviewGate";
import type { PendingPermission } from "@momo/core/features/workbench/agentPane";
import {
  fetchWorkPermissionPreview,
  fetchWorkSessions,
  resumeWorkSession,
  uuidEq,
  type HumanSignatureRequest,
  type WorkSession,
} from "@momo/core/lib/api";
import { desktopDeviceKey, isDesktop, type DesktopControlRequest } from "@/lib/tauri";
import { fetchSessionEvents } from "./useWorkSessions";

export const SIGNING_REQUIRED_KEY = (workspaceId: string) =>
  ["device-keys", workspaceId, "signing-context", "human-control-required"] as const;

/**
 * Does this server require a device signature on an allow or an instruction
 * (`signing-context` `humanControlSignatureRequired`)? `null` = unknown (a
 * server before E3, no instance id, a network error): never read as on (D-11).
 * `signed`: this is the desktop shell AND the server says yes — the only case
 * in which this page signs.
 */
export function useHumanControlSigning(
  workspaceId: string,
  enabled: boolean
): { signatureRequired: boolean | null; signed: boolean; recheck: () => void } {
  const client = useQueryClient();
  const key = SIGNING_REQUIRED_KEY(workspaceId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchHumanControlSignatureRequired(workspaceId),
    enabled,
    staleTime: 5 * 60_000,
  });
  const signatureRequired = query.data ?? null;
  return {
    signatureRequired,
    signed: isDesktop() && signatureRequired === true,
    recheck: () => void client.invalidateQueries({ queryKey: key }),
  };
}

/**
 * The owner's read of the open request's host preview, through the shared
 * gate (#3128). `permission` null = nothing to read (not signing, not the
 * owner, no request). Read once per request; a failed read says so, it never
 * falls back to the inferred preview.
 */
export function usePermissionPreviewGate(
  workspaceId: string,
  sessionId: string,
  permission: PendingPermission | null
): PermissionPreviewGate {
  const requestEventId = permission?.requestEventId ?? "";
  const read = useQuery({
    queryKey: ["work-permission-preview", workspaceId, sessionId, requestEventId] as const,
    queryFn: () => fetchWorkPermissionPreview(workspaceId, sessionId, requestEventId),
    enabled: permission !== null,
    staleTime: Infinity,
    retry: 1,
    // A failed read tries again on its own (the card's sentence says so).
    refetchInterval: (query) => (query.state.status === "error" ? 15_000 : false),
  });
  return permissionPreviewGate(
    permission?.previewSha256 ?? null,
    read.data ? { status: "ok", data: read.data } : read.isError ? { status: "error" } : { status: "loading" }
  );
}

/** How long a signed statement lives: a Touch ID prompt and one request. The
 * server caps it at `maxLifetimeMs` (10 min). */
export const STATEMENT_LIFETIME_MS = 2 * 60_000;

/**
 * The shell's refusal codes (`device_key_*`) as the agent pane's 해요체
 * sentences. `cancelled` = the person said no; nothing was sent.
 */
export function desktopSignerRefusal(code: unknown): SignerRefusal {
  if (code instanceof SignerRefusal) return code;
  const raw = typeof code === "string" ? code : "";
  const key = raw.split(":")[0]!.trim();
  switch (key) {
    case "device_key_declined":
    case "device_key_cancelled":
      return new SignerRefusal("서명을 취소해서 보내지 않았어요.", true);
    case "device_key_auth_failed":
      return new SignerRefusal("본인 확인에 실패해 보내지 않았어요. 다시 보내 주세요.");
    case "device_key_not_root_here":
    case "device_key_absent":
    case "device_key_changed":
      return new SignerRefusal(
        "이 맥이 이 워크스페이스의 지시 서명 기기로 등록돼 있지 않아요. 설정 › 기기 › 지시 서명에서 등록해 주세요."
      );
    case "device_key_unsigned_build":
    case "device_key_entitlement_missing":
    case "device_key_unsupported":
    case "unsupported_platform":
      return new SignerRefusal("이 빌드에서는 기기 서명을 할 수 없어요. 팀 배포 앱에서 보내 주세요.");
    case "device_key_payload_rejected":
      // #3128: the shell's own check of the preview (hash, cut, shape).
      if (/^device_key_payload_rejected:\s*preview_sha256: mismatch/.test(raw)) {
        return new SignerRefusal(
          "보여 준 미리보기가 요청과 맞지 않아 서명하지 않았어요. 거부하거나 호스트에서 결정해 주세요."
        );
      }
      if (/^device_key_payload_rejected:\s*preview: truncated/.test(raw)) {
        return new SignerRefusal(
          "미리보기가 잘려 서명하지 않았어요. 전체를 보지 않고는 허락할 수 없어요. 거부하거나 호스트에서 결정해 주세요."
        );
      }
      if (/^device_key_payload_rejected:\s*preview/.test(raw)) {
        return new SignerRefusal(
          "미리보기를 확인할 수 없어 서명하지 않았어요. 거부하거나 호스트에서 결정해 주세요."
        );
      }
      return new SignerRefusal(
        "보이지 않는 문자나 올바르지 않은 값이 있어 서명하지 않았어요. 내용을 고친 뒤 다시 보내 주세요."
      );
    default:
      return new SignerRefusal("기기 서명을 하지 못해 보내지 않았어요. 다시 보내 주세요.");
  }
}

export interface DesktopSignerDeps {
  context: (workspaceId: string) => Promise<SigningContext>;
  sign: typeof desktopDeviceKey.signControl;
  now: () => number;
}

const DEFAULT_DEPS: DesktopSignerDeps = {
  context: fetchSigningContext,
  sign: (request) => desktopDeviceKey.signControl(request),
  now: () => Date.now(),
};

function shellContent(control: ControlToSign): DesktopControlRequest["content"] {
  const content = control.content;
  switch (content.kind) {
    case "input":
      return { kind: "input", mode: content.mode, text: content.text };
    case "permission":
      // #3128: no preview, no allow (the shell refuses too; this is earlier).
      if (!control.permissionPreview || !content.previewSha256) {
        throw new SignerRefusal(ALLOW_NEEDS_PREVIEW_LINE);
      }
      return {
        kind: "permission",
        requestEventId: content.requestEventId,
        optionId: content.optionId,
        optionKind: content.optionKind,
        scope: content.scope,
        preview: control.permissionPreview,
        previewSha256: content.previewSha256,
      };
    case "spawn_task":
      // #3592: every field the statement signs, as the page holds it.
      return {
        kind: "spawn_task",
        agentMemberId: content.agentMemberId,
        folderId: content.folderId,
        tool: content.tool,
        channelId: content.channelId,
        threadRootId: content.threadRootId,
        originMessageId: content.originMessageId,
        label: content.label,
        prompt: content.prompt,
      };
    case "spawn":
      return {
        kind: "spawn",
        agentMemberId: content.agentMemberId,
        folderId: content.folderId,
        tool: content.tool,
        channelId: content.channelId,
        firstPrompt: content.firstPrompt,
      };
  }
}

/**
 * The desktop shell as a `HumanControlSigner`. The signing context is read
 * fresh for every statement: its `instanceId` is echoed verbatim (D-5) and its
 * clock corrects this Mac's (D-9), so a Mac whose clock is off still signs a
 * statement the server accepts.
 */
/**
 * The exact request the shell's `device_key_sign_control` receives for one
 * statement (`payload::ControlRequest`, `deny_unknown_fields`). Pure, so the
 * cross test can hand the same JSON to the Rust builder
 * (`clients/desktop/src-tauri/src/device_key/payload/tests.rs`).
 */
export function shellControlRequest(
  workspaceId: string,
  instanceId: string,
  control: ControlToSign,
  issuedAtMs: number,
  expiresAtMs: number
): DesktopControlRequest {
  return {
    workspaceId,
    instanceId,
    hostId: control.hostId,
    sessionId: control.sessionId,
    nonce: control.nonce,
    issuedAtMs,
    expiresAtMs,
    content: shellContent(control),
  };
}

/** The wire envelope from the shell's answer: exactly the server's keys. */
export function envelopeFromShell(
  control: ControlToSign,
  signed: { deviceKeyId: string; signature: string },
  issuedAtMs: number,
  expiresAtMs: number
): HumanSignatureRequest {
  const content = control.content;
  const envelope: HumanSignatureRequest = {
    deviceKeyId: signed.deviceKeyId,
    nonce: control.nonce,
    issuedAtMs,
    expiresAtMs,
    signature: signed.signature,
  };
  if (content.kind === "input") envelope.mode = content.mode;
  if (content.kind === "permission") envelope.scope = content.scope;
  if (content.kind === "spawn") {
    envelope.agentMemberId = content.agentMemberId;
    envelope.folderId = content.folderId;
  }
  if (content.kind === "spawn_task") {
    if (content.agentMemberId !== null) envelope.agentMemberId = content.agentMemberId;
    envelope.folderId = content.folderId;
  }
  return envelope;
}

/**
 * The desktop shell as a `HumanControlSigner`. The signing context is read
 * fresh for every statement: its `instanceId` is echoed verbatim (D-5) and its
 * clock corrects this Mac's (D-9), so a Mac whose clock is off still signs a
 * statement the server accepts.
 */
export function desktopSigner(
  workspaceId: string,
  deps: DesktopSignerDeps = DEFAULT_DEPS
): HumanControlSigner {
  return {
    async sign(control) {
      const before = deps.now();
      const context = await deps.context(workspaceId);
      const readAt = (before + deps.now()) / 2;
      const issuedAtMs = Math.round(deps.now() + (context.serverTimeMs - readAt));
      const expiresAtMs = issuedAtMs + Math.min(STATEMENT_LIFETIME_MS, context.maxLifetimeMs);
      let signed: Awaited<ReturnType<DesktopSignerDeps["sign"]>>;
      try {
        signed = await deps.sign(
          shellControlRequest(workspaceId, context.instanceId, control, issuedAtMs, expiresAtMs)
        );
      } catch (code) {
        throw desktopSignerRefusal(code);
      }
      return envelopeFromShell(control, signed, issuedAtMs, expiresAtMs);
    },
  };
}

/**
 * Resume on a chosen host. On a signing desktop the owner names the successor
 * and signs it (ADR-0146 증보 E7 「서명 재개」); everywhere else, as before.
 * The agent the signed spawn names comes from the session's own events.
 * `source` may be an id (a workstream run): the session is then looked up.
 */
export function useResumeWorkSession(workspaceId: string, signed: boolean) {
  return useCallback(
    async (source: WorkSession | string, targetHostId: string): Promise<WorkSession> => {
      const sourceId = typeof source === "string" ? source : source.id;
      if (!signed) return resumeWorkSession(workspaceId, sourceId, targetHostId);
      const session =
        typeof source === "string"
          ? (await fetchWorkSessions(workspaceId)).find((s) => uuidEq(s.id, source))
          : source;
      if (!session) throw new SignerRefusal(RESUME_AGENT_UNKNOWN_LINE);
      const page = await fetchSessionEvents(workspaceId, session.channelId, session.rootMessageId);
      const agent = agentMemberIdFromEvents(page.events);
      if (!agent) throw new SignerRefusal(RESUME_AGENT_UNKNOWN_LINE);
      return signedResume({
        workspaceId,
        session,
        targetHostId,
        agentMemberId: agent,
        signer: desktopSigner(workspaceId),
      });
    },
    [workspaceId, signed]
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Server, Smartphone } from "lucide-react";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  DEVICE_KEY_REFUSAL,
  deviceKeyErrorMessage,
  deviceKeyServerMessage,
  fetchSigningContext,
  listDeviceKeys,
  phoneKeys,
  rebindDeviceKey,
  registerRootDeviceKey,
  rootRowFor,
  submitEndorsement,
  submitRevocation,
  unapprovablePhoneKeys,
  type DeviceKey,
} from "@momo/core/features/auth/deviceKeys";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  desktopDeviceKey,
  type DesktopDeviceKeyStatus,
  type DesktopHostDelivery,
  type DesktopHostPin,
} from "@/lib/tauri";
import {
  autoRebindTried,
  DEVICE_KEYS_QUERY_KEY,
  deviceKeyFingerprint,
  hostDeliveryCopy,
  PHONE_NAME_ORIGIN_COPY,
  PHONE_NAME_UNVERIFIED,
  phoneNameOrigin,
  registeredAtCopy,
} from "./deviceKeysShared";
import { linkedDevicesQuery } from "./linkedDevicesQuery";
import { ConfirmButton, Field, StatusChip } from "./SettingsFields";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

// =============================================================================
// 지시 서명 (ADR-0146 개정 2026-09-28 R2-E5, #3025). Desktop shell only.
//
// This Mac is the root of trust (D-6): its Secure Enclave key is registered
// with the server (password re-entered, E2), bound in the shell and pinned on
// this Mac's workd. From here the person approves a phone as an instruction
// device (device_endorse.v1) and ends that approval (device_revoke.v1, handed
// to workd over the local socket as well as to the server, D-7).
//
// Every signature is built, shown (native dialog) and signed by the shell. This
// file only chooses which statement to ask for and posts the letters.
//
// #3103 (ADR-0146 D-7 증보 #3097): a refresh reuse or an expiry ends this
// Mac's sign-in without revoking its key. The row stays `root` but signs
// nothing (`lineageLive: false`) until the key moves itself onto the current
// sign-in (`device_rebind.v1`, no password). The panel says so (「다시 연결
// 필요」), tries once on its own — Touch ID still asks — and, if that fails,
// says why and leaves the button.
// =============================================================================

const LOCAL_KEY = (workspaceId: string) =>
  ["settings", "device-key-local", workspaceId] as const;

/** How often the half state is read again (#3129). workd polls every ~2 s. */
const HALF_STATE_POLL_MS = 5_000;

const LINES = [
  "에이전트에게 보내는 지시와 권한 허용에는 기기 서명이 필요해요. 이 맥이 서명 기기가 되고, 폰은 이 맥에서 승인해야 지시를 보낼 수 있어요.",
];

function serverError(error: unknown, fallback: string): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) return deviceKeyServerMessage(error.code, fallback);
  return deviceKeyErrorMessage(error);
}

function useFingerprint(publicKey: string | undefined): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!publicKey) {
      setValue(null);
      return;
    }
    deviceKeyFingerprint(publicKey).then(
      (fp) => live && setValue(fp),
      () => live && setValue(null)
    );
    return () => {
      live = false;
    };
  }, [publicKey]);
  return value;
}

export function DeviceKeysBlock({
  workspaceId,
  memberId,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
}) {
  const local = useQuery({
    queryKey: LOCAL_KEY(workspaceId),
    queryFn: async () => {
      const status = await desktopDeviceKey.status(workspaceId);
      if (!status) throw "unsupported_platform";
      return status;
    },
    retry: false,
    // The half state turns 「켜짐」 on its own a poll after the root is pinned
    // (#3117): read it again while it lasts rather than show a stale state.
    refetchInterval: (query) =>
      query.state.data?.host?.signatureEnforcement === "server_only" ? HALF_STATE_POLL_MS : false,
  });
  const server = useQuery({
    queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId),
    queryFn: () => listDeviceKeys(workspaceId),
    retry: false,
  });

  return (
    <SettingsSection title="지시 서명" description={LINES.join(" ")} testId="device-keys-card">
      {(local.isPending || server.isPending || local.isError || server.isError) && (
      <CardBody>
      {(local.isPending || server.isPending) && (
        <div role="status" data-testid="device-keys-loading">
          <span className="sr-only">지시 서명 상태를 불러오고 있어요.</span>
          <Skeleton ready={false} rows={2} className="p-0" />
        </div>
      )}
      {local.isError && (
        <InlineBanner
          message="이 맥의 서명 키 상태를 읽지 못했어요."
          actionLabel="다시 확인"
          onAction={() => void local.refetch()}
          className="px-0"
          separator={false}
          testId="device-keys-local-error"
        />
      )}
      {server.isError && (
        <InlineBanner
          message={serverError(server.error, "기기 키 목록을 불러오지 못했어요. 다시 시도해 주세요.")}
          actionLabel="다시 시도"
          onAction={() => void server.refetch()}
          className="px-0"
          separator={false}
          testId="device-keys-server-error"
        />
      )}
      </CardBody>
      )}
      {local.isSuccess && server.isSuccess && (
        <DeviceKeysBody
          workspaceId={workspaceId}
          memberId={memberId}
          offline={offline}
          local={local.data}
          keys={server.data}
        />
      )}
    </SettingsSection>
  );
}

function DeviceKeysBody({
  workspaceId,
  memberId,
  offline,
  local,
  keys,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  local: DesktopDeviceKeyStatus;
  keys: DeviceKey[];
}) {
  const found = local.publicKey ? rootRowFor(keys, local.publicKey) : undefined;
  const rootRow = found?.row;
  // A root row on an ended sign-in signs nothing: never 「뿌리」 (#3103).
  const mute = found !== undefined && !found.lineageLive;
  const bound =
    !mute && local.root !== null && rootRow !== undefined && rootRow.id === local.root.keyId;
  const phones = phoneKeys(keys);
  // #3129: waiting phones no root may approve (#3119) are shown, not hidden,
  // with why — the phone says 「QR 연결 필요」 and the person looks for it here.
  const unapprovable = unapprovablePhoneKeys(keys).sort((a, b) => b.createdAtMs - a.createdAtMs);
  const lockedReasonId = useId();
  const lockedReason = offline
    ? "연결이 끊겨서 지금은 승인하거나 끊을 수 없어요."
    : bound
      ? null
      : mute
        ? "이 맥을 다시 연결하면 폰을 승인하거나 끊을 수 있어요."
        : local.support === "ready" || local.support === "absent"
          ? "이 맥을 서명 기기로 등록하면 폰을 승인할 수 있어요."
          : "이 앱에서는 서명할 수 없어서 폰을 승인하거나 끊을 수 없어요.";

  return (
    <div
      className="flex min-w-0 flex-col divide-y divide-line"
      data-testid="device-keys"
      data-device-key-support={local.support}
      data-device-key-bound={bound ? "true" : "false"}
    >
      {/* 카드의 행들: 이 맥, 작업 호스트 서명 검증, 폰 목록이 각자 한 행이고 행 사이는 선 하나다. */}
      <div className="px-4 py-3">
        <ThisMacRoot
          workspaceId={workspaceId}
          memberId={memberId}
          offline={offline}
          local={local}
          rootRow={rootRow}
          mute={mute}
          bound={bound}
        />
      </div>
      <div className="px-4 py-3">
        <HostSignatureRow
          workspaceId={workspaceId}
          host={local.host}
          bound={bound}
          pinned={
            bound &&
            local.host?.pinnedRootKeyId != null &&
            local.root !== null &&
            local.host.pinnedRootKeyId.toLowerCase() === local.root.keyId.toLowerCase()
          }
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
        <h4 className="text-meta font-semibold text-ink">지시를 보낼 수 있는 폰</h4>
        {phones.length === 0 && unapprovable.length === 0 ? (
          <p className="break-keep text-body text-ink-muted" data-testid="device-keys-no-phone">
            승인할 폰이 없어요. 아래 「폰 연결」로 폰을 연결하면 여기서 승인할 수 있어요.
          </p>
        ) : (
          <ul
            className="flex flex-col divide-y divide-line"
            data-testid="device-keys-phones"
          >
            {phones.map((key) => (
              <PhoneKeyRow
                key={key.id}
                workspaceId={workspaceId}
                phone={key}
                locked={lockedReason !== null}
                lockedReasonId={lockedReasonId}
              />
            ))}
            {unapprovable.map((key) => (
              <UnapprovablePhoneRow key={key.id} phone={key} />
            ))}
          </ul>
        )}
        {lockedReason && phones.length > 0 && (
          <p
            id={lockedReasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid="device-keys-locked"
          >
            {lockedReason}
          </p>
        )}
      </div>
    </div>
  );
}

// ---- this Mac -----------------------------------------------------------------

function unsupportedCopy(local: DesktopDeviceKeyStatus): string | null {
  switch (local.support) {
    case "unsigned_build":
    case "entitlement_missing":
    case "unsupported":
    case "error":
      return deviceKeyErrorMessage(local.detail ?? `device_key_${local.support}`);
    default:
      return null;
  }
}

function pinCopy(
  local: DesktopDeviceKeyStatus
): { tone: "ok" | "muted" | "warn"; text: string } | null {
  const host = local.host;
  if (!host || !local.root) return null;
  if (!host.running) {
    return {
      tone: "muted",
      text: "작업 호스트가 켜지면 이 키를 서명 기기로 등록해요.",
    };
  }
  if (!host.matches) return null;
  if (host.pinnedRootKeyId === null) {
    return { tone: "muted", text: "작업 호스트에 아직 등록되지 않았어요." };
  }
  if (host.pinnedRootKeyId.toLowerCase() === local.root.keyId.toLowerCase()) {
    return { tone: "ok", text: "이 맥의 작업 호스트가 이 키를 서명 기기로 등록했어요." };
  }
  return {
    tone: "warn",
    text: "작업 호스트에 다른 키가 서명 기기로 등록돼 있어요. 작업 호스트를 다시 등록해야 이 키로 지시를 보낼 수 있어요.",
  };
}

/**
 * Move this Mac's root row onto the current sign-in (#3103): the shell signs
 * the key's own `device_rebind.v1` letter (native dialog, Touch ID), this page
 * posts it, and a moved row that is not `current` is a failure
 * (`rebindDeviceKey`). The key id does not change, so the shell's binding and
 * workd's pin stay; only a Mac with no binding for this row binds it after.
 */
async function rebindRoot(input: {
  workspaceId: string;
  memberId: string;
  row: DeviceKey;
  local: DesktopDeviceKeyStatus;
}): Promise<DesktopHostDelivery | null> {
  const { workspaceId, memberId, row, local } = input;
  // Any attempt, the button's or the register path's, counts as the one
  // automatic attempt for this row: never two prompts for one move.
  autoRebindTried.add(row.id);
  const context = await fetchSigningContext(workspaceId);
  if (!context.sessionId) throw "device_key_no_session";
  const letter = await desktopDeviceKey.signRebind({
    workspaceId,
    memberId,
    keyId: row.id,
    sessionId: context.sessionId,
  });
  const moved = await rebindDeviceKey(workspaceId, {
    publicKey: letter.publicKey,
    platform: "macos",
    label: row.label.trim() || "Mac",
    rebind: { signedAtMs: letter.signedAtMs, signature: letter.signature },
  });
  if (local.root?.keyId === moved.id) return null;
  const bound = await desktopDeviceKey.bindRoot({
    workspaceId,
    memberId,
    keyId: moved.id,
    publicKey: letter.publicKey,
  });
  return bound.host;
}

function ThisMacRoot({
  workspaceId,
  memberId,
  offline,
  local,
  rootRow,
  mute,
  bound,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  local: DesktopDeviceKeyStatus;
  rootRow: DeviceKey | undefined;
  mute: boolean;
  bound: boolean;
}) {
  const client = useQueryClient();
  const passwordId = useId();
  const reasonId = useId();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const fingerprint = local.fingerprint;
  const rootStartRef = useRef<HTMLButtonElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) passwordRef.current?.focus({ preventScroll: true });
    else if (wasAsking.current) rootStartRef.current?.focus({ preventScroll: true });
    wasAsking.current = asking;
  }, [asking]);

  const settle = () => {
    void client.invalidateQueries({ queryKey: LOCAL_KEY(workspaceId) });
    void client.invalidateQueries({ queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId) });
  };

  const register = useMutation({
    mutationFn: async (): Promise<string> => {
      setNotice(null);
      const created = local.publicKey ? local : await desktopDeviceKey.create();
      const publicKey = created.publicKey;
      if (!publicKey) throw created.detail ?? "device_key_absent";
      const moveIfMute = async (keys: DeviceKey[]) => {
        const found = rootRowFor(keys, publicKey);
        if (!found || found.lineageLive) return null;
        const host = await rebindRoot({ workspaceId, memberId, row: found.row, local: created });
        return relinkNotice(host);
      };
      const keys = await listDeviceKeys(workspaceId);
      const moved = await moveIfMute(keys);
      if (moved) return moved;
      let row = rootRowFor(keys, publicKey)?.row;
      if (!row) {
        try {
          row = await registerRootDeviceKey(workspaceId, {
            publicKey,
            label: "Mac",
            currentPassword: password,
          });
        } catch (error) {
          // The list was stale: the key is ours on an ended sign-in (#3103).
          if (error instanceof ApiError && error.code === DEVICE_KEY_REFUSAL.rebindRequired) {
            const again = await moveIfMute(await listDeviceKeys(workspaceId));
            if (again) return again;
          }
          throw error;
        }
      }
      const result = await desktopDeviceKey.bindRoot({
        workspaceId,
        memberId,
        keyId: row.id,
        publicKey,
      });
      return bindNotice(result.host);
    },
    onSuccess: (text) => {
      setAsking(false);
      setPassword("");
      setNotice(text);
    },
    onSettled: settle,
  });

  const relink = useMutation({
    mutationFn: async () => {
      setNotice(null);
      if (!rootRow) throw "device_key_absent";
      return relinkNotice(await rebindRoot({ workspaceId, memberId, row: rootRow, local }));
    },
    onSuccess: (text) => setNotice(text),
    onSettled: settle,
  });
  const relinkMutate = relink.mutate;
  const autoId = mute && rootRow && !offline ? rootRow.id : null;
  useEffect(() => {
    if (autoId === null || autoRebindTried.has(autoId)) return;
    autoRebindTried.add(autoId);
    relinkMutate();
  }, [autoId, relinkMutate]);

  const blocked = unsupportedCopy(local);
  if (blocked) {
    return (
      <RootRow
        title="이 맥"
        chip={<StatusChip tone="muted">서명 불가</StatusChip>}
        detail={blocked}
        testId="device-key-root-unsupported"
      />
    );
  }

  if (mute && rootRow) {
    const relinkError = relink.isError
      ? serverError(relink.error, "다시 연결하지 못했어요. 다시 시도해 주세요.")
      : null;
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="device-key-root-relink">
        <RootRow
          title="이 맥"
          chip={
            <StatusChip tone={relink.isPending ? "muted" : "warn"}>
              {relink.isPending ? "다시 연결 중" : "다시 연결 필요"}
            </StatusChip>
          }
          fingerprint={fingerprint}
          detail={
            relink.isPending
              ? null
              : "로그인이 끝나서 이 맥의 서명 키로 지금은 서명할 수 없어요."
          }
          detailTone="warn"
          notice={
            relink.isPending
              ? "확인 창과 Touch ID로 이 맥의 서명 키를 이 로그인에 다시 연결하고 있어요."
              : null
          }
        />
        {!relink.isPending && (
          <p className="break-keep text-meta text-ink-muted">
            같은 키를 이 로그인에 다시 연결하면 폰 승인과 작업 호스트 등록은 그대로이고, 비밀번호도 필요 없어요.
          </p>
        )}
        {relinkError && (
          <p
            className="break-keep text-meta text-danger"
            role="alert"
            data-testid="device-key-relink-error"
          >
            {relinkError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            aria-disabled={offline || relink.isPending || undefined}
            aria-describedby={offline ? reasonId : undefined}
            aria-busy={relink.isPending || undefined}
            className={offline || relink.isPending ? "opacity-50" : undefined}
            onClick={() => {
              if (offline || relink.isPending) return;
              relink.mutate();
            }}
            data-testid="device-key-relink"
          >
            다시 연결
          </Button>
        </div>
        {offline && (
          <span id={reasonId} className="text-meta text-ink-muted">
            연결이 끊겨서 지금은 다시 연결할 수 없어요.
          </span>
        )}
      </div>
    );
  }

  if (bound) {
    const pin = pinCopy(local);
    return (
      <RootRow
        title="이 맥"
        chip={<StatusChip tone="ok">서명 기기</StatusChip>}
        fingerprint={fingerprint}
        detail={pin?.text ?? null}
        detailTone={pin?.tone === "warn" ? "warn" : "muted"}
        notice={notice}
        testId="device-key-root-bound"
      />
    );
  }

  // A server row for this key already exists (a bind that was declined, or a
  // reload between the two steps): binding needs no password again.
  const needsPassword = rootRow === undefined;
  const canSubmit = !offline && (!needsPassword || password.length > 0);
  const errorText = register.isError
    ? serverError(register.error, "이 맥을 서명 기기로 등록하지 못했어요. 다시 시도해 주세요.")
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="device-key-root-unbound">
      <RootRow
        title="이 맥"
        chip={<StatusChip tone="muted">등록 전</StatusChip>}
        fingerprint={fingerprint}
        detail={
          local.root && !rootRow
            ? "로그아웃 등으로 이 맥의 키 등록이 풀렸어요. 다시 등록해 주세요."
            : "이 맥을 서명 기기로 등록해야 폰을 승인할 수 있어요."
        }
        notice={notice}
      />
      {asking && needsPassword ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setAsking(false);
              setPassword("");
              register.reset();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || register.isPending) return;
            register.mutate();
          }}
          data-testid="device-key-root-form"
        >
          <Field
            label="현재 비밀번호"
            htmlFor={passwordId}
            hint="서명 키는 호스트 등록과 폰 승인에 쓰여서, 등록할 때 비밀번호를 한 번 더 확인해요."
            error={errorText}
          >
            <Input
              ref={passwordRef}
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="device-key-root-password"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              aria-disabled={!canSubmit || undefined}
              aria-describedby={offline ? reasonId : undefined}
              aria-busy={register.isPending || undefined}
              className={canSubmit ? undefined : "opacity-50"}
              data-testid="device-key-root-submit"
            >
              {register.isPending ? "등록 중" : "서명 기기로 등록"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAsking(false);
                setPassword("");
                register.reset();
              }}
            >
              취소
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          {!needsPassword && errorText && (
            <p className="text-meta text-danger" role="alert">
              {errorText}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={rootStartRef}
              size="sm"
              aria-disabled={offline || undefined}
              aria-describedby={offline ? reasonId : undefined}
              aria-busy={register.isPending || undefined}
              className={offline ? "opacity-50" : undefined}
              onClick={() => {
                if (offline || register.isPending) return;
                if (needsPassword) setAsking(true);
                else register.mutate();
              }}
              data-testid="device-key-root-start"
            >
              {needsPassword ? "이 맥을 서명 기기로 등록" : "이 맥을 서명 기기로 연결"}
            </Button>
          </div>
        </div>
      )}
      {offline && (
        <span id={reasonId} className="text-meta text-ink-muted">
          연결이 끊겨서 지금은 등록할 수 없어요.
        </span>
      )}
    </div>
  );
}

function relinkNotice(host: DesktopHostDelivery | null): string {
  const done = "이 맥의 서명 키를 이 로그인에 다시 연결했어요.";
  switch (host?.state) {
    case undefined:
    case "delivered":
      return done;
    case "notRunning":
      return `${done} 작업 호스트가 켜지면 등록해요.`;
    case "otherHost":
      return `${done} 이 맥의 작업 호스트는 다른 워크스페이스 것이라 등록하지 않았어요.`;
    case "refused":
      return `${done} 작업 호스트가 등록을 받지 않았어요.`;
  }
}

function bindNotice(host: DesktopHostDelivery): string {
  switch (host.state) {
    case "delivered":
      return "이 맥을 서명 기기로 등록하고 작업 호스트에도 등록했어요.";
    case "notRunning":
      return "이 맥을 서명 기기로 등록했어요. 작업 호스트가 켜지면 등록해요.";
    case "otherHost":
      return "이 맥을 서명 기기로 등록했어요. 이 맥의 작업 호스트는 다른 워크스페이스 것이라 등록하지 않았어요.";
    case "refused":
      return "이 맥을 서명 기기로 등록했지만 작업 호스트가 등록을 받지 않았어요.";
  }
}

function RootRow({
  title,
  chip,
  fingerprint,
  detail,
  detailTone = "muted",
  notice,
  testId,
}: {
  title: string;
  chip: React.ReactNode;
  fingerprint?: string | null;
  detail?: string | null;
  detailTone?: "muted" | "warn";
  notice?: string | null;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid={testId}>
      <Monitor className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-ink">
          <span className="break-keep">{title}</span>
          {chip}
        </p>
        {fingerprint && <Fingerprint value={fingerprint} />}
        {detail && (
          <p
            className={
              detailTone === "warn"
                ? "break-keep text-meta text-warn"
                : "break-keep text-meta text-ink-muted"
            }
          >
            {detail}
          </p>
        )}
        {notice && (
          <p className="break-keep text-meta text-ink-muted" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

function Fingerprint({ value }: { value: string }) {
  return (
    <p className="text-meta text-ink-muted">
      지문{" "}
      <span
        className="whitespace-nowrap font-mono text-ink"
        data-numeric=""
        data-testid="device-key-fingerprint"
      >
        {value}
      </span>
    </p>
  );
}

// ---- a phone ------------------------------------------------------------------

function PhoneKeyRow({
  workspaceId,
  phone,
  locked,
  lockedReasonId,
}: {
  workspaceId: string;
  phone: DeviceKey;
  locked: boolean;
  lockedReasonId: string;
}) {
  const client = useQueryClient();
  const fingerprint = useFingerprint(phone.publicKey);
  const [asking, setAsking] = useState(false);
  const [revokeAsking, setRevokeAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const label = phone.label.trim() || "이름 없는 폰";
  // #3145: read only while the approve panel is open (the list is the settings
  // page's own cache; a failed read says "could not compare", never a guess).
  const linked = useQuery({ ...linkedDevicesQuery(), enabled: asking });
  const nameOrigin = phoneNameOrigin(phone, linked.data);
  const noFingerprintId = useId();
  const startRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  // After an approval the trigger is gone (the row turns 지시 기기): focus the
  // outcome sentence instead of dropping it on <body> (design-review R2 M1).
  const landOnNotice = useRef(false);
  // Focus follows the two-step flow (ConfirmButton's rule): into the panel
  // when it opens, back to the trigger when it closes.
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) panelRef.current?.focus({ preventScroll: true });
    else if (wasAsking.current && !landOnNotice.current) {
      startRef.current?.focus({ preventScroll: true });
    }
    wasAsking.current = asking;
  }, [asking]);
  useEffect(() => {
    if (notice && landOnNotice.current) {
      landOnNotice.current = false;
      noticeRef.current?.focus({ preventScroll: true });
    }
  }, [notice]);
  const refresh = () =>
    void client.invalidateQueries({ queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId) });

  const endorse = useMutation({
    mutationFn: async () => {
      setNotice(null);
      const letter = await desktopDeviceKey.signEndorse({
        workspaceId,
        targetKeyId: phone.id,
        targetAlg: "p256",
        targetPublicKey: phone.publicKey,
        label: phone.label,
      });
      return submitEndorsement(workspaceId, phone.id, {
        rootKeyId: letter.rootKeyId,
        signature: letter.signature,
      });
    },
    onSuccess: () => {
      landOnNotice.current = true;
      setAsking(false);
      setNotice(`지시를 보낼 수 있는 폰으로 승인했어요: ${label}`);
    },
    onSettled: refresh,
  });

  // The letter, once signed, is kept until the server has it: a failed post
  // is retried with the same letter, never by signing again, and the note
  // says honestly that the host here already knows (security review M5).
  const [letter, setLetter] = useState<{
    rootKeyId: string;
    revokedAtMs: number;
    signature: string;
    host: DesktopHostDelivery;
  } | null>(null);
  const revoke = useMutation({
    mutationFn: async () => {
      setNotice(null);
      const signed =
        letter ??
        (await desktopDeviceKey.signRevoke({
          workspaceId,
          targetKeyId: phone.id,
          targetLabel: phone.label,
        }));
      setLetter(signed);
      await submitRevocation(workspaceId, phone.id, {
        rootKeyId: signed.rootKeyId,
        revokedAtMs: signed.revokedAtMs,
        signature: signed.signature,
      });
      return signed.host;
    },
    onSuccess: (host) => {
      setLetter(null);
      setNotice(`지시 권한을 끊었어요. ${hostDeliveryCopy(host)}`);
    },
    onSettled: refresh,
  });

  const endorsed = phone.state === "endorsed";
  // #3119/#3129: approved before 「QR 연결로만」 — it keeps working, and says so.
  const linkNote = endorsed ? approvedLinkNote(phone) : null;
  const close = () => {
    setAsking(false);
    endorse.reset();
  };
  const error = endorse.isError
    ? serverError(endorse.error, "승인하지 못했어요. 다시 시도해 주세요.")
    : revoke.isError
      ? letter
        ? `${
            letter.host.state === "delivered"
              ? "이 맥의 작업 호스트에는 알렸지만 서버에는 알리지 못했어요."
              : "서명은 했지만 서버에 알리지 못했어요."
          } ${serverError(revoke.error, "다시 보내세요.")}`
        : serverError(revoke.error, "지시 권한을 끊지 못했어요. 다시 시도해 주세요.")
      : null;

  const identity = (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <Smartphone className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-ink">
          <span className="min-w-0 break-keep">{label}</span>
          {endorsed ? (
            <StatusChip tone="ok">지시 가능</StatusChip>
          ) : (
            <StatusChip tone="warn">승인 전</StatusChip>
          )}
          {linkNote && <StatusChip tone="warn">{linkNote.chip}</StatusChip>}
        </p>
        {/* The approve panel shows it large; one fingerprint on screen at a time. */}
        {fingerprint && !asking && <Fingerprint value={fingerprint} />}
        {linkNote && (
          <p className="break-keep text-meta text-ink-muted" data-testid="device-key-phone-link-note">
            {linkNote.detail}
          </p>
        )}
      </div>
    </div>
  );

  const canApprove = !locked && fingerprint !== null;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0"
      data-testid={`device-key-phone-${phone.id}`}
      data-device-key-state={phone.state}
    >
      {/* Same grammar as 연결된 기기 rows: identity left, the one action right;
          the row stacks while a confirmation is open. */}
      <div
        className={
          asking || revokeAsking
            ? "flex min-w-0 flex-col items-stretch gap-2"
            : "flex min-w-0 items-start justify-between gap-3"
        }
      >
        {identity}
        {!endorsed && !asking && (
          <div className="shrink-0">
            <Button
              ref={startRef}
              size="sm"
              variant="secondary"
              aria-disabled={locked || undefined}
              aria-describedby={locked ? lockedReasonId : undefined}
              className={locked ? "opacity-50" : undefined}
              onClick={() => {
                if (locked) return;
                setAsking(true);
              }}
              data-testid="device-key-endorse-start"
            >
              지시를 보낼 수 있게 승인
            </Button>
          </div>
        )}
        {endorsed && (
          <div className={revokeAsking ? "min-w-0" : "shrink-0"}>
            <ConfirmButton
              label="지시 권한 끊기"
              subject={label}
              question="끊은 폰은 이 맥에서 다시 승인해야 지시를 보낼 수 있어요."
              confirmLabel="끊기"
              busy={revoke.isPending}
              busyLabel="끊는 중"
              disabled={locked}
              describedBy={locked ? lockedReasonId : undefined}
              onAskingChange={setRevokeAsking}
              onConfirm={() => revoke.mutate()}
              testId="device-key-revoke"
            />
          </div>
        )}
      </div>

      {!endorsed && asking && (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="flex min-w-0 flex-col gap-2 rounded-md bg-surface-muted p-3 focus-visible:focus-ring"
          role="group"
          aria-label={`승인: ${label}`}
          data-testid="device-key-endorse-confirm"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <p className="break-keep text-body text-ink">
            방금 이 계정에 연결한 폰이 맞는지 확인하고 승인하세요. 아래는 이 폰 키의 지문이에요.
          </p>
          {fingerprint ? (
            <p
              className="whitespace-nowrap font-mono text-title text-ink"
              data-numeric=""
              data-testid="device-key-endorse-fingerprint"
            >
              {fingerprint}
            </p>
          ) : (
            <p className="break-keep text-meta text-ink-muted" id={noFingerprintId}>
              지문을 계산하지 못해서 지금은 승인할 수 없어요.
            </p>
          )}
          <div className="flex min-w-0 flex-col gap-px" data-testid="device-key-endorse-origin">
            <p className="break-keep text-meta text-ink" data-testid="device-key-endorse-registered">
              <span className="text-ink-muted">등록 시각</span>{" "}
              {registeredAtCopy(phone.createdAtMs, Date.now())}
            </p>
            <p
              className="break-keep break-words text-meta text-ink"
              data-testid="device-key-endorse-name"
              data-name-origin={nameOrigin}
            >
              <span className="text-ink-muted">이름</span> {label}
            </p>
            {nameOrigin === "notInLinks" ? (
              // #3154 M2: 이름이 연결 목록에 없다는 것은 다른 폰일 수 있다는 신호다 —
              // 회색 보조 글씨 속에 묻히지 않게 위험 바탕·굵은 글씨로 세운다.
              <p
                className="mt-1 break-keep rounded-sm border border-danger/40 bg-danger-soft px-2 py-1.5 text-meta font-medium text-danger"
                data-testid="device-key-endorse-name-warning"
                role="note"
              >
                {PHONE_NAME_ORIGIN_COPY[nameOrigin]}
              </p>
            ) : (
              <p className="break-keep text-meta text-ink-muted">{PHONE_NAME_ORIGIN_COPY[nameOrigin]}</p>
            )}
            <p className="break-keep text-meta text-ink-muted">{PHONE_NAME_UNVERIFIED}</p>
          </div>
          <p className="break-keep text-meta text-ink-muted">
            승인하면 이 맥에 확인 창이 뜨고 Touch ID로 서명해요. 확인 창의 지문도 같은지 꼭 확인하세요.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              aria-busy={endorse.isPending || undefined}
              aria-disabled={!canApprove || undefined}
              aria-describedby={
                locked ? lockedReasonId : fingerprint === null ? noFingerprintId : undefined
              }
              className={canApprove ? undefined : "opacity-50"}
              onClick={() => {
                if (!canApprove || endorse.isPending) return;
                endorse.mutate();
              }}
              data-testid="device-key-endorse-submit"
            >
              {endorse.isPending ? "승인 중" : "지시를 보낼 수 있게 승인"}
            </Button>
            <Button size="sm" variant="ghost" onClick={close}>
              취소
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="break-keep text-meta text-danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          className="break-keep text-meta text-ink-muted focus-visible:focus-ring"
          role="status"
          data-testid="device-key-phone-notice"
        >
          {notice}
        </p>
      )}
    </li>
  );
}

// ---- phones the server will not let a root approve (#3129) -------------------

/** The phone's own 「QR 연결 필요」 steps (`clients/mobile/.../deviceKey/copy.ts`
 *  QR_LINK_STEPS), in the same order: the QR is scanned only before sign-in. */
const QR_RELINK_HOW = "아래 「폰 연결」에서 QR을 만들고, 폰에서 로그아웃한 뒤 첫 화면의 「QR 찍기」로 찍으세요.";

/**
 * An approved phone from before 「QR 연결로만」 (ADR-0146 D-6 증보, #3119): it
 * keeps working; the Mac marks it and recommends a QR re-link. `undefined`
 * (an older server) says nothing.
 */
function approvedLinkNote(phone: DeviceKey): { chip: string; detail: string } | null {
  if (phone.linkedSession === false) {
    return {
      chip: "QR 아님",
      detail:
        "QR 연결이 생기기 전에 등록된 폰이에요. 지시 권한을 끊고 다시 연결하는 게 좋아요. "+QR_RELINK_HOW,
    };
  }
  if (phone.linkedFromMac === false) {
    return {
      chip: "맥 QR 아님",
      detail:
        "맥이 아닌 곳에서 띄운 QR로 연결된 폰이에요. 지시 권한을 끊고 다시 연결하는 게 좋아요. "+QR_RELINK_HOW,
    };
  }
  return null;
}

/** Why a waiting phone cannot be approved, in the phone's own words. */
function unapprovableCopy(phone: DeviceKey): { detail: string } {
  return phone.linkedSession === false
    ? {
        detail:
          "QR로 연결하지 않은 로그인에서 등록된 폰이라 승인할 수 없어요. "+QR_RELINK_HOW,
      }
    : {
        detail:
          "맥이 아닌 곳에서 띄운 QR로 연결된 폰이라 승인할 수 없어요. "+QR_RELINK_HOW,
      };
}

function UnapprovablePhoneRow({ phone }: { phone: DeviceKey }) {
  const fingerprint = useFingerprint(phone.publicKey);
  const label = phone.label.trim() || "이름 없는 폰";
  const copy = unapprovableCopy(phone);
  return (
    <li
      className="flex min-w-0 items-start gap-2 py-3 first:pt-0 last:pb-0"
      data-testid={`device-key-unapprovable-${phone.id}`}
      data-device-key-state={phone.state}
    >
      <Smartphone className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-ink">
          <span className="min-w-0 break-keep">{label}</span>
          <StatusChip tone="warn">QR 연결 필요</StatusChip>
        </p>
        {fingerprint && <Fingerprint value={fingerprint} />}
        <p className="break-keep text-meta text-ink-muted">{copy.detail}</p>
      </div>
    </li>
  );
}

// ---- this Mac's work host: does it check signatures? (#3129) ------------------

type Enforcement = NonNullable<DesktopHostPin["signatureEnforcement"]>;

/**
 * What the host's signature check is, in the page's words (#3117 status,
 * #3129 surface). `server_only` is the half state: the server requires
 * signatures and this host does not check them yet, because no root is pinned
 * — the way out is this Mac's root, which the row points at.
 */
function hostSignatureCopy(input: {
  host: DesktopHostPin;
  bound: boolean;
  pinned: boolean;
}): {
  enforcement: Enforcement;
  chip: string;
  tone: "ok" | "warn" | "muted";
  detail: string;
  /** The latch can be lowered here: workd latched it on the server's word
   *  (or could not read it), and the server no longer asks. */
  canReset: boolean;
  /** Why it cannot, when it is on and the person may wonder. */
  resetBlocked: string | null;
} | null {
  const { host, bound, pinned } = input;
  const enforcement = host.signatureEnforcement;
  if (!host.running || enforcement === undefined) return null;
  if (!(host.workspaceMatches ?? host.matches)) return null;
  switch (enforcement) {
    case "enforced": {
      const by = host.signaturesRequiredBy ?? null;
      const serverAsks = host.serverRequiresSignatures === true;
      return {
        enforcement,
        chip: "켜짐",
        tone: "ok",
        detail:
          by === "config"
            ? "작업 호스트 설정에서 켜 두었어요. 이 맥의 작업 호스트는 서명 없는 지시와 권한 허용을 거절해요."
            : by === "unreadable"
              ? "검증 상태를 읽지 못해서 켜 둔 채로 있어요. 이 맥의 작업 호스트는 서명 없는 지시와 권한 허용을 거절해요."
              : serverAsks
                ? "서버가 요구해서 켰어요. 이 맥의 작업 호스트는 서명 없는 지시와 권한 허용을 거절해요."
                : "서버는 서명 요구를 껐지만, 한 번 켜진 검증은 이 맥에서만 끌 수 있어요.",
        canReset: by !== "config" && !serverAsks,
        resetBlocked:
          by === "config"
            ? null
            : serverAsks
              ? "서버가 서명을 요구하는 동안에는 끌 수 없어요."
              : null,
      };
    }
    case "server_only":
      return {
        enforcement,
        chip: "서버만 켜짐",
        tone: "warn",
        detail: !bound
          ? "서버는 지시 서명을 요구하지만 이 맥의 작업 호스트는 아직 검증하지 않아요. 위에서 이 맥을 서명 기기로 등록하면 작업 호스트가 검증을 켜요."
          : pinned
            ? "서버는 지시 서명을 요구하고, 작업 호스트에 서명 기기가 등록됐어요. 몇 초 안에 검증이 켜져요."
            : "서버는 지시 서명을 요구하지만 이 맥의 작업 호스트는 아직 검증하지 않아요. 작업 호스트가 이 맥의 키를 서명 기기로 등록하면 검증이 켜져요.",
        canReset: false,
        resetBlocked: null,
      };
    case "off":
      return {
        enforcement,
        chip: "꺼짐",
        tone: "muted",
        detail: "서버가 지시 서명을 요구하지 않아서 작업 호스트도 검증하지 않아요.",
        canReset: false,
        resetBlocked: null,
      };
  }
}

function HostSignatureRow({
  workspaceId,
  host,
  bound,
  pinned,
}: {
  workspaceId: string;
  host: DesktopHostPin | null;
  bound: boolean;
  pinned: boolean;
}) {
  const client = useQueryClient();
  const hintId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: async () => {
      setNotice(null);
      return desktopDeviceKey.resetSignatureRequirement(workspaceId);
    },
    onSuccess: ({ required }) =>
      setNotice(
        required
          ? "작업 호스트 설정에서 검증을 켜 둬서 꺼지지 않았어요."
          : "검증을 껐어요. 서버가 다시 서명을 요구하면 작업 호스트가 스스로 다시 켜요."
      ),
    onSettled: () => void client.invalidateQueries({ queryKey: LOCAL_KEY(workspaceId) }),
  });
  if (!host) return null;
  const copy = hostSignatureCopy({ host, bound, pinned });
  if (!copy) return null;
  // The shell rejects with a bare code string (Tauri), typed here as unknown.
  const failure: unknown = reset.error;
  // Choosing 취소 in the dialog is the person's answer, not a failure.
  const declined = reset.isError && failure === "device_key_declined";
  const error = reset.isError && !declined ? deviceKeyErrorMessage(failure) : null;
  // A local socket call: no server needed, so being offline does not block it.
  const disabled = reset.isPending;
  return (
    <div
      className="flex min-w-0 items-start gap-2"
      data-testid="device-key-host-signatures"
      data-signature-enforcement={copy.enforcement}
    >
      <Server className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-ink">
          <span className="break-keep">작업 호스트 서명 검증</span>
          <StatusChip tone={copy.tone}>{copy.chip}</StatusChip>
        </p>
        <p
          className={
            copy.tone === "warn"
              ? "break-keep text-meta text-warn"
              : "break-keep text-meta text-ink-muted"
          }
          data-testid="device-key-host-signatures-detail"
        >
          {copy.detail}
        </p>
        {copy.resetBlocked && (
          <p className="break-keep text-meta text-ink-muted">{copy.resetBlocked}</p>
        )}
        {copy.canReset && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              aria-disabled={disabled || undefined}
              aria-busy={reset.isPending || undefined}
              aria-describedby={hintId}
              className={disabled ? "opacity-50" : undefined}
              onClick={() => {
                if (disabled) return;
                reset.mutate();
              }}
              data-testid="device-key-host-signatures-reset"
            >
              {reset.isPending ? "확인 중" : "검증 끄기"}
            </Button>
            <span id={hintId} className="break-keep text-meta text-ink-muted">
              누르면 이 맥에 확인 창이 떠요.
            </span>
          </div>
        )}
        {error && (
          <p className="break-keep text-meta text-danger" role="alert">
            {error}
          </p>
        )}
        {(notice || declined) && (
          <p className="break-keep text-meta text-ink-muted" role="status">
            {declined ? "검증을 끄지 않았어요." : notice}
          </p>
        )}
      </div>
    </div>
  );
}

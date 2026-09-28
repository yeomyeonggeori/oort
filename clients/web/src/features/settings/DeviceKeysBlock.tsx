import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Smartphone } from "lucide-react";
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
  type DeviceKey,
} from "@momo/core/features/auth/deviceKeys";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  desktopDeviceKey,
  type DesktopDeviceKeyStatus,
  type DesktopHostDelivery,
} from "@/lib/tauri";
import {
  autoRebindTried,
  DEVICE_KEYS_QUERY_KEY,
  deviceKeyFingerprint,
  hostDeliveryCopy,
} from "./deviceKeysShared";
import { ConfirmButton, Field, StatusChip, Subsection } from "./SettingsFields";

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

const LINES = [
  "에이전트에게 보내는 지시와 권한 허용에는 기기 키 서명이 필요합니다. 이 맥이 서명의 뿌리이고, 폰은 이 맥에서 승인해야 지시할 수 있습니다.",
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
  });
  const server = useQuery({
    queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId),
    queryFn: () => listDeviceKeys(workspaceId),
    retry: false,
  });

  return (
    <Subsection title="지시 서명" lines={LINES}>
      {(local.isPending || server.isPending) && (
        <div role="status" data-testid="device-keys-loading">
          <span className="sr-only">지시 서명 상태를 불러오는 중입니다.</span>
          <Skeleton ready={false} rows={2} className="p-0" />
        </div>
      )}
      {local.isError && (
        <InlineBanner
          message="이 맥의 서명 키 상태를 읽지 못했습니다."
          actionLabel="다시 확인"
          onAction={() => void local.refetch()}
          className="px-0"
          separator={false}
          testId="device-keys-local-error"
        />
      )}
      {server.isError && (
        <InlineBanner
          message={serverError(server.error, "기기 키 목록을 불러오지 못했습니다. 다시 시도하세요.")}
          actionLabel="다시 시도"
          onAction={() => void server.refetch()}
          className="px-0"
          separator={false}
          testId="device-keys-server-error"
        />
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
    </Subsection>
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
  const lockedReasonId = useId();
  const lockedReason = offline
    ? "연결이 끊겨 지금은 승인하거나 끊을 수 없습니다."
    : bound
      ? null
      : mute
        ? "이 맥을 다시 연결하면 폰을 승인하거나 끊을 수 있습니다."
        : local.support === "ready" || local.support === "absent"
          ? "이 맥을 뿌리로 등록한 뒤 폰을 승인할 수 있습니다."
          : "이 앱에서는 서명할 수 없어 폰을 승인하거나 끊을 수 없습니다.";

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="device-keys"
      data-device-key-support={local.support}
      data-device-key-bound={bound ? "true" : "false"}
    >
      <ThisMacRoot
        workspaceId={workspaceId}
        memberId={memberId}
        offline={offline}
        local={local}
        rootRow={rootRow}
        mute={mute}
        bound={bound}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-meta font-semibold text-ink">지시 기기</h4>
        {phones.length === 0 ? (
          <p className="break-keep text-body text-ink-muted" data-testid="device-keys-no-phone">
            승인할 폰이 없습니다. 아래 「폰 연결」로 폰을 붙이면 여기에서 승인합니다.
          </p>
        ) : (
          <ul
            className="flex flex-col overflow-hidden rounded-md border border-line"
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
      text: "작업 호스트가 켜지면 이 키를 뿌리로 고정합니다.",
    };
  }
  if (!host.matches) return null;
  if (host.pinnedRootKeyId === null) {
    return { tone: "muted", text: "작업 호스트에 아직 고정되지 않았습니다." };
  }
  if (host.pinnedRootKeyId.toLowerCase() === local.root.keyId.toLowerCase()) {
    return { tone: "ok", text: "이 맥의 작업 호스트가 이 키를 뿌리로 고정했습니다." };
  }
  return {
    tone: "warn",
    text: "작업 호스트가 다른 키를 뿌리로 고정해 두었습니다. 작업 호스트를 다시 등록해야 이 키로 지시할 수 있습니다.",
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
      ? serverError(relink.error, "다시 연결하지 못했습니다. 다시 시도하세요.")
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
              ? "확인 창과 Touch ID로 이 맥의 서명 키를 지금 로그인에 옮기는 중입니다."
              : "로그인이 바뀌어 이 맥의 서명 키가 지금은 서명할 수 없습니다. 같은 키를 이 로그인으로 옮기면 폰 승인과 작업 호스트 고정은 그대로이고, 비밀번호는 필요 없습니다."
          }
          detailTone={relink.isPending ? "muted" : "warn"}
        />
        {relinkError && (
          <p
            className="break-keep text-meta text-danger"
            role="alert"
            data-testid="device-key-relink-error"
          >
            {relinkError}
          </p>
        )}
        {!relink.isPending && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              aria-disabled={offline || undefined}
              aria-describedby={offline ? reasonId : undefined}
              className={offline ? "opacity-50" : undefined}
              onClick={() => {
                if (offline || relink.isPending) return;
                relink.mutate();
              }}
              data-testid="device-key-relink"
            >
              다시 연결
            </Button>
          </div>
        )}
        {offline && (
          <span id={reasonId} className="text-meta text-ink-muted">
            연결이 끊겨 지금은 다시 연결할 수 없습니다.
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
        chip={<StatusChip tone="ok">뿌리</StatusChip>}
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
    ? serverError(register.error, "이 맥을 뿌리로 등록하지 못했습니다. 다시 시도하세요.")
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="device-key-root-unbound">
      <RootRow
        title="이 맥"
        chip={<StatusChip tone="muted">등록 전</StatusChip>}
        fingerprint={fingerprint}
        detail={
          local.root && !rootRow
            ? "로그아웃 등으로 이 맥의 키 등록이 해제됐습니다. 다시 등록하세요."
            : "이 맥을 뿌리로 등록해야 폰을 지시 기기로 승인할 수 있습니다."
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
            hint="뿌리 키는 호스트 등록과 폰 승인에 쓰여서, 등록할 때 비밀번호를 한 번 더 확인합니다."
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
              {register.isPending ? "등록 중" : "뿌리로 등록"}
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
              {needsPassword ? "이 맥을 뿌리로 등록" : "이 맥을 뿌리로 연결"}
            </Button>
          </div>
        </div>
      )}
      {offline && (
        <span id={reasonId} className="text-meta text-ink-muted">
          연결이 끊겨 지금은 등록할 수 없습니다.
        </span>
      )}
    </div>
  );
}

function relinkNotice(host: DesktopHostDelivery | null): string {
  const done = "이 맥의 서명 키를 이 로그인에 다시 연결했습니다.";
  switch (host?.state) {
    case undefined:
    case "delivered":
      return done;
    case "notRunning":
      return `${done} 작업 호스트가 켜지면 고정합니다.`;
    case "otherHost":
      return `${done} 이 맥의 작업 호스트는 다른 워크스페이스 것이라 고정하지 않았습니다.`;
    case "refused":
      return `${done} 작업 호스트가 고정을 받지 않았습니다.`;
  }
}

function bindNotice(host: DesktopHostDelivery): string {
  switch (host.state) {
    case "delivered":
      return "이 맥을 뿌리로 등록하고 작업 호스트에 고정했습니다.";
    case "notRunning":
      return "이 맥을 뿌리로 등록했습니다. 작업 호스트가 켜지면 고정합니다.";
    case "otherHost":
      return "이 맥을 뿌리로 등록했습니다. 이 맥의 작업 호스트는 다른 워크스페이스 것이라 고정하지 않았습니다.";
    case "refused":
      return "이 맥을 뿌리로 등록했지만 작업 호스트가 고정을 받지 않았습니다.";
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
      setNotice(`지시 기기로 승인했습니다: ${label}`);
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
      setNotice(`지시 권한을 끊었습니다. ${hostDeliveryCopy(host)}`);
    },
    onSettled: refresh,
  });

  const endorsed = phone.state === "endorsed";
  const close = () => {
    setAsking(false);
    endorse.reset();
  };
  const error = endorse.isError
    ? serverError(endorse.error, "승인하지 못했습니다. 다시 시도하세요.")
    : revoke.isError
      ? letter
        ? `${
            letter.host.state === "delivered"
              ? "이 맥의 작업 호스트에는 알렸지만 서버에는 알리지 못했습니다."
              : "서명은 했지만 서버에 알리지 못했습니다."
          } ${serverError(revoke.error, "다시 보내세요.")}`
        : serverError(revoke.error, "지시 권한을 끊지 못했습니다. 다시 시도하세요.")
      : null;

  const identity = (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <Smartphone className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-ink">
          <span className="min-w-0 break-keep">{label}</span>
          {endorsed ? (
            <StatusChip tone="ok">지시 기기</StatusChip>
          ) : (
            <StatusChip tone="warn">승인 전</StatusChip>
          )}
        </p>
        {/* The approve panel shows it large; one fingerprint on screen at a time. */}
        {fingerprint && !asking && <Fingerprint value={fingerprint} />}
      </div>
    </div>
  );

  const canApprove = !locked && fingerprint !== null;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
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
              지시 기기로 승인
            </Button>
          </div>
        )}
        {endorsed && (
          <div className={revokeAsking ? "min-w-0" : "shrink-0"}>
            <ConfirmButton
              label="지시 권한 끊기"
              subject={label}
              question="끊은 폰은 이 맥에서 다시 승인해야 지시할 수 있습니다."
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
            방금 이 계정에 연결한 폰이 맞는지 확인하고 승인하세요. 이 폰 키의 지문입니다.
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
              지문을 계산하지 못해 지금은 승인할 수 없습니다.
            </p>
          )}
          <p className="break-keep text-meta text-ink-muted">
            승인하면 이 맥이 확인 창을 띄우고 Touch ID로 서명합니다. 확인 창의 지문도 같은지 보세요.
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
              {endorse.isPending ? "승인 중" : "지시 기기로 승인"}
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

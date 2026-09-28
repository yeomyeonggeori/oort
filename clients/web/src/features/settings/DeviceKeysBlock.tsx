import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Smartphone } from "lucide-react";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  deviceKeyErrorMessage,
  deviceKeyServerMessage,
  listDeviceKeys,
  phoneKeys,
  registerRootDeviceKey,
  rootRowFor,
  submitEndorsement,
  submitRevocation,
  type DeviceKey,
} from "@momo/core/features/auth/deviceKeys";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { desktopDeviceKey, type DesktopDeviceKeyStatus } from "@/lib/tauri";
import {
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
  const rootRow = local.publicKey ? rootRowFor(keys, local.publicKey) : undefined;
  const bound =
    local.root !== null && rootRow !== undefined && rootRow.id === local.root.keyId;
  const phones = phoneKeys(keys);
  const lockedReasonId = useId();
  const lockedReason = offline
    ? "연결이 끊겨 지금은 승인하거나 끊을 수 없습니다."
    : bound
      ? null
      : "이 맥을 뿌리로 등록한 뒤 폰을 승인할 수 있습니다.";

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
        bound={bound}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-meta font-semibold text-ink">지시 기기</h4>
        {phones.length === 0 ? (
          <p className="break-keep text-body text-ink-muted" data-testid="device-keys-no-phone">
            승인할 폰이 없습니다. 아래 「기기 연결」로 폰을 붙이면 여기에서 승인합니다.
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

function ThisMacRoot({
  workspaceId,
  memberId,
  offline,
  local,
  rootRow,
  bound,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
  local: DesktopDeviceKeyStatus;
  rootRow: DeviceKey | undefined;
  bound: boolean;
}) {
  const client = useQueryClient();
  const passwordId = useId();
  const reasonId = useId();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const fingerprint = local.fingerprint;

  const register = useMutation({
    mutationFn: async () => {
      setNotice(null);
      const created = local.publicKey ? local : await desktopDeviceKey.create();
      const publicKey = created.publicKey;
      if (!publicKey) throw created.detail ?? "device_key_absent";
      const keys = await listDeviceKeys(workspaceId);
      const row =
        rootRowFor(keys, publicKey) ??
        (await registerRootDeviceKey(workspaceId, {
          publicKey,
          label: "Mac",
          currentPassword: password,
        }));
      return desktopDeviceKey.bindRoot({
        workspaceId,
        memberId,
        keyId: row.id,
        publicKey,
      });
    },
    onSuccess: (result) => {
      setAsking(false);
      setPassword("");
      setNotice(
        result.host.state === "delivered"
          ? "이 맥을 뿌리로 등록하고 작업 호스트에 고정했습니다."
          : "이 맥을 뿌리로 등록했습니다. 작업 호스트가 켜지면 고정합니다."
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: LOCAL_KEY(workspaceId) });
      void client.invalidateQueries({ queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId) });
    },
  });

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
            ? "서버에서 이 맥의 키가 끝났습니다(로그아웃 등). 다시 등록하세요."
            : "이 맥을 뿌리로 등록해야 폰을 지시 기기로 승인할 수 있습니다."
        }
        notice={notice}
      />
      {asking && needsPassword ? (
        <form
          className="flex min-w-0 flex-col gap-2"
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
      <span className="font-mono text-ink" data-numeric="" data-testid="device-key-fingerprint">
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
  const [notice, setNotice] = useState<string | null>(null);
  const label = phone.label.trim() || "이름 없는 폰";
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
      setAsking(false);
      setNotice(`${label}을 지시 기기로 승인했습니다.`);
    },
    onSettled: refresh,
  });

  const revoke = useMutation({
    mutationFn: async () => {
      setNotice(null);
      const letter = await desktopDeviceKey.signRevoke({
        workspaceId,
        targetKeyId: phone.id,
        targetPublicKey: phone.publicKey,
        targetLabel: phone.label,
      });
      await submitRevocation(workspaceId, phone.id, {
        rootKeyId: letter.rootKeyId,
        revokedAtMs: letter.revokedAtMs,
        signature: letter.signature,
      });
      return letter.host;
    },
    onSuccess: (host) => setNotice(`지시 권한을 끊었습니다. ${hostDeliveryCopy(host)}`),
    onSettled: refresh,
  });

  const endorsed = phone.state === "endorsed";
  const error = endorse.isError
    ? serverError(endorse.error, "승인하지 못했습니다. 다시 시도하세요.")
    : revoke.isError
      ? serverError(revoke.error, "지시 권한을 끊지 못했습니다. 다시 시도하세요.")
      : null;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
      data-testid={`device-key-phone-${phone.id}`}
      data-device-key-state={phone.state}
    >
      <div className="flex min-w-0 items-start gap-2">
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
          {fingerprint && <Fingerprint value={fingerprint} />}
        </div>
      </div>

      {!endorsed && !asking && (
        <div>
          <Button
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
            이 폰을 지시 기기로 승인
          </Button>
        </div>
      )}
      {!endorsed && asking && (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-md bg-surface-muted p-3"
          role="group"
          aria-label={`${label} 승인`}
          data-testid="device-key-endorse-confirm"
        >
          <p className="break-keep text-body text-ink">
            폰 화면에 보이는 지문이 아래와 같을 때만 승인하세요.
          </p>
          {fingerprint && (
            <p
              className="font-mono text-title text-ink"
              data-numeric=""
              data-testid="device-key-endorse-fingerprint"
            >
              {fingerprint}
            </p>
          )}
          <p className="break-keep text-meta text-ink-muted">
            승인하면 이 맥이 확인 창을 띄우고 Touch ID로 서명합니다.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              aria-busy={endorse.isPending || undefined}
              onClick={() => {
                if (endorse.isPending) return;
                endorse.mutate();
              }}
              data-testid="device-key-endorse-submit"
            >
              {endorse.isPending ? "승인 중" : "지문이 같습니다, 승인"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAsking(false);
                endorse.reset();
              }}
            >
              취소
            </Button>
          </div>
        </div>
      )}
      {endorsed && (
        <div>
          <ConfirmButton
            label="지시 권한 끊기"
            subject={label}
            question="끊은 폰은 이 맥에서 다시 승인해야 지시할 수 있습니다."
            confirmLabel="끊기"
            busy={revoke.isPending}
            busyLabel="끊는 중"
            disabled={locked}
            describedBy={locked ? lockedReasonId : undefined}
            onConfirm={() => revoke.mutate()}
            testId="device-key-revoke"
          />
        </div>
      )}
      {error && (
        <p className="break-keep text-meta text-danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="break-keep text-meta text-ink-muted" role="status">
          {notice}
        </p>
      )}
    </li>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Smartphone } from "lucide-react";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  isCannotRevokeCurrent,
  isPhonePlatform,
  linkedDevicePlatformLabel,
  revokeLinkedDevice,
  type LinkedDevice,
} from "@momo/core/features/auth/linkedDevices";
import { cn } from "@/design/lib/cn";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { ConfirmButton, Subsection } from "./SettingsFields";
import {
  LINKED_DEVICES_QUERY_KEY,
  linkedDevicesQuery,
} from "./linkedDevicesQuery";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

const LINKED_AT = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
});

const CURRENT_REASON =
  "지금 쓰는 기기는 여기서 끊을 수 없습니다. 이 세션을 끝내려면 로그아웃하세요.";
const SERVER_CURRENT_REASON =
  "서버가 이 기기를 지금 쓰는 기기로 봅니다. 이 세션을 끝내려면 로그아웃하세요.";
const OFFLINE_REASON =
  "연결이 끊겨 지금은 기기를 해제할 수 없습니다. 다시 연결되면 이어서 해제할 수 있습니다.";
const GONE_NOTICE = "그 기기는 이미 목록에 없습니다.";
const REVOKE_QUESTION =
  "이 기기 연결을 끊으면 그 기기는 다시 QR을 찍어야 합니다.";

function listFailureCopy(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError && error.status === 403) {
    return "사람 계정만 연결된 기기를 볼 수 있습니다.";
  }
  return "기기 목록을 불러오지 못했습니다. 다시 시도하세요.";
}

function revokeFailureCopy(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (isCannotRevokeCurrent(error)) return SERVER_CURRENT_REASON;
  if (error instanceof ApiError && error.status === 404) return GONE_NOTICE;
  return "기기를 해제하지 못했습니다. 다시 시도하세요.";
}

function linkedAtCopy(linkedAt: number): string {
  return `연결 ${LINKED_AT.format(new Date(linkedAt))}`;
}

function disconnectTriggerSelector(id: string): string {
  return `[data-testid="linked-device-row-${id}"] [data-testid="linked-device-disconnect"]`;
}

export function LinkedDevicesList({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  const list = useQuery(linkedDevicesQuery());
  const currentReasonId = useId();
  const offlineReasonId = useId();
  const [rowError, setRowError] = useState<string | null>(null);
  const [goneNotice, setGoneNotice] = useState<string | null>(null);
  const [removed, setRemoved] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);
  const landing = useRef<string | null>(null);

  const rows = list.data ?? [];

  useEffect(() => {
    const target = landing.current;
    if (target === null) return;
    landing.current = null;
    if (target === "") {
      document
        .querySelector<HTMLElement>('[data-testid="device-link-create"]')
        ?.focus({ preventScroll: true });
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(disconnectTriggerSelector(target))
      ?.focus({ preventScroll: true });
  }, [list.data]);

  const revoke = useMutation({
    mutationFn: (id: string) => revokeLinkedDevice(id),
    onMutate: async (id) => {
      setRowError(null);
      setGoneNotice(null);
      await client.cancelQueries({ queryKey: LINKED_DEVICES_QUERY_KEY });
      const previous = client.getQueryData<LinkedDevice[]>(
        LINKED_DEVICES_QUERY_KEY
      );
      const current = previous ?? [];
      const gone = current.findIndex((row) => row.id === id);
      const neighbour = current[gone + 1] ?? current[gone - 1];
      landing.current = neighbour?.id ?? "";
      const label = current[gone]?.label;
      setRemoved(label ? `${label} 연결을 해제했습니다.` : "");
      client.setQueryData<LinkedDevice[]>(
        LINKED_DEVICES_QUERY_KEY,
        (next) => (next ?? []).filter((row) => row.id !== id)
      );
      return { previous };
    },
    onError: (error, _id, ctx) => {
      landing.current = null;
      setRemoved("");
      if (error instanceof ApiError && error.status === 404) {
        setGoneNotice(GONE_NOTICE);
        return;
      }
      if (ctx?.previous) {
        client.setQueryData(LINKED_DEVICES_QUERY_KEY, ctx.previous);
      }
      setRowError(revokeFailureCopy(error));
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: LINKED_DEVICES_QUERY_KEY });
    },
  });

  const hasCurrent = rows.some((row) => row.current);
  const revokingId = revoke.isPending ? (revoke.variables ?? null) : null;
  const busy = revoke.isPending;

  return (
    <Subsection
      title="연결된 기기"
      lines={[
        "QR로 붙인 세션입니다. 마지막 사용 시각은 아직 기록하지 않습니다.",
      ]}
    >
      {list.isPending && (
        <div role="status" data-testid="linked-devices-loading">
          <span className="sr-only">연결된 기기를 불러오는 중입니다.</span>
          <Skeleton ready={false} rows={2} className="p-0" />
        </div>
      )}

      {list.isError && (
        <InlineBanner
          message={listFailureCopy(list.error)}
          actionLabel="다시 시도"
          onAction={() => void list.refetch()}
          className="px-0"
          separator={false}
          testId="linked-devices-error"
        />
      )}

      {list.isSuccess && rows.length === 0 && (
        <p
          className="break-keep text-body text-ink-muted"
          data-testid="linked-devices-empty"
        >
          연결된 기기가 없습니다.
        </p>
      )}

      {list.isSuccess && rows.length > 0 && (
        <ul
          ref={listRef}
          className="flex flex-col overflow-hidden rounded-md border border-line"
          data-testid="linked-devices-list"
        >
          {rows.map((device) => (
            <LinkedDeviceRow
              key={device.id}
              device={device}
              offline={offline}
              busy={busy}
              revoking={revokingId === device.id}
              currentReasonId={currentReasonId}
              offlineReasonId={offlineReasonId}
              onRevoke={() => revoke.mutate(device.id)}
            />
          ))}
        </ul>
      )}

      {list.isSuccess && rows.length > 0 && hasCurrent && (
        <p
          id={currentReasonId}
          className="break-keep text-meta text-ink-muted"
          data-testid="linked-devices-current-reason"
        >
          {CURRENT_REASON}
        </p>
      )}
      {list.isSuccess && rows.length > 0 && offline && (
        <p
          id={offlineReasonId}
          className="break-keep text-meta text-ink-muted"
          data-testid="linked-devices-offline"
        >
          {OFFLINE_REASON}
        </p>
      )}

      <p
        className="sr-only"
        role="status"
        data-testid="linked-devices-removed"
      >
        {removed}
      </p>

      {goneNotice && (
        <p
          className="break-keep text-meta text-ink-muted"
          role="status"
          data-testid="linked-devices-gone"
        >
          {goneNotice}
        </p>
      )}
      {rowError && (
        <p
          className="break-keep text-meta text-danger"
          role="alert"
          data-testid="linked-devices-revoke-error"
        >
          {rowError}
        </p>
      )}
    </Subsection>
  );
}

function LinkedDeviceRow({
  device,
  offline,
  busy,
  revoking,
  currentReasonId,
  offlineReasonId,
  onRevoke,
}: {
  device: LinkedDevice;
  offline: boolean;
  busy: boolean;
  revoking: boolean;
  currentReasonId: string;
  offlineReasonId: string;
  onRevoke: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const Icon = isPhonePlatform(device.platform) ? Smartphone : Monitor;
  const locked = device.current || offline || (busy && !revoking);
  const describedBy = device.current
    ? currentReasonId
    : offline
      ? offlineReasonId
      : undefined;
  const platformLabel = linkedDevicePlatformLabel(device.platform);

  return (
    <li
      className={cn(
        "flex min-w-0 gap-3 border-b border-line p-3 last:border-b-0",
        asking ? "flex-col items-stretch" : "items-start justify-between"
      )}
      data-testid={`linked-device-row-${device.id}`}
      data-current={device.current ? "true" : undefined}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Icon
          className="mt-px size-4 shrink-0 text-ink-muted"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <p className="min-w-0 break-keep text-body text-ink">
            {device.label}
          </p>
          <p className="break-keep text-meta text-ink-muted">
            {device.current ? (
              <>
                <span data-testid="linked-device-current">현재 기기</span>
                {", "}
              </>
            ) : null}
            {platformLabel}, {linkedAtCopy(device.linkedAt)}
          </p>
        </div>
      </div>
      <div className={asking ? "min-w-0" : "shrink-0"}>
        <ConfirmButton
          label="연결 해제"
          subject={device.label}
          question={REVOKE_QUESTION}
          confirmLabel="해제"
          busy={revoking}
          busyLabel="해제 중"
          disabled={locked}
          describedBy={describedBy}
          onAskingChange={setAsking}
          onConfirm={onRevoke}
          testId="linked-device-disconnect"
        />
      </div>
    </li>
  );
}

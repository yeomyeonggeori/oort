import { useEffect, useMemo, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { encodeQr, qrModulePath } from "@momo/core/lib/qr";
import {
  confirmDeviceLinkSas,
  DEVICE_LINK_POLL_INTERVAL_MS,
  getDeviceLink,
  issueDeviceLink,
  type DeviceLinkDevice,
  type DeviceLinkIssue,
} from "@momo/core/features/auth/deviceLink";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { CopyButton } from "./SettingsFields";
import { readDeviceLinkLive, writeDeviceLinkLive } from "./deviceLinkLive";

// Reading this as: settings / first-run for internal team users on web+Tauri,
// density 6/10, motion 2/10.

type Phase = "idle" | "pending" | "awaitingConfirm" | "connected" | "expired";

const COUNTDOWN_TICK_MS = 1_000;
const ANNOUNCE_SECONDS = 30;
const POLL_BACKOFF_CAP_MS = 16_000;
const OFFLINE_REASON_ID = "device-link-offline-reason";

function failureCopy(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "아직 폰이 이 코드를 쓰지 않았거나, 이 연결은 확인이 필요 없습니다. 폰에서 먼저 찍은 뒤 다시 시도하세요.";
    }
    if (error.status === 400) {
      return "서버가 확인 요청을 거절했습니다. 다시 시도하세요.";
    }
    if (error.status === 403) {
      return "사람 계정만 폰을 연결할 수 있습니다.";
    }
    if (error.status === 429) {
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
    }
  }
  return "서버가 연결을 만들지 못했습니다. 다시 시도하세요.";
}

function announceBand(remaining: number): number {
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / ANNOUNCE_SECONDS) * ANNOUNCE_SECONDS;
}

function toIssued(live: {
  id: string;
  expiresAt: number;
  deepLink?: string;
  sas?: string;
}): DeviceLinkIssue {
  return {
    id: live.id,
    token: "",
    expiresAt: live.expiresAt,
    deepLink: live.deepLink ?? "",
    ...(live.sas ? { sas: live.sas } : {}),
  };
}

function persistLiveWithoutVoucher(extra?: {
  sas?: string;
  confirmed?: boolean;
}): void {
  const live = readDeviceLinkLive();
  if (!live) return;
  writeDeviceLinkLive({
    id: live.id,
    expiresAt: live.expiresAt,
    ...(extra?.sas ?? live.sas ? { sas: extra?.sas ?? live.sas } : {}),
    ...(extra?.confirmed || live.confirmed ? { confirmed: true } : {}),
  });
}

// icon-system-exception(ADR-0172): this SVG is a data matrix of the deep link,
// not a function glyph. Lucide `QrCode` is a 16px icon and cannot encode a payload.
function DeviceLinkQr({ payload }: { payload: string }) {
  const encoded = useMemo(() => encodeQr(payload), [payload]);
  const path = useMemo(() => qrModulePath(encoded.modules), [encoded]);
  return (
    <svg
      role="img"
      aria-label="폰 연결 QR"
      viewBox={`0 0 ${path.viewBox} ${path.viewBox}`}
      className="qr-well shrink-0"
      data-qr-modules={String(path.viewBox)}
      data-testid="device-link-qr"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="currentColor" />
    </svg>
  );
}

function filledCreate(phase: Phase): boolean {
  return phase === "idle" || phase === "expired";
}

export function DeviceLinkCard({ offline = false }: { offline?: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [issued, setIssued] = useState<DeviceLinkIssue | null>(null);
  const [device, setDevice] = useState<DeviceLinkDevice | undefined>(undefined);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const liveIdRef = useRef<string | null>(null);

  useEffect(() => {
    const live = readDeviceLinkLive();
    if (!live) return;
    let cancelled = false;
    liveIdRef.current = live.id;
    void getDeviceLink(live.id)
      .then((status) => {
        if (cancelled || liveIdRef.current !== live.id) return;
        setIssued(toIssued(live));
        if (status.status === "consumed") {
          setDevice(status.device);
          persistLiveWithoutVoucher({
            ...(live.sas ? { sas: live.sas } : {}),
            ...(live.sas && !live.confirmed ? {} : { confirmed: true }),
          });
          if (live.sas && !live.confirmed) {
            setConfirmed(false);
            setPhase("awaitingConfirm");
          } else {
            setConfirmed(true);
            setPhase("connected");
          }
        } else if (status.status === "expired" || Date.now() >= live.expiresAt) {
          writeDeviceLinkLive(null);
          setPhase("expired");
        } else {
          setConfirmed(false);
          setPhase("pending");
          setRemaining(
            Math.max(0, Math.ceil((live.expiresAt - Date.now()) / 1_000))
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (Date.now() >= live.expiresAt) {
          writeDeviceLinkLive(null);
          setPhase("expired");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== "pending" || !issued) return;
    const id = issued.id;
    liveIdRef.current = id;
    let cancelled = false;
    let delay = DEVICE_LINK_POLL_INTERVAL_MS;
    let failures = 0;
    let timer = 0;
    const poll = async () => {
      if (cancelled || liveIdRef.current !== id) return;
      try {
        const status = await getDeviceLink(id);
        if (cancelled || liveIdRef.current !== id) return;
        failures = 0;
        delay = DEVICE_LINK_POLL_INTERVAL_MS;
        if (status.status === "consumed") {
          setDevice(status.device);
          persistLiveWithoutVoucher({
            ...(issued.sas ? { sas: issued.sas } : {}),
            ...(issued.sas && !confirmed ? {} : { confirmed: true }),
          });
          if (issued.sas && !confirmed) setPhase("awaitingConfirm");
          else setPhase("connected");
          return;
        }
        if (status.status === "expired") {
          writeDeviceLinkLive(null);
          setPhase("expired");
          return;
        }
      } catch (error) {
        if (cancelled || liveIdRef.current !== id) return;
        failures += 1;
        const copy = failureCopy(error);
        setBanner((prev) => (prev === copy ? prev : copy));
        if (Date.now() >= issued.expiresAt) {
          writeDeviceLinkLive(null);
          setPhase("expired");
          return;
        }
        delay = Math.min(
          DEVICE_LINK_POLL_INTERVAL_MS * 2 ** failures,
          POLL_BACKOFF_CAP_MS
        );
      }
      timer = window.setTimeout(() => {
        void poll();
      }, delay);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, issued, confirmed]);

  useEffect(() => {
    if (phase !== "pending" || !issued) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((issued.expiresAt - Date.now()) / 1_000));
      setRemaining(left);
      if (left <= 0) {
        writeDeviceLinkLive(null);
        setPhase("expired");
      }
    };
    tick();
    const timer = window.setInterval(tick, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [phase, issued]);

  const liveBand = phase === "pending" ? announceBand(remaining) : null;

  async function create(): Promise<void> {
    if (offline || busy) return;
    setBanner(null);
    setBusy(true);
    try {
      const next = await issueDeviceLink();
      liveIdRef.current = next.id;
      writeDeviceLinkLive({
        id: next.id,
        expiresAt: next.expiresAt,
        deepLink: next.deepLink,
        ...(next.sas ? { sas: next.sas } : {}),
      });
      setIssued(next);
      setDevice(undefined);
      setConfirmed(false);
      setPhase("pending");
      setRemaining(
        Math.max(0, Math.ceil((next.expiresAt - Date.now()) / 1_000))
      );
    } catch (error) {
      setBanner(failureCopy(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!issued || confirmBusy) return;
    setBanner(null);
    setConfirmBusy(true);
    try {
      await confirmDeviceLinkSas(issued.id);
      setConfirmed(true);
      setPhase("connected");
      persistLiveWithoutVoucher({
        ...(issued.sas ? { sas: issued.sas } : {}),
        confirmed: true,
      });
    } catch (error) {
      setBanner(failureCopy(error));
    } finally {
      setConfirmBusy(false);
    }
  }

  const showQr = phase === "pending" && issued;
  const showSas =
    Boolean(issued?.sas) && !confirmed && phase === "awaitingConfirm";
  const createLabel = busy
    ? "생성 중"
    : phase === "expired"
      ? "다시 만들기"
      : "QR 만들기";
  const body =
    phase === "connected"
      ? device
        ? `연결됨: ${device.name}`
        : "연결됨"
      : phase === "awaitingConfirm"
        ? device
          ? `코드를 쓴 기기: ${device.name}. 폰에 같은 숫자가 보이면 확인하세요.`
          : "폰이 코드를 썼습니다. 폰에 같은 숫자가 보이면 확인하세요."
        : phase === "expired"
          ? "이 코드는 만료됐습니다. 다시 만들면 새 QR이 나옵니다."
          : phase === "pending"
            ? "이 QR은 지금 살아 있습니다. 폰 카메라로 찍으세요."
            : "이 계정을 폰에서도 쓰려면 QR을 만드세요.";

  return (
    <div
      className="flex min-w-0 flex-col items-start gap-3 rounded-md border border-line bg-surface-raised p-4 shadow-sm"
      data-testid="device-link-card"
    >
      <div className="flex items-center gap-2">
        <Smartphone className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <h3 className="text-body font-semibold text-ink">폰 연결</h3>
      </div>
      <p
        className="break-keep text-body text-ink-muted"
        data-testid={
          phase === "connected"
            ? "device-link-connected"
            : phase === "expired"
              ? "device-link-expired"
              : phase === "awaitingConfirm"
                ? "device-link-awaiting-confirm"
                : phase === "pending"
                  ? "device-link-pending"
                  : undefined
        }
      >
        {body}
      </p>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 다시 연결된 뒤에 QR을 만들 수 있습니다."
          messageId={OFFLINE_REASON_ID}
          testId="device-link-offline"
          separator={false}
        />
      )}
      {banner && (
        <InlineBanner
          tone="error"
          message={banner}
          testId="device-link-banner"
          separator={false}
        />
      )}

      {showQr && issued && (
        <div className="flex min-w-0 flex-col items-start gap-3">
          <DeviceLinkQr payload={issued.deepLink} />
          <p
            className="font-mono text-body text-ink"
            data-numeric
            data-testid="device-link-countdown"
            aria-hidden="true"
          >
            남은 시간 {remaining}초
          </p>
          <p
            className="sr-only"
            aria-live="polite"
            data-testid="device-link-countdown-live"
          >
            {liveBand ? `남은 시간 ${liveBand}초` : ""}
          </p>
          <div className="self-start">
            <CopyButton
              value={issued.deepLink}
              label="복사"
              subject="연결 주소"
              testId="device-link-copy"
            />
          </div>
        </div>
      )}

      {showSas && issued?.sas && (
        <div className="flex min-w-0 flex-col items-start gap-2">
          <div
            role="group"
            className="flex items-center gap-2"
            data-testid="device-link-sas"
            aria-label={`확인 숫자 ${issued.sas}`}
          >
            {issued.sas.split("").map((digit, index) => (
              <span
                key={`${issued.id}-${index}`}
                data-numeric
                className="font-mono text-display font-semibold text-ink"
              >
                {digit}
              </span>
            ))}
          </div>
          <Button
            type="button"
            size="default"
            className="self-start"
            onClick={() => void confirm()}
            aria-busy={confirmBusy || undefined}
            data-testid="device-link-confirm-sas"
          >
            {confirmBusy ? "확인 중" : "폰에 같은 숫자가 보이면 확인"}
          </Button>
        </div>
      )}

      <Button
        type="button"
        size="default"
        variant={filledCreate(phase) ? "default" : "outline"}
        className={offline ? "self-start opacity-50" : "self-start"}
        onClick={() => void create()}
        aria-busy={busy || undefined}
        aria-disabled={offline || undefined}
        aria-describedby={offline ? OFFLINE_REASON_ID : undefined}
        data-testid="device-link-create"
      >
        {createLabel}
      </Button>
    </div>
  );
}

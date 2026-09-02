import { useEffect, useMemo, useState } from "react";
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

// Reading this as: settings / onboarding for internal team users on web+Tauri,
// density 6/10, motion 2/10.

type Phase = "idle" | "pending" | "expired" | "consumed";

const COUNTDOWN_TICK_MS = 1_000;
const ANNOUNCE_SECONDS = 30;

function failureCopy(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "아직 폰이 이 코드를 쓰지 않았거나, 이 연결은 확인이 필요 없습니다. 폰에서 먼저 찍은 뒤 다시 시도하세요.";
    }
    if (error.status === 400) {
      return "확인 요청을 읽지 못했습니다. 다시 시도하세요.";
    }
    if (error.status === 403) {
      return "사람 계정만 폰을 연결할 수 있습니다.";
    }
    if (error.status === 429) {
      return "잠시 뒤에 다시 시도하세요.";
    }
  }
  return "연결을 만들지 못했습니다. 다시 시도하세요.";
}

function announceBand(remaining: number): number {
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / ANNOUNCE_SECONDS) * ANNOUNCE_SECONDS;
}

// icon-system-exception(ADR-0172): this SVG is a scannable QR matrix, not a
// function glyph. Lucide `QrCode` is a 16px icon and cannot encode a deep link.
function DeviceLinkQr({ payload }: { payload: string }) {
  const encoded = useMemo(() => encodeQr(payload), [payload]);
  const path = useMemo(() => qrModulePath(encoded.modules), [encoded]);
  return (
    <svg
      role="img"
      aria-label="폰 연결 QR"
      viewBox={`0 0 ${path.viewBox} ${path.viewBox}`}
      className="qr-well size-pane-sm shrink-0"
      data-testid="device-link-qr"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="currentColor" />
    </svg>
  );
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

  useEffect(() => {
    if (phase !== "pending" || !issued) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getDeviceLink(issued.id);
        if (cancelled) return;
        if (status.status === "consumed") {
          setDevice(status.device);
          setPhase("consumed");
        } else if (status.status === "expired") {
          setPhase("expired");
        }
      } catch (error) {
        if (!cancelled) setBanner(failureCopy(error));
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, DEVICE_LINK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, issued]);

  useEffect(() => {
    if (phase !== "pending" || !issued) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((issued.expiresAt - Date.now()) / 1_000));
      setRemaining(left);
      if (left <= 0) setPhase("expired");
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
    } catch (error) {
      setBanner(failureCopy(error));
    } finally {
      setConfirmBusy(false);
    }
  }

  const showQr = phase === "pending" && issued;
  const showSas =
    Boolean(issued?.sas) &&
    !confirmed &&
    (phase === "pending" || phase === "consumed");
  const createLabel = busy
    ? "생성 중"
    : phase === "expired"
      ? "다시 만들기"
      : "QR 만들기";

  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4 shadow-sm"
      data-testid="device-link-card"
    >
      <div className="flex items-center gap-2">
        <Smartphone className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <h3 className="text-body font-semibold text-ink">폰 연결</h3>
      </div>
      <p
        className="break-keep text-body text-ink-muted"
        data-testid={
          phase === "consumed" && device ? "device-link-connected" : undefined
        }
      >
        {phase === "consumed" && device
          ? `연결됨: ${device.name}`
          : "이 계정을 폰에서도 쓰려면 QR을 만드세요."}
      </p>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 다시 연결된 뒤에 QR을 만들 수 있습니다."
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
        <div className="flex min-w-0 flex-col gap-3">
          <DeviceLinkQr payload={issued.deepLink} />
          {phase === "pending" && (
            <>
              <p
                className="font-mono text-body text-ink"
                data-numeric
                data-testid="device-link-countdown"
              >
                {remaining}초
              </p>
              <p
                className="sr-only"
                aria-live="polite"
                data-testid="device-link-countdown-live"
              >
                {liveBand === null
                  ? ""
                  : liveBand === 0
                    ? "만료됨"
                    : `${liveBand}초`}
              </p>
            </>
          )}
          <CopyButton
            value={issued.deepLink}
            label="복사"
            subject="연결 주소"
            testId="device-link-copy"
          />
        </div>
      )}

      {showSas && issued?.sas && (
        <div className="flex min-w-0 flex-col gap-2">
          <div
            className="flex items-center gap-2"
            data-testid="device-link-sas"
            aria-label={`확인 숫자 ${issued.sas}`}
            aria-live="polite"
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
            size="sm"
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
        onClick={() => void create()}
        aria-busy={busy || undefined}
        aria-disabled={offline || undefined}
        className={offline ? "opacity-50" : undefined}
        data-testid="device-link-create"
      >
        {createLabel}
      </Button>
    </div>
  );
}

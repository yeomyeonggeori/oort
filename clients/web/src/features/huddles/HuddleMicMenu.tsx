import { useId } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { Button } from "@/design/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { clampGainPercent } from "./micGain";
import { useAudioInputDevices } from "./useAudioInputDevices";

export const HUDDLE_MIC_PICKER_LABEL = "마이크 선택";
export const HUDDLE_MIC_MENU_LABEL = "마이크";
export const HUDDLE_MIC_DEFAULT_LABEL = "시스템 기본";
export const HUDDLE_MIC_GAIN_LABEL = "입력 음량";
export const HUDDLE_MIC_PERMISSION_PROMPT =
  "마이크 사용을 허용하면 장치를 고를 수 있습니다.";
export const HUDDLE_MIC_PERMISSION_DENIED =
  "마이크 권한이 없어 장치를 고를 수 없습니다. 브라우저 설정에서 허용하세요.";
export const HUDDLE_MIC_EMPTY = "연결된 마이크가 없습니다.";

const DEFAULT_DEVICE_VALUE = "__momo_default__";

function permissionCopy(permission: "prompt" | "granted" | "denied"): string {
  if (permission === "denied") return HUDDLE_MIC_PERMISSION_DENIED;
  return HUDDLE_MIC_PERMISSION_PROMPT;
}

export function HuddleMicMenu({
  selectedDeviceId,
  gainPercent,
  busy,
  disabled,
  split,
  onSelectDevice,
  onGainChange,
}: {
  selectedDeviceId: string;
  gainPercent: number;
  busy?: boolean;
  disabled?: boolean;
  split?: boolean;
  onSelectDevice: (deviceId: string) => void;
  onGainChange: (gainPercent: number) => void;
}) {
  const { devices, permission } = useAudioInputDevices();
  const menuLabelId = useId();
  const gainId = useId();
  const selectedInList = devices.some(
    (device) => device.deviceId === selectedDeviceId
  );
  const current = selectedInList ? selectedDeviceId : "";
  const radioValue = current === "" ? DEFAULT_DEVICE_VALUE : current;
  const showList = permission === "granted";
  const listEmpty = showList && devices.length === 0;
  const locked = Boolean(disabled);

  function nudgeGain(key: string): void {
    if (locked) return;
    if (key === "ArrowLeft") onGainChange(clampGainPercent(gainPercent - 1));
    if (key === "ArrowRight") onGainChange(clampGainPercent(gainPercent + 1));
  }

  const trigger = split ? (
    <button
      type="button"
      aria-label={HUDDLE_MIC_PICKER_LABEL}
      title={HUDDLE_MIC_PICKER_LABEL}
      aria-busy={busy || undefined}
      disabled={locked}
      data-testid="huddle-mic-devices"
      className="flex h-control w-6 shrink-0 items-center justify-center border-l border-line-strong text-ink-muted hover:bg-surface-hover focus-visible:focus-ring data-[state=open]:bg-surface-hover data-[state=open]:text-ink disabled:pointer-events-none disabled:opacity-50"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
      ) : (
        <ChevronsUpDown aria-hidden="true" className="size-4" />
      )}
    </button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={HUDDLE_MIC_PICKER_LABEL}
      title={HUDDLE_MIC_PICKER_LABEL}
      aria-busy={busy || undefined}
      disabled={locked}
      data-testid="huddle-mic-devices"
      className="shrink-0 text-ink-muted data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
      ) : (
        <ChevronsUpDown aria-hidden="true" className="size-4" />
      )}
    </Button>
  );

  return (
    <DropdownMenu>
      {split ? (
        <div className="wide-only">
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </div>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="end"
        data-testid="huddle-mic-menu"
        className="max-w-menu-available"
      >
        <DropdownMenuLabel id={menuLabelId}>
          {HUDDLE_MIC_MENU_LABEL}
        </DropdownMenuLabel>
        {!showList && (
          <p
            className="px-2 py-2 text-meta text-ink-muted"
            data-testid="huddle-mic-permission"
          >
            {permissionCopy(permission)}
          </p>
        )}
        {listEmpty && (
          <p
            className="px-2 py-2 text-meta text-ink-muted"
            data-testid="huddle-mic-empty"
          >
            {HUDDLE_MIC_EMPTY}
          </p>
        )}
        {showList && !listEmpty && (
          <DropdownMenuRadioGroup
            value={radioValue}
            aria-labelledby={menuLabelId}
            data-testid="huddle-mic-list"
          >
            <DropdownMenuRadioItem
              value={DEFAULT_DEVICE_VALUE}
              data-testid="huddle-mic-option-default"
              className="min-w-0"
              disabled={locked}
              onSelect={(event) => {
                event.preventDefault();
                onSelectDevice("");
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                {HUDDLE_MIC_DEFAULT_LABEL}
              </span>
              {current === "" && (
                <Check
                  className="size-4 shrink-0 text-ink-muted"
                  aria-hidden="true"
                />
              )}
            </DropdownMenuRadioItem>
            {devices.map((device) => {
              const isCurrent = device.deviceId === current;
              return (
                <DropdownMenuRadioItem
                  key={device.deviceId}
                  value={device.deviceId}
                  data-testid={`huddle-mic-option-${device.deviceId}`}
                  className="min-w-0"
                  disabled={locked}
                  onSelect={(event) => {
                    event.preventDefault();
                    onSelectDevice(device.deviceId);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{device.label}</span>
                  {isCurrent && (
                    <Check
                      className="size-4 shrink-0 text-ink-muted"
                      aria-hidden="true"
                    />
                  )}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        )}
        {showList && !listEmpty && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              layout="stack"
              data-testid="huddle-mic-gain-item"
              disabled={locked}
              onSelect={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                nudgeGain(event.key);
              }}
            >
              <label htmlFor={gainId} className="text-meta text-ink-muted">
                {HUDDLE_MIC_GAIN_LABEL}
              </label>
              <span className="flex w-full min-w-0 items-center gap-2">
                <input
                  id={gainId}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={gainPercent}
                  disabled={locked}
                  tabIndex={-1}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={gainPercent}
                  aria-valuetext={`${gainPercent}%`}
                  data-testid="huddle-mic-gain"
                  className="h-2 w-full min-w-0 accent-accent focus-visible:focus-ring"
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (
                      event.key === "ArrowLeft" ||
                      event.key === "ArrowRight"
                    ) {
                      event.preventDefault();
                      nudgeGain(event.key);
                    }
                  }}
                  onChange={(event) =>
                    onGainChange(Number(event.currentTarget.value))
                  }
                />
                <span
                  className="w-numeric-4 shrink-0 whitespace-nowrap text-right text-meta"
                  data-numeric
                  data-testid="huddle-mic-gain-value"
                >
                  {gainPercent}%
                </span>
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

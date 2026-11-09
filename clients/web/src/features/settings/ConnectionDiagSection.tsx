import { useSyncExternalStore } from "react";
import { Button } from "@/design/ui/button";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { readConnectionDiag, subscribeConnectionDiag } from "@/features/common/connectionDiag";
import { SettingsRow } from "@/features/settings/shell/SettingsRow";
import { SettingsSection } from "@/features/settings/shell/SettingsSection";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  formatConnectionDiag,
  todayConnectionDiagCounts,
  type ConnectionDiagKind,
} from "@momo/core/features/connection/diagnosticLog";
import type { PlainMessageKey } from "./settingsNav";

// =============================================================================
// 설정 > 업데이트 > 연결 기록 (#5587). 읽기 전용이다.
//
// 연결 판정이 흔들린 까닭을 owner 기기에서 가려내려고 남기는 기기 안 기록(`connectionDiag.ts`)을 꺼내 보는 가장 작은 자리다. 오늘의 횟수를
// 묶음별로 보이고, 기록 전체(UTC 시각 + 종류 낱말, 한 줄에 한 건)를 복사하는 단추 하나를 둔다. 「연결에 문제가 있어요」 카드가 이미 「연결 기록을
// 복사해 알려 주세요」라고 말하므로 단추 이름이 그 문장과 같다. 폰은 설정 > 정보의 「연결 기록 복사」가 같은 일을 한다.
//
// 데스크탑에서만 선다(이 페이지가 데스크탑 전용이고, 기록도 데스크탑에서만 남는다).
// =============================================================================

/** 오늘의 횟수를 보이는 묶음. 종류 낱말 여럿이 한 줄로 모인다. 순서는 사람이 먼저 물을 것부터다. */
const ROWS: ReadonlyArray<{ readonly labelKey: PlainMessageKey; readonly prefix: string; readonly testId: string }> = [
  { labelKey: "settings.connectionLog.sendBlocked", prefix: "send.blocked.", testId: "connection-log-send-blocked" },
  { labelKey: "settings.connectionLog.deviceOffline", prefix: "device.offline", testId: "connection-log-device-offline" },
  { labelKey: "settings.connectionLog.restFailed", prefix: "rest.fail.", testId: "connection-log-rest-failed" },
  { labelKey: "settings.connectionLog.socketDown", prefix: "socket.disconnected", testId: "connection-log-socket-down" },
  { labelKey: "settings.connectionLog.wakeLate", prefix: "wake.late.", testId: "connection-log-wake-late" },
  { labelKey: "settings.connectionLog.windowHidden", prefix: "window.hidden", testId: "connection-log-window-hidden" },
];

function countFor(counts: ReadonlyArray<{ kind: ConnectionDiagKind; count: number }>, prefix: string): number {
  return counts.reduce((sum, item) => (item.kind.startsWith(prefix) ? sum + item.count : sum), 0);
}

export function ConnectionDiagSection({ appVersion }: { appVersion: string | null }) {
  const formatMessage = useFormatMessage();
  const log = useSyncExternalStore(subscribeConnectionDiag, readConnectionDiag, readConnectionDiag);
  const counts = todayConnectionDiagCounts(log, Date.now());
  // 첫 줄은 앱 버전(알 때만)이다. 나머지는 한 줄에 한 건(UTC 시각 + 종류 낱말).
  const text = [appVersion, formatConnectionDiag(log)].filter((line) => line !== null).join("\n");
  const { copied, copy } = useClipboardCopy(text);

  return (
    <SettingsSection
      title={formatMessage("settings.connectionLog.title")}
      description={formatMessage("settings.connectionLog.description")}
      testId="connection-log"
    >
      {ROWS.map((row) => (
        <SettingsRow key={row.testId} label={formatMessage(row.labelKey)} testId={row.testId}>
          <span className="font-mono text-body text-ink" data-numeric>
            {formatMessage("settings.connectionLog.count", { count: countFor(counts, row.prefix) })}
          </span>
        </SettingsRow>
      ))}
      <SettingsRow
        label={formatMessage("settings.connectionLog.copyLabel")}
        description={formatMessage("settings.connectionLog.copyDescription")}
      >
        <Button variant="outline" size="sm" onClick={() => void copy()} data-testid="connection-log-copy">
          {formatMessage(copied ? "settings.connectionLog.copied" : "settings.connectionLog.copy")}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}

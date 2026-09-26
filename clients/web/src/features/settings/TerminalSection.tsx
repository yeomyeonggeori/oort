import {
  TERMINAL_APP_BINDINGS,
  keyPlatformOf,
  type KeyPlatform,
} from "@momo/core/features/workbench/keymap";
import { isDesktop } from "@/lib/tauri";
import { SectionShell } from "./SettingsFields";

// Reading this as: 설정 > 터미널(단축키 표) for internal team users on
// web+Tauri, density 6/10, motion 0/10.
//
// ADR-0190 D5 「터미널에 포커스가 있으면 앱 단축키보다 터미널 입력이 먼저다.
// 위 표의 앱 키만 가로챈다. 이 목록은 설정에서 볼 수 있다」. 표는 판정과 같은
// 배열(`TERMINAL_APP_BINDINGS`)을 그린다. 키를 바꾸면 이 화면도 같이 바뀐다.
//
// 바꾸는 자리는 없다(보기만). 다시 매핑은 이 이슈 밖이다.

function detectPlatform(): KeyPlatform {
  if (typeof navigator === "undefined") return "other";
  return keyPlatformOf(navigator.platform || navigator.userAgent);
}

/** macOS 키캡을 이 플랫폼 표기로. 다른 플랫폼은 ⌘를 Ctrl로 읽는다(D5). */
export function keycapLabel(platform: KeyPlatform, mac: string): string {
  if (platform === "mac") return mac;
  return mac
    .replace(/⌘/g, "Ctrl+")
    .replace(/⌃/g, "Ctrl+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌥/g, "Alt+")
    .replace(/↵/g, "Enter");
}

export function TerminalSection({
  desktop = isDesktop(),
  platform = detectPlatform(),
}: {
  desktop?: boolean;
  platform?: KeyPlatform;
}) {
  const lines = desktop
    ? [
        "로컬 터미널은 이 기기에서 셸과 하네스를 엽니다. 출력은 이 기기에만 있고 서버에 기록하지 않습니다.",
        "터미널에 포커스가 있으면 아래 표의 키만 앱이 받고, 나머지 키는 Esc를 포함해 모두 터미널로 갑니다.",
      ]
    : [
        "이 브라우저에는 로컬 터미널이 없습니다. 로컬 터미널과 아래 단축키는 oort 데스크탑 앱에서 씁니다.",
      ];
  return (
    <SectionShell title="터미널" lines={lines}>
      <table className="w-full border-collapse text-body" data-testid="terminal-shortcut-table">
        <caption className="sr-only">터미널에 포커스가 있을 때 앱이 가로채는 키</caption>
        <thead>
          <tr className="border-b border-line text-left text-meta text-ink-muted">
            <th scope="col" className="py-2 pr-4 font-medium">동작</th>
            <th scope="col" className="py-2 font-medium">키</th>
          </tr>
        </thead>
        <tbody>
          {TERMINAL_APP_BINDINGS.map((binding) => (
            <tr key={binding.id} className="border-b border-line align-top" data-testid="terminal-shortcut-row">
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                {binding.description}
                {binding.note ? (
                  <span className="block text-meta text-ink-muted">{binding.note}</span>
                ) : null}
              </th>
              <td className="py-2">
                <span className="flex flex-wrap gap-1">
                  {binding.keycaps.map((cap) => (
                    <kbd
                      key={cap}
                      className="rounded-sm border border-line bg-surface-muted px-1 font-mono text-meta text-ink"
                    >
                      {keycapLabel(platform, cap)}
                    </kbd>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionShell>
  );
}

import {
  TERMINAL_APP_BINDINGS,
  keyPlatformOf,
  type KeyPlatform,
} from "@momo/core/features/workbench/keymap";
import { isDesktop } from "@/lib/tauri";
import {
  setTerminalTheme,
  useTerminalTheme,
  type TerminalThemeChoice,
} from "@/features/workbench/local/terminalTheme";
import { ChoiceRadios, SectionShell } from "./SettingsFields";

// Reading this as: 설정 > 터미널(단축키 표) for internal team users on
// web+Tauri, density 6/10, motion 0/10.
//
// ADR-0190 D5 「터미널에 포커스가 있으면 앱 단축키보다 터미널 입력이 먼저다.
// 위 표의 앱 키만 가로챈다. 이 목록은 설정에서 볼 수 있다」. 표는 판정과 같은
// 배열(`TERMINAL_APP_BINDINGS`)을 그린다. 키를 바꾸면 이 화면도 같이 바뀐다.
//
// 바꾸는 자리는 없다(보기만). 다시 매핑은 이 이슈 밖이다.
//
// 터미널 색(#2849)은 데스크탑에서만 고른다. 기본은 어둡게이고, 저장 버튼 없이
// 누르는 즉시 열려 있는 칸이 바뀐다(설정 › 테마와 같은 이유).

/** 첫 값이 기본이다. 순서는 core `TERMINAL_THEME_CHOICES`와 같다. */
const TERMINAL_THEME_OPTIONS: { id: TerminalThemeChoice; label: string; detail: string }[] = [
  {
    id: "dark",
    label: "어둡게 (기본)",
    detail: "앱 테마와 상관없이 어두운 바탕에 그립니다. 셸 프롬프트와 TUI 대부분이 이 바탕을 전제로 색을 고릅니다.",
  },
  {
    id: "app",
    label: "앱 테마 따르기",
    detail: "앱이 라이트면 밝게, 다크면 어둡게 그립니다.",
  },
  {
    id: "light",
    label: "밝게",
    detail: "앱 테마와 상관없이 밝은 바탕에 그립니다. 어두운 바탕을 전제로 한 프롬프트는 덜 읽힐 수 있습니다.",
  },
];

export function TerminalThemeChoiceGroup() {
  const { theme, storageFailed } = useTerminalTheme();
  return (
    <ChoiceRadios
      name="terminal-theme"
      legend="터미널 색"
      choices={TERMINAL_THEME_OPTIONS}
      value={theme}
      onChange={(id) => setTerminalTheme(id as TerminalThemeChoice)}
      hint={
        storageFailed
          ? "이 기기에 저장하지 못했습니다. 앱을 다시 열면 어둡게로 돌아갑니다."
          : "이 기기에만 저장됩니다. 칸 테두리와 머리 줄은 앱 테마를 따릅니다."
      }
      testId="terminal-theme-choice"
    />
  );
}

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
      {desktop ? <TerminalThemeChoiceGroup /> : null}
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
                  {binding.keycaps.map((cap, i) => (
                    <span key={cap} className="flex items-center gap-1">
                      {/* 번호 이동은 ⌃1부터 ⌃9까지의 범위다(두 키가 아니다). */}
                      {binding.id === "focus-index" && i > 0 ? (
                        <span aria-hidden className="text-meta text-ink-muted">…</span>
                      ) : null}
                      <kbd className="rounded-sm border border-line bg-surface-muted px-1 font-mono text-meta text-ink">
                        {keycapLabel(platform, cap)}
                      </kbd>
                    </span>
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

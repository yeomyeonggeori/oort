import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keyPlatformOf, type KeyPlatform } from "@momo/core/features/workbench/keymap";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { Keycaps } from "@/app/ShortcutHelpDialog";
import { SHORTCUT_HELP_GROUPS } from "@/app/keyboardShortcuts";
import {
  checkBinding,
  comboKeycap,
  customizedCount,
  effectiveCombos,
  resetAllBindings,
  resetBinding,
  setBinding,
  shortcutStorageFailed,
  swapBindings,
  useShortcutBindingsVersion,
  type ShortcutCombo,
} from "@/app/shortcutBindings";
import { isDesktop } from "@/lib/tauri";
import { SettingsRow } from "./shell/SettingsRow";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";
import { TerminalSection } from "./TerminalSection";
import {
  buildShortcutRows,
  filterShortcutRows,
  groupDescription,
  type ShortcutRow,
} from "./shortcutRows";
import { keycapLabel } from "./TerminalSection";

// Reading this as: 설정 > 단축키 for internal team users on web+Tauri, density 6/10,
// motion 0/10.
//
// 목록은 도움말·팔레트와 같은 등록표(`keyboardShortcuts.ts`)와 core 터미널 표에서만 나온다.
// 바꿀 수 있는 키는 등록표가 `rebindable`로 표시한 다섯 줄이고, 나머지는 읽기 전용이다.
// 키 입력 칸은 `window` 캡처 단계에서 받는다: 입력 중에 ⌘K·⌘,가 팔레트나 설정을 열면 안 된다.

function detectPlatform(): KeyPlatform {
  if (typeof navigator === "undefined") return "other";
  return keyPlatformOf(navigator.platform || navigator.userAgent);
}

interface Notice {
  rowId: string;
  message: string;
  /** 같은 키를 쓰는 다른 항목과 맞바꿀 수 있을 때만 있다. */
  swap?: { combo: ShortcutCombo; conflictId: string };
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "AltGraph"]);

function changeButtonId(rowId: string): string {
  return `shortcut-change-${rowId}`;
}

export function ShortcutsSection({
  desktop = isDesktop(),
  platform = detectPlatform(),
}: {
  desktop?: boolean;
  platform?: KeyPlatform;
}) {
  // 키캡·사용자 지정 표시는 저장소에서 다시 읽는다.
  const version = useShortcutBindingsVersion();
  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [live, setLive] = useState("");
  const captureRef = useRef<HTMLButtonElement | null>(null);
  const swapRef = useRef<HTMLButtonElement | null>(null);

  const allRows = useMemo(
    () => buildShortcutRows(desktop),
    // 키캡·초기화 단추는 재지정이 바뀔 때(version) 다시 읽는다. 값 자체는 저장소에서 온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [desktop, version]
  );
  const rows = useMemo(
    () => filterShortcutRows(allRows, query, keycapLabel, platform),
    [allRows, query, platform]
  );
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const group of SHORTCUT_HELP_GROUPS) {
      for (const shortcut of group.shortcuts) map[shortcut.id] = shortcut.description;
    }
    return map;
  }, []);

  const groups = useMemo(() => {
    const order: { id: string; title: string; rows: ShortcutRow[] }[] = [];
    for (const row of rows) {
      let group = order.find((item) => item.id === row.groupId);
      if (group === undefined) {
        group = { id: row.groupId, title: row.groupTitle, rows: [] };
        order.push(group);
      }
      group.rows.push(row);
    }
    return order;
  }, [rows]);

  const focusChange = useCallback((rowId: string) => {
    // 상태가 반영되어 단추가 다시 그려진 뒤에 돌려준다.
    window.setTimeout(() => document.getElementById(changeButtonId(rowId))?.focus(), 0);
  }, []);

  const cancelCapture = useCallback(
    (announce: boolean, rowId: string | null) => {
      setCapturingId(null);
      setNotice(null);
      if (announce) setLive("키 지정을 취소했어요.");
      if (rowId !== null) focusChange(rowId);
    },
    [focusChange]
  );

  // 키 입력 칸: 캡처 단계에서 모든 키를 받는다.
  useEffect(() => {
    if (capturingId === null) return;
    const rowId = capturingId;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") return;
      if (event.key === "Tab") return; // 포커스 이동은 막지 않는다. 벗어나면 입력이 끝난다.
      // Esc(수식 키 없음)는 아래 `useEscapeLayer`가 가져간다: 설정 셸의 「앱으로 돌아가기」
      // Esc와 같은 키라, 층으로 올려야 이 입력만 취소되고 설정은 닫히지 않는다.
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return;
      if (MODIFIER_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || event.code === "") return;

      const modOk =
        platform === "mac"
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
      const modName = platform === "mac" ? "⌘" : "Ctrl";
      if (!modOk) {
        const message = `${modName} 키와 함께 누르세요. 글자만 누르면 입력과 구분되지 않아요.`;
        setNotice({ rowId, message });
        setLive(message);
        return;
      }
      const combo: ShortcutCombo = { code: event.code, shift: event.shiftKey, alt: event.altKey };
      const effective = effectiveCombos();
      const current = effective[rowId];
      if (
        current !== undefined &&
        current.code === combo.code &&
        current.shift === combo.shift &&
        current.alt === combo.alt
      ) {
        const message = "이미 이 항목에 지정된 키예요.";
        setNotice({ rowId, message });
        setLive(message);
        return;
      }
      const result = checkBinding(rowId, combo, { desktop, platform, effective, names });
      if (result.ok) {
        setBinding(rowId, combo);
        setCapturingId(null);
        setNotice(null);
        setLive(`「${names[rowId] ?? rowId}」 키를 ${keycapLabel(platform, comboKeycap(combo))}(으)로 바꿨어요.`);
        focusChange(rowId);
        return;
      }
      if (result.kind === "conflict" && current !== undefined) {
        // 서로 바꾸기: 상대가 내 옛 키를 받아도 규칙을 통과해야 한다.
        const back = checkBinding(result.conflictId, current, {
          desktop,
          platform,
          effective: { ...effective, [rowId]: combo },
          names,
        });
        if (back.ok) {
          const message = `${result.message} 서로 바꾸거나 다른 키를 고르세요.`;
          setCapturingId(null);
          setNotice({ rowId, message, swap: { combo, conflictId: result.conflictId } });
          setLive(message);
          return;
        }
        const message = `${result.message} 서로 바꿀 수도 없으니 다른 키를 누르세요.`;
        setNotice({ rowId, message });
        setLive(message);
        return;
      }
      setNotice({ rowId, message: result.message });
      setLive(`${result.message} 다른 키를 누르거나 Esc로 취소하세요.`);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturingId, cancelCapture, desktop, platform, names, focusChange]);

  useEscapeLayer(capturingId !== null, () => cancelCapture(true, capturingId));

  useEffect(() => {
    if (capturingId !== null) captureRef.current?.focus();
  }, [capturingId]);

  useEffect(() => {
    if (notice?.swap !== undefined) swapRef.current?.focus();
  }, [notice]);

  const startCapture = (row: ShortcutRow) => {
    setNotice(null);
    setCapturingId(row.id);
    setLive(`「${row.name}」에 지정할 키를 누르세요. Esc로 취소해요.`);
  };

  const confirmSwap = () => {
    if (notice?.swap === undefined) return;
    const { conflictId } = notice.swap;
    const rowId = notice.rowId;
    // 내 새 키를 먼저 상대 자리에서 비우기 위해 한 번에 맞바꾼다. 새 키는 상대의 현재 키다.
    swapBindings(rowId, conflictId);
    setLive(`「${names[rowId] ?? rowId}」과 「${names[conflictId] ?? conflictId}」의 키를 서로 바꿨어요.`);
    setNotice(null);
    focusChange(rowId);
  };

  const onResetAll = () => {
    resetAllBindings();
    setCapturingId(null);
    setNotice(null);
    setLive("모든 단축키를 기본 키로 되돌렸어요.");
  };

  const lines = desktop
    ? [
        "메신저 안에서 쓰는 단축키와 데스크탑의 작업 공간 키예요. 바꾼 키는 이 기기에만 저장돼요.",
        "터미널에 포커스가 있으면 터미널이 키를 먼저 가져요. 아래 키를 바꿔도 터미널로 넘어가는 키가 늘지 않아요.",
      ]
    : [
        "메신저 안에서 쓰는 단축키예요. 바꾼 키는 이 브라우저에만 저장돼요.",
        "브라우저가 먼저 받는 키(새 탭, 새로고침 등)와 입력 칸의 서식 키(굵게, 기울임)는 지정할 수 없어요. 「데스크탑 전용」 표시가 있는 키는 데스크탑 앱에서만 동작해요.",
      ];
  const modifierName = platform === "mac" ? "⌘" : "Ctrl";
  const customized = customizedCount();
  const storageFailed = shortcutStorageFailed();

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="shortcuts-page">
      <div className="flex min-w-0 flex-col gap-4">
        <p className="break-keep text-body text-ink-muted">{lines.join(" ")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-pane-sm flex-1">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="이름이나 키로 검색"
              aria-label="단축키 검색"
              data-testid="shortcut-search"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={customized === 0}
            onClick={onResetAll}
            data-testid="shortcut-reset-all"
          >
            모두 초기화
          </Button>
        </div>

        {storageFailed ? (
          <p className="text-meta text-danger" role="alert" data-testid="shortcut-storage-failed">
            이 기기에 저장하지 못했어요. 앱을 다시 열면 기본 키로 돌아가요.
          </p>
        ) : null}

        {/* 낭독 전용. 키 지정 시작·취소·충돌·완료를 한 자리에서 알린다. */}
        <p className="sr-only" role="status" aria-live="polite" data-testid="shortcut-live">
          {live}
        </p>
      </div>

      {groups.length === 0 ? (
        <SettingsSection>
          <CardBody>
            <p className="break-keep text-body text-ink-muted" data-testid="shortcut-empty">
              일치하는 단축키가 없어요. 이름이나 키를 다시 확인해 주세요.
            </p>
          </CardBody>
        </SettingsSection>
      ) : (
        <div className="flex min-w-0 flex-col gap-8" data-testid="shortcut-list">
          {groups.map((group) => (
            <SettingsSection
              key={group.id}
              title={group.title}
              description={groupDescription(group.id, desktop) ?? undefined}
            >
              {group.rows.map((row) => {
                const capturing = capturingId === row.id;
                const rowNotice = notice?.rowId === row.id ? notice : null;
                const status = capturing
                  ? `${modifierName} 키를 누른 채 키를 누르세요. Esc로 취소해요.`
                  : [
                      // 데스크탑 앱 안에서는 모든 키가 동작하므로 표시가 소음이다. 브라우저에서만 말한다.
                      row.desktopOnly && !desktop ? "데스크탑 전용" : null,
                      row.rebindable ? null : "고정",
                      row.customized ? "변경됨" : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" · ") || "기본 키";
                return (
                  <div
                    key={row.id}
                    className="flex min-w-0 flex-col"
                    data-shortcut-row={row.id}
                    data-rebindable={row.rebindable ? "true" : "false"}
                  >
                    <SettingsRow label={row.name} description={status}>
                      <div className="flex w-action flex-wrap items-center justify-end gap-1">
                        {capturing ? (
                          <button
                            ref={captureRef}
                            type="button"
                            className="w-action rounded-md border border-line-strong bg-surface px-2 py-1 text-meta text-ink press focus-visible:focus-ring"
                            aria-label={`키를 누르세요. 「${row.name}」에 지정해요. Esc로 취소해요.`}
                            onBlur={() => {
                              // 포커스가 입력 칸을 벗어나면 입력이 끝난다. 끝났다고 알리고 남은 경고를 걷는다.
                              if (capturingId !== row.id) return;
                              setCapturingId(null);
                              setNotice((current) => (current?.swap === undefined ? null : current));
                              setLive("포커스를 옮겨 키 지정을 끝냈어요. 키는 그대로예요.");
                            }}
                            data-testid="shortcut-capture"
                          >
                            키를 누르세요
                          </button>
                        ) : (
                          <Keycaps
                            keycaps={row.keycaps}
                            format={(cap) => keycapLabel(platform, cap)}
                          />
                        )}
                      </div>
                      {row.rebindable ? (
                        <div className="flex w-action items-center justify-end gap-1">
                          <Button
                            id={changeButtonId(row.id)}
                            type="button"
                            variant="ghost"
                            size="sm"
                            // 취소 단추를 눌러도 입력 칸의 포커스가 먼저 빠지지 않게 한다.
                            // 빠지면 입력이 끝나고 같은 단추가 「변경」으로 바뀌어 다시 시작된다.
                            onMouseDown={capturing ? (event) => event.preventDefault() : undefined}
                            onClick={() => (capturing ? cancelCapture(true, row.id) : startCapture(row))}
                            aria-label={
                              capturing
                                ? `취소, 「${row.name}」 키 지정`
                                : `변경, 「${row.name}」 단축키`
                            }
                            data-testid={`shortcut-change-${row.id}`}
                          >
                            {capturing ? "취소" : "변경"}
                          </Button>
                          {row.customized ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                resetBinding(row.id);
                                setNotice(null);
                                setLive(`「${row.name}」 키를 기본 키로 되돌렸어요.`);
                              }}
                              aria-label={`초기화, 「${row.name}」 단축키를 기본 키로`}
                              data-testid={`shortcut-reset-${row.id}`}
                            >
                              초기화
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </SettingsRow>
                    {row.terminalNote !== null || rowNotice !== null ? (
                      <div className="flex flex-col gap-2 px-4 pb-3">
                        {row.terminalNote !== null ? (
                          <p className="break-keep text-meta text-ink-muted">{row.terminalNote}</p>
                        ) : null}
                        {rowNotice !== null ? (
                          <div className="flex flex-col gap-2" data-testid="shortcut-notice">
                            <p className="break-keep text-meta text-danger">{rowNotice.message}</p>
                            {rowNotice.swap !== undefined ? (
                              <div className="flex items-center gap-2">
                                <Button
                                  ref={swapRef}
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  onClick={confirmSwap}
                                  data-testid="shortcut-swap"
                                >
                                  서로 바꾸기
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => cancelCapture(true, row.id)}
                                  data-testid="shortcut-swap-cancel"
                                >
                                  취소
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </SettingsSection>
          ))}
        </div>
      )}
      {/* 검색은 위 목록만 거른다: 검색 중에는 걸러지지 않는 터미널 목록을 숨겨서 「일치하는 키가
          없어요」 옆에 안 걸린 표가 서지 않게 한다. */}
      {query.trim() === "" ? <TerminalSection desktop={desktop} platform={platform} /> : null}
    </div>
  );
}

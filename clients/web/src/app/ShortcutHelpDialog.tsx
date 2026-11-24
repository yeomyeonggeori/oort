import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, CircleHelp, Search } from "lucide-react";
import { looseTailIncludes } from "@momo/core/features/channels/nameSearch";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { OPEN_DIALOG_SELECTOR } from "@/design/ui/escapeLayer";
import { Dialog, DialogContent, DialogTitle } from "@/design/ui/dialog";
import {
  OPEN_SHORTCUT_HELP_SHORTCUT,
  SHORTCUT_HELP_GROUPS,
  shouldOpenShortcutHelp,
  type ShortcutHelpGroup,
} from "@/app/keyboardShortcuts";
import { useShortcutBindingsVersion } from "@/app/shortcutBindings";
import { rememberSettingsOpener } from "@/features/settings/settingsFocus";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { Tooltip } from "@/design/ui/tooltip";

/**
 * 키캡 상자. 글꼴·모서리·그릇·색이 한 벌로 여기 한 번만 적힌다.
 *
 * ⌘K 팔레트도 같은 키를 그린다(ADR-0186 D1 키캡 힌트). 두 자리가 각자 `<kbd>`를
 * 적으면 도움말과 팔레트의 키가 서로 다른 모양으로 늙는다 — 이 파일이 애초에
 * 세워진 이유(키 문자열을 다시 적으면 갈라진다)와 같은 규율이라, 상자도 한 번만
 * 적는다. 문자열 자체는 여전히 `keyboardShortcuts.ts`의 `keycaps`에서 온다.
 */
const KEYCAP_BOX =
  "whitespace-nowrap rounded-sm bg-muted-soft px-2 font-mono text-meta text-ink";

/**
 * 갈리는 것은 **세로 여백 하나**뿐이고, 그 갈림은 상자가 선 자리에서 나온다.
 *
 * `block` 은 이 파일의 정의 목록이다: 키캡이 그 줄에서 가장 큰 것이라 상자가 행
 * 높이를 정해도 된다.
 *
 * `inline` 은 텍스트 줄에 **얹히는** 자리다(⌘K 팔레트 명령 줄, #2524 R1 H-1).
 * 거기서 `py-1` 상자는 18+8=26px 이 되어 `text-body` 줄상자(22px)보다 크고,
 * 그러면 키캡이 달린 줄만 4px 높아진다 — 한 목록의 행 리듬이 **내용**으로
 * 흔들린다. `py-px` 면 상자가 20px 이라 줄상자 안에 들어가고, 행 높이는 다시
 * 글자가 정한다. 키 문자열도 상자의 정체성도 갈리지 않는다.
 */
const KEYCAP_PAD = { block: "py-1", inline: "py-px" } as const;

export function Keycaps({
  keycaps,
  variant = "block",
  format,
}: {
  keycaps: readonly string[];
  variant?: keyof typeof KEYCAP_PAD;
  /** 키캡 글자를 바꿔 적는다(설정이 macOS 밖에서 ⌘를 Ctrl로 적을 때). 키 문자열 자체는 그대로다. */
  format?: (keycap: string) => string;
}) {
  return (
    <>
      {keycaps.map((keycap) => (
        <kbd key={keycap} className={`${KEYCAP_BOX} ${KEYCAP_PAD[variant]}`}>
          {format ? format(keycap) : keycap}
        </kbd>
      ))}
    </>
  );
}

function anotherDialogIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  // "Is another dialog *open*", not "who owns this Escape". Presence-exit
  // nodes are not open; overlayOwnsEscape(event) is the ownership predicate.
  return document.querySelector(OPEN_DIALOG_SELECTOR) !== null;
}

/** 설정 › 단축키. 목차 id 는 `settingsNav.ts` 의 `shortcuts` 다. */
const SHORTCUT_SETTINGS_PATH = "/settings?section=shortcuts";

/** 「?로 다시 열 수 있어요」의 키캡 자리. 문장은 사전의 것이고, 키캡만 그 자리에 부품으로 선다(`ChannelNameField` 와 같은 표지). */
const REOPEN_KEY_MARK = "";

/**
 * 찾기 칸에 친 말로 줄을 거른다 (#6081). 재료는 사람이 보는 것 셋: 줄의 설명 · 묶음 머리 · 키캡.
 *
 * 낱말(빈칸으로 나눈 조각)마다 재료 안에 있어야 한다. 마지막 낱말만은 한글 조합 중이어도 맞는다(ADR-0225 D12,
 * ⌘K 팔레트 · 작성창 `#` 과 같은 `looseTailIncludes`): 「탐색」을 치는 동안 입력기가 만드는 「탐ㅅ」 · 「탐새」에서도
 * 「탐색 패널 접고 펴기」 줄이 사라졌다 돌아오지 않는다. 팔레트의 부분수열 일치(「dpl」 → deploy)는 쓰지 않는다:
 * 아홉 줄짜리 목록에서 띄엄띄엄 맞는 줄은 거른 것이 아니라 남긴 것이다.
 */
function matchingGroups(
  groups: readonly ShortcutHelpGroup[],
  query: string
): readonly ShortcutHelpGroup[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter((shortcut) => {
        const hay = [shortcut.description, group.title, ...shortcut.keycaps].join(" ").toLowerCase();
        return tokens.every(
          (token, index) =>
            hay.includes(token) || (index === tokens.length - 1 && looseTailIncludes(token, hay))
        );
      }),
    }))
    .filter((group) => group.shortcuts.length > 0);
}

/**
 * 묶음을 두 열로 나눈다. 차례는 그대로 두고 앞에서부터 왼쪽 열을 채우다가 절반(줄 + 머리)에 닿으면 오른쪽으로 간다.
 * 지금 표(탐색 7 · 작성과 동작 1 · 메시지 행 1)는 시안 장면 2 처럼 왼쪽 「탐색」, 오른쪽 나머지 둘이 된다.
 * 한 열 폭에서는 두 열이 위아래로 이어 서므로 읽는 차례가 원래 표와 같다.
 */
function splitColumns(
  groups: readonly ShortcutHelpGroup[]
): readonly (readonly ShortcutHelpGroup[])[] {
  const weight = (group: ShortcutHelpGroup) => group.shortcuts.length + 1;
  const total = groups.reduce((sum, group) => sum + weight(group), 0);
  const left: ShortcutHelpGroup[] = [];
  let filled = 0;
  for (const group of groups) {
    if (left.length > 0 && filled >= total / 2) break;
    left.push(group);
    filled += weight(group);
  }
  const right = groups.slice(left.length);
  return right.length > 0 ? [left, right] : [left];
}

/**
 * 창의 속. 찾기 말은 여기 산다: 창이 닫히면 이 칸이 내려가므로 다시 열 때마다 빈 칸에서 시작한다.
 *
 * 모양은 2026-11-20 시안 장면 2 의 추천안(디자인 시스템 README §2.16):
 * - 머리: 제목 + 찾기 칸(공용 `Input` + 돋보기, 사람 목록 · 메시지 검색과 같은 그릇). 설명 문장과 「닫기」 줄은 없다.
 *   Esc · 바깥 누르기로 닫히고, 바닥 한 줄이 「?」로 다시 연다고 말한다.
 * - 몸: 줄 사이 선 대신 묶음 머리(작은 굵은 글자)와 여백으로 나눈다. 가리킨 줄만 옅은 바탕(`hover:bg-surface-hover`).
 *   두 열은 몸의 폭이 `@xl`(36rem) 이상일 때만. 좁은 창 · 큰 글자에서는 한 열이다.
 * - 바닥: 「단축키 바꾸기 →」(설정 › 단축키) · 「?로 다시 열 수 있어요」.
 */
function ShortcutHelpBody({
  searchRef,
  onChangeShortcuts,
}: {
  searchRef: RefObject<HTMLInputElement>;
  onChangeShortcuts: () => void;
}) {
  const formatMessage = useFormatMessage();
  const [query, setQuery] = useState("");
  const groups = matchingGroups(SHORTCUT_HELP_GROUPS, query);
  const columns = splitColumns(groups);
  const [reopenBefore = "", reopenAfter = ""] = formatMessage("app.shortcutHelp.reopenHint", {
    key: REOPEN_KEY_MARK,
  }).split(REOPEN_KEY_MARK);
  const searchLabel = formatMessage("app.shortcutHelp.search");

  return (
    <>
      <div className="flex flex-col gap-3 px-6 pt-6">
        <DialogTitle>키보드 단축키</DialogTitle>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
          />
          {/* 글 칸에 찾기 역할만 준다: type="search" 는 엔진이 제 색(파랑)의 지우기 X 를 그려 시안 밖 색이 서고,
              Esc 가 칸 비우기와 창 닫기를 한 번에 한다. 이 창의 Esc 는 닫기 하나다. */}
          <Input
            ref={searchRef}
            type="text"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={searchLabel}
            placeholder={searchLabel}
            autoComplete="off"
            spellCheck={false}
            className="ps-8"
            data-testid="shortcut-help-search"
          />
        </div>
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto px-4 pb-2 pt-4">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-label text-ink-muted" data-testid="shortcut-help-empty">
            {formatMessage("app.shortcutHelp.empty")}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 @xl:grid-cols-2">
            {columns.map((column) => (
              <div key={column[0]?.id} className="flex min-w-0 flex-col gap-4">
                {column.map((group) => (
                  <section key={group.id} aria-labelledby={`shortcut-group-${group.id}`}>
                    <h2
                      id={`shortcut-group-${group.id}`}
                      className="px-2 pb-1 text-meta font-semibold text-ink-muted"
                    >
                      {group.title}
                    </h2>
                    <dl className="flex flex-col">
                      {group.shortcuts.map((shortcut) => (
                        <div
                          key={shortcut.id}
                          className="flex min-h-control items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-surface-hover"
                          data-shortcut-id={shortcut.id}
                        >
                          <dt className="min-w-0 text-label text-ink">{shortcut.description}</dt>
                          <dd className="flex shrink-0 items-center gap-1">
                            <Keycaps keycaps={shortcut.keycaps} variant="inline" />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onChangeShortcuts}
          data-testid="shortcut-help-change"
        >
          {formatMessage("app.shortcutHelp.change")}
          <ArrowRight aria-hidden="true" />
        </Button>
        <p className="flex items-center gap-1 pe-2 text-meta text-ink-muted">
          {reopenBefore}
          <Keycaps keycaps={OPEN_SHORTCUT_HELP_SHORTCUT.keycaps} variant="inline" />
          {reopenAfter}
        </p>
      </div>
    </>
  );
}

/**
 * 전역 단축키 도움말. 실제 버튼과 `?`가 같은 프로그램형 Dialog를 연다.
 * DialogTrigger는 쓰지 않고, 연 순간의 엘리먼트를 opener로 넘겨 WebKit에서도
 * Esc 뒤 포커스가 제자리로 돌아가게 한다.
 */
export function ShortcutHelpDialog() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  // 설정에서 키를 바꾸면 도움말의 키캡도 같은 정본에서 다시 읽는다 (#3281).
  useShortcutBindingsVersion();

  const setDialogOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  const openFrom = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    setDialogOpen(true);
  }, [setDialogOpen]);

  // 「단축키 바꾸기」: 창을 닫고 설정 › 단축키로 간다. 설정에서 돌아오면 캐럿은 이 창을 연 자리로 간다
  // (`rememberSettingsOpener`, ⌘, 와 같은 길). 이미 설정 안이면 기록을 하나 더 쌓지 않는다: 「앱으로 돌아가기」가
  // 뒤로 가기라 겹친 /settings 가 첫 누름을 먹는다(#1867 H-1, QuickSwitcher 의 ⌘, 와 같은 이유).
  const goToShortcutSettings = useCallback(() => {
    const already = location.pathname === "/settings";
    if (!already) rememberSettingsOpener(openerRef.current ?? triggerRef.current);
    setDialogOpen(false);
    navigate(SHORTCUT_SETTINGS_PATH, { replace: already });
  }, [location.pathname, navigate, setDialogOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        openRef.current ||
        anotherDialogIsOpen() ||
        !shouldOpenShortcutHelp(event)
      ) {
        return;
      }
      event.preventDefault();
      const active = document.activeElement;
      openFrom(active instanceof HTMLElement ? active : null);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFrom]);

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <Tooltip label="단축키 도움말 (?)" side="top">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => openFrom(triggerRef.current)}
          aria-label="단축키 도움말 열기"
          data-testid="shortcut-help-trigger"
          className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </Tooltip>

      {/* 설명 문장은 걷었다(시안 장면 2): 이 창의 이름은 제목이 말하고, 묶음 머리 · 줄이 내용을 말한다.
          Radix 는 Description 이 없으면 aria-describedby 를 비우라고 한다. 열리면 캐럿은 찾기 칸에 선다:
          아홉 줄을 Tab 으로 걷지 않고 바로 치면 된다. */}
      <DialogContent
        opener={openerRef.current}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        className="max-w-pane-lg gap-0 overflow-hidden"
        data-testid="shortcut-help-dialog"
      >
        <ShortcutHelpBody searchRef={searchRef} onChangeShortcuts={goToShortcutSettings} />
      </DialogContent>
    </Dialog>
  );
}

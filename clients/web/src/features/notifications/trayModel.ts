import type { LocaleService } from "@momo/core/i18n";
import { composedUnreadCount } from "@momo/core/features/readState/model";
import type { AdeItem, AdeState } from "@momo/core/features/work/adeControl";
import type { ReadState } from "@momo/core/lib/api";
import type { TrayStatusWire } from "@/lib/tauri";

// =============================================================================
// 메뉴 막대 아이콘의 웹 쪽 규칙 (#5193). 순수 함수만 있다 — 훅·IPC는 `TrayStatus.tsx`가 한다.
//
// 셸(`clients/desktop/src-tauri/src/tray.rs`)은 문구를 한 글자도 들고 있지 않다. 이 파일이 그 순간의 상태를
// 만든다: 독 배지와 같은 수, 실행 중인 작업 줄들, 메뉴의 낱말(이미 사람의 언어로). 셸에서 돌아오는 길은
// `momo:tray-action` 이벤트 하나이고, 그 읽기(`readTrayAction`)와 작업 카드의 갈 곳(`adeItemLanding`)은 코어에 있다.
// 이벤트의 줄 id는 이 쪽이 마지막으로 보낸 줄들(`TrayRows.byId`)과 맞춰 본 것만 믿는다 — 페이로드를 그대로 이동
// 경로로 쓰지 않는다(`bannerClicks.ts`의 `claimBanner`와 같은 규칙).
//
// 「모두 읽음 처리」(#5195)의 뜻은 여기 한 곳이다(`readAllTargets`): 안 읽은 멘션이 있는 채널과 안 읽은 DM의 읽음 위치를
// 최신으로 올린다. 메뉴 항목의 켜짐(`readAll`)과 눌렀을 때 읽는 채널 목록이 같은 함수의 답이라, 항목이 켜져 있으면 눌렀을 때
// 반드시 무언가 읽힌다. 승인·응답 필요 칸은 읽음이 아니라 결정으로만 닫히므로 건드리지 않고, 남아 있는 수를 한 줄로 말한다.
// =============================================================================

/**
 * 메뉴가 늘어놓는 작업 줄의 상한. 셸의 `MAX_RUN_ROWS`와 같은 수다(`tests/fixtures/tray_limits.json`을 셸 시험과 `trayModel.test.ts`가 함께 읽어 맞춘다).
 * 넘치면 셸이 상태 전체를 거절해 메뉴가 옛 모습에 멈추므로, 그보다 적게 보내고 나머지는 `more` 한 줄로 말한다.
 */
export const TRAY_MAX_ROWS = 6;

/** 이름을 보내는 길이(코드 포인트). 셸은 24자에서 자르고, 이 값은 비정상적으로 긴 이름이 IPC를 부풀리지 않게 하는 선이다. */
const TITLE_SEND_CODE_POINTS = 64;

/** 이름에서 걷어 내는 문자: 제어 문자와 글자 순서·모양을 흔드는 보이지 않는 문자(셸의 `is_unsafe_char`와 같다). */
function isUnsafe(char: string): boolean {
  const c = char.codePointAt(0) ?? 0;
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  );
}

/** 메뉴에 쓸 이름: 걷어 낸 자리는 공백이 되고 공백은 하나로 접힌다. 비면 보여 줄 것이 없다. */
export function cleanTitle(raw: string): string {
  const blanked = Array.from(raw, (char) => (isUnsafe(char) ? " " : char)).join("");
  const collapsed = blanked.split(/\s+/).filter(Boolean).join(" ");
  return Array.from(collapsed).slice(0, TITLE_SEND_CODE_POINTS).join("");
}

/**
 * 줄 id를 나눠 주는 장부. 작업 카드의 key(`run|<uuid>|<uuid>`)는 셸이 받는 id 모양(짧은 토큰)이 아니고 줄여 쓰면 서로
 * 겹칠 수 있어서, 카드마다 짧은 id(`0`, `1`, … 36진수)를 하나씩 정해 준다. 같은 카드는 실행 중인 동안 늘 같은 id이므로
 * 메뉴가 다시 그려져도 열려 있던 줄을 누른 선택이 같은 작업으로 간다. 끝난 카드의 id는 장부에서 빠지고 다시 쓰이지
 * 않는다 — 메뉴에 남아 있던 옛 줄을 누르면 id가 장부에 없어 아무 데도 가지 않는다(엉뚱한 작업으로 가지 않는다).
 */
export interface RowIds {
  /** 이 카드의 id. 처음 보는 카드면 새로 정한다. */
  of: (key: string) => string;
  /** 지금 실행 중인 카드들만 남기고 나머지의 id는 버린다(장부가 자라지 않게). */
  keepOnly: (keys: Iterable<string>) => void;
}

export function createRowIds(): RowIds {
  const ids = new Map<string, string>();
  let next = 0;
  return {
    of(key) {
      let id = ids.get(key);
      if (id === undefined) {
        id = next.toString(36);
        next += 1;
        ids.set(key, id);
      }
      return id;
    },
    keepOnly(keys) {
      const keep = new Set(keys);
      for (const key of [...ids.keys()]) if (!keep.has(key)) ids.delete(key);
    },
  };
}

/** 「모두 읽음 처리」가 닫지 못하는 것: 읽음이 아니라 결정으로만 닫히는 일의 수(`useNeedsMe`의 승인·칸). */
export interface StillWaiting {
  approvals: number;
  panes: number;
}

/** 메뉴의 낱말. 사람의 언어로 이미 만든 것이다(`trayCopy`). */
export interface TrayCopy {
  labels: TrayStatusWire["labels"];
  stateWorking: string;
  stateBlocked: string;
  more: (count: number) => string;
  /** 「모두 읽음 처리」 밑의 한 줄: 남은 일의 종류에 맞는 문장. 남은 것이 없으면 `null`(줄이 아예 없다). */
  remaining: (left: StillWaiting) => string | null;
}

/** 카탈로그의 메뉴 낱말. 끝내기는 앱 메뉴의 ⌘Q 항목과 같은 낱말이다(같은 길이므로). */
export function trayCopy(t: LocaleService["formatMessage"]): TrayCopy {
  return {
    labels: {
      running: t("desktop.tray.running"),
      none: t("desktop.tray.none"),
      newMessage: t("desktop.tray.newMessage"),
      readAll: t("desktop.tray.readAll"),
      open: t("desktop.tray.open"),
      quit: t("desktop.menu.quit"),
    },
    stateWorking: t("desktop.tray.stateWorking"),
    stateBlocked: t("desktop.tray.stateBlocked"),
    more: (count) => t("desktop.tray.more", { count }),
    remaining: ({ approvals, panes }) => {
      if (approvals > 0 && panes > 0) return t("desktop.tray.remainBoth", { approvals, panes });
      if (approvals > 0) return t("desktop.tray.remainApprovals", { count: approvals });
      if (panes > 0) return t("desktop.tray.remainPanes", { count: panes });
      return null;
    },
  };
}

/** 「모두 읽음 처리」가 읽음 위치를 올릴 채널 하나: `seq`는 지금까지 아는 가장 최신(서버가 `latestSeq`로 죈다). */
export interface ReadAllTarget {
  channelId: string;
  seq: number;
}

/**
 * 「모두 읽음 처리」가 읽음으로 만들 채널들(#5195, owner 결정: 「안 읽은 멘션·DM만」).
 *
 *  - 안 읽은 멘션이 있는 채널(`mentionCount > 0`): 독 배지의 멘션 수가 이 읽음 위치에서 나온다.
 *  - 안 읽은 DM(`composedUnreadCount > 0`, 사이드바와 같은 판정이라 「여기부터 안 읽음」 표시도 든다).
 *    독 배지의 「안 읽은 DM도 합산」 옵션과 무관하다: 이 항목의 뜻은 옵션이 아니라 「멘션·DM을 읽었다」이다.
 *
 * **읽음 위치를 올리는 이유.** 인박스 서버의 `read-all`(`POST …/inbox/read-all`)은 인박스 항목의 `read_at`만 채우고 채널
 * 읽음 위치와 `mention_count`를 건드리지 않는다(ADR-0199 D3: 항목→커서 방향 없음). 그것만 부르면 인박스는 비는데 독 배지와
 * 메뉴 막대의 점은 그대로여서 「눌렀는데 그대로」가 된다. 읽음 위치를 올리면 같은 트랜잭션에서 `mention_count`가 다시 계산되고
 * 트리거가 그 채널의 인박스 항목을 읽음으로 채운다(커서→항목, 마이그레이션 126) — 점·배지·인박스가 한 규칙으로 바뀐다.
 * 값은 그 채널 **전체**가 읽힌다는 것이다(멘션 뒤의 다른 메시지도): 읽음 위치는 채널 단위다.
 *
 * 한 채널은 한 번만 든다(멘션이 있는 DM).
 */
export function readAllTargets(input: {
  readStates: readonly ReadState[];
  /** DM 채널의 id(소문자). */
  dmChannelIds: ReadonlySet<string>;
}): ReadAllTarget[] {
  const targets: ReadAllTarget[] = [];
  const seen = new Set<string>();
  for (const row of input.readStates) {
    const key = row.channelId.toLowerCase();
    if (seen.has(key)) continue;
    const mentioned = row.mentionCount > 0;
    const unreadDm = input.dmChannelIds.has(key) && composedUnreadCount(row) > 0;
    if (!mentioned && !unreadDm) continue;
    seen.add(key);
    targets.push({ channelId: row.channelId, seq: row.latestSeq });
  }
  return targets;
}

/** 메뉴에 오르는 상태: 실행 중과 대기. 유휴(호스트가 터미널을 열어 둘 뿐)는 진행 중인 작업이 아니다(`adeCounts.total`과 같은 뜻). */
const LISTED: Readonly<Record<AdeState, boolean>> = { working: true, blocked: true, idle: false };

export interface TrayRows {
  status: TrayStatusWire;
  /** 보낸 줄의 id → 그 작업. 셸이 돌려준 id는 여기 있는 것만 믿는다. */
  byId: ReadonlyMap<string, AdeItem>;
}

/**
 * 셸에 보낼 상태. 실행 중인 작업을 관제 서랍이 정한 순서(대기 먼저, 오래된 것 먼저) 그대로 `TRAY_MAX_ROWS`까지 싣고,
 * 넘치는 수는 `more` 한 줄로 말한다.
 *
 * 이름이 비어 보이는 작업(보이지 않는 문자뿐)은 줄에서 뺀다 — 셸은 그런 줄 하나 때문에 상태 전체를 거절하므로, 한 줄을
 * 못 그리는 쪽이 메뉴 전체가 멈추는 쪽보다 낫다. 빠진 줄도 `more`의 수에는 든다(실행 중인 것은 맞다).
 */
export function buildTrayStatus(input: {
  unread: number;
  compose: boolean;
  /** 「모두 읽음 처리」가 할 일이 있다(`readAllTargets`가 비지 않았다). */
  readAll: boolean;
  /** 「모두 읽음 처리」를 눌러도 남는 일. */
  left: StillWaiting;
  items: readonly AdeItem[];
  copy: TrayCopy;
  rowIds: RowIds;
}): TrayRows {
  const live = input.items.filter((item) => LISTED[item.state]);
  input.rowIds.keepOnly(live.map((item) => item.key));
  const stateWord: Readonly<Record<AdeState, string>> = {
    working: input.copy.stateWorking,
    blocked: input.copy.stateBlocked,
    idle: "",
  };
  const byId = new Map<string, AdeItem>();
  const running: TrayStatusWire["running"] = [];
  for (const item of live) {
    if (running.length >= TRAY_MAX_ROWS) break;
    const title = cleanTitle(item.title);
    if (title === "") continue;
    const id = input.rowIds.of(item.key);
    byId.set(id, item);
    running.push({ id, title, state: stateWord[item.state] });
  }
  const hidden = live.length - running.length;
  return {
    status: {
      unread: input.unread,
      compose: input.compose,
      readAll: input.readAll,
      labels: input.copy.labels,
      running,
      more: hidden > 0 ? input.copy.more(hidden) : null,
      remaining: input.copy.remaining(input.left),
    },
    byId,
  };
}

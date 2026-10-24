import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  closeDm,
  reopenDm,
  uuidEq,
  type Channel,
  type ReadState,
} from "@momo/core/lib/api";
import {
  dmClosedListReason,
  type DmCounterpart,
} from "@momo/core/features/sidebar/dmVisibility";
import {
  readProjectionPhase,
  rosterIsComplete,
  type ReadProjectionPhase,
} from "@momo/core/features/sidebar/goneDm";
import {
  isChannelStarred,
  sectionIdForChannel,
  type SidebarPrefs,
} from "@momo/core/features/sidebar/sidebarSections";
import {
  channelLabelParts,
  idKey,
  type Directory,
} from "@momo/core/features/workspace/directory";
import { applyClosureToCache } from "@/features/workspace/useWorkspace";
import {
  DM_CLOSURE_CACHE_KEY,
  dmClosureCacheOf,
  dmClosureMode,
  dmVerdict,
  foldDmClosureAbsent,
  migrateDmLedger,
  parseDmClosureCache,
  type DmClosureCache,
  type DmClosureMode,
  type DmVerdict,
} from "./dmClosureModel";
import { useDmRevival } from "./dmRevival";
import { useGoneUnreadVerdicts } from "./goneUnreadVerdicts";
import {
  closeDmOnDevice,
  closedDmsFor,
  reopenDmOnDevice,
  useClosedDms,
  type ClosedDms,
} from "./sidebarDmClosure";

// =============================================================================
// 사이드바와 본문(`ChatShell` 의 인덱스 폴백)이 **같이 읽는** DM 보임 훅 (ADR-0177 증보 D8, #4228).
//
// 둘이 따로 판정하면 사이드바는 숨기는데 본문은 여는 길이 생긴다(design-review #3963 R1 H1). 그래서 입력을 모으는 일도 한 곳이다.
// 판정 자체는 코어 `dmVisibility`, 입력을 모으는 규칙은 `dmClosureModel.ts` 가 갖고, 이 훅은 거기에 읽음 투영·명부·별표·원장·
// 첫 페인트 캐시를 대 준다.
// =============================================================================

const EMPTY_LEDGER: ClosedDms = Object.freeze({});

interface ReadStatesLike {
  data?: ReadState[];
  isPending: boolean;
  isError?: boolean;
  byChannel: Map<string, ReadState>;
}

export interface ClosedListEntry {
  channel: Channel;
  /** closed: 내가 명시적으로 닫았다(7번) · gone: 상대가 나갔다(6번). */
  reason: "closed" | "gone";
}

export interface DmVisibilityView {
  mode: DmClosureMode;
  phase: ReadProjectionPhase;
  /** 열림 여부를 **뺀** 판정. 열린 DM 은 호출부가 보임으로 얹는다(`dmShownNow`). */
  verdictOf: (channelId: string) => DmVerdict;
  /** 「⋯ › 닫은 대화」 목록: 숨겨진 DM 중 명시적 닫기(7)와 나간 상대(6)만. */
  closedList: readonly ClosedListEntry[];
  /** 지금 DM 이 하나라도 판정을 미루고 있나(재설치 직후 첫 투영을 기다린다). */
  anyPending: boolean;
}

function readCache(workspaceId: string): DmClosureCache | null {
  try {
    return parseDmClosureCache(
      typeof localStorage === "undefined" ? null : localStorage.getItem(DM_CLOSURE_CACHE_KEY),
      workspaceId
    );
  } catch {
    return null;
  }
}

function writeCache(workspaceId: string, cache: DmClosureCache): void {
  try {
    if (typeof localStorage === "undefined") return;
    let all: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(DM_CLOSURE_CACHE_KEY) ?? "{}");
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        all = parsed as Record<string, unknown>;
      }
    } catch {
      all = {};
    }
    all[workspaceId.toLowerCase()] = cache;
    localStorage.setItem(DM_CLOSURE_CACHE_KEY, JSON.stringify(all));
  } catch {
    // 저장소 거부: 첫 페인트가 투영을 기다릴 뿐이다.
  }
}

export function useDmVisibility(input: {
  workspaceId: string;
  dms: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
  /** 명부를 받았나(`rosterLoaded`). */
  rosterReady: boolean;
  readStates: ReadStatesLike;
  /** 별표·섹션 배치. 아직 모르면 `undefined`(별표가 없는 것과 같다 - 별표는 보임 쪽이라 모르면 코어가 숨길 수 있다). */
  prefs: SidebarPrefs | undefined;
}): DmVisibilityView {
  const { workspaceId, dms, directory, selfMemberId, rosterReady, readStates, prefs } = input;
  const phase = readProjectionPhase(readStates);
  const ledger = useClosedDms(workspaceId);

  // 첫 페인트 사본은 워크스페이스가 바뀔 때 한 번 읽는다(렌더마다 파싱하지 않는다).
  const cacheRef = useRef<{ workspaceId: string; cache: DmClosureCache | null } | null>(null);
  if (cacheRef.current === null || cacheRef.current.workspaceId !== workspaceId) {
    cacheRef.current = { workspaceId, cache: readCache(workspaceId) };
  }
  const cache = cacheRef.current.cache;

  const rows = readStates.data;
  const projectionMode = dmClosureMode({ workspaceId, rows });
  // 투영이 아직 없을 때(오는 중): 사본이 있으면 server, 없고 원장에 항목이 있으면 legacy.
  const mode: DmClosureMode =
    projectionMode !== "unknown"
      ? projectionMode
      : phase === "loading"
        ? cache !== null
          ? "server"
          : Object.keys(ledger).length > 0
            ? "legacy"
            : "unknown"
        : "unknown";
  const legacy = mode !== "server";

  // legacy 갈래의 되살림·안 읽음 판정은 서버가 닫기를 기억하면 **읽지 않는다**: 후보가 비도록 원장은 비우고 국면은 오는 중으로 준다.
  const revivalLatestSeqOf = useDmRevival({
    workspaceId,
    dms,
    closed: legacy ? ledger : EMPTY_LEDGER,
    byChannel: readStates.byChannel,
    phase: legacy ? phase : "loading",
  });
  const goneVerdicts = useGoneUnreadVerdicts({
    workspaceId,
    dms,
    directory,
    selfMemberId,
    rosterReady,
    byChannel: readStates.byChannel,
    phase: legacy ? phase : "loading",
    closed: legacy ? ledger : EMPTY_LEDGER,
    closureLatestSeqOf: revivalLatestSeqOf,
  });

  const rosterComplete = rosterIsComplete(directory.members.length);
  const verdicts = useMemo(() => {
    const out = new Map<string, DmVerdict>();
    for (const dm of dms) {
      const id = idKey(dm.id);
      const label = channelLabelParts(dm, directory, selfMemberId, { rosterReady });
      // 명부를 믿을 수 있을 때만 「나간 멤버」다(D8 `unknown`): 못 받았거나 한도에서 잘렸으면 6번을 건너뛴다.
      const counterpart: DmCounterpart =
        label.kind === "gone" ? (rosterComplete ? "gone" : "unknown") : label.kind === "pending" ? "unknown" : "present";
      out.set(
        id,
        dmVerdict({
          mode,
          phase,
          counterpart,
          starredOrSectioned:
            prefs !== undefined &&
            (isChannelStarred(prefs, dm.id) || sectionIdForChannel(prefs, dm.id) !== null),
          read: readStates.byChannel.get(id),
          cache,
          channelId: id,
          ledgerClosedAtSeq: ledger[id],
          revivalLatestSeq: revivalLatestSeqOf(dm.id),
          goneVerdict: goneVerdicts.get(id),
        })
      );
    }
    return out;
  }, [dms, directory, selfMemberId, rosterReady, rosterComplete, mode, phase, prefs, readStates.byChannel, cache, revivalLatestSeqOf, goneVerdicts, ledger]);

  const verdictOf = useCallback(
    (channelId: string): DmVerdict => verdicts.get(idKey(channelId)) ?? { state: "shown", rule: 9 },
    [verdicts]
  );

  const closedList = useMemo(() => {
    const out: ClosedListEntry[] = [];
    for (const dm of dms) {
      const verdict = verdicts.get(idKey(dm.id));
      if (verdict === undefined || verdict.state !== "hidden") continue;
      const reason = dmClosedListReason(verdict.rule);
      if (reason !== null) out.push({ channel: dm, reason });
    }
    return out;
  }, [dms, verdicts]);

  const anyPending = useMemo(
    () => Array.from(verdicts.values()).some((verdict) => verdict.state === "pending"),
    [verdicts]
  );

  // 마지막 투영의 사본을 갈아 둔다(D8 첫 페인트). server 갈래의 **준비된** 투영에서만, 바뀔 때만 쓴다.
  const lastWritten = useRef<string>("");
  useEffect(() => {
    if (mode !== "server" || phase !== "ready" || rows === undefined) return;
    const next = dmClosureCacheOf(rows, new Set(dms.map((dm) => idKey(dm.id))));
    const serialized = JSON.stringify(next);
    if (serialized === lastWritten.current) return;
    lastWritten.current = serialized;
    writeCache(workspaceId, next);
  }, [mode, phase, rows, dms, workspaceId]);

  return { mode, phase, verdictOf, closedList, anyPending };
}

/** 이 세션에서 이전을 이미 시작한 워크스페이스. 실패한 항목의 재시도는 **다음 실행**이다(같은 세션에서 반복하지 않는다). */
const migrationStarted = new Set<string>();

/** 시험 전용. */
export function resetDmMigrationForTest(): void {
  migrationStarted.clear();
}

/**
 * 로컬 원장 이전(D12): server 갈래의 준비된 투영이 오면 한 번. 한 세션에 한 번만 돈다(진행 중·끝난 워크스페이스). 사이드바 한 곳만
 * 부른다 - 본문(`ChatShell`)은 읽기만 하므로 쓰기 길(QueryClient)을 들이지 않는다.
 */
export function useDmLedgerMigration(input: {
  workspaceId: string;
  mode: DmClosureMode;
  phase: ReadProjectionPhase;
  rows: ReadState[] | undefined;
}): void {
  const { workspaceId, mode, phase, rows } = input;
  const client = useQueryClient();
  useEffect(() => {
    if (mode !== "server" || phase !== "ready" || rows === undefined) return;
    const key = workspaceId.toLowerCase();
    if (migrationStarted.has(key)) return;
    migrationStarted.add(key);
    const ledger = closedDmsFor(workspaceId);
    void migrateDmLedger({
      workspaceId,
      ledger,
      rows,
      put: (channelId, seenSeq) => closeDm(workspaceId, channelId, seenSeq),
      forget: (channelId) => reopenDmOnDevice(workspaceId, channelId),
      storage: (() => {
        try {
          return typeof localStorage === "undefined" ? null : localStorage;
        } catch {
          return null;
        }
      })(),
    }).then((result) => {
      if (result.absent) foldDmClosureAbsent(workspaceId);
      // 서버 사실로 맞춘다: 올린 항목의 닫힘이 투영에 실려 오게 다시 읽는다.
      if (result.settled.length > 0) {
        void client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
      }
    });
  }, [workspaceId, mode, phase, rows, client]);
}

export interface DmClosureActions {
  /** DM 을 닫는다. 실패하면 `false`(호출부가 말한다). */
  close: (channelId: string, seenSeq: number) => Promise<boolean>;
  /** 닫은 DM 을 다시 연다. 서버에 닫힘이 없으면 아무것도 쓰지 않는다. */
  reopen: (channelId: string) => Promise<boolean>;
}

/**
 * 이 오류가 「이 서버에는 닫기 경로가 없다」인가. 405/501 이다. 404 는 아니다: 서버가 닫기를 싣는다고 투영으로 이미 알려 준 뒤의 404 는
 * 「그 DM 이 없다」(참여자가 아니거나 보관됨)다(`migrateDmLedger` 가 항목별로 같이 읽는다).
 */
function closureRouteAbsent(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 405 || error.status === 501);
}

/**
 * 닫기·다시 열기 쓰기. server 갈래는 서버에 쓰고 **쓴 기기는 즉시 반영한다**(D10): 성공을 기다리지 않고 캐시 행에 먼저 적고, 실패하면
 * 되돌린다. 경로가 없다고 답하면(404/405/501) 그 워크스페이스를 legacy 로 접고 **이 호출을 원장에 쓴다** - 사람이 한 닫기가 사라지지
 * 않는다.
 */
export function useDmClosureActions(input: {
  workspaceId: string;
  mode: DmClosureMode;
  byChannel: Map<string, ReadState>;
}): DmClosureActions {
  const { workspaceId, mode, byChannel } = input;
  const client = useQueryClient();
  const byChannelRef = useRef(byChannel);
  byChannelRef.current = byChannel;

  const close = useCallback(
    async (channelId: string, seenSeq: number): Promise<boolean> => {
      // 서버가 닫기를 기억한다고 **알 때만** 서버에 쓴다. 증거가 없는 동안(`unknown`: 투영 행이 0 개)은 원장에 쓴다 - 행이 생겨 server
      // 로 판명되면 숨은 항목이 그때 서버로 옮겨 간다(`migrateDmLedger`).
      if (mode !== "server") {
        closeDmOnDevice(workspaceId, channelId, seenSeq);
        return true;
      }
      const before = byChannelRef.current.get(idKey(channelId))?.closedAtSeq;
      applyClosureToCache(client, workspaceId, channelId, seenSeq);
      try {
        await closeDm(workspaceId, channelId, seenSeq);
        return true;
      } catch (error) {
        applyClosureToCache(client, workspaceId, channelId, before ?? null);
        if (closureRouteAbsent(error)) {
          // 이 서버에는 경로가 없다: 접고 이 닫기를 원장에 쓴다 - 사람이 한 닫기가 사라지지 않는다.
          foldDmClosureAbsent(workspaceId);
          closeDmOnDevice(workspaceId, channelId, seenSeq);
          return true;
        }
        return false;
      }
    },
    [client, mode, workspaceId]
  );

  const reopen = useCallback(
    async (channelId: string): Promise<boolean> => {
      if (mode !== "server") {
        reopenDmOnDevice(workspaceId, channelId);
        return true;
      }
      const row = byChannelRef.current.get(idKey(channelId));
      // 닫은 적이 없으면(나간 상대의 DM·열린 DM) 쓸 것이 없다(D8): 왕복도 만들지 않는다.
      if (row === undefined || typeof row.closedAtSeq !== "number") return true;
      const before = row.closedAtSeq;
      applyClosureToCache(client, workspaceId, channelId, null);
      try {
        await reopenDm(workspaceId, channelId);
        return true;
      } catch (error) {
        applyClosureToCache(client, workspaceId, channelId, before);
        if (error instanceof ApiError && error.status === 404) return true;
        return false;
      }
    },
    [client, mode, workspaceId]
  );

  return useMemo(() => ({ close, reopen }), [close, reopen]);
}

/**
 * 지금 이 DM 이 목록에 서는가: **열린 DM 은 언제나 선다**(D8-1). 판정이 미뤄진 DM(재설치 직후 첫 투영 전)은 서지 않는다.
 */
export function dmShownNow(
  verdict: DmVerdict,
  channelId: string,
  openId: string | null
): boolean {
  if (openId !== null && uuidEq(channelId, openId)) return true;
  return verdict.state === "shown";
}

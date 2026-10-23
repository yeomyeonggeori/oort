import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { uuidEq, type Channel, type RosterMember } from "@momo/core/lib/api";
import { dmPeer } from "@momo/core/features/workspace/directory";
import { apiBase } from "@momo/core/runtime/host";
import {
  createScheduledMessage,
  deleteScheduledMessage,
  listAllScheduledMessages,
  sendScheduledMessageNow,
  updateScheduledMessage,
} from "@momo/core/features/scheduled/api";
import { isScheduledAbsent, isSchedulerDisabled } from "@momo/core/features/scheduled/errors";
import {
  EMPTY_SCHEDULED_STORE,
  applyScheduledEvent,
  applyScheduledList,
  applyScheduledRow,
  removeScheduledRow,
  type ScheduledMessageFrame,
  type ScheduledStore,
} from "@momo/core/features/scheduled/events";
import { nextScheduledBoundaryMs, scheduledTotals } from "@momo/core/features/scheduled/model";
import type {
  CreateScheduledInput,
  ScheduledMessage,
  ScheduledPatch,
} from "@momo/core/features/scheduled/types";
import {
  SCHEDULED_UNKNOWN_CHANNEL_LABEL,
  dmConversationLabel,
  errorPlaceWord,
  placeWord,
  type ErrorPlaceWord,
  type PlaceWord,
} from "@momo/core/features/scheduled/copy";
import { useSession } from "@/app/session";
import {
  channelLabelParts,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";

// =============================================================================
// 예약 메시지의 웹 데이터 층 (ADR-0208 D12·D16, #4215). 병합 규칙은 코어(`features/scheduled/events`)가
// 한 벌 갖고, 이 파일은 그것을 React Query 캐시와 개인 채널 구독에 꽂는 일만 한다.
//
//   읽기   `GET …/scheduled-messages`(열린 목록 전부). **첫 요청이 404면 이 서버에는 예약이 없다**: 입구
//          (▾·사이드바 줄·배너)를 세션 동안 세우지 않고 다시 묻지도 않는다. 5xx·네트워크 오류는 없는 서버가
//          아니라 장애이므로 입구는 두고 목록 화면이 오류를 말한다(`useInboxSurface`와 같은 규칙).
//   이벤트 개인 채널 `scheduled_message.updated`는 본문이 없다. 아는 행은 그 자리에서 고치고 모르는 행은 뼈대
//          행으로 세워서, **`sessions_ended`로 멈춘 예약이 이벤트가 도착하는 즉시** 목록의 「보내지 못함」·채널
//          배너·사이드바 알약에 잡힌다(owner 결정 6). 본문은 뒤따르는 `GET`이 채운다.
//   쓰기   응답 행을 같은 병합 함수로 캐시에 합친다. 폰은 이벤트 구독이 없어 응답과 목록만 합치지만 같은 함수다.
//
// 캐시는 이 세션의 메모리뿐이고 로그아웃에서 사라진다(ADR-0208 D14: 오프라인 목록 캐시는 로그아웃 때 지운다).
// =============================================================================

export type ScheduledSurface = "unknown" | "present" | "absent";

interface ScheduledCache {
  surface: "present" | "absent";
  store: ScheduledStore;
}

/** 서버 주소가 키에 있어서 서버를 바꾸면 다시 묻는다. */
export const scheduledQueryKey = (workspaceId: string) =>
  ["scheduled", apiBase(), workspaceId] as const;

/** 이벤트가 알려 준 변화를 읽어 오기까지 모아 두는 시간. 재접속 때 지난 신호가 몰려 와도 한 번에 읽는다. */
const REFETCH_DEBOUNCE_MS = 250;
const STALE_MS = 30_000;

async function loadScheduled(
  client: QueryClient,
  key: ReturnType<typeof scheduledQueryKey>,
  workspaceId: string
): Promise<ScheduledCache> {
  const previous = client.getQueryData<ScheduledCache>(key);
  try {
    const rows = await listAllScheduledMessages(workspaceId, { status: "open" });
    return {
      surface: "present",
      store: applyScheduledList(previous?.store ?? EMPTY_SCHEDULED_STORE, rows),
    };
  } catch (error) {
    // 404만 「없는 서버」다. 그 밖의 오류는 던져서 쿼리가 오류 상태로 말하게 한다(이전 데이터는 남는다).
    if (isScheduledAbsent(error)) return { surface: "absent", store: EMPTY_SCHEDULED_STORE };
    throw error;
  }
}

function withStore(
  current: ScheduledCache | undefined,
  next: (store: ScheduledStore) => ScheduledStore
): ScheduledCache {
  const base = current?.store ?? EMPTY_SCHEDULED_STORE;
  return { surface: "present", store: next(base) };
}

/**
 * 이벤트 한 건을 캐시에 합친다. 이미 아는 `rev` 이하면 캐시 객체를 **그대로** 돌려줘 구독자가 다시 그려지지
 * 않는다. 다시 읽어야 하면 `true`를 돌려준다(시험이 읽는 순수 쪽 입구).
 */
export function applyFrameToCache(
  client: QueryClient,
  workspaceId: string,
  frame: ScheduledMessageFrame
): boolean {
  if (!uuidEq(frame.workspaceId, workspaceId)) return false;
  const key = scheduledQueryKey(workspaceId);
  let refetch = false;
  client.setQueryData<ScheduledCache>(key, (current) => {
    if (current?.surface === "absent") return current;
    const base = current?.store ?? EMPTY_SCHEDULED_STORE;
    const result = applyScheduledEvent(base, frame);
    refetch = result.refetch;
    if (result.store === base && current !== undefined) return current;
    return { surface: "present", store: result.store };
  });
  return refetch;
}

// ---- 서버가 예약을 껐다는 사실 (쓰기의 503 `scheduler_disabled`) -------------------------------------
//
// 입구는 서되 흐리게 하고 이유를 말한다(UI 명세 0.6). 앞선 쓰기가 그렇게 답했다는 **잠시 동안의 사실**이라 캐시가 아니라 작은
// 외부 저장소가 든다(키는 서버 주소 + 워크스페이스). 쓰기가 한 번 성공하면 풀리고, **아무 일이 없어도 5분 뒤에 풀린다**:
// 관리자가 스케줄러를 다시 켜도 클라이언트가 그것을 알 길은 쓰기뿐인데, ▾가 흐려서 쓰기를 시도할 수 없으면 앱을 다시 켜기
// 전에는 영영 풀리지 않는다(데스크탑 앱은 며칠씩 켜져 있다, design-review #4215 M4). 풀린 뒤 한 번 더 시도해서 같은 503을
// 받으면 다시 흐려지고, 그 시도는 직접 고르기의 오류 줄이 이유를 말하므로 사람은 영문을 모르는 채 막히지 않는다.

/** 「서버가 예약을 껐다」를 믿는 시간. */
export const SCHEDULER_DISABLED_MEMORY_MS = 5 * 60_000;

const disabledSince = new Map<string, number>();
const disabledListeners = new Set<() => void>();
let disabledVersion = 0;

const disabledKey = (workspaceId: string) => `${apiBase()}|${workspaceId}`;

function notifyDisabled(): void {
  disabledVersion += 1;
  for (const listener of disabledListeners) listener();
}

function setDisabled(workspaceId: string, disabled: boolean): void {
  const key = disabledKey(workspaceId);
  if (disabled) {
    // 같은 503이 이어서 오면 기억의 시작을 새로 쓴다(마지막으로 확인한 때부터 5분이다).
    disabledSince.set(key, Date.now());
  } else if (!disabledSince.delete(key)) {
    return;
  }
  notifyDisabled();
}

function useSchedulerDisabled(workspaceId: string): boolean {
  useSyncExternalStore(
    (listener) => {
      disabledListeners.add(listener);
      return () => {
        disabledListeners.delete(listener);
      };
    },
    () => disabledVersion
  );
  const since = disabledSince.get(disabledKey(workspaceId));
  const disabled = since !== undefined && Date.now() - since < SCHEDULER_DISABLED_MEMORY_MS;
  // 기억이 끝나는 순간 한 번 다시 그린다: 그때까지 아무도 이 훅을 다시 그리게 하지 않을 수 있다.
  useEffect(() => {
    if (!disabled || since === undefined) return;
    const wait = Math.max(since + SCHEDULER_DISABLED_MEMORY_MS - Date.now(), 0) + 1;
    const id = setTimeout(notifyDisabled, wait);
    return () => clearTimeout(id);
  }, [disabled, since]);
  return disabled;
}

/** 시험이 세션 사이를 넘어가지 않게 한다. */
export function resetSchedulerDisabledForTest(): void {
  disabledSince.clear();
  notifyDisabled();
}

/** 쓰기가 503 `scheduler_disabled`로 거절됐으면 그 사실을 적는다(5분 동안 믿는다). 던진 오류는 그대로 다시 던진다. */
function noteWriteFailure(workspaceId: string, error: unknown): never {
  if (isSchedulerDisabled(error)) setDisabled(workspaceId, true);
  throw error;
}

// ---- 훅 ----------------------------------------------------------------------------------------

export interface ScheduledMutations {
  create: (input: CreateScheduledInput) => Promise<ScheduledMessage>;
  update: (id: string, patch: ScheduledPatch) => Promise<ScheduledMessage>;
  sendNow: (id: string) => Promise<ScheduledMessage>;
  remove: (id: string) => Promise<void>;
}

export interface ScheduledState {
  /** `unknown`: 아직 첫 목록을 받지 못했다(입구는 있는 서버로 읽어 레이아웃이 움직이지 않게 한다). */
  surface: ScheduledSurface;
  /** 열린 행(`pending` + `failed`). 뼈대 행(이벤트로만 안 행)을 포함한다. */
  rows: readonly ScheduledMessage[];
  /** 아직 한 번도 못 읽었다. */
  isPending: boolean;
  /** 읽기가 장애로 실패했고 가진 데이터가 없다. 있으면 그것을 그대로 보인다. */
  isError: boolean;
  refetch: () => void;
  /** 내 대기 예약 수(한도 판정). */
  pendingCount: number;
  /** 앞선 쓰기가 503 `scheduler_disabled`였다. */
  schedulerDisabled: boolean;
  mutations: ScheduledMutations;
}

/**
 * 이 세션의 예약 목록과 쓰기. 여러 곳(입력창·스레드 입력창·사이드바·배너·목록 화면)이 같은 쿼리를 읽는다.
 * 개인 채널 구독은 훅마다 하나씩 붙지만 구독 자체는 채널당 하나로 공유되고(`attach`가 센다), 같은 이벤트를
 * 여러 번 합쳐도 `rev` 규칙이 두 번째부터 무시한다.
 */
export function useScheduled(): ScheduledState {
  const { workspaceId, session, realtime } = useSession();
  const client = useQueryClient();
  const key = scheduledQueryKey(workspaceId);
  const disabled = useSchedulerDisabled(workspaceId);

  const query = useQuery({
    queryKey: key,
    queryFn: () => loadScheduled(client, key, workspaceId),
    // 「없는 서버」는 세션 동안 다시 묻지 않는다. 있는 서버는 이벤트가 신선하게 지키고, 창으로 돌아올 때와
    // 재접속 때 한 번씩 다시 읽는다.
    staleTime: (q) => (q.state.data?.surface === "absent" ? Infinity : STALE_MS),
    retry: false,
    refetchOnWindowFocus: (q) => q.state.data?.surface !== "absent",
    refetchOnReconnect: (q) => q.state.data?.surface !== "absent",
  });

  const surface: ScheduledSurface = query.data?.surface ?? "unknown";
  const present = surface === "present";

  // 개인 채널 구독. 첫 목록을 받은 뒤에, 있는 서버에만 붙인다(`useMailbox`의 인박스 구독과 같다): 없는 서버에는
  // 붙이지 않고, 붙는 순간 `onResync`가 한 번 더 읽어서 첫 읽기와 구독 사이에 지나간 신호도 메운다.
  const selfId = session.member.id;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!present || !realtime?.subscribeScheduled) return;
    const queryKey = scheduledQueryKey(workspaceId);
    const refresh = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void client.invalidateQueries({ queryKey });
      }, REFETCH_DEBOUNCE_MS);
    };
    const off = realtime.subscribeScheduled(selfId, {
      onEvent: (frame) => {
        if (applyFrameToCache(client, workspaceId, frame)) refresh();
      },
      onResync: refresh,
    });
    return () => {
      off();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [present, realtime, selfId, workspaceId, client]);

  const rows = useMemo<readonly ScheduledMessage[]>(
    () => query.data?.store.rows ?? [],
    [query.data]
  );

  const mutations = useMemo<ScheduledMutations>(() => {
    const queryKey = scheduledQueryKey(workspaceId);
    const write = (next: (store: ScheduledStore) => ScheduledStore) => {
      client.setQueryData<ScheduledCache>(queryKey, (current) => withStore(current, next));
    };
    return {
      create: async (input) => {
        try {
          const row = await createScheduledMessage(workspaceId, input);
          setDisabled(workspaceId, false);
          write((store) => applyScheduledRow(store, row));
          return row;
        } catch (error) {
          return noteWriteFailure(workspaceId, error);
        }
      },
      update: async (id, patch) => {
        try {
          const row = await updateScheduledMessage(workspaceId, id, patch);
          setDisabled(workspaceId, false);
          write((store) => applyScheduledRow(store, row));
          return row;
        } catch (error) {
          return noteWriteFailure(workspaceId, error);
        }
      },
      sendNow: async (id) => {
        try {
          const row = await sendScheduledMessageNow(workspaceId, id);
          setDisabled(workspaceId, false);
          write((store) => applyScheduledRow(store, row));
          return row;
        } catch (error) {
          // 거절(409 + 실패 사유)은 행이 `failed`가 됐다는 뜻이다: 목록을 다시 읽어 구획을 옮긴다.
          void client.invalidateQueries({ queryKey });
          return noteWriteFailure(workspaceId, error);
        }
      },
      remove: async (id) => {
        await deleteScheduledMessage(workspaceId, id);
        write((store) => removeScheduledRow(store, id));
      },
    };
  }, [client, workspaceId]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    surface,
    rows,
    isPending: query.isPending && query.data === undefined,
    isError: query.isError && query.data === undefined,
    refetch,
    pendingCount: scheduledTotals(rows).pending,
    schedulerDisabled: disabled,
    mutations,
  };
}

// ---- 시계 ---------------------------------------------------------------------------------------

/** 「오늘·내일」 말이 자정을 넘기며 낡지 않게 하는 걸음. 마감 경계는 이 걸음과 따로 정확한 시각에 선다. */
const CLOCK_STEP_MS = 60_000;

/**
 * 화면이 쓰는 지금. **마감 경계(`editableUntilMs`·`sendAtMs`)에서 한 번씩 정확히** 바뀌고, 그 밖에는 1분마다
 * 바뀐다(UI 명세 0.6: 열려 있는 대화상자와 목록 행은 경계에서 상태를 바꾼다). 경계가 없으면 1분 걸음만 돈다.
 */
export function useScheduledClock(rows: readonly ScheduledMessage[]): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    const boundary = nextScheduledBoundaryMs(rows, current);
    const wait = boundary === null ? CLOCK_STEP_MS : Math.min(Math.max(boundary - current, 0) + 1, CLOCK_STEP_MS);
    const id = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(id);
  }, [rows, now]);
  return now;
}

// ---- 곳의 이름 ------------------------------------------------------------------------------------

export interface ScheduledPlaceInfo {
  /** 행·배너 머리글에 쓰는 이름. 채널은 이름, DM은 「{이름}과의 대화」, 못 읽으면 「알 수 없는 채널」. */
  label: string;
  /** 필터 문장·대화상자에 쓰는 표기: 채널은 「#이름」. */
  markedLabel: string;
  kind: Channel["kind"] | undefined;
  /** DM 상대가 에이전트다. */
  isAgent: boolean;
  /** DM 상대(아바타를 그린다). 채널·알 수 없는 곳·명부에서 빠진 상대는 `null`이다. */
  peer: RosterMember | null;
  /** 채널 목록에서 찾았다. */
  known: boolean;
  /** 배너 문장의 장소 낱말: 채널·대화·스레드는 호출하는 쪽이 스레드 여부로 고른다. */
  word: PlaceWord;
  /** 오류·실패 사유 문장의 장소 낱말: 채널 또는 대화. */
  errorWord: ErrorPlaceWord;
}

/** 채널 id → 곳의 이름. 채널 목록과 명부가 아직 없으면 「알 수 없는 채널」로 읽는다. */
export function useScheduledPlaces(): (channelId: string) => ScheduledPlaceInfo {
  const { session, workspaceId } = useSession();
  const channelsQuery = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const groups = channelsQuery.groups;
  const selfId = session.member.id;
  return useCallback(
    (channelId: string): ScheduledPlaceInfo => {
      const channel = [...groups.channels, ...groups.dms].find((entry) => uuidEq(entry.id, channelId));
      if (channel === undefined) {
        return {
          label: SCHEDULED_UNKNOWN_CHANNEL_LABEL,
          markedLabel: SCHEDULED_UNKNOWN_CHANNEL_LABEL,
          kind: undefined,
          isAgent: false,
          peer: null,
          known: false,
          word: placeWord({ kind: undefined }),
          errorWord: errorPlaceWord(undefined),
        };
      }
      const parts = channelLabelParts(channel, directory, selfId);
      const isDm = channel.kind === "dm";
      const label = isDm ? dmConversationLabel(parts.text) : parts.text;
      return {
        label,
        markedLabel: isDm ? label : `#${label}`,
        kind: channel.kind,
        isAgent: isDm && parts.isAgent,
        peer: isDm ? dmPeer(channel, directory, selfId) : null,
        known: true,
        word: placeWord({ kind: channel.kind }),
        errorWord: errorPlaceWord(channel.kind),
      };
    },
    [groups, directory, selfId]
  );
}

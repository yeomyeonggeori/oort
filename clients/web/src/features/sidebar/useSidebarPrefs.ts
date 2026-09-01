import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSidebarPrefs,
  putSidebarPrefs,
  sidebarPrefsQueryKey,
} from "@momo/core/features/sidebar/api";
import {
  canCreateSidebarSection,
  createSidebarSection,
  deleteSidebarSection,
  emptySidebarPrefs,
  placeChannelInSection,
  renameSidebarSection,
  sectionIdForChannel,
  sidebarChannelRefCapMessage,
  sidebarChannelRefCount,
  SIDEBAR_CHANNEL_REF_MAX,
  SIDEBAR_PREFS_LOAD_FAILURE,
  SIDEBAR_PREFS_SAVE_FAILURE,
  type SidebarPrefs,
} from "@momo/core/features/sidebar/sidebarSections";

// =============================================================================
// 사이드바 배치의 저장 (ADR-0177 D2 / BT-4 #1932).
//
// 규칙은 **화면이 먼저, 서버가 뒤**다. 섹션을 만들고 채널을 옮기는 것은 사람이
// 목록을 정리하는 동안 연달아 일어나고, 매번 왕복을 기다리면 정리가 아니라 폼
// 제출이 된다. 그래서 편집은 즉시 로컬에 반영되고 PUT 은 `SAVE_DEBOUNCE_MS`
// 뒤에 **마지막 상태 하나만** 나간다(buzz 의 2초 문법과 같은 수).
//
// 그럴 수 있는 이유는 계약이 그렇게 생겼기 때문이다: PUT 은 통째 교체이고
// (패치가 아니라) 이벤트도 없다(D2). 즉 중간 상태를 서버에 보여 줄 이유가 없고,
// 마지막 것만 도착하면 그것이 곧 진실이다. 쓰는 사람도 한 명이라(D1 멤버 소유)
// 경합할 상대가 없다.
//
// ## 실패하면 되돌린다
//
// 저장이 실패하면 로컬 편집을 버리고 서버가 준 마지막 payload 로 돌아간다.
// 남겨 두는 선택지도 있었지만, 그러면 화면은 저장된 것처럼 보이는데 저장되지
// 않은 상태가 되고, 다음 새로고침이 조용히 그것을 지운다 - 화면이 성공을
// 말했다가 나중에 번복하는 것이 이 레포가 #1937 H-1 에서 값을 치른 그 형태다.
// 되돌린 자리에는 문장이 선다(사이드바의 배너), 토스트가 아니라.
//
// ## 빈 값과 「모른다」는 같은 것이 아니다 (design-review #1932 B-1)
//
// 이 훅의 첫 판은 `query.data ?? emptySidebarPrefs()` 로 **읽지 못한 상태를 빈
// payload 로 승격**시켰다. 그 위에서 편집 하나가 나가면 PUT 이 통째 교체이므로
// (D3) 다른 기기에서 만든 섹션 전부와 별표가 말없이 지워졌다. 리뷰 프로브 실측:
// GET 500 → 화면 섹션 0개 · 배너 0개 → 「새 섹션」 한 번 → PUT
// `sections=["리뷰 프로브"] starred=[]`. 5xx 한 번이면 닿는 경로였다.
//
// 그래서 상태가 셋이다(`SidebarPrefsStatus`):
//
//   * `loading` — 부트스트랩이 아직 안 왔다. 편집 문 없음, 쓰기 없음.
//   * `error`   — **한 번도** 못 읽었다. 편집 문 없음, 쓰기 없음, 배너 + 재시도.
//   * `ready`   — 서버 payload 를 손에 들었다. 그때만 쓴다.
//
// 갈림은 `isError` 가 아니라 **`data === undefined`** 다. 한 번 읽은 뒤의 배경
// 재조회 실패는 위험하지 않다 - 서버 진실을 이미 들고 있으므로 그 위에 쓰는 것은
// 통째 교체여도 지울 것이 없다. 위험한 것은 「한 번도 못 읽었다」 하나뿐이다.
//
// 방어는 두 겹이다: 화면이 문을 내밀지 않고(`canEdit`), 훅이 쓰기를 거절한다.
// 문 하나만 닫으면 다음 표면이 그 훅을 부르는 날 같은 구멍이 다시 열린다.
//
// ## 접기는 여기 없다
//
// ADR-0177 D4 - 접힘은 `sidebarSectionPreference.ts` 의 localStorage 가 정본이다.
// =============================================================================

/** buzz `channelSectionsSync` 와 같은 수. 정리하는 손이 멈춘 뒤에야 한 번 나간다. */
export const SIDEBAR_PREFS_SAVE_DEBOUNCE_MS = 2000;

export type SidebarPrefsStatus = "loading" | "error" | "ready";

export interface SidebarPrefsController {
  /** 화면이 그리는 것. 로컬 편집이 있으면 그것, 없으면 서버가 준 것. */
  prefs: SidebarPrefs;
  /** 부트스트랩이 어디까지 왔는가. `ready` 가 아니면 아무것도 쓰지 않는다. */
  status: SidebarPrefsStatus;
  /**
   * 편집 문을 내밀어도 되는가 = `status === "ready"`.
   *
   * 표면이 읽어야 하는 **유일한** 물음이라 별도 필드로 둔다. 첫 판의 `isPending`
   * 은 독스트링만 있고 소비처가 0이었다(리뷰 지적) - 지키지 못한 약속이었다.
   */
  canEdit: boolean;
  /** 상한에 닿지 않았는가(50). `canEdit` 이 거짓이면 이 값은 뜻이 없다. */
  canCreate: boolean;
  /** 저장 실패·상한 초과 문장. 배너가 읽는다. */
  error: string | null;
  /** 부트스트랩을 한 번도 못 읽었을 때의 문장. `error` 와 다른 자리다. */
  loadError: string | null;
  retryLoad: () => void;
  dismissError: () => void;
  createSection: (name: string) => void;
  renameSection: (id: string, name: string) => void;
  deleteSection: (id: string) => void;
  moveChannel: (channelId: string, sectionId: string | null) => void;
  sectionIdFor: (channelId: string) => string | null;
}

export function useSidebarPrefs(workspaceId: string): SidebarPrefsController {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: sidebarPrefsQueryKey(workspaceId),
    queryFn: () => fetchSidebarPrefs(workspaceId),
    // 사이드바는 셸이 살아 있는 내내 마운트돼 있고, 이 표면에는 이벤트가 없다
    // (D2). 창을 다시 볼 때마다 다시 물으면 타 기기의 변경이 그때 도착한다.
    retry: false,
  });

  // 로컬 편집. `null` 이면 서버가 준 것이 곧 화면이다. 편집이 저장되면 다시
  // `null` 로 돌아가 서버가 유일한 정본이 된다 - 두 벌을 오래 들고 있지 않는다.
  const [draft, setDraft] = useState<SidebarPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  // **여기가 B-1 의 자리다.** `query.data` 가 없다는 것은 「섹션이 없다」가 아니라
  // 「모른다」이고, 그 둘을 같은 값으로 접으면 아래 쓰기 경로가 남의 payload 를
  // 빈 것으로 덮는다. 화면은 여전히 빈 사이드바를 그리지만(그릴 것이 없으니), 그
  // 상태에서는 아무것도 쓰지 않는다.
  const knowsServerTruth = query.data !== undefined;
  const status: SidebarPrefsStatus = knowsServerTruth
    ? "ready"
    : query.isError
      ? "error"
      : "loading";
  const server = query.data ?? emptySidebarPrefs();
  const prefs = draft ?? server;

  // 타이머와 「보낼 것」을 ref 로 든다: 렌더마다 새로 잡히면 디바운스가 서지 않고,
  // 언마운트 때 남은 것을 흘려보내려면 최신 payload 가 ref 에 있어야 한다.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SidebarPrefs | null>(null);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const flush = useCallback(
    (next: SidebarPrefs) => {
      const ws = workspaceRef.current;
      pending.current = null;
      void putSidebarPrefs(ws, next)
        .then((saved) => {
          client.setQueryData(sidebarPrefsQueryKey(ws), saved);
          // 그 사이 사람이 또 만졌으면 그 편집이 아직 정본이다. 이 저장이 답한
          // 것은 방금 보낸 것뿐이므로, 새 편집이 없을 때만 서버로 돌아간다.
          setDraft((current) => (current === next ? null : current));
          setError(null);
        })
        .catch(() => {
          // 되돌린다. 서버가 준 마지막 payload 가 다시 화면이 된다.
          setDraft((current) => (current === next ? null : current));
          setError(SIDEBAR_PREFS_SAVE_FAILURE);
        });
    },
    [client]
  );

  const schedule = useCallback(
    (next: SidebarPrefs) => {
      // 두 겹 방어의 안쪽 (B-1). 화면이 문을 닫는 것과 별개로, 서버 진실을 손에
      // 들지 않은 동안에는 이 훅이 쓰기 자체를 거절한다. 조용히 거절하지 않고
      // 문장을 남긴다 - 눌렀는데 아무 일도 없는 컨트롤은 아무 말도 하지 않는다.
      if (!knowsServerTruth) {
        setError(SIDEBAR_PREFS_LOAD_FAILURE);
        return;
      }
      // M-3: 「저장 전에 여기서 먼저 세어 400 을 왕복 없이 막는다」는 약속을
      // 지키는 자리. 적용한 뒤 서버가 거절해 롤백되면, 사람은 무엇이 한계였는지
      // 끝내 듣지 못한다.
      if (sidebarChannelRefCount(next) > SIDEBAR_CHANNEL_REF_MAX) {
        setError(sidebarChannelRefCapMessage());
        return;
      }
      setDraft(next);
      setError(null);
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const payload = pending.current;
        if (payload) flush(payload);
      }, SIDEBAR_PREFS_SAVE_DEBOUNCE_MS);
    },
    [flush, knowsServerTruth]
  );

  // 창을 닫거나 워크스페이스를 갈아타는 것이 방금 만든 섹션을 삼키지 않게, 남은
  // 것을 즉시 흘려보낸다. 마운트 시점의 함수만 쓰므로 의존성은 비어 있다.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      const payload = pending.current;
      if (payload) flush(payload);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const createSection = useCallback(
    (name: string) => schedule(createSidebarSection(prefs, name)),
    [prefs, schedule]
  );
  const renameSection = useCallback(
    (id: string, name: string) => schedule(renameSidebarSection(prefs, id, name)),
    [prefs, schedule]
  );
  const deleteSection = useCallback(
    (id: string) => schedule(deleteSidebarSection(prefs, id)),
    [prefs, schedule]
  );
  const moveChannel = useCallback(
    (channelId: string, sectionId: string | null) =>
      schedule(placeChannelInSection(prefs, channelId, sectionId)),
    [prefs, schedule]
  );
  const sectionIdFor = useCallback(
    (channelId: string) => sectionIdForChannel(prefs, channelId),
    [prefs]
  );

  const refetch = query.refetch;
  const retryLoad = useCallback(() => {
    void refetch();
  }, [refetch]);

  return useMemo(
    () => ({
      prefs,
      status,
      canEdit: status === "ready",
      canCreate: canCreateSidebarSection(prefs),
      error,
      loadError: status === "error" ? SIDEBAR_PREFS_LOAD_FAILURE : null,
      retryLoad,
      dismissError: () => setError(null),
      createSection,
      renameSection,
      deleteSection,
      moveChannel,
      sectionIdFor,
    }),
    [
      prefs,
      status,
      error,
      retryLoad,
      createSection,
      renameSection,
      deleteSection,
      moveChannel,
      sectionIdFor,
    ]
  );
}

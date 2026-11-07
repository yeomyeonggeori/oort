import {
  applyExpressionList,
  emptyExpressionCache,
  isNextExpressionVersion,
} from '@momo/core/features/expressions/cache';
import {
  createExpressionNoticeGate,
  type ExpressionNoticeVerdict,
} from '@momo/core/features/expressions/changeNotice';
import {matchesExpressionContract} from '@momo/core/features/expressions/contracts';
import {loopForever} from '@momo/core/features/expressions/gifLoop';
import {
  errorCodeOf,
  photoModelRequest,
  readPhotoDraftResult,
  readPhotoModel,
  type PhotoDraftResult,
  type PhotoModel,
} from '@momo/core/features/expressions/photo';
import type {
  Expression,
  ExpressionAddPolicy,
  ExpressionChangedDetail,
  ExpressionDraft,
  ExpressionList,
  ExpressionMedia,
  ExpressionMutation,
  ExpressionVariant,
} from '@momo/core/features/expressions/types';
import type {ExpressionRequest, ExpressionTransport} from './transport';
import {
  emptyExpressionUsage,
  recordExpressionUse,
  restoreExpressionUsage,
  type ExpressionUsage,
} from '@momo/core/features/expressions/usage';
import {tokenizeExpressions} from '@momo/core/features/expressions/message';

/**
 * 서버가 사진 길에서 답한 상태와 닫힌 `error.code`(있으면). 그 밖의 글 — 공급자가 쓴 말이 섞일 수 있는 본문 —
 * 은 싣지 않는다. 웹 transport 의 `ExpressionHttpError` 와 같은 모양이라 화면이 같은 코어 판정
 * (`photoFailureOf`)에 그대로 넣는다.
 */
export class ExpressionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(String(status));
  }
}

/** 답이 성공이 아닐 때: 상태와 닫힌 코드만 꺼낸다(코어 `errorCodeOf` 가 모양을 확인한다). */
function httpErrorOf(response: {status: number; json?: unknown}) {
  return new ExpressionHttpError(
    response.status,
    errorCodeOf(JSON.stringify(response.json ?? null)),
  );
}

/** 처음 읽는 동안(loading)만 마지막으로 읽은 목록으로 그린다 — 끊김·오류·세션 끝은 닫힌 채로 둔다. 상태 이름은 표의 키다(직접 문구 장부를 늘리지 않는다). */
const SHELF_FROM_LAST: Record<ExpressionSnapshot['state'], boolean> = {
  loading: true,
  ready: false,
  error: false,
  offline: false,
};
/** 목록 응답의 계약 이름과 「쓸 수 있는 등록」 판정 — 아래 여러 곳이 같은 낱말을 쓴다. */
const LIST_CONTRACT = 'List';
const isActive = (item: Expression) => item.status === 'active';
/** 기기에 남기는 보관함의 형식 번호. 1(전체 등록을 그대로)은 읽지 않고 지운다(#5473). */
const SHELF_FORMAT = 2;
/**
 * 기기에 남기지 않은 필드의 **빈 값**. 읽어 되살린 등록은 `Expression` 모양이어야(같은 계약 검사·같은 소비자) 하지만 이 필드들은 그리는 데 쓰이지 않는다
 * (`expressionAltText` 가 `tags[0]` 을 읽으므로 `tags` 는 빈 배열이다). 출처 종류 낱말은 표의 키에서 꺼낸다(직접 문구 장부를 늘리지 않는다).
 */
const [BLANK_ORIGIN_KIND] = Object.keys({upload: 0}) as Array<
  Expression['origin']['kind']
>;
const blankTrace = () => ({
  version: '0',
  tags: [] as string[],
  subjectMemberId: null,
  origin: {kind: BLANK_ORIGIN_KIND, sourceUrl: null, prompt: null},
  createdBy: '00000000-0000-4000-8000-000000000000',
  createdAtMs: 0,
});

export interface ExpressionFiles {
  write(key: string, bytes: Uint8Array): string;
  remove(uri: string): void;
}
/**
 * 기기에 남기는 **마지막 보관함**(이름 → 그림 크기, #5451). 대화가 열리는 순간 보관함이 아직 안 왔어도 `:이름:` 을 글로 먼저 그렸다가 큰 그림으로
 * 바꾸지 않으려는 것이다. 읽기·쓰기는 동기다(MMKV). 읽을 때 워크스페이스·멤버와 목록 계약 검사를 지난 것만 받는다.
 */
export interface ExpressionShelfStorage {
  read(): unknown;
  write(value: PersistedShelf): void;
  clear(): void;
}
/**
 * 기기에 남기는 한 등록 — **그리는 데 필요한 것만**(#5473 L-5451-2): id·이름·표시 이름·상태·종류·그림 정보(치수·해시·형식 …).
 * 프롬프트·출처 주소·만든 사람·대상 멤버·태그는 남기지 않는다(`origin`·`createdBy`·`subjectMemberId`·`tags`).
 */
export interface PersistedShelfItem {
  id: string;
  name: string;
  displayName: string;
  status: Expression['status'];
  kind?: Expression['kind'];
  media: ExpressionMedia;
}
export interface PersistedShelf {
  v: typeof SHELF_FORMAT;
  memberId: string;
  workspaceId: string;
  items: PersistedShelfItem[];
}
export interface ExpressionSnapshot {
  items: readonly Expression[];
  /**
   * 대화 줄(본문 토큰·반응 칩)이 **그리는** 표현 목록. `items` 는 서버가 확인한 목록(고르개·보내기가 쓴다)이고, 이것은 그리기 전용이다:
   *   · 읽은 목록이 있을 때(`ready`) = `items`
   *   · 처음 읽는 중(`loading`) = 마지막으로 읽은 목록(기기에 남긴 것 포함) — 그림 칸이 첫 프레임부터 선다. 그림 파일은 목록이 확인된 뒤에야 받는다.
   *   · 끊김·오류(`offline`·`error`)·세션 끝 = 비어 있다(닫힌 채로 — 숨김·삭제를 확인할 수 없는 동안 낡은 목록으로 그리지 않는다).
   */
  shelf: readonly Expression[];
  state: 'loading' | 'ready' | 'error' | 'offline';
  revision: number;
  /**
   * 숨김·삭제 알림(`changed()`)이 왔고 그 뒤 목록이 **아직 적용되지 않았다**(#5473 M-5451-1). 이 동안 숨긴 등록이 어느 것인지 모르므로 화면은 그림 층을
   * 그리지 않고 칸만 둔다(칸 크기는 그대로라 줄이 뛰지 않는다). 목록이 적용되면(또는 닫히면) 내려간다. 없으면 거짓이다.
   */
  changePending?: boolean;
  usage?: ExpressionUsage;
  /** 누가 새 그림을 올릴 수 있는가. 서버가 준 값이고, 목록을 받기 전에는 모른다. */
  addPolicy?: ExpressionAddPolicy;
}

/** Owns metadata, pending downloads and temporary files for one signed-in scope. */
export function createPhoneExpressionStore(
  workspaceId: string,
  memberId: string,
  transport: ExpressionTransport,
  files: ExpressionFiles,
  storage?: {read(): unknown; write(value: ExpressionUsage): void},
  shelfStorage?: ExpressionShelfStorage,
) {
  const emptyItems: readonly Expression[] = [];
  // 기기에 남은 한 등록을 `Expression` 모양으로 되살린다. 남기지 않은 필드는 빈 값이고, 남은 필드만 하나씩 골라 옮긴다(저장값의 다른 필드는 따라오지 않는다).
  const reviveItem = (item: PersistedShelfItem): Expression => ({
    ...blankTrace(),
    workspaceId,
    id: item.id,
    name: item.name,
    displayName: item.displayName,
    status: item.status,
    media: item.media,
    ...(item.kind === undefined ? {} : {kind: item.kind}),
  });
  // 마지막으로 읽은(또는 기기에 남은) 목록 — 다른 워크스페이스·멤버의 것이나 계약에 안 맞는 것은 받지 않는다.
  const restoreShelf = (): readonly Expression[] => {
    if (!shelfStorage) return emptyItems;
    try {
      // 낱말이 아닌 값(글자·숫자·null)은 `?.` 가 `undefined` 로 받아 아래에서 걸러진다.
      const value = shelfStorage.read() as PersistedShelf | null;
      if (value?.v !== SHELF_FORMAT) {
        // 옛 형식(전체 등록 — 프롬프트·출처 주소·만든 사람이 들어 있다)이나 모르는 값은 쓰지 않고 곧바로 지운다(#5473).
        if (value !== null && value !== undefined) shelfStorage.clear();
        return emptyItems;
      }
      if (value.memberId !== memberId || value.workspaceId !== workspaceId)
        return emptyItems;
      // 되살린 목록을 전체 목록 계약에 그대로 대어 본다 — 그림 정보(해시·치수·형식)와 이름·종류의 모양이 예전과 같은 검사를 지난다.
      const list: ExpressionList = {
        workspaceId,
        version: '0',
        baseVersion: null,
        reset: true,
        addPolicy: emptyExpressionCache(workspaceId, memberId).addPolicy,
        items: value.items.map(reviveItem),
      };
      if (!matchesExpressionContract(LIST_CONTRACT, list)) return emptyItems;
      const active = list.items.filter(
        item => isActive(item) && item.media !== null,
      );
      return active.length > 0 ? active : emptyItems;
    } catch {
      return emptyItems;
    }
  };
  let lastKnown: readonly Expression[] = restoreShelf();
  let shelfVersion: string | null = null;
  let cache = emptyExpressionCache(workspaceId, memberId);
  let usage = storage
    ? restoreExpressionUsage(storage.read(), workspaceId, memberId)
    : emptyExpressionUsage(workspaceId, memberId);
  // 처음 스냅샷에도 기기의 사용 기록이 실린다(#5503): 목록이 오기 전에 창을 열면 창이 이 기록을 열 때 쥐므로, 첫 `publish` 전에 비어 있으면 그 창의 「자주·최근」 칸이 끝내 서지 않는다.
  let snapshot: ExpressionSnapshot = {
    items: emptyItems,
    shelf: lastKnown,
    state: 'loading',
    revision: 0,
    usage,
  };
  // 그림 받기의 판. 전체 걷기·「어느 등록인지 모르는」 알림이 올리면 그전에 시작한 받기는 버려진다(`image()`).
  let epoch = 0;
  // 목록 읽기의 판. 걷기·알림이 올리면 더 앞서 시작한 읽기의 답은 버려진다 — 낡은 목록이 내린 등록을 되살리지 못한다.
  let readGen = 0;
  // 그림 파일이 걷힌 횟수(스냅샷 `revision`). 전체든 일부든 걷으면 오른다.
  let revision = 0;
  // 등록 id 별 걷기 횟수. 숨김·삭제 상세가 그 id 의 받는 중 읽기만 버리게 한다(다른 그림의 받기는 그대로다).
  const idEpochs = new Map<string, number>();
  // 상세 알림과 v1 알림을 같은 version 으로 짝지어 둘째를 건너뛴다(코어 판정, ADR-0218 §15).
  const noticeGate = createExpressionNoticeGate();
  let serial = 0;
  let online = true;
  let disposed = false;
  // 알림(`changed()`)이 왔고 그 뒤 목록이 아직 적용되지 않았다 — 스냅샷으로 나가 화면이 그림 층을 그리지 않게 한다(#5473).
  let changePending = false;
  const receipts = new Set<string>();
  const listeners = new Set<() => void>();
  const images = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  const root = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  const base = `${root}/expressions`;
  // 등록 전 미리보기 파일. 목록 그림(`images`)과 따로 둔다: 변경 알림이 목록 그림을 걷어도 사람이 보고 있는
  // 미리보기를 지우면 안 된다. 화면이 놓을 때(`discardDraftImage`)나 세션이 끝날 때만 지운다.
  const draftFiles = new Set<string>();
  // 읽은 목록을 마지막 보관함으로 삼고 기기에 남긴다(같은 버전이면 다시 쓰지 않는다 — 목록이 클 수 있다).
  const rememberShelf = () => {
    if (cache.version === null || cache.version === shelfVersion) return;
    shelfVersion = cache.version;
    const active = cache.items.filter(
      item => isActive(item) && item.media !== null,
    );
    lastKnown = active.length > 0 ? active : emptyItems;
    try {
      // 기기에는 그리는 데 필요한 것만 남긴다(`PersistedShelfItem`) — 프롬프트·출처 주소·만든 사람·태그는 나가지 않는다.
      shelfStorage?.write({
        v: SHELF_FORMAT,
        memberId,
        workspaceId,
        items: active.map(item => ({
          id: item.id,
          name: item.name,
          displayName: item.displayName,
          status: item.status,
          kind: item.kind,
          media: item.media as ExpressionMedia,
        })),
      });
    } catch {
      // 기기에 못 남겨도 앱 안의 보관함은 그대로다.
    }
  };
  const publish = (state = snapshot.state) => {
    const ready = state === 'ready';
    if (ready) rememberShelf();
    const items = ready && cache.items.length > 0 ? cache.items : emptyItems;
    snapshot = {
      items,
      shelf: ready ? items : SHELF_FROM_LAST[state] ? lastKnown : emptyItems,
      state,
      revision,
      changePending,
      usage,
      addPolicy: cache.addPolicy,
    };
    listeners.forEach(listener => listener());
  };
  /** 그림 파일을 전부 걷고 받는 중 읽기·목록 읽기도 버린다(끊김·오류·세션 끝·읽기 실패). */
  const evict = () => {
    epoch += 1;
    readGen += 1;
    revision += 1;
    for (const uri of images.values()) files.remove(uri);
    images.clear();
    pending.clear();
  };
  const idOfKey = (key: string) => key.slice(0, key.indexOf('/'));
  /**
   * 이 id 들의 그림만 걷는다: 파일·받는 중 읽기(그 id 의 것만 — 다른 그림의 받기는 이어진다)·이전에 시작한 목록 읽기. 목록이 알려 준
   * `evictImageIds`(지워졌거나 그림이 바뀐 등록)와 숨김·삭제 상세가 이 길을 쓴다(ADR-0218 §15 P5).
   */
  const evictIds = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    readGen += 1;
    revision += 1;
    const gone = new Set(ids);
    for (const id of gone) idEpochs.set(id, (idEpochs.get(id) ?? 0) + 1);
    for (const [key, uri] of images) {
      if (!gone.has(idOfKey(key))) continue;
      files.remove(uri);
      images.delete(key);
    }
    for (const key of [...pending.keys()]) {
      if (gone.has(idOfKey(key))) pending.delete(key);
    }
  };
  /**
   * 목록을 읽는다. **이미 읽은 목록이 있으면 읽는 동안에도 그대로 보인다**(#5330): 앞 판은 앞서 비우고 `loading` 을 내보내서
   * 앱이 앞으로 돌아올 때·연결이 다시 이어질 때·변경 알림이 올 때마다 모든 탭이 「불러오는 중이에요」로 바뀌었다. 지금은
   * 읽은 목록(`cache`)이 곧 캐시이고, 답이 오면 한 번에 바꿔 끼운다(코어 `applyExpressionList` — 전체 읽기는 `reset` 목록이라
   * 쌓인 캐시 위에서도 그대로 적용되고, 지워지거나 그림이 바뀐 등록의 id 를 `evictImageIds` 로 돌려준다).
   * 비어 있는 채로 처음 읽을 때(앱을 막 켰을 때·오류 뒤 다시 시도)만 `loading` 이다.
   *
   * 실패는 그대로 닫힌다: 틀린 답·실패는 목록을 비우고 `error` 다. 고르는 순간(`choose`)이 이 상태로 「지금도 있는 표현인가」를
   * 확인하므로, 읽지 못했는데 낡은 목록으로 보내는 일은 없다.
   */
  const refresh = async (full = false, again = true): Promise<void> => {
    if (disposed || !online) return;
    if (cache.version === null && snapshot.state !== 'loading') publish('loading');
    const started = readGen;
    try {
      // 전체 읽기는 `since` 없이 — 서버가 `reset` 목록을 준다. 부분 읽기는 읽은 버전 뒤의 변경만 받는다.
      const since = !full && cache.version !== null ? `?since=${cache.version}` : '';
      const response = await transport.request({
        method: 'GET',
        path: base + since,
      });
      if (disposed || started !== readGen) return;
      if (
        response.status !== 200 ||
        !matchesExpressionContract(LIST_CONTRACT, response.json)
      )
        throw new Error('Expression list unavailable');
      const update = applyExpressionList(
        cache,
        response.json as ExpressionList,
      );
      if (update.needsFullRefresh) {
        if (full) throw new Error('Invalid expression snapshot');
        await refresh(true);
        return;
      }
      if (!update.applied) {
        // 읽은 답이 이미 적용한 목록보다 낡았다. 알림 뒤 목록이 아직 확인되지 않았으면 한 번 더 읽는다 — 그림을 막은 채 멈추지 않게.
        if (changePending && again) {
          await refresh(full, false);
          return;
        }
        // 낡은 답이 두 번 이어졌다: 알림이 어느 등록을 내렸는지 끝내 모른다. 두었던 파일을 그대로 남기지 않고 전부 걷는다(문은 그대로 닫혀 있다).
        if (changePending) evict();
        return;
      }
      // 목록이 알려 준 id 의 그림만 걷는다(지워졌거나 그림이 바뀐 등록) — 나머지는 이미 받은 파일 그대로 다시 선다(다시 받기 없음).
      evictIds(update.evictImageIds);
      cache = update.cache;
      changePending = false;
      publish('ready');
    } catch {
      if (!disposed && started === readGen) {
        evict();
        cache = emptyExpressionCache(workspaceId, memberId);
        changePending = false;
        publish('error');
      }
    }
  };
  /**
   * 알림 하나를 판정(코어 `changeNotice`)대로 처리한다(ADR-0218 §15). 도착 순서·유실에 기대지 않는다: 어느 길이든 숨기거나 지운 그림은 화면에 남지 않는다.
   *   · `revoke-ids` 숨김·삭제 상세: 그 id 의 파일·받는 중 읽기를 걷고 보관함에서 뺀다. 다른 그림은 그대로 두고 목록을 새로 읽는다.
   *   · `keep-all` 등록·고치기·정책 상세: 그리던 그림을 그대로 두고 목록만 새로 읽는다(빈 프레임 0, 다시 받기 0).
   *   · `revoke-all` 상세 없는 알림: 모든 그림 층을 내리고(`changePending`) 받는 중 읽기를 버린다. 파일은 두고, 다음 목록이 알려 주는 id 의 것만 걷는다.
   *   · `already-handled` 같은 version 의 다른 알림이 이미 처리했다. 숨김·삭제 상세는 이것이 아니다 — 앞선 v1 이 이름 없이 처리했어도 그 id 를 그 자리에서 걷는다.
   */
  const applyNotice = (verdict: ExpressionNoticeVerdict) => {
    if (disposed || !online) return;
    switch (verdict.kind) {
      case 'already-handled':
        return;
      case 'keep-all':
        void refresh();
        return;
      case 'revoke-ids': {
        const gone = new Set(verdict.ids);
        evictIds(verdict.ids);
        // 목록이 올 때까지 기다리지 않고 보관함에서 뺀다 — 이 id 의 칸은 지금 글자가 된다(읽기가 앞서 시작했어도 `readGen` 이 그 답을 버린다).
        cache = {...cache, items: cache.items.filter(item => !gone.has(item.id))};
        lastKnown = lastKnown.filter(item => !gone.has(item.id));
        publish();
        void refresh();
        return;
      }
      case 'revoke-all':
        // 다음 목록이 적용될 때까지(`changePending`) 화면은 그림 층을 그리지 않고 칸만 둔다(#5473 M-5451-1). 파일은 걷지 않는다 — 다음 목록이 빠진 id 를 알려 준다는 전제 위에서다:
        // 캐시가 읽지 않은 version 을 건너뛰지 않는다(`mutate` 는 응답이 바로 다음 version 일 때만 델타로 얹는다, H-5491-1).
        changePending = true;
        epoch += 1;
        readGen += 1;
        pending.clear();
        publish();
        void refresh();
    }
  };
  return {
    start() {
      disposed = false;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    refresh,
    recordSuccess(receipt: string, body: string) {
      if (disposed || receipts.has(receipt)) return;
      receipts.add(receipt);
      const ids = new Set(
        tokenizeExpressions(body, cache.items).flatMap(token =>
          token.type === 'expression' ? [token.expression.id] : [],
        ),
      );
      if (ids.size === 0) return;
      for (const id of ids) usage = recordExpressionUse(usage, id, Date.now());
      try { storage?.write(usage); } catch {
        // Device history is optional; a committed send/reaction remains successful.
      }
      publish();
    },
    /**
     * 어느 등록이 바뀌었는지 모르는 알림(`expression.changed`, 앞서 같은 version 의 상세가 오지 않았다): 그림을 즉시 내린다 — 모든 그림 층을 내리고
     * (`changePending`) 받는 중 읽기를 버린다(D3). **파일은 걷지 않는다**: 다음 목록이 `evictImageIds` 로 알려 주는 id 의 것만 걷고 나머지는 이미
     * 받은 파일 그대로 다시 선다(다시 받기 없음). 목록을 못 받으면 전부 걷는다. 이름 목록이 `loading` 으로 비는 일은 없다(#5330).
     * `version` 은 같은 version 의 상세가 먼저 처리됐는지 알아보는 열쇠다(없으면 항상 처리한다).
     */
    changed(version: string | null = null) {
      applyNotice(noticeGate.changed(version));
    },
    /** 상세 알림(`expression.changed.detail`): 숨김·삭제는 그 id 만 내리고, 등록·고치기·정책은 그림을 그대로 둔 채 목록만 새로 읽는다. */
    detailed(detail: ExpressionChangedDetail) {
      applyNotice(noticeGate.detail(detail));
    },
    /** 새로 구독했다(되쏘기 포함): 앞서 본 version 은 그 틈 뒤를 말해 주지 않는다. */
    resetNotices() {
      noticeGate.reset();
    },
    setOnline(value: boolean) {
      if (online === value) return;
      online = value;
      noticeGate.reset();
      evict();
      cache = emptyExpressionCache(workspaceId, memberId);
      changePending = false;
      publish(value ? 'loading' : 'offline');
      if (value) void refresh(true);
    },
    /**
     * 한 표현의 그림 파일. `loop` 는 반응 칩만 켠다(#5504, owner 「계속 움직임」): 움직이는 그림의 반복 횟수(서버는 4번)만 무한으로 바꾼 **따로 쓴 파일**을 준다 -
     * 서버가 준 그림·해시는 그대로이고, 같은 그림의 모든 반응 칩이 이 파일 하나를 나눠 쓴다(받기도 쓰기도 한 번). 메시지 속 그림은 `loop` 없이 서버 그대로의 파일이라 4번 규칙을 지킨다.
     */
    async image(
      item: Pick<Expression, 'id' | 'name'>,
      variant: ExpressionVariant,
      loop = false,
    ): Promise<string | null> {
      const current = cache.items.find(
        entry =>
          entry.id === item.id && entry.name === item.name && isActive(entry),
      );
      // 알림 뒤 목록이 아직 적용되지 않았으면(`changePending`) 두었던 파일도 내주지 않는다 — 어느 등록이 내려갔는지 모르는 동안이다.
      if (
        disposed ||
        !online ||
        changePending ||
        snapshot.state !== 'ready' ||
        !current?.media
      )
        return null;
      const media = current.media[variant];
      const forever = loop && media.mime === 'image/gif';
      const key = `${item.id}/${variant}/${media.sha256}${forever ? '/loop' : ''}`;
      if (images.has(key)) return images.get(key)!;
      if (pending.has(key)) return pending.get(key)!;
      const started = epoch;
      const idStarted = idEpochs.get(item.id) ?? 0;
      const task = (async () => {
        try {
          const response = await transport.request({
            method: 'GET',
            path: `${base}/${encodeURIComponent(
              item.id,
            )}/image?size=${variant}&v=${media.sha256}`,
          });
          // 그 사이 전체 걷기·이 id 의 걷기가 있었으면 받은 것을 파일로 쓰지 않는다.
          if (
            disposed ||
            started !== epoch ||
            (idEpochs.get(item.id) ?? 0) !== idStarted ||
            response.status !== 200
          )
            return null;
          const bytes =
            response.bytes ??
            (response.bodyBase64 === undefined
              ? null
              : Uint8Array.from(atob(response.bodyBase64), char =>
                  char.charCodeAt(0),
                ));
          if (!bytes || bytes.length > media.bytes || bytes.length === 0)
            return null;
          const uri = files.write(
            `${++serial}.${media.mime === 'image/gif' ? 'gif' : 'png'}`,
            forever ? loopForever(bytes) : bytes,
          );
          images.set(key, uri);
          return uri;
        } catch {
          return null;
        } finally {
          if (started === epoch) pending.delete(key);
        }
      })();
      pending.set(key, task);
      return task;
    },
    /** `/v1/workspaces/{id}` — 가져오기가 `…/expressions/import`·`…/expression-drafts/{id}/file` 같은 길을 이어 붙인다. */
    root,
    workspaceId,
    memberId,
    /** 올리기·가져오기·바꿔 올리기: 서버가 준 초안이 계약과 이 워크스페이스에 맞을 때만 돌려준다. */
    async draft(request: ExpressionRequest): Promise<ExpressionDraft> {
      const response = await transport.request(request);
      const value = response.json as ExpressionDraft | undefined;
      if (
        (response.status !== 200 && response.status !== 201) ||
        !matchesExpressionContract('Draft', value) ||
        value?.workspaceId !== workspaceId
      )
        throw new Error('Expression draft unavailable');
      return value;
    },
    /**
     * 팀에 이미지 모델이 연결돼 있는가, 있다면 사진이 어느 회사로 가는가(ADR-0218 §8 H9). 웹 `ExpressionStore.photoModel`
     * 과 같은 약속이다: 성공이 아니면 상태와 닫힌 코드를 실은 오류, 모양이 어긋난 답도 오류다.
     */
    async photoModel(): Promise<PhotoModel> {
      const response = await transport.request(photoModelRequest(root));
      if (response.status !== 200) throw httpErrorOf(response);
      const model = readPhotoModel(response.json);
      // 상태를 아는 어긋난 답: 「연결이 끊겼어요」가 아니라 일반 실패로 읽힌다.
      if (!model) throw new ExpressionHttpError(response.status, undefined);
      return model;
    },
    /**
     * 사진 한 장으로 만든 초안과 서버가 배경에 한 일. 요청은 코어 `photoDraftRequest` 가 만든 것이고, 부르는 쪽이
     * `signal` 을 달아 기다리기를 그만둘 수 있다(서버는 이미 시작한 일을 끝까지 한다).
     */
    async photoDraft(request: ExpressionRequest): Promise<PhotoDraftResult> {
      const response = await transport.request(request);
      if (response.status !== 200 && response.status !== 201) {
        throw httpErrorOf(response);
      }
      const result = readPhotoDraftResult(response.json, workspaceId);
      if (!result) throw new ExpressionHttpError(response.status, undefined);
      return result;
    },
    /**
     * 보고 고른 초안을 등록한다. 돌려받은 그림을 목록에 바로 넣고, 못 맞으면 목록을 다시 받는다. **바로 넣는 것은 응답이 캐시 version 의 바로 다음일 때뿐이다**:
     * 사이에 남의 변경(예: 숨김)이 끼었으면 응답 하나로는 그것을 알 수 없고, 델타로 건너뛴 캐시는 그 등록을 `active` 로 둔 채 앞서 간다 — 뒤따르는 목록 읽기
     * (`since`)는 건너뛴 version 을 다시 알리지 않으므로, 그 숨김의 알림이 상세 없이 오면 두었던 파일이 문이 열릴 때 다시 쓰인다(#5491 검수 1회차 H-5491-1,
     * ADR-0218 §15 P5-4). 그때는 목록으로 다시 읽어 빠진 version 의 숨김이 `evictImageIds` 로 들어오게 한다.
     */
    async mutate(request: ExpressionRequest): Promise<ExpressionMutation> {
      const response = await transport.request(request);
      const result = response.json as ExpressionMutation | undefined;
      if (
        (response.status !== 200 && response.status !== 201) ||
        !matchesExpressionContract('Mutation', result) ||
        result?.workspaceId !== workspaceId
      )
        throw new Error('Expression mutation unavailable');
      const update =
        cache.version !== null &&
        isNextExpressionVersion(cache.version, result.version)
          ? applyExpressionList(cache, {
              workspaceId,
              version: result.version,
              baseVersion: cache.version,
              reset: false,
              addPolicy: cache.addPolicy,
              items: [result.expression],
            })
          : null;
      if (disposed) return result;
      if (!update?.applied) {
        await refresh();
        return result;
      }
      const dropsReading = update.evictImageIds.length > 0;
      evictIds(update.evictImageIds);
      cache = update.cache;
      publish('ready');
      // 위 걷기는 읽고 있던 목록 읽기를 버린다(판이 바뀐다). 알림 뒤 목록이 아직 확인되지 않았다면 다시 읽는다 — 등록 응답은 알림을 확인해 주지 않는다.
      if (dropsReading && changePending) void refresh();
      return result;
    },
    /** 등록 전 미리보기(`large`)를 임시 파일로 받는다. 못 받으면 `null` — 그때는 등록할 수 없다. */
    async draftImage(
      draft: ExpressionDraft,
      variant: ExpressionVariant = 'large',
    ): Promise<string | null> {
      if (disposed || !online || draft.state !== 'ready') return null;
      const media = draft.media[variant];
      try {
        const response = await transport.request({
          method: 'GET',
          path: `${root}/expression-drafts/${encodeURIComponent(
            draft.draftId,
          )}/image?size=${variant}&v=${media.sha256}`,
        });
        if (disposed || response.status !== 200) return null;
        const bytes =
          response.bytes ??
          (response.bodyBase64 === undefined
            ? null
            : Uint8Array.from(atob(response.bodyBase64), char =>
                char.charCodeAt(0),
              ));
        if (!bytes || bytes.length > media.bytes || bytes.length === 0)
          return null;
        const uri = files.write(
          `draft-${++serial}.${media.mime === 'image/gif' ? 'gif' : 'png'}`,
          bytes,
        );
        draftFiles.add(uri);
        return uri;
      } catch {
        return null;
      }
    },
    discardDraftImage(uri: string) {
      if (draftFiles.delete(uri)) files.remove(uri);
    },
    dispose() {
      disposed = true;
      // 세션이 끝났다(로그아웃·워크스페이스 전환): 남겨 둔 보관함도 지운다.
      lastKnown = emptyItems;
      shelfVersion = null;
      try {
        shelfStorage?.clear();
      } catch {
        // 못 지워도 다음 읽기가 계약(워크스페이스·멤버)으로 걸러 낸다.
      }
      for (const uri of draftFiles) files.remove(uri);
      draftFiles.clear();
      evict();
      cache = emptyExpressionCache(workspaceId, memberId);
      changePending = false;
      publish('offline');
      listeners.clear();
    },
  };
}
export type PhoneExpressionStore = ReturnType<
  typeof createPhoneExpressionStore
>;

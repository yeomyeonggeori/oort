import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, AppState, Platform} from 'react-native';

import {PHOTO_CARD} from './photoCardDesign';
import {PHOTO_COPY} from './photoCardCopy';
import {
  canReadPhotos,
  clampSelection,
  PhotoResolveError,
  toggleSelection,
  type PhotoAsset,
  type PhotoLibraryPorts,
  type PhotoPermission,
} from './photoLibrary';
import type {PickedAttachmentFile} from './picker';

// =============================================================================
// 사진 카드의 상태 — 포트 위에서 도는 한 훅 (#4181, ADR-0168 증보 1).
//
// `active` 가 거짓인 동안 이 훅은 **아무것도 부르지 않는다**: 권한 읽기도, 요청도, 목록도.
// 앱 시작·컴포저 마운트·첨부 메뉴 열기에서 권한 API 가 0번 불리는 것(ADR-0168 증보 1 D3)이
// 여기서 나온다 — 훅을 카드가 열린 때에만 `active` 로 건다.
// =============================================================================

export type PhotoCardPermission = PhotoPermission | 'checking';

export type PhotoNotice =
  | {kind: 'capped'; room: number}
  | {kind: 'full'}
  | {kind: 'resolveFailed'}
  | {kind: 'cloudFailed'}
  | {kind: 'partialFailed'; failed: number};

export interface PhotoAttaching {
  done: number;
  total: number;
  /** 지금 처리 중인 한 장이 iCloud 에서 내려오는 중인가. */
  downloading: boolean;
}

export interface PhotoLibraryView {
  permission: PhotoCardPermission;
  /** 「허용」 프롬프트가 떠 있는 동안. */
  requesting: boolean;
  assets: PhotoAsset[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  loadFailed: boolean;
  /** 고른 사진 id, 고른 순서. */
  selected: string[];
  attaching: PhotoAttaching | null;
  notice: PhotoNotice | null;
}

export interface PhotoLibraryActions {
  request(): void;
  openSettings(): void;
  presentLimited(): void;
  loadMore(): void;
  retry(): void;
  toggle(id: string): void;
  attach(): void;
}

const CAP_NOTICE_MS = 2500;
const CHANGE_DEBOUNCE_MS = 250;

/**
 * 낭독 알림. iOS 는 `accessibilityLiveRegion` 이 없어서(안드로이드 전용) 상태 문구가 바뀌어도 읽히지
 * 않는다 — 소리로만 전달되는 사실은 이 길로 알린다.
 */
function announce(sentence: string): void {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(sentence);
}

export function noticeText(notice: PhotoNotice): string {
  switch (notice.kind) {
    case 'capped':
      return PHOTO_COPY.capped(notice.room);
    case 'full':
      return PHOTO_COPY.full;
    case 'resolveFailed':
      return PHOTO_COPY.resolveFailed;
    case 'cloudFailed':
      return PHOTO_COPY.cloudFailed;
    case 'partialFailed':
      return PHOTO_COPY.partialFailed(notice.failed);
  }
}

export function usePhotoLibrary({
  ports,
  active,
  room,
  onAttach,
  onDone,
  initialSelected,
}: {
  ports: PhotoLibraryPorts;
  /** 카드가 열려 있는가. 거짓이면 포트를 전혀 부르지 않는다. */
  active: boolean;
  /** 더 붙일 수 있는 수(`photoRoom(트레이 개수)`). */
  room: number;
  /** 변환이 끝난 파일을 **한 번의 호출로** 넘긴다(`addPickedFiles` 는 일부 거절에 던진다). */
  onAttach: (files: PickedAttachmentFile[]) => void;
  /** 고른 것을 전부 넘겼다 — 카드를 닫아도 된다. */
  onDone: () => void;
  /** 처음 선택(캡처 하네스용). 열려 있는 동안만 산다 — 닫히면 비워진다. */
  initialSelected?: readonly string[];
}): PhotoLibraryView & PhotoLibraryActions {
  const [permission, setPermission] = useState<PhotoCardPermission>('checking');
  const [requesting, setRequesting] = useState(false);
  const [assets, setAssets] = useState<PhotoAsset[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>(() => [...(initialSelected ?? [])]);
  const [attaching, setAttaching] = useState<PhotoAttaching | null>(null);
  const [notice, setNotice] = useState<PhotoNotice | null>(null);

  // 선택한 자산을 id 로 되찾는 표. 목록이 다시 불려도(보관함이 바뀌어도) 이미 고른 사진은
  // 여기서 나온다 — 선택은 「지금 화면에 있는 쪽」이 아니라 사람의 결정이다.
  const catalog = useRef(new Map<string, PhotoAsset>());
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  // 다음 쪽을 부르는 중인 세대. 같은 커서로 두 번 나가지 않게 한다(`onEndReached` 는 연달아 온다).
  const moreInFlight = useRef<number | null>(null);
  const busy = useRef(false);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const callbacks = useRef({onAttach, onDone});
  callbacks.current = {onAttach, onDone};
  const selectedRef = useRef<string[]>([]);
  selectedRef.current = selected;
  const roomRef = useRef(room);
  roomRef.current = room;
  const permissionRef = useRef<PhotoCardPermission>('checking');
  permissionRef.current = permission;

  const say = useCallback((next: PhotoNotice | null) => {
    setNotice(next);
    if (next !== null) announce(noticeText(next));
  }, []);

  // ---- 목록 ----------------------------------------------------------------

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    cursor.current = null;
    setLoading(true);
    setLoadFailed(false);
    try {
      const page = await portsRef.current.listPhotos(null, PHOTO_CARD.pageSize);
      if (mine !== generation.current) return;
      for (const asset of page.assets) catalog.current.set(asset.id, asset);
      cursor.current = page.endCursor;
      setAssets(page.assets);
      setHasMore(page.hasNextPage);
    } catch {
      if (mine !== generation.current) return;
      setAssets([]);
      setHasMore(false);
      setLoadFailed(true);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!canReadPhotos(permissionRef.current as PhotoPermission)) return;
    const mine = generation.current;
    const after = cursor.current;
    if (after === null || moreInFlight.current === mine) return;
    moreInFlight.current = mine;
    setLoadingMore(true);
    try {
      const page = await portsRef.current.listPhotos(after, PHOTO_CARD.pageSize);
      if (mine !== generation.current) return;
      for (const asset of page.assets) catalog.current.set(asset.id, asset);
      cursor.current = page.endCursor;
      setAssets(current => {
        const known = new Set(current.map(asset => asset.id));
        return [...current, ...page.assets.filter(asset => !known.has(asset.id))];
      });
      setHasMore(page.hasNextPage);
    } catch {
      // 커서가 가리키던 자산이 사라졌다(보관함이 바뀌었다). 첫 쪽부터 다시 한다.
      if (mine === generation.current) void loadFirst();
    } finally {
      if (moreInFlight.current === mine) moreInFlight.current = null;
      if (mine === generation.current) setLoadingMore(false);
    }
  }, [loadFirst]);

  // ---- 권한 ----------------------------------------------------------------

  const readPermission = useCallback(async () => {
    try {
      const next = await portsRef.current.getPermission();
      setPermission(next);
    } catch {
      setPermission('denied');
    }
  }, []);

  // 열리면 상태를 **읽는다**(프롬프트 없음). 닫히면 모두 비운다 — 다음에 열 때 보관함도
  // 권한도 달라져 있을 수 있다.
  useEffect(() => {
    if (!active) {
      generation.current += 1;
      catalog.current.clear();
      cursor.current = null;
      busy.current = false;
      setPermission('checking');
      setRequesting(false);
      setAssets([]);
      setHasMore(false);
      setLoading(false);
      setLoadingMore(false);
      setLoadFailed(false);
      setSelected([]);
      setAttaching(null);
      setNotice(null);
      return;
    }
    void readPermission();
  }, [active, readPermission]);

  // 읽을 수 있게 되면 첫 쪽을 부른다.
  useEffect(() => {
    if (active && canReadPhotos(permission as PhotoPermission)) void loadFirst();
  }, [active, permission, loadFirst]);

  // 설정 앱에서 돌아오면 상태가 바뀌어 있을 수 있다.
  useEffect(() => {
    if (!active) return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void readPermission();
    });
    return () => subscription.remove();
  }, [active, readPermission]);

  // 보관함 변경(허용한 사진을 바꾼 것 포함)이 오면 목록과 권한을 다시 읽는다. 연달아 오므로 묶는다.
  useEffect(() => {
    if (!active || !canReadPhotos(permission as PhotoPermission)) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = portsRef.current.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void readPermission();
        void loadFirst();
      }, CHANGE_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [active, permission, readPermission, loadFirst]);

  // 트레이가 다른 경로로 늘어 상한이 줄었다.
  useEffect(() => {
    setSelected(current => {
      const next = clampSelection(current, room);
      return next.length === current.length ? current : next;
    });
  }, [room]);

  // 안내는 일정 시간 뒤에 걷힌다(상한 안내만 — 실패 안내는 다음 행동까지 남는다).
  useEffect(() => {
    if (notice?.kind !== 'capped') return undefined;
    const timer = setTimeout(() => setNotice(null), CAP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // ---- 행동 ----------------------------------------------------------------

  const request = useCallback(() => {
    // 미결정일 때만 묻는다. iOS 는 거부한 앱에 다시 묻지 않으므로 다른 상태의 호출은 헛일이다.
    if (permissionRef.current !== 'undetermined' || busy.current) return;
    busy.current = true;
    setRequesting(true);
    portsRef.current.requestPermission().then(
      next => {
        busy.current = false;
        setRequesting(false);
        setPermission(next);
      },
      () => {
        busy.current = false;
        setRequesting(false);
        void readPermission();
      },
    );
  }, [readPermission]);

  const openSettings = useCallback(() => portsRef.current.openSettings(), []);

  const presentLimited = useCallback(() => {
    void portsRef.current.presentLimitedPicker().catch(() => undefined);
  }, []);

  const retry = useCallback(() => {
    // 사진을 읽을 수 있는 상태에서만 다시 읽는다(닫힘·거부에서의 호출은 헛일이다).
    if (!canReadPhotos(permissionRef.current as PhotoPermission)) return;
    setNotice(null);
    void loadFirst();
  }, [loadFirst]);

  const toggle = useCallback(
    (id: string) => {
      if (attaching !== null) return;
      if (roomRef.current <= 0) {
        say({kind: 'full'});
        return;
      }
      const result = toggleSelection(selectedRef.current, id, roomRef.current);
      setSelected(result.next);
      if (result.blocked) {
        say({kind: 'capped', room: roomRef.current});
      } else {
        setNotice(null);
      }
    },
    [attaching, say],
  );

  const attach = useCallback(async () => {
    const ids = selectedRef.current;
    if (busy.current || ids.length === 0) return;
    busy.current = true;
    setNotice(null);
    const generationAtStart = generation.current;
    const files: PickedAttachmentFile[] = [];
    const doneIds: string[] = [];
    const failedIds: string[] = [];
    let cloud = false;
    setAttaching({done: 0, total: ids.length, downloading: false});
    announce(PHOTO_COPY.preparingStart);
    for (const id of ids) {
      const asset = catalog.current.get(id);
      if (asset === undefined) {
        failedIds.push(id);
        continue;
      }
      try {
        files.push(
          await portsRef.current.resolvePhoto(asset, {
            onDownloading: () => {
              announce(PHOTO_COPY.downloading);
              setAttaching(current =>
                current === null ? current : {...current, downloading: true},
              );
            },
          }),
        );
        doneIds.push(id);
      } catch (error: unknown) {
        failedIds.push(id);
        if (error instanceof PhotoResolveError && error.reason === 'cloud') {
          cloud = true;
        }
      }
      // 카드가 닫혔다(뒤로·화면 이탈). 변환된 파일은 버린다 — 사람이 취소한 것이다.
      if (generationAtStart !== generation.current) return;
      setAttaching({
        done: files.length + failedIds.length,
        total: ids.length,
        downloading: false,
      });
    }
    busy.current = false;
    setAttaching(null);
    // 변환하는 동안 트레이가 다른 길로 차 상한이 줄었을 수 있다. 상한을 넘는 만큼은 넘기지 않고
    // 선택에 남긴다 — `addPickedFiles` 는 일부라도 거절되면 던지므로 넘긴 뒤에 알면 늦다.
    const accepted = Math.min(files.length, roomRef.current);
    const leftIds = [...failedIds, ...doneIds.slice(accepted)];
    if (accepted > 0) {
      try {
        callbacks.current.onAttach(files.slice(0, accepted));
      } catch {
        // 호스트가 거절했다(예: 불변식). 변환 결과는 버리고 선택을 그대로 둔다.
        setSelected(ids);
        say({kind: 'resolveFailed'});
        return;
      }
    }
    setSelected(clampSelection(leftIds, roomRef.current));
    if (leftIds.length === 0) {
      callbacks.current.onDone();
    } else if (accepted === 0 && failedIds.length > 0 && files.length === 0) {
      say({kind: cloud ? 'cloudFailed' : 'resolveFailed'});
    } else if (failedIds.length > 0) {
      say({kind: 'partialFailed', failed: failedIds.length});
    } else {
      say({kind: 'capped', room: roomRef.current});
    }
  }, [say]);

  return {
    permission,
    requesting,
    assets,
    hasMore,
    loading,
    loadingMore,
    loadFailed,
    selected,
    attaching,
    notice,
    request,
    openSettings,
    presentLimited,
    loadMore: () => void loadMore(),
    retry,
    toggle,
    attach: () => void attach(),
  };
}

import {NON_SECRET_KEYS, nonSecretStore} from './kv';

// =============================================================================
// 잰 크기를 **기기에** 기억하는 작은 지도 (#5451).
//
// 대화 행의 미디어(첨부 사진의 가로세로, 링크 카드 묶음의 높이)는 받기 전에는 크기를 모른다. 앞 판은 앱이 사는 동안만 기억해서(메모리), 앱을
// 다시 켠 뒤 들어간 대화는 사진마다 16:9 자리표시로 섰다가 받으면 제 비율로 바뀌었다 — 그 높이 변화가 대화에 들어올 때의 위아래 떨림이다.
// 지도는 **숫자뿐**이다: 키는 서버가 만든 uuid(첨부 id·메시지 id)이고 값은 가로·세로나 높이다. 글·주소·바이트는 없다(비밀이 아니고, 잃으면 한 번
// 더 재면 된다). 같은 값은 쓰지 않고, 쓰기는 한데 모아 한 번에 한다(MMKV 쓰기는 동기라 첫 화면에서 사진 수만큼 쓰면 JS 스레드를 잡는다).
//
// 항목 수는 상한이 있고 오래된 것부터 잊는다. 읽기는 처음 부를 때 한 번 하고(`hydrate`), 못 읽으면 빈 채로 시작한다.
// =============================================================================

export interface MeasureMemory {
  /** 이 id 의 기억한 값. 모르면 `null`. 값이 같으면 **같은 배열**을 돌려준다(구독 비교가 동일성으로 끝난다). */
  get(id: string): readonly number[] | null;
  /** 값을 기억한다. 유한하고 0보다 큰 숫자 `arity` 개만 받는다. 받지 못하면 `null`. */
  set(id: string, value: readonly number[]): readonly number[] | null;
  delete(id: string): void;
  /** 바뀔 때마다 부른다(해제 함수를 돌려준다). */
  subscribe(listener: () => void): () => void;
  /** 메모리와 저장된 것을 모두 비우고 쓰기 시계도 멈춘다(로그아웃, #5473). */
  clear(): void;
  /** 시험: `clear()` 와 같다. */
  clearForTest(): void;
}

/** 쓰기를 모으는 시간(ms). */
export const MEASURE_FLUSH_MS = 600;

export function createMeasureMemory(options: {
  key: string;
  limit: number;
  arity: number;
}): MeasureMemory {
  const map = new Map<string, readonly number[]>();
  const listeners = new Set<() => void>();
  let hydrated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // `Number.isFinite` 는 숫자가 아닌 값(글자 포함)을 거짓으로 답한다(바꿔 읽지 않는다).
  const valid = (value: unknown): value is number =>
    Number.isFinite(value) && (value as number) > 0;

  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;
    try {
      const raw = nonSecretStore().getString(options.key);
      if (raw === undefined) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed as unknown[]) {
        if (!Array.isArray(entry) || entry.length !== options.arity + 1) continue;
        const [id, ...values] = entry as unknown[];
        if (id !== String(id) || !values.every(valid)) continue;
        map.set(id as string, values as number[]);
      }
      while (map.size > options.limit) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    } catch {
      // 못 읽으면 빈 채로 시작한다 — 한 번 더 재면 되는 값이다.
    }
  };
  const flush = () => {
    timer = null;
    try {
      nonSecretStore().set(
        options.key,
        JSON.stringify([...map].map(([id, value]) => [id, ...value])),
      );
    } catch {
      // 못 써도 앱 안의 지도는 그대로다.
    }
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, MEASURE_FLUSH_MS);
  };
  const notify = () => listeners.forEach(listener => listener());
  const clear = () => {
    map.clear();
    hydrated = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      nonSecretStore().remove(options.key);
    } catch {
      // 저장소가 없으면(시험) 건너뛴다.
    }
    notify();
  };

  return {
    get(id) {
      hydrate();
      return map.get(id) ?? null;
    },
    set(id, value) {
      hydrate();
      if (value.length !== options.arity || !value.every(valid)) return null;
      const earlier = map.get(id);
      if (earlier !== undefined && earlier.every((v, i) => v === value[i])) {
        return earlier;
      }
      const stored = [...value];
      map.delete(id);
      map.set(id, stored);
      while (map.size > options.limit) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
      schedule();
      notify();
      return stored;
    },
    delete(id) {
      hydrate();
      if (!map.delete(id)) return;
      schedule();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear,
    clearForTest: clear,
  };
}

/** 첨부 사진·GIF 의 가로세로(pt 가 아니라 그림의 픽셀): 첨부 id → [가로, 세로]. */
export const attachmentSizeMemory = createMeasureMemory({
  key: NON_SECRET_KEYS.attachmentSizes,
  limit: 500,
  arity: 2,
});

/** 링크 카드 묶음의 높이(pt): 메시지 id → [높이]. 글·주소는 기억하지 않는다. */
export const unfurlHeightMemory = createMeasureMemory({
  key: NON_SECRET_KEYS.unfurlHeights,
  limit: 300,
  arity: 1,
});

/**
 * 로그아웃: 잰 크기 지도 둘(첨부 id → 가로세로, 메시지 id → 카드 높이)을 메모리와 기기에서 모두 지운다(#5473 L-5451-3). 숫자뿐이라 비밀은 아니지만 계정
 * 구분이 없고, 「로그아웃은 이 기기에서 내 흔적을 지운다」(`session/useSession.tsx`)는 원칙이 같다.
 */
export function forgetMeasuredSizes(): void {
  attachmentSizeMemory.clear();
  unfurlHeightMemory.clear();
}

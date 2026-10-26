import type { DownloadsDeps, StorageLike } from "./downloadsStore";

// 다운로드 스토어·단추 시험이 함께 쓰는 가짜 의존. 시험 전용이다(앱 코드는 이 파일을 읽지 않는다).
// 가짜는 일을 하지 않고 **기록하고 시험이 끝내 준다**: 받기는 열린 약속이라 시험이 진행을 알리고
// resolve·reject로 끝낸다. 그래서 순서(받기 → 저장 → 기록)와 간격이 시험 안에서 결정적이다.

export const SOURCE = { workspaceId: "ws-dalmuri", channelId: "ch-design", attachmentId: "att-budget" };
export const ATTACHMENT = {
  id: "att-budget",
  name: "2분기 예산안.pdf",
  mime: "application/pdf",
  sizeBytes: 1000,
};

export function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

export interface Fake {
  deps: DownloadsDeps;
  storage: ReturnType<typeof memoryStorage>;
  /** fetchBytes의 열린 요청. 시험이 진행을 알리고 끝낸다. */
  fetches: Array<{
    source: typeof SOURCE;
    progress: (loaded: number, total: number | null) => void;
    resolve: (bytes: Uint8Array) => void;
    reject: (error: unknown) => void;
  }>;
  saves: Array<{ bytes: Uint8Array; name: string }>;
  saveAnswer: { fileName: string } | Error;
  /** null이면 물은 파일이 모두 있다고 답한다. */
  probeAnswer: boolean[] | Error | null;
  reveals: string[];
  opens: string[];
  rowError: Error | null;
  folderError: Error | null;
  clock: { now: number };
  ids: number;
}

export function fake(initialStorage: Record<string, string> = {}): Fake {
  const state: Fake = {
    storage: memoryStorage(initialStorage),
    fetches: [],
    saves: [],
    saveAnswer: { fileName: "2분기 예산안.pdf" },
    probeAnswer: null,
    reveals: [],
    opens: [],
    rowError: null,
    folderError: null,
    clock: { now: 10_000 },
    ids: 0,
    deps: undefined as unknown as DownloadsDeps,
  };
  state.deps = {
    now: () => state.clock.now,
    newId: () => `dl-${++state.ids}`,
    fetchBytes: (source, progress) =>
      new Promise<Uint8Array>((resolve, reject) => {
        state.fetches.push({ source, progress, resolve, reject });
      }),
    save: async (bytes, name) => {
      state.saves.push({ bytes, name });
      if (state.saveAnswer instanceof Error) throw state.saveAnswer;
      return state.saveAnswer;
    },
    probe: async (names) => {
      if (state.probeAnswer instanceof Error) throw state.probeAnswer;
      return state.probeAnswer ?? names.map(() => true);
    },
    reveal: async (fileName) => {
      state.reveals.push(fileName);
      if (state.rowError !== null) throw state.rowError;
    },
    open: async (fileName) => {
      state.opens.push(fileName);
      if (state.rowError !== null) throw state.rowError;
    },
    openFolder: async () => {
      if (state.folderError !== null) throw state.folderError;
    },
    storage: state.storage,
  };
  return state;
}

export const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

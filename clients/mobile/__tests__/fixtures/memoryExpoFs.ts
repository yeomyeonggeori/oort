// 시험 도구: `expo-file-system`(v57 새 API: `File`·`Directory`·`Paths`)의 메모리 구현. 보관 칸의 진짜 파일 백엔드(`disk/fileBackend.ts`)를 이 위에서 돌린다.
// 전역 목(`jest.setup.js`)은 다운로드·업로드용이라 `write`·`bytes`·`moveSync` 가 없다 — 이 파일은 백엔드가 쓰는 동작만, **진짜와 같은 규칙**으로 흉내 낸다:
//   · 디렉터리 주소는 `/` 로 끝나고 파일 주소는 아니다. `list()` 는 직속 항목만 돌려준다(하위 폴더는 `Directory`).
//   · `File.write` 는 부모 폴더가 없으면 던진다(없는 폴더에 쓰는 실수를 시험이 잡는다). 문자열은 UTF-8 바이트다.
//   · `File.size` 는 없는 파일에서 0 이다. `moveSync` 는 덮어쓰기 옵션이 없으면 도착지가 있을 때 던지고, 움직인 뒤 그 객체의 `uri` 가 새 주소다.
//   · `Directory.delete()` 는 안의 모든 것을 지운다. `Directory.create` 는 `idempotent` 가 아니면 이미 있을 때 던지고, `intermediates` 가 아니면 부모가 없을 때 던진다.
// 사용: `jest.mock('expo-file-system', () => jest.requireActual('./fixtures/memoryExpoFs').createMemoryExpoFs())` 한 줄, 상태는 `jest.requireMock('expo-file-system').__fs`.

export interface MemoryFsState {
  files: Map<string, {bytes: Uint8Array; modified: number}>;
  dirs: Set<string>;
  /** `lastModified` 에 쓰이는 시계. */
  clock: {now: number};
  /** 다음 `moveSync` 를 이 오류로 던진다(원자적 쓰기 시험). */
  failMoveOnce: Error | null;
  /** 다음 `write` 가 앞에서 이만큼의 바이트만 쓰고 끝난다(짧게 쓰인 파일). */
  shortWriteOnce: number | null;
  /** 이 이름이 든 주소의 `write` 는 항상 던진다(디스크 가득 참). */
  failWriteMatching: string | null;
  reset(): void;
}

const ROOT = 'file:///cache/';

function normalize(parts: unknown[]): {uri: string; trailing: boolean} {
  const segments: string[] = [];
  let trailing = false;
  for (const part of parts) {
    const text = typeof part === 'string' ? part : String((part as {uri: string}).uri);
    trailing = text.endsWith('/');
    const trimmed = text.replace(/\/+$/, '');
    segments.push(segments.length === 0 ? trimmed : trimmed.replace(/^\/+/, ''));
  }
  return {uri: segments.join('/'), trailing};
}
const dirUri = (uri: string) => `${uri.replace(/\/+$/, '')}/`;
const parentOf = (uri: string) => dirUri(uri.replace(/\/+$/, '').slice(0, uri.replace(/\/+$/, '').lastIndexOf('/')));
const nameOfUri = (uri: string) => {
  const trimmed = uri.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

export function createMemoryExpoFs() {
  const state: MemoryFsState = {
    files: new Map(),
    dirs: new Set([ROOT, 'file:///document/']),
    clock: {now: 1_700_000_000_000},
    failMoveOnce: null,
    shortWriteOnce: null,
    failWriteMatching: null,
    reset() {
      state.files.clear();
      state.dirs.clear();
      state.dirs.add(ROOT);
      state.dirs.add('file:///document/');
      state.clock.now = 1_700_000_000_000;
      state.failMoveOnce = null;
      state.shortWriteOnce = null;
      state.failWriteMatching = null;
    },
  };

  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = dirUri(normalize(parts).uri);
    }
    get name() {
      return nameOfUri(this.uri);
    }
    get exists() {
      return state.dirs.has(this.uri);
    }
    create(options: {intermediates?: boolean; idempotent?: boolean} = {}) {
      if (state.dirs.has(this.uri)) {
        if (options.idempotent) return;
        throw new Error('directory already exists');
      }
      const parent = parentOf(this.uri);
      if (!state.dirs.has(parent)) {
        if (!options.intermediates) throw new Error('parent directory is missing');
        let walk = parent;
        while (!state.dirs.has(walk) && walk.length > 'file:///'.length) {
          state.dirs.add(walk);
          walk = parentOf(walk);
        }
      }
      state.dirs.add(this.uri);
    }
    delete() {
      if (!state.dirs.has(this.uri)) throw new Error('directory does not exist');
      for (const dir of [...state.dirs]) if (dir.startsWith(this.uri)) state.dirs.delete(dir);
      for (const file of [...state.files.keys()]) if (file.startsWith(this.uri)) state.files.delete(file);
    }
    list(): Array<Directory | File> {
      if (!state.dirs.has(this.uri)) throw new Error('directory does not exist');
      const direct = (uri: string) => parentOf(uri) === this.uri;
      return [
        ...[...state.dirs].filter(dir => dir !== this.uri && direct(dir)).map(dir => new Directory(dir)),
        ...[...state.files.keys()].filter(direct).map(file => new File(file)),
      ];
    }
  }

  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = normalize(parts).uri;
    }
    get name() {
      return nameOfUri(this.uri);
    }
    get exists() {
      return state.files.has(this.uri);
    }
    get size() {
      return state.files.get(this.uri)?.bytes.byteLength ?? 0;
    }
    get lastModified() {
      return state.files.get(this.uri)?.modified ?? null;
    }
    get modificationTime() {
      return this.lastModified;
    }
    write(content: string | Uint8Array) {
      if (!state.dirs.has(parentOf(this.uri))) throw new Error('parent directory is missing');
      if (state.failWriteMatching !== null && this.uri.includes(state.failWriteMatching)) {
        throw new Error('no space left on device');
      }
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content);
      const kept = state.shortWriteOnce === null ? bytes : bytes.slice(0, state.shortWriteOnce);
      state.shortWriteOnce = null;
      state.files.set(this.uri, {bytes: kept, modified: state.clock.now});
    }
    async bytes() {
      return this.bytesSync();
    }
    bytesSync() {
      const found = state.files.get(this.uri);
      if (!found) throw new Error('file does not exist');
      return Uint8Array.from(found.bytes);
    }
    textSync() {
      return new TextDecoder().decode(this.bytesSync());
    }
    async text() {
      return this.textSync();
    }
    delete() {
      if (!state.files.has(this.uri)) throw new Error('file does not exist');
      state.files.delete(this.uri);
    }
    moveSync(destination: File | Directory, options: {overwrite?: boolean} = {}) {
      if (state.failMoveOnce !== null) {
        const failure = state.failMoveOnce;
        state.failMoveOnce = null;
        throw failure;
      }
      const found = state.files.get(this.uri);
      if (!found) throw new Error('file does not exist');
      const target = destination instanceof Directory ? new File(destination, nameOfUri(this.uri)).uri : destination.uri;
      if (state.files.has(target) && !options.overwrite) throw new Error('destination exists');
      if (!state.dirs.has(parentOf(target))) throw new Error('parent directory is missing');
      state.files.delete(this.uri);
      state.files.set(target, found);
      this.uri = target;
    }
  }

  return {
    Directory,
    File,
    Paths: {cache: new Directory(ROOT), document: new Directory('file:///document/')},
    UploadType: {BINARY_CONTENT: 0, MULTIPART: 1},
    __fs: state,
  };
}

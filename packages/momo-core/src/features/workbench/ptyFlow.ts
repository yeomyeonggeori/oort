// =============================================================================
// 로컬 PTY 흐름 제어의 순수 부분 (#2774). 데스크탑 셸 계약은
// `clients/desktop/README.md`의 `pty_spawn`·`pty_write`·`pty_ack` 줄이다.
//
// - ack: 셸은 받은 출력 중 ack되지 않은 것이 1 MiB에 이르면 PTY 읽기를 멈춘다.
//   출력 조각마다 ack하면 IPC 왕복이 조각(약 1 KiB)마다 생겨 앱 RSS가 700 MB까지
//   올랐다(#2824 R1 실측). 그래서 64 KiB가 쌓이거나 16 ms가 지나면 한 번에 보낸다.
// - 쓰기: `pty_write` 한 번은 1 MiB까지다. 더 큰 붙여넣기는 잘라 순서대로 보낸다.
//   셸은 부른 순서대로 자식에게 넘기므로(동기 명령) 기다렸다 보낼 필요가 없다.
//   UTF-8 글자 가운데에서 잘려도 바이트는 순서대로 이어 도착하므로 깨지지 않는다.
// =============================================================================

export const PTY_ACK_BATCH_BYTES = 64 * 1024;
export const PTY_ACK_BATCH_MS = 16;
export const PTY_WRITE_MAX_BYTES = 1 << 20;

export interface AckScheduler {
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface AckBatcher {
  /** 칸이 `bytes`만큼 더 그렸다(파싱했다). */
  add: (bytes: number) => void;
  /** 쌓인 것을 지금 보낸다. */
  flush: () => void;
  /** 이후 add는 버린다. 쌓인 것은 보내지 않는다(세션이 끝났다). */
  dispose: () => void;
}

export function createAckBatcher(
  send: (bytes: number) => void,
  scheduler: AckScheduler,
  options: { batchBytes?: number; batchMs?: number } = {}
): AckBatcher {
  const batchBytes = options.batchBytes ?? PTY_ACK_BATCH_BYTES;
  const batchMs = options.batchMs ?? PTY_ACK_BATCH_MS;
  let pending = 0;
  let timer: unknown = null;
  let disposed = false;

  const flush = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
    if (disposed || pending === 0) return;
    const bytes = pending;
    pending = 0;
    send(bytes);
  };

  return {
    add(bytes) {
      if (disposed || !(bytes > 0)) return;
      pending += bytes;
      if (pending >= batchBytes) {
        flush();
        return;
      }
      if (timer === null) timer = scheduler.schedule(flush, batchMs);
    },
    flush,
    dispose() {
      disposed = true;
      if (timer !== null) scheduler.cancel(timer);
      timer = null;
      pending = 0;
    },
  };
}

/** `bytes`를 `max` 바이트 이하 조각들로 자른다. 빈 입력은 빈 목록. */
export function chunkBytes(bytes: Uint8Array, max: number = PTY_WRITE_MAX_BYTES): Uint8Array[] {
  if (!(max > 0)) throw new RangeError("max must be positive");
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += max) {
    out.push(bytes.subarray(offset, Math.min(bytes.length, offset + max)));
  }
  return out;
}

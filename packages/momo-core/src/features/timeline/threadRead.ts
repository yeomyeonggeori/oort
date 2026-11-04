import { ApiError, type ThreadReadState } from "../../lib/api";

// =============================================================================
// 스레드를 열어 둔 화면이 「여기까지 읽었어요」를 보내는 규칙 (#4878, #4889 2단계).
//
// `PUT …/messages/{root}/read` 가 읽은 위치를 옮기는 **유일한 길**이다(`GET …/replies` 는 인박스·작업 패널도
// 부르는 읽기라 읽음이 아니다). 그래서 스레드를 보여 주는 두 화면(웹·데스크탑 패널, 폰 스레드 화면)이 열 때와
// 새 답글을 그릴 때 이것을 보내야 「새 답글 M」 칩이 사라진다. 두 화면이 보내는 규칙은 한 곳에 둔다:
//
//   * **앞으로만.** 든 답글의 최대 seq가 보낸 값보다 클 때만 보낸다 — 같은 값을 다시 보내지 않고, 낮은 값은
//     보내지 않는다(서버도 뒤로는 안 간다). 열 때·재그림마다 이 함수를 불러도 네트워크는 오를 때만 나간다.
//   * **404·405 는 「이 서버에 기능이 없다」다**(옛 서버, 4889 계약). 그 뒤로는 이 보내는 이가 더 보내지 않는다.
//     그 밖의 오류(네트워크·5xx·403)는 삼킨다 — 읽음은 보조 신호라 스레드 읽기를 막으면 안 되고, 다음에 seq가
//     오르거나 다시 열 때 다시 보낸다(실패한 seq는 「보냄」으로 치지 않는다).
//   * **옛 응답이 새 응답을 덮지 않는다.** 5를 보내고 7을 보냈는데 5의 응답이 늦게 오면 그 응답은 버린다.
// =============================================================================

export interface ThreadReadSender {
  /** 화면이 든 답글의 최대 seq(`readSignalSeq`). 답글이 없으면 `null` — 보낼 것이 없다. */
  note(rootId: string, headSeq: number | null): void;
}

export function createThreadReadSender(options: {
  send: (rootId: string, lastReadReplySeq: number) => Promise<ThreadReadState>;
  onState: (rootId: string, state: ThreadReadState) => void;
}): ThreadReadSender {
  const sent = new Map<string, number>();
  let unsupported = false;
  return {
    note(rootId, headSeq) {
      if (unsupported || headSeq === null) return;
      const key = rootId.toLowerCase();
      const previous = sent.get(key);
      if (previous !== undefined && headSeq <= previous) return;
      sent.set(key, headSeq);
      // `then(a, b)` 두 갈래다: `onState`가 던져도(화면 반영의 실패) 그것은 신호의 실패가 아니라서 되돌리지 않는다.
      options.send(rootId, headSeq).then(
        (state) => {
          // 더 높은 값을 이미 보냈으면 그쪽 응답이 맞는 값이다.
          if (sent.get(key) !== headSeq) return;
          try {
            options.onState(rootId, state);
          } catch {
            /* 반영 실패는 삼킨다: 다음 신호나 기록 읽기가 값을 맞춘다. */
          }
        },
        (error: unknown) => {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
            unsupported = true;
            return;
          }
          // 실패한 seq는 보낸 것이 아니다: 되돌려 다음 신호가 다시 시도하게 한다.
          if (sent.get(key) === headSeq) {
            if (previous === undefined) sent.delete(key);
            else sent.set(key, previous);
          }
        }
      );
    },
  };
}

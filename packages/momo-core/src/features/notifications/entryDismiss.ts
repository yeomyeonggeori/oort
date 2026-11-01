// =============================================================================
// 알림으로 들어올 때 겹친 임시 표면을 걷는 신호 하나 (#4667, 테스터 피드백 B5·B6).
//
// 알림은 **새 입구**다. 사람은 지금 열려 있던 설정·시트·서랍·대화상자에서 그 메시지로 온
// 것이 아니라 잠금 화면이나 배너에서 왔다. 그 표면들이 그대로 떠 있으면 알림을 눌렀는데
// 메시지는 안 보이고, 닫아야 비로소 보인다.
//
// 표면의 상태는 한곳에 있지 않다 — 항법 층은 리듀서에, 시트·뷰어·대화상자는 그것을 연
// 컴포넌트의 지역 상태에 있다. 입구가 그 모두의 닫는 함수를 알 수는 없으므로 **방송 하나**로
// 뒤집는다: 알림 입구가 `dismissTemporarySurfaces()` 를 한 번 부르고, 임시 표면은 자기가
// 열려 있는 동안 `onEntryDismiss` 로 구독해 **자기 닫는 길**로 닫는다.
//
// 이 모듈은 플랫폼을 모른다. 폰은 `useDismissOnEntry`(`clients/mobile/src/lib`), 웹은 같은 이름의
// 훅(`clients/web/src/lib`)으로 구독한다. 두 클라이언트가 같은 규칙을 같은 코드로 쓰는 것이 이
// 파일이 코어에 있는 이유다.
//
// ## 맡기는 쪽이 먼저, 닫는 쪽이 나중이다
//
// 글을 쓰던 시트는 닫히기 **전에** 쓰던 글을 맡겨야 한다(`hold`). 닫는 길은 부모의 상태를 바꾸고, 그 변경이 같은 틱에
// 시트를 걷어 가면 뒤늦게 불린 맡기기는 이미 언마운트된 시트의 글을 읽지 못한다. 구독 순서(자식 효과가 부모보다 먼저
// 서므로 닫는 쪽이 먼저 구독된다)에 기대면 그 순서가 어느 날 바뀔 때 글이 조용히 사라진다. 그래서 순서를 구독 순서가
// 아니라 **종류**로 못 박는다: `dismiss()` 는 맡기는 구독자를 모두 부른 뒤에 닫는 구독자를 부른다.
//
// ## 구독자는 서로를 막지 못한다
//
// 구독자 하나가 던져도 나머지는 모두 불린다 — 닫는 길 하나가 깨졌다고 시트가 줄줄이 남으면
// 이 신호의 존재 이유가 사라진다. 던진 것은 삼키지 않고 **다음 틱에 다시 던진다**(전역 오류
// 처리기와 시험이 본다). 부르는 쪽(알림 입구)은 이어서 곧바로 이동해야 하므로 그 호출이 던지게
// 두지 않는다.
// =============================================================================

export type EntryDismissListener = () => void;

export interface EntryDismissBus {
  /** 닫는 쪽으로 구독한다. 돌려주는 함수가 구독을 푼다(두 번 불러도 안전하다). */
  subscribe: (listener: EntryDismissListener) => () => void;
  /** 맡기는 쪽으로 구독한다 — 어느 닫는 구독자보다도 먼저 불린다. 쓰던 글을 맡길 시트가 쓴다. */
  hold: (listener: EntryDismissListener) => () => void;
  /**
   * 구독자 모두에게 「닫아라」를 보낸다. 맡기는 쪽을 먼저, 닫는 쪽을 나중에 — 각각 구독한 순서대로이고, 보낸 시점의
   * 구독자만 받는다.
   */
  dismiss: () => void;
  /** 지금 구독자 수(맡기는 쪽 + 닫는 쪽). 시험과 진단이 읽는다. */
  size: () => number;
}

interface Entry {
  listener: EntryDismissListener;
}

export function createEntryDismissBus(
  rethrow: (error: unknown) => void = (error) => {
    setTimeout(() => {
      throw error;
    }, 0);
  }
): EntryDismissBus {
  // 같은 함수를 두 번 구독해도 구독은 둘이다 — `Set<함수>` 였다면 하나가 풀릴 때 둘 다 풀린다.
  const closers = new Set<Entry>();
  const keepers = new Set<Entry>();
  const join = (set: Set<Entry>) => (listener: EntryDismissListener) => {
    const entry: Entry = { listener };
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  };
  const run = (set: Set<Entry>) => {
    for (const entry of [...set]) {
      // 앞 구독자가 닫으며 풀어 버린 구독은 부르지 않는다.
      if (!set.has(entry)) continue;
      try {
        entry.listener();
      } catch (error) {
        rethrow(error);
      }
    }
  };
  return {
    subscribe: join(closers),
    hold: join(keepers),
    dismiss() {
      run(keepers);
      run(closers);
    },
    size: () => closers.size + keepers.size,
  };
}

/** 앱에 하나다 — 폰의 알림 입구와 웹의 알림 클릭이 같은 방송을 쓴다. */
const shared = createEntryDismissBus();

/** 알림 입구가 이동하기 **직전에** 한 번 부른다. 열려 있는 임시 표면이 모두 닫힌다. */
export function dismissTemporarySurfaces(): void {
  shared.dismiss();
}

/** 임시 표면이 열려 있는 동안 구독한다. 돌려주는 함수가 구독을 푼다. 표면은 이 구독으로 **자기 닫는 길**을 부른다. */
export function onEntryDismiss(listener: EntryDismissListener): () => void {
  return shared.subscribe(listener);
}

/**
 * 쓰던 글을 가진 표면이 구독한다 — 어느 `onEntryDismiss` 구독자보다도 먼저 불리므로, 표면이 걷히기 전에 글을 맡길 수
 * 있다. 돌려주는 함수가 구독을 푼다.
 */
export function onEntryHold(listener: EntryDismissListener): () => void {
  return shared.hold(listener);
}

/** 지금 구독 중인 임시 표면 수. */
export function entryDismissSubscribers(): number {
  return shared.size();
}

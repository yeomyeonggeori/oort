import {createContext} from 'react';

// =============================================================================
// 도크가 자라는 프레임에 목록이 같이 따라가는 길 (#4518)
//
// 입력창을 누르는 순간 펼치기 시작하면(owner 10-25) 펼침이 키보드 준비(메인 스레드가 막히는 구간)와 겹친다. 도크의 높이는 JS 가 프레임마다 정해 네이티브에 넘기는데
// 목록이 그 높이를 따라가는 길(`Timeline` 의 `onLayout` → `scrollToEnd`)은 네이티브 → JS → 네이티브를 한 바퀴 돌아야 해서, 메인 스레드가 막혔다 풀린 순간 목록이 2~3프레임
// 늦는다. 그 사이 도크가 먼저 자라 마지막 말풍선의 아랫줄이 가려졌다 돌아왔다(시뮬레이터 실측: 짧은 탭 −22pt·3프레임, design-review R2 B1).
//
// 그래서 입력창이 자라는 **그 프레임**(스프링의 값이 바뀔 때마다, 레이아웃을 미는 같은 JS 틱 안)에 목록에게 「바닥을 따라가라」고 직접 알린다. 목록은 JS 가 아는 길이가 아니라
// **네이티브 `scrollToEnd`**(지금 그 순간의 창과 콘텐츠 길이로 끝을 셈한다)를 부르므로 레이아웃 이벤트를 기다리지 않는다. 명령은 같은 큐의 레이아웃 커밋 뒤에 실려서
// 메인 스레드가 막혔다 풀려도 둘이 한꺼번에 적용된다.
//
// 이 파일은 둘 사이의 얇은 다리다: `ConversationLayout` 이 다리를 하나 만들어 목록 자리와 도크 자리의 후손에게 컨텍스트로 준다. 다리가 없는 곳(시험·하네스 일부)에서는 아무 일도 안 한다.
// =============================================================================

export interface DockFollow {
  /** 목록이 「바닥을 따라가는 중이면 지금 바닥으로 간다」는 처리기를 건다. 푸는 함수를 돌려준다(마지막으로 건 처리기만 산다). */
  register: (follow: () => void) => () => void;
  /** 도크의 높이가 이번 프레임에 바뀌었다 — 걸려 있는 처리기를 부른다. */
  notify: () => void;
}

export function createDockFollow(): DockFollow {
  let current: (() => void) | null = null;
  return {
    register(follow) {
      current = follow;
      return () => {
        if (current === follow) current = null;
      };
    },
    notify() {
      current?.();
    },
  };
}

export const DockFollowContext = createContext<DockFollow | null>(null);

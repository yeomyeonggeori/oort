import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";

// =============================================================================
// 나를 부른 새 글이 오면 읽음 투영을 **바로** 다시 읽는다 (#5660).
//
// 실측(2026-11-11, `gates/gate-background-resume.mjs` 장면 A): 독 배지·메뉴 막대 점·탭 제목의 수는 읽음 투영(`useReadStates`)의 멘션 수에서
// 오는데, 그 투영은 30초 폴링으로만 새로 읽혔다. 다른 기기에서 나를 멘션하면 폰은 바로 울리는데 메뉴 막대 점은 최대 30초(잰 값 26.4초) 뒤에야
// 켜졌다. 소켓이 멀쩡해도 그랬다.
//
// 서버는 나를 부른 글(멘션·내 글에 답·따라가는 스레드의 답글·DM)마다 같은 트랜잭션에서 멘션 수를 올리고 인박스 항목을 만들며, 그 사실을 내 개인
// 채널로 알린다(`inbox_item.created`, ADR-0199 D7). 그 신호를 받으면 투영을 한 번 무효화한다. 폰을 울린 것과 같은 글이 같은 순간 이 신호를
// 낸다. 수를 여기서 셈하지 않는다: 서버가 셈한 투영을 다시 읽을 뿐이다(`useReadStates`의 「서버가 정본」 그대로).
//
// - 붙을 때마다(`onResync`) 한 번 읽는다: 끊긴 동안 온 신호는 다시 오지 않을 수 있다. 처음 붙을 때의 한 번은 앱이 막 연 투영과 겹치지만 가르지
//   않는다: 구독은 다른 화면과 함께 쓰는 것이라, 이 손잡이가 처음 듣는 「붙음」이 첫 연결인지 잠자기 뒤의 다시 붙음인지 여기서는 모른다.
// - 신호가 몰려도(다시 붙을 때의 되쏘기) 250ms 로 합쳐 한 번만 묻는다.
// - 개인 채널 구독은 인박스·예약 메시지 화면과 **공유**한다(refcount): 더 붙어도 소켓은 늘지 않는다.
// - 폴링(30초)은 그물로 남는다: 신호를 놓친 경우(구서버, 구독 거절)에도 수는 결국 맞는다.
//
// 아무것도 그리지 않는다.
// =============================================================================

const DEBOUNCE_MS = 250;

export function ReadStateLiveSync() {
  const { session, workspaceId, realtime } = useSession();
  const client = useQueryClient();
  const selfId = session.member.id;

  useEffect(() => {
    if (!realtime?.subscribeInbox) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
      }, DEBOUNCE_MS);
    };
    const off = realtime.subscribeInbox(selfId, { onEvent: refresh, onResync: refresh });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [realtime, selfId, workspaceId, client]);

  return null;
}

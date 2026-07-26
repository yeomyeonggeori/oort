import { useEffect, useState } from "react";
import { useSession } from "@/app/session";

/**
 * 오프라인인가. 두 곳에 물어본다.
 *
 * 레일의 `disconnected`는 centrifuge가 재연결을 포기한 종단 절단에서만 오기
 * 때문에, 랜선을 뽑고 105초를 기다려도 상태는 `connecting`에 머문다. 즉 그
 * 신호 하나만 보면 오프라인 상태는 코드에만 있고 화면에는 없다. 브라우저가
 * 아는 사실(navigator.onLine)을 함께 읽어야 실제로 끊긴 사람이 실제로 배너를
 * 본다. 두 신호는 겹칠 뿐 서로를 대체하지 않는다: 랜선은 살아 있는데 서버만
 * 죽은 경우는 레일이, 랜선이 빠진 경우는 브라우저가 안다.
 *
 * 채널 만들기 다이얼로그(MOMO-614)가 처음 쓴 규칙이고, 에이전트 프로필
 * 다이얼로그가 같은 판단을 하게 되면서 공용으로 옮겼다. 폼 다이얼로그가 저장
 * 가능 여부를 서로 다르게 판단하면 한쪽만 고쳐지는 순간이 온다.
 */
export function useOffline(): boolean {
  const { connStatus } = useSession();
  const [browserOffline, setBrowserOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false
  );
  useEffect(() => {
    const online = () => setBrowserOffline(false);
    const offline = () => setBrowserOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  return browserOffline || connStatus === "disconnected";
}

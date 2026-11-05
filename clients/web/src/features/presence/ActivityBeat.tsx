import { useEffect } from "react";
import { holdActivityBeat } from "@momo/core/features/presence/activityBeat";
import { useSession } from "@/app/session";
import { documentActivity } from "./activityPort";

// =============================================================================
// 「지금 쓰는 중」 신호 (ADR-0206 D4, #4508).
//
// Renders nothing. 로그인한 동안 이 창이 앞에 있고 5분 안에 입력이 있었으면 20초 이하 주기로
// `PUT …/presence/activity` 를 보낸다. 서버는 그 동안 이 사람의 **폰** 푸시를 설정한 시간만큼 늦춘다
// (읽으면 취소). 본문이 없다: 무엇을 보는지도 어느 채널인지도 말하지 않는다. 폰 앱은 이 파일을
// 쓰지 않는다. 주기·멈춤·거절 처리는 전부 core(`activityBeat.ts`)에 있고, 여기서는 세션 동안의
// 한 번 잡기만 한다. 채널 화면이 아니라 앱 셸에 서므로 설정·받은함에 있어도 신호가 이어진다.
// =============================================================================

export function ActivityBeat() {
  const { workspaceId } = useSession();

  useEffect(() => holdActivityBeat(workspaceId, documentActivity), [workspaceId]);

  return null;
}

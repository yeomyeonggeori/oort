import { useConnection } from "@/features/common/connectionContext";

export { useBrowserOffline } from "@/features/common/browserOffline";

/**
 * 지금 쓰기(보내기·올리기·승인·폼 저장)를 막아야 하나. 이 앱에서 그 질문의 답은 이 훅 한 곳이다.
 *
 * 답은 연결 상태 모델의 게이트(`canSend`, #5219)다. 쓰기는 REST이고 소켓은 수신용이라, 실시간(소켓)만
 * 끊겼다고 막지 않는다(#5201 결정 ③). 막는 것은 **기기 오프라인**과 **서버에 닿지 못함**이 확정일 때와
 * 로그인이 만료됐을 때뿐이고, 모르면 막지 않는다. 소켓이 흔들리는 1초에 전송 단추가 잠기던 것(#786 수리의
 * 부작용, 감사 문서 §2.1)이 이것으로 끝난다.
 *
 * 폼 다이얼로그가 저장 가능 여부를 서로 다르게 판단하면 한쪽만 고쳐지는 순간이 온다. 그래서 채널 만들기
 * (MOMO-614)가 처음 쓴 규칙을 공용으로 옮긴 이 훅을 38개 파일이 그대로 읽고, 규칙은 여기서만 바뀐다.
 * 셸 위에 서는 라우트(CLI·OAuth 동의, 초대 수락)는 세션이 없으므로 이 훅이 아니라 `useBrowserOffline`을 쓴다.
 */
export function useOffline(): boolean {
  return !useConnection().view.canSend;
}

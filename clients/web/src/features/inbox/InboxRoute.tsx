import { RouteStub } from "@/features/common/RouteStub";

/** 인박스 (R-1 §2). Route and keyboard path land now, data lands with the approval ledger. */
export function InboxRoute() {
  return (
    <RouteStub
      title="인박스"
      headline="알림 기본값은 0입니다. 소음을 끄는 것이 아니라, 필요한 것만 켭니다."
      points={[
        "승인 대기: 에이전트가 실행 전에 물어보는 작업을 여기서 승인하거나 거절합니다.",
        "멘션: 나를 부른 메시지만 모입니다.",
        "에이전트: 내가 담당하는 에이전트가 끝낸 작업의 결과가 남습니다.",
      ]}
      testId="inbox-route"
    />
  );
}
